# LLD-CR099：正式开发授权与执行包

- 关联需求：[CR-099](../PRD/CR-099-设置中心评审二轮与能力管理合并.md)
- 设计基线：[UI-CR099-v1](../UI/文档/UI-CR099-设置评审二轮与能力管理.md)（`workbench-v4/cr099.js` / `cr099.css`）
- 工作层级：**正式编码**（用户 2026-11-26「代码实现了没，需要实现」＝明确编码授权）
- projectId：`AI-Delelovelop`／featureId：`FEAT-013 + FEAT-014 + FEAT-015`（同一批设置评审，拆三个特性验收）
- 会话范围：本会话只实现 CR-099 的 11 条 AC 及其直接依赖；不扩到其它 Feature。

## 允许修改的文件范围

| 模块 | 文件 | 涉及 AC |
| --- | --- | --- |
| 设置左栏与页签 | `src/modules/settings/index.tsx` | AC-11 |
| 通用页 | `src/modules/settings/SettingsGeneral.tsx`、`general.css` | AC-01、AC-02 |
| 模型管理 | `src/modules/settings/SettingsModels.tsx`、`cr085-models.css` | AC-03、AC-04、AC-05、AC-06 |
| 模型检测 | `src/modules/settings/SettingsModelProbe.tsx`、`cr085-models.css` | AC-07、AC-08 |
| SDK 与 CLI | `src/modules/settings/CliRoute.tsx`、`cliCapabilities.ts`、`SettingsSdk.tsx` | AC-09、AC-10 |
| 能力管理 | `src/modules/settings/index.tsx`、新增 `AbilityCenter.tsx` | AC-11 |
| 平台 runtime 身份 | `src-tauri/src/commands/platform_agent.rs` | AC-02（运行时消费点） |
| 权限白名单 | `src-tauri/src/commands/chat.rs`（`validate_permission`） | AC-10（实现前置） |

不修改：MCP/Skill/Tool 各自业务逻辑、探测算法、数据库结构、依赖清单。

## 数据设计

**无需数据库结构变更。** 沿用 `setting_default`（scope=global）键值：

| key | 取值 | 默认 |
| --- | --- | --- |
| `chat.clientIdentity` | JSON `{"enabled":bool,"preset":"codex"\|"claude"}` | `{"enabled":false,"preset":"codex"}` |

权限偏好继续用现有 `cli.preferences.<cliId>` 的 `permission` 字段，不新增键。

## 关键实现决策

1. **身份模拟只改客户端身份，不伪造凭证**
   后端读取 `chat.clientIdentity`，开启时对平台 runtime 的出站请求追加该 CLI 的身份头：
   - `codex`：`user-agent: codex_cli_rs/<ver>`、`originator: codex_cli_rs`、`x-codex-session-id`（每进程固定）
   - `claude`：`user-agent: claude-cli/<ver> (external, cli)`、`x-app: cli`、`anthropic-version`、`anthropic-beta`
   **绝不改写/伪造** `Authorization`、`x-api-key`、账号 id、计费头。
   仅作用于平台 runtime（`platform_agent`），不改变 CLI 会话自身的启动参数。

2. **权限白名单必须先扩**
   `chat.rs::validate_permission` 现只放行 `default/plan/agent`。界面按 CLI 放开档位前，先把白名单扩到与界面一致（Claude/Codex：`default/plan/agent/auto/full`；Grok：`default/agent/full`），并把各档位映射到真实启动参数：
   - Claude：`auto` → `--permission-mode acceptEdits` 且不额外加审批旗标（原生审核由 CLI 自身处理）；`full` → `--permission-mode bypassPermissions`（需在界面明确风险提示）
   - Codex：`auto` → `--sandbox workspace-write` + `-c approval_policy="on-request"`（由原生审查通道裁决）；`full` → `--sandbox danger-full-access` + `-c approval_policy="never"`
   - Grok：仅 `default/agent/full` 三档，`full` → `--always-approve`
   **若某档位在本机 CLI 版本无法表达，则不放行**（宁可少给，不伪造能力）。

3. **归因只留指纹结论**
   `SettingsModelProbe` 移除独立归因块，结果区内仅保留一段纯文本：`指纹归因：最像 X（d=…） + 一致性 + 声称家族`；不再列不通过项与探针编号。

4. **新增供应商改为草稿**
   前端持有草稿状态（不入 store、不入列表、不计数），保存时才调用 `providerSave`。草稿卡含「供应商配置／模型配置」两页签，模型配置页支持手动增删模型并随保存提交；「获取模型」在草稿态禁用并说明需先保存端点与密钥（后端获取模型依赖已保存配置）。

5. **停用供应商折叠**
   停用项不进主列表；列表下方「查看停用供应商（N）」展开，卡片沿用现有供应商卡样式与原开关，不另造简化卡。

## 验证计划

| AC | 方式 |
| --- | --- |
| AC-01/02 | 软件隔离预览断言 + 截图；身份头用后端单测断言（不改 Authorization） |
| AC-03/04/05/06 | 隔离预览：草稿不落库、保存后入列表、顺序、端点对齐 |
| AC-07/08 | 隔离预览：点击检测不位移；归因块无边框/底色/阴影 |
| AC-09/10 | 隔离预览 + 后端单测：权限映射与白名单一致；空态原因 |
| AC-11 | 隔离预览：左栏 5 项、四 tab 切换 |
| 构建 | `npx tsc --noEmit`、`npm run build`、`cargo check --all-targets`、`cargo test --lib` |

## 已知不验证

- 真实 Tauri WebView2 渲染与字体差异。
- 真实模型端点下身份头的服务端反应（需真实中转账号）。
- 各 CLI 真实版本的 `auto`/`full` 行为（本机可能未安装或版本不符）。
