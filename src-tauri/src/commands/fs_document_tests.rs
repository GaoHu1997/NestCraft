//! 未挂载的历史读窗口/租约测试（CR-055 期间遗留），**不参与编译，也不构成任何覆盖**。
//! 原因：这些用例调用旧 `open_document(own, root, path)` 三参签名，当前 `read` 模块是
//! 四参（own, instance, pins, credit）；文件里用到的 `checked_path` 也已不在该模块。
//! 保留仅用于追溯；若将来要恢复，必须先按现行签名重写并通过回归，不能直接挂载后当已测。
use super::*;
struct Fixture { root: PathBuf, id: Option<String> }
impl Fixture {
    fn new(bytes: &[u8]) -> Self { let root=std::env::temp_dir().join(format!("cr055-editor-{}",uuid::Uuid::new_v4()));fs::create_dir(&root).unwrap();fs::write(root.join("sample.txt"),bytes).unwrap();Self{root:fs::canonicalize(root).unwrap(),id:None} }
    fn open(&mut self)->DocumentInfo { let info=open_document("test-window".into(),self.root.clone(),self.root.join("sample.txt")).unwrap();self.id=Some(info.doc_id.clone());info }
    fn page(&self,info:&DocumentInfo,cursor:&str)->WindowData { let handle=docs().lock().unwrap().get(&info.doc_id).cloned().unwrap();let mut doc=handle.lock().unwrap();read_window(&mut doc,cursor,&info.revision).unwrap() }
}
impl Drop for Fixture {fn drop(&mut self){if let Some(id)=&self.id{docs().lock().unwrap().remove(id);}let _=fs::remove_dir_all(&self.root);}}
#[test]
#[cfg(windows)]
fn utf8_window_handles_scalar_boundary_and_replay(){
    let content=format!("{}😀\r\n尾", "a".repeat(BLOCK-1));let mut f=Fixture::new(content.as_bytes());let info=f.open();
    let first=f.page(&info,&info.initial_cursor);assert_eq!(first.text.len(),BLOCK-1);assert!(!first.eof);
    let replay=f.page(&info,&info.initial_cursor);assert_eq!(replay.text,first.text);assert_eq!(replay.next_cursor,first.next_cursor);
    let last=f.page(&info,first.next_cursor.as_ref().unwrap());assert!(last.eof);assert_eq!(format!("{}{}",first.text,last.text),content);
    assert_eq!(last.source_hash.unwrap(),format!("sha256:{:x}",Sha256::digest(content.as_bytes())));
}
#[test]
#[cfg(windows)]
fn utf16_window_keeps_surrogate_pair_and_original_hash(){
    let content=format!("{}😀\r\n尾", "a".repeat(BLOCK/2-1));let mut bytes=vec![0xff,0xfe];bytes.extend(content.encode_utf16().flat_map(u16::to_le_bytes));
    let mut f=Fixture::new(&bytes);let info=f.open();assert_eq!(info.encoding,"utf-16le");let first=f.page(&info,&info.initial_cursor);let last=f.page(&info,first.next_cursor.as_ref().unwrap());assert_eq!(format!("{}{}",first.text,last.text),content);assert_eq!(last.source_hash.unwrap(),format!("sha256:{:x}",Sha256::digest(&bytes)));
}
#[test]
#[cfg(windows)]
fn lease_blocks_external_write_and_rejects_wrong_revision(){
    let mut f=Fixture::new(b"original");let info=f.open();assert!(OpenOptions::new().write(true).open(f.root.join("sample.txt")).is_err());
    let handle=docs().lock().unwrap().get(&info.doc_id).cloned().unwrap();let mut doc=handle.lock().unwrap();assert!(read_window(&mut doc,&info.initial_cursor,"wrong").is_err());assert!(read_window(&mut doc,"3",&info.revision).is_err());
}
#[test]
fn checked_path_rejects_parent_escape(){let f=Fixture::new(b"safe");assert!(checked_path(&f.root.to_string_lossy(),"../sample.txt").is_err());}
#[test]
#[cfg(windows)]
fn guarded_rename_preserves_original_and_never_overwrites_competitor(){
    let f=Fixture::new(b"old");let original=f.root.join("sample.txt");let backup=f.root.join("backup.txt");let target=f.root.join("new.tmp");
    let old=exclusive(&original,false).unwrap();let mut staged=exclusive(&target,true).unwrap();staged.write_all(b"new").unwrap();staged.sync_all().unwrap();rename_handle(&old,&backup).unwrap();
    fs::write(&original,b"competitor").unwrap();assert!(rename_handle(&staged,&original).is_err());assert!(rename_handle(&old,&original).is_err());drop(staged);drop(old);assert_eq!(fs::read(&original).unwrap(),b"competitor");assert_eq!(fs::read(&backup).unwrap(),b"old");
}
