# UI-CR055-FEAT007-v1：编码性能设计

- 唯一执行身份：projectId=`NestCraft-workspace-D-github-AI_Delelovelop`（仓库身份，不访问业务project DB），featureId=`FEAT-007`，STORY-034 CR055-01～05，WP-C1/C2。
- 授权：主代理派发记录用户2026-11-21 15:35“执行吧，进行开发”；本Feature唯一writer impl-editor。专属设计先行；共享入口/资源索引由主代理登记，不由本代理写入。
- 可操作资源：[专属设计稿](../performance-editor/index.html)，版本UI-CR055-FEAT007-v1，SHA256=`546617b045cb7d2f453ed87d119a999c059807398be91691838cf36ed9b26fe3`。该路径是内部设计资源，唯一公开入口仍由主代理统一登记。
- 风格来源：读取现行工作台编码设计及CR045 code-reading设计，继承白蓝/深色令牌、260px文件栏、26px文件行、40px页签/路径栏、13px等宽编辑；只补性能状态，不从现有软件反推覆盖新设计。CR048自动保存/排版编辑方向保留，完整Markdown排版引擎不在本次性能实现中伪称完成。

## 场景与义务

| 场景 | 状态／行为 | 关联AC／实现 |
| --- | --- | --- |
| C1目录 | 初始加载、空、失败重试、部分页/加载更多、选中、滚动虚拟行 | CR055-01；FileTree及目录页API |
| C1搜索 | 进行中、取消、完整结果、结果达上限并明确未搜索全部；保持已返回结果 | CR055-05；FileTree及后台搜索 |
| C2编辑 | 普通/大文档继续编辑；已保存/未保存/保存中/失败保草稿；CtrlS同一保存队列 | CR055-02/03；CodeArea与文档状态模型 |
| C2打开 | 文件准备状态不阻塞当前文档；窗口预览必须用户主动选择；返回编辑保草稿 | CR055-04；元信息/受检句柄/窗口读取 |
| C2窗口 | 明确只读窗口、当前片段/下一段、失败/过期重试；不把原可编辑文件自动降只读 | CR055-04；WindowPreview |
| S1滚动 | 文件树/搜索结果/代码/窗口正文初始隐藏、滚动显示、停止700ms隐藏，嵌套独立且草稿/选区保留 | 全部；UI-SCROLL-001 |

UI-SCROLL-001采用[现行滚动条规范](UI-CR049-滚动条按需显示.md)与[CR049](../../PRD/CR-049-滚动条仅在滚动时显示.md)，源hash沿CR055主方案。正式软件复用既有全局scrollbar监听，不设置测试专用隐藏样式、不改变正文宽度、不以overflow:hidden禁用正文滚动。存量Markdown视图不在本稿中重定义，仍受CR048约束；相关全量WYSIWYG缺口要报告，不能把本次编码性能当该缺口已完成。

## 实际设计验证（先于UI源码）

2026-11-21 15:42，本机Playwright通过Edge157.0.4341.60打开file设计资源；16项检查通过：可见行有界、动态滚动开始/700ms停止、选区与输入保持、主动窗口/返回草稿、取消/部分反馈、加载/空/错误/冲突/准备/窗口状态、390宽无页面横溢、无JS错误。浅/深1440及深390截图已生成；主代理需登记唯一入口再准入。

[机器记录](../performance-editor/design-validation.json)／[浅色正常](../performance-editor/light-normal.png)／[滚动中](../performance-editor/scroll-active.png)／[停止后](../performance-editor/scroll-idle.png)／[部分搜索](../performance-editor/light-partial.png)／[深色](../performance-editor/dark-normal.png)／[窄屏](../performance-editor/dark-narrow.png)。截图为设计证据，不是软件一致证明。已用read_image实际查看浅色正常图。真实软件需同条件对照，不能只凭DOM或构建通过。

## 技术边界与采用记录

UI技能路由已加载，选定React组件性能技能正文再次fetch failed，未声称采用未读正文。新增接口暂沿既有rootUri/path调用边界，后端复检规范根/受检路径并绑定窗口label和根，不接真实project DB；与LLD scopeId的适配在实现报告登记。DB不适用本次代码缓冲/目录租约/搜索内存任务，不创建业务表；完整磁盘文档恢复协议未实现不得记AC03全通过。

纯内部dirty与保存串行化不改变正文视觉，只记录新状态提示；虚拟树不改变文件行外观与滚动规则；新可见状态均由上表定义。准入后实际实现位置、比对结果与未验证项见[本 Feature 实现报告](../../Test/REPORT-CR055-正式实施与集成验证.md)。
