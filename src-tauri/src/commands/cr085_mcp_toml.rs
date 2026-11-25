//! Bounded Codex MCP TOML subset: quoted strings, multiline string arrays, env subsections.
use serde_json::{Value, json};
fn uncomment(raw:&str)->&str{let mut quote=None;let mut escape=false;for(i,c)in raw.char_indices(){if escape{escape=false;continue;}if quote==Some('"')&&c=='\\'{escape=true;continue;}if let Some(q)=quote{if c==q{quote=None;}}else if c=='\''||c=='"'{quote=Some(c);}else if c=='#'{return &raw[..i];}}raw}
fn string(raw:&str)->Result<String,String>{let value=raw.trim();if value.starts_with('\'')&&value.ends_with('\'')&&value.len()>=2{return Ok(value[1..value.len()-1].to_string());}serde_json::from_str::<String>(value).map_err(|_|"字符串需使用匹配的引号，反斜杠须按TOML规则转义".into())}
fn array(raw:&str)->Result<Vec<String>,String>{let raw=raw.trim();if !raw.starts_with('[')||!raw.ends_with(']'){return Err("args需为字符串数组".into());}let inner=&raw[1..raw.len()-1];let mut out=Vec::new();let mut start=0;let mut quote=None;let mut escape=false;for(i,c)in inner.char_indices(){if escape{escape=false;continue;}if quote==Some('"')&&c=='\\'{escape=true;continue;}if let Some(q)=quote{if c==q{quote=None;}}else if c=='\''||c=='"'{quote=Some(c);}else if c==','{let part=inner[start..i].trim();if !part.is_empty(){out.push(string(part)?);}start=i+1;}}if quote.is_some(){return Err("args字符串引号未闭合".into());}let tail=inner[start..].trim();if !tail.is_empty(){out.push(string(tail)?);}Ok(out)}
fn complete_array(raw:&str)->bool{let mut quote=None;let mut escape=false;let mut depth=0;for c in raw.chars(){if escape{escape=false;continue;}if quote==Some('"')&&c=='\\'{escape=true;continue;}if let Some(q)=quote{if c==q{quote=None;}}else if c=='\''||c=='"'{quote=Some(c);}else if c=='['{depth+=1;}else if c==']'{depth-=1;}}depth==0&&quote.is_none()}
pub fn parse(text:&str)->Vec<(String,Value)>{
 let mut out:Vec<(String,Value)>=Vec::new();let mut current:Option<usize>=None;let mut env=false;let lines:Vec<&str>=text.lines().collect();let mut index=0;
 while index<lines.len(){let raw=uncomment(lines[index]).trim();index+=1;if raw.is_empty(){continue;}
 if raw.starts_with('['){current=None;env=false;let header=raw.trim_start_matches('[').trim_end_matches(']');if let Some(rest)=header.strip_prefix("mcp_servers."){let(ident,is_env)=if let Some(id)=rest.strip_suffix(".env"){(id,true)}else{(rest,false)};let name=if ident.starts_with('"')||ident.starts_with('\''){match string(ident){Ok(v)=>v,Err(_)=>continue}}else{ident.to_string()};if name.is_empty()||(!ident.starts_with('"')&&ident.contains('.')){continue;}let at=out.iter().position(|(n,_)|n==&name).unwrap_or_else(||{out.push((name,json!({"transport":"stdio"})));out.len()-1});current=Some(at);env=is_env;}continue;}
 let Some(at)=current else{continue};let Some((key,value))=raw.split_once('=')else{continue};let key=key.trim();let mut value=value.trim().to_string();if !env&&key=="args"{while !complete_array(&value)&&index<lines.len(){value.push('\n');value.push_str(uncomment(lines[index]));index+=1;}}
 let cfg=&mut out[at].1;let result:Result<(),String>=(||{if env{let key=if key.starts_with('"')||key.starts_with('\''){string(key)?}else{key.to_string()};if cfg.get("env").is_none(){cfg["env"]=json!({});}cfg["env"][key]=json!(string(&value)?);return Ok(());}match key{"command"=>cfg["command"]=json!(string(&value)?),"url"=>{cfg["url"]=json!(string(&value)?);cfg["transport"]=json!("http");},"args"=>cfg["args"]=json!(array(&value)?),"enabled"=>cfg["enabled"]=json!(value=="true"),_=>{}}Ok(())})();if let Err(e)=result{cfg["_parseError"]=json!(format!("第{}行：{}",index,e));}
 }out
}
#[cfg(test)]mod tests{use super::*;#[test]fn cr085_mcp_toml_preserves_argv(){let rows=parse(r#"[mcp_servers.demo]
command = 'C:\Program Files\nodejs\node.exe'
args = [
  'C:\my work\index.js',
  '', ' a,b ', "two words", # comment
]
[mcp_servers.demo.env]
TOKEN = '  demo=a=b  '
"#);assert_eq!(rows.len(),1);assert_eq!(rows[0].1["command"],r#"C:\Program Files\nodejs\node.exe"#);assert_eq!(rows[0].1["args"],json!([r#"C:\my work\index.js"#,""," a,b ","two words"]));assert_eq!(rows[0].1["env"]["TOKEN"],"  demo=a=b  ");}
#[test]fn cr085_mcp_toml_invalid_args_visible(){let rows=parse("[mcp_servers.bad]\ncommand='node'\nargs=[1,2]");assert!(rows[0].1.get("_parseError").is_some());}}
