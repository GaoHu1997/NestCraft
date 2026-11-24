# DB-CR071-v2：平台会话摘要与回放

- v2补session_context_turn.sourceHash及无校验旧表的加列兼容；新增迁移、事务、回放hash与大原文测试。隔离数据库已运行，真实用户库未迁移。

- 归属 FEAT-025，关联 [CR-071](../PRD/CR-071-平台会话分层上下文与安全找回.md)／[LLD-CR071](../LLD/LLD-CR071-平台上下文压缩实现.md)。状态：设计中，尚未迁移真实数据库。
- 原 `session/message/provider/model/capability` 复用；不改旧字段、不删原消息、不建任务权威。新表仅平台派生状态。

## 1. 表与约束

### session_context_state

| 列 | 定义 |
| --- | --- |
| sessionId | TEXT PRIMARY KEY，REFERENCES session(id) ON DELETE CASCADE |
| revision | INTEGER NOT NULL DEFAULT 0，非负；摘要事务的 CAS 版本 |
| updatedAt | INTEGER NOT NULL |

### session_context_block

| 列 | 定义 |
| --- | --- |
| id | TEXT PRIMARY KEY，永不复用 |
| sessionId | TEXT NOT NULL，session 级联删除 |
| sourceIdsJson | TEXT NOT NULL，有序完整源消息 ID 列表；不写路径或原正文 |
| sourceHash | TEXT NOT NULL，sha256，绑定 source rows+精确回放 |
| summaryJson | TEXT NOT NULL，固定六字段结构、非空、最大4096 bytes |
| level | INTEGER NOT NULL，CHECK 1～3 |
| parentIdsJson | TEXT NOT NULL，一级为空，上级指向被替代块 ID |
| scopeHash | TEXT NOT NULL，创建时来源/身份指纹 |
| modelId | TEXT NOT NULL，生成模型的现行 ID；不记录密钥 |
| status | TEXT NOT NULL，CHECK active/superseded |
| createdAt | INTEGER NOT NULL |

索引 `idx_context_block_session ON session_context_block(sessionId,status,createdAt,id)`。活跃块源范围不得重叠，应用层事务验证。旧块 superseded 留追溯，上级保留全部源 IDs/hash。

### session_context_turn

| 列 | 定义 |
| --- | --- |
| userMessageId | TEXT PRIMARY KEY，REFERENCES message(id) ON DELETE CASCADE |
| sessionId | TEXT NOT NULL，session 级联删除；校验 userMessageId 实际归属同会话 |
| transcriptJson | TEXT NOT NULL，有序 ChatMsg，包含本轮受检User(prompt)及全部assistant/tool交换；原user展示正文仍在message，不以此替代 |
| sourceHash | TEXT NOT NULL DEFAULT ''，绑定原消息组及transcript；空值/失配拒绝恢复，不把旧无校验回放当可信 |
| scopeHash | TEXT NOT NULL；本轮读取／模型生成的来源指纹 |
| createdAt | INTEGER NOT NULL |

用于准确重放新平台轮次中 assistant→工具→assistant 的原顺序；旧 message 行不会为了修复顺序被 UPDATE。原 user/assistant/tool_use/tool_result 仍是用户历史与内容权威。

## 2. 迁移

`platform_context::migrate(conn)` CREATE TABLE/INDEX IF NOT EXISTS，挂 `db::init` 既有序列。不执行生产迁移、本轮测试均为隔离库。回退旧软件时表保留、旧软件忽略；不 DROP 或重建原 message/session。

## 3. 事务与版本

- 准备阶段获取 revision+活跃块+源 IDs/hash+scopeHash，网络期间无 DB 锁。
- 提交阶段同事务重新校验 scope/源 hash、revision CAS；激活新块，父块 superseded，revision+1。失配／SQL失败整个事务回滚。
- 本轮输出 messages+精确 transcript 同一事务归档；即使停止/错误有部分输出也可归档，Done 仅成功提交后发。
- 已撤权/身份修订的摘要不能恢复；旧块可保留本地追溯但不再上模型。任何查询只限宿主确定的 sessionId，不接受模型跨会话参数。

## 4. 备份、隐私和容量

使用已有 SQLite 整库备份，无外部向量／缓存服务。摘要与 transcript 是用户内容，安全等级与 message 一致，不进日志；密钥不入新表。搜索/恢复仅当前会话、有界分页、低信任回填。结构化摘要有损，不把数据库可检索等同模型语义无损。

原消息保留意味着磁盘不会因模型压缩自动减小；本增量解决模型窗口而非历史归档容量。最长新回放／摘要来源请求有预算与读取上限，超大保护轮次失败关闭。

## 5. 必测不变量

迁移幂等、旧消息hash不变、sourceIds跨会话拒绝、CAS冲突回滚、父块追溯、active范围不重叠、level<=3、摘要有界、删除级联、重启验证、撤权不回填。逐项见 TEST-CR071 与 Story AC。
