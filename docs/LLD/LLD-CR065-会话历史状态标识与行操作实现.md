# LLD-CR065：会话历史状态标识与行操作实现

- 关联需求：[CR-065](../PRD/CR-065-会话历史状态标识与行操作.md) / [STORY-084](../Plan/Story/STORY-084-会话历史状态标识与行操作.md)（AC-01～AC-12）。
- 设计基线：[UI-CR065-v1](../UI/文档/UI-CR065-会话历史状态标识与行操作.md)。
- 数据设计：[DB-CR065](../DB/DB-CR065-会话置顶字段与索引.md)。
- 本次范围：`src-tauri/src/{commands/chat.rs,db.rs,models.rs,lib.rs}`、`src/api/index.ts`、`src/modules/chat/{SessionHistory,ChatPanel}.tsx`、`chat.css`、`src/smoke/{runner,design-preview,ui-suite}.ts`。
- 工作区基线：承接 CR-063（`HEAD c82aabf` + 未提交改动）。本轮只做叠加式改动，不重排他人代码。

## 1. 现状

| 现状 | 位置 | 处理 |
| --- | --- | --- |
| 行尾状态文字（已读/运行中/成功/失败/待处理） | `SessionHistory.tsx` `chat-hist-state` | **删除渲染**，仅保留左侧标识 |
| `.active` 同时有边框与背景 | `chat.css` `.chat-hist-item.active` | 改为仅背景色 |
| 「当前」徽标 + 钉住容器 | `chat-hist-pinned` / `chat-hist-pin-tag` | 去掉徽标；钉住行保留在顶部，用 active 背景表达 |
| 底部「新会话」按钮与栏位 | `SessionHistory.tsx` `.chat-history-foot` | 删除整栏（不换成 token 汇总）；头部 `+` 保留 |
| 「全部」按钮 | `SessionHistory.tsx` `.chat-hist-all` | 改文案「重置」，非搜索态禁用 |
| 行尾删除图标 | `.chat-hist-del` | 改为「…」菜单入口，菜单含删除 |
| `session.unread` | `db.rs` `unread TEXT` | 复用，不改取值 |
| 排序 `updatedAt DESC, id DESC` | `chat.rs` `sessions_page_query` | 改为 `pinnedAt DESC, updatedAt DESC, id DESC`，游标加 `pinnedAt` |
| `SessionMeta` | `models.rs` | 增加 `pinned_at: i64` |

## 2. 数据与接口

### 2.1 `session.pinnedAt`

- 类型 `INTEGER NOT NULL DEFAULT 0`；`0` 表示未置顶，非 0 为置顶时刻（毫秒）。
- 迁移：`migrate_cr064_session_pin(conn)`；先 `PRAGMA table_info(session)` 判断列是否存在，缺则 `ALTER TABLE session ADD COLUMN pinnedAt INTEGER NOT NULL DEFAULT 0`。
- 索引重建（旧的三个分页索引不含 pinnedAt，必须替换）：
  - `idx_session_project_updated (projectId, pinnedAt DESC, updatedAt DESC, id DESC)`
  - `idx_session_server_updated (serverId, pinnedAt DESC, updatedAt DESC, id DESC)`
  - `idx_session_scope_updated (projectId, serverId, pinnedAt DESC, updatedAt DESC, id DESC)`
- 使用 `DROP INDEX IF EXISTS` + `CREATE INDEX IF NOT EXISTS`，幂等；旧索引名复用，避免索引堆积。

### 2.2 分页排序与游标

- 排序：`ORDER BY s.pinnedAt DESC, s.updatedAt DESC, s.id DESC`。
- 游标结构扩展为 `{ pinnedAt, updatedAt, id }`：

```sql
AND (s.pinnedAt < ?p
  OR (s.pinnedAt = ?p AND s.updatedAt < ?u)
  OR (s.pinnedAt = ?p AND s.updatedAt = ?u AND s.id < ?id))
```

- `SessionCursor` 增加 `pinned_at: i64`；`chat_sessions_page` 增加参数 `cursor_pinned_at: Option<i64>`，与 `cursor_updated_at`/`cursor_id` 三者必须同时给或同时不给，否则 `Err("分页游标不完整")`。
- 前端 `SessionPage.nextCursor` 同步增加 `pinnedAt`。
- 不改变 `total` 语义（置顶不改变计数）。

### 2.3 新命令 `chat_session_pin`

```rust
#[tauri::command]
pub fn chat_session_pin(id: String, pinned: bool) -> Result<SessionMeta, String>;
```

- `pinned=true` → `pinnedAt = now_ms()`；`false` → `0`。
- 更新后返回 `chat_session_get(id)`。
- 不改变 `updatedAt`（置顶不是内容更新，避免把会话顶到时间序最前造成误解）。

### 2.4 新命令 `chat_session_fork`

```rust
#[tauri::command]
pub fn chat_session_fork(id: String) -> Result<SessionMeta, String>;
```

规则：

1. 源会话必须存在；`RUNNING` 中存在该 id → `Err("会话正在运行，结束或停止后再分叉")`。
2. 仅普通会话可分叉：`sessionRole != "ordinary"` → `Err("执行会话暂不支持分叉")`。
3. 新 id = `new_id("sess")`，`now = now_ms()`。
4. 复制字段：`projectId/serverId/cliId/providerId/modelId/effort/featureId/featureTitle`；`title = format!("分叉 · {}", 原标题)`；`draft=''`、`unread=NULL`、`pinnedAt=0`、`sessionRole='ordinary'`。
5. **不复制**：`nativeThreadRef`、`nativeBindingRevision`（保持 0）、`nativeConfirmedTurnId`、`featureSourceHash`（保留源值，仅作提示）。
6. 复制消息：按 `createdAt, rowid` 顺序读取源消息，逐条插入新 id（内容、role、metaJson、refsJson、gitContextJson、createdAt 原样）。
7. 单事务完成（`BEGIN IMMEDIATE` / 提交），失败回滚；返回新会话 `SessionMeta`。
8. 分叉不启动任何 CLI 进程、不发模型请求。

### 2.5 前端接口

```ts
export const chatSessionPin = (id: string, pinned: boolean) => invoke<SessionMeta>("chat_session_pin", { id, pinned });
export const chatSessionFork = (id: string) => invoke<SessionMeta>("chat_session_fork", { id });
```

## 3. 前端状态与行结构

### 3.1 状态标识

```ts
type SessionMark = "running" | "unread-success" | "unread-failed" | "unread-pending" | "none";

function markOf(s: SessionMeta, runningIds: string[]): SessionMark {
  if (runningIds.includes(s.id)) return "running";
  const u = s.unread?.toLowerCase();
  if (!u || u === "none") return "none";
  if (["success", "green", "done"].includes(u)) return "unread-success";
  if (["failed", "failure", "error", "red"].includes(u)) return "unread-failed";
  return "unread-pending";
}
```

- 渲染：`running` → `<span className="chat-hist-spin" role="status" aria-label="运行中" />`；其他点用 `<span className="chat-hist-dot dot-…" title aria-label />`；`none` → 保留 10px 占位 `<span className="chat-hist-mark" aria-hidden />`。
- 不渲染行尾状态文字；保留 `aria-label` 供读屏。

### 3.2 选中态

```css
.chat-hist-item { border: 0; }           /* 基础无边框，避免选中时 1px 位移 */
.chat-hist-item.active { background: var(--node-sel-bg); }
.chat-hist-item:hover { background: var(--hover-bg); }
```

钉住行（当前会话不在已加载区间）沿用同一 active 背景与无边框；**删除 `.chat-hist-pin-tag`**。

### 3.3 底部

- 删除 `.chat-history-foot` 整栏（连同「新会话」按钮），不渲染任何 token 汇总；列表 `flex: 1` 自然延伸到底。
- `formatTokens` 等汇总格式函数不在本版引入（每行元信息已有 tokens）。

### 3.4 「重置」按钮

- 文案「重置」，`aria-label="清空搜索并重新查询"`；`disabled={!keyword}`。
- 点击行为不变：`onShowAll()`（清空关键词、回第 1 页 20 条）。
- 空态「清除搜索」保留。

### 3.5 「…」菜单

- 行尾按钮 `.chat-hist-more-btn`，hover / `:focus-within` 显示，24×24，固定占位。
- 菜单 `.chat-hist-menu`：绝对定位在按钮下方（右对齐），`min-width: 168px`，白底/深色令牌、1px 边、8px 圆角、`--shadow-pop`。
- 菜单项：复制会话 ID / 分叉会话 / 置顶（取消置顶）/ 重命名 / 删除。
- 状态：`menuFor: string | null`（会话 id）；同一时刻一个；外点/Escape/滚动/切换会话关闭。
- 键盘：`↑/↓` 移动焦点、`Enter` 执行、`Escape` 关闭并把焦点还给「…」按钮。
- 运行中会话：分叉项 `disabled` 并附 `title`；删除仍由后端“先停止”规则兜底。

### 3.6 复制会话 ID

```ts
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* 回退 */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}
```

- 成功 `toast("已复制会话 ID")`；失败 `toast("复制失败，请手动复制", "err")`；不记录 ID 到日志。

### 3.7 分叉 / 置顶 / 重命名

| 操作 | 前端流程 |
| --- | --- |
| 分叉 | `api.chatSessionFork(id)` → `insertSessionRow(meta)` → `openSession(meta)` → `toast("已分叉会话，上下文已保留")`；失败 toast 原因 |
| 置顶 | `api.chatSessionPin(id, !pinned)` → 重取首页（`loadSessionPage(keyword)`）保证排序与游标一致 → toast；不本地移动行，避免游标错位 |
| 重命名 | 行内编辑：设置 `editingId = id`，标题位置渲染 input（自动聚焦、全选）；Enter 或 blur 保存，Escape 取消；保存调用 `api.chatSessionUpdate({id,title})` 后 `updateSessionRow`；空标题 toast 并恢复原标题 |

- 行内编辑态：`editingId` + `editingValue`；input 点击不触发行切换（单独 `data-act`），Enter/blur 提交、Escape 取消；提交中避免重复请求。

## 4. 兼容与风险

| 项 | 说明 |
| --- | --- |
| 旧数据 | 迁移补 `pinnedAt=0`，旧会话行为不变 |
| `chat_sessions` 旧接口 | 返回的 `SessionMeta` 增加 `pinnedAt`（默认 0），签名不变 |
| 游标升级 | 前端与后端同时升级；旧前端不会带 `cursorPinnedAt`，后端按“游标不完整”拒绝（仅开发期可能遇到） |
| 索引替换 | 旧索引名复用，`DROP` 后重建；迁移失败时功能仍可用，仅排序变慢 |
| 分叉上下文 | 只复制消息文本与元数据，不复制原生线程；新会话首次发送会走 fresh 流程 |
| 置顶与更新 | 置顶不改 `updatedAt`，避免置顶操作本身改变时间序 |
| 状态点可访问性 | 颜色不是唯一信号，均有 `title`/`aria-label` |

## 5. 实现步骤

| 步 | 内容 | 文件 |
| --- | --- | --- |
| S1 | `pinnedAt` 迁移 + 索引重建 + 单测 | `db.rs` |
| S2 | `SessionMeta.pinnedAt`、游标扩展、排序与查询 | `models.rs`、`chat.rs` |
| S3 | `chat_session_pin` / `chat_session_fork` + 单测 | `chat.rs`、`lib.rs` |
| S4 | API 封装 | `src/api/index.ts` |
| S5 | 行结构、状态标识、选中态、底部无汇总、重置、菜单与行内重命名 | `SessionHistory.tsx`、`chat.css` |
| S6 | 分叉/置顶/重命名/复制接线与局部更新 | `ChatPanel.tsx` |
| S7 | 预览 mock 与冒烟断言 | `design-preview.ts`、`runner.ts`、`ui-suite.ts` |
| S8 | 测试与设计对照 | `docs/Test/*` |

## 6. 验证方法

- Rust：迁移幂等、置顶排序与游标翻页、分叉消息复制与绑定清空、运行中拒绝、执行会话拒绝。
- 前端：`npm run build`；隔离预览验证选中无边框、五种状态、底部无汇总、重置禁用、菜单五项、复制/分叉/置顶/重命名。
- 视觉：1440 浅/深 + 390；设计稿与软件成对截图；滚动条行为不变。
- 详细用例见 [TEST-CR065](../Test/TEST-CR065-会话历史状态标识与行操作验证.md)。

## 7. 未决项

- 分叉是否允许执行会话：本版拒绝，后续若需要须先定义 feature 与绑定语义。
- 置顶数量上限：本版不限制；若用户置顶过多导致首屏全是置顶，再评估上限或分组。
- `formatTokens` 是否复用到底部统计：本版只在列表底部使用，后续可迁到公共工具。