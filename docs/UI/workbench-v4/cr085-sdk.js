/* UI-CR085-SDK-v1 · FEAT-015 · 纯设计资源，所有操作为合成仿真。
 * 集成：主代理在 settingsHtml / refreshSettings 中优先使用 CR085Sdk.content(tab)。
 * 不接 IPC / npm / fetch，不改 Screens；UI-SCROLL-001 继承 scrollbar.js 的实际滚动 + 700ms。
 */
window.CR085Sdk = (() => {
  "use strict";
  const { D, store, esc, icon } = UI;
  const state = store.cr085Sdk = store.cr085Sdk || {
    drafts: {}, targets: {}, busy: {}, feedback: {}, history: [], selected: null,
    recordsOpen: false, registry: "https://registry.npmmirror.com", registrySaved: "https://registry.npmmirror.com",
    failures: {}, delay: 650, sequence: 0
  };
  const copy = value => JSON.parse(JSON.stringify(value));
  state.refreshResults = state.refreshResults || {};
  const ver = value => String(value || "").replace(/^v/, "");
  const withV = value => value && value !== "—" ? "v" + ver(value) : "—";
  const cli = id => D.settings.clis.find(c => c.id === id);
  const sdk = id => D.settings.sdks.find(s => s.id === id);
  const safeId = value => String(value).replace(/[^a-zA-Z0-9_-]/g, "-");
  const later = fn => setTimeout(fn, state.delay);
  const effortOrder = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const aliases = { "关闭": "off", "低": "low", "中": "medium", "高": "high", "极高": "xhigh", "最高": "max", none: "off" };
  const effortKey = value => aliases[String(value).toLowerCase()] || String(value).toLowerCase();
  const effortLabel = value => window.CR074?.effortLabel ? window.CR074.effortLabel(value) : String(value);

  // 同 AI 侧栏的能力源。不同 CLI 的名称可相同，原生语义与可用性分别声明。
  // 来源：ModelPicker.tsx permissionOptions + CR068 的 Grok 能力边界；auto/full 未核验不开放。
  function permissions(id) {
    const entries = {
      claude: [
        ["default", "默认模式", "Claude default · 保留原生逐次审批边界", true],
        ["plan", "规划模式", "Claude plan · 只读规划语义，不是 OS 沙箱", true],
        ["agent", "代理模式", "Claude acceptEdits · 自动接受编辑，其他操作仍审批", true],
        ["auto", "自动审核", "原生审核通道未核验", false],
        ["full", "完全访问", "bypassPermissions · 隔离与托管策略未核验", false]
      ],
      codex: [
        ["default", "默认模式", "Codex on-request + workspace-write · 请求原生审批", true],
        ["plan", "规划模式", "Codex read-only + never · 只读执行边界", true],
        ["agent", "代理模式", "Codex workspace-write + never · 保留工作区沙箱", true],
        ["auto", "自动审核", "approvalsReviewer · 原生审核通道未核验", false],
        ["full", "完全访问", "danger-full-access · 隔离与托管策略未核验", false]
      ],
      grok: [
        ["default", "默认模式", "Grok ACP 权限请求 · 审批桥未核验", false],
        ["agent", "代理模式", "Grok ACP 允许范围 · 原生通道未核验", false],
        ["full", "完全访问", "Grok /always-approve on · 审批能力未核验", false]
      ]
    };
    return (entries[id] || []).map(([key, name, desc, enabled]) => ({ id: key, name, desc, enabled, available: enabled, icon: "shield" }));
  }
  // 侧栏和设置复用同一函数；不临时改 store.aiCli 来获取另一 CLI 的能力。
  Object.defineProperty(D.ai, "permissions", { configurable: true, get: () => permissions(store.aiCli) });

  function models(id) {
    return (window.CR068?.catalog(id) || []).flatMap(p => p.models.map(m => ({
      ...m, providerId: p.id, providerName: p.name,
      key: p.id + "::" + (m.modelId || m.id), label: p.name + " · " + m.name
    })));
  }
  function resolve(id, value) {
    return models(id).find(m => m.key === value || m.label === value || (m.providerName + " · " + m.id) === value) || null;
  }
  function mainModel(id) {
    const current = D.ai.modelCatalog.current || {};
    return models(id).find(m =>
      (m.providerId === current.providerId || m.providerName === current.provider) &&
      (m.id === current.modelId || m.id === current.model || m.name === current.model)) || null;
  }
  function efforts(model) {
    if (!model || model.thinking === false) return [];
    const valid = value => value === null || typeof value === "string" && !!value.trim();
    let source;
    if (model.efforts && typeof model.efforts === "object") {
      source = Object.keys(model.efforts).filter(k => valid(model.efforts[k]));
    } else {
      source = Array.isArray(model.levels) ? model.levels : [];
      // 原型只显式保存有改动的映射；未覆盖的已声明档位沿用同名 wire。
      if (model.mappings) source = source.filter(k => !(k in model.mappings) || valid(model.mappings[k]));
    }
    return [...new Set(source.filter(k => typeof k === "string" && k.trim()))].sort((a, b) => {
      const rank = k => effortOrder.includes(effortKey(k)) ? effortOrder.indexOf(effortKey(k)) : 99;
      return rank(a) - rank(b);
    });
  }
  function draft(id) {
    if (!state.drafts[id]) {
      const c = cli(id);
      state.drafts[id] = {
        permission: c?.permission || "default", slots: copy(c?.slots || []),
        fallback: copy(c?.fallback || { model: "", effort: "" }), dirty: false
      };
    }
    const d = state.drafts[id];
    [d.fallback, ...d.slots].forEach((s, i) => {
      const found = i === 0 && !s.model ? mainModel(id) : resolve(id, s.model);
      if (found && s.model) s.model = found.key; // 旧显示字符串迁移为稳定身份。
      if (s.effort && !efforts(found).includes(s.effort)) {
        s.effort = "";
        d.dirty = true;
      }
    });
    return d;
  }
  function selectedSlot(id, key) {
    const d = draft(id);
    return key === "fallback" ? d.fallback : d.slots[Number(key)];
  }
  function target(s) {
    const list = versions(s);
    if (!state.targets[s.id]) state.targets[s.id] = list.includes(ver(s.latest)) ? ver(s.latest) : list[0] || "";
    return state.targets[s.id];
  }
  function versions(s) {
    const list = [...new Set((s.versions || []).map(ver).filter(v => /^\d+\.\d+\.\d+$/.test(v)))].slice(0, 10);
    const cur = ver(s.version);
    if (s.installed && cur && cur !== "—" && !list.includes(cur)) list.push(cur);
    return list;
  }
  function newer(s) {
    if (!s.installed || !s.latest || !s.version) return false;
    const a = ver(s.latest).split(".").map(Number), b = ver(s.version).split(".").map(Number);
    if (a.length !== 3 || b.length !== 3 || [...a, ...b].some(n => !Number.isFinite(n))) return false;
    for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
    return false;
  }
  function actionState(s) {
    const selected = target(s), busy = state.busy[s.id];
    const same = s.installed && ver(s.version) === selected;
    return {
      target: selected, busy: !!busy, disabled: !!busy || same || !selected || s.builtin,
      label: busy?.action === "install" ? "安装中…" : same ? "当前版本 " + withV(s.version) : (s.installed ? "升级到 " : "安装到 ") + withV(selected)
    };
  }
  function refresh() {
    // 仅重绘设置内容；草稿均保存在 state，焦点与原滚动位置按稳定键恢复。
    if (!document.querySelector(".s85-content")) return;
    const scroll = document.querySelector(".set-scroll");
    const active = document.activeElement;
    const focusKey = active?.getAttribute?.("data-s85-focus");
    const top = scroll?.scrollTop || 0, left = scroll?.scrollLeft || 0;
    const selection = active && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
    const inner = [...document.querySelectorAll(".s85-content [data-s85-scroll]")].map(el => [el.getAttribute("data-s85-scroll"), el.scrollTop, el.scrollLeft]);
    window.Screens.refreshSettings();
    if (scroll) { scroll.scrollTop = top; scroll.scrollLeft = left; }
    inner.forEach(([key, y, x]) => {
      const el = [...document.querySelectorAll(".s85-content [data-s85-scroll]")].find(el => el.getAttribute("data-s85-scroll") === key);
      if (el) { el.scrollTop = y; el.scrollLeft = x; }
    });
    if (focusKey) {
      const next = [...document.querySelectorAll("[data-s85-focus]")].find(el => el.getAttribute("data-s85-focus") === focusKey);
      if (next && !next.disabled) {
        next.focus({ preventScroll: true });
        if (selection && next.setSelectionRange) next.setSelectionRange(...selection);
      }
    }
  }
  const attrs = (action, id = "", key = "") => `data-s85="${action}" data-id="${esc(id)}" data-key="${esc(key)}" data-s85-focus="${esc(action + ":" + id + ":" + key)}"`;
  const note = (message, error = false) => message ? `<p class="s85-feedback ${error ? "error" : ""}" role="${error ? "alert" : "status"}">${esc(message)}</p>` : "";
  function feedback(id) { const n = state.feedback[id]; return n ? note(n.message, n.error) : ""; }
  function logo(id, size) { return id === 'dsh' ? icon('box', 'ico-20') : window.Screens.cliTile(id, size); }

  function modelField(id, key, slot) {
    const fallback = key === "fallback", list = models(id), m = fallback && !slot.model ? mainModel(id) : resolve(id, slot.model);
    const choices = efforts(m), fieldId = "s85-" + safeId(id + "-" + key);
    const invalid = !!slot.model && !m;
    return `<div class="s85-model-grid">
      <div class="s85-field"><label for="${fieldId}-model">${fallback ? "兜底模型" : "模型"}</label>
        <select class="select" id="${fieldId}-model" ${attrs("model", id, key)} aria-invalid="${invalid}"${invalid ? ` aria-describedby="${fieldId}-error"` : ""}>
          <option value="">${fallback ? "跟随主 agent" : "未选择模型"}</option>
          ${list.map(x => `<option value="${esc(x.key)}"${x.key === slot.model ? " selected" : ""}>${esc(x.label)}</option>`).join("")}
          ${invalid ? `<option value="${esc(slot.model)}" selected disabled>${esc(slot.model)}（不可用）</option>` : ""}
        </select>
      </div>
      <div class="s85-field"><label for="${fieldId}-effort">思考等级</label>
        <select class="select" id="${fieldId}-effort" ${attrs("effort", id, key)}${choices.length ? "" : " disabled"}>
          <option value="">${!m ? "未选择兼容模型" : !choices.length ? "未配置思考档位" : fallback && !slot.model ? "跟随主 agent" : "模型默认"}</option>
          ${choices.map(x => `<option value="${esc(x)}"${slot.effort === x ? " selected" : ""}>${esc(effortLabel(x))}</option>`).join("")}
        </select>
      </div>
    </div>${invalid ? `<p id="${fieldId}-error" class="s85-feedback error" role="alert">模型不可用，请重新选择。</p>` : ""}
      ${fallback && !slot.model ? `<p class="s85-follow">当前：${m ? esc(m.label) : "主 agent 未配置兼容模型"}</p>` : ""}`;
  }
  function routeBody(c) {
    const d = draft(c.id), id = c.id;
    const selected = store.cliRouteSel?.[id] || "fallback";
    const key = selected !== "fallback" && !d.slots[Number(selected)] ? "fallback" : selected;
    const open = !!store.cliRouteOpen?.[id], slot = key === "fallback" ? d.fallback : d.slots[Number(key)];
    const tab = (k, label, remove) => `<span class="route-tab-wrap">
      <button class="route-tab ${k === key ? "on" : ""}" type="button" ${attrs("slot-select", id, k)} aria-pressed="${k === key}" aria-controls="s85-route-${id}" title="${esc(k === "fallback" ? d.fallback.model || "跟随主 agent" : d.slots[Number(k)]?.model || "未选择模型")}">${label}</button>
      ${remove ? `<button class="route-x" type="button" ${attrs("slot-remove", id, k)} aria-label="删除${label}" title="删除${label}">${icon("x", "ico-12")}</button>` : ""}</span>`;
    const perms = permissions(id), selectedPerm = perms.find(p => p.id === d.permission);
    return `<div class="s85-cli-body">
      <div class="route-card ${open ? "open" : ""}"><div class="route-bar">
        <div class="route-tabs" aria-label="${esc(c.name)} 任务模型路由">${tab("fallback", "兜底模型", false)}${d.slots.map((s, i) => tab(String(i), "模型" + (i + 1), true)).join("")}
          ${d.slots.length < 5 ? `<button class="route-add" type="button" ${attrs("slot-add", id)} aria-label="新增模型槽">${icon("plus", "ico-14")}新增</button>` : ""}
        </div><span class="spacer"></span><span class="route-sum">${d.slots.length}/5</span>
        <button class="route-toggle" type="button" ${attrs("route-toggle", id)} aria-expanded="${open}" aria-controls="s85-route-${id}" aria-label="${open ? "收起" : "展开"}模型配置">${icon(open ? "chevronUp" : "chevronDown", "ico-14")}</button>
      </div>${open ? `<div class="route-detail" id="s85-route-${id}">${modelField(id, key, slot)}${key === "fallback" ? "" : `<div class="s85-field"><label>执行任务类型</label><div class="chips">${D.settings.taskTypes.map(t => `<button class="chip ${(slot.types || []).includes(t) ? "on" : ""}" type="button" ${attrs("slot-type", id, key)} data-type="${esc(t)}" aria-pressed="${(slot.types || []).includes(t)}">${esc(t)}</button>`).join("")}</div></div>`}</div>` : ""}</div>
      <div class="s85-field"><label for="s85-perm-${id}">权限模式</label><select class="select" id="s85-perm-${id}" ${attrs("permission", id)}${perms.some(p => p.enabled) ? "" : " disabled"}>
        ${perms.map(p => `<option value="${p.id}"${p.id === d.permission ? " selected" : ""}${p.enabled ? "" : " disabled"}>${esc(p.name)}${p.enabled ? "" : "（暂未核验）"}</option>`).join("")}
        ${!selectedPerm ? `<option value="${esc(d.permission)}" selected disabled>原权限已失效</option>` : ""}
      </select>${note(selectedPerm?.desc || "当前 CLI 权限映射未核验", !selectedPerm || !selectedPerm.enabled)}</div>
      <div class="s85-cli-footer"><button class="btn sm primary" type="button" ${attrs("cli-save", id)}>保存</button>${d.dirty ? '<span class="s85-status">未保存</span>' : ""}</div>${feedback("cli:" + id)}
    </div>`;
  }
  function cliList() {
    return `<div class="s85-cli-list">${D.settings.clis.map(c => {
      const canExpand = !c.builtin, open = store.cliOpen === c.id;
      return `<article class="s85-cli-card" data-s85-cli="${c.id}"><div class="s85-cli-head">
        <button class="s85-cli-heading" type="button" ${attrs("cli-expand", c.id)}${canExpand ? ` aria-expanded="${open}" aria-controls="s85-cli-body-${c.id}"` : " disabled"}>
          ${logo(c.id, 30)}<span class="s85-heading-copy"><b>${esc(c.name)}</b><span>${c.builtin ? "内置" : esc(c.version || "—")}</span></span>
        </button>
        ${!c.installed ? '<span class="tag gray">未安装</span>' : ""}
        <button class="switch" type="button" ${attrs("cli-toggle", c.id)} role="switch" aria-label="启用 ${esc(c.name)}" aria-checked="${!!c.enabled}"${c.installed && !c.builtin ? "" : " disabled"}></button>
        ${canExpand ? `<button class="icon-btn" type="button" ${attrs("cli-expand", c.id)} aria-expanded="${open}" aria-controls="s85-cli-body-${c.id}" aria-label="${open ? "收起" : "展开"} ${esc(c.name)}">${icon(open ? "chevronUp" : "chevronDown", "ico-14")}</button>` : ""}
      </div>${canExpand && open ? `<div id="s85-cli-body-${c.id}">${routeBody(c)}</div>` : ""}</article>`;
    }).join("")}</div>`;
  }
  function sdkCard(s) {
    const open = store.sdkOpen === s.id, a = actionState(s), busy = state.busy[s.id];
    const versionLabel = newer(s) ? withV(s.version) + " → " + withV(s.latest) : s.installed ? withV(s.version) : "";
    return `<article class="s85-sdk-card" data-s85-sdk="${s.id}"><button class="s85-sdk-head" type="button" ${attrs("sdk-expand", s.id)} aria-expanded="${open}" aria-controls="s85-sdk-body-${s.id}">
      <span class="s85-logo">${logo(s.id, 30)}</span><span class="s85-heading-copy"><b>${esc(s.name)}</b><span class="mono">${esc(s.package)}</span></span>
      <span class="s85-sdk-status">${newer(s) ? '<span class="tag amber">有新版本</span>' : !s.installed ? '<span class="tag gray">未安装</span>' : ""}
        ${versionLabel ? `<span class="mono s85-version">${esc(versionLabel)}</span>` : ""}${busy ? `<span class="s85-loading">${busy.action === "refresh" ? "刷新中…" : busy.action === "uninstall" ? "卸载中…" : "安装中…"}</span>` : ""}</span>
      ${icon(open ? "chevronUp" : "chevronDown", "ico-14")}
    </button>${open ? `<div class="s85-sdk-body" id="s85-sdk-body-${s.id}">${s.builtin ? `<span class="s85-status">随宿主更新</span>` : `
      <div class="s85-target-row"><div class="s85-field"><label for="s85-target-${s.id}">目标版本</label><select class="select" id="s85-target-${s.id}" ${attrs("target", s.id)}${a.busy ? " disabled" : ""}>
        ${!versions(s).length ? '<option value="">暂无版本</option>' : versions(s).map(v => `<option value="${esc(v)}"${v === a.target ? " selected" : ""}>${withV(v)}${v === ver(s.latest) ? "（最新）" : v === ver(s.version) && s.installed ? "（当前）" : ""}</option>`).join("")}
        ${a.target && !versions(s).includes(a.target) ? `<option value="${esc(a.target)}" selected>${withV(a.target)}（已选择）</option>` : ""}
      </select></div><button class="btn sm" type="button" ${attrs("refresh", s.id)}${a.busy ? " disabled" : ""}>${icon("refresh", "ico-14")}刷新</button></div>
      <div class="s85-sdk-actions"><button class="btn sm ${a.disabled ? "" : "primary"}" type="button" ${attrs("install", s.id)}${a.disabled ? " disabled" : ""}>${esc(a.label)}</button>
        ${s.installed ? `<button class="btn sm danger" type="button" ${attrs("uninstall-ask", s.id)}${a.busy ? " disabled" : ""}>卸载</button>` : ""}</div>`}
      <div class="s85-field"><label>安装路径</label><div class="s85-path mono" tabindex="0" data-s85-scroll="path:${s.id}" aria-label="${esc(s.name)} 安装路径">${esc(s.path || "—")}</div></div>${feedback(s.id)}
    </div>` : ""}</article>`;
  }
  const time = at => new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const statusName = status => ({ running: "进行中", success: "成功", error: "失败" }[status] || status);
  function records() {
    const current = state.history.find(r => r.id === state.selected) || state.history[0];
    return `<div class="s85-record-dock"><button class="btn sm s85-record-trigger" type="button" ${attrs("records-toggle")} aria-expanded="${state.recordsOpen}" aria-controls="s85-record-panel">${icon("clock", "ico-14")}操作记录${state.history.length ? ` <span>${state.history.length}</span>` : ""}${icon(state.recordsOpen ? "chevronDown" : "chevronUp", "ico-14")}</button>
      ${state.recordsOpen ? `<section class="s85-record-panel" id="s85-record-panel" aria-label="操作记录"><div class="s85-record-title"><b>操作记录</b><span>最近 5 次 · 合成日志</span><button class="icon-btn" type="button" ${attrs("records-toggle")} aria-label="收起操作记录">${icon("x", "ico-14")}</button></div>
        ${!current ? '<p class="s85-record-empty">暂无操作记录</p>' : `<div class="s85-record-layout"><div class="s85-record-list" data-s85-scroll="record-list" aria-label="选择操作记录">${state.history.map(r => `<button type="button" class="s85-record-item ${r.id === current.id ? "on" : ""}" ${attrs("record-select", r.id)} aria-pressed="${r.id === current.id}" aria-controls="s85-record-log"><span>${esc(r.label)}</span><span><time datetime="${r.at}">${time(r.at)}</time><b class="s85-record-state ${r.status}">${statusName(r.status)}</b></span></button>`).join("")}</div>
        <pre class="s85-record-log mono" id="s85-record-log" data-s85-scroll="log:${current.id}" tabindex="0" aria-label="${esc(current.label)}日志">${esc(current.logs.join("\n"))}</pre></div>`}
      </section>` : ""}</div>`;
  }
  function sdkList() {
    const busy = Object.keys(state.busy).length > 0;
    return `<div class="s85-sdk-pane"><div class="s85-registry"><label for="s85-registry">npm registry</label><div class="s85-registry-controls"><input class="input mono" id="s85-registry" ${attrs("registry")} value="${esc(state.registry)}" autocomplete="url"><button class="btn sm" type="button" ${attrs("registry-save")}${busy ? " disabled" : ""}>保存</button><button class="btn sm" type="button" ${attrs("refresh-all")}${busy ? " disabled" : ""}>${icon("refresh", "ico-14")}刷新</button></div>${feedback("registry")}${feedback("all")}</div>
      <div class="s85-sdk-list">${D.settings.sdks.map(sdkCard).join("")}</div>${records()}</div>`;
  }
  function content(tab) {
    if (tab !== "cli") return null;
    return `<div class="s85-content" data-s85-version="UI-CR085-SDK-v1"><div class="cli-tabs s85-tabs" aria-label="SDK 与 CLI">
      <button type="button" class="${store.sdkTab !== "sdk" ? "on" : ""}" ${attrs("tab", "cli")} aria-pressed="${store.sdkTab !== "sdk"}">CLI 管理</button>
      <button type="button" class="${store.sdkTab === "sdk" ? "on" : ""}" ${attrs("tab", "sdk")} aria-pressed="${store.sdkTab === "sdk"}">SDK 管理</button>
    </div>${store.sdkTab === "sdk" ? sdkList() : cliList()}</div>`;
  }

  function beginRecord(label, action, ids) {
    const record = { id: "s85-op-" + (++state.sequence), at: new Date().toISOString(), label, action, status: "running", logs: [] };
    record.logs.push(`[${time(record.at)}] ${label}（设计仿真）`);
    state.history.unshift(record); state.history.splice(5); state.selected = record.id;
    ids.forEach(id => { state.busy[id] = { action, record: record.id }; delete state.feedback[id]; });
    return record;
  }
  function failNext(action, id = "*", message = "合成故障：操作失败，请重试。") { state.failures[action + ":" + id] = message; }
  function takeFailure(action, id) {
    const key = action + ":" + id, wildcard = action + ":*";
    const value = state.failures[key] || state.failures[wildcard];
    delete state.failures[key]; delete state.failures[wildcard]; return value;
  }
  function finish(record, ids, error, message) {
    record.status = error ? "error" : "success";
    record.logs.push(`[${time(new Date().toISOString())}] ${message}`);
    ids.forEach(id => { if (state.busy[id]?.record === record.id) delete state.busy[id]; state.feedback[id] = { error: !!error, message }; });
    refresh();
  }
  function install(id) {
    const s = sdk(id); if (!s || actionState(s).disabled) return false;
    const v = target(s), record = beginRecord(s.name + " · " + (s.installed ? "升级到 " : "安装到 ") + withV(v), "install", [id]);
    record.logs.push("registry " + state.registrySaved, "目标版本 " + withV(v), "准备依赖与校验文件…"); refresh();
    later(() => {
      const error = takeFailure("install", id);
      if (error) { record.logs.push("校验失败，保留原安装状态。"); finish(record, [id], error, error); return; }
      s.installed = true; s.version = withV(v); s.path = s.path && s.path !== "—" ? s.path : "~/.npm-global/bin/" + id;
      const c = cli(id); if (c) { c.installed = true; c.version = s.version; c.expandable = true; }
      record.logs.push("依赖校验完成。", "文件写入完成（合成，未执行安装）。");
      finish(record, [id], null, "安装成功 · " + s.version + "（仿真）");
    }); return true;
  }
  function uninstall(id) {
    const s = sdk(id); if (!s || s.builtin || !s.installed || state.busy[id]) return false;
    const record = beginRecord(s.name + " · 卸载", "uninstall", [id]);
    record.logs.push("检查当前版本 " + withV(s.version), "准备移除 SDK…"); refresh();
    later(() => {
      const error = takeFailure("uninstall", id);
      if (error) { finish(record, [id], error, error); return; }
      s.installed = false; s.version = "—"; s.path = "—";
      const c = cli(id); if (c) { c.installed = false; c.enabled = false; c.version = "—"; }
      finish(record, [id], null, "卸载成功（仿真）");
    }); return true;
  }
  function refreshSdk(id) {
    const list = id ? [sdk(id)].filter(Boolean) : D.settings.sdks.filter(s => !s.builtin);
    if (!list.length || list.some(s => state.busy[s.id])) return false;
    const ids = list.map(s => s.id), record = beginRecord(id ? list[0].name + " · 刷新" : "全部 SDK · 刷新", "refresh", ids);
    record.logs.push("读取本机检测结果…", "获取最新 10 个稳定版本…"); refresh();
    // 原子更新：检测与版本列表均成功才发布；任一失败保留上一份完整快照。
    later(() => {
      const error = takeFailure("refresh", id || "all") || list.map(s => takeFailure("refresh", s.id)).find(Boolean);
      if (error) {
        if (!id) state.feedback.all = { error: true, message: error + " 已保留原检测与版本列表。" };
        finish(record, ids, error, error + " 已保留原检测与版本列表。"); return;
      }
      const snapshots = list.map(s => ({ ...copy(s), ...copy(state.refreshResults[s.id] || {}), checkedAt: new Date().toISOString() }));
      list.forEach((s, i) => {
        Object.assign(s, snapshots[i]);
        delete state.refreshResults[s.id];
        const c = cli(s.id); if (c) { c.installed = s.installed; c.version = s.version; if (!s.installed) c.enabled = false; }
        record.logs.push(s.name + "：" + (s.installed ? withV(s.version) : "未安装") + "；最新 " + withV(s.latest));
      });
      if (!id) state.feedback.all = { error: false, message: "检测与版本列表已刷新（仿真）" };
      finish(record, ids, null, "检测与版本列表已刷新（仿真）");
    }); return true;
  }
  function saveCli(id) {
    const c = cli(id), d = draft(id); if (!c) return false;
    const invalid = d.slots.some(s => !resolve(id, s.model)) || d.fallback.model && !resolve(id, d.fallback.model);
    if (invalid) { state.feedback["cli:" + id] = { error: true, message: "请选择可用模型，或删除无效模型槽。" }; refresh(); return false; }
    if (!permissions(id).some(p => p.id === d.permission && p.enabled)) {
      state.feedback["cli:" + id] = { error: true, message: "当前权限尚未核验，无法保存。" }; refresh(); return false;
    }
    c.slots = copy(d.slots); c.fallback = copy(d.fallback); c.permission = d.permission; d.dirty = false;
    state.feedback["cli:" + id] = { error: false, message: "已保存 · 对后续新会话生效（仿真）" }; refresh(); return true;
  }
  function askUninstall(id) {
    const s = sdk(id); if (!s || s.builtin || state.busy[id]) return;
    UI.openSubDialog(`<span data-dialog-class="modal-sm" hidden></span><div class="dlg-h"><h2>卸载 ${esc(s.name)}？</h2><button class="icon-btn" type="button" ${attrs("uninstall-cancel")} aria-label="关闭">${icon("x", "ico-16")}</button></div><div class="dlg-b"><p>当前版本 ${esc(withV(s.version))}</p></div><div class="dlg-f"><button class="btn" type="button" ${attrs("uninstall-cancel")}>取消</button><button class="btn danger" type="button" ${attrs("uninstall-confirm", id)}>卸载</button></div>`);
  }
  function perform(action, id, key, element) {
    const d = () => draft(id);
    const route = () => { store.cliRouteOpen = store.cliRouteOpen || {}; store.cliRouteSel = store.cliRouteSel || {}; };
    switch (action) {
      case "tab": store.sdkTab = id; refresh(); break;
      case "cli-expand": if (cli(id)?.builtin) return; store.cliOpen = store.cliOpen === id ? "" : id; refresh(); break;
      case "cli-toggle": { const c = cli(id); if (c?.installed && !c.builtin) c.enabled = !c.enabled; refresh(); break; }
      case "route-toggle": route(); store.cliRouteOpen[id] = !store.cliRouteOpen[id]; refresh(); break;
      case "slot-select": route(); { const same = (store.cliRouteSel[id] || "fallback") === key; store.cliRouteSel[id] = key; store.cliRouteOpen[id] = same ? !store.cliRouteOpen[id] : true; } refresh(); break;
      case "slot-add": route(); if (d().slots.length >= 5) return; d().slots.push({ model: "", effort: "", types: [] }); d().dirty = true; store.cliRouteSel[id] = String(d().slots.length - 1); store.cliRouteOpen[id] = true; refresh(); break;
      case "slot-remove": if (key === "fallback" || !Number.isInteger(Number(key)) || !d().slots[Number(key)]) return; route(); d().slots.splice(Number(key), 1); d().dirty = true; store.cliRouteSel[id] = d().slots.length ? String(Math.min(Number(key), d().slots.length - 1)) : "fallback"; refresh(); break;
      case "slot-type": { const s = selectedSlot(id, key), t = element?.dataset.type; if (!s || !D.settings.taskTypes.includes(t)) return; s.types = (s.types || []).includes(t) ? s.types.filter(x => x !== t) : [...(s.types || []), t]; d().dirty = true; refresh(); break; }
      case "cli-save": saveCli(id); break;
      case "sdk-expand": store.sdkOpen = store.sdkOpen === id ? "" : id; refresh(); break;
      case "install": install(id); break;
      case "refresh": refreshSdk(id); break;
      case "refresh-all": refreshSdk(); break;
      case "uninstall-ask": askUninstall(id); break;
      case "uninstall-cancel": UI.closeSubDialog(); break;
      case "uninstall-confirm": UI.closeSubDialog(); uninstall(id); break;
      case "records-toggle": state.recordsOpen = !state.recordsOpen; refresh(); break;
      case "record-select": state.selected = id; refresh(); break;
      case "registry-save": {
        if (Object.keys(state.busy).length) return;
        const r = beginRecord("保存 npm registry", "registry", []);
        try { const parsed = new URL(state.registry.trim()); if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw Error(); state.registrySaved = parsed.href.replace(/\/$/, ""); r.status = "success"; r.logs.push("已保存 " + state.registrySaved + "（仅设计内存）。"); state.feedback.registry = { message: "已保存（仿真）" }; }
        catch { r.status = "error"; r.logs.push("保存失败：请输入有效 HTTP(S) 地址，不含凭证。"); state.feedback.registry = { error: true, message: "请输入有效 HTTP(S) 地址，不含凭证。" }; }
        refresh(); break;
      }
    }
  }
  function change(action, id, key, value) {
    if (action === "registry") { state.registry = value; return; }
    if (action === "target") { if (!state.busy[id] && versions(sdk(id)).includes(value)) state.targets[id] = value; refresh(); return; }
    const d = draft(id);
    if (action === "permission") { if (permissions(id).some(p => p.id === value && p.enabled)) { d.permission = value; d.dirty = true; } refresh(); return; }
    const s = selectedSlot(id, key); if (!s) return;
    if (action === "model") {
      if (value && !resolve(id, value)) return;
      s.model = value;
      const m = key === "fallback" && !value ? mainModel(id) : resolve(id, value);
      if (!efforts(m).includes(s.effort)) s.effort = "";
      d.dirty = true; refresh();
    } else if (action === "effort") {
      const m = key === "fallback" && !s.model ? mainModel(id) : resolve(id, s.model);
      if (!value || efforts(m).includes(value)) { s.effort = value; d.dirty = true; delete state.feedback["cli:" + id]; refresh(); }
    }
  }
  document.addEventListener("click", event => {
    const el = event.target.closest?.("[data-s85]");
    if (!el || el.matches("input,select,textarea")) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!el.disabled) perform(el.dataset.s85, el.dataset.id, el.dataset.key, el);
  }, true);
  document.addEventListener("change", event => {
    const el = event.target.closest?.("[data-s85]");
    if (!el || !el.matches("input,select,textarea")) return;
    event.stopImmediatePropagation();
    if (!el.disabled) change(el.dataset.s85, el.dataset.id, el.dataset.key, el.value);
  }, true);
  document.addEventListener("input", event => {
    if (event.target.dataset?.s85 === "registry") state.registry = event.target.value;
  }, true);
  return { version: "UI-CR085-SDK-v1", content, permissions, models, resolve, mainModel, efforts, draft, actionState, versions, newer,
    install, uninstall, refreshSdk, saveCli, failNext,
    setRefreshResult: (id, result) => { state.refreshResults[id] = copy(result); },
    perform, change, state, scroll: { version: "UI-CR049-v1", idleMs: 700, owner: "scrollbar.js" } };
})();
