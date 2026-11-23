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

  const states = new Map();
  function stateOf(projectId) {
    if (!states.has(projectId)) states.set(projectId, { selected: null, collapsed: new Set(), locate: null });
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
    return `<aside class="req-map-detail" role="dialog" aria-label="${esc(node.title || node.id)}详情">
      <header class="req-map-detail-head">
        <span class="req-kind ${esc(node.kind)}">${esc(KIND_LABEL[node.kind] || node.kind)}</span>
        <b>${esc(node.id)}</b>
        <button class="icon-btn" data-act="req-map-detail-close" aria-label="关闭详情">${icon("x", "ico-14")}</button>
      </header>
      <div class="req-map-detail-scroll">
        <h3>${esc(node.title || node.id)}</h3>
        <dl class="req-map-detail-meta">
          <dt>状态</dt><dd>${esc(status)}</dd>
          <dt>负责人</dt><dd>${esc(node.owner || "未提供")}</dd>
          ${node.kind === "model" ? `<dt>关联</dt><dd>项目级独立分支，不作为 Story 的第二父项</dd><dt>来源</dt><dd>${esc(node.relPath || "未提供")}</dd>` : `<dt>工作量</dt><dd>${esc(node.estimate || "未提供")}</dd><dt>更新</dt><dd>${esc(node.updated || "未提供")}</dd>`}
        </dl>
        ${node.summary ? `<p class="req-map-detail-summary">${esc(node.summary)}</p>` : `<p class="req-map-detail-summary muted">源未提供摘要；不生成虚构正文。</p>`}
        ${acs.length ? `<h4>可观察验收</h4><div class="req-map-detail-acs">${acs.map(ac => `<div class="req-ac"><b>${esc(ac.id)}</b><p>${esc(ac.text || "验收正文未提供")}</p></div>`).join("")}</div>` : `<p class="req-map-detail-summary muted">当前实体没有验收条目。</p>`}
      </div>
      <footer class="req-map-detail-foot">
        ${node.kind === "model"
          ? `<button class="btn sm" data-act="req-map-open-model" data-id="${esc(node.id)}">${icon("database", "ico-14")}打开模型文档</button>`
          : `<button class="btn sm" data-act="req-map-open-doc" data-id="${esc(node.id)}" data-kind="${esc(node.kind)}">${icon("fileText", "ico-14")}在文档中打开</button><button class="btn sm" data-act="req-edit" data-id="${esc(node.id)}">${icon("edit", "ico-14")}编辑</button>`}
      </footer>
    </aside>`;
  }

  /** 导图主区：整块是画布 + 右侧悬浮详情框，不再是「上导图、下正文」。 */
  function mapHtml(p, s, data) {
    const st = stateOf(p.id);
    const zoom = s.mapZoom || 1;
    const graph = layout(data.vision, node => childrenOf(data, node, st.collapsed));
    const selected = data.all.find(node => node.id === st.selected) ?? null;
    const selectedVisible = selected && graph.nodes.some(node => node.id === selected.id) ? selected : null;
    const paths = graph.edges.map(edge => `<path class="req-map-edge${edge.to.kind === "model" ? " dashed" : ""}" d="${edgePath(edge.from, edge.to)}"/>`).join("");
    const folds = graph.nodes.map(node => foldHtml(node, data, st)).join("");
    return `<section class="req-map-area" data-mode="map">
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
        <button class="btn sm" data-act="req-map-add" data-id="${esc(data.vision.id)}" data-kind="epic">${icon("plus", "ico-14")}新增 Epic</button>
      </div>
      <div class="req-map-stage">
        <div class="req-map-scroll"><div class="req-map-scaled" style="width:${Math.round(graph.width * zoom)}px;height:${Math.round(graph.height * zoom)}px">
          <div class="req-map-inner" style="width:${graph.width}px;height:${graph.height}px">
            <svg class="req-map-edges" width="${graph.width}" height="${graph.height}" aria-hidden="true">${paths}</svg>
            ${graph.nodes.map(node => nodeHtml(node, data, st)).join("")}
            ${folds}
          </div>
        </div></div>
        ${selectedVisible ? detailHtml(selectedVisible) : ""}
      </div>
      <div class="req-map-help">整块为思维导图：Vision 连接 Epic、Epic 连接 Feature、Feature 连接 Story；点击节点在右侧悬浮框查看内容，左侧「导图目录」可定位节点，节点上可直接新增下级。</div>
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
    const st = stateOf(store.projectId);
    st.selected = el.dataset.id;
    st.locate = null;
    UI.render();
  };
  actions["req-map-detail-close"] = () => { stateOf(store.projectId).selected = null; UI.render(); };
  actions["req-map-fit"] = () => { fitToView(store.projectId); UI.render(); };
  actions["req-map-locate"] = el => {
    const st = stateOf(store.projectId);
    st.selected = el.dataset.id;
    st.locate = el.dataset.id;
    UI.render();
  };
  actions["req-map-fold"] = el => {
    const st = stateOf(store.projectId);
    const id = el.dataset.id;
    st.collapsed.has(id) ? st.collapsed.delete(id) : st.collapsed.add(id);
    UI.render();
  };
  actions["req-map-all"] = el => {
    const st = stateOf(store.projectId);
    const p = D.projects.find(project => project.id === store.projectId);
    const data = p && window.RequirementsWorkspace.inventoryById(p.id);
    if (!data) return;
    st.collapsed = new Set(el.dataset.collapse === "true" ? data.all.filter(node => node.kind !== "vision").map(node => node.id) : []);
    UI.render();
  };
  actions["req-map-add"] = el => {
    const kind = el.dataset.kind || "epic";
    const parent = el.dataset.id || "";
    const p = D.projects.find(project => project.id === store.projectId);
    const data = p && window.RequirementsWorkspace.inventoryById(p.id);
    /* 合成情景愿景不是真实来源，不在其下新增条目，避免把演示节点当真实父项。 */
    if (data && data.vision.scenario && parent === data.vision.id) { UI.toast("情景愿景不是真实来源，不能在其下新增需求"); return; }
    store.reqMenu = null;
    window.Screens.reqFormModal("new", "", parent, kind);
  };
  actions["req-map-open-doc"] = el => {
    const p = D.projects.find(project => project.id === store.projectId);
    if (!p) return;
    window.RequirementsWorkspace.openNode(p.id, el.dataset.kind, el.dataset.id);
  };
  actions["req-map-open-model"] = el => {
    const p = D.projects.find(project => project.id === store.projectId);
    const data = p && window.RequirementsWorkspace.inventoryById(p.id);
    const model = data && data.all.find(node => node.id === el.dataset.id && node.kind === "model");
    if (!model) { UI.toast("模型源未提供"); return; }
    UI.toast("模型文档：" + (model.relPath || model.id) + "（设计夹具，无真实文件读取）");
  };

  /** 目录定位后把画布滚动到目标节点。 */
  function locateSelected() {
    const st = stateOf(store.projectId);
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

  window.RequirementsMindmap = Object.freeze({
    version: "UI-CR066-v1",
    mapHtml,
    outlineHtml,
    locateSelected
  });
})();
