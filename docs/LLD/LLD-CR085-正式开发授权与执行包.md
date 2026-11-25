# CR-085：正式开发授权与分特性执行包

- projectId：NestCraft；协调会话只负责准入、文档、受检集成和验证，不直接承担跨Feature开发。
- 用户编码授权：2026-11-25 19:08（Asia/Shanghai），用户原话「授权开发」；范围为此前交付CR-085全部设置调整（总则1组＋模型管理13项＋检测2项＋SDK/CLI6项＋能力5项）。不含提交、推送、发布、便携版重打包、真实账号/付费供应商/SDK安装验证。
- 需求：[CR-085](../PRD/CR-085-设置中心精简与配置交互补正.md)；设计：[UI-CR085-v1](../UI/文档/UI-CR085-设置中心精简与交互补正.md)；源hash：[基线](../Test/cr085-settings-baseline.json)。设计与需求先于本次编码；历史“仅设计”记录保留。
- 接手源码HEAD：`3dcf819dbd3aec7fea2e44f073e50b48092f0e94`，main，大量并行未提交变更。现有设置模块未列为既有改动；其他会话的聊天/知识库/概览、package文件和数据库/注册入口改动全部保护，不回退。

## 1. 独立执行与文件所有权

| Feature执行上下文 | 完整AC／场景 | 独占软件文件 | 独占验证与方案增量 |
| --- | --- | --- | --- |
| FEAT-013 能力与设置 | STORY-023 CR085-01；STORY-078 CR085-01～05；SC-085-01/13～16/17 | SettingsSkill.tsx、SettingsMcp.tsx、SettingsTool.tsx、SettingsGeneral.tsx、SettingsDialog.tsx、settings/index.tsx；capabilities.rs；新能力helper/API与cr085-abilities.css | docs/Test/REPORT-CR085-FEAT013-实现验证.md、scripts/cr085-feat013-*；必要数据方案仅CR085范围 |
| FEAT-014 模型与检测 | STORY-076 CR085-01～13；STORY-075 CR085-01～02；SC-085-02～09/17 | SettingsModels.tsx、SettingsModelProbe.tsx、SettingsImageGen.tsx；providers.rs；src/api/index.ts仅供应商字段/函数；models.rs仅Provider/EffortResolution；db.rs仅本批迁移；lib.rs仅注册新provider命令；新模型helper与cr085-models.css | docs/Test/REPORT-CR085-FEAT014-实现验证.md、scripts/cr085-feat014-*；DB-CR085-FEAT014必要数据方案 |
| FEAT-015 SDK与CLI | STORY-077 CR085-01～06；SC-085-10～12/17 | SettingsSdk.tsx、CliRoute.tsx、sdk.rs（必要时）；新CLI能力helper/API与cr085-sdk.css；ModelPicker.tsx只允许权限选项共享函数的窄替换，保护其他未提交编辑 | docs/Test/REPORT-CR085-FEAT015-实现验证.md、scripts/cr085-feat015-* |

所有代理不改共享settings.css，改为独立CSS并由所属组件导入；不改package/lock；不改别人的原型资源/实现文件。FEAT-013不改src/api/index.ts、models.rs或lib.rs：优先复用既有命令及api.invoke，扩展skill_save草稿的可选字段可在独占capabilities.rs内完成。新的命令确实需要共享注册时先提出变更，由已负责该文件的执行上下文按明确局部补丁协作，不整文件覆盖/全仓格式化。

## 2. 逐工作包必需义务

### FEAT-013
- 完整源：[STORY-023 CR085-01](../Plan/Story/STORY-023-设置中心弹框与菜单重组.md#cr-085增量)、[STORY-078 CR085-01～05](../Plan/Story/STORY-078-能力管理评审调整.md#cr-085增量)。不能只看本表摘要。
- 受管技能可编辑显示名/slug/描述/全文，改名保留目录附属资源与启停状态；创建/更新身份区分、重名拒绝、不覆盖外部来源。文件+DB一致性与失败恢复需实测，不直接清目录重建。
- MCP结构化command/args/env保持字节边界，空参数/空格/反斜杠/等号不能因回填再分词丢失，JSON文件/粘贴/扫描保留；验证连接调用既有真实发现链，保存不当连接成功；内置工具只分类、不改权限。
- 设置头只留标题与业务操作，FEAT014使用事件`settings:new-provider`连接标题“新增供应商”；FEAT013负责在index标题放置按钮，FEAT014负责监听并移除正文重复入口。所有受影响子弹窗删冗余说明，不删字段/错误/必要状态。

### FEAT-014
- 完整源：[STORY-076 CR085-01～13](../Plan/Story/STORY-076-模型配置评审调整.md#cr-085增量)、[STORY-075 CR085-01～02](../Plan/Story/STORY-075-设置模型检测十九针探针.md#cr-085增量)。
- 供应商ID新增可指定、留空生成；已有ID不能改，避免把用户指定ID误当UPDATE，更不能按不存在ID自动创建覆盖；明确创建/编辑契约。Chat和Responses前端不能映射成同一个选中状态；需要持久区分时先补DB方案，保持粗协议兼容字段与既有路由。
- 端点草稿始终两种可填，地址存在即启用，空省略；密钥明文只在用户主动编辑/复制时按所有权校验读取，不加入provider_list或日志，掩码首尾可辨识，原secret引用保护。
- 范围独立草稿与显式保存/取消；拖动+键盘排序有插入线、失败还原与真实持久化回读；自动模态有来源回显/未知保持/手改保护；固定108px检测六槽，20针及概率性归因规则保留。

### FEAT-015
- 完整源：[STORY-077 CR085-01～06](../Plan/Story/STORY-077-CLI与SDK管理评审调整.md#cr-085增量)。
- 权限按各CLI能力同源且保留未核验禁用；可用模型/effort按配置源，不能用全局固定档位冒充所选模型支持；跟随主agent保留实际有效配置，失效可见、切模型清无效档位。
- SDK执行锁覆盖请求发起到后端任务结束（不能仅Promise resolve后解锁），同SDK版本/卸载互斥；检测与刷新版本合并，失败保留旧成功值。最新版本不能写成已安装。
- 最近5次记录含操作、目标、时间、状态及脱敏日志，记录在关闭设置重开后保持；可复用setting存储，不必新增表。安装记录更新跟随真实job；只用隔离仿真测试，不安装真实SDK。

## 3. 共通准入、数据与动态验证

- **UI-SCROLL-001**：[UI-CR049-v1](../UI/文档/UI-CR049-滚动条按需显示.md)，SHA256 `a7cfe6449d07a76b0c83c9f3c6db280a3f42eb4afe00deb4d3882af7ea3fbd7c`；实际滚动目标显示、停止700ms隐藏、连续滚动重置、hover/focus不唤醒；不禁滚、不变宽、不丢草稿/选区，嵌套独立。适用设置正文、供应商/模型、协议菜单、模型获取、Skill正文/扫描、MCP参数/环境/JSON/扫描、SDK日志。每包返回动态实测与未验项，静态截图和class存在不代验。
- 数据：复用DB-CR059、DB-CR058、已有capability/provider和setting；若需provider默认API模式/排序字段，FEAT014执行者在DB增量登记兼容读取/迁移/回退，再改schema；技能目录及索引更新先记录原子/恢复策略；SDK日志复用setting，不虚构已落库。
- 测试：前端tsc、针对性脚本与隔离组件/App预览；Rust定向单测/cargo check，最终集成构建由主代理协调运行，避免多份构建覆盖。不启动替换用户软件服务器；浏览器对比可使用独立静态构建/临时端口并明确非当前桌面应用。
- 视觉：相同1440×900/390×844、100%浅/深、同合成样例与状态，设计/软件成对截图及动态滚动证据。每条AC返回通过/失败/未执行/不适用，缺项不能标已完成。技术验证通过但原生/真实环境未验则交付待验收，不自动宣称发布。

## 4. 交接检查点

本轮协调：授权和源版本已读取，独立工作包已登记；下一步三个Feature独立writer按表执行。需保护所有接手时未提交变更；现有外部会话writer未知，遇共享源码改变先核对停止writer，不覆盖。各代理只更新自己的实现验证报告和必要DB/LLD增量，Story/Feature/README/汇总由主代理最终同步。
