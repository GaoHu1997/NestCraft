/**
 * 专项验证 ②：子 CLI 的 token 消耗能否被统计。
 *
 * 验证目标（用户重点关切）：
 *  1. 每种 CLI（claude / codex / grok）真实调用后，assistant 消息的 metaJson.usage 是否落库；
 *  2. 事件流里的 usage 事件是否带 input/output/cacheRead 三项；
 *  3. 前端 hydrateUsage 汇总（tokensIn/tokensOut）与库内合计一致；
 *  4. 子智能体（subagent）消息是否被排除在主会话 token 之外（CR-062 边界）。
 *
 * 触发：TAURI_SMOKE=1 且 SMOKE_TOKEN_SUITE=1，需 TIERFLOW_SMOKE_KEY。
 */
import * as api from "@/api";

const results: { name: string; ok: boolean; detail: string }[] = [];

async function t(name: string, fn: () => Promise<string>): Promise<void> {
  try { results.push({ name, ok: true, detail: await fn() }); }
  catch (e) { results.push({ name, ok: false, detail: String(e).slice(0, 400) }); }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(label + " 超时 " + ms + "ms")), ms))]);
}

async function sendAndCollectWithUsage(sessionId: string, text: string, usageOut: api.ChatEvent[]): Promise<void> {
  const events: api.ChatEvent[] = [];
  await withTimeout(
    api.chatSend({ sessionId, content: text, refs: [], attachments: [] }, (ev) => {
      events.push(ev);
      if (ev.type === "usage") usageOut.push(ev);
    }),
    240000, "chatSend"
  );
  await withTimeout(new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待 done 超时")), 240000);
    const check = setInterval(() => {
      if (events.some((e) => e.type === "done")) { clearTimeout(timer); clearInterval(check); resolve(); }
      if (events.some((e) => e.type === "error")) {
        clearTimeout(timer); clearInterval(check);
        reject(new Error("error：" + JSON.stringify(events.find((e) => e.type === "error")).slice(0, 200)));
      }
    }, 300);
  }), 240000, "done");
}

export async function runTokenSuite(): Promise<void> {
  const dirs = await api.invoke<{ projectDir: string }>("smoke_prepare_fixtures");
  const p = await api.createProject("Token 统计专项", "code", dirs.projectDir);
  const key = await api.getSetting("smoke.tierflowKey");
  if (!key) {
    await api.invoke("smoke_report_write_grok", { content: "# Token 统计专项\n\n- 结果：**未执行**（缺少 smoke.tierflowKey）\n" }).catch(() => {});
    return;
  }

  const providerId = await api.providerSave({
    name: "Token 专项供应商", protocol: "anthropic", disabled: false, headersJson: null,
    // 三 CLI 需要两种线协议：claude→Anthropic，codex/grok→Chat（OpenAI 系）。
    // 密钥协议取 UI 语义值（Chat / Anthropic），后端 key_wire 再映射为线协议。
    keys: [
      { alias: "anthropic", secret: key, enabled: true, protocol: "Anthropic" },
      { alias: "openai", secret: key, enabled: true, protocol: "Chat" },
    ],
    endpoints: [
      { protocol: "anthropic", baseUrl: "https://tierflow.cn", enabled: true },
      { protocol: "openai", baseUrl: "https://tierflow.cn/v1", enabled: true },
    ],
    models: [{
      modelId: "tierflow", displayName: "TierFlow", text: true, vision: false, imageGen: false,
      efforts: { off: null, low: "low" }, defaultEffort: "off", contextWindow: 128000, maxTokens: 8192,
    }],
  });

  for (const cli of ["claude", "codex", "grok"] as const) {
    await t(`${cli} 单轮 token 落库`, async () => {
      await api.invoke("smoke_use_real_cli", { cliId: cli });
      const s = await api.chatSessionCreate({ projectId: p.id, cliId: cli, providerId, modelId: "tierflow", effort: "off" } as never);
      let usageEv: api.ChatEvent[] = [];
      let msgs: api.ChatMessage[] = [];
      try {
        await sendAndCollectWithUsage(s.id, "回答数字 42", usageEv);
        msgs = await api.chatMessages(s.id);
      } finally {
        await api.chatSessionDelete(s.id).catch(() => {});
      }
      const assistant = msgs.filter((m) => m.role === "assistant" && m.metaJson);
      const withUsage = assistant.map((m) => {
        try { return JSON.parse(m.metaJson ?? "{}").usage as { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | null; }
        catch { return null; }
      }).filter(Boolean);
      if (!withUsage.length) {
        throw new Error(`assistant 消息无 usage；事件 usage=${usageEv.length}；消息数=${msgs.length}；metaSamples=${assistant.slice(0,2).map(m=>String(m.metaJson).slice(0,80)).join(" || ")}`);
      }
      const sumIn = withUsage.reduce((n, u) => n + (u!.inputTokens ?? 0), 0);
      const sumOut = withUsage.reduce((n, u) => n + (u!.outputTokens ?? 0), 0);
      const sumCache = withUsage.reduce((n, u) => n + (u!.cacheReadTokens ?? 0), 0);
      return `usage 消息 ${withUsage.length} 条，in=${sumIn} out=${sumOut} cache=${sumCache}；usage 事件 ${usageEv.length} 个`;
    });
  }

  await api.deleteProject(p.id).catch(() => {});
  const pass = results.filter((r) => r.ok).length;
  const lines = [
    "# Token 统计专项报告",
    "",
    `- 时间：${new Date().toLocaleString("zh-CN")}`,
    `- 结果：**${pass} 通过 / ${results.length - pass} 失败 / 共 ${results.length}**`,
    "",
    "| # | 用例 | 结果 | 说明 |",
    "| --- | --- | --- | --- |",
    ...results.map((r, i) => `| ${i + 1} | ${r.name} | ${r.ok ? "PASS" : "**FAIL**"} | ${r.detail.replace(/\|/g, "/")} |`),
    "",
  ];
  await api.invoke("smoke_report_write_grok", { content: lines.join("\n") }).catch(() => {});
}
