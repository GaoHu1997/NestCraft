# Agent 工作台（个人 Agent 桌面应用）

Tauri 2 + React 18 + TypeScript 实现的个人 Agent 工作台：项目/需求管理、AI 会话（CLI 桥）、Git 管理、编码区、服务器运维（SSH）、知识库与统一设置。

## 运行

```bash
npm install
npm run tauri dev    # 开发运行（首次编译 Rust 需数分钟）
```

打包：`npm run tauri build`（NSIS，未含签名配置）。

环境要求：Node 24+、Rust 1.99+（MSVC 工具链）、git、Windows WebView2。

## 使用要点

- 首次启动自动建库：`%APPDATA%/com.agentworkbench.app/workbench.db`（SQLite，WAL）。
- **AI 会话前需先安装 CLI**：设置 → SDK 管理 → 安装 `claude` / `codex` / `grok`（npm 全局）。
- **模型供应商**：首次启动会预置一份 TierFlow 模板（含 Anthropic / OpenAI 双协议端点与 `tierflow`、`tierflow_pro` 模型），只需在「模型设置」里填入密钥即可用；也可自行新建其他供应商。
- 项目（编码）需选择本地目录；需求树读取项目 `docs/Plan/**` 下带 front matter 的 Markdown。
- 知识库以本地 `.md` 目录为源，按项目授权后才能被 AI 检索/读取（每次调用实时复检）。
- 服务器模块使用 russh；高风险命令（rm -rf、shutdown 等）需逐次审批。

## 文档

**CR-043 办公项目调整（仅设计）**：[同一原型](docs/UI/仿真原型UI.html) → 办公项目。左侧文件夹树可新建目录／文件；右侧直接复用编码模式完整AI侧栏；统一风格并补同源报告、台账、汇报、PDF与会话仿真样例。[本批需求](docs/PRD/CR-043-办公文件树与统一AI侧栏.md)／[UI说明](docs/UI/文档/UI-CR043-办公文件树与统一侧栏.md)／[验证](docs/Test/REPORT-CR043-办公文件树与统一侧栏.md)。不修改正式软件。

**CR-038 办公类型项目（仅设计）**：[同一原型](docs/UI/仿真原型UI.html) → 项目管理 → 办公 → 打开项目。办公内部调整为文档／成果、资料与多格式编辑、项目内AI、审阅与防覆盖保存；不是全局模式，不改Code项目。[完整需求](docs/PRD/CR-038-办公类型项目文档协作.md)／[UI设计](docs/UI/文档/UI-CR038-办公项目文档协作.md)／[验证报告](docs/Test/REPORT-CR038-办公项目设计验证.md)。原型仅合成仿真，未接真实Office引擎，设计待评审。

**UI唯一公开入口：[仿真原型UI.html](docs/UI/仿真原型UI.html)**（CR-036 按评审意见重构版，指向 `docs/UI/workbench-v4/`）。可直接用浏览器打开，无需安装、构建或启动服务：默认「工作台」，项目卡片＋目录选择、需求整宽树＋行尾菜单、设计三栏一体、任务 CLI 标识、编码三栏＋Git 面板、AI 侧栏可拖拽（历史／`@`/`/`／CLI／权限／模型／统计）、知识库多格式树＋授权、服务器满高三栏、设置固定弹窗。意见与落实对照见 [CR-036](docs/PRD/CR-036-主界面按评审意见重构.md)，设计见 [UI-CR036-v1](docs/UI/文档/UI-CR036-主界面重构设计.md)，验证见 [REPORT-CR036](docs/Test/REPORT-CR036-主界面按意见重构验证.md)（离线浏览器 27/27、28 张截图）。CR-035 与更早原型保留为历史；正式软件未修改／运行，视觉待用户评审。

**当前 UI 仿真原型固定在 [统一工作台](docs/UI/仿真原型UI.html)**，可用浏览器直接打开，无需安装、构建或启动服务；资源目录固定为 [设计图总览](docs/UI/文档/设计资源索引.html)。后续设计原地更新，不变更入口位置。CR-022 保留用户近期新设计，仅补已授权存量缺口和可信样例；本轮不修改正式软件。Agent 思想承接范围见 [现行需求](docs/PRD/PRD-002-需求派发与自主执行.md#cr-022研发-agent-思想的渐进承接)。

全部研发文档在 [docs/](docs/README.md)（需求/方案/数据/验证/参考索引）。技术方案：[docs/LLD/LLD-FEAT-002](docs/LLD/LLD-FEAT-002-Tauri正式实现方案.md)。

## 目录

```
src/                 前端（React）：modules/{projects,chat,git,editor,servers,knowledge,settings}
src-tauri/           后端（Rust）：commands/*、db.rs、ssh/、models.rs
docs/                研发文档（正式）+ tmp/（过程）+ 参考/（本地，不入库）
```

## 状态

v0.1：全部模块开发完成，构建链全绿（cargo build / tsc / vite build），应用级冒烟通过；运行时逐项验收与打包发布未完成。当前状态：**待用户验收**。
