# DB-CR059：模型配置与生图数据设计

- 关联：[CR-059](../PRD/CR-059-设置中心评审调整.md) §1.G／[STORY-076](../Plan/Story/STORY-076-模型配置评审调整.md)／[LLD-CR059-FEAT014](../LLD/LLD-CR059-FEAT014-模型配置与生图实现.md)；唯一父项 FEAT-014。
- 状态：**已实现（2026-11-22），迁移幂等、无破坏性变更**。
- 迁移位置：`src-tauri/src/db.rs` 的 `migrate_cr059_model_config()`（在 CR-058 迁移之后调用）。

## 1. 变更总览

| 表 | 变更 | 兼容性 |
| --- | --- | --- |
| `provider_key` | 新增 `protocol` / `modelsJson` / `scopeSource` / `probedAt` | 可空或带默认值，旧行自动读为「默认协议 + 全部模型」 |
| `model` | 新增 `sortOrder` | 默认 0；迁移时为历史行按 `createdAt` 回填序号（仅在全部为 0 时执行一次） |
| `image_gen_config` | 新建单行表 | 新表，无历史数据风险 |

## 2. provider_key

| 字段 | 类型 | 含义与约束 |
| --- | --- | --- |
| `protocol` | TEXT NOT NULL DEFAULT '' | 密钥协议。`''`＝沿用供应商默认；`Chat`/`Responses` → OpenAI 端点；`Anthropic` → Anthropic 端点。保存时校验是否为这四值之一。 |
| `modelsJson` | TEXT | 该密钥可用模型 ID 的 JSON 数组。空数组/ NULL ＝全部模型（后续新增自动覆盖）。 |
| `scopeSource` | TEXT | 范围来源：`auto`（探测写入）／`manual`（手动指定）／NULL（未限定）。 |
| `probedAt` | INTEGER | 最近一次探测完成时间（毫秒）。仅用于内部与手动探测判断，**界面不显示**（CR-059 G14）。 |

写入路径：`provider_save` 整表替换该供应商的密钥行；`probedAt` 从旧行按 id 保留，其余字段以草稿为准。
探测写回：`provider_probe_key_scopes` 返回结果，由前端按规则写入草稿后再随保存落库（避免探测与用户编辑的写竞争）。

## 3. model.sortOrder

- 该供应商内的展示与候选顺序（`ORDER BY sortOrder, createdAt`）。
- 保存时按数组下标写 `sortOrder`（前端拖动排序后的顺序即下标）。
- 迁移回填：`UPDATE model SET sortOrder = (同供应商内 createdAt 不晚于本行的数量) WHERE NOT EXISTS (SELECT 1 FROM model WHERE sortOrder <> 0)`——幂等，只在首次全为 0 时生效。

## 4. image_gen_config

| 字段 | 类型 | 含义与约束 |
| --- | --- | --- |
| `id` | TEXT PRIMARY KEY | 固定 `'default'`（单行配置）。 |
| `enabled` | INTEGER NOT NULL DEFAULT 1 | 总开关。关闭时 `generate_image` 拒绝生成。 |
| `orderJson` | TEXT NOT NULL DEFAULT '[]' | 有序「先试」列表，元素为 `providerId/modelId`。保存时校验每一项都存在于当前生图候选，且不重复。 |
| `defaultsJson` | TEXT NOT NULL DEFAULT '{}' | `{size, quality, n, timeoutMin}`；`n` 限 1–4，`timeoutMin` 限 1–60。 |
| `outputDir` | TEXT NOT NULL DEFAULT 'generated-images' | 相对应用数据目录；拒绝 `..`、绝对路径与含 `:` 的路径。 |
| `updatedAt` | INTEGER NOT NULL | 毫秒时间戳。 |

候选集来源：`model.imageGen = 1` 且关联供应商未被停用，且供应商协议为 `openai`（Anthropic 无 images 接口，标为不支持并在运行时跳过）。端点与密钥不在此表——复用该模型所属供应商的启用 OpenAI 端点与第一条启用密钥。

## 5. 回退与恢复

- 全部变更为新增列／新增表，不删除、不改名、不改语义。
- 回退方式：应用回退到旧版本时，旧代码忽略新列与新表，`provider_key`/`model` 现有读写不受影响；`image_gen_config` 保留但不生效。
- 密钥范围（`modelsJson`）与协议（`protocol`）回退后不参与路由，等价于「全部模型 + 供应商默认协议」，属于安全降级。
- 生成图片落盘在 `<app_data_dir>/<outputDir>/`，不属于数据库，回退不清理（用户可按需删除）。

## 6. 验证

- `cargo test --lib` 270 通过（含 CR-059 新增 8 项：知识库匹配 4、生图参数降级/信封解析/脱敏/路径校验 4）。
- 迁移幂等性由 `PRAGMA table_info` 前置判断保证；重复启动不报错。
- 未验证：真实旧库升级（本机库为新装）、真实上游 `/models` 探测与生图请求。
