/* CR-075：服务器列表、主机表单与自动连接工作台（仅设计资源）。
   - 系统标识取连接后检测到的 OS，由 os-logos/ 官方标识渲染；用户不可选择、不可配置。
   - 列表不提供连接/断开；打开工作台自动连接，关闭工作台页签自动断开。
   - 新增/编辑弹窗按内容高度呈现，提供测试连接；不写说明性长文案。
   依赖：core.js（UI）、screens-more.js（Screens）、data.js（D）。 */
(function () {
  "use strict";
  const UI = window.UI;
  const { D, esc, icon, store, toast, openDialog, openWindow, dlgShell, closeDialog, render } = UI;
  const Screens = window.Screens || (window.Screens = {});

  /* ---------------- 官方系统标识 ---------------- */
  const OS_DEFS = [
    { id: "ubuntu", re: /ubuntu/i, label: "Ubuntu", file: "ubuntu.svg" },
    { id: "debian", re: /debian/i, label: "Debian", file: "debian.svg" },
    { id: "centos", re: /centos/i, label: "CentOS", file: "centos.svg" },
    { id: "rocky", re: /rocky/i, label: "Rocky Linux", file: "rockylinux.svg" },
    { id: "alma", re: /alma/i, label: "AlmaLinux", file: "almalinux.svg" },
    { id: "fedora", re: /fedora/i, label: "Fedora", file: "fedora.svg" },
    { id: "arch", re: /arch\s*linux|\barch\b/i, label: "Arch Linux", file: "archlinux.svg" },
    { id: "opensuse", re: /open\s*suse|\bsuse\b|\bsles\b/i, label: "openSUSE", file: "opensuse.svg" },
    { id: "alpine", re: /alpine/i, label: "Alpine Linux", file: "alpinelinux.svg" },
    { id: "amazon", re: /amazon/i, label: "Amazon Linux", file: "amazon.svg" },
    { id: "oracle", re: /oracle/i, label: "Oracle Linux", file: "oracle.svg" },
    { id: "redhat", re: /red\s*hat|\brhel\b/i, label: "Red Hat", file: "redhat.svg" },
    { id: "freebsd", re: /freebsd/i, label: "FreeBSD", file: "freebsd.svg" },
    { id: "windows", re: /windows/i, label: "Windows", file: "windows.svg" },
    { id: "macos", re: /mac\s*os|macos|darwin|os\s*x/i, label: "macOS", file: "apple.svg" },
    { id: "linux", re: /linux/i, label: "Linux", file: "linux.svg" },
  ];

  function osMeta(os) {
    const text = String(os || "");
    if (!text || text === "未知" || text === "系统未知") return null;
    return OS_DEFS.find((d) => d.re.test(text)) || null;
  }
  function osTile(os, cls) {
    const meta = osMeta(os);
    const size = cls || "";
    if (!meta) {
      return `<span class="c075-os-tile ${size}" title="系统未知" aria-label="系统未知">${icon("server", "ico-18")}</span>`;
    }
    return `<span class="c075-os-tile ${size}" title="${esc(meta.label)}"><img src="os-logos/${meta.file}" alt="${esc(meta.label)} 标识"></span>`;
  }
  function tabIcon(id) {
    const s = D.servers.find((x) => x.id === id);
    const meta = s && osMeta(s.os);
    if (!meta) return icon("server", "ico-14");
    return `<img class="c075-tab-os" src="os-logos/${meta.file}" alt="">`;
  }

  /* ---------------- 工具 ---------------- */
  const hostAddr = (s) => {
    const raw = String(s.host || "");
    const at = raw.indexOf("@");
    const user = at >= 0 ? raw.slice(0, at) : s.username || "ops";
    const host = at >= 0 ? raw.slice(at + 1) : raw;
    return `${user}@${host}:${s.port || 22}`;
  };
  const pct = (v) => (v == null || Number.isNaN(Number(v)) ? null : Math.round(Number(v)));
  function metrics(s) {
    const cpu = s.cpu && s.cpu.length ? pct(s.cpu.reduce((a, b) => a + b, 0) / s.cpu.length) : null;
    const mem = s.mem && s.mem.total ? pct((s.mem.used / s.mem.total) * 100) : null;
    const disk = s.disk && s.disk.total ? pct((s.disk.used / s.disk.total) * 100) : null;
    return { cpu, mem, disk };
  }
  const lastText = (s) => (s.last && s.last !== "从未" ? `上次采样 ${esc(s.last)}` : "未采样");
  const failReason = (host) => {
    const h = String(host || "");
    if (/198\.51\.100\./.test(h)) return "连接超时";
    if (/invalid|bad|timeout/i.test(h)) return "无法解析主机";
    return null;
  };
  const looksReachable = (host) => !failReason(host);

  /* ---------------- 列表页 ---------------- */
  function serversPage() {
    const forced = new URLSearchParams(location.search).get("c075");
    const hosts = D.servers || [];
    const head = `<div class="page-h c075-head"><div class="titles"><h1 class="page-title">服务器管理</h1></div>
      <div class="c075-head-actions"><span class="c075-count">${hosts.length} 台</span>
      <button class="btn primary" type="button" data-c075="add">${icon("plus", "ico-14")}添加主机</button></div></div>`;

    if (forced === "loading") {
      return `<div class="page">${head}<div class="c075-grid">${[0, 1, 2].map(() => '<div class="c075-skel"></div>').join("")}</div></div>`;
    }
    if (forced === "error") {
      return `<div class="page">${head}<div class="empty"><div class="e-icon">${icon("alert", "ico-20")}</div><b>服务器列表读取失败</b><p>连接本机数据服务超时</p><button class="btn" type="button" data-c075="retry-list">重试</button></div></div>`;
    }
    if (!hosts.length || forced === "empty") {
      return `<div class="page">${head}<div class="empty"><div class="e-icon">${icon("server", "ico-20")}</div><b>还没有服务器</b><button class="btn primary" type="button" data-c075="add">${icon("plus", "ico-14")}添加主机</button></div></div>`;
    }

    return `<div class="page">${head}
      <div class="c075-grid">${hosts.map(hostCard).join("")}</div>
    </div>`;
  }

  function hostCard(s) {
    const m = metrics(s);
    const group = s.group || s.groupTag || "";
    return `<article class="c075-host" role="button" tabindex="0" data-c075-open="${esc(s.id)}" aria-label="进入 ${esc(s.name)} 工作台">
      <div class="c075-host-top">
        ${osTile(s.os)}
        <div class="c075-host-id">
          <div class="c075-host-name"><b>${esc(s.name)}</b>${group ? `<span class="tag gray">${esc(group)}</span>` : ""}</div>
          <div class="c075-host-addr">${esc(hostAddr(s))}</div>
        </div>
        <div class="c075-host-acts">
          <button class="icon-btn" type="button" data-c075="edit" data-id="${esc(s.id)}" title="编辑" aria-label="编辑 ${esc(s.name)}">${icon("pen", "ico-14")}</button>
          <button class="icon-btn" type="button" data-c075="del" data-id="${esc(s.id)}" title="删除" aria-label="删除 ${esc(s.name)}">${icon("trash", "ico-14")}</button>
        </div>
      </div>
      <div class="c075-host-stats">
        <div><span>CPU</span><b>${m.cpu == null ? "—" : m.cpu + "%"}</b></div>
        <div><span>内存</span><b>${m.mem == null ? "—" : m.mem + "%"}</b></div>
        <div><span>磁盘</span><b>${m.disk == null ? "—" : m.disk + "%"}</b></div>
      </div>
      <div class="c075-host-foot"><span>${esc(s.os || "系统未知")}</span><span>${lastText(s)}</span></div>
    </article>`;
  }

  /* ---------------- 自动连接 ---------------- */
  function connOf(id) {
    store.c075Conn = store.c075Conn || {};
    return store.c075Conn[id] || null;
  }
  function scheduleConnect(id, delay) {
    window.setTimeout(() => {
      const alive = store.windows.some((w) => w.id === `server:${id}`);
      if (!alive) { delete store.c075Conn[id]; return; }
      const s = D.servers.find((x) => x.id === id);
      const c = store.c075Conn[id];
      if (!c || c.phase !== "connecting") return;
      if (!s) { c.phase = "fail"; c.reason = "主机已删除"; }
      else if (s.status === "offline" || !looksReachable(s.host)) { c.phase = "fail"; c.reason = failReason(s.host) || "连接超时"; s.connected = false; }
      else {
        c.phase = "connected";
        s.connected = true;
        s.last = "刚刚";
        if (!s.os || s.os === "未知") s.os = guessOs({ name: s.name, host: s.host });
      }
      render();
    }, delay || 850);
  }
  function beginConnect(id, delay) {
    store.c075Conn = store.c075Conn || {};
    if (store.c075Conn[id]) return;
    store.c075Conn[id] = { phase: "connecting" };
    scheduleConnect(id, delay);
  }
  function retryConnect(id) {
    store.c075Conn = store.c075Conn || {};
    store.c075Conn[id] = { phase: "connecting" };
    render();
    scheduleConnect(id, 900);
  }

  /* 关闭工作台页签即断开；切换页签不断开（页签仍打开）。 */
  const baseCloseWindow = UI.closeWindow;
  UI.closeWindow = function (id) {
    if (typeof id === "string" && id.startsWith("server:")) {
      const sid = id.slice("server:".length);
      if (store.c075Conn) delete store.c075Conn[sid];
      const s = D.servers.find((x) => x.id === sid);
      if (s) s.connected = false;
    }
    return baseCloseWindow.apply(UI, arguments);
  };

  /* ---------------- 工作台 ---------------- */
  function serverPage(id) {
    const s = D.servers.find((x) => x.id === id) || D.servers[0];
    if (!s) return `<div class="empty"><b>主机不存在</b></div>`;
    const c = connOf(s.id);
    if (!c) beginConnect(s.id, 850);
    const phase = c ? c.phase : "connecting";
    const connLabel = phase === "connected" ? "已连接" : phase === "fail" ? "连接失败" : "正在连接";
    const connCls = phase === "connected" ? "ok" : phase === "fail" ? "fail" : "connecting";
    const state = phase === "connected" ? "" : `<span class="c075-spin" aria-hidden="true"></span>`;

    return `<div class="c075-wb">
      <header class="c075-wb-head">
        ${osTile(s.os, "sm")}
        <b>${esc(s.name)}</b>
        <span class="c075-wb-addr">${esc(hostAddr(s))}</span>
        <span class="spacer"></span>
        <span class="c075-conn ${connCls}">${state}${connLabel}${phase === "connected" ? `<span class="caption"> · ${esc(s.os || "系统未知")}</span>` : ""}</span>
      </header>
      <div class="srv-shell c075-shell">
        <aside class="srv-files">
          <div class="srv-files-h"><span>${icon("folder", "ico-14")}文件</span><button class="icon-btn" type="button" data-c075="file-hint" title="刷新">${icon("refresh", "ico-14")}</button></div>
          <div class="srv-path">${esc(s.host || "")} <span class="caption">›</span> /home/${esc((s.host || "").split("@")[0] || "ops")}</div>
          ${phase === "connected" ? `<div class="srv-tree">${(s.files || []).map((f) => `<button class="srv-file" type="button" data-c075="file-hint">${icon("folder", "ico-14")}${esc(f)}</button>`).join("") || `<div class="c075-pane-state">暂无文件</div>`}</div>` : `<div class="c075-pane-state">${phase === "fail" ? "未连接" : "等待连接"}</div>`}
        </aside>
        <section class="srv-term">
          <div class="srv-term-h"><span class="tab on">${icon("terminal", "ico-14")}shell 1</span></div>
          ${phase === "connected" ? terminalBody(s) : `<div class="c075-term-state">${phase === "connecting" ? `<span class="c075-spin lg" aria-hidden="true"></span><b>正在连接</b><span class="c075-state-sub">${esc(hostAddr(s))}</span>` : `<b>连接失败</b><span class="c075-state-sub">${esc((c && c.reason) || "无法建立连接")}</span><button class="btn sm" type="button" data-c075="retry" data-id="${esc(s.id)}">重试</button>`}</div>`}
        </section>
        <aside class="srv-monitor">
          <div class="mon-h"><b>实时监控</b><span>${phase === "connected" ? "每 5 秒刷新" : ""}</span></div>
          ${phase === "connected" ? monitorBody(s) : `<div class="c075-mon-state">${phase === "fail" ? "无数据" : "等待连接"}</div>`}
        </aside>
      </div>
    </div>`;
  }

  function terminalBody(s) {
    const lines = store.termLog && store.termServer === s.id ? store.termLog : (D.terminal[s.id] || []).map((h) => ({ cmd: h.cmd, out: h.out }));
    const user = (s.host || "").split("@")[0] || "ops";
    const host = (s.host || "").split("@").pop() || "";
    return `<div class="term-body" id="term-body">${lines.length ? lines.map((l) => `<div class="cmd">${esc(l.cmd)}</div><div class="out">${esc(l.out)}</div>`).join("") : `<div class="hint">输入 help 查看可用命令。</div>`}</div>
      <form class="term-input" data-act="term-submit" data-id="${esc(s.id)}"><span class="p">${esc(user)}@${esc(host)}:~$</span><input id="term-input" autocomplete="off" spellcheck="false" placeholder="输入命令"></form>`;
  }

  function monitorBody(s) {
    const m = metrics(s);
    const cpu = m.cpu == null ? null : m.cpu;
    const mem = s.mem;
    const disk = s.disk;
    const cores = Array.isArray(s.cpu) && s.cpu.length ? s.cpu : [0, 0, 0, 0, 0, 0, 0, 0];
    return `<div class="mon-host"><div class="row between"><b>${esc(s.name)}</b><span class="status green">已连接</span></div>
        <div class="mon-kv"><span>系统</span><b>${esc(s.os || "系统未知")}</b></div>
        <div class="mon-kv"><span>地址</span><b class="mono">${esc(hostAddr(s))}</b></div>
        <div class="mon-kv"><span>运行时长</span><b>${esc(s.uptime || "—")}</b></div></div>
      <div class="mon-block"><div class="row between"><span>CPU 使用率</span><b>${cpu == null ? "—" : cpu + "%"}</b></div>
        <svg class="spark" viewBox="0 0 200 40" preserveAspectRatio="none" aria-hidden="true"><polyline points="${cpu == null ? "0,20 200,20" : "0,32 20,28 40,30 60,18 80,22 100,14 120,20 140,10 160,16 180,12 200,18"}" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
        <div class="core-grid">${cores.map((v) => `<span class="core"><i style="height:${Math.max(6, Math.min(100, Number(v) || 8))}%"></i></span>`).join("")}</div>
        <div class="caption">每核心占用</div></div>
      <div class="mon-block"><div class="row between"><span>内存</span><b>${mem ? `${mem.used.toFixed(1)} / ${mem.total} GB` : "—"}</b></div><div class="bar"><i style="width:${m.mem == null ? 0 : m.mem}%"></i></div></div>
      <div class="mon-block"><div class="row between"><span>磁盘</span><b>${disk ? `${disk.used} / ${disk.total} GB` : "—"}</b></div><div class="bar amber"><i style="width:${m.disk == null ? 0 : m.disk}%"></i></div></div>
      <div class="mon-block"><div class="row between"><span>负载</span><b>${s.load && s.load.length ? s.load.join(" / ") : "—"}</b></div><div class="caption">1 / 5 / 15 分钟</div></div>`;
  }

  /* ---------------- 主机表单 ---------------- */
  function emptyDraft() {
    return { id: "", name: "", host: "", port: "22", username: "ops", group: "", authType: "password", originalAuth: "password", password: "", keyPath: "", passphrase: "", os: "", test: null, errors: {}, editing: false, hasSecret: false };
  }
  function draftFromHost(h) {
    const raw = String(h.host || "");
    const at = raw.indexOf("@");
    return {
      id: h.id,
      name: h.name || "",
      host: at >= 0 ? raw.slice(at + 1) : raw,
      port: String(h.port || 22),
      username: at >= 0 ? raw.slice(0, at) : h.username || "ops",
      group: h.group || h.groupTag || "",
      authType: h.authType || "password",
      originalAuth: h.authType || "password",
      password: "",
      keyPath: "",
      passphrase: "",
      os: h.os && h.os !== "未知" ? h.os : "",
      test: null,
      errors: {},
      editing: true,
      hasSecret: true,
    };
  }
  function openHostDialog(h) {
    const draft = h ? draftFromHost(h) : emptyDraft();
    renderHostDialog(draft, h ? "" : "c075-name");
  }
  function renderHostDialog(draft, focusId) {
    openDialog(hostDialogHtml(draft), "c075-dialog");
    if (focusId) window.setTimeout(() => { const el = document.getElementById(focusId); if (el) el.focus(); }, 0);
  }

  function hostDialogHtml(d) {
    const t = d.test;
    const testBtn = t && t.phase === "testing"
      ? `<button class="btn" type="button" disabled><span class="c075-spin" aria-hidden="true"></span>测试中…</button>`
      : `<button class="btn" id="c075-test" type="button" data-c075="test">测试连接</button>`;
    const testResult = !t ? ""
      : t.phase === "testing" ? `<span class="c075-test-result"><span class="c075-spin" aria-hidden="true"></span>正在连接</span>`
      : t.phase === "ok" ? `<span class="c075-test-result ok">${icon("checkCircle", "ico-14")}连接成功 · ${esc(t.os)}</span>`
      : `<span class="c075-test-result fail">${icon("alert", "ico-14")}${esc(t.msg || "连接失败")}</span>`;

    const field = (key, label, control, extra) => `<div class="c075-field ${d.errors[key] ? "invalid" : ""}" ${extra || ""}>
      <label class="c075-label" for="c075-${key}">${label}</label>${control}
      <span class="c075-err" data-c075-err="${key}">${esc(d.errors[key] || "")}</span></div>`;
    const input = (key, attrs) => `<input class="input ${d.errors[key] ? "invalid" : ""}" id="c075-${key}" ${attrs || ""} value="${esc(d[key] == null ? "" : d[key])}">`;

    const authPanel = d.authType === "password"
      ? field("password", "密码", `<input class="input ${d.errors.password ? "invalid" : ""}" id="c075-password" type="password" autocomplete="new-password" value="${esc(d.password || "")}" placeholder="${d.hasSecret ? "已保存，留空不修改" : "登录密码"}">`)
      : d.authType === "key"
        ? `<div class="c075-field ${d.errors.keyPath ? "invalid" : ""}"><label class="c075-label" for="c075-keyPath">私钥路径</label>
            <input class="input mono ${d.errors.keyPath ? "invalid" : ""}" id="c075-keyPath" value="${esc(d.keyPath || "")}" placeholder="${d.hasSecret ? "已保存，留空不修改" : "~/.ssh/id_ed25519"}">
            <span class="c075-err" data-c075-err="keyPath">${esc(d.errors.keyPath || "")}</span></div>
          <div class="c075-field"><label class="c075-label" for="c075-passphrase">私钥口令（可选）</label>
            <input class="input" id="c075-passphrase" type="password" autocomplete="new-password" value="${esc(d.passphrase || "")}" placeholder="可留空"></div>`
        : "";

    return dlgShell(d.editing ? "编辑主机" : "新建主机", "", `<div class="c075-form">
      ${field("name", "名称", input("name", `placeholder="如 生产-web-01"`))}
      <div class="c075-row host">
        ${field("host", "主机地址", `<input class="input mono ${d.errors.host ? "invalid" : ""}" id="c075-host" value="${esc(d.host || "")}" placeholder="192.0.2.10 或 example.com">`)}
        ${field("port", "端口", `<input class="input ${d.errors.port ? "invalid" : ""}" id="c075-port" inputmode="numeric" value="${esc(d.port || "")}">`)}
      </div>
      <div class="c075-row">
        ${field("username", "用户名", `<input class="input ${d.errors.username ? "invalid" : ""}" id="c075-username" value="${esc(d.username || "")}" placeholder="root">`)}
        ${field("group", "分组（可选）", `<input class="input" id="c075-group" value="${esc(d.group || "")}" placeholder="如 生产环境">`)}
      </div>
      <div class="c075-field">
        <span class="c075-label">认证方式</span>
        <div class="c075-seg" role="group" aria-label="认证方式">
          <button type="button" id="c075-auth-password" data-c075="auth" data-auth="password" aria-pressed="${d.authType === "password"}">密码</button>
          <button type="button" id="c075-auth-key" data-c075="auth" data-auth="key" aria-pressed="${d.authType === "key"}">私钥</button>
          <button type="button" id="c075-auth-none" data-c075="auth" data-auth="none" aria-pressed="${d.authType === "none"}">免认证</button>
        </div>
      </div>
      ${authPanel}
    </div>`, `<div class="c075-test">${testBtn}${testResult}</div>
      <button class="btn" type="button" data-act="close-dialog">取消</button>
      <button class="btn primary" type="button" data-c075="save">保存</button>`, "c075-dialog");
  }

  function readForm(d) {
    const val = (id) => { const el = document.getElementById(id); return el ? el.value : ""; };
    d.name = val("c075-name");
    d.host = val("c075-host");
    d.port = val("c075-port");
    d.username = val("c075-username");
    d.group = val("c075-group");
    if (d.authType === "password") d.password = val("c075-password");
    if (d.authType === "key") { d.keyPath = val("c075-keyPath"); d.passphrase = val("c075-passphrase"); }
    return d;
  }
  function validate(d, forTest) {
    const errors = {};
    if (!forTest && !String(d.name || "").trim()) errors.name = "请填写名称";
    if (!String(d.host || "").trim()) errors.host = "请填写主机地址";
    const p = Number(d.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errors.port = "端口需为 1–65535";
    if (!String(d.username || "").trim()) errors.username = "请填写用户名";
    const authChanged = !d.editing || d.authType !== d.originalAuth;
    if (d.authType === "password" && authChanged && !String(d.password || "")) errors.password = "请填写密码";
    if (d.authType === "key" && authChanged && !String(d.keyPath || "").trim()) errors.keyPath = "请填写私钥路径";
    return errors;
  }
  function guessOs(d) {
    const text = `${d.name || ""} ${d.host || ""}`.toLowerCase();
    if (/debian|ci\b/.test(text)) return "Debian 12";
    if (/centos/.test(text)) return "CentOS Stream 9";
    if (/windows/.test(text)) return "Windows Server 2022";
    if (/alpine/.test(text)) return "Alpine Linux 3.20";
    return "Ubuntu 24.04 LTS";
  }

  function runTest(d) {
    readForm(d);
    const errors = validate(d, true);
    if (Object.keys(errors).length) { d.errors = errors; d.test = null; renderHostDialog(d, "c075-test"); return; }
    d.errors = {};
    d.test = { phase: "testing" };
    renderHostDialog(d, "c075-test");
    window.setTimeout(() => {
      const reason = failReason(d.host);
      if (reason) d.test = { phase: "fail", msg: `连接失败：${reason}` };
      else {
        const os = d.os || guessOs(d);
        d.os = os;
        d.test = { phase: "ok", os };
      }
      renderHostDialog(d, "c075-test");
    }, 850);
  }

  function saveHost(d) {
    readForm(d);
    const errors = validate(d, false);
    if (Object.keys(errors).length) { d.errors = errors; renderHostDialog(d, "c075-test"); return; }
    const hostOnly = String(d.host).includes("@") ? String(d.host).split("@").pop() : String(d.host).trim();
    const host = `${String(d.username).trim()}@${hostOnly}`;
    const os = d.test && d.test.phase === "ok" ? d.test.os : d.os || "";
    if (d.editing) {
      const s = D.servers.find((x) => x.id === d.id);
      if (!s) { toast("主机已不存在", "err"); return; }
      Object.assign(s, {
        name: String(d.name).trim(),
        host,
        username: String(d.username).trim(),
        port: Number(d.port),
        group: String(d.group || "").trim(),
        authType: d.authType,
        os: os || s.os || "",
      });
      closeDialog();
      render();
      toast(`已保存 ${s.name}`);
      return;
    }
    const id = "SRV-" + String(D.servers.length + 1).padStart(2, "0");
    D.servers.push({
      id,
      name: String(d.name).trim(),
      host,
      username: String(d.username).trim(),
      port: Number(d.port),
      group: String(d.group || "").trim(),
      authType: d.authType,
      os,
      status: looksReachable(d.host) ? "online" : "offline",
      connected: false,
      uptime: "—",
      last: "从未",
      cpu: [],
      mem: null,
      disk: null,
      load: [],
      files: [],
    });
    closeDialog();
    render();
    toast(`已添加主机 ${String(d.name).trim()}`);
  }

  /* ---------------- 事件 ---------------- */
  function findHost(id) { return D.servers.find((x) => x.id === id); }

  function onAction(act, el) {
    if (act === "add") { openHostDialog(null); return; }
    if (act === "edit") { const h = findHost(el.dataset.id); if (h) openHostDialog(h); return; }
    if (act === "del") {
      const h = findHost(el.dataset.id);
      if (!h) return;
      openDialog(dlgShell("删除主机", h.name, "<p>删除后不可恢复。</p>",
        `<button class="btn" type="button" data-act="close-dialog">取消</button><button class="btn danger" type="button" data-c075="del-ok" data-id="${esc(h.id)}">删除</button>`, "modal-sm"));
      return;
    }
    if (act === "del-ok") {
      const h = findHost(el.dataset.id);
      if (!h) return;
      D.servers.splice(D.servers.indexOf(h), 1);
      if (store.c075Conn) delete store.c075Conn[h.id];
      closeDialog();
      render();
      toast(`已删除 ${h.name}`);
      return;
    }
    if (act === "save") {
      const d = el.__c075Draft;
      const draft = d || activeDraft;
      if (draft) saveHost(draft);
      return;
    }
    if (act === "test") {
      if (activeDraft) runTest(activeDraft);
      return;
    }
    if (act === "auth") {
      if (!activeDraft) return;
      readForm(activeDraft);
      activeDraft.authType = el.dataset.auth;
      activeDraft.errors = {};
      activeDraft.test = null;
      renderHostDialog(activeDraft, `c075-auth-${el.dataset.auth}`);
      return;
    }
    if (act === "retry") { retryConnect(el.dataset.id); return; }
    if (act === "retry-list") { render(); return; }
    if (act === "file-hint") { toast("演示：文件树交互保持既有规则"); return; }
  }

  /* 当前弹窗草稿：由重绘时绑定，保证测试/保存读取同一份值。 */
  let activeDraft = null;
  const baseRenderHost = renderHostDialog;
  renderHostDialog = function (draft, focusId) {
    activeDraft = draft;
    baseRenderHost(draft, focusId);
  };

  document.addEventListener("click", (e) => {
    const actEl = e.target.closest("[data-c075]");
    if (actEl) {
      e.preventDefault();
      e.stopPropagation();
      onAction(actEl.dataset.c075, actEl);
      return;
    }
    if (e.target.closest(".c075-host-acts")) return;
    const card = e.target.closest("[data-c075-open]");
    if (card) {
      const h = findHost(card.dataset.c075Open);
      if (h) { closeDialog(); openWindow("server", h.id, h.name); }
    }
  }, true);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest && e.target.closest("[data-c075-open]");
    if (!card || e.target !== card) return;
    e.preventDefault();
    const h = findHost(card.dataset.c075Open);
    if (h) openWindow("server", h.id, h.name);
  });

  document.addEventListener("input", (e) => {
    if (!e.target.closest || !e.target.closest(".c075-form")) return;
    if (activeDraft) {
      activeDraft.test = null;
      if (e.target.id === "c075-host") activeDraft.os = "";
    }
    const field = e.target.closest(".c075-field");
    if (field) field.classList.remove("invalid");
    const err = field && field.querySelector(".c075-err");
    if (err) err.textContent = "";
    const result = document.querySelector(".c075-test-result");
    if (result) { result.className = "c075-test-result"; result.textContent = ""; }
  });

  /* ---------------- 覆盖页面 ---------------- */
  Screens.serversPage = serversPage;
  Screens.server = serverPage;

  D.servers.forEach((s, i) => {
    if (!s.authType) s.authType = i === 1 ? "key" : "password";
  });

  window.C075 = { osMeta, osTile, tabIcon, hostAddr, metrics };
})();
