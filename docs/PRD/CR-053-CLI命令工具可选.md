# CR-053：CLI 命令工具（Shell）可选

- 状态：**需求已确认（2026-11-21）；设计待评审；未进入开发**。
- 来源：用户 2026-11-21 提问「NestCraft 中能否指定 CLI 使用什么 cmd 工具，比如本地装了 PowerShell 7，能否指定它使用这个工具」，随后明确「可以，只调整需求和设计」。
- 关联：[FEAT-015](../Plan/Feature/FEAT-015-CLISDK装卸与会话可用性.md)（唯一父项）、[EPIC-007](../Plan/Epic/EPIC-007-AI设置与引擎管理.md)、[STORY-070](../Plan/Story/STORY-070-CLI命令工具选择.md)；能力与权限边界沿用 [STORY-049](../Plan/Story/STORY-049-按CLI适配的会话权限契约.md)、[STORY-030](../Plan/Story/STORY-030-CLI-SDK管理正式实现.md)。
- 设计：[UI-CR053-v1](../UI/文档/UI-CR053-CLI命令工具选择.md)／[可查看设计稿](../UI/cli-shell-design/index.html)／[实现方案](../LLD/LLD-CR053-CLI命令工具选择实现.md)。
- 不新增 Epic／Feature；新增 STORY-070 与 8 条 AC。

## 1. 背景与目标

NestCraft 以参数数组直接启动 `claude` / `codex` / `grok`，自身不经过 Shell（`src-tauri/src/commands/chat.rs` 的 `spawn_cli`）。CLI 内部执行命令时用哪个 Shell，由 CLI 自己决定：用户装了 PowerShell 7，却无法在 NestCraft 里查看或指定，只能去改 CLI 自己的配置或环境变量，且不同 CLI 的支持程度不同。

目标：让用户在「设置 → SDK 与 CLI → CLI 管理」看清每个 CLI 实际使用的命令工具，并在 CLI 支持的前提下指定它；指定失败时给出明确原因，而不是静默换一个 Shell 继续跑。

## 2. 本次范围／不做事项

**包含**

1. 三个已安装 CLI 的「命令工具（Shell）」分组：展示当前值与检测结果（路径、版本、来源）。
2. 候选检测：PowerShell 7（`pwsh.exe`）、Windows PowerShell 5.1（`powershell.exe`）、Git Bash（`bash.exe`）；检测失败时明确不可用。
3. 在 CLI 能力允许时提供选择，并写入设置；默认「自动」保持现状。
4. 派发时按所选值注入；只影响之后的新会话。
5. 保存前校验；失效时行内报错并禁止保存，不静默回落。
6. 每个 CLI 标注可控程度（可指定类型／实验性／仅展示），不得把仅展示写成已生效。

**不包含**

1. 不改变 NestCraft 启动 CLI 的方式（仍不拼 Shell、不经过 cmd.exe）。
2. 不改变 CLI 原生权限模式、沙箱与审批；命令工具不是权限开关。
3. 不支持给 Shell 传任意参数、环境变量脚本或自定义 profile。
4. 不支持 Claude Code 的自定义 PowerShell 安装路径（该 CLI 只从固定绝对位置识别，见 §4）。
5. 本批不覆盖 macOS／Linux 的 Shell 选择；界面不出现假选项。
6. 不在本轮修改任何正式源码、配置或依赖。

## 3. 业务流程

1. 打开设置 → SDK 与 CLI → CLI 管理，展开某个 CLI。
2. 「命令工具（Shell）」显示当前值（默认「自动（CLI 默认）」）、检测时间与候选列表。
3. 点「重新检测」刷新候选；检测中禁用候选与保存。
4. 选择候选后点该卡片的「保存」；校验通过写入设置并提示「仅对之后的新会话生效」。
5. 所选路径已不存在时，候选行标红、显示「未找到」，保存禁用，提示重新检测或改选自动。
6. 派发新会话时读取该 CLI 的设置并注入；进行中的会话不受影响。

## 4. 能力矩阵（设计基线，不得跨层宣称）

| CLI | 可控程度 | 可选值 | 注入方式（方案层） | 版本依据 |
| --- | --- | --- | --- | --- |
| Claude Code | 可指定类型 | 自动／PowerShell 7／Windows PowerShell 5.1／Git Bash | `CLAUDE_CODE_USE_POWERSHELL_TOOL`、`CLAUDE_CODE_GIT_BASH_PATH` | claude 2.1.318 二进制内的 PowerShell 固定候选与 `PowerShellTool` |
| Codex | 实验性（待实测） | 自动／PowerShell 7／Windows PowerShell 5.1／Git Bash | 环境变量传递，语义待实测；派发带 `--ignore-user-config`，用户 config.toml 不生效 | codex-cli 0.166.0 的 `POWERSHELL`／`PWSH`／`SHELL` 引用 |
| Grok CLI | 仅展示 | 自动（不可选） | 无 | grok 1.0.77 未发现配置项 |

Claude Code 的 PowerShell 识别顺序为固定绝对路径（不查 PATH）：`C:\Program Files\PowerShell\7\pwsh.exe`、`C:\Program Files\PowerShell\7-preview\pwsh.exe`、`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`、`cmd.exe`。因此「指定 PowerShell 7」只在该位置存在时成立；这不是 NestCraft 能绕过的限制。

## 5. 规则与边界

- 命令工具属于**执行环境偏好**，不属于权限；权限模式、沙箱与审批仍由 CLI 与既有契约控制。
- 设置默认「自动」；旧配置无该字段时按自动处理，行为与升级前一致。
- 检测与保存失败都必须可见；禁止"检测失败就当作自动"的静默处理。
- 检测结果只来自本机真实探测，不伪造版本；示例路径必须在设计文档中标注为样例。
- 只保存绝对路径；候选类型限定为 `pwsh.exe`、`powershell.exe`、`bash.exe`，不接受任意可执行文件。
- 不把命令工具的路径、版本写入日志之外的敏感位置；错误信息不包含用户目录以外的隐私内容。
- 窄屏与深色主题可用；键盘可直接完成选择与保存（使用原生 radio/button 语义）。
- 新会话启动前复检所选路径；失效时阻止启动并提示改选「自动」，不静默回退到其他 Shell。

## 6. 验收标准

见 [STORY-070 AC-01～08](../Plan/Story/STORY-070-CLI命令工具选择.md)。UI 场景与证据见 [UI-CR053-v1](../UI/文档/UI-CR053-CLI命令工具选择.md)。

## 7. 待确认问题

| 编号 | 问题 | 建议 | 影响 |
| --- | --- | --- | --- |
| Q-053-01 | 是否接受 Claude Code 只能选工具类型、不能自定义 pwsh 路径 | 接受，并在界面写明原因 | 若不接受，需要 CLI 侧新增支持，超出本批 |
| Q-053-02 | Codex 在实测通过前是否上线选择项 | 先上线但标「实验性」，只记录偏好 | 若要求先实测，需临时脚本验证三种 CLI |
| Q-053-03 | 是否提供 `cmd.exe` 作为显式选项 | 不提供；仅作为 CLI 自动回退 | 提供会扩大支持面且难验证 |
| Q-053-04 | 选择粒度是全局 per-CLI 还是 per-项目／会话 | 本批全局 per-CLI | 细粒度需要新数据结构与界面 |
| Q-053-05 | 是否同批支持 macOS／Linux | 本批不做，界面不出现假选项 | 跨平台需各自的 shell 检测与注入 |

## 8. 确认记录

| 日期 | 范围 | 依据 |
| --- | --- | --- |
| 2026-11-21 | 新增 CLI 命令工具选择的需求与设计；不改代码 | 用户「可以，只调整需求和设计」 |

## 9. 变更记录

| 日期 | 编号 | 变更 | 依据 |
| --- | --- | --- | --- |
| 2026-11-21 | CR-053 | 建立需求、STORY-070／8 条 AC、UI-CR053-v1 设计稿与实现方案；未改正式源码 | 用户提问并确认只做需求与设计 |