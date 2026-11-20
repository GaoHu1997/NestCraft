# LLD-CR025：后台任务记录设计契约

- 关联：[CR-025](../PRD/CR-025-AI侧栏后台任务下拉设计.md)、[STORY-021](../Plan/Story/STORY-021-多会话历史与后台任务.md) AC-11～17；仅需求／设计。
- 可视基准：[UI-CR025-v1](../UI/文档/UI-CR025-后台任务下拉设计.md)；正式软件未获编码授权，不进入开发。

## 当前资源与复用

[AI侧栏](../UI/task-workbench/ai-sidebar.js)已有按scope/session划分的内存会话、单一互斥popup、历史与子智能体、独立Todo/目标和配置安全门禁。增加独立 [后台记录模型](../UI/task-workbench/background-task-model.js)，在 [内部资源页](../UI/task-workbench/index.html) 的AI侧栏脚本前载入，仅设计内存，不读取宿主job_list、不改变已有SDK作业或项目TaskRuntime权威。唯一公开入口保持 [仿真原型UI](../UI/仿真原型UI.html)。

## 设计记录与接口

每条演示记录：`id / scope / sessionId / ownerAgentId? / tool / command / status / startMs? / endMs? / exitCode? / output / error / revision / source='demo'`。有效状态running/completed/failed/cancelled/unknown；已结束只前三种终态，不将未知误清。id在会话内唯一，record同id幂等，update必须同时匹配scope和sessionId，缺失记录拒绝，不静默写入别的会话；revision单调递增，重复/旧事件拒绝，终态不被迟到running复活。

展示记录挂在所属session.backgroundTasks，分组/数量/清空同源。`record(session,data)`记录；`update(session,id,patch)`更新状态/输出；`clearEnded(session)`仅结束展示；`loadFixture(session,kind)`显式载入4条混合/11条全结束/未知场景。外部脚本只经AiSessionDesign的受限演示桥和当前/指定已存在sessionID调用，不放行任意真实执行；未知ID拒绝。DOM渲染一律escape，命令/输出当文字，不插入HTML、不执行脚本。

后台变化更新所属记录；终态首次改变触发所属会话事件revision及成功/失败未读，无消息伪造真实执行结果。当前可见后台列表则刷新列表，不改变输入焦点、不自动收起已展开行；查看列表按已有规则标读。侧栏关闭/会话切换不清记录。演示自动推进使用独立短计时器捕获原会话对象，不能读取当前session指针写回；只显式点击DEMO推进才启动，退出页面停止所有DEMO计时器。

## 边界／数据结论

- 没有正式数据库结构变更，DB不适用：新增仅原型内存。正式作业持久化/恢复/审计清理和权限设计尚未实现，本轮不假定已由SQLite提供。
- 无新增供应商、插件、库、网络访问或真实后台执行；不改src/src-tauri、依赖／运行配置／构建产物。
- 后台记录显示不改变M.sessionBusy、模型/权限锁定及发送/停止行为；不增加真实取消按钮，后台作业状态不自动更新项目验收。
- 示例11条采用参考图的信息形态和相同记录数，但命令与输出为本项目合成夹具，不冒充截图原任务或本机实测。

## 验证与承接

[测试方案](../Test/TEST-CR025-后台任务下拉设计验证.md)：纯模型事件幂等/归属/旧revision/终态/未知；浏览器零隐藏、并列布局、组折叠/明细/清空、异步归属、菜单焦点、浅深1440/1920/390/320及原AI/管理/工作台回归。先实看设计截图再更新索引。

后续正式编码前登记设计hash/覆盖/明确编码授权与真实事件契约；同视口/主题/夹具逐场景生成设计/软件成对证据，软件视觉对照本轮未执行。主代理独占AI脚本、样式、资源接入与文档；不派发共享写入子任务。无部署/迁移/发布；原型撤回可按本轮基线逐项还原本次增量，禁止覆盖其他工作。
