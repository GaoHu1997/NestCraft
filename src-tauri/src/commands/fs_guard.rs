//! Windows handle-pinned filesystem scopes and window instance ownership.
use std::{collections::{HashMap,HashSet}, fs::{self,File,OpenOptions}, path::{Path,PathBuf}, sync::{Arc,Mutex,OnceLock,atomic::{AtomicBool,Ordering}}};
#[derive(Debug)] pub struct Instance { pub label:String, pub nonce:String, pub alive:AtomicBool }
static WINDOWS:OnceLock<Mutex<HashMap<String,Arc<Instance>>>>=OnceLock::new();
pub fn instance(label:&str)->Result<Arc<Instance>,String>{
 let mut map=WINDOWS.get_or_init(Default::default).lock().map_err(|_|"WINDOW_BUSY")?;
 Ok(map.entry(label.into()).or_insert_with(||Arc::new(Instance{label:label.into(),nonce:uuid::Uuid::new_v4().to_string(),alive:AtomicBool::new(true)})).clone())
}
pub fn destroy(label:&str)->Option<Arc<Instance>>{let old=WINDOWS.get_or_init(Default::default).lock().ok()?.remove(label);if let Some(v)=&old{v.alive.store(false,Ordering::Release);}old}
pub fn live(instance:&Instance)->Result<(),String>{if instance.alive.load(Ordering::Acquire){Ok(())}else{Err("WINDOW_CLOSED".into())}}
pub fn reparse(meta:&fs::Metadata)->bool{
 #[cfg(windows)]{use std::os::windows::fs::MetadataExt;meta.file_attributes()&0x400!=0}
 #[cfg(not(windows))]{meta.file_type().is_symlink()}
}
pub fn identity(file:&File)->Result<String,String>{
 #[cfg(windows)]{
  use std::{os::windows::io::AsRawHandle,ffi::c_void};
  #[repr(C)]struct Info{attributes:u32,created:[u32;2],accessed:[u32;2],written:[u32;2],volume:u32,size_hi:u32,size_lo:u32,links:u32,index_hi:u32,index_lo:u32}
  #[link(name="kernel32")]extern "system"{fn GetFileInformationByHandle(file:*mut c_void,info:*mut Info)->i32;}
  let mut info=Info{attributes:0,created:[0;2],accessed:[0;2],written:[0;2],volume:0,size_hi:0,size_lo:0,links:0,index_hi:0,index_lo:0};
  if unsafe{GetFileInformationByHandle(file.as_raw_handle(),&mut info)}==0{return Err("IDENTITY_UNAVAILABLE".into());}
  Ok(format!("{}:{}:{}",info.volume,info.index_hi,info.index_lo))
 }
 #[cfg(unix)]{use std::os::unix::fs::MetadataExt;let m=file.metadata().map_err(|e|e.to_string())?;Ok(format!("{}:{}",m.dev(),m.ino()))}
 #[cfg(not(any(windows,unix)))]{let _=file;Err("IDENTITY_UNAVAILABLE".into())}
}
fn directory(path:&Path)->Result<File,String>{
 #[cfg(windows)]{
  use std::os::windows::fs::OpenOptionsExt;
  let f=OpenOptions::new().read(true).share_mode(3).custom_flags(0x02000000|0x00200000).open(path).map_err(|e|format!("PARENT_GUARD_UNAVAILABLE: {e}"))?;
  let m=f.metadata().map_err(|e|e.to_string())?;if reparse(&m)||!m.is_dir(){return Err("PATH_LINK".into());}Ok(f)
 }
 #[cfg(not(windows))]{let _=path;Err("SAFE_PLATFORM_UNAVAILABLE".into())}
}
pub struct Pin{path:PathBuf,id:String,_handle:File}
pub struct RootedPath{pub root:PathBuf,pub path:PathBuf,pub root_id:String,pub parent_id:String,pins:Vec<Pin>}
impl RootedPath{
 pub fn new(root_arg:&str,target:&str,missing:bool)->Result<Self,String>{
  if root_arg.len()>32768||target.len()>32768||!Path::new(root_arg).is_absolute(){return Err("ROOT_INVALID".into());}
  if Path::new(target).components().any(|p|matches!(p,std::path::Component::ParentDir)){return Err("PATH_ESCAPE".into());}
  let root_meta=fs::symlink_metadata(root_arg).map_err(|e|format!("ROOT_UNAVAILABLE: {e}"))?;
   if reparse(&root_meta)||!root_meta.is_dir(){return Err("ROOT_LINK_OR_NOT_DIRECTORY".into());}
   let root=fs::canonicalize(root_arg).map_err(|e|format!("ROOT_UNAVAILABLE: {e}"))?;
  let requested=if target.is_empty(){root.clone()}else if Path::new(target).is_absolute(){PathBuf::from(target)}else{root.join(target)};
  // Resolve only after rejecting links along the requested path, then pin ancestors
  // in parent-first order and repeat resolution while all handles are retained.
  for p in requested.ancestors(){if let Ok(meta)=fs::symlink_metadata(p){if reparse(&meta){return Err("PATH_LINK".into());}}}
  let path=match fs::canonicalize(&requested){Ok(p)=>p,Err(e) if missing&&e.kind()==std::io::ErrorKind::NotFound=>{
   fs::canonicalize(requested.parent().ok_or("PATH_INVALID")?).map_err(|e|e.to_string())?.join(requested.file_name().ok_or("PATH_INVALID")?)
  },Err(e)=>return Err(format!("SOURCE_UNAVAILABLE: {e}"))};
  if !path.starts_with(&root){return Err("PATH_ESCAPE".into());}
  let parent=if fs::symlink_metadata(&path).map(|m|m.is_dir()).unwrap_or(false){path.clone()}else{path.parent().ok_or("PATH_INVALID")?.to_path_buf()};
  let mut ancestors=parent.ancestors().map(Path::to_path_buf).collect::<Vec<_>>();ancestors.reverse();
  let mut pins=Vec::new();for p in ancestors{let f=directory(&p)?;let id=identity(&f)?;pins.push(Pin{path:p,id,_handle:f});}
  let root_id=pins.iter().find(|p|p.path==root).ok_or("ROOT_UNPINNED")?.id.clone();
  let parent_id=pins.last().ok_or("PARENT_UNPINNED")?.id.clone();
  let result=Self{root,path,root_id,parent_id,pins};result.verify()?;
  if fs::canonicalize(root_arg).map_err(|_|"ROOT_CHANGED")?!=result.root{return Err("ROOT_CHANGED".into());}
  if let Ok(now)=fs::canonicalize(&requested){if now!=result.path{return Err("SOURCE_CHANGED".into());}}
  Ok(result)
 }
 pub fn verify(&self)->Result<(),String>{for pin in &self.pins{let f=directory(&pin.path)?;if identity(&f)?!=pin.id{return Err("PARENT_CHANGED".into());}}Ok(())}
 pub fn read(&self)->Result<File,String>{self.verify()?;let f=read_file(&self.path)?;self.verify()?;Ok(f)}
 pub fn exclusive(&self)->Result<File,String>{self.verify()?;let f=exclusive(&self.path,false)?;self.verify()?;Ok(f)}
}
pub fn read_file(path:&Path)->Result<File,String>{
 #[cfg(windows)]{use std::os::windows::fs::OpenOptionsExt;let f=OpenOptions::new().read(true).share_mode(1).custom_flags(0x00200000).open(path).map_err(|e|format!("FILE_BUSY: {e}"))?;let m=f.metadata().map_err(|e|e.to_string())?;if reparse(&m)||!m.is_file(){return Err("NOT_REGULAR_FILE".into());}Ok(f)}
 #[cfg(not(windows))]{let _=path;Err("SAFE_PLATFORM_UNAVAILABLE".into())}
}
pub fn exclusive(path:&Path,create:bool)->Result<File,String>{
 #[cfg(windows)]{use std::os::windows::fs::OpenOptionsExt;let mut o=OpenOptions::new();o.read(true).write(true).access_mode(0x80000000|0x40000000|0x10000).share_mode(0).custom_flags(0x00200000);if create{o.create_new(true);}let f=o.open(path).map_err(|e|format!("FILE_BUSY: {e}"))?;let m=f.metadata().map_err(|e|e.to_string())?;if reparse(&m)||!m.is_file(){return Err("NOT_REGULAR_FILE".into());}Ok(f)}
 #[cfg(not(windows))]{let _=(path,create);Err("SAFE_PLATFORM_UNAVAILABLE".into())}
}
static FILES:OnceLock<Mutex<HashSet<String>>>=OnceLock::new();
pub struct FilePermit{id:String}
pub fn lock_file(id:&str)->Result<FilePermit,String>{let mut map=FILES.get_or_init(Default::default).lock().map_err(|_|"FILE_BUSY")?;if map.len()>=128||!map.insert(id.into()){return Err("SAVE_IN_PROGRESS: 同一实体文件正在操作".into());}Ok(FilePermit{id:id.into()})}
pub fn file_busy(id:&str)->bool{FILES.get_or_init(Default::default).lock().map(|m|m.contains(id)).unwrap_or(true)}
impl Drop for FilePermit{fn drop(&mut self){if let Ok(mut m)=FILES.get_or_init(Default::default).lock(){m.remove(&self.id);}}}

struct Managed { nonce: String, root_id: String, file_id: String, path: PathBuf }
static MANAGED: OnceLock<Mutex<Vec<Managed>>> = OnceLock::new();
pub fn manage(instance: &Instance, root_id: &str, file_id: &str, path: &Path) -> Result<(), String> {
    let mut map = MANAGED.get_or_init(Default::default).lock().map_err(|_| "EDITOR_BUSY")?;
    live(instance)?;
    if map.iter().any(|v| v.nonce == instance.nonce && v.root_id == root_id && v.path == path) { return Ok(()); }
    if map.len() >= 128 { return Err("EDITOR_OWNERSHIP_FULL".into()); }
    map.push(Managed { nonce: instance.nonce.clone(), root_id: root_id.into(), file_id: file_id.into(), path: path.into() }); Ok(())
}
pub fn managed(file_id: &str) -> bool {
    MANAGED.get_or_init(Default::default).lock().map(|m| m.iter().any(|v| v.file_id == file_id)).unwrap_or(true)
}
pub fn migrate_managed(old: &str, new: &str, path: &Path) {
    if let Ok(mut map) = MANAGED.get_or_init(Default::default).lock() { for v in map.iter_mut() { if v.file_id == old && v.path == path { v.file_id = new.into(); } } }
}
pub fn release_managed(instance: &Instance, root_id: &str, path: &Path) {
    if let Ok(mut map) = MANAGED.get_or_init(Default::default).lock() { map.retain(|v| !(v.nonce == instance.nonce && v.root_id == root_id && v.path == path)); }
}
pub fn destroy_managed(instance: &Instance) {
    if let Ok(mut map) = MANAGED.get_or_init(Default::default).lock() { map.retain(|v| v.nonce != instance.nonce); }
}
