# DB-CR104：会话搜索授权与权限档位

- 关联：[CR-104](../PRD/CR-104-本地搜索授权会话化.md)／[LLD-CR093](../LLD/LLD-CR093-AI搜索工具.md)。范围：`session` 表新增权限档位列；本地搜索额外目录改存会话作用域。
- 迁移方式：纯增量、幂等；不批量回填历史记录，不删除旧数据。

## 1. session.permissionMode

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| permissionMode | TEXT | 可空 | 会话权限档位：`default` / `plan` / `agent` / `auto` / `full`；NULL 视为 `default`。 |

- 新库：包含在 `db.rs` 的 `CREATE TABLE IF NOT EXISTS session` 中。
- 旧库：`migrate_cr095_session_permission` 检测 `PRAGMA table_info(session)`，缺列时 `ALTER TABLE session ADD COLUMN permissionMode TEXT`；已存在则跳过。
- 写入时机：
  - `chat_send` 携带 `permissionId` 时随用户消息写入（与本轮实际使用的档位一致）；
  - `chat_session_set_permission` 在设置面板切换时写入。
- 不回填原因：历史会话当时实际使用的档位没有留存事实；按当前全局默认回填会改写历史，故保持 NULL（工具侧按 `default` 解析）。
- 读取：`SESSION_COLUMNS` 末列返回给前端；本地搜索工具经 `session_permission_mode` 读取，`plan` 时只保留项目根。

## 2. 会话额外搜索目录

存储位置：`setting_default`。

| scope | key | value |
| --- | --- | --- |
| `session:<sessionId>` | `search.extraDirs` | JSON 字符串数组，元素为 canonical 绝对目录 |

- 为何不复用 `projectId` 作用域：CR-104 要求「仅本会话有效、不写入项目设置」，同一项目不同会话可各自授权不同目录。
- 写入：`search_session_dirs_add` / `search_session_dirs_remove`；读取：`search_session_scope_get`、工具侧 `search_roots`。
- 校验：必须为存在的绝对目录，canonical 化后去重；不可访问的目录在读取时跳过，不阻断其他目录。
- 旧数据：CR-093 的 `setting_default(scope=<projectId>, key='search.authDirs')` 不再被读取；本轮不删除，保留以便回溯，后续可统一清理。

## 3. 影响与回退

- 影响：本地搜索默认范围变化（项目根），设置页删除授权卡片，新增会话级授权入口；`session` 表仅加可空列，旧代码读旧列不受影响。
- 回退：应用旧版本时，`permissionMode` 列被忽略（旧查询不选该列）；`session:<id>` 作用域的设置记录成为无主数据，但不影响旧逻辑。搜索范围回退到旧的「项目 authDirs」白名单（旧版本行为）。
- 索引：本次无需新增索引；会话列表查询仍按既有 `(projectId, pinnedAt, updatedAt, id)`。

## 4. 验证要点

- 新库建表含 `permissionMode`；旧库迁移一次后列存在，重复执行不报错。
- 设置会话档位后重启应用，列表/详情返回同一值。
- 添加/移除会话额外目录只影响该会话，其他会话的 `search_scope_get` 不变。
- `plan` 会话的工具结果 `searchRoots` 只含项目根。

## 5. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-11-26 | 建立本设计：`session.permissionMode` 与 `session:<id>/search.extraDirs`。 |
