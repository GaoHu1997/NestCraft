//! CR-055: proof that an indexed body still matches the protected original.
//! Callers materialize versioned DB rows first, drop the DB transaction, then hash.
use super::files;
use crate::commands::kb_index::ChunkView;
use rusqlite::{Connection,params,OptionalExtension};
use sha2::{Digest,Sha256};
use std::{collections::HashMap,fs::File,io::Read,path::Path,sync::{Mutex,OnceLock,atomic::{AtomicUsize,Ordering}},time::{Duration,Instant}};

#[derive(Clone)]
pub(super) struct Reference {
    pub library_id:String,
    pub note_id:String,
    pub relative_uri:String,
    pub source_ref:String,
    pub source_hash:String,
    pub expected_sha256:String,
    pub byte_size:Option<u64>,
}
pub(super) struct Proof {root:files::SafeRoot,_file:File,pub reference:Reference}
static ACTIVE:AtomicUsize=AtomicUsize::new(0);
static GATEWAY_ACTIVE:AtomicUsize=AtomicUsize::new(0);
pub(super) struct GatewayPermit;
impl Drop for GatewayPermit {fn drop(&mut self){GATEWAY_ACTIVE.fetch_sub(1,Ordering::AcqRel);}}
pub(super) fn gateway_permit()->Result<GatewayPermit,String>{GATEWAY_ACTIVE.compare_exchange(0,1,Ordering::AcqRel,Ordering::Acquire).map(|_|GatewayPermit).map_err(|_|"BUSY_RETRY: 正在核验另一知识请求".into())}
struct Permit;
impl Drop for Permit {fn drop(&mut self){ACTIVE.fetch_sub(1,Ordering::AcqRel);}}
fn admit()->Result<Permit,String>{
    ACTIVE.fetch_update(Ordering::AcqRel,Ordering::Acquire,|n|if n<2{Some(n+1)}else{None})
        .map(|_|Permit).map_err(|_|"BUSY_RETRY: 原件核验繁忙".into())
}
fn hex(bytes:&[u8])->String{bytes.iter().map(|b|format!("{b:02x}")).collect()}

/// Must be called in the same SQLite read transaction as the ChunkView.
/// Legacy P0 indexed raw UTF-8, so contiguous chunks can prove the original SHA.
pub(super) fn legacy_reference(conn:&Connection,view:&ChunkView)->Result<Reference,String>{
    let source_ref=super::performance::source_ref(conn,&view.library_id)?;
    let relative_uri:String=conn.query_row("SELECT relativeUri FROM kb_chunk WHERE libraryId=?1 AND noteId=?2 AND parseGeneration=?3 AND chunkKey=?4 AND sourceHash=?5",params![view.library_id,view.note_id,view.parse_generation,view.chunk_key,view.source_hash],|r|r.get(0))
        .map_err(|_|"SOURCE_CHANGED: 选定切片身份已失效")?;
    files::relative(&relative_uri)?;
    let mut sha=Sha256::new();let mut position=0u64;let mut ordinal=0i64;
    let mut stmt=conn.prepare("SELECT ordinal,startByte,endByte,text,kind,sourceHash,relativeUri FROM kb_chunk WHERE libraryId=?1 AND noteId=?2 AND parseGeneration=?3 ORDER BY ordinal").map_err(|e|e.to_string())?;
    let mut rows=stmt.query(params![view.library_id,view.note_id,view.parse_generation]).map_err(|e|e.to_string())?;
    while let Some(row)=rows.next().map_err(|e|e.to_string())?{
        let actual:i64=row.get(0).map_err(|e|e.to_string())?;
        let start:i64=row.get(1).map_err(|e|e.to_string())?;let end:i64=row.get(2).map_err(|e|e.to_string())?;
        let text:String=row.get(3).map_err(|e|e.to_string())?;let kind:String=row.get(4).map_err(|e|e.to_string())?;
        let hash:String=row.get(5).map_err(|e|e.to_string())?;let path:String=row.get(6).map_err(|e|e.to_string())?;
        if actual!=ordinal||start<0||end<start||start as u64!=position||end as u64-position!=text.len()as u64||kind!="body"||hash!=view.source_hash||path!=relative_uri||text.len()>4096 {
            return Err("INDEX_COVERAGE_INVALID: 旧代正文范围不连续或身份不一致".into());
        }
        position=end as u64;
        if position>files::TEXT_LIMIT{return Err("INDEX_COVERAGE_INVALID: 旧P0范围超过既有容量，不能当新快照核验".into());}
        sha.update(text.as_bytes());ordinal+=1;
    }
    if ordinal==0{return Err("INDEX_PENDING".into());}
    Ok(Reference{library_id:view.library_id.clone(),note_id:view.note_id.clone(),relative_uri,source_ref,source_hash:view.source_hash.clone(),expected_sha256:hex(&sha.finalize()),byte_size:Some(position)})
}
fn snapshot_reference(conn:&Connection,view:&ChunkView,generation:i64)->Result<Reference,String>{
    let reference=super::snapshot::hit_reference(conn,&view.library_id,generation,view.chunk_key)?;
    let source_ref=super::performance::source_ref(conn,&view.library_id)?;
    let expected_sha256=reference.source_hash.strip_prefix("sha256:").ok_or("INDEX_HASH_INVALID")?.to_string();
    let byte_size:Option<u64>=conn.query_row("SELECT sourceSize FROM kb_snap_member WHERE libraryId=?1 AND generation=?2 AND noteId=?3",params![view.library_id,generation,view.note_id],|r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string())?.and_then(|v|v.parse().ok());
    Ok(Reference{library_id:view.library_id.clone(),note_id:view.note_id.clone(),relative_uri:reference.relative_uri,source_ref,source_hash:reference.source_hash,expected_sha256,byte_size})
}
impl Proof {
    pub fn recheck(&self,conn:&Connection,project_id:Option<&str>)->Result<(),String>{
        self.root.verify()?;
        if super::performance::source_ref(conn,&self.reference.library_id)?!=self.reference.source_ref{return Err("SOURCE_CHANGED: 库根已改变".into());}
        if !super::authorized(conn,project_id)?.contains(&self.reference.library_id){return Err("KNOWLEDGE_DENIED: 知识授权已撤销".into());}
        Ok(())
    }
}

pub(super) fn verify(reference:Reference)->Result<Proof,String>{
    #[cfg(not(windows))]
    {let _=reference;return Err("SNAPSHOT_UNAVAILABLE: 本平台尚未验证原件读保护".into());}
    #[cfg(windows)]
    {
        let permit=admit()?;
        let mut root=files::SafeRoot::new(Path::new(&reference.source_ref))?;
        let mut file=files::open_snapshot(&mut root,&reference.relative_uri)?;
        let size=file.metadata().map_err(|_|"SOURCE_UNAVAILABLE")?.len();
        if reference.byte_size.map(|n|n!=size).unwrap_or(false){return Err("SOURCE_CHANGED: 原件大小与索引不同".into());}
        if reference.expected_sha256.len()!=64||!reference.expected_sha256.bytes().all(|b|b.is_ascii_hexdigit()){return Err("INDEX_HASH_INVALID".into());}
        let mut sha=Sha256::new();let mut fnv=0xcbf29ce484222325u64;let mut count=0u64;let mut buffer=[0u8;65536];
        loop{let n=file.read(&mut buffer).map_err(|_|"SOURCE_UNAVAILABLE: 原件无法核验")?;if n==0{break;}count+=n as u64;sha.update(&buffer[..n]);for b in &buffer[..n]{fnv=(fnv^u64::from(*b)).wrapping_mul(0x100000001b3);}}
        if count!=size||hex(&sha.finalize())!=reference.expected_sha256.to_lowercase(){return Err("SOURCE_CHANGED: 原件完整SHA-256不匹配，拒绝将旧正文发送AI".into());}
        if let Some(hash)=reference.source_hash.strip_prefix("fnv1a64:"){if hash!=format!("{fnv:016x}"){return Err("SOURCE_CHANGED: 旧索引指纹不一致".into());}}
        else if reference.source_hash!=format!("sha256:{}",reference.expected_sha256.to_lowercase()){return Err("INDEX_HASH_INVALID".into());}
        root.verify()?;
        drop(permit);
        Ok(Proof{root,_file:file,reference})
    }
}

#[derive(Clone)]
pub(super) struct Prepared {
    pub view:ChunkView,
    pub reference:Reference,
    pub grant_revision:i64,
    pub index_epoch:i64,
    pub snapshot_generation:Option<i64>,
}
#[derive(Clone)]
struct Cached {project:String,library:String,prepared:Prepared,created:Instant}
static REFERENCES:OnceLock<Mutex<HashMap<String,Cached>>>=OnceLock::new();
fn references()->&'static Mutex<HashMap<String,Cached>> {REFERENCES.get_or_init(||Mutex::new(HashMap::new()))}
fn grant_revision(conn:&Connection,project:Option<&str>,library:&str)->Result<i64,String>{
    let project=project.ok_or("KNOWLEDGE_DENIED")?;
    conn.query_row("SELECT g.revision FROM project_library_grant g JOIN knowledge_library l ON l.id=g.libraryId WHERE g.projectId=?1 AND g.libraryId=?2 AND g.readAllowed=1 AND l.enabled=1",params![project,library],|r|r.get(0))
        .map_err(|_|"KNOWLEDGE_DENIED: 知识库已撤权或停用".into())
}
fn index_epoch(conn:&Connection,library:&str)->Result<i64,String>{conn.query_row("SELECT indexEpoch FROM kb_library_state WHERE libraryId=?1",[library],|r|r.get(0)).map_err(|_|"INDEX_PENDING".into())}
fn stash(project:Option<&str>,prepared:Prepared)->Result<String,String>{
    let project=project.ok_or("KNOWLEDGE_DENIED")?;
    let mut entries=references().lock().map_err(|_|"引用锁不可用")?;
    entries.retain(|_,v|v.created.elapsed()<Duration::from_secs(60));
    if entries.len()>=128 {if let Some(key)=entries.iter().min_by_key(|(_,v)|v.created).map(|(key,_)|key.clone()){entries.remove(&key);}}
    let id=crate::models::new_id("kbhit");
    entries.insert(id.clone(),Cached{project:project.into(),library:prepared.view.library_id.clone(),prepared,created:Instant::now()});Ok(format!("kbref:{id}"))
}
fn cached(project:Option<&str>,library:&str,id:&str)->Result<Prepared,String>{
    let key=id.strip_prefix("kbref:").ok_or("REFERENCE_INVALID")?;
    let mut entries=references().lock().map_err(|_|"引用锁不可用")?;
    entries.retain(|_,v|v.created.elapsed()<Duration::from_secs(60));
    let entry=entries.get(key).ok_or("REFERENCE_EXPIRED: 请重新检索")?;
    if Some(entry.project.as_str())!=project||entry.library!=library{return Err("REFERENCE_SCOPE_MISMATCH".into());}
    Ok(entry.prepared.clone())
}
fn from_view(conn:&Connection,project:Option<&str>,view:ChunkView)->Result<Prepared,String>{
    let grant_revision=grant_revision(conn,project,&view.library_id)?;
    let index_epoch=index_epoch(conn,&view.library_id)?;
    let reference=legacy_reference(conn,&view)?;
    Ok(Prepared{view,reference,grant_revision,index_epoch,snapshot_generation:None})
}
fn from_snapshot(conn:&Connection,project:Option<&str>,view:ChunkView,generation:i64)->Result<Prepared,String>{
    let grant_revision=grant_revision(conn,project,&view.library_id)?;
    let epoch=super::snapshot::active_snapshot(conn,&view.library_id)?.filter(|s|s.generation==generation).ok_or("INDEX_CHANGED: 所选快照已不再活动")?.epoch;
    let reference=snapshot_reference(conn,&view,generation)?;
    Ok(Prepared{view,reference,grant_revision,index_epoch:epoch,snapshot_generation:Some(generation)})
}
fn prepare(conn:&Connection,project:Option<&str>,library:&str,note:Option<&str>,cursor:Option<&str>)->Result<Prepared,String>{
    if let Some(cursor)=cursor{if cursor.starts_with("kbref:"){let p=cached(project,library,cursor)?;recheck(conn,project,&p)?;return Ok(p);}}
    let view=if let Some(cursor)=cursor{crate::commands::kb_index::gateway_read_cursor_conn(conn,project,library,cursor,None)?}
        else{crate::commands::kb_index::gateway_read_chunk_conn(conn,project,library,note.ok_or("缺少noteId或cursor")?,None)?};
    from_view(conn,project,view)
}
fn recheck(conn:&Connection,project:Option<&str>,prepared:&Prepared)->Result<(),String>{
    if grant_revision(conn,project,&prepared.view.library_id)?!=prepared.grant_revision{return Err("KNOWLEDGE_DENIED: 授权版本已变化".into());}
    if super::performance::source_ref(conn,&prepared.reference.library_id)?!=prepared.reference.source_ref{return Err("SOURCE_CHANGED: 库根已改变".into());}
    if let Some(generation)=prepared.snapshot_generation {
        let active=super::snapshot::active_snapshot(conn,&prepared.view.library_id)?.ok_or("INDEX_CHANGED: 快照已失效")?;
        if active.generation!=generation||active.epoch!=prepared.index_epoch{return Err("INDEX_CHANGED: 所选索引代已改变，请重新选择".into());}
        super::snapshot::hit_reference(conn,&prepared.view.library_id,generation,prepared.view.chunk_key)?;
        return Ok(())
    }
    if index_epoch(conn,&prepared.view.library_id)?!=prepared.index_epoch{return Err("INDEX_CHANGED: 所选索引代已改变，请重新选择".into());}
    let matches:i64=conn.query_row("SELECT COUNT(*) FROM kb_chunk WHERE libraryId=?1 AND noteId=?2 AND parseGeneration=?3 AND chunkKey=?4 AND sourceHash=?5",params![prepared.view.library_id,prepared.view.note_id,prepared.view.parse_generation,prepared.view.chunk_key,prepared.view.source_hash],|r|r.get(0)).map_err(|e|e.to_string())?;
    if matches!=1{return Err("SOURCE_CHANGED: 所选片段已失效".into());}Ok(())
}
fn bounded_view(project:Option<&str>,prepared:&Prepared,max_bytes:Option<usize>)->Result<ChunkView,String>{
    let mut view=prepared.view.clone();
    if let Some(max)=max_bytes {let mut end=max.min(view.content.len());while !view.content.is_char_boundary(end){end-=1;}view.content.truncate(end);}
    view=crate::commands::kb_index::fit_response(view)?;
    let consumed=view.content.len();
    if consumed==0&&!prepared.view.content.is_empty(){return Err("BUDGET_EXCEEDED: 预算不足以推进正文游标".into());}
    if consumed<prepared.view.content.len(){
        let mut remainder=prepared.clone();remainder.view.content=prepared.view.content[consumed..].to_string();remainder.view.start_byte+=consumed;
        remainder.view.start_line+=view.content.bytes().filter(|c|*c==b'\n').count();
        view.next_cursor=Some(stash(project,remainder)?);view.truncated=true;view.eof=false;
    }
    view.end_byte=view.start_byte+consumed;
    if !view.content.is_empty(){view.end_line=view.start_line+view.content.bytes().filter(|c|*c==b'\n').count()-usize::from(view.content.ends_with('\n'));}
    if serde_json::to_vec(&view).map_err(|e|e.to_string())?.len()>crate::commands::kb_index::RESPONSE_BUDGET_BYTES{return Err("BUDGET_EXCEEDED: 完整引用超出响应预算".into());}
    Ok(view)
}
/// Returns the proof too, allowing read_many to hold all original protections until final envelope materialization.
pub(super) fn read(conn:&Connection,project:Option<&str>,library:&str,note:Option<&str>,cursor:Option<&str>,max_bytes:Option<usize>)->Result<(ChunkView,Proof,Prepared),String>{
    let tx=conn.unchecked_transaction().map_err(|e|e.to_string())?;
    let prepared=prepare(&tx,project,library,note,cursor)?;
    tx.commit().map_err(|e|e.to_string())?;
    let proof=verify(prepared.reference.clone())?;
    let view=bounded_view(project,&prepared,max_bytes)?;
    proof.recheck(conn,project)?;recheck(conn,project,&prepared)?;
    Ok((view,proof,prepared))
}
pub(super) fn search(conn:&Connection,project:Option<&str>,query:&str)->Result<serde_json::Value,String>{
    let tx=conn.unchecked_transaction().map_err(|e|e.to_string())?;
    let libraries=super::authorized(&tx,project)?;
    if libraries.is_empty(){return Ok(serde_json::json!({"hits":[],"denied":true}));}
    let mut usable=Vec::new(); let mut excluded=Vec::new();
    for library in libraries {if super::snapshot::active_snapshot(&tx,&library)?.is_some() || index_epoch(&tx,&library).unwrap_or(0)>0{usable.push(library);}else{excluded.push(library);}}
    let (hits,mut incomplete)=super::search_candidates_bounded(&tx,&usable,query,5)?;
    let mut prepared_hits=Vec::new();
    for (hit,metadata,raw) in hits {
        let grant=grant_revision(&tx,project,&hit.library_id)?;
        if metadata {prepared_hits.push((hit,None,grant));continue;}
        let prepared=if let Some(generation)=raw.snapshot_generation {
            let view=super::snapshot::read_hit_conn(&tx,&hit.library_id,generation,raw.chunk_key,None)?;
            if view.chunk_key!=raw.chunk_key{return Err("INDEX_CHANGED".into());}
            Some(from_snapshot(&tx,project,view,generation)?)
        } else {
            let (hash,generation):(String,String)=tx.query_row("SELECT sourceHash,parseGeneration FROM kb_chunk WHERE libraryId=?1 AND noteId=?2 AND chunkKey=?3",params![hit.library_id,raw.note_id,raw.chunk_key],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|"SOURCE_CHANGED")?;
            let cursor=format!("{}:{}:{}",raw.note_id,raw.ordinal,hash);
            let view=crate::commands::kb_index::gateway_read_cursor_conn(&tx,project,&hit.library_id,&cursor,None)?;
            if view.chunk_key!=raw.chunk_key||view.parse_generation!=generation{return Err("INDEX_CHANGED".into());}
            Some(from_view(&tx,project,view)?)
        };
        prepared_hits.push((hit,prepared,grant));
    }
    tx.commit().map_err(|e|e.to_string())?;
    let mut values=Vec::new();let mut protections=Vec::new();
    incomplete|=!excluded.is_empty();
    for (hit,prepared,grant) in prepared_hits {
        if grant_revision(conn,project,&hit.library_id)?!=grant{return Err("KNOWLEDGE_DENIED".into());}
        let mut value=serde_json::to_value(&hit).map_err(|e|e.to_string())?;
        if let Some(prepared)=prepared {
            let proof=verify(prepared.reference.clone())?;
            proof.recheck(conn,project)?;recheck(conn,project,&prepared)?;
            value["sourceHash"]=serde_json::json!(prepared.view.source_hash);
            value["parseGeneration"]=serde_json::json!(prepared.view.parse_generation);
            value["startByte"]=serde_json::json!(prepared.view.start_byte);
            value["endByte"]=serde_json::json!(prepared.view.end_byte);
            value["hitRef"]=serde_json::json!(stash(project,prepared.clone())?);
            value["sourceVerified"]=serde_json::json!(true);
            protections.push((proof,prepared));
        }else {value["contentUnavailable"]=serde_json::json!(true);}
        values.push(value);
        let proposed=serde_json::json!({"hits":values,"denied":false,"incomplete":incomplete,"excludedLibraries":excluded});
        if serde_json::to_vec(&proposed).map_err(|e|e.to_string())?.len()>crate::commands::kb_index::RESPONSE_BUDGET_BYTES {values.pop();incomplete=true;break;}
    }
    for (proof,prepared) in &protections {proof.recheck(conn,project)?;recheck(conn,project,prepared)?;}
    let out=serde_json::json!({"hits":values,"denied":false,"incomplete":incomplete,"excludedLibraries":excluded});
    if serde_json::to_vec(&out).map_err(|e|e.to_string())?.len()>crate::commands::kb_index::RESPONSE_BUDGET_BYTES{return Err("BUDGET_EXCEEDED".into());}
    Ok(out)
}
pub(super) fn read_many(conn:&Connection,project:Option<&str>,items:&[serde_json::Value])->Result<serde_json::Value,String>{
    if items.len()>100{return Err("单次最多选择100篇笔记".into());}
    let mut notes=Vec::new();let mut errors=Vec::new();let mut proofs=Vec::new();let mut next=None;
    for(index,item)in items.iter().enumerate(){
        let library=item.get("libraryId").and_then(|v|v.as_str()).ok_or("缺少libraryId")?;
        let note=item.get("noteId").and_then(|v|v.as_str());let cursor=item.get("hitRef").or_else(||item.get("cursor")).and_then(|v|v.as_str());
        let before_notes=notes.len();let before_errors=errors.len();
        match read(conn,project,library,note,cursor,None){
            Ok((view,proof,prepared))=>{notes.push(serde_json::to_value(view).map_err(|e|e.to_string())?);proofs.push((proof,prepared));},
            Err(error)=>errors.push(serde_json::json!({"noteId":note,"error":error})),
        }
        let out=serde_json::json!({"notes":notes,"errors":errors,"incomplete":true,"nextIndex":index+1});
        if serde_json::to_vec(&out).map_err(|e|e.to_string())?.len()>crate::commands::kb_index::RESPONSE_BUDGET_BYTES {
            notes.truncate(before_notes);errors.truncate(before_errors);next=Some(index);break;
        }
    }
    for(proof,prepared)in &proofs{proof.recheck(conn,project)?;recheck(conn,project,prepared)?;}
    let out=serde_json::json!({"notes":notes,"errors":errors,"incomplete":next.is_some(),"nextIndex":next});
    if serde_json::to_vec(&out).map_err(|e|e.to_string())?.len()>crate::commands::kb_index::RESPONSE_BUDGET_BYTES{return Err("BUDGET_EXCEEDED".into());}
    Ok(out)
}

#[cfg(test)]
mod tests{
    use super::*;
    #[cfg(windows)]
    static VERIFY_TESTS:Mutex<()>=Mutex::new(());
    #[cfg(windows)]
    struct Fixture {conn:Connection,path:std::path::PathBuf,note:String}
    #[cfg(windows)]
    impl Fixture {
        fn new(body:&str)->Self{
            let base=std::fs::canonicalize(std::env::temp_dir()).unwrap();let path=base.join(crate::models::new_id("kb-ai-test"));std::fs::create_dir(&path).unwrap();std::fs::write(path.join("note.md"),body).unwrap();
            let conn=Connection::open_in_memory().unwrap();
            conn.execute_batch("CREATE TABLE knowledge_library(id TEXT PRIMARY KEY,name TEXT,sourceKind TEXT,sourceRef TEXT,revision INTEGER,enabled INTEGER,createdAt INTEGER); CREATE TABLE knowledge_note_index(libraryId TEXT,noteId TEXT,title TEXT,relativeUri TEXT,contentHash TEXT,updatedAt INTEGER,PRIMARY KEY(libraryId,noteId),UNIQUE(libraryId,relativeUri)); CREATE TABLE project_library_grant(projectId TEXT,libraryId TEXT,readAllowed INTEGER,revision INTEGER); CREATE TABLE schema_version(version INTEGER PRIMARY KEY,appliedAt INTEGER);").unwrap();
            crate::commands::kb_index::migrate_cr030_knowledge_index(&conn).unwrap();
            conn.execute("INSERT INTO knowledge_library VALUES('kb','Test','managed-directory',?1,0,1,0)",[path.to_string_lossy().as_ref()]).unwrap();
            conn.execute("INSERT INTO project_library_grant VALUES('p','kb',1,1)",[]).unwrap();
            let note=super::super::publish_note(&conn,"kb","note.md",body).unwrap();Self{conn,path,note}
        }
    }
    #[cfg(windows)]
    impl Drop for Fixture {fn drop(&mut self){let _=std::fs::remove_dir_all(&self.path);}}
    #[cfg(windows)]
    #[test]
    fn ai_search_snippet_and_read_reject_external_change_and_deletion(){
        let _serial=VERIFY_TESTS.lock().unwrap();let f=Fixture::new("# original\nneedle secret source");
        let response=search(&f.conn,Some("p"),"needle").unwrap();assert_eq!(response["hits"].as_array().unwrap().len(),1);assert_eq!(response["hits"][0]["sourceVerified"],true);
        let hit=response["hits"][0]["hitRef"].as_str().unwrap();
        let(view,proof,_)=read(&f.conn,Some("p"),"kb",None,Some(hit),None).unwrap();assert!(view.content.contains("needle"));drop(proof);
        std::fs::write(f.path.join("note.md"),"# external\nchanged but not indexed").unwrap();
        assert!(search(&f.conn,Some("p"),"needle").is_err());assert!(read(&f.conn,Some("p"),"kb",Some(&f.note),None,None).is_err());
        std::fs::remove_file(f.path.join("note.md")).unwrap();assert!(search(&f.conn,Some("p"),"needle").is_err());assert!(read(&f.conn,Some("p"),"kb",None,Some(hit),None).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn ai_fragment_cursor_has_no_skips_and_rechecks_revocation(){
        let _serial=VERIFY_TESTS.lock().unwrap();let body=format!("needle {}","中文😀 ".repeat(300));let f=Fixture::new(&body);
        let mut cursor=None;let mut collected=String::new();
        for _ in 0..500 {
            let(view,proof,prepared)=read(&f.conn,Some("p"),"kb",Some(&f.note),cursor.as_deref(),Some(37)).unwrap();
            assert_eq!(view.end_byte-view.start_byte,view.content.len());collected.push_str(&view.content);
            cursor=view.next_cursor.clone();proof.recheck(&f.conn,Some("p")).unwrap();recheck(&f.conn,Some("p"),&prepared).unwrap();drop(proof);
            if cursor.is_none(){break;}
        }
        assert_eq!(collected,body);
        let(_,proof,prepared)=read(&f.conn,Some("p"),"kb",Some(&f.note),None,None).unwrap();
        f.conn.execute("UPDATE project_library_grant SET readAllowed=0,revision=revision+1",[]).unwrap();
        assert!(proof.recheck(&f.conn,Some("p")).is_err());assert!(recheck(&f.conn,Some("p"),&prepared).is_err());drop(proof);
    }
    #[cfg(windows)]
    #[test]
    fn ai_read_many_budgets_complete_envelope(){
        let _serial=VERIFY_TESTS.lock().unwrap();let f=Fixture::new(&format!("needle {}","文".repeat(2000)));
        let items=(0..20).map(|_|serde_json::json!({"libraryId":"kb","noteId":f.note})).collect::<Vec<_>>();
        let response=read_many(&f.conn,Some("p"),&items).unwrap();assert!(serde_json::to_vec(&response).unwrap().len()<=8192);assert_eq!(response["incomplete"],true);assert!(response["nextIndex"].as_u64().unwrap()<20);
    }
    #[test]
    fn legacy_sha_requires_one_complete_contiguous_generation(){
        let conn=Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE knowledge_library(id TEXT,sourceRef TEXT,enabled INTEGER,sourceKind TEXT); INSERT INTO knowledge_library VALUES('lib','unused',1,'managed-directory'); CREATE TABLE kb_chunk(libraryId TEXT,noteId TEXT,parseGeneration TEXT,chunkKey INTEGER,sourceHash TEXT,relativeUri TEXT,ordinal INTEGER,startByte INTEGER,endByte INTEGER,text TEXT,kind TEXT);").unwrap();
        let hash=files::hash(b"hello");
        conn.execute("INSERT INTO kb_chunk VALUES('lib','n','g',1,?1,'a.txt',0,0,5,'hello','body')",[&hash]).unwrap();
        let view=ChunkView{library_id:"lib".into(),note_id:"n".into(),source_hash:hash,parse_generation:"g".into(),chunk_key:1,ordinal:0,start_byte:0,end_byte:5,start_line:1,end_line:1,heading:String::new(),content:"hello".into(),truncated:false,eof:true,next_cursor:None};
        let reference=legacy_reference(&conn,&view).unwrap();assert_eq!(reference.byte_size,Some(5));assert_eq!(reference.expected_sha256,hex(&Sha256::digest(b"hello")));
        conn.execute("UPDATE kb_chunk SET startByte=1",[]).unwrap();assert!(legacy_reference(&conn,&view).is_err());
        conn.execute("UPDATE kb_chunk SET startByte=0,kind='metadata'",[]).unwrap();assert!(legacy_reference(&conn,&view).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn originals_are_pinned_and_changes_or_missing_sources_are_rejected(){
        let base=std::fs::canonicalize(std::env::temp_dir()).unwrap();let path=base.join(crate::models::new_id("kb-proof"));std::fs::create_dir(&path).unwrap();std::fs::write(path.join("a.txt"),b"original").unwrap();
        let reference=||Reference{library_id:"lib".into(),note_id:"n".into(),relative_uri:"a.txt".into(),source_ref:path.to_string_lossy().into_owned(),source_hash:files::hash(b"original"),expected_sha256:hex(&Sha256::digest(b"original")),byte_size:Some(8)};
        let proof=verify(reference()).unwrap();assert!(std::fs::write(path.join("a.txt"),b"external").is_err());drop(proof);
        std::fs::write(path.join("a.txt"),b"external").unwrap();assert!(verify(reference()).is_err());
        std::fs::remove_file(path.join("a.txt")).unwrap();assert!(verify(reference()).is_err());std::fs::remove_dir(path).unwrap();
    }
}
