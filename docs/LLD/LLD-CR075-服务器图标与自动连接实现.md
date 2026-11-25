# LLD-CR075：服务器图标与自动连接实现

- 关联：[CR-075](../PRD/CR-075-服务器列表与主机表单重构.md)／[STORY-035 CR-075 增量](../Plan/Story/STORY-035-服务器管理正式实现.md#cr-075增量)／[UI-CR075-v1](../UI/文档/UI-CR075-服务器列表与主机表单.md)。
- 状态：**已实现（2026-11-24 用户「修改代码」授权）**。本文记录实际落地方案与实现中新增的约束；`cargo check --all-targets`、`vite build` 通过，软件侧隔离预览 22/22，真实 SSH 未验证。
- 影响模块（实际）：`src/modules/servers/`（HostList、HostForm、Workbench、MonitorPane、TerminalPane、hostVisual、servers.css）、`src/api/index.ts`、`src/store/app.tsx`、`src/App.tsx`（关闭页签文案）、`src/smoke/design-preview.ts`（隔离夹具）、`src-tauri/src/{ssh/mod.rs,commands/servers.rs,commands/ai_tools.rs,lib.rs}`、`public/brand/os/`。复用现有 `server_host.os` 字段，无数据库结构变更。

## 1. 当前实现与差距

| 现状 | 差距 |
| --- | --- |
| `HostList.tsx` 卡片带连接／断开按钮，卡片显示“已连接／未连接”，页脚含指标说明 | 需移除按钮与常驻连接态；仅保留最近采样；卡片增加官方系统标识。 |
| `HostForm.tsx` 使用 `Modal`；底层 `.srv-dialog .modal` 规则与弹窗实际高度仍可能出现下半空白（用户截图） | 需按内容高度、底栏固定、正文按需滚动；重排字段；移除说明段。 |
| 后端已有 `server_connect`／`server_disconnect`，连接由显式按钮触发 | 需改为工作台挂载自动连接、卸载／关闭页签自动断开；防止并发与关闭竞态。 |
| 无“测试连接”命令 | 需新增临时连接测试，不保存主机、不复用常驻连接状态。 |
| `server_host.os` 已由 CR-072 落库，列表显示文本 | 需统一由 `os` 派生官方图标；不新增可配置图标字段。 |
| 软件图标为通用服务器图标 | 需在卡片、工作台标题、窗口页签统一显示检测到的系统标识。 |

## 2. 选定方案

### 2.1 测试连接契约

新增命令（名称以实现时注册为准）：

```text
server_test_connection {
  id?: string,            // 编辑态可选，用于取已保存凭据
  host: string,
  port: number,
  username: string,
  authType: "password" | "key" | "none",
  secret?: string,        // 新输入密码或私钥口令；不落日志
  keyPath?: string
} -> {
  ok: boolean,
  latencyMs?: number,
  os?: string,            // PRETTY_NAME/系统名，用于显示与保存
  code?: "timeout" | "auth" | "dns" | "refused" | "hostkey" | "unknown",
  message?: string        // 短中文原因，界面直接显示
}
```

实现要点：

1. 使用现有 SSH 建连代码建立一次性会话，超时建议 8s（可配置），成功后执行系统识别，关闭会话；不写入连接管理器、不更新 `connected`、不保存主机。
2. 编辑态且凭据字段为空时，按 `id` 取已保存凭据；不得把已保存密码回传前端。新输入凭据仅在该次测试中使用。
3. 失败按 `code` 映射短文案；日志只记录主机、端口、认证类型与错误类别，不记录密码、私钥或口令。
4. 命令可被前端取消：关闭弹窗时取消进行中的测试；取消与超时都不改变主机记录。
5. 成功返回 `os`；前端在保存时写入现有 `os` 字段。未测试或失败时保留原 `os`，未知保持空。

### 2.2 系统识别

优先顺序：

1. Linux：`/etc/os-release` 的 `PRETTY_NAME`／`NAME`／`ID`／`ID_LIKE`。
2. macOS：`sw_vers -productName -productVersion`。
3. Windows（OpenSSH）：PowerShell `Get-CimInstance Win32_OperatingSystem` 或 `cmd /c ver`，失败回退通用。
4. 其他：`uname -s`；未知不猜测品牌。

前端映射只读 `os` 文本：Ubuntu／Debian／CentOS／Rocky／Alma／Fedora／Arch／openSUSE／Alpine／Amazon／Oracle／Red Hat／FreeBSD／macOS／Windows／Linux；未命中用中性占位。资源实现时放入 `public/brand/os/*.svg`，来源与 NOTICE 随仓库保留；不写入数据库，不提供设置项。

### 2.3 列表与弹窗

1. `HostList.tsx`：删除 `toggleConnect`、`busyId`、连接按钮与“已连接”徽标；卡片保留名称、地址、分组、三列指标、系统名与上次采样；整卡打开工作台；保留编辑、删除与确认。
2. `HostForm.tsx`：字段顺序按 UI 稿；弹窗不传固定高度，使用内容高度；`.modal-body` 只在超过视口时滚动，footer 在滚动区外；删除副标题、免认证解释与底部提示；错误按字段显示。
3. 新增测试连接状态机：`idle → testing → ok|fail`；测试中禁用测试与保存，关闭弹窗取消；成功显示系统名，失败显示短原因；输入变化清除旧结果。
4. 保存：编辑留空凭据不下发；若测试成功携带 `os`；新增主机写入 `os`、`lastSeenAt` 为空；列表显示未采样。
5. 删除确认去掉长解释，仅保留“删除后不可恢复”。

### 2.4 自动连接与关闭断开

1. 工作台 `Workbench` 挂载时若未连接则调用一次 `serverConnect`；连接中显示状态；成功后加载文件树、监控与终端；失败显示原因与“重试”。
2. 关闭工作台页签（`close-window`／对象窗口关闭）时调用 `serverDisconnect`；切换页签不触发断开。应用进程退出由后端清理连接。
3. 防止并发：以 hostId 为键的连接中标记；关闭或卸载后到达的连接结果丢弃，不得把已关闭工作台标记为已连接。
4. 失败重试仅重发连接；不提供手动断开。高风险命令审批、授权与连接状态不变；断开后终端输入禁用、文件与监控清空，不显示旧数据。
5. 列表不需要订阅连接状态；最近采样与 `lastSeenAt` 仍按现有接口读取。

## 3. 数据、权限与兼容

- **数据库**：复用 `server_host.os`（CR-072）与现有 `connected`／采样字段；不新增表、字段或迁移。图标不落库、不可配置，因此不需要 DB 变更。
- **权限／审批**：不新增权限模型；自动连接只改变连接发起时机，不改变 SSH 授权、主机信任或高风险命令审批。测试连接不写入审批记录。
- **兼容**：旧主机的 `os` 可能为空或文本不标准，按中性占位显示；连接成功后刷新为新检测值。旧凭据字段保持“留空沿用”，不做批量改写。
- **安全**：测试与自动连接不得记录或回传明文凭据；错误文案不包含密钥路径以外的敏感信息；不新增外部网络依赖。

## 4. 实现步骤与验证计划

1. 后端：抽出系统识别与一次性连接测试；注册命令；补单元／集成测试（认证失败、超时、成功返回 os、失败不落库、不写连接状态）。
2. 前端：重排 `HostForm`、卡片与工作台；接入测试连接与自动连接；补图标资源与映射；窗口页签复用同一标识。
3. 视觉：按 UI-CR075-v1 逐场景实现，先比对设计稿再提交；1440／390、浅／深、连接中／成功／失败／关闭断开、空／错／加载全部覆盖。
4. 回归：既有服务器 CRUD、SSH 终端、文件树、监控、审批；不得因自动连接引入双重连接、关闭竞态或审批绕过。
5. 证据：设计／软件同视口截图成对、UI-SCROLL-001 动态序列、真实或受控 SSH 测试记录；真实主机不可用时明确未验证，不写通过。

## 5. 风险与未决项

- 测试连接与常驻连接共用 SSH 代码：已抽出共用 `authenticate`，`test_connect` 不注册 `CONNECTIONS`／`CONNECTED_HOSTS`，因此不会把主机标记为已连接；`best_effort_disconnect` 的失败被忽略，避免把成功翻成失败。
- 系统识别命令在受限 shell、非 POSIX shell 或 Windows OpenSSH 下可能失败，失败回退「系统未知」，不中断连接（未在真实主机验证）。
- 关闭页签与连接完成的竞态：前端在连接返回后发现工作台已不可见则立即 `disconnect`；断开幂等性由后端保证（未做真实并发验证）。
- Q-CR075-01：关闭页签即断开；关闭应用由进程退出兜底。若产品要求切换到其他页签也断开，需另行确认。
- 正式开发前需明确编码授权、Feature 执行包与允许修改文件；本方案不覆盖其他 Feature。

## 6. 实现记录（2026-11-24）

1. **后端**：`ssh::authenticate` 由 `connect` 与原认证分支抽出共用；新增 `test_connect`（10s 总超时、exec OS 探测、尽力断开）、`parse_os_name`；`server_test_connection` 命令校验入参后按「本次提交凭据 → 已保存凭据」解析，从不写库／不写密钥／不进连接管理器；`HostDraft` 增加 `os`，UPDATE 用 `COALESCE` 保留旧值、INSERT 显式写入；`lib.rs` 注册命令；`ai_tools.rs` 的结构体字面量补 `os: None`（编译必需）。
2. **前端安全补强（实现中发现，已回写需求）**：编辑时改了主机地址／端口／用户名却留空凭据，原本会沿用已保存凭据去连新目标，等于把旧密码发往别的主机。现由前端（`keepsStoredSecret` 只在中三者均未变时成立）和后端（`server_test_connection` 比对已保存值）双重拦截，提示「地址或用户名已修改，请重新填写密码／私钥路径」。
3. **自动连接**：工作台在 `visible && host && !connected` 时提示"正在连接"并只试一次（`autoTried`），成功后采样一次指标写回列表缓存；失败停在"连接失败 + 重试"，不循环重连。关闭页签由 `store/app.tsx` 的 `closeWindow` 调 `serverDisconnect`；连接返回时若页签已关则立即断开。
4. **列表**：移除连接／断开、状态徽标、副标题与页脚；卡片改为官方标识＋名称/分组＋`user@host:port`＋三指标＋系统/采样时间；编辑/删除为悬浮图标按钮；删除前兜底断开。
5. **表单**：520px、按内容高度（依赖 `nc-dialog-auto`，删除了旧的 `height:auto !important` 覆盖）、字段顺序与三等分认证分段、字段级错误、底栏左侧测试连接＋结果。
6. **工作台**：新增 `srv-wb` 顶栏（官方标识＋名称＋地址＋连接状态），中间连接中/失败状态块；未连接时监控只显示「无数据」，文件树显示「等待连接」。
7. **既存缺陷修复**：xterm 在容器尺寸为 0 时 `open` 会在内部 `Viewport.syncScrollArea` 抛 `dimensions` 未定义（隔离预览中出现 1 次全局异常）。修复：`open` 包 try/catch、`fit` 前检查尺寸、`open` 后同帧 `fit` 改为下一帧执行。
8. **夹具**：`design-preview.ts` 新增 `server_test_connection`（文档 IP 校验、不可达主机失败、不上网络）、`server_connect` 对 `198.51.100.x` 返回"连接超时"、`server_save` 支持 `os`，并加 360ms 延迟让"连接中／测试中"中间态可观察。
