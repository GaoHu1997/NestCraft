//! FEAT-008 immutable generation engine. Tantivy 0.26.0 API (MIT).
//! API setup follows upstream examples/basic_search.rs; attribution retained in third-party/tantivy.
//! This module is compiled in the application, not only in tests. SQLite is the publication authority.
use super::*;
use serde::{Deserialize, Serialize};
use tantivy::{Index, IndexReader, IndexWriter, Searcher, Term, ReloadPolicy, DocAddress};
use tantivy::schema::{Schema, Field, TextOptions, TextFieldIndexing, IndexRecordOption, TantivyDocument, Value as TvValue, STORED, INDEXED};
use tantivy::query::{Query, BooleanQuery, TermQuery, BoostQuery, Occur, EmptyQuery};
use tantivy::collector::TopDocs;
use tantivy::tokenizer::{WhitespaceTokenizer,TokenStream};
use std::io::Write;
use tantivy::directory::Directory;
pub(super) const FORMAT: &str = "nestcraft-tantivy-immutable-v2";
pub(super) const SCHEMA_VERSION:u32=2;
pub(super) const TOKENIZER: &str = "host-literal-simplecase-v1";
pub(super) const WRITER_BYTES: usize = 50_000_000;
const STORE_CACHE_BLOCKS:usize=4;
const MAX_SEGMENTS:usize=64;
const MAX_SEAL_BYTES:u64=4*1024*1024;
#[cfg(test)]
#[derive(Default,Clone,Debug,Serialize)]
pub(super) struct CacheStats {pub loads:u64,pub pin_chains:u64,pub pin_opens:u64,pub cold_fullhashfiles:u64,pub heldmetadata:u64,pub open_micros:u64,pub fresh_batch_files:u64,pub batch_ancestor_verifies:u64}
#[cfg(test)]
std::thread_local! {pub(super) static CACHE_STATS:std::cell::RefCell<CacheStats>=std::cell::RefCell::new(CacheStats::default());}
fn read_manifest(path:&Path,pins:&files::SnapshotPins)->Result<Vec<u8>,String>{
    #[cfg(test)] CACHE_STATS.with(|s|s.borrow_mut().pin_opens+=1);
    let file=pins.file(path,false).map_err(|e|format!("INDEX_MISSING: 缺封存或ownership文件; {e}"))?;let m=file.metadata().map_err(err)?;
    if m.len()>MAX_SEAL_BYTES{return Err("INDEX_SEAL_INVALID".into());}
    let mut bytes=Vec::new();file.take(MAX_SEAL_BYTES+1).read_to_end(&mut bytes).map_err(err)?;
    if bytes.len() as u64>MAX_SEAL_BYTES{return Err("INDEX_SEAL_INVALID".into());}pins.verify()?;Ok(bytes)
}
fn held_fingerprint(file:&fs::File)->Result<String,String>{
    #[cfg(test)] CACHE_STATS.with(|s|s.borrow_mut().heldmetadata+=1);
    let m=file.metadata().map_err(err)?;if unsafe_entry(&m)||!m.is_file(){return Err("INDEX_PATH_UNSAFE".into());}
    Ok(format!("{}:{}",files::snapshot_entity_id(file)?,stat_token(&m)))
}
fn check_reader(index:&Index,reader:&IndexReader)->Result<(),String>{
    if index.settings().docstore_blocksize!=16_384||reader.searcher().segment_readers().len()>MAX_SEGMENTS{return Err("INDEX_RESOURCE_UNSUPPORTED: docstore块或segment预算未知".into());}Ok(())
}
fn err(e: impl std::fmt::Display) -> String { format!("INDEX_ENGINE: {e}") }
#[derive(Clone)]
struct Fields { terms:[Field;4], key:Field, note:Field, ordinal:Field, primary:Field, suffix:Field, metadata:Field }
fn schema() -> (Schema, Fields) {
    let mut b=Schema::builder();
    let options=TextOptions::default().set_indexing_options(TextFieldIndexing::default().set_tokenizer("host_whitespace").set_index_option(IndexRecordOption::WithFreqsAndPositions));
    let terms=["title_terms","heading_terms","body_terms","bigram_terms"].map(|s|b.add_text_field(s,options.clone()));
    let key=b.add_u64_field("chunk_key",INDEXED|tantivy::schema::FAST);
    let note=b.add_text_field("stable_note",TextOptions::default().set_fast(None));
    let ordinal=b.add_u64_field("stable_ordinal",tantivy::schema::FAST);
    let primary=b.add_text_field("primary",STORED); let suffix=b.add_text_field("suffix",STORED); let metadata=b.add_text_field("metadata",STORED);
    (b.build(), Fields{terms,key,note,ordinal,primary,suffix,metadata})
}
fn register(index:&Index) { register_observed(index,IoTrace::default()); }
fn register_observed(index:&Index,trace:IoTrace) {
    let tokenizer=WhitespaceTokenizer::default();
    #[cfg(test)] let tokenizer=io_faults::tokenizer(tokenizer);
    index.tokenizers().register("host_whitespace",ObservedTokenizer{inner:tantivy::tokenizer::TextAnalyzer::from(tokenizer),trace});
}
fn bounded(mut text:String,limit:usize)->String{
    if text.len()>limit{let marker=" [truncated]";let mut end=limit.saturating_sub(marker.len());while !text.is_char_boundary(end){end-=1;}text.truncate(end);text.push_str(marker);}text
}
fn panic_detail(payload:&(dyn std::any::Any+Send))->String{
    bounded(if let Some(s)=payload.downcast_ref::<&str>(){(*s).into()}else if let Some(s)=payload.downcast_ref::<String>(){s.clone()}else{"non-string panic payload (not exposed by upstream)".into()},2048)
}
#[derive(Clone)]
struct ObservedTokenizer {inner:tantivy::tokenizer::TextAnalyzer,trace:IoTrace}
impl tantivy::tokenizer::Tokenizer for ObservedTokenizer {
    type TokenStream<'a>=ObservedTokens<'a>;
    fn token_stream<'a>(&'a mut self,text:&'a str)->Self::TokenStream<'a>{
        let trace=self.trace.clone();
        let analyzer=&mut self.inner;
        let inner=match std::panic::catch_unwind(std::panic::AssertUnwindSafe(move||{let analyzer=analyzer;analyzer.token_stream(text)})){Ok(stream)=>stream,Err(payload)=>{trace.record_detail("worker_panic",Path::new("tokenizer"),&panic_detail(payload.as_ref()));std::panic::resume_unwind(payload)}};
        ObservedTokens{inner,trace}
    }
}
struct ObservedTokens<'a>{inner:tantivy::tokenizer::BoxTokenStream<'a>,trace:IoTrace}
impl tantivy::tokenizer::TokenStream for ObservedTokens<'_>{
    fn advance(&mut self)->bool{
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(||self.inner.advance())){Ok(value)=>value,Err(payload)=>{self.trace.record_detail("worker_panic",Path::new("tokenizer"),&panic_detail(payload.as_ref()));std::panic::resume_unwind(payload)}}
    }
    fn token(&self)->&tantivy::tokenizer::Token{self.inner.token()}
    fn token_mut(&mut self)->&mut tantivy::tokenizer::Token{self.inner.token_mut()}
}
#[cfg(test)]
mod diagnostic_tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn repairs_v2_r5_quota_metadata_handle_cannot_race_atomic_replacement(){
        use std::os::windows::fs::OpenOptionsExt;
        let path=std::env::temp_dir().join(new_id("cr055-atomic-scan"));fs::create_dir(&path).unwrap();
        let target=path.join(".managed.json");fs::write(&target,b"old").unwrap();
        let directory=ObservedDirectory{inner:Box::new(tantivy::directory::MmapDirectory::open(&path).unwrap()),trace:IoTrace::default()};
        let scan=disk_scan_atomic_guard().unwrap();
        // Actual metadata-only handle, even share READ|WRITE|DELETE does not make
        // Windows replacement safe. The same critical section encloses quota scans.
        let held=fs::OpenOptions::new().access_mode(0x80).share_mode(7).custom_flags(0x00200000).open(&target).unwrap();
        assert_eq!(held.metadata().unwrap().len(),3);
        let(start_tx,start_rx)=std::sync::mpsc::sync_channel(1);
        let(done_tx,done_rx)=std::sync::mpsc::sync_channel(1);
        let worker=std::thread::spawn(move||{start_tx.send(()).unwrap();let result=directory.atomic_write(Path::new(".managed.json"),b"new");done_tx.send(result).unwrap();});
        let started=start_rx.recv_timeout(Duration::from_secs(5));
        let premature=done_rx.recv_timeout(Duration::from_millis(100));
        drop(held);drop(scan); // Do not poison a production lock on assertion failure.
        worker.join().unwrap();
        let(premature_error,result)=match premature{Ok(r)=>(Some(format!("{r:?}")),r),Err(std::sync::mpsc::RecvTimeoutError::Timeout)=>(None,done_rx.recv_timeout(Duration::from_secs(5)).unwrap()),Err(e)=>panic!("worker channel: {e}")};
        let bytes=fs::read(&target).unwrap();fs::remove_dir_all(&path).unwrap();
        assert!(started.is_ok(),"atomic worker did not start");
        assert!(premature_error.is_none(),"quota metadata handle overlapped upstream atomic replacement: {premature_error:?}");
        result.unwrap();assert_eq!(bytes,b"new");
    }
    #[test]
    fn repairs_v2_r5_diagnostic_bounds_preserve_utf8_and_event_budget(){
        let payload=format!("worker-payload {}","中".repeat(4096));let detail=panic_detail(&payload);
        assert!(detail.len()<=2048&&detail.starts_with("worker-payload")&&detail.ends_with("[truncated]"));
        let trace=IoTrace::default();for _ in 0..64{trace.record_detail("worker_panic",Path::new("tokenizer"),&payload);}
        let state=trace.0.lock().unwrap();assert_eq!(state.events.len(),8);assert_eq!(state.dropped,56);assert!(state.events.iter().all(|e|e.len()<=2048&&e.ends_with("[truncated]")));
    }
}
fn sha(text:&str)->String {format!("sha256:{:x}",Sha256::digest(text.as_bytes()))}
/// 1:1 Unicode simple lowercase; multi-scalar expansions remain unchanged, no NFC or diacritic stripping.
pub(super) fn fold(text:&str)->String { text.chars().map(|c|{let mut iter=c.to_lowercase();let first=iter.next().unwrap_or(c);if iter.next().is_none(){first}else{c}}).collect() }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(super) struct Meta {
    pub library:String, pub generation:i64, pub note:String, pub relative_uri:String, pub title:String,
    pub parse:String, pub source_hash:String, pub legacy_hash:String, pub source_bytes:String,
    pub key:i64, pub ordinal:usize, pub start:u64, pub end:u64, pub search_end:u64,
    pub start_line:usize, pub end_line:usize, pub heading:String, pub kind:String,
    pub parser:String, pub chunker:String, pub encoding:String, pub context:String, pub options:String,
    pub tokenizer:String, pub format:String, pub schema:u32, pub primary_sha:String, pub suffix_sha:String,
}
impl Meta {
    pub(super) fn new(spec:&BuildSpec,note:&str,parse:&str,relative:&str,title:&str,hash:&SourceHash,key:i64,c:&StreamChunk,suffix:&str,kind:&str)->Self {
        Self{library:spec.library.clone(),generation:spec.generation,note:note.into(),relative_uri:relative.into(),title:title.into(),parse:parse.into(),source_hash:hash.sha256.clone(),legacy_hash:hash.fnv.clone(),source_bytes:hash.bytes.to_string(),key,ordinal:c.ordinal,start:c.start,end:c.end,search_end:c.end+suffix.len()as u64,start_line:c.start_line,end_line:c.end_line,heading:c.heading.clone(),kind:kind.into(),parser:PARSER_VERSION.into(),chunker:CHUNKER_VERSION.into(),encoding:ENCODING_VERSION.into(),context:CONTEXT_VERSION.into(),options:options_hash(),tokenizer:TOKENIZER.into(),format:FORMAT.into(),schema:SCHEMA_VERSION,primary_sha:sha(&c.text),suffix_sha:sha(suffix)}
    }
    fn versions(&self)->Result<(),String> {
        if self.format!=FORMAT||self.schema!=SCHEMA_VERSION||self.tokenizer!=TOKENIZER||self.parser!=PARSER_VERSION||self.chunker!=CHUNKER_VERSION||self.encoding!=ENCODING_VERSION||self.context!=CONTEXT_VERSION||self.options!=options_hash(){return Err("SNAPSHOT_REBUILD_REQUIRED: 引擎/分词/解析/编码版本未知".into());}
        files::relative(&self.relative_uri)?; Ok(())
    }
}
#[derive(Serialize,Deserialize,PartialEq)]
struct Ownership {format:String, database:String, library:String, generation:i64}
fn identity(conn:&Connection,lib:&str,generation:i64)->Result<Ownership,String> {
    let db=conn.path().filter(|p|!p.is_empty()).ok_or("INDEX_PATH_UNAVAILABLE: 持久引擎需要宿主文件数据库")?;
    let path=fs::canonicalize(db).map_err(err)?;
    Ok(Ownership{format:FORMAT.into(),database:format!("{:x}",Sha256::digest(path.to_string_lossy().as_bytes())),library:lib.into(),generation})
}
pub(super) fn managed_root(conn:&Connection)->Result<PathBuf,String> {
    let db=conn.path().filter(|p|!p.is_empty()).ok_or("INDEX_PATH_UNAVAILABLE")?;
    let db=fs::canonicalize(db).map_err(err)?;
    // 生产库位于统一数据根的 db/ 下，索引固定落在同一根的 index/；
    // 其它位置（测试、冒烟隔离库）保持与库文件同级，避免跨环境互相污染。
    if let Ok(data) = crate::commands::general::resolve_data_dir(conn) {
        let db_dir = data.join("db");
        if db.parent() == Some(db_dir.as_path()) {
            return Ok(data.join("index"));
        }
    }
    Ok(db.parent().ok_or("INDEX_PATH_UNAVAILABLE")?.join("kb-index"))
}
fn safe_chain(path:&Path)->Result<(),String> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor){Ok(m)=>if unsafe_entry(&m)||!m.is_dir(){return Err("INDEX_PATH_UNSAFE: 索引父链不是受管目录".into());},Err(e)if e.kind()==std::io::ErrorKind::NotFound=>{},Err(e)=>return Err(err(e))}
    } Ok(())
}
pub(super) fn location(conn:&Connection,lib:&str,generation:i64)->Result<PathBuf,String> {
    if generation<=0{return Err("SNAPSHOT_INVALID_GENERATION".into());}
    let path=managed_root(conn)?.join(format!("{:x}",Sha256::digest(lib.as_bytes()))).join(generation.to_string()); safe_chain(&path)?; Ok(path)
}
fn write_new(path:&Path,bytes:&[u8])->Result<(),String> {
    #[cfg(test)] let fault=if path.file_name().is_some_and(|n|n=="ownership.json"){io_faults::ownership_fault()}else{None};
    #[cfg(test)] if fault==Some(io_faults::Fault::OwnershipOpen){return Err("INDEX_OWNERSHIP_OPEN_INJECTED".into());}
    let mut f=fs::OpenOptions::new().create_new(true).write(true).open(path).map_err(err)?;
    #[cfg(test)] if fault==Some(io_faults::Fault::OwnershipPartial){f.write_all(&bytes[..bytes.len()/2]).map_err(err)?;return Err("INDEX_OWNERSHIP_PARTIAL_INJECTED".into());}
    f.write_all(bytes).map_err(err)?;
    #[cfg(test)] if fault==Some(io_faults::Fault::OwnershipFlush){return Err("INDEX_OWNERSHIP_FLUSH_INJECTED".into());}
    f.sync_all().map_err(err)
}
fn owned(conn:&Connection,lib:&str,generation:i64,path:&Path,pins:&files::SnapshotPins)->Result<(),String> {
    if location(conn,lib,generation)?!=path{return Err("INDEX_PATH_MISMATCH".into());}
    let bytes=read_manifest(&path.join("ownership.json"),pins).map_err(|_|"INDEX_MISSING: 索引ownership缺失")?;
    let actual:Ownership=serde_json::from_slice(&bytes).map_err(err)?;
    if actual!=identity(conn,lib,generation)?{return Err("INDEX_OWNERSHIP_MISMATCH".into());} Ok(())
}
#[derive(Debug)]
struct IoEvents {started:Instant,events:Vec<String>,dropped:usize}
impl Default for IoEvents {fn default()->Self{Self{started:Instant::now(),events:Vec::new(),dropped:0}}}
#[derive(Clone,Debug,Default)]
struct IoTrace(Arc<Mutex<IoEvents>>);
impl IoTrace {
    // An observed error may be tolerated by Tantivy (GC, lock contention, new-index probes).
    // Never claim the first observation is the original worker error or the historical root cause.
    fn record(&self,operation:&str,path:&Path,error:&std::io::Error){self.record_detail(operation,path,&format!("{error} (kind={:?}, os={:?})",error.kind(),error.raw_os_error()));}
    fn record_detail(&self,operation:&str,path:&Path,detail:&str){
        if let Ok(mut state)=self.0.lock(){
            // Preserve the first four and most recent four observations; noisy GC cannot
            // permanently crowd a later writer failure out of the bounded diagnostic.
            if state.events.len()>=8{state.events.remove(4);state.dropped=state.dropped.saturating_add(1);}
            let thread=std::thread::current();let name=path.file_name().unwrap_or_default().to_string_lossy();
            let mut message=format!("{operation} {name}: {detail} (t_us={}, thread={:?}, id={:?})",state.started.elapsed().as_micros(),thread.name(),thread.id());
            message=bounded(message,2048);
            state.events.push(message);
        }
    }
    fn read_error(&self,operation:&str,path:&Path,error:&tantivy::directory::error::OpenReadError){
        use tantivy::directory::error::OpenReadError;
        match error {
            OpenReadError::IoError{io_error,..}=>self.record(operation,path,io_error),
            OpenReadError::FileDoesNotExist(_)=>self.record_detail(operation,path,"FileDoesNotExist (kind=NotFound; may be an expected probe)"),
            OpenReadError::IncompatibleIndex(_)=>self.record_detail(operation,path,"IncompatibleIndex (not an I/O error)"),
        }
    }
    fn enrich(&self,error:impl std::fmt::Display)->String{
        let original=err(error);
        match self.0.lock(){Ok(state)if !state.events.is_empty()=>format!("{original}; observed_io={:?}; dropped={}; observation_scope=correlated_not_proven_cause",state.events,state.dropped),_=>original}
    }
}
// Windows replacement fails while even a share-DELETE metadata handle remains
// open on its destination. Serialize our quota scan with managed atomic writes.
// No retries or changes to upstream durability/error semantics.
static DISK_SCAN_ATOMIC_IO:Mutex<()>=Mutex::new(());
pub(super) fn disk_scan_atomic_guard()->std::io::Result<std::sync::MutexGuard<'static,()>>{
    DISK_SCAN_ATOMIC_IO.lock().map_err(|_|std::io::Error::other("INDEX_DISK_IO_LOCK_POISONED"))
}
#[derive(Clone,Debug)]
struct ObservedDirectory {inner:Box<dyn tantivy::directory::Directory>,trace:IoTrace}
impl tantivy::directory::Directory for ObservedDirectory {
    fn get_file_handle(&self,path:&Path)->Result<Arc<dyn tantivy::directory::FileHandle>,tantivy::directory::error::OpenReadError>{
        let r=self.inner.get_file_handle(path);if let Err(e)=&r{self.trace.read_error("read",path,e);}r
    }
    fn delete(&self,path:&Path)->Result<(),tantivy::directory::error::DeleteError>{
        let r=self.inner.delete(path);if let Err(e)=&r{match e{
            tantivy::directory::error::DeleteError::IoError{io_error,..}=>self.trace.record("delete_may_be_tolerated",path,io_error),
            tantivy::directory::error::DeleteError::FileDoesNotExist(_)=>self.trace.record_detail("delete_may_be_tolerated",path,"FileDoesNotExist (kind=NotFound)"),
        }}r
    }
    fn exists(&self,path:&Path)->Result<bool,tantivy::directory::error::OpenReadError>{
        let r=self.inner.exists(path);if let Err(e)=&r{self.trace.read_error("exists_probe",path,e);}r
    }
    fn open_write(&self,path:&Path)->Result<tantivy::directory::WritePtr,tantivy::directory::error::OpenWriteError>{
        use tantivy::directory::error::OpenWriteError;
        let r=self.inner.open_write(path);
        if let Err(e)=&r{match e{OpenWriteError::IoError{io_error,..}=>self.trace.record("open_write",path,io_error),OpenWriteError::FileAlreadyExists(_)=>self.trace.record_detail("open_write",path,"FileAlreadyExists (may be expected lock contention)")}}
        let writer=r?;let capacity=writer.capacity();
        let inner=writer.into_inner().map_err(|e|{let e=e.into_error();self.trace.record("open_flush",path,&e);OpenWriteError::wrap_io_error(e,path.to_owned())})?;
        Ok(std::io::BufWriter::with_capacity(capacity,Box::new(ObservedWrite{inner,trace:self.trace.clone(),path:path.to_owned()})))
    }
    fn atomic_read(&self,path:&Path)->Result<Vec<u8>,tantivy::directory::error::OpenReadError>{
        let r=self.inner.atomic_read(path);if let Err(e)=&r{self.trace.read_error("atomic_read",path,e);}r
    }
    fn atomic_write(&self,path:&Path,data:&[u8])->std::io::Result<()>{
        let r=(||{let _io=disk_scan_atomic_guard()?;self.inner.atomic_write(path,data)})();
        if let Err(e)=&r{self.trace.record("atomic_write",path,e);}r
    }
    fn sync_directory(&self)->std::io::Result<()>{let r=self.inner.sync_directory();if let Err(e)=&r{self.trace.record("sync_directory",Path::new("directory"),e);}r}
    fn acquire_lock(&self,lock:&tantivy::directory::Lock)->Result<tantivy::directory::DirectoryLock,tantivy::directory::error::LockError>{
        let r=self.inner.acquire_lock(lock);if let Err(e)=&r{match e{tantivy::directory::error::LockError::IoError(io)=>self.trace.record("acquire_lock",&lock.filepath,io),tantivy::directory::error::LockError::LockBusy=>self.trace.record_detail("lock_busy_may_be_tolerated",&lock.filepath,"LockBusy")}}r
    }
    fn watch(&self,callback:tantivy::directory::WatchCallback)->tantivy::Result<tantivy::directory::WatchHandle>{
        let r=self.inner.watch(callback);if let Err(e)=&r{match e{tantivy::TantivyError::IoError(io)=>self.trace.record("watch",Path::new("meta.json"),io),_=>self.trace.record_detail("watch",Path::new("meta.json"),&e.to_string())}}r
    }
}
struct ObservedWrite {inner:Box<dyn tantivy::directory::TerminatingWrite+Send+Sync>,trace:IoTrace,path:PathBuf}
impl std::io::Write for ObservedWrite {
    fn write(&mut self,bytes:&[u8])->std::io::Result<usize>{let r=self.inner.write(bytes);if let Err(e)=&r{self.trace.record("write",&self.path,e);}r}
    fn flush(&mut self)->std::io::Result<()>{let r=self.inner.flush();if let Err(e)=&r{self.trace.record("flush",&self.path,e);}r}
}
impl tantivy::directory::TerminatingWrite for ObservedWrite {
    fn terminate_ref(&mut self,token:tantivy::directory::AntiCallToken)->std::io::Result<()>{let r=self.inner.terminate_ref(token);if let Err(e)=&r{self.trace.record("terminate",&self.path,e);}r}
}

pub(super) struct Writer {index:Index, writer:IndexWriter, fields:Fields, path:PathBuf,trace:IoTrace,pins:Arc<files::SnapshotPins>}
impl Writer {
    pub(super) fn create(conn:&Connection,spec:&BuildSpec)->Result<Self,String> {
        let path=location(conn,&spec.library,spec.generation)?;
        let ownership=serde_json::to_vec(&identity(conn,&spec.library,spec.generation)?).map_err(err)?;
        let pins=files::SnapshotPins::parent(&path,true)?.create_generation(path.file_name().ok_or("INDEX_PATH_UNSAFE")?)?;
        let entity=pins.entity()?;
        if let Err(error)=conn.execute("INSERT INTO kb_snap_managed_entity(libraryId,generation,entityId) VALUES(?1,?2,?3)",params![spec.library,spec.generation,entity]){
            let cleanup=pins.delete_created();return Err(format!("{}; created_entity_rollback={cleanup:?}",db_error(error)));
        }
        let pins=Arc::new(pins);pins.verify()?;
        // Registration precedes ownership I/O: failed or partial ownership is still recoverable.
        write_new(&path.join("ownership.json"),&ownership)?;pins.verify()?;
        let(s,fields)=schema();let trace=IoTrace::default();
        let directory:Box<dyn Directory>=Box::new(tantivy::directory::MmapDirectory::open(&path).map_err(err)?);
        #[cfg(test)] let directory=io_faults::wrap(directory);
        let directory=ObservedDirectory{inner:directory,trace:trace.clone()};
        let index=Index::create(directory,s,tantivy::IndexSettings::default()).map_err(|e|trace.enrich(e))?;register_observed(&index,trace.clone());
        // One indexing thread; Tantivy default store compression and merge maintenance also use threads.
        let writer=index.writer_with_num_threads(1,WRITER_BYTES).map_err(|e|trace.enrich(e))?;
        Ok(Self{index,writer,fields,path,trace,pins})
    }
    pub(super) fn add(&self,meta:&Meta,primary:&str,suffix:&str,terms:&kb_index::ChunkTerms)->Result<(),String> {
        meta.versions()?;let mut doc=TantivyDocument::default();
        for(field,text)in self.fields.terms.iter().zip([&terms.title,&terms.heading,&terms.body,&terms.bigram]){doc.add_text(*field,fold(text));}
        doc.add_u64(self.fields.key,meta.key as u64);doc.add_text(self.fields.primary,primary);doc.add_text(self.fields.suffix,suffix);doc.add_text(self.fields.metadata,serde_json::to_string(meta).map_err(err)?);
        doc.add_text(self.fields.note,&meta.note);doc.add_u64(self.fields.ordinal,meta.ordinal as u64);
        self.writer.add_document(doc).map_err(|e|self.trace.enrich(e))?;Ok(())
    }
    #[cfg(test)]
    pub(super) fn split_segment_for_test(&mut self)->Result<(),String>{
        self.writer.set_merge_policy(Box::new(tantivy::indexer::NoMergePolicy));
        self.writer.commit().map_err(|e|self.trace.enrich(e))?;Ok(())
    }
    pub(super) fn abort_error(mut self,host:String)->String{
        // prepare_commit preserves the original indexing worker Result. Never commit
        // this failed business generation, but always drain newly spawned/merge workers.
        let prepared=match self.writer.prepare_commit(){Ok(prepared)=>{drop(prepared);"Ok(unpublished)".into()},Err(e)=>bounded(self.trace.enrich(e),4096)};
        let joined=match self.writer.wait_merging_threads(){Ok(())=>"Ok".into(),Err(e)=>bounded(self.trace.enrich(e),4096)};
        format!("{host}; engine_prepare={prepared}; engine_join={joined}")
    }
    pub(super) fn commit_monitored(self,conn:&Connection,spec:&BuildSpec,cancel:&AtomicBool,limits:&Limits)->Result<Ready,String>{
        std::thread::scope(|scope|{
            let(tx,rx)=std::sync::mpsc::sync_channel(1);let trace=self.trace.clone();
            let worker=scope.spawn(move||{
                let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||self.commit())).unwrap_or_else(|payload|Err(trace.enrich(format!("INDEX_WORKER_PANIC: {}",panic_detail(payload.as_ref())))));
                let _=tx.send(result);
            });
            let mut failure=None;
            let mut result=loop{
                if failure.is_none(){failure=ensure_build(conn,spec,cancel).and_then(|_|check_disk(conn,limits)).err();}
                match rx.recv_timeout(PROGRESS_INTERVAL){
                    Ok(result)=>break result,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout)=>{},
                    Err(_)=>break Err("INDEX_WORKER_UNAVAILABLE: 提交线程异常退出".into())
                }
            };
            if let Err(payload)=worker.join(){result=Err(format!("INDEX_WORKER_PANIC: {}",panic_detail(payload.as_ref())));}
            if failure.is_none(){failure=ensure_build(conn,spec,cancel).and_then(|_|check_disk(conn,limits)).err();}
            if let Some(host)=failure{
                let engine=match &result{Ok(_)=>"Ok(unpublished)".into(),Err(e)=>format!("Err({})",bounded(e.clone(),8192))};
                return Err(format!("{host}; engine_result={engine}"));
            }
            result
        })
    }
    fn commit(mut self)->Result<Ready,String> {
        let committed=self.writer.prepare_commit().and_then(|prepared|prepared.commit());
        // Even an engine commit failure must join every remaining worker before pins drop.
        let joined=self.writer.wait_merging_threads();
        if let Err(e)=committed{let drain=match joined{Ok(())=>"Ok".into(),Err(e)=>bounded(self.trace.enrich(e),4096)};return Err(format!("{}; engine_join={drain}",self.trace.enrich(e)));}
        joined.map_err(|e|self.trace.enrich(e))?;
        let reader:IndexReader=self.index.reader_builder().reload_policy(ReloadPolicy::Manual).doc_store_cache_num_blocks(STORE_CACHE_BLOCKS).try_into().map_err(|e|self.trace.enrich(e))?;reader.reload().map_err(|e|self.trace.enrich(e))?;check_reader(&self.index,&reader)?;
        self.pins.verify()?;Ok(Ready{_index:self.index,reader,fields:self.fields,path:self.path,_pins:self.pins,_files:Vec::new()})
    }
}
pub(super) struct Ready {_index:Index, reader:IndexReader, fields:Fields, path:PathBuf,_pins:Arc<files::SnapshotPins>,_files:Vec<fs::File>}
fn extract(doc:&TantivyDocument,fields:&Fields)->Result<(Meta,String,String),String> {
    let get=|f|doc.get_first(f).and_then(|v|v.as_str()).ok_or("INDEX_STORED_FIELD_MISSING");
    let meta:Meta=serde_json::from_str(get(fields.metadata)?).map_err(err)?;meta.versions()?;
    let primary=get(fields.primary)?.to_string();let suffix=get(fields.suffix)?.to_string();
    if meta.key<=0||meta.end<meta.start||meta.search_end<meta.end||meta.end-meta.start!=primary.len()as u64||meta.search_end-meta.end!=suffix.len()as u64||primary.len()>CHUNK_BYTES||suffix.len()>SEARCH_OVERLAP||sha(&primary)!=meta.primary_sha||sha(&suffix)!=meta.suffix_sha{return Err("INDEX_STORED_INTEGRITY: 正文/范围/SHA不符".into());}
    Ok((meta,primary,suffix))
}
fn validate_meta(conn:&Connection,lib:&str,generation:i64,meta:&Meta)->Result<(),String> {
    let sql="SELECT m.noteId,m.relativeUri,m.title,m.parseGeneration,m.sourceHash,m.legacyHash,m.sourceSize,c.ordinal,c.startByte,c.endByte,c.searchEndByte,c.startLine,c.endLine,c.heading,c.kind,m.parserVersion,m.chunkerVersion,m.encodingVersion,m.contextVersion,m.optionsHash FROM kb_snap_member m JOIN kb_snap_chunk c ON c.libraryId=m.libraryId AND c.noteId=m.noteId AND c.parseGeneration=m.parseGeneration WHERE m.libraryId=?1 AND m.generation=?2 AND c.chunkKey=?3";
    let mut expected=meta.clone();
    conn.prepare_cached(sql).map_err(db_error)?.query_row(params![lib,generation,meta.key],|r| {
        expected.library=lib.into();expected.generation=generation;expected.note=r.get(0)?;expected.relative_uri=r.get(1)?;expected.title=r.get(2)?;expected.parse=r.get(3)?;expected.source_hash=r.get(4)?;expected.legacy_hash=r.get(5)?;expected.source_bytes=r.get(6)?;expected.ordinal=r.get::<_,i64>(7)?as usize;expected.start=r.get::<_,i64>(8)?as u64;expected.end=r.get::<_,i64>(9)?as u64;expected.search_end=r.get::<_,i64>(10)?as u64;expected.start_line=r.get::<_,i64>(11)?as usize;expected.end_line=r.get::<_,i64>(12)?as usize;expected.heading=r.get(13)?;expected.kind=r.get(14)?;expected.parser=r.get(15)?;expected.chunker=r.get(16)?;expected.encoding=r.get(17)?;expected.context=r.get(18)?;expected.options=r.get(19)?;Ok(())
    }).map_err(|_|"INDEX_METADATA_MISMATCH: store未对应同代SQL成员")?;
    if &expected!=meta{return Err("INDEX_METADATA_MISMATCH: store来源/版本/位置不同代".into());}Ok(())
}
impl Ready {
    fn by_key(&self,searcher:&Searcher,key:i64)->Result<(Meta,String,String),String> {
        let q=TermQuery::new(Term::from_field_u64(self.fields.key,key as u64),IndexRecordOption::Basic);
        let docs=searcher.search(&q,&TopDocs::with_limit(2).order_by_score()).map_err(err)?;
        if docs.len()!=1{return Err("INDEX_CHUNK_MAPPING: chunkKey不是唯一store记录".into());}
        extract(&searcher.doc::<TantivyDocument>(docs[0].1).map_err(err)?,&self.fields)
    }
    pub(super) fn validate(&self,conn:&Connection,spec:&BuildSpec,chunks:i64,cancel:&AtomicBool,limits:&Limits)->Result<(),String> {
        let searcher=self.reader.searcher();if searcher.num_docs()!=chunks as u64{return Err("INDEX_DOC_COUNT_MISMATCH".into());}
        let mut probe=DiskGuard::new();
        for (segment,reader) in searcher.segment_readers().iter().enumerate() {
            let notes=reader.fast_fields().str("stable_note").map_err(err)?.ok_or("INDEX_SORT_KEY_MISSING")?;
            let ordinals=reader.fast_fields().u64("stable_ordinal").map_err(err)?;
            let keys=reader.fast_fields().u64("chunk_key").map_err(err)?;
            for doc in reader.doc_ids_alive() {
                ensure_build(conn,spec,cancel)?;probe.check(conn,limits,0,false)?;
                let(meta,_,_)=extract(&searcher.doc::<TantivyDocument>(DocAddress::new(segment as u32,doc)).map_err(err)?,&self.fields)?;
                let mut note_ords=notes.term_ords(doc);let note_ord=note_ords.next().ok_or("INDEX_SORT_KEY_MISSING")?;let mut note=String::new();
                if note_ords.next().is_some()||!notes.ord_to_str(note_ord,&mut note).map_err(err)?||note!=meta.note
                    ||!ordinals.values_for_doc(doc).eq(std::iter::once(meta.ordinal as u64))
                    ||!keys.values_for_doc(doc).eq(std::iter::once(meta.key as u64)){return Err("INDEX_SORT_KEY_MISMATCH".into());}
                validate_meta(conn,&spec.library,spec.generation,&meta)?;
            }
        }
        // Per-file continuity and exact forward-context ownership, bounded to one chunk pair.
        let mut stmt=conn.prepare("SELECT m.noteId,c.chunkKey,c.ordinal,c.startByte,c.endByte FROM kb_snap_member m JOIN kb_snap_chunk c ON c.libraryId=m.libraryId AND c.noteId=m.noteId AND c.parseGeneration=m.parseGeneration WHERE m.libraryId=?1 AND m.generation=?2 ORDER BY m.noteId,c.ordinal").map_err(db_error)?;
        let mut rows=stmt.query(params![spec.library,spec.generation]).map_err(db_error)?;
        let mut note=String::new();let mut ordinal=0;let mut end=0;let mut prior_suffix=String::new();
        while let Some(row)=rows.next().map_err(db_error)? {
            check_cancel(cancel)?;probe.check(conn,limits,0,false)?;
            let n:String=row.get(0).map_err(db_error)?;let key:i64=row.get(1).map_err(db_error)?;
            if n!=note {if !prior_suffix.is_empty(){return Err("INDEX_SUFFIX_FINAL".into());}note=n;ordinal=0;end=0;}
            let(meta,primary,suffix)=self.by_key(&searcher,key)?;
            if meta.ordinal!=ordinal||meta.start!=end{return Err("INDEX_RANGE_CONTINUITY".into());}
            let mut e=SEARCH_OVERLAP.min(primary.len());while !primary.is_char_boundary(e){e-=1;}
            if ordinal>0&&prior_suffix!=primary[..e]{return Err("INDEX_SUFFIX_MISMATCH".into());}
            ordinal+=1;end=meta.end;prior_suffix=suffix;
        }
        if !prior_suffix.is_empty(){return Err("INDEX_SUFFIX_FINAL".into());}Ok(())
    }
    pub(super) fn seal(&self,conn:&Connection,spec:&BuildSpec,digest:&str,cancel:&AtomicBool,limits:&Limits)->Result<String,String> {
        owned(conn,&spec.library,spec.generation,&self.path,&self._pins)?;
        let mut files=Vec::new();let mut probe=DiskGuard::new();
        for entry in fs::read_dir(&self.path).map_err(err)? {
            ensure_build(conn,spec,cancel)?;probe.check(conn,limits,0,false)?;
            let entry=entry.map_err(err)?;let meta=entry.metadata().map_err(err)?;
            if !meta.is_file()||unsafe_entry(&fs::symlink_metadata(entry.path()).map_err(err)?){return Err("INDEX_PATH_UNSAFE".into());}
            let name=entry.file_name().into_string().map_err(|_|"INDEX_PATH_ENCODING")?;
            if name.contains("lock"){continue;}
            let mut file=self._pins.file(&entry.path(),true)?;let hash=hash_reader_progress(&mut file,cancel,|_|{ensure_build(conn,spec,cancel)?;probe.check(conn,limits,0,false)})?;
            file.sync_all().map_err(err)?;
            files.push(serde_json::json!({"name":name,"bytes":hash.bytes,"sha256":hash.sha256}));
        }
        files.sort_by_key(|v|v["name"].as_str().unwrap_or("").to_string());
        let bytes=serde_json::to_vec(&serde_json::json!({"format":FORMAT,"digest":digest,"files":files})).map_err(err)?;
        if bytes.len() as u64>MAX_SEAL_BYTES{return Err("INDEX_SEAL_INVALID".into());}
        ensure_build(conn,spec,cancel)?;probe.check(conn,limits,0,true)?;
        write_new(&self.path.join("sealed.json"),&bytes)?;
        // Complete seal bytes are anchored by the host's publication CAS, not self-hashed in JSON.
        // File sync_all + Tantivy managed-directory atomic meta commit. True sudden power-loss not claimed.
        Ok(format!("sha256:{:x}",Sha256::digest(&bytes)))
    }
}
fn check_inventory(path:&Path,names:&HashSet<&str>)->Result<(),String>{
    for required in ["ownership.json","meta.json",".managed.json"]{if !names.contains(required){return Err("INDEX_SEAL_INCOMPLETE: 缺必需文件".into());}}
    let mut actual_names=HashSet::new();
    for entry in fs::read_dir(path).map_err(err)?{
        let entry=entry.map_err(err)?;let name=entry.file_name().into_string().map_err(|_|"INDEX_PATH_ENCODING")?;
        if name=="sealed.json"||name==".tantivy-writer.lock"||name==".tantivy-meta.lock"{continue;}
        if actual_names.len()>=4096||unsafe_entry(&fs::symlink_metadata(entry.path()).map_err(err)?)||!entry.file_type().map_err(err)?.is_file(){return Err("INDEX_PATH_UNSAFE".into());}
        actual_names.insert(name);
    }
    if actual_names.len()!=names.len()||actual_names.iter().any(|n|!names.contains(n.as_str())){return Err("INDEX_SEAL_INCOMPLETE: 文件全集与封存不符".into());}Ok(())
}
#[cfg(windows)]
fn read_held_manifest(file:&fs::File)->Result<Vec<u8>,String>{
    use std::os::windows::fs::FileExt;
    let len=file.metadata().map_err(err)?.len();if len>MAX_SEAL_BYTES{return Err("INDEX_SEAL_INVALID".into());}
    let mut bytes=vec![0;len as usize];let mut offset=0;
    // seek_read affects the shared cursor, but this operation's explicit offset is
    // independent of it. No published Ready handle is consumed with seek + Read.
    while offset<bytes.len(){let n=file.seek_read(&mut bytes[offset..],offset as u64).map_err(err)?;if n==0{return Err("INDEX_FILE_CHANGED".into());}offset+=n;}
    if file.metadata().map_err(err)?.len()!=len{return Err("INDEX_FILE_CHANGED".into());}Ok(bytes)
}
#[derive(Clone)]
struct CacheEntry {ready:Arc<Ready>, touched:Instant, fingerprints:Vec<String>, seal_hash:String,digest:String,file_names:Vec<String>}
#[derive(Default)]
struct CacheState {entries:HashMap<PathBuf,CacheEntry>,epoch:u64}
impl CacheState {
    fn invalidate(&mut self,path:&Path)->Result<(),String>{
        // Never wrap a ticket back to an old value, including cache-miss forget.
        self.epoch=self.epoch.checked_add(1).ok_or("INDEX_CACHE_EPOCH_EXHAUSTED")?;
        self.entries.remove(path);Ok(())
    }
}
#[cfg(test)]
#[test]
fn perf_v2_cache_miss_epoch_is_bounded_and_does_not_wrap(){
    let mut state=CacheState::default();for n in 1..=10000{state.invalidate(&PathBuf::from(format!("unused-generation-{n}"))).unwrap();assert_eq!(state.epoch,n);assert!(state.entries.is_empty());}
    state.epoch=u64::MAX;assert_eq!(state.invalidate(Path::new("miss")).unwrap_err(),"INDEX_CACHE_EPOCH_EXHAUSTED");assert_eq!(state.epoch,u64::MAX);assert!(state.entries.is_empty());
}
#[cfg(test)]
std::thread_local! {pub(super) static PERF_BEFORE_CACHE_INSERT:std::cell::RefCell<Option<Box<dyn FnOnce()>>>=std::cell::RefCell::new(None);}
#[cfg(windows)]
fn reuse_held(conn:&Connection,lib:&str,generation:i64,path:&Path,e:&CacheEntry,trusted:&str,digest:&str)->Result<Arc<Ready>,String>{
    if e.seal_hash!=trusted{return Err("INDEX_SEAL_UNTRUSTED: 封存SHA与发布事务不同".into());}
    if e.digest!=digest{return Err("INDEX_SEAL_MISMATCH".into());}
    let ready=&e.ready;
    if ready._files.len()!=e.file_names.len()||ready._files.len()>4096{return Err("INDEX_BATCH_LIMIT".into());}
    let paths:Vec<_>=e.file_names.iter().zip(&ready._files).map(|(name,file)|Ok((path.join(name),files::snapshot_entity_id(file)?))).collect::<Result<_,String>>()?;
    #[cfg(test)] let batch_before=files::SNAPSHOT_BATCH_COUNTS.with(|s|s.get());
    let batch=ready._pins.checked_read_files(&paths,|fresh|{
    let mut fingerprints=vec![ready._pins.entity()?];
    for file in &ready._files{fingerprints.push(held_fingerprint(file)?);}
    if fingerprints!=e.fingerprints{return Err("INDEX_FILE_CHANGED".into());}
    let seal_bytes=read_held_manifest(ready._files.first().ok_or("INDEX_SEAL_INVALID")?)?;
    if trusted!=format!("sha256:{:x}",Sha256::digest(&seal_bytes)){return Err("INDEX_SEAL_UNTRUSTED: 封存SHA与发布事务不同".into());}
    let sealed:serde_json::Value=serde_json::from_slice(&seal_bytes).map_err(err)?;
    if sealed["format"]!=FORMAT||sealed["digest"]!=digest{return Err("INDEX_SEAL_MISMATCH".into());}
    let entries=sealed["files"].as_array().ok_or("INDEX_SEAL_INVALID")?;
    if entries.is_empty()||entries.len()>4096||ready._files.len()!=entries.len()+1{return Err("INDEX_SEAL_INVALID".into());}
    let mut names=HashSet::new();let mut ownership=None;
    for (entry,file) in entries.iter().zip(ready._files.iter().skip(1)){
        let name=entry["name"].as_str().ok_or("INDEX_SEAL_INVALID")?;
        if Path::new(name).components().count()!=1||name.contains('/')||name.contains('\\')||name=="."||name==".."||!names.insert(name){return Err("INDEX_SEAL_INVALID".into());}
        if file.metadata().map_err(err)?.len()!=entry["bytes"].as_u64().ok_or("INDEX_SEAL_INVALID")?{return Err("INDEX_FILE_CHANGED".into());}
        if name=="ownership.json"{ownership=Some(file);}
    }
    check_inventory(path,&names)?;
    let bytes=read_held_manifest(ownership.ok_or("INDEX_MISSING: 索引ownership缺失")?)?;
    let actual:Ownership=serde_json::from_slice(&bytes).map_err(err)?;
    if actual!=identity(conn,lib,generation)?{return Err("INDEX_OWNERSHIP_MISMATCH".into());}
    if fresh.len()!=ready._files.len(){return Err("INDEX_BATCH_LIMIT".into());}
    Ok(())
    });
    #[cfg(test)] {let batch_after=files::SNAPSHOT_BATCH_COUNTS.with(|s|s.get());CACHE_STATS.with(|s|{let mut s=s.borrow_mut();s.fresh_batch_files+=batch_after.0-batch_before.0;s.batch_ancestor_verifies+=batch_after.1-batch_before.1;});}
    let _=batch?;
    // Only renew the still-live entry that was checked; never reinsert after forget/TTL.
    let mut c=cache().lock().map_err(|_|"INDEX_CACHE_POISONED")?;
    if let Some(current)=c.entries.get_mut(path){if Arc::ptr_eq(&current.ready,ready)&&current.touched.elapsed()<LEASE_TTL{current.touched=Instant::now();}}
    Ok(ready.clone())
}
static CACHE:OnceLock<Mutex<CacheState>>=OnceLock::new();
fn cache()->&'static Mutex<CacheState>{CACHE.get_or_init(||Mutex::new(CacheState::default()))}
#[cfg(test)]
pub(super) fn perf_cached_ready(path:&Path)->Option<Arc<Ready>>{cache().lock().unwrap().entries.get(path).map(|e|e.ready.clone())}
#[cfg(test)]
pub(super) fn perf_expire_cache(path:&Path){cache().lock().unwrap().entries.get_mut(path).unwrap().touched=Instant::now()-LEASE_TTL-Duration::from_secs(1);}
#[cfg(test)]
pub(super) fn perf_cache_len()->usize{cache().lock().unwrap().entries.len()}
#[cfg(test)]
pub(super) fn perf_open(conn:&Connection,lib:&str,generation:i64)->Result<Arc<Ready>,String>{open(conn,lib,generation)}
#[cfg(all(test,windows))]
pub(super) fn perf_read_held_seal(ready:&Ready)->Result<Vec<u8>,String>{
    use std::os::windows::fs::FileExt;
    let file=ready._files.first().ok_or("INDEX_SEAL_INVALID")?;
    // Deliberately disturb the shared cursor; the production reader must ignore it.
    let mut scratch=[0;1];file.seek_read(&mut scratch,7).map_err(err)?;read_held_manifest(file)
}
fn open(conn:&Connection,lib:&str,generation:i64)->Result<Arc<Ready>,String> {
    #[cfg(test)] let started=Instant::now();
    let result=open_checked(conn,lib,generation);
    #[cfg(test)] CACHE_STATS.with(|s|{let mut s=s.borrow_mut();s.loads+=1;s.open_micros+=started.elapsed().as_micros()as u64;});
    result
}
fn open_checked(conn:&Connection,lib:&str,generation:i64)->Result<Arc<Ready>,String> {
    let path=location(conn,lib,generation)?;
    if engine_for(conn,lib,generation)?!=Engine::Tantivy{return Err("SNAPSHOT_REBUILD_REQUIRED: 未知引擎或版本".into());}
    let (registered,trusted,digest):(String,Option<String>,String)=conn.query_row("SELECT enginePath,engineSealHash,manifestDigest FROM kb_snap_generation WHERE id=?1 AND libraryId=?2",params![generation,lib],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(db_error)?;
    if Path::new(&registered)!=path{return Err("INDEX_PATH_MISMATCH".into());}
    let trusted=trusted.ok_or("SNAPSHOT_REBUILD_REQUIRED: 旧Tantivy代缺可信封存SHA")?;
    let (cached,ticket)={let mut c=cache().lock().map_err(|_|"INDEX_CACHE_POISONED")?;c.entries.retain(|_,v|v.touched.elapsed()<LEASE_TTL);(c.entries.get(&path).cloned(),c.epoch)};
    #[cfg(windows)] if let Some(e)=cached.as_ref(){
        // The legacy maximum is 4096 manifest entries + seal. The rare 4097-file
        // case keeps full cold acquisition instead of exceeding the batch bound.
        if e.ready._files.len()<=4096{return reuse_held(conn,lib,generation,&path,e,&trusted,&digest);}
    }
    #[cfg(not(windows))] let _=cached;
    #[cfg(test)] CACHE_STATS.with(|s|s.borrow_mut().pin_chains+=1);
    let pins=Arc::new(files::SnapshotPins::new(&path)?);owned(conn,lib,generation,&path,&pins)?;
    let seal_bytes=read_manifest(&path.join("sealed.json"),&pins)?;
    if trusted!=format!("sha256:{:x}",Sha256::digest(&seal_bytes)){return Err("INDEX_SEAL_UNTRUSTED: 封存SHA与发布事务不同".into());}
    let sealed:serde_json::Value=serde_json::from_slice(&seal_bytes).map_err(err)?;
    if sealed["format"]!=FORMAT||sealed["digest"]!=digest{return Err("INDEX_SEAL_MISMATCH".into());}
    let entries=sealed["files"].as_array().ok_or("INDEX_SEAL_INVALID")?;
    if entries.is_empty()||entries.len()>4096{return Err("INDEX_SEAL_INVALID".into());}
    #[cfg(test)] CACHE_STATS.with(|s|s.borrow_mut().pin_opens+=1);
    let seal_file=pins.file(&path.join("sealed.json"),false)?;
    let mut fingerprints=vec![pins.entity()?,held_fingerprint(&seal_file)?];let mut names=HashSet::new();let mut held_files=vec![seal_file];
    // SQL anchor + real entity identities on acquisition; hashes on first open, per-document SHA on read.
    for e in entries {let name=e["name"].as_str().ok_or("INDEX_SEAL_INVALID")?;if Path::new(name).components().count()!=1||name.contains('/')||name.contains('\\')||name=="."||name==".."||!names.insert(name){return Err("INDEX_SEAL_INVALID".into());}
        #[cfg(test)] CACHE_STATS.with(|s|s.borrow_mut().pin_opens+=1);
        let file=pins.file(&path.join(name),false)?;fingerprints.push(held_fingerprint(&file)?);
        if file.metadata().map_err(err)?.len()!=e["bytes"].as_u64().ok_or("INDEX_SEAL_INVALID")?{return Err("INDEX_FILE_CHANGED".into());}held_files.push(file);}
    check_inventory(&path,&names)?;
    #[cfg(not(windows))] {
        let mut c=cache().lock().map_err(|_|"INDEX_CACHE_POISONED")?;c.entries.retain(|_,v|v.touched.elapsed()<LEASE_TTL);
        if c.epoch==ticket{if let Some(e)=c.entries.get_mut(&path){if e.seal_hash!=trusted||e.digest!=digest||e.fingerprints!=fingerprints{return Err("INDEX_FILE_CHANGED".into());}e.touched=Instant::now();return Ok(e.ready.clone());}}
    }
    for(e,file)in entries.iter().zip(held_files.iter_mut().skip(1)){
        #[cfg(test)] CACHE_STATS.with(|s|s.borrow_mut().cold_fullhashfiles+=1);
        let h=hash_reader(file,&AtomicBool::new(false))?;if e["sha256"].as_str()!=Some(&h.sha256){return Err("INDEX_FILE_HASH_MISMATCH".into());}}
    let index=Index::open_in_dir(&path).map_err(err)?;let(s,fields)=schema();if index.schema()!=s{return Err("INDEX_SCHEMA_UNSUPPORTED".into());}
    // Fixed schema has postings/positions/norms/fast/store/terms. Delete is optional.
    for segment in index.searchable_segment_metas().map_err(err)?{for file in segment.list_files(){if file.extension().and_then(|e|e.to_str())!=Some("del")&&!names.contains(file.to_str().ok_or("INDEX_PATH_ENCODING")?){return Err("INDEX_SEAL_INCOMPLETE: 缺活动segment必需文件".into());}}}
    register(&index);
    let reader=index.reader_builder().reload_policy(ReloadPolicy::Manual).doc_store_cache_num_blocks(STORE_CACHE_BLOCKS).try_into().map_err(err)?;
    check_reader(&index,&reader)?;
    pins.verify()?;let ready=Arc::new(Ready{_index:index,reader,fields,path:path.clone(),_pins:pins,_files:held_files});
    #[cfg(test)] PERF_BEFORE_CACHE_INSERT.with(|hook|{let callback=hook.borrow_mut().take();if let Some(callback)=callback{callback();}});
    let mut c=cache().lock().map_err(|_|"INDEX_CACHE_POISONED")?;
    // A completed forget/remove, even for a miss, forbids late insertion or renewal.
    if c.epoch!=ticket{return Ok(ready);}
    c.entries.retain(|_,v|v.touched.elapsed()<LEASE_TTL);
    if let Some(e)=c.entries.get_mut(&path){if e.seal_hash!=trusted||e.digest!=digest||e.fingerprints!=fingerprints{return Err("INDEX_FILE_CHANGED".into());}e.touched=Instant::now();return Ok(e.ready.clone());}
    if c.entries.len()>=8 {if let Some(p)=c.entries.iter().min_by_key(|(_,e)|e.touched).map(|(p,_)|p.clone()){c.entries.remove(&p);}}
    let file_names=std::iter::once("sealed.json".to_string()).chain(entries.iter().map(|e|e["name"].as_str().unwrap().to_string())).collect();
    c.entries.insert(path,CacheEntry{ready:ready.clone(),touched:Instant::now(),fingerprints,seal_hash:trusted,digest,file_names});Ok(ready)
}
pub(super) fn forget(conn:&Connection,lib:&str,generation:i64)->Result<(),String> {
    let path=location(conn,lib,generation)?;cache().lock().map_err(|_|"INDEX_CACHE_POISONED")?.invalidate(&path)
}
pub(super) fn remove(conn:&Connection,lib:&str,generation:i64)->Result<(),String> {
    // Confirmation must be committed before physical deletion, not nested in an outer SQL transaction.
    if !conn.is_autocommit(){return Err("INDEX_CLEANUP_TRANSACTION_UNCOMMITTED".into());}
    if generation<=0{return Err("SNAPSHOT_INVALID_GENERATION".into());}
    // Only inspect the parent chain here: a confirmed missing tombstone must never
    // resolve/open the old generation path, which may now belong to a replacement.
    let original=managed_root(conn)?.join(format!("{:x}",Sha256::digest(lib.as_bytes()))).join(generation.to_string());
    safe_chain(original.parent().ok_or("INDEX_PATH_UNSAFE")?)?;
    cache().lock().map_err(|_|"INDEX_CACHE_POISONED")?.invalidate(&original)?;
    let registered:Option<(String,Option<String>,bool,String)>=conn.query_row("SELECT entityId,cleanupPath,deleteComplete,cleanupStage FROM kb_snap_managed_entity WHERE libraryId=?1 AND generation=?2",params![lib,generation],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(db_error)?;
    let (entity,cleanup,complete,stage)=match registered{
        Some(row)=>row,
        None=>{
            match fs::symlink_metadata(&original){Ok(_)=>{},Err(e)if e.kind()==std::io::ErrorKind::NotFound=>return Ok(()),Err(e)=>return Err(err(e))}
            let pins=files::SnapshotPins::new(&original)?;owned(conn,lib,generation,&original,&pins)?;let entity=pins.entity()?;
            conn.execute("INSERT INTO kb_snap_managed_entity(libraryId,generation,entityId) VALUES(?1,?2,?3)",params![lib,generation,entity]).map_err(db_error)?;(entity,None,false,"pending".into())
        }
    };
    if stage!="pending"&&stage!="renameConfirmed"{return Err("INDEX_CLEANUP_STAGE_UNSUPPORTED".into());}
    if stage=="renameConfirmed"&&cleanup.is_none(){return Err("INDEX_CLEANUP_STAGE_MISMATCH".into());}
    let prefix=format!("{generation}.gc-");
    let tombstone=match cleanup{
        Some(path)=>{let p=PathBuf::from(path);if p.parent()!=original.parent()||!p.file_name().and_then(|n|n.to_str()).is_some_and(|n|n.starts_with(&prefix)&&n.len()>prefix.len()&&n[prefix.len()..].bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-')){return Err("INDEX_CLEANUP_PATH_UNSAFE".into());}p},
        None=>original.with_file_name(format!("{prefix}{}",new_id("entity")))
    };
    // Preserve the legacy durable deleteComplete marker; missing pending paths alone are not proof.
    if complete{return Ok(());}
    let exists=match fs::symlink_metadata(&tombstone){Ok(_)=>true,Err(e)if e.kind()==std::io::ErrorKind::NotFound=>false,Err(e)=>return Err(err(e))};
    if stage=="renameConfirmed"&&!exists{
        let parent=files::SnapshotPins::parent(&tombstone,false)?;parent.verify()?;
        let changed=conn.execute("UPDATE kb_snap_managed_entity SET deleteComplete=1 WHERE libraryId=?1 AND generation=?2 AND entityId=?3 AND cleanupPath=?4 AND cleanupStage='renameConfirmed' AND deleteComplete=0",params![lib,generation,entity,tombstone.to_string_lossy()]).map_err(db_error)?;
        if changed!=1{return Err("INDEX_CLEANUP_JOURNAL_CHANGED".into());}
        parent.verify()?;return Ok(());
    }
    let source=if exists{&tombstone}else{&original};
    if !exists{
        match fs::symlink_metadata(source){Ok(_)=>{},Err(e)if e.kind()==std::io::ErrorKind::NotFound=>return Err("INDEX_CLEANUP_PENDING_MISSING: 未确认rename，不能猜完成".into()),Err(e)=>return Err(err(e))}
    }
    let mut delete=files::SnapshotDelete::open(source,&entity)?;
    if source!=&tombstone{
        let changed=conn.execute("UPDATE kb_snap_managed_entity SET cleanupPath=?3 WHERE libraryId=?1 AND generation=?2 AND entityId=?4 AND cleanupStage='pending' AND deleteComplete=0 AND (cleanupPath IS NULL OR cleanupPath=?3)",params![lib,generation,tombstone.to_string_lossy(),entity]).map_err(db_error)?;
        if changed!=1{return Err("INDEX_CLEANUP_JOURNAL_CHANGED".into());}
        delete.rename(&tombstone)?;
    }
    if stage=="pending"{
        // DELETE handle and all parent pins stay alive across durable confirmation.
        // Failure leaves the same tombstone intact for an identity-checked retry.
        let changed=conn.execute("UPDATE kb_snap_managed_entity SET cleanupStage='renameConfirmed' WHERE libraryId=?1 AND generation=?2 AND entityId=?3 AND cleanupPath=?4 AND cleanupStage='pending' AND deleteComplete=0",params![lib,generation,entity,tombstone.to_string_lossy()]).map_err(db_error)?;
        if changed!=1{return Err("INDEX_CLEANUP_JOURNAL_CHANGED".into());}
    }
    delete.remove_children()?;delete.finish()?;
    let changed=conn.execute("UPDATE kb_snap_managed_entity SET deleteComplete=1 WHERE libraryId=?1 AND generation=?2 AND entityId=?3 AND cleanupPath=?4 AND cleanupStage='renameConfirmed' AND deleteComplete=0",params![lib,generation,entity,tombstone.to_string_lossy()]).map_err(db_error)?;
    if changed!=1{return Err("INDEX_CLEANUP_JOURNAL_CHANGED".into());}Ok(())
}
pub(super) fn load(conn:&Connection,lib:&str,generation:i64,key:i64)->Result<(Meta,String,String),String> {
    let ready=open(conn,lib,generation)?;let result=ready.by_key(&ready.reader.searcher(),key)?;validate_meta(conn,lib,generation,&result.0)?;Ok(result)
}
/// Copy one compatible member from the trusted immutable store. The reader and
/// entity pins outlive all bounded pages; an expired lease cannot be resurrected.
pub(super) fn copy_member(conn:&Connection,lib:&str,generation:i64,note:&str,parse:&str,cancel:&AtomicBool,mut emit:impl FnMut(&Meta,String,String)->Result<(),String>)->Result<usize,String>{
    let lease=ReadLease::new(conn,lib,generation)?;let ready=open(conn,lib,generation)?;
    lease.renew(conn,lib,generation)?;let searcher=ready.reader.searcher();let mut after=-1i64;let mut count=0usize;
    loop{
        check_cancel(cancel)?;lease.renew(conn,lib,generation)?;ready._pins.verify()?;
        let keys={
            let mut stmt=conn.prepare_cached("SELECT c.chunkKey,c.ordinal FROM kb_snap_member m JOIN kb_snap_chunk c ON c.libraryId=m.libraryId AND c.noteId=m.noteId AND c.parseGeneration=m.parseGeneration WHERE m.libraryId=?1 AND m.generation=?2 AND m.noteId=?3 AND m.parseGeneration=?4 AND c.ordinal>?5 ORDER BY c.ordinal LIMIT 32").map_err(db_error)?;
            let rows=stmt.query_map(params![lib,generation,note,parse,after],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?))).map_err(db_error)?;rows.collect::<Result<Vec<_>,_>>().map_err(db_error)?
        };
        if keys.is_empty(){break;}
        for(key,ordinal)in keys{
            check_cancel(cancel)?;lease.renew(conn,lib,generation)?;
            let(meta,primary,suffix)=ready.by_key(&searcher,key)?;validate_meta(conn,lib,generation,&meta)?;
            if ordinal!=count as i64||meta.ordinal!=count||meta.note!=note||meta.parse!=parse{return Err("INDEX_REUSE_MAPPING_MISMATCH".into());}
            emit(&meta,primary,suffix)?;lease.renew(conn,lib,generation)?;
            after=ordinal;count+=1;
        }
    }
    ready._pins.verify()?;lease.renew(conn,lib,generation)?;Ok(count)
}
/// Bounded immutable store traversal used by full reconstruction validation.
pub(super) fn visit_primary(conn:&Connection,lib:&str,generation:i64,mut emit:impl FnMut(&Meta,&str)->Result<(),String>)->Result<(),String>{
    let _lease=ReadLease::new(conn,lib,generation)?;let ready=open(conn,lib,generation)?;let searcher=ready.reader.searcher();
    let mut stmt=conn.prepare("SELECT c.chunkKey FROM kb_snap_member m JOIN kb_snap_chunk c ON c.libraryId=m.libraryId AND c.noteId=m.noteId AND c.parseGeneration=m.parseGeneration WHERE m.libraryId=?1 AND m.generation=?2 ORDER BY m.noteId,c.ordinal").map_err(db_error)?;
    let mut rows=stmt.query(params![lib,generation]).map_err(db_error)?;
    while let Some(row)=rows.next().map_err(db_error)?{let(m,p,_)=ready.by_key(&searcher,row.get(0).map_err(db_error)?)?;validate_meta(conn,lib,generation,&m)?;emit(&m,&p)?;}
    Ok(())
}
fn query(q:&ParsedQuery,fields:&Fields)->Box<dyn Query> {
    if q.terms.is_empty(){return Box::new(EmptyQuery);}
    let must=q.terms.iter().map(|token| {
        let clauses=fields.terms.iter().zip([8.0,4.0,1.0,0.2]).map(|(field,boost)| {
            let term=TermQuery::new(Term::from_field_text(*field,&fold(token)),IndexRecordOption::WithFreqsAndPositions);
            (Occur::Should,Box::new(BoostQuery::new(Box::new(term),boost)) as Box<dyn Query>)
        }).collect();(Occur::Must,Box::new(BooleanQuery::new(clauses)) as Box<dyn Query>)
    }).collect();Box::new(BooleanQuery::new(must))
}
#[cfg(test)]
pub(super) fn rank_oracle_for_test(conn:&Connection,lib:&str,generation:i64,q:&ParsedQuery)->Result<(Vec<(f64,String,usize,i64)>,usize,Vec<String>),String>{
    let ready=open(conn,lib,generation)?;let searcher=ready.reader.searcher();
    // Full candidate collection is a test-only oracle, never the production collector.
    let top=searcher.search(&*query(q,&ready.fields),&TopDocs::with_limit(searcher.num_docs() as usize).order_by_score()).map_err(err)?;
    let mut ranks=Vec::new();for(score,addr)in top{let(m,_,_)=extract(&searcher.doc::<TantivyDocument>(addr).map_err(err)?,&ready.fields)?;ranks.push((-f64::from(score),m.note,m.ordinal,m.key));}
    ranks.sort_by(|a,b|a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)).then(a.3.cmp(&b.3)));
    let mut physical=Vec::new();for(segment,reader)in searcher.segment_readers().iter().enumerate(){for doc in reader.doc_ids_alive(){let(m,_,_)=extract(&searcher.doc::<TantivyDocument>(DocAddress::new(segment as u32,doc)).map_err(err)?,&ready.fields)?;physical.push(m.note);}}
    Ok((ranks,searcher.segment_readers().len(),physical))
}
pub(super) fn search(conn:&Connection,lib:&str,generation:i64,q:&ParsedQuery)->Result<(Vec<RawHit>,bool),String> {
    let ready=open(conn,lib,generation)?;let searcher=ready.reader.searcher();let mut hits=Vec::new();let mut seen=HashSet::new();let mut incomplete=false;
    let mut consume=|meta:Meta,primary:String,suffix:String,score:f64|->Result<(),String>{
        validate_meta(conn,lib,generation,&meta)?;
        let text=format!("{primary}{suffix}");
        if let Some(span)=owned_match(&text,primary.len(),&format!("{}\n{}",meta.title,meta.relative_uri),&meta.heading,q) {
            let identity=(meta.note.clone(),span.map(|(a,b)|(meta.start+a as u64,meta.start+b as u64)));
            if seen.insert(identity){hits.push(RawHit{note_id:meta.note,relative_uri:meta.relative_uri,title:meta.title,heading:meta.heading,chunk_key:meta.key,ordinal:meta.ordinal,score,chunk_text:text,metadata_only:meta.kind=="metadata",snapshot_generation:Some(generation)});}
        }Ok(())
    };
    if q.terms.is_empty() {
        let mut stmt=conn.prepare("SELECT c.chunkKey FROM kb_snap_member m JOIN kb_snap_chunk c ON c.libraryId=m.libraryId AND c.noteId=m.noteId AND c.parseGeneration=m.parseGeneration WHERE m.libraryId=?1 AND m.generation=?2 ORDER BY m.noteId,c.ordinal LIMIT 1001").map_err(db_error)?;
        let mut rows=stmt.query(params![lib,generation]).map_err(db_error)?;let mut n=0;let mut bytes=0;
        while let Some(row)=rows.next().map_err(db_error)? {
            n+=1;if n>kb_index::SCAN_MAX_ROWS{incomplete=true;break;}
            let (m,p,s)=ready.by_key(&searcher,row.get(0).map_err(db_error)?)?;bytes+=p.len()+s.len()+m.title.len()+m.relative_uri.len();
            if bytes>kb_index::SCAN_MAX_BYTES{incomplete=true;break;}consume(m,p,s,0.0)?;
        }
    }else {
        use tantivy::collector::sort_key::{SortBySimilarityScore,SortByString,SortByStaticFastValue};
        // 0.26.0's flat four-tuple defaults its comparator instead of forwarding
        // dynamic Orders. Nested pairs forward them for both TopK and merging.
        let collector=TopDocs::with_limit(101).order_by((
            (SortBySimilarityScore,tantivy::Order::Desc),
            ((SortByString::for_field("stable_note"),tantivy::Order::Asc),
                ((SortByStaticFastValue::<u64>::for_field("stable_ordinal"),tantivy::Order::Asc),
                 (SortByStaticFastValue::<u64>::for_field("chunk_key"),tantivy::Order::Asc)))
        ));
        let top=searcher.search(&*query(q,&ready.fields),&collector).map_err(err)?;incomplete=top.len()>100;
        for((score,(note,(ordinal,key))),addr)in top.into_iter().take(100){
            let(m,p,s)=extract(&searcher.doc::<TantivyDocument>(addr).map_err(err)?,&ready.fields)?;
            if note.as_deref()!=Some(m.note.as_str())||ordinal!=Some(m.ordinal as u64)||key!=Some(m.key as u64){return Err("INDEX_SORT_KEY_MISMATCH".into());}
            consume(m,p,s,-f64::from(score))?;
        }
    }
    hits.sort_by(|a,b|a.score.total_cmp(&b.score).then(a.note_id.cmp(&b.note_id)).then(a.ordinal.cmp(&b.ordinal)).then(a.chunk_key.cmp(&b.chunk_key)));
    if hits.len()>100{hits.truncate(100);incomplete=true;}Ok((hits,incomplete))
}

#[cfg(test)]
#[path="kb_tantivy_faults.rs"]
pub(super) mod io_faults;

#[cfg(test)]
mod io_trace_tests {
    use super::*;
    #[test]
    fn io_observation_is_bounded_and_gc_is_not_a_root_cause(){
        let trace=IoTrace::default();
        for i in 0..20{trace.record_detail("delete_may_be_tolerated",Path::new("temporary"),&format!("event-{i} {}","中".repeat(3000)));}
        trace.record("write",Path::new("fatal.fieldnorm"),&std::io::Error::new(std::io::ErrorKind::PermissionDenied,"write denied"));
        let message=trace.enrich("writer failed");assert!(message.contains("fatal.fieldnorm"));assert!(!message.contains("root_io="));
        let state=trace.0.lock().unwrap();assert_eq!(state.events.len(),8);assert_eq!(state.dropped,13);
        assert!(state.events.iter().all(|s|s.len()<=2048));assert!(state.events[0].contains("event-0"));
    }
    #[test]
    fn tolerated_missing_delete_preserves_the_original_variant(){
        let path=std::env::temp_dir().join(new_id("tantivy-missing-delete"));fs::create_dir(&path).unwrap();
        let trace=IoTrace::default();let directory=ObservedDirectory{inner:Box::new(tantivy::directory::MmapDirectory::open(&path).unwrap()),trace:trace.clone()};
        assert!(matches!(directory.delete(Path::new("missing")),Err(tantivy::directory::error::DeleteError::FileDoesNotExist(_))));
        assert_eq!(directory.exists(Path::new("missing")).unwrap(),false);
        assert!(trace.enrich("unrelated failure").contains("delete_may_be_tolerated"));assert!(!trace.enrich("unrelated failure").contains("root_io="));
        drop(directory);fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn missing_read_is_observed_without_claiming_root_cause(){
        let path=std::env::temp_dir().join(new_id("tantivy-missing-read"));fs::create_dir(&path).unwrap();
        let trace=IoTrace::default();let directory=ObservedDirectory{inner:Box::new(tantivy::directory::MmapDirectory::open(&path).unwrap()),trace:trace.clone()};
        assert!(matches!(directory.get_file_handle(Path::new("missing.store")),Err(tantivy::directory::error::OpenReadError::FileDoesNotExist(_))));
        let message=trace.enrich("reader failed");
        drop(directory);fs::remove_dir_all(path).unwrap();
        assert!(message.contains("observed_io="),"{message}");
        assert!(message.contains("read missing.store:"),"{message}");
        assert!(!message.contains("root_io="),"correlated observation is not proof of root cause: {message}");
    }
    #[test]
    fn real_missing_parent_io_is_preserved_without_swallowing(){
        let path=std::env::temp_dir().join(new_id("tantivy-io-trace"));fs::create_dir(&path).unwrap();
        let trace=IoTrace::default();let directory=ObservedDirectory{inner:Box::new(tantivy::directory::MmapDirectory::open(&path).unwrap()),trace:trace.clone()};
        assert!(directory.open_write(Path::new("missing/child")).is_err());
        assert!(trace.enrich("writer killed").contains("open_write child:"));
        assert!(!trace.enrich("writer killed").contains("root_io="));
        let mut writer=directory.open_write(Path::new("valid")).unwrap();writer.write_all(b"real bytes").unwrap();
        tantivy::directory::TerminatingWrite::terminate(writer).unwrap();assert_eq!(fs::read(path.join("valid")).unwrap(),b"real bytes");
        drop(directory);fs::remove_dir_all(path).unwrap();
    }
}
