# RESEARCH-008：个人记忆层与默认个人知识库方案建议

- 日期：2026-11-25。来源：用户「我现在有个知识库，也提供了工具给 ai 用，你结合本项目，给我制定一个方案」，目标为「默认个人知识库 → 逐渐积累 AI 对话 → 越来越懂我」。
- 性质：**方案建议（设计层），待确认，不构成实现授权**。本轮未修改任何正式软件源码、依赖、运行配置或构建产物；未新建 PRD/LLD/DB 正式条目、未分配 CR 编号。用户确认后再走「需求(PRD/CR) → 设计(LLD/DB/UI) → 开发」流程。
- 方法：主代理实读本仓库现行实现与文档，以及 [RESEARCH-003](./RESEARCH-003-WeKnora知识库检索机制调研.md) 与前序 AI 记忆方向调研结论；未运行、未实测、未导入任何外部代码。

## 0. 一句话结论

本项目已具备「个人记忆」约 80% 的基础设施：对话原文已在本地 `message` 表、会话摘要机制已在 `session_context_block`、知识库已有 FTS5+本地语义+双链图谱、工具已有授权与预算体系。**缺口不是「再建一个知识库」，而是三样东西：(1) 一个开箱即用的默认记忆库；(2) 把「对话」自动提炼成「记忆/画像」的沉淀管道；(3) 新对话开始时自动把画像与相关记忆注入上下文。** 因此方案是「在现有知识库之上加一层记忆层」，而不是另起炉灶。

## 1. 现状核实（实读代码，不是文档描述）

| 能力 | 现状事实 | 位置 |
| --- | --- | --- |
| 对话原文 | 已本地落库：`message(id, sessionId, role, content, metaJson, refsJson, ...)`；会话 `session(projectId, runner='cli'|'platform', ...)` | [db.rs:245-272](../../src-tauri/src/db.rs#L245-L272) |
| 会话摘要 | 平台已有分层上下文：`session_context_block`（有损摘要，六字段、≤4096B、level 1-3、superseded 追溯）、`session_context_turn`（精确回放） | [DB-CR071](../DB/DB-CR071-平台会话摘要与回放.md) |
| 知识库 | 本地 Markdown 文件夹库；`knowledge_library`／`knowledge_note_index` | [db.rs:92-111](../../src-tauri/src/db.rs#L92-L111) |
| 检索 | FTS5+中文 bigram 关键词 + 本地 `bge-small-zh-v1.5` int8 语义（512 维）+ RRF(k=60) 混合 | [LLD-CR089](../LLD/LLD-CR089-知识库图谱与语义实现.md) |
| 关系 | `kb_link` 双链索引 + 图谱 `kb_graph`（节点=笔记/附件） | [CR-088](../PRD/CR-088-知识库Obsidian式本地文件交互.md)／[CR-089](../PRD/CR-089-知识库图谱与本地语义.md) |
| 知识工具 | 进程内 5 个只读工具 `knowledge_search/read/links/graph/list`（+ `read_many`），带库启用校验、`project_library_grant.readAllowed` 复检、预算（read≤64KiB、≤20 条、片段≤200 字、graph≤50 节点/≤100 边）、可选审计 | [kb_tools.rs](../../src-tauri/src/commands/kb_tools.rs) |
| 工具注册 | 工作台工具目录 `workbench_tools()`（25 个 `ToolDef{name,registry_id,description,schema,risk}`）注册到 workbench MCP（CLI 用）与平台 runtime（CR-086 统一供给）；`tool_enabled` 可单独停用；`run_tool` 分发、`with_project` 注入 projectId | [ai_tools.rs:171-216](../../src-tauri/src/commands/ai_tools.rs#L171-L216) |
| 授权 | `project_library_grant(projectId, libraryId, readAllowed)`，无记录即拒绝，每次调用复检 | [db.rs:149-157](../../src-tauri/src/db.rs#L149-L157) |
| 存储 | 统一数据根按类别分目录：`data/{db,chat,knowledge,index,skills,...}` | [CR-081](../PRD/CR-081-本地数据统一存储.md) |
| 后台任务 | 首启后台逐库建语义索引（可取消、有进度）可作抽取任务框架 | [LLD-CR089 §3](../LLD/LLD-CR089-知识库图谱与语义实现.md) |

**核心缺口（本方案要补的）**：
1. 没有「默认就存在、默认就积累」的个人记忆库（知识库现在要手动建、手动授权）。
2. `message` 里的对话只"存着"，没有提炼成可复用的记忆/画像。
3. 新对话不会自动带上"你之前告诉我的事"，只能靠 AI 主动 `knowledge_search`。
4. 没有记忆的去重/冲突/衰减/纠错闭环，也没有"关于我"的结构化画像。

## 2. 用户诉求拆解

| 层 | 用户原话对应 | 本方案落点 |
| --- | --- | --- |
| L1 默认个人知识库 | 「一个默认的个人知识库」 | 首启自动创建内置「个人记忆库」 |
| L2 积累 AI 对话 | 「逐渐积累 ai 对话的一些东西」 | 对话→记忆的自动抽取与沉淀管道 |
| L3 越来越懂我 | 「慢慢沉淀，越来越了解我」 | 用户画像聚合 + 新对话自动注入 |

## 3. 方案总览：五层记忆架构（映射到现有存储）

```
用户对话（session / message，已有）
        │  ① 抽取 extraction（LLM 抽 {事实/偏好/目标/事件/决策}）
        ▼
┌──────────────────────────────────────────────────────────┐
│ L0 原始对话     message 表（已有，不改，作为溯源与回放）      │
│ L1 会话摘要     session_context_block（已有，补「可检索」）   │
│ L2 记忆条目     新增 memory_item 表（原子记忆 + 来源）        │
│ L3 用户画像     新增 memory_profile（结构化字段 + 摘要）      │
│ L4 长期知识     现有 knowledge 库：Markdown + kb_embed + kb_link │
└──────────────────────────────────────────────────────────┘
        │  ② 合并/去重/冲突消解（ADD/UPDATE/DELETE/NOOP）
        │  ③ 重要性×时效衰减（遗忘）
        ▼
新对话开始 → ④ 注入：画像摘要 + 相关记忆 TopK（拼进 system prompt）
        → 也可由 AI 用 memory_* 工具主动读写
```

**推荐落点（关键设计决定 A）**：把记忆做成**一个内置的 `knowledge_library`（sourceKind='personal-memory'）**，物理目录 `data/knowledge/memory/`，内含 `画像/`、`记忆/`、`日志/` 子目录；记忆条目以 Markdown 落盘（用户可读可改，符合 CR-088 的 Obsidian 式本地文件库），同时派生写入 `memory_item`（结构化、可合并）与 `kb_embed`（复用语义检索）。这样"默认知识库"能白嫖现有 FTS5+语义+图谱+授权全部能力，用户也能像改笔记一样改记忆。

## 4. 数据设计（新增，均派生可重建，不改原表）

> 遵循 CR-071 的教训：原文权威在 `message`，本层只做派生状态；可重建、可删、可回退。

### 4.1 memory_item（原子记忆）

| 列 | 定义 |
| --- | --- |
| id | TEXT PRIMARY KEY，永不复用 |
| scope | TEXT NOT NULL，`global` 或 `project:<projectId>`（记忆归属与隔离边界） |
| kind | TEXT NOT NULL，`fact`/`preference`/`goal`/`event`/`decision`/`relation` |
| memKey | TEXT，去重/合并键（同 scope+kind+memKey 视为同一事实，可空） |
| content | TEXT NOT NULL，原子记忆正文（一句话事实/偏好） |
| sourceType | TEXT NOT NULL，`message`/`session`/`manual`/`doc` |
| sourceRef | TEXT，messageId/sessionId/noteId，**只存引用不复制正文** |
| trust | TEXT NOT NULL DEFAULT 'own'，`own`/`external`（外部来源低信任，防注入） |
| importance | INTEGER NOT NULL DEFAULT 3，1-5 |
| confidence | REAL NOT NULL DEFAULT 0.7 |
| status | TEXT NOT NULL DEFAULT 'active'，`active`/`superseded`/`deleted` |
| supersededBy | TEXT，被哪条新记忆取代（保留追溯，不物理删） |
| accessCount | INTEGER NOT NULL DEFAULT 0 |
| lastAccessAt | INTEGER |
| createdAt | INTEGER NOT NULL |
| updatedAt | INTEGER NOT NULL |

索引：`idx_mem_scope ON memory_item(scope,kind,status)`、`idx_mem_key ON memory_item(scope,memKey)`、`idx_mem_updated ON memory_item(status,updatedAt DESC)`。

### 4.2 memory_profile（画像摘要，供快速注入）

| 列 | 定义 |
| --- | --- |
| scope | TEXT PRIMARY KEY（global / project:<id>） |
| fieldsJson | TEXT NOT NULL，结构化画像（身份/偏好/目标/习惯/常用技术栈/沟通偏好等，字段可扩展） |
| summary | TEXT NOT NULL，自然语言画像摘要（≤2KB，直接拼进 prompt） |
| revision | INTEGER NOT NULL DEFAULT 0（CAS） |
| updatedAt | INTEGER NOT NULL |

画像由 `memory_item` 中 kind∈{preference,goal,fact} 聚合生成（LLM 归纳），并保留从 Markdown「画像/」笔记反向同步的通道。

### 4.3 复用（不改）

- 记忆 Markdown 落盘 → 自动进 `knowledge_note_index` + `kb_embed` + `kb_link`，直接获得检索/图谱。
- 对话原文 → `message`；会话摘要 → `session_context_block`（给 L1 打 `searchable` 标记即可被检索，不必新表）。

## 5. 工具设计（新增 `memory_*`，注册进 `workbench_tools()`）

复用 [kb_tools.rs](../../src-tauri/src/commands/kb_tools.rs) 的「授权复检 + 预算 + 审计」模式，保持一致的错误码风格：

| 工具 | 参数 | 作用 | 预算/权限 |
| --- | --- | --- | --- |
| `memory_search` | query, scope?, kind?, limit? | 检索记忆条目（复用知识库语义+关键词 RRF，仅搜记忆库） | ≤20 条、片段≤200 字 |
| `memory_save` | content, kind, scope?, importance? | AI 判断"值得记"时主动写入（走合并逻辑） | 单条≤1KB，写类 |
| `memory_list` | scope?, kind?, status? | 列出记忆条目 | ≤20 条 |
| `memory_forget` | id | 软删除（status=deleted） | 写类，需授权 |
| `profile_get` | scope? | 读画像摘要 + 结构化字段 | 低预算只读 |

- 授权：`scope=project:<id>` 时必须项目可见；记忆库同走 `project_library_grant`（或内置库默认对 owner 开放）。
- 开关：注册进 capability，按 registry_id 可单独停用（沿用 `tool_enabled`）。
- 所有写类工具记审计，外部来源记忆 `trust=external`。

## 6. 沉淀管道（对话 → 记忆）

**触发**：① 平台 runtime 每轮 assistant 结束后异步触发（复用现有轮次钩子）；② 会话结束/空闲时批量补抽；③ 提供「沉淀本会话」手动入口兜底。CLI 会话在消息落库后由后台 job 处理，不阻塞对话。

**步骤**：
1. 取本轮/本会话 transcript（`message` + `session_context_turn`）。
2. LLM 抽取结构化 JSON：`[{kind, key, content, importance, sourceRef}]`，仅收"关于用户且长期有用"的项；闲聊、一次性任务不入库。
3. 合并决策（Mem0 式）：对每条与既有 `memory_item`（同 scope+kind+key，或语义近邻）比较 → `ADD / UPDATE / DELETE / NOOP`；冲突走"新盖旧 + supersede"，旧条 `status=superseded`。
4. 落盘：写 `memory_item` + 更新对应 Markdown 笔记（进索引/向量/图谱）+ 触发画像 `memory_profile` 重新归纳（可节流）。
5. 全程可失败降级：抽取失败只记日志，不影响对话；后台可取消（复用 CR-089 的首启 job 框架）。

## 7. 读取注入（越来越懂我）

- 新会话首次请求前：取 `memory_profile.summary`（画像摘要）+ 按当前用户输入语义检索记忆库 TopK（3-5 条），拼成 `## 关于用户` / `## 相关记忆` 两个块注入 system prompt。
- 预算：画像≤2KB、记忆注入≤1.5KB，超出按 importance×时效截断。
- 不注入原始对话全文（避免爆上下文），原文只在需要时由 AI 用 `memory_search`/`knowledge_read` 按需取。
- 可配置开关：按会话/项目可关闭"记忆注入"，尊重隐私。

## 8. 记忆生命周期

- **去重合并**：memKey + 语义近邻。
- **冲突消解**：时序优先 + supersede 链（沿用 CR-071 block 的 superseded 思路），不物理删。
- **重要性/时效打分**：`score = w1·importance + w2·recency + w3·relevance`（Generative Agents 思路），低分长期不访问 → 归档/降权（不直接删）。
- **用户可控**：记忆管理界面（列表/编辑/删除/来源溯源/"这条记错了"），对应 UI 先行。
- **纠错回灌**：用户改一条记忆 → 更新 `memory_item` + Markdown + 画像。

## 9. 与现有能力的复用矩阵（本方案主张「加一层，不造轮子」）

| 需求 | 复用现有 | 新增 |
| --- | --- | --- |
| 记忆存储 | knowledge 库 Markdown + `knowledge_note_index` | `memory_item`/`memory_profile` 派生表 |
| 检索 | FTS5 + bge 语义 + RRF（CR-089） | 仅加"只在记忆库内搜"的过滤 |
| 关系 | `kb_link` + `kb_graph`（CR-088/089） | — |
| 会话摘要 | `session_context_block`（CR-071） | 打可检索标记 |
| 工具框架 | `workbench_tools` + `run_tool` + 授权/预算/审计（CR-086/089） | `memory_*` 5 个工具 |
| 授权 | `project_library_grant` | 记忆库默认 owner 可见 |
| 后台任务 | CR-089 首启建索引 job 框架 | 抽取 job |
| 存储目录 | `data/knowledge/`（CR-081） | `data/knowledge/memory/` |
| 本地 LLM | 平台 runtime 已有模型通道 | 抽取/归纳调用 |

## 10. 安全与隐私（沿用本项目既有原则）

- **全本地**：不引入云端 embedding/向量数据库；语义继续用本地 `bge-small-zh` int8。
- **归属与可控**：记忆是用户内容，可导出/删除/关闭；Markdown 可读可改。
- **防注入**：外部内容（网页/工具结果/MCP）抽取的记忆标 `trust=external`，优先级低、注入需显式；参考 CR-071 的 `scopeHash` 校验思路，撤权记忆不回填。
- **隔离**：记忆按 `scope`（global / project）隔离，跨项目不串。
- **不泄密**：抽取与注入不进日志、不含密钥。

## 11. 分期路线（均需另行授权）

**P0（MVP，最小闭环）**
- 首启内置「个人记忆库」+ 目录结构；`memory_item`/`memory_profile` 建表与迁移。
- 会话结束异步抽取"事实/偏好" → 合并 → 落 `memory_item` + Markdown。
- 新会话注入画像摘要 + 相关记忆 TopK。
- 工具：`memory_search`、`memory_save`。
- 验收：新会话能"记得"上一会话告诉它的偏好；重复事实不重复记；关掉注入后行为回到现状。

**P1（可说、可改、可溯源）**
- 记忆管理界面（列表/编辑/删除/来源）；画像页；`memory_list`/`memory_forget`/`profile_get`。
- 冲突 supersede 链、语义去重、项目级记忆。
- 记忆图谱（复用 kb_graph）。

**P2（越用越准、可评测）**
- 重要性×时效衰减/遗忘；跨会话一致性；抽取质量评测集（换说法召回、重复抑制、错误记忆纠正率）。
- 可选：跨设备同步（沿用 CR-032/004 同步框架，不新增架构）。

## 12. 需用户拍板的关键决策

| 编号 | 决策 | 推荐 |
| --- | --- | --- |
| D1 | 记忆存储形态：内置独立「个人记忆库」 vs 只存 SQLite 表 | **内置独立库**（可白嫖检索/图谱/可读可改） |
| D2 | 抽取触发：每轮结束 / 会话结束 / 手动 | **会话结束为主 + 手动兜底**（省 token、少噪声） |
| D3 | 抽取用哪个模型：平台 runtime 当前模型 / 专用小模型 | 先用**平台当前模型**，后续可换本地小模型 |
| D4 | 记忆默认作用域：全局个人 vs 按项目 | **全局个人**为主，项目记忆可选 |
| D5 | 是否默认开启自动注入 | **默认开**，提供按会话/项目关闭 |

## 13. 参考（承接前序调研，供实现借鉴，不引入其架构）

- 分层记忆：MemGPT（[2310.08560](https://arxiv.org/abs/2310.08560)）／Letta
- 抽取+合并：Mem0（[2504.19413](https://arxiv.org/abs/2504.19413)、[mem0ai/mem0](https://github.com/mem0ai/mem0)）
- 用户画像：Memobase（[memodb-io/memobase](https://github.com/memodb-io/memobase)）
- 记忆卡片自组织：A-MEM（[2502.12110](https://arxiv.org/abs/2502.12110)）
- 重要性×时效检索：Generative Agents（[2304.03442](https://arxiv.org/abs/2304.03442)）
- 时序图谱：Zep/Graphiti（[2501.13956](https://arxiv.org/abs/2501.13956)、[getzep/graphiti](https://github.com/getzep/graphiti)）
- 综述索引：[Awesome-AI-Memory](https://github.com/IAAR-Shanghai/Awesome-AI-Memory)；本仓库 [RESEARCH-003](./RESEARCH-003-WeKnora知识库检索机制调研.md)

## 14. 风险与未验证项（如实）

- **未做任何实测**：抽取质量、注入收益、token 成本、中文抽取准确率均未测；P0 应先建小评测集再承诺效果。
- **抽取成本**：每会话一次 LLM 调用，长会话 token 需按轮次窗口截断；建议后台异步 + 可取消。
- **记忆错误传播**：抽取错误会长期污染画像，必须有"用户可改/可删 + supersede + external 低信任"兜底；不能宣称"自动记忆一定更准"。
- **隐私**：记忆含个人偏好，默认仅本地、可关闭、不日志。
- 本方案为建议，**未改任何源码、未分配正式 CR 编号、未建正式 PRD/LLD/DB 条目**。

## 变更记录

| 版本/日期 | 依据 | 结果 |
| --- | --- | --- |
| RESEARCH-008 / 2026-11-25 | 用户「结合本项目制定方案」 | 只读实读现状 + 产出方案建议；未改软件、未授权实现、未立正式需求编号 |
