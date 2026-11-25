# LLD-FEAT-026：个人记忆层实现方案（CR-092）

- 归属 [FEAT-026](../Plan/Feature/FEAT-026-个人记忆层.md)；关联 [CR-092](../PRD/CR-092-个人记忆层与默认记忆库.md)／[DB-FEAT-026](../DB/DB-FEAT-026-个人记忆数据设计.md)／[UI-FEAT-026](../UI/文档/UI-FEAT-026-记忆管理界面.md)。状态：开发中。

## 1. 现状与复用点（实读）

- 对话原文：`message(id,sessionId,role,content,metaJson,refsJson,createdAt)`、`session(projectId,runner)`。
- 摘要：`session_context_block`/`session_context_turn`（CR-071）。
- 知识库：`knowledge_library`/`knowledge_note_index`/`kb_link`/`kb_embed`；检索 FTS5+本地语义 RRF（CR-089）；工具 `kb_tools.rs` 的授权/预算/审计范式。
- 工具注册：`ai_tools.rs` `workbench_tools()`（含 `ToolDef{name,registry_id,description,schema,risk}`、`run_tool`、`with_project`、`tool_enabled`、`TOOL_COUNT`）。
- 平台模型通道：`platform_agent.rs` / `platform_context_runtime.rs`（抽取与注入复用）。

**不改**：任何现有表字段、`project_library_grant` 语义、知识库检索口径。**新增**仅 `memory_item`/`memory_profile` 派生表、`commands/memory_*.rs`、若干注册/注入点。

## 2. 架构分层

```
message/session ──①抽取(平台模型)──▶ memory.rs(抽取+合并+画像)
                                        │ 写 memory_item / memory_profile
                                        │ 写 data/knowledge/memory/*.md（→ 进 knowledge 索引）
新会话 ──②注入──▶ memory.rs(build_memory_context: 画像摘要+相关记忆TopK) ──▶ system prompt
AI/用户 ──③工具/UI──▶ memory_tools.rs(memory_* 工具 + memory_* 命令)
```

## 3. 数据

见 [DB-FEAT-026](../DB/DB-FEAT-026-个人记忆数据设计.md)。`memory_item`、`memory_profile`，`migrate_feat026(conn)` 幂等挂 `db::init`。

## 4. Rust 模块与函数契约（供并行实现，签名固定）

### 4.1 `commands/memory_store.rs`（数据访问层，新增；仅本文件写 memory 两表 SQL）

```rust
pub struct MemoryItem { pub id:String, pub scope:String, pub kind:String, pub mem_key:Option<String>,
  pub content:String, pub source_type:String, pub source_ref:Option<String>, pub trust:String,
  pub importance:i64, pub confidence:f64, pub status:String, pub superseded_by:Option<String>,
  pub access_count:i64, pub last_access_at:Option<i64>, pub created_at:i64, pub updated_at:i64 }

pub fn ensure_schema(conn:&Connection) -> Result<(),String>; // 调 migrate_feat026
pub fn insert(conn:&Connection, it:&MemoryItem) -> Result<(),String>;
pub fn get(conn:&Connection, id:&str) -> Result<Option<MemoryItem>,String>;
pub fn find_by_key(conn:&Connection, scope:&str, kind:&str, mem_key:&str) -> Result<Option<MemoryItem>,String>;
pub fn list(conn:&Connection, scope:Option<&str>, kind:Option<&str>, status:Option<&str>, limit:usize)
   -> Result<Vec<MemoryItem>,String>;
pub fn update_content(conn:&Connection, id:&str, content:&str, importance:Option<i64>) -> Result<(),String>;
pub fn soft_delete(conn:&Connection, id:&str) -> Result<(),String>;
pub fn hard_delete(conn:&Connection, id:&str) -> Result<(),String>;
pub fn supersede(conn:&Connection, old_id:&str, new_id:&str) -> Result<(),String>;
pub fn touch_access(conn:&Connection, id:&str) -> Result<(),String>;
pub fn all_active_texts(conn:&Connection, scope:&str) -> Result<Vec<(String,String)>,String>; // (id,content) 供画像/检索
pub fn counts(conn:&Connection, scope:&str) -> Result<serde_json::Value,String>; // 统计

pub struct Profile { pub scope:String, pub fields_json:String, pub summary:String, pub revision:i64 }
pub fn get_profile(conn:&Connection, scope:&str) -> Result<Profile,String>;
pub fn upsert_profile(conn:&Connection, scope:&str, fields_json:&str, summary:&str) -> Result<(),String>;
```

### 4.2 `commands/memory.rs`（业务服务，新增）

```rust
pub struct Extracted { pub kind:String, pub mem_key:Option<String>, pub content:String,
                       pub importance:i64, pub trust:String }
pub struct MergeReport { pub added:usize, pub updated:usize, pub superseded:usize, pub skipped:usize }

/// 纯函数：把平台模型返回的 JSON 文本解析成 Extracted 列表（鲁棒：失败返回空并记录，不 panic）。
pub fn parse_extraction(raw:&str) -> Vec<Extracted>;

/// 合并：对每条按 scope+kind+memKey 查找，ADD/UPDATE/NOOP；冲突 supersede。写 memory_item。
pub fn merge(conn:&Connection, scope:&str, items:&[Extracted], source_type:&str, source_ref:Option<&str>)
   -> Result<MergeReport,String>;

/// 画像重建：读 active 记忆 → 生成 fieldsJson+summary（可用简单聚合；LLM 归纳可选，失败保底拼接）。
pub fn rebuild_profile(conn:&Connection, scope:&str) -> Result<(),String>;

/// 注入：返回可直接拼进 system prompt 的文本（画像摘要 + 相关记忆 TopK，按预算截断）；关闭返回空串。
pub fn build_memory_context(conn:&Connection, scope:&str, query:&str) -> Result<String,String>;

/// 会话抽取：取该会话消息 → 调平台模型抽取 → merge → rebuild_profile。
/// 平台模型通道若不可用返回 Err（上层降级，不 panic）。
pub fn run_extraction_for_session(session_id:&str) -> Result<MergeReport,String>;

/// 记忆库首启幂等创建（sourceKind='personal-memory'，目录 画像/记忆/日志）。
pub fn ensure_memory_library(conn:&Connection, data_root:&std::path::Path) -> Result<String,String>;
```

### 4.3 `commands/memory_tools.rs`（工具实现 + Tauri 命令，新增）

工具实现（供 ai_tools 调用）：
```rust
pub fn tool_search(args:&Value)->Result<Value,String>;   // 复用 memory_store::list + 可选语义
pub fn tool_save(args:&Value)->Result<Value,String>;     // 解析 content/kind/scope/importance → merge 单条
pub fn tool_list(args:&Value)->Result<Value,String>;
pub fn tool_forget(args:&Value)->Result<Value,String>;
pub fn tool_profile_get(args:&Value)->Result<Value,String>;
```
Tauri 命令（前端 invoke，命名带后缀避免与工具名冲突）：
```rust
#[tauri::command] pub fn memory_list_items(scope:Option<String>, kind:Option<String>, status:Option<String>, limit:Option<usize>) -> Result<Value,String>;
#[tauri::command] pub fn memory_get_item(id:String) -> Result<Value,String>;
#[tauri::command] pub fn memory_update_item(id:String, content:String, importance:Option<i64>) -> Result<Value,String>;
#[tauri::command] pub fn memory_delete_item(id:String, hard:Option<bool>) -> Result<Value,String>;
#[tauri::command] pub fn memory_get_profile(scope:Option<String>) -> Result<Value,String>;
#[tauri::command] pub fn memory_update_profile(scope:Option<String>, fieldsJson:Option<String>, summary:Option<String>) -> Result<Value,String>;
#[tauri::command] pub fn memory_stats(scope:Option<String>) -> Result<Value,String>;
#[tauri::command] pub fn memory_ensure_library() -> Result<Value,String>;
#[tauri::command] pub fn memory_resediment_session(sessionId:String) -> Result<Value,String>; // 手动沉淀
```

### 4.4 `ai_tools.rs`（修改，独占）

- `TOOL_COUNT` 25 → 30；`workbench_tools()` 增 5 个 `ToolDef`（见 §5）；`run_tool` 增分发：`memory_search/save/list/forget/profile_get` → `memory_tools::tool_*`（`with_project` 注入 projectId→scope）；`REG_LABELS` 增对应中文名。
- 授权：`scope` 由 `projectId` 派生（`project:<id>`）或 `global`；沿用 `tool_enabled` 与审计。

### 4.5 注入点（修改，独占）

- 在平台 runtime 组装 system prompt 处（`platform_context_runtime.rs`，必要时 `chat.rs` 平台分支）请求前调用 `memory::build_memory_context(conn, scope_from_project, latest_user_text)`，非空则追加到 system 段；开关关闭或空则不加。scope 推断：会话绑定项目→`project:<id>`，否则 `global`，并同时拼 `global`。

### 4.6 `commands/mod.rs`、`db.rs`、`lib.rs`（修改，独占文件）

- `mod.rs`：`pub mod memory; pub mod memory_store; pub mod memory_tools; pub mod memory;`
- `db.rs`：`init` 序列末尾调用 `memory_store::ensure_schema(conn)`（或内联 migrate_feat026）。
- `lib.rs`：`generate_handler!` 注册 §4.3 命令；首启调用 `memory::ensure_memory_library`；会话结束触发 `run_extraction_for_session`（后台线程/异步，失败仅日志）。

## 5. 工具 schema（注册进 workbench_tools）

| name | registry_id | 参数 | risk |
| --- | --- | --- | --- |
| memory_search | workbench.memory_search | query(req), scope?, kind?, limit? | low |
| memory_save | workbench.memory_save | content(req), kind(req), scope?, importance? | medium |
| memory_list | workbench.memory_list | scope?, kind?, status?, limit? | low |
| memory_forget | workbench.memory_forget | id(req) | medium |
| profile_get | workbench.profile_get | scope? | low |

预算：search/list ≤20 条、片段≤200 字；save content ≤1KB；写类审计。schema 用 `schema_obj`（`additionalProperties:false`）。

## 6. 前端契约（STORY-109）

- 新模块 `src/modules/memory/`：`MemoryPane.tsx`（页签容器：列表 / 画像 / 统计）、`MemoryList.tsx`、`MemoryProfile.tsx`；样式 `src/theme/memory.css`。
- invoke 命令见 §4.3；数据形状与 Rust 返回 JSON 对齐。
- 入口：知识库页（`src/modules/knowledge/`）新增「记忆」页签，或工作台侧栏入口；导航遵循现有页签/紧凑规则。
- 界面基准：以 [UI-FEAT-026](../UI/文档/UI-FEAT-026-记忆管理界面.md) + `docs/UI/memory-manager/index.html` 为准；空态/深色/窄屏/UI-SCROLL-001。

## 7. 并行工作包划分（文件不重叠，接口按 §4 固定）

| 包 | Story | 负责文件（独占） | 依赖 |
| --- | --- | --- | --- |
| A | 104 | `db.rs`(migrate)、`memory_store.rs` | — |
| B | 105 | `memory.rs` | A |
| C | 106 | `memory_tools.rs`、`ai_tools.rs`、`mod.rs` | A,B |
| D | 107 | `platform_context_runtime.rs`(注入) | A,B |
| E | 108 | `lib.rs`(job/注册)+`memory.rs` 的 run_extraction | A,B |
| F | 109 | 前端 `src/modules/memory/*`、`theme/memory.css`、入口接线 | A（命令契约） |

建议：A 先落（地基，独占 db.rs）→ A 完成后 B/C/D/E 并行、F 全程按契约并行 → 主代理集成、`cargo check/test` + `npm run build`。

## 8. 验证

- 单元：迁移幂等、合并 ADD/UPDATE/NOOP/supersede、软删过滤、scope 隔离、external 低信任、注入预算截断、工具授权拒绝（仿 `kb_tools.rs` 夹具）。
- 集成：`cargo test --lib` 全量、`cargo check --all-targets`、`npm run build` exit 0。
- 端到端（如未跑需标注未验证）：新增偏好→会话结束抽取→新会话被"记得"；关闭注入回退。
- 前端：组件渲染/空态/深色/窄屏/滚动条三态。

## 9. 回退

- 关工具开关 + 关注入开关 → 回现状；`DROP TABLE memory_item/memory_profile` + 删内置库登记 → 彻底回退；Markdown 记忆文件留作普通笔记。

## 10. 未决与风险

- 平台模型抽取接口若不可稳定调用，STORY-108 降级为「AI 主动 memory_save + 手动沉淀」，自动抽取如实标未完成。
- 语义去重依赖现有 `kb_embed`（记忆落 Markdown 后随索引可用）；无向量时退化为 memKey 精确匹配。
- 抽取质量/成本未测，先保证"可关闭、可纠错、可删除"的兜底。
