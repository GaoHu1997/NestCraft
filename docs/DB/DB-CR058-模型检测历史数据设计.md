# DB-CR058：模型检测历史数据设计

- 关联：[CR-058](../PRD/CR-058-模型检测十九针探针.md) / [STORY-075](../Plan/Story/STORY-075-设置模型检测十九针探针.md) / [LLD-CR058](../LLD/LLD-CR058-模型检测探针实现.md)；复用既有 [DB-FEAT-001](DB-FEAT-001-知识授权与工作台数据设计.md) 的 provider / provider_key / provider_endpoint / model 表（只读，不修改）。

## 1. 新表 model_probe_history

检测结果本地留存（仅本地库，不上传），自动保留最近 10 条。

```sql
CREATE TABLE IF NOT EXISTS model_probe_history (
    id                TEXT PRIMARY KEY,          -- uuid
    providerId        TEXT NOT NULL,             -- 供应商 id（provider.id，不设外键：供应商删除后历史仍可读）
    providerName      TEXT NOT NULL,             -- 冗余展示名（供应商删除后历史仍可读）
    modelId           TEXT NOT NULL,
    modelDisplayName  TEXT NOT NULL,
    protocol          TEXT NOT NULL,             -- openai | anthropic
    score             INTEGER NOT NULL,          -- 0~100
    grade             TEXT NOT NULL,             -- S/A/B/C/D
    verdict           TEXT NOT NULL,             -- 真实/存疑/假冒嫌疑/无法判定
    channel           TEXT NOT NULL,             -- 官方直连/聚合中转/逆向套壳嫌疑
    summary           TEXT NOT NULL,             -- 一句话结论
    durationMs        INTEGER NOT NULL,          -- 检测总耗时
    resultJson        TEXT NOT NULL,             -- 逐针结果 [{code,name,status,ms,note}] + 金丝雀/锚点/题目指纹等证据；r5 增 "attribution" 键（P20 归因：consistency/claimedFamily/candidates[{name,family,distance}]/note），旧记录无该键读出 null
    createdAt         INTEGER NOT NULL           -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_model_probe_history_created ON model_probe_history(createdAt DESC);
```

约束与边界：

- **保留 10 条**：每次插入后执行 `DELETE FROM model_probe_history WHERE id NOT IN (SELECT id FROM model_probe_history ORDER BY createdAt DESC, rowid DESC LIMIT 10)`。
- **不做外键**：供应商/模型删除后历史保留为只读记录（providerName 冗余保证可读性）；检测本身要求供应商存在且启用。
- **密钥安全**：`resultJson` 只含状态、耗时、证据摘要与判定；错误信息经密钥/令牌正则脱敏；不含 Authorization、x-api-key 等请求头值。attribution 候选名只含基线库公开模型名与采集日期，不含端点/密钥。
- 迁移：`db.rs::migrate_cr058_model_probe`（`CREATE TABLE IF NOT EXISTS`，幂等，符合本库迁移惯例）。**r5 无表结构变更**：attribution 存于 resultJson JSON 内，无需新迁移；旧记录兼容（缺键 → null → 前端不渲染归因面板）。

## 2. 读写路径

- 写：`model_probe_run` 成功完成 9 针编排后单条插入（P1 失败的「无法判定」结果同样入库，供历史追溯；参数校验失败/配置缺失不产生记录）。
- 读：`model_probe_history_list()` 按 `createdAt DESC` 取 10 条；前端历史弹层渲染，详情展开 `resultJson`。

## 3. 迁移与回退

- 迁移顺序：随应用启动 `migrate()` 幂等执行；无存量数据兼容问题（新表）。
- 回退：表独立，删除该表不影响既有功能；历史记录丢失可接受（检测结果可重测）。
