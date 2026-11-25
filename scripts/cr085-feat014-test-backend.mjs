// 仅编译本工作包正式源码中的纯逻辑和内存库单测；不编译应用、不运行Tauri/网络/真实库。
import {readFileSync,writeFileSync,mkdirSync,readdirSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
const out=resolve('docs/tmp/cr085-feat014-tests');mkdirSync(out,{recursive:true});
const providers=readFileSync('src-tauri/src/commands/providers.rs','utf8').replace(/\r/g,'');
const db=readFileSync('src-tauri/src/db.rs','utf8').replace(/\r/g,'');
const models=readFileSync('src-tauri/src/models.rs','utf8').replace(/\r/g,'');
const section=(text,start,end)=>{const a=text.indexOf(start),b=text.indexOf(end,a);if(a<0||b<0)throw Error('source boundary missing '+start);return text.slice(a,b);};
const fn=(text,name)=>{const start=text.indexOf(`fn ${name}`);if(start<0)throw Error('missing '+name);const body=text.indexOf('{',start);let depth=1,end=body+1;for(;depth;end++){if(text[end]==='{')depth++;if(text[end]==='}')depth--;}return text.slice(start,end);};
// 选取连续原文，不维护第二套实现。
const pure=[fn(providers,'mask_secret'),section(providers,'pub(crate) fn load_providers_inner','#[tauri::command]'),
 section(providers,'/// 供应商草稿','#[tauri::command]\npub fn provider_save').replace(/\r/g,''),
 fn(providers,'check_owned_ids'),fn(providers,'save_provider_inner'),fn(providers,'provider_secret_refs'),fn(providers,'key_secret_ref'),
 fn(providers,'reorder_inner'),fn(providers,'unreferenced_secrets'),fn(providers,'models_url'),fn(providers,'parse_discovered_models'),
 section(providers,'/// 单个模型的思考档位解析结果。','/// 模型发现并把上游返回行'),
 providers.slice(providers.indexOf('#[cfg(test)]'))];
const modelText=section(models,'// ---------- 模型供应商','// ---------- SDK');
const source=`#![allow(dead_code,unused_imports)]
extern crate url as tauri;
mod models {use serde::{Serialize,Deserialize};${modelText}
pub fn now_ms()->i64{1} pub fn new_id(prefix:&str)->String{format!("{}-{}",prefix,uuid::Uuid::new_v4())}}
mod commands {
pub mod model_route {include!(${JSON.stringify(resolve('src-tauri/src/commands/model_route.rs')).replaceAll('\\\\','/')});}
pub mod think_kb {include!(${JSON.stringify(resolve('src-tauri/src/commands/think_kb.rs')).replaceAll('\\\\','/')});}
pub mod providers {
use crate::models::*;use std::collections::{BTreeMap,BTreeSet};
const THINKING_LEVELS:[&str;7]=["off","minimal","low","medium","high","xhigh","max"];
const MAX_MODELS_BODY:u64=1024*1024;const MAX_DISCOVERED_MODELS:usize=1000;
${pure.join('\n')}
}}
use rusqlite::Connection;
${fn(db,'migrate_cr085_provider_metadata')}
#[test]fn cr085_migration_backfills_once_and_preserves_later_edits(){
let conn=Connection::open_in_memory().unwrap();
conn.execute_batch("CREATE TABLE provider(id TEXT PRIMARY KEY,protocol TEXT,createdAt INTEGER); INSERT INTO provider VALUES('p2','anthropic',2),('p1','openai',1),('p3','openai',2);").unwrap();
migrate_cr085_provider_metadata(&conn).unwrap();
let values:Vec<(String,String,i64)>=conn.prepare("SELECT id,apiMode,sortOrder FROM provider ORDER BY sortOrder").unwrap().query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap().collect::<Result<_,_>>().unwrap();
assert_eq!(values,vec![("p1".into(),"Chat".into(),0),("p2".into(),"Anthropic".into(),1),("p3".into(),"Chat".into(),2)]);
conn.execute_batch("UPDATE provider SET apiMode='Responses',sortOrder=8 WHERE id='p1';").unwrap();
migrate_cr085_provider_metadata(&conn).unwrap();
assert_eq!(conn.query_row("SELECT apiMode,sortOrder FROM provider WHERE id='p1'",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?))).unwrap(),("Responses".into(),8));}
`;
// include! 不接受文件开头的内层文档注释，生成只去除文档注释的受检副本。
let finalSource=source;
for(const name of ['model_route','think_kb']){const path=resolve(`src-tauri/src/commands/${name}.rs`),file=join(out,`${name}.rs`);writeFileSync(file,readFileSync(path,'utf8').replace(/^\/\/!.*$/gm,''));finalSource=finalSource.replace(JSON.stringify(path).replaceAll('\\\\','/'),JSON.stringify(file).replaceAll('\\\\','/'));}
const sourcePath=join(out,'providers.rs');writeFileSync(sourcePath,finalSource);
const deps=resolve('src-tauri/target/debug/deps');
const args=['--edition=2021','--test',sourcePath,'-L',`dependency=${deps}`];
for(const name of ['rusqlite','serde','serde_json','uuid','url']){const libs=readdirSync(deps).filter(n=>n.startsWith(`lib${name}-`)&&n.endsWith('.rlib')).sort((a,b)=>statSync(join(deps,b)).mtimeMs-statSync(join(deps,a)).mtimeMs);if(!libs.length)throw Error('missing cached rlib '+name);args.push('--extern',`${name}=${join(deps,libs[0])}`);}
const exe=join(out,'providers-tests.exe');args.push('-o',exe);
let result=spawnSync('rustc',args,{encoding:'utf8'});process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');if(result.status!==0)process.exit(result.status||1);
result=spawnSync(exe,['--nocapture'],{encoding:'utf8'});writeFileSync(join(out,'result.txt'),(result.stdout||'')+(result.stderr||''));process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status||0);
