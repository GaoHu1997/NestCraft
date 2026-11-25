/* CR-036 增量夹具：项目卡片、知识树、设置详情、AI 会话与统计。仍为虚构数据。 */
(function (root) {
  "use strict";
  const D = root.DEMO;
  if (!D) return;

  /* 项目卡片补充字段 */
  const extra = {
    "PRJ-1042": { path: "D:/work/booking-service", members: ["林澈", "周野", "陈雨"], tags: ["核心", "进行中"], createdAt: "2026-10-28" },
    "PRJ-1031": { path: "D:/work/ops-console", members: ["周野", "林澈"], tags: ["基础设施"], createdAt: "2026-11-02" },
    "PRJ-1018": { path: "D:/work/research-booking", members: ["陈雨", "林澈"], tags: ["研究"], createdAt: "2026-11-06" },
    "PRJ-1009": { path: "D:/work/nestcraft-site", members: ["陈雨"], tags: ["品牌"], createdAt: "2026-11-09" }
  };
  D.projects.forEach(p => Object.assign(p, extra[p.id] || {}));

  /* 知识库授权与多格式文档 */
  const libs = D.knowledge.libraries;
  const grant = {
    "KB-01": { grantedTo: ["PRJ-1042"], allProjects: false },
    "KB-02": { grantedTo: ["PRJ-1042", "PRJ-1018"], allProjects: false },
    "KB-03": { grantedTo: [], allProjects: false }
  };
  libs.forEach(l => {
    Object.assign(l, grant[l.id] || { grantedTo: [], allProjects: false });
    l.granted = l.allProjects || l.grantedTo.length > 0;
  });
  const types = {
    "KD-011": "md", "KD-012": "md", "KD-013": "md", "KD-014": "md", "KD-015": "md", "KD-016": "md", "KD-017": "md",
    "KD-021": "md", "KD-022": "md", "KD-023": "md", "KD-024": "md", "KD-025": "md"
  };
  Object.keys(D.knowledge.docs).forEach(lib => {
    D.knowledge.docs[lib].forEach(doc => {
      doc.type = types[doc.id] || "md";
      if (doc.id === "KD-014") { doc.type = "pdf"; doc.size = "1.8 MB"; }
    });
  });
  D.knowledge.docs["KB-01"].push(
    { id: "KD-018", title: "架构评审记录", path: "架构/评审-2026-11.pdf", updated: "11-13 15:20", size: "1.8 MB", type: "pdf" },
    { id: "KD-019", title: "发布记录", path: "发布/记录.xlsx", updated: "11-12 10:05", size: "86 KB", type: "xlsx" },
    { id: "KD-020", title: "预约流程图", path: "架构/预约流程.png", updated: "11-11 09:30", size: "240 KB", type: "png" },
    { id: "KD-026", title: "预约样本数据", path: "数据/预约样本.csv", updated: "11-10 14:12", size: "42 KB", type: "csv" }
  );
  D.knowledge.docs["KB-02"].push(
    { id: "KD-027", title: "问卷结果", path: "问卷/结果.xlsx", updated: "11-16 11:40", size: "124 KB", type: "xlsx" }
  );
  D.knowledge.content["KD-019"] = "";
  D.knowledge.content["KD-020"] = "";
  D.knowledge.content["KD-026"] = "activity,slot,remaining,booked\n社区读书会,A-01,2,18\n社区读书会,A-02,0,20\n亲子手工,B-01,5,15";
  D.knowledge.content["KD-027"] = "";
  D.knowledge.content["KD-018"] = `# 架构评审记录（PDF 摘要）

- 日期：2026-11-13
- 参会：林澈、周野、陈雨
- 结论：容量扣减使用条件更新；幂等键保留 24 小时；审计日志不含凭证。
- 待办：补充并发用例；确认取消回补事务边界。

本页为 PDF 设计样例，未嵌入真实文件。`;

  /* 设置：通用、CLI、SDK、供应商详情 */
  D.settings.general = {
    profile: { name: "林澈", email: "lin.che@example.invalid", role: "研发负责人", timezone: "Asia/Shanghai" },
    code: { theme: "跟随系统", fontSize: 13, tabSize: 2, font: "JetBrains Mono", wrap: false, preview: true },
    server: { port: 22, keepAlive: 30, auth: "密钥文件", confirmDanger: true, defaultUser: "ops" },
    dataDir: "安装目录\\data"
  };
  D.settings.providers = [
    {
      id: "PRV-01", name: "TierFlow", protocol: "Responses", enabled: true, updated: "今天 10:12",
      keys: [
        { label: "主凭证", masked: "sk-****...6ce3", on: true, scope: "2 个模型", protocol: "Responses", models: ["tierflow-pro", "tierflow-lite"] },
        { label: "备用", masked: "sk-****...a442", on: true, scope: "1 个模型", protocol: "", models: ["tierflow-lite"] },
        { label: "Anthropic 凭证", masked: "sk-ant-****...7f21", on: true, scope: "2 个模型", protocol: "Anthropic", models: ["tierflow-pro", "tierflow-lite"] }
      ],
      endpoints: [
        { protocol: "OpenAI", url: "https://api.demo.invalid/v1", on: true },
        { protocol: "Anthropic", url: "https://anthropic.demo.invalid", on: true }
      ],
      headers: [{ name: "X-Demo-Client", value: "offline-review" }],
      spoof: "关闭",
      models: [
        { id: "tierflow-pro", name: "TierFlow Pro", modalities: ["文本", "图片"], thinking: true, levels: ["off", "low", "medium", "high"], defaultLevel: "中", context: 200000, maxOutput: 65536, autoLevels: true, on: true },
        { id: "tierflow-lite", name: "TierFlow Lite", modalities: ["文本"], thinking: true, levels: ["off", "low", "medium"], defaultLevel: "低", context: 128000, maxOutput: 32768, autoLevels: true, on: true },
        { id: "tierflow-image", name: "TierFlow Image", modalities: ["生图"], thinking: false, levels: [], defaultLevel: "—", context: null, maxOutput: null, autoLevels: false, on: false },
        { id: "tierflow-image-pro", name: "TierFlow Image Pro", modalities: ["生图"], thinking: false, levels: [], defaultLevel: "—", context: null, maxOutput: null, autoLevels: false, on: false }
      ],
      availableModels: [
        { id: "tierflow-reasoner", name: "TierFlow Reasoner", modalities: ["文本"], context: 200000 },
        { id: "tierflow-vision", name: "TierFlow Vision", modalities: ["文本", "图片"], context: 200000 },
        { id: "tierflow-mini", name: "TierFlow Mini", modalities: ["文本"], context: 128000 },
        { id: "tierflow-embed", name: "TierFlow Embedding", modalities: ["文本"], context: 8192 }
      ]
    },
    {
      id: "PRV-02", name: "本地网关", protocol: "Chat", enabled: true, updated: "昨天 21:40",
      keys: [{ label: "本地", masked: "local-****", on: true, scope: "全部模型", protocol: "Chat", models: ["local-qwen-72b"] }],
      endpoints: [{ protocol: "OpenAI", url: "http://127.0.0.1:11434/v1", on: true }],
      headers: [], spoof: "关闭",
      models: [{ id: "local-qwen-72b", name: "Qwen 72B", modalities: ["文本"], thinking: false, levels: [], defaultLevel: "—", context: 32768, maxOutput: 8192, autoLevels: false, on: true }],
      availableModels: [{ id: "local-qwen-32b", name: "Qwen 32B", modalities: ["文本"], context: 32768 }, { id: "local-embed", name: "Local Embedding", modalities: ["文本"], context: 8192 }]
    },
    {
      id: "PRV-03", name: "备用直连", protocol: "Anthropic", enabled: false, updated: "11-16 09:02",
      keys: [], endpoints: [{ protocol: "Anthropic", url: "", on: false }], headers: [], spoof: "关闭", models: [],
      availableModels: [{ id: "backup-sonnet", name: "Backup Sonnet", modalities: ["文本", "图片"], context: 200000 }]
    }
  ];

  /* CR-059：CLI 管理改为「任务模型路由」——默认只有 1 个兜底槽；模型槽按需新增（0～5），
     折叠为一行摘要。由主 agent 决定使用哪个 CLI；此处只配置「该 CLI 内哪类任务用哪个模型」。演示夹具，非真实调度。 */
  const TASK_TYPES_59 = ["仓库探索", "代码定位", "资料检索", "方案核验", "影响分析", "功能开发", "缺陷修复", "测试验证", "代码审查", "数据处理", "模块重构", "方案设计", "文档整理"];
  D.settings.taskTypes = TASK_TYPES_59;
  D.settings.clis = [
    {
      id: "dsh", name: "dsh 子代理", badge: "内置", version: "v0.2.2-rc.5", installed: true, enabled: true,
      meta: "随宿主提供 · 由主 agent 决定何时使用", permission: "default", expandable: false, builtin: true
    },
    {
      id: "claude", name: "claude cli", version: "v2.1.318", installed: true, enabled: true,
      meta: "由主 agent 决定何时使用 · 2/5 个模型槽", permission: "agent", expandable: true,
      slots: [
        { model: "TierFlow · tierflow-pro", effort: "high", types: ["仓库探索", "影响分析", "方案设计"] },
        { model: "TierFlow · tierflow-lite", effort: "medium", types: ["资料检索", "文档整理"] }
      ],
      fallback: { model: "", effort: "", note: "跟随主 agent" }
    },
    {
      id: "codex", name: "codex cli", version: "v0.48.2", installed: true, enabled: true,
      meta: "由主 agent 决定何时使用 · 5/5 个模型槽（上限）", permission: "agent", expandable: true,
      slots: [
        { model: "MagpieGateway · GPT-5.6 Sol", effort: "high", types: ["功能开发", "缺陷修复"] },
        { model: "MagpieGateway · GPT 6 Astra", effort: "medium", types: ["测试验证", "代码审查"] },
        { model: "MagpieGateway · DeepSeek V4.1 Flash", effort: "low", types: ["数据处理"] },
        { model: "MagpieGateway · GPT 6 Astra", effort: "low", types: ["代码定位"] },
        { model: "MagpieGateway · DeepSeek V4.1 Flash", effort: "medium", types: ["模块重构", "文档整理"] }
      ],
      fallback: { model: "", effort: "high", note: "跟随主 agent" }
    },
    {
      id: "grok", name: "grok cli", version: "—", installed: false, enabled: false,
      meta: "未安装 · 安装后可配置", permission: "default", expandable: false
    }
  ];
  /* CR-059：SDK 版本下拉＝最新 10 个稳定版（倒序）；当前版不在其中时渲染层补入「当前」项。 */
  D.settings.sdks = [
    { id: "dsh", name: "dsh 子代理", package: "随宿主内置", version: "v0.2.2-rc.5", latest: "v0.2.2-rc.5", installed: true, builtin: true, enabled: true, path: "随宿主安装", desc: "随宿主安装，无需 npm 安装 / 升级" },
    { id: "claude", name: "Claude Code SDK", package: "@anthropic-ai/claude-code", version: "v2.1.318", latest: "v2.1.328", installed: true, enabled: true, path: "D:\\devlop\\node-v24.8.0\\claude.CMD", desc: "Claude AI 功能所需。包含 Claude Code SDK 及相关依赖。",
      versions: ["2.1.328", "2.1.327", "2.1.326", "2.1.325", "2.1.324", "2.1.323", "2.1.322", "2.1.321", "2.1.320", "2.1.319"] },
    { id: "codex", name: "Codex SDK", package: "@openai/codex", version: "v0.166.0", latest: "v0.166.0", installed: true, enabled: true, path: "~/.npm-global/bin/codex", desc: "Codex AI 功能所需。包含 OpenAI Codex SDK。",
      versions: ["0.166.0", "0.165.2", "0.165.1", "0.165.0", "0.164.3", "0.164.2", "0.164.1", "0.164.0", "0.163.4", "0.163.3"] },
    { id: "grok", name: "Grok CLI SDK", package: "@xai-official/grok", version: "v0.1.2", latest: "v0.1.4", installed: true, enabled: true, path: "~/.npm-global/bin/grok", desc: "Grok AI 功能所需。包含 xAI Grok CLI 及相关依赖。",
      versions: ["0.1.4", "0.1.3", "0.1.2", "0.1.1", "0.1.0", "0.0.9", "0.0.8", "0.0.7", "0.0.6", "0.0.5"] }
  ];
  /* CR-059：跨 agent 扫描导入演示夹具（虚构路径与条目；正式实现只读配置，不执行指令、不搬登录态）。 */
  D.settings.skillSources = [
    { agent: "Claude Code", root: "~/.claude/skills", items: [
      { slug: "commit-helper", name: "提交助手", desc: "按约定生成 commit message 并核对暂存区。" },
      { slug: "api-review", name: "API 评审", desc: "对照 REST 规范检查接口设计与错误码。" },
      { slug: "release-check", name: "发布检查", desc: "对照发布清单，确认回滚路径与证据。", imported: true }
    ]},
    { agent: "Codex", root: "~/.codex/skills", items: [
      { slug: "test-gen", name: "测试生成", desc: "为指定函数生成边界用例与断言。" },
      { slug: "doc-sync", name: "文档同步", desc: "代码变更后同步 README 与变更日志。" }
    ]},
    { agent: "ZCode", root: "~/.zcode/plugins/skills", items: [
      { slug: "pdf-report", name: "PDF 报告", desc: "把分析结论排版为可交付 PDF。" }
    ]}
  ];
  D.settings.mcpSources = [
    { agent: "Claude Code", root: "~/.claude.json · mcpServers", items: [
      { name: "context7", transport: "stdio", target: "npx -y @upstash/context7-mcp" },
      { name: "playwright", transport: "stdio", target: "npx -y @playwright/mcp" }
    ]},
    { agent: "Codex", root: "~/.codex/config.toml · [mcp_servers]", items: [
      { name: "deepwiki", transport: "http", target: "https://mcp.deepwiki.example.invalid/mcp" }
    ]},
    { agent: "ZCode", root: "~/.zcode/mcp.json", items: [
      { name: "filesystem", transport: "stdio", target: "npx -y @modelcontextprotocol/server-filesystem D:/work", imported: true }
    ]}
  ];
  /* CR-059：Skill 文件夹添加演示夹具（模拟系统文件夹选择框的候选目录）。 */
  D.settings.skillFolders = [
    { path: "D:/skills/deploy-check", valid: true, slug: "deploy-check", name: "部署检查", desc: "部署前核对配置、迁移与回滚步骤。", body: "# 部署检查\n\n1. 核对环境变量与密钥引用。\n2. 确认迁移顺序与回退脚本。\n3. 部署后检查关键业务路径。" },
    { path: "D:/skills/meeting-notes", valid: true, slug: "meeting-notes", name: "会议纪要", desc: "把讨论整理为决议、待办与负责人。", body: "# 会议纪要\n\n输出决议、待办、负责人与截止时间。" },
    { path: "D:/downloads/random-folder", valid: false, slug: "", name: "", desc: "", body: "" }
  ];
  /* CR-059 r2：Tools 树形列表——根节点＝提供方。
     用户决策「AI 必须可以使用工具」：内置全部 18 项统一经 workbench MCP 通道真实注入（目标态）。
     workbench 12 项已由并行 CR-060 落地；原有 6 项注入为 BUG-CR059-01 待实现，行内如实标注。 */
  D.settings.toolTree = [
    { id: "nestcraft", name: "NestCraft 内置", kind: "builtin-live", note: "内置 MCP · 注入会话（6 项待实现）", tools: [
      { name: "fs.read", risk: "低", desc: "读取项目内文件", on: true, pending: true },
      { name: "knowledge.list", risk: "低", desc: "列出项目已授权知识库", on: true, pending: true },
      { name: "knowledge.search", risk: "低", desc: "在已授权知识库内检索", on: true, pending: true },
      { name: "knowledge.read", risk: "低", desc: "读取知识库笔记正文", on: true, pending: true },
      { name: "knowledge.read_many", risk: "低", desc: "批量读取知识库笔记", on: true, pending: true },
      { name: "ssh-exec", risk: "高", desc: "在服务器上执行命令（需连接、授权与逐次审批）", on: true, pending: true },
      { name: "workbench.get_context", risk: "低", desc: "获取当前会话绑定的项目上下文", on: true },
      { name: "workbench.list_projects", risk: "低", desc: "列出项目清单", on: true },
      { name: "workbench.create_project", risk: "中", desc: "创建项目（重名与目录校验与界面一致）", on: true },
      { name: "workbench.update_project", risk: "中", desc: "更新项目名称/根目录/图标", on: true },
      { name: "workbench.get_requirements", risk: "低", desc: "读取项目需求树", on: true },
      { name: "workbench.read_requirement_doc", risk: "低", desc: "读取需求文档正文", on: true },
      { name: "workbench.write_requirement_doc", risk: "中", desc: "创建/更新需求文档（自动编号）", on: true },
      { name: "workbench.list_kbs", risk: "低", desc: "列出知识库与授权状态", on: true },
      { name: "workbench.create_kb", risk: "中", desc: "创建受管知识库", on: true },
      { name: "workbench.set_kb_grant", risk: "中", desc: "设置项目-知识库读取授权", on: true },
      { name: "workbench.list_servers", risk: "低", desc: "列出服务器主机（不含密钥）", on: true },
      { name: "workbench.save_server", risk: "中", desc: "新建/更新服务器主机配置", on: true }
    ]},
    { id: "mcp-filesystem", name: "filesystem", kind: "mcp", note: "stdio · 最近发现 6 个工具", tools: [
      { name: "read_file", risk: "低", desc: "读取受管目录内文件", on: true },
      { name: "write_file", risk: "中", desc: "写入文件（受目录白名单约束）", on: true },
      { name: "list_directory", risk: "低", desc: "列出目录内容", on: true },
      { name: "search_files", risk: "低", desc: "按名称模式搜索文件", on: true },
      { name: "create_directory", risk: "中", desc: "创建目录", on: true },
      { name: "move_file", risk: "中", desc: "移动或重命名文件", on: true }
    ]},
    { id: "mcp-knowledge-gateway", name: "knowledge-gateway", kind: "mcp", note: "HTTP · 最近发现 3 个工具", tools: [
      { name: "kb_query", risk: "低", desc: "检索已授权知识条目", on: true },
      { name: "kb_fetch", risk: "低", desc: "按 ID 获取条目正文", on: true },
      { name: "kb_sources", risk: "低", desc: "列出可用知识来源", on: true }
    ]},
    { id: "mcp-browser", name: "browser", kind: "mcp", note: "stdio · 已停用 · 尚未发现工具", tools: [] },
    { id: "cli-claude", name: "Claude Code 原生", kind: "cli", note: "由 CLI 自身管理，此处不可开关", tools: [
      { name: "Read / Write / Edit", risk: "中", desc: "文件读写与编辑（CLI 内置）", on: true },
      { name: "Bash", risk: "高", desc: "Shell 命令（CLI 内置，受权限模式约束）", on: true },
      { name: "Glob / Grep", risk: "低", desc: "文件与内容检索（CLI 内置）", on: true },
      { name: "Task", risk: "中", desc: "子代理派发（CLI 内置）", on: true }
    ]},
    { id: "cli-codex", name: "Codex 原生", kind: "cli", note: "由 CLI 自身管理，此处不可开关", tools: [
      { name: "shell", risk: "高", desc: "沙箱内命令执行（CLI 内置）", on: true },
      { name: "apply_patch", risk: "中", desc: "补丁式文件编辑（CLI 内置）", on: true },
      { name: "update_plan", risk: "低", desc: "计划步骤更新（CLI 内置）", on: true }
    ]}
  ];
  D.settings.skills = D.settings.skills.map((s, i) => ({ ...s, source: i === 0 ? "本机目录" : "导入", updated: i === 0 ? "今天 09:20" : "11-17 15:04" }));
  D.settings.mcp = D.settings.mcp.map((m, i) => ({ ...m, source: i === 0 ? "本机配置" : "导入", updated: i === 0 ? "今天 09:21" : "11-16 10:40" }));
  D.settings.tools = D.settings.tools.slice();

  /* CR-059 r8：多密钥各自的模型支持夹具（模拟保存后异步探测每个密钥的 /models）。
     规则：全部支持→不写范围；部分支持→写交集；手动已配置→只追加新增模型。 */
  D.settings.keyModelSupport = {
    "主凭证": ["tierflow-pro", "tierflow-lite", "tierflow-image", "tierflow-image-pro"],
    "备用": ["tierflow-lite", "tierflow-image"]
  };

  /* CR-059 r3 #4：生图配置夹具（用户要求多模型有序＋失败顺延，参考 MIT 开源实现形态）。
     协议：OpenAI 兼容 images（/images/generations，参考图走 /images/edits）；b64_json 与 url 双解析。
     演示：不发起真实请求；order 为「先试」顺序，第一个失败自动用下一个。 */
  D.settings.imageGen = {
    enabled: true,
    order: ["PRV-01/tierflow-image", "PRV-01/tierflow-image-pro"],
    defaults: { size: "1024x1024", quality: "auto", n: 1, timeoutMin: 15 },
    outputDir: "generated-images"
  };

  /* CR-059：思考等级两级来源演示夹具。
     endpointSignals＝供应商 /models 列表给出的推理信号（三态：true/false/unknown，沉默不等于拒绝）；
     thinkKnowledge＝本地内置知识库条目（MIT 开源知识库引入后的演示子集，正式实现为全量 87 条）。 */
  D.settings.endpointSignals = {
    "tierflow-reasoner": { reasoning: true },
    "tierflow-vision": { reasoning: false },
    "local-qwen-32b": { reasoning: "unknown" }
  };
  D.settings.thinkKnowledge = [
    { id: "deepseek-v4-1-flash", patterns: ["deepseek-v4.1-flash", "deepseek-flash"], efforts: { off: "none", low: "low", high: "high", max: "max" }, defaultEffort: "high", contextWindow: 1048576, maxTokens: 384000, note: "DeepSeek-V4.1-Flash 官方档位" },
    { id: "openai-gpt-5-2", patterns: ["gpt-5.2"], efforts: { off: "none", low: "low", medium: "medium", high: "high", xhigh: "xhigh" }, defaultEffort: "off", contextWindow: 400000, maxTokens: 128000, note: "GPT-5.2 官方档位" },
    { id: "claude-sonnet-4-5", patterns: ["claude-4.5-sonnet", "claude-sonnet-4-5"], efforts: { off: null, low: "low", medium: "medium", high: "high" }, defaultEffort: "medium", contextWindow: 200000, maxTokens: 64000, note: "Claude Sonnet 4.5 自适应思考" },
    { id: "qwen3-max", patterns: ["qwen3-max", "qwen-max"], efforts: { off: null, low: "low", medium: "medium", high: "high" }, defaultEffort: "medium", contextWindow: 262144, maxTokens: 65536, note: "Qwen3-Max 档位" },
    { id: "grok-4", patterns: ["grok-4"], efforts: { off: null, low: "low", high: "high" }, defaultEffort: "low", contextWindow: 256000, maxTokens: 32768, note: "Grok 4 档位" },
    { id: "glm-4-plus", patterns: ["glm-4-plus", "glm-4.6"], efforts: { off: null, low: "low", medium: "medium", high: "high" }, defaultEffort: "medium", contextWindow: 128000, maxTokens: 16384, note: "GLM 系列档位" },
    { id: "tierflow-pro", patterns: ["tierflow-pro"], efforts: { off: "none", low: "low", medium: "medium", high: "high" }, defaultEffort: "medium", contextWindow: 200000, maxTokens: 65536, note: "演示供应商自定义模型（知识库命中示例）" }
  ];

  /* CR-058 模型检测演示夹具：全部为虚构演示数据，未发起任何真实网络请求。
     固定 19+1 针顺序：P1 握手 / P2 回显 / P3 Schema / P4 真流式 / P5 头指纹 / P6 金丝雀 / P7 注入 / P8 记忆 / P9 stop / P10 max_tokens / P11 工具 / P12 JSON / P13 逻辑 / P14 混池 / P15 识图 / P16 responses / P17 输入对账 / P18 输出对账 / P19 缓存 / P20 行为指纹与归因（r5，权重 0 辅助信号）。
     attribution 为 P20 归因面板演示数据：一致性三态 + top-3「最像的已知候选」（距离越小越像）；候选名均为虚构演示。 */
  D.settings.probeFixtures = {
    clean: {
      score: 97, grade: "S", verdict: "真实", channel: "官方直连", duration: "14.2s",
      summary: "流式真实、金丝雀与锚点完整回显、原生工具调用正常；长前缀缓存命中稳定。",
      attribution: { consistency: "match", claimedFamily: "tierflow", candidates: [
        { name: "tierflow-pro（基线 2026-11-20）", family: "tierflow", distance: 0.08 },
        { name: "tierflow-air（基线 2026-11-20）", family: "tierflow", distance: 0.31 },
        { name: "glm-5.3（基线 2026-11-18）", family: "glm", distance: 0.62 }
      ], note: "数字偏好与身份自述均贴近声称家族；概率性提示，不构成实锤。" },
            probes: [
        { status: "pass", ms: 214, note: "HTTP 200 · SSE 建流 96ms" },
        { status: "pass", ms: 236, note: "回显 tierflow-pro 同代同档" },
        { status: "pass", ms: 51, note: "id chatcmpl-* · finish stop" },
        { status: "pass", ms: 1024, note: "前置空帧 0 · 首真字 412ms" },
        { status: "pass", ms: 1, note: "openai-processing-ms 存在（官方直连特征）" },
        { status: "pass", ms: 402, note: "金丝雀 9F3C 原样回显" },
        { status: "pass", ms: 388, note: "未检出套壳特征 · 差分膨胀 +3" },
        { status: "pass", ms: 566, note: "第 3 轮锚点 7B2E 复述正确" },
        { status: "pass", ms: 351, note: "stop 序列精准截断" },
        { status: "pass", ms: 289, note: "max_tokens 截断 finish=length" },
        { status: "pass", ms: 447, note: "原生 tool_calls 结构合规" },
        { status: "pass", ms: 302, note: "strict JSON Schema 合规" },
        { status: "pass", ms: 823, note: "逆序拼串+校验和一次算对" },
        { status: "pass", ms: 1731, note: "4 并发档位一致 · 无 flex 降档" },
        { status: "pass", ms: 693, note: "色块与数字 381 识别正确" },
        { status: "pass", ms: 512, note: "responses 事件流拼出 OK" },
        { status: "pass", ms: 96, note: "输入差分膨胀 +2（正常）" },
        { status: "pass", ms: 1180, note: "流式/非流式输出一致" },
        { status: "pass", ms: 2204, note: "长前缀缓存命中 87%" },
        { status: "pass", ms: 1462, note: "行为指纹与声称家族一致（最近候选 tierflow-pro d=0.08）" }
      ]
    },
    downgraded: {
      score: 32, grade: "D", verdict: "假冒嫌疑", channel: "聚合中转", duration: "19.6s",
      summary: "检出跨档偷换与上下文篡改（红牌封顶）：请求 lite 档回显 mini 档、System 金丝雀丢失、多轮锚点被裁。",
      attribution: { consistency: "mismatch", claimedFamily: "tierflow", candidates: [
        { name: "glm-5.3-flash（基线 2026-11-18）", family: "glm", distance: 0.12 },
        { name: "deepseek-v4.1-flash（基线 2026-11-19）", family: "deepseek", distance: 0.19 },
        { name: "qwen3.8-flash（基线 2026-11-18）", family: "qwen", distance: 0.27 }
      ], note: "数字偏好显著偏离声称家族，最像 glm-5.3-flash；概率性提示，不构成实锤。" },
            probes: [
        { status: "pass", ms: 201, note: "HTTP 200 · SSE 建流 88ms" },
        { status: "fail", ms: 198, note: "请求 lite → 回显 mini（跨档降级）" },
        { status: "pass", ms: 48, note: "id 与 finish 字段在位" },
        { status: "warn", ms: 2101, note: "前置空帧 3 · 首真字 1873ms（假首字嫌疑）" },
        { status: "pass", ms: 1, note: "网关追踪头 cf-ray（聚合中转）" },
        { status: "fail", ms: 369, note: "System 金丝雀丢失（被吞/被篡改）" },
        { status: "warn", ms: 377, note: "差分膨胀 +96（疑似暗塞前置提示词）" },
        { status: "fail", ms: 604, note: "第 1 轮锚点丢失（多轮历史被裁）" },
        { status: "pass", ms: 342, note: "stop 序列精准截断" },
        { status: "pass", ms: 276, note: "max_tokens 截断服从" },
        { status: "pass", ms: 451, note: "原生 tool_calls 结构合规" },
        { status: "pass", ms: 318, note: "strict JSON Schema 合规" },
        { status: "pass", ms: 766, note: "随机逻辑题算对" },
        { status: "fail", ms: 1893, note: "4 并发中 1 路回显 mini（混池实锤）" },
        { status: "na", ms: 0, note: "不适用：非视觉模型" },
        { status: "warn", ms: 0, note: "不支持 /v1/responses 协议" },
        { status: "warn", ms: 88, note: "输入差分膨胀 +64" },
        { status: "pass", ms: 1102, note: "流式/非流式输出一致" },
        { status: "warn", ms: 2318, note: "缓存命中 0%（散池嫌疑）" },
        { status: "warn", ms: 1518, note: "行为指纹偏离声称家族（最像 glm-5.3-flash d=0.12，辅助信号不计分）" }
      ]
    },
    localWarn: {
      score: 88, grade: "B", verdict: "真实", channel: "聚合中转", duration: "16.8s",
      summary: "流式真实、上下文纯净；工具调用为提示词模拟（P8 警示），Agent 场景需关注兼容。",
      attribution: { consistency: "unknown", claimedFamily: "qwen", candidates: [], note: "与所有已知候选都不像（本地私有部署不在基线库内）；无法判定，不指认。" },
            probes: [
        { status: "pass", ms: 187, note: "HTTP 200 · SSE 建流 102ms" },
        { status: "pass", ms: 205, note: "回显 local-qwen-72b 一致" },
        { status: "pass", ms: 55, note: "id 在位 · finish stop" },
        { status: "pass", ms: 986, note: "前置空帧 1 · 首真字 520ms" },
        { status: "pass", ms: 38, note: "无官方特征头（聚合中转）" },
        { status: "pass", ms: 431, note: "金丝雀 A17C 原样回显" },
        { status: "pass", ms: 402, note: "差分膨胀 +4" },
        { status: "pass", ms: 610, note: "第 3 轮锚点复述正确" },
        { status: "pass", ms: 356, note: "stop 截断正常" },
        { status: "pass", ms: 268, note: "max_tokens 截断服从" },
        { status: "warn", ms: 490, note: "无原生 tool_calls（文本冒充）" },
        { status: "pass", ms: 341, note: "strict JSON Schema 合规" },
        { status: "pass", ms: 892, note: "随机逻辑题算对" },
        { status: "pass", ms: 1655, note: "4 并发档位一致" },
        { status: "na", ms: 0, note: "不适用：非视觉模型" },
        { status: "na", ms: 0, note: "本地上游无 responses 端点" },
        { status: "pass", ms: 91, note: "输入差分膨胀 +3" },
        { status: "pass", ms: 1240, note: "流式/非流式输出一致" },
        { status: "skip", ms: 0, note: "未执行：本地上游无缓存报告" },
        { status: "na", ms: 1390, note: "无法判定：与所有已知候选都不像（基线库外）" }
      ]
    }
  };
  D.settings.probeHistory = [
    { id: "MP-03", time: "今天 09:15", providerName: "TierFlow", modelId: "tierflow-lite", score: 32, grade: "D", verdict: "假冒嫌疑", channel: "聚合中转", duration: "19.6s",
      summary: "检出跨档偷换与上下文篡改（红牌封顶）：请求 lite 档回显 mini 档、System 金丝雀丢失、多轮锚点被裁。",
      attribution: D.settings.probeFixtures.downgraded.attribution,
      probes: D.settings.probeFixtures.downgraded.probes },
    { id: "MP-02", time: "昨天 21:47", providerName: "本地网关", modelId: "local-qwen-72b", score: 88, grade: "B", verdict: "真实", channel: "聚合中转", duration: "16.8s",
      summary: "流式真实、上下文纯净；工具调用为提示词模拟（P8 警示）。",
      attribution: D.settings.probeFixtures.localWarn.attribution,
      probes: D.settings.probeFixtures.localWarn.probes },
    { id: "MP-01", time: "昨天 20:02", providerName: "TierFlow", modelId: "tierflow-pro", score: 97, grade: "S", verdict: "真实", channel: "官方直连", duration: "14.2s",
      summary: "全针通过；长前缀缓存命中稳定。",
      attribution: D.settings.probeFixtures.clean.attribution,
      probes: D.settings.probeFixtures.clean.probes }
  ];

  /* AI 会话、子智能体、后台任务、模型目录 */
  const baseMessages = D.session.messages.slice();
  D.ai = {
    active: "S-1042-01",
    sessions: [
      { id: "S-1042-01", title: "让 STORY-0102 容量校验通过 AC-02 / AC-03", status: "success", updated: "14:31", tokens: "128.4K", duration: "46m31s", messages: baseMessages,
        goal: "让 STORY-0102 的容量校验通过 AC-02 与 AC-03，并把证据整理到交付包。",
        tasks: [
          { id: "TASK-01", title: "核对会话目标与授权范围", state: "completed" },
          { id: "TASK-02", title: "读取 STORY-0102 与相关测试证据", state: "completed" },
          { id: "TASK-03", title: "生成容量校验差异并自检", state: "running" },
          { id: "TASK-04", title: "写入测试文件并运行回归", state: "pending" },
          { id: "TASK-05", title: "汇总交付证据与验收说明", state: "pending" }
        ] },
      { id: "S-1042-02", title: "调整统一 AI 侧栏与输入菜单", status: "pending", updated: "13:02", tokens: "26.1K", duration: "12m08s", messages: [] },
      { id: "S-1042-03", title: "核验执行计划模型与失败重试", status: "failed", updated: "11:47", tokens: "57.8K", duration: "21m22s", messages: [
        { role: "user", time: "11:36", text: "复现取消后旧锁未释放，确认失败重试是否会误报完成。" },
        { role: "assistant", time: "11:47", text: "复现结果：状态回退用例失败，取消后仍保留旧锁；本次不生成交付产物，等待修复后重跑。" }
      ],
        tasks: [
          { id: "TASK-F1", title: "读取执行计划模型与冻结记录", state: "completed" },
          { id: "TASK-F2", title: "复现失败重试的状态回退", state: "failed" },
          { id: "TASK-F3", title: "整理失败原因与下一步", state: "pending" }
        ] },
      { id: "S-1042-04", title: "研究 Run 生命周期与交付闭环", status: "read", updated: "昨天", tokens: "110K", duration: "16m34s", messages: [] }
    ],
    subagents: [
      { id: "AG-2087-E", taskId: "RUN-2087", cli: "dsh", title: "核验容量事务边界", tokens: "8.6M", duration: "12m31s", status: "成功", model: "deepseek-v4.1", output: "事务边界位于 capacity.settle；回补路径 3 处，均先校验锁再提交。", events: [
        { kind: "status", status: "运行中" },
        { kind: "text", text: "先核对事务边界与回补路径，再给出可复用的结论。" },
        { kind: "tool", toolName: "code-search", text: "code-search · capacity|rollback|settle" },
        { kind: "result", text: "命中 src/booking/capacity.ts、tests/capacity.spec.ts 共 7 处。" },
        { kind: "output", text: "事务边界位于 capacity.settle；回补路径 3 处，均先校验锁再提交。" },
        { kind: "status", status: "成功" }
      ] },
      { id: "AG-2087-B", taskId: "RUN-2087", cli: "claude", title: "评审取消回补用例", tokens: "2.1M", duration: "6m02s", status: "待确认", model: "claude-4.5-sonnet", output: "用例已覆盖取消分支，是否保留并发回补断言需要人工确认。", events: [
        { kind: "status", status: "运行中" },
        { kind: "text", text: "对照验收标准检查取消回补用例的断言强度。" },
        { kind: "tool", toolName: "fs.read", text: "fs.read · tests/capacity.spec.ts" },
        { kind: "result", text: "读取 6.2 KB；取消分支有 2 条断言，并发回补断言缺失。" },
        { kind: "status", status: "待确认" }
      ] },
      { id: "AG-2087-A", taskId: "RUN-2087", cli: "codex", title: "生成并发测试数据", tokens: "1.4M", duration: "3m18s", status: "成功", model: "gpt-5-codex", output: "生成 200 条并发扣减夹具，含 3 条冲突回滚样本。", events: [
        { kind: "status", status: "运行中" },
        { kind: "tool", toolName: "shell", text: "shell · node scripts/seed-capacity.mjs --rows 200" },
        { kind: "result", text: "写入 200 行；冲突样本 3 条（演示输出）。" },
        { kind: "output", text: "生成 200 条并发扣减夹具，含 3 条冲突回滚样本。" },
        { kind: "status", status: "成功" }
      ] },
      { id: "AG-2087-D", taskId: "RUN-2087", cli: "dsh", title: "整理交付证据清单", tokens: "—", duration: "—", status: "失败", model: "deepseek-v4.1", output: "CLI 退出码 1：模型端拒绝请求（演示失败，不代表真实结论）。", events: [
        { kind: "status", status: "运行中" },
        { kind: "text", text: "汇总本轮变更、测试与验收证据。" },
        { kind: "status", status: "失败" }
      ] }
    ],
    background: [
      { jobId: "JOB-3182", cmd: "pnpm vitest run tests/capacity.spec.ts", exit: "运行中", duration: "00:42", state: "运行中", output: "RUN  v2.1.0  D:/work/booking-service\n\n ✓ tests/capacity.spec.ts (12)\n   ✓ 容量扣减与回补 (7)\n   ✓ 并发冲突回滚 (5)\n\n 12 passed (12)\n（演示输出，随示例推进）" },
      { jobId: "JOB-3181", cmd: "pnpm tsc --noEmit", exit: 0, duration: "11s", state: "完成", output: "tsc --noEmit\n\n退出码 0 · 无类型错误（演示）" },
      { jobId: "JOB-3180", cmd: "git status --short", exit: 0, duration: "1s", state: "完成", output: " M tests/capacity.spec.ts\n M src/booking/capacity.ts（演示）" },
      { jobId: "JOB-3179", cmd: "node scripts/seed-demo.mjs", exit: 1, duration: "16s", state: "完成", output: "TypeError: 数据源未配置（演示失败，不是用户验收结论）\n  at seed-demo.mjs:42:9" },
      { jobId: "JOB-3178", cmd: "npx ui-skills list --category interaction", exit: 1, duration: "32s", state: "完成", output: "npm ERR! 无法连接注册表（离线设计稿不会发起真实请求）" }
    ],
    modelCatalog: {
      current: { provider: "MagpieGateway", model: "DeepSeek V4.1 Flash", level: "High" },
      providers: [
        { name: "MagpieGateway", count: 14, models: [
          { name: "GPT 6 Astra AR", ctx: "922K", fav: true, vision: true, thinking: true },
          { name: "GPT 6 Astra", ctx: "922K", fav: false, vision: true, thinking: true },
          { name: "GPT-6.1 Sol AR", ctx: "922K", fav: true, vision: true, thinking: true },
          { name: "GPT 6.1 Sol", ctx: "922K", fav: false, vision: true, thinking: true },
          { name: "GPT-6 Luna", ctx: "922K", fav: false, vision: true, thinking: true },
          { name: "GPT-5.6 Sol", ctx: "922K", fav: false, vision: true, thinking: true },
          { name: "DeepSeek V4.1 Flash", ctx: "1M", fav: true, vision: false, thinking: true }
        ]},
        { name: "TierFlow", count: 3, models: [
          { name: "tierflow-pro", ctx: "200K", fav: true, vision: true, thinking: true },
          { name: "tierflow-lite", ctx: "128K", fav: false, vision: false, thinking: true },
          { name: "tierflow-image", ctx: "—", fav: false, vision: false, thinking: false, image: true }
        ]},
        { name: "本地网关", count: 1, models: [{ name: "local-qwen-72b", ctx: "32K", fav: false, vision: false, thinking: false }] }
      ],
      levels: ["Off", "Low", "High", "Max"]
    },
    /* CR-059：权限挡位文案与 AI 侧栏统一（图1：自动审核 / 完全访问）；id 语义不变，auto/full 未核验前禁用。 */
    permissions: [
      { id: "default", name: "默认模式", desc: "需要手动确认每个操作，适合谨慎使用", icon: "message" },
      { id: "plan", name: "规划模式", desc: "仅使用只读工具，生成计划供用户审批后执行", icon: "list" },
      { id: "agent", name: "代理模式", desc: "自动接受文件创建/编辑，减少确认步骤", icon: "box" },
      { id: "auto", name: "自动审核", desc: "使用提供商原生审查器处理审批，同时保留安全边界", icon: "shield", enabled: false },
      { id: "full", name: "完全访问", desc: "完全自动化，绕过所有权限检查【谨慎使用】", icon: "zap", enabled: false }
    ],
    clis: [
      { id: "dsh", name: "DeepSeek Harness", badge: "Beta" },
      { id: "claude", name: "Claude Code", badge: "" },
      { id: "codex", name: "Codex", badge: "" },
      { id: "grok", name: "Grok CLI", badge: "Beta" }
    ],
    stats: {
      rounds: 4, modelTime: "21 分 17 秒", toolTime: "7 分 17 秒", ttft: "7.9 秒", tps: "148 tok/s",
      tokens: { total: "6,064,710 tok", cacheHit: "95%", uncached: "297,767 tok", cacheRead: "5,703,936 tok", output: "63,007 tok" },
      context: { used: "6%", detail: "~66.7K / 1M", system: "~2K", tools: "~12.7K", messages: "~106K" }
    }
  };
  /* CR-063：历史会话分批加载演示数据（合成；连同上面 4 条共 60 条，首批 20 条）。
     仅用于设计验证「继续加载 / 全项目搜索 / 当前会话钉住」三类状态，不代表真实业务记录。 */
  (function () {
    const titles = [
      "梳理项目初始化时的目录与权限边界", "排查会话草稿在切换项目后丢失", "给需求树补上折叠状态的键盘操作",
      "核验知识库授权变更后的索引重建", "重构文件树搜索的防抖与高亮", "处理 CLI 退出码 137 的失败提示",
      "修复深色主题下步骤框对比度不足", "让模型候选过滤掉生图模型", "补齐设置中心 SDK 版本下拉",
      "验证执行计划失败后的重试入口", "调整右栏预览的定位分流", "整理 MCP 连接超时的错误文案",
      "修复窗口页签溢出时的滚动条", "统一技能列表的风险标签配色", "排查子智能体事件重复上报",
      "给会话历史加键盘导航", "优化服务器列表的连接状态刷新", "修正知识库目录树的层级缩进",
      "让草稿保存失败时保留输入", "核对工具调用的参数脱敏", "调整需求预览的思维导图缩放",
      "修复上下文用量统计偏小", "补上后台任务清空后的计数", "处理办公表格预览的列宽",
      "核验项目切换时的会话隔离", "统一错误提示的关闭行为", "给文件重命名加冲突校验",
      "优化代码区行号与高亮的滚动同步", "修复窄屏下模型浮层超出视口", "补充 MCP 授权失败的重试",
      "调整会话标题自动生成规则", "核对计划模式的只读边界", "修复搜索框焦点丢失",
      "统一图标尺寸与对齐", "排查知识库检索命中为空", "给历史会话补未读状态",
      "修复模态框打开时的背景滚动", "优化大型需求树的渲染耗时", "补充服务器终端的粘贴保护",
      "核对审批请求的超时文案", "修正主题切换时的颜色闪烁", "让统计浮层与控件右缘对齐",
      "修复复制路径时的转义", "给任务派发加前置校验提示", "处理会话恢复失败后的降级",
      "统一按钮的禁用态样式", "核验知识库上传的大小限制", "修复文件保存冲突的提示",
      "优化消息流的自动滚动阈值", "补充 CLI 安装状态的证据", "调整项目卡片的更新时间格式",
      "修复需求编号跳转失效", "核对导入技能后的重名处理", "优化会话列表的首屏加载",
      "修复工作台页签的激活态", "补充失败步骤的退出码说明"
    ];
    const states = ["success", "read", "failed", "pending"];
    D.ai.sessions = D.ai.sessions.concat(titles.map((title, i) => ({
      id: `S-ARCH-${String(i + 1).padStart(2, "0")}`,
      title,
      status: states[i % states.length],
      updated: `${10 + Math.floor(i / 28)}月${(i % 27) + 1}日 ${String(9 + (i % 9)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}`,
      tokens: i % 5 === 0 ? "—" : `${12 + (i * 3) % 90}.${i % 10}K`,
      duration: i % 5 === 0 ? "—" : `${3 + (i % 40)}m${String((i * 11) % 60).padStart(2, "0")}s`,
      messages: [],
      steps: []
    })));
  })();
  D.session = D.ai.sessions[0];
  /* CR-064：状态标识与置顶的合成演示（运行中 / 未读成功 / 失败 / 待处理 / 已读） */
  D.ai.runningIds = ["S-1042-04"];
  D.ai.stats.tokensTotal = 6064710;
  const pinnedDemo = D.ai.sessions.find(s => s.id === "S-1042-03");
  if (pinnedDemo) pinnedDemo.pinned = true;
})(window);



