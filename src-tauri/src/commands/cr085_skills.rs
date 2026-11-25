//! CR085 Skill managed-copy edit transaction. File journal + same-DB commit marker recover interrupted edits.
use rusqlite::{params, Connection};
use std::{path::Path, sync::{Mutex, OnceLock}};
static EDIT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
pub fn lock() -> Result<std::sync::MutexGuard<'static, ()>, String> { EDIT_LOCK.get_or_init(||Mutex::new(())).lock().map_err(|_|"技能操作锁不可用".into()) }
pub fn slug(value:&str)->Result<String,String>{let s=value.trim();if s.is_empty()||s.len()>100||!s.chars().all(|c|c.is_ascii_alphanumeric()||c=='-'||c=='_'){return Err("技能标识仅可包含字母、数字、连字符和下划线".into());}Ok(s.to_string())}
#[derive(serde::Serialize,serde::Deserialize)]
struct Journal { id:String, old:Option<String>, new:String, old_content:Option<String> }
fn marker(id:&str)->String{format!("skill.edit.committed.{id}")}
fn write_sync(path:&Path,content:&[u8])->Result<(),String>{use std::io::Write;let mut f=std::fs::File::create(path).map_err(|e|e.to_string())?;f.write_all(content).and_then(|_|f.sync_all()).map_err(|e|e.to_string())}
fn rollback(root:&Path,j:&Journal)->Result<(),String>{
  let new=root.join(&j.new);
  if let Some(old)=&j.old {let old=root.join(old);if old!=new&&new.exists(){if old.exists(){return Err("技能恢复目标已存在，请保留恢复日志人工核对".into());}std::fs::rename(&new,&old).map_err(|e|e.to_string())?;}if let Some(text)=&j.old_content{if old.is_dir(){write_sync(&old.join("SKILL.md"),text.as_bytes())?;}}}
  else if new.exists(){std::fs::remove_dir_all(new).map_err(|e|e.to_string())?;}
  Ok(())
}
pub fn recover(root:&Path,conn:&Connection)->Result<(),String>{
  if !root.exists(){return Ok(());}
  for entry in std::fs::read_dir(root).map_err(|e|e.to_string())?.flatten(){
    if !entry.file_name().to_string_lossy().starts_with(".edit-"){continue;}
    let path=entry.path();let file=path.join("journal.json");if !file.is_file(){continue;}
    let j:Journal=serde_json::from_slice(&std::fs::read(&file).map_err(|e|e.to_string())?).map_err(|_|"技能恢复日志无效，未继续修改".to_string())?;
    slug(&j.new)?;if let Some(old)=&j.old{slug(old)?;}
    let committed:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM setting_default WHERE scope='global' AND key=?1)",[marker(&j.id)],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !committed {rollback(root,&j)?;}
    std::fs::remove_dir_all(&path).map_err(|e|format!("技能恢复日志清理失败：{e}"))?;
    conn.execute("DELETE FROM setting_default WHERE scope='global' AND key=?1",[marker(&j.id)]).map_err(|e|e.to_string())?;
  } Ok(())
}
pub fn display_name(conn:&Connection,name:&str)->Option<String>{conn.query_row("SELECT value FROM setting_default WHERE scope='global' AND key=?1",[format!("skill.displayName.{name}")],|r|r.get(0)).ok()}
pub struct Edit<'a>{pub name:&'a str,pub original:Option<&'a str>,pub display:&'a str,pub description:&'a str,pub content:&'a str}
pub fn save(root:&Path,conn:&Connection,input:Edit<'_>)->Result<(),String>{
  std::fs::create_dir_all(root).map_err(|e|e.to_string())?;recover(root,conn)?;
  let name=slug(input.name)?; let original=input.original.map(slug).transpose()?;
  let target=root.join(&name);
  if std::fs::symlink_metadata(&target).map(|m|m.file_type().is_symlink()).unwrap_or(false){return Err("技能目录不能为符号链接".into());}
  let old_content=if let Some(old)=&original {let path=root.join(old);if !path.join("SKILL.md").is_file(){return Err("原技能已不存在，请刷新后重试".into());}if std::fs::symlink_metadata(&path).map(|m|m.file_type().is_symlink()).unwrap_or(false){return Err("技能目录不能为符号链接".into());}Some(std::fs::read_to_string(path.join("SKILL.md")).map_err(|e|e.to_string())?)}else{None};
  if original.as_deref()!=Some(name.as_str())&&(target.exists()||conn.query_row("SELECT EXISTS(SELECT 1 FROM capability WHERE kind='skill' AND name=?1)",[&name],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string())?){return Err("同名技能已存在".into());}
  let id=uuid::Uuid::new_v4().simple().to_string();let work=root.join(format!(".edit-{id}"));std::fs::create_dir(&work).map_err(|e|e.to_string())?;
  let journal=Journal{id:id.clone(),old:original.clone(),new:name.clone(),old_content};
  write_sync(&work.join("next.md"),input.content.as_bytes())?;write_sync(&work.join("journal.json"),&serde_json::to_vec(&journal).map_err(|e|e.to_string())?)?;
  let mut changed = false;
  let result=(||->Result<(),String>{
    let tx=conn.unchecked_transaction().map_err(|e|e.to_string())?;
    if let Some(old)=&original{if old!=&name{std::fs::rename(root.join(old),&target).map_err(|e|e.to_string())?;}}else{std::fs::create_dir(&target).map_err(|e|e.to_string())?;}
    changed = true;
    write_sync(&work.join("started"), b"1")?;
    // Journal holds exact prior bytes. Only SKILL.md is replaced; attached directories stay in place.
    write_sync(&target.join("SKILL.md"),input.content.as_bytes())?;
    let source=target.join("SKILL.md").to_string_lossy().to_string();
    if let Some(old)=&original{
      let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM capability WHERE kind='skill' AND name=?1)",[old],|r|r.get(0)).map_err(|e|e.to_string())?;
      if exists{tx.execute("UPDATE capability SET name=?2,description=?3,sourceRef=?4 WHERE kind='skill' AND name=?1",params![old,name,input.description,source]).map_err(|e|e.to_string())?;}
      else{tx.execute("INSERT INTO capability(id,kind,name,description,sourceRef,risk,enabled,builtin,createdAt) VALUES(?1,'skill',?2,?3,?4,'low',1,0,?5)",params![crate::models::new_id("cap"),name,input.description,source,crate::models::now_ms()]).map_err(|e|e.to_string())?;}
      tx.execute("DELETE FROM setting_default WHERE scope='global' AND key=?1",[format!("skill.displayName.{old}")]).map_err(|e|e.to_string())?;
    }else{tx.execute("INSERT INTO capability(id,kind,name,description,sourceRef,risk,enabled,builtin,createdAt) VALUES(?1,'skill',?2,?3,?4,'low',1,0,?5)",params![crate::models::new_id("cap"),name,input.description,source,crate::models::now_ms()]).map_err(|e|e.to_string())?;}
    tx.execute("INSERT OR REPLACE INTO setting_default(scope,key,value,updatedAt) VALUES('global',?1,?2,0)",params![format!("skill.displayName.{name}"),input.display]).map_err(|e|e.to_string())?;
    tx.execute("INSERT OR REPLACE INTO setting_default(scope,key,value,updatedAt) VALUES('global',?1,'1',0)",[marker(&id)]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?;Ok(())
  })();
  if let Err(e)=result{if changed { if let Err(r)=rollback(root,&journal){return Err(format!("保存失败：{e}；恢复失败：{r}，恢复日志已保留"));} }let _=std::fs::remove_dir_all(&work);return Err(format!("技能保存失败，原内容已恢复：{e}"));}
  // Cleanup failure is recoverable and must not make an already committed save appear failed.
  let _=recover(root,conn);Ok(())
}
#[cfg(test)]
#[path = "cr085_skills_tests.rs"]
mod regression;
