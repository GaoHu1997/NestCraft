# STORY-070：CLI 命令工具选择

- 类型：用户故事；所属 [FEAT-015](../Feature/FEAT-015-CLISDK装卸与会话可用性.md)（唯一父项）／[PRD CR-053](../../PRD/CR-053-CLI命令工具可选.md)。
- 来源与确认：用户 2026-11-21 提问能否指定 CLI 使用的 cmd 工具，并确认「只调整需求和设计」。
- 负责人／优先级／状态／依赖：主代理／P1／**待验收（正式实现完成，2026-11-21，见文末实现记录）**／依赖 CLI 能力实测（Claude Code 固定路径已实测；Codex 环境变量语义未实测、维持不注入）。
- 目标：作为使用本机 PowerShell 7 的用户，我希望在 NestCraft 里看清并指定每个 CLI 的命令工具，以便 CLI 内部命令使用我期望的 Shell，而不是只能去改 CLI 自己的配置。
- 本次包含：三个 CLI 的检测与展示；在 CLI 支持时提供选择与保存；保存前校验；派发时注入；能力分层标注。
- 本次不包含：自定义 Shell 参数／profile；Claude Code 自定义 pwsh 路径；macOS／Linux；任何权限语义变化；本轮代码修改。

## 验收标准

- **AC-01**：给定已安装的 Claude Code／Codex／Grok CLI，当打开「设置 → SDK 与 CLI → CLI 管理」并展开卡片时，每个卡片显示「命令工具（Shell）」分组、当前值、检测时间与「重新检测」；默认值为「自动（CLI 默认）」，升级前行为不变。
- **AC-02**：候选列表来自本机真实检测，至少覆盖 PowerShell 7、Windows PowerShell 5.1、Git Bash；每项显示绝对路径与版本，检测不到的类型不出现或标为不可用，不伪造版本。
- **AC-03**：选择候选并点保存后写入设置，重新打开设置仍保留；配置中无该字段时按「自动」读取，不报错。
- **AC-04**：保存前校验所选路径存在且文件名属于 `pwsh.exe`／`powershell.exe`／`bash.exe`；失效时该行标红并显示「未找到」，保存禁用，提示重新检测或改选自动，不静默回落到其他 Shell。
- **AC-05**：派发新会话时按 CLI 能力注入所选命令工具（Claude Code：PowerShell 工具开关／`CLAUDE_CODE_GIT_BASH_PATH`；Codex：按实测结论注入环境变量；Grok：不注入），且只影响之后的新会话，不修改进行中的会话。
- **AC-06**：每个 CLI 明确标注可控程度——Claude Code「可指定类型」、Codex「实验性（待实测）」、Grok「仅展示」；Grok 不出现可点击的假选择，Codex 的未验证语义不得写成已生效。
- **AC-07**：检测中、检测失败、保存失败均有可见状态并保留上次成功值；窄屏 390、深色主题与键盘操作下可选择和保存；设置区滚动条按 UI-SCROLL-001 只在实际滚动时显示。
- **AC-08**：本轮只提交需求、设计稿与方案文档；不改 `src/`、`src-tauri/`、依赖或构建产物；设计稿可打开、状态覆盖与资源 hash 登记完整，并明确标注"设计稿不是软件截图"。

## 方案

- [LLD-CR053](../../LLD/LLD-CR053-CLI命令工具选择实现.md)：设置键、检测协议、注入映射、安全与回退。
- 复用处：[STORY-030](STORY-030-CLI-SDK管理正式实现.md) 的 SDK 检测与路径登记、[STORY-049](STORY-049-按CLI适配的会话权限契约.md) 的权限边界、`dispatch.rs` 的派发注入。

## UI 准入

- 场景／状态：S-01 默认、S-02 指定 pwsh、S-03 路径失效、S-04 检测中、S-05 已保存、S-06 深色、S-07 1024、S-08 390 单列。
- 可视设计资源与版本：[UI-CR053-v1](../../UI/文档/UI-CR053-CLI命令工具选择.md)／[设计稿](../../UI/cli-shell-design/index.html)（含 8 张渲染图与 hash）。
- 覆盖检查：三个 CLI 的能力分层、默认／选择／失效／检测中／保存后全部有可视状态；不适用项（macOS／Linux、自定义参数）已在 PRD 说明。
- 确认／执行授权：需求与设计已获用户「只调整需求和设计」授权；**无正式编码授权**，不得进入开发。
- 先设计后软件记录：本轮仅设计，未修改软件；软件实现需另立编码授权并在实现后做设计／软件成对视觉对照。

## 实现位置

- 本轮无代码实现。预期位置（方案层，未确认）：`src/modules/settings/SettingsSdk.tsx`、`src-tauri/src/commands/sdk.rs`、`src-tauri/src/commands/chat.rs`、`src-tauri/src/commands/dispatch.rs`。

## 验证结果

| AC | 方式 | 预计 | 实际 | 证据／时间 |
| --- | --- | --- | --- | --- |
| 01～08 | 设计稿静态与渲染检查 | 设计可查看、状态齐全 | 通过（仅设计层） | [REPORT-CR053](../../Test/REPORT-CR053-CLI命令工具设计验证.md)，2026-11-21 |
| 05 | 真实 CLI 注入 | 需实测 | 未执行 | 方案 §实测计划，未授权执行 |

## 验收结论

- 需求已确认；**设计待用户评审**；未进入开发，未验收。（以下实现记录已更新当前状态，见「正式实现记录」）
- 阻塞／遗留：Q-053-01～05（见 PRD §7）；Codex 注入语义与 Claude Code 实际 Shell 需在编码授权后用真实 CLI 实测。

## 正式实现记录（2026-11-21）

- **授权依据**：用户 2026-11-21 原话「我更正了需求和设计，你需要对照进行开发和调整」＝正式编码授权，范围仅 CR-053 照 [LLD-CR053](../../LLD/LLD-CR053-CLI命令工具选择实现.md) 实现。**AC-08 为设计批次记录（原「本轮只提交需求设计」）**：按新授权转入软件实现执行，AC-08 原文不改写，其结论按新授权关闭（设计资源、状态覆盖与 hash 依然完整；设计稿不是软件截图的标注继续有效）。
- **实现位置**：`src-tauri/src/commands/shell.rs`（新增：探测/读取/保存+复核/复检/注入映射，16 项单测）、`src-tauri/src/commands/chat.rs`（spawn_cli 启动前复检＋供应商注入后注入 shell 环境）、`src-tauri/src/lib.rs`＋`commands/mod.rs`（注册）、`src/api/index.ts`（Shell API）、`src/modules/settings/SettingsSdk.tsx`（命令工具分组，能力分层标注）＋`settings.css`（分组样式）、`src/smoke/runner.ts`（7 项 IPC 断言）。选择新建独立 `shell.rs` 而非并入 `sdk.rs`：后者职责为 npm 安装任务状态机（460 行），Shell 探测/注入是独立关注点且被 chat.rs 引用，独立模块避免耦合、便于单测。
- **验证结果**：cargo test 82/82（含 shell 16 项）；`tsc --noEmit`／`npm run build` exit 0；IPC 冒烟 **106/106**（[smoke-report-cr053.md](../../Test/smoke-report-cr053.md)，含失效路径阻止 chat_send、损坏 JSON→auto、codex 只存偏好）；真实 claude+tierflow 对话回复 "OK" 与真实工具调用通过。视觉成对证据 10 张（[cr053-sw](../../Test/screenshots/cr053-sw/)），AC 逐条结论与未验证项见 [REPORT-CR053-正式软件实现](../../Test/REPORT-CR053-正式软件实现.md)。
- **状态流转**：设计中 → 开发中 → 验证中 → **待验收**（技术验证通过，待用户验收）。
- **偏离与遗留**：S-08 390 窄屏未通过（VIS-DEV-01：设置弹窗壳层 pane-resize 在窄视口关闭 nav 但未收列宽，前序未提交工作引入的存量缺口，非本批引入；归属设置弹窗壳层修复）。claude 注入生效性会话实测（pwsh 下 `$PSVersionTable`/git-bash 下 `$BASH_VERSION`）未执行，注入映射由单测逐行断言证明；codex 语义未实测、维持不注入。详见报告 §6。
- **过程修正（如实记录）**：实现期截图核验发现失效行误显示候选版本，已改为「<失效路径> · 未找到」（与设计稿一致）；冒烟基建修复 `smoke_use_real_claude` 的 mockbin 路径分隔符失配（正/反斜杠归一化）与既有陈旧断言（`ST-T1`→`ST-0-T1`、演示推进须在真实工具记录前），均属测试基建/断言修正，不改业务行为。