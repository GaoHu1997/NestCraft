/**
 * 死锁回归：直接调用 chat_session_pin / chat_session_fork。
 *
 * 这两个命令曾在持有 db::conn() 全局 Mutex guard 时调用 chat_session_get，
 * 造成同线程二次加锁永久死锁（应用整体无响应）。本套件只做最小调用，
 * 超时即证明死锁仍在；能返回即证明已修复。
 *
 * 触发：TAURI_SMOKE=1 且 SMOKE_PIN_SUITE=1
 */
import * as api from "@/api";

const results: { name: string; ok: boolean; detail: string }[] = [];

async function t(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (e) {
    results.push({ name, ok: false, detail: String(e).slice(0, 300) });
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms（疑似死锁）`)), ms)),
  ]);
}

export async function runPinSuite(): Promise<void> {
  let projectId = "";
  let sessionId = "";

  await t("准备项目与会话", async () => {
    const dirs = await api.invoke<{ projectDir: string }>("smoke_prepare_fixtures");
    const p = await api.createProject("死锁回归项目", "code", dirs.projectDir);
    projectId = p.id;
    const s = await api.chatSessionCreate({ projectId });
    sessionId = s.id;
    return `${projectId} / ${sessionId}`;
  });

  await t("chat_session_pin(true) 不死锁且置顶生效", async () => {
    const pinned = await withTimeout(api.chatSessionPin(sessionId, true), 8000, "pin(true)");
    if (!((pinned.pinnedAt ?? 0) > 0)) throw new Error(`pinnedAt 应非 0，实际 ${pinned.pinnedAt}`);
    return `pinnedAt=${pinned.pinnedAt}`;
  });

  await t("置顶会话排在分页最前", async () => {
    const page = await withTimeout(
      api.chatSessionsPage({ projectId, limit: 20 }),
      8000,
      "sessions_page"
    );
    if (page.items[0]?.id !== sessionId) {
      throw new Error(`置顶应排最前，实际首位=${page.items[0]?.id}`);
    }
    return `共 ${page.items.length} 条，首位正确`;
  });

  await t("chat_session_pin(false) 不死锁且取消置顶", async () => {
    const unpinned = await withTimeout(api.chatSessionPin(sessionId, false), 8000, "pin(false)");
    if ((unpinned.pinnedAt ?? 0) !== 0) throw new Error(`pinnedAt 应为 0，实际 ${unpinned.pinnedAt}`);
    return "pinnedAt=0";
  });

  await t("chat_session_fork 不死锁且生成新会话", async () => {
    await withTimeout(api.chatSessionUpdate({ id: sessionId, title: "分叉源会话" }), 8000, "update");
    const forked = await withTimeout(api.chatSessionFork(sessionId), 10000, "fork");
    if (forked.title !== "分叉 · 分叉源会话") throw new Error(`标题应带前缀，实际 ${forked.title}`);
    if ((forked.pinnedAt ?? 0) !== 0) throw new Error("分叉不应继承置顶");
    if (forked.id === sessionId) throw new Error("分叉应生成新会话");
    await api.chatSessionDelete(forked.id).catch(() => {});
    return `forked=${forked.id}`;
  });

  await t("死锁修复后数据库仍可用", async () => {
    // 若前面任一步死锁，这里会因全局锁被占而一起卡住——所以本步是死锁的终局判据。
    const list = await withTimeout(api.listProjects(), 8000, "list_projects");
    if (!list.some((p) => p.id === projectId)) throw new Error("项目应仍在列表中");
    await api.chatSessionDelete(sessionId).catch(() => {});
    return `数据库正常，${list.length} 个项目`;
  });

  const pass = results.filter((r) => r.ok).length;
  const lines = [
    "# 死锁回归报告（CR-065 pin / fork）",
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
  try {
    await api.invoke("smoke_report_write_pin", { content: lines.join("\n") });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("报告落盘失败", e);
  }
}
