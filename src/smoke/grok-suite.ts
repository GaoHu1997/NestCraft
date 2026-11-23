/**
 * grok 真实链路验证：走产品代码的 dispatch 注入 + chat_send，直连真实 grok CLI。
 *
 * 与 scripts/verify-real-cli-matrix.mjs 的区别：那个脚本自己拼环境变量，
 * 本套件让应用自己构造 dispatch（GROK_XAI_API_BASE_URL / XAI_API_KEY / GROK_HOME），
 * 因此验证的是产品代码，而不是脚本的假设。
 *
 * 触发：TAURI_SMOKE=1 且 SMOKE_GROK_SUITE=1，并需 TIERFLOW_SMOKE_KEY 环境变量。
 */
import * as api from "@/api";

const results: { name: string; ok: boolean; detail: string }[] = [];

async function t(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    results.push({ name, ok: true, detail: await fn() });
  } catch (e) {
    results.push({ name, ok: false, detail: String(e).slice(0, 400) });
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms（疑似挂起）`)), ms)
    ),
  ]);
}

export async function runGrokSuite(): Promise<void> {
  const key = await api.getSetting("smoke.tierflowKey").catch(() => null);
  if (!key) {
    await api
      .invoke("smoke_report_write_grok", {
        content: "# grok 真实链路报告\n\n- 结果：**未执行**（缺少 smoke.tierflowKey）\n",
      })
      .catch(() => {});
    return;
  }

  let projectId = "";

  await t("准备供应商（openai 协议指向网关）", async () => {
    const dirs = await api.invoke<{ projectDir: string }>("smoke_prepare_fixtures");
    const p = await api.createProject("grok 真实链路项目", "code", dirs.projectDir);
    projectId = p.id;
    await api.invoke("smoke_set_tierflow_key", { key });
    const list = await api.providerList();
    const pv = list.find((x) => x.id === "prov-smoke-tierflow");
    if (!pv) throw new Error("缺少冒烟供应商");
    if (!pv.endpoints.some((e) => e.protocol === "openai")) {
      throw new Error("缺少 openai 端点（grok 需要 OpenAI 兼容端点）");
    }
    return `${pv.id} endpoints=${pv.endpoints.map((e) => e.protocol).join(",")}`;
  });

  await t("chat_send 经 grok + 网关完成真实对话", async () => {
    // 冒烟模式启动时 cli_sdk 被钉到 mockbin，必须先切回真实 grok，
    // 否则会静默跑 mock（mock 只回固定文案，正文断言无从成立）。
    await api.invoke("smoke_use_real_cli", { cliId: "grok" });
    const list = await api.providerList();
    const pv = list.find((x) => x.id === "prov-smoke-tierflow")!;
    const s = await api.chatSessionCreate({
      projectId,
      cliId: "grok",
      providerId: pv.id,
      modelId: "tierflow",
      effort: "off",
    } as { projectId: string; cliId: string; providerId: string; modelId: string; effort: string });

    const events: api.ChatEvent[] = [];
    let err = "";
    try {
      await withTimeout(
        api.chatSend({ sessionId: s.id, content: "请只回复两个字母：OK", refs: [], attachments: [] }, (ev) =>
          events.push(ev)
        ),
        180000,
        "chat_send"
      );
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          const ck = setInterval(() => {
            if (events.some((e) => e.type === "done")) { clearInterval(ck); resolve(); }
            if (events.some((e) => e.type === "error")) {
              clearInterval(ck);
              reject(new Error("error 事件：" + JSON.stringify(events.find((e) => e.type === "error")).slice(0, 200)));
            }
          }, 300);
        }),
        180000,
        "等待 done"
      );
    } catch (e) {
      err = String(e);
    }

    const msgs = await api.chatMessages(s.id).catch(() => []);
    await api.chatSessionDelete(s.id).catch(() => {});
    const assistant = msgs.find((m) => m.role === "assistant");
    const text = (assistant?.content ?? "").trim();

    // 关键断言：正文必须真的落库（帧解析走 grok 分支的 data 字段）
    if (!text) {
      throw new Error(
        "助手正文为空——grok 帧可能未被解析；错误=" + err.slice(0, 200) +
        "；事件=" + events.map((e) => e.type).join(",")
      );
    }
    if (!/OK/i.test(text)) {
      throw new Error("回复未包含 OK，实际=" + JSON.stringify(text.slice(0, 80)));
    }
    return `回复=${JSON.stringify(text.slice(0, 40))} 事件=${events.map((e) => e.type).join(",")}`;
  });

  if (projectId) {
    await api.deleteProject(projectId).catch(() => {});
  }

  const pass = results.filter((r) => r.ok).length;
  const lines = [
    "# grok 真实链路报告（产品代码路径）",
    "",
    `- 时间：${new Date().toLocaleString("zh-CN")}`,
    `- 结果：**${pass} 通过 / ${results.length - pass} 失败 / 共 ${results.length}**`,
    "",
    "| # | 用例 | 结果 | 说明 |",
    "| --- | --- | --- | --- |",
    ...results.map(
      (r, i) => `| ${i + 1} | ${r.name} | ${r.ok ? "PASS" : "**FAIL**"} | ${r.detail.replace(/\|/g, "\\|")} |`
    ),
    "",
  ];
  await api.invoke("smoke_report_write_grok", { content: lines.join("\n") }).catch(() => {});
}
