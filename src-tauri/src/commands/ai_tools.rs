//! AI 内置工作台工具集 —— 应用自带 MCP stdio 服务器。
//!
//! 文件归属：本文件由两批工作共同承载，注释按实际来源标注，避免张冠李戴。
//! - **CR-060 / STORY-079 / FEAT-023**：内置 `workbench` MCP 服务器与 13 个工作台业务工具
//!   （项目 / 需求文档 / 知识库 / 服务器 / 生图），设计见 docs/LLD/LLD-CR060-AI内置工作台工具集实现.md。
//! - **CR-059 / STORY-078 / FEAT-013**：复用同一通道补齐原有 6 项内置工具
//!   （fs_read / knowledge_* / ssh_exec），修复 BUG-CR059-01；设计见
//!   docs/LLD/LLD-CR059-FEAT013-能力管理与工具注入.md。
//! - **CR-054 / STORY-073**：`open_panel` 让 AI 真实请求打开工作台右栏，设计见 docs/PRD/CR-054-会话中心工作台.md。
//!
//! 共同约束：
//! - 以本应用二进制 `--app-mcp-stdio` 启动（不启动 GUI），与主应用共用同一
//!   SQLite（WAL + busy_timeout）与数据目录；
//! - 实现 MCP stdio 传输：逐行 JSON-RPC 2.0（initialize / tools/list / tools/call / ping）；
//! - 工具复用与 UI 命令同一套校验与存储逻辑（projects/knowledge/servers）；
//! - 工具启停经 capability 表（kind='tool'，name=registry_id），设置-工具页直接治理；
//! - 日志只走 stderr，严禁污染 stdout（会破坏协议流）；
//! - 不做删除类、知识内容写入类、供应商密钥类工具。

use crate::db;
use crate::models::RequirementNode;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

/// stdio 服务器运行上下文（来自启动参数）。
pub struct ToolContext {
    pub project_id: Option<String>,
    pub data_dir: PathBuf,
    /// CR-047：执行会话绑定的唯一 Feature；普通会话为空。
    /// 非空时，工作台需求写入只能落在该 Feature 子树内。
    pub execution_feature_id: Option<String>,
}

/// 解析 `--app-mcp-stdio` 模式参数。返回 None 表示不是该模式。
pub fn parse_stdio_args(args: &[String]) -> Option<Result<ToolContext, String>> {
    if !args.iter().any(|a| a == "--app-mcp-stdio") {
        return None;
    }
    Some(parse_stdio_args_inner(args))
}

fn parse_stdio_args_inner(args: &[String]) -> Result<ToolContext, String> {
    let mut data_dir: Option<PathBuf> = None;
    let mut project_id: Option<String> = None;
    let mut execution_feature_id: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--app-data-dir" => {
                i += 1;
                data_dir = args.get(i).map(PathBuf::from);
            }
            "--project-id" => {
                i += 1;
                project_id = args.get(i).cloned().filter(|v| !v.trim().is_empty());
            }
            "--execution-feature-id" => {
                i += 1;
                execution_feature_id = args.get(i).cloned().filter(|v| !v.trim().is_empty());
            }
            _ => {}
        }
        i += 1;
    }
    let data_dir = data_dir.ok_or("缺少 --app-data-dir 参数，无法定位应用数据目录")?;
    Ok(ToolContext { project_id, data_dir, execution_feature_id })
}

/// stdio 主循环：初始化数据库后逐行处理 JSON-RPC，直到 stdin 关闭。
pub fn run_stdio_server(args: &[String]) -> Result<(), String> {
    let ctx = parse_stdio_args(args)
        .ok_or("未提供 --app-mcp-stdio")?
        .map_err(|e| e)?;
    let db_file = ctx.data_dir.join("workbench.db");
    db::init(&db_file)?;
    {
        let guard = db::conn()?;
        if let Some(conn) = guard.as_ref() {
            // 与主应用跨进程共库：写等待，避免瞬时 busy 直接失败。
            let _ = conn.busy_timeout(std::time::Duration::from_millis(5000));
        }
    }
    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if n == 0 {
            break; // stdin EOF：正常退出
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // 单请求 panic 不结束进程：转为 JSON-RPC internal error。
        let response = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            handle_line(&ctx, trimmed)
        }))
        .unwrap_or_else(|_| {
            Some(json!({"jsonrpc": "2.0", "id": null,
                   "error": {"code": -32603, "message": "工具服务器内部错误"}}))
        });
        if let Some(resp) = response {
            writeln!(out, "{resp}").map_err(|e| e.to_string())?;
            out.flush().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 处理一行请求：通知不响应；其余返回 JSON-RPC 响应。
fn handle_line(ctx: &ToolContext, line: &str) -> Option<Value> {
    let msg: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => {
            return Some(json!({"jsonrpc": "2.0", "id": null,
                "error": {"code": -32700, "message": "请求不是合法 JSON"}}));
        }
    };
    handle_message_value(ctx, &msg)
}

pub(crate) fn handle_message_value(ctx: &ToolContext, msg: &Value) -> Option<Value> {
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    // JSON-RPC 通知（无 id）与 MCP notifications/* 一律不响应。
    let id = match msg.get("id") {
        Some(v) if !v.is_null() => v.clone(),
        _ => return None,
    };
    if method.starts_with("notifications/") {
        return None;
    }
    let respond = |result: Value| json!({"jsonrpc": "2.0", "id": id, "result": result});
    let respond_err = |code: i64, message: &str| {
        json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
    };
    match method {
        "initialize" => {
            let requested = msg
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("2024-11-05")
                .to_string();
            Some(respond(json!({
                "protocolVersion": requested,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "workbench", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "工作台内置工具：创建/查询项目、读写需求文档（Epic/Feature/Story）、知识库与授权、服务器主机配置。删除类操作不提供。",
            })))
        }
        "ping" => Some(respond(json!({}))),
        "tools/list" => match list_tools() {
            Ok(tools) => Some(respond(json!({ "tools": tools }))),
            Err(e) => Some(respond_err(-32603, &e)),
        },
        "tools/call" => {
            let name = msg.pointer("/params/name").and_then(Value::as_str).unwrap_or("");
            let args = msg.pointer("/params/arguments").cloned().unwrap_or(json!({}));
            Some(respond(call_tool(ctx, name, &args)))
        }
        other => Some(respond_err(-32601, &format!("未知方法：{other}"))),
    }
}

// ---------- 工具目录 ----------

#[derive(Clone)]
pub(crate) struct ToolDef {
    pub(crate) name: &'static str,
    /// capability 注册名（kind='tool'）
    pub(crate) registry_id: &'static str,
    pub(crate) description: &'static str,
    pub(crate) schema: Value,
    #[allow(dead_code)]
    pub(crate) risk: &'static str,
}

fn schema_obj(props: Value, required: &[&str]) -> Value {
    let mut schema = json!({ "type": "object", "properties": props, "additionalProperties": false });
    if !required.is_empty() {
        schema["required"] = json!(required);
    }
    schema
}

/// 13 个工作台业务工具 + 6 个原有内置工具（BUG-CR059-01）+ 1 个右栏请求工具（CR-054／STORY-073）。
const TOOL_COUNT: usize = 21;

pub(crate) fn workbench_tools() -> [ToolDef; TOOL_COUNT] {
    [
        ToolDef {
            name: "get_context",
            registry_id: "workbench.get_context",
            description: "获取当前会话绑定的项目上下文与项目总数。涉及『当前项目』的操作前先调用本工具。",
            schema: schema_obj(json!({}), &[]),
            risk: "low",
        },
        ToolDef {
            name: "list_projects",
            registry_id: "workbench.list_projects",
            description: "列出所有项目（id/name/kind/rootUri/图标/创建更新时间）。",
            schema: schema_obj(json!({}), &[]),
            risk: "low",
        },
        ToolDef {
            name: "create_project",
            registry_id: "workbench.create_project",
            description: "创建项目。kind 为 code（编码）或 work（办公）；rootUri 必须是已存在的可访问目录。",
            schema: schema_obj(
                json!({
                    "name": { "type": "string", "description": "项目名称（不可与现有项目重名）" },
                    "kind": { "type": "string", "enum": ["code", "work"] },
                    "rootUri": { "type": "string", "description": "项目根目录绝对路径" }
                }),
                &["name", "kind", "rootUri"],
            ),
            risk: "medium",
        },
        ToolDef {
            name: "update_project",
            registry_id: "workbench.update_project",
            description: "更新项目名称/根目录/图标。icon/iconColor 传 null 恢复默认，缺省保持不变。",
            schema: schema_obj(
                json!({
                    "projectId": { "type": "string" },
                    "name": { "type": "string" },
                    "rootUri": { "type": "string" },
                    "icon": { "type": ["string", "null"], "description": "内置图标 id 或 null" },
                    "iconColor": { "type": ["string", "null"], "description": "背景色卡 id 或 null" }
                }),
                &["projectId", "name"],
            ),
            risk: "medium",
        },
        ToolDef {
            name: "get_requirements",
            registry_id: "workbench.get_requirements",
            description: "读取项目需求树（vision→epic→feature→story/bug，含 sourceUri）。projectId 缺省用当前项目。",
            schema: schema_obj(
                json!({ "projectId": { "type": "string" } }),
                &[],
            ),
            risk: "low",
        },
        ToolDef {
            name: "read_requirement_doc",
            registry_id: "workbench.read_requirement_doc",
            description: "读取需求文档正文。优先给 entityId；给 sourceUri 时必须是该项目 docs 内的文档。",
            schema: schema_obj(
                json!({
                    "projectId": { "type": "string" },
                    "entityId": { "type": "string", "description": "如 EPIC-001 / FEAT-002 / STORY-003" },
                    "sourceUri": { "type": "string" }
                }),
                &[],
            ),
            risk: "low",
        },
        ToolDef {
            name: "write_requirement_doc",
            registry_id: "workbench.write_requirement_doc",
            description: "创建或更新需求文档。kind 决定目录（Vision/Epic/Feature/Story）；新建自动分配编号（如 EPIC-001）并生成 front matter；传 entityId 则更新原文档（保留原编号与位置）。content 为正文 Markdown，不要自带 front matter。",
            schema: schema_obj(
                json!({
                    "kind": { "type": "string", "enum": ["vision", "epic", "feature", "story", "bug"] },
                    "title": { "type": "string" },
                    "content": { "type": "string", "description": "正文 Markdown" },
                    "parentEntityId": { "type": "string", "description": "父项编号，如 FEAT-001；必须已存在" },
                    "entityId": { "type": "string", "description": "更新模式：要修改的既有编号" },
                    "status": { "type": "string", "description": "如 待确认/已确认/开发中" },
                    "owner": { "type": "string" },
                    "expectedDocumentHash": { "type": "string", "description": "更新既有需求时必填：read_requirement_doc 返回的 documentHash；不一致则拒绝覆盖" },
                    "projectId": { "type": "string" }
                }),
                &["kind", "title"],
            ),
            risk: "medium",
        },
        ToolDef {
            name: "list_kbs",
            registry_id: "workbench.list_kbs",
            description: "列出知识库及其对指定项目（缺省当前项目）的授权状态。",
            schema: schema_obj(
                json!({ "projectId": { "type": "string" } }),
                &[],
            ),
            risk: "low",
        },
        ToolDef {
            name: "create_kb",
            registry_id: "workbench.create_kb",
            description: "创建受管知识库（应用数据目录下自动建空目录）。默认授权给当前项目读取。只建库，不写知识内容。",
            schema: schema_obj(
                json!({
                    "name": { "type": "string" },
                    "grantProjectIds": { "type": "array", "items": { "type": "string" },
                        "description": "要授权的项目 id 列表；缺省=当前项目（无绑定则不授权）" }
                }),
                &["name"],
            ),
            risk: "medium",
        },
        ToolDef {
            name: "set_kb_grant",
            registry_id: "workbench.set_kb_grant",
            description: "设置项目对知识库的读取授权（readAllowed=false 为撤权）。",
            schema: schema_obj(
                json!({
                    "projectId": { "type": "string" },
                    "libraryId": { "type": "string" },
                    "readAllowed": { "type": "boolean" }
                }),
                &["projectId", "libraryId", "readAllowed"],
            ),
            risk: "medium",
        },
        ToolDef {
            name: "list_servers",
            registry_id: "workbench.list_servers",
            description: "列出服务器主机配置（名称/地址/端口/用户名/认证类型/分组；不含任何密钥）。",
            schema: schema_obj(json!({}), &[]),
            risk: "low",
        },
        ToolDef {
            name: "save_server",
            registry_id: "workbench.save_server",
            description: "新建或更新服务器主机配置。password 认证必须提供 secret；key 认证必须提供 keyPath；密钥只写入受管密钥文件，不出现在返回值。",
            schema: schema_obj(
                json!({
                    "serverId": { "type": "string", "description": "更新模式：既有主机 id" },
                    "name": { "type": "string" },
                    "host": { "type": "string" },
                    "port": { "type": "integer" },
                    "username": { "type": "string" },
                    "authType": { "type": "string", "enum": ["password", "key", "none"] },
                    "secret": { "type": "string", "description": "密码或密钥口令" },
                    "keyPath": { "type": "string", "description": "私钥文件路径" },
                    "groupTag": { "type": "string" }
                }),
                &["name", "host", "port", "username", "authType"],
            ),
            risk: "medium",
        },
        ToolDef {
            name: "generate_image",
            registry_id: "workbench.generate_image",
            description: "生成图片。按设置中生图模型的顺序尝试，第一个失败自动用下一个；返回落盘文件的真实路径。最终回复必须逐张嵌入真实路径图片，禁止虚构 URL。",
            schema: schema_obj(
                json!({
                    "prompt": { "type": "string", "description": "完整画面描述：主体、构图、风格、光照与需要出现的文字" },
                    "model": { "type": "string", "description": "可选：指定生图模型（provider/modelId 或唯一 modelId）；缺省按设置中的顺序尝试" },
                    "size": { "type": "string", "description": "如 1024x1024；缺省取设置默认" },
                    "quality": { "type": "string", "enum": ["low", "medium", "high", "auto"] },
                    "n": { "type": "integer", "description": "张数 1-4；缺省取设置默认" }
                }),
                &["prompt"],
            ),
            risk: "medium",
        },
        // CR-059 / BUG-CR059-01：原有 6 项内置工具真实注入（复用同一 workbench MCP 通道）。
        ToolDef {
            name: "fs_read",
            registry_id: "fs.read",
            description: "读取项目内文本文件（相对项目根路径，项目外路径一律拒绝）。文件超过 1 MiB 时返回 LEGACY_FILE_TOO_LARGE，需要用户改用编辑器窗口读取。",
            schema: schema_obj(
                json!({
                    "path": { "type": "string", "description": "相对项目根的路径，如 src/main.ts" },
                    "projectId": { "type": "string", "description": "缺省用会话绑定项目" }
                }),
                &["path"],
            ),
            risk: "low",
        },
        ToolDef {
            name: "knowledge_list",
            registry_id: "knowledge.list",
            description: "列出当前项目已授权且启用的知识库（未授权的库不会出现）。",
            schema: schema_obj(
                json!({ "projectId": { "type": "string" } }),
                &[],
            ),
            risk: "low",
        },
        ToolDef {
            name: "knowledge_search",
            registry_id: "knowledge.search",
            description: "在当前项目已授权知识库内做只读全文检索；传 libIds 时逐库复检授权，未授权/停用一律拒绝。",
            schema: schema_obj(
                json!({
                    "query": { "type": "string" },
                    "libIds": { "type": "array", "items": { "type": "string" }, "description": "省略＝全部已授权库" },
                    "projectId": { "type": "string" }
                }),
                &["query"],
            ),
            risk: "low",
        },
        ToolDef {
            name: "knowledge_read",
            registry_id: "knowledge.read",
            description: "读取知识库笔记正文切片（只读）。每次调用都复检项目授权与库启用状态，撤权即时生效。",
            schema: schema_obj(
                json!({
                    "libId": { "type": "string" },
                    "noteId": { "type": "string" },
                    "projectId": { "type": "string" }
                }),
                &["libId", "noteId"],
            ),
            risk: "low",
        },
        ToolDef {
            name: "knowledge_read_many",
            registry_id: "knowledge.read_many",
            description: "批量读取知识库笔记（最多 20 条）。单条失败不中断整批，逐条返回错误。",
            schema: schema_obj(
                json!({
                    "items": {
                        "type": "array",
                        "maxItems": 20,
                        "items": {
                            "type": "object",
                            "properties": {
                                "libId": { "type": "string" },
                                "noteId": { "type": "string" }
                            },
                            "required": ["libId", "noteId"],
                            "additionalProperties": false
                        }
                    },
                    "projectId": { "type": "string" }
                }),
                &["items"],
            ),
            risk: "low",
        },
        ToolDef {
            name: "ssh_exec",
            registry_id: "ssh-exec",
            description: "在已连接且已授权的服务器上执行命令。高风险命令立刻返回 {needsApproval:true, requestId}，必须在服务器工作台由用户批准后才会执行，AI 不得自行重试绕过审批。",
            schema: schema_obj(
                json!({
                    "hostId": { "type": "string" },
                    "command": { "type": "string" }
                }),
                &["hostId", "command"],
            ),
            risk: "high",
        },
        ToolDef {
            name: "ssh_exec_status",
            registry_id: "workbench.ssh_exec_status",
            description: "查询 ssh_exec 提交的高风险命令审批结论（pending/approved/rejected/expired/missing）。approved 时返回执行结果。用户需先在界面批准。",
            schema: schema_obj(
                json!({ "requestId": { "type": "string", "description": "ssh_exec 返回的 requestId" } }),
                &["requestId"],
            ),
            risk: "low",
        },
        // CR-054 / STORY-073：AI 请求打开工作台右栏（不需要人工逐次确认；用户关闭后同轮不重开）。
        ToolDef {
            name: "open_panel",
            registry_id: "workbench.open_panel",
            description: "请求工作台右栏打开一个只读预览面板。kind 必须是 file/requirement/knowledge/office-file 之一，key 为对应标识（文件用相对路径，需求用实体编号，知识用 libraryId:noteId，办公文件用 fileId）。是否真正打开、以及用户关闭后是否重开由前端规则决定；本工具不获得任何额外权限。",
            schema: schema_obj(
                json!({
                    "kind": { "type": "string", "enum": ["file", "requirement", "knowledge", "office-file"] },
                    "key": { "type": "string", "description": "文件相对路径 / 需求实体编号 / libraryId:noteId / 办公 fileId" },
                    "title": { "type": "string", "description": "面板标题（可选，缺省用 key）" }
                }),
                &["kind", "key"],
            ),
            risk: "low",
        },
    ]
}

/// 侧栏步骤中文名（UI-CR059 映射表；前端同名表对齐）。
pub const TOOL_LABELS: [(&str, &str); TOOL_COUNT] = [
    ("get_context", "工作台·当前上下文"),
    ("list_projects", "工作台·项目清单"),
    ("create_project", "工作台·创建项目"),
    ("update_project", "工作台·更新项目"),
    ("get_requirements", "工作台·需求树"),
    ("read_requirement_doc", "工作台·读需求文档"),
    ("write_requirement_doc", "工作台·写需求文档"),
    ("list_kbs", "工作台·知识库清单"),
    ("create_kb", "工作台·创建知识库"),
    ("set_kb_grant", "工作台·设置知识授权"),
    ("list_servers", "工作台·服务器清单"),
    ("save_server", "工作台·保存服务器"),
    ("generate_image", "工作台·生成图片"),
    // CR-059 / BUG-CR059-01：原有内置工具真实注入后的中文名（与注册表一致）。
    ("fs_read", "工作台·读文件"),
    ("knowledge_list", "工作台·知识清单"),
    ("knowledge_search", "工作台·知识检索"),
    ("knowledge_read", "工作台·读知识"),
    ("knowledge_read_many", "工作台·批量读知识"),
    ("ssh_exec", "工作台·服务器命令"),
    ("ssh_exec_status", "工作台·审批结论"),
    // CR-054 / STORY-073：右栏请求
    ("open_panel", "工作台·打开预览面板"),
];

pub(crate) fn tool_enabled(conn: &rusqlite::Connection, registry_id: &str) -> bool {
    conn.query_row(
        "SELECT enabled FROM capability WHERE kind='tool' AND name=?1",
        [registry_id],
        |r| r.get::<_, i64>(0),
    )
    .map(|v| v != 0)
    .unwrap_or(true)
}

fn list_tools() -> Result<Vec<Value>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut out = Vec::new();
    for def in workbench_tools() {
        if !tool_enabled(conn, def.registry_id) {
            continue;
        }
        out.push(json!({
            "name": def.name,
            "description": def.description,
            "inputSchema": def.schema,
        }));
    }
    Ok(out)
}

fn call_tool(ctx: &ToolContext, name: &str, args: &Value) -> Value {
    let def = workbench_tools().into_iter().find(|d| d.name == name);
    let Some(def) = def else {
        return tool_error(&format!("未知工具：{name}"));
    };
    let enabled = db::conn().ok().and_then(|g| {
        g.as_ref().map(|conn| tool_enabled(conn, def.registry_id))
    }).unwrap_or(false);
    if !enabled {
        return tool_error(&format!("工具 {name} 已在设置中停用"));
    }
    let payload = if args.is_object() { args } else { &Value::Null };
    match run_tool(ctx, name, payload) {
        Ok(v) => json!({ "content": [{ "type": "text", "text": v.to_string() }], "isError": false }),
        Err(e) => tool_error(&e),
    }
}

fn tool_error(message: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
}

pub(crate) fn run_tool(ctx: &ToolContext, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "get_context" => tool_get_context(ctx),
        "list_projects" => crate::commands::projects::list_projects()
            .map(|p| json!({ "projects": p })),
        "create_project" => tool_create_project(args),
        "update_project" => tool_update_project(args),
        "get_requirements" => tool_get_requirements(ctx, args),
        "read_requirement_doc" => tool_read_requirement_doc(ctx, args),
        "write_requirement_doc" => tool_write_requirement_doc(ctx, args),
        "list_kbs" => tool_list_kbs(ctx, args),
        "create_kb" => tool_create_kb(ctx, args),
        "set_kb_grant" => tool_set_kb_grant(args),
        "list_servers" => tool_list_servers(),
        "save_server" => tool_save_server(ctx, args),
        "generate_image" => tool_generate_image(ctx, args),
        // CR-059 / BUG-CR059-01：原有 6 项内置工具（复用 UI 命令同一套校验与授权路径）。
        "fs_read" => tool_fs_read(ctx, args),
        "knowledge_list" => tool_knowledge_list(ctx, args),
        "knowledge_search" => tool_knowledge_search(ctx, args),
        "knowledge_read" => tool_knowledge_read(ctx, args),
        "knowledge_read_many" => tool_knowledge_read_many(ctx, args),
        "ssh_exec" => tool_ssh_exec(args),
        "ssh_exec_status" => tool_ssh_exec_status(args),
        "open_panel" => tool_open_panel(args),
        other => Err(format!("未知工具：{other}")),
    }
}

// ---------- 参数辅助 ----------

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn req_str(args: &Value, key: &str) -> Result<String, String> {
    str_arg(args, key)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("缺少必填参数：{key}"))
}

/// JSON 三态 → Option<Option<&str>>：缺省=保持，null=清空，字符串=设置。
fn opt_opt_str<'a>(args: &'a Value, key: &str) -> Result<Option<Option<&'a str>>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(Some(None)),
        Some(Value::String(s)) => Ok(Some(Some(s.as_str()))),
        Some(_) => Err(format!("参数 {key} 必须是字符串或 null")),
    }
}

fn resolve_project_id(ctx: &ToolContext, args: &Value) -> Result<String, String> {
    if let Some(pid) = str_arg(args, "projectId").filter(|v| !v.trim().is_empty()) {
        return Ok(pid.trim().to_string());
    }
    ctx.project_id
        .clone()
        .ok_or_else(|| "会话未绑定项目且参数缺 projectId；请先调用 workbench_list_projects 获取项目 id".to_string())
}

fn project_root_uri(conn: &rusqlite::Connection, project_id: &str) -> Result<PathBuf, String> {
    let uri: String = conn
        .query_row("SELECT rootUri FROM project WHERE id=?1", [project_id], |r| r.get(0))
        .map_err(|_| format!("项目不存在：{project_id}"))?;
    let root = PathBuf::from(&uri);
    if !root.is_dir() {
        return Err(format!("项目目录不可访问：{uri}"));
    }
    Ok(root)
}

// ---------- 项目域 ----------

fn tool_get_context(ctx: &ToolContext) -> Result<Value, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM project", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    match &ctx.project_id {
        Some(pid) => {
            let (name, kind, root): (String, String, String) = conn
                .query_row("SELECT name, type, rootUri FROM project WHERE id=?1", [pid], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })
                .map_err(|_| format!("当前会话绑定的项目不存在或已删除：{pid}"))?;
            Ok(json!({ "projectId": pid, "name": name, "kind": kind, "rootUri": root, "projectsTotal": total }))
        }
        None => Ok(json!({
            "projectId": Value::Null,
            "hint": "会话未绑定项目；请先调用 workbench_list_projects，用返回的 projectId 操作指定项目，或用 workbench_create_project 新建",
            "projectsTotal": total,
        })),
    }
}

fn tool_create_project(args: &Value) -> Result<Value, String> {
    let name = req_str(args, "name")?;
    let kind = req_str(args, "kind")?;
    let root_uri = req_str(args, "rootUri")?;
    let project = crate::commands::projects::create_project(name, kind, root_uri)?;
    Ok(json!({ "projectId": project.id, "name": project.name, "kind": project.kind, "rootUri": project.root_uri }))
}

fn tool_update_project(args: &Value) -> Result<Value, String> {
    let id = req_str(args, "projectId")?;
    let name = req_str(args, "name")?;
    let root_uri = str_arg(args, "rootUri").map(|v| v.to_string());
    let icon = opt_opt_str(args, "icon")?;
    let icon_color = opt_opt_str(args, "iconColor")?;
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let project =
        crate::commands::projects::update_project_inner(conn, &id, &name, root_uri.as_deref(), icon, icon_color)?;
    Ok(json!({ "projectId": project.id, "name": project.name, "rootUri": project.root_uri }))
}

// ---------- 需求域 ----------

fn flatten_requirements<'a>(nodes: &'a [RequirementNode], out: &mut Vec<&'a RequirementNode>) {
    for n in nodes {
        out.push(n);
        flatten_requirements(&n.children, out);
    }
}

fn tool_get_requirements(ctx: &ToolContext, args: &Value) -> Result<Value, String> {
    let project_id = resolve_project_id(ctx, args)?;
    let tree = crate::commands::projects::read_requirements(project_id.clone())?;
    Ok(json!({ "projectId": project_id, "requirements": tree }))
}

fn tool_read_requirement_doc(ctx: &ToolContext, args: &Value) -> Result<Value, String> {
    let project_id = resolve_project_id(ctx, args)?;
    crate::commands::projects::read_requirements(project_id.clone())?; // 先刷新投影
    let source_uri = if let Some(entity_id) = str_arg(args, "entityId").filter(|v| !v.trim().is_empty()) {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        conn.query_row(
            "SELECT sourceUri FROM requirement_index WHERE projectId=?1 AND entityId=?2",
            rusqlite::params![project_id, entity_id.trim()],
            |r| r.get(0),
        )
        .map_err(|_| format!("需求编号不存在：{}（可先调用 workbench_get_requirements 查看清单）", entity_id.trim()))?
    } else if let Some(uri) = str_arg(args, "sourceUri").filter(|v| !v.trim().is_empty()) {
        let guard = db::conn()?;
        let root = project_root_uri(guard.as_ref().ok_or("db not initialized")?, &project_id)?;
        let doc = PathBuf::from(uri.trim());
        let doc_canon = std::fs::canonicalize(&doc).map_err(|_| format!("文档不存在：{uri}"))?;
        let root_canon = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;
        if !doc_canon.starts_with(&root_canon) {
            return Err("sourceUri 必须位于项目目录内".to_string());
        }
        doc_canon.to_string_lossy().to_string()
    } else {
        return Err("缺少 entityId 或 sourceUri 参数".to_string());
    };
    let content = crate::commands::projects::read_doc(source_uri.clone())?;
    let document_hash = crate::commands::projects::document_hash(&content);
    Ok(json!({ "sourceUri": source_uri, "content": content, "documentHash": document_hash }))
}

/// 文件名安全净化：去非法字符与首尾空白，限长（按字符截断）。
fn sanitize_filename(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.trim().chars() {
        let bad = matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            || (ch as u32) < 0x20;
        if bad {
            out.push('-');
        } else if ch.is_whitespace() {
            out.push(' ');
        } else {
            out.push(ch);
        }
    }
    let mut collapsed = String::new();
    let mut prev_dash = false;
    for ch in out.trim().chars() {
        let is_dash = ch == ' ' || ch == '-';
        if is_dash && prev_dash {
            continue;
        }
        collapsed.push(if ch == ' ' { '-' } else { ch });
        prev_dash = is_dash;
    }
    let trimmed = collapsed.trim_matches('-').to_string();
    if trimmed.chars().count() > 60 {
        trimmed.chars().take(60).collect()
    } else if trimmed.is_empty() {
        "untitled".to_string()
    } else {
        trimmed
    }
}

/// 从文件名或 front matter id 中提取 `PREFIX-数字` 的数字部分。
fn parse_entity_number(text: &str, prefix: &str) -> Option<i64> {
    let after = text.strip_prefix(prefix)?.strip_prefix('-')?;
    let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

fn kind_layout(kind: &str) -> Result<(&'static str, &'static str), String> {
    match kind {
        "vision" => Ok(("Vision", "VISION")),
        "epic" => Ok(("Epic", "EPIC")),
        "feature" => Ok(("Feature", "FEAT")),
        "story" => Ok(("Story", "STORY")),
        "bug" => Ok(("Story", "BUG")),
        other => Err(format!(
            "kind 必须是 vision/epic/feature/story/bug，当前：{other}"
        )),
    }
}

/// 扫描既有文档，分配同前缀下一个编号（3 位补零，>999 自然增长）。
fn allocate_entity_id(plan_dir: &Path, subdir: &str, prefix: &str) -> Result<String, String> {
    let mut max = 0i64;
    for dir in [plan_dir.join(subdir), plan_dir.to_path_buf()] {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for ent in rd.flatten() {
            let path = ent.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                if let Some(n) = parse_entity_number(stem, prefix) {
                    max = max.max(n);
                }
            }
            if let Ok(text) = std::fs::read_to_string(&path) {
                let fm = crate::commands::projects::parse_front_matter(&text);
                if let Some(id) = fm.get("id") {
                    if let Some(n) = parse_entity_number(id, prefix) {
                        max = max.max(n);
                    }
                }
            }
        }
    }
    let next = max + 1;
    Ok(if next >= 1000 {
        format!("{prefix}-{next}")
    } else {
        format!("{prefix}-{next:03}")
    })
}

fn compose_doc(
    id: &str,
    kind: &str,
    parent: Option<&str>,
    title: &str,
    status: &str,
    owner: Option<&str>,
    body: &str,
) -> String {
    let mut fm = String::new();
    fm.push_str("---\n");
    fm.push_str(&format!("id: {id}\n"));
    fm.push_str(&format!("type: {kind}\n"));
    if let Some(p) = parent.filter(|v| !v.trim().is_empty()) {
        fm.push_str(&format!("parent: {}\n", p.trim()));
    }
    fm.push_str(&format!("title: {}\n", title.replace('\n', " ").trim()));
    fm.push_str(&format!("status: {status}\n"));
    if let Some(o) = owner.filter(|v| !v.trim().is_empty()) {
        fm.push_str(&format!("owner: {}\n", o.trim()));
    }
    fm.push_str("---\n\n");
    let body = body.trim_start_matches('\n');
    fm.push_str(body);
    if !body.ends_with('\n') {
        fm.push('\n');
    }
    fm
}

/// 剥离旧 front matter，返回正文（用于更新模式保留原正文）。
fn strip_front_matter(text: &str) -> String {
    if let Some(rest) = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) {
        if let Some(pos) = rest.find("\n---") {
            let after = &rest[pos + 4..];
            return after.strip_prefix('\n').unwrap_or(after).to_string();
        }
    }
    text.to_string()
}

/// CR-047：判断需求实体是否位于执行 Feature 的子树内（含 Feature 自身）。
/// 父链来自 requirement_index 投影；过深或缺失按拒绝处理，不放行。
fn entity_within_feature(
    conn: &rusqlite::Connection,
    project_id: &str,
    entity_id: &str,
    feature_id: &str,
) -> Result<bool, String> {
    let mut current = Some(entity_id.trim().to_string());
    let mut depth = 0;
    while let Some(id) = current {
        if id == feature_id {
            return Ok(true);
        }
        depth += 1;
        if depth > 32 {
            return Err("需求父链过深或成环，拒绝写入".into());
        }
        let row: Option<Option<String>> = conn
            .query_row(
                "SELECT parentId FROM requirement_index WHERE projectId=?1 AND entityId=?2",
                rusqlite::params![project_id, id],
                |r| r.get(0),
            )
            .ok();
        match row {
            None => return Ok(false),
            Some(parent) => current = parent.filter(|p| !p.trim().is_empty()),
        }
    }
    Ok(false)
}

fn tool_write_requirement_doc(ctx: &ToolContext, args: &Value) -> Result<Value, String> {
    let project_id = resolve_project_id(ctx, args)?;
    let kind = req_str(args, "kind")?.to_lowercase();
    let title = req_str(args, "title")?;
    let (subdir, prefix) = kind_layout(&kind)?;
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let root = project_root_uri(conn, &project_id)?;
    drop(guard);
    // 刷新投影并校验父项 / 更新目标
    let tree = crate::commands::projects::read_requirements(project_id.clone())?;
    let mut nodes = Vec::new();
    flatten_requirements(&tree, &mut nodes);

    let plan_dir = root.join("docs").join("Plan");
    let status = str_arg(args, "status").unwrap_or("待确认").trim().to_string();
    let owner = str_arg(args, "owner").map(|v| v.trim().to_string());
    let parent_arg = str_arg(args, "parentEntityId").map(|v| v.trim().to_string()).filter(|v| !v.is_empty());

    if let Some(parent) = &parent_arg {
        if !nodes.iter().any(|n| n.entity_id == *parent) {
            let samples: Vec<String> = nodes.iter().take(8).map(|n| n.entity_id.clone()).collect();
            return Err(format!(
                "父项不存在：{parent}；可先用 workbench_get_requirements 查看可用编号（样例：{}）",
                samples.join(", ")
            ));
        }
    }

    if let Some(entity_id) = str_arg(args, "entityId").filter(|v| !v.trim().is_empty()) {
        // 更新模式：定位既有文档，保留原编号/位置
        let entity_id = entity_id.trim().to_string();
        if let Some(feature_id) = ctx.execution_feature_id.as_deref() {
            let guard = db::conn()?;
            let conn = guard.as_ref().ok_or("db not initialized")?;
            if !entity_within_feature(conn, &project_id, &entity_id, feature_id)? {
                return Err(format!(
                    "CR-047 执行范围限制：{entity_id} 不属于执行特性 {feature_id}，拒绝写入"
                ));
            }
        }
        let node = nodes
            .iter()
            .find(|n| n.entity_id == entity_id)
            .ok_or_else(|| format!("要更新的需求编号不存在：{entity_id}"))?;
        let old = crate::commands::projects::read_doc(node.source_uri.clone())?;
        // CR-032／双向同步最小安全底线：更新既有文档必须带读取时拿到的 documentHash，
        // 否则拒绝，避免用过期建议覆盖并发人工修改。
        let expected = str_arg(args, "expectedDocumentHash")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let Some(expected) = expected else {
            return Err(format!(
                "DOCUMENT_HASH_REQUIRED：更新既有需求必须提供 expectedDocumentHash（当前 {}）。请先调用 workbench_read_requirement_doc 获取 documentHash 后再提交。",
                crate::commands::projects::document_hash(&old)
            ));
        };
        let fm = crate::commands::projects::parse_front_matter(&old);
        let old_kind = fm.get("type").cloned().unwrap_or_else(|| kind.clone());
        let old_body = strip_front_matter(&old);
        let body = str_arg(args, "content").unwrap_or(old_body.trim());
        let final_title = if title.trim().is_empty() {
            fm.get("title").cloned().unwrap_or(entity_id.clone())
        } else {
            title.trim().to_string()
        };
        let content = compose_doc(
            &entity_id,
            &old_kind,
            parent_arg.as_deref().or(fm.get("parent").map(|s| s.as_str())),
            &final_title,
            &status,
            owner.as_deref().or(fm.get("owner").map(|s| s.as_str())),
            body,
        );
        crate::commands::projects::write_doc_checked(&node.source_uri, &content, &expected)?;
        crate::commands::projects::read_requirements(project_id)?; // 刷新投影
        return Ok(json!({
            "mode": "updated", "entityId": entity_id,
            "sourceUri": node.source_uri, "title": final_title,
            "documentHash": crate::commands::projects::document_hash(&content),
        }));
    }

    // 新建模式：分配编号并写文档
    // CR-047：执行会话只能在本 Feature 子树内新建需求，不能新建无父项或跨 Feature 文档。
    if let Some(feature_id) = ctx.execution_feature_id.as_deref() {
        let parent = parent_arg.as_deref().ok_or_else(|| {
            format!("CR-047 执行范围限制：执行会话不能新建无父项需求；父项必须位于 {feature_id} 子树内")
        })?;
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        if !entity_within_feature(conn, &project_id, parent, feature_id)? {
            return Err(format!(
                "CR-047 执行范围限制：父项 {parent} 不属于执行特性 {feature_id}，拒绝新建"
            ));
        }
    }
    std::fs::create_dir_all(plan_dir.join(subdir)).map_err(|e| format!("创建需求目录失败：{e}"))?;
    let entity_id = allocate_entity_id(&plan_dir, subdir, prefix)?;
    let file_name = format!("{}-{}.md", entity_id, sanitize_filename(&title));
    let source_uri = plan_dir.join(subdir).join(&file_name);
    let body = str_arg(args, "content").unwrap_or("");
    let content = compose_doc(&entity_id, &kind, parent_arg.as_deref(), title.trim(), &status, owner.as_deref(), body);
    crate::commands::projects::write_doc(source_uri.to_string_lossy().to_string(), content.clone())?;
    crate::commands::projects::read_requirements(project_id.clone())?; // 刷新投影并验证
    Ok(json!({
        "mode": "created", "entityId": entity_id,
        "sourceUri": source_uri.to_string_lossy(), "title": title.trim(),
        "documentHash": crate::commands::projects::document_hash(&content),
        "hint": "文档已进入需求树；继续为同父项添加内容时再次调用即可自动递增编号",
    }))
}

// ---------- 知识库域 ----------

fn tool_list_kbs(ctx: &ToolContext, args: &Value) -> Result<Value, String> {
    let project_id = resolve_project_id(ctx, args).ok();
    let libs = crate::commands::knowledge::kb_list()?;
    let grants: serde_json::Map<String, Value> = match &project_id {
        Some(pid) => {
            let guard = db::conn()?;
            let conn = guard.as_ref().ok_or("db not initialized")?;
            let mut stmt = conn
                .prepare("SELECT libraryId, readAllowed FROM project_library_grant WHERE projectId=?1")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([pid], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? != 0))
                })
                .map_err(|e| e.to_string())?;
            let mut map = serde_json::Map::new();
            for row in rows {
                let (id, allowed) = row.map_err(|e| e.to_string())?;
                map.insert(id, json!(allowed));
            }
            map
        }
        None => serde_json::Map::new(),
    };
    Ok(json!({ "libraries": libs, "grants": grants, "projectId": project_id }))
}

fn tool_create_kb(ctx: &ToolContext, args: &Value) -> Result<Value, String> {
    let name = req_str(args, "name")?;
    let base = ctx.data_dir.join("knowledge-managed");
    std::fs::create_dir_all(&base).map_err(|e| format!("创建受管目录失败：{e}"))?;
    let clean = sanitize_filename(&name);
    let mut dir = base.join(&clean);
    let mut n = 2;
    while dir.exists() && std::fs::read_dir(&dir).map(|d| d.count() > 0).unwrap_or(false) {
        dir = base.join(format!("{clean}-{n}"));
        n += 1;
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建知识库目录失败：{e}"))?;
    let kb_id = crate::commands::knowledge::kb_save_inner(&name, &dir.to_string_lossy())?;
    let mut granted = Vec::new();
    let explicit: Vec<String> = args
        .get("grantProjectIds")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let targets = if explicit.is_empty() { ctx.project_id.iter().cloned().collect::<Vec<_>>() } else { explicit };
    for pid in targets {
        crate::commands::knowledge::kb_grant_set(pid.clone(), kb_id.clone(), true)?;
        granted.push(pid);
    }
    Ok(json!({
        "libraryId": kb_id, "name": name.trim(),
        "sourceRef": dir.to_string_lossy(),
        "grantedProjects": granted,
        "note": "知识库已创建；知识内容写入仍由用户在界面完成（CR-045 边界）",
    }))
}

fn tool_set_kb_grant(args: &Value) -> Result<Value, String> {
    let project_id = req_str(args, "projectId")?;
    let library_id = req_str(args, "libraryId")?;
    let read_allowed = args
        .get("readAllowed")
        .and_then(Value::as_bool)
        .ok_or("缺少必填参数：readAllowed（布尔）")?;
    crate::commands::knowledge::kb_grant_set(project_id, library_id, read_allowed)?;
    Ok(json!({ "ok": true }))
}

// ---------- 服务器域 ----------

fn tool_list_servers() -> Result<Value, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut stmt = conn
        .prepare("SELECT id, name, host, port, username, authType, groupTag FROM server_host ORDER BY createdAt")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "host": r.get::<_, String>(2)?,
                "port": r.get::<_, i64>(3)?,
                "username": r.get::<_, String>(4)?,
                "authType": r.get::<_, String>(5)?,
                "groupTag": r.get::<_, Option<String>>(6)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let servers: Vec<Value> = rows.filter_map(|r| r.ok()).collect();
    Ok(json!({ "servers": servers }))
}

fn tool_save_server(ctx: &ToolContext, args: &Value) -> Result<Value, String> {
    let draft = crate::commands::servers::HostDraft {
        id: str_arg(args, "serverId").map(|v| v.trim().to_string()).filter(|v| !v.is_empty()),
        name: req_str(args, "name")?,
        host: req_str(args, "host")?,
        port: args
            .get("port")
            .and_then(Value::as_i64)
            .ok_or("缺少必填参数：port（整数）")?,
        username: req_str(args, "username")?,
        auth_type: req_str(args, "authType")?,
        secret: str_arg(args, "secret").map(|v| v.to_string()),
        key_path: str_arg(args, "keyPath").map(|v| v.to_string()),
        group_tag: str_arg(args, "groupTag").map(|v| v.trim().to_string()),
    };
    let id = crate::commands::servers::server_save_at(&ctx.data_dir, draft)?;
    Ok(json!({
        "serverId": id,
        "note": "主机配置已保存；连接、终端与远程命令执行仍需在界面按既有审批流程操作",
    }))
}

// ---------- BUG-CR059-01：原有 6 项内置工具的实现 ----------

/// fs.read：只允许读项目根之下的文本文件（沿用 fs::fs_read_file 的路径保护与 1 MiB 上限）。
fn tool_fs_read(ctx: &ToolContext, args: &Value) -> Result<Value, String> {
    let project_id = resolve_project_id(ctx, args)?;
    let rel = req_str(args, "path")?;
    let root = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        project_root_uri(conn, &project_id)?
    };
    let text = crate::commands::fs::fs_read_file(
        root.to_string_lossy().to_string(),
        rel.clone(),
    )?;
    Ok(json!({
        "projectId": project_id,
        "path": rel,
        "content": text,
    }))
}

/// knowledge.list：只列当前项目已授权且启用的库（授权语义与 AI 网关一致）。
fn tool_knowledge_list(ctx: &ToolContext, args: &Value) -> Result<Value, String> {
    let project_id = resolve_project_id(ctx, args)?;
    let libs = crate::commands::knowledge::kb_grants(Some(project_id.clone()))?;
    let allowed: Vec<Value> = libs
        .iter()
        .filter(|g| g.read_allowed)
        .map(|g| json!({ "id": g.library_id, "name": g.library_name }))
        .collect();
    Ok(json!({
        "projectId": project_id,
        "libraries": allowed,
        "note": "只列已授权且启用的知识库；未授权的库不会出现",
    }))
}

/// knowledge.search：显式 libIds 必须全部属于本项目已授权集合，否则整次拒绝。
fn tool_knowledge_search(ctx: &ToolContext, args: &Value) -> Result<Value, String> {
    let project_id = resolve_project_id(ctx, args)?;
    let query = req_str(args, "query")?;
    let authorized = crate::commands::knowledge::authorized_libraries(&project_id)?;
    let requested: Vec<String> = match args.get("libIds") {
        None | Some(Value::Null) => authorized.clone(),
        Some(Value::Array(items)) => {
            let mut out = Vec::new();
            for item in items {
                let id = item.as_str().map(str::trim).filter(|v| !v.is_empty())
                    .ok_or("libIds 必须是字符串数组")?;
                if !authorized.iter().any(|a| a == id) {
                    return Err(format!("知识库未授权或已停用，拒绝检索：{id}"));
                }
                if !out.iter().any(|v: &String| v == id) {
                    out.push(id.to_string());
                }
            }
            if out.is_empty() { authorized.clone() } else { out }
        }
        Some(_) => return Err("libIds 必须是字符串数组".into()),
    };
    if requested.is_empty() {
        return Ok(json!({ "hits": [], "note": "当前项目没有已授权的知识库", "projectId": project_id }));
    }
    let hits = crate::commands::knowledge::kb_search(requested.clone(), query)?;
    Ok(json!({ "projectId": project_id, "libraries": requested, "hits": hits }))
}

fn parse_item_list(args: &Value) -> Result<Vec<(String, String)>, String> {
    let items = args.get("items").and_then(Value::as_array)
        .ok_or("缺少 items 数组")?;
    if items.len() > 20 { return Err("单次最多读取 20 条笔记".into()); }
    let mut out = Vec::new();
    for item in items {
        let lib = item.get("libId").and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty())
            .ok_or("items 每项需要 libId")?;
        let note = item.get("noteId").and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty())
            .ok_or("items 每项需要 noteId")?;
        out.push((lib.to_string(), note.to_string()));
    }
    Ok(out)
}

/// knowledge.read：每次调用都复检授权（撤权即时生效）。
fn tool_knowledge_read(ctx: &ToolContext, args: &Value) -> Result<Value, String> {
    let project_id = resolve_project_id(ctx, args)?;
    let lib_id = req_str(args, "libId")?;
    let note_id = req_str(args, "noteId")?;
    let authorized = crate::commands::knowledge::authorized_libraries(&project_id)?;
    if !authorized.iter().any(|a| *a == lib_id) {
        return Err(format!("知识库未授权或已停用，拒绝读取：{lib_id}"));
    }
    let note = crate::commands::knowledge::kb_read(lib_id.clone(), note_id)?;
    Ok(json!({
        "projectId": project_id,
        "libraryId": lib_id,
        "note": note,
    }))
}

/// knowledge.read_many：逐条复检授权；单条失败不中断整批。
fn tool_knowledge_read_many(ctx: &ToolContext, args: &Value) -> Result<Value, String> {
    let project_id = resolve_project_id(ctx, args)?;
    let items = parse_item_list(args)?;
    let authorized = crate::commands::knowledge::authorized_libraries(&project_id)?;
    let mut notes = Vec::new();
    let mut errors = Vec::new();
    for (lib_id, note_id) in items {
        if !authorized.iter().any(|a| *a == lib_id) {
            errors.push(json!({ "libId": lib_id, "noteId": note_id, "error": "知识库未授权或已停用" }));
            continue;
        }
        match crate::commands::knowledge::kb_read(lib_id.clone(), note_id.clone()) {
            Ok(note) => notes.push(json!({ "libId": lib_id, "noteId": note_id, "note": note })),
            Err(e) => errors.push(json!({ "libId": lib_id, "noteId": note_id, "error": e })),
        }
    }
    Ok(json!({ "projectId": project_id, "notes": notes, "errors": errors }))
}

/// ssh.exec：高风险命令走**跨进程审批**——待批请求写入共享 SQLite，主应用轮询后
/// 弹出审批卡片，用户在 GUI 批准/拒绝；工具进程只读结论，绝不自己执行高风险命令。
fn tool_ssh_exec(args: &Value) -> Result<Value, String> {
    let host_id = req_str(args, "hostId")?;
    let command = req_str(args, "command")?;
    let risk = crate::commands::servers::classify_command_risk(&command);
    if risk == "high" {
        let request_id = crate::commands::servers::submit_tool_approval(&host_id, &command)?;
        return Ok(json!({
            "needsApproval": true,
            "requestId": request_id,
            "risk": "high",
            "command": command,
            "hostId": host_id,
            "note": "高风险命令未执行。审批请求已送到应用内待审批列表，请让用户在界面批准或拒绝；批准后结果会在下次审批查询中返回。AI 不得重试绕过审批。",
        }));
    }
    let output = crate::commands::servers::exec_ai_command_blocking(&host_id, &command)?;
    Ok(json!({
        "needsApproval": false,
        "exitCode": output.1,
        "output": output.0,
        "hostId": host_id,
    }))
}

/// ssh_exec_status：查询某条审批请求的结论（配合 ssh_exec 使用）。
/// 返回 pending / approved / rejected / expired / missing；approved 时附带执行结果。
fn tool_ssh_exec_status(args: &Value) -> Result<Value, String> {
    let request_id = req_str(args, "requestId")?;
    let status = crate::commands::servers::tool_approval_status(&request_id)?;
    let mut out = json!({ "requestId": request_id, "status": status });
    if status == "approved" {
        if let Some(note) = crate::commands::servers::tool_approval_note(&request_id)? {
            out["result"] = serde_json::from_str(&note).unwrap_or(Value::Null);
        }
    }
    Ok(out)
}

/// open_panel：只做「请求」与参数校验。真正的开栏、用户关闭优先与跨项目拒绝由前端
/// `panelRequest.ts` 执行；本工具不写文件、不联网、不扩授权。
fn tool_open_panel(args: &Value) -> Result<Value, String> {
    let kind = req_str(args, "kind")?;
    if !matches!(kind.as_str(), "file" | "requirement" | "knowledge" | "office-file") {
        return Err(format!("不支持的面板类型：{kind}（可选 file/requirement/knowledge/office-file）"));
    }
    let key = req_str(args, "key")?;
    let title = str_arg(args, "title").map(str::trim).filter(|v| !v.is_empty()).unwrap_or(&key);
    Ok(json!({
        "requested": true,
        "kind": kind,
        "key": key,
        "title": title,
        "note": "已提交右栏打开请求；是否真正打开、以及用户关闭后是否重开由前端规则决定，本工具不获得额外权限。",
    }))
}

// ---------- 测试 ----------

/// CR-059 G4：生图工具。总开关关闭时 run_generate 会拒绝；此处只做参数透传与结果整形。
fn tool_generate_image(ctx: &ToolContext, args: &Value) -> Result<Value, String> {
    let prompt = str_arg(args, "prompt").ok_or("缺少 prompt")?;
    let model = str_arg(args, "model");
    let size = str_arg(args, "size");
    let quality = str_arg(args, "quality");
    let n = args.get("n").and_then(Value::as_u64).map(|v| v as u32);
    let result = crate::commands::image_gen::run_generate(&ctx.data_dir, prompt, model, size, quality, n)?;
    let images: Vec<Value> = result.images.iter().map(|p| json!({ "filePath": p, "mime": "image/png" })).collect();
    let markdown: Vec<String> = result.images.iter()
        .enumerate()
        .map(|(i, p)| format!("![生成的图片 {}]({})", i + 1, p)).collect();
    let text = format!("已生成 {} 张图片（模型 {}）。请在最终回复中逐张嵌入以下真实路径，禁止虚构 URL：
{}",
        result.images.len(), result.model.clone().unwrap_or_default(), markdown.join("
"));
    Ok(json!({
        "images": images,
        "model": result.model,
        "prompt": result.prompt,
        "paramsUsed": result.params_used,
        "revisions": result.revisions,
        "attempts": result.attempts,
        "summary": text,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    /// 串行化使用全局 db::init 的测试（CONN 为进程级单例）。
    static DB_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct TestDb {
        dir: PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl TestDb {
        /// 每个测试用独立目录：Windows 下全局旧连接未释放时目录删除会静默失败，
        /// 共名会导致旧库数据泄漏到下一个测试。
        fn new(tag: &str) -> Self {
            let guard = DB_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            // 夹具目录必须直接基于规范化后的临时目录：GitHub Windows runner 的
            // %TEMP% 可能是 8.3 短名（如 RUNNER~1），SafeRoot 会把 canonicalize
            // 结果与原始路径不一致判为“路径已变化”，与产品行为无关。
            let base = std::fs::canonicalize(std::env::temp_dir())
                .unwrap_or_else(|_| std::env::temp_dir());
            let dir = base.join(format!("ai-tools-test-{}-{tag}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            db::init(&dir.join("workbench.db")).unwrap();
            let _ = db::conn().unwrap().as_ref().unwrap().busy_timeout(std::time::Duration::from_millis(5000));
            Self { dir, _guard: guard }
        }
    }

    impl Drop for TestDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn ctx(db: &TestDb, project: Option<&str>) -> ToolContext {
        ctx_exec(db, project, None)
    }

    fn ctx_exec(db: &TestDb, project: Option<&str>, feature: Option<&str>) -> ToolContext {
        ToolContext {
            project_id: project.map(|s| s.to_string()),
            data_dir: db.dir.clone(),
            execution_feature_id: feature.map(|s| s.to_string()),
        }
    }

    fn call(ctx: &ToolContext, name: &str, args: Value) -> (bool, Value) {
        let resp = call_tool(ctx, name, &args);
        let is_err = resp.get("isError").and_then(Value::as_bool).unwrap_or(true);
        let text = resp.pointer("/content/0/text").and_then(Value::as_str).unwrap_or("").to_string();
        let parsed: Value = serde_json::from_str(&text).unwrap_or(json!(text));
        (is_err, parsed)
    }

    #[test]
    fn execution_scope_blocks_cross_feature_requirement_writes() {
        let db = TestDb::new("exec-scope");
        let root = db.dir.join("exec-root");
        std::fs::create_dir_all(&root).unwrap();
        let c = ctx(&db, None);
        let (_, created) = call(&c, "create_project", json!({"name": "范围项目", "kind": "code", "rootUri": root.to_string_lossy()}));
        let pid = created.get("projectId").unwrap().as_str().unwrap().to_string();
        let cp = ctx(&db, Some(&pid));

        let (err, epic) = call(&cp, "write_requirement_doc", json!({"kind": "epic", "title": "目标"}));
        assert!(!err, "{epic}");
        let (err, feat) = call(&cp, "write_requirement_doc", json!({"kind": "feature", "title": "特性", "parentEntityId": "EPIC-001"}));
        assert!(!err, "{feat}");
        let (err, story) = call(&cp, "write_requirement_doc", json!({"kind": "story", "title": "故事", "parentEntityId": "FEAT-001"}));
        assert!(!err, "{story}");
        assert_eq!(story.get("entityId").unwrap(), "STORY-001");

        // 执行会话绑定 FEAT-001：只能写它自己的子树。
        let ep = ctx_exec(&db, Some(&pid), Some("FEAT-001"));
        let (_, before) = call(&ep, "read_requirement_doc", json!({"entityId": "STORY-001"}));
        let hash = before.get("documentHash").unwrap().as_str().unwrap().to_string();
        let (err, _) = call(&ep, "write_requirement_doc", json!({
            "kind": "story", "entityId": "STORY-001", "title": "故事（范围内）", "content": "范围内更新",
            "expectedDocumentHash": hash
        }));
        assert!(!err, "同 Feature 子树更新应允许");

        // 跨 Feature（写 Epic）必须拒绝。
        let (_, epic_doc) = call(&ep, "read_requirement_doc", json!({"entityId": "EPIC-001"}));
        let epic_hash = epic_doc.get("documentHash").unwrap().as_str().unwrap().to_string();
        let (err, msg) = call(&ep, "write_requirement_doc", json!({
            "kind": "epic", "entityId": "EPIC-001", "title": "越界", "content": "不应写入",
            "expectedDocumentHash": epic_hash
        }));
        assert!(err);
        assert!(msg.as_str().unwrap().contains("CR-047 执行范围限制"));

        // 无父项新建必须拒绝。
        let (err, msg) = call(&ep, "write_requirement_doc", json!({"kind": "epic", "title": "越界新 Epic"}));
        assert!(err);
        assert!(msg.as_str().unwrap().contains("CR-047 执行范围限制"));

        // 跨 Feature 父项新建必须拒绝。
        let (err, _) = call(&ep, "write_requirement_doc", json!({
            "kind": "story", "title": "越界故事", "parentEntityId": "EPIC-001"
        }));
        assert!(err);

        // 本 Feature 子树内新建允许。
        let (err, allowed) = call(&ep, "write_requirement_doc", json!({
            "kind": "story", "title": "范围内新故事", "parentEntityId": "FEAT-001"
        }));
        assert!(!err, "同 Feature 子树新建应允许：{allowed}");
    }

    #[test]
    fn registry_and_tool_catalog_stay_in_sync() {
        // 设置-工具页登记的 registry_id 必须与实际工具目录一一对应（防止两侧漂移）。
        let catalog: Vec<&str> = workbench_tools().iter().map(|d| d.name).collect();
        assert_eq!(catalog.len(), TOOL_COUNT);
        let registry_ids: Vec<&str> = workbench_tools().iter().map(|d| d.registry_id).collect();
        assert_eq!(registry_ids.len(), TOOL_COUNT);
        let registered: Vec<&str> = crate::commands::capabilities::BUILTIN_TOOLS
            .iter()
            .map(|(name, _, _, _)| *name)
            .collect();
        // BUG-CR059-01：6 个原有内置工具的 registry_id 不带 workbench. 前缀，其余 13 个带。
        for id in &registry_ids {
            assert!(registered.contains(id), "注册表缺少 {id}");
        }
        let workbench_prefixed = registry_ids.iter().filter(|id| id.starts_with("workbench.")).count();
        assert_eq!(workbench_prefixed + 6, TOOL_COUNT, "6 项原有内置工具应为不带 workbench. 前缀的 registry_id");
        // 中文名映射表与工具目录一致
        assert_eq!(TOOL_LABELS.len(), TOOL_COUNT);
        for (tool, label) in TOOL_LABELS.iter() {
            assert!(catalog.contains(tool), "映射表含未知工具 {tool}");
            assert!(label.starts_with("工作台·"), "显示名应带前缀：{label}");
        }
    }

    #[test]
    fn ssh_exec_high_risk_registers_cross_process_approval_and_never_executes() {
        // CR-059 二期：高风险命令不执行，但必须登记为真实可批准的跨进程待审批请求：
        // requestId 非空且能在 tool_approval 表查到 pending（主应用轮询后弹出审批卡片）。
        let db = TestDb::new("ssh-approval");
        let args = json!({ "hostId": "h1", "command": "rm -rf /tmp/x" });
        let out = tool_ssh_exec(&args).unwrap();
        assert_eq!(out.get("needsApproval").unwrap(), &Value::Bool(true));
        let request_id = out.get("requestId").and_then(Value::as_str).expect("必须返回可批准的 requestId");
        assert!(!request_id.is_empty());
        // 不能被执行：主机未连接，若真执行会报连接错误；这里必须仍是 pending。
        assert_eq!(crate::commands::servers::tool_approval_status(request_id).unwrap(), "pending");
        let guard = db::conn().unwrap();
        let (command, risk): (String, String) = guard.as_ref().unwrap()
            .query_row("SELECT command, risk FROM tool_approval WHERE id=?1", [request_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(command, "rm -rf /tmp/x");
        assert_eq!(risk, "high");
        assert!(out.get("note").and_then(Value::as_str).unwrap_or("").contains("待审批"));
    }

    /// CR-054 / STORY-073：open_panel 只做请求与参数校验，拒绝非法类型。
    #[test]
    fn open_panel_validates_kind_and_returns_request_only() {
        let ok = tool_open_panel(&json!({ "kind": "file", "key": "src/main.ts" })).unwrap();
        assert_eq!(ok.get("requested").unwrap(), &Value::Bool(true));
        assert_eq!(ok.get("kind").unwrap(), &Value::String("file".into()));
        assert_eq!(ok.get("key").unwrap(), &Value::String("src/main.ts".into()));
        // 缺省标题回落到 key。
        assert_eq!(ok.get("title").unwrap(), &Value::String("src/main.ts".into()));
        // 非法类型必须报错，不能静默当成功。
        assert!(tool_open_panel(&json!({ "kind": "shell", "key": "x" })).is_err());
        // 缺 key 必须报错。
        assert!(tool_open_panel(&json!({ "kind": "file" })).is_err());
    }

    /// CR-059 二期：审批查询对未知 requestId 返回 missing，不抛错。
    #[test]
    fn ssh_exec_status_reports_missing_request() {
        let db = TestDb::new("approval-status");
        let _ = db;
        let out = tool_ssh_exec_status(&json!({ "requestId": "no-such-request" })).unwrap();
        assert_eq!(out.get("status").unwrap(), &Value::String("missing".into()));
    }

    #[test]
    fn knowledge_items_validation_rejects_oversized_batches() {
        let many: Vec<Value> = (0..21).map(|i| json!({ "libId": "kb", "noteId": format!("n{i}") })).collect();
        let error = parse_item_list(&json!({ "items": many })).unwrap_err();
        assert!(error.contains("20"), "应提示单次上限：{error}");
        let ok = parse_item_list(&json!({ "items": [{ "libId": "kb", "noteId": "n1" }] })).unwrap();
        assert_eq!(ok, vec![("kb".to_string(), "n1".to_string())]);
    }

    #[test]
    fn parse_stdio_args_variants() {
        assert!(parse_stdio_args(&[]).is_none());
        let ok = parse_stdio_args(&[
            "--app-mcp-stdio".into(),
            "--app-data-dir".into(),
            "D:/data".into(),
            "--project-id".into(),
            "proj-1".into(),
        ]).unwrap().unwrap();
        assert_eq!(ok.data_dir, PathBuf::from("D:/data"));
        assert_eq!(ok.project_id.as_deref(), Some("proj-1"));
        let missing = parse_stdio_args(&["--app-mcp-stdio".into()]).unwrap();
        assert!(missing.is_err());
    }

    #[test]
    fn protocol_roundtrip_and_disabled_filter() {
        let db = TestDb::new("proto");
        let c = ctx(&db, None);
        // initialize 回显版本
        let init = handle_message_value(&c, &json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18" }
        })).unwrap();
        assert_eq!(init.pointer("/result/protocolVersion").unwrap(), "2025-06-18");
        assert_eq!(init.pointer("/result/serverInfo/name").unwrap(), "workbench");
        // 通知不响应
        assert!(handle_message_value(&c, &json!({
            "jsonrpc": "2.0", "method": "notifications/initialized"
        })).is_none());
        // tools/list 默认 TOOL_COUNT 个（13 工作台业务 + 6 原有内置）
        let list = handle_message_value(&c, &json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/list"
        })).unwrap();
        let tools = list.pointer("/result/tools").unwrap().as_array().unwrap();
        assert_eq!(tools.len(), TOOL_COUNT);
        assert!(tools.iter().all(|t| t.get("inputSchema").is_some()));
        // ping
        let ping = handle_message_value(&c, &json!({ "jsonrpc": "2.0", "id": 3, "method": "ping" })).unwrap();
        assert!(ping.get("result").is_some());
        // 未知方法
        let unknown = handle_message_value(&c, &json!({ "jsonrpc": "2.0", "id": 4, "method": "bogus" })).unwrap();
        assert!(unknown.get("error").is_some());
        // 非法 JSON 行
        let bad = handle_line(&c, "not-json");
        assert_eq!(bad.unwrap().pointer("/error/code").unwrap(), -32700);
        // 停用工具后 tools/list 过滤 + tools/call 拒绝
        {
            let guard = db::conn().unwrap();
            guard.as_ref().unwrap()
                .execute("INSERT OR REPLACE INTO capability (id, kind, name, risk, enabled, builtin, createdAt) VALUES ('cap-t','tool','workbench.create_project','medium',0,1,1)", [])
                .unwrap();
        }
        let list2 = handle_message_value(&c, &json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/list" })).unwrap();
        let tools2 = list2.pointer("/result/tools").unwrap().as_array().unwrap();
        assert_eq!(tools2.len(), TOOL_COUNT - 1);
        let (is_err, _) = call(&c, "create_project", json!({}));
        assert!(is_err, "停用工具调用必须 isError");
    }

    #[test]
    fn project_tools_roundtrip() {
        let db = TestDb::new("project");
        let c = ctx(&db, None);
        let root = db.dir.join("proj-root");
        std::fs::create_dir_all(&root).unwrap();
        let (err, _) = call(&c, "create_project", json!({"name": "x", "kind": "web", "rootUri": root.to_string_lossy()}));
        assert!(err, "非法 kind 必须拒绝");
        let (err, _) = call(&c, "create_project", json!({"name": " ", "kind": "code", "rootUri": root.to_string_lossy()}));
        assert!(err, "空名称必须拒绝");
        let (err, created) = call(&c, "create_project", json!({"name": "演示项目", "kind": "code", "rootUri": root.to_string_lossy()}));
        assert!(!err, "创建项目失败：{created}");
        let pid = created.get("projectId").unwrap().as_str().unwrap().to_string();
        let (err, listed) = call(&c, "list_projects", json!({}));
        assert!(!err);
        assert_eq!(listed.pointer("/projects/0/id").unwrap(), pid.as_str());
        // 重名拒绝
        let (err, _) = call(&c, "create_project", json!({"name": "演示项目", "kind": "code", "rootUri": root.to_string_lossy()}));
        assert!(err);
        // 上下文
        let c2 = ctx(&db, Some(&pid));
        let (err, context) = call(&c2, "get_context", json!({}));
        assert!(!err);
        assert_eq!(context.get("name").unwrap(), "演示项目");
        // 更新：改名 + 图标设置/清空
        let (err, updated) = call(&c, "update_project", json!({"projectId": pid, "name": "改名后", "icon": "rocket"}));
        assert!(!err, "更新项目失败：{updated}");
        assert_eq!(updated.get("name").unwrap(), "改名后");
        let (err, _) = call(&c, "update_project", json!({"projectId": pid, "name": "改名后", "icon": Value::Null}));
        assert!(!err);
        // 上下文（未绑定）提示不伪造项目
        let (err, hint) = call(&c, "get_context", json!({}));
        assert!(!err);
        assert!(hint.get("projectId").unwrap().is_null());
    }

    #[test]
    fn requirement_doc_tools_roundtrip() {
        let db = TestDb::new("requirement");
        let c = ctx(&db, None);
        let root = db.dir.join("req-root");
        std::fs::create_dir_all(&root).unwrap();
        let (_, created) = call(&c, "create_project", json!({"name": "需求项目", "kind": "code", "rootUri": root.to_string_lossy()}));
        let pid = created.get("projectId").unwrap().as_str().unwrap().to_string();
        let cp = ctx(&db, Some(&pid));

        // 父项不存在 → 拒绝
        let (err, msg) = call(&cp, "write_requirement_doc", json!({"kind": "story", "title": "孤儿故事", "parentEntityId": "FEAT-999"}));
        assert!(err);
        assert!(msg.as_str().unwrap().contains("父项不存在"));

        // 创建 Epic（无父项）→ EPIC-001
        let (err, epic) = call(&cp, "write_requirement_doc", json!({
            "kind": "epic", "title": "业务目标", "content": "## 目标\n完成闭环。", "status": "已确认"
        }));
        assert!(!err, "创建 epic 失败：{epic}");
        assert_eq!(epic.get("entityId").unwrap(), "EPIC-001");
        let epic_uri = epic.get("sourceUri").unwrap().as_str().unwrap().to_string();
        assert!(epic_uri.replace('\\', "/").contains("/docs/Plan/Epic/EPIC-001-业务目标.md"));
        let raw = std::fs::read_to_string(&epic_uri).unwrap();
        assert!(raw.starts_with("---\nid: EPIC-001\ntype: epic\ntitle: 业务目标\nstatus: 已确认"));
        assert!(!raw.contains("parent:"));
        assert!(raw.contains("## 目标"));

        // Story 挂在 Epic 下 → STORY-001，落在 Story 目录
        let (err, story) = call(&cp, "write_requirement_doc", json!({
            "kind": "story", "title": "首个故事", "parentEntityId": "EPIC-001", "content": "作为用户，我希望…"
        }));
        assert!(!err, "创建 story 失败：{story}");
        assert_eq!(story.get("entityId").unwrap(), "STORY-001");
        let story_uri = story.get("sourceUri").unwrap().as_str().unwrap().to_string();
        assert!(story_uri.replace('\\', "/").contains("/docs/Plan/Story/"));
        let raw = std::fs::read_to_string(&story_uri).unwrap();
        assert!(raw.contains("parent: EPIC-001"));

        // 编号递增
        let (err, epic2) = call(&cp, "write_requirement_doc", json!({"kind": "epic", "title": "第二个 Epic"}));
        assert!(!err);
        assert_eq!(epic2.get("entityId").unwrap(), "EPIC-002");

        // 更新模式：改标题与状态，不新建文件（必须先读 documentHash 再提交）
        let (_, before) = call(&cp, "read_requirement_doc", json!({"entityId": "STORY-001"}));
        let before_hash = before.get("documentHash").unwrap().as_str().unwrap().to_string();
        let (err, updated) = call(&cp, "write_requirement_doc", json!({
            "kind": "story", "entityId": "STORY-001", "title": "首个故事（改名）", "status": "开发中", "content": "更新后的正文",
            "expectedDocumentHash": before_hash
        }));
        assert!(!err, "更新 story 失败：{updated}");
        assert_eq!(updated.get("mode").unwrap(), "updated");
        assert_eq!(Path::new(updated.get("sourceUri").unwrap().as_str().unwrap()), Path::new(&story_uri));
        let raw = std::fs::read_to_string(&story_uri).unwrap();
        assert!(raw.contains("id: STORY-001"));
        assert!(raw.contains("parent: EPIC-001"));
        assert!(raw.contains("status: 开发中"));
        assert!(raw.contains("更新后的正文"));

        // CR-032：更新缺失 documentHash → 拒绝，磁盘不写入
        let (err, msg) = call(&cp, "write_requirement_doc", json!({
            "kind": "story", "entityId": "STORY-001", "title": "无 hash 更新", "content": "不应写入"
        }));
        assert!(err);
        assert!(msg.as_str().unwrap().contains("DOCUMENT_HASH_REQUIRED"));

        // 过期 hash → DOCUMENT_CHANGED，保留原正文
        let (err, msg) = call(&cp, "write_requirement_doc", json!({
            "kind": "story", "entityId": "STORY-001", "title": "过期更新", "content": "不应写入",
            "expectedDocumentHash": "sha256:deadbeef"
        }));
        assert!(err);
        assert!(msg.as_str().unwrap().contains("DOCUMENT_CHANGED"));
        assert!(std::fs::read_to_string(&story_uri).unwrap().contains("更新后的正文"));

        // 读回：entityId 与 sourceUri 两条路径
        let (err, doc) = call(&cp, "read_requirement_doc", json!({"entityId": "STORY-001"}));
        assert!(!err);
        assert!(doc.get("content").unwrap().as_str().unwrap().contains("更新后的正文"));
        let (err, doc2) = call(&cp, "read_requirement_doc", json!({"sourceUri": story_uri}));
        assert!(!err);
        assert!(doc2.get("content").is_some());
        // 越界读取拒绝
        let outside = db.dir.join("outside.md");
        std::fs::write(&outside, "secret").unwrap();
        let (err, _) = call(&cp, "read_requirement_doc", json!({"sourceUri": outside.to_string_lossy()}));
        assert!(err, "项目外文档必须拒绝");

        // 需求树读回
        let (err, tree) = call(&cp, "get_requirements", json!({}));
        assert!(!err);
        let arr = tree.pointer("/requirements").unwrap().as_array().unwrap();
        let epic_node = arr.iter().find(|n| n.get("entityId").unwrap() == "EPIC-001").unwrap();
        assert_eq!(epic_node.pointer("/children/0/entityId").unwrap(), "STORY-001");

        // 未绑定项目且未传 projectId → 明确报错
        let (err, _) = call(&c, "write_requirement_doc", json!({"kind": "epic", "title": "x"}));
        assert!(err);
    }

    #[test]
    fn kb_tools_roundtrip() {
        let db = TestDb::new("kb");
        let c = ctx(&db, None);
        let root = db.dir.join("kb-root");
        std::fs::create_dir_all(&root).unwrap();
        let (_, created) = call(&c, "create_project", json!({"name": "KB项目", "kind": "work", "rootUri": root.to_string_lossy()}));
        let pid = created.get("projectId").unwrap().as_str().unwrap().to_string();
        let cp = ctx(&db, Some(&pid));

        let (err, kb) = call(&cp, "create_kb", json!({"name": "产品资料库"}));
        assert!(!err, "创建知识库失败：{kb}");
        let kb_id = kb.get("libraryId").unwrap().as_str().unwrap().to_string();
        let source = kb.get("sourceRef").unwrap().as_str().unwrap().to_string();
        assert!(Path::new(&source).is_dir(), "受管目录应已创建");
        assert_eq!(kb.get("grantedProjects").unwrap().as_array().unwrap().len(), 1);

        // 授权清单
        let (err, libs) = call(&cp, "list_kbs", json!({}));
        assert!(!err);
        assert_eq!(libs.pointer("/libraries/0/id").unwrap(), kb_id.as_str());
        assert_eq!(libs.pointer("/grants").unwrap().get(&kb_id).unwrap(), &json!(true));

        // 撤权后授权表 readAllowed=0，且 AI 知识网关拒绝读取
        let (err, _) = call(&cp, "set_kb_grant", json!({"projectId": pid, "libraryId": kb_id, "readAllowed": false}));
        assert!(!err);
        let (err, libs2) = call(&cp, "list_kbs", json!({}));
        assert!(!err);
        assert_eq!(libs2.pointer("/grants").unwrap().get(&kb_id).unwrap(), &json!(false));
        let gateway = crate::commands::knowledge::gateway_list(Some(&pid)).unwrap();
        assert_eq!(gateway.pointer("/libraries").unwrap().as_array().unwrap().len(), 0, "撤权后网关不得返回该库");
        // 重新授权
        let (err, _) = call(&cp, "set_kb_grant", json!({"projectId": pid, "libraryId": kb_id, "readAllowed": true}));
        assert!(!err);
        let gateway2 = crate::commands::knowledge::gateway_list(Some(&pid)).unwrap();
        assert_eq!(gateway2.pointer("/libraries").unwrap().as_array().unwrap().len(), 1);
    }

    #[test]
    fn server_tools_roundtrip() {
        let db = TestDb::new("server");
        let c = ctx(&db, None);
        let (err, _) = call(&c, "save_server", json!({
            "name": "生产机", "host": "10.0.0.8", "port": 22, "username": "root",
            "authType": "password", "secret": "s3cret-明文", "groupTag": "生产"
        }));
        assert!(!err, "保存服务器失败");
        let (err, listed) = call(&c, "list_servers", json!({}));
        assert!(!err);
        let row = listed.pointer("/servers/0").unwrap();
        assert_eq!(row.get("host").unwrap(), "10.0.0.8");
        assert!(row.get("secret").is_none(), "清单不得含密钥");
        assert!(serde_json::to_string(row).unwrap().contains("s3cret") == false, "返回值不得含密钥明文");
        // 密钥只进受管文件
        let secrets = std::fs::read_to_string(db.dir.join("server-secrets.json")).unwrap();
        assert!(secrets.contains("s3cret-明文"));
        // 校验与 UI 同源
        let (err, _) = call(&c, "save_server", json!({
            "name": "坏端口", "host": "h", "port": 99999, "username": "u", "authType": "password", "secret": "x"
        }));
        assert!(err, "端口越界必须拒绝");
        let (err, _) = call(&c, "save_server", json!({
            "name": "缺密码", "host": "h", "port": 22, "username": "u", "authType": "password"
        }));
        assert!(err, "password 认证缺 secret 必须拒绝");
        let (err, _) = call(&c, "save_server", json!({
            "name": "坏类型", "host": "h", "port": 22, "username": "u", "authType": "agent-forward"
        }));
        assert!(err, "认证类型白名单必须拒绝");
    }

    #[test]
    fn sanitize_and_number_helpers() {
        assert_eq!(sanitize_filename("  a/b\\c:d*e?  "), "a-b-c-d-e");
        assert_eq!(sanitize_filename("多 空格  合并"), "多-空格-合并");
        assert_eq!(sanitize_filename(""), "untitled");
        assert_eq!(parse_entity_number("EPIC-012-标题", "EPIC"), Some(12));
        assert_eq!(parse_entity_number("EPIC-2", "EPIC"), Some(2));
        assert_eq!(parse_entity_number("STORY-x", "STORY"), None);
        assert_eq!(parse_entity_number("FEAT-999", "STORY"), None);
        // 大编号自然增长
        let dir = std::env::temp_dir().join(format!("ai-tools-alloc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Epic")).unwrap();
        std::fs::write(dir.join("Epic/EPIC-999-旧.md"), "---\nid: EPIC-999\ntype: epic\n---\n").unwrap();
        assert_eq!(allocate_entity_id(&dir, "Epic", "EPIC").unwrap(), "EPIC-1000");
        std::fs::write(dir.join("Epic/EPIC-007-x.md"), "").unwrap();
        assert_eq!(allocate_entity_id(&dir, "Epic", "EPIC").unwrap(), "EPIC-1000");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
