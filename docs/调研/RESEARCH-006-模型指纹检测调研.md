# RESEARCH-006：模型检测是否增加「模型指纹检测」调研

- 日期：2026-11-24；负责人：lead；来源：用户指令——「调研一下模型检测中是否需要增加一项指纹检测。我看好像只有 codex 和 claude 的，看看有没有论文/github 项目支持检测 deepseek、glm、minimax、grok 等模型的指纹。给出报告」。
- 任务类型：调研（仅本报告与 `docs/tmp/` 过程材料；未修改任何正式源码、配置或设计资源）。
- 关联现状：[CR-058](../PRD/CR-058-模型检测十九针探针.md) / [STORY-075](../Plan/Story/STORY-075-设置模型检测十九针探针.md) / [LLD-CR058](../LLD/LLD-CR058-模型检测探针实现.md)。
- 方法与限制：`web_search` 工具因供应商余额不足不可用、box 无额度；改用本机直连 arXiv API／arXiv HTML 全文／raw.githubusercontent.com 逐篇核实。**GitHub 网页搜索与 api.github.com 被限流，未能做全站仓库普查**；GitHub 结论以论文自带官方仓库链接逐一验证为准（见 §6）。Bing/DDG 通用搜索被反爬或结果不相关，不作为依据。所有论文均实际读取摘要或全文关键段，未凭标题推断。

## 1. 结论先行

1. **「只有 codex 和 claude」的印象基本属实，但位置要说准**：本项目 19 针里真正"认厂商"的硬编码只有两处——P5 响应头指纹只认 OpenAI 特征头（`openai-processing-ms` 等），P7 套壳关键词表 12 个词全是 OpenAI/Anthropic/IDE 生态（cursor、copilot、claude code…）。**P2 档位回显其实已覆盖 DeepSeek/GLM/Qwen/Gemini/Claude**（有单测），但 MiniMax、Grok、Kimi、Doubao 命名完全不命中规则，落入「档位规则未覆盖」兜底。参照平台 gpttest.xyz 比本项目更偏 GPT：其实测题库连 claude/deepseek 字样都没有，档位映射纯 GPT 世代正则。
2. **学术界确有可直接支撑 DeepSeek/GLM/MiniMax/Grok 指纹检测的工作**，最直接的是 **NumPrint（arXiv:2611.14010，2026-11）**：51 个商用模型清单明确含 `deepseek-v4.1-flash`、`glm-5.3/5.1`、`minimax-m2.7/m3`、`grok-4.6/4.7`、`kimi-k3`、`doubao-2.1-*`、`qwen3.8-*` 等，单条定长整数序列即可 92.72% 闭集识别，4 条答案 97.12%。**但截至本次核查其代码/数据未见公开发布**。
3. **最贴合中转站偷换场景的是 Contagious Fingerprints（arXiv:2611.18104，2026-11）**：实测 DeepSeek V4.1 Flash 顶替 Claude Sonnet、MiniMax M3 开放集替换、GLM-4.5-Air held-out，并证明「多轮历史会传染指纹」——这正是本项目 P8 多轮锚点之外缺失的维度；其 Lineup 方法（同历史采样参考分布再排位检验）无需训练分类器。论文给出的 TurnPrint 仓库当前 404（未公开或已删）。
4. **建议：值得增加，但按「第 20 针：行为指纹一致性」增量落地，而不是引入重型分类器**。分三步：① 零成本补齐现有 P2/P5/P7 的国产与 Grok 盲区；② 新增轻量行为指纹针（数字偏好序列 + 身份自述交叉验证，输出「与声称家族一致/不一致/无法判定」三态辅助信号，不动 19 针主评分）；③ 若将来要家族级自动归类，再评估 LLMmap 模板扩展或 NumPrint 式离线分类器。理由与风险见 §5。用户追问「能否指认是哪个模型冒充的、最像哪个」——可以，方法原生输出即候选排名，边界与落地形态见 §6。
5. **必须同时写进设计的反面证据**：token 计数只能证明「共享分词栈」不能证明家族血缘（arXiv:2608.29930 冻结阈值 holdout 研究，Qwen/DeepSeek 同族对都翻车）——直接约束本项目 P17/P18 对账针的结论措辞；长历史会把诚实模型误报成偷换（Contagious Fingerprints 误报率可达 1.00）——行为指纹针必须用全新短会话探测。

## 2. 本项目现状核对（读源事实）

| 位置 | 现状 | 厂商覆盖缺口 |
| --- | --- | --- |
| P2 回显档位表 [model_probe.rs:466](../../src-tauri/src/commands/model_probe.rs#L466) | 秩表 max/opus/pro/reasoner/plus=4…mini/nano/lite=0；`-chat`=3；参数量 `(\d+)b`；GPT 代数 | 单测已覆盖 qwen/glm-4-plus→flash/deepseek-reasoner→chat/claude/gemini 降级；**minimax-m2/m3、abab、grok-4(-fast/-heavy)、kimi、doubao、hunyuan、ernie 不命中任何规则** → Mismatch 兜底警示 |
| P5 头指纹 [model_probe.rs:1272](../../src-tauri/src/commands/model_probe.rs#L1272) | 只认 `openai-processing-ms`/`openai-organization`/`x-ratelimit-*`、`cf-ray`、`x-oneapi-request-id`/`x-request-id` | Anthropic（`request-id`、`anthropic-ratelimit-*`）、DeepSeek、智谱、Moonshot、xAI 等官方特征头一概落入「无明显厂商特征头」；渠道轴对非 OpenAI 官方直连基本失明 |
| P7 套壳关键词 [model_probe.rs:45](../../src-tauri/src/commands/model_probe.rs#L45) | cursor/copilot/windsurf/trae/cline/kiro/augment/codeium/claude code/you are claude 等 12 词 | 无 grok CLI、gemini CLI、qwen-code、iflow 及国产 IDE 套壳词；「you are claude」类身份嗅探没有对应其他厂商变体 |
| P13 动态逻辑 / P6 金丝雀 / P8 锚点 | 厂商无关的行为验真（防背题、防裁剪） | 这些针能证「行为健康」，**不能证「是谁」**——低智商冒充可被抓，但同档位横向偷换（sonnet↔glm-5.3↔deepseek-v4）抓不到 |
| 供应商侧旧 `fingerprint_check` [providers.rs:809](../../src-tauri/src/commands/providers.rs#L809) | 仅 `GET /v1/models` 连通性探测存 fingerprintJson | 与身份指纹无关，名字易混淆；本报告所指「指纹检测」是模型身份识别 |

参照平台核实：gpttest.xyz 前端 JS 中模型档位映射为纯 GPT 世代正则（`/^gpt-6/`、codex/o-series、mini/nano），CLI 伪装选项只有 Codex CLI/TUI、Claude Code、OpenCode、OpenAI SDK；其公开 19 针题库（已存 [tmp/gpttest-probe-bank.md](../tmp/gpttest-probe-bank.md)）通篇不含任何非 OpenAI 厂商名。**本项目 P2 已经比参照平台覆盖面广**；「补非 GPT 短板」在 CR-058 r4 只完成了一半（档位表），身份级指纹仍空白。

## 3. 论文证据（均已实读摘要/全文）

### 3.1 直接覆盖目标厂商的黑盒身份指纹

| 论文 |  venue/时间 | 方法 | 目标厂商覆盖（实读核实） | 对本项目的可用性 |
| --- | --- | --- | --- | --- |
| **NumPrint / One Sequence Is Enough**（[arXiv:2611.14010](https://arxiv.org/abs/2611.14010)） | 2026-11 | 让模型一次输出 294 个 1–355 的整数；SMCT（浅层 MLP+因果 Transformer）聚合数字偏好做 51 类闭集识别；单序列 92.72%，2 条 96.06%，4 条 97.12%；中日英三语提示 | **附录清单明确含 deepseek-v4.1-flash、glm-5.3/5.3-flash/5.1、minimax-m2.7/m3、grok-4.6/4.7、kimi-k3、doubao-2.1-pro/turbo/lite、qwen3.8-max/27b/flash、step、mimo、混元 hy3/hy4 等 51 模型** | 思路可低成本移植成一针（数字偏好向量比对）；**代码/数据未检索到公开发布**，需自采参考基线 |
| **Contagious Fingerprints**（[arXiv:2611.18104](https://arxiv.org/abs/2611.18104)） | 2026-11 | 证明续聊会继承前一模型指纹（DeepSeek 顶替 Claude Sonnet 后文本分类检出率 0.97→0.72；同厂降档 Haiku 0.87→0.54）；提出 **Lineup**：在被声称模型的**同一历史**上采样参考回复，按排位做可交换性检验，无需拟合阈值/logprobs；4 轮审计检出 81% 偷换会话，FPR 0.056 | 13 模型：Claude Sonnet/Haiku 5.5、GPT-6.1 Sol/6 Luna、**DeepSeek V4.1 Flash（官方 API）、MiniMax M3（开放集）、GLM-4.5-Air、Qwen3-8B/32B**、Gemma、OLMo、Mistral-Small | 与中转站「前几轮真、后面偷换」场景完全对口；Lineup 需要能反复调用「声称模型」的可信参考端点（官方直连），成本高，适合抽检不适合每次 19 针全跑；论文仓库 [TTtianTT/TurnPrint](https://github.com/TTtianTT/TurnPrint) **当前 404** |
| **Token Counts Are Not Model Lineage**（[arXiv:2608.29930](https://arxiv.org/abs/2608.29930)） | 2026-08 | 24 个标注端点对、冻结阈值 holdout：prompt_tokens 序列平移不变精确匹配在开发集完美分离，holdout 平衡准确率仅 0.75、灵敏度 0.50；**Qwen 3.8 与 DeepSeek V4 同族对低于阈值** | Qwen、DeepSeek 等真实中转端点 | **负面结论**：token 计数=分词栈指纹≠家族血缘。本项目 P17/P18 对账针的 note 不应表述为「证明了模型身份」；也提醒任何「计费对账即指纹」的宣传不成立 |
| **The Surprising Universality of LLM Outputs**（[arXiv:2604.25634](https://arxiv.org/abs/2604.25634)） | 2026-04 | 输出 token 秩频分布收敛于双参数 Mandelbrot 分布，但参数 q 跨模型干净可分（1.63–3.69，跨模型间距超自举标准差一个量级）；CPU 每 token 2.6μs，支持闭源 API 的 rank-only 模式，用于「静默偷换审计」 | 5 家独立厂商 6 个前沿模型（正文未逐一列名） | 统计指纹路线备选：只需几千输出 token、无需训练；但需要较长采样文本，与 19 针短请求预算冲突，适合独立「深度检测」模式 |

### 3.2 经典/通用方法（可作方法论依据，默认库不含目标厂商）

| 论文 | 方法要点 | 默认模型覆盖 | 目标厂商差距 |
| --- | --- | --- | --- |
| **LLMmap**（[arXiv:2407.15847](https://arxiv.org/abs/2407.15847)，USENIX Security '25） | 8 条精心构造查询（含注入式自我披露、拒答风格、能力边界），开集最近邻距离判别；未知 system prompt/采样参数/RAG/CoT 下鲁棒；>95% 识别 42 版本 | v0.2 预训练模板 **52 模型**：GPT-3.5/4/4o、Claude-3 系、Qwen2/2.5 开源版、Llama、Mistral、Gemma、Phi、granite、internlm 等 | **无 DeepSeek/GLM/MiniMax/Grok/Kimi**；提供 `add_new_template.py` 免重训扩模板（后端仅 HF/OpenAI/Anthropic 三种，OpenAI 兼容端点可接 DeepSeek/GLM/MiniMax/Grok 官方 API） |
| **LLM DNA**（[arXiv:2509.24496](https://arxiv.org/abs/2509.24496)，ICLR 2026 Oral） | 600 固定探针→答案嵌入→共享高斯投影 128 维「DNA」，training-free、双 Lipschitz、遗传性；305 模型进化树 | HuggingFace 305 开源模型（含 GLM-4-32B/9B、DeepSeek 蒸馏系、CodeFuse-DeepSeek-33B 等） | 开源权重可用（GLM/DeepSeek 蒸馏版可测），**闭源 API 旗舰（deepseek-chat 线上版、grok、minimax）不在库**；默认需 Qwen3-Embedding-8B 编码器，桌面端成本高 |
| **DistDNA**（[arXiv:2611.27831](https://arxiv.org/abs/2611.27831)，2026-11） | 用 prompt 条件响应分布 + MMD 处理随机解码（温度/top-p 未知），免分类器，115 checkpoint 上比 LLM DNA 提升 10.36% | 115 个 checkpoint（以开源为主） | 解决「同一模型不同采样参数被误判」问题，是行为指纹针的重要设计约束 |
| **LLMs Have Rhythm**（[arXiv:2502.20589](https://arxiv.org/abs/2502.20589)） | 被动网络侧信道：inter-token time（ITT）节奏指纹，加密流量下仍可识别；16 SLM + 10 商用 LLM | 商用仅 GPT 系、Claude 系、Mistral 系（经网页 GUI 采集） | 无目标厂商；且中转站会重写流式分帧（本项目 P4 已证伪流式普遍存在），ITT 在 relay 场景失真——**不建议采用**，但其「流式节奏是模型固有特征」佐证 P4 的价值 |
| **Behavioral Fingerprinting of LLMs**（[arXiv:2509.04504](https://arxiv.org/abs/2509.04504)） | 诊断提示套件 + LLM-as-judge 打分，18 模型多维行为画像（谄媚、语义鲁棒性、人格聚类） | 脚本 TARGET_MODELS 注释清单含 **grok-4、deepseek-r1-0528、qwen3-235b、glm-4-32b**（OpenRouter ID） | 画像式而非判别式，适合人工审阅参考基线，不适合自动判真伪 |
| **Hide and Seek**（[arXiv:2408.02871](https://arxiv.org/abs/2408.02871)） | Auditor LLM 进化生成判别性 prompt，Detective LLM 归类，家族级 72% | Llama/Mistral/Gemma 等家族 | 精度不足以做红牌依据；思路可用于离线生成针对国产模型的判别题库 |
| **Attacks and Defenses Against LLM Fingerprinting**（[arXiv:2508.09021](https://arxiv.org/abs/2508.09021)） | RL 优化查询选择（3 条即超随机）；防御方用二次 LLM 语义保持改写可显著降低指纹准确率 | — | **对抗性提醒**：中转站加一层改写即可削弱行为指纹；指纹结论只能是概率性辅助信号 |
| **Invisible Traces**（[arXiv:2501.18712](https://arxiv.org/abs/2501.18712)） | 静态（架构特征）+动态（行为）混合指纹，面向多代理/频繁换模的 GenAI 应用 | — | 方法论参考：单一信号不可靠，混合多针正是本项目 19 针架构的学理背书 |
| **Every Model Leaves a Trace**（[arXiv:2610.28434](https://arxiv.org/abs/2610.28434)，2026-10） | 多分辨率指纹：家族→蒸馏→LoRA 变体均可分辨；语义表征跨语言最鲁棒，表面词汇线索被改写后信号减弱 | 开源家族及衍生变体 | 支持「家族级判定可行、精确版本判定难」的分级结论设计 |

（所有权保护类指纹——Instructional Fingerprinting、FPEdit、ImF、LLMPrint、iSeal、AttnDiff 等——需要向模型注入后门/编辑参数，属白盒厂商侧技术，与本项目黑盒验真场景无关，仅列名排除。LLMPrint 官方仓库实测以 Llama 系为主。）

## 4. GitHub 项目核实

| 项目 | 许可证（实读 LICENSE） | 状态 | 目标厂商支持 | 借鉴方式 |
| --- | --- | --- | --- | --- |
| [pasquini-dario/LLMmap](https://github.com/pasquini-dario/LLMmap) | MIT | 活跃（v0.2 PyTorch 重构，含训练/扩模板脚本）。**注意：CR-058 引用的 `ppapagio/LLMmap` 已 404，正确仓库是论文作者本人的 pasquini-dario**，建议后续修订引用时更正 | 默认 52 模板无目标厂商；`add_new_template.py` 可对 OpenAI 兼容端点自建 DeepSeek/GLM/MiniMax/Grok 模板（每模板约 100 组 prompt 配置的采集成本） | 借其 8 查询题型与开集距离判别思路；若引入代码需保留 MIT 版权声明 |
| [Xtra-Computing/LLM-DNA](https://github.com/Xtra-Computing/LLM-DNA) | Apache-2.0 | 活跃，PyPI `llm-dna`，在线 demo dna.xtra.science | 305 开源模型含 GLM/DeepSeek 蒸馏系；API 模型可扩展但需 8B 嵌入编码器 | 不适合直接进 Tauri 桌面端（Python+GPU 依赖）；可作离线参考基线生成工具 |
| [JarvisPei/Behavioral-Fingerprinting](https://github.com/JarvisPei/Behavioral-Fingerprinting) | MIT | 可用；OpenRouter 驱动，无 key 时仿真模式 | 注释清单含 grok-4/deepseek-r1/qwen3/glm-4-32b，改 TARGET_MODELS 即可测任意 OpenRouter 模型 | 诊断提示套件可作 P20 题库素材；judge 依赖强模型，不宜内置 |
| [TTtianTT/TurnPrint](https://github.com/TTtianTT/TurnPrint)（Contagious Fingerprints 论文自称仓库） | — | **404（main/master/codeload 均试过）**，未公开或已删除 | 论文实验含 DeepSeek/MiniMax/GLM | 只能按论文复现 Lineup 思路，暂无代码可复用 |
| NumPrint（2611.14010） | — | 论文全文无 github/huggingface 发布链接（已检索），**未见公开代码/数据** | 51 模型含全部四类目标厂商 | 方法可自行实现（整数序列偏好 + 简单分类器）；参考基线需自采 |
| [gpt-relay-inspector（gpttest.xyz）](https://gpttest.xyz) | MIT（自述，源码经 `/api/opensource/source.tar.gz` 分发，非 GitHub 仓库） | v1.8.0 在线可下载；19 针题库已抓取存档 | **题库与档位映射纯 GPT 向，无任何非 OpenAI 厂商适配**——不能作为「补国产指纹」的参照，反而是本项目已超越的部分 | 继续作为探针工程参照；其「零留存/防背题/中立」宪章与本项目一致 |
| [hifi-hyp/ACL-LLMPrint](https://github.com/hifi-hyp/ACL-LLMPrint) | 见仓库（ACL 2026 主会官方代码） | 可用 | Llama 系为主，白盒/灰盒注入式 | 场景不符，排除 |

## 5. 是否增加：建议与理由

**建议增加，定位为「第 20 针：模型行为指纹一致性（辅助信号）」，同时零成本修补现有三针的厂商盲区。** 不是推翻 19 针，而是补上「同档位横向偷换」这一现有体系抓不到的作弊面。

### 5.1 为什么值得做

- **威胁真实存在且已有量化证据**：Contagious Fingerprints 用真实官方 API 演示了 DeepSeek 顶替 Claude、MiniMax 开放集替换、同厂 Haiku 降档，并证明现有文本分类器在多轮场景大幅漏检。本项目用户恰好多走中转站，P2 只防「回显撒谎」，防不了「回显诚实但行为是别家同档模型」。
- **方法已收敛且轻量可行**：NumPrint 证明一条整数序列就有 92.7% 家族区分度；LLMmap 证明 8 条查询即可开集识别。两者都不需要 logprobs、不需要权重，与本项目 ureq 黑盒架构兼容。
- **国产模型可自建基线**：DeepSeek/GLM/MiniMax/Grok/Kimi 官方 API 全部 OpenAI 兼容（本项目双协议已支持），参考指纹可用官方直连端点离线采集，绕开「开源库默认不带国产模型」的现状。

### 5.2 分阶段方案（供需求评审，不构成编码授权）

| 阶段 | 内容 | 成本 | 判定强度 |
| --- | --- | --- | --- |
| A（修补，近零成本） | P2 秩表补 minimax-m*/abab、grok-*-fast/heavy、kimi-k*、doubao-*、hunyuan-*、ernie-* 命名规则；P5 增补 anthropic/`request-id`、各国产厂商特征头（需先实测采集）；P7 关键词表补 grok/gemini/qwen-code 等 CLI 套壳词 | 纯规则表扩充+单测 | 与现有 P2/P5/P7 同级 |
| B（新针 P20） | 全新短会话发 1–2 条固定熵探针：①定长整数偏好序列（NumPrint 式，本地算特征向量与官方基线库比对）②身份/知识截止自述交叉验证（LLMmap 式，仅作弱信号）。输出三态：一致/不一致/无法判定，**并附「最像的已知候选」top-3 排名与距离**（归因输出头，见 §6）；**只进渠道轴摘要与封顶规则，不单独红牌**（对抗改写可致误报，见 2508.09021） | 每次 +2~4 请求；基线库随版本内置 JSON，官方端点定期重采 | 概率性辅助信号 |
| C（可选深检） | 「深度检测」独立模式：Lineup 同历史参考排位检验（需用户配置官方直连参考端点）或 Mandelbrot 秩频统计（需数千 token 采样） | 高（额外费用与时长） | 接近实证，适合争议仲裁 |

### 5.3 必须写进设计的约束（来自反面证据）

1. **禁止把 token 计数当身份指纹**（2608.29930）：P17/P18 及任何新针的 note 措辞限定为「计费一致性/分词栈一致性」。
2. **行为指纹必须在全新短会话采集**（2611.18104）：带长历史的探测会把诚实模型误报（FPR 可达 1.00）；P20 不复用 P8 的多轮上下文。
3. **温度/采样参数会移动指纹**（DistDNA）：基线采集与检测请求固定 temperature/top_p；无法固定时放宽为分布区间比对。
4. **中转站可加改写层反制**（2508.09021）：P20 结论永远不单独构成「假冒」红牌，只与 P2/P14 等联合封顶——沿用现有双轴判决哲学。
5. **精确版本判定不可承诺**（2610.28434）：结论粒度定为「家族级」（deepseek/glm/minimax/grok/qwen…），版本级只在回显+行为双证时提示。
6. 基线库是**时效性资产**：厂商静默升级会使基线漂移，需要版本号+采集日期+失效策略（类似 models.dev 元数据维护），否则误报会随时间累积。

### 5.4 不做的事

- 不引入 ITT 网络侧信道（relay 重写分帧后失真，且需抓包权限）。
- 不引入白盒注入式指纹（LLMPrint/FPEdit 等，场景不符）。
- 不在桌面端内置 LLM-DNA 的 8B 嵌入编码器（体积/算力不符）；如需 DNA 基线，离线生成后只带 128 维向量。
- 不照搬 gpttest.xyz 的 GPT 中心档位映射（本项目已超越）。

## 6. 追问补充（2026-11-24）：能否识别「实际是哪个模型冒充的、最像哪个模型」

用户追问：现有检测给出「真实概率」，还想知道**被谁冒充、最像哪个模型**。结论：**可以办到，这正是开集归因（attribution）问题，学术方法原生输出就是候选排名，不是二分类**。但有三条硬边界。

### 6.1 方法本身输出的就是「最像谁」

| 方法 | 原生输出形态 | 实读证据 |
| --- | --- | --- |
| LLMmap | **按距离排序的候选榜单**：`[Distance: 32.96] --> LiquidAI/LFM2-1.2B <--`、`[Distance: 40.79] microsoft/Phi-3-mini…`，第一名即「最像的已知模型」；开集设计，距离都远时判「未知模型」 | README 推理示例（已实读）；`test_model.py -k 3` 支持 top-k 评估 |
| NumPrint | 51 类 softmax 分类 → 天然可得 top-k 候选及置信度；附录 F 有完整混淆矩阵（单答案 756 测试样本中 701 对 55 错），**误分类方向本身就是「谁最容易被认成谁」的相似度地图** | 全文 §6.5 Model Confusions and Family Identification、附录 F（已实读目录与统计） |
| LLM DNA / DistDNA | 128 维向量最近邻 = 功能上最接近的模型，可画进化树；DistDNA 用 MMD 距离对多个解码设置下的参考指纹取最近 | 论文摘要与 README（已实读） |
| Contagious Fingerprints | 分类器在已知替换对上训练，直接判「是 DeepSeek 顶替还是 Haiku 降档」；未见过的替换（MiniMax）走开放集拒识 | 全文实验设计（已实读） |

落到本项目 P20 针的输出形态应为：**「声称 claude-sonnet-5.5 → 行为最像：① glm-5.3（距离 d1）② deepseek-v4.1（d2）③ qwen3.8-max（d3）；与声称家族一致性：低」**，而不是只给一个真伪分。这与现有双轴判决（真伪×渠道）兼容，等于给渠道轴加第三列「疑似真身」。

### 6.2 三条硬边界（必须写进需求）

1. **只能指认基线库里的模型**。NumPrint 原文明确：闭集识别，"Extending identification to models outside this set requires unknown-model detection and updates to the reference set"。中转站若用一个库里没有的小众/私有微调模型冒充，只能报「未知模型，与所有已知候选都不像」，不能凭空说出名字。→ 基线库要覆盖中转站常见「廉价替身」（各家 mini/flash/lite/air 档 + 开源部署热门款），并留版本化更新机制。
2. **蒸馏/同源模型会互相混淆，这是原理性的**。LLM DNA 实测 DeepSeek 蒸馏 Qwen 落在 Qwen3 簇旁；Multi-Resolution（2610.28434）证明 LoRA 变体可分辨但信号弱。若替身是「用 Claude 输出蒸馏的 GLM」，行为指纹会同时像两家——此时应输出并列候选而非强行唯一指认。NumPrint 混淆矩阵里同族相邻版本（glm-5.3 vs 5.3-flash 等）也是主要错误方向。→ 结论粒度默认**家族级**，版本级只在距离差显著时给出。
3. **对抗改写与长历史会污染归因**（同 §5.3）：改写层把指纹推向「什么都不像」，长历史把指纹推向「像历史里那个模型」——后者恰好会造成**反向冤案**（真 Claude 续聊后被认成 DeepSeek）。→ 归因探针必须全新短会话；「最像」永远标注为概率性提示，不单独构成红牌。

### 6.3 工程可行性

- 桌面端无需重型依赖：LLMmap 推理是小嵌入模型+最近邻（PyTorch 权重可导出 ONNX 或直接把模板向量内置 JSON，Rust 侧算余弦/欧氏距离即可）；NumPrint 式整数偏好特征甚至可以先用纯统计规则（各数字桶频率向量 + 卡方/JS 散度）起步，零 ML 依赖。
- 基线采集是一次性离线成本：对每个候选模型官方 API 跑固定探针组（LLMmap 约 100 组配置 × 8 查询，或 NumPrint 式 4~10 条序列），存向量+采集日期+模型快照名。国产厂商全 OpenAI 兼容，采集脚本可复用本项目现有双协议线缆层思路。
- 展示建议：P20 结果行展开显示 top-3 候选与距离条，主结论行只写「与声称家族一致/不一致/无法判定」，避免把概率性归因误读成实锤。

**小结**：「验真」和「指认替身」是同一套指纹基础设施的两个输出头，增加 P20 时一并设计即可，不需要第二套系统；但产品措辞必须是「最像的已知候选」，不能承诺「一定查出是谁」。

## 7. 证据与未验证项

- 已实读：LLMmap README+LICENSE+论文全文关键词段；NumPrint 全文附录模型清单、§6.5 混淆分析目录与附录 F 统计（701/756）、闭集限制原文；Contagious Fingerprints 全文模型表与仓库链接；LLM DNA README+LICENSE+全文；DistDNA/ITT/TokenCounts/Universality/BehavioralFP/HideSeek/AttacksDefenses/InvisibleTraces/MultiResolution/LLMPrint 摘要或全文关键段；gpttest.xyz 前端 JS 与 19 针题库全文；本项目 model_probe.rs 相关段落。摘要批量存档：[tmp/fingerprint-arxiv-abstracts.txt](../tmp/fingerprint-arxiv-abstracts.txt)。
- **未验证**：NumPrint/TurnPrint 是否有非 GitHub 渠道发布（仅查了论文内链接与 GitHub 直连）；GitHub 全站同类仓库普查（搜索通道受限）；各国产厂商官方 API 的实际响应头特征（阶段 A 实施前需实测）；任何论文方法在本项目网关上的真实效果（均未运行）。
- 引用更正待办：CR-058 与本报告中 LLMmap 的正确仓库为 `pasquini-dario/LLMmap`（原引用 `ppapagio/LLMmap` 已失效）；是否在 CR-058 原文更正由后续需求变更决定，本次不改历史文档。
- 本报告为调研结论，**不构成编码授权**；若采纳 §5.2，应走 CR 变更流程更新 PRD/LLD/UI（涉及检测页新增针位展示）后再实现。