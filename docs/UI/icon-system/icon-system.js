/* CR-051 v4 设计稿交互：主题、图标库、色卡、头像字段与更换弹窗、树折叠、滚动条。
   仅演示：图片只在本页内存与 canvas 预览，不写磁盘、不联网、不调用真实服务。 */
(function () {
  "use strict";

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const LOGO = "../brand-assets-v2/logo-sail.png";

  const STYLE_NAMES = {
    a: "A · 原彩透明",
    b: "B · 薄荷承载（默认）",
    c: "C · 圆角方砖",
    d: "D · 墨青实底",
    e: "E · 双色光环"
  };

  const SWATCHES = [
    { id: "blue", soft: "#eaf1ff", strong: "#2b6cf6", darkSoft: "#1e2a44", darkStrong: "#8db3ff" },
    { id: "teal", soft: "#e8f7f3", strong: "#0b7d70", darkSoft: "#17302b", darkStrong: "#4fd1c5" },
    { id: "violet", soft: "#f0edfd", strong: "#6f5bd6", darkSoft: "#262238", darkStrong: "#b9a8ff" },
    { id: "amber", soft: "#fff4e2", strong: "#b76a00", darkSoft: "#2b2416", darkStrong: "#e0a04a" },
    { id: "green", soft: "#e7f8ef", strong: "#1a9d5a", darkSoft: "#16281d", darkStrong: "#4ccb83" },
    { id: "rose", soft: "#fdeef1", strong: "#c2345a", darkSoft: "#331a20", darkStrong: "#ff9ab0" },
    { id: "indigo", soft: "#eef0ff", strong: "#4356c9", darkSoft: "#1e2144", darkStrong: "#97a3ff" },
    { id: "orange", soft: "#fff0e6", strong: "#c2410c", darkSoft: "#331b12", darkStrong: "#f0906a" },
    { id: "slate", soft: "#eef1f5", strong: "#52627a", darkSoft: "#242a33", darkStrong: "#a7b6c8" },
    { id: "sand", soft: "#f8f1e3", strong: "#8a6420", darkSoft: "#2b2519", darkStrong: "#d8b06a" }
  ];

  const PROJECT_GROUPS = [
    { name: "通用", hint: "类型 / 技术 / 资料 / 目标", icons: ["code", "terminal", "globe", "database", "layers", "box", "wrench", "gauge", "bulb", "target", "sparkles", "book", "bookOpen", "library", "shield", "users"] },
    { name: "办公", hint: "组织 / 计划 / 沟通", icons: ["briefcase", "building", "calendar", "clipboard", "presentation", "mail", "idBadge"] },
    { name: "商业", hint: "数据 / 财务 / 经营", icons: ["chartBar", "chartLine", "chartPie", "wallet", "receipt", "cart", "tag", "scale"] },
    { name: "内容", hint: "市场 / 媒体 / 创作", icons: ["megaphone", "camera", "music", "video", "mic", "newspaper", "pen", "brush"] },
    { name: "产品", hint: "研发 / 上线 / 探索", icons: ["rocket", "bug", "puzzle", "flag", "compass", "flask", "robot", "cloud"] },
    { name: "生活", hint: "学习 / 收藏 / 关怀", icons: ["school", "heart", "star"] }
  ];

  const NEW_ICONS = ["fileMarkdown", "fileHtml", "fileAudio", "fileVideo", "fileUnknown", "briefcase", "library", "building", "calendar", "clipboard", "presentation", "mail", "idBadge", "chartBar", "chartLine", "chartPie", "wallet", "receipt", "cart", "tag", "scale", "megaphone", "camera", "music", "video", "mic", "newspaper", "pen", "brush", "rocket", "bug", "puzzle", "flag", "compass", "flask", "robot", "cloud", "school", "heart", "star"];
  const REUSE_ICONS = ["folder", "folderOpen", "file", "fileText", "filePdf", "fileWord", "fileSheet", "csv", "fileSlides", "fileCode", "fileArchive", "image", "book", "bookOpen", "globe", "layers", "code", "terminal", "database", "box", "wrench", "gauge", "bulb", "target", "sparkles", "shield"];

  const state = {
    theme: "light",
    avatarStyle: "b",
    photo: null,
    zoom: 100,
    project: { icon: "code", swatch: "blue" },
    kb: { icon: "bookOpen", swatch: "teal" }
  };
  let draft = null;

  const swatchById = id => SWATCHES.find(s => s.id === id) || SWATCHES[0];

  /* ---------- 图标网格 ---------- */
  function iconButton(id, attrs) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "icon-cell";
    b.title = id;
    b.setAttribute("aria-label", "图标 " + id);
    b.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#' + id + '"/></svg><code>' + id + "</code>";
    Object.keys(attrs || {}).forEach(k => b.setAttribute(k, attrs[k]));
    return b;
  }
  function fillGrid(sel, ids) {
    const host = $(sel);
    if (!host) return;
    ids.forEach(id => host.appendChild(iconButton(id)));
  }
  function fillGroups(host, groups, dataName, onPick) {
    groups.forEach(g => {
      const box = document.createElement("div");
      box.className = "icon-group";
      const head = document.createElement("div");
      head.className = "icon-group-h";
      head.innerHTML = "<b>" + g.name + "</b><span>" + (g.hint || "") + " · " + g.icons.length + "</span>";
      const grid = document.createElement("div");
      grid.className = "icon-grid";
      g.icons.forEach(id => {
        const bnd = iconButton(id, { [dataName]: id, "aria-pressed": "false" });
        bnd.addEventListener("click", () => onPick(id));
        grid.appendChild(bnd);
      });
      box.appendChild(head);
      box.appendChild(grid);
      host.appendChild(box);
    });
  }

  fillGrid("#icon-new-grid", NEW_ICONS);
  fillGrid("#icon-reuse-grid", REUSE_ICONS);
  const projectOverview = $("#icon-project-grid");
  if (projectOverview) {
    PROJECT_GROUPS.forEach(g => {
      const block = document.createElement("div");
      block.innerHTML = '<div class="group-h"><b>' + g.name + "</b><span>" + (g.hint || "") + "</span></div>";
      const grid = document.createElement("div");
      grid.className = "icon-grid";
      g.icons.forEach(id => grid.appendChild(iconButton(id)));
      block.appendChild(grid);
      projectOverview.appendChild(block);
    });
  }

  /* ---------- 项目 / 知识库图标 + 色卡 ---------- */
  function paint(tile, sw) {
    if (!tile) return;
    const dark = state.theme === "dark";
    tile.style.background = dark ? sw.darkSoft : sw.soft;
    tile.style.color = dark ? sw.darkStrong : sw.strong;
  }
  function applyProject() {
    const sw = swatchById(state.project.swatch);
    [$("[data-project-tile]")].forEach(t => {
      if (!t) return;
      paint(t, sw);
      const use = t.querySelector("use");
      if (use) use.setAttribute("href", "#" + state.project.icon);
    });
    const comboTile = $("[data-combo-tile]");
    if (comboTile) {
      paint(comboTile, sw);
      const use = comboTile.querySelector("use");
      if (use) use.setAttribute("href", "#" + state.project.icon);
    }
    const text = $("#project-combo-text");
    if (text) text.textContent = state.project.icon;
    $$("#project-icon-picker [data-project-icon]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.projectIcon === state.project.icon)));
    $$("#project-swatches [data-swatch]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.swatch === state.project.swatch)));
  }
  function applyKb() {
    const sw = swatchById(state.kb.swatch);
    const tile = $("[data-kb-tile]");
    if (tile) {
      paint(tile, sw);
      const use = tile.querySelector("use");
      if (use) use.setAttribute("href", "#" + state.kb.icon);
    }
    const comboTile = $("[data-combo-kb]");
    if (comboTile) {
      paint(comboTile, sw);
      const use = comboTile.querySelector("use");
      if (use) use.setAttribute("href", "#" + state.kb.icon);
    }
    const text = $("#kb-combo-text");
    if (text) text.textContent = state.kb.icon;
    $$("#kb-icon-picker [data-kb-icon]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.kbIcon === state.kb.icon)));
    $$("#kb-swatches [data-swatch]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.swatch === state.kb.swatch)));
  }

  const projectPicker = $("#project-icon-picker");
  if (projectPicker) {
    fillGroups(projectPicker, PROJECT_GROUPS, "data-project-icon", id => {
      state.project.icon = id;
      applyProject();
    });
    $$("[data-project-icon]", projectPicker).forEach(b => b.setAttribute("aria-pressed", String(b.dataset.projectIcon === state.project.icon)));
  }
  const kbPicker = $("#kb-icon-picker");
  if (kbPicker) {
    fillGroups(kbPicker, PROJECT_GROUPS, "data-kb-icon", id => {
      state.kb.icon = id;
      applyKb();
    });
    $$("[data-kb-icon]", kbPicker).forEach(b => b.setAttribute("aria-pressed", String(b.dataset.kbIcon === state.kb.icon)));
  }

  function renderSwatches(sel, group, onPick) {
    const host = $(sel);
    if (!host) return;
    SWATCHES.forEach(sw => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch";
      b.dataset.swatch = sw.id;
      b.setAttribute("aria-pressed", String((group === "project" ? state.project.swatch : state.kb.swatch) === sw.id));
      b.setAttribute("aria-label", "背景色 " + sw.id);
      b.dataset.swatchId = sw.id;
      b.style.setProperty("--sw", state.theme === "dark" ? sw.darkStrong : sw.strong);
      b.addEventListener("click", () => {
        if (group === "project") state.project.swatch = sw.id;
        else state.kb.swatch = sw.id;
        onPick();
      });
      host.appendChild(b);
    });
  }
  renderSwatches("#project-swatches", "project", applyProject);
  renderSwatches("#kb-swatches", "kb", applyKb);

  /* ---------- 主题 ---------- */
  const themeBtn = $("#theme-toggle");
  const themeLabel = $("#theme-label");
  function setTheme(theme) {
    state.theme = theme;
    document.documentElement.dataset.theme = theme;
    const dark = theme === "dark";
    if (themeLabel) themeLabel.textContent = dark ? "浅色预览" : "深色预览";
    if (themeBtn) themeBtn.querySelector("use").setAttribute("href", dark ? "#sun" : "#moon");
    applyProject();
    applyKb();
    repaintSwatches();
  }
  function repaintSwatches() {
    $$("#project-swatches .swatch, #kb-swatches .swatch").forEach(b => {
      const sw = SWATCHES.find(s => s.id === b.dataset.swatch);
      if (sw) b.style.setProperty("--sw", state.theme === "dark" ? sw.darkStrong : sw.strong);
    });
  }
  if (themeBtn) themeBtn.addEventListener("click", () => setTheme(state.theme === "dark" ? "light" : "dark"));

  /* ---------- 头像：外观与页面同步 ---------- */
  const AVATAR_SKINS = {
    a: { bg: "transparent", border: "0", radius: "50%", filter: "none", shadow: "none", img: "88%" },
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
      img.style.objectFit = "cover";
    }
  }

  function applyAvatarDom() {
    document.body.dataset.avatarStyle = state.avatarStyle;
    $$("[data-user-avatar]").forEach(av => {
      const img = av.querySelector("img");
      if (!img) return;
      img.src = state.photo || LOGO;
      av.classList.toggle("has-photo", Boolean(state.photo));
      const frame = av.closest(".avatar-frame");
      const styleId = frame ? state.avatarStyle : state.avatarStyle;
      styleAvatarEl(av, styleId, Boolean(state.photo));
    });
    const label = $("#current-style-label");
    if (label) label.textContent = STYLE_NAMES[state.avatarStyle];
    $$("[data-style-btn]").forEach(b => {
      const on = b.dataset.styleBtn === state.avatarStyle;
      b.setAttribute("aria-pressed", String(on));
      b.setAttribute("aria-checked", String(on));
    });
    $$("[data-style-radio]").forEach(b => {
      const on = b.dataset.styleRadio === state.avatarStyle;
      b.setAttribute("aria-checked", String(on));
      b.setAttribute("aria-pressed", String(on));
    });
  }

  function setAvatarStyle(style) {
    if (!STYLE_NAMES[style]) return;
    state.avatarStyle = style;
    applyAvatarDom();
  }
  $$("[data-style-btn]").forEach(b => b.addEventListener("click", () => setAvatarStyle(b.dataset.styleBtn)));
  $$("[data-style-radio]").forEach(b => b.addEventListener("click", () => setAvatarStyle(b.dataset.styleRadio)));

  /* ---------- 更换头像弹窗 ---------- */
  const modal = $("#avatar-modal");
  const presets = $("#avatar-presets");
  const cropBox = $("#avatar-crop");
  const cropImg = $("#avatar-crop-img");
  const zoomInput = $("#avatar-zoom");
  const zoomValue = $("#avatar-zoom-value");
  const fileName = $("#avatar-file-name");
  const fileInput = $("#avatar-file");
  const errorBox = $("#avatar-error");
  const draftPreview = $("#avatar-draft-preview");
  const draftNote = $("#avatar-draft-note");

  function showError(msg) {
    if (!errorBox) return;
    errorBox.textContent = msg;
    errorBox.hidden = false;
  }
  function clearError() {
    if (errorBox) errorBox.hidden = true;
  }

  function renderPresets() {
    $$("#avatar-presets [data-preset]").forEach(b => {
      const id = b.dataset.preset;
      const selected = id === "custom" ? draft.mode === "custom" : draft.mode === "builtin" && draft.style === id;
      b.setAttribute("aria-pressed", String(selected));
      if (id === "custom") {
        b.innerHTML = draft.photo
          ? '<span class="avatar has-photo"><img src="' + draft.photo + '" alt=""></span><span>自定义</span>'
          : '<span class="plus"><svg class="ico ico-14"><use href="#camera"/></svg></span><span>自定义</span>';
        const photo = b.querySelector(".avatar");
        if (photo) styleAvatarEl(photo, draft.style, true);
      } else {
        const av = b.querySelector(".avatar");
        if (av) styleAvatarEl(av, id, false);
      }
    });
  }

  function renderDraft() {
    renderPresets();
    const hasPhoto = draft.mode === "custom" && Boolean(draft.photo);
    const img = draftPreview.querySelector("img");
    if (img) img.src = hasPhoto ? draft.photo : LOGO;
    draftPreview.hidden = hasPhoto;
    draftPreview.classList.toggle("has-photo", hasPhoto);
    styleAvatarEl(draftPreview, draft.style, hasPhoto);
    const canvas = $("#avatar-preview-canvas");
    if (canvas) {
      canvas.hidden = !hasPhoto;
      canvas.classList.toggle("square", draft.style === "c");
    }
    draftNote.textContent = hasPhoto ? "自定义图片 · 容器 " + draft.style.toUpperCase() : STYLE_NAMES[draft.style];

    // 裁剪区常驻：内置样式显示 Logo 预览；自定义显示照片或占位
    const stage = $("#avatar-crop-stage");
    const empty = $("#avatar-crop-empty");
    const hint = $("#avatar-crop-hint");
    const repick = $("#avatar-repick");
    const cropWrap = $("#avatar-crop");
    const noPhotoCustom = draft.mode === "custom" && !draft.photo;
    if (stage) stage.hidden = noPhotoCustom;
    if (empty) empty.hidden = !noPhotoCustom;
    if (cropWrap) cropWrap.classList.toggle("is-disabled", !hasPhoto);
    if (zoomInput) {
      zoomInput.disabled = !hasPhoto;
      zoomInput.value = String(draft.zoom);
    }
    if (zoomValue) zoomValue.textContent = draft.zoom + "%";
    if (hint) {
      hint.textContent = hasPhoto
        ? "拖动图片调整位置；框内就是最终显示区域，框外不会出现在头像里。"
        : draft.mode === "builtin"
          ? "内置样式使用品牌 Logo，无需裁剪；切换「自定义」可上传图片并调整。"
          : "上传图片后可在这里拖动调整。";
    }
    if (repick) repick.textContent = hasPhoto ? "重新选择" : "选择图片";
    const mask = $("#avatar-crop-mask");
    if (mask) mask.classList.toggle("square", draft.style === "c");

    if (hasPhoto) {
      if (cropImg && cropImg.getAttribute("src") !== draft.photo) cropImg.src = draft.photo;
      if (draft.natural) {
        layoutCrop();
        drawPreview();
      }
    } else if (cropImg) {
      cropImg.src = LOGO;
      cropImg.style.width = "150px";
      cropImg.style.height = "150px";
      cropImg.style.objectFit = "contain";
      cropImg.style.transform = "translate(-50%, -50%)";
      draft.scale = 1;
    }
  }

  function openAvatarModal() {
    draft = { style: state.avatarStyle, photo: state.photo, zoom: state.zoom, offset: { x: 0, y: 0 }, natural: null, scale: 1, mode: state.photo ? "custom" : "builtin" };
    clearError();
    if (fileInput) fileInput.value = "";
    if (fileName) fileName.textContent = state.photo ? "已选择图片" : "未选择文件";
    renderDraft();
    if (draft.photo) loadNatural(draft.photo);
    modal.hidden = false;
    const closeBtn = $("#avatar-modal-close");
    if (closeBtn) closeBtn.focus();
  }
  function closeAvatarModal() {
    modal.hidden = true;
    draft = null;
  }

  ["#avatar-edit", "#avatar-open", "#avatar-open-2", "#avatar-open-settings"].forEach(sel => {
    const el = $(sel);
    if (el) el.addEventListener("click", openAvatarModal);
  });
  ["#avatar-modal-close", "#avatar-cancel"].forEach(sel => {
    const el = $(sel);
    if (el) el.addEventListener("click", closeAvatarModal);
  });
  if (modal) {
    modal.addEventListener("click", e => {
      if (e.target === modal) closeAvatarModal();
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && !modal.hidden) closeAvatarModal();
    });
  }

  if (presets) {
    presets.addEventListener("click", e => {
      const b = e.target.closest("[data-preset]");
      if (!b || !draft) return;
      clearError();
      const id = b.dataset.preset;
      if (id === "custom") {
        draft.mode = "custom";
        renderDraft();
        if (fileInput) fileInput.click();
      } else {
        draft.mode = "builtin";
        draft.style = id;
        draft.photo = null;
        if (fileName) fileName.textContent = "未选择文件";
        if (cropBox) cropBox.hidden = true;
        renderDraft();
      }
    });
  }

  if (zoomInput) {
    zoomInput.addEventListener("input", () => {
      if (!draft || draft.mode !== "custom" || !draft.photo) return;
      draft.zoom = Number(zoomInput.value);
      if (zoomValue) zoomValue.textContent = draft.zoom + "%";
      layoutCrop();
      drawPreview();
    });
  }

  const pickFile = () => {
    if (!fileInput) return;
    clearError();
    fileInput.click();
  };
  $("#avatar-repick")?.addEventListener("click", pickFile);

  if (fileInput) {
    fileInput.addEventListener("change", () => {
      if (!draft) return;
      clearError();
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
        showError("不支持的文件类型。请选择 PNG、JPG 或 WebP 图片；当前头像保持不变。");
        fileInput.value = "";
        return;
      }
      if (file.size > 200 * 1024) {
        showError("图片超过 200KB。请压缩后再上传；当前头像保持不变。");
        fileInput.value = "";
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => showError("读取图片失败，当前头像保持不变。请重试或选择其他文件。");
      reader.onload = () => {
        draft.mode = "custom";
        draft.photo = String(reader.result);
        draft.zoom = 100;
        draft.offset = { x: 0, y: 0 };
        draft.natural = null;
        if (fileName) fileName.textContent = file.name + " · " + Math.max(1, Math.round(file.size / 1024)) + "KB";
        renderDraft();
        loadNatural(draft.photo);
      };
      reader.readAsDataURL(file);
    });
  }

  const resetBtn = $("#avatar-reset");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      if (!draft) return;
      clearError();
      draft.mode = "builtin";
      draft.style = "b";
      draft.photo = null;
      draft.zoom = 100;
      draft.offset = { x: 0, y: 0 };
      draft.natural = null;
      if (fileInput) fileInput.value = "";
      if (fileName) fileName.textContent = "未选择文件";
      renderDraft();
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("图片无法解码"));
      img.src = src;
    });
  }

  const FRAME = 200;

  async function loadNatural(src) {
    try {
      const img = await loadImage(src);
      if (!draft || draft.photo !== src) return;
      draft.natural = { w: img.naturalWidth, h: img.naturalHeight };
      layoutCrop();
      drawPreview();
    } catch (err) {
      showError("图片无法解码，请重新选择；当前头像保持不变。");
    }
  }

  function layoutCrop() {
    if (!draft || !draft.natural || !cropImg) return;
    const n = draft.natural;
    const scale = Math.max(FRAME / n.w, FRAME / n.h) * (draft.zoom / 100);
    const W = n.w * scale, H = n.h * scale;
    const limX = Math.max(0, (W - FRAME) / 2), limY = Math.max(0, (H - FRAME) / 2);
    draft.offset.x = Math.max(-limX, Math.min(limX, draft.offset.x));
    draft.offset.y = Math.max(-limY, Math.min(limY, draft.offset.y));
    draft.scale = scale;
    cropImg.style.width = W + "px";
    cropImg.style.height = H + "px";
    cropImg.style.transform = "translate(-50%,-50%) translate(" + draft.offset.x + "px," + draft.offset.y + "px)";
    const mask = $("#avatar-crop-mask");
    if (mask) mask.classList.toggle("square", draft.style === "c");
  }

  function drawPreview() {
    if (!draft || !draft.natural || !draft.photo) return;
    const canvas = $("#avatar-preview-canvas");
    const n = draft.natural;
    const scale = draft.scale || Math.max(FRAME / n.w, FRAME / n.h);
    const W = n.w * scale, H = n.h * scale;
    const sx = ((W - FRAME) / 2 - draft.offset.x) / scale;
    const sy = ((H - FRAME) / 2 - draft.offset.y) / scale;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(cropImg, sx, sy, FRAME / scale, FRAME / scale, 0, 0, canvas.width, canvas.height);
  }

  async function cropToDataUrl() {
    if (!draft || !draft.natural || !draft.photo) return null;
    const n = draft.natural;
    const scale = draft.scale || Math.max(FRAME / n.w, FRAME / n.h) * (draft.zoom / 100);
    const W = n.w * scale, H = n.h * scale;
    const sx = ((W - FRAME) / 2 - draft.offset.x) / scale;
    const sy = ((H - FRAME) / 2 - draft.offset.y) / scale;
    const img = cropImg && cropImg.complete && cropImg.naturalWidth ? cropImg : await loadImage(draft.photo);
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    canvas.getContext("2d").drawImage(img, sx, sy, FRAME / scale, FRAME / scale, 0, 0, size, size);
    return canvas.toDataURL("image/png");
  }

  let dragging = null;
  const cropStage = $("#avatar-crop-stage");
  if (cropStage) {
    cropStage.addEventListener("pointerdown", e => {
      if (!draft || draft.mode !== "custom" || !draft.photo) return;
      dragging = { x: e.clientX, y: e.clientY, ox: draft.offset.x, oy: draft.offset.y };
      cropStage.setPointerCapture(e.pointerId);
    });
    cropStage.addEventListener("pointermove", e => {
      if (!dragging) return;
      draft.offset.x = dragging.ox + (e.clientX - dragging.x);
      draft.offset.y = dragging.oy + (e.clientY - dragging.y);
      layoutCrop();
      drawPreview();
    });
    const endDrag = () => { dragging = null; };
    cropStage.addEventListener("pointerup", endDrag);
    cropStage.addEventListener("pointercancel", endDrag);
  }

  const applyBtn = $("#avatar-apply");
  if (applyBtn) {
    applyBtn.addEventListener("click", async () => {
      if (!draft) return;
      clearError();
      try {
        if (draft.mode === "custom" && draft.photo) {
          state.photo = await cropToDataUrl();
        } else {
          state.photo = null;
        }
        state.avatarStyle = draft.style;
        state.zoom = draft.zoom;
        applyAvatarDom();
        closeAvatarModal();
      } catch (err) {
        showError("头像处理失败，请重新选择图片；当前头像保持不变。");
      }
    });
  }

  /* ---------- 树折叠 ---------- */
  $$("[data-tree-toggle]").forEach(caret => {
    caret.addEventListener("click", e => {
      e.stopPropagation();
      const row = caret.closest(".kw-row");
      const children = row && row.nextElementSibling;
      if (!children || !children.classList.contains("kw-children")) return;
      const open = caret.getAttribute("aria-expanded") === "true";
      caret.setAttribute("aria-expanded", String(!open));
      children.hidden = open;
      const icon = caret.querySelector("use");
      const folder = row.querySelector(".f-ico use");
      if (icon) icon.setAttribute("href", open ? "#chevronRight" : "#chevronDown");
      if (folder) folder.setAttribute("href", open ? "#folder" : "#folderOpen");
    });
  });

  /* ---------- 滚动条按需显示（UI-SCROLL-001） ---------- */
  function bindScroll(node) {
    let timer = 0;
    node.addEventListener("scroll", () => {
      node.classList.add("scrolling");
      clearTimeout(timer);
      timer = setTimeout(() => node.classList.remove("scrolling"), 700);
    }, { passive: true });
  }
  bindScroll(document.documentElement);
  $$("[data-scroll]").forEach(bindScroll);

  /* ---------- 初始状态 ---------- */
  setTheme("light");
  setAvatarStyle("b");
  applyProject();
  applyKb();
})();