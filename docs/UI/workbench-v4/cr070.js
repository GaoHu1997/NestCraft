/* CR-070：图标悬浮层（原型演示）。项目/知识库卡片图标砖点击后弹出悬浮层，
   10 色卡一行 + 50 图标 6 组网格 + 默认项；选择即时预览，保存成对写入。
   不接真实业务；关闭方式：关闭按钮、遮罩按下、Escape（视为取消，不落库）。 */
window.CR070 = (() => {
  "use strict";
  const { D, store, esc, icon, toast, ICON_GROUPS, ICON_COLORS, ICON_COLOR_LABELS } = UI;
  const projTile = UI.projTile;
  const kbTile = (lib, extra) => {
    const pair = UI.iconColorPair(lib.iconColor) || UI.iconColorPair("teal");
    return `<span class="kb-icon" style="background:${pair[0]};color:${pair[1]}" ${extra || ""}>${icon(UI.kbIconId(lib, null) || "library", "ico-20")}</span>`;
  };
  const iconLabel = id => ICON_COLOR_LABELS[id] || id;

  /* 当前打开的悬浮层状态：{ kind:'project'|'kb', id, value, color }。 */
  let draft = null;

  function previewPair(color) { return UI.iconColorPair(color) || UI.iconColorPair("teal"); }

  function defaultIcon() {
    if (draft.kind === "project") {
      const p = D.projects.find(x => x.id === draft.id);
      return p && p.kind === "work" ? "briefcase" : "code";
    }
    return "library";
  }
  function currentIcon() { return draft.value || defaultIcon(); }
  function currentColor() { return draft.color || "teal"; }

  function render() {
    const isProject = draft.kind === "project";
    const target = isProject
      ? D.projects.find(x => x.id === draft.id)
      : D.knowledge.libraries.find(x => x.id === draft.id);
    if (!target) { close(); return; }
    const preview = isProject
      ? projTile({ icon: draft.value || null, iconColor: draft.color || null, kind: target.kind }, "", "ico-20")
      : (() => { const [bg, fg] = previewPair(draft.color || null); return `<span class="kb-icon" style="background:${bg};color:${fg}">${icon(currentIcon(), "ico-20")}</span>`; })();
    const picker = ICON_GROUPS.map(g => `<div class="picker-group"><div class="picker-group-h"><b>${esc(g.name)}</b><span>${esc(g.hint)}</span></div>
      <div class="picker-group-grid">${g.icons.map(ic => `<button type="button" class="picker-cell" aria-pressed="${currentIcon() === ic}" data-c070-act="icon" data-id="${ic}" title="${ic}">${icon(ic, "ico-20")}<span class="picker-name">${ic}</span></button>`).join("")}</div></div>`).join("");
    const swatches = ICON_COLORS.map(sw => `<button type="button" class="swatch" style="background:var(--c51c-${esc(sw.id)}-strong)" aria-pressed="${currentColor() === sw.id}" aria-label="背景色 ${esc(iconLabel(sw.id))}" data-c070-act="color" data-id="${esc(sw.id)}" title=" "></button>`).join("");
    const mask = document.getElementById("icon-pop-mask") || document.createElement("div");
    mask.id = "icon-pop-mask";
    mask.className = "icon-pop-mask";
    mask.innerHTML = `<div class="icon-pop" role="dialog" aria-modal="true" aria-label="选择图标与颜色">
      <div class="icon-pop-h"><b>${esc(target.name)}</b><button class="icon-btn" type="button" data-c070-act="close" aria-label="关闭">${icon("x", "ico-14")}</button></div>
      <div class="icon-pop-b">
        <div class="icon-pop-current" style="margin-bottom:12px">${preview}<span class="caption">${isProject ? "点击下方图标或色卡即时预览；保存后卡片、侧栏与授权弹窗同步。" : "点击下方图标或色卡即时预览；清空回来源默认，背景回默认青绿。"}</span></div>
        <div class="icon-pop-sec">选择颜色</div>
        <div class="swatches" role="group" aria-label="背景色（10 选 1）">${swatches}<button type="button" class="swatch swatch-clear" aria-pressed="${!draft.color}" aria-label="背景色回默认" data-c070-act="color-clear" title="背景色回默认">${icon("undo", "ico-14")}</button></div>
        <div class="icon-pop-sec">选择图标</div>
        <div class="picker" role="group" aria-label="图标选择（50 选 1）" style="display:grid;gap:10px">${picker}<button type="button" class="picker-cell picker-clear" aria-pressed="${!draft.value}" data-c070-act="icon-clear" title="清空回默认图标">${icon("x", "ico-14")}<span class="picker-name">默认</span></button></div>
      </div>
      <div class="icon-pop-f"><span class="caption">保存才生效；取消不改动。</span><button class="btn" type="button" data-c070-act="close">取消</button><button class="btn primary" type="button" data-c070-act="save">保存</button></div>
    </div>`;
    if (!mask.isConnected) document.body.appendChild(mask);
  }

  function open(kind, id) {
    const target = kind === "project"
      ? D.projects.find(x => x.id === id)
      : D.knowledge.libraries.find(x => x.id === id);
    if (!target) return;
    draft = { kind, id, value: target.icon || "", color: target.iconColor || "" };
    render();
    document.querySelector(".icon-pop button")?.focus();
  }
  function close() {
    draft = null;
    document.getElementById("icon-pop-mask")?.remove();
  }

  document.addEventListener("click", e => {
    const trigger = e.target.closest("[data-c070-open]");
    if (trigger) {
      e.preventDefault(); e.stopPropagation();
      open(trigger.dataset.c070Kind, trigger.dataset.c070Open);
      return;
    }
    if (!draft) return;
    const act = e.target.closest("[data-c070-act]");
    if (!act) {
      if (!e.target.closest(".icon-pop")) close();
      return;
    }
    e.preventDefault(); e.stopPropagation();
    const a = act.dataset.c070Act;
    if (a === "close") { close(); return; }
    if (a === "icon") { draft.value = act.dataset.id; render(); return; }
    if (a === "icon-clear") { draft.value = ""; render(); return; }
    if (a === "color") { draft.color = act.dataset.id; render(); return; }
    if (a === "color-clear") { draft.color = ""; render(); return; }
    if (a === "save") {
      const isProject = draft.kind === "project";
      const target = isProject
        ? D.projects.find(x => x.id === draft.id)
        : D.knowledge.libraries.find(x => x.id === draft.id);
      if (target) {
        target.icon = draft.value || undefined;
        target.iconColor = draft.color || undefined;
        toast((isProject ? "项目图标已保存" : "知识库图标已保存") + (draft.value ? "：" + draft.value : "（回默认图标）"));
      }
      close();
      UI.render();
    }
  }, true);

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && draft) { close(); e.stopPropagation(); }
  }, true);

  return { open, close, version: "UI-CR070-v1" };
})();
