//! CR-045 user-only local file operations. No parser, shell execution of content, or AI writer.
//! Revision tokens hash actual bytes with FNV-1a64, not a cryptographic digest.

use crate::models::NoteNode;
use base64::Engine;
use serde::Serialize;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Write};
#[cfg(windows)]
use std::io::{Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

pub(super) const TEXT_LIMIT: u64 = 1024 * 1024;
pub(super) const FILE_LIMIT: u64 = 25 * 1024 * 1024;
pub(super) const BATCH_LIMIT: usize = 20;
const DEPTH_LIMIT: usize = 32;
const ENTRY_LIMIT: usize = 10000;
const TEMP_PREFIX: &str = ".nestcraft-kb-save-";
/// Serializes explicit knowledge mutations, including the hash compare and index publication.
pub(super) static MUTATION: Mutex<()> = Mutex::new(());

pub(super) fn fnv_bytes(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x100000001b3))
}
pub(super) fn hash(bytes: &[u8]) -> String { format!("fnv1a64:{:016x}", fnv_bytes(bytes)) }
pub(super) fn file_id(rel: &str) -> String { format!("n{}", fnv_bytes(rel.as_bytes())) }
pub(super) fn dir_id(rel: &str) -> String { format!("d{}", fnv_bytes(rel.as_bytes())) }
pub(super) fn markdown(path: &Path) -> bool {
    path.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("md") || s.eq_ignore_ascii_case("markdown")).unwrap_or(false)
}
/// 富文本对应 zyplayer editorType=1，落成 .html/.htm。SVG 不是富文本。
pub(super) fn richtext(path: &Path) -> bool {
    path.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("html") || s.eq_ignore_ascii_case("htm")).unwrap_or(false)
}
/// CR-030-D1：参与切片的文本格式（read_text 已支持，零新增解析器）。
/// 其它格式（pdf/office/图片/未知）= metadata_only：文件名/路径可搜，正文不可搜。
pub(super) fn indexable_text(path: &Path) -> bool {
    path.extension().and_then(|s| s.to_str())
        .map(|s| ["txt", "log", "text", "json", "csv"].iter().any(|e| s.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}
pub(super) fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 240 || name.trim() != name || name.ends_with('.')
        || name == "." || name == ".." || name.starts_with(TEMP_PREFIX)
        || name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c)) {
        return Err("文件名无效：不能为空、过长、含路径/控制字符、尾空格或尾点".into());
    }
    let base = name.split('.').next().unwrap_or("").trim_end().to_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$"].contains(&base.as_str())
        || base.strip_prefix("COM").or_else(|| base.strip_prefix("LPT"))
            .map(|n| ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"].contains(&n)).unwrap_or(false) {
        return Err("文件名是保留设备名称".into());
    }
    Ok(())
}
pub(super) fn relative(rel: &str) -> Result<Vec<&str>, String> {
    if rel.is_empty() { return Ok(vec![]); }
    // Public URIs use '/', never OS-specific absolute/device/ADS paths.
    if rel.contains('\\') || rel.starts_with('/') { return Err("父路径必须是库内相对URI".into()); }
    let parts: Vec<_> = rel.split('/').collect();
    if parts.len() > DEPTH_LIMIT { return Err("目录层级超过32层".into()); }
    for part in &parts { validate_name(part)?; }
    Ok(parts)
}
pub(super) fn child_uri(parent: &str, name: &str) -> Result<String, String> {
    relative(parent)?;
    validate_name(name)?;
    let rel = if parent.is_empty() { name.to_string() } else { format!("{parent}/{name}") };
    relative(&rel)?;
    Ok(rel)
}

fn normal_absolute(path: &Path) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let s = path.to_str().ok_or("路径编码无效")?;
        // canonicalize on Windows emits a verbatim drive prefix. Accept only that
        // harmless canonical form; UNC, device namespaces and alternate streams stay forbidden.
        let s = s.strip_prefix("\\\\?\\").unwrap_or(s);
        let bytes = s.as_bytes();
        if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':'
            || ![b'\\', b'/'].contains(&bytes[2]) || s[2..].contains(':') {
            return Err("只允许本机绝对磁盘路径；拒绝UNC、设备路径与ADS".into());
        }
        let normal = PathBuf::from(s);
        if normal.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
            return Err("绝对路径含相对穿越".into());
        }
        Ok(normal)
    }
    #[cfg(not(windows))]
    {
        if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
            return Err("路径不是安全绝对路径".into());
        }
        Ok(path.to_path_buf())
    }
}
fn link(meta: &Metadata) -> bool {
    #[cfg(windows)]
    { use std::os::windows::fs::MetadataExt; meta.file_type().is_symlink() || meta.file_attributes() & 0x400 != 0 }
    #[cfg(not(windows))]
    { meta.file_type().is_symlink() }
}
fn identity(meta: &Metadata) -> (u64, u64) {
    #[cfg(windows)]
    { use std::os::windows::fs::MetadataExt; (meta.creation_time(), meta.file_attributes() as u64 & 0x10) }
    #[cfg(unix)]
    { use std::os::unix::fs::MetadataExt; (meta.dev(), meta.ino()) }
    #[cfg(not(any(windows, unix)))]
    { (meta.len(), 0) }
}
fn open_directory(path: &Path) -> Result<File, String> {
    let mut opt = OpenOptions::new();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Zero data access, BACKUP_SEMANTICS + OPEN_REPARSE_POINT; no DELETE sharing.
        // Pin every ancestor while checking/reading/writing, preventing junction swaps
        // and parent-directory renames by another process during the operation.
        opt.access_mode(0).share_mode(3).custom_flags(0x02000000 | 0x00200000);
    }
    #[cfg(not(windows))]
    { opt.read(true); }
    opt.open(path).map_err(|_| "无法锁定受检目录".into())
}
/// Holds directory handles and identities for the entire operation.
pub(super) struct SafeRoot {
    pub path: PathBuf,
    pins: Vec<(PathBuf, File, (u64, u64))>,
}
impl SafeRoot {
    pub fn new(path: &Path) -> Result<Self, String> {
        let original = normal_absolute(path)?;
        let mut root = Self { path: original.clone(), pins: vec![] };
        let mut cursor = PathBuf::new();
        for component in original.components() {
            cursor.push(component.as_os_str());
            if matches!(component, Component::Normal(_)) || matches!(component, Component::RootDir) {
                root.pin(&cursor)?;
            }
        }
        let canonical = normal_absolute(&fs::canonicalize(&original).map_err(|_| "知识库目录不可访问")?)?;
        if canonical != original { return Err("知识库路径已变化或存在链接".into()); }
        root.path = canonical;
        root.verify()?;
        Ok(root)
    }
    fn pin(&mut self, path: &Path) -> Result<(), String> {
        if self.pins.iter().any(|(p, _, _)| p == path) { return self.verify(); }
        let before = fs::symlink_metadata(path).map_err(|_| "目录不可访问")?;
        if link(&before) || !before.is_dir() { return Err("拒绝symlink/reparse或非目录".into()); }
        let handle = open_directory(path)?;
        let held = handle.metadata().map_err(|_| "目录状态不可读取")?;
        let after = fs::symlink_metadata(path).map_err(|_| "目录在操作期间变化")?;
        if link(&held) || link(&after) || identity(&before) != identity(&held) || identity(&held) != identity(&after) {
            return Err("目录在操作期间变化".into());
        }
        self.pins.push((path.to_path_buf(), handle, identity(&held)));
        Ok(())
    }
    pub fn verify(&self) -> Result<(), String> {
        for (path, handle, id) in &self.pins {
            let meta = fs::symlink_metadata(path).map_err(|_| "父目录在操作期间变化")?;
            if link(&meta) || !meta.is_dir() || identity(&meta) != *id
                || identity(&handle.metadata().map_err(|_| "目录锁失效")?) != *id {
                return Err("父目录在操作期间变化".into());
            }
        }
        Ok(())
    }
    pub fn parent(&mut self, rel: &str) -> Result<PathBuf, String> {
        let mut path = self.path.clone();
        for part in relative(rel)? { path.push(part); self.pin(&path)?; }
        self.verify()?;
        let canonical = normal_absolute(&fs::canonicalize(&path).map_err(|_| "父目录不可访问")?)?;
        if canonical != path || !canonical.starts_with(&self.path) { return Err("路径越界或父目录变化".into()); }
        Ok(path)
    }
    pub fn file(&mut self, rel: &str) -> Result<PathBuf, String> {
        let parts = relative(rel)?;
        if parts.is_empty() { return Err("必须指定文件".into()); }
        let parent = parts[..parts.len()-1].join("/");
        let path = self.parent(&parent)?.join(parts[parts.len()-1]);
        let meta = fs::symlink_metadata(&path).map_err(|_| "文件不可访问")?;
        if link(&meta) || !meta.is_file() { return Err("拒绝symlink/reparse或非普通文件".into()); }
        let canonical = normal_absolute(&fs::canonicalize(&path).map_err(|_| "文件不可访问")?)?;
        if canonical != path || !canonical.starts_with(&self.path) { return Err("路径越界".into()); }
        self.verify()?;
        Ok(path)
    }
}
fn open_read(path: &Path) -> Result<File, String> {
    let before = fs::symlink_metadata(path).map_err(|_| "文件不可访问")?;
    if link(&before) || !before.is_file() { return Err("拒绝symlink/reparse或非普通文件".into()); }
    let mut opt = OpenOptions::new();
    opt.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        opt.share_mode(1).custom_flags(0x00200000);
    }
    let file = opt.open(path).map_err(|_| "文件被占用或不可读取")?;
    let held = file.metadata().map_err(|_| "文件状态不可读取")?;
    let after = fs::symlink_metadata(path).map_err(|_| "文件在操作期间变化")?;
    if link(&held) || !held.is_file() || link(&after) || identity(&before) != identity(&held) || identity(&held) != identity(&after) {
        return Err("文件在操作期间变化".into());
    }
    Ok(file)
}
/// FEAT-008 immutable-index cache identity; independent of timestamps/stat tokens.
/// Existing user-file APIs and their behavior are unchanged.
pub(super) fn snapshot_entity_id(file:&File)->Result<String,String>{
    #[cfg(windows)] {
        use std::os::windows::io::AsRawHandle;
        #[repr(C)] struct FileIdInfo {volume:u64,id:[u8;16]}
        #[link(name="kernel32")] extern "system" {fn GetFileInformationByHandleEx(handle:*mut std::ffi::c_void,class:i32,info:*mut std::ffi::c_void,size:u32)->i32;}
        let mut info=FileIdInfo{volume:0,id:[0;16]};
        // FILE_ID_INFO (18) supplies the real volume + 128-bit entity identity.
        let ok=unsafe{GetFileInformationByHandleEx(file.as_raw_handle(),18,&mut info as *mut _ as *mut std::ffi::c_void,std::mem::size_of::<FileIdInfo>()as u32)};
        if ok==0{return Err(format!("INDEX_ENTITY_UNAVAILABLE: {}",std::io::Error::last_os_error()));}
        Ok(format!("{:016x}:{:02x?}",info.volume,info.id))
    }
    #[cfg(unix)] {use std::os::unix::fs::MetadataExt;let m=file.metadata().map_err(|e|e.to_string())?;Ok(format!("{}:{}",m.dev(),m.ino()))}
    #[cfg(not(any(windows,unix)))] {let _=file;Err("INDEX_ENTITY_UNAVAILABLE: 本平台无受检实体ID".into())}
}
pub(super) fn snapshot_file_identity(path:&Path)->Result<String,String>{
    let file=open_read(path)?;snapshot_entity_id(&file)
}
pub(super) fn snapshot_directory_identity(path:&Path)->Result<String,String>{
    let file=open_directory(path)?;let held=file.metadata().map_err(|e|e.to_string())?;
    if link(&held)||!held.is_dir(){return Err("INDEX_PATH_UNSAFE".into());}snapshot_entity_id(&file)
}
/// FEAT-008 derived-index protection. Does not change SafeRoot/user-file behavior.
pub(super) struct SnapshotPins { pub path:PathBuf, pins:Vec<(PathBuf,File,String)> }
fn snapshot_probe(path:&Path,directory:bool)->Result<File,String>{
    let mut options=OpenOptions::new();
    #[cfg(windows)] {use std::os::windows::fs::OpenOptionsExt;options.access_mode(0x80).share_mode(7).custom_flags(0x00200000|if directory{0x02000000}else{0});}
    #[cfg(not(windows))] {options.read(true);}
    let file=options.open(path).map_err(|e|format!("INDEX_ENTITY_OPEN: {e}"))?;let m=file.metadata().map_err(|e|e.to_string())?;
    if link(&m)||if directory{!m.is_dir()}else{!m.is_file()}{return Err("INDEX_PATH_UNSAFE".into());}Ok(file)
}
fn snapshot_pin_directory(path:&Path)->Result<File,String>{
    let mut options=OpenOptions::new();
    #[cfg(windows)] {use std::os::windows::fs::OpenOptionsExt;options.access_mode(0).share_mode(1).custom_flags(0x02200000);}
    #[cfg(not(windows))] {options.read(true);}
    options.open(path).map_err(|e|format!("INDEX_DIRECTORY_PIN: {e}"))
}
// Instrument only the new batch API; old file/verify behavior is untouched.
#[cfg(test)]
std::thread_local! {pub(super) static SNAPSHOT_BATCH_COUNTS:std::cell::Cell<(u64,u64)>=std::cell::Cell::new((0,0));}
impl SnapshotPins {
    fn chain(path:&Path,create:bool)->Result<Self,String>{
        let path=normal_absolute(path)?;let mut result=Self{path:path.clone(),pins:Vec::new()};let mut cursor=PathBuf::new();
        for component in path.components(){cursor.push(component.as_os_str());if !matches!(component,Component::RootDir|Component::Normal(_)){continue;}
            if create&&matches!(component,Component::Normal(_))&&!cursor.exists(){
                let parent=result.pins.last().ok_or("INDEX_PATH_UNSAFE")?;
                match snapshot_create_directory(&parent.1,component.as_os_str()){
                    Ok(file)=>{let id=snapshot_entity_id(&file)?;result.pins.push((cursor.clone(),file,id));continue;},
                    Err(error)=>{if !cursor.exists(){return Err(error);}}
                }
            }
            let file=snapshot_pin_directory(&cursor)?;let m=file.metadata().map_err(|e|e.to_string())?;if link(&m)||!m.is_dir(){return Err("INDEX_PATH_UNSAFE".into());}
            let id=snapshot_entity_id(&file)?;if snapshot_entity_id(&snapshot_probe(&cursor,true)?)?!=id{return Err("INDEX_ENTITY_CHANGED".into());}
            result.pins.push((cursor.clone(),file,id));
        }
        result.verify()?;Ok(result)
    }
    pub(super) fn new(path:&Path)->Result<Self,String>{Self::chain(path,false)}
    pub(super) fn parent(path:&Path,create:bool)->Result<Self,String>{Self::chain(path.parent().ok_or("INDEX_PATH_UNSAFE")?,create)}
    pub(super) fn verify(&self)->Result<(),String>{
        for(path,file,id)in &self.pins{
            if snapshot_entity_id(file)?!=*id||snapshot_entity_id(&snapshot_probe(path,true)?)?!=*id{return Err("INDEX_ENTITY_CHANGED".into());}
        }Ok(())
    }
    pub(super) fn entity(&self)->Result<String,String>{self.pins.last().map(|p|p.2.clone()).ok_or("INDEX_PATH_UNSAFE".into())}
    pub(super) fn create_generation(mut self,name:&std::ffi::OsStr)->Result<Self,String>{
        self.verify()?;let child=self.path.join(name);let parent=&self.pins.last().ok_or("INDEX_PATH_UNSAFE")?.1;
        let file=snapshot_create_directory(parent,name)?;let id=snapshot_entity_id(&file)?;
        self.path=child.clone();self.pins.push((child,file,id));self.verify()?;Ok(self)
    }
    pub(super) fn delete_created(mut self)->Result<(),String>{
        self.verify()?;let(path,file,expected)=self.pins.pop().ok_or("INDEX_PATH_UNSAFE")?;self.path=path.parent().ok_or("INDEX_PATH_UNSAFE")?.to_path_buf();
        // Transfer only a failed creation to DELETE capability; all ancestors remain pinned.
        // Never adopt a replacement after closing the read pin, even if the path still exists.
        drop(file);let file=snapshot_delete_open(&path,true)?;
        if snapshot_entity_id(&file)?!=expected||snapshot_entity_id(&snapshot_probe(&path,true)?)?!=expected{return Err("INDEX_ENTITY_CHANGED: 拒绝回收创建路径replacement".into());}
        self.verify()?;let delete=SnapshotDelete{path,file,_parent:self};delete.remove_children()?;delete.finish()
    }
    /// Fresh READ_DATA for one bounded batch. Existing pins never leave this owner.
    /// Check runs while every fresh handle is alive; exactly two successful ancestor
    /// verifications enclose acquisition AND the caller's content/inventory checks.
    pub(super) fn checked_read_files<T>(&self,paths:&[(PathBuf,String)],check:impl FnOnce(&[File])->Result<T,String>)->Result<(T,usize),String>{
        if paths.is_empty()||paths.len()>4096{return Err("INDEX_BATCH_LIMIT".into());}
        #[cfg(test)] SNAPSHOT_BATCH_COUNTS.with(|s|{let(f,v)=s.get();s.set((f,v+1));});
        self.verify()?;
        let mut fresh=Vec::with_capacity(paths.len());
        for (path,expected) in paths{
            let path=normal_absolute(path)?;
            if path.parent()!=Some(self.path.as_path()){return Err("INDEX_PATH_UNSAFE".into());}
            snapshot_child_name(path.file_name().ok_or("INDEX_PATH_UNSAFE")?)?;
            let mut options=OpenOptions::new();options.read(true);
            #[cfg(windows)] {use std::os::windows::fs::OpenOptionsExt;options.share_mode(1).custom_flags(0x00200000);}
            // No backup semantics / attributes-only access: normal READ_DATA is
            // checked against the CURRENT token and CURRENT DACL on every call.
            let file=options.open(&path).map_err(|e|format!("INDEX_FRESH_READ_OPEN: {e}"))?;
            #[cfg(test)] SNAPSHOT_BATCH_COUNTS.with(|s|{let(f,v)=s.get();s.set((f+1,v));});
            let m=file.metadata().map_err(|e|e.to_string())?;
            if link(&m)||!m.is_file()||snapshot_entity_id(&file)?!=*expected{return Err("INDEX_ENTITY_CHANGED".into());}
            fresh.push(file);
        }
        let result=check(&fresh);
        #[cfg(test)] SNAPSHOT_BATCH_COUNTS.with(|s|{let(f,v)=s.get();s.set((f,v+1));});
        self.verify()?;
        result.map(|value|(value,fresh.len()))
    }
    pub(super) fn file(&self,path:&Path,write:bool)->Result<File,String>{
        self.verify()?;let path=normal_absolute(path)?;if path.parent()!=Some(self.path.as_path()){return Err("INDEX_PATH_UNSAFE".into());}
        snapshot_child_name(path.file_name().ok_or("INDEX_PATH_UNSAFE")?)?;
        let mut options=OpenOptions::new();options.read(true).write(write);
        #[cfg(windows)] {use std::os::windows::fs::OpenOptionsExt;options.share_mode(1).custom_flags(0x00200000);}
        let file=options.open(&path).map_err(|e|format!("INDEX_FILE_OPEN: {e}"))?;let m=file.metadata().map_err(|e|e.to_string())?;
        if link(&m)||!m.is_file()||snapshot_entity_id(&file)?!=snapshot_entity_id(&snapshot_probe(&path,false)?)?{return Err("INDEX_PATH_UNSAFE".into());}
        self.verify()?;Ok(file)
    }
}
fn snapshot_child_name(name:&std::ffi::OsStr)->Result<(),String>{
    let text=name.to_str().ok_or("INDEX_PATH_ENCODING")?;
    if text.is_empty()||text=="."||text==".."||text.chars().any(|c|c.is_control()||"<>:\"/\\|?*".contains(c))||text.ends_with('.')||text.ends_with(' '){return Err("INDEX_PATH_UNSAFE".into());}Ok(())
}
#[cfg(windows)]
fn snapshot_create_directory(parent:&File,name:&std::ffi::OsStr)->Result<File,String>{
    use std::os::windows::{ffi::OsStrExt,io::{AsRawHandle,FromRawHandle}};
    snapshot_child_name(name)?;let mut wide:Vec<u16>=name.encode_wide().collect();if wide.len()>32767{return Err("INDEX_PATH_UNSAFE".into());}
    #[repr(C)] struct UnicodeString {length:u16,maximum:u16,buffer:*mut u16}
    #[repr(C)] struct ObjectAttributes {length:u32,root:*mut std::ffi::c_void,name:*mut UnicodeString,attributes:u32,security:*mut std::ffi::c_void,qos:*mut std::ffi::c_void}
    #[repr(C)] struct IoStatus {status:usize,information:usize}
    #[link(name="ntdll")] extern "system" {
        fn NtCreateFile(handle:*mut *mut std::ffi::c_void,access:u32,attributes:*mut ObjectAttributes,status:*mut IoStatus,allocation:*mut i64,file_attributes:u32,share:u32,disposition:u32,options:u32,ea:*mut std::ffi::c_void,ea_length:u32)->i32;
        fn RtlNtStatusToDosError(status:i32)->u32;
    }
    let mut name=UnicodeString{length:(wide.len()*2)as u16,maximum:(wide.len()*2)as u16,buffer:wide.as_mut_ptr()};
    let mut attributes=ObjectAttributes{length:std::mem::size_of::<ObjectAttributes>()as u32,root:parent.as_raw_handle(),name:&mut name,attributes:0x40,security:std::ptr::null_mut(),qos:std::ptr::null_mut()};
    let mut status=IoStatus{status:0,information:0};let mut handle=std::ptr::null_mut();
    // FILE_CREATE, relative to the pinned parent: obtain the created entity atomically.
    // READ_ATTRIBUTES | SYNCHRONIZE, no WRITE/DELETE sharing. A DELETE-capable
    // directory pin with this sharing blocks Windows atomic replacement of its children.
    // Failed registration explicitly transfers to a checked DELETE handle; builds do not.
    let result=unsafe{NtCreateFile(&mut handle,0x100080,&mut attributes,&mut status,std::ptr::null_mut(),0,1,2,0x204021,std::ptr::null_mut(),0)};
    if result<0{return Err(format!("INDEX_ENTITY_CREATE: {}",std::io::Error::from_raw_os_error(unsafe{RtlNtStatusToDosError(result)}as i32)));}
    Ok(unsafe{File::from_raw_handle(handle)})
}
#[cfg(not(windows))]
fn snapshot_create_directory(_parent:&File,_name:&std::ffi::OsStr)->Result<File,String>{Err("INDEX_HANDLE_UNSUPPORTED: 原子受管目录创建仅验证Windows".into())}
/// DELETE-capable generation handle plus continuously held ancestors.
pub(super) struct SnapshotDelete { pub path:PathBuf, file:File, _parent:SnapshotPins }
impl SnapshotDelete {
    pub(super) fn open(path:&Path,expected:&str)->Result<Self,String>{
        let parent=SnapshotPins::parent(path,false)?;let path=normal_absolute(path)?;let file=snapshot_delete_open(&path,true)?;
        if snapshot_entity_id(&file)?!=expected||snapshot_entity_id(&snapshot_probe(&path,true)?)?!=expected{return Err("INDEX_ENTITY_CHANGED: 拒绝回收replacement".into());}
        parent.verify()?;Ok(Self{path,file,_parent:parent})
    }
    pub(super) fn rename(&mut self,target:&Path)->Result<(),String>{
        let target=normal_absolute(target)?;if target.parent()!=self.path.parent(){return Err("INDEX_PATH_UNSAFE".into());}
        self._parent.verify()?;snapshot_rename_handle(&self.file,&target)?;self.path=target;self._parent.verify()
    }
    pub(super) fn remove_children(&self)->Result<(),String>{
        self._parent.verify()?;
        for entry in fs::read_dir(&self.path).map_err(|e|e.to_string())?{
            let entry=entry.map_err(|e|e.to_string())?;snapshot_child_name(&entry.file_name())?;
            let file=snapshot_delete_open(&entry.path(),false)?;let expected=snapshot_entity_id(&file)?;
            if snapshot_entity_id(&snapshot_probe(&entry.path(),false)?)?!=expected{return Err("INDEX_ENTITY_CHANGED".into());}
            snapshot_dispose(&file)?;drop(file);
        }Ok(())
    }
    pub(super) fn finish(self)->Result<(),String>{self._parent.verify()?;snapshot_dispose(&self.file)?;Ok(())}
}
fn snapshot_delete_open(path:&Path,directory:bool)->Result<File,String>{
    let mut options=OpenOptions::new();
    #[cfg(windows)] {use std::os::windows::fs::OpenOptionsExt;options.access_mode(0x110080).share_mode(1).custom_flags(0x00200000|if directory{0x02000000}else{0});}
    #[cfg(not(windows))] {let _=(path,directory);return Err("INDEX_HANDLE_UNSUPPORTED: 句柄式回收仅验证Windows".into());}
    let file=options.open(path).map_err(|e|format!("INDEX_DELETE_OPEN: {e}"))?;let m=file.metadata().map_err(|e|e.to_string())?;
    if link(&m)||if directory{!m.is_dir()}else{!m.is_file()}{return Err("INDEX_PATH_UNSAFE".into());}Ok(file)
}
#[cfg(windows)]
fn snapshot_dispose(file:&File)->Result<(),String>{
    use std::os::windows::io::AsRawHandle;
    #[link(name="kernel32")] extern "system" {fn SetFileInformationByHandle(handle:*mut std::ffi::c_void,class:i32,info:*const std::ffi::c_void,size:u32)->i32;}
    let mut delete:u8=1;let ok=unsafe{SetFileInformationByHandle(file.as_raw_handle(),4,&mut delete as *mut _ as *mut std::ffi::c_void,1)};
    if ok==0{return Err(format!("INDEX_DELETE_ENTITY: {}",std::io::Error::last_os_error()));}Ok(())
}
#[cfg(not(windows))]
fn snapshot_dispose(_file:&File)->Result<(),String>{Err("INDEX_HANDLE_UNSUPPORTED".into())}
#[cfg(windows)]
fn snapshot_rename_handle(file:&File,path:&Path)->Result<(),String>{
    use std::os::windows::{ffi::OsStrExt,io::AsRawHandle};
    #[repr(C)] struct RenameInfo {replace:u8,root:*mut std::ffi::c_void,length:u32,name:[u16;1]}
    #[link(name="kernel32")] extern "system" {fn SetFileInformationByHandle(handle:*mut std::ffi::c_void,class:i32,info:*const std::ffi::c_void,size:u32)->i32;}
    let wide:Vec<u16>=path.as_os_str().encode_wide().collect();let offset=std::mem::offset_of!(RenameInfo,name);let size=offset+wide.len()*2;
    if size>u32::MAX as usize{return Err("INDEX_PATH_UNSAFE".into());}
    // u64 storage gives the pointer-bearing native struct correct alignment; no replace flag.
    let mut buffer=vec![0u64;(size+7)/8];let ptr=buffer.as_mut_ptr()as *mut RenameInfo;
    unsafe{(*ptr).replace=0;(*ptr).root=std::ptr::null_mut();(*ptr).length=(wide.len()*2)as u32;std::ptr::copy_nonoverlapping(wide.as_ptr(),(ptr as *mut u8).add(offset)as *mut u16,wide.len());}
    let ok=unsafe{SetFileInformationByHandle(file.as_raw_handle(),3,ptr as *mut std::ffi::c_void,size as u32)};
    if ok==0{return Err(format!("INDEX_RENAME_ENTITY: {}",std::io::Error::last_os_error()));}Ok(())
}
#[cfg(not(windows))]
fn snapshot_rename_handle(_file:&File,_path:&Path)->Result<(),String>{Err("INDEX_HANDLE_UNSUPPORTED".into())}

pub(super) fn open_snapshot(root: &mut SafeRoot, rel: &str) -> Result<File, String> {
    let path = root.file(rel)?;
    let file = open_read(&path)?;
    root.verify()?;
    Ok(file)
}
fn limited_read(file: &mut File, limit: u64) -> Result<Vec<u8>, String> {
    if file.metadata().map_err(|_| "文件状态不可读取")?.len() > limit { return Err(format!("文件超过容量上限（{} MiB）", limit / 1024 / 1024)); }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).map_err(|_| "文件读取失败")?;
    if bytes.len() as u64 > limit { return Err("文件在读取期间超过容量上限".into()); }
    Ok(bytes)
}
pub(super) fn read_bytes(root: &mut SafeRoot, rel: &str, limit: u64) -> Result<Vec<u8>, String> {
    let path = root.file(rel)?;
    let bytes = limited_read(&mut open_read(&path)?, limit)?;
    root.verify()?;
    Ok(bytes)
}
pub(super) fn read_text(root: &mut SafeRoot, rel: &str) -> Result<(String, String), String> {
    let bytes = read_bytes(root, rel, TEXT_LIMIT)?;
    let token = hash(&bytes);
    let content = String::from_utf8(bytes).map_err(|_| "文件不是有效UTF-8文本；原件保留，可导出")?;
    if content.contains('\0') { return Err("文件含二进制NUL，不作为文本预览".into()); }
    Ok((content, token))
}

pub(super) fn create_folder(root: &mut SafeRoot, parent: &str, name: &str) -> Result<NoteNode, String> {
    let rel = child_uri(parent, name)?;
    let path = root.parent(parent)?.join(name);
    fs::create_dir(&path).map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { "同名目录或文件已存在，不覆盖".to_string() } else { "创建文件夹失败".to_string() })?;
    root.verify()?;
    Ok(NoteNode { note_id: dir_id(&rel), title: name.into(), relative_uri: rel, is_dir: true, children: vec![] })
}
fn new_file(path: &Path) -> Result<File, String> {
    let mut opt = OpenOptions::new();
    opt.write(true).create_new(true);
    #[cfg(windows)]
    { use std::os::windows::fs::OpenOptionsExt; opt.share_mode(0).custom_flags(0x00200000); }
    opt.open(path).map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { "同名文件或目录已存在，不覆盖".into() } else { "无法排它创建文件".into() })
}
fn write_new(root: &SafeRoot, path: &Path, bytes: &[u8]) -> Result<(), String> {
    root.verify()?;
    let mut file = new_file(path)?;
    let result = file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|_| "写入失败；未保存，请保留草稿".to_string());
    drop(file);
    if result.is_err() { let _ = fs::remove_file(path); }
    result?;
    root.verify()?;
    Ok(())
}
pub(super) fn create_markdown(root: &mut SafeRoot, parent: &str, name: &str, content: &str) -> Result<String, String> {
    let rel = child_uri(parent, name)?;
    if !markdown(Path::new(name)) { return Err("新建仅允许.md或.markdown文件".into()); }
    if content.len() as u64 > TEXT_LIMIT || content.contains('\0') { return Err("Markdown必须是1MiB内的UTF-8文本".into()); }
    let path = root.parent(parent)?.join(name);
    write_new(root, &path, content.as_bytes())?;
    Ok(rel)
}
pub(super) fn create_richtext(root: &mut SafeRoot, parent: &str, name: &str, content: &str) -> Result<String, String> {
    let rel = child_uri(parent, name)?;
    if !richtext(Path::new(name)) { return Err("新建富文本仅允许.html或.htm文件".into()); }
    if content.len() as u64 > TEXT_LIMIT || content.contains('\0') { return Err("富文本必须是1MiB内的UTF-8文本".into()); }
    let path = root.parent(parent)?.join(name);
    write_new(root, &path, content.as_bytes())?;
    Ok(rel)
}
pub(super) fn save_richtext(root: &mut SafeRoot, rel: &str, expected: &str, content: &str) -> Result<String, String> {
    if !richtext(Path::new(rel)) { return Err("仅允许保存.html或.htm富文本".into()); }
    if content.len() as u64 > TEXT_LIMIT || content.contains('\0') { return Err("富文本必须是1MiB内的UTF-8文本".into()); }
    #[cfg(windows)]
    { save_guarded(root, rel, expected, content, |_,_| {}) }
    #[cfg(not(windows))]
    {
        let _ = (root, rel, expected, content);
        Err("当前平台尚无排它原子保存守护；未修改原文件，请保留草稿".into())
    }
}
fn node_for(rel: &str, is_dir: bool) -> NoteNode {
    let title = rel.rsplit('/').next().unwrap_or(rel).to_string();
    NoteNode { note_id: if is_dir { dir_id(rel) } else { file_id(rel) }, title, relative_uri: rel.into(), is_dir, children: vec![] }
}
/// 文件走 file()，目录走 parent()。空路径是库根，不允许改。
pub(super) fn locate_entry(root: &mut SafeRoot, rel: &str) -> Result<(PathBuf, bool), String> {
    if relative(rel)?.is_empty() { return Err("不能对知识库根执行此操作".into()); }
    if let Ok(path) = root.file(rel) { return Ok((path, false)); }
    Ok((root.parent(rel)?, true))
}
pub(super) fn rename_entry(root: &mut SafeRoot, rel: &str, new_name: &str) -> Result<NoteNode, String> {
    validate_name(new_name)?;
    let (path, is_dir) = locate_entry(root, rel)?;
    let parts = relative(rel)?;
    let parent_rel = parts[..parts.len()-1].join("/");
    if parts[parts.len()-1] == new_name { return Ok(node_for(rel, is_dir)); }
    let dest_rel = child_uri(&parent_rel, new_name)?;
    let dest = root.parent(&parent_rel)?.join(new_name);
    if fs::symlink_metadata(&dest).is_ok() { return Err("同名目录或文件已存在，不覆盖".into()); }
    fs::rename(&path, &dest).map_err(|_| "重命名失败，未覆盖已有文件".to_string())?;
    if !is_dir { root.verify()?; }
    Ok(node_for(&dest_rel, is_dir))
}
fn remove_tree(path: &Path) -> Result<(), String> {
    let mut children = fs::read_dir(path).map_err(|_| "目录不可读取".to_string())?.collect::<Result<Vec<_>, _>>().map_err(|_| "目录枚举失败".to_string())?;
    children.sort_by_key(|entry| entry.file_name());
    for entry in children {
        let child = entry.path();
        let meta = fs::symlink_metadata(&child).map_err(|_| "子项状态不可读取".to_string())?;
        if link(&meta) { return Err("目录内有链接，已停止删除".into()); }
        if meta.is_dir() { remove_tree(&child)?; }
        else if meta.is_file() { fs::remove_file(&child).map_err(|_| "删除子文件失败".to_string())?; }
        else { return Err("目录内有非普通文件，已停止删除".into()); }
    }
    fs::remove_dir(path).map_err(|_| "删除目录失败".to_string())
}
pub(super) fn delete_entry(root: &mut SafeRoot, rel: &str) -> Result<(), String> {
    let (path, is_dir) = locate_entry(root, rel)?;
    if path == root.path || !path.starts_with(&root.path) { return Err("路径越界，未删除".into()); }
    root.verify()?;
    if is_dir { remove_tree(&path)?; } else { fs::remove_file(&path).map_err(|_| "删除文件失败".to_string())?; }
    // 删掉的目录本身已被钉住，不能再按原路径复核；只确认库根还在。
    let root_meta = fs::symlink_metadata(&root.path).map_err(|_| "知识库根已变化")?;
    if link(&root_meta) || !root_meta.is_dir() { return Err("知识库根已变化".into()); }
    if !is_dir { root.verify()?; }
    Ok(())
}
pub(super) fn move_entry(root: &mut SafeRoot, rel: &str, new_parent: &str) -> Result<NoteNode, String> {
    let (path, is_dir) = locate_entry(root, rel)?;
    if is_dir && (new_parent == rel || new_parent.starts_with(&format!("{rel}/"))) {
        return Err("不能把目录移动到自身或子目录".into());
    }
    let parts = relative(rel)?;
    let name = parts[parts.len()-1].to_string();
    let current_parent = parts[..parts.len()-1].join("/");
    if current_parent == new_parent { return Ok(node_for(rel, is_dir)); }
    let dest_rel = child_uri(new_parent, &name)?;
    let dest = root.parent(new_parent)?.join(&name);
    if fs::symlink_metadata(&dest).is_ok() { return Err("目标已有同名文件或目录，不覆盖".into()); }
    fs::rename(&path, &dest).map_err(|_| "移动失败，未覆盖目标".to_string())?;
    if !is_dir { root.verify()?; }
    Ok(node_for(&dest_rel, is_dir))
}
#[cfg(windows)]
fn open_exclusive(path: &Path, create: bool) -> Result<File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    let mut opt = OpenOptions::new();
    // GENERIC_READ | GENERIC_WRITE | DELETE, no sharing whatsoever. DELETE access
    // lets us rename our own object by handle without releasing its write/delete guard.
    opt.read(true).write(true)
        .access_mode(0x80000000 | 0x40000000 | 0x00010000)
        .share_mode(0).custom_flags(0x00200000);
    if create { opt.create_new(true); }
    let file = opt.open(path).map_err(|_| "无法独占文件；未覆盖，请保留草稿".to_string())?;
    let meta = file.metadata().map_err(|_| "独占文件状态不可读取")?;
    if link(&meta) || !meta.is_file() { return Err("拒绝symlink/reparse或非普通文件".into()); }
    Ok(file)
}

/// Windows FILE_RENAME_INFO with ReplaceIfExists=FALSE. The native operation is
/// create-only: a concurrent target claim can cause failure but can never be overwritten.
#[cfg(windows)]
fn rename_guarded(file: &File, destination: &Path) -> std::io::Result<()> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct RenameInfo {
        replace: u8,
        root: *mut c_void,
        name_bytes: u32,
        name: [u16; 1],
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn SetFileInformationByHandle(file: *mut c_void, class: i32, info: *const c_void, size: u32) -> i32;
    }
    let mut name: Vec<u16> = destination.as_os_str().encode_wide().collect();
    if name.contains(&0) { return Err(std::io::ErrorKind::InvalidInput.into()); }
    let name_bytes = name.len().checked_mul(2).and_then(|n| u32::try_from(n).ok())
        .ok_or(std::io::ErrorKind::InvalidInput)?;
    // Allocate an aligned zero-filled buffer; the filename is the last flexible
    // field (offset 20 on x64), not the trailing padding of the Rust header.
    let offset = std::mem::offset_of!(RenameInfo, name);
    name.push(0);
    let size = std::mem::size_of::<RenameInfo>().max(offset + name.len() * 2);
    let mut buffer = vec![0usize; (size + std::mem::size_of::<usize>() - 1) / std::mem::size_of::<usize>()];
    unsafe {
        let ptr = buffer.as_mut_ptr().cast::<RenameInfo>();
        (*ptr).replace = 0;
        (*ptr).root = std::ptr::null_mut();
        (*ptr).name_bytes = name_bytes;
        std::ptr::copy_nonoverlapping(name.as_ptr(), buffer.as_mut_ptr().cast::<u8>().add(offset).cast::<u16>(), name.len());
        if SetFileInformationByHandle(file.as_raw_handle(), 3, buffer.as_ptr().cast(), size as u32) == 0 {
            Err(std::io::Error::last_os_error())
        } else { Ok(()) }
    }
}

#[cfg(windows)]
#[derive(Clone, Copy)]
pub(super) enum SaveStage { BeforeGuard, AfterFinalHash, AfterBackup }

pub(super) fn save_markdown(root: &mut SafeRoot, rel: &str, expected: &str, content: &str) -> Result<String, String> {
    if !markdown(Path::new(rel)) { return Err("仅允许保存Markdown文件".into()); }
    if content.len() as u64 > TEXT_LIMIT || content.contains('\0') { return Err("Markdown必须是1MiB内的UTF-8文本".into()); }
    #[cfg(windows)]
    { save_guarded(root, rel, expected, content, |_,_| {}) }
    #[cfg(not(windows))]
    {
        let _ = (root, rel, expected);
        // POSIX advisory locks do not exclude an uncooperative external rename.
        // Refuse rather than label a check-then-rename sequence as safe CAS.
        Err("当前平台尚无排它原子保存守护；未修改原文件，请保留草稿".into())
    }
}

#[cfg(windows)]
fn save_guarded<F: FnMut(SaveStage, &Path)>(root: &mut SafeRoot, rel: &str, expected: &str, content: &str, mut hook: F) -> Result<String, String> {
    let path = root.file(rel)?;
    hook(SaveStage::BeforeGuard, &path);
    let mut old = open_exclusive(&path, false)?;
    let before = limited_read(&mut old, TEXT_LIMIT)?;
    if hash(&before) != expected { return Err("文件已被外部修改：hash冲突，未覆盖，请保留草稿并重新读取".into()); }
    let parent = path.parent().ok_or("文件无父目录")?;
    let temp = parent.join(format!("{}{}.tmp", TEMP_PREFIX, uuid::Uuid::new_v4()));
    // Backup is visible as a regular .md recovery file if a competing writer
    // occupies the target and non-overwriting restore cannot run.
    let ext = path.extension().and_then(|s| s.to_str()).map(|s| s.to_ascii_lowercase()).filter(|s| matches!(s.as_str(), "md" | "markdown" | "html" | "htm")).unwrap_or_else(|| "md".into());
    let backup = parent.join(format!("nestcraft-recovery-{}.{ext}", uuid::Uuid::new_v4()));
    let mut staged = open_exclusive(&temp, true)?;
    let result = (|| {
        staged.write_all(content.as_bytes()).and_then(|_| staged.sync_all())
            .map_err(|_| "写入临时稿失败；原文件保留，请保留草稿".to_string())?;
        root.verify()?;
        old.seek(SeekFrom::Start(0)).map_err(|_| "无法核对原文件")?;
        let current = limited_read(&mut old, TEXT_LIMIT)?;
        if current != before { return Err("文件在保存期间变化：hash冲突，未覆盖，请保留草稿".into()); }
        // The same exclusive handle survives final comparison, backup rename,
        // commit and recovery. External write/delete/atomic-replace is not shared.
        hook(SaveStage::AfterFinalHash, &path);
        root.verify()?;
        rename_guarded(&old, &backup).map_err(|_| "无法安全备份原稿；原文件保留，请保留草稿".to_string())?;
        hook(SaveStage::AfterBackup, &path);
        let commit = root.verify().and_then(|_| rename_guarded(&staged, &path)
            .map_err(|_| "提交目标已被占用或提交失败；未覆盖外部文件".to_string()));
        if let Err(error) = commit {
            return match rename_guarded(&old, &path) {
                Ok(()) => Err(format!("{error}；原文件已恢复，请保留草稿")),
                Err(_) => Err(format!("{error}；恢复也未覆盖目标，原稿保留于 {}，请保留草稿", backup.file_name().unwrap_or_default().to_string_lossy())),
            };
        }
        Ok(hash(content.as_bytes()))
    })();
    drop(old);
    drop(staged);
    if result.is_ok() { let _ = fs::remove_file(&backup); }
    else { let _ = fs::remove_file(&temp); }
    result
}

#[cfg(all(windows, test))]
pub(super) fn save_markdown_race<F: FnMut(SaveStage, &Path)>(root: &mut SafeRoot, rel: &str, expected: &str, content: &str, hook: F) -> Result<String, String> {
    save_guarded(root, rel, expected, content, hook)
}

#[derive(Debug, Clone)]
pub(super) struct Entry { pub rel: String, pub is_dir: bool }
pub(super) fn entries(root: &mut SafeRoot) -> Result<Vec<Entry>, String> {
    fn visit(root: &mut SafeRoot, rel: &str, out: &mut Vec<Entry>) -> Result<(), String> {
        let path = root.parent(rel)?;
        let mut children: Vec<_> = fs::read_dir(&path).map_err(|_| format!("目录不可读取：{rel}"))?
            .collect::<Result<Vec<_>, _>>().map_err(|_| format!("目录枚举失败：{rel}"))?;
        children.sort_by_key(|e| e.file_name());
        for child in children {
            let name = child.file_name().into_string().map_err(|_| "文件名不是有效Unicode")?;
            if name == ".git" || name == "node_modules" || name.starts_with(TEMP_PREFIX) { continue; }
            let uri = child_uri(rel, &name)?;
            let meta = fs::symlink_metadata(child.path()).map_err(|_| format!("文件状态不可读取：{uri}"))?;
            if link(&meta) { return Err(format!("目录包含symlink/reparse，扫描拒绝：{uri}")); }
            if !meta.is_dir() && !meta.is_file() { return Err(format!("目录包含非普通文件：{uri}")); }
            if out.len() >= ENTRY_LIMIT { return Err("知识库超过10000个条目，未截断或发布部分树".into()); }
            out.push(Entry { rel: uri.clone(), is_dir: meta.is_dir() });
            if meta.is_dir() { visit(root, &uri, out)?; }
        }
        root.verify()?;
        Ok(())
    }
    let mut out = vec![];
    visit(root, "", &mut out)?;
    Ok(out)
}
pub(super) fn tree(entries: &[Entry], indexed: &std::collections::BTreeMap<String, (String, String)>) -> Vec<NoteNode> {
    fn level(parent: &str, entries: &[Entry], indexed: &std::collections::BTreeMap<String, (String, String)>) -> Vec<NoteNode> {
        let mut nodes: Vec<_> = entries.iter().filter(|e| e.rel.rsplit_once('/').map(|(p,_)| p).unwrap_or("") == parent)
            .map(|e| {
                let filename = e.rel.rsplit('/').next().unwrap_or("").to_string();
                let (id, title) = if e.is_dir { (dir_id(&e.rel), filename) }
                    else { indexed.get(&e.rel).cloned().unwrap_or_else(|| (file_id(&e.rel), filename)) };
                NoteNode { note_id: id, title, relative_uri: e.rel.clone(), is_dir: e.is_dir,
                    children: if e.is_dir { level(&e.rel, entries, indexed) } else { vec![] } }
            }).collect();
        nodes.sort_by(|a,b| b.is_dir.cmp(&a.is_dir).then(a.relative_uri.cmp(&b.relative_uri)));
        nodes
    }
    level("", entries, indexed)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeFileInfo {
    pub note_id: String, pub title: String, pub relative_uri: String,
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<i64>,
    pub kind: String, pub mime: String, pub preview_supported: bool, pub editable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeFileData {
    pub info: KnowledgeFileInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base64: Option<String>,
}
pub(super) fn info(root: &mut SafeRoot, rel: &str, id: &str, title: &str) -> Result<KnowledgeFileInfo, String> {
    let path = root.file(rel)?;
    let meta = open_read(&path)?.metadata().map_err(|_| "文件状态不可读取")?;
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
    let (kind, mime, preview, editable) = match ext.as_str() {
        "md" | "markdown" => ("markdown", "text/markdown", meta.len() <= TEXT_LIMIT, meta.len() <= TEXT_LIMIT),
        "html" | "htm" => ("html", "text/html", meta.len() <= TEXT_LIMIT, meta.len() <= TEXT_LIMIT),
        "txt" | "text" | "log" => ("text", "text/plain", meta.len() <= TEXT_LIMIT, false),
        "json" => ("text", "application/json", meta.len() <= TEXT_LIMIT, false),
        "csv" => ("text", "text/csv", meta.len() <= TEXT_LIMIT, false),
        "png" => ("image", "image/png", meta.len() <= FILE_LIMIT, false),
        "jpg" | "jpeg" => ("image", "image/jpeg", meta.len() <= FILE_LIMIT, false),
        "gif" => ("image", "image/gif", meta.len() <= FILE_LIMIT, false),
        "webp" => ("image", "image/webp", meta.len() <= FILE_LIMIT, false),
        "pdf" => ("pdf", "application/pdf", false, false),
        "doc" | "dot" | "docx" | "rtf" => ("attachment", "application/msword", false, false),
        "ppt" | "pps" | "pot" | "pptx" => ("attachment", "application/vnd.ms-powerpoint", false, false),
        "xls" | "xlsx" => ("attachment", "application/vnd.ms-excel", false, false),
        "bmp" | "ico" | "tif" | "tiff" | "svg" => ("attachment", "application/octet-stream", false, false),
        _ => ("attachment", "application/octet-stream", false, false),
    };
    root.verify()?;
    Ok(KnowledgeFileInfo { note_id: id.into(), title: title.into(), relative_uri: rel.into(), size_bytes: meta.len(),
        modified_at: meta.modified().ok().and_then(|s| s.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis().min(i64::MAX as u128) as i64),
        kind: kind.into(), mime: mime.into(), preview_supported: preview, editable, hash: None })
}
fn valid_image(mime: &str, bytes: &[u8]) -> bool {
    match mime {
        "image/png" => bytes.len() >= 33 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") && &bytes[12..16] == b"IHDR"
            && bytes[8..12] == [0,0,0,13] && bytes[16..20] != [0,0,0,0] && bytes[20..24] != [0,0,0,0],
        "image/jpeg" => bytes.len() >= 4 && bytes.starts_with(b"\xff\xd8\xff") && bytes.ends_with(b"\xff\xd9"),
        "image/gif" => bytes.len() >= 14 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"))
            && bytes[6..8] != [0,0] && bytes[8..10] != [0,0] && bytes.last() == Some(&0x3b),
        "image/webp" => bytes.len() >= 20 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP"
            && [b"VP8 ".as_slice(), b"VP8L".as_slice(), b"VP8X".as_slice()].contains(&&bytes[12..16])
            && u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize + 8 == bytes.len(),
        _ => false,
    }
}
pub(super) fn data(root: &mut SafeRoot, rel: &str, id: &str, title: &str) -> Result<KnowledgeFileData, String> {
    let mut info = info(root, rel, id, title)?;
    let mut text = None;
    let mut image = None;
    match info.kind.as_str() {
        "markdown" | "text" | "html" => { let (body, token) = read_text(root, rel)?; info.hash = Some(token); text = Some(body); }
        "image" => {
            let bytes = read_bytes(root, rel, FILE_LIMIT)?;
            if !valid_image(&info.mime, &bytes) { return Err("图片签名与类型不符或文件损坏；禁止内嵌，可导出原件".into()); }
            info.hash = Some(hash(&bytes));
            image = Some(base64::engine::general_purpose::STANDARD.encode(bytes));
        }
        // PDF、Office、SVG、压缩包和未知格式只给元信息。HTML 富文本在上面作为文档正文返回，界面必须消毒后再显示。
        _ => {}
    }
    Ok(KnowledgeFileData { info, text, base64: image })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadItem {
    pub name: String, pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index_error: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct UploadResult { pub cancelled: bool, pub items: Vec<UploadItem> }
#[derive(Debug, Serialize)]
pub struct ExportResult { pub cancelled: bool, pub exported: bool }

/// Only called with paths returned by our native picker, never exposed as an IPC sourcePath.
/// 上传按原件流式复制，不设容量上限（本机传输）；格式合法性由读取/索引路径分别把关。
pub(super) fn upload_one(root: &mut SafeRoot, parent: &str, source: &Path) -> Result<String, String> {
    let source = normal_absolute(source)?;
    let name = source.file_name().and_then(|s| s.to_str()).ok_or("文件名编码无效")?;
    validate_name(name)?;
    let rel = child_uri(parent, name)?;
    let dest = root.parent(parent)?.join(name);
    let meta = fs::symlink_metadata(&source).map_err(|_| "源文件不可读取".to_string())?;
    if link(&meta) || !meta.is_file() { return Err("拒绝链接或非普通文件".into()); }
    let mut input = open_read(&source)?;
    let mut output = new_file(&dest)?;
    let copied = std::io::copy(&mut input, &mut output).and_then(|_| output.sync_all());
    drop(output);
    if copied.is_err() { let _ = fs::remove_file(&dest); return Err("上传复制失败".into()); }
    root.verify()?;
    Ok(rel)
}
pub(super) fn export(root: &mut SafeRoot, rel: &str, destination: &Path) -> Result<(), String> {
    let destination = normal_absolute(destination)?;
    let name = destination.file_name().and_then(|s| s.to_str()).ok_or("导出文件名编码无效")?;
    validate_name(name)?;
    let target = SafeRoot::new(destination.parent().ok_or("目标无父目录")?)?;
    let source = root.file(rel)?;
    let mut source_file = open_read(&source)?;
    let mut dest = new_file(&destination)?;
    let result = std::io::copy(&mut source_file, &mut dest).and_then(|_| dest.sync_all()).map_err(|_| "导出复制失败".to_string());
    drop(dest);
    if result.is_err() { let _ = fs::remove_file(&destination); }
    result?;
    root.verify()?;
    target.verify()?;
    Ok(())
}

/// 导入只接受参考项目文件策略登记的后缀：md、zip。其它后缀原句拒绝，不落盘。
#[derive(Debug, Serialize)]
pub struct ImportOutcome {
    pub created: Vec<String>,
    pub warnings: Vec<String>,
}
#[derive(Debug, Serialize)]
pub struct RecycleItem {
    pub id: String,
    pub name: String,
    #[serde(rename = "relativeUri")]
    pub relative_uri: String,
    #[serde(rename = "deletedAt")]
    pub deleted_at: i64,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
}

fn suffix_of(name: &str) -> String {
    name.rsplit('.').next().unwrap_or("").to_ascii_lowercase()
}
fn u16_le(bytes: &[u8]) -> u16 { u16::from_le_bytes([bytes[0], bytes[1]]) }
fn u32_le(bytes: &[u8]) -> u32 { u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) }

/// 顺序读本地文件头。UTF-8 标志位按标准解码，否则按参考项目的 GBK 解压。
fn zip_entries(bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut out = Vec::new();
    let mut index = 0;
    while index + 30 <= bytes.len() && &bytes[index..index + 4] == b"PK\x03\x04" {
        let flags = u16_le(&bytes[index + 6..]);
        let method = u16_le(&bytes[index + 8..]);
        let comp_size = u32_le(&bytes[index + 18..]) as usize;
        let name_len = u16_le(&bytes[index + 26..]) as usize;
        let extra_len = u16_le(&bytes[index + 28..]) as usize;
        let name_at = index + 30;
        let data_at = name_at + name_len + extra_len;
        let data_end = data_at.checked_add(comp_size).ok_or("ZIP 结构不完整，未导入")?;
        if name_at + name_len > bytes.len() || data_end > bytes.len() { return Err("ZIP 结构不完整，未导入".into()); }
        if flags & 0x1 != 0 { return Err("ZIP 已加密，未导入".into()); }
        if flags & 0x8 != 0 && comp_size == 0 { return Err("ZIP 使用数据描述符且未给出大小，未导入".into()); }
        let raw_name = &bytes[name_at..name_at + name_len];
        let name = if flags & 0x800 != 0 {
            String::from_utf8(raw_name.to_vec()).map_err(|_| "ZIP 文件名不是 UTF-8，未导入".to_string())?
        } else {
            encoding_rs::GBK.decode(raw_name).0.into_owned()
        };
        let compressed = &bytes[data_at..data_end];
        let payload = match method {
            0 => compressed.to_vec(),
            8 => {
                let mut decoder = flate2::read::DeflateDecoder::new(compressed);
                let mut plain = Vec::new();
                decoder.read_to_end(&mut plain).map_err(|_| "ZIP 解压失败，未导入".to_string())?;
                plain
            }
            other => return Err(format!("暂时不支持的 ZIP 压缩方式：{other}")),
        };
        if payload.len() as u64 > 2 * 1024 * 1024 * 1024 { return Err("ZIP 内单个文件过大，未导入".into()); }
        out.push((name.replace('\\', "/"), payload));
        if out.len() > ENTRY_LIMIT { return Err("ZIP 条目过多，未导入".into()); }
        index = data_end;
    }
    if out.is_empty() { return Err("ZIP 中没有可导入的文件".into()); }
    Ok(out)
}

fn zip_parts(name: &str) -> Result<Vec<String>, String> {
    let name = name.trim_matches('/');
    if name.is_empty() { return Ok(vec![]); }
    if name.contains(':') { return Err("ZIP 含绝对路径，未导入".into()); }
    let parts: Vec<String> = name.split('/').filter(|part| !part.is_empty()).map(str::to_string).collect();
    if parts.len() > DEPTH_LIMIT { return Err("ZIP 目录层级超过 32 层，未导入".into()); }
    for part in &parts {
        if part == "." || part == ".." { return Err("ZIP 含目录穿越，未导入".into()); }
        validate_name(part)?;
    }
    Ok(parts)
}

fn ensure_folders(root: &mut SafeRoot, mut parent: String, dirs: &[String]) -> Result<String, String> {
    for name in dirs {
        let rel = child_uri(&parent, name)?;
        let path = root.parent(&parent)?.join(name);
        if !path.exists() { create_folder(root, &parent, name)?; }
        else if !path.is_dir() { return Err("同名文件已存在，不能当作文件夹导入".into()); }
        parent = rel;
    }
    Ok(parent)
}

fn write_bytes(root: &mut SafeRoot, parent: &str, name: &str, bytes: &[u8]) -> Result<String, String> {
    let rel = child_uri(parent, name)?;
    let path = root.parent(parent)?.join(name);
    write_new(root, &path, bytes)?;
    Ok(rel)
}

fn import_markdown(root: &mut SafeRoot, parent: &str, file_name: &str, bytes: &[u8]) -> Result<String, String> {
    if bytes.len() as u64 > TEXT_LIMIT { return Err("Markdown必须是1MiB内的UTF-8文本".into()); }
    let text = std::str::from_utf8(bytes).map_err(|_| "文件不是有效UTF-8文本；未导入".to_string())?;
    if text.contains('\0') { return Err("文件含二进制NUL，未导入".into()); }
    let stem = file_name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(file_name);
    let name = if stem.is_empty() { "新建文档.md".to_string() } else { format!("{stem}.md") };
    let rel = write_bytes(root, parent, &name, text.as_bytes())?;
    Ok(rel)
}

pub(super) fn import_file(root: &mut SafeRoot, parent: &str, source: &Path) -> Result<ImportOutcome, String> {
    let source = normal_absolute(source)?;
    let file_name = source.file_name().and_then(|s| s.to_str()).ok_or("文件名编码无效")?;
    validate_name(file_name)?;
    let suffix = suffix_of(file_name);
    if suffix == "md" {
        let mut holder = SafeRoot::new(source.parent().ok_or("源文件无父目录")?)?;
        let bytes = read_bytes(&mut holder, file_name, TEXT_LIMIT)?;
        let created = import_markdown(root, parent, file_name, &bytes)?;
        return Ok(ImportOutcome { created: vec![created], warnings: vec![] });
    }
    if suffix != "zip" { return Err(format!("暂时不支持{suffix}格式文件的导入")); }
    let mut holder = SafeRoot::new(source.parent().ok_or("源文件无父目录")?)?;
    let bytes = read_bytes(&mut holder, file_name, 2 * 1024 * 1024 * 1024)?;
    let entries = zip_entries(&bytes)?;
    let mut created = Vec::new();
    let mut warnings = Vec::new();
    for (name, payload) in entries {
        let parts = zip_parts(&name)?;
        if parts.is_empty() { continue; }
        let file = parts.last().unwrap();
        let folder = ensure_folders(root, parent.to_string(), &parts[..parts.len() - 1])?;
        let ext = suffix_of(file);
        if ext == "md" {
            created.push(import_markdown(root, &folder, file, &payload)?);
        } else {
            match write_bytes(root, &folder, file, &payload) {
                Ok(rel) => created.push(rel),
                Err(error) => warnings.push(format!("{file}：{error}")),
            }
        }
    }
    if created.is_empty() {
        return Err(warnings.pop().unwrap_or_else(|| "ZIP 中没有可导入的 MD 文件".into()));
    }
    Ok(ImportOutcome { created, warnings })
}

fn copy_name(name: &str, index: u32) -> String {
    let suffix = if index == 1 { " 副本".to_string() } else { format!(" 副本{index}") };
    match name.rsplit_once('.') {
        Some((stem, ext)) if !ext.is_empty() && !ext.contains(' ') && ext.len() <= 8 => format!("{stem}{suffix}.{ext}"),
        _ => format!("{name}{suffix}"),
    }
}

fn stream_copy(source: &Path, destination: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(source).map_err(|_| "源文件状态不可读取".to_string())?;
    if link(&meta) { return Err("拒绝复制链接或重解析点".into()); }
    if meta.is_dir() {
        fs::create_dir(destination).map_err(|_| "无法创建副本目录".to_string())?;
        let mut children = fs::read_dir(source).map_err(|_| "目录不可读取".to_string())?.collect::<Result<Vec<_>, _>>().map_err(|_| "目录枚举失败".to_string())?;
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            let name = child.file_name().to_str().ok_or("文件名编码无效")?.to_string();
            validate_name(&name)?;
            stream_copy(&child.path(), &destination.join(name))?;
        }
        return Ok(());
    }
    if !meta.is_file() { return Err("拒绝复制非普通文件".into()); }
    let mut input = open_read(source)?;
    let mut output = new_file(destination)?;
    let result = std::io::copy(&mut input, &mut output).and_then(|_| output.sync_all()).map_err(|_| "复制定稿失败".to_string());
    drop(output);
    if result.is_err() { let _ = fs::remove_file(destination); }
    result
}

pub(super) fn copy_entry(root: &mut SafeRoot, rel: &str, new_parent: &str) -> Result<NoteNode, String> {
    let (path, is_dir) = locate_entry(root, rel)?;
    let parts = relative(rel)?;
    let name = parts[parts.len() - 1].to_string();
    let mut chosen = String::new();
    for index in 1..51 {
        let candidate = copy_name(&name, index);
        let dest = root.parent(new_parent)?.join(&candidate);
        if !dest.exists() { chosen = candidate; break; }
    }
    if chosen.is_empty() { return Err("副本名称已用尽，未覆盖已有文件".into()); }
    let dest_rel = child_uri(new_parent, &chosen)?;
    let dest = root.parent(new_parent)?.join(&chosen);
    stream_copy(&path, &dest)?;
    if !is_dir { root.verify()?; }
    Ok(node_for(&dest_rel, is_dir))
}

fn library_key(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 80 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("知识库标识无效".into());
    }
    Ok(())
}
fn recycle_dir(store: &Path, library_id: &str) -> Result<PathBuf, String> {
    library_key(library_id)?;
    let root = store.join("kb-recycle").join(library_id);
    fs::create_dir_all(&root).map_err(|_| "无法创建回收站目录".to_string())?;
    Ok(root)
}
fn recycle_now() -> i64 {
    std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub(super) fn recycle_put(store: &Path, library_id: &str, root: &mut SafeRoot, rel: &str) -> Result<RecycleItem, String> {
    let (path, is_dir) = locate_entry(root, rel)?;
    let name = rel.rsplit('/').next().unwrap_or(rel).to_string();
    let id = uuid::Uuid::new_v4().to_string();
    let bucket = recycle_dir(store, library_id)?.join(&id);
    fs::create_dir(&bucket).map_err(|_| "无法建立回收项".to_string())?;
    let payload = bucket.join("payload");
    let moved = fs::rename(&path, &payload).is_ok();
    if !moved {
        stream_copy(&path, &payload)?;
        delete_entry(root, rel)?;
    }
    let item = RecycleItem { id: id.clone(), name, relative_uri: rel.to_string(), deleted_at: recycle_now(), is_dir };
    let meta = serde_json::json!({
        "id": item.id, "name": item.name, "relativeUri": item.relative_uri,
        "deletedAt": item.deleted_at, "isDir": item.is_dir,
    });
    if fs::write(bucket.join("meta.json"), meta.to_string()).is_err() {
        let _ = fs::rename(&payload, &path);
        let _ = fs::remove_dir_all(&bucket);
        return Err("回收记录写入失败，已尝试放回原处".into());
    }
    Ok(item)
}

pub(super) fn recycle_list(store: &Path, library_id: &str) -> Result<Vec<RecycleItem>, String> {
    let root = recycle_dir(store, library_id)?;
    let mut items = Vec::new();
    for entry in fs::read_dir(&root).map_err(|_| "回收站不可读取".to_string())? {
        let entry = entry.map_err(|_| "回收站枚举失败".to_string())?;
        let meta_path = entry.path().join("meta.json");
        if !meta_path.is_file() { continue; }
        let text = fs::read_to_string(&meta_path).map_err(|_| "回收记录不可读".to_string())?;
        let value: serde_json::Value = serde_json::from_str(&text).map_err(|_| "回收记录损坏".to_string())?;
        items.push(RecycleItem {
            id: value["id"].as_str().unwrap_or("").to_string(),
            name: value["name"].as_str().unwrap_or("").to_string(),
            relative_uri: value["relativeUri"].as_str().unwrap_or("").to_string(),
            deleted_at: value["deletedAt"].as_i64().unwrap_or(0),
            is_dir: value["isDir"].as_bool().unwrap_or(false),
        });
    }
    items.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at).then(b.id.cmp(&a.id)));
    Ok(items)
}

pub(super) fn recycle_restore(store: &Path, library_id: &str, root: &mut SafeRoot, recycle_id: &str) -> Result<NoteNode, String> {
    library_key(library_id)?;
    if !uuid_like(recycle_id) { return Err("回收项标识无效".into()); }
    let bucket = recycle_dir(store, library_id)?.join(recycle_id);
    let text = fs::read_to_string(bucket.join("meta.json")).map_err(|_| "回收项不存在".to_string())?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|_| "回收记录损坏".to_string())?;
    let rel = value["relativeUri"].as_str().ok_or("回收记录缺少原路径")?;
    let is_dir = value["isDir"].as_bool().unwrap_or(false);
    let parts = relative(rel)?;
    if parts.is_empty() { return Err("不能恢复到知识库根".into()); }
    let parent = parts[..parts.len() - 1].join("/");
    ensure_folders(root, String::new(), &parts[..parts.len() - 1].iter().map(|s| (*s).to_string()).collect::<Vec<_>>())?;
    let dest = root.parent(&parent)?.join(parts[parts.len() - 1]);
    if dest.exists() { return Err("原位置已有同名文件或目录，未覆盖".into()); }
    let payload = bucket.join("payload");
    if fs::rename(&payload, &dest).is_err() {
        stream_copy(&payload, &dest)?;
        if is_dir { let _ = fs::remove_dir_all(&payload); } else { let _ = fs::remove_file(&payload); }
    }
    let _ = fs::remove_dir_all(&bucket);
    if !is_dir { root.verify()?; }
    Ok(node_for(rel, is_dir))
}

fn uuid_like(value: &str) -> bool {
    value.len() == 36 && value.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

pub(super) fn recycle_purge(store: &Path, library_id: &str, recycle_id: &str) -> Result<(), String> {
    library_key(library_id)?;
    if !uuid_like(recycle_id) { return Err("回收项标识无效".into()); }
    let bucket = recycle_dir(store, library_id)?.join(recycle_id);
    if !bucket.is_dir() { return Err("回收项不存在".into()); }
    fs::remove_dir_all(&bucket).map_err(|_| "彻底删除失败".to_string())
}

const MEDIA_EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "mp4", "webm"];
pub(super) fn write_media(root: &mut SafeRoot, parent: &str, name: &str, bytes: &[u8]) -> Result<String, String> {
    validate_name(name)?;
    let ext = suffix_of(name);
    if !MEDIA_EXT.contains(&ext.as_str()) { return Err("编辑器只接收图片或视频附件".into()); }
    if bytes.len() as u64 > FILE_LIMIT { return Err("附件超过 25MiB，未写入".into()); }
    if bytes.is_empty() { return Err("附件为空，未写入".into()); }
    let path = root.parent(parent)?.join(name);
    let final_name = if path.exists() { copy_name(name, 1) } else { name.to_string() };
    write_bytes(root, parent, &final_name, bytes)
}

#[cfg(any(windows, test))]
fn parse_picker(bytes: &[u8], multi: bool) -> Result<Option<Vec<PathBuf>>, String> {
    if bytes.len() > 131072 { return Err("文件选择结果过长".into()); }
    let text = std::str::from_utf8(bytes).map_err(|_| "文件选择结果编码无效")?;
    let value: Option<Vec<String>> = serde_json::from_str(text.trim_start_matches('\u{feff}').trim()).map_err(|_| "文件选择结果无效")?;
    match value {
        None => Ok(None),
        Some(paths) => {
            if paths.is_empty() || paths.len() > if multi { BATCH_LIMIT } else { 1 } { return Err("单次最多选择20个文件；此次未复制任何文件".into()); }
            paths.into_iter().map(|p| normal_absolute(Path::new(&p))).collect::<Result<Vec<_>, _>>().map(Some)
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn knowledge_native_picker_cancel_and_untrusted_output() {
        assert!(parse_picker(b"null\r\n",true).unwrap().is_none());
        assert!(parse_picker(b"not json",true).is_err());
        assert!(parse_picker(br#"["relative/path"]"#,true).is_err());
        assert!(parse_picker(b"[]",true).is_err());
        let path = std::env::temp_dir().join("chosen-file.bin").to_string_lossy().to_string();
        let choices = serde_json::to_vec(&vec![path.clone();21]).unwrap();
        assert!(parse_picker(&choices,true).is_err());
        let choices = serde_json::to_vec(&vec![path;2]).unwrap();
        assert!(parse_picker(&choices,false).is_err());
    }
}

pub(super) async fn picker(save: bool) -> Result<Option<Vec<PathBuf>>, String> {
    #[cfg(windows)]
    {
        let constructor = if save { "SaveFileDialog" } else { "OpenFileDialog" };
        let mode = if save { "$dialog.OverwritePrompt = $true; $dialog.Title = '导出知识原件（不覆盖已有文件）'" }
            else { "$dialog.Multiselect = $true; $dialog.CheckFileExists = $true; $dialog.Title = '上传知识原件（最多20个，每个25MiB）'" };
        let result = if save { "$paths = @($dialog.FileName)" } else { "$paths = @($dialog.FileNames)" };
        // Only constants are interpolated. Filenames are returned through JSON, never executed.
        let script = format!(r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.{constructor}
{mode}
$dialog.RestoreDirectory = $true
try {{
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{
    {result}
    ConvertTo-Json -InputObject $paths -Compress
  }} else {{ [Console]::WriteLine('null') }}
}} finally {{ $dialog.Dispose() }}
"#);
        let encoded = base64::engine::general_purpose::STANDARD.encode(script.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>());
        let windows = std::env::var_os("SystemRoot").ok_or("Windows系统目录不可用")?;
        let exe = Path::new(&windows).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut command = tokio::process::Command::new(exe);
        command.args(["-NoProfile", "-STA", "-NonInteractive", "-EncodedCommand", &encoded])
            .stdin(std::process::Stdio::null()).kill_on_drop(true).creation_flags(0x08000000);
        let output = tokio::time::timeout(std::time::Duration::from_secs(600), command.output()).await
            .map_err(|_| "系统文件选择超时")?.map_err(|_| "无法打开系统文件选择器")?;
        if !output.status.success() { return Err("系统文件选择器执行失败".into()); }
        parse_picker(&output.stdout, !save)
    }
    #[cfg(not(windows))]
    { let _ = save; Err("当前平台未接入本机文件选择器".into()) }
}
