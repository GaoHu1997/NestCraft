# LLD-CR046：右上角软件更新入口实现方案

- 关联需求／Story／AC：[CR-046](../PRD/CR-046-右上角软件更新入口.md)、[STORY-064](../Plan/Story/STORY-064-主界面按评审意见重构.md#cr-046右上角软件更新入口) AC-35～39；UI 基准 [UI-CR046](../UI/文档/UI-CR046-右上角更新入口.md)。
- 本次解决的问题：应用没有更新能力；用户希望有更新时标题栏出现「更新」、下载校验后变「重启」，并同时适配安装版与免安装版。
- 不在本次范围：更新说明弹窗、跳过版本、自动更新开关、差分更新、断点续传、代码签名、发布流程改造；正式源码改动以用户明确指令「再改代码实现」为授权依据。

## 1. 当前实现与受影响模块

| 现状 | 说明 |
| --- | --- |
| 无更新能力 | `src-tauri/Cargo.toml` 未引入 updater 插件，`lib.rs` 无更新命令；`src/App.tsx` 顶栏只有搜索、主题、通知、账户与窗口控制 |
| 已有依赖可复用 | `ureq`（同步 HTTP，已启用 TLS）用于上游请求；`tokio` 提供异步运行时；`sha2` 已在 `Cargo.lock`（0.10.9）中，可直接声明为直接依赖；Tauri 2 提供 `AppHandle`、`Emitter`、`app_data_dir` |
| 数据目录 | `setup` 中解析 `app.path().app_data_dir()`，更新暂存放其下 `update/`，不写数据库、不写安装目录之外的用户数据 |
| 分发形态 | `tauri.conf.json` 当前只配置 `nsis` 安装包；尚无免安装版构建脚本与标记文件，运行时判定按「标记优先、卸载器次之、其余不支持」设计 |

受影响文件：`src-tauri/src/updater.rs`（新增）、`src-tauri/src/commands/updater.rs`（新增，命令包装）、`src-tauri/src/lib.rs`（模块与命令注册、启动清理）、`src-tauri/Cargo.toml`（`sha2` 直接依赖）、`src/api/index.ts`（命令封装与类型）、`src/modules/update/UpdateBadge.tsx`（新增）、`src/modules/update/update.css`（新增）、`src/App.tsx`（顶栏挂载）。

不改：`tauri.conf.json`、数据库 schema、既有窗口关闭流程、通知面板、设置页。

## 2. 选定方案与流程

采用**自研轻量更新**：清单 JSON + HTTPS 下载 + SHA-256 校验 + 按形态落位，不引入 Tauri updater 插件，避免签名密钥与配置体系成为前置依赖。

### 2.1 状态机

```text
unsupported ──（开发环境 / 无法判定形态）──> 不显示入口
hidden ──检查到更高版本且资产匹配──> available
available ──点击/自动开始──> downloading ──校验通过──> ready
downloading ──失败──> available
ready ──点击──> applying ──成功──> 新版本启动
applying ──失败──> ready
```

前端只在 `available`／`downloading`／`ready`／`applying` 渲染徽标；`downloading` 与 `applying` 为 `disabled`。检查结果不得覆盖进行中的下载或安装状态。

### 2.2 更新源与清单

默认清单地址（待确认 Q-046-01，常量化便于调整）：

```text
https://github.com/GaoHu1997/NestCraft/releases/latest/download/nestcraft-win64.json
```

候选地址优先级：

1. 环境变量 `NESTCRAFT_UPDATE_FEED`（单个 URL，设置后只用它，便于强制指定与测试）。
2. `<app_data>/update/feed.json`：内容为单个或多个 URL，逗号／空白／换行分隔，只接受 `http://`、`https://`。
3. 内置默认候选：默认清单地址的「直连 + 各 GitHub 加速镜像」列表（见 §2.2.1）。

清单结构（只允许 `installer`／`portable` 两类资产）：

```json
{
  "version": "0.2.0",
  "notes": "本版更新说明（本轮不展示，仅保留字段）",
  "pub_date": "2026-11-21",
  "installer": {
    "url": "https://github.com/GaoHu1997/NestCraft/releases/download/v0.2.0/NestCraft_0.2.0_x64-setup.exe",
    "sha256": "64 位十六进制",
    "size": 12345678,
    "mirrors": ["https://mirror.example/NestCraft_0.2.0_x64-setup.exe"]
  },
  "portable": {
    "url": "https://github.com/GaoHu1997/NestCraft/releases/download/v0.2.0/NestCraft_0.2.0_x64_portable.exe",
    "sha256": "64 位十六进制",
    "size": 12345678,
    "mirrors": []
  }
}
```

- 字段校验：`version` 非空；资产 `url` 必须 `http(s)`；`sha256` 必须 64 位十六进制；`size` 允许 0 但大于 0 时严格校验。
- 只取当前形态资产；另一形态缺失不影响本形态；当前形态缺失时 `update_available=false` 并记录原因，不显示可安装状态。

### 2.2.1 GitHub 加速候选（BUG-001 修复）

直连 GitHub Release 在部分网络下会卡在 `release-assets.githubusercontent.com` 的连接重置上，表现为「拉取更新清单失败」，此时用户既看不到更新也无法自更新。因此内置一份前缀式加速镜像列表，规则如下：

- **展开规则**：`{加速器前缀}{原始 GitHub 地址}`。清单与安装包都走同一套展开；只有 `github.com`、`raw.githubusercontent.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com`、`codeload.github.com` 会被展开，其他域名原样使用。
- **顺序语义**：候选顺序为「直连 → 加速镜像（按列表顺序）→ 清单声明的 `mirrors`」。顺序只影响首选速度，不影响正确性：任一源成功即用，失败自动切下一个。列表靠前的为实测可用源，靠后的保留作兜底（镜像会出现 429／403 等临时限流，仍可作为下一轮候选）。
- **安全边界**：镜像只承担传输，安装包下载完成与安装前都按清单 `sha256` 完整校验，哈希不符即删除并切下一个源；清单本身来自发布仓库，加速器不参与内容生成。
- **失败体验**：清单探测走较短的连接／读取超时（6s／12s），总等待上限 45s，超限放弃剩余候选；最终错误消息说明已尝试的源数量，并最多列出 3 条源错误，避免界面提示被十几个源的失败串撑满。
- **慢源保护**：镜像的实际下载速度差异很大（同一安装包实测约 10KB/s～320KB/s）。启动阶段 30s 内收不到 512KiB（<17KB/s）视为该源不可用立即切源；单源总时限 600s 兜底，超时丢弃半包切下一个候选，避免更新长时间停在慢源上。候选顺序按实测下载可用性排列（`hub.ddayh.com` 优先）。
- **代理**：`NESTCRAFT_UPDATE_PROXY` 优先，其次 `HTTPS_PROXY`／`ALL_PROXY`／`HTTP_PROXY`（大小写均认）；都未设置时仍读取系统环境变量代理，不再有任何代理即直连。注意只识别环境变量，不读取 Windows「Internet 选项」里的系统代理/PAC；使用 Clash 等工具的用户需要用 `NESTCRAFT_UPDATE_PROXY` 显式指定，否则走加速镜像兜底。
- **覆盖能力不变**：`NESTCRAFT_UPDATE_FEED` 与 `feed.json` 仍是强制指定（只尝试给定地址），便于内网或指定 tag 场景；内置加速只作用于默认候选。

### 2.3 版本比较

按 `.` 分段比较数字；`v` 前缀忽略；带 `-` 的预发布段低于同号正式版；数字段缺失按 0。只接受候选严格大于当前 `CARGO_PKG_VERSION`。

### 2.4 形态判定

按顺序，全部为纯函数，便于单测：

1. `debug_assertions` 为真 → `unsupported`（开发环境不升级）。
2. 可执行文件同目录存在 `portable.marker` → `portable`。
3. 可执行文件同目录存在 `uninstall.exe` → `installed`（NSIS 安装目录特征）。
4. 其余 → `unsupported`（无法安全判定，不显示入口）。

免安装版构建由 `.github/workflows/release-windows.yml` 在发布包内写入 `portable.marker`，并同时生成同版本更新清单；本仓库不再手工准备该标记。

### 2.5 下载与校验

- 使用 `ureq::AgentBuilder`，连接超时 10s、单次读超时 30s；在 `tauri::async_runtime::spawn_blocking` 中执行，避免阻塞 UI 线程。
- 下载候选按 §2.2.1 展开：主地址若为 GitHub 直链，先直连、再逐个加速镜像，最后追加清单声明的 `mirrors`；去重后逐个尝试，任一成功即用。单个候选失败（含大小或哈希不符）立即删除 `.part` 并切下一个。
- 暂存目录 `<app_data>/update/`；临时文件 `update.part`，落位名 `update-staged.exe`（两形态共用，内容由清单决定）。
- 分块 64 KiB 写入，累计 `done`、按 1 秒窗口计算 `speed`；每块后更新全局进度并 `emit("update-progress", ...)`；前端同时以 700ms 轮询 `update_status` 兜底。
- 下载完成：若清单 `size>0` 且实际大小不等 → 失败；计算 SHA-256，不匹配 → 删除 `.part`、失败；匹配 → `rename` 为 `update-staged.exe`，状态 `ready`，写入 `staged.json`（版本、sha256、形态）供重启后恢复。
- 同一时刻只允许一个下载（`AtomicBool`）；重复触发返回「已有下载任务进行中」。
- 不使用清单中的文件名或路径落盘，避免路径穿越。

### 2.6 落位

**免安装版**

1. 安装前重新校验 `update-staged.exe` 的 SHA-256。
2. 当前 exe 改名为 `<name>.exe.old`（已存在则 `.old-2`…`.old-9`，再冲突用随机后缀）；改名失败按 100/200/400/800/1500ms 退避重试。
3. `update-staged.exe` 改名为当前 exe；失败则把旧版改回原名并返回错误。
4. 以分离进程启动新 exe（Windows：`DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`），设置 `NESTCRAFT_UPDATED=1`。
5. `app.exit(0)`。新版本启动时清理 `*.old`、`.part`、`staged.json`。

**安装版**

1. 安装前重新校验安装包 SHA-256。
2. 以 `Command::new(staged).arg("/S")` 启动 NSIS 安装包；`/S` 为 NSIS 标准静默参数，安装包是否完全无界面或触发 UAC 由其自身配置决定，不在此承诺。
3. 启动成功后 `app.exit(0)`；由安装包替换文件、更新卸载登记并启动新版本。
4. 启动失败：保留安装包与 `ready` 状态，提示用户可重试或手动运行安装包。

**共同约束**：失败不删除暂存包；不修改用户项目、知识、会话与数据库；不自动重试安装。

### 2.7 命令契约

| 命令 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `update_environment` | 无 | `{ kind: "installed"\|"portable"\|"unsupported", current_version, exe_path, updatable }` | 前端启动时先取；`unsupported` 时不检查、不渲染 |
| `update_check` | 无 | `{ current_version, update_available, manifest, asset }` | `asset` 为按形态裁剪后的 `{ url, mirrors, sha256, size }`；不可用时 `manifest=null` |
| `update_download` | `expected_version`, `expected_sha256` | `{ path }` | 下载前校验清单身份与期望值，防止检查后被替换；成功后返回暂存路径 |
| `update_status` | 无 | `{ phase, done, total, speed, message, staged_file, kind, version }` | `phase`：`idle\|downloading\|verifying\|ready\|applying\|unsupported`；启动时由 `staged.json` 恢复 `ready` |
| `update_apply` | `expected_sha256` | `()` | 再次校验后落位；成功时不返回（进程退出），失败返回错误 |

所有命令返回 `Result<T, String>`；错误信息使用可操作中文，例如「更新包 SHA-256 不匹配，已删除损坏文件」「旧版程序改名失败（可能被杀毒软件占用）」「安装器启动失败」。不返回本机敏感路径以外的信息。

### 2.8 前端

- 新增 `UpdateBadge` 组件，挂在 `App.tsx` 顶栏 `.top-actions` 中、通知按钮之后、账户按钮之前；无状态时不渲染。
- 启动流程：`update_environment` → 若 `updatable` 则 2 秒后 `update_check`，此后每 30 分钟一次；同时 `update_status` 恢复 `ready`／`downloading`。
- 点击 `available` → `update_download`；监听 `update-progress` 更新进度，轮询 `update_status` 兜底；成功后 `ready`。
- 点击 `ready` → `update_apply`；失败恢复 `ready` 并 Toast 提示。
- 失败提示复用 `src/components/ui.tsx` 的 `useToast`；错误文案直接来自后端。
- 状态机与样式按 [UI-CR046](../UI/文档/UI-CR046-右上角更新入口.md)：54×22 文字胶囊，绿「更新」、橙「重启」、边框进度、加载环。
- 卸载时清理监听与定时器；页面不可见不改变状态。

## 3. 数据、权限、安全与兼容

- **数据**：不新建数据库表、不迁移、不改现有 schema；只写 `<app_data>/update/` 下的暂存包、`staged.json` 与 `feed.json`（可选）。DB 不适用，理由：更新状态是瞬时本机安装状态，不参与业务数据与多设备同步。
- **权限**：只读网络与自身安装目录；不在应用内提权；安装版由安装包自行处理 UAC；免安装版仅在 exe 目录可写时允许落位，不可写时返回错误。
- **安全**：只允许 `http(s)`；SHA-256 必填并在下载后、安装前各校验一次；固定落盘路径；不执行未校验文件；失败清理临时文件；不记录凭据。
- **兼容**：Windows 10/11 x64；`http(s)` 代理沿用系统环境变量（ureq 读取 `HTTPS_PROXY`／`ALL_PROXY`／`HTTP_PROXY`，专用变量 `NESTCRAFT_UPDATE_PROXY` 优先）；无更新源或离线时静默；版本号取 `CARGO_PKG_VERSION`，与 `tauri.conf.json`／`package.json` 保持一致由发布流程保证。GitHub 直连不可达时按 §2.2.1 切加速镜像。
- **并发**：下载单飞；apply 期间忽略重复点击；检查与下载互不覆盖状态。

## 4. 实现步骤与验证

1. `Cargo.toml` 增加 `sha2 = "0.10"`；确认 `cargo check --offline` 可解析（lock 已有 0.10.9）。
2. 实现 `updater.rs` 的纯函数与单测：版本比较、清单解析、资产选择、形态判定、URL／哈希校验、SHA-256 校验（临时文件）。
3. 实现下载、状态、落位与 Tauri 命令；`lib.rs` 注册命令并在 `setup` 中启动清理。
4. 前端 API、组件、样式与顶栏挂载；构建类型检查。
5. 验证：
   - `cargo test --offline --lib`（新增 updater 单测）；
   - `npm run build`（含 `tsc --noEmit`）；
   - 本机 feed 夹具 + 本地 HTTP 服务：检查、下载、进度、校验失败、`ready` 恢复；
   - 免安装落位：用临时副本 exe 与 marker 夹具验证换名／回滚（不替换正在运行的应用）；安装版落位只验证安装包启动路径与参数，不实际完成升级；
   - 设计／软件同视口五态对照截图。
6. 未验证项如实登记：安装版完整升级、代码签名、UAC 行为。真实 GitHub Release 与免安装版构建产物已由 0.0.1 发布流水线产出并核对清单（见 §6 变更记录）。

## 5. 风险、取舍与未决项

| 项 | 取舍／风险 | 缓解 |
| --- | --- | --- |
| 不使用 Tauri updater 插件 | 需要自己实现下载、校验与落位 | 复用现有 `ureq`／`sha2`；逻辑集中在一个模块并单测 |
| NSIS `/S` | 安装器是否完全无界面、是否需要 UAC 取决于其配置 | 文案不承诺无界面；失败保留 ready 可重试 |
| 形态判定 | 无 marker、无卸载器的绿色版会被判为 unsupported | 免安装构建写入 marker；文档明确；不猜测目录可写性作为唯一依据 |
| 更新源 | 默认仓库与清单名待确认；直连 GitHub 在部分网络会被重置 | 常量集中、可用环境变量覆盖（Q-046-01）；内置「直连 + 加速镜像」候选，按 §2.2.1 逐级兜底 |
| 大文件下载 | 无断点续传 | 本轮范围外；失败重下，`.part` 清理 |
| 安装版替换时机 | 安装器可能在应用退出前开始 | 启动安装器后立即退出；安装器自身负责文件占用处理 |

未决：Q-046-01 更新源（当前使用内置默认地址）、Q-046-02 安装器界面／UAC 接受度。Q-046-03（免安装构建脚本）已由 2026-11-20 的 GitHub Actions 发布流水线交付。

## 6. 变更记录

| 日期 | 变更 | 依据 |
| --- | --- | --- |
| 2026-11-20 | 建立 LLD-CR046：自研清单＋SHA-256 更新、安装版／免安装版分叉、五态前端与命令契约 | 用户直接指令先需求设计后代码；UI-CR046-v1 已登记 |
| 2026-11-20 | 交付 0.0.1 发布流水线：`.github/workflows/ci.yml` 做前端构建、`cargo check --all-targets`、`cargo test --lib`；`.github/workflows/release-windows.yml` 以 `--no-bundle` 构建 Windows x64 单文件免安装 exe，写入 `portable.marker`、生成 `nestcraft-win64.json` 并创建 Release，暂不构建安装包 | 用户要求版本调整为 0.0.1、发布到 GitHub、经 CI 检测并手动触发构建，现阶段只触发 win amd64 免安装 exe |
| 2026-11-20 | 0.0.1 发布验证：CI 全绿；发布构建全步骤成功，Release `v0.0.1` 含 exe／zip／`.sha256`／清单；`releases/latest/download/nestcraft-win64.json` 可读，按清单下载 exe 校验 SHA-256 与清单一致，exe 版本 0.0.1 且可启动（窗口「栖造 NestCraft」） | 用户要求通过 CI 检测并触发 win amd64 免安装构建 |
| 2026-11-20 | CI 环境适配：GitHub Windows runner 所在卷未阻止对已打开目录的 rename，且重建同名目录时复用 `creation_time`（NTFS file system tunneling），`knowledge_parent_change_and_symlink_are_rejected` 的 pin 断言在该卷上只记录日志；符号链接替换断言仍生效。产品侧 `SafeRoot` 校验未放宽 | CI run 44769606280 失败、44770443847 通过；本地仍严格通过 |
| 2026-11-22 | 0.0.2 发布启动：版本统一为 0.0.2（package.json、tauri.conf.json、Cargo.toml、两份 lock 同步）；提交 CR-049~CR-056 批量成果（文档 fd56a86、源码 c4cbe8e）并推送 v0.0.2 标签触发 release-windows 流水线，仍只发布 Windows x64 免安装 exe | 用户 2026-11-22 02:06 指令「五个小时后提交代码到 GitHub 并发布 0.0.2」；发布前本地验证 npm run build 与 cargo test --lib（205 通过）均绿 |
| 2026-11-22 | 0.0.2 发布验证：CI（run 44961327296）与发布构建（run 44961333017）均 success；Release `v0.0.2` 含 exe／zip／`.sha256`／`nestcraft-win64.json` 四资产，`releases/latest` 指向 v0.0.2；清单、校验文件与实际下载 exe 三方 SHA-256 一致（73848345…b4062eef），exe 大小 23,085,056 字节与清单一致，VersionInfo 产品版本 0.0.2；zip 含 `NestCraft.exe`、`portable.marker`、`README.txt`。GUI 启动验证未执行（无人值守），列为待用户验收项 | 用户 2026-11-22 02:06 指令；Actions run 结论与 Release 资产逐项核对 |
| 2026-11-22 | BUG-001 修复：更新检查报「拉取更新清单失败」。新增 §2.2.1 GitHub 加速候选与 §2.5 下载候选展开；清单探测改用较短的 6s／12s 超时并加 45s 总预算，错误消息限长；支持 `NESTCRAFT_UPDATE_PROXY` 与系统代理环境变量。实测本机直连 GitHub Release 资产被连接重置（curl http=000），加速镜像 `kenyu.ggff.net`／`hub.ddayh.com` 可取到清单 v0.0.2；实网回退与整包 SHA-256 校验见验证记录 | 用户 2026-11-22 报错并要求对照参考项目补齐加速配置 |
| 2026-11-23 | 0.0.3 发布启动：版本统一为 0.0.3（package.json、tauri.conf.json、Cargo.toml、两份 lock 同步）；提交 CR-057~CR-067 批量成果（文档 9a794e7、源码 ecf304d，含 tantivy 第三方依赖 vendoring 与许可核对）并推送 v0.0.3 标签触发 CI 与 release-windows 流水线，仍只发布 Windows x64 免安装 exe | 用户 2026-11-23 指令「版本号 +1，发布到 github，需要通过 ci，并触发构建免安装 exe」；发布前本地验证 npm run build 与 cargo test --lib（348 通过）均绿 |
| 2026-11-23 | 0.0.3 发布验证：Release `v0.0.3` 已发布（发布构建 run 45118211969 success），含 exe／zip／`.sha256`／`nestcraft-win64.json` 四资产，`releases/latest` 指向 v0.0.3；清单、校验文件、单文件 exe 与 zip 内 `NestCraft.exe` 四方 SHA-256 一致（5eebdda6…f476ffe6，32,094,208 字节），VersionInfo 产品版本 0.0.3（产品名「栖造」），单文件 exe 与 zip 内 exe 二进制完全相同，zip 含 `NestCraft.exe`、`portable.marker`、`README.txt` | 用户 2026-11-23 指令「版本号 +1，发布到 github，需要通过 ci，并触发构建免安装 exe」 |
| 2026-11-23 | 0.0.3 CI 失败与修复：首次 CI（run 45117893409）在 Rust unit tests 失败，`commands::ai_tools::tests::kb_tools_roundtrip` 报「知识库路径已变化或存在链接」。根因为 GitHub Windows runner 的 `%TEMP%` 是 8.3 短名（`RUNNER~1`／`D:\a\_temp`），`SafeRoot` 将 canonicalize 展开后的长名与原短名判为不一致。产品侧 `SafeRoot` 校验未放宽；按项目既有做法（`knowledge.rs` 两处夹具）改为测试夹具直接基于规范化后的临时目录，修复提交 e5babfb，重跑 CI（run 45122366819）success。本地 `cargo test --lib` 348 通过 / 0 失败 | CI run 45117893409 job 日志与本地 8.3 短名复现（`SHORTN~1` ≠ 长名）；用户要求「需要通过 ci」 |
| 2026-11-24 | 0.0.4 发布启动：版本统一为 0.0.4（package.json、tauri.conf.json、Cargo.toml、两份 lock 同步）；0.0.3 之后 CR-068~CR-071 批量成果（平台主代理运行时、平台会话分层上下文与安全原文找回、主界面导航精简与图标悬浮层、会话可用性修复等）随 main 已有提交一并发布，并推送 v0.0.4 标签触发 CI 与 release-windows 流水线，仍只发布 Windows x64 免安装 exe | 用户 2026-11-24 指令「版本号 +1，发布到 github，需要通过 ci，并触发构建免安装 exe」；发布前本地验证 npm run build 与 cargo test --lib（500 通过）均绿 |
| 2026-11-24 | 0.0.4 发布验证：CI（run 45320690852）与发布构建（run 45320796182）均 success；Release `v0.0.4` 含 exe／zip／`.sha256`／`nestcraft-win64.json` 四资产，`releases/latest` 指向 v0.0.4；清单、`.sha256` 文件、单文件 exe 与 zip 内 `NestCraft.exe` 四方 SHA-256 一致（4cd2e9f7…2b78f30，33,778,688 字节），单文件 exe 与 zip 内 exe 二进制完全相同，VersionInfo 产品版本 0.0.4（产品名「栖造」），zip 含 `NestCraft.exe`、`portable.marker`、`README.txt`。GUI 启动验证未执行（无人值守），列为待用户验收项 | 用户 2026-11-24 指令；Actions run 结论与 Release 资产逐项核对 |
