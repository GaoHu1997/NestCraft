//! FEAT-007: bounded directory snapshots and cooperative, streamed literal search.
use serde::Serialize;
use tauri::WebviewWindow;
use std::{collections::{HashMap, VecDeque}, fs, io::{BufRead, BufReader}, path::{Path, PathBuf}, sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
use super::{guard, resources};
const PAGE_BYTES: usize = 256 * 1024;
const SNAPSHOT_BYTES: usize = 32 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(60);
const HIDDEN: &[&str] = &["node_modules", ".git", "target", "dist"];
const TEXT_EXT: &[&str] = &["md", "txt", "rs", "ts", "tsx", "js", "jsx", "json", "toml", "yaml", "yml", "css", "html", "py", "java", "go", "c", "h", "cpp", "sql", "sh", "vue", "xml"];

pub(super) fn checked_path(root: &str, target: &str) -> Result<(PathBuf, PathBuf), String> {
    if !Path::new(root).is_absolute() { return Err("ROOT_INVALID: 项目根必须是绝对目录".into()); }
    let root_path = fs::canonicalize(root).map_err(|e| format!("ROOT_UNAVAILABLE: {e}"))?;
    if Path::new(target).components().any(|p| matches!(p, std::path::Component::ParentDir)) { return Err("PATH_ESCAPE: 不允许父路径穿越".into()); }
    let requested = if Path::new(target).is_absolute() { PathBuf::from(target) } else { Path::new(root).join(target) };
    let target_path = fs::canonicalize(&requested).map_err(|e| format!("SOURCE_UNAVAILABLE: {e}"))?;
    if !target_path.starts_with(&root_path) { return Err("PATH_ESCAPE: 文件不在项目根内".into()); }
    if reparse(&fs::symlink_metadata(&requested).map_err(|e| e.to_string())?) { return Err("PATH_LINK: 不读取链接或重解析点".into()); }
    let mut p = target_path.clone();
    loop {
        if reparse(&fs::symlink_metadata(&p).map_err(|e| e.to_string())?) { return Err("PATH_LINK: 不读取重解析路径".into()); }
        if p == root_path { break; }
        if !p.pop() { return Err("PATH_ESCAPE".into()); }
    }
    Ok((root_path, target_path))
}
pub(super) fn reparse(meta: &fs::Metadata) -> bool {
    #[cfg(windows)] { use std::os::windows::fs::MetadataExt; meta.file_attributes() & 0x400 != 0 }
    #[cfg(not(windows))] { meta.file_type().is_symlink() }
}
pub(super) fn fingerprint(meta: &fs::Metadata) -> String {
    format!("{}:{:?}:{:?}", meta.len(), meta.modified().ok(), meta.created().ok())
}
fn scope(window: &WebviewWindow, root: &Path) -> String { format!("{}\n{}", window.label(), root.display()) }

#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Entry { pub name:String, pub path:String, pub is_dir:bool, pub size:Option<u64> }
struct Directory { owner:String, path:PathBuf, revision:String, entries:Vec<Entry>, touched:Instant, bytes:usize }
static DIRECTORIES: OnceLock<Mutex<HashMap<String, Directory>>> = OnceLock::new();
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct DirectoryPage { pub items:Vec<Entry>, pub next_cursor:Option<String>, pub directory_revision:String, pub complete:bool }
fn directory_page(owner:String, root:String, relative:String, cursor:Option<String>, limit:usize) -> Result<DirectoryPage,String> {
    let rooted = guard::RootedPath::new(&root, &relative, false)?;
    rooted.verify()?;
    let target = rooted.path.clone();
    let revision=fingerprint(&fs::metadata(&target).map_err(|e|e.to_string())?);
    let cache=DIRECTORIES.get_or_init(Default::default);
    let (id, mut position)=if let Some(cursor)=cursor { let (id, offset)=cursor.rsplit_once(':').ok_or("CURSOR_INVALID")?; (id.to_string(), offset.parse::<usize>().map_err(|_|"CURSOR_INVALID")?) } else {
        let mut entries=Vec::new(); let mut bytes=0;
        for item in fs::read_dir(&target).map_err(|e|format!("DIRECTORY_UNREADABLE: {e}"))? {
            let item=item.map_err(|e|format!("DIRECTORY_INCOMPLETE: {e}"))?;
            let name=item.file_name().to_string_lossy().into_owned();
            if HIDDEN.contains(&name.as_str()) || name.starts_with(".nestcraft-editor-") { continue; }
            let meta=fs::symlink_metadata(item.path()).map_err(|e|format!("DIRECTORY_CHANGED: {e}"))?;
            if reparse(&meta) { continue; }
            let path=item.path().to_string_lossy().into_owned(); bytes+=name.len()+path.len()+128;
            if bytes>SNAPSHOT_BYTES { return Err("DIRECTORY_TOO_LARGE: 目录快照超过32MiB，未截断成成功结果".into()); }
            entries.push(Entry{name,path,is_dir:meta.is_dir(),size:meta.is_file().then_some(meta.len())});
        }
        entries.sort_by_cached_key(|e|(!e.is_dir,e.name.to_lowercase(),e.path.clone()));
        if fingerprint(&fs::metadata(&target).map_err(|e|e.to_string())?)!=revision { return Err("DIRECTORY_CHANGED: 枚举期间目录已改变，请重试".into()); }
        let mut map=cache.lock().map_err(|_|"DIRECTORY_BUSY")?;
        map.retain(|_,d|d.touched.elapsed()<TTL);
        if map.len()>=32 || map.values().map(|d|d.bytes).sum::<usize>()+bytes>64*1024*1024 { return Err("BUSY_RETRY: 目录快照预算已满，请稍后刷新".into()); }
        let id=uuid::Uuid::new_v4().to_string();
        map.insert(id.clone(),Directory{owner:owner.clone(),path:target.clone(),revision:revision.clone(),entries,touched:Instant::now(),bytes});(id,0)
    };
    let mut map=cache.lock().map_err(|_|"DIRECTORY_BUSY")?;
    let d=map.get_mut(&id).ok_or("CURSOR_EXPIRED: 目录游标已过期，请刷新")?;
    if d.owner!=owner || d.path!=target { return Err("CURSOR_SCOPE: 游标不属于当前窗口/目录".into()); }
    if d.touched.elapsed()>=TTL || d.revision!=revision { map.remove(&id);return Err("DIRECTORY_CHANGED: 目录已变更或游标过期，请刷新".into()); }
    let mut items=Vec::new();let mut bytes=256;
    if position>d.entries.len(){return Err("CURSOR_INVALID".into());}
    while position<d.entries.len() && items.len()<limit.clamp(1,200) {
        let item=&d.entries[position];let cost=serde_json::to_vec(item).map_err(|e|e.to_string())?.len();
        if cost+256>PAGE_BYTES { return Err("FIELD_TOO_LARGE: 目录项超出响应预算".into()); }
        if bytes+cost>PAGE_BYTES { break; }
        items.push(item.clone());bytes+=cost;position+=1;
    }
    d.touched=Instant::now();let complete=position==d.entries.len();
    let out=DirectoryPage{items,next_cursor:(!complete).then(||format!("{id}:{position}")),directory_revision:d.revision.clone(),complete};
    if complete { map.remove(&id); }
    Ok(out)
}
#[tauri::command]
pub async fn fs_perf_dir_page(window:WebviewWindow,root_uri:String,rel_path:String,cursor:Option<String>,limit:Option<usize>) -> Result<DirectoryPage,String> {
    let root=fs::canonicalize(&root_uri).map_err(|e|e.to_string())?;let owner=scope(&window,&root);
    let permit=resources::admit(32*1024*1024)?;
    tauri::async_runtime::spawn_blocking(move||{let _permit=permit;directory_page(owner,root_uri,rel_path,cursor,limit.unwrap_or(200))}).await.map_err(|e|e.to_string())?
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all="camelCase")]
pub struct Hit { pub path:String, pub line_no:u64, pub line_text:String }
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Batch { pub seq:u64,pub hits:Vec<Hit> }
struct SearchState { batches:VecDeque<Batch>,next_seq:u64,status:String,error:Option<String>,files:u64,bytes:u64,skipped:u64,limited:bool,touched:Instant }
struct Search { owner:String,cancel:AtomicBool,state:Mutex<SearchState> }
static SEARCHES:OnceLock<Mutex<HashMap<String,Arc<Search>>>>=OnceLock::new();
fn searches()-> &'static Mutex<HashMap<String,Arc<Search>>> { SEARCHES.get_or_init(Default::default) }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct SearchPoll { pub batches:Vec<Batch>,pub status:String,pub error:Option<String>,pub files:u64,pub bytes:u64,pub skipped:u64,pub limited:bool }
fn push(search:&Search,hits:Vec<Hit>)->bool {
    loop {
        if search.cancel.load(Ordering::Relaxed) {return false;}
        let mut s=match search.state.lock(){Ok(s)=>s,Err(_)=>return false};
        if s.touched.elapsed()>Duration::from_secs(5){search.cancel.store(true,Ordering::Relaxed);return false;}
        if s.batches.len()<4 {let seq=s.next_seq;s.next_seq+=1;s.batches.push_back(Batch{seq,hits});return true;}
        drop(s);std::thread::sleep(Duration::from_millis(10));
    }
}
/// Streaming UTF-8 decoder/search: at most 64KiB raw bytes + a query-sized suffix.
fn scan_file(path:&Path,query:&str,search:&Search,found:&mut usize)->Result<(),String> {
    let mut options=fs::OpenOptions::new();options.read(true);
    #[cfg(windows)] {use std::os::windows::fs::OpenOptionsExt;options.share_mode(1);}
    let file=options.open(path).map_err(|e|e.to_string())?;
    let before=fingerprint(&file.metadata().map_err(|e|e.to_string())?);
    let mut reader=BufReader::with_capacity(64*1024,file);
    let mut pending=Vec::<u8>::new(); let mut line=1u64;let mut suffix=String::new();let mut prefix=String::new();let mut line_hit=false;
    let mut batch=Vec::new();let mut batch_bytes=0usize;
    loop {
        if search.cancel.load(Ordering::Relaxed){return Ok(());}
        if search.state.lock().map_err(|_|"SEARCH_LOCK")?.touched.elapsed()>Duration::from_secs(5){search.cancel.store(true,Ordering::Relaxed);return Ok(());}
        let raw=reader.fill_buf().map_err(|e|e.to_string())?;let n=raw.len();
        if n==0{break;}
        pending.extend_from_slice(raw);reader.consume(n);
        {let mut s=search.state.lock().map_err(|_|"SEARCH_LOCK")?;s.bytes+=n as u64;}
        let valid=match std::str::from_utf8(&pending){Ok(_)=>pending.len(),Err(e)=>{if e.error_len().is_some(){return Err("ENCODING_UNSUPPORTED".into());}e.valid_up_to()}};
        let text=std::str::from_utf8(&pending[..valid]).map_err(|e|e.to_string())?;
        if text.contains('\0'){return Err("BINARY_CONTENT".into());}
        for piece in text.split_inclusive('\n') {
            if search.cancel.load(Ordering::Relaxed){return Ok(());}
            let newline=piece.ends_with('\n');let segment=piece.trim_end_matches('\n');
            if prefix.chars().count()<200 {prefix.extend(segment.chars().take(200-prefix.chars().count()));}
            if !line_hit {
                let folded=segment.to_lowercase();let joined=format!("{suffix}{folded}");
                if joined.contains(query){line_hit=true;}
                // Keep complete scalars across block boundaries, enough for a split match.
                let keep=query.len().saturating_sub(1);let mut start=joined.len().saturating_sub(keep);
                while start<joined.len()&&!joined.is_char_boundary(start){start+=1;}
                suffix=joined[start..].to_string();
            }
            if newline {
                if line_hit {let hit=Hit{path:path.to_string_lossy().into_owned(),line_no:line,line_text:prefix.clone()};batch_bytes+=hit.path.len()*6+hit.line_text.len()*6+128;batch.push(hit);*found+=1;}
                line+=1;prefix.clear();suffix.clear();line_hit=false;
                if batch.len()>=20 || batch_bytes>=32000 {if !push(search,std::mem::take(&mut batch)){return Ok(());}batch_bytes=0;}
                if *found>=100 {search.state.lock().map_err(|_|"SEARCH_LOCK")?.limited=true;break;}
            }
        }
        pending.drain(..valid);
        if *found>=100{break;}
    }
    if !pending.is_empty() && *found<100 {return Err("INVALID_UTF8".into());}
    if line_hit && *found<100 {batch.push(Hit{path:path.to_string_lossy().into_owned(),line_no:line,line_text:prefix});*found+=1;}
    if before!=fingerprint(&reader.get_ref().metadata().map_err(|e|e.to_string())?){return Err("SOURCE_CHANGED".into());}
    if !batch.is_empty(){push(search,batch);}
    Ok(())
}
fn run_search(root:PathBuf,query:String,search:Arc<Search>) {
    let root_text=root.to_string_lossy().into_owned();
    let root_pin=match guard::RootedPath::new(&root_text,"",false){Ok(v)=>v,Err(e)=>{if let Ok(mut s)=search.state.lock(){s.status="failed".into();s.error=Some(e);}return;}};
    if root_pin.verify().is_err(){if let Ok(mut s)=search.state.lock(){s.status="failed".into();s.error=Some("ROOT_CHANGED".into());}return;}
    let mut found=0usize;
    for entry in walkdir::WalkDir::new(&root).max_depth(10).follow_links(false).into_iter().filter_entry(|e|!HIDDEN.iter().any(|n|e.file_name().to_string_lossy().eq_ignore_ascii_case(n))) {
        if search.cancel.load(Ordering::Relaxed){break;}
        let entry=match entry{Ok(e)=>e,Err(_)=>{if let Ok(mut s)=search.state.lock(){s.skipped+=1;}continue;}};
        if entry.file_type().is_symlink(){continue;}
        if entry.file_type().is_dir(){if entry.depth()==10 {if let Ok(mut s)=search.state.lock(){s.limited=true;}}continue;}
        if !entry.file_type().is_file(){continue;}
        let ext=entry.path().extension().and_then(|s|s.to_str()).unwrap_or("").to_lowercase();if !TEXT_EXT.contains(&ext.as_str()){continue;}
        let relative=match entry.path().strip_prefix(&root){Ok(v)=>v.to_string_lossy().replace('\\', "/"),Err(_)=>{if let Ok(mut s)=search.state.lock(){s.skipped+=1;}continue;}};
        let file_pin=match guard::RootedPath::new(&root_text,&relative,false){Ok(v)=>v,Err(_)=>{if let Ok(mut s)=search.state.lock(){s.skipped+=1;}continue;}};
        if file_pin.verify().is_err(){if let Ok(mut s)=search.state.lock(){s.skipped+=1;}continue;}
        if scan_file(&file_pin.path,&query,&search,&mut found).is_err(){if let Ok(mut s)=search.state.lock(){s.skipped+=1;}}
        if let Ok(mut s)=search.state.lock(){s.files+=1;}
        if found>=100{if let Ok(mut s)=search.state.lock(){s.limited=true;}break;}
    }
    if let Ok(mut s)=search.state.lock(){s.status=if search.cancel.load(Ordering::Relaxed){"cancelled"}else{"done"}.into();}
}
#[tauri::command]
pub async fn fs_perf_search_start(window:WebviewWindow,root_uri:String,query:String,request_id:String)->Result<(),String>{
    uuid::Uuid::parse_str(&request_id).map_err(|_|"REQUEST_ID_INVALID")?;
    if query.trim().is_empty()||query.chars().count()>128||query.contains(['\r','\n']){return Err("QUERY_INVALID: 输入1～128字符的单行关键词".into());}
    let root=fs::canonicalize(&root_uri).map_err(|e|e.to_string())?;let owner=scope(&window,&root);
    let search=Arc::new(Search{owner:owner.clone(),cancel:AtomicBool::new(false),state:Mutex::new(SearchState{batches:VecDeque::new(),next_seq:0,status:"running".into(),error:None,files:0,bytes:0,skipped:0,limited:false,touched:Instant::now()})});
    {let mut map=searches().lock().map_err(|_|"SEARCH_BUSY")?;
        map.retain(|_,task|task.state.lock().map(|s|s.touched.elapsed()<TTL||s.status=="running").unwrap_or(false));
        if map.contains_key(&request_id){return Err("REQUEST_ID_REUSED".into());}
        for task in map.values().filter(|s|s.owner==owner){task.cancel.store(true,Ordering::Relaxed);}
        if map.len()>=32 || map.values().filter(|s|s.state.lock().map(|v|v.status=="running").unwrap_or(false)).count()>=2{return Err("BUSY_RETRY: 后台搜索槽位已满".into());}
        map.insert(request_id,search.clone());
    }
    let permit=resources::admit(64*1024)?;let slot=resources::search_slot()?;
    tauri::async_runtime::spawn_blocking(move||{let _permit=permit;let _slot=slot;run_search(root,query.to_lowercase(),search)});Ok(())
}
#[tauri::command]
pub fn fs_perf_search_poll(window:WebviewWindow,root_uri:String,request_id:String,ack_seq:Option<u64>)->Result<SearchPoll,String>{
    let root=fs::canonicalize(root_uri).map_err(|e|e.to_string())?;let owner=scope(&window,&root);
    let task=searches().lock().map_err(|_|"SEARCH_BUSY")?.get(&request_id).cloned().ok_or("REQUEST_EXPIRED")?;
    if task.owner!=owner{return Err("REQUEST_SCOPE".into());}
    let mut s=task.state.lock().map_err(|_|"SEARCH_BUSY")?;
    if let Some(ack)=ack_seq{if ack>=s.next_seq{return Err("ACK_INVALID".into());}while s.batches.front().map(|b|b.seq<=ack).unwrap_or(false){s.batches.pop_front();}}
    s.touched=Instant::now();Ok(SearchPoll{batches:s.batches.iter().cloned().collect(),status:s.status.clone(),error:s.error.clone(),files:s.files,bytes:s.bytes,skipped:s.skipped,limited:s.limited})
}
#[tauri::command]
pub fn fs_perf_cancel(window:WebviewWindow,root_uri:String,request_id:String)->Result<bool,String>{
    let root=fs::canonicalize(root_uri).map_err(|e|e.to_string())?;let owner=scope(&window,&root);
    let task=searches().lock().map_err(|_|"SEARCH_BUSY")?.get(&request_id).cloned();
    if let Some(task)=task{if task.owner!=owner{return Err("REQUEST_SCOPE".into());}task.cancel.store(true,Ordering::Relaxed);Ok(true)}else{Ok(false)}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn directory_pages_are_bounded_and_scoped(){
        let root=std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());fs::create_dir(&root).unwrap();
        for i in 0..405{fs::write(root.join(format!("item-{i:04}.ts")),"x").unwrap();}
        let r=root.to_string_lossy().into_owned();let first=directory_page("one".into(),r.clone(),"".into(),None,200).unwrap();assert_eq!(first.items.len(),200);
        assert!(directory_page("two".into(),r.clone(),"".into(),first.next_cursor.clone(),200).is_err());
        let second=directory_page("one".into(),r.clone(),"".into(),first.next_cursor,200).unwrap();let last=directory_page("one".into(),r,"".into(),second.next_cursor,200).unwrap();assert_eq!(last.items.len(),5);assert!(last.complete);fs::remove_dir_all(&root).unwrap();
    }
    #[test] fn streamed_search_matches_across_buffer_and_long_lines(){
        let root=std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());fs::create_dir(&root).unwrap();let path=root.join("long.ts");
        fs::write(&path,format!("{}跨块命中\nnext\n", "a".repeat(65534))).unwrap();
        let search=Search{owner:"test".into(),cancel:AtomicBool::new(false),state:Mutex::new(SearchState{batches:VecDeque::new(),next_seq:0,status:"running".into(),error:None,files:0,bytes:0,skipped:0,limited:false,touched:Instant::now()})};
        let mut count=0;scan_file(&path,"跨块命中",&search,&mut count).unwrap();assert_eq!(count,1);assert_eq!(search.state.lock().unwrap().batches[0].hits[0].line_no,1);fs::remove_dir_all(root).unwrap();
    }
}
