# RESEARCH-010：本地搜索工具授权机制对照（PI-Desktop / ZCode / DSH Desktop）

- 日期：2026-11-26；负责人：lead；性质：只读源码调研，未复制代码、未构建、未运行三个参考项目。
- 来源：用户 2026-11-26 反馈「本地搜索工具不应该单独授权，应该继承会话权限」，并指定调研 `D:\github\PI-Desktop`、`docs/参考/ZCode`、`D:\github\deepseek-harness-desktop` 三个项目的本地文件搜索工具授权方式。
- 结论先行：**三个项目都没有「在设置页为本地搜索单独配置授权目录」这种模式**。它们的共同做法是：本地搜索工具默认就是可用的只读工具，默认范围＝当前会话的工作区／工作目录；只有越过工作区访问外部路径时才触发授权（按次或按会话记住），或由权限规则／沙箱模式治理。

## 1. 问题

本项目 CR-093 已实现 `fs_grep` / `fs_glob`，但授权模型是：`setting_default(scope=projectId, key='search.authDirs')` 中默认空数组，未配置时工具直接报「尚未授权任何本地搜索目录，请到「设置 · 搜索」为该项目的授权目录，再重试」。用户认为这是多此一举：会话本身已经绑定了项目与工作目录，应当继承会话权限，而不是单独开一份授权。

## 2. 调研对象与方法

| 对象 | 本地位置 | HEAD | 许可 | 读取方式 |
| --- | --- | --- | --- | --- |
| PI-Desktop | `D:\github\PI-Desktop`（外部目录，未复制入本仓库） | `5c150c50`（2026-09-09） | LGPL-3.0 | 只读源码 |
| ZCode | `docs/参考/ZCode` | `a4b44451`（v4.0.0，2026-11-23） | Apache-2.0 | 只读源码 |
| DSH Desktop | `D:\github\deepseek-harness-desktop`（外部目录，未复制入本仓库） | `4989742a`（2026-09-22） | MIT | 只读源码；权限内核参考本机安装的 DSH 文档 |

三个项目均未运行，未验证其真实交互；结论仅来自源码与随仓文档。

## 3. 逐项结论

### 3.1 PI-Desktop（Rust 宿主 + React 桌面）

**授权模型：会话工作区 + 会话临时目录默认放行；只有显式路径在工作区外才进入授权。**

- 工具实现：`crates/host-core/src/tools/mod.rs` —— `Glob` / `Grep` / `Read` 共用 `allow_external_paths` 标志；`tool_glob`（约 L1517）与 `tool_grep`（约 L1574）通过 `resolve_tool_path_with_external` 解析路径。
- 路径判定：`crates/host-core/src/workspace.rs:189-236` —— `resolve_tool_path` 先按会话工作区包含校验，再按会话 scratch 目录校验；`resolve_tool_path_with_external` 只在「工作区外 + 已获授权」时返回 `ToolRoot::External`。
- 授权判定：`crates/host-core/src/rpc/mod.rs:629-651` —— `requires_external_path_permission` 只对 `Read / Glob / Grep / Write / Edit` 的显式 `path` 参数判断是否越出工作区与 scratch；相对路径与 `..`、符号链接都走同一解析器，无法绕过。
- 审批结果：`crates/host-core/src/permissions.rs:168-223` —— 外部路径访问时：`auto` 模式直接 `AllowOnce`；会话已授予该工具（`session_grants[sessionId]` 含工具名）则 `AllowSession`；否则返回 `None` 弹审批卡。审批卡（`apps/desktop/src/components/PermissionCard.tsx`）提供「拒绝 / 允许本会话 / 允许一次」，120 秒超时自动拒绝。
- 权限模式：`crates/host-core/src/sessions.rs:53-63` —— `permission_mode` 持久化在会话上（`inherit / ask / accept-edits / auto`），是「会话上的权限」。
- 契约模式：`permissions.rs:114-119` 的 `plan_mode_allows` 对 Plan/Goal 模式给出工具白名单硬拒绝（Read / Glob / Grep / Bash / BrowserPreview / new_context），`auto` 也不能放开。

**要点**：Glob/Grep 本身是低风险只读工具，正常范围内**完全不需要授权**；「单独授权」只发生在用户显式指向工作区外路径时，且授权可选择「仅本会话」。设置页没有「本地搜索授权目录」这种配置。

### 3.2 ZCode（CLI Agent + 桌面/Web/服务端）

**授权模型：Grep/Glob 声明为只读低风险工具、默认不需审批；执行范围＝工作目录 + 项目附加目录；越界与高风险靠权限规则（可持久化）治理。**

- 工具声明：`apps/zcode-cli/packages/core/src/tool/handlers/grep.ts:140-169` —— `readOnly: true`、`riskLevel: "low"`、`needsApproval: false`、`permission: { permission: "read", patternSources: ["path","input"], alwaysAllowPatternSources: ["path","input"] }`。
- 路径策略：`apps/zcode-cli/packages/core/src/tool/path-policy.ts:36-39` 明确注释「当前版本故意不硬阻止工作区外路径」，原因是子代理可能需要查看用户指定的兄弟仓库或外部文件，等文件系统权限适配层具备显式 ask/deny 规则再收紧。也就是说搜索范围默认跟随 `workingDirectory` / `workspaceRoot`，但不在路径层硬拦。
- 工作目录与附加目录：`packages/services/src/project/index.ts:299-338`、`packages/services/src/project-storage/project-repository.ts` 与 `packages/shared/src/zcode-protocol/index.ts` —— 项目有 `roots`，派发任务时作为 `additionalDirectories` 随会话/任务传递，执行目录＝workspacePath + additionalDirectories。
- 权限规则：`apps/zcode-cli/packages/core/src/tool/executor/permission-rules.ts` 与 `permission-suggestions.ts` —— 审批后可 `addRules` 持久化 allow 规则，规则内容为「工具名 + ruleContent（path / pattern / command / url 等）」；另有 `permission-rules-persistence.ts`。
- 权限模式：`packages/shared/src/subagent-profile.ts`、`packages/ui/src/i18n` —— default / acceptEdits / auto / bypassPermissions / dontAsk / plan 等档位。
- 内嵌搜索分支：`apps/zcode-cli/packages/core/src/runtime/methods/embedded-search-branch.ts` —— Bash 可用时默认隐藏独立 `Glob`/`Grep`，改走内嵌搜索（`embedded-search/*`），搜索因此继承 Bash 的权限与只读策略。

**要点**：ZCode 没有「设置页授权目录」；搜索默认可用，范围由工作目录 + 项目附加目录决定，个别路径靠规则收放。

### 3.3 DSH Desktop（Tauri 外壳 + DSH 内核）

**授权模型：外壳不实现搜索工具，也不实现 Agent 权限；完全继承 DSH 内核的「沙箱模式 + 审批策略」。**

- 外壳边界：`src-tauri/src` 全量检索只有通知权限、WebView2 权限、文件权限等操作系统级内容；`packages/dsh-tauri` 是客户端插件与宿主桥，没有 Agent 工具定义或工具权限模型。
- DSH 沙箱（本机安装版文档 `docs/subsystems/sandbox.zh.md`）：`SandboxMode = read-only | workspace-write | danger-full-access`，只约束**文件写效果**；`read-only` 拒绝写入、`workspace-write` 允许写工作区根 + 受支持额外根 + 临时区、`danger-full-access` 绕过隔离。**读不受沙箱约束**（Windows ACL runner 读取不受限）。
- 会话边界：`docs/subsystems/sandbox.zh.md` —— 普通工具调用从调用会话的不可变 cwd 派生 `workspaceRoot`；完成的 Session 注册可增加「额外可写根」，且是 runtime-only（resume/fork 后失效）。
- 权限预设：`docs/subsystems/permission-presets.zh.md` —— 预设把沙箱模式与审批策略捆绑：`workspace-write`（workspace-write + ask）、`danger-full-access`（danger-full-access + never）、`auto`（danger-full-access + ask，由 Auto review 注册）。
- 审批策略：`docs/subsystems/approval.zh.md` —— `ask` 交给应答者链，`never` 一律拒绝。

**要点**：DSH 的本地搜索（grep/glob）是读工具，沙箱不拦读；授权体现在「写范围」和「高风险操作审批」上，搜索本身没有单独的目录授权配置。会话 cwd 就是工作区边界，额外范围通过会话内注册或审批扩展。

## 4. 对照表

| 维度 | PI-Desktop | ZCode | DSH（含 Desktop） | 本项目 CR-093 现状 |
| --- | --- | --- | --- | --- |
| 搜索工具默认可用 | 是（Glob/Grep 低风险） | 是（needsApproval=false） | 是（读工具） | **否**：默认空授权，直接报错 |
| 默认搜索范围 | 会话工作区 + scratch | 工作目录 + additionalDirectories | 读不受沙箱限制；工具按自身路径规则 | **无默认范围**，必须设置页添加目录 |
| 越界访问治理 | 审批卡：拒绝/允许本会话/允许一次 | 权限规则（可持久化 allow/deny） | 沙箱管写 + 审批策略 | 无越界概念，只认白名单 |
| 授权存储 | 会话级 `session_grants`（工具名）；`permission_mode` 持久化在会话 | 规则集持久化（工具+path/pattern） | 会话 cwd 边界；额外可写根 runtime-only；预设按会话 | 按项目存 JSON 目录数组 |
| 设置页单独授权目录 | 无 | 无（只有项目附加目录） | 无 | **有**（「本地搜索授权目录」卡片） |

## 5. 对本项目的影响与建议

1. **行业对照支持用户的判断**：三个项目都不要求「先在设置里授权目录才能搜索」；本地搜索是默认可用的只读能力，授权只针对越过会话工作区的访问。
2. **方案 A 可以更贴近参考项目**：`fs_grep` / `fs_glob` 默认范围＝会话绑定项目的根目录（NestCraft 的会话 cwd），无需任何前置配置；设置页「本地搜索授权目录」降级为「额外授权目录（可选）」，未配置时不再阻断，只影响能否搜项目外路径。
3. **「会话级授权」在 NestCraft 的落点**：参考 PI-Desktop 的 `session_grants`（按会话 + 按工具记住「允许本会话」）。NestCraft 的 CLI 是非交互适配器，当前没有人工审批通道（`ChatPanel.tsx` 已注明「非交互 CLI 适配器未提供可用的人工审批流程，未自动放行」），所以短期不宜把「越界搜索」做成 CLI 内审批卡；可行做法是：
   - 近期：默认项目根 + 设置页额外目录（可选），即方案 A；
   - 中期：由平台侧提供「会话授权」面板，把授权落到 session（类似 PI 的 allow-session），供平台会话使用，CLI 会话仍以项目根为默认范围。
4. **权限档位语义要对齐**：PI 的 `ask / accept-edits / auto`、DSH 的 `read-only / workspace-write / danger-full-access` 与 NestCraft 的 CLI 档位（default / plan / agent）以及平台助理权限（readonly / limited / full）语义接近，但都不直接约束「读」。因此不建议让 `fs_grep` / `fs_glob` 依赖权限档位做范围判断；档位只用于决定「越界访问是否需要授权/是否允许」。
5. **UI 文案**：设置页卡片说明应改为「默认已包含当前项目根目录；此处仅添加项目外的额外目录」，空态不再显示「尚未授权任何目录」的阻断提示。

## 6. 未验证与限制

- 三个项目均未运行，未实测其审批卡、规则持久化和 additionalDirectories 的真实交互；结论来自源码与随仓文档。
- ZCode 的 `path-policy.ts` 注释表明「工作区外不硬拦」是当前版本的临时状态，后续可能收紧；本结论按其当前源码记录。
- DSH 的权限内核以本机安装版（Desktop profile）文档为准；`deepseek-harness-desktop` 仓库本身不含权限实现，只证明外壳不做二次授权。
- 未核对三个项目各自的完整传递依赖与分发许可；本调研不含代码复制，后续如需复制须另核 LGPL / Apache-2.0 / MIT 义务。

## 7. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-11-26 | 建立本调研：只读核对 PI-Desktop、ZCode、DSH Desktop 的本地搜索工具授权方式，结论与建议见 §5。 |
