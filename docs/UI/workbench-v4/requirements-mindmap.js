/* UI-CR066-v1 · 需求思维导图：标准层级思维导图（Xmind / ProcessOn 式）。
   仅可操作设计资源：不读取磁盘、不接模型／派发后端、不写正式软件。 */
(function () {
  "use strict";
  const { D, store, esc, icon } = UI;
  const actions = window.__actions;

  const KIND_LABEL = { vision: "Vision", epic: "Epic", feature: "Feature", story: "Story", bug: "Bug", model: "模型" };
  const KIND_ORDER = { vision: 0, epic: 1, feature: 2, story: 3, bug: 4, model: 5 };
  /* 导图内新增只允许一级下级：Vision→Epic→Feature→Story。 */
  const CHILD_KIND = { vision: "epic", epic: "feature", feature: "story" };
  const H_GAP = 58, V_GAP = 16, NODE_H = 46;

  /** UI-CR073：当前渲染工作区的项目 id（store.projectId 在切换窗口时不更新）。 */
  function activeProjectId() {
    const root = document.querySelector(".req-workspace");
    return (root && root.dataset.project) || store.projectId;
  }
  function activeState() { return stateOf(activeProjectId()); }
  const states = new Map();
  function stateOf(projectId) {
    if (!states.has(projectId)) states.set(projectId, { selected: null, collapsed: new Set(), locate: null, draft: null });
    return states.get(projectId);
  }

  function textWidth(title) {
    let width = 0;
    for (const ch of String(title || "")) width += /[\u2E80-\u9FFF\uFF00-\uFFEF]/.test(ch) ? 13 : 7;
    /* 节点右侧还要放折叠／新增／文档三个 22px 图标，宽度必须一并计入，否则标题被截断。 */
    return Math.round(Math.min(320, Math.max(200, width + 66 + 72)));
  }

  function rawChildrenOf(data, node) {
    const out = [];
    data.all.forEach(candidate => {
      if (candidate.id === node.id) return;
      if (candidate.parent === node.id) out.push(candidate);
    });
    if (node.kind === "vision") {
      data.all.forEach(candidate => {
        if (candidate.id === node.id || candidate.kind === "vision") return;
        if (!candidate.parent && !out.some(item => item.id === candidate.id)) out.push(candidate);
      });
      /* 模型是项目级独立分支，与 Epic 平级挂在 Vision 下；不成为 Story 的第二父项。 */
      data.all.forEach(candidate => {
        if (candidate.kind !== "model") return;
        if (!out.some(item => item.id === candidate.id)) out.push(candidate);
      });
    }
    return out;
  }

  function childrenOf(data, node, collapsed) {
    return rawChildrenOf(data, node)
      .filter(candidate => !collapsed.has(node.id))
      .sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || String(a.id).localeCompare(String(b.id)));
  }

  /** 层级布局：父在左、子在右；子节点纵向排开，父节点垂直居中于其子树。 */
  function layout(root, kidsOf) {
    const nodes = [], edges = [];
    let cursor = 0;
    const seen = new Set();
    function place(node, depth, x) {
      if (seen.has(node.id)) return null;
      seen.add(node.id);
      node._w = textWidth(node.title || node.id);
      node._h = NODE_H;
      node._x = x;
      node._depth = depth;
      const placed = [];
      kidsOf(node).forEach(kid => { const child = place(kid, depth + 1, x + node._w + H_GAP); if (child) placed.push(child); });
      if (!placed.length) { node._y = cursor; cursor += node._h + V_GAP; }
      else {
        const first = placed[0], last = placed[placed.length - 1];
        node._y = (first._y + first._h / 2 + last._y + last._h / 2) / 2 - node._h / 2;
      }
      nodes.push(node);
      placed.forEach(child => edges.push({ from: node, to: child }));
      return node;
    }
    place(root, 0, 24);
    return {
      nodes, edges,
      width: nodes.reduce((max, node) => Math.max(max, node._x + node._w), 0) + 24,
      height: cursor + 24
    };
  }

  function edgePath(from, to) {
    const x1 = from._x + from._w, y1 = from._y + from._h / 2;
    const x2 = to._x, y2 = to._y + to._h / 2;
    const bend = Math.max(24, (x2 - x1) * 0.5);
    return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
  }

  function nodeHtml(node, data, st) {
    const childKind = CHILD_KIND[node.kind];
    const on = st.selected === node.id;
    const broken = node.kind !== "vision" && !!node.parent && !data.all.some(candidate => candidate.id === node.parent);
    return `<div class="req-map-node ${esc(node.kind)}${on ? " on" : ""}${broken ? " broken" : ""}" data-node-id="${esc(node.id)}"
        style="left:${node._x}px;top:${node._y}px;width:${node._w}px;height:${node._h}px" tabindex="0" role="treeitem" aria-selected="${on}"
        aria-label="${esc(KIND_LABEL[node.kind] || node.kind)} ${esc(node.id)} ${esc(node.title || "")}">
        <button class="req-map-node-hit" data-act="req-map-select" data-id="${esc(node.id)}" data-kind="${esc(node.kind)}">
          <small>${esc(KIND_LABEL[node.kind] || node.kind)}${node.id ? ` · ${esc(node.id)}` : ""}</small>
          <b>${esc(node.title || node.id)}</b>
        </button>
        <span class="req-map-node-tools">
          ${childKind ? `<button data-act="req-map-add" data-id="${esc(node.id)}" data-kind="${childKind}" aria-label="在${esc(node.title || node.id)}下新增${esc(KIND_LABEL[childKind])}" title="新增下级${esc(KIND_LABEL[childKind])}">${icon("plus", "ico-14")}</button>` : ""}
          ${node.kind === "model" ? `<button data-act="req-map-open-model" data-id="${esc(node.id)}" aria-label="打开模型文档${esc(node.title || node.id)}" title="打开模型文档">${icon("database", "ico-14")}</button>` : `<button data-act="req-map-open-doc" data-id="${esc(node.id)}" data-kind="${esc(node.kind)}" aria-label="在文档中打开${esc(node.title || node.id)}" title="在文档中打开">${icon("fileText", "ico-14")}</button>`}
        </span>
      </div>`;
  }

  /* UI-CR066 r2：折叠控件放在父子连线的连接处（父节点右边缘），悬浮连线或控件时才显示，
     不再与节点内的「新增下级」图标挤在一起。 */
  function foldHtml(node, data, st) {
    const hasKids = rawChildrenOf(data, node).length > 0;
    if (!hasKids) return "";
    const shut = st.collapsed.has(node.id);
    return `<button class="req-map-foldpoint" data-act="req-map-fold" data-id="${esc(node.id)}" data-for="${esc(node.id)}" aria-expanded="${!shut}"
        aria-label="${shut ? "展开" : "折叠"}${esc(node.title || node.id)}的子级" title="${shut ? "展开子级" : "折叠子级"}"
        style="left:${node._x + node._w}px;top:${node._y + node._h / 2}px">${icon(shut ? "plus" : "minimize", "ico-14")}</button>`;
  }

  function detailHtml(node) {
    const status = (D.statusMeta && D.statusMeta[node.status] && D.statusMeta[node.status].label) || node.status || "未提供";
    const acs = Array.isArray(node.acs) ? node.acs : [];
    /* UI-CR073（用户第 7 项）：右侧悬浮栏由「查看」改为「编辑」。
       有了右侧面板就不再弹窗：字段直接可改，底部保存/取消；模型节点保持只读。 */
    const editable = node.kind !== "model";
    const statusOptions = Object.keys(D.statusMeta || {}).map(k => `<option value="${esc(k)}" ${node.status === k ? "selected" : ""}>${esc(D.statusMeta[k].label)}</option>`).join("");
    const body = editable
      ? `<div class="req-map-editor-form" data-edit-id="${esc(node.id)}">
          <div><label for="rme-title">标题</label><input class="input" id="rme-title" data-field="title" value="${esc(node.title || "")}"></div>
          <div class="req-map-editor-fields">
            <div><label for="rme-status">状态</label><select class="select" id="rme-status" data-field="status">${statusOptions}</select></div>
            <div><label for="rme-owner">负责人</label><input class="input" id="rme-owner" data-field="owner" value="${esc(node.owner || "")}"></div>
          </div>
          <div><label for="rme-summary">摘要</label><textarea class="textarea" id="rme-summary" rows="2" data-field="summary">${esc(node.summary || "")}</textarea></div>
          <div class="req-map-editor-fields">
            <div><label for="rme-estimate">工作量</label><input class="input" id="rme-estimate" data-field="estimate" value="${esc(node.estimate || "")}" placeholder="例如：2 人日"></div>
            <div><label for="rme-updated">最近更新</label><input class="input" id="rme-updated" data-field="updated" value="${esc(node.updated || "")}" readonly></div>
          </div>
          ${node.kind === "story" || node.kind === "bug" ? `<div><label for="rme-acs">可观察验收（每行一条，保留已有 AC 编号）</label><textarea class="textarea mono" id="rme-acs" rows="4" data-field="acs">${esc(acs.map(a => `${a.id}：${a.text || ""}`).join("\n"))}</textarea></div>` : ""}
          <div><label for="rme-body">正文（Markdown）</label><textarea class="textarea mono" id="rme-body" rows="6" data-field="body">${esc(String(node.body ?? node.content ?? node.markdown ?? "").replace(/^\s*#\s+[^\n]*(?:\n|$)/, ""))}</textarea></div>
          <p class="req-map-editor-note">保存写回该项目源文档；取消不改动。完整正文仍在「文档」页签可读。</p>
        </div>`
      : `<div class="req-map-detail-scroll">
          <h3>${esc(node.title || node.id)}</h3>
          <dl class="req-map-detail-meta">
            <dt>类型</dt><dd>数据库／领域设计模型</dd>
            <dt>关联</dt><dd>项目级独立分支，不作为 Story 的第二父项</dd>
            <dt>来源</dt><dd>${esc(node.relPath || "未提供")}</dd>
          </dl>
        </div>`;
    return `<aside class="req-map-detail${editable ? " req-map-editor" : ""}" role="dialog" aria-label="${esc(node.title || node.id)}${editable ? "编辑" : "详情"}" data-edit-id="${esc(node.id)}">
      <header class="req-map-detail-head">
        <span class="req-kind ${esc(node.kind)}">${esc(KIND_LABEL[node.kind] || node.kind)}</span>
        <b>${esc(node.id)}</b>
        <span class="caption">${editable ? "编辑" : "只读"}</span>
        <button class="icon-btn" data-act="req-map-detail-close" aria-label="关闭面板">${icon("x", "ico-14")}</button>
      </header>
      <div class="req-map-detail-scroll">${body}</div>
      <footer class="req-map-detail-foot">
        ${editable
          ? `<button class="btn sm primary" data-act="req-map-save" data-id="${esc(node.id)}">保存</button><button class="btn sm" data-act="req-map-cancel" data-id="${esc(node.id)}">取消</button><span class="spacer"></span><button class="btn sm" data-act="req-map-open-doc" data-id="${esc(node.id)}" data-kind="${esc(node.kind)}">${icon("fileText", "ico-14")}文档</button>`
          : `<button class="btn sm" data-act="req-map-open-model" data-id="${esc(node.id)}">${icon("database", "ico-14")}打开模型文档</button>`}
      </footer>
    </aside>`;
  }

  /* UI-CR073（用户第 7 项）：新建下级不再弹窗。画布先出现虚线占位节点，
     右侧复用同一编辑面板（新建态）；保存后落库并选中，取消则移除占位。 */
  function draftHtml(draft, graph) {
    const parent = graph.nodes.find(node => node.id === draft.parentId);
    if (!parent) return "";
    const x = parent._x + parent._w + H_GAP, y = parent._y + parent._h + V_GAP;
    const label = KIND_LABEL[draft.kind] || draft.kind;
    return `<div class="req-map-node ${esc(draft.kind)} req-map-draft" data-draft-kind="${esc(draft.kind)}" data-draft-parent="${esc(draft.parentId)}"
        style="left:${x}px;top:${y}px;width:200px;height:${NODE_H}px" aria-label="新建${esc(label)}占位">
        <span class="req-map-draft-tag">未保存</span>
        <span class="req-map-node-hit"><small>${esc(label)} · 新建</small><b>${esc(draft.title || "填写标题后保存")}</b></span>
      </div>`;
  }

  function draftPanelHtml(draft) {
    const label = KIND_LABEL[draft.kind] || draft.kind;
    const statusOptions = Object.keys(D.statusMeta || {}).map(k => `<option value="${esc(k)}" ${draft.status === k ? "selected" : ""}>${esc(D.statusMeta[k].label)}</option>`).join("");
    return `<aside class="req-map-detail req-map-editor" role="dialog" aria-label="新建${esc(label)}" data-create-kind="${esc(draft.kind)}">
      <header class="req-map-detail-head">
        <span class="req-kind ${esc(draft.kind)}">${esc(label)}</span>
        <b>新建</b>
        <span class="caption">在 ${esc(draft.parentId)} 下</span>
        <button class="icon-btn" data-act="req-map-draft-close" aria-label="取消新建">${icon("x", "ico-14")}</button>
      </header>
      <div class="req-map-detail-scroll">
        <div class="req-map-editor-form" data-create="1">
          <div><label for="rmc-title">标题</label><input class="input" id="rmc-title" data-field="title" value="${esc(draft.title || "")}" placeholder="一句话说明价值"></div>
          <div class="req-map-editor-fields">
            <div><label for="rmc-status">状态</label><select class="select" id="rmc-status" data-field="status">${statusOptions}</select></div>
            <div><label for="rmc-owner">负责人</label><input class="input" id="rmc-owner" data-field="owner" value="${esc(draft.owner || "")}"></div>
          </div>
          <div><label for="rmc-summary">摘要</label><textarea class="textarea" id="rmc-summary" rows="2" data-field="summary">${esc(draft.summary || "")}</textarea></div>
          <div><label for="rmc-estimate">工作量</label><input class="input" id="rmc-estimate" data-field="estimate" value="${esc(draft.estimate || "")}" placeholder="例如：2 人日"></div>
          ${draft.kind === "story" ? `<div><label for="rmc-acs">可观察验收（每行一条）</label><textarea class="textarea mono" id="rmc-acs" rows="4" data-field="acs">${esc(draft.acs || "")}</textarea></div>` : ""}
          <div><label for="rmc-body">正文（Markdown）</label><textarea class="textarea mono" id="rmc-body" rows="5" data-field="body">${esc(draft.body || "")}</textarea></div>
          <p class="req-map-editor-note">保存后按现有规则分配编号并写入项目目录；取消不会产生文件。</p>
        </div>
      </div>
      <footer class="req-map-detail-foot">
        <button class="btn sm primary" data-act="req-map-draft-save">保存</button>
        <button class="btn sm" data-act="req-map-draft-close">取消</button>
      </footer>
    </aside>`;
  }

  /** 导图主区：整块是画布 + 右侧编辑面板（新建时复用同一面板），不再是「上导图、下正文」。
   *  UI-CR073：画布支持空白处拖拽平移与 Ctrl/⌘ + 滚轮缩放。 */
  function mapHtml(p, s, data) {
    const st = stateOf(p.id);
    const zoom = s.mapZoom || 1;
    const graph = layout(data.vision, node => childrenOf(data, node, st.collapsed));
    const selected = data.all.find(node => node.id === st.selected) ?? null;
    const selectedVisible = selected && graph.nodes.some(node => node.id === selected.id) ? selected : null;
    const paths = graph.edges.map(edge => `<path class="req-map-edge${edge.to.kind === "model" ? " dashed" : ""}" d="${edgePath(edge.from, edge.to)}"/>`).join("");
    const folds = graph.nodes.map(node => foldHtml(node, data, st)).join("");
    const draft = st.draft || null;
    return `<section class="req-map-area" data-mode="map" data-zoom="${zoom}">
      <div class="req-map-controls">
        <b>思维导图</b>
        <button class="btn sm" data-act="req-map-zoom" data-delta="-0.1" aria-label="缩小">−</button>
        <span class="req-map-zoom">${Math.round(zoom * 100)}%</span>
        <button class="btn sm" data-act="req-map-zoom" data-delta="0.1" aria-label="放大">+</button>
        <button class="btn sm" data-act="req-map-reset">重置</button>
        <button class="btn sm" data-act="req-map-fit">适应窗口</button>
        <button class="btn sm" data-act="req-map-all" data-collapse="false">全部展开</button>
        <button class="btn sm" data-act="req-map-all" data-collapse="true">折叠分支</button>
        <span class="spacer"></span>
        <span class="caption">空白处拖动平移 · Ctrl+滚轮缩放</span>
        <button class="btn sm" data-act="req-map-add" data-id="${esc(data.vision.id)}" data-kind="epic">${icon("plus", "ico-14")}新增 Epic</button>
      </div>
      <div class="req-map-stage">
        <div class="req-map-scroll"><div class="req-map-scaled" style="width:${Math.round(graph.width * zoom)}px;height:${Math.round(graph.height * zoom)}px">
          <div class="req-map-inner" style="width:${graph.width}px;height:${graph.height}px">
            <svg class="req-map-edges" width="${graph.width}" height="${graph.height}" aria-hidden="true">${paths}</svg>
            ${graph.nodes.map(node => nodeHtml(node, data, st)).join("")}
            ${folds}
            ${draft ? draftHtml(draft, graph) : ""}
          </div>
        </div></div>
        ${draft ? draftPanelHtml(draft) : selectedVisible ? detailHtml(selectedVisible) : ""}
      </div>
      <div class="req-map-help">整块为思维导图：Vision 连接 Epic、Epic 连接 Feature、Feature 连接 Story；点击节点在右侧面板直接编辑，左侧「导图目录」可定位节点，节点上可直接新增下级（同样在右侧面板填写）。</div>
    </section>`;
  }

  /** 导图目录：与画布同源同一层级，点击定位并选中画布中对应节点。 */
  function outlineHtml(p, s, data) {
    const st = stateOf(p.id);
    const rows = [];
    const walk = (node, depth) => {
      rows.push({ node, depth });
      childrenOf(data, node, st.collapsed).forEach(child => walk(child, depth + 1));
    };
    walk(data.vision, 0);
    return rows.map(({ node, depth }) => `<div class="req-tree-row${st.selected === node.id ? " on" : ""}" style="--req-depth:${depth}" role="treeitem" aria-selected="${st.selected === node.id}">
      <span class="req-tree-caret"></span>
      <button class="req-tree-open" data-act="req-map-locate" data-id="${esc(node.id)}" data-kind="${esc(node.kind)}">
        <span class="req-kind ${esc(node.kind)}">${esc(KIND_LABEL[node.kind] || node.kind)}</span>
        <span class="ellipsis">${esc(node.title || node.id)}</span>
        <small>${esc(node.id)}</small>
      </button>
    </div>`).join("");
  }

  /** 缩放到画布可见范围（导图类产品的标准「适应窗口」）。 */
  function fitToView(projectId) {
    const p = D.projects.find(project => project.id === projectId);
    const data = p && window.RequirementsWorkspace.inventoryById(projectId);
    const canvas = document.querySelector(".req-map-scroll");
    if (!data || !canvas) return;
    const st = stateOf(projectId);
    const graph = layout(data.vision, node => childrenOf(data, node, st.collapsed));
    const available = canvas.clientWidth - 48, availableH = canvas.clientHeight - 48;
    if (!graph.width || !graph.height) return;
    const ratio = Math.min(1, Math.min(available / graph.width, availableH / graph.height));
    const zoom = Math.max(0.4, Math.round(ratio * 20) / 20);
    /* 缩放值与折叠状态同属项目级阅读状态，统一放在 requirements-workspace 的 state 里。 */
    const ws = window.RequirementsWorkspace.getState(projectId);
    if (ws) ws.mapZoom = zoom;
  }

  actions["req-map-select"] = el => {
    const st = activeState();
    st.selected = el.dataset.id;
    st.locate = null;
    UI.render();
  };
  actions["req-map-detail-close"] = () => { activeState().selected = null; UI.render(); };
  actions["req-map-fit"] = () => { fitToView(store.projectId); UI.render(); };
  actions["req-map-locate"] = el => {
    const st = activeState();
    st.selected = el.dataset.id;
    st.locate = el.dataset.id;
    UI.render();
  };
  actions["req-map-fold"] = el => {
    const st = activeState();
    const id = el.dataset.id;
    st.collapsed.has(id) ? st.collapsed.delete(id) : st.collapsed.add(id);
    UI.render();
  };
  actions["req-map-all"] = el => {
    const st = activeState();
    const p = D.projects.find(project => project.id === activeProjectId());
    const data = p && window.RequirementsWorkspace.inventoryById(p.id);
    if (!data) return;
    st.collapsed = new Set(el.dataset.collapse === "true" ? data.all.filter(node => node.kind !== "vision").map(node => node.id) : []);
    UI.render();
  };
  actions["req-map-add"] = el => {
    const kind = el.dataset.kind || "epic";
    const parent = el.dataset.id || "";
    const p = D.projects.find(project => project.id === activeProjectId());
    const data = p && window.RequirementsWorkspace.inventoryById(p.id);
    /* 合成情景愿景不是真实来源，不在其下新增条目，避免把演示节点当真实父项。 */
    if (data && data.vision.scenario && parent === data.vision.id) { UI.toast("情景愿景不是真实来源，不能在其下新增需求"); return; }
    store.reqMenu = null;
    /* UI-CR073：不弹窗；画布出现占位节点，右侧复用编辑面板（新建态）。 */
    const st = activeState();
    st.selected = null;
    st.draft = { parentId: parent, kind, title: "", owner: D.user?.name || "", status: kind === "story" ? "unconfirmed" : "running", summary: "", estimate: "", acs: "", body: "" };
    UI.render();
    requestAnimationFrame(() => document.getElementById("rmc-title")?.focus());
  };
  /* UI-CR073：右侧编辑面板保存 —— 写回同一份演示数据并刷新文档页签。 */
  actions["req-map-save"] = el => {
    const p = D.projects.find(project => project.id === activeProjectId());
    const data = p && window.RequirementsWorkspace.inventoryById(p.id);
    const node = data && data.all.find(item => item.id === el.dataset.id);
    const form = document.querySelector(".req-map-editor .req-map-editor-form");
    if (!node || !form) return;
    const read = name => form.querySelector(`[data-field="${name}"]`)?.value ?? "";
    const title = read("title").trim();
    if (!title) { UI.toast("标题不能为空"); return; }
    node.title = title;
    node.status = read("status") || node.status;
    node.owner = read("owner").trim();
    node.summary = read("summary").trim();
    node.estimate = read("estimate").trim();
    if (node.kind === "story" || node.kind === "bug") {
      const lines = read("acs").split("\n").map(line => line.trim()).filter(Boolean);
      node.acs = lines.map((line, i) => {
        const hit = /^(AC-[\w-]+)[：:]\s*(.*)$/.exec(line);
        return hit ? { id: hit[1], text: hit[2], state: (node.acs?.[i]?.state) || "pending" } : { id: `AC-${String(i + 1).padStart(2, "0")}`, text: line, state: (node.acs?.[i]?.state) || "pending" };
      });
    }
    const bodyText = read("body");
    if (node.body != null) node.body = bodyText; else if (node.content != null) node.content = bodyText; else node.markdown = bodyText;
    node.updated = "刚刚";
    UI.toast("已保存 " + node.id);
    UI.render();
  };
  actions["req-map-cancel"] = () => {
    /* 取消不改数据；重新渲染即丢弃面板内未保存输入。 */
    UI.render();
  };
  actions["req-map-draft-save"] = () => {
    const st = activeState();
    if (!st.draft) return;
    const form = document.querySelector(".req-map-editor .req-map-editor-form[data-create]");
    if (!form) return;
    const read = name => form.querySelector(`[data-field="${name}"]`)?.value ?? "";
    const title = read("title").trim();
    if (!title) { UI.toast("标题不能为空"); return; }
    const kind = st.draft.kind;
    /* 编号沿用现有 nextId 规则（见 main.js），在演示数据里追加实体。 */
    const prefix = kind === "epic" ? "EPIC-" : kind === "feature" ? "FEAT-" : "STORY-";
    const nums = D.requirements.filter(r => r.kind === kind).map(r => parseInt(String(r.id).replace(/\D+/g, ""), 10) || 0);
    let n = Math.max(0, ...nums) + 1;
    let id = prefix + String(n).padStart(kind === "epic" ? 2 : 3, "0");
    while (D.requirements.some(r => r.id === id)) { n++; id = prefix + String(n).padStart(kind === "epic" ? 2 : 3, "0"); }
    const acLines = kind === "story" ? read("acs").split("\n").map(line => line.trim()).filter(Boolean) : [];
    D.requirements.push({
      id, kind, project: activeProjectId(), parent: st.draft.parentId || undefined, title,
      summary: read("summary").trim(), owner: read("owner").trim(), estimate: read("estimate").trim(),
      status: read("status") || (kind === "story" ? "unconfirmed" : "running"),
      updated: "刚刚", deps: [], tests: "未执行", hash: "req 草稿 · design —",
      body: read("body"),
      acs: kind === "story" ? acLines.map((text, i) => ({ id: `AC-${String(i + 1).padStart(2, "0")}`, text, state: "pending" })) : undefined,
      cli: kind === "story" ? "claude" : undefined, model: kind === "story" ? "tierflow-lite" : undefined,
    });
    st.draft = null;
    st.selected = id;
    UI.toast("已创建 " + id + "：" + title);
    UI.render();
  };
  actions["req-map-draft-close"] = () => {
    activeState().draft = null;
    UI.render();
  };
  actions["req-map-open-doc"] = el => {
    const p = D.projects.find(project => project.id === activeProjectId());
    if (!p) return;
    window.RequirementsWorkspace.openNode(p.id, el.dataset.kind, el.dataset.id);
  };
  actions["req-map-open-model"] = el => {
    const p = D.projects.find(project => project.id === activeProjectId());
    const data = p && window.RequirementsWorkspace.inventoryById(p.id);
    const model = data && data.all.find(node => node.id === el.dataset.id && node.kind === "model");
    if (!model) { UI.toast("模型源未提供"); return; }
    UI.toast("模型文档：" + (model.relPath || model.id) + "（设计夹具，无真实文件读取）");
  };

  /** 目录定位后把画布滚动到目标节点。 */
  function locateSelected() {
    const st = activeState();
    if (!st.locate) return;
    const target = document.querySelector(`.req-map-node[data-node-id="${CSS.escape(st.locate)}"]`);
    const canvas = document.querySelector(".req-map-scroll");
    if (!target || !canvas) return;
    const scaled = target.closest(".req-map-scaled");
    const zoom = scaled && scaled.style.width ? parseFloat(scaled.style.width) / parseFloat(target.closest(".req-map-inner").style.width || "1") : 1;
    canvas.scrollTo({
      left: Math.max(0, target.offsetLeft * zoom - canvas.clientWidth / 2 + target.offsetWidth * zoom / 2),
      top: Math.max(0, target.offsetTop * zoom - canvas.clientHeight / 2 + target.offsetHeight * zoom / 2)
    });
    st.locate = null;
  }

  /* ---------- UI-CR073：画布拖拽平移与 Ctrl/⌘ + 滚轮缩放 ---------- */
  /* 只在画布空白处（未命中节点卡、折叠点、占位）开始平移，避免抢走节点点击。
     位移小于 PAN_THRESHOLD 视为点击，不改变选中与折叠状态。 */
  const PAN_THRESHOLD = 4;
  let pan = null;

  function interactiveTarget(el) {
    return Boolean(el.closest(".req-map-node, .req-map-foldpoint, .req-map-detail, a, input, textarea, select, .req-map-controls"));
  }
  function currentCanvas() { return document.querySelector(".req-workspace .req-map-scroll"); }

  document.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    const canvas = currentCanvas();
    if (!canvas || !canvas.contains(e.target)) return;
    if (interactiveTarget(e.target)) return;
    pan = {
      canvas,
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      left: canvas.scrollLeft,
      top: canvas.scrollTop,
      moved: false,
    };
    canvas.setPointerCapture?.(e.pointerId);
  }, true);

  document.addEventListener("pointermove", e => {
    if (!pan || pan.id !== e.pointerId) return;
    const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    if (!pan.moved && Math.abs(dx) < PAN_THRESHOLD && Math.abs(dy) < PAN_THRESHOLD) return;
    if (!pan.moved) { pan.moved = true; pan.canvas.classList.add("is-panning"); }
    pan.canvas.scrollLeft = pan.left - dx;
    pan.canvas.scrollTop = pan.top - dy;
    /* 平移同步到阅读状态，切换模式回来保持位置。 */
    const ws = window.RequirementsWorkspace.getState(activeProjectId());
    if (ws) ws.mapScroll = [pan.canvas.scrollLeft, pan.canvas.scrollTop];
  }, true);

  function endPan(e) {
    if (!pan || (e && pan.id !== e.pointerId)) return;
    const canvas = pan.canvas;
    if (pan.moved) {
      canvas.classList.remove("is-panning");
      /* 平移结束后的点击不应再触发节点选中。 */
      canvas.addEventListener("click", swallow, { capture: true, once: true });
    }
    try { if (canvas.hasPointerCapture?.(pan.id)) canvas.releasePointerCapture(pan.id); } catch (_) { /* 已释放 */ }
    pan = null;
  }
  function swallow(e) { e.stopPropagation(); e.preventDefault(); }
  document.addEventListener("pointerup", endPan, true);
  document.addEventListener("pointercancel", endPan, true);

  /* Ctrl／⌘ + 滚轮：以画布中心为锚点缩放；不按修饰键保持原生纵向滚动。 */
  document.addEventListener("wheel", e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const canvas = currentCanvas();
    if (!canvas || !canvas.contains(e.target)) return;
    e.preventDefault();
    const s = window.RequirementsWorkspace.getState(activeProjectId());
    if (!s) return;
    const before = s.mapZoom || 1;
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    const next = Math.max(0.5, Math.min(1.8, Math.round((before + delta) * 10) / 10));
    if (next === before) return;
    /* 记录指针相对内容的比例位置，缩放后回滚到同一处。 */
    const rect = canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) / Math.max(1, rect.width);
    const py = (e.clientY - rect.top) / Math.max(1, rect.height);
    const scrollX = canvas.scrollLeft, scrollY = canvas.scrollTop;
    s.mapZoom = next;
    s.mapScroll = [0, 0];
    UI.render();
    requestAnimationFrame(() => {
      const after = currentCanvas();
      if (!after) return;
      after.scrollLeft = (scrollX + px * rect.width) * (next / before) - px * rect.width;
      after.scrollTop = (scrollY + py * rect.height) * (next / before) - py * rect.height;
      s.mapScroll = [after.scrollLeft, after.scrollTop];
    });
  }, { capture: true, passive: false });

  window.RequirementsMindmap = Object.freeze({
    version: "UI-CR073-r1",
    mapHtml,
    outlineHtml,
    locateSelected
  });
})();
