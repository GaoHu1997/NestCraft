//! Additional owner-only source-byte windows. Not a canonical/line editor or AI reader.
use super::{blocking, source_ref};
use super::super::files;
use crate::models::new_id;
use rusqlite::Connection;
use serde::Serialize;
use std::{collections::HashMap, fs::File, io::{Read,Seek,SeekFrom}, path::Path, sync::{Arc,Mutex,Once,OnceLock,atomic::{AtomicBool,Ordering}}, time::{Duration,Instant}};

const TTL:Duration=Duration::from_secs(60);
const MAX_SOURCE_BYTES:usize=64*1024;
const MAX_JSON_BYTES:usize=256*1024;
#[derive(Clone,Copy,Debug)]
enum Encoding { Utf8, Utf16Le, Utf16Be }
impl Encoding { fn name(self)->&'static str {match self{Self::Utf8=>"utf-8",Self::Utf16Le=>"utf-16le",Self::Utf16Be=>"utf-16be"}} }
struct Document {
    owner:String, library:String, source:String, root:files::SafeRoot, file:File,
    relative_uri:String, revision:String, size:u64, encoding:Encoding, bom:usize, touched:Instant,
}
struct Slot { owner:String, library:String, document:Arc<Mutex<Document>> }
static DOCUMENTS:OnceLock<Mutex<HashMap<String,Slot>>>=OnceLock::new();
fn documents()->&'static Mutex<HashMap<String,Slot>> {DOCUMENTS.get_or_init(||Mutex::new(HashMap::new()))}
fn expire(){
    if let Ok(mut all)=documents().lock(){
        all.retain(|_,slot|match slot.document.try_lock(){Ok(doc)=>doc.touched.elapsed()<TTL,Err(_)=>true});
    }
}
fn start_expiry(){static START:Once=Once::new();START.call_once(||{let _=std::thread::Builder::new().name("kb-lease-expiry".into()).spawn(||loop{std::thread::sleep(Duration::from_secs(5));expire();});});}
pub(super) fn close_window(owner:&str){
    if let Ok(mut all)=documents().lock(){all.retain(|_,slot|slot.owner!=owner);}
    if let Ok(state)=search_cancels().lock(){for (key,entry) in state.iter(){if key.starts_with(&format!("{owner}\0")){entry.token.store(true,Ordering::Release);}}}
}
#[derive(Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct Window {
    doc_id:String,revision:String,text:String,source_start_byte:String,source_end_byte:String,
    next_offset:Option<String>,eof:bool,offset_space:&'static str,
}
#[derive(Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct OpenDocument {
    doc_id:String,file_id:String,revision:String,size_bytes:String,encoding:&'static str,
    mode:&'static str,offset_space:&'static str,initial_window:Window,
}
fn decode(bytes:&[u8],encoding:Encoding,at_end:bool,offset:u64,bom:usize)->Result<(String,usize),String>{
    if offset!=0 && offset<(bom as u64){return Err("INVALID_BOUNDARY: 偏移在BOM内".into());}
    let skip=if offset==0{bom}else{0};
    if bytes.len()<skip{return Err("ENCODING_REQUIRED: BOM不完整".into());}
    let raw=&bytes[skip..];
    let (text,used)=match encoding {
        Encoding::Utf8=>{
            if offset>0 && raw.first().map(|v|v&0xc0==0x80).unwrap_or(false){return Err("INVALID_BOUNDARY: 偏移在UTF-8字符内".into());}
            match std::str::from_utf8(raw){
                Ok(s)=>(s.to_string(),raw.len()),
                Err(error) if error.error_len().is_none() && !at_end=>{
                    let valid=error.valid_up_to();
                    (std::str::from_utf8(&raw[..valid]).map_err(|_|"ENCODING_REQUIRED")?.to_string(),valid)
                },
                Err(_)=>return Err("ENCODING_REQUIRED: 无效UTF-8，未替换坏字节".into()),
            }
        },
        Encoding::Utf16Le|Encoding::Utf16Be=>{
            if offset%2!=0{return Err("INVALID_BOUNDARY: UTF-16偏移必须位于码元边界".into());}
            if at_end && raw.len()%2!=0{return Err("ENCODING_REQUIRED: UTF-16末尾半个码元".into());}
            let unit=|i:usize|if matches!(encoding,Encoding::Utf16Le){u16::from_le_bytes([raw[i],raw[i+1]])}else{u16::from_be_bytes([raw[i],raw[i+1]])};
            let mut text=String::new();let mut used=0;
            while used+1<raw.len(){
                let first=unit(used);
                if (0xdc00..=0xdfff).contains(&first){return Err(if used==0&&offset>0{"INVALID_BOUNDARY: 偏移在代理对内"}else{"ENCODING_REQUIRED: 未配对低代理"}.into());}
                if (0xd800..=0xdbff).contains(&first){
                    if used+3>=raw.len(){if at_end{return Err("ENCODING_REQUIRED: 未配对高代理".into());}break;}
                    let second=unit(used+2);
                    if !(0xdc00..=0xdfff).contains(&second){return Err("ENCODING_REQUIRED: 无效代理对".into());}
                    let scalar=0x10000+(((first as u32)-0xd800)<<10)+(second as u32-0xdc00);
                    text.push(char::from_u32(scalar).ok_or("ENCODING_REQUIRED")?);used+=4;
                }else{text.push(char::from_u32(first as u32).ok_or("ENCODING_REQUIRED")?);used+=2;}
            }
            (text,used)
        }
    };
    if text.contains('\0'){return Err("ENCODING_REQUIRED: 不把NUL二进制作为文本".into());}
    Ok((text,skip+used))
}
fn window_from_file(doc:&mut Document,id:&str,offset:u64,max_bytes:usize)->Result<Window,String>{
    if offset>doc.size{return Err("INVALID_OFFSET: 超出原件末尾".into());}
    if max_bytes<4||max_bytes>MAX_SOURCE_BYTES{return Err("INVALID_BUDGET: 读取量必须在4～65536字节之间".into());}
    doc.root.verify()?;
    doc.file.seek(SeekFrom::Start(offset)).map_err(|_|"READ_FAILED")?;
    let len=((doc.size-offset).min(max_bytes as u64))as usize;
    let mut bytes=vec![0;len];doc.file.read_exact(&mut bytes).map_err(|_|"SOURCE_CHANGED: 文件不能完整读取")?;
    let mut end=len;
    loop{
        let (text,used)=decode(&bytes[..end],doc.encoding,offset+end as u64==doc.size,offset,doc.bom)?;
        let stop=offset+used as u64;
        if stop==offset && offset<doc.size{return Err("INVALID_BUDGET: 无法容纳完整字符".into());}
        let out=Window{doc_id:id.into(),revision:doc.revision.clone(),text,source_start_byte:offset.to_string(),source_end_byte:stop.to_string(),next_offset:if stop<doc.size{Some(stop.to_string())}else{None},eof:stop==doc.size,offset_space:"source-byte"};
        if serde_json::to_vec(&out).map_err(|e|e.to_string())?.len()<=MAX_JSON_BYTES{
            doc.root.verify()?;doc.touched=Instant::now();return Ok(out);
        }
        end/=2;
        if end<4{return Err("RESPONSE_TOO_LARGE".into());}
    }
}
fn open(conn:&Connection,owner:&str,library:&str,file_id:&str)->Result<OpenDocument,String>{
    #[cfg(not(windows))]
    {let _=(conn,owner,library,file_id);return Err("SNAPSHOT_UNAVAILABLE: 本平台尚未验证受保护原件句柄".into());}
    #[cfg(windows)]
    {
        expire();
        {let all=documents().lock().map_err(|_|"文档锁不可用")?;
            if all.len()>=64 || all.values().filter(|slot|slot.owner==owner).count()>=32{return Err("DOCUMENT_LIMIT".into());}}
        let source=source_ref(conn,library)?;
        let mut root=files::SafeRoot::new(Path::new(&source))?;
        let (rel,_)=super::super::resolve(conn,&mut root,library,file_id)?;
        if !files::markdown(Path::new(&rel))&&!files::indexable_text(Path::new(&rel)){return Err("FORMAT_UNSUPPORTED: 此接口仅安全文本，不执行附件".into());}
        let mut file=files::open_snapshot(&mut root,&rel)?;
        let size=file.metadata().map_err(|_|"READ_FAILED")?.len();
        let mut prefix=[0u8;3];let n=file.read(&mut prefix).map_err(|_|"READ_FAILED")?;
        let (encoding,bom)=if n>=3&&prefix==[0xef,0xbb,0xbf]{(Encoding::Utf8,3)}else if n>=2&&prefix[..2]==[0xff,0xfe]{(Encoding::Utf16Le,2)}else if n>=2&&prefix[..2]==[0xfe,0xff]{(Encoding::Utf16Be,2)}else{(Encoding::Utf8,0)};
        let id=new_id("kbdoc");let revision=new_id("protected-source");
        let mut doc=Document{owner:owner.into(),library:library.into(),source:source.clone(),root,file,relative_uri:rel,revision:revision.clone(),size,encoding,bom,touched:Instant::now()};
        let initial_window=window_from_file(&mut doc,&id,0,MAX_SOURCE_BYTES)?;
        if source_ref(conn,library)?!=source{return Err("SOURCE_CHANGED".into());}
        {
            let mut all=documents().lock().map_err(|_|"文档锁不可用")?;
            if all.len()>=64||all.values().filter(|slot|slot.owner==owner).count()>=32{return Err("DOCUMENT_LIMIT".into());}
            all.insert(id.clone(),Slot{owner:owner.into(),library:library.into(),document:Arc::new(Mutex::new(doc))});
        }
        start_expiry();
        Ok(OpenDocument{doc_id:id,file_id:file_id.into(),revision,size_bytes:size.to_string(),encoding:encoding.name(),mode:"window-readonly",offset_space:"source-byte",initial_window})
    }
}
#[tauri::command]
pub async fn kb_open_document(window:tauri::WebviewWindow,library_id:String,file_id:String)->Result<OpenDocument,String>{
    let owner=window.label().to_string();blocking(move|conn|open(&conn,&owner,&library_id,&file_id)).await
}
#[tauri::command]
pub async fn kb_read_window(window:tauri::WebviewWindow,library_id:String,doc_id:String,revision:String,offset:String,max_bytes:Option<usize>)->Result<Window,String>{
    let owner=window.label().to_string();
    blocking(move|conn|{
        expire();let current_source=source_ref(&conn,&library_id)?;
        let held=documents().lock().map_err(|_|"文档锁不可用")?.get(&doc_id).map(|slot|slot.document.clone()).ok_or("DOC_EXPIRED")?;
        let mut doc=held.lock().map_err(|_|"文档锁不可用")?;
        if doc.owner!=owner||doc.library!=library_id{return Err("DOCUMENT_SCOPE_MISMATCH".into());}
        if doc.touched.elapsed()>=TTL{return Err("DOC_EXPIRED".into());}
        if doc.revision!=revision||doc.source!=current_source{return Err("SOURCE_CHANGED".into());}
        // A pinned root and source handle prevent Windows rename/reparse/write races.
        let rel=doc.relative_uri.clone();doc.root.file(&rel)?;
        if offset.is_empty()||offset.len()>20||!offset.bytes().all(|c|c.is_ascii_digit()){return Err("INVALID_OFFSET".into());}
        let offset=offset.parse::<u64>().map_err(|_|"INVALID_OFFSET")?;
        if offset>i64::MAX as u64{return Err("INVALID_OFFSET".into());}
        let out=window_from_file(&mut doc,&doc_id,offset,max_bytes.unwrap_or(MAX_SOURCE_BYTES))?;
        if source_ref(&conn,&library_id)?!=current_source{return Err("SOURCE_CHANGED".into());}
        Ok(out)
    }).await
}
#[tauri::command]
pub fn kb_close_document(window:tauri::WebviewWindow,library_id:String,doc_id:String)->Result<(),String>{
    let mut all=documents().lock().map_err(|_|"文档锁不可用")?;
    if let Some(slot)=all.get(&doc_id){if slot.owner!=window.label()||slot.library!=library_id{return Err("DOCUMENT_SCOPE_MISMATCH".into());}}
    all.remove(&doc_id);drop(all);
    if let Ok(state)=search_cancels().lock(){let prefix=format!("{}\0{library_id}\0{doc_id}\0",window.label());for (key,entry)in state.iter(){if key.starts_with(&prefix){entry.token.store(true,Ordering::Release);}}}
    Ok(())
}

#[derive(Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct SearchHit {source_start_byte:String,source_end_byte:String,excerpt:String}
#[derive(Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct SearchPage {doc_id:String,revision:String,hits:Vec<SearchHit>,next_offset:Option<String>,incomplete:bool,eof:bool,scanned_bytes:String,offset_space:&'static str}
struct SearchCancel {token:Arc<AtomicBool>,active:bool,touched:Instant}
static SEARCH_CANCELS:OnceLock<Mutex<HashMap<String,SearchCancel>>>=OnceLock::new();
fn search_cancels()->&'static Mutex<HashMap<String,SearchCancel>> {SEARCH_CANCELS.get_or_init(||Mutex::new(HashMap::new()))}
fn purge_search_tombstones(state:&mut HashMap<String,SearchCancel>){state.retain(|_,entry|entry.active||entry.touched.elapsed()<TTL);}
struct SearchRequestGuard { key:String, token:Arc<AtomicBool> }
impl Drop for SearchRequestGuard { fn drop(&mut self) { if let Ok(mut state)=search_cancels().lock(){if state.get(&self.key).map(|entry|Arc::ptr_eq(&entry.token,&self.token)).unwrap_or(false){state.remove(&self.key);}} } }
fn source_len(text:&str,encoding:Encoding)->u64 {if matches!(encoding,Encoding::Utf8){text.len()as u64}else{(text.encode_utf16().count()*2)as u64}}
fn suffix(text:&str,keep:usize)->&str {if keep==0{return "";} let start=text.char_indices().rev().nth(keep-1).map(|(i,_)|i).unwrap_or(0);&text[start..]}
fn search_file(doc:&mut Document,id:&str,query:&str,start:u64,max_hits:usize,token:&AtomicBool)->Result<SearchPage,String>{
    let mut offset=start;let mut remaining=4*1024*1024usize;let mut hits=Vec::new();let mut tail=String::new();let mut accepted_until=start;
    while offset<doc.size&&remaining>=4 {
        if token.load(Ordering::Acquire){return Err("CANCELLED".into());}
        let request=remaining.min(MAX_SOURCE_BYTES);let requested=(doc.size-offset).min(request as u64)as usize;
        let page=window_from_file(doc,id,offset,request)?;
        remaining=remaining.saturating_sub(requested);
        let text_start=offset+if offset==0{doc.bom as u64}else{0};
        let base=text_start.saturating_sub(source_len(&tail,doc.encoding));
        let combined=format!("{tail}{}",page.text);
        let search_start=if accepted_until<=base{0}else if matches!(doc.encoding,Encoding::Utf8){((accepted_until-base)as usize).min(combined.len())}else{
            let mut consumed=0u64;let mut index=combined.len();
            for (at,ch) in combined.char_indices(){if consumed>=accepted_until-base{index=at;break;}consumed+=(ch.len_utf16()*2)as u64;}
            index
        };
        for (relative_at,_) in combined[search_start..].match_indices(query){
            let at=search_start+relative_at;
            let from=base+source_len(&combined[..at],doc.encoding);
            let to=from+source_len(query,doc.encoding);
            if from<accepted_until{continue;}
            hits.push(SearchHit{source_start_byte:from.to_string(),source_end_byte:to.to_string(),excerpt:combined[at..].chars().take(160).collect()});
            accepted_until=to;
            if hits.len()>=max_hits {
                return Ok(SearchPage{doc_id:id.into(),revision:doc.revision.clone(),hits,next_offset:if to<doc.size{Some(to.to_string())}else{None},incomplete:to<doc.size,eof:to==doc.size,scanned_bytes:to.saturating_sub(start).to_string(),offset_space:"source-byte"});
            }
        }
        offset=page.source_end_byte.parse().map_err(|_|"INVALID_OFFSET")?;
        tail=suffix(&combined,query.chars().count().saturating_sub(1)).to_string();
        if page.eof{break;}
    }
    if token.load(Ordering::Acquire){return Err("CANCELLED".into());}
    let next=if offset<doc.size {
        // Re-scan the tiny query tail on the next bounded call. Hits in that tail
        // are withheld now, so boundary matches are neither lost nor duplicated.
        let tail_start=offset.saturating_sub(source_len(&tail,doc.encoding)).max(start);
        hits.retain(|hit|hit.source_start_byte.parse::<u64>().map(|p|p<tail_start).unwrap_or(false));
        let next=hits.last().and_then(|hit|hit.source_end_byte.parse::<u64>().ok()).unwrap_or(tail_start).max(tail_start);
        Some(next.to_string())
    }else{None};
    Ok(SearchPage{doc_id:id.into(),revision:doc.revision.clone(),hits,incomplete:next.is_some(),eof:next.is_none(),next_offset:next,scanned_bytes:offset.saturating_sub(start).to_string(),offset_space:"source-byte"})
}
#[tauri::command]
pub async fn kb_search_document(window:tauri::WebviewWindow,library_id:String,doc_id:String,revision:String,query:String,offset:String,max_hits:Option<usize>,request_id:String)->Result<SearchPage,String>{
    let owner=window.label().to_string();
    if query.is_empty()||query.chars().count()>128||request_id.is_empty()||request_id.len()>128{return Err("INVALID_QUERY".into());}
    let key=format!("{owner}\0{library_id}\0{doc_id}\0{request_id}");
    let token={let mut state=search_cancels().lock().map_err(|_|"查询锁不可用")?;purge_search_tombstones(&mut state);
        if let Some(entry)=state.get(&key){return Err(if entry.token.load(Ordering::Acquire){"CANCELLED"}else{"REQUEST_ID_REUSED"}.into());}
        if state.len()>=256 {
            if let Some(old)=state.iter().filter(|(_,entry)|!entry.active).min_by_key(|(_,entry)|entry.touched).map(|(key,_)|key.clone()){state.remove(&old);}else{return Err("BUSY_RETRY".into());}
        }
        let token=Arc::new(AtomicBool::new(false));state.insert(key.clone(),SearchCancel{token:token.clone(),active:true,touched:Instant::now()});token};
    let _request=SearchRequestGuard{key,token:token.clone()};
    blocking(move|conn|{
        expire();let current_source=source_ref(&conn,&library_id)?;
        let held=documents().lock().map_err(|_|"文档锁不可用")?.get(&doc_id).map(|slot|slot.document.clone()).ok_or("DOC_EXPIRED")?;
        let mut doc=held.lock().map_err(|_|"文档锁不可用")?;
        if doc.owner!=owner||doc.library!=library_id{return Err("DOCUMENT_SCOPE_MISMATCH".into());}
        if doc.touched.elapsed()>=TTL{return Err("DOC_EXPIRED".into());}
        if doc.revision!=revision||doc.source!=current_source{return Err("SOURCE_CHANGED".into());}
        if offset.is_empty()||offset.len()>20||!offset.bytes().all(|c|c.is_ascii_digit()){return Err("INVALID_OFFSET".into());}
        let start=offset.parse::<u64>().map_err(|_|"INVALID_OFFSET")?;
        if start>doc.size||start>i64::MAX as u64{return Err("INVALID_OFFSET".into());}
        let result=search_file(&mut doc,&doc_id,&query,start,max_hits.unwrap_or(50).clamp(1,50),&token)?;
        if source_ref(&conn,&library_id)?!=current_source{return Err("SOURCE_CHANGED".into());}
        if token.load(Ordering::Acquire){return Err("CANCELLED".into());}
        Ok(result)
    }).await
}
#[tauri::command]
pub fn kb_search_document_cancel(window:tauri::WebviewWindow,library_id:String,doc_id:String,request_id:String)->Result<(),String>{
    if request_id.is_empty()||request_id.len()>128{return Err("REQUEST_ID_INVALID".into());}
    let key=format!("{}\0{library_id}\0{doc_id}\0{request_id}",window.label());
    let mut state=search_cancels().lock().map_err(|_|"查询锁不可用")?;purge_search_tombstones(&mut state);
    if let Some(entry)=state.get_mut(&key){entry.token.store(true,Ordering::Release);entry.touched=Instant::now();}else if state.len()<256{state.insert(key,SearchCancel{token:Arc::new(AtomicBool::new(true)),active:false,touched:Instant::now()});}
    Ok(())
}

#[cfg(test)]
mod tests{
    use super::*;
    fn temporary_document(bytes:&[u8])->(Document,std::path::PathBuf){
        let base=std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let path=base.join(new_id("kb-window-test"));std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("data.txt"),bytes).unwrap();
        let mut root=files::SafeRoot::new(&path).unwrap();let file=files::open_snapshot(&mut root,"data.txt").unwrap();
        (Document{owner:"test-window".into(),library:"lib".into(),source:path.to_string_lossy().into_owned(),root,file,relative_uri:"data.txt".into(),revision:"r1".into(),size:bytes.len()as u64,encoding:Encoding::Utf8,bom:0,touched:Instant::now()},path)
    }
    #[test]
    fn large_line_windows_bound_json_and_preserve_offsets(){
        let bytes=vec![1u8;200_000];let(mut doc,path)=temporary_document(&bytes);
        let first=window_from_file(&mut doc,"doc",0,MAX_SOURCE_BYTES).unwrap();
        assert!(serde_json::to_vec(&first).unwrap().len()<=MAX_JSON_BYTES);
        let next=first.next_offset.unwrap().parse::<u64>().unwrap();assert!(next>0&&next<=65536);
        assert_eq!(first.text.as_bytes(),&bytes[..next as usize]);
        let second=window_from_file(&mut doc,"doc",next,MAX_SOURCE_BYTES).unwrap();assert_eq!(second.source_start_byte,next.to_string());
        assert!(window_from_file(&mut doc,"doc",200001,65536).is_err());
        let end=window_from_file(&mut doc,"doc",200000,65536).unwrap();assert!(end.eof&&end.next_offset.is_none()&&end.text.is_empty());
        #[cfg(windows)] assert!(std::fs::write(path.join("data.txt"),"external").is_err());
        drop(doc);std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn search_matches_across_read_and_request_boundaries(){
        let mut bytes=vec![b'x';4*1024*1024-2];bytes[65534..65540].copy_from_slice(b"NEEDLE");bytes.extend_from_slice(b"NEEDLEend");
        let(mut doc,path)=temporary_document(&bytes);let token=AtomicBool::new(false);
        let first=search_file(&mut doc,"doc","NEEDLE",0,50,&token).unwrap();assert!(first.incomplete);assert_eq!(first.hits.len(),1);assert_eq!(first.hits[0].source_start_byte,"65534");
        let second=search_file(&mut doc,"doc","NEEDLE",first.next_offset.unwrap().parse().unwrap(),50,&token).unwrap();assert!(second.eof);assert_eq!(second.hits.len(),1);assert_eq!(second.hits[0].source_start_byte,(4*1024*1024-2).to_string());
        token.store(true,Ordering::Release);assert!(search_file(&mut doc,"doc","x",0,50,&token).unwrap_err().contains("CANCELLED"));
        drop(doc);std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn capped_search_continues_without_duplicates(){
        let(mut doc,path)=temporary_document(b"aa aa aa aa");let token=AtomicBool::new(false);
        let a=search_file(&mut doc,"doc","aa",0,2,&token).unwrap();assert_eq!(a.hits.len(),2);assert_eq!(a.next_offset.as_deref(),Some("5"));
        let b=search_file(&mut doc,"doc","aa",5,2,&token).unwrap();assert_eq!(b.hits[0].source_start_byte,"6");assert_eq!(b.hits[1].source_start_byte,"9");assert!(b.eof);
        drop(doc);std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn document_search_terminal_slots_do_not_accumulate_after_256_pages(){
        let prefix=crate::models::new_id("search-slot-test");
        for page in 0..600 {
            let key=format!("{prefix}:{page}");let token=Arc::new(AtomicBool::new(false));
            search_cancels().lock().unwrap().insert(key.clone(),SearchCancel{token:token.clone(),active:true,touched:Instant::now()});
            let guard=SearchRequestGuard{key:key.clone(),token:token.clone()};
            if page%2==0{token.store(true,Ordering::Release);}
            drop(guard);assert!(!search_cancels().lock().unwrap().contains_key(&key));
        }
        let key=format!("{prefix}:reuse");let old=Arc::new(AtomicBool::new(true));let newer=Arc::new(AtomicBool::new(false));
        let guard=SearchRequestGuard{key:key.clone(),token:old};
        search_cancels().lock().unwrap().insert(key.clone(),SearchCancel{token:newer.clone(),active:true,touched:Instant::now()});
        drop(guard);assert!(Arc::ptr_eq(&search_cancels().lock().unwrap().get(&key).unwrap().token,&newer));search_cancels().lock().unwrap().remove(&key);
        let mut states=HashMap::new();let old=Instant::now()-Duration::from_secs(120);
        states.insert("active".into(),SearchCancel{token:Arc::new(AtomicBool::new(true)),active:true,touched:old});
        states.insert("tombstone".into(),SearchCancel{token:Arc::new(AtomicBool::new(true)),active:false,touched:old});
        purge_search_tombstones(&mut states);assert!(states.contains_key("active"));assert!(!states.contains_key("tombstone"));
    }
    #[test]
    fn source_byte_utf8_boundaries_bom_and_crlf(){
        let raw="\u{feff}A😀\r\n中".as_bytes();
        let(text,used)=decode(&raw[..7],Encoding::Utf8,false,0,3).unwrap();assert_eq!(text,"A");assert_eq!(used,4);
        assert!(decode(&raw[5..],Encoding::Utf8,true,5,3).unwrap_err().contains("INVALID_BOUNDARY"));
        let(text,used)=decode(&raw[4..],Encoding::Utf8,true,4,3).unwrap();assert_eq!(text,"😀\r\n中");assert_eq!(used,raw.len()-4);
        assert!(decode(&[0xff],Encoding::Utf8,true,0,0).is_err());
        assert!(decode(&raw[1..],Encoding::Utf8,true,1,3).unwrap_err().contains("BOM"));
    }
    #[test]
    fn utf16_endianness_surrogates_and_source_offsets(){
        let units=[0xfeffu16,65,0xd83d,0xde00,13,10];
        for encoding in [Encoding::Utf16Le,Encoding::Utf16Be]{
            let bytes:Vec<u8>=units.iter().flat_map(|v|if matches!(encoding,Encoding::Utf16Le){v.to_le_bytes()}else{v.to_be_bytes()}).collect();
            let(text,used)=decode(&bytes[..6],encoding,false,0,2).unwrap();assert_eq!(text,"A");assert_eq!(used,4);
            assert!(decode(&bytes[6..],encoding,true,6,2).unwrap_err().contains("INVALID_BOUNDARY"));
            assert!(decode(&bytes[3..],encoding,true,3,2).is_err());
            let(text,used)=decode(&bytes,encoding,true,0,2).unwrap();assert_eq!(text,"A😀\r\n");assert_eq!(used,bytes.len());
            assert!(decode(&bytes[..6],encoding,true,0,2).is_err());
        }
    }
    #[test]
    fn chunk_decoder_never_replaces_bad_sequences(){
        assert!(decode(&[b'a',0xe4,0xb8],Encoding::Utf8,true,0,0).is_err());
        assert_eq!(decode(&[b'a',0xe4,0xb8],Encoding::Utf8,false,0,0).unwrap(),("a".into(),1));
        assert!(decode(&[0x00,0xd8,0x41,0x00],Encoding::Utf16Le,true,2,2).is_err());
        assert!(decode(&[0],Encoding::Utf8,true,0,0).is_err());
    }
}
