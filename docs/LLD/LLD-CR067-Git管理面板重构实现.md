# LLD-CR067：Git 管理面板按参考图重构实现

- 关联需求：[CR-067](../PRD/CR-067-Git管理面板按参考图重构.md)、[STORY-085](../Plan/Story/STORY-085-Git管理面板按参考图重构.md)、[FEAT-007](../Plan/Feature/FEAT-007-文件草稿与分支上下文.md)。
- 本次设计范围：编码 Tab 内 Git 管理侧栏的结构重构，以及国内加速、密钥配置两项新能力；不改 Git 执行层的权限模型与其他模块。

## 1. 当前实现与受影响模块

| 位置 | 现状 | 本次变化 |
| --- | --- | --- |
| `src/modules/git/index.tsx` | 三段式纵向布局（2:1:2，段间分隔线、每段右上刷新），提交区随段滚动 | 改为「顶栏 + 三张卡片」，提交区固定在变更卡底部；新增拆分提交按钮、分组全部暂存、分支树折叠、历史筛选、提交展开 |
| `src/modules/git/GitPanel.css` | 段落式样式（`.gitp*`） | 重写为卡片式（`.gita*`），沿用软件主题令牌 |
| `src/api/index.ts` | `gitLog(repoPath, limit, skip)`；无仓库／远程／加速／凭据命令 | 增加筛选参数与 `git_remotes`、`git_remote_save`、`git_accel_get/set`、`git_credentials_*` |
| `src-tauri/src/commands/gitcmd.rs` | 20 个 `git_*` 命令，无 `GIT_TERMINAL_PROMPT` 控制、无 accelerated 参数 | 日志增加 `all/author/since` 参数；网络命令支持加速前缀与凭据参数 |
| `src-tauri/src/commands/gitconfig.rs`（新增） | — | 远程列表／新增、加速配置读写、凭据增删查 |
| `src-tauri/src/lib.rs` | 注册 14 个 git 命令 | 注册新增命令 |

复用点：`git_status`／`git_branches`／`git_log`／`git_commit_files`／`git_stage`／`git_unstage`／`git_commit`／`git_fetch`／`git_pull_ff_only`／`git_push` 的现有语义与错误返回不变；受管密钥文件复用 `secrets.json`（与 MCP 令牌同一互斥锁与原子写）。

## 2. 选定方案

### 2.1 后端：命令契约

```rust
// 日志筛选：None 表示不过滤；all=true 时追加 --all
git_log(repo_path, limit, skip, all: Option<bool>, author: Option<String>, since: Option<String>)

// 远程管理
git_remotes(repo_path) -> Vec<RemoteEntry>              // { name, url }
git_remote_save(repo_path, name, url) -> ()             // 已存在则 set-url，否则 add

// 国内加速（全局设置，存 setting_default）
git_accel_get() -> AccelConfig                          // { enabled, url }
git_accel_set(enabled, url) -> ()                       // 校验 http(s) 且无空白

// 凭据（按远端主机，存 secrets.json，永不回显令牌）
git_credentials_list() -> Vec<CredentialHostEntry>      // { host, username, savedAt }
git_credentials_save(host, username, token, replace) -> ()
git_credentials_delete(host) -> ()
```

- 加速与凭据在网络命令内组合成 git 参数：
  - 加速：`-c url.<prefix>https://github.com/.insteadOf=https://github.com/`
  - 凭据：`-c credential.<scheme>://<host>.helper=` 空 helper 关闭继承，再走 `-c credential.<scheme>://<host>.username=<user>` + 环境变量 `GIT_ASKPASS` 脚本不可行（Windows 无脚本），改用 `credential.helper=store --file=<受管文件>` 的临时引用不可取，最终采用 `GIT_CONFIG_COUNT/GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n` 注入 `credential.<scheme>://<host>.username` 与通过 `git credential approve` 预写入的受管 store 文件（`git-credentials`），保证令牌不出现在命令行。
- 写操作（push）规则：仍走直连；若配置了该主机凭据则按上述方式注入。

### 2.2 前端：面板结构

- 状态：`status`／`branches`／`commits`／`remotes`／`accel`／`credentials` 分片加载；`seqRef` 防竞态（沿用）。
- 三张卡片，CSS 按 §2.2 的 2:1:2 与最小高度保底；列表滚动与提交区固定在变更卡内。
- 提交拆分为两个按钮共享同一门禁（`canCommit`），菜单项「提交」「提交并推送」。
- 分支树用 `Set<string>` 记录展开组（`local`、`remote`、`remote:<name>`）。
- 历史查询参数进入 `git_log` 调用（服务端过滤），不在已加载页内过滤；筛选变化重置分页。
- 图谱：前向单趟车道算法（与设计稿同一实现），仅依赖 `parents`，配合 `--topo-order`。
- 滚动条：不新增 `overflow:hidden`；沿用 `src/components/scrollbar.ts` 的按需显示。

### 2.3 错误与边界

| 场景 | 行为 |
| --- | --- |
| 非 Git 目录 | 三卡均显示对应空态，不显示操作按钮 |
| detached HEAD | 显示提示，提交与分支切换禁用 |
| 未设上游 | 更新／推送禁用并说明原因 |
| 加速前缀非法 | 保存被拒并提示；未保存时网络命令按直连执行 |
| 凭据读取失败 | 列表显示错误，不回退到猜测值；操作被禁用 |
| 令牌保存失败 | 提示失败并保留原文件（原子替换 + 临时文件） |

## 3. 安全与隐私

- 令牌只写入 `secrets.json`（`0o600`，原子 rename），通过 `GIT_CONFIG_*` 环境注入，**不出现在进程参数、日志、错误信息与 AI 上下文**。
- 列表接口只返回 `host`／`username`／`savedAt`；保存接口不回传令牌；前端输入框为 `type=password` 且保存后清空。
- 加速前缀只接受 `http(s)://` 且不含空白，避免把任意字符串拼进 `-c` 值造成配置注入。
- 所有仓库路径仍经 `find_repo` 校验；分支名沿用 `branchNameIssue` 校验。

## 4. 实现步骤

1. 后端：`gitconfig.rs` 新增远程／加速／凭据命令；`gitcmd.rs` 扩展日志筛选与网络参数；`lib.rs` 注册。
2. 前端 API 层补齐类型与调用。
3. 前端面板重写（结构 → 样式 → 交互），保持既有命令语义。
4. `tsc --noEmit`、`vite build`、`cargo check` 通过。
5. 设计/软件同条件截图对照，登记差异。

## 5. 验证与回退

- 验证：类型检查、构建、Rust 编译；设计侧 14 场景截图与断言；软件侧结构与状态断言。
- 回退：新增命令为纯增量；面板样式以独立文件替换，回退时恢复 `GitPanel.css` 与 `index.tsx` 即可，无数据库迁移。

## 6. 未决项与假设

- 假设：受管 store 文件方案（`git-credentials`）在该项目环境中可用；若 Windows 下 `GIT_CONFIG_COUNT` 注入受限，退化为 `credential.helper` 命令形式。
- 未决：是否支持删除远程、标签管理，留待后续 CR。
