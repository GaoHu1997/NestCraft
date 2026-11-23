# LLD-CR059-FEAT014：模型配置细化与生图实现方案

- 关联：[CR-059](../PRD/CR-059-设置中心评审调整.md) §1.G／[STORY-076](../Plan/Story/STORY-076-模型配置评审调整.md)／[UI-CR059-v3](../UI/文档/UI-CR059-设置中心评审调整.md)；唯一父项 FEAT-014。
- 状态：**方案已登记，未获编码授权，未改正式软件**。
- 技术参照：用户指定 MIT 开源实现（思考等级知识库同一项目）的生图模块形态与协议；本项目差异点为「多生图模型有序列表＋失败自动顺延」（参考实现只有单默认模型＋参数级回退）。

## 1. 本次要解决的问题

模型配置的保存模型分散（模型内保存按钮）、思考等级按钮作用域混乱（单模型/批量未区分）、模型不能排序、缺少生图能力和对应 AI 工具；供应商无法区分稳定标识与可改名称；端点与协议控件形态不符合评审意见。r3 统一收敛。

## 2. 供应商 ID 与名称（G6）

- 数据：`provider.id` 已是稳定主键（`prov-*`），本次明确为**对外可见的供应商 ID**：创建时生成，UI 只读展示，不可编辑；名称（`name`）可改且不影响任何引用。
- 迁移：无 schema 变更；仅新增「新增供应商」表单的 ID 预览（创建后回填）。
- 引用规则：密钥、端点、模型、会话绑定、生图配置一律存 `providerId`，不存名称。现有代码已按 ID 存储，无需迁移；仅补 UI 展示与校验（防前端误把名称当键）。

## 3. 单一保存入口与放弃修改（G2）

- 模型表单移除「保存模型」按钮与独立保存命令；所有模型字段进入供应商草稿（前端已有 draft 机制），底部「保存供应商」一次提交 `providerSave`（一次事务写供应商＋密钥＋端点＋模型）。
- 「放弃修改」两级：
  - 模型级：丢弃当前展开模型的未保存字段，回到最近保存快照（已实现于 `providerSave` 后的 canonical 回填）。
  - 供应商级：整体回滚草稿为最近保存快照；若存在未保存的新密钥/新端点，一并丢弃前先提示。
- 后端：`providerSave` 已是全量覆盖语义，无需新增命令；前端需保证批量草稿一致（现 `buildDraft` 已校验）。

## 4. 思考等级批量补齐（G1）

- 工具条「自动获取思考等级」= 批量：`models.filter(m => !m.visionOnlyImage && m.efforts 为空)` → 逐个 `resolveThinkingLevels`（供应商 `/models` 推理信号 → 本地知识库 → 供应商确认 true 的通用阶梯）→ 回显并标注来源；未命中不写值。
- 模型内「一键获取」= 单模型同一解析器（后端共享一个 `resolve_efforts`）。
- 后端接口建议：`providerResolveEfforts(providerId, modelIds[])` 返回每模型的档位/来源/说明；知识库数据随应用内置（MIT，保留版权与许可）。
- 与获取模型解耦：`providerDiscoverModels` 只返回清单，不等待能力字段（B1 已定）。

## 5. 模型排序（G3）

- 存储：`model.sortOrder`（INTEGER），`providerSave` 按数组顺序写序号。
- 交互：拖动手柄＋插入指示线＋键盘 Alt+↑/↓；顺序即会话模型候选顺序。
- 迁移：旧数据按 `createdAt, rowid` 初始化 sortOrder。

## 6. 端点固定两种协议（G7）

- 每供应商固定两个端点槽：OpenAI、Anthropic。移除「添加端点」入口与任意协议新增。
- 后端兼容：`provider_endpoint` 若存在其他 protocol 行（历史数据），读取时标记为 unsupported 并提示；保存时保留但不参与路由，或按用户确认后清理。**不做静默删除**。
- 「更多端点」= 展开第二个（Anthropic）输入框；两个槽都可填，是否启用由内容非空决定。

## 7. 生图配置与工具（G4）

### 7.1 数据模型（新增）

```sql
CREATE TABLE image_gen_config (
  id TEXT PRIMARY KEY,            -- 单行 'default'
  enabled INTEGER NOT NULL DEFAULT 1,
  orderJson TEXT NOT NULL,        -- ["provX/modelA","provY/modelB"] 先试顺序
  defaultsJson TEXT NOT NULL,     -- {size,quality,n,timeoutMs}
  outputDir TEXT NOT NULL,        -- 相对 app_data_dir
  updatedAt INTEGER NOT NULL
);
```

无迁移风险（新表）；`orderJson` 中的项以 `providerId/modelId` 引用，供应商或模型删除时启动校验剔除并提示。

### 7.2 生成流程（多模型顺延）

```
for (candidate of order) {
  if (provider 端点不支持 images) { attempts.push({model, error:"endpoint"}); continue }
  参数 = defaults ∪ 调用参数
  for (attempt in 0..4) {
    resp = POST {baseUrl}/images/generations   // 有参考图 → /images/edits (multipart image[])
    if ok → 解析(b64_json | url→下载) → 落盘(不覆盖) → return {images, model, paramsUsed, revisions, attempts}
    revision = classify(resp)   // response_format / quality / size / n
    if revision && revisions.length < 4 { 应用降级; continue }
    attempts.push({model, error: sanitize(resp)}); break
  }
}
return error(汇总 attempts)
```

- 错误分类：`auth`(401) / `permission`(403) / `endpoint`(404) / `param`(4xx) / `upstream`(429,5xx) / `timeout` / `aborted` / `config` / `reference`；全部脱敏（剥 Bearer、sk-、密钥回显）。
- 超时与取消：整条链路共享一个 `timeoutMs` 与 AbortSignal（默认 15 分钟，界面可配 5/10/15/30/60）。
- 落盘：默认 `<app_data_dir>/generated-images/<prompt前40字>-<时间戳>.png`；同名自动加 `-2`、`-3`；**永不覆盖**。

### 7.3 内置 tool 注入

- 工具名 `generate_image`，注册进 workbench MCP 工具目录（`ai_tools.rs`），registry_id = `imagegen.generate`，纳入 capability 启停（与其它内置工具一致，停用即从 tools/list 消失）。
- 输入 Schema：

```json
{ "type":"object", "additionalProperties": false, "required":["prompt"],
  "properties": {
    "prompt": {"type":"string","description":"完整画面描述：主体、构图、风格、光照与需出现的文字"},
    "model":  {"type":"string","description":"可选；指定生图模型（provider/modelId），缺省按配置顺序尝试"},
    "size":   {"type":"string","description":"如 1024x1024；缺省取配置默认"},
    "quality":{"type":"string","description":"low|medium|high|auto"},
    "n":      {"type":"integer","description":"张数 1-4"},
    "reference_images": {"type":"array","items":{"type":"string"},"description":"本地参考图路径；非空走 /images/edits"},
    "path":   {"type":"string","description":"落盘 .png 或目录；缺省自动命名"}
  } }
```

- 返回：`{ images:[{filePath,mime}], model, prompt, paramsUsed, revisions, attempts }`；MCP 文本块附 Markdown 图片语法（`!` + `[生成图片]` + `(真实文件路径)`）并要求 AI 最终回复逐张嵌真实路径、禁止虚构 URL。
- 总开关关闭时：工具从 tools/list 消失，`call_tool` 返回明确错误「生图已在设置中关闭」。
- 中文名映射：`generate_image` → 「工作台·生成图片」（并入 UI-CR060 映射表，两侧一致性单测沿用）。

### 7.4 安全与成本

- 密钥只在后端请求栈内解析（沿用受管密钥机制），不落日志、不进结果；错误信息脱敏。
- 不跟随重定向下载（或仅同源跟随），防 SSRF；参考图路径必须落在受管目录内。
- 成本提示：界面说明「每次生成调用上游计费接口」；n 上限 4。


## 7.5 密钥协议→端点绑定与按密钥模型探测（r8）

### 7.5.1 协议→端点绑定

- 数据：`provider_key.protocol`（'' | 'Chat' | 'Responses' | 'Anthropic'）；空＝沿用供应商默认。
- 解析：`resolveKeyTarget(key, provider)` → `{ wire, baseUrl }`：
  - key.protocol 为空 → 用 provider.protocol 的 wire 与其端点；
  - key.protocol 为 Chat/Responses → wire=openai，baseUrl=OpenAI 端点；
  - key.protocol 为 Anthropic → wire=anthropic，baseUrl=Anthropic 端点。
- 请求与探测都用该函数取目标；端点缺地址时明确报错（不静默回落到另一端点）。
- 迁移：无 schema 变更（现有字段已存在）；仅新增解析函数与 UI 展示（`协议 · 端点`）。

### 7.5.2 按密钥模型探测（参考 MIT 开源实现）

- 触发：①保存供应商后异步（后台任务，不阻塞保存响应）；②密钥范围表单「立即探测」。
- 前置：启用密钥 ≥2；provider 有已声明模型清单；provider 协议可列举（openai/anthropic 的 `/models`）。
- 流程（每把启用密钥）：

```
targets = key.protocol ? [对应端点] : (供应商协议端点 + 另一协议端点，若有地址)
served  = union(每个 target GET /models 的 id)    // 任一失败则该 target 跳过
if served 为空 → 保留上次范围（不写空）
declared = provider.models.id
intersection = declared ∩ served
if intersection == declared            → 写 NULL（全部，新增自动覆盖）
else if key.manual_scope == 1          → key.models = 旧范围 ∪ (intersection − 旧范围)
                                          soft 标记 manual 保留
else                                   → key.models = intersection；scope_source='auto'
```

- 存储：`provider_key.modelsJson`（现有）+ `scopeSource`（'auto' | 'manual' | NULL）；`probedAt` 时间戳。
- 并发：探测前不在事务内；写回时重新读取模型清单与密钥列表（避免覆盖用户同时的编辑）；写入使用单事务并校验 `providerId + keyId` 仍存在。
- 失败语义：单个 target 失败 → 不计入（不是「不支持」）；全部 target 失败 → 不写、保留上次结果并记录错误；密钥被删除/停用 → 跳过并中止该密钥写回。
- 成本：每次探测 = 启用密钥数 × target 数 次 `/models` 请求；仅在保存与手动触发时发生。

## 8. 影响范围

- 前端：`SettingsModels.tsx`（大改：供应商 ID、协议卡片、固定端点、密钥浮层、卡片点选、模型无保存、批量思考等级、模型拖动）、新增 `SettingsImageGen.tsx`、`api/index.ts` 绑定、`settings.css` 增量。
- 后端：`providers.rs`（sortOrder、端点固定语义）、新增 `image_gen.rs`（配置/生成/工具注册）、`ai_tools.rs`（注册 generate_image）、`dispatch.rs`（无改动，复用 MCP 注入）、`db.rs`（新表迁移）。
- 不改：权限门禁、知识库授权、MCP OAuth、CLI 检测链路。

## 9. 验证计划（实现后）

- 单测：供应商 ID 不随名称变化；模型排序持久化；批量思考等级只填未配置项；生图多模型顺延（构造第 1 个 401 → 第 2 个成功）；参数降级链；落盘不覆盖；密钥脱敏；tool 停用后从 tools/list 消失且调用被拒。
- 进程级：`verify-ai-tools.mjs` 扩展 `generate_image` 的 tools/list 与 call。
- 端到端：真实供应商生成一张图并落盘；AI 会话内调用并嵌图；失败顺延可见 attempts。
- 设计对照：同视口浅/深色成对截图 + CR-049 动态滚动证据。

## 10. 未决与风险

1. 历史数据中存在非 openai/anthropic 的端点协议行：保留并标记 unsupported，清理需用户确认（不静默删除）。
2. 生图模型与聊天模型的「模态互斥」：模型标为生图后不进会话模型候选（沿用现行过滤），需在 UI 明示。
3. `generate_image` 与未来第三方生图 MCP 工具重名：workbench 内置优先，冲突时工具名加 `workbench_` 前缀（沿用 CR-060 约定）。
4. 参考图编辑（`/images/edits`）在部分中转站不可用，按 404 归入 `endpoint` 并顺延下一个模型。

## 11. 变更记录

| 日期 | 变更 | 依据 |
| --- | --- | --- |
| 2026-11-22 | 建立方案（r3/G1～G8） | 用户 2026-11-22 模型配置第二轮意见 |
| 2026-11-22 r8 | 新增 §7.5：密钥协议→端点绑定解析、按密钥模型探测（全支持留空/部分写交集/手动只追加/单密钥跳过/失败保留） | 用户 2026-11-22：「选了那个协议就要用那个协议的端点…保存后异步探测每个密钥支持什么模型自动勾选…」 |