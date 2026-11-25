# UI-CR081：本地数据统一存储界面（设置 · 通用）

- 版本：UI-CR081-v1（2026-11-24）
- 关联：[CR-081](../../PRD/CR-081-本地数据统一存储.md)、[LLD-CR081](../../LLD/LLD-CR081-本地数据统一存储.md)
- 可查看入口：[仿真原型UI.html](../../仿真原型UI.html) → 设置 → 通用（内部资源 `docs/UI/workbench-v4/`）
- 设计资源版本：`screens-more.js` 438bb4c113f87244、`main.js` 29656e85d8cdd4fc、`data2.js` 01e8a41adc8f12b3
- 软件实现：`src/modules/settings/SettingsGeneral.tsx`（设置 → 通用 → 数据存储）

## 页面与状态

设置弹窗 → 通用页顶部新增「数据存储」分区，位于「用户基本信息」之前。

| 元素 | 内容 |
| --- | --- |
| 分区标题 | 数据存储 |
| 字段一 | 数据存储位置：只读输入框显示当前路径 + 「选择目录」按钮 |
| 说明 | 默认安装目录下的 data；本项目数据都在这里按类分开：db 数据库与会话、chat 会话文件、knowledge 知识库、skills 技能、mcp、secrets 密钥、avatar、logs、editor、git、recycle、index、examples。改位置需重启生效，重启时旧数据迁入新位置，不覆盖同名文件 |
| 字段二 | 知识库目录：显示 `<数据存储位置>/knowledge`，说明可直接拷文件进去、刷新目录后进入索引 |

状态覆盖：

- 默认态：输入框显示「安装目录\data」，知识库目录显示「安装目录\data/knowledge」。
- 选择后：写入演示路径 `D:\NestCraft-data`，并提示「重启后迁移并生效」。
- 保存设置：保存其余字段并提示「数据存储位置重启后迁移并生效」。
- 「通用」页说明文字改为「数据存储、用户信息、代码样式与服务器默认值。」

## 与软件的对应

软件同一分区、同一字段顺序与同一提示文案；软件额外有真实目录选择器与 `storage_data_dir` 返回值。设计稿的 `选择目录` 只写入演示路径，不读真实磁盘。

## 验证

- `node scripts/shot-cr081.mjs`：**10/10 断言通过**，0 JS 异常；截图 `docs/Test/screenshots/cr081/01-settings-general-storage.png`、`02-data-dir-picked.png`。
- 基线：`docs/Test/cr081-design-baseline.json`（视口 1440×900）。
- 未验证：深色主题、窄屏、真实软件与设计稿的成对视觉对照（软件截图未生成）。

## 来源与限制

设计稿原先只有「用户基本信息 / 代码样式 / 服务器配置 / 界面外观 / 会话」，缺数据存储分区；本次按已实现功能补齐设计。滚动条按 UI-SCROLL-001 处理：设置正文沿用现有 `set-scroll` 滚动容器，未新增常显滚动条。