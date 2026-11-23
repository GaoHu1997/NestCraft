# LLD-CR069：平台主代理运行时实现方案

- 关联：[CR-069](../PRD/CR-069-平台主代理运行时与受管执行接入.md)／[FEAT-025](../Plan/Feature/FEAT-025-平台主代理运行时.md)／[STORY-089](../Plan/Story/STORY-089-平台主代理会话与模型调用.md)／[STORY-090](../Plan/Story/STORY-090-平台工具调用循环与自干边界.md)／[STORY-091](../Plan/Story/STORY-091-主代理派发与受管执行接入.md)。
- 数据：[DB-CR069](../DB/DB-CR069-会话运行通道与派发记录.md)。验证：[TEST-CR069](../Test/TEST-CR069-平台主代理运行时验证.md)。UI 准入：[UI-CR069](../UI/文档/UI-CR069-平台主代理会话准入.md)。
- 状态：设计定稿（本轮），**未获编码授权，正式软件未修改**。
- 本文档目标：**施工级**。每一步给出「改哪个文件、哪一行附近、写什么函数、签名是什么、怎么测」，使执行者无需自行设计。

## 0. 施工前必读：事实基线

| 事实 | 证据 | 对施工的约束 |
| --- | --- | --- |
| 项目是 Tauri 2 + Rust + React，HTTP 用 `ureq` | `src-tauri/Cargo.toml:18-35` | 不新增 HTTP 框架依赖；流式沿用 `ureq` 阻塞读 |
| 现有对话强依赖 CLI | `chat.rs:550`、`596-608` | 新增通道，不删旧通道 |
| 已有双协议 SSE 解析 | `model_probe.rs:227-352` | **复制其解析思路，不复用其函数**（见 §3.5 理由） |
| 已有 `document_hash` / `write_doc_checked` | `projects.rs:360-384` | 需求写入的并发保护直接复用 |
| `dispatch_once` 是 M0 模拟 | `execution.rs:1708-1710` | 派发只创建记录，不声称执行 |
| 工具实现集中在 `run_tool` | `ai_tools.rs:557-586` | 平台循环调用它，不重写业务逻辑 |
| 工具启停读 `capability` 表 | `ai_tools.rs:508-516` | 循环前后都要校验 |
| 现有 `MAX_PROMPT_TEXT=512KB`、`MAX_REF_TEXT=64KB` | `chat.rs:1131-1132` | 平台通道沿用同一上限 |

## 1. 变更清单（总览）

| # | 文件 | 类型 | 说明 |
| --- | --- | --- | --- |
| 1 | `src-tauri/src/db.rs` | 修改 | `session` 增加 `runner` 列 + 迁移 |
| 2 | `src-tauri/src/models.rs` | 修改 | `SessionMeta` 增加 `runner`；新增平台消息类型 |
| 3 | `src-tauri/src/commands/platform_agent.rs` | **新增** | 模型客户端、工具循环、派发工具 |
| 4 | `src-tauri/src/commands/chat.rs` | 修改 | `chat_send` 分派；`SESSION_COLUMNS` 增加列 |
| 5 | `src-tauri/src/commands/mod.rs` | 修改 | 注册新模块 |
| 6 | `src-tauri/src/lib.rs` | 修改 | 注册新命令 |
| 7 | `src/api/index.ts` | 修改 | 新命令绑定与类型 |
| 8 | `src/modules/chat/*` | 修改（需 UI 准入） | 运行通道选择与展示 |

**文件 8 因 UI 设计缺失，本次只登记，不给出实现细节。**

## 2. 步骤一：数据库与会话通道

### 2.1 `db.rs` 新增迁移函数

位置：紧跟 `migrate_session_feature_binding`（`db.rs:461-484`）之后新增函数，并在 `init` 的迁移调用序列中注册（与既有迁移同样的位置规律）。

```rust
/// CR-069：会话运行通道。旧记录默认 'cli'，行为与现状完全一致。
fn migrate_session_runner(conn: &Connection) -> Result<(), String> {
    let column_exists = {
        let mut statement = conn
            .prepare("PRAGMA table_info(session)")
            .map_err(|e| e.to_string())?;
        let found = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .any(|name| name == "runner");
        found
    };
    if !column_exists {
        conn.execute_batch(
            "ALTER TABLE session ADD COLUMN runner TEXT NOT NULL DEFAULT 'cli'
                 CHECK (runner IN ('cli','platform'));",
        )
        .map_err(|e| e.to_string())?;
    }
    conn.execute_batch(
        "UPDATE session SET runner='cli'
           WHERE runner IS NULL OR runner NOT IN ('cli','platform');
         CREATE INDEX IF NOT EXISTS idx_session_runner ON session(projectId, runner, updatedAt);",
    )
    .map_err(|e| e.to_string())
}
```

**注意**：SQLite 的 `ALTER TABLE ... ADD COLUMN` 支持 `CHECK`，但**不支持**带非常量默认值的表达式。上面用的是常量默认值 `'cli'`，符合限制。

**单测要求**（放在 `db.rs` 既有 `mod tests` 内，参考 `db.rs:695-750` 的写法）：

| 测试名 | 断言 |
| --- | --- |
| `cr069_runner_defaults_to_cli_for_old_rows` | 建旧表结构后插入一行，迁移后 `runner='cli'` |
| `cr069_runner_migration_is_idempotent` | 连续执行两次迁移不报错，数据不变 |
| `cr069_runner_rejects_unknown_value` | 直接 `UPDATE session SET runner='bogus'` 抛错（CHECK 生效） |

### 2.2 `models.rs` 增加字段

位置：`SessionMeta`（`models.rs:319-352`）。在 `pinned_at` 之后新增：

```rust
    /// CR-069：会话运行通道。'cli' 走既有 CLI 进程；'platform' 由平台主代理作答。
    #[serde(default = "default_runner")]
    pub runner: String,
```

并新增：

```rust
fn default_runner() -> String { "cli".into() }
```

**为什么用 `default = "default_runner"`**：历史前端或测试构造 `SessionMeta` 时不传该字段，`serde` 需要默认值，否则反序列化失败。

### 2.3 `chat.rs` 读取列

位置：`SESSION_COLUMNS`（`chat.rs:156-160`）。在末尾追加 `, s.runner`：

```rust
const SESSION_COLUMNS: &str = "s.id, ... s.pinnedAt, s.runner";
```

位置：`session_row`（`chat.rs:114-154`）。在 `Ok(SessionMeta { ... })` 中追加：

```rust
        runner: row.get::<_, Option<String>>(23)?.unwrap_or_else(|| "cli".into()),
```

**列下标推导**：现有最大下标是 `22`（`s.pinnedAt`，见 `chat.rs:152`），因此 `runner` 为 `23`。**必须按实际 SELECT 顺序核对，不能照抄。**

### 2.4 `chat_session_create` 支持通道

位置：`chat_session_create`（`chat.rs:307-336`）。在参数列表末尾追加：

```rust
    runner: Option<String>,
```

在 `INSERT` 语句的列名与占位符中追加 `runner`，并绑定：

```rust
let runner = match runner.as_deref() {
    None | Some("") => "cli",
    Some("cli") => "cli",
    Some("platform") => "platform",
    Some(other) => return Err(format!("未知会话运行通道：{other}")),
};
```

**关键**：默认必须是 `cli`。不得因为「平台通道是新功能」就把默认改成 `platform`——那会改变所有既有会话行为。

### 2.5 `chat_session_update` 允许切换

位置：`chat_session_update`（`chat.rs:351-408`）。

**规则**：只有在会话没有消息且未运行时才允许切换通道。

```rust
if let Some(next) = runner.as_deref() {
    if session.message_count > 0 {
        return Err("已有消息的会话不能切换运行通道；请新建会话".into());
    }
    if running.contains_key(&id) {
        return Err("会话正在运行，不能切换运行通道".into());
    }
    // 校验取值同上
}
```

**为什么这样限制**：切换通道会让上下文格式和续接语义完全不同（CLI 有原生线程引用，平台通道没有）。允许中途切换会造成「历史来自 CLI、后续由平台作答」的混合状态，无法保证一致。

## 3. 步骤二：平台模型客户端

### 3.1 新文件骨架

新建 `src-tauri/src/commands/platform_agent.rs`。文件头注释必须写清职责与禁止项：

```rust
//! CR-069：平台主代理运行时。
//!
//! 职责：用平台已配置的供应商/模型直接与模型服务对话，并在允许的工具集内循环。
//! 边界：
//! - 不管理供应商、密钥、端点（读取既有表，见 providers.rs）；
//! - 不接管 CLI 路径（chat.rs 的 chat_send 保持不变）；
//! - 不提供 shell / 文件写 / git 写 / 凭据读取能力（工具白名单硬编码）；
//! - 不修改任务状态（派发只创建记录，见 execution.rs）。
```

### 3.2 数据结构的精确定义

```rust
/// 平台会话的一轮请求上下文。
struct PlatformTurn {
    session_id: String,
    project_id: Option<String>,
    /// 供应商与端点（已校验可用）
    protocol: String,          // "openai" | "anthropic"
    base_url: String,
    api_key: String,
    model_id: String,
    effort: Option<String>,
    /// 供应商自定义请求头（对齐 providers.rs 的 headersJson）
    extra_headers: Vec<(String, String)>,
}

/// 模型返回的规范化结果。
#[derive(Default)]
struct ModelReply {
    text: String,
    thinking: String,
    tool_calls: Vec<ToolCall>,
    finish_reason: Option<String>,
    usage: Option<(i64, i64, i64)>, // (input, output, cache_read)
}

struct ToolCall {
    id: String,
    name: String,
    arguments: String, // 原始 JSON 字符串
}

/// 对话消息（含工具角色）。
enum ChatMsg {
    System(String),
    User(String),
    Assistant { text: String, tool_calls: Vec<ToolCall> },
    Tool { call_id: String, content: String, is_error: bool },
}
```

**为什么自定义 `ChatMsg` 而不复用 `probe` 的 `(&str, &str)`**：`model_probe.rs:358-409` 的 `build_body` 只接受纯文本对，**无法表达 assistant 的 `tool_calls` 与 `tool` 角色消息**。工具循环必须支持这两种消息，因此需要独立类型。

### 3.3 凭证解析

复用平台既有来源，不自行读环境变量：

1. 从 `provider` 表读 `name/protocol/disabled/headersJson`。
2. 从 `provider_endpoint` 读匹配协议的启用端点，取 `baseUrl`。
3. 从 `provider_key` 读启用密钥，取 `secretRef`。
4. 用 `dispatch.rs:75-81` 同款逻辑从 `secrets.json` 读明文。

**施工要求**：把 `dispatch.rs:75-81` 的 `read_secret` 提为 `pub(crate)`，或在新文件中复制同样实现并注明「与 dispatch.rs:75-81 行为一致」。**推荐提取**，避免两处漂移。

```rust
// dispatch.rs:75-81 改为
pub(crate) fn read_secret(app: &tauri::AppHandle, key_id: &str) -> Option<String> { ... }
```

### 3.4 请求 URL 构造

**必须独立实现**，不能直接复用 `model_probe.rs:1996-2023` 的 `chat_url`，因为它是 `fn`（私有）且语义为「探针地址」。复制同一规则并改名为 `platform_chat_url`：

| 协议 | 端点已以 `/v1` 结尾 | 其他情况 |
| --- | --- | --- |
| anthropic | `<base>/messages` | `<base>/v1/messages` |
| openai | `<base>/chat/completions` | `<base>/v1/chat/completions` |

**同时必须做与 `model_probe.rs:1997-2006` 相同的 URL 校验**：只允许 `http`/`https`、必须有 host、不得含用户名密码查询片段。

### 3.5 请求体构造

```rust
fn build_platform_body(
    protocol: &str,
    model_id: &str,
    effort: Option<&str>,
    effort_map: &crate::models::EffortMap,
    messages: &[ChatMsg],
    tools: &[crate::commands::ai_tools::ToolDef],
    stream: bool,
) -> Result<serde_json::Value, String>
```

**Anthropic 分支**：

```json
{
  "model": "...",
  "max_tokens": 4096,
  "stream": true,
  "system": "<第一条 System 消息>",
  "messages": [ {"role":"user","content":[{"type":"text","text":"..."}]}, ... ],
  "tools": [ {"name":"...","description":"...","input_schema":{...}} ]
}
```

- `system` 单独字段，**不能**作为 `messages` 里的 `system` 角色（Anthropic 会报错）。
- assistant 的 tool_use 表示为 `{"role":"assistant","content":[{"type":"tool_use","id":"...","name":"...","input":{...}}]}`。
- 工具结果表示为 `{"role":"user","content":[{"type":"tool_result","tool_use_id":"...","content":"..."}]}`。

**OpenAI 分支**：

```json
{
  "model": "...",
  "stream": true,
  "stream_options": {"include_usage": true},
  "messages": [ {"role":"system","content":"..."}, {"role":"user","content":"..."} ],
  "tools": [ {"type":"function","function":{"name":"...","description":"...","parameters":{...}}} ]
}
```

- assistant 的 tool_calls 表示为 `{"role":"assistant","content":null,"tool_calls":[{"id":"...","type":"function","function":{"name":"...","arguments":"<json string>"}}]}`。
- 工具结果表示为 `{"role":"tool","tool_call_id":"...","content":"..."}`。
- `max_tokens` 字段名：推理模型用 `max_completion_tokens`，其他用 `max_tokens`。**判定复用** `model_probe.rs:412-422` 的 `is_reasoning_model`（需改为 `pub(crate)`）。

**思考档位映射**：

`EffortMap` 是 `BTreeMap<String, Option<String>>`（`models.rs:197-198`），语义为「档位名 → 实际下发拼写，`None` 表示不下发」。施工：

```rust
fn apply_effort(body: &mut serde_json::Value, protocol: &str, effort: Option<&str>, map: &EffortMap) -> Result<(), String> {
    let Some(level) = effort.filter(|s| !s.trim().is_empty()) else { return Ok(()) };
    match map.get(level) {
        None => Err(format!("模型未声明思考档位 {level}")),
        Some(None) => Ok(()),                    // 该档不下发参数
        Some(Some(wire)) => {
            if protocol == "anthropic" {
                body["thinking"] = serde_json::json!({"type":"enabled","budget_tokens": budget_of(level)});
            } else {
                body["reasoning_effort"] = serde_json::json!(wire);
            }
            Ok(())
        }
    }
}
```

`budget_of` 参考 `chat.rs:17-26` 的 `claude_thinking_budget` 分档；**若该函数不足以覆盖新档位，需在此明确新增映射而不是隐式回退**。

### 3.6 流式读取

参照 `model_probe.rs:227-268` 的读取骨架（`BufReader` 逐行 + `take(MAX_STREAM_BYTES)`），但**解析目标不同**：

| 文件 | 目的 | 是否可复用 |
| --- | --- | --- |
| `model_probe.rs:270-308` | 统计帧类型与「假 TTFT」 | **否**，它不解析 tool_calls |
| `model_probe.rs:310-343` | 统计 Anthropic 增量 | **否**，同上 |

必须新写解析器，处理：

**OpenAI 流**：
- `data: {"choices":[{"delta":{"content":"..."}}]}` → 文本增量
- `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"...","function":{"name":"...","arguments":"partial"}}]}}]}` → **按 `index` 累积拼接** arguments（这是最容易做错的地方：arguments 是逐段字符串，必须拼完再 `serde_json::from_str`）
- `data: {"usage":{...}}` → 用量
- `data: [DONE]` → 结束

**Anthropic 流**：
- `content_block_start`（`type=tool_use`）→ 新建 tool call，记 `index→(id,name)`
- `content_block_delta`（`type=input_json_delta`）→ 按 `index` 累积 `partial_json`
- `content_block_delta`（`type=text_delta`）→ 文本增量
- `message_delta` → `stop_reason` 与 `usage.output_tokens`
- `ping` → 忽略

**统一的硬性要求**：

1. 每次收到文本增量，立即 `channel.send(ChatEvent::Delta)`，不能缓冲到结束。
2. `MAX_STREAM_BYTES` 必须有上限（参考 `model_probe.rs` 已有常量），防超大响应。
3. 解析失败的行**跳过并计数**，超过阈值（建议 20 行）判为协议不兼容并报错，不静默产出空回复。

### 3.7 非流式兜底

当 `stream=false`（例如模型不支持流式）时使用 `send_json` 同款结构，直接解析完整 JSON。**是否降级到非流式必须显式判定，不能因流式失败自动静默切换**——否则用户会看到「卡很久后突然整段出现」。

## 4. 步骤三：发送分派

### 4.1 分派位置

**不要修改 `chat_send` 内部逻辑**（`chat.rs:541-784`）。在 `chat_send` 函数体最前面（`chat.rs:546` 之后、`reserve_turn` 之前或之后均可，但必须在任何 CLI 相关校验之前）插入分派：

```rust
pub async fn chat_send(
    app: tauri::AppHandle,
    payload: SendPayload,
    channel: tauri::ipc::Channel<serde_json::Value>,
) -> Result<(), String> {
    // CR-069：平台通道分流。必须在任何 CLI 校验之前判定。
    let runner = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        conn.query_row("SELECT runner FROM session WHERE id=?1", [&payload.session_id], |r| {
            r.get::<_, Option<String>>(0)
        })
        .map_err(|_| "会话不存在".to_string())?
        .unwrap_or_else(|| "cli".into())
    };
    if runner == "platform" {
        return crate::commands::platform_agent::send_platform(app, payload, channel).await;
    }
    // ... 以下为既有 CLI 实现，一行不改
}
```

**为什么用 `query_row` 而不是复用 `chat_session_get`**：`chat_session_get` 会走完整的 `SESSION_COLUMNS`（含子查询），在热路径上多一次关联查询。但**如果可读性优先，可以用 `chat_session_get`**——这是可接受的取舍，需在实现时在注释中说明选择理由。

### 4.2 平台发送的函数签名

```rust
pub async fn send_platform(
    app: tauri::AppHandle,
    payload: crate::models::SendPayload,
    channel: tauri::ipc::Channel<serde_json::Value>,
) -> Result<(), String>
```

内部步骤（**顺序不可调换**，因为失败必须发生在持久化用户消息之前，保留草稿）：

1. `reserve_turn(&payload.session_id)` —— **必须复用** `chat.rs:48-57` 的互斥，否则可与 CLI 轮次并发写同一会话。需将该函数改为 `pub(crate)`。
2. 读取会话，取 `provider_id` / `model_id` / `effort` / `project_id` / `feature_id` / `session_role`。
3. 校验供应商可用（§3.3）。失败即返回，不落库。
4. 校验模型属于该供应商且 `text=true`、`non image_gen`（对齐 `providers.rs:456`）。
5. 编译上下文：**调用 `build_prompt(&app, &payload, project_id)`**（`chat.rs:1185-1293`）。该函数是私有 `fn`，需改为 `pub(crate)`。
6. 组装 `Vec<ChatMsg>`：system（平台主代理提示）+ 历史（从 `message` 表读 assistant/user 文本）+ 本轮 user（即 build_prompt 结果）。
7. 持久化 user 消息（对齐 `chat.rs:684-703` 的写法）。
8. 进入工具循环（§5）。
9. 结束：落库助手与工具消息，`channel.send(Done)`，释放 `reserve_turn`。

**注意**：第 7 步必须在所有校验通过之后。这与既有代码注释「所有启动校验均在持久化用户消息之前完成，失败保留前端草稿」（`chat.rs:614`）一致。

### 4.3 上下文注入的复用边界

**必须复用** `build_prompt`，因为它已经处理：

- 知识库启用与授权复检（`chat.rs:1210-1233`）
- Skill 停用校验与正文读取（`chat.rs:1234-1257`）
- 文件引用路径与知识授权旁路检查（`chat.rs:1150-1173`）
- 办公快照的项目归属校验（`chat.rs:1138-1148`）
- 总量上限（`chat.rs:1176-1181`）

**绝不能在新通道里另写一套**。若 `build_prompt` 的签名需要调整，只能加参数不能改语义。

### 4.4 系统提示

平台主代理的系统提示必须包含（**放在 `platform_agent.rs` 顶部常量**，不放数据库，不进设置页）：

```rust
const PLATFORM_SYSTEM_PROMPT: &str = "\
你是本工作台的主代理。你可以查询项目与需求、读取已授权知识与项目文件、在允许范围内修改需求元数据、请求打开预览面板，以及派发工作给受管执行。

你必须遵守：
1. 只使用提供的工具；没有提供的工具即表示你不能做那件事。
2. 需要写代码、执行命令、操作 git、删除文件、修改权限或处理凭据时，不要尝试绕过；应说明需要派发或请用户操作。
3. 不要在工具参数中猜测对象编号；不确定时先查询。
4. 派发成功不代表工作完成；不要声称已完成、已验证或已通过。
5. 回答用户时使用简体中文。";
```

**明确不做的事**：不写「如果任务简单就自己处理」这类判断规则。是否派发由模型结合可用工具自行决定，而**边界由工具集强制**。

## 5. 步骤四：工具循环

### 5.1 白名单常量

放在 `platform_agent.rs`：

```rust
/// CR-069：平台主代理可见工具。此清单是唯一来源；模型无法扩展。
const PLATFORM_TOOL_ALLOWLIST: [&str; 14] = [
    "get_context",
    "list_projects",
    "get_requirements",
    "read_requirement_doc",
    "write_requirement_doc",
    "list_kbs",
    "knowledge_list",
    "knowledge_search",
    "knowledge_read",
    "knowledge_read_many",
    "fs_read",
    "list_servers",
    "open_panel",
    "dispatch_work",
];
```

**注意**：`dispatch_work` 在 STORY-091 确认前**不应**加入。首版实现时该常量应为 13 项，`dispatch_work` 随 STORY-091 一起灰度。

### 5.2 生成模型可见工具定义

复用 `ai_tools.rs:192-506` 的 `workbench_tools()`，过滤：

```rust
fn platform_tool_defs(conn: &rusqlite::Connection) -> Vec<&'static ToolDef> {
    workbench_tools()
        .iter()
        .filter(|d| PLATFORM_TOOL_ALLOWLIST.contains(&d.name))
        .filter(|d| tool_enabled(conn, d.registry_id))   // ai_tools.rs:508-516
        .collect()
}
```

**为什么用 `'static`**：`workbench_tools()` 返回 `[ToolDef; TOOL_COUNT]`（值数组），`iter()` 借用临时值。施工时必须改为：

```rust
fn platform_tool_defs(conn: &rusqlite::Connection) -> Vec<ToolDef> {
    workbench_tools()
        .into_iter()
        .filter(|d| PLATFORM_TOOL_ALLOWLIST.contains(&d.name.as_str()))
        .filter(|d| tool_enabled(conn, &d.registry_id))
        .collect()
}
```

`ToolDef` 需 `#[derive(Clone)]` 或直接 move。**必须核对 `ToolDef` 是否已实现 `Clone`**（`ai_tools.rs:171-179`），没有则加派生。

### 5.3 循环主体

```rust
const MAX_TOOL_ROUNDS: usize = 8;
const MAX_TOOL_CALLS_PER_ROUND: usize = 8;
const MAX_TOOL_CALLS_TOTAL: usize = 24;

async fn run_tool_loop(
    app: &tauri::AppHandle,
    turn: &PlatformTurn,
    ctx: &ToolContext,
    mut messages: Vec<ChatMsg>,
    channel: &tauri::ipc::Channel<serde_json::Value>,
    abort: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<ModelReply, String> {
    let mut rounds = 0usize;
    let mut total_calls = 0usize;
    let mut executed: std::collections::HashSet<String> = Default::default(); // 副作用幂等

    loop {
        if *abort.borrow() { return Err("已停止".into()); }
        rounds += 1;
        let defs = { /* 每轮重新读 capability，见 5.4 */ };
        let reply = request_model(turn, &messages, &defs, channel, abort).await?;

        if reply.tool_calls.is_empty() {
            return Ok(reply);
        }
        if rounds >= MAX_TOOL_ROUNDS {
            return Err(format!("工具轮次已达上限 {MAX_TOOL_ROUNDS}；本轮未完成"));
        }
        if reply.tool_calls.len() > MAX_TOOL_CALLS_PER_ROUND {
            return Err(format!("单轮工具调用超过 {MAX_TOOL_CALLS_PER_ROUND} 个"));
        }
        total_calls += reply.tool_calls.len();
        if total_calls > MAX_TOOL_CALLS_TOTAL {
            return Err(format!("累计工具调用超过 {MAX_TOOL_CALLS_TOTAL} 次"));
        }

        messages.push(ChatMsg::Assistant {
            text: reply.text.clone(),
            tool_calls: reply.tool_calls.clone(),
        });

        for call in &reply.tool_calls {
            // 双重校验：白名单 + 启停（即使上一轮已在清单内，这里再查一次）
            let allowed = PLATFORM_TOOL_ALLOWLIST.contains(&call.name.as_str());
            let enabled = allowed && {
                let guard = db::conn()?;
                let conn = guard.as_ref().ok_or("db not initialized")?;
                workbench_tools()
                    .into_iter()
                    .find(|d| d.name == call.name)
                    .map(|d| tool_enabled(conn, &d.registry_id))
                    .unwrap_or(false)
            };
            if !allowed || !enabled {
                messages.push(ChatMsg::Tool {
                    call_id: call.id.clone(),
                    content: format!("工具 {} 不可用（未在允许清单或已停用）", call.name),
                    is_error: true,
                });
                continue;
            }

            // 副作用幂等：同一轮同一工具同一参数只执行一次
            let key = format!("{}:{}:{}", rounds, call.name, call.arguments);
            if is_side_effect_tool(&call.name) && !executed.insert(key) {
                messages.push(ChatMsg::Tool {
                    call_id: call.id.clone(),
                    content: "相同调用已执行过，未重复执行；如需继续请改变参数或确认结果".into(),
                    is_error: true,
                });
                continue;
            }

            let result = execute_tool_safely(ctx, &call);
            messages.push(ChatMsg::Tool {
                call_id: call.id.clone(),
                content: result.content,
                is_error: result.is_error,
            });
        }
    }
}
```

### 5.4 每轮重新读取工具清单的理由

`capability` 表可能在会话进行中被用户修改（设置页停用某工具）。**只在开头读一次会让整个会话继续使用已停用工具**，直到下一轮消息。每轮重读并重校验，使停用立即生效（对齐 AC-STORY-090-03）。

**性能**：每轮一次 SQLite 查询，代价可接受；若后续需要优化，可加带失效的缓存，但**不得牺牲「停用即时生效」**。

### 5.5 安全执行封装

```rust
struct ToolOutcome {
    content: String,
    is_error: bool,
}

fn execute_tool_safely(ctx: &ToolContext, call: &ToolCall) -> ToolOutcome {
    let args: serde_json::Value = match serde_json::from_str(&call.arguments) {
        Ok(v) => v,
        Err(e) => return ToolOutcome { content: format!("参数不是有效 JSON：{e}"), is_error: true },
    };
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        crate::commands::ai_tools::run_tool(ctx, &call.name, &args)
    })) {
        Ok(Ok(value)) => ToolOutcome { content: value.to_string(), is_error: false },
        Ok(Err(e)) => ToolOutcome { content: e, is_error: true },
        Err(_) => ToolOutcome { content: "工具执行异常终止".into(), is_error: true },
    }
}
```

**施工注意**：

1. `run_tool` 是私有 `fn`（`ai_tools.rs:557`），需改为 `pub(crate) fn`。
2. `catch_unwind` 不能捕获跨线程 panic；工具是同步调用，可捕获。若未来引入异步工具，需改用 `JoinHandle` 并处理 abort。
3. **不要**在这里做参数校验的第二套实现——校验在各工具实现内（例如 `write_requirement_doc` 的 `expectedDocumentHash`）。

### 5.6 副作用工具的判定

```rust
fn is_side_effect_tool(name: &str) -> bool {
    matches!(name,
        "write_requirement_doc" | "create_project" | "update_project" |
        "create_kb" | "set_kb_grant" | "save_server" | "generate_image" |
        "dispatch_work")
}
```

**只读工具**（`get_*`、`list_*`、`read_*`、`knowledge_*`、`fs_read`、`open_panel`）不去重，因为重复读取无害，且模型可能需要多读几次。

## 6. 步骤五：派发工具

### 6.1 工具定义

在 `ai_tools.rs` 的 `workbench_tools()` 中新增（**注意会改变 `TOOL_COUNT`，需同步更新 `ai_tools.rs:190`**）：

```rust
ToolDef {
    name: "dispatch_work",
    registry_id: "workbench.dispatch_work",
    description: "把编码类工作派发给受管执行。只创建批次与任务，不启动执行、不推进状态、不代表完成。返回 batchId 与 taskIds。",
    schema: schema_obj(
        json!({
            "projectId": { "type": "string" },
            "featureId": { "type": "string", "description": "目标特性；执行会话必须与绑定一致" },
            "storyIds": { "type": "array", "items": {"type": "string"}, "minItems": 1 },
            "baselineHash": { "type": "string" },
            "idempotencyKey": { "type": "string" },
            "requestDigest": { "type": "string" },
            "dependencies": { "type": "array", "items": {
                "type": "object",
                "properties": {
                    "successorStoryId": {"type": "string"},
                    "predecessorStoryId": {"type": "string"},
                    "requiredArtifactKey": {"type": "string"}
                },
                "required": ["successorStoryId","predecessorStoryId","requiredArtifactKey"]
            }}
        }),
        &["projectId", "storyIds", "baselineHash", "idempotencyKey", "requestDigest"],
    ),
    risk: "medium",
},
```

同时在 `ai_tools.rs:482-506` 的 `TOOL_LABELS` 中加入 `("dispatch_work", "工作台·派发工作")`，以及 `capabilities.rs:390-416` 的 `BUILTIN_TOOLS` 中加入对应行。

**三处必须一致**：`workbench_tools()` 名称、`TOOL_LABELS`、`BUILTIN_TOOLS`。既有单测 `ai_tools.rs:1276-1290` 会校验数量一致，改错会直接失败——**这是有用的护栏，不要改测试去迁就错误**。

### 6.2 实现

```rust
fn tool_dispatch_work(ctx: &ToolContext, args: &Value) -> Result<Value, String> {
    let project_id = resolve_project_id(ctx, args)?;
    let story_ids: Vec<String> = args.get("storyIds")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .ok_or("storyIds 必须是字符串数组")?;
    if story_ids.is_empty() { return Err("至少需要一个 Story".into()); }

    let baseline_hash = req_str(args, "baselineHash")?;
    let idempotency_key = req_str(args, "idempotencyKey")?;
    let request_digest = req_str(args, "requestDigest")?;
    let feature_id = str_arg(args, "featureId").map(str::to_string);

    // 执行会话边界：必须与绑定 Feature 一致（对齐 ai_tools.rs:916-924 的思路）
    if let Some(bound) = ctx.execution_feature_id.as_deref() {
        match feature_id.as_deref() {
            Some(given) if given == bound => {}
            Some(given) => return Err(format!("派发特性 {given} 与执行会话绑定 {bound} 不一致")),
            None => return Err(format!("执行会话派发必须指定 featureId={bound}")),
        }
    }

    // Story 存在性与类型校验（复用 read_requirements）
    let tree = crate::commands::projects::read_requirements(project_id.clone())?;
    let mut nodes = Vec::new();
    flatten_requirements(&tree, &mut nodes);
    for id in &story_ids {
        let node = nodes.iter().find(|n| &n.entity_id == id)
            .ok_or_else(|| format!("Story {id} 不存在于项目 {project_id}"))?;
        if node.kind != "story" && node.kind != "bug" {
            return Err(format!("{id} 的类型是 {}，不是 story/bug", node.kind));
        }
    }

    // 依赖边解析
    let dependencies = args.get("dependencies").and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|d| {
            Some(DependencyInput {
                successor_story_id: d.get("successorStoryId")?.as_str()?.to_string(),
                predecessor_story_id: d.get("predecessorStoryId")?.as_str()?.to_string(),
                required_artifact_key: d.get("requiredArtifactKey")?.as_str()?.to_string(),
            })
        }).collect())
        .unwrap_or_default();

    let input = CreateBatchInput {
        project_id: project_id.clone(),
        scope_kind: if story_ids.len() == 1 { "story".into() } else { "feature".into() },
        story_ids,
        feature_id,
        baseline_hash,
        idempotency_key,
        request_digest,
        dependencies,
    };

    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let batch = crate::commands::execution::create_batch(conn, &input)?;

    Ok(json!({
        "accepted": true,
        "batchId": batch.id,
        "taskIds": batch.tasks.iter().map(|t| t.id.clone()).collect::<Vec<_>>(),
        "taskStatuses": batch.tasks.iter().map(|t| (t.id.clone(), t.status.clone())).collect::<Vec<_>>(),
        "note": "已受管接纳，尚未执行。任务当前为 queued；执行与验收另行进行。",
    }))
}
```

**关键点**：

1. **不调用** `claim_task` / `transition_task` / `authorize_plan`。
2. 返回内容必须包含 `accepted` 与 `note`，明确不是完成。
3. `scope_kind` 取值必须在 `execution.rs:607-617` 的 `validate_scope_kind` 允许范围内——**施工前必须核对该函数接受的字符串**，不要凭猜。

### 6.3 注册到 `run_tool`

在 `ai_tools.rs:557-586` 的 `run_tool` 中追加分支：

```rust
"dispatch_work" => tool_dispatch_work(ctx, args),
```

## 7. 前端接入（需 UI 准入）

### 7.1 允许的改动

仅当 UI 设计补齐并登记后：

1. `src/api/index.ts`：`chatSessionCreate` 增加可选 `runner`；新增类型字段。
2. `src/modules/chat/ChatPanel.tsx`：`createSession`（`ChatPanel.tsx:361-391`）传递 `runner`。
3. 会话配置浮层：展示与切换运行通道。

### 7.2 必须避免的改动

- **不要改** `ChatPanel.tsx:823` 的 CLI 校验逻辑使其对平台会话放行——那会让平台会话误走 CLI 校验。正确做法是在发送前按 `meta.runner` 分流，或在 `startSend` 开头判断。

```tsx
// 期望形态（仅示意，需设计准入后实现）
if (meta.runner === "platform") {
  // 只校验平台模型可用性，不校验 cliId
} else {
  if (!meta.cliId || !cliCands.some(c => c.id === meta.cliId)) { /* 现有逻辑 */ }
}
```

### 7.3 设计缺失的后果

**当前 `docs/UI/仿真原型UI.html` 与 `docs/UI/文档/` 中没有任何「运行通道」设计。** 按项目规则 §6.3.1，受影响界面不得开发。因此本次交付**只做后端**，前端改动进入阻塞清单。

## 8. 实施顺序（供执行者按序施工）

| 序 | 内容 | 依赖 | 可独立验证 |
| --- | --- | --- | --- |
| 1 | `db.rs` 迁移 + `models.rs` 字段 + `SESSION_COLUMNS` | 无 | 单测：3 个迁移测试 |
| 2 | `platform_agent.rs` 骨架 + URL 与请求体构造 | 1 | 单测：双协议请求体快照 |
| 3 | 流式解析器（OpenAI + Anthropic） | 2 | 单测：喂固定 SSE 行序列，断言文本与 tool_calls |
| 4 | `send_platform` 非工具单轮 | 1-3 | 集成：mock 端点返回固定响应 |
| 5 | 工具循环 + 白名单 + 上限 | 4 | 单测：白名单外调用被拒、超限终止、幂等 |
| 6 | `dispatch_work` 工具 | 5 | 单测：幂等键、跨 Feature 拒绝、环拒绝 |
| 7 | 前端接入 | 6 + **UI 设计** | 阻塞中 |

**每一步都必须能单独通过测试再进入下一步**，不允许「一起写完再调」。

## 9. 风险与对策

| 风险 | 后果 | 对策 |
| --- | --- | --- |
| OpenAI `arguments` 分段拼接错误 | 工具收到非法 JSON，全部失败 | 按 `index` 累积到 `finish_reason` 再解析；单测覆盖多段拼接 |
| Anthropic 把 system 放进 messages | 请求 400 | 强制 system 独立字段；单测断言 |
| 工具白名单被误加 | 越权执行 | 白名单为常量；review 时逐项核对；禁止从配置读取白名单 |
| 循环无上限 | 无限调用烧钱 | 三重上限（轮次/单轮/累计） |
| 停用工具仍可调用 | 设置失效 | 每轮重读 capability |
| 平台通道与 CLI 通道并发写同会话 | 消息错乱 | 复用 `reserve_turn` 互斥 |
| 派发被误解为完成 | 用户以为工作已完成 | 返回文案强制区分；`note` 字段 |
| 迁移默认值写成 `platform` | 所有既有会话行为改变 | 单测锁定旧行为为 `cli` |

## 10. 未决项

1. `MAX_TOOL_ROUNDS=8` / `MAX_TOOL_CALLS_TOTAL=24` 是否合适——需真实使用数据。
2. 平台会话是否需要独立的上下文压缩策略（CLI 侧由 CLI 自己管理；平台侧目前无压缩，长会话可能超限）。
3. 是否需要把 `model_probe.rs` 的解析能力重构为共享模块，而不是复制——**本次选择复制**，理由是探针语义（统计假 TTFT）与对话语义（需要 tool_calls）不同，强行共用会互相污染。此项应在实现后评估是否值得重构。
4. `dispatch_work` 的默认 `max_tasks` 与是否允许一次多 Story。

## 11. 变更记录

| 日期 | 变更 | 依据 |
| --- | --- | --- |
| 2026-11-23 | 建立；施工级细化到文件与行号 | 用户要求「参考哪个文件哪行代码都写清楚」 |
