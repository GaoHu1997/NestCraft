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
    server: { port: 22, keepAlive: 30, auth: "密钥文件", confirmDanger: true, defaultUser: "ops" }
  };
  D.settings.providers = [
    {
      id: "PRV-01", name: "TierFlow", protocol: "Responses", enabled: true, updated: "今天 10:12",
      keys: [
        { label: "主凭证", masked: "sk-****...6ce3", on: true, scope: "2 个模型", protocol: "Responses", models: ["tierflow-pro", "tierflow-lite"] },
        { label: "备用", masked: "sk-****...a442", on: true, scope: "1 个模型", protocol: "", models: ["tierflow-lite"] }
      ],
      endpoints: [
        { protocol: "OpenAI", url: "https://api.demo.invalid/v1", on: true },
        { protocol: "Anthropic", url: "https://anthropic.demo.invalid", on: false }
      ],
      headers: [{ name: "X-Demo-Client", value: "offline-review" }],
      spoof: "关闭",
      models: [
        { id: "tierflow-pro", name: "TierFlow Pro", modalities: ["文本", "图片"], thinking: true, levels: ["off", "low", "medium", "high"], defaultLevel: "中", context: 200000, maxOutput: 65536, autoLevels: true, on: true },
        { id: "tierflow-lite", name: "TierFlow Lite", modalities: ["文本"], thinking: true, levels: ["off", "low", "medium"], defaultLevel: "低", context: 128000, maxOutput: 32768, autoLevels: true, on: true },
        { id: "tierflow-image", name: "TierFlow Image", modalities: ["生图"], thinking: false, levels: [], defaultLevel: "—", context: null, maxOutput: null, autoLevels: false, on: false }
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

  D.settings.clis = [
    {
      id: "dsh", name: "dsh 子代理", badge: "内置", version: "v0.2.2-rc.5", installed: true, enabled: true,
      meta: "3 类任务 · 最低难度 低 · 随宿主提供", model: "沿用主代理模型", effort: "默认（CLI 自身行为）",
      minDifficulty: "低", types: ["仓库探索", "代码定位", "资料检索"], permission: "工作区写入", expandable: false
    },
    {
      id: "claude", name: "claude cli", version: "v2.1.318", installed: true, enabled: true,
      meta: "沿用主代理模型 · 5 类任务 · 最低难度 中", model: "沿用主代理模型（主代理协议不兼容时回退）", effort: "默认（CLI 自身行为）",
      minDifficulty: "中", types: ["仓库探索", "影响分析", "模块重构", "方案设计", "文档整理"], permission: "bypassPermissions（跳过所有确认）", expandable: true
    },
    {
      id: "codex", name: "codex cli", version: "v0.48.2", installed: true, enabled: true,
      meta: "gpt-5-codex · 4 类任务 · 最低难度 中", model: "gpt-5-codex", effort: "高",
      minDifficulty: "中", types: ["功能开发", "缺陷修复", "测试验证", "代码审查"], permission: "workspace-write", expandable: true
    },
    {
      id: "grok", name: "grok cli", version: "—", installed: false, enabled: false,
      meta: "未安装 · 安装后可选择", model: "—", effort: "—", minDifficulty: "中", types: [], permission: "—", expandable: false
    }
  ];
  D.settings.sdks = [
    { id: "dsh", name: "dsh 子代理", version: "v0.2.2-rc.5", latest: "v0.2.2-rc.5", installed: true, builtin: true, enabled: true, path: "随宿主安装", desc: "随宿主安装，无需 npm 安装 / 升级" },
    { id: "claude", name: "Claude Code SDK", version: "v2.1.318", latest: "v2.1.328", installed: true, enabled: true, path: "D:\\devlop\\node-v24.8.0\\claude.CMD", desc: "Claude AI 功能所需。包含 Claude Code SDK 及相关依赖。" },
    { id: "codex", name: "Codex SDK", version: "v0.166.0", latest: "v0.166.0", installed: true, enabled: true, path: "~/.npm-global/bin/codex", desc: "Codex AI 功能所需。包含 OpenAI Codex SDK。" },
    { id: "grok", name: "Grok CLI SDK", version: "v0.1.2", latest: "v0.1.4", installed: true, enabled: true, path: "~/.npm-global/bin/grok", desc: "Grok AI 功能所需。包含 xAI Grok CLI 及相关依赖。" }
  ];
  D.settings.skills = D.settings.skills.map((s, i) => ({ ...s, source: i === 0 ? "本机目录" : "导入", updated: i === 0 ? "今天 09:20" : "11-17 15:04" }));
  D.settings.mcp = D.settings.mcp.map((m, i) => ({ ...m, source: i === 0 ? "本机配置" : "导入", updated: i === 0 ? "今天 09:21" : "11-16 10:40" }));
  D.settings.tools = D.settings.tools.slice();

  /* AI 会话、子智能体、后台任务、模型目录 */
  const baseMessages = D.session.messages.slice();
  D.ai = {
    active: "S-1042-01",
    sessions: [
      { id: "S-1042-01", title: "让 STORY-0102 容量校验通过 AC-02 / AC-03", status: "success", updated: "14:31", tokens: "128.4K", duration: "46m31s", messages: baseMessages,
        steps: [
          { id: "ST-01", title: "核对会话目标与授权范围", state: "done", meta: "0.8s" },
          { id: "ST-02", title: "读取 STORY-0102 与相关测试证据", state: "done", meta: "1.2s" },
          { id: "ST-03", title: "生成容量校验差异并自检", state: "running", meta: "进行中" },
          { id: "ST-04", title: "写入测试文件并运行回归", state: "todo", meta: "未开始" },
          { id: "ST-05", title: "汇总交付证据与验收说明", state: "todo", meta: "未开始" }
        ] },
      { id: "S-1042-02", title: "调整统一 AI 侧栏与输入菜单", status: "pending", updated: "13:02", tokens: "26.1K", duration: "12m08s", messages: [] },
      { id: "S-1042-03", title: "核验执行计划模型与失败重试", status: "failed", updated: "11:47", tokens: "57.8K", duration: "21m22s", messages: [
        { role: "user", time: "11:36", text: "复现取消后旧锁未释放，确认失败重试是否会误报完成。" },
        { role: "assistant", time: "11:47", text: "复现结果：状态回退用例失败，取消后仍保留旧锁；本次不生成交付产物，等待修复后重跑。" }
      ],
        steps: [
          { id: "ST-F1", title: "读取执行计划模型与冻结记录", state: "done", meta: "0.7s" },
          { id: "ST-F2", title: "复现失败重试的状态回退", state: "failed", meta: "退出码 1" },
          { id: "ST-F3", title: "整理失败原因与下一步", state: "todo" }
        ] },
      { id: "S-1042-04", title: "研究 Run 生命周期与交付闭环", status: "read", updated: "昨天", tokens: "110K", duration: "16m34s", messages: [] }
    ],
    subagents: [
      { cli: "dsh", title: "核验容量事务边界", tokens: "8.6M", duration: "12m31s", status: "成功", model: "deepseek-v4.1" },
      { cli: "claude", title: "评审取消回补用例", tokens: "2.1M", duration: "6m02s", status: "待确认", model: "claude-4.5-sonnet" },
      { cli: "codex", title: "生成并发测试数据", tokens: "1.4M", duration: "3m18s", status: "成功", model: "gpt-5-codex" },
      { cli: "dsh", title: "整理交付证据清单", tokens: "—", duration: "—", status: "失败", model: "deepseek-v4.1" }
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
    permissions: [
      { id: "default", name: "默认模式", desc: "需要手动确认每个操作，适合谨慎使用", icon: "message" },
      { id: "plan", name: "规划模式", desc: "仅使用只读工具，生成计划供用户审批后执行", icon: "list" },
      { id: "agent", name: "代理模式", desc: "自动接受文件创建/编辑，减少确认步骤", icon: "box" },
      { id: "auto", name: "自动审批", desc: "使用提供商原生审查器处理审批，同时保留安全边界", icon: "shield" },
      { id: "full", name: "全自动", desc: "完全自动化，绕过所有权限检查【谨慎使用】", icon: "zap" }
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
  D.session = D.ai.sessions[0];
})(window);



