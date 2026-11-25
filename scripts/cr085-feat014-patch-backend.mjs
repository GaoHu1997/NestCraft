import {readFileSync,writeFileSync} from 'node:fs';
const apply=(p,edits)=>{let s=readFileSync(p,'utf8');for(const [a,b]of edits){if(!s.includes(a)||s.indexOf(a)!==s.lastIndexOf(a))throw Error('unique match failed '+p+' '+a.slice(0,50));s=s.replace(a,b);}writeFileSync(p,s);};
apply('src-tauri/src/commands/providers.rs',[
['return "*".repeat(chars.len());','return if chars.len() < 2 { "****".into() } else { format!("{}****{}", chars[0], chars[chars.len() - 1]) };'],
['FROM provider ORDER BY createdAt")','FROM provider ORDER BY sortOrder, createdAt, id")'],
['pub fn provider_list(app: tauri::AppHandle) -> Result<Vec<Provider>, String> {','pub fn provider_list(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {'],
['    load_providers_inner(conn)\n}',`    load_providers_inner(conn)?.into_iter().map(|p| {
        let (mode, order): (String, i64) = conn.query_row("SELECT apiMode, sortOrder FROM provider WHERE id=?1", [&p.id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?;
        let mut value = serde_json::to_value(p).map_err(|e| e.to_string())?;
        value["apiMode"] = serde_json::json!(mode); value["sortOrder"] = serde_json::json!(order);
        Ok(value)
    }).collect()
}`],
['    if draft.name.trim().is_empty() {',`    save_provider_inner_v2(conn, draft, None, None, secrets, write_secrets)
}

fn save_provider_inner_v2(
    conn: &rusqlite::Connection, draft: ProviderDraft, create_id: Option<String>, api_mode: Option<String>,
    secrets: &mut BTreeMap<String, String>, write_secrets: impl FnOnce(&BTreeMap<String, String>) -> Result<(), String>,
) -> Result<String, String> {
    if draft.id.is_some() && create_id.as_deref().is_some_and(|id| !id.trim().is_empty()) { return Err("创建ID与更新身份不能同时指定".into()); }
    let mode = api_mode.unwrap_or_else(|| if draft.protocol == "anthropic" { "Anthropic".into() } else { "Chat".into() });
    if !matches!(mode.as_str(), "Chat" | "Responses" | "Anthropic") || (mode == "Anthropic") != (draft.protocol == "anthropic") { return Err("默认协议与端点类型不一致".into()); }
    if draft.name.trim().is_empty() {`],
['    for e in &draft.endpoints {\n        models_url(&e.base_url)?;', '    let mut endpoint_wires = BTreeSet::new();\n    for e in draft.endpoints.iter().filter(|e| !e.base_url.trim().is_empty()) {\n        if !endpoint_wires.insert(e.protocol.as_str()) { return Err("同一协议只能配置一个端点".into()); }\n        models_url(&e.base_url)?;'],
['    let pid = draft.id.clone().unwrap_or_else(|| new_id("prov"));',`    let pid = draft.id.clone().or_else(|| create_id.filter(|id| !id.trim().is_empty()).map(|id| id.trim().to_string())).unwrap_or_else(|| new_id("prov"));
    if pid.len() > 128 || !pid.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) { return Err("供应商ID只允许字母、数字、短横线、下划线和点（最多128字符）".into()); }`],
['    // 子表仅替换目标供应商，事务内任一步失败都保留原配置。',`    tx.execute("UPDATE provider SET apiMode=?2 WHERE id=?1", rusqlite::params![pid, mode]).map_err(|e| e.to_string())?;
    // 子表仅替换目标供应商，事务内任一步失败都保留原配置。`],
['    for e in &draft.endpoints {\n        let eid', '    for e in draft.endpoints.iter().filter(|e| !e.base_url.trim().is_empty()) {\n        let eid'],
['e.base_url.trim(), e.enabled as i64, now]', 'e.base_url.trim(), 1_i64, now]'],
['    pub note: Option<String>,\n}', '    pub note: Option<String>,\n    pub text: Option<bool>,\n    pub vision: Option<bool>,\n    pub image_gen: Option<bool>,\n    pub modality_source: Option<String>,\n}'],
['        let signal = row.and_then(reasoning_signal);',`        let signal = row.and_then(reasoning_signal);
        let (text, vision, image_gen) = row.map(modality_signal).unwrap_or((None, None, None));
        let modality_source = if text.is_some() || vision.is_some() || image_gen.is_some() { Some("vendor".to_string()) } else { None };`],
['                note: Some("上游明确声明不支持推理".into()),','                note: Some("上游明确声明不支持推理".into()), text, vision, image_gen, modality_source,'],
['                note: entry.note.map(str::to_string),','                note: entry.note.map(str::to_string), text, vision, image_gen, modality_source,'],
['                note: Some("上游确认支持推理，使用通用阶梯（中置信），请核实下发拼写".into()),','                note: Some("上游确认支持推理，使用通用阶梯（中置信），请核实下发拼写".into()), text, vision, image_gen, modality_source,'],
['            note: Some("供应商与内置知识库均未提供可信档位，请手动配置".into()),','            note: Some("供应商与内置知识库均未提供可信档位，请手动配置".into()), text, vision, image_gen, modality_source,'],
['fn reasoning_signal(row: &serde_json::Value) -> Option<bool> {',`fn modality_signal(row: &serde_json::Value) -> (Option<bool>, Option<bool>, Option<bool>) {
    let flag = |names: &[&str]| names.iter().find_map(|name| row.get(*name).and_then(|v| v.as_bool()).or_else(|| row.get("capabilities").and_then(|c| c.get(*name)).and_then(|v| v.as_bool())));
    let input = row.get("input_modalities").or_else(|| row.get("architecture").and_then(|v| v.get("input_modalities"))).and_then(|v| v.as_array());
    let output = row.get("output_modalities").or_else(|| row.get("architecture").and_then(|v| v.get("output_modalities"))).and_then(|v| v.as_array());
    let has = |items: Option<&Vec<serde_json::Value>>, kind: &str| items.map(|items| items.iter().any(|x| x.as_str() == Some(kind)));
    (flag(&["text", "supports_text"]).or_else(|| has(input, "text")), flag(&["vision", "supports_vision"]).or_else(|| has(input, "image")), flag(&["imageGen", "image_gen", "supports_image_generation"]).or_else(|| has(output, "image")))
}

fn reasoning_signal(row: &serde_json::Value) -> Option<bool> {`],
['CREATE TABLE provider(id TEXT PRIMARY KEY,name TEXT,protocol TEXT,disabled INTEGER,headersJson TEXT,createdAt INTEGER,updatedAt INTEGER);','CREATE TABLE provider(id TEXT PRIMARY KEY,name TEXT,protocol TEXT,disabled INTEGER,headersJson TEXT,createdAt INTEGER,updatedAt INTEGER,apiMode TEXT NOT NULL DEFAULT \'\',sortOrder INTEGER NOT NULL DEFAULT 0);'],
["INSERT INTO provider VALUES('p1','one','openai',0,NULL,1,1),('p2','two','openai',0,NULL,1,1);","INSERT INTO provider(id,name,protocol,disabled,headersJson,createdAt,updatedAt) VALUES('p1','one','openai',0,NULL,1,1),('p2','two','openai',0,NULL,1,1);"],
['CREATE TABLE provider(id TEXT PRIMARY KEY,name TEXT,protocol TEXT,disabled INTEGER,headersJson TEXT,fingerprintJson TEXT,createdAt INTEGER,updatedAt INTEGER);','CREATE TABLE provider(id TEXT PRIMARY KEY,name TEXT,protocol TEXT,disabled INTEGER,headersJson TEXT,fingerprintJson TEXT,createdAt INTEGER,updatedAt INTEGER,apiMode TEXT NOT NULL DEFAULT \'\',sortOrder INTEGER NOT NULL DEFAULT 0);']
]);
apply('src-tauri/src/db.rs',[["    migrate_cr059_model_config(conn)?;",`    migrate_cr059_model_config(conn)?;
    migrate_cr085_provider_metadata(conn)?;`],["fn migrate_cr059_model_config(conn: &Connection) -> Result<(), String> {",`fn migrate_cr085_provider_metadata(conn: &Connection) -> Result<(), String> {
    let cols: Vec<String> = conn.prepare("PRAGMA table_info(provider)").map_err(|e| e.to_string())?.query_map([], |r| r.get(1)).map_err(|e| e.to_string())?.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    if !cols.iter().any(|c| c == "apiMode") { tx.execute_batch("ALTER TABLE provider ADD COLUMN apiMode TEXT NOT NULL DEFAULT ''; UPDATE provider SET apiMode=CASE WHEN protocol='anthropic' THEN 'Anthropic' ELSE 'Chat' END;").map_err(|e| e.to_string())?; }
    if !cols.iter().any(|c| c == "sortOrder") { tx.execute_batch("ALTER TABLE provider ADD COLUMN sortOrder INTEGER NOT NULL DEFAULT 0; UPDATE provider SET sortOrder=(SELECT COUNT(*) FROM provider p2 WHERE p2.createdAt<provider.createdAt OR (p2.createdAt=provider.createdAt AND p2.id<provider.id));").map_err(|e| e.to_string())?; }
    tx.commit().map_err(|e| e.to_string())
}

fn migrate_cr059_model_config(conn: &Connection) -> Result<(), String> {`]]);
console.log('provider mode metadata, creation identity, modality response + migration landed');
