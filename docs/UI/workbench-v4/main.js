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

  /* CR-059 r3：思考档位解析（供应商信号 → 本地知识库 → 通用阶梯），供单模型「一键获取」
     与工具栏「自动获取思考等级」共用；未命中返回 null，不猜测。 */
  const normModel = s => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, " ").replace(/([a-z])(\d)/g, "$1 $2");
  function matchThinkKnowledge(id, name) {
    const hay = normModel(id) + " " + normModel(name);
    let best = null;
    (D.settings.thinkKnowledge || []).forEach(entry => entry.patterns.forEach(pat => {
      const needle = normModel(pat);
      const at = hay.indexOf(needle);
      if (at < 0) return;
      const before = hay[at - 1], after = hay[at + needle.length];
      const boundary = (!before || !/[a-z0-9]/.test(before)) && (!after || !/[a-z0-9]/.test(after));
      if (boundary && (!best || needle.length > best.len)) best = { entry, len: needle.length };
    }));
    return best ? best.entry : null;
  }
  function resolveThinkingLevels(m) {
    const signal = (D.settings.endpointSignals || {})[m.id];
    if (signal && signal.reasoning === false) return { levels: [], thinking: false, defaultLevel: "不下发", source: "供应商", note: "上游明确不支持推理" };
    const entry = matchThinkKnowledge(m.id, m.name);
    if (entry) return { levels: Object.keys(entry.efforts), thinking: true, defaultLevel: entry.defaultEffort || "跟随记忆", source: signal && signal.reasoning === true ? "供应商信号 + 本地知识库" : "本地知识库", note: entry.note, contextWindow: entry.contextWindow, maxTokens: entry.maxTokens };
    if (signal && signal.reasoning === true) return { levels: ["off", "low", "medium", "high"], thinking: true, defaultLevel: "跟随记忆", source: "供应商", note: "上游确认支持推理，通用阶梯（中置信）" };
    return null;
  }
  function applyThinkingLevels(m, r) {
    m.levels = r.levels; m.thinking = r.thinking; m.defaultLevel = r.defaultLevel;
    m.levelSource = r.source; m.levelNote = r.note; m.autoLevels = true;
    if (r.contextWindow && !m.context) m.context = r.contextWindow;
    if (r.maxTokens && !m.maxOutput) m.maxOutput = r.maxTokens;
  }

  function nextId(kind, projectId) {
    const prefix = kind === "epic" ? "EPIC-" : kind === "feature" ? "FEAT-" : "STORY-";
    const nums = D.requirements.filter(r => r.kind === kind).map(r => parseInt(String(r.id).replace(/\D+/g, ""), 10) || 0);
    let n = Math.max(0, ...nums) + 1;
    let id = prefix + String(n).padStart(kind === "epic" ? 2 : 3, "0");
    while (D.requirements.some(r => r.id === id)) { n++; id = prefix + String(n).padStart(kind === "epic" ? 2 : 3, "0"); }
    return { id, n };
  }

  /* r7b：密钥协议浮层定位——fixed 定位，锚定协议按钮；**默认向下展开**（用户要求），
     下方放不下才向上；夹在视口内（8px margin），并按可用高度限制最大高度。
     目标：浮层不遮挡协议按钮本身，也不被 .key-list / .set-scroll 裁剪。 */
  function positionKeyPop() {
    const pop = document.querySelector(".key-pop");
    if (!pop) return;
    const rect = store.keyPopRect;
    const vw = window.innerWidth, vh = window.innerHeight;
    const pw = pop.offsetWidth || 208;
    const ph = pop.offsetHeight || 200;
    const margin = 8, gap = 4;
    // 右缘对齐协议按钮，横向夹在视口内
    let left = rect ? rect.right - pw : vw / 2 - pw / 2;
    left = Math.max(margin, Math.min(left, vw - pw - margin));
    const spaceAbove = rect ? rect.top - margin - gap : vh / 2;
    const spaceBelow = rect ? vh - rect.bottom - margin - gap : vh / 2;
    let top;
    pop.style.maxHeight = "";
    if (rect && spaceBelow >= ph) {
      top = rect.bottom + gap;                                        // 默认向下
    } else if (rect && spaceAbove >= ph) {
      top = rect.top - ph - gap;                                      // 下方不够 → 向上
    } else if (spaceBelow >= spaceAbove) {
      top = rect ? rect.bottom + gap : margin;                        // 两侧都不够：向空间大的一侧并限高
      pop.style.maxHeight = Math.max(120, spaceBelow) + "px";
    } else {
      pop.style.maxHeight = Math.max(120, spaceAbove) + "px";
      top = rect ? rect.top - Math.min(ph, spaceAbove) - gap : margin;
    }
    top = Math.max(margin, Math.min(top, vh - margin - Math.min(pop.offsetHeight, ph)));
    pop.style.left = Math.round(left) + "px";
    pop.style.top = Math.round(top) + "px";
  }
  window.addEventListener("resize", () => { if (document.querySelector(".key-pop")) positionKeyPop(); });
  document.addEventListener("scroll", e => {
    if (!document.querySelector(".key-pop")) return;
    /* 正文滚动时关闭浮层，避免浮层与按钮脱位。 */
    if (e.target && e.target.closest && e.target.closest(".set-scroll")) {
      store.keyEdit = null; store.keyPopRect = null; S().refreshSettings();
    }
  }, true);

  /* r8：密钥模型范围探测（异步、保存后触发）——演示夹具模拟每个密钥的 `/models` 应答。
     规则（与设计一致）：
     - 只有 1 个密钥 → 不探测（模型配置中的模型即其支持范围）；
     - 全部支持 → 不写范围（空＝全部，后续新增模型自动覆盖）；
     - 部分支持 → 写入交集，标记 auto；
     - 已手动配置的密钥 → 只追加本次新增且被该密钥支持的模型，保留手动选择。
     探测按密钥自身协议对应的端点发出（r8：协议决定端点，不沿用供应商默认）。 */
  /* r9：探测过程在密钥行上不再显示任何状态；完成只弹一次会自动消失的 toast。
     批量探测把所有密钥结果汇总成一条提示；手动探测（范围表单「立即探测」）单独一条。 */
  function probeKeyScopes(p, onlyIdx, opts = {}) {
    if (!p || p.keys.length < 2) return;
    const targets = onlyIdx == null ? p.keys.map((_, i) => i).filter(i => p.keys[i] && p.keys[i].on) : [onlyIdx];
    if (!targets.length) return;
    const summary = [];
    let pending = targets.length;
    targets.forEach(i => {
      const k = p.keys[i];
      if (!k || !k.on) { pending--; return; }
      setTimeout(() => {
        const support = (D.settings.keyModelSupport && D.settings.keyModelSupport[k.id || k.label]) || null;
        const current = p.models.map(m => m.id);
        if (!support) {
          summary.push({ label: k.label || "密钥", ok: false });
        } else {
          const served = current.filter(id => support.includes(id));
          const prev = k.models || [];
          if (served.length === current.length) {
            /* 全部支持 → 空范围（兜底全部，后续新增自动覆盖） */
            k.models = []; k.scope = "全部模型"; k.autoScope = false; k.manualScope = false;
          } else if (k.manualScope || prev.length) {
            /* 手动已配置 → 只追加新增模型中被支持的 */
            const added = served.filter(id => !prev.includes(id));
            k.models = Array.from(new Set([...prev, ...added]));
            k.scope = `${k.models.length} 个模型`; k.autoScope = false; k.manualScope = true;
          } else {
            k.models = served.slice(); k.scope = `${served.length} 个模型`; k.autoScope = true; k.manualScope = false;
          }
          k.probedAt = "刚刚";
          summary.push({ label: k.label || "密钥", ok: true, served: served.length, total: current.length });
        }
        pending--;
        if (pending > 0) return;
        S().refreshSettings();
        if (opts.manual) {
          const r = summary[0];
          toast(r ? (r.ok ? `探测完成：该密钥支持 ${r.served}/${r.total} 个模型` : "探测未完成：未拿到该密钥的模型清单，已保留原范围")
                  : "探测未完成：密钥已停用或删除");
        } else {
          const done = summary.filter(x => x.ok).length;
          const failed = summary.length - done;
          toast(failed ? `模型范围已更新（${done} 把密钥成功，${failed} 把未取到清单已保留原范围）` : "已根据探测结果更新各密钥的模型范围");
        }
      }, 700);
    });
  }
  window.__probeKeyScopes = probeKeyScopes;

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
    "project-edit": el => { store.projectFormDraft = null; store.projectIconExpanded = false; store.projectIconDraft = null; store.projectColorDraft = null; store.projectPathDraft = ""; S().projectModal("edit", el.dataset.id); },
    "project-save": el => {
      const mode = el.dataset.mode;
      /* CR-073：成员字段移除，保存不再读写 members。 */
      const data = {
        name: val("pf-name").trim(), key: (val("pf-key").trim() || "NEW").toUpperCase(), kind: val("pf-kind"),
        owner: val("pf-owner").trim(), desc: val("pf-desc").trim(),
        path: store.projectPathDraft || val("pf-path").trim()
      };
      if (!data.name) { toast("请填写项目名称"); return; }
      if (mode === "edit") {
        const p = projById(el.dataset.id);
        Object.assign(p, data, { ownerInitials: (data.owner || "—").slice(0, 1).toUpperCase(), updated: "刚刚" });
        /* CR-073：编辑弹窗保存后，把表单里的名称/负责人/描述同步到卡片与侧栏。 */
        toast("项目已保存");
      } else {
        const id = "PRJ-" + (1000 + D.projects.length + 1);
        D.projects.push({
          id, ...data, ownerInitials: (data.owner || "—").slice(0, 1).toUpperCase(), tone: data.kind === "code" ? "blue" : "amber",
          stories: 0, done: 0, running: 0, updated: "刚刚", tags: ["新建"], branch: data.kind === "code" ? "main" : "", repo: data.path, createdAt: "今天"
        });
        toast("已创建项目：" + data.name);
      }
      closeDialog(); render();
    },
    "open-project": el => { closeDialog(); openWindow("project", el.dataset.id, projById(el.dataset.id).name); },
    "dir-pick": () => { store.projectDraft = { name: val("pf-name"), key: val("pf-key"), kind: val("pf-kind"), owner: val("pf-owner"), desc: val("pf-desc") }; store.dirReturn = store.projectModal; S().dirPicker(); },
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
    /* UI-CR073（用户第 8 项）：刷新移到需求树标题行「+」左侧；只重扫演示源，不改选中页签。 */
    "req-reload": el => {
      if (el.dataset.busy === "1") return;
      el.dataset.busy = "1";
      el.setAttribute("aria-busy", "true");
      window.RequirementsWorkspace.capture();
      toast("已重新扫描需求源（设计仿真）");
      setTimeout(() => { render(); }, 260);
    },

    /* ---------- 设计 ---------- */
    "design-tab": el => { store.designTab = el.dataset.tab; store.designEdit = false; render(); },
    /* UI-CR073：UI 分区内切换说明文档与可预览的 HTML 原型。 */
    "design-ui-doc": el => { store.designUiDoc = el.value; render(); },
    /* UI-CR073：HTML 设计稿的「预览 / 源码」切换；预览为默认。 */
    "design-view": el => { store.designViewMode = el.dataset.view === "source" ? "source" : "preview"; render(); },
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
    "git-stage": (el, e) => { if (e && e.stopPropagation) e.stopPropagation(); const c = D.git.changes.find(x => x.file === el.dataset.file); if (c) { c.staged = !c.staged; render(); } },
    "git-stage-all": () => { D.git.changes.forEach(c => { c.staged = true; }); toast("已全部加入暂存区（仿真）"); render(); },
    "git-unstage-all": () => { D.git.changes.forEach(c => { c.staged = false; }); toast("已全部取消暂存（仿真）"); render(); },
    "git-group": el => { store.gitOpenGroups = store.gitOpenGroups || { local: true, remote: false }; const k = el.dataset.group; store.gitOpenGroups[k] = !store.gitOpenGroups[k]; render(); },
    "git-branch-expand": () => { store.gitOpenGroups = { local: true, remote: true }; render(); },
    "git-branch-collapse": () => { store.gitOpenGroups = { local: false, remote: false }; render(); },
    "git-remotes": () => {
      openDialog(dlgShell("管理远程", "远程仓库地址；演示不写入真实仓库", `<div class="field"><label>远程名称</label><input class="input" id="gr-name" placeholder="origin"></div><div class="field"><label>仓库地址</label><input class="input" id="gr-url" placeholder="https://github.com/owner/repo.git"></div>${D.git.remoteManager.map(r => `<div class="gitp2-branch"><span class="gitp2-branch-mark">${icon("globe", "ico-14")}</span><span class="gitp2-branch-name">${esc(r.name)}</span><span class="gitp2-hint ellipsis">${esc(r.url)}</span></div>`).join("")}`, `<button class="btn" data-act="close-dialog">取消</button><button class="btn primary" data-act="git-remote-save">保存</button>`, "modal-sm"));
    },
    "git-remote-save": () => {
      const name = val("gr-name").trim(), url = val("gr-url").trim();
      if (!name || !url) { toast("请填写远程名称与地址"); return; }
      D.git.remoteManager.push({ name, url }); closeDialog(); toast(`已保存远程 ${name}（仿真）`); render();
    },
    "git-refresh": () => { toast("已刷新仓库状态（仿真）"); render(); },
    "git-accel": () => { store.gitAccelOpen = !store.gitAccelOpen; store.gitCredOpen = false; render(); },
    "git-accel-toggle": () => { D.git.accel.on = !D.git.accel.on; render(); },
    "git-accel-save": () => {
      const v = val("git-accel-url").trim();
      if (!/^https?:\/\/\S+$/.test(v)) { toast("镜像前缀需以 http:// 或 https:// 开头"); return; }
      D.git.accel.url = v; store.gitAccelOpen = false;
      toast(D.git.accel.on ? `已启用国内加速：${v}` : "已关闭国内加速"); render();
    },
    "git-accel-cancel": () => { store.gitAccelOpen = false; render(); },
    "git-cred": () => { store.gitCredOpen = !store.gitCredOpen; store.gitAccelOpen = false; render(); },
    "git-cred-save": () => {
      const host = val("git-cred-host").trim(), token = val("git-cred-token").trim();
      if (!/^[a-z0-9.-]+$/i.test(host)) { toast("请填写有效的远端主机名"); return; }
      if (!token) { toast("请粘贴访问令牌"); return; }
      const row = D.git.credentialHosts.find(h => h.host === host);
      if (row) row.savedAt = "刚刚"; else D.git.credentialHosts.push({ host, user: "oauth2", savedAt: "刚刚" });
      store.gitCredOpen = false; toast(`已保存 ${host} 的令牌（仿真，不回显）`); render();
    },
    "git-cred-cancel": () => { store.gitCredOpen = false; render(); },
    "git-commit-menu": () => { store.gitCommitMenuOpen = !store.gitCommitMenuOpen; render(); },
    "git-commit-push": () => { store.gitCommitMenuOpen = false; actions["git-commit"](); toast("已提交并推送（仿真）"); },
    "git-commit-toggle": el => { store.gitOpenCommit = store.gitOpenCommit === el.dataset.sha ? null : el.dataset.sha; render(); },
    "git-more": () => { toast("演示样例没有更多提交"); },
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
      g.dataDir = val("gen-data-dir") || g.dataDir;
      D.user.name = g.profile.name;
      D.user.email = g.profile.email;
      D.user.role = g.profile.role;
      toast("设置已保存；数据存储位置重启后迁移并生效");
      UI.closeDialog(); openSettings("general");
      render();
    },
    "pick-data-dir": () => {
      // 设计稿只演示交互：不读真实磁盘，选中后写入示例路径并提示重启语义。
      D.settings.general.dataDir = "D:\\NestCraft-data";
      UI.closeDialog(); openSettings("general");
      toast("演示：已选择目录；重启后迁移并生效");
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
      if (p) {
        /* CR-068：先完整校验，再提交同一个保存动作。 */
        const open = store.modelOpen && p.models.find(m => m.id === store.modelOpen);
        let ctx, max;
        if (open) {
          try { ctx = CR068.parseCapacity(val("m-ctx")); max = CR068.parseCapacity(val("m-max")); }
          catch (err) { CR068.showSaveError(p.id, err.message); return; }
        }
        p.name = val("pm-name") || p.name;
        if (open) {
          open.name = val("m-name") || open.name;
          open.context = ctx; open.maxOutput = max;
          const def = val("m-default"); open.defaultLevel = open.thinking ? (def || open.defaultLevel) : "不下发";
        }
        p.updated = "刚刚";
        /* r8/r9：保存后异步探测每个启用密钥支持的模型（多密钥才探测；单密钥跳过）。
           探测过程不在密钥行显示，完成时只用一条自动消失的 toast 反馈。 */
        if (p.keys.filter(k => k.on).length >= 2) {
          setTimeout(() => probeKeyScopes(p, null), 120);
        }
      }
      store.providerOpen = null; store.modelOpen = null;
      S().refreshSettings();
      toast("供应商与模型修改已保存");
    },
    /* #2：供应商级放弃修改——恢复为最近保存快照（演示重置为初始夹具）。 */
    "provider-discard": el => {
      const p = D.settings.providers.find(x => x.id === el.dataset.id);
      if (!p) return;
      store.modelOpen = null;
      S().refreshSettings(); toast("已放弃未保存修改（演示：回到上次保存状态）");
    },
    /* #2：模型级放弃修改——折叠当前模型，丢弃其草稿。 */
    "model-discard": () => { store.modelOpen = null; S().refreshSettings(); toast("已放弃该模型的修改"); },
    /* #1：批量自动获取思考等级——只处理「档位未配置」的模型（不含生图）。 */
    "model-auto-level-all": () => {
      const p = D.settings.providers.find(x => x.id === store.providerOpen);
      if (!p) return;
      const pending = p.models.filter(m => !m.modalities.includes("生图") && !m.levels.length);
      if (!pending.length) return toast("所有模型都已配置思考档位");
      let hit = 0, miss = 0;
      pending.forEach(m => {
        const r = resolveThinkingLevels(m);
        if (r) { applyThinkingLevels(m, r); hit++; } else miss++;
      });
      S().refreshSettings();
      toast(`已为 ${hit} 个模型回显思考等级${miss ? `；${miss} 个未找到可信档位，需手动配置` : ""}`, miss ? "alert" : undefined);
    },
    "provider-key-add": () => { const p = D.settings.providers.find(x => x.id === store.providerOpen); if (p) { p.keys.push({ label: "新密钥", masked: "sk-****0000", on: true, scope: "全部模型" }); S().refreshSettings(); } },
    "provider-key-toggle": el => { const p = D.settings.providers.find(x => x.id === store.providerOpen); const k = p && p.keys[Number(el.dataset.idx)]; if (k) { k.on = !k.on; S().refreshSettings(); } },
    "provider-key-detect": () => { const p = D.settings.providers.find(x => x.id === store.providerOpen); if (p) { p.keys.push({ label: "自动探测", masked: "sk-****d3t3", on: true, scope: "全部模型" }); S().refreshSettings(); toast("已探测到 1 个可用密钥（仿真）"); } },
    "provider-protocol": el => { const p = D.settings.providers.find(x => x.id === store.providerOpen); if (p) { p.protocol = el.dataset.v; S().refreshSettings(); } },
    /* CR-059 A4：协议下拉切换 → 端点协议联动（Chat/Responses→OpenAI，Anthropic→Anthropic），地址保留。 */
    "provider-protocol-set": el => {
      const p = D.settings.providers.find(x => x.id === (store.providerOpen || store.providerEdit));
      if (!p) return;
      p.protocol = el.value;
      const wire = p.protocol === "Anthropic" ? "Anthropic" : "OpenAI";
      S().refreshSettings(); toast(`协议已切换为 ${p.protocol}，端点联动为 ${wire}（演示）`);
    },
    "provider-header-add": () => { const p = D.settings.providers.find(x => x.id === store.providerOpen); if (p) { p.headers.push({ name: "", value: "" }); S().refreshSettings(); } },
    "provider-header-del": el => { const p = D.settings.providers.find(x => x.id === store.providerOpen); if (p) { p.headers.splice(Number(el.dataset.idx), 1); S().refreshSettings(); } },
    "provider-spoof": el => { const p = D.settings.providers.find(x => x.id === store.providerOpen); if (p) { p.spoof = el.dataset.v; S().refreshSettings(); } },
    "model-pull": () => { const p = D.settings.providers.find(x => x.id === store.providerOpen); if (p) { const m = { id: "pulled-model-" + (p.models.length + 1), name: "Pulled Model " + (p.models.length + 1), modalities: ["文本"], thinking: false, levels: [], defaultLevel: "—", context: 128000, maxOutput: 16384, autoLevels: false, on: true }; p.models.push(m); store.modelEdit = m.id; S().refreshSettings(); toast("已获取 1 个可用模型（仿真）"); } },
    /* CR-059 r3 #1：模型内「一键获取」只取当前模型（共用解析器）。 */
    "model-auto-level": () => {
      const p = D.settings.providers.find(x => x.id === store.providerOpen);
      const m = p && p.models.find(x => x.id === (store.modelOpen || store.modelEdit));
      if (!m) return;
      const r = resolveThinkingLevels(m);
      if (!r) return toast("供应商与本地知识库均未找到可信档位，请手动配置；不会按名称猜测", "alert");
      applyThinkingLevels(m, r);
      S().refreshSettings(); toast(`已获取该模型 ${r.levels.length} 个档位（来源：${r.source}）`);
    },
    /* r8：整行可点击展开/收起；行内按钮（拖动/删除/箭头）由自己的动作处理，不触发展开。 */
    "model-select": (el, e) => {
      if (e && e.target && e.target.closest && e.target.closest("[data-drag-model],[data-act='model-delete']")) return;
      const id = el.dataset.id;
      store.modelOpen = store.modelOpen === id ? null : id;
      store.modelEdit = id; S().refreshSettings();
    },
    "model-pick-open": () => { const p = D.settings.providers.find(x => x.id === store.providerOpen); if (p) { store.modelPick = {}; S().modelPickDialog(p); } },
    /* CR-059 B1/A3：获取模型结果卡片点选。 */
    "model-pick-toggle": el => {
      store.modelPick = store.modelPick || {};
      const id = el.dataset.id;
      store.modelPick[id] = !store.modelPick[id];
      const p = D.settings.providers.find(x => x.id === store.providerOpen);
      if (p) S().modelPickDialog(p);
    },
    "model-pick-save": () => {
      const p = D.settings.providers.find(x => x.id === store.providerOpen);
      if (!p) return;
      const chosen = Object.keys(store.modelPick || {}).filter(id => store.modelPick[id]);
      /* CR-059 B1：只收清单字段；模态/思考保持未知，不猜测、不阻塞。 */
      chosen.forEach(id => {
        const src = (p.availableModels || []).find(m => m.id === id) || { id, name: id, context: null };
        p.models.push({ id: src.id, name: src.name, modalities: ["文本"], visionUnknown: true, thinking: false, levels: [], defaultLevel: "跟随记忆", context: src.context || null, maxOutput: null, autoLevels: false, on: true });
      });
      store.modelPick = {};
      UI.closeSubDialog();
      if (chosen.length) { store.modelOpen = chosen[0]; store.modelEdit = chosen[0]; }
      S().refreshSettings();
      toast(chosen.length ? `已添加 ${chosen.length} 个模型（能力字段保持未知，可用「自动获取思考等级」补齐）` : "未选择模型");
    },
    "model-add-manual": () => {
      const p = D.settings.providers.find(x => x.id === store.providerOpen);
      if (!p) return;
      const id = "new-model-" + (p.models.length + 1);
      p.models.push({ id, name: "新模型", modalities: ["文本"], visionUnknown: true, thinking: false, levels: [], defaultLevel: "跟随记忆", context: null, maxOutput: null, autoLevels: false, on: true });
      store.modelOpen = id; store.modelEdit = id;
      S().refreshSettings();
    },
    "model-autoconfig": () => { const p = D.settings.providers.find(x => x.id === store.providerOpen); const m = p && p.models.find(x => x.id === store.modelEdit); if (m) { Object.assign(m, autoModel(m)); S().refreshSettings(); toast("已按模型能力自动配置"); } },
    "model-modality": el => { const p = D.settings.providers.find(x => x.id === store.providerOpen); const m = p && p.models.find(x => x.id === store.modelEdit); if (m) { const v = el.dataset.v; m.modalities = m.modalities.includes(v) ? m.modalities.filter(x => x !== v) : m.modalities.concat(v); S().refreshSettings(); } },
    "model-thinking": () => { const p = D.settings.providers.find(x => x.id === store.providerOpen); const m = p && p.models.find(x => x.id === store.modelEdit); if (m) { m.thinking = !m.thinking; if (!m.thinking) m.defaultLevel = "不下发"; S().refreshSettings(); } },
    "model-level": el => { const p = D.settings.providers.find(x => x.id === store.providerOpen); const m = p && p.models.find(x => x.id === store.modelEdit); if (m) { const v = el.dataset.v; m.levels = m.levels.includes(v) ? m.levels.filter(x => x !== v) : m.levels.concat(v); S().refreshSettings(); } },
    "model-delete": el => { const p = D.settings.providers.find(x => x.id === store.providerOpen); if (!p) return; if (p.models.length <= 1) { toast("至少保留一个模型"); return; } p.models = p.models.filter(x => x.id !== el.dataset.id); if (store.modelOpen === el.dataset.id) store.modelOpen = null; S().refreshSettings(); toast("已删除模型"); },
    /* CR-059 r3：#6 供应商默认协议改成一行均分卡片（点击即切换，端点联动）。 */
    "provider-protocol-card": el => {
      const p = D.settings.providers.find(x => x.id === (store.providerOpen || store.providerEdit));
      if (!p) return;
      p.protocol = el.dataset.v;
      const wire = { "Chat": "OpenAI", "Responses": "OpenAI", "Anthropic": "Anthropic" }[el.dataset.v] || "OpenAI";
      S().refreshSettings(); toast(`协议已切换为 ${p.protocol}，端点联动为 ${wire}（演示）`);
    },
    /* CR-059 r3 #5 / r8：密钥协议悬浮下拉点选即写入并收起；
       r8 明确语义——选定的协议决定该密钥请求走哪个端点（不是沿用供应商默认）。 */
    "key-protocol-pick": el => {
      const p = D.settings.providers.find(x => x.id === store.providerOpen); if (!p) return;
      const k = p.keys[Number(el.dataset.idx)]; if (!k) return;
      k.protocol = el.dataset.v;
      const wire = k.protocol ? ({ Chat: "OpenAI", Responses: "OpenAI", Anthropic: "Anthropic" }[k.protocol] || "OpenAI") : null;
      store.keyEdit = null; store.keyPopRect = null;
      S().refreshSettings();
      toast(wire ? `密钥协议已设为 ${k.protocol}，请求走 ${wire} 端点` : "该密钥沿用供应商默认协议");
    },
    /* r8：密钥可用模型——手动清空作为全部；立即探测（单密钥无需探测）。 */
    "key-scope-clear": el => {
      const p = D.settings.providers.find(x => x.id === store.providerOpen); if (!p) return;
      const k = p.keys[Number(el.dataset.idx)]; if (!k) return;
      k.models = []; k.scope = "全部模型"; k.autoScope = false; k.manualScope = false;
      S().refreshSettings(); toast("已清空范围＝全部模型（不含筛选）");
    },
    "key-scope-probe": el => {
      const p = D.settings.providers.find(x => x.id === store.providerOpen); if (!p) return;
      const idx = Number(el.dataset.idx);
      const k = p.keys[idx]; if (!k) return;
      if (p.keys.length < 2) return toast("只有一个密钥时无需探测：模型配置中的模型即其支持范围", "alert");
      probeKeyScopes(p, idx, { manual: true });
    },
    /* CR-059 r3 生图配置 */
    "imagegen-open": () => S().imageGenDialog(),
    "imagegen-toggle": () => { const c = D.settings.imageGen; c.enabled = !c.enabled; S().imageGenDialog(); toast(c.enabled ? "生图已开启：generate_image 将提供给 AI（演示）" : "生图已关闭：tool 已注销（演示）", c.enabled ? undefined : "alert"); },
    "imagegen-add": el => {
      const c = D.settings.imageGen; const key = el.dataset.key;
      if (!c.order.includes(key)) c.order.push(key);
      S().imageGenDialog();
    },
    "imagegen-remove": el => {
      const c = D.settings.imageGen; const key = el.dataset.key;
      if (c.order.length <= 1) { toast("至少保留一个生图模型", "alert"); return; }
      c.order = c.order.filter(k => k !== key); S().imageGenDialog();
    },
    "imagegen-save": () => {
      const c = D.settings.imageGen;
      c.defaults.size = val("ig-size") || c.defaults.size;
      c.defaults.quality = val("ig-quality") || c.defaults.quality;
      c.defaults.n = parseInt(val("ig-n"), 10) || c.defaults.n;
      c.defaults.timeoutMin = parseInt(val("ig-timeout"), 10) || c.defaults.timeoutMin;
      c.outputDir = val("ig-outdir") || c.outputDir;
      UI.closeSubDialog(); S().refreshSettings();
      toast(`生图配置已保存：${c.order.length} 个模型按顺序尝试${c.enabled ? "" : "（当前关闭）"}`);
    },
    /* CR-058 模型检测 */
    "probe-run": () => S().probeRun(),
    "probe-history": () => S().probeHistoryDialog(),
    "probe-hist-pick": el => S().probePickHistory(el.dataset.id),
    "probe-history-row": el => { const st = S().probeState(); st.histOpen = st.histOpen === el.dataset.id ? null : el.dataset.id; S().probeHistoryDialog(); },
    "key-alias": el => { store.keyEdit = { idx: Number(el.dataset.idx), mode: "alias" }; S().refreshSettings(); },
    "key-value": el => { store.keyEdit = { idx: Number(el.dataset.idx), mode: "value" }; S().refreshSettings(); },
    "key-protocol": el => {
      /* r7：记录触发按钮的位置，浮层用 fixed 定位并优先向上展开，避免被 .key-list/.set-scroll 裁剪。 */
      store.keyPopRect = el && el.getBoundingClientRect ? el.getBoundingClientRect().toJSON() : null;
      store.keyEdit = { idx: Number(el.dataset.idx), mode: "protocol" };
      S().refreshSettings();
      positionKeyPop();
    },
    "key-scope": el => { store.keyEdit = { idx: Number(el.dataset.idx), mode: "scope" }; S().refreshSettings(); },
    "key-remove": el => { store.keyEdit = { idx: Number(el.dataset.idx), mode: "remove" }; S().refreshSettings(); },
    "key-edit-cancel": () => { store.keyEdit = null; S().refreshSettings(); },
    "key-protocol-set": el => { const p = D.settings.providers.find(x => x.id === store.providerOpen); const k = p && p.keys[Number(el.dataset.idx)]; if (k) { k.protocol = el.dataset.v; store.keyEdit = null; S().refreshSettings(); } },
    /* CR-059 A3：密钥模型范围卡片点选（切换选中，保存时收集）。 */
    "key-scope-pick": el => {
      const p = D.settings.providers.find(x => x.id === store.providerOpen); if (!p) return;
      const k = p.keys[Number(el.dataset.idx)]; if (!k) return;
      k.models = k.models || [];
      const id = el.dataset.model;
      k.models = k.models.includes(id) ? k.models.filter(x => x !== id) : k.models.concat(id);
      k.scope = k.models.length ? k.models.length + " 个模型" : "全部模型";
      S().refreshSettings();
    },
    "key-save": el => {
      const p = D.settings.providers.find(x => x.id === store.providerOpen); if (!p) return;
      const k = p.keys[Number(el.dataset.idx)]; if (!k) return;
      const mode = el.dataset.mode;
      if (mode === "alias") k.label = val("key-alias-input") || k.label;
      else if (mode === "value") k.masked = val("key-value-input") || k.masked;
      else if (mode === "protocol") { const sel = document.getElementById("key-protocol-select"); if (sel) k.protocol = sel.value; }
      else if (mode === "scope") { k.scope = (k.models || []).length ? k.models.length + " 个模型" : "全部模型"; }
      store.keyEdit = null; S().refreshSettings(); toast("密钥已更新");
    },
    "key-remove-confirm": el => { const p = D.settings.providers.find(x => x.id === store.providerOpen); if (!p) return; if (p.keys.length <= 1) { toast("至少保留一个密钥"); store.keyEdit = null; S().refreshSettings(); return; } p.keys.splice(Number(el.dataset.idx), 1); store.keyEdit = null; S().refreshSettings(); toast("已删除密钥"); },
    "close-sub": () => UI.closeSubDialog(),
    "sdk-expand": el => { store.sdkOpen = store.sdkOpen === el.dataset.id ? null : el.dataset.id; S().refreshSettings(); },
    "sdk-tab": el => { store.sdkTab = el.dataset.tab; S().refreshSettings(); if (el.dataset.tab === "sdk") warmCliSdk(); },
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
    "mcp-oauth-demo": el => { const labels = { unauthenticated: "未授权", pending: "待浏览器回调", authenticated: "已授权", expired: "已过期", revoked: "已撤权", error: "连接失败" }; toast("设计演示：HTTP MCP状态 · " + (labels[el.dataset.state] || "未知")); },
    "tool-toggle": el => { const t = D.settings.tools[Number(el.dataset.idx)]; if (t) { t.on = !t.on; S().refreshSettings(); } },

    /* ---------- AI ---------- */
    "ai-toggle": () => { store.aiOpen = !store.aiOpen; render(); },
    /* CR-063：关闭历史浮层时回到「最近 20 条」初始态，下次打开仍是分批列表。 */
    "ai-history": () => {
      store.aiHistory = !store.aiHistory; store.aiTop = null; store.aiPop = null; store.aiMenu = null;
      if (!store.aiHistory) { store.aiHistLimit = 20; store.aiHistQuery = ""; store.aiHistFocus = false; }
      render();
    },
    "ai-history-close": () => { store.aiHistory = false; store.aiHistLimit = 20; store.aiHistQuery = ""; store.aiHistFocus = false; render(); },
    "ai-history-more": () => {
      const hl = document.querySelector(".ai-history-list");
      store.aiHistScroll = hl ? hl.scrollTop : 0;
      store.aiHistLimit = (Number(store.aiHistLimit) || 20) + 20;
      render();
    },
    "ai-history-all": () => { store.aiHistQuery = ""; store.aiHistLimit = 20; store.aiHistFocus = false; store.aiHistState = "idle"; render(); },
    /* CR-064：行内「…」菜单与操作 */
    "ai-hist-menu": el => { const id = el.dataset.id; store.aiHistMenu = store.aiHistMenu === id ? null : id; render(); },
    "ai-hist-menu-noop": () => {},
    "ai-hist-copy-id": el => {
      const id = el.dataset.id;
      const done = () => { store.aiHistMenu = null; toast("已复制会话 ID"); render(); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(id).then(done).catch(() => toast("复制失败，请手动复制", "err"));
      else toast("当前环境不支持剪贴板，请手动复制", "err");
    },
    "ai-hist-fork": el => {
      const src = D.ai.sessions.find(s => s.id === el.dataset.id);
      if (!src) return;
      if ((D.ai.runningIds || []).includes(src.id)) { toast("会话运行中，结束或停止后再分叉"); return; }
      const copy = { ...src, id: "S-" + Date.now().toString().slice(-6), title: "分叉 · " + src.title, pinned: false, status: "read", updated: "刚刚", tokens: "0", duration: "0s", messages: (src.messages || []).map(m => ({ ...m })) };
      D.ai.sessions.unshift(copy);
      store.aiHistMenu = null; store.aiSession = copy.id; store.aiMessages = copy.messages || [];
      toast("已分叉会话，上下文已保留"); render();
    },
    "ai-hist-pin": el => {
      const s = D.ai.sessions.find(x => x.id === el.dataset.id);
      if (!s) return;
      s.pinned = !s.pinned;
      store.aiHistMenu = null;
      toast(s.pinned ? "已置顶会话" : "已取消置顶"); render();
    },
    "ai-hist-rename": el => {
      const s = D.ai.sessions.find(x => x.id === el.dataset.id);
      if (!s) return;
      store.aiHistMenu = null;
      store.aiHistEditId = s.id;
      store.aiHistEditValue = s.title;
      render();
      requestAnimationFrame(() => {
        const input = document.getElementById("ai-hist-rename-input");
        if (input) { input.focus(); input.select(); }
      });
    },
    "ai-hist-edit-noop": () => {},
    "ai-hist-rename-save": () => {
      const id = store.aiHistEditId;
      const s = id ? D.ai.sessions.find(x => x.id === id) : null;
      if (!s) return;
      const value = String(store.aiHistEditValue || "").trim();
      if (!value) { toast("标题不能为空"); store.aiHistEditId = null; render(); return; }
      s.title = value;
      store.aiHistEditId = null; store.aiHistEditValue = "";
      toast("已重命名"); render();
    },
    "ai-hist-rename-cancel": () => { store.aiHistEditId = null; store.aiHistEditValue = ""; render(); },
    "ai-history-retry": () => { store.aiHistState = "idle"; render(); },
    "ai-del": el => {
      const s = D.ai.sessions.find(x => x.id === el.dataset.id);
      if (!s) return;
      /* 与正式软件既有 Confirm 对齐：标题 + 正文（含“删除后不可恢复”）+ 取消/确认，危险操作按钮为 danger 样式。 */
      openDialog(dlgShell("删除会话", "", `<p class="caption">确定删除「${esc(s.title || "未命名会话")}」？删除后不可恢复。</p>`, `<button class="btn" data-act="close-dialog">取消</button><button class="btn danger" data-act="ai-del-confirm" data-id="${esc(s.id)}">确认</button>`, "modal-sm"));
    },
    "ai-del-confirm": el => {
      const id = el.dataset.id;
      D.ai.sessions = D.ai.sessions.filter(s => s.id !== id);
      if (store.aiSession === id) store.aiSession = D.ai.sessions[0]?.id || null;
      closeDialog(); toast("已删除会话"); render();
    },
    /* CR-062：子智能体只读详情；进入后隐藏计数入口，返回主会话保留原状态。 */
    "ai-agent-open": el => { if (!el.dataset.agentId) return; store.aiAgent = el.dataset.agentId; store.aiTop = null; store.aiPop = null; store.aiMenu = null; render(); },
    "ai-agent-back": () => { store.aiAgent = null; render(); },
    "ai-new": () => AIPanel.newSession(),
    "ai-switch": el => AIPanel.switchSession(el.dataset.id),
    "ai-menu-open": () => { store.aiMenuTab = "add"; AIPanel.openMenu(store.aiMenu === "add" ? null : "add"); },
    "ai-menu-tab": el => { store.aiMenuTab = el.dataset.tab; render(); },
    "ai-menu-q": () => {},
    "ai-pick": el => {
      if (el.dataset.kind === "file") AIPanel.openMenu("at");
      if (el.dataset.kind === "command") AIPanel.openMenu("slash");
      if (el.dataset.kind === "image" && AIPanel.canAttachImages()) { AIPanel.openMenu(null); document.getElementById("ai-image-input")?.click(); }
    },
    "ai-insert": el => AIPanel.insert(el.dataset.text, el.dataset.ref ? { key: el.dataset.ref, label: el.dataset.label } : null),
    "ai-image-remove": el => AIPanel.removeImage(Number(el.dataset.index)),
    "ai-image-view": el => AIPanel.imageView(el),
    "ai-ref-remove": el => AIPanel.removeRef(Number(el.dataset.index)),
    "ai-permission": () => { store.aiPop = store.aiPop === "perm" ? null : "perm"; store.aiMenu = null; render(); },
    "ai-perm-set": el => { store.aiPermission = el.dataset.name; store.aiPop = null; toast("权限模式：" + el.dataset.name); render(); },
    "ai-cli": () => { store.aiPop = store.aiPop === "cli" ? null : "cli"; store.aiMenu = null; render(); },
    "ai-cli-set": el => { store.aiCli = el.dataset.id; store.aiPop = null; toast("已切换 CLI：" + el.dataset.id); render(); },
    "ai-model": () => { store.aiPop = store.aiPop === "model" ? null : "model"; store.aiMenu = null; store.aiTop = null; store.aiModelQuery = ""; render(); },
    "ai-model-provider": el => { const cat = D.ai.modelCatalog; cat.current.provider = el.dataset.name; const list = AIPanel.visibleModels(cat.providers.find(p => p.name === el.dataset.name)); if (list.length) cat.current.model = list[0].name; if (!AIPanel.currentModel().thinking) cat.current.level = "—"; else if (!cat.levels.includes(cat.current.level)) cat.current.level = "High"; store.aiModelQuery = ""; render(); },
    "ai-model-set": el => { const cat = D.ai.modelCatalog; cat.current.model = el.dataset.name; const m = AIPanel.currentModel(); if (m.thinking) { if (!cat.levels.includes(cat.current.level)) cat.current.level = "High"; } else cat.current.level = "—"; render(); },
    "ai-level": el => { D.ai.modelCatalog.current.level = D.ai.modelCatalog.levels[Number(el.value)]; render(); },
    "ai-task-toggle": () => { ChatDock.toggle(AIPanel.activeSession()); render(); },
    "ai-goal-edit": () => ChatDock.edit(),
    "ai-goal-apply": () => ChatDock.finish(true),
    "ai-goal-cancel": () => ChatDock.finish(false),
    "ai-goal-toggle": () => { const s = AIPanel.activeSession(); s.goalPaused = !s.goalPaused; render(); },
    "ai-goal-clear": () => {
      if (window.confirm("清除当前会话的目标？")) {
        const s = AIPanel.activeSession();
        s.goal = "";
        s.goalPaused = false;
        render();
        document.getElementById("ai-input")?.focus({ preventScroll: true });
      }
    },
    "ai-send": () => AIPanel.send(),
    "ai-approve": el => AIPanel.approve(Number(el.dataset.idx), true),
    "ai-copy": el => {
      const text = AIPanel.finalText(store.aiMessages[Number(el.dataset.idx)]);
      if (navigator.clipboard && text) navigator.clipboard.writeText(text).then(() => toast("已复制这条回复"), () => toast("复制失败", "alert"));
      else toast("当前环境不支持复制", "alert");
    },
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
    "cli-save": el => {
      const c = D.settings.clis.find(x => x.id === el.dataset.id); if (!c) return;
      /* CR-059 r5：只收集已存在的槽（0～5）＋兜底（含思考等级）；D4：权限挡位。 */
      document.querySelectorAll(`[data-cli-slot^="${c.id}:"]`).forEach(sel => {
        const [, slot, field] = sel.dataset.cliSlot.split(":");
        if (slot === "fallback") { c.fallback = c.fallback || { model: "", note: "跟随主 agent" }; c.fallback[field] = sel.value; }
        else { const idx = Number(slot); if (!Number.isInteger(idx) || idx < 0 || idx >= 5) return; c.slots = c.slots || []; c.slots[idx] = c.slots[idx] || { model: "", effort: "", types: [] }; c.slots[idx][field] = sel.value; }
      });
      const perm = document.getElementById("cli-perm-" + c.id);
      if (perm) c.permission = perm.value;
      S().refreshSettings(); toast("CLI 任务模型路由与权限已保存（演示）；仅影响之后的新会话");
    },
    /* CR-059 r4：单行折叠——点击行/箭头展开收起下方详情区（每 CLI 一个折叠态）。 */
    "cli-route-toggle": el => {
      const id = el.dataset.id;
      store.cliRouteOpen = store.cliRouteOpen || {};
      store.cliRouteOpen[id] = !store.cliRouteOpen[id];
      S().refreshSettings();
    },
    /* CR-059 r4：点行首标签切换当前编辑的模型槽 / 兜底；未展开时同时展开。 */
    "cli-slot-select": el => {
      const id = el.dataset.id;
      store.cliRouteSel = store.cliRouteSel || {};
      const same = store.cliRouteSel[id] === el.dataset.slot || (!store.cliRouteSel[id] && el.dataset.slot === "fallback");
      store.cliRouteSel[id] = el.dataset.slot;
      store.cliRouteOpen = store.cliRouteOpen || {};
      store.cliRouteOpen[id] = same ? !store.cliRouteOpen[id] : true;
      S().refreshSettings();
    },
    /* CR-059 r4：新增模型槽（最多 5 个），新增后选中并展开该槽。 */
    "cli-slot-add": el => {
      const c = D.settings.clis.find(x => x.id === el.dataset.id); if (!c) return;
      c.slots = c.slots || [];
      if (c.slots.length >= 5) { toast("最多只能有 5 个模型槽"); return; }
      c.slots.push({ model: "", effort: "", types: [] });
      store.cliRouteSel = store.cliRouteSel || {};
      store.cliRouteSel[c.id] = String(c.slots.length - 1);
      store.cliRouteOpen = store.cliRouteOpen || {};
      store.cliRouteOpen[c.id] = true;
      S().refreshSettings();
      toast(`已新增模型${c.slots.length}，选择模型与任务类型后保存`);
    },
    /* CR-059 r4：删除当前模型槽；剩余标签重排，选中态跟随。兜底不可删。 */
    "cli-slot-remove": el => {
      const c = D.settings.clis.find(x => x.id === el.dataset.id); if (!c || !c.slots) return;
      const idx = Number(el.dataset.slot);
      if (!Number.isInteger(idx) || idx < 0 || idx >= c.slots.length) return;
      c.slots.splice(idx, 1);
      store.cliRouteSel = store.cliRouteSel || {};
      /* 删到 0 个或删的是最后一个可见槽时回到兜底；否则选中原位置（或末位）。 */
      store.cliRouteSel[c.id] = c.slots.length ? String(Math.min(idx, c.slots.length - 1)) : "fallback";
      S().refreshSettings();
      toast(c.slots.length ? `已删除模型槽，剩 ${c.slots.length}/5` : "已删除全部模型槽；所有任务将使用兜底模型");
    },
    /* CR-059 D3：槽位任务类型 chips。 */
    "cli-slot-type": el => {
      const c = D.settings.clis.find(x => x.id === el.dataset.id); if (!c || !c.slots) return;
      const s = c.slots[Number(el.dataset.slot)]; if (!s) return;
      const t = el.dataset.type;
      s.types = s.types.includes(t) ? s.types.filter(x => x !== t) : s.types.concat(t);
      S().refreshSettings();
    },
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
    "cli-check": el => { const c = D.settings.clis.find(x => x.id === el.dataset.id); if (c) { store.cliChecking = c.id; S().refreshSettings(); setTimeout(() => { store.cliChecking = null; c.checked = "刚刚"; S().refreshSettings(); toast(c.name + " 已重新检测（" + c.version + "）"); }, 700); } },
    /* CR-059 E3：刷新版本列表（演示为即时；正式实现 HTTP 直连 registry）。 */
    "sdk-versions-refresh": el => { const s = D.settings.sdks.find(x => x.id === el.dataset.id); if (s) { store.sdkChecking = s.id; S().refreshSettings(); setTimeout(() => { store.sdkChecking = null; S().refreshSettings(); toast(s.name + " 版本列表已刷新：最新 10 个稳定版（演示）"); }, 600); } },
    /* CR-059 F1：Skill 文件夹添加流程。 */
    "skill-folder-choose": () => S().skillFolderChooseDialog(),
    "skill-folder-pick": el => { store.skillFolderPick = el.dataset.path; S().skillAddDialog(); },
    "skill-add-back": () => S().skillAddDialog(),
    "skill-folder-save": () => {
      const folder = D.settings.skillFolders.find(f => f.path === store.skillFolderPick);
      if (!folder || !folder.valid) { toast("所选文件夹没有 SKILL.md"); return; }
      const slug = val("sk-slug").trim() || folder.slug;
      if (D.settings.skills.some(s => s.slug === slug)) { toast("同名技能已存在"); return; }
      D.settings.skills.push({ name: val("sk-name").trim() || folder.name, slug, desc: val("sk-desc") || folder.desc, source: "本机文件夹（受管副本）", updated: "刚刚", on: true, uses: 0 });
      store.skillFolderPick = null;
      UI.closeSubDialog(); S().refreshSettings(); toast("已复制为受管技能副本；外部源删除不影响");
    },
    /* CR-059 F2：Skill 扫描导入。 */
    "skill-scan-open": () => { store.skillScanSel = {}; S().skillScanDialog(); },
    "skill-scan-import": () => {
      const sel = store.skillScanSel || {};
      let n = 0;
      D.settings.skillSources.forEach(src => src.items.forEach(it => {
        const key = src.agent + ":" + it.slug;
        if (!sel[key]) return;
        if (D.settings.skills.some(s => s.slug === it.slug)) return;
        D.settings.skills.push({ name: it.name, slug: it.slug, desc: it.desc, source: `扫描导入 · ${src.agent}（受管副本）`, updated: "刚刚", on: true, uses: 0 });
        it.imported = true; n++;
      }));
      store.skillScanSel = {};
      UI.closeSubDialog(); S().refreshSettings();
      toast(n ? `已导入 ${n} 个技能为受管副本` : "未选择可导入的技能");
    },
    /* CR-059 F4：MCP 扫描导入。 */
    "mcp-scan-open": () => { store.mcpScanSel = {}; S().mcpScanDialog(); },
    "mcp-import-json": () => S().mcpImportJsonDialog(),
    "mcp-scan-import": () => {
      const sel = store.mcpScanSel || {};
      let n = 0;
      D.settings.mcpSources.forEach(src => src.items.forEach(it => {
        const key = src.agent + ":" + it.name;
        if (!sel[key]) return;
        if (D.settings.mcp.some(m => m.name === it.name)) return;
        D.settings.mcp.push({ name: it.name, transport: it.transport, target: it.target, on: true, tools: 0, source: `扫描导入 · ${src.agent}`, updated: "刚刚" });
        it.imported = true; n++;
      }));
      store.mcpScanSel = {};
      UI.closeSubDialog(); S().refreshSettings();
      toast(n ? `已导入 ${n} 个 MCP 为受管配置` : "未选择可导入的 MCP");
    },
    /* CR-059 F5：图3表单保存（命令词法拆分＋逐行参数/环境变量解析演示）。 */
    "mcp-save-59": () => {
      const name = val("mc-name").trim();
      if (!name) { toast("请填写名称"); return; }
      if (D.settings.mcp.some(m => m.name === name)) { toast("MCP 名称重复，已拒绝"); return; }
      const type = val("mc-type") || "stdio";
      if (type === "stdio") {
        const command = val("mc-command").trim();
        if (!command) { toast("STDIO 需填写启动命令"); return; }
        const extra = val("mc-args").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
        const envLines = val("mc-env").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
        const badLine = envLines.findIndex(x => !x.includes("="));
        if (badLine >= 0) { toast(`环境变量第 ${badLine + 1} 行不是 KEY=value 格式`); return; }
        D.settings.mcp.push({ name, transport: "stdio", target: command + (extra.length ? " " + extra.join(" ") : ""), on: true, tools: 0, source: "手动添加", updated: "刚刚" });
      } else {
        const url = val("mc-url").trim();
        if (!url) { toast("HTTP 需填写 URL"); return; }
        D.settings.mcp.push({ name, transport: "http", target: url, on: true, tools: 0, source: "手动添加", updated: "刚刚" });
      }
      UI.closeSubDialog(); S().refreshSettings(); toast("已添加 MCP " + name + "（仅保存配置，未自动连接）");
    },
    /* CR-059 F7：Tools 树形展开/开关。 */
    "tool-tree-toggle": el => { store.toolTreeOpen = store.toolTreeOpen || {}; const id = el.dataset.id; store.toolTreeOpen[id] = !store.toolTreeOpen[id]; S().refreshSettings(); },
    "tool-tree-switch": el => {
      const g = D.settings.toolTree.find(x => x.id === el.dataset.group);
      if (!g || g.kind === "cli") return;
      const t = g.tools[Number(el.dataset.idx)];
      if (t) { t.on = !t.on; S().refreshSettings(); if (t.pending) toast("开关已保存；该项注入待实现（BUG-CR059-01），当前软件中尚未到达 AI", "alert"); }
    },


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
    if (e.target.closest("#ai-history-q, #ai-input, #ai-model-q") && !e.target.closest("[data-act]")) return;
    if (store.reqMenu && !e.target.closest("#req-menu") && !e.target.closest("[data-act=req-menu]")) store.reqMenu = null;
    if ((store.aiPop || store.aiMenu) && !e.target.closest(".ai-panel, .wb-conv")) { store.aiPop = null; store.aiMenu = null; }
    if (store.aiTop && !e.target.closest(".ai-drop-wrap")) store.aiTop = null;
    if (store.aiHistory && !e.target.closest(".ai-history") && !e.target.closest("[data-act=ai-history]")) { store.aiHistory = false; store.aiHistLimit = 20; store.aiHistQuery = ""; store.aiHistFocus = false; store.aiHistMenu = null; }
    // CR-064：点击菜单外部关闭「…」菜单
    if (store.aiHistMenu && !e.target.closest(".ai-hist-menu-wrap")) store.aiHistMenu = null;
    const el = e.target.closest("[data-act]");
    if (!el) { if (hadMenu && !e.target.closest("#ai-menu")) render(); return; }
    const fn = actions[el.dataset.act];
    if (!fn) { if (hadMenu) render(); return; }
    if (el.tagName === "A") e.preventDefault();
    fn(el, e);
    if (hadMenu) render();
  });

  // CR-074：共享历史搜索由 cr074.js 局部更新，保留原始输入、IME与选区。

  /* CR-064：原位重命名——Enter 保存、Escape 取消、失焦保存 */
  document.addEventListener("focusout", e => {
    if (e.target && e.target.id === "ai-hist-rename-input" && store.aiHistEditId) {
      setTimeout(() => { if (store.aiHistEditId) actions["ai-hist-rename-save"](); }, 0);
    }
  }, true);

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
  const composingChatInputs = new WeakSet();
  const isChatInput = target => ["ai-input", "ai-goal-draft", "ai-menu-q"].includes(target?.id);
  const chatComposing = (target, event) => composingChatInputs.has(target) || event?.isComposing || event?.keyCode === 229;
  document.addEventListener("compositionstart", e => { if (isChatInput(e.target)) composingChatInputs.add(e.target); });
  document.addEventListener("input", e => {
    if (e.target.id === "ai-goal-draft") {
      ChatDock.input(AIPanel.activeSession(), e.target.value);
      return;
    }
    const el = e.target;
    if (el.id === "proj-search") { store.projQuery = el.value; render(); }
    else if (el.id === "tree-search") { store.treeQuery = el.value; render(); }
    else if (el.id === "kb-search") { store.kbQuery = el.value; render(); }
    else if (el.id === "ai-input") AIPanel.inputChanged(el, chatComposing(el, e));
    else if (el.id === "ai-menu-q") {
      const selection = [el.selectionStart, el.selectionEnd, el.selectionDirection];
      store.aiMenuQuery = el.value;
      if (chatComposing(el, e)) return;
      render();
      const input = document.getElementById("ai-menu-q");
      input?.focus({ preventScroll: true });
      input?.setSelectionRange(...selection);
    }
    else if (el.id === "ai-model-q") { store.aiModelQuery = el.value; render(); setTimeout(() => { const q = document.getElementById("ai-model-q"); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }, 0); }
    else if (el.id === "git-message") { store.gitMessage = el.value; render(); }
    else if (el.id === "git-branch-q") { store.gitBranchQuery = el.value; render(); }
    else if (el.id === "git-history-author") { store.gitHistoryAuthor = el.value; render(); }
    else if (el.id === "code-editor") { store.codeDraft = el.value; }
    else if (el.id === "design-editor") { store.designDraft = el.value; }
    else if (el.id === "term-input") { store.termInput = el.value; }
    else if (el.id === "global-q") renderSearch(el.value);
  });

  document.addEventListener("compositionend", e => {
    if (!isChatInput(e.target)) return;
    composingChatInputs.delete(e.target);
    if (e.target.id === "ai-input") AIPanel.inputChanged(e.target);
    else if (e.target.id === "ai-menu-q") e.target.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
  document.addEventListener("keyup", e => { if (e.target.id === "ai-input" && !chatComposing(e.target, e) && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) AIPanel.inputChanged(e.target); });
  document.addEventListener("change", e => {
    if (e.target.id !== "ai-image-input") return;
    const files = Array.from(e.target.files);
    e.target.value = "";
    void AIPanel.addImages(files);
  });
  document.addEventListener("paste", e => {
    if (e.target.id !== "ai-input" || e.clipboardData.getData("text/plain")) return;
    const files = Array.from(e.clipboardData.files).filter(file => file.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    if (AIPanel.canAttachImages()) void AIPanel.addImages(files);
    else toast("当前通道暂不支持图片，请切换到 Codex", "alert");
  });
  document.addEventListener("dragover", e => {
    if (e.target.closest(".ai-composer") && AIPanel.canAttachImages() && e.dataTransfer.types.includes("Files")) e.preventDefault();
  });
  document.addEventListener("drop", e => {
    if (!e.target.closest(".ai-composer") || !e.dataTransfer.files.length) return;
    e.preventDefault();
    void AIPanel.addImages(Array.from(e.dataTransfer.files));
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
    if (isChatInput(e.target) && chatComposing(e.target, e)) { e.stopPropagation(); return; }
    if (e.target.id === "ai-goal-draft") {
      if (e.isComposing) return;
      if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        ChatDock.finish(e.key === "Enter");
        return;
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openSearch(); return; }
    // CR-064：原位重命名时 Enter 保存、Escape 取消，优先于浮层关闭
    if (store.aiHistEditId) {
      if (e.isComposing) return;
      if (e.key === "Enter") { e.preventDefault(); actions["ai-hist-rename-save"](); return; }
      if (e.key === "Escape") { e.preventDefault(); actions["ai-hist-rename-cancel"](); return; }
    }
    if (e.key === "Escape") {
      const sub = document.getElementById("dialog2"), dlg = document.getElementById("dialog");
      if ((sub && sub.open) || (dlg && dlg.open)) { e.preventDefault(); UI.closeTopDialog(); return; }
      if (store.reqMenu) { store.reqMenu = null; render(); return; }
      if (store.aiHistMenu) { store.aiHistMenu = null; render(); return; }
      if (store.aiMenu || store.aiPop || store.aiTop || store.aiHistory) { store.aiMenu = null; store.aiPop = null; store.aiTop = null; store.aiHistory = false; store.aiHistMenu = null; render(); return; }
      UI.closeTopDialog();
    }
    const input = e.target.id === "ai-input";
    const search = e.target.id === "ai-menu-q";
    const row = e.target.closest("#ai-menu .chat-ref-row");
    if ((input || search || row) && !e.isComposing) {
      const options = [...document.querySelectorAll("#ai-menu .chat-ref-row:not(:disabled)")].filter(option => option.getClientRects().length && !option.closest("details:not([open])"));
      if (options.length && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const direction = e.key === "ArrowDown" ? 1 : -1;
        const index = row ? (options.indexOf(row) + direction + options.length) % options.length : direction === 1 ? 0 : options.length - 1;
        e.preventDefault();
        options[index].focus();
      } else if ((input || search) && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (options.length) options[0].click();
        else if (input) AIPanel.send();
      }
    }
  });

  document.addEventListener("click", e => { if (e.target.id === "dialog" || e.target.id === "dialog2") UI.closeTopDialog(); });

  /* ================= CR-059：设置中心评审调整交互 ================= */
  /* A4：供应商协议下拉（change 事件）。 */
  document.addEventListener("change", e => {
    const el = e.target;
    if (el.id === "git-history-branch") { store.gitHistoryBranch = el.value; render(); return; }
    if (el.id === "git-history-range") { store.gitHistoryRange = el.value; render(); return; }
    if (el.id === "pm-protocol") { actions["provider-protocol-set"](el); return; }
    if (el.hasAttribute && el.hasAttribute("data-mcp-type")) { store.mcpFormType = el.value; S().mcpAddDialog(); return; }
    if (el.hasAttribute && el.hasAttribute("data-scan-skill")) { store.skillScanSel = store.skillScanSel || {}; store.skillScanSel[el.dataset.scanSkill] = el.checked; return; }
    if (el.hasAttribute && el.hasAttribute("data-scan-mcp")) { store.mcpScanSel = store.mcpScanSel || {}; store.mcpScanSel[el.dataset.scanMcp] = el.checked; return; }
    if (el.hasAttribute && el.hasAttribute("data-cli-slot")) {
      const [cliId, slot, field] = el.dataset.cliSlot.split(":");
      const c = D.settings.clis.find(x => x.id === cliId); if (!c) return;
      if (slot === "fallback") { c.fallback = c.fallback || { model: "", note: "跟随主 agent" }; c.fallback.model = el.value; }
      else { c.slots = c.slots || []; c.slots[Number(slot)] = c.slots[Number(slot)] || { model: "", effort: "", types: [] }; c.slots[Number(slot)][field] = el.value; }
      return;
    }
    if (el.hasAttribute && el.hasAttribute("data-cli-perm")) {
      const c = D.settings.clis.find(x => x.id === el.dataset.cliPerm);
      if (c) c.permission = el.value;
      return;
    }
  });

  /* A5：供应商拖动排序——指针拖动手柄，插入指示线，松手保存顺序；键盘 Alt+↑/↓ 等价。 */
  let dragProvider = null;
  function providerCards() { return Array.from(document.querySelectorAll("[data-provider-card]")); }
  function clearDropMarks() { providerCards().forEach(c => c.classList.remove("drop-before", "drop-after")); }
  function moveProvider(id, dir) {
    const list = D.settings.providers;
    const i = list.findIndex(p => p.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return false;
    const [p] = list.splice(i, 1);
    list.splice(j, 0, p);
    return true;
  }
  document.addEventListener("pointerdown", e => {
    const handle = e.target.closest("[data-drag-provider]");
    if (!handle) return;
    dragProvider = { id: handle.dataset.dragProvider, startY: e.clientY, moved: false };
    handle.setPointerCapture && handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  document.addEventListener("pointermove", e => {
    if (!dragProvider) return;
    if (Math.abs(e.clientY - dragProvider.startY) > 4) dragProvider.moved = true;
    if (!dragProvider.moved) return;
    const cards = providerCards();
    clearDropMarks();
    const target = cards.find(c => {
      const r = c.getBoundingClientRect();
      return e.clientY >= r.top && e.clientY <= r.bottom && c.dataset.providerCard !== dragProvider.id;
    });
    if (target) {
      const r = target.getBoundingClientRect();
      target.classList.add(e.clientY < r.top + r.height / 2 ? "drop-before" : "drop-after");
      dragProvider.target = target.dataset.providerCard;
      dragProvider.before = e.clientY < r.top + r.height / 2;
    } else { dragProvider.target = null; }
  });
  document.addEventListener("pointerup", () => {
    if (!dragProvider) return;
    const d = dragProvider; dragProvider = null;
    clearDropMarks();
    if (!d.moved || !d.target) return;
    const list = D.settings.providers;
    const from = list.findIndex(p => p.id === d.id);
    let to = list.findIndex(p => p.id === d.target);
    if (from < 0 || to < 0) return;
    const [p] = list.splice(from, 1);
    to = list.findIndex(x => x.id === d.target);
    list.splice(d.before ? to : to + 1, 0, p);
    S().refreshSettings(); toast("供应商顺序已保存（演示）");
  });
  document.addEventListener("keydown", e => {
    const handle = e.target.closest && e.target.closest("[data-drag-provider]");
    if (!handle || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    if (moveProvider(handle.dataset.dragProvider, e.key === "ArrowUp" ? -1 : 1)) {
      S().refreshSettings();
      const again = document.querySelector(`[data-drag-provider="${handle.dataset.dragProvider}"]`);
      if (again) again.focus();
      toast("供应商顺序已保存（键盘）");
    }
  });

  /* ================= CR-059 r3：模型与生图列表拖动排序（复用同一套指针/键盘模式） ================= */
  const modelList = () => {
    const p = D.settings.providers.find(x => x.id === store.providerOpen);
    return p ? p.models : null;
  };
  function moveInList(list, id, dir, keyOf) {
    if (!list) return false;
    const i = list.findIndex(x => keyOf(x) === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return false;
    const [x] = list.splice(i, 1);
    list.splice(j, 0, x);
    return true;
  }
  let dragRow = null;
  document.addEventListener("pointerdown", e => {
    if (dragProvider) return;
    const mh = e.target.closest("[data-drag-model]");
    const ih = e.target.closest("[data-drag-ig]");
    if (!mh && !ih) return;
    dragRow = mh
      ? { kind: "model", id: mh.dataset.dragModel, startY: e.clientY, moved: false, attr: "data-model-card" }
      : { kind: "ig", id: ih.dataset.dragIg, startY: e.clientY, moved: false, attr: "data-ig-model" };
    (mh || ih).setPointerCapture && (mh || ih).setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  document.addEventListener("pointermove", e => {
    if (!dragRow) return;
    if (Math.abs(e.clientY - dragRow.startY) > 4) dragRow.moved = true;
    if (!dragRow.moved) return;
    const rows = Array.from(document.querySelectorAll(`[${dragRow.attr}]`));
    rows.forEach(r => r.classList.remove("drop-before", "drop-after"));
    const target = rows.find(r => {
      const rect = r.getBoundingClientRect();
      return e.clientY >= rect.top && e.clientY <= rect.bottom && r.getAttribute(dragRow.attr) !== dragRow.id;
    });
    if (target) {
      const rect = target.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      target.classList.add(before ? "drop-before" : "drop-after");
      dragRow.target = target.getAttribute(dragRow.attr);
      dragRow.before = before;
    } else { dragRow.target = null; }
  });
  document.addEventListener("pointerup", () => {
    if (!dragRow) return;
    const d = dragRow; dragRow = null;
    document.querySelectorAll(".drop-before, .drop-after").forEach(r => r.classList.remove("drop-before", "drop-after"));
    if (!d.moved || !d.target) return;
    if (d.kind === "model") {
      const list = modelList(); if (!list) return;
      const from = list.findIndex(m => m.id === d.id);
      let to = list.findIndex(m => m.id === d.target);
      if (from < 0 || to < 0) return;
      const [m] = list.splice(from, 1);
      to = list.findIndex(x => x.id === d.target);
      list.splice(d.before ? to : to + 1, 0, m);
      S().refreshSettings(); toast("模型顺序已保存（演示）");
    } else {
      const c = D.settings.imageGen;
      const from = c.order.indexOf(d.id);
      if (from < 0) return;
      const [key] = c.order.splice(from, 1);
      let to = c.order.indexOf(d.target);
      if (to < 0) { c.order.push(key); } else { c.order.splice(d.before ? to : to + 1, 0, key); }
      S().imageGenDialog(); toast("生图模型优先顺序已更新（演示）");
    }
  });
  document.addEventListener("keydown", e => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    const dir = e.key === "ArrowUp" ? -1 : 1;
    const mh = e.target.closest && e.target.closest("[data-drag-model]");
    if (mh) {
      e.preventDefault();
      if (moveInList(modelList(), mh.dataset.dragModel, dir, m => m.id)) {
        S().refreshSettings();
        const again = document.querySelector(`[data-drag-model="${mh.dataset.dragModel}"]`);
        if (again) again.focus();
        toast("模型顺序已保存（键盘）");
      }
      return;
    }
    const ih = e.target.closest && e.target.closest("[data-drag-ig]");
    if (ih) {
      e.preventDefault();
      const c = D.settings.imageGen;
      const i = c.order.indexOf(ih.dataset.dragIg);
      const j = i + dir;
      if (i >= 0 && j >= 0 && j < c.order.length) {
        [c.order[i], c.order[j]] = [c.order[j], c.order[i]];
        S().imageGenDialog();
        const again = document.querySelector(`[data-drag-ig="${ih.dataset.dragIg}"]`);
        if (again) again.focus();
        toast("生图模型顺序已更新（键盘）");
      }
    }
  });

  /* D5/E4：打开 CLI/SDK 页签时首帧渲染缓存，后台逐项「检测中…」渐进上屏（演示 stale-while-revalidate）。 */
  const origOpenSettings = S().openSettings;
  S().openSettings = function (tab) {
    origOpenSettings(tab);
    if (tab === "cli") warmCliSdk();
  };
  function warmCliSdk() {
    if (store.sdkVersionsReady === undefined) {
      /* 首次：版本列表短暂「加载中…」后到位；已有缓存则直接短路。 */
      store.sdkVersionsReady = false;
      S().refreshSettings();
      setTimeout(() => { store.sdkVersionsReady = true; S().refreshSettings(); }, 500);
    }
    const items = D.settings.clis.filter(c => c.installed);
    items.forEach((c, i) => {
      setTimeout(() => { store.cliChecking = c.id; S().refreshSettings(); }, 120 * i);
      setTimeout(() => { if (store.cliChecking === c.id) store.cliChecking = null; S().refreshSettings(); }, 420 + 160 * i);
    });
  }

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

  /* CR-054：挂载会话中心工作台。只注册新增动作并包装 Screens.project / Office.renderPage，
     不重写既有视图；Action 名统一 wb- 前缀，project-tab 为覆盖式接管（工作台需要整页渲染）。 */
  if (window.WorkbenchUI) {
    Object.assign(actions, WorkbenchUI.ACTIONS);
    try { WorkbenchUI.attach(); } catch (e) { console.error("WorkbenchUI 挂载失败", e); }
  }

  window.__actions = actions;
  if (!D.settings.general.sendMode) D.settings.general.sendMode = "queue";
  // CR-056：`?demo=ai` 直接打开项目窗口并展开 AI 侧栏，便于逐状态截图；默认行为不变。
  const demoParam = new URLSearchParams(window.location.search).get("demo");
  if (demoParam === "ai") {
    const pid = D.requirements.find(r => r.kind === "story")?.project || D.projects[0]?.id;
    if (pid) { UI.openWindow("project", pid, D.projects.find(p => p.id === pid)?.name || pid); store.aiOpen = true; }
    // 截图用：top=1 停在与在顶部，便于查看完整时间线；默认贴底跟随最新消息。
    if (new URLSearchParams(window.location.search).get("top") === "1") store.aiStick = false;
  }
  // CR-062：`?agent=<id>` 直接打开子智能体只读详情，供设计与软件同条件截图。
  const agentParam = new URLSearchParams(window.location.search).get("agent");
  // 截图辅助：隐藏右下角栏宽开关，避免遮挡只读条按钮；不影响交互演示。
  if (new URLSearchParams(window.location.search).get("clean") === "1") document.body.classList.add("shot-clean");
  if (agentParam) {
    const pid = D.requirements.find(r => r.kind === "story")?.project || D.projects[0]?.id;
    if (pid) { UI.openWindow("project", pid, D.projects.find(p => p.id === pid)?.name || pid); store.aiOpen = true; }
    store.aiAgent = agentParam;
  }
  render();
})();









