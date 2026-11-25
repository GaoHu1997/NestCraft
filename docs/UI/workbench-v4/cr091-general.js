/* UI-CR091-v1：设置 → 通用 布局重排（设计稿，纯内存演示，不读写真实设置/磁盘/网络）。
   目标：按「我是谁 → 长什么样 → 怎么用 → 主机默认 → 存在哪 → 关于」重新分组；
   合并重复的头像与头像风格；补界面主题、密度、通知、启动行为、存储占用、关于；
   统一单一草稿 + 顶部粘附保存条，取消「点一下立即关闭弹窗重开」的混用保存模型。 */
window.CR091General = (() => {
  const { D, store, esc, icon, toast, dlgShell, openSubDialog, closeSubDialog, closeDialog, avatarHtml, avatarImg, AVATAR_LABELS } = UI;

  const VERSION = "UI-CR091-v1";
  const APP_VERSION = "0.0.5";
  const TZ = ["Asia/Shanghai", "Asia/Tokyo", "Asia/Singapore", "Europe/London", "America/New_York", "UTC"];
  const AUTH = [["key", "密钥文件"], ["password", "密码"], ["jump", "跳板机"]];
  const SEND = [["immediate", "立即发送"], ["queue", "排队"]];
  const THEME = [["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]];
  const DENSITY = [["standard", "标准"], ["compact", "紧凑"]];
  const CODE_THEME = [["auto", "跟随界面"], ["light", "浅色"], ["dark", "深色"]];
  const GROUPS = [
    ["identity", "个人资料", "个人资料", "user"],
    ["appearance", "外观与显示", "外观", "palette"],
    ["behavior", "会话与行为", "会话", "sliders"],
    ["host", "新建主机默认值", "主机默认", "server"],
    ["storage", "数据与存储", "数据", "database"],
    ["about", "关于", "关于", "info"],
  ];
  const DEFAULTS = {
    name: "", email: "", role: "", timezone: "Asia/Shanghai",
    themeMode: "system", density: "standard",
    codeTheme: "auto", fontSize: "13", tabSize: "2", wrap: true,
    sendMode: "queue", notifyDone: true, restoreLastWindow: true,
    port: "22", defaultUser: "", auth: "key",
    dataDir: "",
  };
  const KEY_LABEL = { auto: "跟随界面", light: "浅色", dark: "深色" };
  const AUTH_LABEL = { key: "密钥文件", password: "密码", jump: "跳板机" };

  let draft = null, saved = null, errors = {}, afterDiscard = null;

  /* ---------- 数据夹具补齐（设计稿范围；正式软件需数据设计确认） ---------- */
  function ensureData() {
    const g = D.settings.general;
    g.ui = g.ui || { themeMode: "system", density: "standard" };
    g.chat = g.chat || { notifyDone: true, restoreLastWindow: true };
    g.about = g.about || { version: APP_VERSION };
  }
  function codeThemeKey(v) {
    return ({ "跟随界面": "auto", "跟随系统": "auto", "浅色": "light", "深色": "dark" })[v] || "auto";
  }
  function authKey(v) {
    return ({ "密钥文件": "key", "密码": "password", "跳板机": "jump" })[v] || "key";
  }
  function snapshot() {
    ensureData();
    const g = D.settings.general;
    return {
      name: g.profile.name || "", email: g.profile.email || "", role: g.profile.role || "",
      timezone: g.profile.timezone || "Asia/Shanghai",
      themeMode: g.ui.themeMode || "system", density: g.ui.density || "standard",
      codeTheme: codeThemeKey(g.code.theme),
      fontSize: String(g.code.fontSize ?? 13), tabSize: String(g.code.tabSize ?? 2), wrap: Boolean(g.code.wrap),
      sendMode: g.sendMode || "queue",
      notifyDone: g.chat.notifyDone !== false, restoreLastWindow: g.chat.restoreLastWindow !== false,
      port: String(g.server.port ?? 22), defaultUser: g.server.defaultUser || "", auth: authKey(g.server.auth),
      dataDir: g.dataDir || "",
    };
  }
  function init() {
    if (draft && saved) return;
    saved = snapshot(); draft = { ...saved };
  }
  function dirtyKeys() {
    init();
    return Object.keys(draft).filter(k => draft[k] !== saved[k]);
  }
  function resolvedTheme(mode) {
    if (mode === "dark") return "dark";
    if (mode === "light") return "light";
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  /* ---------- 即时预览（未保存前只改视图；放弃即回滚） ---------- */
  function applyPreview() {
    document.documentElement.setAttribute("data-theme", resolvedTheme(draft.themeMode));
    document.body.dataset.density = draft.density;
    try { localStorage.setItem("wb4-theme", resolvedTheme(draft.themeMode)); } catch { /* 私有模式忽略 */ }
  }
  function restorePreview() {
    document.documentElement.setAttribute("data-theme", resolvedTheme(saved.themeMode));
    document.body.dataset.density = saved.density;
    try { localStorage.setItem("wb4-theme", resolvedTheme(saved.themeMode)); } catch { /* noop */ }
  }
  function codePreviewDark() {
    const t = draft.codeTheme === "auto" ? resolvedTheme(draft.themeMode) : draft.codeTheme;
    return t === "dark";
  }
  function syncPreviewChrome() {
    const pre = document.getElementById("c91-preview");
    if (pre) {
      pre.style.fontSize = `${Math.max(12, Math.min(16, Number(draft.fontSize) || 13))}px`;
      pre.style.tabSize = String(Number(draft.tabSize) === 4 ? 4 : 2);
      pre.style.whiteSpace = draft.wrap ? "pre-wrap" : "pre";
      pre.classList.toggle("dark", codePreviewDark());
      pre.classList.toggle("light", !codePreviewDark());
    }
    const dirtyEl = document.querySelector(".c91-dirty");
    const n = dirtyKeys().length;
    if (dirtyEl) { dirtyEl.textContent = n ? `${n} 项未保存` : "已保存"; dirtyEl.dataset.c91Clean = String(n === 0); }
    const btn = document.querySelector('[data-c91="save"]');
    if (btn) btn.disabled = n === 0;
  }

  /* ---------- 校验 ---------- */
  function validate(d) {
    const e = {};
    if (d.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim())) e.email = "邮箱格式不正确";
    if (d.name.trim().length > 40) e.name = "名称最多 40 个字符";
    if (d.role.trim().length > 24) e.role = "角色最多 24 个字符";
    const fs = Number(d.fontSize);
    if (!Number.isInteger(fs) || fs < 12 || fs > 16) e.fontSize = "字号需为 12–16 的整数";
    if (!["2", "4"].includes(String(d.tabSize))) e.tabSize = "Tab 宽度只能是 2 或 4";
    const port = Number(d.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) e.port = "端口需为 1–65535 的整数";
    if (d.defaultUser.trim() && !/^[A-Za-z0-9._-]{1,32}$/.test(d.defaultUser.trim())) e.defaultUser = "用户名只允许字母、数字与 . _ -";
    if (!["system", "light", "dark"].includes(d.themeMode)) e.themeMode = "未知的界面主题";
    if (!["standard", "compact"].includes(d.density)) e.density = "未知的界面密度";
    if (!["auto", "light", "dark"].includes(d.codeTheme)) e.codeTheme = "未知的代码主题";
    if (!["immediate", "queue"].includes(d.sendMode)) e.sendMode = "未知的发送行为";
    if (!["key", "password", "jump"].includes(d.auth)) e.auth = "未知的默认认证方式";
    if (!TZ.includes(d.timezone)) e.timezone = "未知的时区";
    return e;
  }

  /* ---------- 保存 / 放弃 / 默认 ---------- */
  function save() {
    init();
    errors = validate(draft);
    const n = Object.keys(errors).length;
    if (n) {
      render();
      const first = document.querySelector(".c91-control .input[aria-invalid=\"true\"]");
      first?.focus({ preventScroll: false });
      toast(`有 ${n} 项需要修正`, "alert");
      return false;
    }
    const g = D.settings.general;
    g.profile.name = draft.name.trim();
    g.profile.email = draft.email.trim();
    g.profile.role = draft.role.trim();
    g.profile.timezone = draft.timezone;
    g.ui.themeMode = draft.themeMode;
    g.ui.density = draft.density;
    g.code.theme = KEY_LABEL[draft.codeTheme];
    g.code.fontSize = Number(draft.fontSize);
    g.code.tabSize = Number(draft.tabSize);
    g.code.wrap = draft.wrap;
    g.sendMode = draft.sendMode;
    g.chat.notifyDone = draft.notifyDone;
    g.chat.restoreLastWindow = draft.restoreLastWindow;
    g.server.port = Number(draft.port);
    g.server.defaultUser = draft.defaultUser.trim();
    g.server.auth = AUTH_LABEL[draft.auth];
    g.dataDir = draft.dataDir.trim();
    D.user.name = g.profile.name;
    D.user.email = g.profile.email;
    D.user.role = g.profile.role;
    saved = { ...draft };
    errors = {};
    applyPreview();
    render();
    toast("设置已保存");
    return true;
  }
  function discard() {
    init();
    draft = { ...saved };
    errors = {};
    restorePreview();
    render();
  }
  function restoreDefaults() {
    init();
    draft = { ...DEFAULTS };
    errors = {};
    applyPreview();
    render();
    toast("已恢复本页默认值，尚未保存", "warn");
  }
  function requestDiscard(after) {
    const n = dirtyKeys().length;
    if (!n) { after && after(); return; }
    afterDiscard = after || null;
    openSubDialog(dlgShell("放弃未保存的更改？", "", `<p>通用页有 ${n} 项更改尚未保存，关闭后不会写入。</p>`,
      `<button class="btn" data-act="close-sub">继续编辑</button><button class="btn danger" data-c91="discard-confirm">放弃并关闭</button>`));
  }
  function confirmDefaults() {
    openSubDialog(dlgShell("恢复本页默认值？", "", "<p>姓名、邮箱、角色、主题、代码样式、会话行为与主机默认值将回到初始值；数据存储位置与头像保留。确认后仍需点击「保存」才写入。</p>",
      `<button class="btn" data-act="close-sub">取消</button><button class="btn danger" data-c91="defaults-confirm">恢复默认</button>`));
  }

  /* ---------- 渲染 ---------- */
  const group = (id, title, ico, tag, body, headExtra = "") => `<section class="c91-group" data-c91-group="${id}" id="c91-g-${id}">
      <header class="c91-group-h"><span class="c91-ico">${icon(ico, "ico-14")}</span><h3>${esc(title)}</h3><span class="c91-head-spacer"></span>${headExtra}${tag ? `<span class="c91-group-tag">${esc(tag)}</span>` : ""}</header>
      <div class="c91-rows">${body}</div>
    </section>`;
  const row = (label, control, extra = "") => `<div class="c91-row"><div class="c91-label"><b>${esc(label)}</b>${extra}</div><div class="c91-control">${control}</div></div>`;
  const seg = (field, options, current) => `<div class="seg" role="radiogroup">${options.map(([v, t]) => `<button type="button" role="radio" aria-checked="${String(current) === String(v)}" data-c91="seg" data-f="${field}" data-v="${v}">${esc(t)}</button>`).join("")}</div>`;
  const toggle = (field, on, label) => `<button type="button" class="switch" role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-c91="toggle" data-f="${field}"></button>`;
  const field = (f, value, attrs) => `<input class="input${attrs?.num ? " c91-num" : ""}${attrs?.short ? " c91-short" : ""}" id="c91-${f}" data-c91-field="${f}" value="${esc(value)}" ${attrs?.type ? `type="${attrs.type}"` : ""} ${attrs?.aria ? `aria-label="${esc(attrs.aria)}"` : ""} ${attrs?.min !== undefined ? `min="${attrs.min}"` : ""} ${attrs?.max !== undefined ? `max="${attrs.max}"` : ""} aria-invalid="${Boolean(errors[f])}" ${attrs?.mono ? 'style="font-family:var(--mono)"' : ""}>`;
  const err = f => errors[f] ? `<p class="c91-err" role="alert">${esc(errors[f])}</p>` : "";

  /* 头像：作为独立字段行，控件只有一个小头像；点击打开既有的「更换头像」弹窗（含 5 种样式与自定义裁剪），应用即生效。 */
  function avatarEntry() {
    const style = store.avatarStyle || "b";
    return `<button type="button" class="c91-avatar-btn" data-act="avatar-edit" aria-haspopup="dialog" aria-label="更换头像（当前风格：${esc(AVATAR_LABELS[style])}）" title="更换头像 · ${esc(AVATAR_LABELS[style])}">
        <span class="c91-av" data-v="${style}">${avatarImg("", store.avatarPhoto || null)}</span>
        <span class="c91-avatar-badge" aria-hidden="true">${icon("camera", "ico-12")}</span>
      </button>`;
  }

  function bodyIdentity() {
    return row("头像", avatarEntry() + `<span class="c91-hint">当前样式 ${esc(AVATAR_LABELS[store.avatarStyle || "b"])}；应用后立即生效，不随本页保存。</span>`)
      + row("显示名称", field("name", draft.name, { aria: "显示名称" }) + err("name"))
      + row("邮箱", field("email", draft.email, { type: "email", aria: "邮箱" }) + err("email"))
      + row("角色", field("role", draft.role, { aria: "角色" }) + err("role"))
      + row("时区", `<select class="select" id="c91-timezone" data-c91-field="timezone" aria-label="时区">${TZ.concat(TZ.includes(draft.timezone) ? [] : [draft.timezone]).map(t => `<option value="${esc(t)}" ${t === draft.timezone ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>` + err("timezone") + `<span class="c91-hint">影响会话时间与记录显示，不改系统时区。</span>`);
  }

  function bodyAppearance() {
    const pre = `<pre class="c91-preview ${codePreviewDark() ? "dark" : "light"}" id="c91-preview" style="font-size:${Math.max(12, Math.min(16, Number(draft.fontSize) || 13))}px;tab-size:${Number(draft.tabSize) === 4 ? 4 : 2};white-space:${draft.wrap ? "pre-wrap" : "pre"}"><span class="tk-k">const</span> booking = <span class="tk-k">await</span> createBooking({
	slotId: <span class="tk-s">"DEMO-SLOT-01"</span>,
	idempotencyKey: <span class="tk-s">"DEMO-REQUEST-01"</span>
});</pre>`;
    return row("界面主题", seg("themeMode", THEME, draft.themeMode) + `<span class="c91-hint">跟随系统时随操作系统深浅色自动切换；选择即时预览。</span>`)
      + row("界面密度", seg("density", DENSITY, draft.density) + `<span class="c91-hint">紧凑会收紧列表与表单行距，不改变字号。</span>`)
      + `<div class="c91-sub-h">代码编辑器</div>`
      + row("代码高亮", seg("codeTheme", CODE_THEME, draft.codeTheme))
      + row("字号 / Tab / 换行",
        `<span class="row" style="gap:8px;align-items:center">${field("fontSize", draft.fontSize, { num: true, type: "number", min: 12, max: 16, aria: "编辑器字号" })}<select class="select" id="c91-tabSize" data-c91-field="tabSize" aria-label="Tab 宽度" style="min-width:88px;max-width:88px"><option value="2" ${draft.tabSize === "2" ? "selected" : ""}>2 空格</option><option value="4" ${draft.tabSize === "4" ? "selected" : ""}>4 空格</option></select>${toggle("wrap", draft.wrap, "自动换行")}<span class="c91-inline-note">自动换行</span></span>` + err("fontSize") + err("tabSize"))
      + row("预览", pre);
  }

  function bodyBehavior() {
    return row("生成中再次发送", seg("sendMode", SEND, draft.sendMode) + `<span class="c91-hint">立即发送会打断当前生成；排队等当前回合结束后再发。</span>`)
      + row("完成后通知", toggle("notifyDone", draft.notifyDone, "完成后通知") + `<span class="c91-hint">偏好已保存；提示通道尚未接入，当前不会弹出系统通知。</span>`)
      + row("启动时恢复窗口", toggle("restoreLastWindow", draft.restoreLastWindow, "启动时恢复窗口") + `<span class="c91-hint">偏好已保存；启动恢复逻辑尚未接入，当前启动固定打开工作台。</span>`);
  }

  function bodyHost() {
    return row("默认端口 / 用户",
      `<span class="row" style="gap:8px;align-items:center">${field("port", draft.port, { num: true, type: "number", min: 1, max: 65535, aria: "默认端口" })}${field("defaultUser", draft.defaultUser, { short: true, aria: "默认用户" })}</span>` + err("port") + err("defaultUser") + `<span class="c91-hint">只作为新建主机表单的初始值，不发起连接、不覆盖已有主机。</span>`)
      + row("默认认证", `<select class="select" id="c91-auth" data-c91-field="auth" aria-label="默认认证">${AUTH.map(([v, t]) => `<option value="${v}" ${draft.auth === v ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>` + err("auth") + (draft.auth === "jump" ? `<span class="c91-hint">跳板机执行通道尚未接入，选择后新建表单会要求补充跳板配置。</span>` : ""))
      + row("高风险命令确认",
        `<span class="c91-inline-note">${icon("lock", "ico-14")}由执行层逐次确认，属强制安全策略，不能在此关闭</span>`);
  }

  const dirJoin = (base, name) => {
    const b = String(base || "安装目录/data").replace(/[\\/]+$/, "");
    return /\\/.test(b) ? `${b}\\${name}` : `${b}/${name}`;
  };

  function bodyStorage() {
    const changed = draft.dataDir !== saved.dataDir;
    const usage = [["db", "数据库与会话", "42.6 MB", 4], ["chat", "会话文件", "128 MB", 10], ["knowledge", "知识库", "1.24 GB", 62], ["secrets", "密钥引用", "18 KB", 1]];
    return row("数据存储位置",
      `<span class="row" style="gap:8px;align-items:center;width:100%">${field("dataDir", draft.dataDir, { aria: "数据存储位置", mono: true })}<button type="button" class="btn" data-c91="pick-dir">选择目录</button><button type="button" class="btn" data-c91="open-dir">复制路径</button></span>` + err("dataDir")
      + `<span class="c91-hint">${changed ? "已改为新位置：保存并重启后迁移生效，旧目录保留不删除。" : "默认位于安装目录下的 data；其下按 db、chat、knowledge、skills、secrets、logs、recycle 等分类存放。"}</span>`)
      + row("位置分类", `<span class="c91-dirs">${["db", "chat", "knowledge", "skills", "mcp", "secrets", "avatar", "logs", "recycle", "index", "examples"].map(d => `<span class="c91-dir">${d}</span>`).join("")}</span><span class="c91-hint">各分类位于上述数据目录下；占用统计待接入，可打开目录自行查看。</span>`)
      + row("知识库目录",
        `<span class="row" style="gap:8px;align-items:center;width:100%"><input class="input" id="c91-kbdir" value="${esc(dirJoin(draft.dataDir, "knowledge"))}" readonly aria-label="知识库目录" style="font-family:var(--mono)"><button type="button" class="btn" data-c91="copy-kbdir">复制路径</button></span><span class="c91-hint">可直接把文件拷进该文件夹，刷新后进入索引；不在此处修改。</span>`);
  }

  function bodyAbout() {
    return row("版本",
      `<span class="c91-about"><span class="c91-version">v${esc(APP_VERSION)}</span><span class="c91-about-meta">稳定版 · 本机安装</span><button type="button" class="btn sm" data-c91="check-update">${icon("refresh", "ico-14")}检查更新</button></span>`)
      + row("日志目录",
        `<span class="row" style="gap:8px;align-items:center;width:100%"><input class="input" id="c91-logdir" value="${esc(dirJoin(draft.dataDir, "logs"))}" readonly aria-label="日志目录" style="font-family:var(--mono)"><button type="button" class="btn" data-c91="open-log">打开</button></span><span class="c91-hint">诊断或反馈问题时附上该目录内的最近日志。</span>`)
      + row("本页设置",
        `<span class="row" style="gap:8px;align-items:center"><button type="button" class="btn" data-c91="defaults">恢复本页默认值</button></span><span class="c91-hint">只影响通用页；恢复后仍需点击保存才写入。</span>`);
  }

  function content(tab) {
    if (tab && tab !== "general") return null;
    init();
    const changed = draft.dataDir !== saved.dataDir;
    return `<div class="c91">
      <div class="c91-bar">
        <div class="c91-jump" role="navigation" aria-label="通用设置分组">${GROUPS.map(([id, full, short]) => `<button type="button" data-c91="jump" data-to="${id}" aria-current="false" aria-label="跳转到${esc(full)}">${esc(short)}</button>`).join("")}</div>
        <span class="c91-spacer"></span>
        <span class="c91-dirty" data-c91-clean="${dirtyKeys().length === 0}">${dirtyKeys().length ? `${dirtyKeys().length} 项未保存` : "已保存"}</span>
        <button type="button" class="btn" data-c91="discard" ${dirtyKeys().length ? "" : "disabled"}>放弃</button>
        <button type="button" class="btn primary" data-c91="save" ${dirtyKeys().length ? "" : "disabled"}>保存</button>
      </div>
      ${group("identity", "个人资料", "user", "仅用于显示", bodyIdentity())}
      ${group("appearance", "外观与显示", "palette", "", bodyAppearance())}
      ${group("behavior", "会话与行为", "sliders", "", bodyBehavior())}
      ${group("host", "新建主机默认值", "server", "不影响已建主机", bodyHost())}
      ${group("storage", "数据与存储", "database", changed ? "重启后生效" : "", bodyStorage())}
      ${group("about", "关于", "info", `v${APP_VERSION}`, bodyAbout())}
    </div>`;
  }

  function render() {
    const body = document.querySelector(".set-scroll");
    if (!body || store.settingsTab !== "general") return;
    const scroll = body.scrollTop;
    body.innerHTML = content("general");
    body.scrollTop = scroll;
    syncJump();
  }
  function syncJump() {
    const body = document.querySelector(".set-scroll");
    if (!body) return;
    const limit = body.getBoundingClientRect().top + 64;
    let active = "identity";
    body.querySelectorAll(".c91-group").forEach(g => { if (g.getBoundingClientRect().top <= limit) active = g.dataset.c91Group; });
    document.querySelectorAll(".c91-jump button").forEach(b => b.setAttribute("aria-current", String(b.dataset.to === active)));
  }

  /* ---------- 交互 ---------- */
  function setField(f, value) {
    init();
    draft[f] = value;
    delete errors[f];
    const wrap = document.querySelector(`[data-c91-field="${f}"]`);
    if (wrap) wrap.setAttribute("aria-invalid", "false");
    document.querySelectorAll(`[data-c91-field="${f}"]`).forEach(n => n.setAttribute("aria-invalid", "false"));
    syncPreviewChrome();
  }

  document.addEventListener("input", e => {
    const el = e.target.closest("[data-c91-field]");
    if (!el || !document.querySelector(".c91")) return;
    setField(el.dataset.c91Field, el.value);
  }, true);
  document.addEventListener("change", e => {
    const el = e.target.closest("[data-c91-field]");
    if (el && document.querySelector(".c91")) setField(el.dataset.c91Field, el.value);
  }, true);

  document.addEventListener("click", e => {
    const inSettings = document.querySelector("dialog.settings-dialog") && store.settingsTab === "general";
    const closing = e.target.closest('[data-act="close-dialog"]') || e.target.id === "dialog";
    if (inSettings && closing && dirtyKeys().length) {
      e.preventDefault(); e.stopImmediatePropagation();
      requestDiscard(() => closeDialog());
      return;
    }
    const el = e.target.closest("[data-c91]");
    if (!el || !document.querySelector(".c91")) return;
    const a = el.dataset.c91;
    if (a === "jump") {
      e.preventDefault(); e.stopImmediatePropagation();
      document.getElementById(`c91-g-${el.dataset.to}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
      return;
    }
    e.preventDefault(); e.stopImmediatePropagation();
    init();
    if (a === "seg") { draft[el.dataset.f] = el.dataset.v; delete errors[el.dataset.f]; applyPreview(); render(); return; }
    if (a === "toggle") { draft[el.dataset.f] = !draft[el.dataset.f]; render(); return; }
    if (a === "avatar-open") { openAvatarPop(); return; }
    if (a === "save") { save(); return; }
    if (a === "discard") { discard(); return; }
    if (a === "defaults") { confirmDefaults(); return; }
    if (a === "defaults-confirm") { closeSubDialog(); restoreDefaults(); return; }
    if (a === "discard-confirm") {
      closeSubDialog(); draft = { ...saved }; errors = {}; restorePreview(); render();
      const next = afterDiscard; afterDiscard = null; next && next();
      return;
    }
    if (a === "pick-dir") { draft.dataDir = "D:\\NestCraft-data"; errors.dataDir && delete errors.dataDir; render(); toast("演示：已选择目录；保存并重启后迁移生效", "warn"); return; }
    if (a === "open-dir" || a === "open-log") { toast("演示：路径已复制", "warn"); return; }
    if (a === "copy-kbdir") { toast("演示：路径已复制", "warn"); return; }
    if (a === "check-update") { toast("演示：当前 v0.0.5 已是最新版本", "warn"); return; }
  }, true);

  document.addEventListener("scroll", e => {
    if (e.target && e.target.classList && e.target.classList.contains("set-scroll")) syncJump();
  }, true);

  const helpDialog = () => document.getElementById("dialog");
  helpDialog()?.addEventListener("cancel", e => {
    if (!document.querySelector("dialog.settings-dialog") || store.settingsTab !== "general" || !dirtyKeys().length) return;
    e.preventDefault();
    requestDiscard(() => closeDialog());
  });

  /* 设置关闭后重置草稿（下次打开重新读取），并保留「已保存」基线。 */
  const oldRefresh = Screens.refreshSettings;
  Screens.refreshSettings = () => {
    const body = document.querySelector(".set-scroll");
    if (!body || store.settingsTab !== "general") return oldRefresh();
    const scroll = body.scrollTop;
    const active = document.activeElement, id = active?.id || null;
    const start = active?.selectionStart, end = active?.selectionEnd;
    body.innerHTML = content("general");
    body.scrollTop = scroll;
    const next = id && document.getElementById(id);
    if (next) { next.focus({ preventScroll: true }); if (typeof start === "number" && next.setSelectionRange) next.setSelectionRange(start, end); }
    syncJump();
  };

  ensureData();
  const param = new URLSearchParams(location.search).get("settings");
  if (param === "general") setTimeout(() => { render(); }, 0);

  return {
    version: VERSION,
    content,
    render,
    save,
    discard,
    restoreDefaults,
    dirty: () => dirtyKeys(),
    state: () => ({ draft: { ...draft }, saved: { ...saved }, errors: { ...errors } }),
    reset: () => { draft = null; saved = null; errors = {}; },
  };
})();