# HANDOFF：执行与同步 M0 交接

- 日期：2026-11-23（Asia/Shanghai）。
- 授权：用户「Office 先不做，其他的你完成一下」＝正式编码授权；范围限 FEAT-019／FEAT-004／CR-047 的可持续交付增量。
- 状态：**M0/M1 基础已交付并有测试与证据；完整正式实现未达成。** 不得标记目标完成或用户验收通过。
- 本批终止点：2026-11-23 自动轮次上限到达；此后不再自动扩展功能，剩余工作需用户确认 M1 环境与范围后另开执行会话。
- 阶段收口与完成度表：[REPORT-STAGE](Test/REPORT-STAGE-执行与同步M0收口.md)。

## 1. 已完成（可验证）

### 1.1 执行账本与调度（`src-tauri/src/commands/execution.rs`）

- 11 张执行表：批次、任务、步骤、尝试、依赖、事件、检查点、工作包、工作包 Story、义务、义务映射；另加执行计划／授权／审批表。
- 13 态任务状态机、活动任务唯一键、租约与 `fencingToken` CAS、依赖 gate。
- M0 调度：按优先级领取、依赖顺序、退避重试、重试耗尽。
- 恢复：检查点／fence／源版本／旧 writer 预检，停止确认后恢复；启动时过期租约回收。
- 工作包：义务清单、确认门禁、义务到任务／验证项映射。
- G-PLAN：不可变执行计划、授权快照、`execution_plan_check`。
- 适配器：`ExecutionAdapter`、`ScriptedAdapter`、`ProcessAdapter`、`CliAdapter`、`run_task_with_adapter`。
- worktree：`prepare_task_worktree`／`remove_task_worktree`、`run_isolated_command`。
- 审批：`execution_approval` 请求／决定／过期，写入执行事件流；计划级审批门禁阻止未决或已拒审批的运行。
- CLI 参数：`build_cli_invocation`（claude／codex／grok）；`RealCliAdapter` 受控开关默认关闭，`run_task_real_cli` 组合 worktree 与受控适配器。

### 1.2 双向同步（`src-tauri/src/commands/sync.rs`）

- `sync_baseline`／`sync_batch`／`sync_target_journal`：基线、批次状态机、逐目标 hash 对账。
- 条件写回、崩溃对账、只读预览、行级 diff、标题／AC 语义摘要。
- 从已对账批次发布新基线（幂等）。

### 1.3 界面（只读）

- 任务页：批次、状态、统计、详情、执行计划、授权、待审批与风险、事件时间线。
- 同步页：批次、目标对账、语义摘要、两栏差异、重新对账、发布基线（按状态启用）。
- 设计稿：`docs/UI/task-execution-status/`、`docs/UI/sync-batches/`，含浅／深／390 截图与 hash。

### 1.4 安全底线

- 需求写入 `expectedDocumentHash` 版本保护。
- 执行会话的 `featureId` 注入工作台 MCP，`write_requirement_doc` 拒绝跨 Feature 与无父项新建。

## 2. 验证命令与当前结果

```powershell
cd src-tauri; cargo test --offline --lib -- --test-threads=1   # 399 passed / 0 failed / 8 ignored
cd ..; npm run build                                            # 通过（含 tsc）
node docs/Test/design-docs-check.mjs                            # PASS：430 文档 / 5934 链接
```

真实 Tauri IPC 冒烟（执行账本 + 双向同步，38 通过／0 失败）：

```powershell
# 1) 调试构建走 devUrl，需 1420 提供前端；vite 必须绑 IPv4，否则 WebView2 拿不到页面
npm run build
npx vite preview --outDir src-tauri/dist --host 127.0.0.1 --port 1420 --strictPort

# 2) 另开一个终端：双重授权 + 聚焦套件
$env:PATH = "$PWD\mockbin;" + $env:PATH
$env:TAURI_SMOKE = "1"; $env:SMOKE_EXEC_SUITE = "1"; $env:SMOKE_MOCKBIN = "$PWD\mockbin"
.\src-tauri\target\debug\agent-workbench.exe
# 报告：%APPDATA%\com.agentworkbench.app\smoke-report-execution.md
```

证据：`docs/Test/smoke-report-execution.md`、`docs/Test/REPORT-CR047-执行账本M0与写入保护验证.md`、`REPORT-CR032-双向同步M0验证.md`、`REPORT-FEAT019-任务页只读接入验证.md`、`REPORT-FEAT004-同步视图只读接入验证.md`。

已知环境性卡点：历史全量套件在 `chat_session_pin / chat_session_fork` 处会无响应；与本批命令无关，故用聚焦入口单独验证。

## 3. 未完成（不得当作已交付）

1. **真实 CLI runner**：没有启动真实 claude／codex／grok；能力组合、审批门禁生效、整树停止、资源锁与并发槽未实现。
2. **CLI 原生写入硬拦截**：只覆盖工作台 `write_requirement_doc`；CLI 自带文件工具仍可能越界。
3. **完整语义合并**：只有行级 diff 与标题／AC 集合摘要；没有文档模型、语义等价判断、逐段接受或自动合并。
4. **逆向重建**：纯源码恢复管线未实现。
5. **真实项目数据与真实窗口视觉**：IPC 已在真实 WebView2 上验证，但用隔离库与模拟执行；界面视觉对照仍为 Chromium 隔离预览，未在真实窗口内截图比对。

## 4. 如何继续（建议顺序）

1. **确认 M1 范围与环境**：可用 CLI 与账号、可接受的测试工作区、审批 UI 设计稿。
2. **接真实 CLI**：实现 `ExecutionAdapter` 的真实适配器（按 `build_cli_invocation` 参数启动真实 CLI），接入 `run_task_with_adapter`；审批请求在执行前必须存在且 `approved`，否则拒绝启动。
3. **补停止与资源**：整树停止（Windows Job Object 或等价物）、资源锁与并发槽、恢复对账。
4. **补 CLI 原生写入拦截**：受管 gateway／沙箱或平台级限制；仅靠提示词与工作台工具不够。
5. **语义合并**：先选文档模型或解析器，冻结合并规则与冲突 UI 设计，再实现。
6. **真实 Tauri 验证**：使用独立应用数据目录与测试数据，避免污染用户库；完成后补 WebView2 视觉与滚动证据。

## 5. 真实环境验证检查清单（进入 M1 前）

1. **隔离环境**：准备独立测试仓库与独立应用数据目录；不要用真实项目库或用户数据。
2. **版本核对**：确认 claude／codex／grok 的实际版本与 `build_cli_invocation` 参数一致；不一致先修映射，不能沿用旧结论。
3. **最小只读验证**：先用真实 CLI 跑 `--version` 或等价只读命令，确认可启动、可读退出码、可停止。
4. **受控启用**：仅在测试代码或显式配置中把 `enabled` 置真；确认默认路径仍是 `REAL_CLI_DISABLED`。
5. **门禁顺序**：计划存在 → 授权有效 → 审批清除 → 领取 → worktree → 启动；任一步不满足不得启动。
6. **停止与恢复**：验证整树停止、租约过期回收、恢复预检；不能只验证单进程退出。
7. **证据**：记录命令、版本、退出码、worktree 清理结果、事件序列与失败分支，写入新的验证报告。

## 6. 边界与注意事项

- 本批不包含 Office 原生引擎。
- `ScriptedAdapter`、受控 `.cmd`、`git status` 等只用于测试；生产入口不暴露任意命令。
- worktree 不是 OS 安全边界；不可据此宣称隔离。
- 并行会话的 CR-068 等文档与配置改动不属于本批，未由本批修改或冒领。
- 任何真实执行接入前，必须重新核对 CLI 版本参数与能力证据，不能沿用未验证映射。

## 7. 文件索引

- 实现：`src-tauri/src/commands/execution.rs`、`src-tauri/src/commands/sync.rs`、`src-tauri/src/db.rs`、`src-tauri/src/lib.rs`。
- 前端：`src/api/index.ts`、`src/modules/projects/Workspace.tsx`、`src/modules/projects/projects.css`、`src/smoke/design-preview.ts`。
- 设计：`docs/UI/task-execution-status/`、`docs/UI/sync-batches/`、`docs/UI/文档/UI-FEAT-019-任务执行状态.md`、`docs/UI/文档/UI-FEAT-004-同步批次.md`。
- 数据设计增量：`docs/DB/DB-FEAT-019-任务执行数据设计.md`、`docs/DB/DB-CR032-同步基线与语义追踪.md`。