# LLD-CR091：设置 → 通用 布局重排实现方案

- 关联：[CR-091](../PRD/CR-091-设置通用页布局重排.md)／[STORY-023 CR-091 增量](../Plan/Story/STORY-023-设置中心弹框与菜单重组.md#cr-091增量)（唯一父项 FEAT-013）。
- 设计基准：[UI-CR091-v1](../UI/文档/UI-CR091-设置通用页重排.md)，资源 `docs/UI/workbench-v4/cr091-general.{js,css}`。
- 本轮只做需求与设计，正式软件未修改；下列内容是实现方案，不代表已实现。

## 1. 当前实现与受影响模块

| 位置 | 现状 | 本次变更 |
| --- | --- | --- |
| `src/modules/settings/SettingsGeneral.tsx` | 138 行单文件，6 个 `set-section` 平铺，`Row` 丢弃 `hint`，单一 `save()` 逐个写键 | 拆为分组组件＋草稿 hook；删死参数；校验内联 |
| `src/modules/settings/settings.css` | 复用 `.set-section/.set-field` | 新增分组卡、粘附工具条、占用明细、头像字段与浮层 |
| `src/modules/settings/index.tsx` | 各页用 `hidden` 保活；`TABS.sub` 未渲染 | 通用页无需改壳；不改 `sub` 语义 |
| `src/store/app.tsx` | `theme` 仅 `light`/`dark`，启动 `getTheme()` 解析，`toggleTheme` 写回 | 扩展 `system`：状态保留模式，根节点解析为实际色 |
| `src-tauri/src/commands/general.rs` | `get_theme/set_theme` 存 `theme`，只校验不限制取值 | 语义扩展为接受 `system`（存值不变） |
| 设置页说明 | CR-085 已删说明块 | 本版允许每字段一句 `hint`，不复原说明块 |

## 2. 数据结构复用（无 DB schema 变更）

全部落在既有 `setting_default(scope='global', key, value)`，不新建表、不加列，因此 [DB-FEAT-001](../DB/DB-FEAT-001-知识授权与工作台数据设计.md) 的表结构不变；新增的只是键与取值语义：

| 键 | 取值 | 缺省 | 说明 |
| --- | --- | --- | --- |
| `user.name` / `user.email` / `user.role` / `user.timezone` | 字符串 | 空 / `Asia/Shanghai` | 沿用 |
| `theme` | `system` / `light` / `dark` | `system`（旧库无值按 system） | **语义扩展**：原仅 light/dark，旧值原样有效 |
| `ui.density` | `standard` / `compact` | `standard` | 新增 |
| `editor.theme` | `auto` / `light` / `dark` 或旧中文值 | `auto` | 取值收敛；旧值 `跟随系统/浅色/深色` 需兼容映射 |
| `editor.fontSize` / `editor.tabSize` / `editor.wrap` | 12–16 / 2·4 / bool | 13 / 2 / true | 沿用 |
| `chat.sendMode` | `immediate` / `queue` | `queue` | 沿用 |
| `chat.notifyDone` | bool | `true` | 新增 |
| `ui.restoreLastWindow` | bool | `true` | 新增，消费点在启动流程 |
| `server.port` / `server.defaultUser` / `server.auth` | 1–65535 / 用户名 / `key·password·jump` | 22 / 空 / `key` | 沿用，仅语义限定为“新建主机默认值” |
| `ui.avatarStyle` / `ui.avatarImage` | a–e / 本机图片引用 | b / 空 | 沿用 CR-051，无变更 |
| `settings.general` | 兼容快照 JSON | 空 | 保留写入以兼容既有读取方 |

`storage.dataDir` 走既有 `storageDataDir`／`storageSetDataDir`，含 `restartRequired` 语义，不改。

## 3. 选定方案

### 3.1 组件拆分

```
SettingsGeneral.tsx            // 容器：草稿、校验、保存、关闭保护
  general/DraftContext.ts       // useGeneralDraft：draft/saved/errors/set/validate
  general/GroupCard.tsx        // 卡头（图标、标题、标签）＋行容器
  general/Row.tsx              // label/control/hint/error 的统一样式（接收 hint，渲染一句说明）
  general/Identity.tsx         // 头像字段行（控件只有小头像）+ 名称/邮箱/角色/时区
  general/AvatarPopover.tsx    // 头像浮层：预览、5 风格、上传、恢复默认、取消/应用
  general/Appearance.tsx       // 主题、密度、代码编辑器子块与预览
  general/Behavior.tsx         // 发送行为、通知、启动恢复
  general/HostDefaults.tsx     // 端口/用户/认证 + 只读安全策略
  general/Storage.tsx          // 位置、占用、知识库/日志路径
  general/About.tsx            // 版本、检查更新、恢复默认
  general/StickyBar.tsx        // 分组跳转、未保存计数、放弃/保存
```

保持现有页面契约：仍由 `index.tsx` 以 `hidden` 挂载，切换页签保留草稿（沿用 AC-STORY-023-06）。

### 3.2 单一草稿

- `saved` 为打开时读到的快照，`draft` 为编辑值；`dirty = keys where draft[k] !== saved[k]`。
- 控件只写 `draft`；主题/密度额外触发“预览副作用”（写根节点 `data-theme`／`data-density`），并记录是否处于预览。
- 头像走浮层草稿：`AvatarPopover` 打开时记录快照，风格与图片只改浮层内联状态，点“应用”才写 `draft.avatarStyle`／`draft.avatarPhoto`；取消、点外部、Escape 回滚。页面上“头像”字段的小头像按 `draft` 渲染，因此应用前不会影响其它位置。
- 放弃、确认放弃、卸载时回滚预览到 `saved`；保存成功后 `saved = draft` 并保留预览。
- 切换设置页签不丢弃草稿；关闭设置并重新打开才重新读盘。

### 3.3 保存事务与失败处理

1. 先本地校验；有错误则不写任何键，标红并聚焦首个错误。
2. 按固定顺序写：普通键 → `ui.avatarStyle`／`ui.avatarImage` → `storageSetDataDir` → `settings.general` 快照。
3. 任一步失败：停止后续写入，保留 `draft` 与错误提示“保存未全部完成”，**不回滚已写入的键**（避免与用户刚改的值打架），并在顶部标注“部分保存”；用户可重试。
4. 成功后广播 `app:settings-changed`，携带 profile／general／avatarStyle／themeMode，供侧栏与顶栏同步。

### 3.4 主题 `system`

- 后端 `set_theme` 接受 `system` 并原样存 `theme`；读取返回原值。
- 前端 `AppProvider` 保留 `themeMode`（三态），派生 `resolvedTheme`（`system` → `matchMedia('(prefers-color-scheme: dark)')`），根节点只写解析结果。
- 顶栏切换按钮在 `system` 下按当前解析结果切换到相反固定值（`light`/`dark`），避免“按了没反应”。
- 监听 `matchMedia` 变化，仅当模式为 `system` 时跟随，防止切到固定值后仍被系统变化覆盖。

### 3.5 校验规则（与设计稿一致）

邮箱格式、名称 ≤40、角色 ≤24、字号 12–16 整数、Tab ∈ {2,4}、端口 1–65535、用户名 `^[A-Za-z0-9._-]{1,32}$`、枚举白名单（themeMode、density、codeTheme、sendMode、auth、timezone、avatarStyle）。错误信息为一句中文原因，字段 `aria-invalid` 与错误文本用 `aria-describedby` 关联。

### 3.6 兼容与回退

- 无数据库迁移；新增键缺失按缺省，等价于升级前行为（通知默认开、启动恢复默认开、密度标准）。
- 旧库 `editor.theme` 的中文值经映射读入（`跟随系统→auto`、`浅色→light`、`深色→dark`），保存后写新值。
- 回退：撤掉新样式与组件即可回到旧布局，键值仍可被旧代码读取；`theme=system` 在旧代码中会被当作非 dark 而落到 light，需在回退说明中标注。

## 4. 验证计划

| AC | 方式 |
| --- | --- |
| AC-CR091-01～05、09～11 | 正式软件同条件截图＋DOM 断言（分组顺序、字段存在性、头像字段与浮层、只读策略） |
| AC-CR091-06 | 单元测试校验函数；集成：输入非法值保存后断言无写入、字段标红、焦点 |
| AC-CR091-07～08 | 集成：保存后重开读值；X／遮罩／Escape 三路径确认 |
| AC-CR091-12 | 1440×900 与 390×844 双视口，断言无横向溢出 |
| AC-CR091-13 | 滚动三帧动态证据（静止／滚动／停止 700ms），按 UI-SCROLL-001 |
| 视觉一致 | 设计与软件同视口、同主题、同夹具成对截图，逐组对照 |

本轮只完成设计侧验证（41/41），正式软件验证未执行。

## 5. 未决项与假设

- **待确认**：`新建主机默认值` 是否迁出通用页（设计保留在页内独立分组）。
- **待确认**：通知与启动恢复的真实消费点是否在本轮接入；未接入前不得在界面宣称已生效。
- **假设**：占用明细复用既有存储统计命令，不新建索引；若统计成本高，退化为“打开目录查看”并明确不显示数字。
- **风险**：把左栏各页保活与通用页预览副作用的组合，需要在切换页签时明确“继续预览还是暂停预览”；本方案选择“继续预览，直到保存或放弃”，避免切页丢失用户看到的主题。头像浮层在滚动、切页与整页重渲染时关闭，避免浮层与该字段脱离。
- **风险**：主题从两态扩到三态会触及顶栏切换与 `Editor` 的 `MutationObserver`，需要回归编码页主题跟随。