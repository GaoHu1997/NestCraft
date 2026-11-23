/* UI-CR069-v1：运行通道选择（SC-069-01/02/03）。纯设计演示，不联网、不接真实业务。
   依据：docs/UI/文档/UI-CR069-平台主代理会话准入.md；滚动条义务 UI-SCROLL-001 继承
   workbench-v4 共享规则（本弹层为短菜单，无新增滚动容器），见 cr049 资源。 */
window.CR069 = (function () {
  "use strict";
  const { D, store, esc, icon, toast, render } = UI;

  /* store.aiRunner：'cli'（默认）| 'platform'。默认必须是 cli——与后端 migrate_session_runner 一致，
     平台通道是显式选择，不得反向变成默认值。 */
  store.aiRunner = store.aiRunner || "cli";

  const isPlatform = () => store.aiRunner === "platform";

  /* 平台通道可用性：任一启用供应商同时具备 文本模型 + 启用端点 + 启用密钥 即可。
     与 CLI 不同：不按协议过滤（平台主代理直接支持 OpenAI / Anthropic 两种协议）。 */
  function platformAvailable() {
    return (D.settings.providers || []).some(p => p.enabled && (p.models || []).some(m =>
      (m.modalities || []).includes("文本") && !(m.modalities || []).includes("生图") &&
      (p.endpoints || []).some(e => e.on !== false && e.url) &&
      (p.keys || []).some(k => k.on)));
  }

  /* 平台模式下的模型候选：取消 cr068 按 CLI 协议的过滤，保留 文本/端点/密钥 校验。 */
  function platformCatalog() {
    return (D.settings.providers || []).filter(p => p.enabled).map(p => ({
      id: p.id, name: p.name, enabled: true,
      models: (p.models || []).filter(m => (m.modalities || []).includes("文本") && !(m.modalities || []).includes("生图") &&
        (p.endpoints || []).some(e => e.on !== false && e.url) && (p.keys || []).some(k => k.on))
        .map(m => ({
          ...m, name: m.name, modelId: m.id,
          ctx: m.context ? (m.context / 1000) + "K" : "—",
          vision: (m.modalities || []).includes("图片"), image: false, available: true,
          protocol: /anthropic/i.test(p.protocol || "") ? "Anthropic" : "OpenAI"
        }))
    })).filter(g => g.models.length);
  }
  const cr068Descriptor = Object.getOwnPropertyDescriptor(D.ai.modelCatalog, "providers");
  if (cr068Descriptor && cr068Descriptor.get) {
    const base = cr068Descriptor.get.bind(D.ai.modelCatalog);
    Object.defineProperty(D.ai.modelCatalog, "providers", {
      configurable: true,
      get: () => (isPlatform() ? platformCatalog() : base())
    });
  }

  /* SC-069-01：运行通道 chip。文案必须说明两类通道的差别，不能只写代号。 */
  function runnerChip(busy) {
    const label = isPlatform() ? "平台主代理" : "CLI 进程";
    const title = busy
      ? "运行中配置已锁定"
      : isPlatform()
        ? "运行通道：平台主代理——由平台直接调用已配置模型作答，不依赖 CLI 安装"
        : "运行通道：CLI 进程——由已安装的 CLI 程序作答，支持原生线程续接";
    return `<button class="ai-chip runner${isPlatform() ? " platform" : ""}" id="ai-anchor-runner" data-ai-anchor="runner" data-act="ai-runner" aria-haspopup="dialog" aria-controls="ai-popup-runner" aria-expanded="${store.aiPop === "runner"}" ${busy ? 'disabled aria-disabled="true"' : ""} title="${esc(title)}" aria-label="切换运行通道：${esc(label)}">${icon("bot", "ico-14")}${esc(label)}</button>`;
  }

  /* SC-069-01/02/03：运行通道弹层。默认 cli；平台不可用给设置引导，不出现“请先安装 CLI”类误导。 */
  function runnerPopup() {
    const ok = platformAvailable();
    const busy = Boolean(store.aiBusy || store.aiRuntimeBusy);
    const item = (id, name, desc, enabled) =>
      `<button class="menu-item ${store.aiRunner === id ? "on" : ""}" data-act="ai-runner-set" data-id="${id}" ${busy || (id === "platform" && !enabled) ? 'disabled aria-disabled="true"' : ""}>${icon(id === "platform" ? "bot" : "terminal", "ico-14")}<span class="mi-main"><b>${esc(name)}</b><span>${esc(desc)}</span></span>${store.aiRunner === id ? `<span class="check">${icon("check", "ico-14")}</span>` : ""}</button>`;
    return `<div class="ai-pop ai-pop-runner" id="ai-popup-runner" data-ai-popup="runner" role="dialog" aria-label="切换运行通道" tabindex="-1">
      <div class="pop-h">运行通道<button class="icon-btn" data-ai-popup-close="runner" aria-label="关闭运行通道选择">${icon("x", "ico-14")}</button></div>
      ${item("cli", "CLI 进程", "由已安装的 CLI 程序作答；支持原生线程续接与权限档位", true)}
      ${item("platform", "平台主代理", ok
        ? "由平台直接调用已配置模型作答；不依赖 CLI，工具在本工作台内按白名单执行"
        : "需要先在设置中配置启用的供应商、端点与密钥", ok)}
      <div class="menu-sep"></div>
      ${ok ? "" : `<div class="drop-empty" role="note"><b>没有可用的平台模型</b><p>请在 设置 → 模型供应商 中配置启用的供应商、端点与密钥；CLI 通道不受影响。</p></div>
      <button class="menu-item" data-act="open-settings" data-tab="provider">${icon("sliders", "ico-14")}打开模型供应商设置</button>`}
      <div class="menu-note">已有消息或运行中的会话不能切换运行通道；请新建会话。</div>
      ${isPlatform() ? '<div class="menu-note">平台会话不使用 CLI 权限档位；可用操作由平台工具白名单决定。</div>' : ""}
    </div>`;
  }

  const actions = window.__actions;
  actions["ai-runner"] = () => { store.aiPop = store.aiPop === "runner" ? null : "runner"; store.aiMenu = null; render(); };
  actions["ai-runner-set"] = el => {
    store.aiRunner = el.dataset.id;
    store.aiPop = null;
    document.body.classList.remove("wb-borrow-ai");
    toast(el.dataset.id === "platform" ? "已切换运行通道：平台主代理" : "已切换运行通道：CLI 进程");
    render();
  };

  return { isPlatform, runnerChip, runnerPopup };
})();
