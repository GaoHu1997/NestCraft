# STORY-030：CLI-SDK管理正式实现

- 类型：用户故事（正式实现）
- 所属 Feature：[FEAT-015 CLI SDK 装卸与会话可用性](../Feature/FEAT-015-CLISDK装卸与会话可用性.md)
- 来源与确认依据：CR-012 + CR-015；逻辑对照 CLI 管理插件参考（REF-002-3）
- 关联：CR-012；验证见 REPORT-008。
- 状态：开发完成，技术验证通过，待用户验收
- 目标：作为使用者，我希望安装/更新/卸载 codex、claude、grok 三种 CLI 并实时影响会话候选。
- 本次包含：npm 任务状态机（queued/running/done/failed/cancelled）、版本列表/检测、registry 设置、会话候选过滤（已安装且启用）、SDK 卡 UI 与任务日志轮询。
- 不包含：渠道镜像管理、安装进度百分比。
- 验收标准：
  - AC-STORY-030-01：单 SDK 同时仅一个任务，重复发起被拒绝（409 语义）。
  - AC-STORY-030-02：安装完成后 sdk_cli_candidates 即时包含该 CLI。
  - AC-STORY-030-03：未安装 CLI 的会话发送被明确阻止并提示安装入口。
- 方案：LLD-FEAT-002 §3.4；实现位置 src-tauri/src/commands/sdk.rs
- 验证结果：编译通过；npm 任务运行时验证待冒烟。
- 验收结论及依据：待验收
