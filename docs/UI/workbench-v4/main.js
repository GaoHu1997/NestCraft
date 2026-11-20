/* 交互：所有按钮都有实际作用；仿真状态只在本页内存中。 */
(function () {
  "use strict";
  const { D, esc, icon, store, render, openWindow, toast, openDialog, closeDialog, dlgShell } = UI;
  const S = () => window.Screens;
  const proj = () => D.projects.find(p => p.id === store.projectId) || D.projects[0];
  const val = id => { const el = document.getElementById(id); return el ? el.value : ""; };
  const projById = id => D.projects.find(p => p.id === id) || D.projects[0];

  function autoModel(m) {
    const key = String(m.id + " " + m.name).toLowerCase();
    const image = /image|imagen|dall|stable|draw/.test(key);
    const vision = /vision|pro|max|omni|gemini|gpt-4o/.test(key);
    const thinking = !image && !/embed/.test(key);
    return { ...m, modalities: image ? ["生图"] : vision ? ["文本", "图片"] : ["文本"], thinking, levels: thinking ? ["off", "low", "medium", "high"] : [], defaultLevel: thinking ? (vision ? "高" : "中") : "—", context: m.context || (vision ? 200000 : 128000), maxOutput: m.maxOutput || (vision ? 65536 : 32768), autoLevels: true, on: true };
  }

  function nextId(kind, projectId) {
    const prefix = kind === "epic" ? "EPIC-" : kind === "feature" ? "FEAT-" : "STORY-";
    const nums = D.requirements.filter(r => r.kind === kind).map(r => parseInt(String(r.id).replace(/\D+/g, ""), 10) || 0);
    let n = Math.max(0, ...nums) + 1;
    let id = prefix + String(n).padStart(kind === "epic" ? 2 : 3, "0");
    while (D.requirements.some(r => r.id === id)) { n++; id = prefix + String(n).padStart(kind === "epic" ? 2 : 3, "0"); }
    return { id, n };
  }

  const actions = {
    /* ---------- 外壳 ---------- */
    nav(el) {
      document.body.classList.remove("nav-open");
      const page = el.dataset.page;
      if (page === "tasks" || page === "design") { openWindow("project", store.projectId, proj().name, { projectTab: page }); return; }
      UI.switchWindow("home"); store.homePage = page; render();
    },
    "nav-toggle": () => { if (UI.activeWindow().kind === "home") document.body.classList.toggle("nav-open"); },
    "switch-window": el => UI.switchWindow(el.dataset.id),
    "close-window": el => UI.closeWindow(el.dataset.id),
    "close-window-confirm": el => { closeDialog(); UI.closeWindow(el.dataset.id, false, true); },
    "window-minimize": () => UI.windowControl("minimize"),
    "window-maximize": () => UI.windowControl("maximize"),
    "window-close": () => UI.windowControl("close"),
    "window-restore": () => UI.windowControl("restore"),
    "window-drag-guide": () => toast("浏览器原型只演示拖动热区，双击此处模拟最大化／还原", "info"),
    theme: () => setTheme(store.theme === "dark" ? "light" : "dark"),
    "set-theme": el => setTheme(el.dataset.theme),
    notify: () => toast("2 条通知：RUN-2084 验证失败 · STORY-0201 阻塞", "bell"),
    // CR-046：更新徽标演示。available → 下载进度 → ready → applying；只改内存状态，不联网、不重启浏览器。
    update: () => {
      if (store.updatePhase === "available") {
        store.updatePhase = "downloading";
        store.updateProgress = 0;
        if (store.updateTimer) clearInterval(store.updateTimer);
        store.updateTimer = setInterval(() => {
          store.updateProgress = Math.min(100, (store.updateProgress || 0) + 7);
          if (store.updateProgress >= 100) {
            clearInterval(store.updateTimer);
            store.updateTimer = null;
            store.updatePhase = "ready";
            store.updateProgress = 100;
            toast("更新包已下载并通过 SHA-256 校验（仿真）", "download");
          }
          render();
        }, 180);
        render();
        toast("开始下载更新 v" + store.updateVersion + "（仿真）", "download");
      } else if (store.updatePhase === "ready") {
        store.updatePhase = "applying";
        render();
        setTimeout(() => {
          store.updatePhase = "ready";
          render();
          toast("已模拟重启并安装更新；安装版运行安装包，免安装版替换程序后重新启动（原型不重启浏览器）", "info");
        }, 1200);
      }
    },
    "search-focus": () => openSearch(),
    "user-menu": () => openSettings("general"),

    /* ---------- 项目 ---------- */
    "project-filter": el => { store.projectFilter = el.dataset.kind; render(); },
    "proj-search": () => {},
    "project-new": () => { store.projectPathDraft = ""; store.projectDraft = null; S().projectModal("new"); },
    "project-edit": el => { store.projectPathDraft = ""; S().projectModal("edit", el.dataset.id); },
    "project-save": el => {
      const mode = el.dataset.mode;
      const data = {
        name: val("pf-name").trim(), key: (val("pf-key").trim() || "NEW").toUpperCase(), kind: val("pf-kind"),
        owner: val("pf-owner").trim() || D.user.name, desc: val("pf-desc").trim(),
        path: store.projectPathDraft || val("pf-path").trim(), members: val("pf-members").split(/[、,，\s]+/).filter(Boolean)
      };
      if (!data.name) { toast("请填写项目名称"); return; }
      if (mode === "edit") {
        const p = projById(el.dataset.id);
        Object.assign(p, data, { ownerInitials: data.owner.slice(0, 1).toUpperCase(), updated: "刚刚" });
        toast("项目已保存");
      } else {
        const id = "PRJ-" + (1000 + D.projects.length + 1);
        D.projects.push({
          id, ...data, ownerInitials: data.owner.slice(0, 1).toUpperCase(), tone: data.kind === "code" ? "blue" : "amber",
          stories: 0, done: 0, running: 0, updated: "刚刚", tags: ["新建"], branch: data.kind === "code" ? "main" : "", repo: data.path, createdAt: "今天"
        });
        toast("已创建项目：" + data.name);
      }
      closeDialog(); render();
    },
    "open-project": el => { closeDialog(); openWindow("project", el.dataset.id, projById(el.dataset.id).name); },
    "dir-pick": () => { store.projectDraft = { name: val("pf-name"), key: val("pf-key"), kind: val("pf-kind"), owner: val("pf-owner"), desc: val("pf-desc"), members: val("pf-members") }; store.dirReturn = store.projectModal; S().dirPicker(); },
    "dir-choose": el => { store.dirPick = el.dataset.path; document.getElementById("dir-current").textContent = el.dataset.path; document.querySelectorAll(".dir-row").forEach(r => r.classList.toggle("on", r === el)); },
    "dir-confirm": () => {
      if (!store.dirPick) { toast("请先选择一个文件夹"); return; }
      store.projectPathDraft = store.dirPick;
      const back = store.dirReturn;
      store.dirPick = "";
      if (back) S().projectModal(back.mode, back.id);
    },

    /* ---------- 工作台跳转 ---------- */
    "open-task-global": el => openWindow("project", el.dataset.project, projById(el.dataset.project).name, { projectTab: "tasks", taskId: el.dataset.id }),
    "jump-req": el => openWindow("project", el.dataset.project, projById(el.dataset.project).name, { selectedReq: el.dataset.id, projectTab: "requirements" }),

    /* ---------- 需求 ---------- */
    "select-req": el => { store.selectedReq = el.dataset.id; store.reqMenu = null; render(); },
    "toggle-req": el => { const id = el.dataset.id; const i = store.collapsed.indexOf(id); if (i >= 0) store.collapsed.splice(i, 1); else store.collapsed.push(id); render(); },
    "req-detail": el => { store.selectedReq = el.dataset.id; S().reqDetailModal(el.dataset.id); },
    "req-menu": el => {
      
      const rect = el.getBoundingClientRect();
      store.reqMenu = store.reqMenu === el.dataset.id ? null : el.dataset.id;
      store.reqMenuPos = { x: Math.max(8, Math.min(rect.right - 184, window.innerWidth - 200)), y: Math.min(rect.bottom + 4, window.innerHeight - 220) };
      render();
    },
    "req-new": el => { store.reqMenu = null; S().reqFormModal("new", "", el.dataset.parent || "", el.dataset.kind || "story"); },
    "req-edit": el => { store.reqMenu = null; S().reqFormModal("edit", el.dataset.id); },
    "req-delete": el => { store.reqMenu = null; S().reqDeleteModal(el.dataset.id); },
    "req-delete-confirm": el => {
      const ids = new Set([el.dataset.id]);
      let grew = true;
      while (grew) { grew = false; D.requirements.forEach(r => { if (r.parent && ids.has(r.parent) && !ids.has(r.id)) { ids.add(r.id); grew = true; } }); }
      D.requirements = D.requirements.filter(r => !ids.has(r.id));
      store.selectedReq = D.requirements.find(r => r.kind === "story" && r.project === store.projectId)?.id || null;
      closeDialog(); toast("已删除 " + ids.size + " 条需求"); render();
    },
    "req-save": el => {
      const mode = el.dataset.mode;
      const kind = val("rf-kind");
      const title = val("rf-title").trim();
      if (!title) { toast("请填写标题"); return; }
      const acText = val("rf-acs");
      const acs = acText ? acText.split("\n").map(s => s.trim()).filter(Boolean).map((text, i) => ({ id: "AC-" + String(i + 1).padStart(2, "0"), text, state: "pending" })) : [];
      if (mode === "edit") {
        const r = S().reqById(el.dataset.id);
        Object.assign(r, { title, summary: val("rf-summary").trim(), owner: val("rf-owner").trim(), estimate: val("rf-estimate").trim(), status: val("rf-status"), updated: "刚刚" });
        if (r.kind === "story") r.acs = acs.map((a, i) => ({ ...a, state: (r.acs && r.acs[i] && r.acs[i].state) || "pending" }));
        toast("需求已保存");
      } else {
        const { id } = nextId(kind, store.projectId);
        const node = {
          id, kind, project: store.projectId, title, summary: val("rf-summary").trim(), owner: val("rf-owner").trim() || D.user.name,
          estimate: val("rf-estimate").trim(), status: val("rf-status") || (kind === "story" ? "unconfirmed" : "running"),
          updated: "刚刚", parent: el.dataset.parent || undefined, deps: [], tests: "未执行", hash: "req 草稿 · design —",
          acs: kind === "story" ? acs : undefined, cli: kind === "story" ? "claude" : undefined, model: kind === "story" ? "tierflow-lite" : undefined
        };
        D.requirements.push(node);
        if (el.dataset.parent) { const p = S().reqById(el.dataset.parent); if (p) { store.collapsed = store.collapsed.filter(x => x !== p.id); } }
        store.selectedReq = id;
        toast("已创建 " + id + "：" + title);
      }
      closeDialog(); render();
    },
    "req-dispatch": el => { store.reqMenu = null; S().openDispatch(el.dataset.id); },
    dispatch: el => S().openDispatch(el.dataset.id),
    "confirm-dispatch": el => {
      const node = S().reqById(el.dataset.id);
      const stories = node.kind === "story" ? [node] : S().storiesOf(store.projectId).filter(s => { let p = S().reqById(s.parent); while (p) { if (p.id === node.id) return true; p = p.parent ? S().reqById(p.parent) : null; } return false; });
      const ready = stories.filter(s => s.status === "ready");
      ready.forEach((s, i) => {
        const num = 2100 + D.tasks.length + i;
        D.tasks.push({
          id: "RUN-" + num, title: s.title, story: s.id, project: store.projectId, status: "running", cli: s.cli, model: s.model,
          branch: "agent/" + s.id.toLowerCase(), started: "刚刚", duration: "进行中", progress: 6, round: 1,
          steps: [{ name: "准备", state: "active", time: "刚刚" }, { name: "实现", state: "todo", time: "—" }, { name: "验证", state: "todo", time: "—" }, { name: "评审", state: "todo", time: "—" }, { name: "交付", state: "todo", time: "—" }],
          artifacts: [], logs: [["刚刚", "已冻结范围并创建运行（仿真）"]], usage: { tokens: "0", cost: "¥0.00", commands: 0, files: 0 }
        });
        s.status = "running";
        s.updated = "刚刚";
      });
      store.projectTab = "tasks";
      store.taskId = D.tasks[D.tasks.length - 1]?.id || store.taskId;
      closeDialog();
      if (ready.length) { toast(`已创建 ${ready.length} 个运行`); render(); }
      else { toast("没有可派发的 Story"); render(); }
    },
    "tree-search": () => {},

    /* ---------- 设计 ---------- */
    "design-tab": el => { store.designTab = el.dataset.tab; store.designEdit = false; render(); },
    "design-edit": () => { store.designEdit = !store.designEdit; render(); },
    "design-save": () => { const v = val("design-editor"); const key = store.designTab; if (D.design[key]) { D.design[key].body = v; D.design[key].updated = "刚刚"; } store.designEdit = false; store.designDraft = null; toast("设计草稿已保存"); render(); },
    "design-toc": () => { store.designToc = !store.designToc; render(); },

    /* ---------- 任务 / 编码 ---------- */
    "project-tab": el => { store.projectTab = el.dataset.tab; render(); },
    "open-task": el => { store.taskId = el.dataset.id; store.projectTab = "tasks"; render(); const d = document.getElementById("task-detail"); if (d && getComputedStyle(d).position === "static") d.scrollIntoView({ behavior: "smooth", block: "start" }); },
    "tree-toggle": el => {
      const id = el.dataset.id;
      store.taskTreeCollapsed = store.taskTreeCollapsed || [];
      const i = store.taskTreeCollapsed.indexOf(id);
      if (i >= 0) store.taskTreeCollapsed.splice(i, 1); else store.taskTreeCollapsed.push(id);
      render();
    },
    "task-tree-all": el => {
      const mode = el.dataset.mode;
      const roots = D.tasks.filter(t => !t.parentId && D.tasks.some(c => c.parentId === t.id));
      store.taskTreeCollapsed = mode === "collapse" ? roots.map(t => t.id) : [];
      render();
    },
    "retry-task": el => { const t = D.tasks.find(x => x.id === el.dataset.id); if (t) { t.status = "running"; t.reason = ""; t.progress = 8; t.round += 1; t.branch = "agent/retry-" + t.id.toLowerCase(); } toast("已基于原运行创建重试，保留失败记录"); render(); },
    "code-rail": el => { store.codeRail = el.dataset.rail; store.codeEdit = false; render(); },
    "git-stage": el => { const c = D.git.changes.find(x => x.file === el.dataset.file); if (c) { c.staged = !c.staged; render(); } },
    "open-file": el => { store.codeFile = el.dataset.file; store.codeEdit = false; store.codeRail = "files"; render(); },
    "open-office": el => { store.officeDoc = el.dataset.name; render(); },
    "code-edit": () => { store.codeEdit = true; store.editingFile = store.codeFile; store.codeDraft = D.files[store.codeFile] || ""; render(); },
    "code-cancel": () => { store.codeEdit = false; store.codeDraft = null; render(); },
    "code-save": () => { D.files[store.codeFile] = val("code-editor"); store.codeEdit = false; store.codeDraft = null; toast("文件已保存到本机草稿"); render(); },
    "code-input": () => { store.codeDraft = val("code-editor"); },
    "git-diff": el => S().codeDiffModal(el.dataset.file),
    "git-msg": () => {},
    "git-msg-live": () => {},
    "git-gen": () => {
      const staged = D.git.changes.filter(c => c.staged);
      store.gitMessage = staged.length ? `feat(${staged[0].file.split("/")[1] || "core"}): 补充${staged.length}个文件的实现与测试` : "chore: 更新工作区";
      toast("AI 已生成提交信息（仿真）");
      render();
    },
    "git-commit": () => {
      const staged = D.git.changes.filter(c => c.staged);
      if (!staged.length || !store.gitMessage) { toast("先勾选文件并填写提交信息"); return; }
      const sha = Math.random().toString(16).slice(2, 9);
      D.git.commits.unshift({ sha, msg: store.gitMessage, author: D.user.name, time: "刚刚" });
      D.git.changes = D.git.changes.filter(c => !c.staged);
      D.git.ahead += 1;
      store.gitMessage = "";
      toast("已提交 " + staged.length + " 个文件（本机仿真）");
      render();
    },
    "git-pull": () => { toast("已提取远程更新（仿真）"); },
    "git-update": () => { toast("当前分支已更新（仿真）"); },
    "git-push": () => { D.git.pushed = true; toast("已推送当前分支（仿真）"); render(); },
    "git-branch-new": () => {
      openDialog(dlgShell("新建分支", "基于当前分支创建", `<div class="field"><label>分支名</label><input class="input" id="gb-name" placeholder="feature/…"></div>`, `<button class="btn" data-act="close-dialog">取消</button><button class="btn primary" data-act="git-branch-save">创建</button>`, "modal-sm"));
    },
    "git-branch-save": () => {
      const name = val("gb-name").trim();
      if (!name) { toast("请填写分支名"); return; }
      D.git.branch = name; store.gitMessage = ""; closeDialog(); toast("已切换并创建分支 " + name); render();
    },

    /* ---------- 知识库 ---------- */
    "kb-grant-open": el => { S().grantModal(el.dataset.id); },
    "grant-all": el => { const on = el.getAttribute("aria-checked") === "true"; el.setAttribute("aria-checked", String(!on)); },
    "kb-grant-save": el => {
      const lib = D.knowledge.libraries.find(l => l.id === el.dataset.id);
      const chosen = Array.from(document.querySelectorAll("[data-grant-project]")).filter(x => x.checked).map(x => x.dataset.grantProject);
      lib.grantedTo = chosen;
      lib.allProjects = document.querySelector(".grant-all .switch")?.getAttribute("aria-checked") === "true";
      lib.granted = lib.allProjects || chosen.length > 0;
      closeDialog(); toast("授权已保存：" + (lib.allProjects ? "所有项目" : chosen.length + " 个项目")); render();
    },
    "open-kb": el => { closeDialog(); openWindow("library", el.dataset.id, (D.knowledge.libraries.find(l => l.id === el.dataset.id) || {}).name); },
    "kb-jump": el => { closeDialog(); openWindow("library", el.dataset.kb, (D.knowledge.libraries.find(l => l.id === el.dataset.kb) || {}).name, { kbDoc: el.dataset.doc }); },
    "kb-doc": el => { store.kbDoc = el.dataset.id; render(); },
    "kb-search": () => {},

    /* ---------- 服务器 ---------- */
    "open-server": el => { closeDialog(); openWindow("server", el.dataset.id, (D.servers.find(s => s.id === el.dataset.id) || {}).name); },
    "term-submit": () => {},

    /* ---------- 设置 ---------- */
    "open-settings": el => { closeDialog(); openSettings(el && el.dataset ? el.dataset.tab : "general"); },
    "settings-tab": el => { closeDialog(); openSettings(el.dataset.tab); },
    "settings-back": () => { UI.closeDialog(); openSettings(store.settingsTab); },
    "settings-save": () => {
      const g = D.settings.general;
      g.profile.name = val("gen-name") || g.profile.name;
      g.profile.email = val("gen-email") || g.profile.email;
      g.profile.role = val("gen-role") || g.profile.role;
      g.profile.timezone = val("gen-tz");
      g.code.fontSize = parseInt(val("gen-font"), 10) || g.code.fontSize;
      g.code.tabSize = parseInt(val("gen-tab"), 10) || g.code.tabSize;
      g.server.port = parseInt(val("gen-port"), 10) || g.server.port;
      g.server.defaultUser = val("gen-user") || g.server.defaultUser;
      D.user.name = g.profile.name;
      D.user.email = g.profile.email;
      D.user.role = g.profile.role;
      toast("设置已保存");
      UI.closeDialog(); openSettings("general");
      render();
    },
    "set-code-theme": el => { D.settings.general.code.theme = el.dataset.theme; UI.closeDialog(); openSettings("general"); },
    "set-send-mode": el => { D.settings.general.sendMode = el.dataset.mode; UI.closeDialog(); openSettings("general"); },
    "provider-new": () => {
      const id = "PRV-" + String(D.settings.providers.length + 1).padStart(2, "0");
      D.settings.providers.push({ id, name: "新供应商", protocol: "Responses", enabled: true, updated: "刚刚", keys: [], endpoints: [{ protocol: "OpenAI", url: "", on: true }], headers: [], spoof: "关闭", models: [] });
      store.providerOpen = id; store.providerEdit = id; store.providerTab = "config"; store.modelEdit = null; store.endpointsOpen = false;
      S().refreshSettings();
    },
    "provider-expand": el => {
      const id = el.dataset.id;
      if (store.providerOpen === id) store.providerOpen = null;
      else {
        store.providerOpen = id; store.providerEdit = id; store.providerTab = "config"; store.endpointsOpen = false;
        const p = D.settings.providers.find(x => x.id === id);
        store.modelEdit = p && p.models[0] ? p.models[0].id : null;
      }
      S().refreshSettings();
    },
    "provider-edit": el => {
      store.providerOpen = el.dataset.id; store.providerEdit = el.dataset.id; store.providerTab = "config";
      const p = D.settings.providers.find(x => x.id === el.dataset.id);
      store.modelEdit = el.dataset.model || (p && p.models[0] ? p.models[0].id : null);
      S().refreshSettings();
    },
    "provider-toggle": el => { const p = D.settings.providers.find(x => x.id === el.dataset.id); if (p) p.enabled = !p.enabled; S().refreshSettings(); },
    "provider-delete": el => {
      const id = el.dataset.id;
      D.settings.providers = D.settings.providers.filter(x => x.id !== id);
      if (store.providerOpen === id) store.providerOpen = null;
      S().refreshSettings(); toast("已删除供应商");
    },
    "provider-tab": el => { store.providerTab = el.dataset.tab; S().refreshSettings(); },
    "provider-save": el => {
      const p = D.settings.providers.find(x => x.id === el.dataset.id);
      if (p) { p.name = val("pm-name") || p.name; p.updated = "刚刚"; }
      S().refreshSettings(); toast("供应商已保存");
    },
    "provider-key-add": () => { const p = D.settings.providers.find(x => x.id === store.providerOpen); if (p) { p.keys.push({ label: "新密钥", masked: "sk-****0000", on: true, scope: "全部模型" }); S().refreshSettings(); } },
    "provider-key-toggle": el => { const p = D.settings.providers.find(x => x.id === store.providerOpen); const k = p && p.keys[Number(el.dataset.idx)]; if (k) { k.on = !k.on; S().refreshSettings(); } },
    "provider-key-detect": () => { const p = D.settings.providers.find(x => x.id === store.providerOpen); if (p) { p.keys.push({ label: "自动探测", masked: "sk-****d3t3", on: true, scope: "全部模型" }); S().refreshSettings(); toast("已探测到 1 个可用密钥（仿真）"); } },
    "provider-protocol": el => { const p = D.settings.providers.find(x => x.id === store.providerOpen); if (p) { p.protocol = el.dataset.v; S().refreshSettings(); } },
    "provider-header-add": () => { const p = D.settings.providers.find(x => x.id === store.providerOpen); if (p) { p.headers.push({ name: "", value: "" }); S().refreshSettings(); } },
    "provider-header-del": el => { const p = D.settings.providers.find(x => x.id === store.providerOpen); if (p) { p.headers.splice(Number(el.dataset.idx), 1); S().refreshSettings(); } },
    "provider-spoof": el => { const p = D.settings.providers.find(x => x.id === store.providerOpen); if (p) { p.spoof = el.dataset.v; S().refreshSettings(); } },
    "model-pull": () => { const p = D.settings.providers.find(x => x.id === store.providerOpen); if (p) { const m = { id: "pulled-model-" + (p.models.length + 1), name: "Pulled Model " + (p.models.length + 1), modalities: ["文本"], thinking: false, levels: [], defaultLevel: "—", context: 128000, maxOutput: 16384, autoLevels: false, on: true }; p.models.push(m); store.modelEdit = m.id; S().refreshSettings(); toast("已获取 1 个可用模型（仿真）"); } },
    "model-auto-level": () => { const p = D.settings.providers.find(x => x.id === store.providerOpen); const m = p && p.models.find(x => x.id === store.modelEdit); if (m) { m.levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]; m.autoLevels = true; S().refreshSettings(); toast("已自动获取思考等级（7 档）"); } },
    "model-select": el => { const id = el.dataset.id; store.modelOpen = store.modelOpen === id ? null : id; store.modelEdit = id; S().refreshSettings(); },
    "model-pick-open": () => { const p = D.settings.providers.find(x => x.id === store.providerOpen); if (p) S().modelPickDialog(p); },
    "model-pick-save": () => {
      const p = D.settings.providers.find(x => x.id === store.providerOpen);
      if (!p) return;
      const chosen = Array.from(document.querySelectorAll("[data-pick-model]")).filter(x => x.checked).map(x => x.dataset.pickModel);
      chosen.forEach(id => { const src = (p.availableModels || []).find(m => m.id === id) || { id, name: id, modalities: ["文本"], context: 128000 }; p.models.push(autoModel({ id: src.id, name: src.name, modalities: src.modalities || ["文本"], context: src.context || 128000, on: true })); });
      UI.closeSubDialog();
      if (chosen.length) { store.modelOpen = chosen[0]; store.modelEdit = chosen[0]; }
      S().refreshSettings();
      toast(chosen.length ? `已添加 ${chosen.length} 个模型` : "未选择模型");
    },
    "model-autoconfig": () => { const p = D.settings.providers.find(x => x.id === store.providerOpen); const m = p && p.models.find(x => x.id === store.modelEdit); if (m) { Object.assign(m, autoModel(m)); S().refreshSettings(); toast("已按模型能力自动配置"); } },
    "model-modality": el => { const p = D.settings.providers.find(x => x.id === store.providerOpen); const m = p && p.models.find(x => x.id === store.modelEdit); if (m) { const v = el.dataset.v; m.modalities = m.modalities.includes(v) ? m.modalities.filter(x => x !== v) : m.modalities.concat(v); S().refreshSettings(); } },
    "model-thinking": () => { const p = D.settings.providers.find(x => x.id === store.providerOpen); const m = p && p.models.find(x => x.id === store.modelEdit); if (m) { m.thinking = !m.thinking; S().refreshSettings(); } },
    "model-level": el => { const p = D.settings.providers.find(x => x.id === store.providerOpen); const m = p && p.models.find(x => x.id === store.modelEdit); if (m) { const v = el.dataset.v; m.levels = m.levels.includes(v) ? m.levels.filter(x => x !== v) : m.levels.concat(v); S().refreshSettings(); } },
    "model-delete": el => { const p = D.settings.providers.find(x => x.id === store.providerOpen); if (!p) return; if (p.models.length <= 1) { toast("至少保留一个模型"); return; } p.models = p.models.filter(x => x.id !== el.dataset.id); if (store.modelOpen === el.dataset.id) store.modelOpen = null; S().refreshSettings(); toast("已删除模型"); },
    "model-save": () => { const p = D.settings.providers.find(x => x.id === store.providerOpen); const m = p && p.models.find(x => x.id === store.modelEdit); if (m) { m.id = val("m-id") || m.id; m.name = val("m-name") || m.name; m.context = parseInt(val("m-ctx"), 10) || m.context; m.maxOutput = parseInt(val("m-max"), 10) || m.maxOutput; m.defaultLevel = val("m-default") || m.defaultLevel; } S().refreshSettings(); toast("模型配置已保存"); },
    "key-alias": el => { store.keyEdit = { idx: Number(el.dataset.idx), mode: "alias" }; S().refreshSettings(); },
    "key-value": el => { store.keyEdit = { idx: Number(el.dataset.idx), mode: "value" }; S().refreshSettings(); },
    "key-protocol": el => { store.keyEdit = { idx: Number(el.dataset.idx), mode: "protocol" }; S().refreshSettings(); },
    "key-scope": el => { store.keyEdit = { idx: Number(el.dataset.idx), mode: "scope" }; S().refreshSettings(); },
    "key-remove": el => { store.keyEdit = { idx: Number(el.dataset.idx), mode: "remove" }; S().refreshSettings(); },
    "key-edit-cancel": () => { store.keyEdit = null; S().refreshSettings(); },
    "key-protocol-set": el => { const p = D.settings.providers.find(x => x.id === store.providerOpen); const k = p && p.keys[Number(el.dataset.idx)]; if (k) { k.protocol = el.dataset.v; store.keyEdit = null; S().refreshSettings(); } },
    "key-save": el => {
      const p = D.settings.providers.find(x => x.id === store.providerOpen); if (!p) return;
      const k = p.keys[Number(el.dataset.idx)]; if (!k) return;
      const mode = el.dataset.mode;
      if (mode === "alias") k.label = val("key-alias-input") || k.label;
      else if (mode === "value") k.masked = val("key-value-input") || k.masked;
      else if (mode === "scope") { k.models = Array.from(document.querySelectorAll("[data-key-model]")).filter(x => x.checked).map(x => x.dataset.keyModel); k.scope = k.models.length ? k.models.length + " 个模型" : "全部模型"; }
      store.keyEdit = null; S().refreshSettings(); toast("密钥已更新");
    },
    "key-remove-confirm": el => { const p = D.settings.providers.find(x => x.id === store.providerOpen); if (!p) return; if (p.keys.length <= 1) { toast("至少保留一个密钥"); store.keyEdit = null; S().refreshSettings(); return; } p.keys.splice(Number(el.dataset.idx), 1); store.keyEdit = null; S().refreshSettings(); toast("已删除密钥"); },
    "close-sub": () => UI.closeSubDialog(),
    "sdk-expand": el => { store.sdkOpen = store.sdkOpen === el.dataset.id ? null : el.dataset.id; S().refreshSettings(); },
    "sdk-tab": el => { store.sdkTab = el.dataset.tab; S().refreshSettings(); },
    "cli-toggle": el => { const c = D.settings.clis.find(x => x.id === el.dataset.id); if (c) c.enabled = !c.enabled; S().refreshSettings(); },
    "cli-expand": el => { store.cliOpen = store.cliOpen === el.dataset.id ? "" : el.dataset.id; S().refreshSettings(); },
    "cli-type": el => { const c = D.settings.clis.find(x => x.id === el.dataset.id); if (c) { const t = el.dataset.type; c.types = c.types.includes(t) ? c.types.filter(x => x !== t) : c.types.concat(t); S().refreshSettings(); } },
    "sdk-install": el => { const s = D.settings.sdks.find(x => x.id === el.dataset.id); if (s) { s.installed = true; s.version = s.latest; toast("已安装 " + s.name + "（仿真）"); S().refreshSettings(); } },
    "sdk-uninstall": el => { const s = D.settings.sdks.find(x => x.id === el.dataset.id); if (s) { s.installed = false; s.version = "—"; toast("已卸载 " + s.name + "（仿真）"); S().refreshSettings(); } },
    "sdk-check": el => { const s = D.settings.sdks.find(x => x.id === el.dataset.id); if (s) { s.version = s.latest; toast("已重新检测：" + s.name + " " + s.version); S().refreshSettings(); } },
    "sdk-check-all": () => { D.settings.sdks.forEach(s => { if (s.installed) s.version = s.latest; }); toast("已重新检测全部 SDK"); S().refreshSettings(); },
    "skill-add": () => S().skillModal("add"),
    "skill-import": () => S().skillModal("import"),
    "skill-save": el => {
      const name = val("sk-name").trim(); const slug = val("sk-slug").trim();
      if (!name || !slug) { toast("请填写名称与标识"); return; }
      D.settings.skills.push({ name, slug, desc: val("sk-desc") || "导入的技能", source: el.dataset.mode === "import" ? "导入" : "手动添加", updated: "刚刚", on: true, uses: 0 });
      UI.closeSubDialog(); store.settingsTab = "skills"; S().refreshSettings(); toast("已添加技能 " + name);
    },
    "skill-toggle": el => { const s = D.settings.skills[Number(el.dataset.idx)]; if (s) { s.on = !s.on; S().refreshSettings(); } },
    "mcp-add": () => S().mcpModal("add"),
    "mcp-import": () => S().mcpModal("import"),
    "mcp-save": el => {
      const name = val("mc-name").trim(); const target = val("mc-target").trim();
      if (!name) { toast("请填写名称"); return; }
      if (D.settings.mcp.some(m => m.name === name)) { toast("MCP 名称重复，已拒绝"); return; }
      D.settings.mcp.push({ name, transport: val("mc-transport"), target, on: true, tools: 0, source: el.dataset.mode === "import" ? "导入" : "手动添加", updated: "刚刚" });
      UI.closeSubDialog(); store.settingsTab = "mcp"; S().refreshSettings(); toast("已添加 MCP " + name);
    },
    "mcp-toggle": el => { const m = D.settings.mcp[Number(el.dataset.idx)]; if (m) { m.on = !m.on; S().refreshSettings(); } },
    "tool-toggle": el => { const t = D.settings.tools[Number(el.dataset.idx)]; if (t) { t.on = !t.on; S().refreshSettings(); } },

    /* ---------- AI ---------- */
    "ai-toggle": () => { store.aiOpen = !store.aiOpen; render(); },
    "ai-history": () => { store.aiHistory = !store.aiHistory; store.aiTop = null; store.aiPop = null; store.aiMenu = null; render(); },
    "ai-history-close": () => { store.aiHistory = false; render(); },
    "ai-new": () => AIPanel.newSession(),
    "ai-switch": el => AIPanel.switchSession(el.dataset.id),
    "ai-menu-open": el => { store.aiMenu = "add"; store.aiMenuTab = el.dataset.tab || "add"; store.aiMenuQuery = ""; render(); setTimeout(() => { const q = document.getElementById("ai-menu-q"); if (q) q.focus(); }, 20); },
    "ai-menu-tab": el => { store.aiMenuTab = el.dataset.tab; store.aiMenu = "add"; render(); },
    "ai-menu-q": () => {},
    "ai-pick": el => {
      const kind = el.dataset.kind;
      if (kind === "file") { store.aiMenu = null; openFilePicker(); }
      else if (kind === "goal") { store.aiMenu = null; goalDialog(); }
      else if (kind === "plan") { store.aiMenu = null; store.aiPermission = "规划模式"; toast("已进入规划模式：只读工具生成计划"); render(); }
      else { store.aiMenu = null; feedbackDialog(); }
    },
    "ai-insert": el => AIPanel.insert(el.dataset.text),
    "ai-permission": () => { store.aiPop = store.aiPop === "perm" ? null : "perm"; store.aiMenu = null; render(); },
    "ai-perm-set": el => { store.aiPermission = el.dataset.name; store.aiPop = null; toast("权限模式：" + el.dataset.name); render(); },
    "ai-cli": () => { store.aiPop = store.aiPop === "cli" ? null : "cli"; store.aiMenu = null; render(); },
    "ai-cli-set": el => { store.aiCli = el.dataset.id; store.aiPop = null; toast("已切换 CLI：" + el.dataset.id); render(); },
    "ai-model": () => { store.aiPop = store.aiPop === "model" ? null : "model"; store.aiMenu = null; store.aiTop = null; store.aiModelQuery = ""; render(); },
    "ai-model-provider": el => { const cat = D.ai.modelCatalog; cat.current.provider = el.dataset.name; const list = AIPanel.visibleModels(cat.providers.find(p => p.name === el.dataset.name)); if (list.length) cat.current.model = list[0].name; if (!AIPanel.currentModel().thinking) cat.current.level = "—"; else if (!cat.levels.includes(cat.current.level)) cat.current.level = "High"; store.aiModelQuery = ""; render(); },
    "ai-model-set": el => { const cat = D.ai.modelCatalog; cat.current.model = el.dataset.name; const m = AIPanel.currentModel(); if (m.thinking) { if (!cat.levels.includes(cat.current.level)) cat.current.level = "High"; } else cat.current.level = "—"; render(); },
    "ai-level": el => { D.ai.modelCatalog.current.level = D.ai.modelCatalog.levels[Number(el.value)]; render(); },
    "ai-step-advance": () => AIPanel.advanceStep(),
    "ai-steps-toggle": () => { store.aiStepsOpen = !store.aiStepsOpen; render(); },
    "ai-send": () => AIPanel.send(),
    "ai-approve": el => AIPanel.approve(Number(el.dataset.idx), true),
    "ai-deny": el => AIPanel.approve(Number(el.dataset.idx), false),
    "ai-show-cmd": () => openDialog(dlgShell("待审批命令", "逐次确认，不记忆放行", `<pre class="mono" style="padding:12px;background:var(--surface-2);border:1px solid var(--line);border-radius:6px">pnpm vitest run tests/capacity-rollback.spec.ts\n\n工作目录：D:/work/booking-service\n风险：写入测试文件\n超时：120s</pre>`, `<button class="btn" data-act="close-dialog">关闭</button>`, "modal-sm")),
    "ai-stat": el => { store.aiPop = store.aiPop === el.dataset.stat ? null : el.dataset.stat; store.aiMenu = null; store.aiTop = null; render(); },
    "ai-subagents": () => { store.aiTop = store.aiTop === "agents" ? null : "agents"; store.aiPop = null; store.aiMenu = null; store.aiBgOpen = null; render(); },
    "ai-background": () => { store.aiTop = store.aiTop === "bg" ? null : "bg"; store.aiPop = null; store.aiMenu = null; store.aiBgOpen = null; render(); },
    "ai-bg-toggle": el => { store.aiBgOpen = store.aiBgOpen === el.dataset.id ? null : el.dataset.id; render(); },
    "bg-clear": () => { D.ai.background = D.ai.background.filter(b => b.state === "运行中"); store.aiBgOpen = null; toast("已清空结束的后台记录"); render(); },
    "ai-export": () => {
      const s = AIPanel.activeSession();
      const text = `# ${s.title}\n\n模型：${D.ai.modelCatalog.current.model} · 权限：${store.aiPermission}\n\n` +
        (s.messages || []).map(m => `## ${m.role === "user" ? D.user.name : "AI"} ${m.time}\n\n${m.text}`).join("\n\n");
      download(s.title.replace(/[\\/:*?"<>|]/g, "-") + ".md", text);
      store.aiMenu = null; toast("已导出会话日志", "download"); render();
    },
    "ai-file-pick": () => openFilePicker(),
    "ai-resize": () => {},

    "task-pause": el => { const t = D.tasks.find(x => x.id === el.dataset.id); if (t) { t.status = "paused"; t.reason = "已暂停：仅本机仿真"; toast("任务已暂停"); render(); } },
    "task-accept": el => { const t = D.tasks.find(x => x.id === el.dataset.id); if (t) { t.status = "succeeded"; const r = S().reqById(t.story); if (r) r.status = "completed"; toast("已验收当前产物，Story 状态更新"); render(); } },
    "task-transcript": el => {
      const t = D.tasks.find(x => x.id === el.dataset.id);
      if (!t) return;
      openDialog(dlgShell("运行记录", t.id + " · " + t.title, `<div class="stack-sm">
        <dl class="facts"><dt>执行器</dt><dd>${esc(t.cli)} / ${esc(t.model)}</dd><dt>分支</dt><dd class="mono">${esc(t.branch)}</dd><dt>用量</dt><dd>${esc(t.usage.tokens)} tokens · ${esc(t.usage.cost)}</dd><dt>第几轮</dt><dd>${t.round}</dd></dl>
        <div class="caption">日志</div><div class="log">${t.logs.map(([time, msg]) => `<div class="ln"><span class="t">${esc(time)}</span><span>${esc(msg)}</span></div>`).join("")}</div>
        <div class="caption">产物</div>${t.artifacts.length ? t.artifacts.map(a => `<div class="artifact">${icon("file", "ico-14")}<span class="fname">${esc(a.name)}</span><span class="muted">${esc(a.change)}</span></div>`).join("") : '<div class="caption">无</div>'}
      </div>`, `<button class="btn" data-act="close-dialog">关闭</button>`, "modal-md"));
    },
    "file-new": () => openDialog(dlgShell("新建文件", "写入当前演示工程", `<div class="field"><label>文件路径</label><input class="input" id="nf-path" placeholder="src/booking/new.ts"></div><div class="field"><label>初始内容</label><textarea class="textarea mono" id="nf-body" rows="5"></textarea></div>`, `<button class="btn" data-act="close-dialog">取消</button><button class="btn primary" data-act="file-new-save">创建</button>`, "modal-sm")),
    "file-new-save": () => { const f = val("nf-path").trim(); if (!f) { toast("请填写文件路径"); return; } D.files[f] = val("nf-body") || ""; store.codeFile = f; closeDialog(); toast("已创建 " + f); render(); },
    "cli-save": el => { const c = D.settings.clis.find(x => x.id === el.dataset.id); if (!c) return; const model = val("cli-model-" + c.id), effort = val("cli-effort-" + c.id), min = val("cli-min-" + c.id), perm = val("cli-perm-" + c.id); if (model) c.model = model; if (effort) c.effort = effort; if (min) c.minDifficulty = min; if (perm) c.permission = perm; closeDialog(); openSettings("cli"); toast("CLI 配置已保存"); },
    "design-export": () => { const doc = D.design[store.designTab]; download(doc.name, doc.body); toast("已导出 " + doc.name, "download"); },
    "git-pull": () => { D.git.commits.unshift({ sha: Math.random().toString(16).slice(2, 9), msg: "merge origin/" + D.git.branch, author: "远程", time: "刚刚" }); toast("已提取远程更新（仿真）"); render(); },
    "git-update": () => { D.git.ahead = Math.max(0, D.git.ahead - 1); toast("当前分支已更新（仿真）"); render(); },
    "kb-new": () => kbNewDialog(),
    "kb-new-save": () => {
      const name = val("kb-name").trim();
      if (!name) { toast("请填写知识库名称"); return; }
      const id = "KB-" + String(D.knowledge.libraries.length + 1).padStart(2, "0");
      D.knowledge.libraries.push({ id, name, desc: val("kb-desc") || "新建知识库", docs: 0, updated: "刚刚", grantedTo: [], allProjects: false, granted: false, owner: val("kb-owner") || D.user.name, tone: "blue", path: val("kb-path") });
      D.knowledge.docs[id] = [];
      closeDialog(); render(); toast("已创建知识库 " + name);
    },
    "kb-reindex": () => {
      D.knowledge.libraries.forEach(l => { l.updated = "刚刚"; });
      if (store.active.startsWith("library:")) render();
      toast("已重新索引 " + D.knowledge.libraries.length + " 个知识库（仿真）");
      render();
    },
    "server-new": () => serverNewDialog(),
    "server-new-save": () => {
      const name = val("sv-name").trim(); const host = val("sv-host").trim();
      if (!name || !host) { toast("请填写名称与地址"); return; }
      const id = "SRV-" + String(D.servers.length + 1).padStart(2, "0");
      D.servers.push({ id, name, host, address: host.split("@").pop(), username: host.split("@")[0] || "ops", port: Number(val("sv-port")) || 22, group: val("sv-group"), auth: val("sv-auth"), credentialRef: "DEMO-CREDENTIAL", online: false, connected: false, authorized: false, output: "新主机尚未连接（DEMO）。", os: "未知", uptime: "—", last: "从未", cpu: [], mem: null, disk: null, load: [], files: [] });
      closeDialog(); render(); toast("已添加主机 " + name);
    },
    "server-file": el => serverFileDialog(el.dataset.file),
    "provider-endpoints": () => { store.endpointsOpen = !store.endpointsOpen; S().refreshSettings(); },
    "provider-endpoint-add": () => {
      const p = D.settings.providers.find(x => x.id === store.providerOpen);
      if (p) { p.endpoints.push({ protocol: p.protocol === "Anthropic" ? "Anthropic" : "OpenAI", url: "", on: false }); S().refreshSettings(); }
    },
    "model-reset": () => {
      const p = D.settings.providers.find(x => x.id === store.providerOpen);
      const m = p && p.models.find(x => x.id === store.modelEdit);
      if (m) { m.levels = ["off", "low", "medium", "high"]; m.defaultLevel = "中"; m.autoLevels = false; S().refreshSettings(); toast("已恢复默认思考档位"); }
    },
    "ai-goal-save": () => { AIPanel.activeSession().goal = val("goal-text"); closeDialog(); toast("会话目标已保存"); },
    "ai-feedback-save": () => { D.ai.feedback = D.ai.feedback || []; D.ai.feedback.push({ at: "刚刚", text: val("fb-text") }); closeDialog(); toast("反馈已保存到本机演示"); },
    "cli-check": el => { const c = D.settings.clis.find(x => x.id === el.dataset.id); if (c) { c.meta = c.meta.replace(/^已检测 · /, "") ; c.checked = "刚刚"; toast(c.name + " 已重新检测（" + c.version + "）"); } },


    "close-dialog": () => UI.closeTopDialog(),
    toast: el => toast(el.dataset.msg || "演示操作")
  };

  function openSettings(tab) { store.settingsTab = tab || "general"; UI.closeDialog(); S().openSettings(tab); }

  function setTheme(theme) {
    store.theme = theme; document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("wb4-theme", theme); } catch (e) { /* noop */ }
    render();
  }

  function download(name, text) {
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  }

  function openFilePicker() {
    if (window.OfficeAI && OfficeAI.isActive()) { OfficeAI.filePicker(); return; }
    const items = Object.keys(D.files).map(f => ({ kind: "项目文件", title: f, insert: "@" + f }))
      .concat(Object.values(D.knowledge.docs).flat().map(d => ({ kind: "知识库", title: d.title, insert: "@" + d.title })))
      .concat(D.ai.sessions.map(s => ({ kind: "对话", title: s.title, insert: "@" + s.title })));
    openDialog(dlgShell("选择文件或对话", "选择后以 @ 引用插入输入框", `<div class="stack-sm" style="max-height:420px;overflow:auto">${items.map(x => `<button class="menu-item" data-act="ai-insert" data-text="${esc(x.insert)}"><span class="tag gray">${x.kind}</span><span class="mi-main"><b>${esc(x.title)}</b></span></button>`).join("")}</div>`, `<span class="left caption">共 ${items.length} 项</span><button class="btn" data-act="close-dialog">取消</button>`, "modal-md"));
  }

  function goalDialog() {
    const s = AIPanel.activeSession();
    openDialog(dlgShell("设置会话目标", "目标用于长期任务的收敛，不改变权限", `<div class="field"><label>目标</label><textarea class="textarea" id="goal-text" rows="4">${esc(s.goal || (window.OfficeAI && OfficeAI.isActive() ? "核对本项目资料来源，整理可审阅的报告与汇报。" : "让 STORY-0102 的容量校验通过 AC-02 与 AC-03，并把证据整理到交付包。"))}</textarea></div>`, `<button class="btn" data-act="close-dialog">取消</button><button class="btn primary" data-act="ai-goal-save">保存目标</button>`, "modal-sm"));
  }
  function feedbackDialog() {
    openDialog(dlgShell("会话反馈", "仅保存到本机演示状态", `<div class="field"><label>反馈内容</label><textarea class="textarea" id="fb-text" rows="4" placeholder="哪里不准确、哪里需要更快…"></textarea></div>`, `<button class="btn" data-act="close-dialog">取消</button><button class="btn primary" data-act="ai-feedback-save">提交反馈</button>`, "modal-sm"));
  }

  function kbNewDialog() {
    openDialog(dlgShell("新建知识库", "本地目录只作为源，不复制真实文件", `<div class="form-grid">
      <div class="form-row"><label>名称</label><input class="input" id="kb-name" placeholder="例如：发布手册"></div>
      <div class="form-row"><label>说明</label><input class="input" id="kb-desc" placeholder="一句话说明内容"></div>
      <div class="form-row"><label>本地目录</label><input class="input" id="kb-path" value="D:/knowledge/new-library"></div>
      <div class="form-row"><label>负责人</label><input class="input" id="kb-owner" value="${esc(D.user.name)}"></div>
    </div>`, `<button class="btn" data-act="close-dialog">取消</button><button class="btn primary" data-act="kb-new-save">创建</button>`, "modal-sm"));
  }

  function serverNewDialog() {
    openDialog(dlgShell("添加主机", "演示：不建立真实 SSH 连接", `<div class="form-grid">
      <div class="form-row"><label>名称</label><input class="input" id="sv-name" placeholder="例如：预发布"></div>
      <div class="form-row"><label>地址</label><input class="input" id="sv-host" placeholder="ops@192.0.2.10"></div>
      <div class="form-row two"><div><label>分组</label><input class="input" id="sv-group" value="测试"></div><div><label>端口</label><input class="input" id="sv-port" value="22"></div></div>
      <div class="form-row"><label>认证</label><select class="select" id="sv-auth"><option>密钥文件</option><option>密码</option><option>跳板机</option></select></div>
    </div>`, `<button class="btn" data-act="close-dialog">取消</button><button class="btn primary" data-act="server-new-save">添加</button>`, "modal-sm"));
  }

  function serverFileDialog(file) {
    const online = true;
    openDialog(dlgShell("文件预览", esc(file), `<pre class="mono" style="max-height:360px;overflow:auto;padding:12px;background:var(--surface-2);border:1px solid var(--line);border-radius:6px"># ${esc(file)}\n\nDEMO 文件内容占位。真实实现会读取远端文件并按类型预览；本设计稿不建立 SSH 连接。\n\n- 修改时间：今天 14:10\n- 大小：12.4 KB\n- 编码：UTF-8</pre>
      <div class="row"><button class="btn sm" data-act="toast" data-msg="演示：下载远端文件">${icon("download", "ico-14")}下载</button><button class="btn sm" data-act="toast" data-msg="演示：在终端打开">${icon("terminal", "ico-14")}在终端打开</button></div>`, `<span class="left caption">只读预览</span><button class="btn" data-act="close-dialog">关闭</button>`, "modal-md"));
  }


  const TERM_HELP = "可用命令：help、uptime、free -h、df -h、ls、whoami、systemctl status";
  function runTerminal(cmd, serverId) {
    const s = D.servers.find(x => x.id === serverId) || D.servers[0];
    const c = cmd.trim();
    if (!c) return;
    if (!store.termLog || store.termServer !== s.id) { store.termLog = (D.terminal[s.id] || []).map(h => ({ cmd: h.cmd, out: h.out })); store.termServer = s.id; }
    let out;
    if (s.status !== "online") out = "连接失败：主机离线（DEMO）。";
    else if (c === "help") out = TERM_HELP;
    else if (c === "uptime") out = " 14:35:02 up 12 days,  6:05,  1 user,  load average: 0.36, 0.28, 0.22";
    else if (c === "free -h") out = "               total        used        free      shared  buff/cache   available\nMem:           8.0Gi       3.1Gi       4.0Gi        64Mi       1.0Gi       5.0Gi";
    else if (c === "df -h") out = "Filesystem      Size  Used Avail Use% Mounted on\n/dev/demo        80G   34G   46G  43% /srv";
    else if (c === "ls") out = "releases  shared  .env.example";
    else if (c === "whoami") out = "ops";
    else if (c.startsWith("systemctl status")) out = "● booking.service - Booking API\n     Active: active (running) since Tue 2026-11-18 09:12:04 UTC\n   Main PID: 842 (node)";
    else out = "命令不在白名单，已拒绝执行（DEMO）。高风险命令需逐次审批。";
    store.termLog.push({ cmd: c, out });
    render();
  }

  /* ---------------- 全局搜索 ---------------- */
  function openSearch() {
    openDialog(dlgShell("快速搜索", "项目、需求、文档与主机（仿真索引）", `<label class="search">${icon("search", "ico-14")}<input class="input" id="global-q" placeholder="输入关键词，例如 容量 / 预约 / RUN-2087" autofocus></label><div id="global-results" class="stack-sm" style="margin-top:6px"><div class="caption">输入关键词开始搜索。</div></div>`, `<button class="btn" data-act="close-dialog">关闭</button>`, "modal-md"));
    setTimeout(() => { const el = document.getElementById("global-q"); if (el) el.focus(); }, 30);
  }
  function renderSearch(q) {
    const box = document.getElementById("global-results");
    if (!box) return;
    const term = q.trim().toLowerCase();
    if (!term) { box.innerHTML = '<div class="caption">输入关键词开始搜索。</div>'; return; }
    const items = [
      ...D.projects.map(p => ({ kind: "项目", title: p.name, meta: p.id + " · " + p.owner, act: "open-project", id: p.id })),
      ...D.requirements.map(r => ({ kind: "需求", title: r.title, meta: r.id + " · " + (D.statusMeta[r.status] || {}).label, act: "jump-req", id: r.id, project: r.project })),
      ...Object.keys(D.files).map(f => ({ kind: "文件", title: f, meta: "项目文件", act: "kb-search-none", file: f })),
      ...D.knowledge.libraries.flatMap(l => (D.knowledge.docs[l.id] || []).map(d => ({ kind: "文档", title: d.title, meta: l.name + " · " + d.path, act: "kb-jump", id: l.id, doc: d.id })))
    ].filter(x => (x.title + " " + x.meta).toLowerCase().includes(term)).slice(0, 8);
    box.innerHTML = items.length ? items.map(x => `<button class="menu-item" data-act="${x.act}" data-id="${x.id || ""}" data-project="${x.project || ""}" data-doc="${x.doc || ""}" data-file="${x.file || ""}"><span class="tag gray">${x.kind}</span><span class="mi-main"><b>${esc(x.title)}</b><span>${esc(x.meta)}</span></span></button>`).join("") : '<div class="caption">没有命中。</div>';
  }

  /* ---------------- 拖动 AI 宽度 ---------------- */
  let resizing = false;
  document.addEventListener("mousedown", e => {
    if (window.PaneResize) return;
    const handle = e.target.closest("[data-act=ai-resize]");
    if (!handle) return;
    resizing = true; e.preventDefault();
    document.body.style.cursor = "col-resize";
  });
  document.addEventListener("mousemove", e => {
    if (!resizing) return;
    const w = Math.max(320, Math.min(620, window.innerWidth - e.clientX));
    store.aiWidth = w;
    const panel = document.querySelector(".ai-panel");
    if (panel) panel.style.width = w + "px";
  });
  document.addEventListener("mouseup", () => { if (resizing) { resizing = false; document.body.style.cursor = ""; } });

  /* ---------------- 事件 ---------------- */
  document.addEventListener("click", e => {
    if (document.body.classList.contains("nav-open") && !e.target.closest(".sidebar") && !e.target.closest(".topbar")) document.body.classList.remove("nav-open");
    const hadMenu = Boolean(store.reqMenu || store.aiPop || store.aiMenu || store.aiTop || store.aiHistory);
    if (store.reqMenu && !e.target.closest("#req-menu") && !e.target.closest("[data-act=req-menu]")) store.reqMenu = null;
    if ((store.aiPop || store.aiMenu) && !e.target.closest(".ai-panel")) { store.aiPop = null; store.aiMenu = null; }
    if (store.aiTop && !e.target.closest(".ai-drop-wrap")) store.aiTop = null;
    if (store.aiHistory && !e.target.closest(".ai-history") && !e.target.closest("[data-act=ai-history]")) store.aiHistory = false;
    const el = e.target.closest("[data-act]");
    if (!el) { if (hadMenu) render(); return; }
    const fn = actions[el.dataset.act];
    if (!fn) { if (hadMenu) render(); return; }
    if (el.tagName === "A") e.preventDefault();
    fn(el, e);
    if (hadMenu) render();
  });

  document.addEventListener("dblclick", e => { if (e.target.closest(".window-drag-guide")) UI.windowControl("maximize"); });
  document.addEventListener("error", e => {
    const img = e.target;
    if (!img?.matches?.("img[data-cli-asset]")) return;
    const parent = img.parentElement;
    parent.classList.remove("asset-pending"); parent.classList.add("asset-unavailable");
    parent.title = img.dataset.cliAsset + " · 官方图标资源未就绪";
    parent.setAttribute("aria-label", parent.title);
    img.hidden = true;
    if (!parent.querySelector("svg")) parent.insertAdjacentHTML("beforeend", icon("error", "ico-14"));
    const status = parent.querySelector(".sr-only"); if (status) status.textContent = "官方图标资源未就绪";
  }, true);
  document.addEventListener("load", e => {
    const img = e.target;
    if (!img?.matches?.("img[data-cli-asset]")) return;
    const parent = img.parentElement;
    parent.classList.remove("asset-pending"); parent.classList.add("asset-ready");
    parent.title = img.dataset.cliAsset + " · 官方品牌资产（独立 CLI 标志来源见资源索引）";
    parent.setAttribute("aria-label", parent.title);
    const status = parent.querySelector(".sr-only"); if (status) status.textContent = "官方品牌资产已加载";
  }, true);
  document.addEventListener("input", e => {
    const el = e.target;
    if (el.id === "proj-search") { store.projQuery = el.value; render(); }
    else if (el.id === "tree-search") { store.treeQuery = el.value; render(); }
    else if (el.id === "kb-search") { store.kbQuery = el.value; render(); }
    else if (el.id === "ai-input") {
      store.aiInput = el.value; store.aiStick = true;
      const m = /(?:^|\s)([@/])([^\s@/]*)$/.exec(el.value);
      if (m) { store.aiMenu = m[1] === "@" ? "at" : "slash"; store.aiMenuQuery = m[2]; render(); setTimeout(() => { const q = document.getElementById("ai-menu-q"); if (q) q.focus(); }, 10); }
      else if (store.aiMenu === "at" || store.aiMenu === "slash") { store.aiMenu = null; render(); }
    }
    else if (el.id === "ai-menu-q") { store.aiMenuQuery = el.value; render(); }
    else if (el.id === "ai-model-q") { store.aiModelQuery = el.value; render(); setTimeout(() => { const q = document.getElementById("ai-model-q"); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }, 0); }
    else if (el.id === "git-message") { store.gitMessage = el.value; const b = document.querySelector('[data-act=git-commit]'); if (b) b.disabled = !(el.value.trim() && D.git.changes.some(c => c.staged)); }
    else if (el.id === "code-editor") { store.codeDraft = el.value; }
    else if (el.id === "design-editor") { store.designDraft = el.value; }
    else if (el.id === "term-input") { store.termInput = el.value; }
    else if (el.id === "global-q") renderSearch(el.value);
  });

  document.addEventListener("submit", e => {
    const form = e.target.closest("[data-act=term-submit]");
    if (!form) return;
    e.preventDefault();
    const input = form.querySelector("input");
    const value = input ? input.value : "";
    if (input) input.value = "";
    runTerminal(value, form.dataset.id);
  });

  document.addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openSearch(); return; }
    if (e.key === "Escape") {
      const sub = document.getElementById("dialog2"), dlg = document.getElementById("dialog");
      if ((sub && sub.open) || (dlg && dlg.open)) { e.preventDefault(); UI.closeTopDialog(); return; }
      if (store.reqMenu) { store.reqMenu = null; render(); return; }
      if (store.aiMenu || store.aiPop || store.aiTop || store.aiHistory) { store.aiMenu = null; store.aiPop = null; store.aiTop = null; store.aiHistory = false; render(); return; }
      UI.closeTopDialog();
    }
    if (e.target && e.target.id === "ai-input" && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); AIPanel.send(); }
    if (e.target && e.target.id === "ai-menu-q" && e.key === "Enter") { e.preventDefault(); const first = document.querySelector("#ai-menu .menu-item"); if (first) first.click(); }
  });

  document.addEventListener("click", e => { if (e.target.id === "dialog" || e.target.id === "dialog2") UI.closeTopDialog(); });

  /* 仿真时钟：只更新进度条 */
  setInterval(() => {
    const t = D.tasks.find(x => x.id === "RUN-2087");
    if (!t || t.status !== "running") return;
    t.progress = Math.min(96, t.progress + 1);
    const row = document.querySelector('[data-act="open-task"][data-id="' + t.id + '"]');
    if (row) { const bar = row.querySelector(".mini-progress i"), num = row.querySelector(".num"); if (bar) bar.style.width = t.progress + "%"; if (num) num.textContent = t.progress + "%"; }
  }, 4000);

  if (window.innerWidth < 960) store.aiOpen = false;
  let lastWidth = window.innerWidth;
  window.addEventListener("resize", () => {
    const w = window.innerWidth;
    if (w < 960 && lastWidth >= 960 && store.aiOpen) { store.aiOpen = false; render(); }
    lastWidth = w;
  });

  window.__actions = actions;
  if (!D.settings.general.sendMode) D.settings.general.sendMode = "queue";
  render();
})();









