# LLD-CR061：移除内置预置模型供应商实现方案
- 关联：[CR-061](../PRD/CR-061-移除内置预置模型供应商.md) / [FEAT-014](../Plan/Feature/FEAT-014-供应商模型与能力适配.md) / [STORY-081](../Plan/Story/STORY-081-移除内置预置模型供应商.md)
- 本次设计范围：取消预置供应商写入、冒烟链路改为自建供应商。
- 范围收窄（用户 2026-11-22 追加指令：「老用户不用管，用户自己会删除的」）：**不做老装遗留预置行的自动清理**，由用户在界面自行删除。

## 1. 当前实现与影响面

- 预置写入：`db.rs::seed_default_provider` 在 `migrate()` 末尾调用，仅当 `provider` 表为空时写入 `prov-tierflow-default`（anthropic 协议、两个端点 `https://tierflow.cn`、两个模型 `tierflow`/`tierflow_pro`），**不带密钥**。
- 依赖该预置行的链路：
  - `commands/smoke.rs::smoke_set_tierflow_key` 把测试密钥挂到 `prov-tierflow-default`；
  - 前端 `src/smoke/runner.ts` 断言「应有预置 TierFlow 供应商」并用其 id 建会话。
- 不依赖预置行的部分：设置页供应商界面、`provider_list`/`provider_save`/`model_candidates` 等通用命令；用户自建供应商不受影响。
- **重要事实**：本机实际库中的 TierFlow 是用户自建（id `prov-d4fbad9c…`），与预置 id 不同——移除预置不影响用户自己的配置。

## 2. 选定方案

### 2.1 取消预置写入

删除 `db.rs::seed_default_provider` 函数与其调用点。`migrate()` 不再写入任何供应商，新装库 `provider` 表为空。

### 2.2 老装遗留预置行：不自动清理（范围收窄后的结论）

初版实现包含「启动迁移阶段按固定 id 清理预置行 + 同步删除其独占密钥」。用户明确「老用户不用管，用户自己会删除的」后，**该部分整体移除**：

- 不新增任何清理迁移；`db::migrate` 不再有任何供应商相关写操作。
- 老装库中的 `prov-tierflow-default` 原样保留，出现在用户的设置列表里，由用户自行点击删除。
- 删除路径复用既有 `providers::provider_delete`：删除 provider 行后，只清理该供应商**独占**的 secretRef（`unreferenced_secrets` 判定引用数为 0 才删），被其他密钥复用的条目保留。设置页已有删除按钮与确认弹窗，用户无需任何额外操作。

**理由**：移除预置供应商本身只是「不再凭空造一个供应商」；老装用户看到它、觉得多余、点一下删除，是显式且可逆的用户决定，优于程序替他做不可逆删除。自动清理还需要跨 DB 与 `secrets.json` 两处协调，反而引入误删风险面。

### 2.3 冒烟链路改造

- 后端 `smoke_set_tierflow_key`：不再挂到预置供应商，改为在冒烟库中**自建**供应商 `prov-smoke-tierflow`（名称「冒烟 · TierFlow」）+ 两个端点（anthropic/openai）+ 两个模型（`tierflow`/`tierflow_pro`，与旧预置同口径）+ 密钥绑定。id 与预置 id、用户 id 均不同。
- 前端 `src/smoke/runner.ts`：断言从「应有预置 TierFlow 供应商」改为「冒烟自建供应商就位」——先调 `smoke_set_tierflow_key` 写入供应商，再校验其端点数与 `tierflow` 模型存在；后续真实对话/工具调用用例沿用 `liveProviderId`。

## 3. 数据设计结论（DB）

**无新增表、无新增列、无数据迁移。** 复用既有 `provider` / `provider_key` / `provider_endpoint` / `model` 与 `secrets.json`。本 CR 只取消写入与调整冒烟自建，不触及存储结构。

## 4. 实现步骤与验证

1. `db.rs`：删 `seed_default_provider` 及其调用点（`migrate` 末尾）。
2. `smoke.rs`：`smoke_set_tierflow_key` 改为自建供应商。
3. `runner.ts`：冒烟断言同步。
4. 验证：单测全量（既有 242 项应零回归）、`npm run build`、进程级验证（真实二进制对空数据目录启动，确认 `provider` 表为空）。

## 5. 未决项、假设与风险

- 老装用户的遗留预置供应商需用户自行删除；设置页删除入口与后端密钥连带清理均为既有能力，无需新增。
- 不涉及界面变化：设置页供应商列表本就有空态「尚无供应商，请新建。」，无需新增设计。
- 冒烟用例的真实网关执行需外部密钥（`TIERFLOW_SMOKE_KEY`），本轮只验证代码与断言同步。

## 6. 变更记录

| 日期 | CR | 变更 |
| --- | --- | --- |
| 2026-11-22 | CR-061 | 取消预置供应商写入；冒烟链路改为自建供应商 |
| 2026-11-22 | CR-061（范围收窄） | 用户追加指令：老用户不用管，自己会删除 | 移除自动清理迁移与受管密钥自动清理代码；老装遗留预置行改由用户在界面自行删除 |
