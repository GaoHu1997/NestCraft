# LLD-FEAT-026：记忆范围与落盘修复（MEM-FIX-001）

- 归属：FEAT-026 / STORY-105、106、108、109；范围仅此 Feature。
- 日期：2026-11-26；状态：设计基线，实施中。
- 用户规则：个人记忆(global)通用；项目记忆(project:<id>)仅所属项目可读写；个人记忆需要进入个人记忆知识库。承接本会话 FEAT-026 的正式开发授权及本次「继续」修复指令。不得推送/发布、读取真实私密对话测试。

## 事实诊断

1. memory_save 即使带 global 仍被 projectId 覆盖；读取同样默认项目，无法取个人。
2. 项目 memory_forget 按 id 删除而不核验条目 scope；with_project 的 or_insert 允许参数伪造项目。
3. 自动抽取不分类，一整段对话都写会话项目；个人偏好被藏在项目。
4. memory_* UI 默认只查 global，项目记录不可见。合并、重建画像从未写 Markdown。
5. knowledge.enabled_root 只接受 managed-directory，个人库 sourceKind=personal-memory 会被拒。
6. 旧报告把编译与 unrelated tests 当上述功能通过，不具充分证据；本修复验证必须独立覆盖这些义务。

## 固定契约

- 工具参数 scope 接受 personal/global(个人)、project(当前项目)、project:<当前id>；写入缺省为当前project（兼容旧行为），系统指引明确个人需 scope=personal。读取缺省为 personal+当前project，profile_get 缺省 personal。没有可信 ctx 不能借参数 projectId 访问项目。无项目时 project 拒绝，畸形scope拒绝。所有 memory_* 仅相信 ToolContext.project_id，不相信模型参数 projectId。
- tool_forget 对查询出的 item.scope 复检（仅个人或当前项目）。返回值含 scope / id / 同步状态，只有 DB+文件成功才说记住。
- 自动抽取输出 memoryScope=personal|project 的逐条分类；通用身份/偏好归个人，项目决策/技术约束归当前项目；未标分类旧输出保守留当前项目，不能自动把存量项目内容提升个人。
- UI 命令 scope=None 保持个人兼容；传 global/project:<id> 支持单范围；不默认全库给AI。所有者 UI 允许选任一实际存在项目，list/profile/stats 同范围、范围变化清除旧数据与异步响应。
- 个人文件：data/knowledge/memory/记忆/<稳定id>.md + 画像/个人画像.md；只同步 global。项目不落个人库，仍独立 SQLite。个人库 sourceKind=personal-memory 支持普通本地目录读取；不改原知识授权、不给项目库全局授权。
- 文件：受管派生镜像，不伪称独立权威。稳定ID、metadata范围/来源/状态。软删从活跃个人库移出但DB保留历史；硬删移除。编辑、忘记均更新画像和文件。初始化/查询个人库可幂等补存量 global；绝不把 project 导出其中。不覆盖其它用户笔记；路径/链接与安全根校验，不接受模型路径。
- 索引：成功文件变更通过同连接发布/重建知识索引；禁止持DB锁再次调用 db::conn()；向量不可用明确降级，不阻塞正文。文件失败返回 MEMORY_SYNC_FAILED(说明DB是否已保存)，不报成功。
- 简画像一行读 global 而不是项目；保持按需 memory_search/profile_get，不恢复TopK塞入。

## UI准入

沿用 memory-manager v1；更新 v2：列表/画像/统计共享个人/项目下拉选择；卡片范围徽标，个人/项目空态；保存草稿切换确认，窄/深/加载错误。UI-SCROLL-001=v1(700ms，仅实际滚动显示，不改宽度)，列表/画像/编辑textarea适用。先可操作稿、hash与索引，后实现。软件视觉无截图不得通过。

## 验收清单

- MEM-01：项目A下 scope=personal 真写global；scope=project写A；相同key不跨scope合并。
- MEM-02：项目B仅能读个人+B；篡改projectId/scope或猜A id遗忘均拒绝，无项目不能访问A。
- MEM-03：抽取混合输出分别入global/A；旧未标分类输出保守A；[]合法不报失败。
- MEM-04：个人新增/修改→知识库真实md、索引可列读搜；项目秘密不在个人目录与索引。
- MEM-05：软/硬删除→活跃md/索引/画像同步移除；文件故障不得说已同步；初始化补旧global。
- MEM-06：UI三页签同scope，切换无串数据/草稿损失；聚焦/刷新不盖编辑；浅深窄及UI-SCROLL-001。
- MEM-07：实际定向测试与cargo check/全量lib/npm build结果，失败记录不隐藏；不给真实收费模型/生产DB自动测试。

## 回退

关闭记忆工具/自动抽取；保留DB和个人md，不做破坏性重置。仅回退本Feature diff，不覆盖其它未提交工作。部署exe未重建时必须说明源码修复不自动生效。
