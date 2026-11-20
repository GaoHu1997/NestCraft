# RESEARCH-002：Notrat 同类开源 AI 工作台调研

- 日期：2026-11-19。来源：用户提供 <https://notra.cn/>，问“有没有类似的开源项目”。
- 方法：首轮只读抓取官网、sitemap 与 GitHub API；2026-11-19 复核使用 `web_fetch` 读取官方 README、许可证和文档，只复核 Notrat / Kition / Univer / OfficeCLI / ONLYOFFICE 关键点，不扩候选清单。未克隆源码、未构建、未运行任何被测项目；未使用当前报 402 的 `web_search`。
- Star 数、仓库大小与创建时间为首轮历史抓取记录，本次不刷新，不能据此判定功能完整度或可用性。
- 本次需求语境仅为**项目类型为办公 `work` 的项目工作区**，不是全局办公模式，不替换统一设置或执行内核。本文仅事实核验与机制建议，不构成底层选型、采购/复用许可或正式实现授权；正式方案以 LLD 为准。
- **纠错生效说明**：下文现行表述替代首轮过度结论；原错误结论与纠正理由集中保留在 §7，避免把历史误判继续当作事实。§2.3～2.5 的其他候选只保留历史资料，本次未逐一复核。

## 1. Notrat 是什么，以及它是否开源

官网（canonical 域名为 notrat.cn）自述：**本地优先的 AI 工作台**，约 500MB 的单体桌面应用，Windows / macOS / Linux。

| 能力 | 自述内容 |
| --- | --- |
| Office 原生编辑 | 在应用内直接打开、编辑 `.docx` / `.xlsx` / `.pptx`，不转格式、不依赖本机 Office |
| Markdown | 所见即所得，Mermaid、KaTeX、表格、40+ 语言高亮；数据为纯文本 `.md`，兼容 Obsidian / Typora |
| AI 补全 | 光标位置 Tab 补全，25+ 供应商（含 DeepSeek、通义千问、Kimi、GLM），可接 Ollama 全离线 |
| Agent 运行时 | “Harness 架构”，调研 / 写作 / 审查子 Agent 分工，每一步调用可见 |
| 扩展货架 | 插件、技能、连接器（MCP）、专家 四类 |
| 商业模式 | 纯净版永久免费，买断可选 |

**开源边界（纠正）**：本次读取的 [产品官网](https://notra.cn/) 与 [官方文档站 README](https://raw.githubusercontent.com/NestMold/NotratDoc/main/README.md) 证明其产品定位及公开文档站存在，**不足以证明主程序开源或闭源**。首轮未找到主仓库只能记为“未定位到主程序公开源码及适用许可证”，不能推出“主程序必闭源”或“GitHub 只有周边仓库”。下列为首轮登记的周边仓库；除文档站身份外，本次未逐一复核其许可证，不作为代码复用授权：

| 仓库 | 内容 | 许可证 |
| --- | --- | --- |
| `NestMold/NotratDoc` | 文档站（教程、插件开发、版本记录） | 无 LICENSE |
| `NestMold/notrat-nutstore` | 坚果云同步插件 | AGPL-3.0 |
| `NestMold/NotratLatexPlugin` | LaTeX / `.tex` 支持插件 | MIT |
| `NestMold/notrat-ppt-studio-skill` | PPT 生成技能（10★） | MIT |
| `NestMold/notrat-ui-control-skill` | UI 控制技能 | 无 LICENSE |

现有证据不能回答是否有可直接取得、构建、再分发的完整主程序；也不能从有限候选检索断言不存在同类开源实现。官网功能均为厂商自述，约 500MB、原生编辑、离线与保真度未实测；“本地优先”不自动保证调用远程模型时资料不外发。

## 2. 开源对标：按层拆开找

按桌面宿主、文件编辑、Agent 工具面、人工审阅分别核验，避免把某个层的能力等同于完整产品体验。候选的支持格式、开源范围与交付形式不相同，本次没有做全市场穷举或四项能力的实机对比。

### 2.1 桌面与同文件协作形态参考：Kition

| 项 | 事实 |
| --- | --- |
| 仓库 | `KitionAI/kition`，674★，Apache-2.0，TypeScript + Rust + Tauri |
| 定位 | 桌面工作区：Markdown 笔记、结构化表格、无限白板 + 16 类文件编辑器，**人与 Agent 编辑同一批文件** |
| 机制 | 英文 README：每类文件一个 *kit*，Rust → WebAssembly 引擎在 Web Worker 运行，kit 自绘编辑器；Agent 经 **Kit Harness Protocol（KHP）** 使用同一引擎的工具。另明确 SDK CLI 可注册 MCP 服务，不在此推断全部协议细节 |
| 协作安全 | 英文 README 声明可在 draft 工作，并拒绝覆盖已经变动的基线；中文 README 描述文档 diff 与逐项接受/拒绝。以上为官方描述，未逐 kit 证明全格式一致 |
| 版本固定 | [kit 锁文件](https://raw.githubusercontent.com/KitionAI/kition/main/kits/kits.lock.json) 实际含 repository / version / tag / asset / sha256 / commit；不是仅有空仓库声明，但本次未下载验证其包 |
| 文件类型 | README 列 16 个 kit；必须区分“可打开”与“可创建”：例如 Slide 可打开 `.pptx` / `.kslide`，创建列为 `.kslide`，不能据此直接承诺 PPTX 完整往返；支持列表不等于逐格式保真通过 |
| 状态 | 英文 README 标 **0.1.1 beta**、Linux experimental；HTML / Design / Scene 标 Preview。首轮 0★、新建时间和大小不足以证明所有 kit 均是“早期骨架”或不可用 |

**发布状态核验**：[主仓 Releases API](https://api.github.com/repos/KitionAI/kition/releases) 本次返回 `[]`，只证明该公开端点当时未列桌面 release。[英文 README](https://raw.githubusercontent.com/KitionAI/kition/main/README.md) 明确写 “Desktop builds … **will be published** … **Until then, Kition runs from source**”；[中文 README](https://raw.githubusercontent.com/KitionAI/kition/main/docs/readme/README.zh-CN.md) 仍展示下载入口及“通过 Releases 发布”。应记录两份文档表述不一致，而不是声称英文宣称已发布。英文还给出 SDK CLI / MCP 路径，主仓 release 状态不能代表 SDK/kit 的发布状态。

结论：**可作为机制与后续可行性验证候选，尚无本次可用性实测结论**。既不按星数否定，也不把 README、锁文件或 beta 标签当作本项目能直接依赖的证明。[主仓 LICENSE](https://raw.githubusercontent.com/KitionAI/kition/main/LICENSE) 为 Apache-2.0；各 kit、依赖与实际分发物如要复用仍需逐项核查。

### 2.2 Office 原生编辑这一层（Notrat 的硬骨头）

| 项目 | Stars（首轮） | 许可边界（本轮复核） | 官方描述与本次判断 |
| --- | --- | --- | --- |
| `dream-num/univer` | 30.4k | 开源 Web SDK 核心 Apache-2.0；商业 Web 插件、Server SDK 和超出开源基础的 AI 扩展另行分发授权 | 开源核心包含内容模型、命令、渲染/公式引擎及 Sheets / Docs 编辑；当前 Slides / Boards 为另行分发商业产品。不得把整个产品族和演示都视为 Apache 开源功能，未选为底座 |
| `iOfficeAI/OfficeCLI` | 33.5k | 根 LICENSE 为 Apache-2.0；依赖/分发物尚未逐项审计 | 官方描述为自包含二进制，支持 docx/xlsx/pptx 的 CLI 操作、JSON、skill、HTML/PNG 渲染及内置 MCP；属于文件操作与反馈工具，不能据此承诺“最快接入”或本仓“前端零改动即完整办公” |
| `ONLYOFFICE/DocumentServer` | 7.1k | Community 为 AGPLv3，根 LICENSE 另含归属/界面通知/商标等补充条款，部分非代码内容 CC BY-SA 4.0；Enterprise / Developer 商业许可 | 官方描述为在线编辑器与协同服务，支持文档/表格/幻灯片/PDF等，有自托管安装方案。未做同样本对比，不再称“保真最高”“最重”；部署与许可成本待评估 |

**Univer 文件边界**：[官方 README](https://raw.githubusercontent.com/dream-num/univer/dev/README.md) 与 [根 LICENSE](https://raw.githubusercontent.com/dream-num/univer/dev/LICENSE) 明确区分开源核心和商业扩展；`workbook.save()` 是 JSON snapshot，不等于 XLSX 导出。[Exchange 文档](https://docs.univer.ai/server/import-export/node)（页面版本 v1.5.2）将 Office 转换归于 `@univerjs-pro/exchange-node`。[Exchange 授权文档](https://docs.univer.ai/server/import-export/license) 说明：导入不需要导出授权、不耗导出额度；Free 每授权月有 10 次无水印导出，之后可继续导出带水印完整文件，商业额度/并发/版本权利按购买许可。故“另行许可”也不能误写成“所有导入导出必须先付费”；免费可调用不等于 Apache 开源或获准商业生产/再分发，生产条款需另核。

**OfficeCLI 的 MCP 与体验边界**：[官方 README](https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/main/README.md) 的 AI Integration 已明言内置 MCP；[官方 MCP 命令文档](https://raw.githubusercontent.com/wiki/iOfficeAI/OfficeCLI/command-mcp.md) 写明 stdio / JSON-RPC 2.0、单工具 `officecli` 的 `command` 参数（不是每个 verb 一套结构化工具）。因此不能因其为 CLI 就假定有 MCP，也不能在读到该证据后反称没有 MCP。该 wiki 的部分旧 help 示例仍含独立 format 字段，与正文有不一致，接入需按选定版本实测 schema。渲染、watch 预览或局部表格编辑不等于本仓已有完整原生编辑、差异审阅和保存闭环；截图链路使用 headless browser，不能把“单二进制”推广成所有路径均无环境依赖。[根 LICENSE](https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/main/LICENSE) 已读，未安装或调用。

**ONLYOFFICE 证据**：[官方 Readme](https://raw.githubusercontent.com/ONLYOFFICE/DocumentServer/master/Readme.md) 区分 Community / Enterprise / Developer 及对应功能；[根 LICENSE](https://raw.githubusercontent.com/ONLYOFFICE/DocumentServer/master/LICENSE) 包含 AGPL 正文与 Additional Terms。许可证义务须按所取组件、版本、修改/分发与集成方式核查，不将“AGPL”缩写为“禁止商用”。

### 2.3 Agent 运行时 / 工作台壳（对应本项目 AI 会话 + CLI 桥）

| 项目 | Stars | 许可证 | 与本项目关系 |
| --- | --- | --- | --- |
| `iOfficeAI/AionUi` | 34.4k | Apache-2.0 | 最同构：桌面 cowork，聚合 Claude Code / Codex / OpenCode 等 20+ CLI Agent，多助手组队 |
| `aaif-goose/goose` | 56.8k | Apache-2.0 | Rust 可扩展本地 Agent，MCP 原生，可作 runtime 参考 |
| `CherryHQ/cherry-studio` | 53.7k | AGPL-3.0（首轮记录） | 桌面 AI 工作台，多供应商 + MCP + agents；许可需按复用方式核查，撤回“许可必不适配闭源商业”的概括，本轮未复核该项目 |
| `Mintplex-Labs/anything-llm` | 68.4k | MIT | 本地优先 agent + 文档，许可最宽松 |
| `LibreChat-AI/LibreChat` | 47.3k | MIT | Agents + MCP + Skills 的完整实现 |

### 2.4 本地优先知识层（对应本项目知识库）

| 项目 | Stars | 许可证 | 备注 |
| --- | --- | --- | --- |
| `siyuan-note/siyuan` | 47.3k | AGPL-3.0 | 定位已明确写“人与智能体协作”，中文生态最好，块级编辑 |
| `toeverything/AFFiNE` | 74.9k | NOASSERTION（首轮 API 标识，非许可证结论） | 文档 + 白板一体，本地优先；是否混合许可待按实际组件核查 |
| `AppFlowy-IO/AppFlowy` | 79.2k | AGPL-3.0 | Notion 替代，本地优先 |
| `logseq` / `TriliumNext/Trilium` / `laurent22/joplin` | 45.7k / 39.0k / 57.3k | AGPL-3.0 / AGPL-3.0 / NOASSERTION | 本地 Markdown 存储方向 |
| `khoj-ai/khoj` | 38.2k | AGPL-3.0 | 自托管 AI 第二大脑 |

### 2.5 小而可读的同构实现（适合读代码，不适合当依赖）

| 项目 | Stars | 许可证 | 说明 |
| --- | --- | --- | --- |
| `sundial-org/sundial-desktop` | 36 | Apache-2.0 | Tauri + Yjs CRDT，“人和 agent 在同一文档实时写” |
| `Aitenry/ryten-bench` | 0 | MIT | Electron + LangGraph + PGlite + TipTap，本地优先 AI 桌面工作区 |
| `WWWyyy452/MarkdownEditTool` | 2 | MIT | Electron + CodeMirror + agent tool-use |

## 3. 值得借鉴的两个机制

1. **按文件类型分层的能力契约**：宿主区分读取、预览、结构化修改、保存/导出能力；人工编辑和 Agent 工具尽量共享内容模型与命令，并记录适用格式/版本。版本与校验和锁定值得参考，但“共享命令”本身不自动保证 UI 可审阅或适配现有 CLI 桥，仍需事件、授权与状态映射设计。
2. **草稿 + 差异审阅 + 冲突拒写**：为 `work` 项目的 AI 修改建立明确的基线与草稿，接受/拒绝后再纳入正式文件；基线变动时阻止覆盖并提示重新生成/审阅。原件、草稿、生成产物及失败恢复应区分；这是本项目建议机制，不是已确认所有候选已逐格式实现，也不是仅凭工具调用成功就算交付。

## 4. 许可证风险

| 类别 | 复核结论与边界 |
| --- | --- |
| Apache-2.0 | 本轮已读 Kition 主仓、Univer 开源核心与 OfficeCLI 根 LICENSE。允许商业使用，但需履行分发许可证、保留通知、修改声明及适用 NOTICE 等条件；根许可不自动覆盖商业扩展和所有第三方内容。其他首轮项目标签未重新审计 |
| MIT | 首轮候选标签保留；本次未逐一复核，不能仅用“最宽松”代替版权/许可通知等条件 |
| AGPL-3.0 | **不是禁止商用，也不是所有服务化都与闭源宿主必冲突**。已读 [ONLYOFFICE 根 LICENSE](https://raw.githubusercontent.com/ONLYOFFICE/DocumentServer/master/LICENSE)：§2 明确运行未修改程序的权限，§4 可收费分发，§5～6 规定覆盖作品的修改/分发与对应源码义务，§13 针对修改版的远程网络交互要求向相关用户提供对应源码。是否形成受覆盖的组合/衍生作品，须按具体接口、修改与分发事实判断；独立进程/HTTP 也不是自动免责证明。ONLYOFFICE 另有通知/归属/商标及部分非代码内容条款，商业版本另行授权 |
| NOASSERTION / 混合 | **NOASSERTION 是未作许可断言的元数据标识，不是某种限制性许可证**；不能直接推出混合条款、禁止商用或冲突，也不构成复用许可。确有混合授权与否须读实际 LICENSE、文件头、组件范围及分发条款；本轮没有审计这些非重点项目 |

本节为阅读许可证后的风险提示，不是对具体集成模式的法律合规结论；真正复用前应固定版本、组件清单及使用/分发模式，再做兼容性核查。本次未复用任何代码，也未确立本项目底层选型。首轮对 Multica 的单独记录不在此次五项目复核范围内，不据此推断其他项目的许可证。

## 5. 对办公 `work` 项目需求的机制建议（未选型）

1. **以项目文件而非聊天输出为中心**：同一项目内组织源资料、当前文件、AI 草稿和交付产物；编辑/预览区与 AI 指向同一文件及版本，保持项目隔离和既有知识授权。不引入全局办公模式或第二套模型/执行配置。
2. **把能力和验收拆开**：读取、预览、创建、结构化修改、保存、导出与原文件往返是不同能力；逐格式显示可用/不可用/降级原因。打开 PPTX、渲染 HTML 或保存 JSON 不等于完整 PPTX 往返编辑。
3. **可审阅的修改闭环**：明确对象定位、基线、差异、接受/拒绝、撤销/恢复、保存失败与外部修改冲突；工具返回成功、格式校验通过、视觉正确和用户接受分别记录。
4. **复用统一能力入口**：借鉴共享内容命令、结构化结果、版本锁定与按需能力发现，不预定必须通过某个 SDK、CLI 或服务。OfficeCLI 的 MCP 已有文档证据，但本仓适配仍待评估；Univer 的商业边界与 ONLYOFFICE 的许可/部署边界是后续比较条件，不是本次已选结论。

## 6. 未验证项与复核界限

- 未下载、安装、构建或运行这五个项目；README、命令示例、锁文件与许可证均是静态证据，不代替产品可用性、真实接入或合规验收。
- Notrat 主程序公开源码位置、完整许可证及再分发授权仍未确认；文档/插件公开不自动代表主程序授权。
- Kition 桌面发布仅查主仓公开 Releases；官网其他下载渠道、SDK/kit 包可下载/可运行、构建成功率与全格式审阅/往返未验证。不再保留“全项目无二进制/不可用”的推论。
- Univer 商业协议、离线许可/额度行为、各平台原生组件、Tauri WebView 集成与采购成本未验证；以上 Free 规则仅记录本次 v1.5.2 文档，不承诺未来不变。
- OfficeCLI MCP 的真实握手、schema、权限/路径隔离、返回码、resident 落盘与并发修改行为未运行；原生/浏览器渲染依赖和嵌入 UI 仍待验证。
- ONLYOFFICE 的实际集成模式、商业替代授权、组件级许可与服务资源成本未评估；不做“最高保真”或“所有服务化必冲突”的结论。
- 未逐字核验其他 NOASSERTION 类项目的 LICENSE，未比较中文字体/分页、复杂公式、图表、VBA、动画或宏的保留和执行能力，未测包体、启动时间与跨平台打包。
- 官方分支链接为 2026-11-19 读取的动态来源（Kition / OfficeCLI `main`、Univer `dev`、ONLYOFFICE `master`），未冻结源码快照，复用时需锁定版本。ONLYOFFICE 初试 `README.md` / `LICENSE.txt` 返回 404，经目录 API 确认后实际读到 `Readme.md` / `LICENSE`；404 不代表仓库无文档/许可。SPDX 说明页抓取超时，未当成已读证据。

## 7. 2026-11-19 纠错记录（历史保留，旧结论已撤回）

| 首轮历史结论 | 本轮纠正及依据 |
| --- | --- |
| “Notrat 主程序未开源/只有周边仓库/不存在开源替代” | 改为主程序公开源码与许可未定位；官网和文档仓库只能支持有限正面事实，未找到不能证明不存在，见 §1 |
| “Kition 全部 kit 为 0★早期骨架，当前不可作依赖或工具” | 星数/大小/时间不证明不可用；英文 README 给出源码、SDK/CLI 入口，锁文件含具体包版本与校验和。只记录 beta 与本次未实测，见 §2.1 |
| “中英文 README 都称已通过 Releases 发布，与产物不符” | 英文明确“will be published / Until then … source”；中文仍有下载表述。空 release 仅为该端点当时结果，不覆盖 SDK/kit 或其他下载通道 |
| “Univer 全套 Apache、首选底座；自建文件 IO 即可” | 只确认开源核心许可；Slides、商业插件、Server/扩展 AI 与 Exchange 单独核查，JSON snapshot 不等于 OOXML 转换；Free 导出/水印与导入规则不能混为全付费，见 §2.2 |
| “OfficeCLI 最快接入，CLI/MCP 接上后前端零改动” | 官方现在确有内置 MCP 文档，但本仓适配和完整办公 UI 未验证；渲染/工具操作不等于人工编辑、审阅和保存闭环 |
| “ONLYOFFICE 保真最高；AGPL 不得嵌入闭源商业，服务化必冲突” | 未做保真比较；AGPL 允许商用，义务取决于覆盖作品、修改/分发/网络交互等事实，还须核 ONLYOFFICE 补充条款，见 §4 |
| “NOASSERTION 等于混合/限制，与闭源主线冲突” | 元数据没有给出许可断言，不等于某种许可或冲突结论；真实条款未读的项目保持待核 |
| 按 A/B/C 路线指定底层并排投入高低 | 撤回未经基准验证的排序与选型；本次只给 `work` 项目机制建议，不扩成全局办公，不修改正式软件 |
