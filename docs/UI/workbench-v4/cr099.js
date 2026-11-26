/* UI-CR099-v1：设置中心评审二轮与能力管理合并（设计稿，纯内存演示）。
   覆盖 CR-099 的 11 项，做法是「在原渲染结果上打补丁」而不是重写设置页：
   - 保留 CR-085／CR-091 已有的供应商卡、密钥、模型、检测、能力交互；
   - 只改本轮明确要求变更的结构与文案。
   本文件不读写真实设置、磁盘、网络，不发起任何请求。 */
window.CR099 = (() => {
  "use strict";
  const { D, store, esc, icon, toast, openSubDialog, dlgShell, closeSubDialog } = UI;
  const S = window.Screens;
  const VERSION = "UI-CR099-v1";

  /* ---------------- 左栏：5 项 + 能力管理四 tab ---------------- */
  const NAV = [
    ["general", "通用", "settings"],
    ["models", "模型管理", "cpu"],
    ["probe", "模型检测", "shield"],
    ["cli", "SDK 与 CLI", "terminal"],
    ["abilities", "能力管理", "layers"]
  ];
  const ABILITY_TABS = [
    ["skills", "Skill"],
    ["mcp", "MCP"],
    ["tools", "Tools"],
    ["search", "搜索"]
  ];
  const isAbility = tab => ABILITY_TABS.some(x => x[0] === tab);
  const labelOf = tab => {
    if (isAbility(tab)) return "能力管理";
    const hit = NAV.find(x => x[0] === tab);
    return hit ? hit[1] : "设置";
  };

  /* ---------------- 演示状态 ---------------- */
  store.cr099 = store.cr099 || { showDisabled: false, abilityTab: "skills", newId: null };
  const st = store.cr099;
  let patching = false;

  /* ---------------- 夹具补齐（仅设计范围） ---------------- */
  const identity = () => {
    const g = D.settings.general;
    g.chat = g.chat || {};
    g.chat.identity = g.chat.identity || { enabled: false, preset: "codex" };
    return g.chat.identity;
  };
  identity();

  const searchState = () => {
    D.settings.search = D.settings.search || {
      backend: "default", tavilyUrl: "https://api.tavily.com", tavilyKey: "",
      timeout: 20, limit: 10, webFetch: true,
      granted: [
        { project: "预约服务", dirs: ["D:/work/booking-service"] },
        { project: "运维控制台", dirs: ["D:/work/ops-console", "D:/work/ops-docs"] }
      ]
    };
    return D.settings.search;
  };
  searchState();

  /* 权限挡位：按 CLI 采用已验证定义（决定 D2）。
     依据参考实现的 provider 门控：Claude 与 Codex 五项（Codex 的 auto 按原生审查可用性），
     无头 CLI 隐藏 auto 与 plan。本项目语义映射见下方 name/desc，不再出现「未核验」灰项。 */
  const PERMISSIONS = {
    claude: [
      { id: "default", name: "默认模式", desc: "逐次确认每次操作，保留原生审批边界。", enabled: true },
      { id: "plan", name: "规划模式", desc: "只读分析并给出计划，不落盘修改。", enabled: true },
      { id: "agent", name: "代理模式", desc: "自动接受文件编辑，其他操作仍需审批。", enabled: true },
      { id: "auto", name: "自动审核", desc: "由原生审核通道判定审批请求，保留安全边界。", enabled: true },
      { id: "full", name: "完全访问", desc: "跳过全部权限检查；仅在已核验隔离环境使用。", enabled: true }
    ],
    codex: [
      { id: "default", name: "默认模式", desc: "请求原生审批，工作区可写。", enabled: true },
      { id: "plan", name: "规划模式", desc: "只读执行边界，不落盘修改。", enabled: true },
      { id: "agent", name: "代理模式", desc: "保留工作区沙箱，不逐次请求审批。", enabled: true },
      { id: "auto", name: "自动审核", desc: "由原生审查通道逐项判定；旧版本无此能力。", enabled: true },
      { id: "full", name: "完全访问", desc: "跳过沙箱与审批；仅在已核验隔离环境使用。", enabled: true }
    ],
    grok: [
      { id: "default", name: "默认模式", desc: "逐次确认每次操作。", enabled: true },
      { id: "agent", name: "代理模式", desc: "按会话允许范围执行，不逐次确认。", enabled: true },
      { id: "full", name: "完全访问", desc: "全部允许；仅在已核验隔离环境使用。", enabled: true }
    ]
  };
  const permissionsOf = cliId => PERMISSIONS[cliId] || PERMISSIONS.claude;

  /* ---------------- 通用：模拟客户端身份 ----------------
     全局开关 + 身份二选一。开启后平台 runtime 调用模型时统一携带该 CLI 的
     客户端身份标识；不伪造凭证、账号与计费头。 */
  function identityBlock() {
    const id = identity();
    const presets = [["codex", "Codex"], ["claude", "Claude"]];
    return `<div class="c95-identity">
      <div class="c95-identity-top">
        <button type="button" class="switch" role="switch" aria-checked="${id.enabled}"
          aria-label="模拟客户端身份" data-c95="identity-toggle"></button>
        <div class="c95-identity-presets" data-disabled="${!id.enabled}" role="radiogroup" aria-label="模拟身份">
          ${presets.map(([v, t]) => `<button type="button" role="radio" class="c95-preset"
            aria-checked="${id.preset === v}" data-c95="identity-preset" data-v="${v}" ${id.enabled ? "" : "disabled"}>${icon(v === "codex" ? "terminal" : "layers", "ico-14")}${t}</button>`).join("")}
        </div>
      </div>
      <span class="c95-identity-hint">开启后，平台 runtime 请求模型时按所选 CLI 携带客户端身份标识；<b>不改变凭证、账号与计费归属</b>，也不影响 CLI 会话自身的启动参数。</span>
    </div>`;
  }

  /* ---------------- 模型管理：列表下方入口 ＋ 停用折叠 ----------------
     顺序（用户两次明确要求）：在用供应商列表 → 查看停用供应商 → 新增供应商 → 新建的卡。
     - 停用折叠在在用列表下方、新增供应商上方，两者不混排；
     - 新增供应商沿用既有文字按钮 .text-add 与既有新建动作，不自造草稿表单；
     - 新建出来的卡放在「新增供应商」这一行下面。 */
  const enabledProviders = () => D.settings.providers.filter(p => p.enabled);
  const disabledProviders = () => D.settings.providers.filter(p => !p.enabled);

  function providerTail() {
    const n = disabledProviders().length;
    const fold = n ? `<div class="c95-disabled" data-c95-fold>
      <button type="button" class="text-add c95-fold-btn" data-c95="toggle-disabled" aria-expanded="${st.showDisabled}">
        ${icon(st.showDisabled ? "chevronUp" : "chevronDown", "ico-14")}查看停用供应商（${n}）
      </button>
      <div class="c95-disabled-list"${st.showDisabled ? "" : " hidden"}></div>
    </div>` : "";
    return `${fold}<div class="c95-provider-actions">
      <button type="button" class="text-add" data-act="provider-new">${icon("plus", "ico-14")}新增供应商</button>
      <div class="c95-new-slot" data-c99-slot></div>
    </div>`;
  }

  /* 停用供应商不再自绘卡片：由 patchModels 把原型已渲染的原卡片节点搬进折叠区，
     这样开关、状态标签、删除入口与在用列表完全一致（用户要求「开始之前的开关就好」）。 */


  /* ---------------- 模型检测：这里只展示「指纹归因到哪个模型」 ----------------
     用户第三轮：「存在不通过项：这里要整段移除，不要这里。这里只展示归因到那个模型」。
     因此本段只输出归因结论，不列出各针不通过项，也不带边框、底色与卡片。 */
  const CONSISTENCY = {
    match: { label: "与声称家族一致", tone: "green" },
    mismatch: { label: "与声称家族不一致", tone: "amber" },
    unknown: { label: "无法判定", tone: "gray" }
  };
  function resultNote() {
    const p = store.probe;
    if (!p || !p.result) return "";
    const attr = p.result.attribution;
    if (!attr) return "";
    const c = CONSISTENCY[attr.consistency] || CONSISTENCY.unknown;
    const cands = (attr.candidates || []).slice(0, 3);
    const top = cands[0];

    // 只讲「归因到哪个模型」：最像的候选 + 一致性 + 概率性提示。
    const lead = top
      ? `最像 <span class="mono">${esc(top.name)}</span>（d=${top.distance.toFixed(2)}）`
      : "与所有已知候选都不像（基线库外），不指认";
    const rest = cands.length > 1
      ? `；其余候选 ${cands.slice(1).map((x, i) => `#${i + 2} ${esc(x.name)} d=${x.distance.toFixed(2)}`).join("、")}`
      : "";

    return `<p class="c95-result-text" aria-label="指纹归因">`
      + `<b>指纹归因：</b>${lead}`
      + `<span class="c95-attr-flag tag ${c.tone}">${esc(c.label)}</span>`
      + `<span class="c95-attr-claimed">声称家族 <span class="mono">${esc(attr.claimedFamily || "未知")}</span></span>`
      + `${rest}；概率性提示，不构成实锤。`
      + `</p>`;
  }

  /* ---------------- SDK 与 CLI：候选为空的原因 ---------------- */
  function modelEmptyReason(cliId) {
    const providers = D.settings.providers;
    if (!providers.length) return "尚未配置供应商：先到「模型管理」新增供应商与文本模型。";
    if (!providers.some(p => p.enabled)) return "全部供应商已停用：启用后模型才会进入候选。";
    return cliId === "claude"
      ? "没有 Anthropic 协议的可对话模型：该 CLI 只认 Anthropic 端点，请在供应商里补 Anthropic 地址与密钥。"
      : "没有 OpenAI 协议的可对话模型：该 CLI 只认 Chat／Responses 端点，请检查端点与密钥的启用状态。";
  }

  /* ---------------- 能力 · 搜索 ---------------- */
  function searchPanel() {
    const s = searchState();
    return `<div class="s95-search">
      <section class="c95-card">
        <div class="c95-card-h"><b>联网搜索</b><span class="caption">默认免 API Key（DuckDuckGo，Bing 备用）；配置 Tavily 后优先，失败回退默认。</span></div>
        <div class="c95-card-b">
          <div class="c95-field"><label>后端</label>
            <div class="seg" role="radiogroup" aria-label="联网搜索后端">
              <button type="button" role="radio" aria-checked="${s.backend === "default"}" data-c95="search-backend" data-v="default">默认（免 Key）</button>
              <button type="button" role="radio" aria-checked="${s.backend === "tavily"}" data-c95="search-backend" data-v="tavily">Tavily</button>
            </div>
          </div>
          ${s.backend === "tavily" ? `
          <div class="c95-field"><label for="c95-tavily-url">API 地址</label><input class="input mono" id="c95-tavily-url" value="${esc(s.tavilyUrl)}" data-c95-input="tavilyUrl"></div>
          <div class="c95-field"><label for="c95-tavily-key">API Key</label><input class="input mono" type="password" id="c95-tavily-key" value="${esc(s.tavilyKey)}" placeholder="已配置（留空保持不变）" autocomplete="off" data-c95-input="tavilyKey"></div>` : ""}
          <div class="c95-field"><label for="c95-search-timeout">超时（秒）</label><input class="input c95-num" id="c95-search-timeout" type="number" min="3" max="120" value="${s.timeout}" data-c95-input="timeout"></div>
          <div class="c95-field"><label for="c95-search-limit">结果数上限</label><input class="input c95-num" id="c95-search-limit" type="number" min="1" max="30" value="${s.limit}" data-c95-input="limit"></div>
          <div class="c95-field"><label>网页抓取</label>
            <span class="row" style="gap:8px;align-items:center"><button type="button" class="switch" role="switch" aria-checked="${s.webFetch}" aria-label="启用网页抓取" data-c95="search-webfetch"></button><span class="caption">启用 web_fetch</span></span>
            <span class="c95-hint">仅抓取公开页面；拒绝内网地址与本地回调。</span>
          </div>
          <div class="c95-card-f"><span class="spacer"></span><button type="button" class="btn primary" data-c95="search-save">保存搜索配置</button></div>
        </div>
      </section>
      <section class="c95-card">
        <div class="c95-card-h"><b>本地搜索授权目录</b><span class="caption">fs_grep／fs_glob 只在当前项目已授权目录内搜索。</span></div>
        <div class="c95-card-b">
          ${s.granted.map((g, gi) => `<div class="c95-grant">
            <div class="c95-grant-h"><b>${esc(g.project)}</b><span class="caption">${g.dirs.length} 个目录</span></div>
            ${g.dirs.map((d, di) => `<div class="c95-grant-row"><span class="mono">${esc(d)}</span><button type="button" class="c95-text-btn c95-muted" data-c95="grant-remove" data-g="${gi}" data-d="${di}">移除</button></div>`).join("") || `<p class="caption">该项目尚未授权任何目录。</p>`}
          </div>`).join("")}
        </div>
      </section>
    </div>`;
  }

  /* ---------------- 能力管理页 ---------------- */
  function abilityTabs() {
    return `<div class="c95-abilities"><div class="c95-ab-tabs" role="tablist" aria-label="能力管理分类">
      ${ABILITY_TABS.map(([id, label]) => `<button type="button" role="tab" id="c95-tab-${id}" aria-selected="${st.abilityTab === id}" aria-controls="c95-panel" data-c95="ability-tab" data-tab="${id}">${label}</button>`).join("")}
    </div><div class="c95-ab-panel" role="tabpanel" id="c95-panel" aria-labelledby="c95-tab-${st.abilityTab}"></div></div>`;
  }
  function fillAbilityPanel() {
    const panel = document.querySelector("#c95-panel");
    if (!panel) return;
    const tab = st.abilityTab;
    // 幂等：同一 tab 且内容签名未变时不重建，避免与观察器互相触发导致元素反复 detach。
    const s = searchState();
    const signature = tab === "search"
      ? `search:${s.backend}:${s.webFetch}:${s.granted.map(g => g.dirs.length).join(".")}`
      : `${tab}:${(D.settings[tab] || []).length}`;
    if (panel.dataset.c95Sig === signature) return;
    panel.innerHTML = tab === "search"
      ? searchPanel()
      : (window.CR085Capabilities?.content(tab) ?? `<p class="caption">该分类内容暂不可用。</p>`);
    panel.dataset.c95Sig = signature;
    panel.setAttribute("aria-labelledby", `c95-tab-${tab}`);
  }

  /* ---------------- 补丁：在既有渲染上就地改造 ---------------- */
  function patchNav() {
    const list = document.querySelector(".settings-dialog .set-nav-list");
    if (!list) return;
    const current = isAbility(store.settingsTab) ? "abilities" : store.settingsTab;
    if (list.dataset.c95Nav === current) return;
    list.innerHTML = NAV.map(([k, label, ic]) => `<button class="s-item" aria-selected="${current === k}" data-act="c95-nav" data-tab="${k}">${icon(ic, "ico-14")}${label}</button>`).join("");
    list.dataset.c95Nav = current;
  }

  function patchHead() {
    const head = document.querySelector(".settings-dialog .set-head");
    if (!head) return;
    const current = store.settingsTab;
    const h2 = head.querySelector("h2");
    if (h2 && h2.textContent !== labelOf(current)) h2.textContent = labelOf(current);
    head.querySelectorAll("[data-act='provider-new']").forEach(b => b.remove());
    if (current === "models" && !head.querySelector(".set-head-imagegen")) {
      const actions = document.createElement("div");
      actions.className = "row set-head-actions";
      actions.innerHTML = `<button type="button" class="icon-btn set-head-imagegen" data-act="imagegen-open" title="生图配置" aria-label="生图配置">${icon("image", "ico-18")}</button>`;
      head.appendChild(actions);
    }
  }

  /* 通用：在「会话与行为」末尾补一行模拟身份。 */
  function patchGeneral() {
    const group = document.querySelector('[data-c91-group="behavior"] .c91-rows');
    if (!group || group.querySelector(".c95-identity")) return;
    const row = document.createElement("div");
    row.className = "c91-row";
    row.innerHTML = `<div class="c91-label"><b>模拟客户端身份</b></div><div class="c91-control">${identityBlock()}</div>`;
    group.appendChild(row);
  }

  /* 模型管理：入口、草稿卡、停用折叠都在列表下方。
     顺序（用户两次明确要求）：在用供应商列表 → 查看停用供应商 → 新增供应商 → 草稿卡。
     关键约束（用户第三轮）：点「新增供应商」只产生一张**未保存草稿**，
     不进入供应商数据、不计入「N 个在用供应商」、不出现在上方列表；
     只有点「保存供应商」后才落到上方列表。 */
  function patchModels() {
    const root = document.querySelector(".set-scroll");
    if (!root) return;
    root.querySelectorAll(".row.between [data-act='provider-new']").forEach(b => b.remove());

    const list = root.querySelector(".provider-sort-list");
    if (!list) return;

    // 停用的供应商由折叠区承载，不在主列表里重复渲染。
    D.settings.providers.filter(p => !p.enabled).forEach(p => {
      list.querySelector(`[data-provider-card="${p.id}"]`)?.remove();
    });

    // 尾部区域必须始终存在：草稿卡、折叠区都挂在它上面。
    // 若因重绘丢失，按当前状态重建一次（不因幂等签名跳过）。
    if (!root.querySelector("[data-c99-tail]")) {
      const tail = document.createElement("div");
      tail.dataset.c99Tail = "1";
      tail.innerHTML = providerTail();
      list.insertAdjacentElement("afterend", tail);
      root.dataset.c99Models = "";
    }

    const signature = `${st.showDisabled}:${enabledProviders().length}:${disabledProviders().length}`;
    if (root.dataset.c99Models === signature) return;

    root.dataset.c99Models = signature;

    const holder = root.querySelector(".c95-disabled-list");
    if (holder) {
      holder.dataset.c99Holder = "1";
      holder.innerHTML = disabledProviders().map(providerCardHtml).join("");
      // 折叠区按 st.showDisabled 决定是否可见。
      holder.toggleAttribute("hidden", !st.showDisabled);
      const foldBtn = root.querySelector('[data-c95="toggle-disabled"]');
      if (foldBtn) foldBtn.setAttribute("aria-expanded", String(st.showDisabled));
    }

    const count = [...root.querySelectorAll(".c85-count, .caption")].find(n => /个供应商/.test(n.textContent));
    if (count) {
      // 只统计已保存的供应商；草稿不计数。
      const n = enabledProviders().length, off = disabledProviders().length;
      count.textContent = `${n} 个在用供应商${off ? ` · ${off} 个停用` : ""}`;
    }
  }

  function patchModelsInjectDraft() {
    const slot = document.querySelector("[data-c99-slot]");
    if (!slot) return;
    if (!st.draft) { slot.innerHTML = ""; slot.dataset.c99DraftSig = ""; return; }
    // 签名含页签与模型数量：切页签、加删模型都要重绘草稿。
    const signature = `${st.draft.tab || "config"}:${(st.draft.models || []).length}:${(st.draft.keys || []).length}:${(st.draft.endpoints || []).length}:${st.draft.protocol}`;
    if (slot.dataset.c99DraftSig === signature && slot.querySelector("[data-c99-draft]")) return;
    // 重绘会丢输入焦点：先记住正在编辑的字段与光标位置。
    const active = document.activeElement;
    const focusKey = active?.dataset?.c99DraftField
      ? `${active.dataset.c99DraftField}:${active.dataset.idx || ""}`
      : (active?.id || null);
    const selStart = active?.selectionStart ?? null;
    const selEnd = active?.selectionEnd ?? null;

    slot.innerHTML = draftCardHtml();
    slot.dataset.c99DraftSig = signature;

    if (focusKey) {
      const next = slot.querySelector(`[data-c99-draft-field="${focusKey.split(":")[0]}"][data-idx="${focusKey.split(":")[1] || ""}"]`) || slot.querySelector(`#${focusKey}`);
      if (next) {
        next.focus({ preventScroll: true });
        if (selStart != null && next.setSelectionRange) next.setSelectionRange(selStart, selEnd);
      }
    }
  }

  /* 草稿卡：新增供应商点开后在这里填写，保存前不属于供应商数据。
     结构、类名与原型标准供应商卡一致（页签、密钥、ID/名称、默认协议、API 地址），
     只是标题行多一个「未保存」标记，并带保存/放弃。 */
  function draftCardHtml() {
    const d = st.draft;
    const eol = (d.endpoints || []).map((ep, i) => `<div class="c85-endpoint">
      <label class="endpoint-proto">${ep.protocol === "openai" ? "OpenAI" : "Anthropic"}</label>
      <input class="input mono" data-c99-draft-field="endpoint" data-idx="${i}" value="${esc(ep.url)}" placeholder="https://…" aria-label="${ep.protocol} API 地址">
    </div>`).join("");
    return `<div class="provider-card open c99-draft" data-c99-draft="1" aria-label="新供应商草稿">
      <div class="provider-h">
        <span class="pinfo"><b>${esc(d.name || "新供应商")}</b><span>未保存 · 填写后点「保存供应商」才进入列表</span></span>
        <span class="tag amber">未保存</span>
        <button class="icon-btn" type="button" data-c95="discard-draft" title="放弃草稿" aria-label="放弃草稿">${icon("trash")}</button>
      </div>
      <div class="provider-inline">
        <div class="pm-tabs" role="tablist" aria-label="新供应商页签">
          ${[["config", "供应商配置"], ["models", "模型配置"]].map(([k, l]) => `<button type="button" role="tab" aria-selected="${d.tab === k}" aria-controls="c99-draft-panel" class="${d.tab === k ? "on" : ""}" data-c95="draft-tab" data-tab="${k}">${l}</button>`).join("")}
        </div>
        <div class="pm-body" id="c99-draft-panel" role="tabpanel">
          ${d.tab === "models" ? draftModelsBody() : draftConfigBody(d, eol)}
        </div>
        <div class="pm-f"><span class="spacer"></span>
          <button class="btn" type="button" data-c95="discard-draft">放弃</button>
          <button class="btn primary" type="button" data-c95="save-draft">保存供应商</button>
        </div>
      </div>
    </div>`;
  }

  function draftConfigBody(d, eol) {
    return `
      <div class="pm-section"><div class="row between"><b>API 密钥</b></div>
        <div class="key-list"><button class="text-add c85-add-key" type="button" data-c95="draft-add-key">${icon("plus", "ico-14")}添加密钥</button></div>
        ${(d.keys || []).length ? `<p class="caption">草稿中已有 ${d.keys.length} 个密钥，保存后一起提交。</p>` : ""}
      </div>
      <div class="pm-section c85-provider-identity">
        <div><label for="c99-draft-name">供应商名称</label><input class="input" id="c99-draft-name" data-c99-draft-field="name" value="${esc(d.name)}" placeholder="例如：中转网关"></div>
        <div><label for="c99-draft-id">供应商 ID</label><input class="input mono" id="c99-draft-id" data-c99-draft-field="id" value="${esc(d.id)}" placeholder="自动生成"></div>
      </div>
      <div class="pm-section"><label>默认协议</label>
        <div class="seg-cards" role="radiogroup" aria-label="供应商默认协议">
          ${["Chat", "Responses", "Anthropic"].map(p => `<button class="seg-card ${d.protocol === p ? "on" : ""}" type="button" role="radio" aria-checked="${d.protocol === p}" data-c95="draft-protocol" data-v="${p}">${p}</button>`).join("")}
        </div>
      </div>
      <div class="pm-section"><label>API 地址</label>
        ${eol || `<button class="link-btn" type="button" data-c95="draft-add-endpoint">${icon("plus", "ico-14")}OpenAI 地址</button>`}
      </div>`;
  }

  /* 草稿的模型配置页签：与标准卡一致的工具栏与空态。
     但「获取模型」依赖已保存的供应商（要拿端点与密钥向上游拉清单），
     所以草稿态把它置为禁用并写明先保存，避免误以为草稿能直接拉模型。 */
  function draftModelsBody() {
    const d = st.draft;
    const models = d.models || [];
    return `
      <div class="row between model-toolbar">
        <span class="caption">${models.length} 个模型 · 拖动手柄排序 · 点击行展开</span>
        <span class="row">
          <button class="link-btn" type="button" data-c95="draft-need-save" title="需先保存供应商">自动获取思考等级</button>
          <button class="link-btn" type="button" data-c95="draft-model-add">手动添加</button>
          <button class="link-btn strong" type="button" data-c95="draft-need-save" title="需先保存供应商">获取模型</button>
        </span>
      </div>
      <div class="model-list model-sort-list" aria-label="草稿模型列表">
        ${models.length ? models.map(m => `<div class="model-item">
          <div class="model-head">
            <button class="drag-handle sm" type="button" aria-label="拖动排序模型 ${esc(m.name)}">${icon("drag", "ico-14")}</button>
            <span class="m-name">${esc(m.name)}</span>
            <span class="m-id mono">${esc(m.id)}</span>
            <span class="m-tags">${(m.modalities || []).map(t => `<span class="tag gray">${esc(t)}</span>`).join("")}</span>
            <span class="m-ctx">${m.context ? Math.round(m.context / 1000) + "K" : "—"}</span>
            <button class="icon-btn model-del" type="button" data-c95="draft-model-del" data-id="${esc(m.id)}" title="删除模型">${icon("trash", "ico-14")}</button>
            <span class="m-chev">${icon("chevronDown", "ico-14")}</span>
          </div>
        </div>`).join("") : `<div class="empty" style="padding:24px"><b>还没有模型</b><p>保存供应商后，点「获取模型」从上游拉取清单并勾选；也可先「手动添加」。</p></div>`}
      </div>
      <p class="caption c99-draft-note">「获取模型」需要已保存的端点与密钥向上游拉清单：请先在「供应商配置」填好名称与地址并保存，再回来获取。</p>`;
  }

  function newDraft() {
    return { id: "", name: "", protocol: "Chat", keys: [], endpoints: [{ protocol: "openai", url: "" }], models: [], tab: "config" };
  }

  /* 切页签 / 保存前，把界面上的草稿字段收回到草稿对象（草稿不重绘，靠这一步同步）。 */
  function syncDraftFromDom() {
    if (!st.draft) return;
    const name = document.getElementById("c99-draft-name");
    if (name) st.draft.name = name.value;
    const id = document.getElementById("c99-draft-id");
    if (id) st.draft.id = id.value;
    document.querySelectorAll("[data-c99-draft-field='endpoint']").forEach(input => {
      const i = Number(input.dataset.idx);
      if (st.draft.endpoints[i]) st.draft.endpoints[i].url = input.value;
    });
  }

  /* 保存草稿：这时才写入供应商数据，之后才会出现在上方列表。 */
  function commitDraft() {
    syncDraftFromDom();
    const d = st.draft;
    if (!d) return false;
    const name = String(d.name || "").trim();
    if (!name) { toast("请填写供应商名称", "alert"); return false; }
    const id = String(d.id || "").trim() || "PRV-" + String(D.settings.providers.length + 1).padStart(2, "0");
    if (D.settings.providers.some(p => p.id === id)) { toast("供应商 ID 已存在", "alert"); return false; }
    D.settings.providers.push({
      id, name, protocol: d.protocol || "Chat", enabled: true, updated: "刚刚",
      keys: [], endpoints: (d.endpoints || []).filter(e => e.url && e.url.trim()).map(e => ({ protocol: e.protocol, url: e.url.trim(), on: true })),
      headers: [], spoof: "关闭",
      models: (d.models || []).map(m => ({ ...m, on: true })),
      availableModels: []
    });
    st.draft = null;
    S.refreshSettings(); patchAll();
    toast("供应商已保存");
    return true;
  }
  /* 停用卡：完全沿用原型在用卡的头部结构（含开关），只是数据来自停用项。
     与在用卡唯一差别是不展开配置区——停用态不该继续改配置。 */
  function providerCardHtml(p) {
    return `<div class="provider-card c99-stopped" data-provider-card="${esc(p.id)}">
      <div class="provider-h">
        <button class="drag-handle" data-drag-provider="${esc(p.id)}" title="拖动排序（键盘：Alt+↑/↓）" aria-label="拖动排序供应商 ${esc(p.name)}">${icon("drag", "ico-14")}</button>
        <span class="pinfo" data-act="provider-expand" data-id="${esc(p.id)}" role="button" tabindex="0"><b>${esc(p.name)}</b><span>${esc(p.protocol)} · ${p.keys.length} 个密钥 · ${p.endpoints.length} 个端点 · ${p.models.length} 个模型</span></span>
        <span class="status gray">停用</span>
        <button class="switch" data-act="provider-toggle" data-id="${esc(p.id)}" aria-checked="false" aria-label="启用供应商 ${esc(p.name)}"></button>
        <button class="icon-btn" data-act="provider-delete" data-id="${esc(p.id)}" title="删除供应商">${icon("trash")}</button>
      </div>
    </div>`;
  }

  /* 模型检测：移除独立归因卡，把一段纯文本接到结果摘要后面；同时去掉会插行的提示。 */
  function patchProbe() {
    document.querySelectorAll(".probe-section").forEach(sec => {
      sec.classList.add("c95-probe");
      sec.querySelectorAll(".probe-attr").forEach(n => n.remove());
      sec.querySelectorAll(".probe-run-hint").forEach(n => n.remove());
      const result = sec.querySelector(".c85-result, .probe-result");
      if (!result) return;
      result.querySelectorAll(".c95-result-text").forEach(n => n.remove());
      const summary = result.querySelector(".c85-result-summary, .probe-result-summary");
      if (store.probe?.result) {
        if (summary) summary.insertAdjacentHTML("afterend", resultNote());
        else result.insertAdjacentHTML("beforeend", resultNote());
      }
    });
  }

  /* SDK 与 CLI：权限下拉按 CLI 已验证定义重做；模型下拉为空时给出原因。 */
  function patchCli() {
    document.querySelectorAll(".s85-cli-card").forEach(card => {
      const id = card.getAttribute("data-s85-cli");
      if (!id) return;
      const d = window.CR085Sdk?.draft?.(id);
      const select = card.querySelector('[data-s85="permission"]');
      if (!select || !d) return;
      const list = permissionsOf(id);
      // 只改选项：可用性不再出现「未核验」占位（AC-10）。
      const options = list.map(p => `<option value="${p.id}"${p.id === d.permission ? " selected" : ""}>${esc(p.name)}</option>`).join("")
        + (list.some(p => p.id === d.permission) ? "" : `<option value="${esc(d.permission)}" selected>原权限已失效</option>`);
      if (select.dataset.c95Opts !== options) {
        select.innerHTML = options;
        select.dataset.c95Opts = options;
      }
      // 说明只保留一条：旧的「未核验」反馈与重复说明都清掉，再按当前档位写一条。
      card.querySelectorAll(".c95-perm-desc").forEach(n => n.remove());
      const stale = [...card.querySelectorAll(".s85-feedback")].find(n => /未核验/.test(n.textContent));
      stale?.remove();
      const hit = list.find(p => p.id === d.permission);
      if (hit) select.insertAdjacentHTML("afterend", `<p class="c95-perm-desc caption">${esc(hit.desc)}</p>`);
    });

    document.querySelectorAll(".s85-cli-body").forEach(body => {
      const card = body.closest(".s85-cli-card");
      const id = card?.getAttribute("data-s85-cli");
      if (!id) return;
      const sel = body.querySelector(".s85-model-grid select");
      if (!sel) return;
      const usable = [...sel.options].filter(o => o.value);
      let note = body.querySelector(".c95-model-empty");
      if (!usable.length) {
        const reason = modelEmptyReason(id);
        if (!note) sel.insertAdjacentHTML("afterend", `<p class="c95-model-empty caption" role="status">${esc(reason)}</p>`);
        else note.textContent = reason;
      } else note?.remove();
    });
  }

  /* 能力管理页：套上四个 tab 的壳。 */
  function patchAbilities() {
    const body = document.querySelector(".set-scroll");
    if (!body || !isAbility(store.settingsTab)) return;
    if (!body.querySelector(".c95-abilities")) body.innerHTML = abilityTabs();
    const active = body.querySelector(".c95-ab-tabs button[aria-selected='true']");
    if (active && active.dataset.tab !== st.abilityTab) active.setAttribute("aria-selected", "false");
    body.querySelectorAll(".c95-ab-tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === st.abilityTab)));
    fillAbilityPanel();
  }

  function patchAll() {
    if (patching) return;
    patching = true;
    try {
      // 归一化：外部（URL 参数、旧入口）可能用「能力管理」这一组名打开，
      // 实际内容按当前选中的能力 tab 渲染。
      if (store.settingsTab === "abilities") {
        store.settingsTab = st.abilityTab;
        baseRefresh();
      }
      patchNav();
      patchHead();
      const tab = store.settingsTab;
      if (tab === "general") patchGeneral();
      if (tab === "models") { patchModels(); patchModelsInjectDraft(); }
      if (tab === "probe") patchProbe();
      if (tab === "cli") patchCli();
      if (isAbility(tab)) patchAbilities();
    } finally {
      // 让本轮自身产生的 DOM 变更不再触发一次补丁。
      patching = false;
    }
  }

  /* ---------------- 事件 ---------------- */
  document.addEventListener("click", e => {
    const nav = e.target.closest("[data-act='c95-nav']");
    if (nav) {
      e.preventDefault(); e.stopImmediatePropagation();
      const tab = nav.dataset.tab;
      S.openSettings(tab === "abilities" ? st.abilityTab : tab);
      patchAll();
      return;
    }
    // 新增供应商：只开一张草稿卡，不写入供应商数据、不计入列表与数量。
    const newBtn = e.target.closest("[data-act='provider-new']");
    if (newBtn) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (st.draft) { toast("已有未保存的供应商草稿，请先保存或放弃", "warn"); return; }
      st.draft = newDraft();
      S.refreshSettings(); patchAll();
      document.getElementById("c99-draft-name")?.focus();
      return;
    }
    const el = e.target.closest("[data-c95]");
    if (!el) return;
    const a = el.dataset.c95;
    e.preventDefault(); e.stopImmediatePropagation();
    if (a === "ability-tab") { st.abilityTab = el.dataset.tab; store.settingsTab = st.abilityTab; patchAbilities(); patchHead(); patchNav(); return; }
    if (a === "identity-toggle") { const id = identity(); id.enabled = !id.enabled; S.refreshSettings(); patchAll(); return; }
    if (a === "identity-preset") { const id = identity(); id.preset = el.dataset.v; S.refreshSettings(); patchAll(); return; }
    if (a === "toggle-disabled") {
      st.showDisabled = !st.showDisabled;
      const fold = el.closest("[data-c95-fold]");
      const holder = fold?.querySelector(".c95-disabled-list");
      if (holder) {
        // 重绘可能清空过内容：展开时按当前停用项补齐，只切可见性不整页重绘。
        if (st.showDisabled && !holder.children.length) holder.innerHTML = disabledProviders().map(providerCardHtml).join("");
        holder.toggleAttribute("hidden", !st.showDisabled);
      }
      el.setAttribute("aria-expanded", String(st.showDisabled));
      el.innerHTML = `${icon(st.showDisabled ? "chevronUp" : "chevronDown", "ico-14")}查看停用供应商（${disabledProviders().length}）`;
      return;
    }
    if (a === "enable-provider") {
      const p = D.settings.providers.find(x => x.id === el.dataset.id);
      if (p) { p.enabled = true; S.refreshSettings(); patchAll(); toast("供应商已启用（演示）"); }
      return;
    }
    if (a === "delete-provider") {
      D.settings.providers = D.settings.providers.filter(x => x.id !== el.dataset.id);
      S.refreshSettings(); patchAll(); return;
    }
    if (a === "discard-draft") {
      st.draft = null; S.refreshSettings(); patchAll(); return;
    }
    if (a === "save-draft") { commitDraft(); return; }
    if (a === "draft-tab") {
      if (st.draft) {
        // 切页签前先收下当前输入，避免丢草稿。
        syncDraftFromDom();
        st.draft.tab = el.dataset.tab;
        S.refreshSettings(); patchAll();
      }
      return;
    }
    if (a === "draft-need-save") {
      toast("获取模型需要已保存的端点与密钥：请先填好「供应商配置」并保存供应商", "warn");
      return;
    }
    if (a === "draft-model-add") {
      if (st.draft) {
        const n = (st.draft.models || []).length + 1;
        st.draft.models = [...(st.draft.models || []), { id: "model-" + n, name: "新模型 " + n, modalities: ["文本"], context: null }];
        S.refreshSettings(); patchAll();
        toast("已添加一个模型占位，保存供应商后可补全 ID 与能力", "warn");
      }
      return;
    }
    if (a === "draft-model-del") {
      if (st.draft) {
        st.draft.models = (st.draft.models || []).filter(m => m.id !== el.dataset.id);
        S.refreshSettings(); patchAll();
      }
      return;
    }
    if (a === "draft-protocol") {
      if (st.draft) { st.draft.protocol = el.dataset.v; S.refreshSettings(); patchAll(); }
      return;
    }
    if (a === "draft-add-endpoint") {
      if (st.draft) {
        const has = st.draft.endpoints.some(e => e.protocol === "anthropic");
        if (has) { toast("两个协议地址都已填写", "warn"); return; }
        st.draft.endpoints.push({ protocol: "anthropic", url: "" });
        st.draft = { ...st.draft }; S.refreshSettings(); patchAll();
      }
      return;
    }
    if (a === "draft-add-key") {
      if (st.draft) {
        st.draft.keys.push({ alias: "", secret: "" });
        S.refreshSettings(); patchAll();
        toast("草稿密钥请在保存后于卡片内继续配置", "warn");
      }
      return;
    }
    if (a === "search-backend") { searchState().backend = el.dataset.v; patchAbilities(); return; }
    if (a === "search-webfetch") { const s = searchState(); s.webFetch = !s.webFetch; patchAbilities(); return; }
    if (a === "search-save") { toast("搜索配置已保存（演示）"); return; }
    if (a === "grant-remove") {
      const s = searchState();
      s.granted[Number(el.dataset.g)]?.dirs.splice(Number(el.dataset.d), 1);
      patchAbilities(); return;
    }
  }, true);

  document.addEventListener("input", e => {
    // 草稿字段：只改草稿对象，不碰供应商数据（保存前不入列表）。
    const df = e.target.closest("[data-c99-draft-field]");
    if (df && st.draft) {
      const field = df.dataset.c99DraftField;
      if (field === "endpoint") {
        const i = Number(df.dataset.idx);
        if (st.draft.endpoints[i]) st.draft.endpoints[i].url = df.value;
      } else {
        st.draft[field] = df.value;
      }
      // 标题行的名称实时回显（不重绘，避免丢焦点）。
      if (field === "name") {
        const b = document.querySelector("[data-c99-draft] .pinfo b");
        if (b) b.textContent = df.value || "新供应商";
      }
      return;
    }
    const el = e.target.closest("[data-c95-input]");
    if (!el) return;
    const s = searchState();
    s[el.dataset.c95Input] = el.type === "number" ? Number(el.value) : el.value;
  }, true);

  /* ---------------- 接管 openSettings / refreshSettings 后统一打补丁 ---------------- */
  const baseOpen = S.openSettings;
  S.openSettings = tab => {
    if (isAbility(tab)) { st.abilityTab = tab; store.settingsTab = tab; baseOpen(tab); }
    else baseOpen(tab);
    patchAll();
  };

  const baseRefresh = S.refreshSettings;
  S.refreshSettings = () => { baseRefresh(); patchAll(); };

  /* 原型内部有些刷新直接调用自身闭包里的 refreshSettings（不复经 Screens.refreshSettings），
     例如检测逐针推进。用 MutationObserver 兜住这类重绘，保证补丁始终生效。 */
  function observe() {
    const body = document.querySelector(".set-scroll");
    if (!body || body.dataset.c95Observed === "1") return;
    body.dataset.c95Observed = "1";
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; patchAll(); });
    }).observe(body, { childList: true, subtree: true });
  }

  /* 原型首次进入：按 ?settings= 打开后补一次。 */
  const param = new URLSearchParams(location.search).get("settings");
  if (param) setTimeout(() => S.openSettings(param), 0);
  setTimeout(observe, 0);

  return {
    version: VERSION,
    nav: NAV.map(x => x[0]),
    abilityTabs: ABILITY_TABS.map(x => x[0]),
    permissions: PERMISSIONS,
    modelEmptyReason,
    patchAll
  };
})();
