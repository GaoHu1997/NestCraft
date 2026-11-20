/* CR-047 原型补丁：派发预检显示唯一执行特性；新建执行会话绑定 Feature；会话头/历史显示归属。
   仅设计资源，不连接真实执行。 */
(function () {
  "use strict";
  const { D, esc, icon, store, toast, openDialog, closeDialog, dlgShell } = UI;
  const actions = window.__actions;
  const KIND = { feature: "特性", story: "用户故事", bug: "缺陷", epic: "史诗", vision: "愿景" };

  function walk(node, fn) { fn(node); childrenOf(node.id).forEach(c => walk(c, fn)); }
  function childrenOf(id) { return D.requirements.filter(r => r.parent === id); }
  function findByStory(id) { return D.requirements.find(r => r.id === id) || null; }
  function featureOf(node) {
    if (!node) return null;
    if (node.kind === "feature") return node;
    if (node.kind !== "story" && node.kind !== "bug") return null;
    const seen = new Set([node.id]);
    let parent = node.parent ? findByStory(node.parent) : null;
    while (parent) {
      if (seen.has(parent.id)) return null;
      seen.add(parent.id);
      if (parent.kind === "feature") return parent;
      if (parent.kind !== "epic") return null;
      parent = parent.parent ? findByStory(parent.parent) : null;
    }
    return null;
  }
  function descendants(node, out = [], seen = new Set()) { if (seen.has(node.id)) return out; seen.add(node.id); childrenOf(node.id).forEach(c => { out.push(c); descendants(c, out, seen); }); return out; }
  function storiesIn(feature) {
    return descendants(feature).filter(n => n.kind === "story" || n.kind === "bug");
  }

  function preflight(id) {
    const node = findByStory(id);
    if (!node) { toast("当前范围没有可派发的需求"); return; }
    const feature = featureOf(node);
    const stories = node.kind === "feature" ? storiesIn(node) : node.kind === "story" || node.kind === "bug" ? [node] : descendants(node).filter(n => n.kind === "story" || n.kind === "bug");
    const ready = stories.filter(s => s.status === "ready");
    const excluded = stories.filter(s => s.status !== "ready");
    const summary = feature
      ? `<div class="cr047-feature"><span class="cr047-tag">执行特性</span><b>${esc(feature.id)} · ${esc(feature.title)}</b><p>本执行会话只实现该特性内的 Story；发现其它特性工作须另建执行会话。</p></div>`
      : `<div class="note-box" role="alert">${icon("alert", "ico-14")} 当前范围无法确定唯一执行特性。Epic 下可能有多个特性，请逐特性派发；Story 父链缺失时先修复源关系，不能合并进一个执行会话。</div>`;
    const body = `${summary}
      <div class="pf-summary"><div><div class="big">${ready.length}</div><div class="lbl">将派发</div></div>
      <div><div class="big">${excluded.length}</div><div class="lbl">范围外</div></div>
      <div style="flex:1"><div class="lbl">冻结范围</div><div style="font-size:12px">${feature ? esc(feature.id) + " 范围内可执行 Story" : esc(node.id) + " · 无可确定特性"}</div></div></div>
      <div class="preflight">${ready.map(s => `<div class="pf-item"><span class="pf-id">${esc(s.id)}</span><span class="pf-main"><b>${esc(s.title)}</b><span>${esc(s.cli || "—")} / ${esc(s.model || "—")} · ${s.acs ? s.acs.length : 0} 条 AC</span></span><span class="tag blue">待执行</span></div>`).join("") || `<div class="empty" style="padding:24px"><b>没有可派发的 Story</b><p>当前范围内没有「已就绪」的条目。</p></div>`}</div>
      ${excluded.length ? `<div><div class="caption" style="margin-bottom:6px">范围外（不派发）</div>${excluded.map(s => `<div class="pf-item excluded"><span class="pf-id">${esc(s.id)}</span><span class="pf-main"><b>${esc(s.title)}</b><span>${esc((D.statusMeta[s.status] || {}).label || s.status)}</span></span></div>`).join("")}</div>` : ""}
      <div class="note-box">${icon("alert", "ico-14")} 本机仿真：只设置新执行会话的特性归属，不创建 Run、不调用真实 CLI。</div>`;
    const footer = feature
      ? `<span class="left caption">${ready.length} 个 Story 将进入 ${esc(feature.id)} 执行会话</span><button class="btn" data-act="close-dialog">取消</button><button class="btn primary" data-act="cr047-new-session" data-feature="${esc(feature.id)}" ${ready.length ? "" : "disabled"}>${icon("play", "ico-14")}为 ${esc(feature.id)} 创建执行会话</button>`
      : `<span class="left caption">无唯一执行特性</span><button class="btn" data-act="close-dialog">关闭</button>`;
    openDialog(dlgShell("派发预检", feature ? "冻结特性范围；执行会话只属于该特性" : "先确定唯一执行特性，再创建会话", body, footer, "modal-wide"));
  }

  actions["req-dispatch"] = el => preflight(el.dataset.id);
  actions["dispatch"] = el => preflight(el.dataset.id);
  actions["cr047-new-session"] = el => {
    const id = el.dataset.feature;
    let feature = null;
    D.requirements.forEach(r => walk(r, n => { if (n.id === id && n.kind === "feature") feature = n; }));
    if (!feature) { toast("执行特性源已变化，请重新预检"); return; }
    const session = { id: "S-" + Date.now().toString().slice(-6), title: `执行 ${feature.id} · ${feature.title}`, status: "read", updated: "刚刚", tokens: "0", duration: "0s", messages: [], featureId: feature.id, featureTitle: feature.title, sessionRole: "executor" };
    D.ai.sessions.unshift(session);
    store.aiSession = session.id;
    store.aiMessages = [];
    store.aiInput = "";
    closeDialog();
    toast(`已创建执行会话：仅实现 ${feature.id}`, "check");
    UI.render();
    requestAnimationFrame(() => document.querySelector(".ai-panel .ai-scope-tag")?.scrollIntoView({ block: "nearest" }));
  };
  window.CR047 = Object.freeze({ preflight, featureOf });
})();
