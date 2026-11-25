/* CR-076：会话任务及目标的合成场景，和项目执行步骤分开。 */
const ChatDock = (() => {
  const { esc, icon } = UI;
  const status = { completed: "已完成", running: "进行中", pending: "待处理", failed: "失败", cancelled: "已取消", awaiting_user: "待用户处理" };
  const drafts = new WeakMap();
  const expanded = new WeakSet();
  const action = (key, label, glyph) => `<button class="chat-goal-action" type="button" data-act="${key}" aria-label="${label}" title="${label}">${icon(glyph, "ico-14")}</button>`;

  const stateDot = state => state === "running"
    ? '<svg class="chat-task-spinner" data-state="ongoing" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><g class="chat-task-spinner-motion"><circle class="chat-task-spinner-track" cx="12" cy="12" r="9.5"/><circle class="chat-task-spinner-arc" cx="12" cy="12" r="9.5"/></g></svg>'
    : `<span class="chat-task-dot" data-state="${state === "completed" ? "done" : state === "failed" ? "error" : state === "awaiting_user" ? "warning" : "idle"}" aria-hidden="true"></span>`;
  const syncAnimations = root => { for (const animation of root.getAnimations?.({ subtree: true }) || []) animation.startTime = 0; };
  const synced = new WeakSet();
  function syncStateDots() { document.querySelectorAll(".chat-task-spinner").forEach(spinner => { if (synced.has(spinner)) return; synced.add(spinner); syncAnimations(spinner); spinner.addEventListener("animationstart", () => syncAnimations(spinner)); }); }

  function render(session) {
    if (!session) return "";
    const tasks = session.tasks || [];
    const open = expanded.has(session);
    const progress = Object.entries(status).flatMap(([state, label]) => {
      const count = tasks.filter(item => item.state === state).length;
      return count ? [`${count} ${label}`] : [];
    }).join(" · ");
    const todo = tasks.length ? `<section class="chat-dock-card chat-todo" data-testid="todo-panel" aria-label="任务">
      <button class="chat-todo-header" type="button" data-act="ai-task-toggle" aria-expanded="${open}" ${open ? 'aria-controls="ai-task-list"' : ""}>${icon("steps", "ico-16")}<span class="chat-dock-label">任务</span><span class="chat-dock-ellipsis" title="${esc(progress)}">${esc(progress)}</span>${icon(open ? "chevronDown" : "chevronUp", "ico-16")}</button>
      ${open ? `<ul class="chat-todo-list" id="ai-task-list" data-testid="todo-list">${tasks.map(item => `<li data-status="${esc(item.state)}"><span class="chat-todo-glyph" role="img" aria-label="${esc(status[item.state])}">${stateDot(item.state)}</span><span class="chat-dock-ellipsis" title="${esc(item.title)}">${esc(item.title)}</span></li>`).join("")}</ul>` : ""}
    </section>` : "";
    if (drafts.has(session)) return `${todo}<div class="chat-dock-card chat-goal editing" data-goal-bar><textarea id="ai-goal-draft" rows="1" aria-label="目标内容">${esc(drafts.get(session))}</textarea><div class="chat-goal-actions">${action("ai-goal-apply", "保存目标", "check")}${action("ai-goal-cancel", "取消编辑", "x")}</div></div>`;
    if (!session.goal) return todo;
    const paused = session.goalPaused;
    return `${todo}<div class="chat-dock-card chat-goal" data-goal-bar>${icon("target", "ico-14")}<span class="chat-dock-label">${paused ? "已暂停的目标" : "进行中的目标"}</span><span class="chat-dock-ellipsis" title="${esc(session.goal)}">${esc(session.goal)}</span><div class="chat-goal-actions">${action("ai-goal-edit", "编辑目标", "edit")}${action("ai-goal-clear", "清除目标", "trash")}${action("ai-goal-toggle", paused ? "恢复目标" : "暂停目标", paused ? "play" : "pause")}</div></div>`;
  }

  function edit() {
    const session = AIPanel.activeSession();
    drafts.set(session, session.goal || "");
    UI.store.aiMenu = null;
    UI.render();
    document.getElementById("ai-goal-draft")?.focus();
  }

  function finish(save) {
    const session = AIPanel.activeSession();
    if (save) {
      const text = drafts.get(session)?.trim();
      if (!text) return;
      session.goal = text;
    }
    drafts.delete(session);
    UI.render();
    (document.querySelector('[data-act="ai-goal-edit"]') || document.getElementById("ai-input"))?.focus();
  }

  return { render, edit, finish, syncStateDots, toggle(session) {
    if (expanded.has(session)) expanded.delete(session);
    else expanded.add(session);
  }, input(session, text) { drafts.set(session, text); } };
})();
