# LLD-CR089：知识库图谱与本地语义实现

- 归属 FEAT-009／[STORY-014 CR-089](../Plan/Story/STORY-014-服务器列表与知识库三栏阅读.md#cr-089-图谱与本地语义)；[需求](../PRD/CR-089-知识库图谱与本地语义.md)／[DB](../DB/DB-CR089-知识库语义向量索引.md)／[UI](../UI/文档/UI-CR089-知识库图谱.md)。
- 版本 v1（2026-11-25）；**v2 已实现（2026-11-25，待验收）**。

## 0. 实际实现记录（v2）

- 图谱：`kb_graph.rs`（只读，depth 1-3，节点≤200/边≤400，未启用库报错，未解析用 `missing:<name>` 虚拟节点）；前端 `KnowledgeGraph.tsx` canvas 力导向、无新依赖；Reader 右栏新增「图谱」页签。
- 语义：`kb_semantic.rs` 用 `ort 2.0.0-rc.15`（load-dynamic）+ `tokenizers 0.21` + `ndarray 0.17`；模型 Xenova/bge-small-zh-v1.5 `model_quantized.onnx`（24,010,842B，sha256 15b717c3…）+ tokenizer.json；CLS+L2；int8 存 `kb_embed`；RRF k=60。
- 运行时：`onnxruntime.dll` 1.31.0（17,253,176B，sha256 0c42dc4e…），随模型目录放置；`ensure_model()` 自动设 `ORT_DYLIB_PATH`。**合计约 41.3MB，超出原 30MB 预算**，待用户确认。
- 接线：保存后同进程更新该篇向量（失败只记日志）；`lib.rs` 首启后台逐库建索引（可取消、进度日志）；`ai_tools` 的 `knowledge_search` 改为关键词+语义 RRF，返回 `semantic/degraded`；新增 `knowledge_links`、`knowledge_graph` 两个内置工具（projectId 注入）。
- 首次启动下载（用户选定「不打进安装包」）：`kb_semantic::install` 复用 `updater::accelerated_fetch`（候选源按序尝试、慢源 30 秒/512KiB 切源、单源 600 秒上限、SHA-256 落盘校验），模型走 hf-mirror 与 HF 双候选；onnxruntime.dll 用 `RangeReader`（Read+Seek over HTTP Range）**只取 NuGet 包中那一个条目**，实测 9,842,975 B / 4.3 秒，而非整包 159MB。安装位置为应用数据目录 `semantic-model`，启动时注入 `NESTCRAFT_EMBED_MODEL` 与 `ORT_DYLIB_PATH`。界面为 UI-CR089 SC-M01～M04 四态。
- 未做：Reader 搜索框语义徽标与索引进度 UI；真实 Tauri 端到端；万块性能实测。
- 验证：Rust 24 项（links5/graph7/tools6/semantic6）、图谱组件 19 项、`cargo check`/`npm run build` exit 0，见 [REPORT-CR089](../Test/REPORT-CR089-正式实现与验证.md)。

## 1. 现状与影响面

- 双链索引 `kb_link` 已由 CR-088 提供（解析/反链/改名修复），是图谱的唯一数据来源，**不新增推断**。
- 检索为「切块 + SQLite FTS5 + 中文 bigram」，模块头已声明不引入向量；本轮新增**独立**语义通道，不改变原关键词通道与既有接口语义。
- 不改 AI 授权、MCP 客户端、CR-084 预览与 Office 转换链路。

## 2. 图谱

- 接口 `kb_graph(libraryId, noteId?, depth=1..3, includeAttachments, onlyUnresolved)`：
  - 节点：`knowledge_note_index`（笔记）+ 可选目录清单中的附件；`id/label/path/kind/degree`，不含正文。
  - 边：`kb_link` 中 resolved 边；`onlyUnresolved` 时输出 `missing:<name>` 虚拟目标。
  - 预算：节点 ≤200、边 ≤400，超限 `truncated=true`；只读，库未启用直接报 `KB_LIBRARY_UNAVAILABLE`，不返回空图冒充成功。
- 前端 `KnowledgeGraph`：canvas 自实现力导向（斥力/弹簧/向心/阻尼），无第三方图库；拖拽平移、滚轮 0.3–3x、点选高亮邻接、双击展开、`onOpen` 回跳笔记；加载/空/截断/错误四态；遵循 UI-SCROLL-001。

## 3. 语义层

- **模型**：`bge-small-zh-v1.5`（512 维），int8 量化；ONNX 推理。模型与分词器
  随包或按 `scripts/prepare-semantic-model.mjs` 准备，**不入 git**；缺失返回 `SEMANTIC_MODEL_UNAVAILABLE`。
- **切块**：Markdown 按段落聚合到 200–400 字，块 key 稳定；与检索端一致。
- **向量**：int8 存 `kb_embed.vector`（长度=dim）；查询向量同样 int8；相似度=点积（等价余弦，因均已归一化）。
- **混合召回**：关键词 Top-20 + 语义 Top-20 → **RRF(k=60)** 融合；返回每条命中标注 `source=keyword|semantic|both`。
- **增量**：Markdown 保存成功后，同一事务内删旧行→编码新块写入；编码失败**不回滚正文保存**，仅标记语义待重建（与既有 `index_error` 同思路）。
- **首启后台建索引**：启动后台任务按库扫描，进度与可取消；不阻塞窗口；同一时刻单任务。
- **降级**：模型不可用/推理失败 → 关键词通道照常，结果标记 `semantic: unavailable` 与原因；不得静默冒充语义。

## 4. 内置工具（进程内）

`knowledge_search / knowledge_read / knowledge_links / knowledge_graph / knowledge_list`。统一：
- 校验库 `enabled=1`；带 `projectId` 时必须 `project_library_grant.readAllowed=1`，否则 `KB_ACCESS_DENIED`。
- 预算：read ≤64KiB、search/list ≤20 条、片段 ≤200 字、graph 节点 ≤50、边 ≤100。
- 不返回整篇正文；read 按偏移读文本并处理 UTF-8 边界；可被既有「工具开关」单独停用；调用留审计（可选文件，失败静默）。

## 5. 数据

见 [DB-CR089](../DB/DB-CR089-知识库语义向量索引.md)：`kb_embed` 派生表，`modelVersion` 变化视为失效。

## 6. 预算与目标

| 项 | 目标 |
| --- | --- |
| 安装包增量 | 模型 ≤30MB（int8）；推理运行时另计，优先纯 Rust 后端减少 DLL |
| 首次建索引 | 约 1 万块 CPU 2–4 分钟，后台可取消 |
| 查询延迟 | 语义 ≤30ms、混合 ≤60ms（万级块，暴力点积） |
| 内存 | 常驻 +80–150MB |

## 7. 验证

- 图谱：Rust 单测（depth/筛选/截断/未授权库）+ 真实组件 Playwright（节点边、选中、双击、筛选、空态、深色、390、滚动三态）。
- 语义：`sim("如何申请退款","退款流程是什么") > sim("如何申请退款","服务器磁盘告警")` 具体数值；临时库 `semantic_search("想退货怎么办")` 命中"退款"笔记；降级路径。
- 工具：未授权拒绝、read 截断与多字节边界、graph 截断、list 不返回正文。
- 集成：`npm run build`、`cargo check`，以及定向 `cargo test`。

## 8. 风险与回退

- 中文效果需实测，先做基线（纯关键词）对照，再定是否调权重；模型体积/首启耗时为已声明代价。
- 回退：关闭语义开关或 `DROP TABLE kb_embed` → 自动回落关键词；关闭图谱入口 → 其余阅读功能不受影响。
