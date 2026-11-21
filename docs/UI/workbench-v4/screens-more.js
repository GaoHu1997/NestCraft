/* 知识库、服务器、设置。 */
(function () {
  "use strict";
  const { D, esc, icon, store, toast, openDialog, openSubDialog, closeDialog, dlgShell, md, toc, fileIcon, projTile, kbIconId, avatarHtml, avatarImg, KB_ICON_IDS, AVATAR_LABELS, ICON_GROUPS, ICON_COLORS, ICON_COLOR_LABELS } = UI;
  const iconColorPair = UI.iconColorPair;
  const Screens = window.Screens;

  const libById = id => D.knowledge.libraries.find(l => l.id === id) || D.knowledge.libraries[0];
  const docById = (libId, docId) => (D.knowledge.docs[libId] || []).find(d => d.id === docId);
  const isGranted = lib => lib.allProjects || (lib.grantedTo || []).length > 0;
  /* CR-051：演示夹具的来源推导默认（本地 bookOpen / 本地+网页 layers）；用户自选后保存 lib.icon，清空回推导。 */
  const KB_SOURCE_DEFAULT = { "KB-01": "bookOpen", "KB-02": "layers", "KB-03": "book" };

  /* ================= 知识库 ================= */
  function knowledgePage() {
    return `<div class="page">
      <div class="page-h"><div class="titles"><h1 class="page-title">知识库</h1>
        <p class="page-sub">本地多格式文件为原件；授权到项目后，AI 才能检索并读取有界片段。</p></div>
        <div class="page-actions"><button class="btn" data-act="toast" data-msg="演示：扫描目录并重建索引">${icon("refresh", "ico-14")}重新索引</button>
        <button class="btn primary" data-act="toast" data-msg="演示：新建知识库">${icon("plus", "ico-14")}新建知识库</button></div></div>
      <div class="stack">
        ${D.knowledge.libraries.map(lib => `<div class="card kb-card">
          <span class="kb-icon ${lib.iconColor ? "" : esc(lib.tone || "blue")}" ${lib.iconColor ? `style="background:${iconColorPair(lib.iconColor)[0]};color:${iconColorPair(lib.iconColor)[1]}"` : ""} data-kb-tile="${esc(lib.id)}">${icon(kbIconId(lib, KB_SOURCE_DEFAULT[lib.id] || "library"), "ico-20")}</span>
          <div class="kb-main"><b>${esc(lib.name)}</b><p>${esc(lib.desc)} · ${esc(lib.owner)}</p>
            <div class="kb-tags">${lib.allProjects ? `<span class="tag green">所有项目可用</span>` : lib.grantedTo.length ? lib.grantedTo.map(p => `<span class="tag blue">${esc((D.projects.find(x => x.id === p) || {}).name || p)}</span>`).join("") : `<span class="tag gray">未授权</span>`}</div></div>
          <div class="kb-side"><span>${(D.knowledge.docs[lib.id] || []).length} 篇</span><span>${esc(lib.updated)}</span>
            <button class="btn sm" data-act="kb-icon-open" data-id="${lib.id}" title="选择内置图标">${icon("palette", "ico-14")}图标</button>
            <button class="btn sm" data-act="kb-grant-open" data-id="${lib.id}">${isGranted(lib) ? "管理授权" : "授权"}</button>
            <button class="btn sm primary" data-act="open-kb" data-id="${lib.id}">进入</button></div>
        </div>`).join("")}
      </div>
      <div class="page-foot"><span>检索为本地索引仿真，不调用模型嵌入</span><span>${D.knowledge.libraries.length} 个库 · ${Object.values(D.knowledge.docs).reduce((a, b) => a + b.length, 0)} 个文件</span></div>
    </div>`;
  }

  function grantModal(libId) {
    const lib = libById(libId);
    const body = `<div class="grant-box">
      <div class="caption">选择可以访问该知识库的项目，可多选；也可以对所有项目开放（含以后新建的项目）。</div>
      <div class="grant-list">${D.projects.map(p => `<label class="grant-row"><input type="checkbox" data-grant-project="${p.id}" ${lib.grantedTo.includes(p.id) ? "checked" : ""}>${projTile(p, "sm", "ico-14")}<span class="g-main"><b>${esc(p.name)}</b><span>${esc(p.id)} · ${esc(p.owner)}</span></span></label>`).join("")}</div>
      <label class="grant-all"><span><b>所有项目开放</b><span class="caption">新建项目自动获得访问权</span></span><span class="switch" data-act="grant-all" aria-checked="${lib.allProjects}"></span></label>
      <div class="note-box">${icon("shield", "ico-14")} 授权只授予只读检索，不授予写入、命令执行或未授权目录访问。</div>
    </div>`;
    openDialog(dlgShell("授权知识库", esc(lib.name), body,
      `<button class="btn" data-act="close-dialog">取消</button><button class="btn primary" data-act="kb-grant-save" data-id="${lib.id}">保存授权</button>`, "modal-md"));
  }

  function libraryPage(id) {
    // CR-045: knowledge-workspace.js is loaded after main.js. The library owner
    // can manage local material independently of project AI read-only grants.
    if (window.KnowledgeWorkspace) return window.KnowledgeWorkspace.render(id);
    const lib = libById(id);
    return `<div class="page"><div class="empty"><b>知识工作区设计资源尚未加载</b><p>请在 main.js 后加载 knowledge-workspace.js；项目 AI 授权不限制本人管理。</p><button class="btn" data-act="kb-grant-open" data-id="${esc(lib.id)}">AI 授权管理</button></div></div>`;
  }

  /* ================= 服务器 ================= */
  function serversPage() {
    return `<div class="page"><div class="page-h"><div class="titles"><h1 class="page-title">服务器管理</h1><p class="page-sub">连接、终端与巡检在同一工作台；高风险命令逐次审批。</p></div>
      <div class="page-actions"><button class="btn primary" data-act="toast" data-msg="演示：添加主机">${icon("plus", "ico-14")}添加主机</button></div></div>
      <div class="srv-grid">${D.servers.map(s => `<div class="card srv-card ${s.status === "offline" ? "offline" : ""}" data-act="open-server" data-id="${s.id}">
        <div class="srv-h"><div><b>${esc(s.name)}</b><span>${esc(s.host)}</span></div><span class="status ${s.status === "online" ? "green" : "gray"}">${s.status === "online" ? "在线" : "离线"}</span></div>
        <div class="srv-stats"><div><b>${s.cpu.length ? Math.round(s.cpu.reduce((a, b) => a + b, 0) / s.cpu.length) + "%" : "—"}</b><span>CPU</span></div><div><b>${s.mem ? Math.round(s.mem.used / s.mem.total * 100) + "%" : "—"}</b><span>内存</span></div><div><b>${s.disk ? Math.round(s.disk.used / s.disk.total * 100) + "%" : "—"}</b><span>磁盘</span></div></div>
        <div class="row between"><span class="caption">${esc(s.group)} · ${esc(s.os)}</span><span class="caption">${esc(s.last)}</span></div></div>`).join("")}</div>
      <div class="page-foot"><span>主机、指标与终端输出均为夹具</span><span>3 台 · 2 在线</span></div></div>`;
  }

  function serverPage(id) {
    const s = D.servers.find(x => x.id === id) || D.servers[0];
    const online = s.status === "online";
    const lines = store.termLog && store.termServer === s.id ? store.termLog : (D.terminal[s.id] || []).map(h => ({ cmd: h.cmd, out: h.out }));
    return `<div class="srv-shell">
      <aside class="srv-files">
        <div class="srv-files-h"><span>${icon("folder", "ico-14")}文件</span><button class="icon-btn" data-act="toast" data-msg="演示：打开 SFTP 浏览器">${icon("external", "ico-14")}</button></div>
        <div class="srv-path">${esc(s.host)} <span class="caption">›</span> /home/${esc(s.username || "ops")}</div>
        <div class="srv-tree">${(s.files || []).map(f => `<button class="srv-file" data-act="server-file" data-file="${esc(f)}">${icon("folder", "ico-14")}${esc(f)}</button>`).join("") || `<div class="caption" style="padding:12px">主机离线，无法浏览文件</div>`}</div>
      </aside>
      <section class="srv-term">
        <div class="srv-term-h"><span class="tab on">${icon("terminal", "ico-14")}shell 1</span><span class="spacer"></span><span class="caption">${esc(s.host)} · ${online ? "已连接" : "未连接"}</span></div>
        <div class="term-body" id="term-body">${lines.length ? lines.map(l => `<div class="cmd">${esc(l.cmd)}</div><div class="out">${esc(l.out)}</div>`).join("") : `<div class="hint">${online ? "输入 help 查看可用命令。" : "主机离线：无法建立连接。"}</div>`}</div>
        <form class="term-input" data-act="term-submit" data-id="${s.id}"><span class="p">${esc(s.username || "ops")}@${esc((s.host || "").split("@")[0])}:~$</span><input id="term-input" autocomplete="off" spellcheck="false" placeholder="${online ? "输入命令，例如 uptime" : "主机离线"}" ${online ? "" : "disabled"}></form>
      </section>
      <aside class="srv-monitor">
        <div class="mon-h"><b>实时监控</b><span class="caption">每 5 秒刷新</span></div>
        <div class="mon-host"><div class="row between"><b>${esc(s.name)}</b><span class="status ${online ? "green" : "gray"}">${online ? "正常" : "离线"}</span></div>
          <div class="mon-kv"><span>系统</span><b>${esc(s.os)}</b></div><div class="mon-kv"><span>地址</span><b class="mono">${esc(s.host)}</b></div><div class="mon-kv"><span>运行时长</span><b>${esc(s.uptime)}</b></div></div>
        ${online ? `<div class="mon-block"><div class="row between"><span>CPU 使用率</span><b>${Math.round(s.cpu.reduce((a, b) => a + b, 0) / s.cpu.length)}%</b></div>
          <svg class="spark" viewBox="0 0 200 40" preserveAspectRatio="none"><polyline points="0,32 20,28 40,30 60,18 80,22 100,14 120,20 140,10 160,16 180,12 200,18" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
          <div class="core-grid">${[16, 24, 32, 24, 18, 22, 28, 20].map(v => `<span class="core"><i style="height:${v}%"></i></span>`).join("")}</div>
          <div class="caption">每核心占用 · 共 8 核</div></div>
          <div class="mon-block"><div class="row between"><span>内存</span><b>${s.mem.used.toFixed(1)} / ${s.mem.total} GB</b></div><div class="bar"><i style="width:${s.mem.used / s.mem.total * 100}%"></i></div></div>
          <div class="mon-block"><div class="row between"><span>磁盘</span><b>${s.disk.used} / ${s.disk.total} GB</b></div><div class="bar amber"><i style="width:${s.disk.used / s.disk.total * 100}%"></i></div></div>
          <div class="mon-block"><div class="row between"><span>负载</span><b>${s.load.join(" / ")}</b></div><div class="caption">1 / 5 / 15 分钟</div></div>`
        : `<div class="mon-block"><div class="empty" style="padding:20px"><b>无数据</b><p>主机离线，指标未知。</p></div></div>`}
      </aside>
    </div>`;
  }

  /* ================= 设置 ================= */
  const SET_NAV = [
    ["general", "通用", "settings"],
    ["models", "模型管理", "cpu"],
    ["cli", "SDK 与 CLI", "terminal"],
    ["skills", "能力 · Skill", "layers"],
    ["mcp", "能力 · MCP", "box"],
    ["tools", "能力 · Tools", "zap"]
  ];

  function openSettings(tab) {
    store.settingsOpen = true;
    store.settingsTab = tab || store.settingsTab || "general";
    openDialog(settingsHtml(), "settings-dialog");
  }

  function settingsHtml() {
    const tab = store.settingsTab;
    const g = D.settings.general;
    return `<div class="settings-dialog">
      <aside class="set-nav">
        <div class="set-user">${avatarHtml("md", "")}<div><b>${esc(g.profile.name)}</b><span>${esc(g.profile.email)}</span></div></div>
        <div class="set-nav-list">${SET_NAV.map(([k, label, ic]) => `<button class="s-item" aria-selected="${tab === k}" data-act="settings-tab" data-tab="${k}">${icon(ic, "ico-14")}${label}</button>`).join("")}</div>
        <div class="set-nav-f"><span class="caption">UI-CR036-v4 · 演示</span><button class="btn sm" data-act="close-dialog">关闭</button></div>
      </aside>
      <section class="set-body">
        <div class="set-head"><div><h2>${esc((SET_NAV.find(x => x[0] === tab) || [])[1])}</h2><p class="caption">${esc(setSub(tab))}</p></div></div>
        <div class="set-scroll">${setContent(tab)}</div>
      </section>
    </div>`;
  }
  function setSub(tab) {
    return { general: "用户信息、代码样式与服务器默认值。", models: "供应商、密钥、端点与模型配置。", cli: "CLI 管理与 SDK 管理。", skills: "技能是过程性指令；启用不等于授权执行。", mcp: "MCP 服务器发现工具与资源。", tools: "内置工具与风险等级。" }[tab] || "";
  }

  function setContent(tab) {
    const g = D.settings.general;
    if (tab === "general") {
      const current = store.avatarDraft || store.avatarStyle || "b";
      const avatarRadio = `<div class="avatar-radio-row" role="radiogroup" aria-label="头像风格">
        ${["a", "b", "c", "d", "e"].map(s => `<button class="avatar-radio" type="button" role="radio" aria-checked="${current === s}" data-act="avatar-style-pick" data-id="${s}">${avatarHtml("sm", "")}<b>${esc((UI.AVATAR_LABELS[s] || s).replace(/^[a-e] /, ""))}</b></button>`).join("")}
      </div>`;
      return `<div class="set-section"><h3>用户基本信息</h3>
        <div class="set-field"><div class="f-label"><b>显示名称</b><span>用于会话与操作记录</span></div><div class="f-control"><input class="input" id="gen-name" value="${esc(g.profile.name)}"></div></div>
        <div class="set-field"><div class="f-label"><b>邮箱</b><span>仅占位，不发送邮件</span></div><div class="f-control"><input class="input" id="gen-email" value="${esc(g.profile.email)}"></div></div>
        <div class="set-field"><div class="f-label"><b>角色</b><span>显示在工作台</span></div><div class="f-control"><input class="input" id="gen-role" value="${esc(g.profile.role)}"></div></div>
        <div class="set-field"><div class="f-label"><b>时区</b><span>影响时间显示</span></div><div class="f-control"><select class="select" id="gen-tz"><option>Asia/Shanghai</option><option>UTC</option></select></div></div></div>
      <div class="set-section"><h3>代码样式</h3>
        <div class="set-field"><div class="f-label"><b>编辑器主题</b><span>编码页与预览一致</span></div><div class="f-control"><div class="seg" id="gen-theme"><button data-act="set-code-theme" data-theme="跟随系统" aria-selected="${g.code.theme === "跟随系统"}">跟随系统</button><button data-act="set-code-theme" data-theme="浅色" aria-selected="${g.code.theme === "浅色"}">浅色</button><button data-act="set-code-theme" data-theme="深色" aria-selected="${g.code.theme === "深色"}">深色</button></div></div></div>
        <div class="set-field"><div class="f-label"><b>字号 / Tab</b><span>12–16px，2/4 空格</span></div><div class="f-control row"><input class="input" style="width:90px" id="gen-font" value="${g.code.fontSize}"><select class="select" id="gen-tab" style="width:120px"><option ${g.code.tabSize === 2 ? "selected" : ""}>2</option><option ${g.code.tabSize === 4 ? "selected" : ""}>4</option></select><button class="switch" data-act="toast" data-msg="演示：自动换行切换" aria-checked="${g.code.wrap}"></button></div></div>
        <div class="set-field"><div class="f-label"><b>预览</b><span>当前配置下的代码外观</span></div><div class="f-control" style="max-width:none"><div class="code-preview mono" style="font-size:${g.code.fontSize}px">const booking = await createBooking({<br>&nbsp;&nbsp;slotId: "DEMO-SLOT-01",<br>&nbsp;&nbsp;idempotencyKey: "DEMO-REQUEST-01"<br>});</div></div></div></div>
      <div class="set-section"><h3>服务器配置</h3>
        <div class="set-field"><div class="f-label"><b>默认端口 / 用户</b><span>新建主机时的默认值</span></div><div class="f-control row"><input class="input" style="width:100px" id="gen-port" value="${g.server.port}"><input class="input" style="width:140px" id="gen-user" value="${esc(g.server.defaultUser)}"></div></div>
        <div class="set-field"><div class="f-label"><b>默认认证</b><span>密钥文件 / 密码 / 跳板机</span></div><div class="f-control"><select class="select" id="gen-auth"><option ${g.server.auth === "密钥文件" ? "selected" : "selected"}>密钥文件</option><option>密码</option><option>跳板机</option></select></div></div>
        <div class="set-field"><div class="f-label"><b>高风险命令确认</b><span>逐次确认，不记忆放行</span></div><div class="f-control"><button class="switch" aria-checked="${g.server.confirmDanger}" data-act="toast" data-msg="演示：高风险确认已开启"></button></div></div></div>
      <div class="set-section"><h3>界面外观</h3>
        <div class="set-field"><div class="f-label"><b>头像</b><span>悬停头像出现编辑；内置 5 种样式或自定义图片（PNG / JPG / WebP，≤200KB）。应用后顶栏、侧栏与设置三处同步</span></div><div class="f-control"><span class="avatar-field">
          <span class="avatar-frame"><span class="avatar" style="width:72px;height:72px">${avatarImg("")}</span><button class="avatar-edit" type="button" data-act="avatar-edit" aria-label="更换头像" title="更换头像">${icon("camera", "ico-14")}</button></span>
          <button class="btn sm" type="button" data-act="avatar-edit">更换头像…</button>
        </span></div></div>
        <div class="set-field"><div class="f-label"><b>头像风格</b><span>品牌帆船 Logo；作用于顶栏、侧栏与设置，保存后三处同步</span></div><div class="f-control">${avatarRadio}</div></div>
        <div class="set-field"><div class="f-label"><b>预览</b><span>当前风格下的三处头像（点击上方立即预览整页）</span></div><div class="f-control"><span class="row" style="gap:10px">${avatarHtml("xs", "")}${avatarHtml("", "")}${avatarHtml("md", "")}<span class="caption">24 / 30 / 34px</span></span></div></div></div>
      <div class="set-section"><h3>会话</h3>
        <div class="set-field"><div class="f-label"><b>生成中再次发送</b><span>立即发送会打断当前生成，排队等当前完成</span></div><div class="f-control"><div class="seg"><button data-act="set-send-mode" data-mode="immediate" aria-selected="${(g.sendMode || "queue") === "immediate"}">立即发送</button><button data-act="set-send-mode" data-mode="queue" aria-selected="${(g.sendMode || "queue") === "queue"}">排队</button></div></div></div></div>
      <div class="set-actions"><button class="btn primary" data-act="settings-save">保存设置</button><span class="caption">保存后立即作用于设计稿；取消恢复已保存风格</span></div>`;
    }
    if (tab === "models") {
      return `<div class="row between" style="margin-bottom:14px"><span class="caption">${D.settings.providers.length} 个供应商 · 点击卡片展开配置</span><button class="btn sm primary" data-act="provider-new">${icon("plus", "ico-14")}新建供应商</button></div>
        ${D.settings.providers.map(providerBlock).join("")}
        <div class="note-box info">${icon("shield", "ico-14")} 密钥只保存引用占位；指纹检测按意见移除，保留多密钥、多端点、请求头与请求伪装。</div>`;
    }
    if (tab === "cli") {
      return `<div class="cli-tabs"><button class="${store.sdkTab === "cli" ? "on" : ""}" data-act="sdk-tab" data-tab="cli">CLI 管理</button><button class="${store.sdkTab === "sdk" ? "on" : ""}" data-act="sdk-tab" data-tab="sdk">SDK 管理</button></div>
        ${store.sdkTab === "sdk" ? sdkList() : cliList()}`;
    }
    if (tab === "skills") return skillList();
    if (tab === "mcp") return mcpList();
    return toolList();
  }

  function providerBlock(p) {
    const open = store.providerOpen === p.id;
    const tab = store.providerTab || "config";
    const tabs = [["config", "供应商配置"], ["models", "模型配置"], ["advanced", "高级配置"]];
    return `<div class="provider-card ${open ? "open" : ""}">
      <div class="provider-h" data-act="provider-expand" data-id="${p.id}">
        <span class="pico">${esc(p.name.slice(0, 2))}</span>
        <span class="pinfo"><b>${esc(p.name)}</b><span>${esc(p.protocol)} · ${p.keys.length} 个密钥 · ${p.endpoints.length} 个端点 · ${p.models.length} 个模型</span></span>
        <span class="status ${p.enabled ? "green" : "gray"}">${p.enabled ? "启用" : "停用"}</span>
        <button class="switch" data-act="provider-toggle" data-id="${p.id}" aria-checked="${p.enabled}"></button>
        <button class="icon-btn" data-act="provider-delete" data-id="${p.id}" title="删除供应商">${icon("trash")}</button>
        <span class="chev">${icon(open ? "chevronUp" : "chevronDown")}</span>
      </div>
      ${open ? `<div class="provider-inline">
        <div class="pm-tabs">${tabs.map(([k, l]) => `<button class="${tab === k ? "on" : ""}" data-act="provider-tab" data-tab="${k}">${l}</button>`).join("")}</div>
        <div class="pm-body">${tab === "models" ? providerModels(p) : tab === "advanced" ? providerAdvanced(p) : providerConfig(p)}</div>
        <div class="pm-f"><span class="caption">配置即改即存，不需要弹窗</span><button class="btn primary" data-act="provider-save" data-id="${p.id}">保存供应商</button></div>
      </div>` : ""}
    </div>`;
  }

  function refreshSettings() {
    const body = document.querySelector(".set-scroll");
    if (body) body.innerHTML = setContent(store.settingsTab);
  }

  function cliList() {
    return `<div class="stack-sm">${D.settings.clis.map(c => `<div class="cli-row ${c.expandable ? "expandable" : ""}">
      <div class="cli-h">${Screens.cliTile(c.id, 34)}<span class="cli-info"><b>${esc(c.name)} ${c.badge ? `<span class="tag blue">${esc(c.badge)}</span>` : ""}</b><span>${esc(c.meta)}</span></span>
        <span class="tag ${c.installed ? (c.enabled ? "green" : "gray") : "gray"}">${c.installed ? (c.enabled ? "启用" : "停用") : "未安装"}</span>
        <button class="switch" aria-checked="${c.enabled}" data-act="cli-toggle" data-id="${c.id}" ${c.installed ? "" : "disabled"}></button>
        ${c.expandable ? `<button class="icon-btn" data-act="cli-expand" data-id="${c.id}">${icon(store.cliOpen === c.id ? "chevronUp" : "chevronDown")}</button>` : ""}</div>
      ${c.expandable && store.cliOpen === c.id ? `<div class="cli-body">
        <div class="two-col"><div><label>模型</label><select class="select" id="cli-model-${c.id}"><option>${esc(c.model)}</option><option>沿用主代理模型</option></select></div><div><label>思考等级</label><select class="select" id="cli-effort-${c.id}"><option>${esc(c.effort)}</option><option>低</option><option>中</option><option>高</option></select></div></div>
        <div><label>最低任务难度</label><select class="select" id="cli-min-${c.id}"><option>${esc(c.minDifficulty)}</option><option>高</option></select><div class="caption">仅控制此 CLI；未达门槛改用 dsh 子代理。</div></div>
        <div><label>任务类型</label><div class="chips">${["仓库探索", "代码定位", "资料检索", "方案核验", "影响分析", "功能开发", "缺陷修复", "测试验证", "代码审查", "数据处理", "模块重构", "方案设计", "文档整理"].map(t => `<button class="chip ${c.types.includes(t) ? "on" : ""}" data-act="cli-type" data-id="${c.id}" data-type="${t}">${t}</button>`).join("")}</div></div>
        <div><label>权限模式</label><select class="select" id="cli-perm-${c.id}"><option>${esc(c.permission)}</option><option>acceptEdits</option><option>workspace-write</option></select></div>
        <div class="row"><button class="btn sm primary" data-act="cli-save" data-id="${c.id}">保存</button><button class="btn sm" data-act="cli-check" data-id="${c.id}">重新检测</button></div>
      </div>` : ""}</div>`).join("")}</div>`;
  }

  function sdkList() {
    return `<div class="sdk-registry"><label>npm registry</label><div class="row"><input class="input" value="https://registry.npmmirror.com"><button class="btn sm" data-act="sdk-check-all">全部重新检测</button></div><div class="caption">可选，镜像源；保存后对后续安装生效。</div></div>
      <div class="sdk-cards">${D.settings.sdks.map(sdkCard).join("")}</div>`;
  }

  function sdkCard(s) {
    const open = store.sdkOpen === s.id;
    const status = s.builtin ? "内置" : !s.installed ? "未安装" : s.version === s.latest ? "已安装" : "有更新";
    const tone = s.builtin ? "gray" : !s.installed ? "gray" : s.version === s.latest ? "green" : "amber";
    return `<div class="sdk-card ${s.builtin ? "builtin" : ""} ${open ? "open" : ""}">
      <div class="sdk-card-h" data-act="sdk-expand" data-id="${s.id}">
        <span class="sdk-logo">${icon(s.builtin ? "box" : "terminal", "ico-16")}</span>
        <span class="sdk-info"><b>${esc(s.name)} <span class="tag ${tone}">${status}</span>${!s.builtin && s.installed && s.version !== s.latest ? ` <span class="mono sdk-to">${esc(s.version)} → ${esc(s.latest)}</span>` : ""}</b><span>${esc(s.desc)}</span></span>
        <span class="sdk-version">${s.builtin ? esc(s.version) : esc(s.version)}</span>
        <span class="sdk-chev">${icon(open ? "chevronUp" : "chevronDown", "ico-14")}</span>
      </div>
      ${open ? `<div class="sdk-body">
        ${s.builtin ? `<div class="caption">随宿主安装，无需 npm 安装或升级。</div><div class="sdk-path mono">${esc(s.path)}</div>` : `<div class="sdk-field"><label>目标版本</label><select class="select"><option>${esc(s.latest)}（最新稳定）</option><option>${esc(s.version)}（当前）</option></select><div class="caption">只列正式版（不含 alpha / beta）· 当前平台 win32-x64</div></div>
        <div class="row sdk-actions"><button class="btn sm" disabled>当前版本 ${esc(s.version)}</button>${s.installed ? `<button class="btn sm danger" data-act="sdk-uninstall" data-id="${s.id}">卸载</button>` : ""}<button class="btn sm" data-act="sdk-${s.installed ? "check" : "install"}" data-id="${s.id}">${s.installed ? "重新检测" : "安装"}</button></div>
        <div class="sdk-meta">当前版本 ${esc(s.version)} · 最新稳定 ${esc(s.latest)}</div>
        <div class="sdk-path mono">${esc(s.path)}</div>`}
      </div>` : ""}
    </div>`;
  }

  function skillList() {
    return `<div class="row between" style="margin-bottom:12px"><span class="caption">${D.settings.skills.length} 个技能</span><div class="row"><button class="btn sm" data-act="skill-import">${icon("upload", "ico-14")}导入</button><button class="btn sm primary" data-act="skill-add">${icon("plus", "ico-14")}添加技能</button></div></div>
      <div class="card">${D.settings.skills.map((s, i) => `<div class="cap-row"><span class="kb-icon blue" style="width:32px;height:32px;border-radius:8px">${icon("layers", "ico-16")}</span>
        <span class="cap-main"><b>${esc(s.name)} <span class="mono muted" style="font-size:11px">/${esc(s.slug)}</span></b><span>${esc(s.desc)} · 来源 ${esc(s.source)} · ${esc(s.updated)}</span></span>
        <button class="switch" aria-checked="${s.on}" data-act="skill-toggle" data-idx="${i}"></button></div>`).join("")}</div>`;
  }
  function mcpOauthPreview() {
    const states = [
      ["unauthenticated", "未授权", "HTTP MCP尚未完成授权；连接测试与派发保持阻止。", "授权"],
      ["pending", "待浏览器回调", "已打开系统浏览器，等待一次性loopback回调；超时可重试。", "等待回调"],
      ["authenticated", "已授权", "NestCraft持有受管凭据；工具发现与派发分别显示结果。", "撤销授权"],
      ["expired", "已过期", "刷新令牌失效或凭据过期；旧令牌不再使用。", "重新授权"],
      ["revoked", "已撤权", "本地凭据已删除，远端撤销结果不影响当前配置。", "重新授权"],
      ["error", "连接失败", "metadata、回调、令牌交换或tools/list失败；不展示原始凭据。", "查看失败原因"]
    ];
    return `<section class="mcp-oauth-preview" aria-label="HTTP MCP OAuth状态演示"><h4>HTTP MCP 授权状态覆盖 · 设计夹具</h4><p class="caption">授权由NestCraft管理；token、state、原始回调和CLI用户profile不显示。stdio MCP不显示OAuth操作。</p><div class="mcp-oauth-grid">${states.map(([key, label, desc, action]) => `<article class="mcp-oauth-state ${key}"><b>${label}</b><p>${desc}</p><div class="mcp-oauth-actions"><button class="btn sm" data-act="mcp-oauth-demo" data-state="${key}">${action}</button>${key === "authenticated" ? `<button class="btn sm" data-act="toast" data-msg="设计演示：连接结果与授权状态分开">发现工具</button>` : ""}</div></article>`).join("")}</div>
      <div class="set-section" style="margin-top:14px"><h4 style="margin:0 0 6px;font-size:13px">HTTP 认证方式（MCP 配置内）</h4>
        <div class="set-field"><div class="f-label"><b>认证方式</b><span>OAuth：NestCraft 完成浏览器授权；静态令牌：直接使用服务提供的 Bearer；无认证：仅限受控服务</span></div><div class="f-control"><select class="select" aria-label="MCP认证方式"><option>OAuth</option><option>静态令牌</option><option>无认证</option></select></div></div>
        <div class="set-field"><div class="f-label"><b>Bearer 令牌</b><span>仅写入受管密钥，保存后不回显；不在列表、日志或错误中展示</span></div><div class="f-control"><input class="input" type="password" aria-label="MCP Bearer令牌" placeholder="保存后不回显"></div></div>
        <div class="set-field"><div class="f-label"><b>信任本机自签名证书</b><span>仅 loopback（127.0.0.1／localhost／::1）的 HTTPS 可开启，默认关闭；其他主机始终校验证书</span></div><div class="f-control"><button class="switch" aria-checked="false" aria-label="信任本机自签名证书"></button></div></div>
        <p class="caption">静态令牌连接不需要 OAuth 回调；工具发现仍使用同一受管令牌。</p>
      </div></section>`;
  }
  function mcpList() {
    return `<div class="row between" style="margin-bottom:12px"><span class="caption">${D.settings.mcp.length} 个服务器</span><div class="row"><button class="btn sm" data-act="mcp-import">${icon("upload", "ico-14")}导入</button><button class="btn sm primary" data-act="mcp-add">${icon("plus", "ico-14")}添加 MCP</button></div></div>
      <div class="card">${D.settings.mcp.map((m, i) => `<div class="cap-row"><span class="sdk-logo" style="width:32px;height:32px">${icon("box", "ico-16")}</span>
        <span class="cap-main"><b>${esc(m.name)}</b><span>${esc(m.transport)} · <span class="mono">${esc(m.target)}</span> · ${m.tools} 个工具</span></span>
        <span class="status ${m.on ? "green" : "gray"}">${m.on ? "已启用 · 工具发现独立显示" : "已停用"}</span><button class="switch" aria-checked="${m.on}" data-act="mcp-toggle" data-idx="${i}"></button></div>`).join("")}</div>${mcpOauthPreview()}`;
  }
  function toolList() {
    return `<div class="card"><table class="table"><thead><tr><th>工具</th><th>风险</th><th>说明</th><th>今日调用</th><th>状态</th></tr></thead><tbody>
      ${D.settings.tools.map((t, i) => `<tr><td><span class="mono" style="color:var(--ink)">${esc(t.name)}</span></td><td><span class="risk ${t.risk === "低" ? "low" : t.risk === "中" ? "mid" : "high"}">${esc(t.risk)}</span></td><td class="muted">${esc(t.desc)}</td><td class="num">${t.calls}</td><td><button class="switch" aria-checked="${t.on}" data-act="tool-toggle" data-idx="${i}"></button></td></tr>`).join("")}
    </tbody></table></div>`;
  }

  /* 供应商编辑 */
  function providerModal(id, modelId) {
    const p = id ? D.settings.providers.find(x => x.id === id) : { id: "PRV-NEW", name: "新供应商", protocol: "OpenAI", enabled: true, keys: [], endpoints: [{ protocol: "OpenAI", url: "", on: true }], headers: [], spoof: "关闭", models: [] };
    store.providerEdit = p.id;
    store.providerTab = store.providerTab || "config";
    if (modelId) store.modelEdit = modelId;
    const body = `<div class="provider-modal">
      <div class="pm-h">${icon("drag", "ico-14")}<b>${esc(p.name)}</b><span class="tag gray">自定义</span><span class="status ${p.enabled ? "green" : "gray"}">${p.enabled ? "启用" : "停用"}</span><span class="spacer"></span>
        <button class="switch" aria-checked="${p.enabled}" data-act="provider-toggle" data-id="${p.id}"></button>
        <button class="btn sm" data-act="toast" data-msg="演示：编辑基础信息">编辑</button><button class="btn sm danger" data-act="provider-delete" data-id="${p.id}">删除</button></div>
      <div class="pm-tabs">${[["config", "供应商配置"], ["models", "模型配置"], ["advanced", "高级配置"]].map(([k, l]) => `<button class="${store.providerTab === k ? "on" : ""}" data-act="provider-tab" data-tab="${k}">${l}</button>`).join("")}</div>
      <div class="pm-body">${store.providerTab === "models" ? providerModels(p) : store.providerTab === "advanced" ? providerAdvanced(p) : providerConfig(p)}</div>
      <div class="pm-f"><button class="btn" data-act="settings-back">返回</button><button class="btn primary" data-act="provider-save" data-id="${p.id}">保存供应商</button></div>
    </div>`;
    openDialog(body, "settings-dialog provider-dialog");
  }

  function providerConfig(p) {
    return `<div class="pm-section"><div class="row between"><b>API 密钥</b><button class="btn xs" data-act="provider-key-detect">自动探测</button></div>
      <div class="key-list">${p.keys.map((k, i) => keyRow(p, k, i)).join("") || `<div class="caption" style="padding:10px">还没有密钥</div>`}
        <button class="key-add" data-act="provider-key-add">${icon("plus", "ico-14")}添加另一个密钥</button></div>
      <div class="caption">悬停密钥可改别名、协议与可用模型；删除前会二次确认。</div></div>
      <div class="pm-section"><label>显示名称</label><input class="input" id="pm-name" value="${esc(p.name)}"></div>
      <div class="pm-section"><label>API 协议</label><div class="seg">${["Chat", "Responses", "Anthropic", "Gemini API"].map(x => `<button aria-selected="${p.protocol === x}" data-act="provider-protocol" data-v="${x}">${x}</button>`).join("")}</div></div>
      <div class="pm-section"><div class="row between"><label>API 地址</label><button class="btn xs" data-act="provider-endpoints">${store.endpointsOpen ? "收起端点 ˄" : "更多端点 ˅"}</button></div>
        ${(store.endpointsOpen ? p.endpoints : p.endpoints.slice(0, 1)).map(e => `<div class="endpoint-row"><span class="dot ${e.on ? "on" : "off"}"></span><span class="caption">${esc(e.protocol)}</span><input class="input mono" value="${esc(e.url)}" placeholder="https://…"></div>`).join("")}
        ${store.endpointsOpen ? `<button class="key-add" data-act="provider-endpoint-add">${icon("plus", "ico-14")}添加端点</button>` : ""}
      </div>`;
  }

  function keyRow(p, k, i) {
    const editing = store.keyEdit && store.keyEdit.idx === i ? store.keyEdit.mode : null;
    const scope = k.models && k.models.length ? `${k.models.length} 个模型` : (k.scope || "全部模型");
    return `<div class="key-item ${editing ? "editing" : ""}">
      <div class="key-row">
        <span class="cb ${k.on ? "on" : ""}" data-act="provider-key-toggle" data-idx="${i}" role="checkbox" aria-checked="${k.on}">${k.on ? icon("check", "ico-14") : ""}</span>
        <span class="key-val"><b>${esc(k.label || "未命名密钥")}</b><span class="mono key-mask">${esc(k.masked)}</span><span class="key-scope-tag">${esc(scope)}</span></span>
        <span class="key-actions">
          <button class="link-btn" data-act="key-protocol" data-idx="${i}" title="该密钥使用的协议">${esc(k.protocol || "默认协议")} ›</button>
          <button class="link-btn" data-act="key-scope" data-idx="${i}">模型</button>
          <button class="link-btn" data-act="key-alias" data-idx="${i}">别名</button>
          <button class="link-btn" data-act="key-value" data-idx="${i}">编辑</button>
          <button class="link-btn danger" data-act="key-remove" data-idx="${i}">删除</button>
        </span>
      </div>
      ${editing ? keyForm(p, k, i, editing) : ""}
    </div>`;
  }

  function keyForm(p, k, i, mode) {
    let body = "";
    if (mode === "alias") body = `<div class="key-form-row"><label>别名</label><input class="input" id="key-alias-input" value="${esc(k.label || "")}" placeholder="例如：主凭证"></div>`;
    else if (mode === "value") body = `<div class="key-form-row"><label>密钥值</label><input class="input mono" id="key-value-input" value="${esc(k.masked)}"></div>`;
    else if (mode === "protocol") body = `<div class="key-form-row"><label>该密钥的协议</label><div class="chips">${["", "Chat", "Responses", "Anthropic"].map(v => `<button class="chip ${(k.protocol || "") === v ? "on" : ""}" data-act="key-protocol-set" data-idx="${i}" data-v="${v}">${v || "默认"}</button>`).join("")}</div><div class="caption">默认沿用供应商协议；只有配置了端点地址的协议才应出现。</div></div>`;
    else if (mode === "remove") body = `<div class="key-form-row"><div class="note-box">确定删除「${esc(k.label || "该密钥")}」？删除后该密钥不再参与路由。</div></div>`;
    else if (mode === "scope") body = `<div class="key-form-row"><label>这个密钥可用的模型</label><div class="key-models">${p.models.map(m => `<label class="key-model"><input type="checkbox" data-key-model="${esc(m.id)}" ${(k.models || []).includes(m.id) ? "checked" : ""}>${esc(m.name)}<span class="mono">${esc(m.id)}</span></label>`).join("") || '<span class="caption">还没有模型，先获取模型。</span>'}</div></div>`;
    return `<div class="key-form">${body}<div class="row"><button class="btn sm ${mode === "remove" ? "danger" : "primary"}" data-act="${mode === "remove" ? "key-remove-confirm" : "key-save"}" data-idx="${i}" ${mode === "remove" ? "" : `data-mode="${mode}"`}>${mode === "remove" ? "确认删除" : "保存"}</button><button class="btn sm" data-act="key-edit-cancel">取消</button></div></div>`;
  }

  function modelForm(p, m) {
    return `<div class="model-form">
      <div class="two-col"><div><label>模型 ID</label><input class="input mono" id="m-id" value="${esc(m.id)}"></div><div><label>显示名称</label><input class="input" id="m-name" value="${esc(m.name)}"></div></div>
      <div><label>支持模态</label><div class="chips">${["文本", "图片", "生图"].map(x => `<button class="chip ${m.modalities.includes(x) ? "on" : ""}" data-act="model-modality" data-v="${x}">${x}</button>`).join("")}</div></div>
      <div class="row between"><label>思考</label><div class="row"><button class="btn xs" data-act="model-autoconfig">自动配置</button><button class="switch" aria-checked="${m.thinking}" data-act="model-thinking"></button></div></div>
      <div><label>支持档位</label><div class="chips">${["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(x => `<button class="chip ${m.levels.includes(x) ? "on" : ""}" data-act="model-level" data-v="${x}">${x}</button>`).join("")}</div></div>
      <div class="two-col"><div><label>默认思考强度</label><select class="select" id="m-default">${["低", "中", "高", "跟随记忆"].map(x => `<option ${m.defaultLevel === x ? "selected" : ""}>${x}</option>`).join("")}</select></div><div><label>上下文窗口</label><input class="input" id="m-ctx" value="${m.context || ""}" placeholder="留空 = 模型目录值"></div></div>
      <div class="two-col"><div><label>最大输出</label><input class="input" id="m-max" value="${m.maxOutput || ""}"></div><div><label>状态</label><div class="row"><button class="switch" aria-checked="${m.on}" data-act="toast" data-msg="演示：切换模型启用"></button><span class="caption">${m.on ? "可用" : "停用"}</span></div></div></div>
      <div class="row"><button class="btn sm primary" data-act="model-save">保存模型</button><button class="btn sm" data-act="toast" data-msg="演示：放弃修改">放弃修改</button></div>
    </div>`;
  }

  function providerModels(p) {
    return `<div class="row between model-toolbar"><span class="caption">${p.models.length} 个模型 · 点击模型展开配置</span><button class="btn sm primary" data-act="model-pick-open">${icon("plus", "ico-14")}获取模型</button></div>
      <div class="model-list">${p.models.map(x => {
        const open = store.modelOpen === x.id;
        return `<div class="model-item ${open ? "open" : ""}">
          <div class="model-head" data-act="model-select" data-id="${esc(x.id)}">
            <span class="m-name">${esc(x.name)}</span>
            <span class="m-id mono">${esc(x.id)}</span>
            <span class="m-tags">${x.modalities.map(t => `<span class="tag gray">${esc(t)}</span>`).join("")}</span>
            <span class="m-ctx">${x.context ? Math.round(x.context / 1000) + "K" : "—"}</span>
            <button class="icon-btn model-del" data-act="model-delete" data-id="${esc(x.id)}" title="删除模型">${icon("trash", "ico-14")}</button>
            <span class="m-chev">${icon(open ? "chevronUp" : "chevronDown", "ico-14")}</span>
          </div>
          ${open ? modelForm(p, x) : ""}
        </div>`;
      }).join("") || `<div class="empty" style="padding:24px"><b>还没有模型</b><p>点击「获取模型」从上游拉取并勾选。</p></div>`}</div>`;
  }

  function modelPickDialog(p) {
    const existing = new Set(p.models.map(m => m.id));
    const available = (p.availableModels || []).filter(m => !existing.has(m.id));
    const body = `<div class="model-pick-list">${available.map(m => `<label class="model-pick-row"><input type="checkbox" data-pick-model="${esc(m.id)}"><span class="pick-main"><b>${esc(m.name)}</b><span class="mono">${esc(m.id)}</span></span><span class="tag gray">${esc((m.modalities || []).join(" / "))}</span><span class="caption">${m.context ? Math.round(m.context / 1000) + "K" : "—"}</span></label>`).join("") || `<div class="empty" style="padding:24px"><b>没有更多模型</b><p>上游返回的模型都已在列表中。</p></div>`}</div>
      <div class="caption">勾选保存后会出现在模型列表；再点模型可配置模态与思考档位。</div>`;
    openSubDialog(dlgShell("获取模型", `${p.name} · 从上游拉取`, body, `<button class="btn" data-act="close-sub">取消</button><button class="btn primary" data-act="model-pick-save">保存所选</button>`, "modal-md"));
  }

  function providerAdvanced(p) {
    return `<div class="pm-section"><b>请求头</b><div class="caption">该路由的每个请求都会携带自定义请求头。</div>
      ${p.headers.map((h, i) => `<div class="header-row"><input class="input" value="${esc(h.name)}" placeholder="例如 x-company"><input class="input" value="${esc(h.value)}" placeholder="值"><button class="icon-btn" data-act="provider-header-del" data-idx="${i}">${icon("x", "ico-14")}</button></div>`).join("")}
      <button class="key-add" data-act="provider-header-add">${icon("plus", "ico-14")}添加请求头</button></div>
      <div class="pm-section"><div class="row between"><b>请求伪装</b><div class="seg">${["关闭", "Codex", "Claude"].map(x => `<button aria-selected="${p.spoof === x}" data-act="provider-spoof" data-v="${x}">${x}</button>`).join("")}</div></div><div class="caption">按意见保留请求伪装，不提供指纹检测。</div></div>`;
  }

  /* 技能 / MCP 增删 */
  function skillModal(mode) {
    openSubDialog(dlgShell(mode === "import" ? "导入技能" : "添加技能", "演示：保存后立即出现在能力列表", `<div class="form-grid">
      <div class="form-row"><label>技能名称</label><input class="input" id="sk-name" placeholder="例如：发布检查"></div>
      <div class="form-row"><label>标识（slug）</label><input class="input" id="sk-slug" placeholder="release-check"></div>
      <div class="form-row"><label>说明</label><input class="input" id="sk-desc" placeholder="一句话说明用途"></div>
      ${mode === "import" ? `<div class="form-row"><label>来源</label><input class="input" id="sk-file" placeholder="选择本机 SKILL.md" value="D:/skills/release-check/SKILL.md"></div>` : `<div class="form-row"><label>正文</label><textarea class="textarea mono" id="sk-body" rows="4" placeholder="Markdown 过程性指令"></textarea></div>`}
    </div>`, `<button class="btn" data-act="close-sub">取消</button><button class="btn primary" data-act="skill-save" data-mode="${mode}">${mode === "import" ? "导入" : "添加"}</button>`));
  }
  function mcpModal(mode) {
    openSubDialog(dlgShell(mode === "import" ? "导入 MCP" : "添加 MCP", "演示：重复名称会被拒绝", `<div class="form-grid">
      <div class="form-row"><label>名称</label><input class="input" id="mc-name" placeholder="例如：workspace-files"></div>
      <div class="form-row"><label>传输</label><select class="select" id="mc-transport"><option>stdio</option><option>HTTP</option></select></div>
      <div class="form-row"><label>命令 / 地址</label><input class="input" id="mc-target" placeholder="demo-mcp-fs --root D:/work"></div>
      ${mode === "import" ? `<div class="form-row"><label>配置文件</label><input class="input" id="mc-file" value="D:/config/mcp.json"></div>` : ""}
    </div>`, `<button class="btn" data-act="close-sub">取消</button><button class="btn primary" data-act="mcp-save" data-mode="${mode}">${mode === "import" ? "导入" : "添加"}</button>`));
  }

  /* ================= CR-051 r2/r6：知识库图标选择器（与项目共用 50 个、6 组，10 色卡成对保存） ================= */
  function kbIconModal(libId) {
    const lib = libById(libId);
    const draft = store.kbIconDraft || { libId, value: lib.icon || "", color: lib.iconColor || "" };
    store.kbIconDraft = draft.libId === libId ? draft : { libId, value: lib.icon || "", color: lib.iconColor || "" };
    const value = store.kbIconDraft.value;
    const colorValue = store.kbIconDraft.color;
    const pair = iconColorPair(colorValue);
    const picker = `<div class="picker kb-icon-picker" role="group" aria-label="知识库图标选择（50 选 1，分 6 组，可留空）">
      ${ICON_GROUPS.map(g => `<div class="picker-group"><div class="picker-group-h"><b>${esc(g.name)}</b><span>${esc(g.hint)}</span></div><div class="picker-group-grid">${g.icons.map(ic => `<button type="button" class="picker-cell" aria-pressed="${value === ic}" data-act="kb-icon-pick" data-id="${ic}" title="${ic}">${icon(ic, "ico-20")}<span class="picker-name">${ic}</span></button>`).join("")}</div></div>`).join("")}
      <button type="button" class="picker-cell picker-clear" aria-pressed="${!value}" data-act="kb-icon-clear" title="清空回来源默认">${icon("x", "ico-14")}<span class="picker-name">默认</span></button>
    </div>
    <div class="swatches" role="group" aria-label="知识库背景色（10 选 1，可回默认色）">
      ${ICON_COLORS.map(sw => `<button type="button" class="swatch" style="background:var(--c51c-${esc(sw.id)}-strong)" aria-pressed="${colorValue === sw.id}" aria-label="背景色 ${esc(ICON_COLOR_LABELS[sw.id] || sw.id)}" data-act="kb-color-pick" data-id="${esc(sw.id)}" title=" "></button>`).join("")}
      <button type="button" class="swatch swatch-clear" aria-pressed="${!colorValue}" aria-label="背景色回默认" data-act="kb-color-clear" title="背景色回默认">${icon("undo", "ico-14")}</button>
    </div>
    <div class="row" style="margin-top:10px;gap:10px"><span class="kb-icon" ${pair ? `style="background:${pair[0]};color:${pair[1]}"` : `style="background:var(--c51c-teal-soft);color:var(--c51c-teal-strong)"`}>${icon(value || KB_SOURCE_DEFAULT[lib.id] || "library", "ico-20")}</span><span class="caption">预览：清空图标回来源默认（本地 bookOpen、网页 globe、组合 layers、未标注 library），清空背景回默认青绿。</span></div>`;
    openDialog(dlgShell("知识库图标", esc(lib.name), picker,
      `<button class="btn" data-act="close-dialog">取消</button><button class="btn primary" data-act="kb-icon-save" data-id="${esc(lib.id)}">保存图标</button>`, "modal-lg"));
  }

  /* main.js 只分发它认识的动作；CR-051 新动作与图标落库用捕获阶段监听实现，避免改动 main.js。 */
  document.addEventListener("click", e => {
    const open = e.target.closest("[data-act='kb-icon-open']");
    const pick = e.target.closest("[data-act='kb-icon-pick']");
    const clear = e.target.closest("[data-act='kb-icon-clear']");
    const colorPick = e.target.closest("[data-act='kb-color-pick']");
    const colorClear = e.target.closest("[data-act='kb-color-clear']");
    const saveIcon = e.target.closest("[data-act='kb-icon-save']");
    const avatarEdit = e.target.closest("[data-act='avatar-edit']");
    const stylePick = e.target.closest("[data-act='avatar-style-pick']");
    const saveSettings = e.target.closest("[data-act='settings-save']");
    const close = e.target.closest("[data-act='close-dialog']");
    if (open) { e.preventDefault(); e.stopPropagation(); kbIconModal(open.dataset.id); return; }
    if (pick || clear) {
      e.preventDefault();
      e.stopPropagation();
      const libId = store.kbIconDraft?.libId;
      store.kbIconDraft = { libId, value: clear ? "" : pick.dataset.id, color: store.kbIconDraft?.color || "" };
      kbIconModal(libId);
      return;
    }
    if (colorPick || colorClear) {
      e.preventDefault();
      e.stopPropagation();
      const libId = store.kbIconDraft?.libId;
      store.kbIconDraft = { libId, value: store.kbIconDraft?.value || "", color: colorClear ? "" : colorPick.dataset.id };
      kbIconModal(libId);
      return;
    }
    if (saveIcon) {
      e.preventDefault();
      e.stopPropagation();
      const lib = libById(saveIcon.dataset.id);
      const value = store.kbIconDraft && store.kbIconDraft.libId === saveIcon.dataset.id ? store.kbIconDraft.value : "";
      const color = store.kbIconDraft && store.kbIconDraft.libId === saveIcon.dataset.id ? store.kbIconDraft.color : "";
      lib.icon = value || undefined;
      lib.iconColor = color || undefined;
      store.kbIconDraft = null;
      closeDialog();
      toast("知识库图标已保存" + (value ? "：" + value + (color ? " · " + (ICON_COLOR_LABELS[color] || color) : "") : "（回来源默认）"));
      UI.render();
      return;
    }
    if (avatarEdit) {
      e.preventDefault();
      e.stopPropagation();
      AvatarModals.open();
      return;
    }
    if (stylePick) {
      e.preventDefault();
      e.stopPropagation();
      store.avatarStyleDraft = stylePick.dataset.id;
      document.body.dataset.avatarStyle = stylePick.dataset.id;
      refreshSettings();
      return;
    }
    if (saveSettings) {
      if (store.avatarStyleDraft) {
        store.avatarStyle = store.avatarStyleDraft;
        try { localStorage.setItem("wb4-avatar-style", store.avatarStyle); } catch { /* 私有模式忽略 */ }
        document.body.dataset.avatarStyle = store.avatarStyle;
        store.avatarStyleDraft = null;
      }
      return;
    }
    if (close) {
      if (store.avatarStyleDraft) {
        document.body.dataset.avatarStyle = store.avatarStyle;
        store.avatarStyleDraft = null;
      }
      store.kbIconDraft = null;
      return;
    }
  }, true);

  /* ================= CR-051 r4～r6：更换头像弹窗（固定 680×660、取景框常驻、拖动摆放、缩放 100–300%）
     交互与 docs/UI/icon-system 设计稿同源：5 内置样式 + 最后一格「自定义」；选图后取景框内即最终显示区域，
     框外遮罩，拖动摆放、缩放；报错在弹窗内呈现并保留原头像；应用同步三处，取消不改；恢复默认回 B Logo。
     已应用的照片重新打开仍可继续拖动/缩放（draft.photo 直接来自 store.avatarPhoto）。 ================= */
  const AVATAR_LOGO = "../brand-assets-v2/logo-sail.png";
  const AVATAR_MAX_BYTES = 200 * 1024;
  const AVATAR_FRAME = 200;
  const AVATAR_SKINS = {
    a: { bg: "transparent", border: "0", radius: "50%", filter: "brightness(0) invert(0)", shadow: "none", img: "88%" },
    b: { bg: "var(--teal-soft)", border: "1px solid var(--teal-line)", radius: "50%", filter: "none", shadow: "none", img: "74%" },
    c: { bg: "var(--teal-soft)", border: "1px solid var(--teal-line)", radius: "10px", filter: "none", shadow: "none", img: "72%" },
    d: { bg: "#0f4c45", border: "1px solid rgba(255,255,255,.14)", radius: "50%", filter: "brightness(0) invert(1)", shadow: "none", img: "72%" },
    e: { bg: "var(--surface)", border: "0", radius: "50%", filter: "none", shadow: "0 0 0 1.5px #0f9f8f, 0 0 0 3px rgba(43,108,246,.28)", img: "72%" }
  };
  function styleAvatarEl(av, styleId, hasPhoto) {
    const skin = AVATAR_SKINS[styleId] || AVATAR_SKINS.b;
    const img = av.querySelector("img");
    av.style.background = skin.bg;
    av.style.border = skin.border;
    av.style.borderRadius = skin.radius;
    av.style.boxShadow = skin.shadow;
    if (img) {
      img.style.filter = hasPhoto ? "none" : skin.filter;
      img.style.width = hasPhoto ? "100%" : skin.img;
      img.style.height = hasPhoto ? "100%" : skin.img;
      img.style.objectFit = hasPhoto ? "cover" : "contain";
    }
  }
  const AvatarModals = {
    draft: null,
    open() {
      this.draft = { style: store.avatarStyle || "b", photo: store.avatarPhoto || null, zoom: 100, offset: { x: 0, y: 0 }, natural: null, scale: 1, mode: store.avatarPhoto ? "custom" : "builtin" };
      const mask = document.createElement("div");
      mask.className = "modal-mask";
      mask.id = "avatar-modal";
      mask.innerHTML = `<div class="avatar-modal" role="dialog" aria-modal="true" aria-labelledby="avatar-modal-title">
        <div class="avatar-modal-h"><b id="avatar-modal-title">更换头像</b><span class="caption">内置样式或自定义图片（≤200KB）</span><button class="icon-btn" type="button" data-act="avatar-modal-close" aria-label="关闭">${icon("x", "ico-14")}</button></div>
        <div class="avatar-modal-b">
          <div class="avatar-preview-col">
            <span class="avatar" id="avatar-draft-preview"><img src="${AVATAR_LOGO}" alt="头像预览"></span>
            <canvas class="avatar-canvas" id="avatar-preview-canvas" width="192" height="192" hidden aria-label="裁剪结果实时预览"></canvas>
            <span class="preview-label" id="avatar-draft-note"></span>
            <span class="caption">应用后同步顶栏、侧栏与设置</span>
          </div>
          <div class="avatar-choose">
            <div class="preset-grid" id="avatar-presets">
              ${["a", "b", "c", "d", "e"].map(s => `<button class="preset" type="button" data-preset="${s}" aria-pressed="false" title="${esc(AVATAR_LABELS[s] || s)}"><span class="avatar"><img src="${AVATAR_LOGO}" alt=""></span><span>${s.toUpperCase()}</span></button>`).join("")}
              <button class="preset custom" type="button" data-preset="custom" aria-pressed="false" title="自定义图片"><span class="plus">${icon("camera", "ico-14")}</span><span>自定义</span></button>
            </div>
            <div class="crop" id="avatar-crop">
              <div class="crop-stage" id="avatar-crop-stage" aria-label="拖动图片调整头像显示区域">
                <img id="avatar-crop-img" alt="">
                <div class="crop-mask" id="avatar-crop-mask"></div>
              </div>
              <div class="crop-empty" id="avatar-crop-empty" hidden>选择「自定义」并上传图片后，可在这里拖动调整</div>
              <p class="crop-hint">${icon("hand")}<span id="avatar-crop-hint">框内就是最终显示区域，框外不会出现在头像里。</span></p>
              <div class="crop-row"><span class="caption">缩放</span><input type="range" id="avatar-zoom" min="100" max="300" step="1" value="100" aria-label="缩放头像"><span class="value" id="avatar-zoom-value">100%</span></div>
              <div class="crop-row"><button class="btn sm" type="button" id="avatar-repick">选择图片</button><span class="caption" id="avatar-file-name">未选择文件</span></div>
            </div>
            <p class="upload-error" id="avatar-error" hidden role="alert"></p>
            <span class="caption">PNG / JPG / WebP，≤200KB；建议 ≥256×256。图片只保存在本机，不上传网络、不进入知识库或会话。</span>
            <input type="file" id="avatar-file" accept="image/png,image/jpeg,image/webp" hidden>
          </div>
        </div>
        <div class="avatar-modal-f"><button class="btn" type="button" id="avatar-reset">恢复默认 Logo</button><span class="spacer"></span><button class="btn" type="button" data-act="avatar-modal-close">取消</button><button class="btn primary" type="button" id="avatar-apply">应用</button></div>
      </div>`;
      document.body.appendChild(mask);
      this.mask = mask;
      this.bind();
      this.render();
      if (this.draft.photo) this.loadNatural(this.draft.photo);
      const closeBtn = mask.querySelector("[data-act='avatar-modal-close']");
      if (closeBtn) closeBtn.focus();
    },
    close() {
      if (this.mask) { this.mask.remove(); this.mask = null; }
      this.draft = null;
      document.removeEventListener("keydown", this.onKey);
    },
    showError(msg) { const el = this.mask && this.mask.querySelector("#avatar-error"); if (el) { el.textContent = msg; el.hidden = false; } },
    clearError() { const el = this.mask && this.mask.querySelector("#avatar-error"); if (el) el.hidden = true; },
    bind() {
      const mask = this.mask;
      mask.addEventListener("click", e => {
        if (e.target === mask || e.target.closest("[data-act='avatar-modal-close']")) { e.stopPropagation(); this.close(); }
      });
      this.onKey = ev => { if (ev.key === "Escape") this.close(); };
      document.addEventListener("keydown", this.onKey);
      mask.querySelector("#avatar-presets").addEventListener("click", e => {
        const b = e.target.closest("[data-preset]");
        if (!b || !this.draft) return;
        this.clearError();
        const id = b.dataset.preset;
        if (id === "custom") {
          this.draft.mode = "custom";
          this.render();
          mask.querySelector("#avatar-file").click();
        } else {
          this.draft.mode = "builtin";
          this.draft.style = id;
          this.draft.photo = null;
          this.draft.natural = null;
          this.draft.zoom = 100;
          this.draft.offset = { x: 0, y: 0 };
          mask.querySelector("#avatar-file-name").textContent = "未选择文件";
          this.render();
        }
      });
      mask.querySelector("#avatar-zoom").addEventListener("input", ev => {
        if (!this.draft || this.draft.mode !== "custom" || !this.draft.photo) return;
        this.draft.zoom = Number(ev.target.value);
        mask.querySelector("#avatar-zoom-value").textContent = this.draft.zoom + "%";
        this.layoutCrop();
        this.drawPreview();
      });
      mask.querySelector("#avatar-repick").addEventListener("click", () => { this.clearError(); mask.querySelector("#avatar-file").click(); });
      mask.querySelector("#avatar-file").addEventListener("change", ev => {
        if (!this.draft) return;
        this.clearError();
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { this.showError("不支持的文件类型。请选择 PNG、JPG 或 WebP 图片；当前头像保持不变。"); ev.target.value = ""; return; }
        if (file.size > AVATAR_MAX_BYTES) { this.showError("图片超过 200KB。请压缩后再上传；当前头像保持不变。"); ev.target.value = ""; return; }
        const reader = new FileReader();
        reader.onerror = () => this.showError("读取图片失败，当前头像保持不变。请重试或选择其他文件。");
        reader.onload = () => {
          this.draft.mode = "custom";
          this.draft.photo = String(reader.result);
          this.draft.zoom = 100;
          this.draft.offset = { x: 0, y: 0 };
          this.draft.natural = null;
          mask.querySelector("#avatar-file-name").textContent = file.name + " · " + Math.max(1, Math.round(file.size / 1024)) + "KB";
          this.render();
          this.loadNatural(this.draft.photo);
        };
        reader.readAsDataURL(file);
      });
      mask.querySelector("#avatar-reset").addEventListener("click", () => {
        if (!this.draft) return;
        this.clearError();
        this.draft.mode = "builtin";
        this.draft.style = "b";
        this.draft.photo = null;
        this.draft.zoom = 100;
        this.draft.offset = { x: 0, y: 0 };
        this.draft.natural = null;
        mask.querySelector("#avatar-file").value = "";
        mask.querySelector("#avatar-file-name").textContent = "未选择文件";
        this.render();
      });
      const stage = mask.querySelector("#avatar-crop-stage");
      stage.addEventListener("pointerdown", e => {
        if (!this.draft || this.draft.mode !== "custom" || !this.draft.photo) return;
        this.dragging = { x: e.clientX, y: e.clientY, ox: this.draft.offset.x, oy: this.draft.offset.y };
        stage.setPointerCapture(e.pointerId);
      });
      stage.addEventListener("pointermove", e => {
        if (!this.dragging || !this.draft) return;
        this.draft.offset.x = this.dragging.ox + (e.clientX - this.dragging.x);
        this.draft.offset.y = this.dragging.oy + (e.clientY - this.dragging.y);
        this.layoutCrop();
        this.drawPreview();
      });
      const endDrag = () => { this.dragging = null; };
      stage.addEventListener("pointerup", endDrag);
      stage.addEventListener("pointercancel", endDrag);
      mask.querySelector("#avatar-apply").addEventListener("click", () => this.apply());
    },
    loadImage(src) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("图片无法解码"));
        img.src = src;
      });
    },
    async loadNatural(src) {
      try {
        const img = await this.loadImage(src);
        if (!this.draft || this.draft.photo !== src) return;
        this.draft.natural = { w: img.naturalWidth, h: img.naturalHeight };
        this.layoutCrop();
        this.drawPreview();
      } catch (err) {
        this.showError("图片无法解码，请重新选择；当前头像保持不变。");
      }
    },
    layoutCrop() {
      const draft = this.draft;
      const cropImg = this.mask && this.mask.querySelector("#avatar-crop-img");
      if (!draft || !draft.natural || !cropImg) return;
      const n = draft.natural;
      const scale = Math.max(AVATAR_FRAME / n.w, AVATAR_FRAME / n.h) * (draft.zoom / 100);
      const W = n.w * scale, H = n.h * scale;
      const limX = Math.max(0, (W - AVATAR_FRAME) / 2), limY = Math.max(0, (H - AVATAR_FRAME) / 2);
      draft.offset.x = Math.max(-limX, Math.min(limX, draft.offset.x));
      draft.offset.y = Math.max(-limY, Math.min(limY, draft.offset.y));
      draft.scale = scale;
      cropImg.style.width = W + "px";
      cropImg.style.height = H + "px";
      cropImg.style.transform = "translate(-50%,-50%) translate(" + draft.offset.x + "px," + draft.offset.y + "px)";
      const maskEl = this.mask.querySelector("#avatar-crop-mask");
      if (maskEl) maskEl.classList.toggle("square", draft.style === "c");
    },
    drawPreview() {
      const draft = this.draft;
      const cropImg = this.mask && this.mask.querySelector("#avatar-crop-img");
      const canvas = this.mask && this.mask.querySelector("#avatar-preview-canvas");
      if (!draft || !draft.natural || !draft.photo || !cropImg || !canvas) return;
      const n = draft.natural;
      const scale = draft.scale || Math.max(AVATAR_FRAME / n.w, AVATAR_FRAME / n.h);
      const W = n.w * scale, H = n.h * scale;
      const sx = ((W - AVATAR_FRAME) / 2 - draft.offset.x) / scale;
      const sy = ((H - AVATAR_FRAME) / 2 - draft.offset.y) / scale;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(cropImg, sx, sy, AVATAR_FRAME / scale, AVATAR_FRAME / scale, 0, 0, canvas.width, canvas.height);
    },
    async apply() {
      const draft = this.draft;
      if (!draft) return;
      this.clearError();
      try {
        if (draft.mode === "custom" && draft.photo && draft.natural) {
          const n = draft.natural;
          const scale = draft.scale || Math.max(AVATAR_FRAME / n.w, AVATAR_FRAME / n.h) * (draft.zoom / 100);
          const W = n.w * scale, H = n.h * scale;
          const sx = ((W - AVATAR_FRAME) / 2 - draft.offset.x) / scale;
          const sy = ((H - AVATAR_FRAME) / 2 - draft.offset.y) / scale;
          const img = this.mask.querySelector("#avatar-crop-img");
          const source = img && img.complete && img.naturalWidth ? img : await this.loadImage(draft.photo);
          const size = 256;
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          canvas.getContext("2d").drawImage(source, sx, sy, AVATAR_FRAME / scale, AVATAR_FRAME / scale, 0, 0, size, size);
          store.avatarPhoto = canvas.toDataURL("image/png");
        } else {
          store.avatarPhoto = null;
        }
        store.avatarStyle = draft.style;
        try { localStorage.setItem("wb4-avatar-style", draft.style); } catch { /* 私有模式忽略 */ }
        document.body.dataset.avatarStyle = draft.style;
        store.avatarDraft = null;
        this.close();
        UI.render();
        toast("头像已应用" + (store.avatarPhoto ? "（自定义图片）" : "") + "：风格 " + draft.style.toUpperCase());
      } catch (err) {
        this.showError("头像处理失败，请重新选择图片；当前头像保持不变。");
      }
    },
    render() {
      const draft = this.draft;
      const mask = this.mask;
      if (!draft || !mask) return;
      mask.querySelectorAll("#avatar-presets [data-preset]").forEach(b => {
        const id = b.dataset.preset;
        const selected = id === "custom" ? draft.mode === "custom" : draft.mode === "builtin" && draft.style === id;
        b.setAttribute("aria-pressed", String(selected));
        if (id === "custom") {
          b.innerHTML = draft.photo
            ? `<img class="preset-thumb" src="${draft.photo}" alt=""><span>自定义</span>`
            : `<span class="plus">${icon("camera", "ico-14")}</span><span>自定义</span>`;
        } else {
          const av = b.querySelector(".avatar");
          if (av) styleAvatarEl(av, id, false);
        }
      });
      const hasPhoto = draft.mode === "custom" && Boolean(draft.photo);
      const preview = mask.querySelector("#avatar-draft-preview");
      const img = preview.querySelector("img");
      if (img) img.src = hasPhoto ? draft.photo : AVATAR_LOGO;
      preview.hidden = hasPhoto;
      styleAvatarEl(preview, draft.style, hasPhoto);
      const canvas = mask.querySelector("#avatar-preview-canvas");
      if (canvas) {
        canvas.hidden = !hasPhoto;
        canvas.classList.toggle("square", draft.style === "c");
      }
      mask.querySelector("#avatar-draft-note").textContent = hasPhoto ? "自定义图片 · 容器 " + draft.style.toUpperCase() : (AVATAR_LABELS[draft.style] || draft.style);
      const noPhotoCustom = draft.mode === "custom" && !draft.photo;
      const stage = mask.querySelector("#avatar-crop-stage");
      const empty = mask.querySelector("#avatar-crop-empty");
      if (stage) stage.hidden = noPhotoCustom;
      if (empty) empty.hidden = !noPhotoCustom;
      const cropWrap = mask.querySelector("#avatar-crop");
      if (cropWrap) cropWrap.classList.toggle("is-disabled", !hasPhoto);
      const zoomInput = mask.querySelector("#avatar-zoom");
      if (zoomInput) {
        zoomInput.disabled = !hasPhoto;
        zoomInput.value = String(draft.zoom);
      }
      mask.querySelector("#avatar-zoom-value").textContent = draft.zoom + "%";
      mask.querySelector("#avatar-crop-hint").textContent = hasPhoto
        ? "拖动图片调整位置；框内就是最终显示区域，框外不会出现在头像里。"
        : draft.mode === "builtin"
          ? "内置样式使用品牌 Logo，无需裁剪；切换「自定义」可上传图片并调整。"
          : "上传图片后可在这里拖动调整。";
      mask.querySelector("#avatar-repick").textContent = hasPhoto ? "重新选择" : "选择图片";
      mask.querySelector("#avatar-crop-mask").classList.toggle("square", draft.style === "c");
      const cropImg = mask.querySelector("#avatar-crop-img");
      if (hasPhoto) {
        if (cropImg.getAttribute("src") !== draft.photo) cropImg.src = draft.photo;
        if (draft.natural) { this.layoutCrop(); this.drawPreview(); }
      } else if (cropImg) {
        cropImg.src = AVATAR_LOGO;
        cropImg.style.width = "150px";
        cropImg.style.height = "150px";
        cropImg.style.objectFit = "contain";
        cropImg.style.transform = "translate(-50%, -50%)";
        draft.scale = 1;
      }
    }
  };

  Screens.knowledgePage = knowledgePage;
  Screens.serversPage = serversPage;
  Screens.library = libraryPage;
  Screens.server = serverPage;
  Screens.openSettings = openSettings;
  Screens.refreshSettings = refreshSettings;
  Screens.grantModal = grantModal;
  Screens.providerModal = providerModal;
  Screens.modelPickDialog = modelPickDialog;
  Screens.skillModal = skillModal;
  Screens.mcpModal = mcpModal;
})();











