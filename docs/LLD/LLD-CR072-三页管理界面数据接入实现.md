# LLD-CR072：三页管理界面数据接入实现

- 关联：[CR-072](../PRD/CR-072-三页管理界面设计与数据接入.md) / [STORY-095](../Plan/Story/STORY-095-三页管理界面数据接入与设计对齐.md) / [DB-CR072](../DB/DB-CR072-项目知识库服务器扩展字段.md)。
- 设计基准：[UI-CR072](../UI/文档/UI-CR072-三页管理界面设计对齐.md)（workbench-v4 三页渲染）。

## 1. 当前实现与受影响模块

- 项目管理：`ProjectHome.tsx` 卡片仅 图标/名称/id·类型/本地路径/类型标签/“暂未接入”占位/更新时间/删除/打开。数据模型 `Project` 无 owner/描述/标签/进度/运行数。
- 知识库：`KnowledgeHome.tsx` 网格卡片，含 sourceRef/授权计数/篇数·revision 与多个操作按钮；`KnowledgeLibrary` 无 owner/描述。
- 服务器：`HostList.tsx` 卡片指标为“未知”，带连接/进入/编辑/删除按钮；`ServerHost` 无 os/指标/时间；已有 `server_metrics(host_id)->HostMetrics` 采样。

## 2. 选定方案与接口契约

### 2.1 数据库
见 DB-CR072：project(+owner/description/tagsJson)、knowledge_library(+owner/description)、server_host(+os/lastSeenAt/cpuPct/memPct/diskPct)。`migrate_cr072` 幂等 ALTER。

### 2.2 后端结构与命令
- `models::Project` 增 `owner:String, description:String, tags:Vec<String>, story_total:i64, story_done:i64, running_count:i64`（后三项为派生，仅 list 返回；create/update 返回时也计算）。
- `list_projects`：LEFT 聚合 `requirement_index`（story 总数/完成数）与 `execution_task`（活跃数）；解析 tagsJson。
- `create_project(name, kind, root_uri, owner?, description?, tags?)` 与 `update_project(..., owner?, description?, tags?)`：可选参数 None=保持、Some=覆盖；tags 存 JSON。
- `models::KnowledgeLibrary` 增 `owner:String, description:String`；`kb_list` 返回；新增 `kb_update_meta(id, name?, owner?, description?)`（None=保持）。
- `models::ServerHost` 增 `os:Option<String>, last_seen_at:Option<i64>, cpu_pct:Option<f64>, mem_pct:Option<f64>, disk_pct:Option<f64>`；`server_list` 读缓存；`server_metrics` 成功后写回缓存（os/cpuAvg→cpuPct、memUsed/memTotal→memPct、lastSeenAt=now）。
- 磁盘：`HostMetrics` 目前无磁盘字段，若采样未提供则 diskPct 留空显示「—」（不改 SSH 采样命令，避免扩大风险）；OS 取 `metrics.os`。

### 2.3 前端
- `api/index.ts`：扩展类型与 `createProject/updateProject/kbUpdateMeta` 签名；新增可选参数保持向后兼容。
- 项目管理 `ProjectHome.tsx`：
  - 搜索 placeholder、过滤范围扩展；副标题「双击卡片或点击「打开」进入项目；点击编辑修改项目信息」；双击卡片进入（`onDoubleClick`），保留「打开」按钮。
  - 卡片：描述用 `description`（空则回退 rootUri 弱化显示）；标签 `tags` + `N 个运行`（runningCount>0）；进度条 `storyDone/storyTotal`；负责人首字母圆 + 姓名；更新时间；打开。
  - 删除入口从卡片底部移到「编辑项目」弹窗底部（避免与设计稿底部三元素冲突，功能不丢）。
  - `ProjectFormModal`：启用 负责人/项目描述/标签（逗号或顿号分隔）输入并提交。
- 知识库 `KnowledgeHome.tsx`：单列卡片；「描述 · 负责人」；授权项目名标签（由 grants 映射项目名）；篇数·更新时间（updatedAt 由 revision/文件时间近似或用最后扫描时间，缺则显示篇数）；操作保留 图标/管理授权/进入，重新扫描与删除收进次级；新增「编辑信息」入口设置 owner/description。
- 服务器 `HostList.tsx`：卡片展示 CPU/内存/磁盘（`—` 占位）、分组·OS、更新时间；点击卡片进入工作台；「添加主机」文案；连接后调用 `server_metrics` 刷新并 `reload` 显示缓存。编辑/删除保留为次级按钮。

## 3. UI / 权限 / 兼容性
- 视觉按 workbench-v4；沿用现有 CSS 令牌与图标体系，不新增图标依赖。
- 权限：仅只读统计与本人管理字段，不触及授权/审批/运行语义。
- 兼容：字段可空，旧数据默认空；API 可选参数不影响既有调用。

## 4. 实现步骤
1. db.rs 迁移 + models 字段。
2. projects/knowledge/servers 命令与统计。
3. api/index.ts 类型/函数。
4. 三个前端页与样式。
5. 构建/测试；设计—软件对照。

## 5. 验证与回退
- `cargo test --lib`、`npx tsc --noEmit`/`npm run build`；三页功能回归；对照截图。
- 回退：新增列可空，移除前端读取即恢复旧展示；不改旧数据。

## 6. 未决/假设
- 磁盘使用率：`server_metrics` 未采集时显示「—」，不新增远端采样命令（如后续需要另立需求）。
- 知识库“更新时间”：现有模型无 updatedAt，暂以篇数/最近索引近似或隐藏时间，避免虚构；如需精确时间另记需求。
