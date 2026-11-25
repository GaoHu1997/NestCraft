# LLD-CR079：本地数据统一存储

- 关联：[CR-081](../PRD/CR-081-本地数据统一存储.md)、[UI-CR081](../UI/文档/UI-CR081-本地数据统一存储界面.md)
- 实现：`src-tauri/src/storage_layout.rs`、`lib.rs` 启动段、`commands/general.rs`、`src/modules/settings/SettingsGeneral.tsx`

## 结构

- `storage_layout::root()`：进程级唯一数据根。首次调用解析配置并写入 `OnceLock`，此后全进程固定。
- `configured_root()`：读取 exe 同目录 `storage-root.txt`；无配置时用 `exe/data`。
- `category(name)`：在根下建分类目录并返回路径；所有消费者只经此函数取路径。
- `write_pointer()`：改配置时写指针，并把旧根写入 `storage-root.prev.txt` 作为下次启动的迁移来源。
- `restart_required()`：配置与当前生效根不一致时为 true，设置页据此提示重启。
- `migrate_legacy(legacy, root)`：按已知类别搬移（rename 失败则复制），目标已存在即跳过。

## 启动顺序

1. `root()` 确定数据根。
2. 依次从 `previous_root()` 与系统 `app_data_dir()` 迁移（幂等）。
3. 建全部分类目录。
4. 初始化编辑器恢复目录。
5. `db::init(root/db/workbench.db)`。

数据库必须最后打开，保证迁移完成前没有连接指向旧库。

## 消费者

数据库、workbench MCP 子进程 `--app-data-dir`（传统一根，子进程按 `root/db/workbench.db` 开库）、CLI 会话profile、Skill、MCP/供应商/服务器密钥、头像、图片生成、文档恢复、git 凭据、冒烟日志、知识库与回收站、示例资料。

索引根判定：库文件位于 `root/db/` 时索引固定 `root/index/`；其它环境（测试隔离库）与库文件同级，避免跨环境污染。

## 取舍

- 运行中不热切换根：数据库连接无法安全改指向，热切换会分叉。
- 不迁移第三方 CLI 家目录与用户项目：它们不属于本项目数据。
- 升级器暂存目录保持原行为（免安装版要求与 exe 同卷），不在本 CR 改动范围。

## 界面

设置 → 通用 → 「数据存储」（`SettingsGeneral.tsx`）：只读路径输入 + 选择目录；知识库目录提示；保存后若 `restartRequired` 为真提示「重启后迁移并生效」。设计版本与断言见 [UI-CR081](../UI/文档/UI-CR081-本地数据统一存储界面.md)。

## 验证与未验证

单测见 `storage_layout::tests`（分类落位、不覆盖、幂等、无关文件不动、同根跳过）。全量后端 510 通过；设计侧 10/10 断言、0 JS 异常、2 张截图；`tsc`、`npm run build`、`cargo build` 通过并确认新 exe 含该设置文案。真实安装环境的一次性迁移、改根重启迁移、深色／窄屏与软件成对视觉对照未验证。


