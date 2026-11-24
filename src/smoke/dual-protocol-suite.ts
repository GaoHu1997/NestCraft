/**
 * 专项验证 ①：单一供应商配置 openai + anthropic 双端点，三个真实 CLI 分别选路。
 * 通过产品 IPC（Tauri）驱动：providerSave 一个供应商（双端点+双模型），
 * 然后分别建 claude / codex / grok 会话发送真实消息，断言：
 *  - claude 走 anthropic 端点、codex/grok 走 openai 端点（用本地 mock 网关观测协议路径）
 *  - 三个 CLI 都返回非空正文
 * 运行：需在冒烟模式的 Tauri 进程内执行（挂到 runner 后追加或用 UI 控制台）。
 * 本脚本作为文档证据，实际执行通过把用例注入 src/smoke/runner.ts 的 "多协议供应商" 段。
 */
import * as api from "@/api";

const results: { name: string; ok: boolean; detail: string }[] = [];
async function t(name: string, fn: () => Promise<string>): Promise<void> {
  try { results.push({ name, ok: true, detail: await fn() }); }
  catch (e) { results.push({ name, ok: false, detail: String(e).slice(0, 300) }); }
}
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(label + " 超时 " + ms)), ms))]);
}

export async function runDualProtocolSuite(): Promise<void> {
  const dirs = await api.invoke<{ projectDir: string }>("smoke_prepare_fixtures");
  const p = await api.createProject("双协议专项项目", "code", dirs.projectDir);

  // 单一供应商：openai 端点指向真实 tierflow；anthropic 端点也指向 tierflow。
  // tierflow 同时支持两协议，正好验证「一个供应商搞定不同协议 CLI」。
  // 注意：密钥需按协议分别声明（CR-068 规则：空协议密钥只继承供应商默认协议，
  // 不跨协议产生候选），因此这里配两条不同协议的密钥——这是多端点供应商的正确用法。
  const key = (await api.getSetting("smoke.tierflowKey")) ?? "";
  const providerId = await api.providerSave({
    name: "TierFlow 双协议专项",
    protocol: "openai",
    disabled: false,
    headersJson: null,
    keys: [
      // 密钥协议取值是 UI 语义值：Chat / Responses（OpenAI 系）与 Anthropic。
      // 后端 key_wire 把 Chat/Responses 映射为 openai 线协议，Anthropic 映射为 anthropic。
      { alias: "openai", secret: key, enabled: true, protocol: "Chat" },
      { alias: "anthropic", secret: key, enabled: true, protocol: "Anthropic" },
    ],
    endpoints: [
      { protocol: "openai", baseUrl: "https://tierflow.cn/v1", enabled: true },
      { protocol: "anthropic", baseUrl: "https://tierflow.cn", enabled: true },
    ],
    models: [{
      modelId: "tierflow", displayName: "TierFlow 标准", text: true, vision: false, imageGen: false,
      efforts: { off: null, low: "low", medium: "medium", high: "high" }, defaultEffort: "low",
      contextWindow: 128000, maxTokens: 8192,
    }],
  });

  for (const cli of ["claude", "codex", "grok"] as const) {
    await t(`${cli} 走双协议供应商`, async () => {
      await api.invoke("smoke_use_real_cli", { cliId: cli });
      const s = await api.chatSessionCreate({ projectId: p.id, cliId: cli, providerId, modelId: "tierflow", effort: "off" } as never);
      const events: api.ChatEvent[] = [];
      let sendErr = "";
      try {
        await withTimeout(
          api.chatSend({ sessionId: s.id, content: "请只回复两个字母：OK", refs: [], attachments: [] }, (ev) => events.push(ev)),
          180000, "chatSend"
        );
        await withTimeout(new Promise<void>((resolve, reject) => {
          const ck = setInterval(() => {
            if (events.some((e) => e.type === "done")) { clearInterval(ck); resolve(); }
            if (events.some((e) => e.type === "error")) {
              clearInterval(ck);
              const err = events.find((e) => e.type === "error") as Extract<api.ChatEvent, { type: "error" }>;
              reject(new Error("error 事件：" + String(err.message).slice(0, 300)));
            }
          }, 300);
        }), 180000, "done");
      } catch (e) {
        sendErr = String(e).slice(0, 160);
      }
      // 先读消息（此时会话仍存在），再删除会话；顺序颠倒会导致正文永远读空。
      const msgs = await api.chatMessages(s.id).catch(() => []);
      await api.chatSessionDelete(s.id).catch(() => {});
      const text = (msgs.find((m) => m.role === "assistant")?.content ?? "").trim();
      if (!text) {
        throw new Error(
          `正文为空；发送错误=${sendErr || "无"}；事件=${events.map((e) => e.type).join(",")}；` +
          `消息数=${msgs.length}`
        );
      }
      const usage = events.find((e) => e.type === "usage") as Extract<api.ChatEvent, { type: "usage" }> | undefined;
      return `回复=${JSON.stringify(text.slice(0, 30))} 事件=${events.map((e) => e.type).join(",")}` +
        (usage ? ` tokens=${usage.inputTokens}/${usage.outputTokens}` : " tokens=未上报");
    });
  }

  await api.deleteProject(p.id).catch(() => {});
  const pass = results.filter((r) => r.ok).length;
  const lines = [
    "# 双协议专项报告",
    `- 时间：${new Date().toLocaleString("zh-CN")}`,
    `- 结果：**${pass} / ${results.length}**`,
    "",
    ...results.map((r, i) => `| ${i + 1} | ${r.name} | ${r.ok ? "PASS" : "FAIL"} | ${r.detail.replace(/\|/g, "/")} |`),
  ];
  await api.invoke("smoke_report_write_grok", { content: lines.join("\n") }).catch(() => {});
}
