# LLD-CR053：CLI 命令工具（Shell）选择实现方案

- 关联需求：[CR-053](../PRD/CR-053-CLI命令工具可选.md)、[STORY-070](../Plan/Story/STORY-070-CLI命令工具选择.md)（AC-01～08）、[FEAT-015](../Plan/Feature/FEAT-015-CLISDK装卸与会话可用性.md)。
- 本次设计范围：Windows 上为 `claude`／`codex`／`grok` 检测、保存与注入命令工具；**本轮不编码**，本文是实现前的方案与验证计划。
- 现状依据：`spawn_cli` 以参数数组直接启动 CLI（[`chat.rs`](../../src-tauri/src/commands/chat.rs)）；派发注入在 [`dispatch.rs`](../../src-tauri/src/commands/dispatch.rs)；SDK 检测与路径登记在 [`sdk.rs`](../../src-tauri/src/commands/sdk.rs)；设置落在 `setting_default` 表（[`db.rs`](../../src-tauri/src/db.rs)）；前端 CLI 卡片在 [`SettingsSdk.tsx`](../../src/modules/settings/SettingsSdk.tsx)。

## 1. 结论先行

1. **NestCraft 不引入 Shell 执行层**：仍直接 spawn CLI；只把"用哪个命令工具"作为启动环境变量／参数传给 CLI。
2. **能力分层落地**：Claude Code 可指定工具类型与 Git Bash 路径；Codex 标实验性、实测通过前只存偏好；Grok 只展示。
3. **不新增数据表**：复用 `setting_default`，键 `cli.shell.<cliId>`。
4. **不静默回落**：检测或校验失败必须可见；启动前复检失效则阻止并提示，用户可一键改「自动」。

## 2. 数据与设置契约

键：`cli.shell.<cliId>`，`cliId ∈ {claude, codex, grok}`，值为 JSON：

```json
{
  "mode": "auto | pwsh | windows-powershell | git-bash",
  "path": "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  "savedAt": 1763700000000
}
```

规则：

- 缺省或解析失败 → `auto`（与升级前一致），不报错、不改写用户设置。
- `mode=auto` 时 `path` 必须为空；其余模式必须为绝对路径。
- `path` 只在保存时写入服务端复核后的值；检测结果（版本、来源）不持久化，每次重新探测，避免陈旧版本误导。
- 不引入 `ShellProfile`、参数、环境变量脚本等扩展字段。

## 3. 检测协议

新增只读命令（方案层命名）：

```rust
struct ShellCandidate {
    kind: String,      // pwsh | windows-powershell | git-bash
    label: String,     // 界面文案
    path: Option<String>,
    version: Option<String>,
    source: String,    // fixed | path
    available: bool,
    detail: Option<String>, // 不可用原因，如 "未找到" / "仅 WSL 存根"
}
fn cli_shell_candidates(cli_id: String) -> Result<Vec<ShellCandidate>, String>;
```

候选与探测顺序：

| 类型 | 固定位置 | PATH 兜底 | 版本读取 |
| --- | --- | --- | --- |
| PowerShell 7 | `C:\Program Files\PowerShell\7\pwsh.exe`、`...\7-preview\pwsh.exe` | `resolve_command("pwsh")` | `pwsh -NoProfile -NonInteractive -Command "$PSVersionTable.PSVersion.ToString()"` |
| Windows PowerShell 5.1 | `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` | 不查 PATH | 同上（`powershell.exe`） |
| Git Bash | `C:\Program Files\Git\bin\bash.exe`、`C:\Program Files (x86)\Git\bin\bash.exe` | `resolve_command("bash")`，排除 `WindowsApps` 下的 WSL 存根 | `bash -c 'echo $BASH_VERSION'` |

要求：单次探测超时 3 秒、`CREATE_NO_WINDOW`、stdin 关闭；探测失败返回 `available=false` 与原因，不让整个命令失败。检测命令不得修改任何设置。

## 4. 保存与校验

```rust
fn cli_shell_save(cli_id: String, mode: String, path: Option<String>) -> Result<(), String>;
```

服务端复核（前端校验只用于即时反馈）：

1. `cli_id`、`mode` 枚举合法；
2. 非 auto 时路径为绝对路径、`is_file()`；
3. 文件名白名单：`pwsh.exe`、`powershell.exe`、`bash.exe`（大小写不敏感）；
4. `bash.exe` 不得位于 `WindowsApps`；
5. 写入 `setting_default`（`INSERT ... ON CONFLICT(scope,key) DO UPDATE`）。

错误返回稳定 code 与中文文案，前端映射为行内错误；不得把失败当作成功，也不得自动改回 auto。

## 5. 注入映射

在 `spawn_cli` 完成供应商环境注入之后（`strip_prefixes` 清理之后）统一调用 `apply_shell_env(cli_id, &mut cmd)`：

| CLI | mode | 注入 |
| --- | --- | --- |
| claude | auto | 不注入（CLI 自行选择，固定位置优先 PowerShell 7） |
| claude | pwsh / windows-powershell | `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` |
| claude | git-bash | `CLAUDE_CODE_GIT_BASH_PATH=<path>`，并 `CLAUDE_CODE_USE_POWERSHELL_TOOL=0` |
| codex | auto | 不注入 |
| codex | pwsh / windows-powershell | 按实测结论注入 `PWSH` / `POWERSHELL` / `SHELL`（**未实测前不注入**） |
| codex | git-bash | 同上，未实测前不注入 |
| grok | 任意 | 不注入；保存入口不提供 |

注：`CLAUDE_CODE_USE_POWERSHELL_TOOL` 与 PowerShell 路径的固定候选来自 claude 2.1.318 二进制内字符串；其确切语义（是否默认开启、关闭后是否回退 Bash）需在编码授权后实测，不得直接宣称生效。Codex 的 `--ignore-user-config` 已使 `~/.codex/config.toml` 不参与，因此任何 shell 选择只能由 NestCraft 注入。

## 6. 启动前复检与失败处理

- 新会话启动前读取设置并复检路径；失效时**阻止启动**并返回明确错误，提供「改选自动」的入口；不静默改用其他 Shell。
- 检测超时／无权限读取目录：标为"未知"，不标"未安装"；保留上次成功值供用户判断。
- 会话进行中修改设置：只影响之后的新会话（与现有 CLI 偏好一致）。
- 错误信息只含路径与原因，不含环境变量值或密钥。

## 7. 前端接入点

- 位置：`SettingsSdk.tsx` 的 `cliBody` 中，权限模式之后、保存按钮之前；复用现有 `Field`、`SettingsSwitch` 与卡片样式。
- 数据：初次展开时并行请求 `cli_shell_candidates` 与 `cli_shell_get`；保存复用现有 `operation()` 串行锁，避免重复提交。
- 状态：候选加载中、检测中、失效、保存中、已保存；与设计稿 S-01～S-08 一一对应。
- 可访问性：使用 `fieldset`／`label`＋原生 radio；检测中用 `aria-busy`，错误用 `role="alert"`。

## 8. 数据库与权限

- 数据库：复用 `setting_default`，**无新表、无迁移**。
- 权限：命令工具不参与权限判定；`STORY-049` 的权限模式、沙箱与审批不变。
- 安全：不拼 Shell 字符串，不执行用户输入的任意命令；仅校验并传递路径。

## 9. 实现步骤（获编码授权后）

1. `sdk.rs` 或新 `commands/shell.rs`：候选检测 + 单测（临时目录假 exe、缺失路径、超时）。
2. `cli_shell_get`／`cli_shell_save`＋校验单测（白名单、绝对路径、WindowsApps 排除）。
3. `chat.rs` 注入函数＋单测（构造 `Command` 后断言 env，不真正 spawn）。
4. `SettingsSdk.tsx` 接线，按 UI-CR053-v1 实现；窄屏与深色回归。
5. 真实 CLI 实测矩阵（下表），结果回填 `REPORT-CR053`；未通过项保持"实验性"或退回"仅展示"。
6. 设计—软件成对截图与视觉对照后交用户验收。

## 10. 验证计划

| 项 | 方法 | 通过标准 |
| --- | --- | --- |
| 候选检测 | 单测 + 手测 | 三类候选路径/版本正确；缺失与 WindowsApps 存根被排除 |
| 保存校验 | 单测 | 非法 mode／相对路径／非白名单文件名全部拒绝 |
| 注入 | 单测断言 env；真实 CLI 实测 | claude 在 pwsh 下 `$PSVersionTable` 为 7.x；git-bash 下 `$BASH_VERSION` 非空 |
| 失效处理 | 手测 | 删除 pwsh 后重新检测标红、保存禁用、启动被阻止并提示 |
| 兼容 | 手测 | 旧配置无键时按 auto，行为与升级前一致 |
| 视觉 | 成对截图 | 8 个场景与设计稿一致；滚动条按 UI-SCROLL-001 |

## 11. 未决、假设与风险

- Q-053-01～05 见 [PRD §7](../PRD/CR-053-CLI命令工具可选.md#7-待确认问题)。
- 假设：Claude Code 的 PowerShell 候选与开关在该版本稳定；升级后需复测。
- 风险：Codex 的环境变量语义若不成立，该 CLI 只能保持"仅展示"；Grok 无可用项。
- 风险：非标准安装位置的 pwsh 无法被 Claude Code 识别，界面只能提示，不能指定路径。
- 变更记录：

| 日期 | 版本 | 变更 | 依据 |
| --- | --- | --- | --- |
| 2026-11-21 | v1 | 建立设置键、检测、保存校验、注入映射与验证计划；未编码 | 用户确认只做需求与设计 |