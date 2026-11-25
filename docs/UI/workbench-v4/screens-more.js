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
          <!-- CR-070：知识库图标改由卡片图标砖悬浮层选择；此处保留原「图标」按钮入口（改开悬浮层）。 -->
          <div class="kb-main"><b>${esc(lib.name)}</b><p>${esc(lib.desc)} · ${esc(lib.owner)}</p>
            <div class="kb-tags">${lib.allProjects ? `<span class="tag green">所有项目可用</span>` : lib.grantedTo.length ? lib.grantedTo.map(p => `<span class="tag blue">${esc((D.projects.find(x => x.id === p) || {}).name || p)}</span>`).join("") : `<span class="tag gray">未授权</span>`}</div></div>
          <div class="kb-side"><span>${(D.knowledge.docs[lib.id] || []).length} 篇</span><span>${esc(lib.updated)}</span>
            <button class="btn sm" data-c070-open="${esc(lib.id)}" data-c070-kind="kb" title="选择内置图标">${icon("palette", "ico-14")}图标</button>
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
    ["probe", "模型检测", "shield"],
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
        <div class="set-nav-f"><span class="caption">设计演示 · UI-CR068-v2</span></div>
      </aside>
      <section class="set-body">
        <button class="icon-btn settings-close" data-act="close-dialog" aria-label="关闭设置" title="关闭设置">${icon("x", "ico-18")}</button>
        <div class="set-head"><div><h2>${esc((SET_NAV.find(x => x[0] === tab) || [])[1])}</h2><p class="caption">${esc(setSub(tab))}</p></div>${tab === "models" ? `<button class="icon-btn set-head-imagegen" data-act="imagegen-open" title="生图配置" aria-label="生图配置">${icon("image", "ico-18")}</button>` : ""}</div>
        <div class="set-scroll">${setContent(tab)}</div>
      </section>
    </div>`;
  }
  function setSub(tab) {
    return { general: "数据存储、用户信息、代码样式与服务器默认值。", models: "供应商、密钥、端点与模型配置。", probe: "固定 19+1 针黑盒探针，检测中转掺水；P20 行为指纹给出「最像的已知候选」归因提示。", cli: "CLI 管理与 SDK 管理。", skills: "技能是过程性指令；启用不等于授权执行。", mcp: "MCP 服务器发现工具与资源。", tools: "内置工具与风险等级。" }[tab] || "";
  }

  function setContent(tab) {
    const g = D.settings.general;
    if (tab === "general") {
      const current = store.avatarDraft || store.avatarStyle || "b";
      const avatarRadio = `<div class="avatar-radio-row" role="radiogroup" aria-label="头像风格">
        ${["a", "b", "c", "d", "e"].map(s => `<button class="avatar-radio" type="button" role="radio" aria-checked="${current === s}" data-act="avatar-style-pick" data-id="${s}">${avatarHtml("sm", "")}<b>${esc((UI.AVATAR_LABELS[s] || s).replace(/^[a-e] /, ""))}</b></button>`).join("")}
      </div>`;
      return `<div class="set-section"><h3>数据存储</h3>
        <div class="set-field"><div class="f-label"><b>数据存储位置</b><span>默认安装目录下的 data；本项目数据都在这里按类分开：db 数据库与会话、chat 会话文件、knowledge 知识库、skills 技能、mcp、secrets 密钥、avatar、logs、editor、git、recycle、index、examples。改位置需重启生效，重启时旧数据迁入新位置，不覆盖同名文件</span></div><div class="f-control row"><input class="input mono" id="gen-data-dir" value="${esc(g.dataDir || "安装目录/data")}" aria-label="数据存储位置"><button class="btn" data-act="pick-data-dir">选择目录</button></div></div>
        <div class="set-field"><div class="f-label"><b>知识库目录</b><span>选定位置下 knowledge/库名；可直接把文件拷进该文件夹，刷新目录后进入索引</span></div><div class="f-control"><span class="caption mono">${esc((g.dataDir || "安装目录/data"))}/knowledge</span></div></div></div>
      <div class="set-section"><h3>用户基本信息</h3>
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
      return `<div class="row between" style="margin-bottom:14px"><span class="caption">${D.settings.providers.length} 个供应商 · 拖动手柄排序 · 点击卡片展开配置</span><button class="btn sm primary" data-act="provider-new">${icon("plus", "ico-14")}新建供应商</button></div>
        <div class="provider-sort-list" aria-label="供应商列表（可拖动排序）">${D.settings.providers.map(providerBlock).join("")}</div>
        <div class="note-box info">${icon("shield", "ico-14")} 密钥只保存引用占位；指纹检测按意见移除（CR-058 改为左栏独立页签「模型检测」）。CR-059：高级配置（请求头/请求伪装）已移除，协议不再提供 Gemini。</div>`;
    }
    if (tab === "probe") return probeSection();
    if (tab === "cli") {
      return `<div class="cli-tabs"><button class="${store.sdkTab === "cli" ? "on" : ""}" data-act="sdk-tab" data-tab="cli">CLI 管理</button><button class="${store.sdkTab === "sdk" ? "on" : ""}" data-act="sdk-tab" data-tab="sdk">SDK 管理</button></div>
        ${store.sdkTab === "sdk" ? sdkList() : cliList()}`;
    }
    if (tab === "skills") return skillList();
    if (tab === "mcp") return mcpList();
    return toolList();
  }

  /* CR-059：供应商卡片——移除名称缩写 logo，左侧为拖动手柄；页签只剩 供应商配置 / 模型配置。 */
  function providerBlock(p) {
    const open = store.providerOpen === p.id;
    const tab = store.providerTab === "advanced" ? "config" : (store.providerTab || "config");
    const tabs = [["config", "供应商配置"], ["models", "模型配置"]];
    return `<div class="provider-card ${open ? "open" : ""}" data-provider-card="${esc(p.id)}">
      <div class="provider-h">
        <button class="drag-handle" data-drag-provider="${esc(p.id)}" title="拖动排序（键盘：Alt+↑/↓）" aria-label="拖动排序供应商 ${esc(p.name)}">${icon("drag", "ico-14")}</button>
        <span class="pinfo" data-act="provider-expand" data-id="${p.id}" role="button" tabindex="0"><b>${esc(p.name)}</b><span>${esc(p.protocol)} · ${p.keys.length} 个密钥 · ${p.endpoints.length} 个端点 · ${p.models.length} 个模型</span></span>
        <span class="status ${p.enabled ? "green" : "gray"}">${p.enabled ? "启用" : "停用"}</span>
        <button class="switch" data-act="provider-toggle" data-id="${p.id}" aria-checked="${p.enabled}"></button>
        <button class="icon-btn" data-act="provider-delete" data-id="${p.id}" title="删除供应商">${icon("trash")}</button>
        <span class="chev" data-act="provider-expand" data-id="${p.id}">${icon(open ? "chevronUp" : "chevronDown")}</span>
      </div>
      ${open ? `<div class="provider-inline">
        <div class="pm-tabs">${tabs.map(([k, l]) => `<button class="${tab === k ? "on" : ""}" data-act="provider-tab" data-tab="${k}">${l}</button>`).join("")}</div>
        <div class="pm-body">${tab === "models" ? providerModels(p) : providerConfig(p)}</div>
        <div class="pm-f"><span class="caption">模型修改随供应商一并保存</span><span class="spacer"></span><button class="btn" data-act="provider-discard" data-id="${p.id}">放弃修改</button><button class="btn primary" data-act="provider-save" data-id="${p.id}">保存供应商</button></div>
      </div>` : ""}
    </div>`;
  }

  function refreshSettings() {
    const body = document.querySelector(".set-scroll");
    if (body) body.innerHTML = setContent(store.settingsTab);
  }

  /* CR-059 D：CLI 管理——移除任务难度/CLI 级任务类型；5 模型槽＋兜底的任务路由；中文权限挡位与 AI 侧栏一致。
     加载演示：首帧渲染缓存（store.cliCache），后台逐项「检测中…」渐进上屏（cr059WarmCli）。 */
  const PERM_LABEL = { default: "默认模式", plan: "规划模式", agent: "代理模式", auto: "自动审核", full: "完全访问" };
  function cliList() {
    return `<div class="caption cli-load-note">${icon("clock", "ico-14")} 打开即显示上次缓存，后台并发刷新（演示）；「重新检测」强制刷新。</div>
      <div class="stack-sm">${D.settings.clis.map(c => `<div class="cli-row ${c.expandable ? "expandable" : ""}">
      <div class="cli-h">${Screens.cliTile(c.id, 34)}<span class="cli-info"><b>${esc(c.name)} ${c.badge ? `<span class="tag blue">${esc(c.badge)}</span>` : ""}</b><span>${esc(c.meta)}</span></span>
        <span class="cli-version mono">${esc(c.version || "—")}${store.cliChecking === c.id ? ` <span class="tag blue">检测中…</span>` : ""}</span>
        <span class="tag ${c.installed ? (c.enabled ? "green" : "gray") : "gray"}">${c.installed ? (c.enabled ? "启用" : "停用") : "未安装"}</span>
        <button class="switch" aria-checked="${c.enabled}" data-act="cli-toggle" data-id="${c.id}" ${c.installed ? "" : "disabled"}></button>
        ${c.expandable ? `<button class="icon-btn" data-act="cli-expand" data-id="${c.id}">${icon(store.cliOpen === c.id ? "chevronUp" : "chevronDown")}</button>` : ""}</div>
      ${c.expandable && store.cliOpen === c.id ? cliBody(c) : ""}</div>`).join("")}</div>`;
  }

  function cliModelOptions(c) {
    /* 协议兼容过滤（演示）：claude→Anthropic 系；codex/grok→OpenAI 系。 */
    return window.CR068.catalog(c.id).flatMap(g => g.models.map(m => `${g.name} · ${m.name}`));
  }

  function cliBody(c) {
    /* CR-059 r5：单行折叠路由。行首标签＝模型1…模型5／兜底模型，样式完全一致；模型标签悬浮显示 ×（可删），
       兜底标签无 ×（不可删）。点行展开唯一详情区，点标签切换当前配置。兜底同样含思考等级。 */
    const slots = c.slots || [];
    const opts = cliModelOptions(c);
    const efforts = ["off", "low", "medium", "high", "xhigh", "max"];
    const perms = D.ai.permissions;
    const atLimit = slots.length >= 5;
    const open = !!store.cliRouteOpen?.[c.id];
    const sel = store.cliRouteSel?.[c.id] || "fallback";
    const selIdx = sel === "fallback" ? -1 : Number(sel);
    const slot = selIdx >= 0 ? slots[selIdx] : null;
    const modelSelect = (value, attr) => `<select class="select" ${attr}><option value="">未选择</option>${opts.map(o => `<option${value === o ? " selected" : ""}>${esc(o)}</option>`).join("")}${value && !opts.includes(value) ? `<option selected>${esc(value)}（不可用）</option>` : ""}</select>`;
    const effortSelect = (value, attr) => `<select class="select" ${attr}><option value="">沿用会话</option>${efforts.map(e => `<option${value === e ? " selected" : ""}>${e}</option>`).join("")}</select>`;
    /* 标签：模型与兜底同一结构、字号与内边距；仅模型标签在悬浮/键盘聚焦时显示 × 删除。 */
    const tab = (key, label, removable) => `<span class="route-tab-wrap">
        <button type="button" role="tab" aria-selected="${sel === key}" class="route-tab ${sel === key ? "on" : ""} ${removable ? "removable" : ""}" data-act="cli-slot-select" data-id="${c.id}" data-slot="${key}">${label}</button>
        ${removable ? `<button type="button" class="route-x" data-act="cli-slot-remove" data-id="${c.id}" data-slot="${key}" title="删除${esc(label)}" aria-label="删除${esc(label)}">${icon("close", "ico-12")}</button>` : ""}
      </span>`;
    const detail = sel === "fallback" ? `
      <div class="two-col">
        <div><label>兜底模型</label>${modelSelect(c.fallback?.model || "", `data-cli-slot="${c.id}:fallback:model" aria-label="${esc(c.name)} 兜底模型"`)}</div>
        <div><label>思考等级</label>${effortSelect(c.fallback?.effort || "", `data-cli-slot="${c.id}:fallback:effort" aria-label="${esc(c.name)} 兜底思考等级"`)}</div>
      </div>
      <p class="route-note">任一模型槽不可用时使用；默认与主 agent 当前选择一致（实时跟随）。兜底模型不可删除。</p>`
      : `<div class="two-col">
          <div><label>模型</label>${modelSelect(slot?.model || "", `data-cli-slot="${c.id}:${selIdx}:model"`)}</div>
          <div><label>思考等级</label>${effortSelect(slot?.effort || "", `data-cli-slot="${c.id}:${selIdx}:effort"`)}</div>
        </div>
        <div><label>执行任务类型</label><div class="chips">${D.settings.taskTypes.map(t => `<button class="chip ${(slot?.types || []).includes(t) ? "on" : ""}" data-act="cli-slot-type" data-id="${c.id}" data-slot="${selIdx}" data-type="${t}">${t}</button>`).join("")}</div></div>
        <div class="route-detail-f"><button type="button" class="link-btn danger" data-act="cli-slot-remove" data-id="${c.id}" data-slot="${selIdx}">${icon("trash", "ico-14")}删除此模型槽</button></div>`;
    return `<div class="cli-body">
      <div class="caption">由主 agent 决定使用哪个 CLI；这里只配置该 CLI 内「哪类任务用哪个模型」。模型不可用时使用兜底模型。</div>
      <div class="route-card ${open ? "open" : ""}">
        <div class="route-bar">
          <div class="route-tabs" role="tablist" aria-label="${esc(c.name)} 任务模型路由">
            ${tab("fallback", "兜底模型", false)}
            ${slots.map((s, i) => tab(String(i), `模型${i + 1}`, true)).join("")}
            ${atLimit ? "" : `<button type="button" class="route-add" data-act="cli-slot-add" data-id="${c.id}" title="新增模型槽（最多 5 个）" aria-label="新增模型槽">${icon("plus", "ico-14")}新增</button>`}
          </div>
          <span class="spacer"></span>
          <span class="route-sum">${slots.length ? `${slots.length}/5` : "仅兜底"}</span>
          <button type="button" class="route-toggle" data-act="cli-route-toggle" data-id="${c.id}" aria-expanded="${open}" aria-label="${open ? "收起模型配置" : "展开模型配置"}">${icon(open ? "chevronUp" : "chevronDown", "ico-14")}</button>
        </div>
        ${open ? `<div class="route-detail">${detail}</div>` : ""}
      </div>
      <div><label>权限模式</label><select class="select" id="cli-perm-${c.id}" data-cli-perm="${c.id}">${perms.map(p => `<option value="${p.id}"${c.permission === p.id ? " selected" : ""}${p.enabled === false ? " disabled" : ""}>${esc(p.name)}${p.enabled === false ? "（暂未核验）" : ""}</option>`).join("")}</select>
        <div class="caption">与 AI 侧栏权限挡位一致；自动审核 / 完全访问在原生通道核验前不可选。</div></div>
      <div class="row"><button class="btn sm primary" data-act="cli-save" data-id="${c.id}">保存</button><button class="btn sm" data-act="cli-check" data-id="${c.id}">重新检测</button><span class="caption">保存仅影响之后的新会话。</span></div>
    </div>`;
  }

  /* CR-059 E：SDK 管理——严格按图2：官方 logo＋名称＋包名＋版本＋箭头；展开区＝目标版本下拉＋刷新版本、
     当前版本/卸载/重新检测/安装目标版本、版本摘要、路径。版本列表＝最新 10 稳定版＋当前版补入。 */
  function sdkList() {
    return `<div class="sdk-registry"><label>npm registry</label><div class="row"><input class="input" value="https://registry.npmmirror.com"><button class="btn sm" data-act="toast" data-msg="演示：registry 已保存">保存</button><button class="btn sm" data-act="sdk-check-all">全部重新检测</button></div><div class="caption">可选，镜像源；保存后对后续安装生效。打开页签即显示缓存并后台刷新（演示）。</div></div>
      <div class="sdk-cards">${D.settings.sdks.map(sdkCard).join("")}</div>`;
  }

  function sdkVersionOptions(s) {
    const list = (s.versions || []).slice(0, 10);
    const cur = String(s.version || "").replace(/^v/, "");
    const opts = list.map((v, i) => `<option value="${esc(v)}"${i === 0 ? " selected" : ""}>${esc(v)}${i === 0 ? "（最新稳定）" : ""}</option>`);
    if (cur && cur !== "—" && !list.includes(cur)) opts.push(`<option value="${esc(cur)}">${esc(cur)}（当前）</option>`);
    return opts.join("");
  }

  function sdkCard(s) {
    const open = store.sdkOpen === s.id;
    const status = s.builtin ? "内置" : !s.installed ? "未安装" : s.version === s.latest ? "已安装" : "有更新";
    const tone = s.builtin ? "gray" : !s.installed ? "gray" : s.version === s.latest ? "green" : "amber";
    const checking = store.sdkChecking === s.id;
    return `<div class="sdk-card ${s.builtin ? "builtin" : ""} ${open ? "open" : ""}">
      <div class="sdk-card-h" data-act="sdk-expand" data-id="${s.id}">
        <span class="sdk-logo-official">${s.builtin ? icon("box", "ico-20") : Screens.cliTile(s.id, 30)}</span>
        <span class="sdk-info"><b>${esc(s.name)} <span class="tag ${tone}">${status}</span>${checking ? ` <span class="tag blue">检测中…</span>` : ""}${!s.builtin && s.installed && s.version !== s.latest ? ` <span class="mono sdk-to">${esc(s.version)} → ${esc(s.latest)}</span>` : ""}</b><span>${esc(s.package || s.desc)}</span></span>
        <span class="sdk-version mono">${esc(s.version)}</span>
        <span class="sdk-chev">${icon(open ? "chevronUp" : "chevronDown", "ico-14")}</span>
      </div>
      ${open ? `<div class="sdk-body">
        ${s.builtin ? `<div class="caption">随宿主安装，无需 npm 安装或升级。</div><div class="sdk-path mono">${esc(s.path)}</div>` : `
        <div class="sdk-field"><label>目标版本</label><div class="row"><select class="select" aria-label="${esc(s.name)} 目标版本">${store.sdkVersionsReady === false ? `<option>最新稳定版（加载中…）</option>` : sdkVersionOptions(s)}</select><button class="btn sm" data-act="sdk-versions-refresh" data-id="${s.id}">${icon("refresh", "ico-14")}刷新版本</button></div><div class="caption">只列正式版（不含 alpha / beta）· 最新 10 个稳定版，当前版不在其中时补入 · 当前平台 win32-x64</div></div>
        <div class="row sdk-actions"><button class="btn sm" disabled>当前版本 ${esc(s.version)}</button>${s.installed ? `<button class="btn sm danger" data-act="sdk-uninstall" data-id="${s.id}">卸载</button>` : ""}<button class="btn sm" data-act="sdk-check" data-id="${s.id}">重新检测</button><button class="btn sm primary" data-act="sdk-install" data-id="${s.id}">${s.installed ? "安装目标版本" : "安装"}</button></div>
        <div class="sdk-meta">当前版本 ${esc(s.version)} · 最新稳定 ${esc(s.latest)}</div>
        <div class="sdk-path mono">${esc(s.path)}</div>`}
      </div>` : ""}
    </div>`;
  }

  /* CR-059 F1/F2：Skill 添加＝选择本地文件夹识别；导入＝扫描其他 agent 技能目录勾选。副本归受管目录。 */
  function skillList() {
    return `<div class="row between" style="margin-bottom:12px"><span class="caption">${D.settings.skills.length} 个技能 · 导入后为受管副本，外部删除不影响</span><div class="row"><button class="btn sm" data-act="skill-scan-open">${icon("search", "ico-14")}扫描导入</button><button class="btn sm primary" data-act="skill-add">${icon("folderPlus", "ico-14")}添加技能</button></div></div>
      <div class="card">${D.settings.skills.map((s, i) => `<div class="cap-row"><span class="kb-icon blue" style="width:32px;height:32px;border-radius:8px">${icon("layers", "ico-16")}</span>
        <span class="cap-main"><b>${esc(s.name)} <span class="mono muted" style="font-size:11px">/${esc(s.slug)}</span></b><span>${esc(s.desc)} · 来源 ${esc(s.source)} · ${esc(s.updated)}</span></span>
        <button class="switch" aria-checked="${s.on}" data-act="skill-toggle" data-idx="${i}"></button></div>`).join("")}</div>`;
  }

  function skillAddDialog() {
    const picked = store.skillFolderPick || null;
    const folder = picked ? D.settings.skillFolders.find(f => f.path === picked) : null;
    const body = `<div class="form-grid">
      <div class="form-row"><label>技能文件夹</label>
        <div class="row"><button class="btn sm" data-act="skill-folder-choose">${icon("folderOpen", "ico-14")}选择文件夹…</button><span class="mono caption">${picked ? esc(picked) : "未选择（需包含 SKILL.md）"}</span></div>
        <small>演示：点击后模拟系统文件夹选择框；正式实现调用系统目录选择对话框。</small></div>
      ${folder && !folder.valid ? `<div class="note-box warn">所选文件夹没有 SKILL.md，无法识别为技能。请选择包含 SKILL.md 的文件夹（结构：&lt;文件夹&gt;/SKILL.md，可含附属资源）。</div>` : ""}
      ${folder && folder.valid ? `
      <div class="form-row"><label>识别结果</label><input class="input" id="sk-name" value="${esc(folder.name)}"></div>
      <div class="form-row"><label>标识（slug）</label><input class="input mono" id="sk-slug" value="${esc(folder.slug)}"></div>
      <div class="form-row"><label>说明</label><input class="input" id="sk-desc" value="${esc(folder.desc)}"></div>
      <div class="form-row"><label>正文预览（SKILL.md）</label><textarea class="textarea mono" rows="5" readonly>${esc(folder.body)}</textarea></div>
      <div class="caption">确认后整目录复制到受管技能目录（app_data_dir/skills/&lt;slug&gt;/）；外部源后续删除或修改不影响副本。</div>` : ""}
    </div>`;
    openSubDialog(dlgShell("添加技能", "选择本地文件夹 → 识别 SKILL.md → 复制为受管副本", body, `<button class="btn" data-act="close-sub">取消</button><button class="btn primary" data-act="skill-folder-save"${folder && folder.valid ? "" : " disabled"}>添加到我的技能</button>`));
  }

  function skillFolderChooseDialog() {
    const body = `<div class="folder-list">${D.settings.skillFolders.map(f => `<button class="folder-row" data-act="skill-folder-pick" data-path="${esc(f.path)}">${icon("folder", "ico-16")}<span class="mono">${esc(f.path)}</span>${f.valid ? `<span class="tag green">含 SKILL.md</span>` : `<span class="tag gray">无 SKILL.md</span>`}</button>`).join("")}</div>
      <div class="caption">演示夹具：模拟系统文件夹选择框的候选目录；正式实现为原生目录选择对话框，不限于这些路径。</div>`;
    openSubDialog(dlgShell("选择技能文件夹", "演示：模拟系统文件夹选择框", body, `<button class="btn" data-act="skill-add-back">返回</button>`));
  }

  function skillScanDialog() {
    if (!store.skillScanSel) store.skillScanSel = {};
    const sources = D.settings.skillSources;
    const total = sources.reduce((n, s) => n + s.items.filter(x => !x.imported && !D.settings.skills.some(k => k.slug === x.slug)).length, 0);
    const body = `<div class="scan-list">${sources.map(src => `<div class="scan-group">
      <div class="scan-group-h">${icon("bot", "ico-14")}<b>${esc(src.agent)}</b><span class="mono caption">${esc(src.root)}</span></div>
      ${src.items.map(it => {
        const imported = it.imported || D.settings.skills.some(k => k.slug === it.slug);
        const key = src.agent + ":" + it.slug;
        const on = !!store.skillScanSel[key];
        return `<label class="scan-row ${imported ? "imported" : ""}"><input type="checkbox" data-scan-skill="${esc(key)}"${on ? " checked" : ""}${imported ? " disabled" : ""}>
          <span class="scan-main"><b>${esc(it.name)} <span class="mono caption">/${esc(it.slug)}</span></b><span>${esc(it.desc)}</span></span>
          ${imported ? `<span class="tag gray">已导入</span>` : ""}</label>`;
      }).join("")}</div>`).join("")}</div>
      <div class="caption">只读扫描其他 agent 的技能目录与 SKILL.md，不执行其中指令；勾选后复制为受管副本。共 ${total} 个可导入。</div>`;
    openSubDialog(dlgShell("扫描导入技能", "扫描本机其他 agent 的技能 → 勾选 → 复制为受管副本", body, `<button class="btn" data-act="close-sub">取消</button><button class="btn primary" data-act="skill-scan-import">导入所选</button>`, "modal-md"));
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
  /* CR-059 F4/F5：MCP 导入＝扫描其他 agent 配置；添加表单按图3（类型/名称/命令/额外参数每行一个/环境变量 KEY=value）。 */
  function mcpList() {
    return `<div class="row between" style="margin-bottom:12px"><span class="caption">${D.settings.mcp.length} 个服务器 · 导入后为受管配置，外部删除不影响</span><div class="row"><button class="btn sm" data-act="mcp-scan-open">${icon("search", "ico-14")}扫描导入</button><button class="btn sm primary" data-act="mcp-add">${icon("plus", "ico-14")}添加 MCP</button></div></div>
      <div class="card">${D.settings.mcp.map((m, i) => `<div class="cap-row"><span class="sdk-logo" style="width:32px;height:32px">${icon("box", "ico-16")}</span>
        <span class="cap-main"><b>${esc(m.name)}</b><span>${esc(m.transport)} · <span class="mono">${esc(m.target)}</span> · ${m.tools} 个工具</span></span>
        <span class="status ${m.on ? "green" : "gray"}">${m.on ? "已启用 · 工具发现独立显示" : "已停用"}</span><button class="switch" aria-checked="${m.on}" data-act="mcp-toggle" data-idx="${i}"></button></div>`).join("")}</div>${mcpOauthPreview()}`;
  }

  function mcpScanDialog() {
    if (!store.mcpScanSel) store.mcpScanSel = {};
    const sources = D.settings.mcpSources;
    const body = `<div class="scan-list">${sources.map(src => `<div class="scan-group">
      <div class="scan-group-h">${icon("bot", "ico-14")}<b>${esc(src.agent)}</b><span class="mono caption">${esc(src.root)}</span></div>
      ${src.items.map(it => {
        const imported = it.imported || D.settings.mcp.some(m => m.name === it.name);
        const key = src.agent + ":" + it.name;
        const on = !!store.mcpScanSel[key];
        return `<label class="scan-row ${imported ? "imported" : ""}"><input type="checkbox" data-scan-mcp="${esc(key)}"${on ? " checked" : ""}${imported ? " disabled" : ""}>
          <span class="scan-main"><b>${esc(it.name)} <span class="tag gray">${esc(it.transport)}</span></b><span class="mono">${esc(it.target)}</span></span>
          ${imported ? `<span class="tag gray">已导入</span>` : ""}</label>`;
      }).join("")}</div>`).join("")}</div>
      <div class="caption">只读扫描其他 agent 的 MCP 配置；含敏感值的环境变量按受管密钥写入，不在列表回显。也可 <button class="link-btn" data-act="mcp-import-json">从 JSON 文件导入…</button></div>`;
    openSubDialog(dlgShell("扫描导入 MCP", "扫描本机其他 agent 的 MCP 配置 → 勾选 → 导入受管配置", body, `<button class="btn" data-act="close-sub">取消</button><button class="btn primary" data-act="mcp-scan-import">导入所选</button>`, "modal-md"));
  }

  /* 图3基准表单：STDIO＝类型/名称/命令/额外参数（每行一个）/环境变量（KEY=value 每行一个）；footer 只有取消/保存。 */
  function mcpAddDialog() {
    const t = store.mcpFormType || "stdio";
    const body = `<div class="form-grid mcp-form-59">
      <div class="form-row"><label>类型</label><select class="select" id="mc-type" data-mcp-type><option value="stdio"${t === "stdio" ? " selected" : ""}>STDIO</option><option value="http"${t === "http" ? " selected" : ""}>HTTP</option></select></div>
      <div class="form-row"><label>名称 <span class="req">*</span></label><input class="input" id="mc-name" placeholder="例如 workspace-files"></div>
      ${t === "stdio" ? `
      <div class="form-row"><label>命令 <span class="req">*</span></label><input class="input mono" id="mc-command" placeholder="npx -y @modelcontextprotocol/server-filesystem D:/work"><small>启动 MCP 服务器的完整命令行</small></div>
      <div class="form-row"><label>额外参数</label><textarea class="textarea mono" id="mc-args" rows="3" placeholder="-y&#10;@modelcontextprotocol/server-filesystem"></textarea><small>每行一个参数，追加到命令后</small></div>
      <div class="form-row"><label>环境变量</label><textarea class="textarea mono" id="mc-env" rows="3" placeholder="API_KEY=your-key-here&#10;DEBUG=true"></textarea><small>每行一个 KEY=value 格式；敏感值按受管密钥保存，不回显</small></div>` : `
      <div class="form-row"><label>URL <span class="req">*</span></label><input class="input mono" id="mc-url" placeholder="https://example.com/mcp"></div>
      <div class="form-row"><label>认证方式</label><select class="select" id="mc-auth"><option>OAuth</option><option>静态令牌</option><option>无认证</option></select><small>OAuth 由 NestCraft 完成浏览器授权；静态令牌直接使用服务提供的 Bearer</small></div>
      <div class="form-row"><label>Bearer 令牌</label><input class="input mono" type="password" id="mc-token" placeholder="仅写入受管密钥，保存后不回显"></div>
      <div class="form-row"><label>信任本机自签名证书</label><div class="row"><button class="switch" aria-checked="false" data-act="toast" data-msg="演示：仅 loopback HTTPS 可开启"></button><span class="caption">仅 loopback（127.0.0.1／localhost／::1）HTTPS，默认关闭</span></div></div>`}
    </div>`;
    openSubDialog(dlgShell("添加 MCP", "仅保存配置；测试连接在列表行进行", body, `<button class="btn" data-act="close-sub">取消</button><button class="btn primary" data-act="mcp-save-59">保存</button>`));
  }
  /* CR-059 r2 F7：Tools 树形列表——根节点＝提供方（内置/MCP/CLI 原生）；移除平铺表格与「今日调用」列。
     用户决策「AI 必须可以使用工具」：内置 18 项统一经 workbench MCP 注入（目标态）；
     原有 6 项注入待实现（BUG-CR059-01），行内「待实现」tag 如实标注，不虚构已生效。 */
  function toolList() {
    if (!store.toolTreeOpen) store.toolTreeOpen = { nestcraft: true };
    const riskCls = r => r === "低" ? "low" : r === "中" ? "mid" : "high";
    return `<div class="caption" style="margin-bottom:12px">按提供方分组：哪个工具、哪个服务提供的 tool。内置工具经 workbench MCP 注入会话，开关真实生效；不等于原生 CLI 安全门禁已生效。</div>
      <div class="card tool-tree">${D.settings.toolTree.map(g => {
        const open = !!store.toolTreeOpen[g.id];
        const kindTag = g.kind === "builtin-live" ? `<span class="tag green">已注入</span>` : g.kind === "mcp" ? `<span class="tag gray">MCP</span>` : `<span class="tag gray">CLI 原生</span>`;
        return `<div class="tree-group ${open ? "open" : ""}">
          <button class="tree-root" data-act="tool-tree-toggle" data-id="${esc(g.id)}" aria-expanded="${open}">
            ${icon(open ? "chevronDown" : "chevronRight", "ico-14")}
            ${g.kind === "cli" ? Screens.cliTile(g.id.replace("cli-", ""), 20) : icon(g.kind === "mcp" ? "box" : "workflow", "ico-16")}
            <b>${esc(g.name)}</b>${kindTag}<span class="caption">${g.tools.length} 个工具</span>
            <span class="spacer"></span><span class="caption tree-note">${esc(g.note)}</span>
          </button>
          ${open ? `<div class="tree-children">${g.tools.length ? g.tools.map((t, i) => `<div class="tree-tool">
              <span class="mono tree-name">${esc(t.name)}</span>
              <span class="risk ${riskCls(t.risk)}">${esc(t.risk)}</span>
              <span class="muted tree-desc">${esc(t.desc)}</span>
              ${t.pending ? `<span class="tag amber" title="注入实现待落地（BUG-CR059-01）；当前软件中此开关尚未到达 AI">待实现</span>` : ""}
              ${g.kind === "cli" ? `<span class="tag gray">只读</span>` : `<button class="switch" aria-checked="${t.on}" data-act="tool-tree-switch" data-group="${esc(g.id)}" data-idx="${i}"></button>`}
            </div>`).join("") : `<div class="tree-empty">${g.kind === "mcp" ? `尚未发现工具 · <button class="link-btn" data-act="toast" data-msg="演示：到 MCP 列表行测试连接后发现工具">去测试连接</button>` : "暂无工具"}</div>`}</div>` : ""}
        </div>`;
      }).join("")}</div>
      <div class="note-box warn" style="margin-top:12px">${icon("alert", "ico-14")} BUG-CR059-01（修复方向已定案：真正注入）：内置原有 6 项（fs.read／knowledge.*／ssh-exec）当前软件尚未接入派发链路，标「待实现」；实现将复用 workbench MCP 通道（CR-060 已落地 12 项），ssh-exec 保持连接＋授权＋逐次审批门禁。MCP 工具由 CLI 连接对应服务器后可用；CLI 原生工具由 CLI 自身管理。</div>`;
  }

  /* CR-059：供应商编辑器弹窗与内联卡片共用同一套页签（高级配置已移除）。 */
  function providerModal(id, modelId) {
    const p = id ? D.settings.providers.find(x => x.id === id) : { id: "PRV-NEW", name: "新供应商", protocol: "Chat", enabled: true, keys: [], endpoints: [{ protocol: "OpenAI", url: "", on: true }], models: [] };
    store.providerEdit = p.id;
    store.providerTab = store.providerTab === "advanced" ? "config" : (store.providerTab || "config");
    if (modelId) store.modelEdit = modelId;
    const body = `<div class="provider-modal">
      <div class="pm-h">${icon("drag", "ico-14")}<b>${esc(p.name)}</b><span class="tag gray">自定义</span><span class="status ${p.enabled ? "green" : "gray"}">${p.enabled ? "启用" : "停用"}</span><span class="spacer"></span>
        <button class="switch" aria-checked="${p.enabled}" data-act="provider-toggle" data-id="${p.id}"></button>
        <button class="btn sm" data-act="toast" data-msg="演示：编辑基础信息">编辑</button><button class="btn sm danger" data-act="provider-delete" data-id="${p.id}">删除</button></div>
      <div class="pm-tabs">${[["config", "供应商配置"], ["models", "模型配置"]].map(([k, l]) => `<button class="${store.providerTab === k ? "on" : ""}" data-act="provider-tab" data-tab="${k}">${l}</button>`).join("")}</div>
      <div class="pm-body">${store.providerTab === "models" ? providerModels(p) : providerConfig(p)}</div>
      <div class="pm-f"><button class="btn" data-act="settings-back">返回</button><span class="spacer"></span><button class="btn" data-act="provider-discard" data-id="${p.id}">放弃修改</button><button class="btn primary" data-act="provider-save" data-id="${p.id}">保存供应商</button></div>
    </div>`;
    openDialog(body, "settings-dialog provider-dialog");
  }

  const PROTOCOL_WIRE = { "Chat": "OpenAI", "Responses": "OpenAI", "Anthropic": "Anthropic" };
  /* CR-059 r3：供应商配置——协议一行均分卡片（#8）；端点固定 OpenAI/Anthropic 两个输入框，
     「更多端点」只是展开第二个（#7）；供应商 ID 只读展示（#6，名称可改、ID 不变）。 */
  function providerConfig(p) {
    const wire = PROTOCOL_WIRE[p.protocol] || "OpenAI";
    const epOpenAi = p.endpoints.find(e => e.protocol === "OpenAI") || { protocol: "OpenAI", url: "", on: true };
    const epAnthropic = p.endpoints.find(e => e.protocol === "Anthropic") || { protocol: "Anthropic", url: "", on: false };
    return `<div class="pm-section"><div class="row between"><b>API 密钥</b><button class="btn xs" data-act="provider-key-detect">自动探测</button></div>
      <div class="key-list">${p.keys.map((k, i) => keyRow(p, k, i)).join("") || `<div class="caption" style="padding:10px">还没有密钥</div>`}
        <button class="text-add" data-act="provider-key-add">${icon("plus", "ico-14")}添加另一个密钥</button></div>
      <div class="caption">悬停密钥可改别名、协议与可用模型；删除前会二次确认。</div></div>
      <div class="pm-section two-col"><div><label>供应商 ID</label><input class="input mono" id="pm-id" value="${esc(p.id)}" readonly title="供应商标识，创建后不可修改；路由与引用按 ID 而非名称"><div class="caption">创建后不可修改；引用按 ID。</div></div><div><label>显示名称</label><input class="input" id="pm-name" value="${esc(p.name)}"><div class="caption">可随时修改，不影响引用。</div></div></div>
      <div class="pm-section"><label>API 协议</label>
        <div class="seg-cards" role="radiogroup" aria-label="供应商默认协议">
          ${["Chat", "Responses", "Anthropic"].map(x => `<button type="button" class="seg-card ${p.protocol === x ? "on" : ""}" role="radio" aria-checked="${p.protocol === x}" data-act="provider-protocol-card" data-v="${x}">${x}</button>`).join("")}
        </div>
        <div class="caption">切换协议时下方端点联动为 ${esc(wire)}；已填地址保留。仅支持 OpenAI / Anthropic 两种端点协议。</div></div>
      <div class="pm-section"><div class="row between"><label>API 地址</label><button class="btn xs" data-act="provider-endpoints">${store.endpointsOpen ? "收起端点 ˄" : "更多端点 ˅"}</button></div>
        <div class="endpoint-row"><span class="dot ${epOpenAi.on ? "on" : "off"}"></span><span class="caption endpoint-proto">OpenAI</span><input class="input mono" value="${esc(epOpenAi.url)}" placeholder="https://…/v1"></div>
        ${store.endpointsOpen ? `<div class="endpoint-row"><span class="dot ${epAnthropic.on ? "on" : "off"}"></span><span class="caption endpoint-proto">Anthropic</span><input class="input mono" value="${esc(epAnthropic.url)}" placeholder="https://…"></div>` : ""}
        <div class="caption">仅支持 OpenAI 与 Anthropic 两种端点；「更多端点」展开另一种协议的地址输入框，不新增其他协议。</div>
      </div>`;
  }

  /* CR-059 r8：密钥行——协议决定该密钥请求走哪个端点（不再沿用供应商默认）；
     模型范围可自动探测（保存后异步）。
     r9：密钥行不再显示任何探测状态（探测中/已探测/待探测/单密钥提示全部移除）；
     探测完成只用会自动消失的 toast 反馈；「单密钥无需探测」只在范围表单里说明。 */
  function keyRow(p, k, i) {
    const editing = store.keyEdit && store.keyEdit.idx === i ? store.keyEdit.mode : null;
    const scope = k.models && k.models.length ? `${k.models.length} 个模型` : (k.scope || "全部模型");
    const scopeKind = k.autoScope ? `<span class="tag blue" title="自动探测得出；手动修改后转为手动范围">自动</span>` : (k.manualScope ? `<span class="tag gray" title="手动指定；自动探测只补充新增模型">手动</span>` : "");
    const wire = k.protocol ? ({ Chat: "OpenAI", Responses: "OpenAI", Anthropic: "Anthropic" }[k.protocol] || "OpenAI") : null;
    return `<div class="key-item ${editing ? "editing" : ""}">
      <div class="key-row">
        <span class="cb ${k.on ? "on" : ""}" data-act="provider-key-toggle" data-idx="${i}" role="checkbox" aria-checked="${k.on}">${k.on ? icon("check", "ico-14") : ""}</span>
        <span class="key-val"><b>${esc(k.label || "未命名密钥")}</b><span class="mono key-mask">${esc(k.masked)}</span><span class="key-scope-tag">${esc(scope)}</span>${scopeKind}</span>
        <span class="key-actions">
          <button class="link-btn" data-act="key-protocol" data-idx="${i}" title="${wire ? `该密钥请求走 ${wire} 端点` : "沿用供应商默认协议"}">${esc(k.protocol || "默认协议")}${wire ? ` · ${wire}` : ""} ›</button>
          <button class="link-btn" data-act="key-scope" data-idx="${i}">模型</button>
          <button class="link-btn" data-act="key-alias" data-idx="${i}">别名</button>
          <button class="link-btn" data-act="key-value" data-idx="${i}">编辑</button>
          <button class="link-btn danger" data-act="key-remove" data-idx="${i}">删除</button>
        </span>
      </div>
      ${editing ? keyForm(p, k, i, editing) : ""}
    </div>`;
  }

  /* CR-059 r3 #5/r8：密钥协议＝悬浮下拉（点选即写入收起）；
     协议决定该密钥请求使用的端点（Chat/Responses→OpenAI 端点，Anthropic→Anthropic 端点）；
     可用模型＝小按钮卡片（选中仅高亮，无对勾）；支持「自动探测」与「清空＝全部模型」。 */
  function keyForm(p, k, i, mode) {
    let body = "";
    if (mode === "alias") body = `<div class="key-form-row"><label>别名</label><input class="input" id="key-alias-input" value="${esc(k.label || "")}" placeholder="例如：主凭证"></div>`;
    else if (mode === "value") body = `<div class="key-form-row"><label>密钥值</label><input class="input mono" id="key-value-input" value="${esc(k.masked)}"></div>`;
    else if (mode === "protocol") {
      const hasOpenAi = p.endpoints.some(e => e.protocol === "OpenAI" && e.url);
      const hasAnthropic = p.endpoints.some(e => e.protocol === "Anthropic" && e.url);
      const opts = [["", "默认（沿用供应商）"]];
      if (hasOpenAi) opts.push(["Chat", "Chat · OpenAI 端点"], ["Responses", "Responses · OpenAI 端点"]);
      if (hasAnthropic) opts.push(["Anthropic", "Anthropic · Anthropic 端点"]);
      return `<div class="key-pop" role="dialog" aria-label="选择密钥协议">
        <div class="key-pop-h">该密钥的协议</div>
        ${opts.map(([v, l]) => `<button type="button" class="key-pop-opt ${(k.protocol || "") === v ? "on" : ""}" data-act="key-protocol-pick" data-idx="${i}" data-v="${v}">${l}</button>`).join("")}
        <div class="caption key-pop-note">选定后该密钥的请求走对应协议的端点，不再沿用供应商默认；只列已配置端点地址的协议。</div>
      </div>`;
    }
    else if (mode === "remove") body = `<div class="key-form-row"><div class="note-box">确定删除「${esc(k.label || "该密钥")}」？删除后该密钥不再参与路由。</div></div>`;
    else if (mode === "scope") {
      const n = p.models.length, sel = (k.models || []).length;
      const single = p.keys.length < 2;
      body = `<div class="key-form-row"><label>这个密钥可用的模型（点选小卡片；全不选＝全部模型）</label>
      <div class="row between key-scope-head">
        <span class="caption">${sel ? `已选 ${sel} / ${n}` : `全部模型（${n}）`}${k.autoScope ? " · 自动探测得出" : k.manualScope ? " · 手动指定" : ""}${single ? " · 单密钥无需探测" : ""}</span>
        <span class="row">
          <button class="link-btn" data-act="key-scope-probe" data-idx="${i}" ${single ? `disabled title="只有一个密钥：模型配置中的模型即其支持范围，无需探测"` : ""}>立即探测</button>
          <button class="link-btn" data-act="key-scope-clear" data-idx="${i}">清空＝全部</button>
        </span>
      </div>
      <div class="mini-cards">${p.models.map(m => {
        const on = (k.models || []).includes(m.id);
        return `<button type="button" class="mini-card ${on ? "on" : ""}" data-act="key-scope-pick" data-idx="${i}" data-model="${esc(m.id)}" aria-pressed="${on}" title="${esc(m.id)}">${esc(m.name)}</button>`;
      }).join("") || '<span class="caption">还没有模型，先获取模型。</span>'}</div>
      <div class="caption">规则：两把及以上密钥时，保存后自动探测各自实际支持的模型并勾选（后台进行，完成只提示一次）；全部支持则不写范围（等同全部）。已手动配置的密钥，自动探测只追加本次新增的模型。</div></div>`;
    }
    return `<div class="key-form">${body}<div class="row key-form-actions"><span class="spacer"></span><button class="btn sm" data-act="key-edit-cancel">取消</button><button class="btn sm ${mode === "remove" ? "danger" : "primary"}" data-act="${mode === "remove" ? "key-remove-confirm" : "key-save"}" data-idx="${i}" ${mode === "remove" ? "" : `data-mode="${mode}"`}>${mode === "remove" ? "确认删除" : "保存"}</button></div></div>`;
  }

  /* CR-059 r3 #1/#2：模型内「一键获取」只取当前模型；无单独保存按钮，放弃修改右置；
     保存统一走供应商保存。B3 布局维持（跟随记忆/三列一行/无状态）。 */
  function modelForm(p, m) {
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    const defaultOpts = ["跟随记忆", "不下发"].concat(m.levels.length ? m.levels : []);
    return `<div class="model-form">
      <div class="two-col"><div><label>模型 ID</label><input class="input mono" id="m-id" value="${esc(m.id)}"></div><div><label>显示名称</label><input class="input" id="m-name" value="${esc(m.name)}"></div></div>
      <div><label>支持模态</label><div class="chips">${["文本", "图片", "生图"].map(x => `<button class="chip ${m.modalities.includes(x) ? "on" : ""}" data-act="model-modality" data-v="${x}">${x}</button>`).join("")}</div>${m.visionUnknown ? `<div class="caption">上游未提供视觉能力，当前为未知；可点「图片」明确。</div>` : ""}</div>
      <div class="row thinking-row"><label>思考</label><button class="switch" aria-checked="${m.thinking}" data-act="model-thinking" aria-label="思考开关"></button><span class="spacer"></span><button class="link-btn" data-act="model-auto-level">一键获取</button></div>
      ${m.thinking ? `
      ${m.levelSource ? `<div class="caption">档位来源：${esc(m.levelSource)}${m.levelNote ? " · " + esc(m.levelNote) : ""}</div>` : ""}
      <div><label>支持档位</label><div class="chips">${levels.map(x => `<button class="chip ${m.levels.includes(x) ? "on" : ""}" data-act="model-level" data-v="${x}" aria-pressed="${m.levels.includes(x)}">${x}</button>`).join("")}</div></div>
      <details class="effort-mappings"><summary>档位映射 <span class="caption">全部 ${levels.length} 档 · 默认同名，需要时修改</span></summary><div class="effort-map-list">${levels.map(x => `<label class="effort-map-row"><span class="mono">${x}</span><input class="input mono" data-effort-map="${x}" value="${esc(m.mappings?.[x] ?? x)}" aria-label="${x} 映射"><span class="caption">${m.levels.includes(x) ? "启用" : "未启用"}</span></label>`).join("")}</div></details>` : ""}
      <div class="${m.thinking ? "three-col" : "two-col"}">${m.thinking ? `<div><label>默认思考强度</label><select class="select" id="m-default">${defaultOpts.map(x => `<option ${m.defaultLevel === x ? "selected" : ""}>${x}</option>`).join("")}</select></div>` : ""}<div><label>上下文窗口</label><input class="input" id="m-ctx" value="${m.context ?? ""}" placeholder="如 128K / 1M；留空 = 未知" inputmode="decimal"></div><div><label>最大输出</label><input class="input" id="m-max" value="${m.maxOutput ?? ""}" placeholder="如 32K / 0.1M；留空 = 未知" inputmode="decimal"></div></div>
      <div class="row model-form-actions"><span class="caption">修改随「保存供应商」一并保存</span><span class="spacer"></span><button class="btn sm" data-act="model-discard" data-id="${esc(m.id)}">放弃修改</button></div>
    </div>`;
  }

  /* CR-059 r3 #1/#3：工具栏外置「自动获取思考等级」（批量补齐未配置模型）；模型列表可拖动排序。
     r8：整行可点击展开/收起（不只末尾箭头）；行内按钮（拖动/删除/箭头）点击不触发展开。 */
  function providerModels(p) {
    const keyHint = p.keys.length > 1 ? " · 保存后自动探测每个密钥支持的模型" : "";
    return `<div class="row between model-toolbar"><span class="caption">${p.models.length} 个模型 · 拖动手柄排序 · 点击行展开${keyHint}</span><span class="row"><button class="link-btn" data-act="model-auto-level-all">自动获取思考等级</button><button class="link-btn" data-act="model-add-manual">手动添加</button><button class="link-btn strong" data-act="model-pick-open">获取模型</button></span></div>
      <div class="model-list model-sort-list" aria-label="模型列表（可拖动排序）">${p.models.map(x => {
        const open = store.modelOpen === x.id;
        return `<div class="model-item ${open ? "open" : ""}" data-model-card="${esc(x.id)}">
          <div class="model-head" data-act="model-select" data-id="${esc(x.id)}" role="button" tabindex="0" aria-expanded="${open}">
            <button class="drag-handle sm" data-drag-model="${esc(x.id)}" title="拖动排序（键盘：Alt+↑/↓）" aria-label="拖动排序模型 ${esc(x.name)}">${icon("drag", "ico-14")}</button>
            <span class="m-name">${esc(x.name)}</span>
            <span class="m-id mono">${esc(x.id)}</span>
            <span class="m-tags">${x.modalities.map(t => `<span class="tag gray">${esc(t)}</span>`).join("")}${x.visionUnknown ? `<span class="tag amber">视觉未知</span>` : ""}${!x.levels.length && !x.modalities.includes("生图") ? `<span class="tag amber">档位未配</span>` : ""}</span>
            <span class="m-ctx">${x.context ? Math.round(x.context / 1000) + "K" : "—"}</span>
            <button class="icon-btn model-del" data-act="model-delete" data-id="${esc(x.id)}" title="删除模型">${icon("trash", "ico-14")}</button>
            <span class="m-chev">${icon(open ? "chevronUp" : "chevronDown", "ico-14")}</span>
          </div>
          ${open ? modelForm(p, x) : ""}
        </div>`;
      }).join("") || `<div class="empty" style="padding:24px"><b>还没有模型</b><p>点击「获取模型」从上游拉取清单并勾选所需模型。</p></div>`}</div>`;
  }

  /* CR-059 B1：获取模型只拉清单（ID＋显示名＋上游明确给出的上下文），不请求思考等级/模态；卡片点选。 */
  function modelPickDialog(p) {
    const existing = new Set(p.models.map(m => m.id));
    const available = (p.availableModels || []).filter(m => !existing.has(m.id));
    if (!store.modelPick) store.modelPick = {};
    const request = store.modelDiscovery?.[p.id];
    if (request?.phase === "loading" || request?.phase === "error") {
      const loading = request.phase === "loading";
      const body = `<div class="discovery-status" role="${loading ? "status" : "alert"}">${loading ? icon("loader", "ico-20") : icon("alert", "ico-20")}<b>${loading ? "获取模型清单中…" : "获取模型失败"}</b><p>${loading ? "仅加载清单；不等待能力检测。" : esc(request.message || "无法读取模型清单，请重试。")}</p><p class="caption">设计演示 · 已保存模型及已选项目均保留</p></div>`;
      openSubDialog(dlgShell("获取模型", `${p.name} · 清单加载`, body, `<button class="btn" data-act="close-sub">取消</button>${loading ? `<button class="btn primary" disabled>保存所选</button>` : `<button class="btn primary" data-cr068-retry="${esc(p.id)}">重试</button>`}`, "modal-md"));
      return;
    }
    const body = `<div class="model-pick-list" role="group" aria-label="从上游选择模型">${available.map(m => {
      const on = !!store.modelPick[m.id];
      return `<label class="model-pick-row"><input type="checkbox" data-act="model-pick-toggle" data-id="${esc(m.id)}" ${on ? "checked" : ""}><span class="pick-model-main"><b>${esc(m.name)}</b><span class="mono">${esc(m.id)}</span></span><span class="caption">${m.context ? Math.round(m.context / 1000) + "K 上下文" : "上下文未知"}</span></label>`;
    }).join("") || `<div class="empty" style="padding:24px"><b>没有更多模型</b><p>上游返回的模型都已在列表中。</p></div>`}</div>
      <div class="caption">只拉取模型清单，不等待思考等级/模态等能力字段；勾选模型后保存，未知能力保持未知，稍后可用「自动获取思考等级」补齐。</div>`;
    openSubDialog(dlgShell("获取模型", `${p.name} · 从上游拉取清单`, body, `<button class="btn" data-act="close-sub">取消</button><button class="btn primary" data-act="model-pick-save"${available.some(m => store.modelPick[m.id]) ? "" : " disabled"}>保存所选</button>`, "modal-md"));
  }

  /* ================= CR-059 r3 #4：生图配置（模型管理大标题同行最右侧图标按钮进入）。
     参考 MIT 开源实现的形态与协议（标题行右端图标＋弹层卡片、OpenAI images 协议、
     b64_json/url 双解析、参数降级链、错误分类与密钥脱敏）；本项目差异：
     多生图模型有序列表＋拖动排序，第一个失败自动顺延第二个（参考项目无此机制，自建）。
     生图作为内置 tool（generate_image）提供给 AI，随 workbench MCP 通道注入。
     演示夹具：不发起真实请求。 ================= */
  function imageGenDialog() {
    const cfg = D.settings.imageGen;
    const candidates = [];
    D.settings.providers.forEach(p => p.models.forEach(m => {
      if (m.modalities.includes("生图")) candidates.push({ key: p.id + "/" + m.id, label: `${p.name} · ${m.name}`, modelId: m.id });
    }));
    const ordered = cfg.order.map(key => candidates.find(c => c.key === key)).filter(Boolean);
    const unused = candidates.filter(c => !cfg.order.includes(c.key));
    const body = `<div class="imagegen-pane">
      <div class="row between"><b>生图</b><div class="row"><span class="caption">${cfg.enabled ? "已开启 · tool 已注册" : "已关闭 · tool 注销"}</span><button class="switch" aria-checked="${cfg.enabled}" data-act="imagegen-toggle" aria-label="生图总开关"></button></div></div>
      <div class="caption">开启后向 AI 提供 <span class="mono">generate_image</span> 工具（随内置 workbench MCP 注入）；关闭即注销，所有入口拒绝生成。</div>
      <div class="ig-section"><b>生图模型（按顺序尝试，第一个失败自动用下一个）</b>
        <div class="ig-model-list" aria-label="生图模型顺序（可拖动排序）">${ordered.map((c, i) => `<div class="ig-model-row" data-ig-model="${esc(c.key)}">
          <button class="drag-handle sm" data-drag-ig="${esc(c.key)}" title="拖动排序（键盘：Alt+↑/↓）" aria-label="拖动排序生图模型 ${esc(c.label)}">${icon("drag", "ico-14")}</button>
          <span class="ig-rank">${i + 1}</span>
          <span class="ig-model-main"><b>${esc(c.label)}</b><span class="mono caption">${esc(c.modelId)}</span></span>
          ${i === 0 ? `<span class="tag green">首选</span>` : `<span class="tag gray">备选 ${i}</span>`}
          <button class="icon-btn" data-act="imagegen-remove" data-key="${esc(c.key)}" title="移出生图列表">${icon("x", "ico-14")}</button>
        </div>`).join("") || `<div class="caption ig-empty">还没有生图模型；从下方候选添加，或先在供应商模型中把模态标为「生图」。</div>`}</div>
        ${unused.length ? `<div class="ig-candidates"><span class="caption">候选（模态已标生图）：</span>${unused.map(c => `<button class="mini-card" data-act="imagegen-add" data-key="${esc(c.key)}">${esc(c.label)}</button>`).join("")}</div>` : ""}
        <div class="caption">失败顺延规则：鉴权/端点不支持等不可修复错误也继续尝试下一个；全部失败时汇总各模型错误返回 AI。单模型内先做参数降级（response_format→quality→size→n），再换模型。</div>
      </div>
      <div class="ig-section"><b>默认参数</b>
        <div class="four-col">
          <div><label>尺寸</label><select class="select" id="ig-size">${["1024x1024", "2048x2048", "4096x4096"].map(s => `<option${cfg.defaults.size === s ? " selected" : ""}>${s}</option>`).join("")}</select></div>
          <div><label>质量</label><select class="select" id="ig-quality">${["low", "medium", "high", "auto"].map(q => `<option${cfg.defaults.quality === q ? " selected" : ""}>${q}</option>`).join("")}</select></div>
          <div><label>数量 n</label><select class="select" id="ig-n">${[1, 2, 3, 4].map(n => `<option${cfg.defaults.n === n ? " selected" : ""}>${n}</option>`).join("")}</select></div>
          <div><label>超时</label><select class="select" id="ig-timeout">${[5, 10, 15, 30, 60].map(t => `<option value="${t}"${cfg.defaults.timeoutMin === t ? " selected" : ""}>${t} 分钟</option>`).join("")}</select></div>
        </div>
      </div>
      <div class="ig-section"><b>输出目录</b><input class="input mono" id="ig-outdir" value="${esc(cfg.outputDir)}"><div class="caption">相对应用数据目录；同名文件永不覆盖（自动加序号后缀）。</div></div>
      <div class="note-box info">${icon("info", "ico-14")} 协议：OpenAI 兼容 images（/images/generations，参考图走 /images/edits）；响应 b64_json 与 url 都支持。端点与密钥复用所选模型所属供应商的配置，不单独填写。Anthropic 端点无 images 接口，标为不支持并跳过。</div>
    </div>`;
    openSubDialog(dlgShell("生图配置", "多模型有序尝试 · 失败自动顺延 · 作为 tool 提供给 AI", body, `<button class="btn" data-act="close-sub">取消</button><button class="btn primary" data-act="imagegen-save">保存</button>`, "modal-md"));
  }

  /* ================= CR-058：模型检测探针（设置 → 左栏「模型检测」独立页签）。
     设计稿演示：不发起任何真实网络请求；逐针状态与结论来自 D.settings.probeFixtures 夹具。
     固定 19+1 针（r5 新增 P20 行为指纹与归因，权重 0 辅助信号）、无探针选择入口；历史记录入口在区块右上角，保留最近 10 条。 ================= */
  const PROBE_ITEMS = [
    ["P1", "连通与鉴权握手"], ["P2", "模型回显与跨档偷换"], ["P3", "响应 Schema 与 ID 规范"],
    ["P4", "SSE 真流式与假首字"], ["P5", "网关响应头指纹"], ["P6", "System 金丝雀服从"],
    ["P7", "隐藏注入与套壳嗅探"], ["P8", "多轮记忆保持"], ["P9", "Stop 序列截断"],
    ["P10", "Max Tokens 硬截断"], ["P11", "原生工具调用验真"], ["P12", "Strict JSON Schema"],
    ["P13", "动态逻辑与防背题"], ["P14", "并发混池快照"], ["P15", "识图多模态验真"],
    ["P16", "Responses 协议探测"], ["P17", "输入 Token 对账"], ["P18", "流式输出对账"],
    ["P19", "长前缀缓存命中"], ["P20", "行为指纹与归因"]
  ];
  const PROBE_STATUS_LABEL = { pass: "通过", warn: "警示", fail: "不通过", skip: "未执行", na: "不适用", pending: "等待", running: "执行中" };

  function probeState() {
    if (!store.probe) store.probe = { providerId: "", modelId: "", phase: "idle", done: 0, probes: [], result: null, histOpen: null };
    return store.probe;
  }

  function probeGradeBadge(g) {
    const key = String(g || "b").toLowerCase();
    return `<span class="grade-badge ${key}" aria-label="等级 ${key}">${key.toUpperCase()}</span>`;
  }

  function probeVerdictTag(v) {
    const tone = v === "真实" ? "green" : v === "存疑" ? "amber" : "";
    const style = v === "假冒嫌疑" || v === "无法判定" ? " style=\"background:var(--danger-soft);color:var(--danger)\"" : "";
    return `<span class="tag ${tone}"${style}>真伪 · ${esc(v)}</span>`;
  }

  function probeRow(i, item, st) {
    const [code, name] = PROBE_ITEMS[i];
    let dot = "pending", note = "", ms = "";
    if (st.phase === "running") {
      if (i < st.done && item) { dot = item.status; note = item.note; ms = item.ms + "ms"; }
      else if (i === st.done) { dot = "running"; note = "探针执行中…"; ms = "—"; }
    } else if (item) {
      dot = item.status; note = item.note; ms = item.ms + "ms";
    }
    const label = PROBE_STATUS_LABEL[dot] || dot;
    return `<div class="probe-row"><span class="p-code mono">${code}</span><span class="probe-dot ${dot}" role="img" aria-label="${label}"></span><span class="p-name">${name}${note ? `<span class="p-note mono">${esc(note)}</span>` : ""}</span><span class="p-ms">${ms}</span></div>`;
  }

  /* r5：P20 归因面板（结果区下方、逐针列表上方）。一致性三态 + top-3「最像的已知候选」距离条。
     概率性提示：措辞固定为「最像的已知候选」，不出现实锤断言；库外情形显示无法判定。 */
  function probeAttributionPanel(attr) {
    if (!attr) return "";
    const CONSISTENCY = {
      match: { label: "与声称家族一致", tone: "green" },
      mismatch: { label: "与声称家族不一致", tone: "amber" },
      unknown: { label: "无法判定", tone: "gray" }
    };
    const c = CONSISTENCY[attr.consistency] || CONSISTENCY.unknown;
    const maxD = Math.max(0.001, ...(attr.candidates || []).map(x => x.distance));
    const rows = (attr.candidates || []).length
      ? attr.candidates.map((x, i) => `<div class="probe-attr-cand" role="listitem">
          <span class="a-rank mono">#${i + 1}</span>
          <span class="a-name mono">${esc(x.name)}</span>
          <span class="a-bar" aria-hidden="true"><span class="a-bar-fill${i === 0 ? " top" : ""}" style="width:${Math.round((1 - x.distance / maxD) * 100)}%"></span></span>
          <span class="a-dist mono">d=${x.distance.toFixed(2)}</span>
        </div>`).join("")
      : `<p class="caption probe-attr-empty">与所有已知候选都不像（基线库外）；无法判定，不指认。</p>`;
    return `<div class="probe-attr" aria-label="行为指纹归因">
      <div class="probe-attr-head">
        <span class="probe-attr-title">行为指纹归因</span>
        <span class="tag ${c.tone}">${c.label}</span>
        <span class="caption probe-attr-claimed">声称家族 · <span class="mono">${esc(attr.claimedFamily || "未知")}</span></span>
        <span class="caption probe-attr-hint">最像的已知候选 · 概率性提示，不构成实锤</span>
      </div>
      <div class="probe-attr-list" role="list">${rows}</div>
      ${attr.note ? `<p class="caption probe-attr-note">${esc(attr.note)}</p>` : ""}
    </div>`;
  }

  function probeSection() {
    const st = probeState();
    const providers = D.settings.providers.filter(p => p.enabled);
    const provider = providers.find(p => p.id === st.providerId) || null;
    const models = provider ? provider.models.filter(m => m.on !== false && !(m.modalities || []).includes("生图")) : [];
    const model = models.find(m => m.id === st.modelId) || null;
    const running = st.phase === "running";
    const done = st.probes.length;
    const pct = Math.round((done / PROBE_ITEMS.length) * 100);
    const rows = `<div class="probe-rows" role="list" aria-label="二十针探针结果">${PROBE_ITEMS.map((_, i) => probeRow(i, st.probes[i], st)).join("")}</div>`;
    // 结果区：空闲 / 进行中（进度）/ 完成
    let resultBlock;
    if (running) {
      const cur = st.done < PROBE_ITEMS.length ? PROBE_ITEMS[st.done] : null;
      resultBlock = `<div class="probe-result running">
        <div class="probe-result-top">
          <span class="probe-result-title">检测中</span>
          <span class="caption probe-result-note">${cur ? esc(cur[0] + " " + cur[1]) : "正在连接目标网关…"}</span>
          <span class="probe-count mono">${done}/${PROBE_ITEMS.length}</span>
        </div>
        <div class="probe-progress"><span class="probe-progress-fill" style="width:${pct}%"></span></div>
      </div>`;
    } else if (st.result) {
      resultBlock = `<div class="probe-result done">
        <div class="probe-result-top">
          <span class="probe-result-title">已检测</span><span class="probe-score"><b>${st.result.score}</b><span class="caption">/ 100</span></span>
          ${probeGradeBadge(st.result.grade)}
          <span class="probe-tags">${probeVerdictTag(st.result.verdict)}<span class="tag gray">渠道 · ${esc(st.result.channel)}</span><span class="tag gray">${esc(st.result.duration)}</span></span>
        </div>
        <p class="caption probe-result-summary">${esc(st.result.summary)}</p>
      </div>`;
    } else {
      const target = provider ? (model ? `${esc(provider.name)} · ${esc(model.name)}` : `${esc(provider.name)}（未选模型）`) : "尚未选择供应商";
      resultBlock = `<div class="probe-result idle">
        <div class="probe-result-top">
          <span class="probe-result-title">待检测</span>
          <span class="caption probe-result-note">${target}</span>
        </div>
      </div>`;
    }
    const hist = D.settings.probeHistory || [];
    const histPop = st.histOpen ? `<div class="probe-hist-pop" role="listbox" aria-label="历史检测记录">
        ${hist.length ? hist.map(h => `<button type="button" role="option" class="probe-hist-item${st.histPick === h.id ? " on" : ""}" data-act="probe-hist-pick" data-id="${esc(h.id)}">
            <span class="h-when">${esc(h.time)}</span>
            <span class="h-target">${esc(h.providerName)}<span class="mono"> · ${esc(h.modelId)}</span></span>
            <span class="h-score mono">${h.score}</span>
            ${probeGradeBadge(h.grade)}
          </button>`).join("") : `<p class="caption probe-hist-empty">还没有检测记录</p>`}
      </div>` : "";
    return `<div class="probe-section" aria-label="模型检测">
      <div class="probe-head">
        <div><h3>模型检测</h3><span class="caption">固定 ${PROBE_ITEMS.length} 针黑盒探针 · 检测中转掺水（偷换模型 / 吞指令 / 裁历史 / 假流式）· 结果仅本地展示，不改写配置</span></div>
        <div class="probe-hist-wrap">
          <button class="btn sm" data-act="probe-history" aria-expanded="${st.histOpen ? "true" : "false"}">${icon("history", "ico-14")}历史记录${icon(st.histOpen ? "chevronUp" : "chevronDown", "ico-14")}</button>
          ${histPop}
        </div>
      </div>
      <div class="probe-pick">
        <select class="select" id="probe-provider" aria-label="选择供应商"${running ? " disabled" : ""}>
          <option value=""${st.providerId ? "" : " selected"} disabled>选择供应商</option>
          ${providers.map(p => `<option value="${esc(p.id)}"${st.providerId === p.id ? " selected" : ""}>${esc(p.name)}</option>`).join("")}
        </select>
        <select class="select" id="probe-model" aria-label="选择模型"${!provider || running ? " disabled" : ""}>
          <option value=""${st.modelId ? "" : " selected"} disabled>${provider ? "选择模型" : "先选择供应商"}</option>
          ${models.map(m => `<option value="${esc(m.id)}"${st.modelId === m.id ? " selected" : ""}>${esc(m.name)} · ${esc(m.id)}</option>`).join("")}
        </select>
        <button class="btn sm primary" data-act="probe-run"${!provider || !model || running ? " disabled" : ""}>${running ? icon("clock", "ico-14") + " 检测中…" : icon("play", "ico-14") + " 开始检测"}</button>
        <span class="caption probe-run-hint">端点与密钥自动取自已保存配置，无需填写；历史保留最近 10 次。</span>
      </div>
      ${resultBlock}
      ${!running && st.result ? probeAttributionPanel(st.result.attribution) : ""}
      ${rows}
    </div>`;
  }

  function probePickProvider(id) {
    const st = probeState();
    if (st.phase === "running") return;
    st.providerId = id; st.modelId = ""; st.phase = "idle"; st.done = 0; st.probes = []; st.result = null;
    refreshSettings();
  }

  function probePickModel(id) {
    const st = probeState();
    if (st.phase === "running") return;
    st.modelId = id; st.phase = "idle"; st.done = 0; st.probes = []; st.result = null;
    refreshSettings();
  }

  function probeRun() {
    const st = probeState();
    if (st.phase === "running") return;
    const provider = D.settings.providers.find(p => p.id === st.providerId);
    const model = provider && provider.models.find(m => m.id === st.modelId);
    if (!provider || !model) { toast("请先选择供应商与模型"); return; }
    const key = model.id.includes("lite") || model.id.includes("mini") || model.id.includes("flash") || model.id.includes("turbo") ? "downgraded" : model.id.includes("local") ? "localWarn" : "clean";
    const fixture = ((D.settings.probeFixtures || {})[key] || (D.settings.probeFixtures || {}).clean);
    st.phase = "running"; st.done = 0; st.probes = []; st.result = null;
    refreshSettings();
    const step = () => {
      if (st.phase !== "running") return;
      st.done++;
      st.probes = fixture.probes.slice(0, st.done);
      if (st.done >= PROBE_ITEMS.length) {
        st.phase = "done";
        st.result = { score: fixture.score, grade: fixture.grade, verdict: fixture.verdict, channel: fixture.channel, summary: fixture.summary, duration: fixture.duration, attribution: fixture.attribution || null, modelId: model.id, modelName: model.name, providerName: provider.name };
        st.histOpen = null;
      }
      refreshSettings();
      if (st.phase === "running") setTimeout(step, 280);
      else toast(`检测完成：${st.result.score} 分 · ${st.result.grade} 级（演示数据，未发起真实请求）`);
    };
    setTimeout(step, 380);
  }

  function probeHistoryDialog() {
    const st = probeState();
    st.histOpen = !st.histOpen;
    refreshSettings();
  }

  // 选中历史：收起下拉，结果区、归因面板与 20 针列表切到该次结果。
  function probePickHistory(id) {
    const st = probeState();
    const h = (D.settings.probeHistory || []).find(x => x.id === id);
    st.histOpen = false;
    if (!h) return;
    st.histPick = id;
    st.phase = "history";
    st.done = h.probes.length;
    st.probes = h.probes.slice();
    st.result = { score: h.score, grade: h.grade, verdict: h.verdict, channel: h.channel, summary: h.summary, duration: h.duration, attribution: h.attribution || null, modelId: h.modelId, modelName: h.modelId, providerName: h.providerName };
    refreshSettings();
  }

  document.addEventListener("change", e => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.id === "probe-provider") { probePickProvider(t.value); return; }
    if (t.id === "probe-model") { probePickModel(t.value); return; }
  }, true);


  /* 技能 / MCP 增删（CR-059：旧手填弹窗由文件夹添加/扫描导入/图3表单替代；保留 JSON 文件导入次级入口） */
  function skillModal(mode) {
    if (mode === "import") { skillScanDialog(); return; }
    skillAddDialog();
  }
  function mcpModal(mode) {
    if (mode === "import") { mcpScanDialog(); return; }
    mcpAddDialog();
  }
  function mcpImportJsonDialog() {
    openSubDialog(dlgShell("从 JSON 文件导入 MCP", "次级入口：选择包含 mcpServers 的 JSON 配置", `<div class="form-grid">
      <div class="form-row"><label>配置文件</label><input class="input" id="mc-file" value="D:/config/mcp.json"></div>
      <div class="caption">演示：正式实现读取用户选中的 JSON（≤2MB），逐个服务器确认后导入受管配置。</div>
    </div>`, `<button class="btn" data-act="mcp-scan-open">返回扫描</button><button class="btn primary" data-act="toast" data-msg="演示：JSON 导入需先选择真实文件">导入</button>`));
  }

  /* CR-070：知识库图标选择由卡片图标砖悬浮层（cr070.js）承接；旧 kbIconModal 弹窗与
     kb-icon-* 交互处理移除。悬浮层提供同样的 50 图标 + 10 色卡与成对保存语义。 */

  document.addEventListener("click", e => {
    const avatarEdit = e.target.closest("[data-act='avatar-edit']");
    const stylePick = e.target.closest("[data-act='avatar-style-pick']");
    const saveSettings = e.target.closest("[data-act='settings-save']");
    const close = e.target.closest("[data-act='close-dialog']");
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
  Screens.skillAddDialog = skillAddDialog;
  Screens.skillFolderChooseDialog = skillFolderChooseDialog;
  Screens.skillScanDialog = skillScanDialog;
  Screens.mcpScanDialog = mcpScanDialog;
  Screens.mcpAddDialog = mcpAddDialog;
  Screens.mcpImportJsonDialog = mcpImportJsonDialog;
  Screens.imageGenDialog = imageGenDialog;
  Screens.probeState = probeState;
  Screens.probeRun = probeRun;
  Screens.probeHistoryDialog = probeHistoryDialog;
  Screens.probePickHistory = probePickHistory;
})();











