# ADR-002：Tauri 桌面技术栈选型

- 状态：选定，2026-11-19；关联 [CR-015](../PRD/CR-015-启动Tauri正式实现.md)。
- 决策依据：用户明确倾向 Tauri 开发；本机已具备 Node 24 / Rust 1.99 (MSVC) / pnpm 工具链；产品为单用户本地工作台。

## 选定方案

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 应用壳 | **Tauri 2**（Windows 优先） | 用户指定；安装包小、前端自由度高；WebView2 系统自带 |
| 前端 | **React 18 + TypeScript + Vite** | 生态与参考项目一致（参考会话 GUI 与多个插件前端均为 React）；不引入重型 UI 库，自建 CR-014 白蓝设计令牌 |
| 路由/状态 | 自建轻量路由（基于应用状态）+ React Context/Reducer | 模块数量可控（项目/知识库/服务器/设置），避免额外依赖；与仿真原型的页面切换语义一致 |
| 持久化 | **SQLite（rusqlite，bundled）** | ADR-001 已选定；本地单用户，无服务端 |
| 需求/知识正文 | **Markdown 文件（项目 docs 目录/受管知识源目录）** | ADR-001：正文唯一事实来源，SQLite 只存索引与业务元数据 |
| AI 会话执行 | **Rust 子进程管理**：spawn `claude` / `codex` CLI 非交互模式，stdin/stdout 流式事件经 Tauri Channel/Event 推送前端 | 参考会话 GUI 的桥接协议（事件标签行）在 Rust 中复刻；密钥不落日志 |
| Git | **spawn git CLI**（后端命令封装） | 与参考 Git 面板实现方式一致；Windows 下 git 可用；避免 git2 原生编译负担 |
| SSH/终端 | **russh + russh-sftp**（Rust）+ **xterm.js**（前端） | TermX 的逻辑形态在 Rust 复刻；纯 Rust 避免 libssh2 链接问题；终端数据经 Tauri Channel 流式传输 |
| 代码编辑器 | **CodeMirror 6** | 轻量、可控、桌面 webview 性能好；按 openidea 的文件树/编辑器交互逻辑落地 |
| Markdown 渲染 | **marked + DOMPurify**（正文阅读、预览、TOC 提取） | 知识库三栏阅读需要 TOC 与安全渲染（不执行脚本） |
| 安装队列/任务 | Rust tokio 任务 + 事件推送 | 复刻 SDK 管理的任务状态机（queued/running/done/failed/cancelled/timeout） |

## 备选与取舍

- **Electron**：参考项目多为 Electron/Node 形态，移植成本更低，但用户明确倾向 Tauri，且 Tauri 的 Rust 后端天然满足"密钥不经前端、进程管理可控"的安全要求（ADR-001-B）。
- **git2/libgit2**：编译依赖重、中文路径历史问题多；git CLI 输出解析逻辑可从参考面板直接对照移植。
- **Monaco**：体积大、启动慢；CodeMirror 6 满足行号/高亮/多语言需求。若后续需要 VSCode 级扩展能力再评估（另记 ADR）。
- **sqlx**：异步编译期校验强，但 rusqlite 同步模型与 Tauri command（线程池）组合更简单可控；数据量小。

## 影响与约束

- 密钥、会话正文、授权等业务数据一律在 Rust 进程内处理；前端只接收掩码后的展示数据（沿用 CR-012 语义）。
- CLI 适配器生成短期受管配置或启动参数，不写入用户原生 CLI 配置（ADR-001-B）。
- 知识检索网关在 Rust 网关层执行：每次调用解析会话项目身份并复检授权（DB-FEAT-001 第 3 节）。
- 构建链：`npm run build`（前端）+ `cargo build`（后端）；开发 `tauri dev`；验证以 `cargo check` + 前端构建 + 冒烟测试为最低门槛。
