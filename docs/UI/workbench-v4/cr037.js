/* UI-CR037-v2：仅在明确载入后演示原生续接和定向返工。 */
window.CR037 = (function () {
  "use strict";
  const { D, esc, store } = UI;
  const actions = window.__actions;
  const projectId = "PRJ-1042";
  const originalSession = "S-1042-01";
  const taskId = "RUN-2087";
  const agentRow = "AG-2087-A";
  const attemptId = "ATT-2087-02";
  const invA = { id: "INV-2087-A1", cli: "codex", sessionRef: "native-demo:A-2087", attemptId };
  const r1 = { id: "RUN-2087/r1", invocationId: invA.id };
  const invB = { id: "INV-2087-B1", inputRevision: r1.id, access: "read-only" };
  const ac = "AC-STORY-0102-03";
  const fence = "FENCE-2087 · 容量扣减与测试目录";
  let chat = null;
  let rework = null;
  let sequence = 0;
  const scope = () => `${UI.activeWindow()?.id}/${store.aiSession}`;
  const cliName = id => D.settings.clis.find(cli => cli.id === id)?.name || id;
  const alternateCli = () => chat.originalCli === "claude" ? "codex" : "claude";
  const activeChat = () => chat?.scope === scope();
  const unavailableReasons = {
    missing: "原会话没有可恢复的原生引用",
    unavailable: "旧原生引用已过期",
    incompatible: "旧引用与当前适配器的命名空间不兼容"
  };
  const button = (text, act, opts = "") => `<button type="button" class="btn sm" data-act="cr037-${act}" ${opts}>${text}</button>`;
  const details = entries => `<dl class="cr037-facts">${entries.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>`;
  const headline = (title, status, tone) => `<div class="cr037-heading"><b>${title}</b><span class="tag ${tone}" role="status">${status}</span></div>`;
  const editPanel = (id, html, previous) => {
    const host = document.getElementById(id);
    if (!host) return;
    const hadFocus = host.contains(document.activeElement) || previous?.closest(`#${id}`);
    host.innerHTML = html;
    if (hadFocus) host.querySelector("[data-cr037-focus]")?.focus({ preventScroll: true });
  };

  function chatBody() {
    const { phase, targetCli, sessionId, sessionRef } = chat;
    const reason = unavailableReasons[chat.variant];
    const states = {
      ready: ["待恢复", "gray", "用下方输入框发送，或直接试跑。演示保留输入框中的草稿。"],
      checking: ["恢复中", "blue", "正在重新核验发送权限和适配器的原生线程。暂停发送，草稿已保留。"],
      resumed: ["已续接原生线程", "green", "适配器确认原生引用一致。本次在原上下文中继续。"],
      unavailable: ["原生引用不可用", "amber", "当前演示计划允许另起上下文，须明确确认后才能创建。"],
      revoked: ["原生引用已撤销 · 已阻塞", "red", "当前会话的原生引用与发送权限已撤销。恢复授权前无法继续，草稿仍在输入框。"],
      fresh: ["新上下文已创建", "green", "已确认 fresh。原会话与聊天记录保留，消息流已标出原生上下文断点。"],
      switched: ["已另建 CLI 会话", "green", "独立 CLI 会话已创建。此前的上下文和引用留在原会话。"]
    };
    const [status, tone, description] = states[phase];
    const original = chat.origin;
    const fields = [["原 NestCraft 会话", original], ["原 CLI", cliName(chat.originalCli)]];
    if (["ready", "checking", "resumed"].includes(phase)) fields.push(["原生引用", chat.originalRef || "未绑定"]);
    if (phase === "unavailable") fields.push(["校验结果", reason]);
    if (phase === "revoked") fields.push(["校验结果", "撤销后禁止发送／fresh"]);
    if (sessionId && phase === "switched") fields.push(["新 NestCraft 会话", sessionId], ["新 CLI", cliName(targetCli)]);
    if (sessionRef) fields.push(["新原生引用", sessionRef]);
    return `${headline("普通聊天续接 · 合成演示", status, tone)}<p>${description}</p>${details(fields)}
      <div class="cr037-actions">
        ${phase === "ready" ? button("试跑恢复", "chat-send", "data-cr037-focus") : ""}
        ${phase === "unavailable" ? button("申请 fresh", "fresh-dialog", "data-cr037-focus") : ""}
        ${phase === "resumed" ? button(`改用 ${esc(cliName(alternateCli()))}`, "switch-dialog", "data-cr037-focus") : ""}
        ${button("退出演示", "chat-close", !["ready", "unavailable", "resumed"].includes(phase) ? "data-cr037-focus" : "")}
      </div>`;
  }

  function chatCard() {
    return activeChat() ? `<section class="cr037-card" id="cr037-chat" data-ui-version="UI-CR037-v2" aria-label="普通聊天续接">${chatBody()}</section>` : "";
  }

  function notifyChat(source) {
    if (activeChat()) editPanel("cr037-chat", chatBody(), source);
  }

  function canStartRecovery() {
    return activeChat() && chat.phase === "ready" && !store.aiBusy;
  }

  function send(source) {
    if (!activeChat()) return false;
    if (!canStartRecovery()) return true;
    const request = chat;
    request.phase = "checking";
    notifyChat(source);
    setTimeout(() => {
      if (chat !== request) return;
      request.phase = unavailableReasons[request.variant] ? "unavailable" : request.variant === "native" ? "resumed" : "revoked";
      notifyChat();
    }, 1000);
    return true;
  }

  function showChoiceDialog() {
    UI.openDialog(UI.dlgShell("AI 侧栏续接演示", "UI-CR037-v2 · 合成样例", `<div class="cr037-choices">
      <p>选择普通聊天的恢复结果。样例留在本页，原会话记录和草稿可继续使用。</p>
      ${button("原生引用可用", "chat-load", 'data-variant="native"')}
      ${button("原生引用过期", "chat-load", 'data-variant="unavailable"')}
      ${button("原生引用缺失", "chat-load", 'data-variant="missing"')}
      ${button("原生引用不兼容", "chat-load", 'data-variant="incompatible"')}
      ${button("发送权限已撤销", "chat-load", 'data-variant="revoked"')}
      ${store.projectId === projectId && store.aiSession === originalSession ? '<p class="caption">定向返工从本会话的「子智能体」菜单进入。</p>' : ""}
    </div>`, '<button class="btn" data-act="close-dialog">关闭</button>', "modal-sm"));
  }

  function startChat(el) {
    const scroll = document.getElementById("ai-scroll");
    if (!scroll) return;
    const origin = D.ai.sessions.find(session => session.id === store.aiSession);
    if (!origin || store.aiBusy) return;
    const variant = el.dataset.variant;
    const originalRef = variant === "missing" ? null : (origin.cr037Ref || `native-demo:${store.aiCli}:${origin.id}`);
    chat = { scope: scope(), origin: origin.id, originalCli: store.aiCli, originalRef, variant, phase: "ready" };
    UI.closeDialog();
    document.getElementById("cr037-chat")?.remove();
    scroll.insertAdjacentHTML("beforeend", chatCard());
    const host = document.getElementById("cr037-chat");
    host.scrollIntoView({ block: "end" });
    host.querySelector("[data-cr037-focus]")?.focus({ preventScroll: true });
  }

  function newSessionDialog(kind) {
    if (!activeChat() || chat.phase !== (kind === "fresh" ? "unavailable" : "resumed")) return;
    const fresh = kind === "fresh";
    const nextCli = esc(cliName(alternateCli()));
    UI.openSubDialog(UI.dlgShell(fresh ? "确认从新上下文开始？" : `改用 ${nextCli} 并另建会话？`, fresh ? "原生线程无法恢复" : "原会话继续保留", `<p>${fresh ? "演示计划允许 fresh。原 NestCraft 会话、聊天记录与草稿保留，后续请求将使用新原生上下文。" : `${nextCli} 将获得自己的会话 ID 和原生引用。之前的会话仍可查看。`}</p>`, `<button class="btn" data-act="cr037-cancel-new" autofocus>取消</button>${button(fresh ? "确认 fresh" : `创建 ${nextCli} 会话`, `new-${kind}`)}`, "modal-sm"));
  }

  function completeNewSession(kind) {
    const fresh = kind === "fresh";
    if (!activeChat() || chat.phase !== (fresh ? "unavailable" : "resumed") || !document.getElementById("dialog2")?.open) return;
    const origin = D.ai.sessions.find(session => session.id === chat.origin);
    if (!origin) return;
    sequence += 1;
    const cli = fresh ? chat.originalCli : alternateCli();
    const id = fresh ? origin.id : `S-CR037-DEMO-${sequence}`;
    const ref = `native-demo:${cli}:new-${sequence}`;
    if (fresh) {
      origin.cr037Ref = ref;
      origin.messages = [...store.aiMessages, { role: "continuity-break", cli, previousRef: chat.originalRef, sessionRef: ref }];
      store.aiMessages = origin.messages;
    } else {
      origin.messages = store.aiMessages;
      const session = { id, title: `续接演示 · ${cliName(cli)} · ${id}`, status: "read", updated: "刚刚", tokens: "0", duration: "0s", messages: [], cr037Ref: ref, cr037Cli: cli, cr037Origin: origin.id, cr037OriginCli: chat.originalCli };
      D.ai.sessions.unshift(session);
      store.aiSession = id;
      store.aiMessages = session.messages;
    }
    store.aiCli = cli;
    store.aiStick = true;
    Object.assign(chat, { phase: fresh ? "fresh" : "switched", targetCli: cli, sessionId: id, sessionRef: ref, scope: scope() });
    UI.closeSubDialog();
    // The modal's opener, not the composer, has focus when the workbench rerenders.
    const draft = document.getElementById("ai-input");
    const selection = draft && [draft.selectionStart, draft.selectionEnd, draft.selectionDirection];
    const draftScroll = draft && [draft.scrollTop, draft.scrollLeft];
    UI.render();
    const composer = document.getElementById("ai-input");
    if (composer && selection) {
      composer.setSelectionRange(...selection);
      [composer.scrollTop, composer.scrollLeft] = draftScroll;
    }
    document.querySelector("#cr037-chat [data-cr037-focus]")?.focus({ preventScroll: true });
  }

  function beforeSwitchSession(session) {
    const current = D.ai.sessions.find(entry => entry.id === store.aiSession);
    if (session.cr037Cli) store.aiCli = session.cr037Cli;
    else if (current?.cr037Origin === session.id) store.aiCli = current.cr037OriginCli;
  }

  function agentLink(agent) {
    return agent.id === agentRow && store.projectId === projectId && store.aiSession === originalSession && D.tasks.some(t => t.id === taskId)
      ? button("打开原任务", "open-task", 'title="打开 RUN-2087 的合成返工演示"') : "";
  }

  function openTask() {
    const existing = D.tasks.find(t => t.id === taskId && t.project === projectId);
    if (!existing || store.projectId !== projectId || store.aiSession !== originalSession) return;
    rework ||= { phase: "candidate", writerStopped: false, allocated: null };
    store.aiTop = null;
    actions["open-task"]({ dataset: { id: taskId } });
    if (store.taskWorkspaceView === "tree") actions["task-workspace-view"]?.({ dataset: { view: "detail" } });
    requestAnimationFrame(() => document.getElementById("cr037-task")?.querySelector("[data-cr037-focus]")?.focus({ preventScroll: true }));
  }

  function taskBody() {
    const stage = rework.phase;
    const states = {
      candidate: ["候选 r1 · 待审查", "gray"], passed: ["结果引用已交给 B", "blue"],
      rejected: ["B 提出缺陷 · 待停止旧写入", "amber"], stopping: ["正在停止旧写入", "blue"],
      stopped: ["旧写入已停止", "amber"], resuming: ["正恢复 A 原生线程", "blue"],
      blocked: ["返工已阻塞", "red"], revised: ["r2 · 待验证", "amber"]
    };
    const [status, tone] = states[stage];
    const fields = [["原任务 / 根 Attempt", `${taskId} / ${attemptId}`], ["写入范围", fence],
      ["原计划预算", stage === "revised" || stage === "resuming" ? "2 轮 / 本次已占用 1 轮" : "2 轮 / 本次可用 1 轮"]];
    let body = details(fields);
    body += `<ol class="cr037-trace"><li><b>A 封存 ${r1.id}</b><span>产出调用 ${r1.invocationId} · ${invA.cli} · ${invA.sessionRef}</span></li>`;
    if (stage !== "candidate") {
      const route = rework.route === "direct" ? "按冻结计划直投" : "大管家转发引用";
      body += `<li><b>B 只读消费 r1</b><span>${route} · ${invB.id} → ${invB.inputRevision} · ${invB.access}。</span></li>`;
    }
    if (!["candidate", "passed"].includes(stage)) body += `<li><b>B 驳回 r1 · ${ac}</b><span>位置 tests/capacity-rollback.spec.ts:42</span><span>合成证据 EV-2087-B1 · 模拟写入失败后，期望剩余名额 5，实际 4。</span><span>沿 r1 → ${r1.invocationId} 找回 A 与其原生引用。</span></li>`;
    if (stage === "stopping") body += `<li><b>等待旧写进程停止回执</b><span>未获得停止回执前，替代调用保持禁用。</span></li>`;
    if (rework.writerStopped) body += `<li><b>旧写进程确认停止</b><span>回执 STOP-2087-A1 · ${invA.id} 已退出 · 写入租约已释放。</span></li>`;
    if (stage === "blocked") body += '<li><b>A 原生引用已撤销</b><span>执行计划禁止 fresh。已创建任务 0 · 替代调用 0 · 预算消耗 0。保留原任务与报缺证据。</span></li>';
    if (rework.allocated) body += `<li><b>${rework.allocated.id} · ${stage === "resuming" ? "核对原生引用" : "已续接 A 原线程"}</b><span>sourceInvocationId = ${rework.allocated.sourceInvocationId}</span><span>继续使用 ${invA.sessionRef}、${attemptId}、原写入范围与轮次预算。</span></li>`;
    if (stage === "revised") body += `<li><b>${taskId}/r2 · 待验证</b><span>产出调用 ${rework.allocated.id} · 重新验证 ${ac} 和受影响消费。通过验证前保持验收关闭。</span></li>`;
    if (rework.lateArchived) body += `<li><b>旧轮回执已归档</b><span>STALE_BINDING · ${invA.id} 的迟到结果对应已停写的 r1。当前候选仍为 r2，等待验证。</span></li>`;
    body += "</ol>";
    const next = {
      candidate: button("按冻结计划直投 B", "pass", 'data-cr037-focus data-route="direct"') +
        button("由大管家转发引用", "pass", 'data-route="relay"'),
      passed: button("由 B 报告缺陷", "reject", "data-cr037-focus"),
      rejected: button("停止旧写入", "stop", "data-cr037-focus"),
      stopping: button("继续 A 原线程", "resume", "disabled"),
      stopped: button("继续 A 原线程", "resume", "data-cr037-focus") + button("试跑引用撤销", "block"),
      resuming: button("等待恢复确认", "resume", "disabled"),
      blocked: button("重放返工演示", "replay", "data-cr037-focus"),
      revised: '<span class="caption">等待验证器检查 r2</span>' +
        (!rework.lateArchived ? button("试跑旧轮回执迟到", "late-receipt", "data-cr037-focus") : "") +
        button("重放返工演示", "replay", rework.lateArchived ? "data-cr037-focus" : "")
    };
    return `${headline("定向返工 · 合成演示", status, tone)}${body}<div class="cr037-actions">${next[stage]}${button("退出演示", "task-close", ["stopping", "resuming"].includes(stage) ? "data-cr037-focus" : "")}</div>`;
  }

  function taskCard(task) {
    return rework && task.id === taskId && task.project === projectId ? `<section class="cr037-card" id="cr037-task" data-ui-version="UI-CR037-v2" aria-label="定向返工">${taskBody()}</section>` : "";
  }

  function advance(from, to, source) {
    if (rework?.phase !== from || !document.getElementById("cr037-task")) return false;
    rework.phase = to;
    editPanel("cr037-task", taskBody(), source);
    return true;
  }

  actions["ai-cr037"] = showChoiceDialog;
  actions["cr037-chat-load"] = startChat;
  actions["cr037-chat-send"] = send;
  actions["cr037-chat-close"] = () => {
    chat = null;
    document.getElementById("cr037-chat")?.remove();
    document.querySelector("[data-act=ai-cr037]")?.focus({ preventScroll: true });
  };
  actions["cr037-fresh-dialog"] = () => newSessionDialog("fresh");
  actions["cr037-switch-dialog"] = () => newSessionDialog("switch");
  actions["cr037-cancel-new"] = () => UI.closeSubDialog();
  actions["cr037-new-fresh"] = () => completeNewSession("fresh");
  actions["cr037-new-switch"] = () => completeNewSession("switch");
  actions["cr037-open-task"] = openTask;
  actions["cr037-pass"] = el => {
    const route = el.dataset.route;
    if (rework?.phase !== "candidate" || !["direct", "relay"].includes(route)) return;
    rework.route = route;
    advance("candidate", "passed", el);
  };
  actions["cr037-reject"] = el => advance("passed", "rejected", el);
  actions["cr037-stop"] = el => {
    const request = rework;
    if (!advance("rejected", "stopping", el)) return;
    setTimeout(() => {
      if (rework !== request) return;
      request.writerStopped = true;
      request.phase = "stopped";
      editPanel("cr037-task", taskBody());
    }, 900);
  };
  actions["cr037-resume"] = el => {
    if (rework?.phase !== "stopped" || !rework.writerStopped || !document.getElementById("cr037-task")) return;
    const request = rework;
    request.allocated = { id: "INV-2087-A2", sourceInvocationId: r1.invocationId };
    advance("stopped", "resuming", el);
    setTimeout(() => {
      if (rework !== request) return;
      request.phase = "revised";
      editPanel("cr037-task", taskBody());
    }, 900);
  };
  actions["cr037-late-receipt"] = el => {
    if (rework?.phase !== "revised" || !rework.writerStopped || rework.lateArchived || !document.getElementById("cr037-task")) return;
    rework.lateArchived = true;
    editPanel("cr037-task", taskBody(), el);
  };
  actions["cr037-block"] = el => advance("stopped", "blocked", el);
  actions["cr037-replay"] = el => {
    rework = { phase: "candidate", writerStopped: false, allocated: null };
    editPanel("cr037-task", taskBody(), el);
  };
  actions["cr037-task-close"] = () => { rework = null; document.getElementById("cr037-task")?.remove(); };
  return { agentLink, chatCard, taskCard, send, beforeSwitchSession };
})();
