# LLD-CR063：会话历史分批加载与全项目搜索实现

- 版本：**v2**（2026-11-22 评审退回后修订；v1 的问题见 §11）。
- 关联需求：[CR-063](../PRD/CR-063-会话历史分批加载与全项目搜索.md) / [STORY-082](../Plan/Story/STORY-082-会话历史分批加载与搜索.md)（AC-01～AC-14）。
- 设计基线：[UI-CR063-v2](../UI/文档/UI-CR063-会话历史分批加载与全项目搜索.md)。
- 数据设计：[DB-CR063](../DB/DB-CR063-会话历史分页索引.md)。
- 改动范围：`src-tauri/src/commands/chat.rs`、`src-tauri/src/db.rs`、`src-tauri/src/lib.rs`、`src-tauri/src/models.rs`、`src/api/index.ts`、`src/modules/chat/{ChatPanel,Composer,SessionHistory}.tsx`、`src/modules/chat/chat.css`、`src/smoke/{runner,design-preview,ui-suite}.ts`、`docs/*`。不改会话存储模型、权限与派发链路。

## 0. 工作区基线（评审 I-11 / N-05）

开发起点记录（2026-11-22，本 CR 编码前实测）：

- `git rev-parse HEAD` = **`c82aabf`**（`docs(release): 记录 0.0.2 发布与流水线验证结果`）。
- `git diff --stat` 全量：**50 files changed, 3044 insertions(+), 376 deletions(-)**（含 CR-055/058/060/061/062 等未提交改动）。
- 本 CR 将触及的已跟踪文件（改动前已存在他人改动）：

| 文件 | 改动前 diff | 说明 |
| --- | --- | --- |
| `src-tauri/src/commands/chat.rs` | +69 | CR-060/062 相关未提交改动 |
| `src-tauri/src/db.rs` | +72 / −50 | CR-058/061 迁移改动 |
| `src-tauri/src/lib.rs` | +18 | CR-060/062 命令注册 |
| `src/api/index.ts` | +61 | CR-060/062 接口 |
| `src/modules/chat/ChatPanel.tsx` | +40 | CR-062 子智能体视图 |
| `src/modules/chat/chat.css` | +52 | CR-062 样式 |
| `src/smoke/runner.ts` | +34 | CR-060/062 冒烟 |

- 本 CR 当前**未改动**的已跟踪文件：`Composer.tsx`、`SessionHistory.tsx`、`smoke/design-preview.ts`、`smoke/ui-suite.ts`、`src-tauri/src/models.rs`。
- 本 CR 新增（未跟踪）：`docs/PRD/CR-063-*`、`docs/Plan/Story/STORY-082-*`、`docs/LLD/LLD-CR063-*`、`docs/DB/DB-CR063-*`、`docs/UI/文档/UI-CR063-*`、`docs/Test/TEST-CR063-*`、`docs/Test/REPORT-CR063-*`、`docs/UI/workbench-v4/cr063.css`、`scripts/shot-cr063-design.mjs`、`docs/Test/screenshots/cr063-design/*`。
- 本 CR 修改的设计资源（已跟踪）：`workbench-v4/{ai.js,core.js,data2.js,index.html,main.js,pane-resize.js}`、`docs/UI/文档/设计资源索引.html`、`docs/需求汇总.md`、`docs/README.md`、`docs/PRD/CR-054-*`、`docs/Plan/Feature/FEAT-011-*`。

改动纪律：

- 只新增函数/字段/命令，不重排、不删除既有代码；不 `git checkout` / `reset` / 回退他人未提交内容；
- 每个文件改动后跑 `git diff --stat` 复核，确认新增行与既有改动可区分；
- 若同一行冲突，以当前工作区版本为准，并在交付说明记录；
- 完成后的最终 diff 由集成负责人审查（AGENTS §7.2 第 7 条）。

## 1. 问题与目标

一次全量查询 + 全量传输 + 全量 DOM，在会话变多后同时拖慢打开速度与查找效率；`@` 引用与发送校验又依赖内存全量列表。目标：

1. 列表改为**键集（游标）分页**，每批 20 条；
2. 查找改为**后端标题检索**，覆盖当前作用域全部会话；
3. 所有消费点不再依赖完整内存列表；
4. 不改会话数据模型与权限边界。

## 2. 现状与复用点

| 现状 | 位置 | 处理 |
| --- | --- | --- |
| `chat_sessions(project_id)` 全量查询 | `chat.rs:162` | **保留**（冒烟与历史调用），新增分页命令 |
| `SESSION_COLUMNS` + `session_row` 行映射 | `chat.rs:113-157` | 直接复用，分页命令返回同一 `SessionMeta` |
| 作用域过滤 | `ChatPanel.tsx:233` `filterSessions` | 语义下沉到 SQL，前端不再二次过滤 |
| 会话历史浮层 | `SessionHistory.tsx` | 改造为分页 + 搜索 + 钉住 + 加载/失败态 |
| `@` 候选 | `Composer.tsx:181` | 改为按需查询 |
| 发送校验 | `ChatPanel.tsx:574` | 改为读取会话元信息比对作用域 |
| 轮次结束全量刷新 | `ChatPanel.tsx:179/440/638` | 改为单行更新（§4.3） |
| 会话表索引 | `db.rs:402` | 新增三个作用域排序索引 |
| 设计预览 mock | `smoke/design-preview.ts:985` | 新增 `chat_sessions_page` 实现 |

## 3. 接口契约

### 3.1 新命令 `chat_sessions_page`

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionCursor { pub updated_at: i64, pub id: String }

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionPage {
    pub items: Vec<SessionMeta>,
    pub total: i64,
    pub has_more: bool,
    pub next_cursor: Option<SessionCursor>,
}

#[tauri::command]
pub fn chat_sessions_page(
    project_id: Option<String>,
    server_id: Option<String>,
    keyword: Option<String>,
    cursor_updated_at: Option<i64>,
    cursor_id: Option<String>,
    limit: Option<i64>,
) -> Result<SessionPage, String>;
```

> `SessionPage` 与 `SessionCursor` 必须带 `#[serde(rename_all = "camelCase")]`，与 `SessionMeta` 一致；否则前端拿不到 `hasMore` / `nextCursor`（评审 M-04）。

规则：

- `limit` 缺省 20，钳制到 `1..=100`。
- `keyword` 去首尾空白；空串等价于 `None`。
- `cursor_updated_at` 与 `cursor_id` 必须同时给或同时不给；只给一个返回 `Err("分页游标不完整")`。
- `hasMore` 用“多取 1 条”判断：SQL `LIMIT limit+1`，`items` 只返回前 `limit` 条。
- `nextCursor` 取 `items` 最后一条的 `(updatedAt, id)`；`hasMore=false` 时为 `None`。
- `total` 为同作用域 + 同关键词的 `COUNT(*)`，**不是** `items.len()`。
- `total` 与 `items` 是两条独立 SELECT，顺序执行；`db.rs` 为单连接 + Mutex 串行，期间无并发写插入，因此计数与列表一致。不宣称“事务快照”；若将来启用多连接写入，改为 `BEGIN DEFERRED` 包住两条查询（评审 M-03）。

### 3.2 作用域与关键词 SQL

作用域严格复刻 `filterSessions`（评审 I-06，含“server-only 不限制 projectId”的既有语义）：

| 入参 | WHERE |
| --- | --- |
| `project=Some, server=Some` | `s.projectId = ?1 AND s.serverId = ?2` |
| `project=Some, server=None` | `s.projectId = ?1` |
| `project=None, server=Some` | `s.serverId = ?1` |
| `project=None, server=None` | `s.projectId IS NULL AND s.serverId IS NULL` |

关键词：`AND s.title LIKE ?n ESCAPE '\'`，参数为 `%{escaped}%`；`escaped` 依次把 `\`、`%`、`_` 替换为 `\\`、`\%`、`\_`。

游标：`AND (s.updatedAt < ?c OR (s.updatedAt = ?c AND s.id < ?cid))`。

排序：`ORDER BY s.updatedAt DESC, s.id DESC LIMIT ?lim + 1`。

### 3.3 错误处理

| 情况 | 返回 |
| --- | --- |
| 数据库未初始化 | `Err("db not initialized")` |
| 游标参数不成对 | `Err("分页游标不完整")` |
| `limit` 非法 | 钳制，不报错 |
| SQL 失败 | `Err(e.to_string())`，前端原样展示到 `title` 与行内错误 |

### 3.4 兼容性

- `chat_sessions(project_id)` 签名与行为不变。
- 新命令在 `lib.rs` 的 `generate_handler!` 注册；`api/index.ts` 增加 `chatSessionsPage`。
- `design-preview.ts` 必须实现同语义 mock（见 §7.3），否则设计预览首屏报“未知命令”。

## 4. 前端状态设计

`ChatPanel` 把 `sessions: SessionMeta[]` 扩展为列表 + 分页状态：

```ts
interface SessionsState {
  scopeKey: string;                 // `${projectId ?? ""}|${serverId ?? ""}`
  items: SessionMeta[];             // 已加载主体（不含钉住行）
  total: number;
  hasMore: boolean;
  cursor: { updatedAt: number; id: string } | null;
  keyword: string;                  // 已生效的搜索词
  loading: "idle" | "first" | "more" | "search";
  error: string | null;
}
```

约束：

1. `items` 按 `id` 去重合并；同 id 以新数据覆盖。
2. 请求带 `requestId` + `scopeKey` 双重校验；作用域切换后到达的过期响应丢弃。
3. **新建**：`items.unshift(meta)`、`total+1`；搜索态下仅当 `meta.title` 命中当前关键词时插入并 `total+1`。
4. **删除**：移除该项并按是否命中扣减 `total`；**删除的若是 `current` 且不在 `items`（钉住行），只 `total-1`、不操作 `items`**；删当前会话后按既有规则选剩余第一项（评审 N-09）。
5. **发送/未读变化**：只更新对应行（§4.3），不重置分页；**保持原位、不置顶**（评审 N-04，AC-09 不要求重排）。
6. **钉住行**：`currentId` 不在 `items` 中且 `keyword` 为空时渲染；进入主体后自动隐藏。
7. **标题变化**：命中判断按新标题重算；未命中则从搜索结果移除并 `total-1`（评审 M-05）。
8. **关闭/切换会话**：浮层卸载即重置为「最近 20 条 + 空关键词」；再次打开重新取首页（评审 N-07，与 UI §3.7 一致）。

### 4.1 搜索时序（统一 250ms）

- 输入 → 组件内 `query` 即时回显；250ms 防抖后调用 `onSearch(trimmed)`。
- 关键词为空 → 不留在搜索态，调用 `onShowAll()`：清空关键词并**取一次无关键词首页**（`items` 重置、`limit=20`、`total` 为全部总数）。设计稿与实现一致（评审 I-01）。
- 关键词变化 → 重置 `items/cursor`，发 `limit=20, keyword` 首查，`loading="search"`。
- 搜索态滚动到底 → 带同一 `keyword` 与游标追加，`loading="more"`。
- 同一关键词的过期响应按请求序号丢弃。

### 4.2 `SessionHistory` 接口（评审 B-02）

```ts
export function SessionHistory(props: {
  scopeId?: string;
  items: SessionMeta[];
  current: SessionMeta | null;      // 钉住行与删除确认的数据源
  currentId: string | null;
  total: number;
  hasMore: boolean;
  loading: "idle" | "first" | "more" | "search";
  error: string | null;
  keyword: string;
  runningIds: string[];
  onLoadMore: () => void;
  onSearch: (q: string) => void;
  onShowAll: () => void;
  onRetry: () => void;
  onSwitch: (s: SessionMeta) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
});
```

- 钉住行渲染 `props.current`；删除确认的 `target` 先查 `items`，再回退 `props.current`。
- `current` 由 `ChatPanel` 的 `cur` 提供，即便不在已加载集合也有完整 `SessionMeta`。
- 搜索态（`keyword` 非空）不渲染钉住行。

### 4.3 替换 `refreshSessions` 的三个全量调用点（评审 I-04）

| 调用点 | 现状 | 改为 |
| --- | --- | --- |
| `ChatPanel.tsx:179` fresh 确认后 | `void refreshSessions()` | 已有 `meta = await api.chatSessionGet(sid)`，直接 `updateSessionRow(meta)` |
| `ChatPanel.tsx:440` 轮次结束 | `await refreshSessions(scope)` | **复用 438 行已取到的 `meta`**，先合并本轮生成的新 `title`（首句标题）再 `updateSessionRow`，不得用 440 行前的旧 `meta.title` 覆盖（评审 N-03） |
| `ChatPanel.tsx:638` 轮询安静后 | `await refreshSessions()` | 仅当该 sid 在 `items` 中或为当前会话时 `const meta = await api.chatSessionGet(sid); updateSessionRow(meta)` |

```ts
const updateSessionRow = (meta: SessionMeta) => {
  setSessions(prev => prev.map(s => (s.id === meta.id ? { ...s, ...meta } : s)));
  setCur(prev => (prev?.id === meta.id ? { ...prev, ...meta } : prev));
};
```

`refreshSessions` 保留但只用于“切换作用域 / 手动重试”这类需要重建列表的场景，并且按当前已加载数量重取首页（`limit = max(20, items.length)`），不再无条件回到 20 条。

### 4.4 计数与按钮文案

- 头部：`loading === "first" ? "…" : \`${items.length} / ${total}\``。
- 按钮：`hasMore ? \`继续加载 · 还剩 ${total - items.length} 条\``；`loading === "more"` 时显示「加载中…」并禁用。
- 到底：`hasMore=false && !loading` 显示「已到全部」。

## 5. `@` 引用会话

- `ReferencePopover` 新增 `serverId?: string`、`onSessionSearch?: (q: string) => Promise<SessionMeta[]>`。
- `trigger === "@"` 且提供 `onSessionSearch` 时：输入 250ms 防抖调 `chatSessionsPage({ projectId, serverId, keyword: q, limit: 20 })`，用 `items` 作为会话候选；失败回退本地 `sessions` 并显示原有提示。
- 作用域为完整 `project + server`（与列表一致），当前应用只传 `projectId`，行为不变（评审 M-07）。
- 候选点击仍生成 `kind: "session"` 的 `ContextRef`，展示文本不变。

## 6. 发送前会话归属校验

原逻辑：`sessions.some(s => s.id === ref.objectId)`。改为：

```ts
const meta = await api.chatSessionGet(ref.objectId);
if (!inScope(meta, props.projectId, props.serverId)) { toast("引用会话不属于当前项目，未发送", "err"); return false; }
```

`inScope` 与 SQL 四分支一一对应，写成纯函数放在 `ChatPanel.tsx` 内部并由 `ui-suite` 冒烟覆盖（仓库无前端单测框架，不新增 devDependency；评审 I-12）。

## 7. 索引、迁移与 mock

### 7.1 索引（评审 I-05 修订）

实际查询分支决定索引形状，**不能**只用一个 `(projectId, serverId, updatedAt, id)`：

| 索引 | 覆盖分支 |
| --- | --- |
| `idx_session_project_updated (projectId, updatedAt DESC, id DESC)` | project-only（生产主路径）、global（`projectId IS NULL` 等值定位后行内过滤 serverId） |
| `idx_session_server_updated (serverId, updatedAt DESC, id DESC)` | server-only |
| `idx_session_scope_updated (projectId, serverId, updatedAt DESC, id DESC)` | project + server 同时等值 |

- 迁移函数 `migrate_cr063_session_page_index`，幂等 `CREATE INDEX IF NOT EXISTS`，在既有迁移链（`migrate_session_feature_binding` 之后）执行。
- 保留 `idx_session_feature`（CR-047 使用）。
- **查询计划预期**（必须实测，见 REPORT）：project-only / project+server / server-only 三个分支无 `TEMP B-TREE` 排序；global 分支以 `projectId IS NULL` 前缀定位，`serverId IS NULL` 作为残余过滤，允许不做严格无排序断言。

### 7.2 迁移与回退

- 只建索引，不改表；回退 `DROP INDEX` 即可，功能仍正确，仅排序变慢。
- 详见 [DB-CR063](../DB/DB-CR063-会话历史分页索引.md)。

### 7.3 设计预览 mock

`src/smoke/design-preview.ts` 增加：

```ts
on("chat_sessions_page", a => {
  const scope = sessions.filter(s => /* 与命令相同的四分支作用域 */);
  const kw = String(a.keyword ?? "").trim().toLowerCase();
  const matched = (kw ? scope.filter(s => s.title.toLowerCase().includes(kw)) : scope)
    .sort((x, y) => y.updatedAt - x.updatedAt || (x.id < y.id ? 1 : x.id > y.id ? -1 : 0)); // 必须先排序
  const limit = Math.min(100, Math.max(1, Number(a.limit) || 20));
  const cu = a.cursorUpdatedAt == null ? null : Number(a.cursorUpdatedAt);
  const cid = a.cursorId == null ? null : String(a.cursorId);
  const start = cu == null ? 0 : matched.findIndex(s => s.updatedAt < cu || (s.updatedAt === cu && s.id < cid));
  const from = start < 0 ? matched.length : start; // 游标不命中返回空页，不退化为首页
  const page = matched.slice(from, from + limit);
  const hasMore = from + limit < matched.length;
  return {
    items: copy(page),
    total: matched.length,
    hasMore,
    nextCursor: hasMore && page.length ? { updatedAt: page.at(-1)!.updatedAt, id: page.at(-1)!.id } : null,
  };
});
```

> 与命令契约一致：先按 `updatedAt DESC, id DESC` 排序；`hasMore=false` 时 `nextCursor=null`；游标不命中返回空页（评审 N-06）。

不实现该 mock 时，设计预览首屏历史加载会报“未知命令”（评审 I-08）。

## 8. 实现步骤

| 步 | 内容 | 文件 | 依赖 |
| --- | --- | --- | --- |
| S1 | 三个索引迁移 + 单测 | `db.rs` | 无 |
| S2 | `SessionPage/SessionCursor` + `chat_sessions_page` + 注册 + 单测 | `models.rs`、`chat.rs`、`lib.rs` | S1 |
| S3 | 前端接口 `chatSessionsPage` + 类型 | `src/api/index.ts` | S2 |
| S4 | `SessionHistory` 分页/搜索/钉住/加载失败/删除 | `SessionHistory.tsx`、`chat.css` | S3、UI-CR063-v2 |
| S5 | `ChatPanel` 状态机、局部更新、替换三个 `refreshSessions` 调用 | `ChatPanel.tsx` | S4 |
| S6 | `Composer` 按需搜索 + 发送归属校验 | `Composer.tsx`、`ChatPanel.tsx` | S5 |
| S7 | 设计预览 mock + 冒烟断言 | `smoke/design-preview.ts`、`smoke/runner.ts`、`smoke/ui-suite.ts` | S5 |
| S8 | 测试与视觉对照 | `docs/Test/*` | 全部 |

单文件串行修改，本轮由主代理顺序执行。

## 9. 验证方法

- Rust：`cargo test --lib`，覆盖四分支作用域、游标不重不漏、关键词转义、`hasMore` 边界、`limit` 钳制、游标不成对报错、索引存在幂等。
- 前端：`npm run build`（含 `tsc --noEmit`）。
- 行为：`src/smoke/runner.ts` 增加分页/搜索断言；`ui-suite.ts` 断言历史浮层新结构（搜索行、继续加载、计数、钉住、删除入口）；设计预览走 `chat_sessions_page` mock。
- `ui-suite` 执行口径（评审 N-10）：跑**设计预览/正式软件的 ChatPanel**，而非另起测试框架；夹具通过冒烟库预置 45 条会话（44 条普通 + 1 条标题含「退出码」的旧会话），断言：①首批 20 行与计数 `20 / 45`；②滚到底出现「继续加载」；③点击后 40 行；④搜索「退出码」命中 1 条且该会话 `createdAt` 位于第 45 位；⑤钉住行在 `currentId` 不在前 20 时出现；⑥`inScope` 四分支纯函数至少覆盖 project-only 与 global（界面可达的两种），server-only / project+server 由 Rust 单测覆盖。
- 视觉：1440×900 + 浅/深逐场景对照；390×844 只验软件行为；滚动条四帧动态证据。
- 设计稿断言已在 UI-CR063 §5 执行。

## 10. 未决项与风险

| 项 | 说明 |
| --- | --- |
| `total` 的 `COUNT(*)` 成本 | 走同一作用域索引；十万级会话才明显，本轮不做近似计数 |
| 搜索大小写/拼音 | 仅字面匹配（MySQL/SQLite 默认 ASCII 不分大小写），不做拼音 |
| 钉住行与计数 | 钉住行不计入 `X/Y`，已固定 |
| 外部更新越过游标（评审 M-06） | 键集分页保证不重复，但若某未加载会话在翻页期间被更新、`updatedAt` 越到已加载区间之前，可能被跳过。缓解：①当前会话的钉住行由 `cur` 驱动，更新只刷新行内容（**不置顶**）；②切换作用域或手动重试时重取首页；③风险记录在报告，不承诺强一致快照 |
| 已加载行 `updatedAt` 变化后的位置 | **保持原位**（不强制重排、不置顶），避免列表跳动；下一次重建列表时按新排序归位（评审 N-04，与 AC-09 一致） |
| 并发写入 | 单连接 Mutex 串行，无写插入穿插；未来多连接需 `BEGIN DEFERRED` |
| 搜索态新建/删除计数 | 按 §4 约束 3/4/7 只对命中项计入，未命中不改 `total` |

## 11. v1 评审问题与修订对照

| 评审项 | 修订 |
| --- | --- |
| B-01 加载/失败/删除态缺设计 | 新增 5 类状态 + 行删除确认，UI-CR063 升 v2 并重新截图 |
| B-02 钉住行缺数据源 | `SessionHistory` 增加 `current: SessionMeta | null` |
| I-01 清空行为矛盾 | 统一为“回到第 1 页取一次无关键词首页” |
| I-02 计数文案不一 | 统一为头部 `X / Y` + 按钮 `还剩 N 条` |
| I-03 搜索态钉住未定义 | 明确搜索态不钉住 |
| I-04 三个全量刷新点 | §4.3 逐点替换为单行更新 |
| I-05 索引结论不成立 | 改三索引，按分支给查询计划预期 |
| I-06 AC-07 自相矛盾 | 改为“与四分支逐条一致”，server-only 仅单测 |
| I-07 删除入口丢失 | 设计补行内删除 + 确认态 |
| I-08 design-preview 遗漏 | §7.3 实现 mock |
| I-09 搜索态分批无验收 | 新增 AC-14 + 用例 |
| I-10 文字按钮偏离 | 改纯文字按钮并补截图 |
| I-11 脏工作区风险 | §0 记录基线策略 |
| I-12 前端单测不可执行 | 改由 smoke/ui-suite 覆盖 |
| M-01～M-10 | 分别落入 AC-01 措辞、250ms/700ms 统一、total 说明、camelCase、搜索态计数、外部更新风险、@ 作用域、状态与链接、滚动条版本、ui-suite |