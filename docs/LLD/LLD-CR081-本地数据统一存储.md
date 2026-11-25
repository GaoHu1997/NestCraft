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
2. 依次从 `previous_root()` 与系统 `app_data_dir()` 做**同步核心迁移**（`migrate_on_startup`）：只搬数据库、secrets、skills、examples、index、recycle、editor、git、office、avatar、generated-images、logs 等小体量数据；`chat/<cli>-profiles` 只登记为后台待迁。
3. 建全部分类目录。
4. 初始化编辑器恢复目录。
5. `db::init(root/db/workbench.db)`。
6. 既有启动工作（更新清理、SDK 清单、示例安装）。
7. 写 `logs/startup.log` 并 `spawn_deferred_migration` 后台续传 `chat/<cli>-profiles`。

数据库必须在同步迁移完成后打开，保证没有连接指向旧库；会话存储与数据库打开无关，放后台，见 §BUG-001。

## 消费者

数据库、workbench MCP 子进程 `--app-data-dir`（传统一根，子进程按 `root/db/workbench.db` 开库）、CLI 会话profile、Skill、MCP/供应商/服务器密钥、头像、图片生成、文档恢复、git 凭据、冒烟日志、知识库与回收站、示例资料。

索引根判定：库文件位于 `root/db/` 时索引固定 `root/index/`；其它环境（测试隔离库）与库文件同级，避免跨环境污染。

## BUG-001：首次启动迁移阻塞窗口（未响应）

- 关联：[STORY-099](../Plan/Story/STORY-099-首启数据迁移不阻塞启动.md)、用户 2026-11-25 报告与编码授权。
- 现场：便携版 0.0.5 首次启动把 `%APPDATA%\com.agentworkbench.app`（11617 文件 / 3.5 GB）从 C: 同步复制到 `D:\...\data`；跨卷 `rename` 必失败，退化为递归复制，全程在 Tauri `setup` 主线程执行，窗口消息循环不处理 → Windows 14:27:22 记 `AppHangB1`、提示「栖造 未响应」，用户「关闭程序」中断。14:28 重启后继续复制剩余 3.1 GB 才完成。
- 次生缺陷：原 `move_if_absent` 只要**目标目录存在**就整目录跳过，中断留下的半份 `chat\codex-profiles`（5651/10783 文件）此后永不补齐；源目录仍在，数据未丢但新根缺文件。
- 修复：
  1. `migrate_on_startup(legacy, root)`：主线程只做 `migrate_core`（数据库与小体量类别），返回 `chat/*-profiles` 的 `(来源, 目标)` 清单，不再同步搬大目录。
  2. `merge_path(from, to)` 取代 `move_if_absent`：目录递归逐项合并，文件级「目标存在则跳过、缺失则补齐」，中断后再次执行即续传；仍不覆盖、不删除源。
  3. `spawn_deferred_migration(root, pending)`：`db::init` 与示例安装完成后，在独立线程续传会话存储，写 `<root>/logs/startup.log` 记录同步耗时、待迁条目与后台完成耗时；失败不影响启动。
  4. `migrate_legacy` 保留为「同步做完全部迁移」的兼容入口，供测试与需要一次完成的调用方。
- 取舍：
  - 不新增启动进度窗口或文案：避免引入未设计的新界面；未响应来自主线程阻塞，去掉同步大目录复制即可消除。
  - 会话存储后台上传期间，若用户立刻打开历史 CLI 会话，其 profile 可能尚未补齐；该目录仅用于 `--resume` 续接，主数据仍在数据库。续传完成前 `logs/startup.log` 有记录可查。
  - 每次启动都会在后台遍历一次源 profiles 目录做存在性检查（不复制已有文件、不读大文件内容），代价是秒级 stat，不阻塞界面。
- 验证：`cargo test --lib storage_layout`（新增「启动只迁核心、会话存储进后台清单并续传」「merge_path 续传不覆盖」两项）；回归既有迁移 2 项。结果见 [REPORT-BUG-001](../Test/REPORT-BUG-001-首启迁移未响应修复验证.md)。

## 取舍

- 运行中不热切换根：数据库连接无法安全改指向，热切换会分叉。
- 不迁移第三方 CLI 家目录与用户项目：它们不属于本项目数据。
- 升级器暂存目录保持原行为（免安装版要求与 exe 同卷），不在本 CR 改动范围。

## 界面

设置 → 通用 → 「数据存储」（`SettingsGeneral.tsx`）：只读路径输入 + 选择目录；知识库目录提示；保存后若 `restartRequired` 为真提示「重启后迁移并生效」。设计版本与断言见 [UI-CR081](../UI/文档/UI-CR081-本地数据统一存储界面.md)。

## 验证与未验证

单测见 `storage_layout::tests`（分类落位、不覆盖、幂等、无关文件不动、同根跳过）。全量后端 510 通过；设计侧 10/10 断言、0 JS 异常、2 张截图；`tsc`、`npm run build`、`cargo build` 通过并确认新 exe 含该设置文案。真实安装环境的一次性迁移、改根重启迁移、深色／窄屏与软件成对视觉对照未验证。


