/**
 * UI 层自检：在真实 DOM 上用原生事件走通各模块核心交互（点击/输入/断言渲染结果）。
 * 与 IPC 套件互补：IPC 验证后端契约，本套件验证界面真的能操作、状态真的更新。
 */
import { FILE_TYPE_GLYPHS, fileTypeGlyph } from "@/components/icon-tiles";
import * as api from "@/api";

interface UiCase {
  section: string;
  name: string;
  ok: boolean;
  detail: string;
}
const uiResults: UiCase[] = [];

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(fn: () => T | null | undefined | false, ms = 5000, label = "元素"): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v as T;
    await sleep(80);
  }
  throw new Error(`等待超时：${label}`);
}

function q<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(sel);
}

function qa<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(sel));
}

/** 按文本内容查找可点击元素（按钮/链接/页签） */
function byText(text: string, root: ParentNode = document): HTMLElement | null {
  const nodes = qa<HTMLElement>(
    'button, a, [role="tab"], [role="treeitem"], .nav-item, .rail-btn, .segment button',
    root
  );
  return nodes.find((n) => (n.textContent ?? "").trim().includes(text)) ?? null;
}

/** 真实事件派发（模拟用户操作） */
function click(el: Element | null, label: string): void {
  if (!el) throw new Error(`找不到可点击元素：${label}`);
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
}

function typeInto(el: HTMLInputElement | HTMLTextAreaElement | null, value: string, label: string): void {
  if (!el) throw new Error(`找不到输入框：${label}`);
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function ui(section: string, name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    uiResults.push({ section, name, ok: true, detail });
  } catch (e) {
    uiResults.push({ section, name, ok: false, detail: String(e).slice(0, 400) });
  }
}

export function uiResultsSnapshot(): UiCase[] {
  return [...uiResults];
}

/** 通过 Ctrl+K 搜索弹窗打开项目窗口（不依赖项目管理页自身列表状态）。 */
async function openProjectBySearch(name: string): Promise<void> {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
  await waitFor(() => q(".modal"), 3000, "搜索弹窗");
  const row = await waitFor(
    () => qa<HTMLElement>(".nc-list-row").find(r => (r.textContent ?? "").includes(name)) ?? null,
    3000,
    `搜索结果「${name}」`
  );
  click(row, `搜索结果「${name}」`);
  await sleep(500);
}

export async function runUiSuite(): Promise<void> {
  /* ---------- 全局壳 ---------- */
  await ui("全局壳", "渲染全局导航与三个入口", async () => {
    const items = await waitFor(() => {
      const nav = qa(".nav-item");
      return nav.length >= 3 ? nav : null;
    }, 8000, "导航项");
    const labels = items.map((n) => (n.textContent ?? "").trim()).filter(Boolean);
    if (!labels.some((l) => l.includes("项目管理"))) throw new Error(`缺少项目管理入口：${labels.join(",")}`);
    if (!labels.some((l) => l.includes("知识库"))) throw new Error("缺少知识库入口");
    if (!labels.some((l) => l.includes("服务器"))) throw new Error("缺少服务器入口");
    if (!labels.some((l) => l.includes("设置"))) throw new Error("缺少设置入口");
    return labels.join(" / ");
  });

  await ui("全局壳", "深浅色切换真实改变 data-theme", async () => {
    const before = document.documentElement.dataset.theme || "light";
    click(byText("深色") ?? byText("浅色"), "主题切换按钮");
    await sleep(300);
    const after = document.documentElement.dataset.theme;
    if (after === before) throw new Error(`主题未变化（仍为 ${after}）`);
    click(byText(after === "dark" ? "浅色" : "深色"), "主题切换回退");
    await sleep(200);
    return `${before} → ${after} → ${document.documentElement.dataset.theme}`;
  });

  /* ---------- 设置中心 ---------- */
  await ui("设置中心", "打开设置并渲染六项页签", async () => {
    click(q('button[aria-label="设置与账户"]'), "设置入口");
    const modal = await waitFor(() => q('[aria-label="设置中心"]'), 4000, "设置弹框");
    const tabs = qa('nav[aria-label="设置页签"] button').map((b) => (b.textContent ?? "").trim());
    for (const need of ["基础设置", "模型设置", "SDK", "Skill", "MCP", "Tool"]) {
      if (!tabs.some((t) => t.includes(need))) throw new Error(`缺页签 ${need}，实际：${tabs.join(",")}`);
    }
    return tabs.join(" / ");
  });

  await ui("设置中心", "切到模型设置并新建供应商表单", async () => {
    click(byText("模型设置"), "模型设置页签");
    await sleep(400);
    const pane = await waitFor(() => q('[aria-label="设置中心"]') as HTMLElement, 3000, "设置面板");
    const addBtn = byText("新建供应商", pane) ?? byText("新建", pane);
    if (!addBtn) throw new Error("模型设置缺新建供应商入口");
    click(addBtn, "新建供应商");
    await sleep(500);
    const inputs = qa<HTMLInputElement>('input.input, input', pane).filter((i) => i.type !== "password");
    if (inputs.length === 0) throw new Error("供应商表单未渲染输入框");
    typeInto(inputs[0], "UI 自检供应商", "供应商名称");
    return `表单渲染 ${inputs.length} 个输入框，已填入名称`;
  });

  await ui("设置中心", "模型检测页签渲染 9 针区块与历史入口（CR-058）", async () => {
    const nav = q('[aria-label="设置分类"]') as HTMLElement;
    const probeTab = byText("模型检测", nav);
    if (!probeTab) throw new Error("设置左栏缺「模型检测」页签");
    click(probeTab, "模型检测页签");
    await sleep(400);
    const pane = q('[aria-label="设置中心"]') as HTMLElement;
    const section = q('[aria-label="模型检测"]', pane) as HTMLElement | null;
    if (!section) throw new Error("模型检测区块未渲染");
    // 外层不得有卡片框（CR-058 r3）
    const style = window.getComputedStyle(section);
    if (style.borderTopWidth !== "0px" || style.backgroundColor !== "rgba(0, 0, 0, 0)") {
      throw new Error(`检测区不应带外框：border=${style.borderTopWidth} bg=${style.backgroundColor}`);
    }
    const sel = qa<HTMLSelectElement>('select.select', section);
    if (sel.length < 2) throw new Error(`应有供应商与模型两个选择器，实际 ${sel.length}`);
    const runBtn = byText("开始检测", section) as HTMLButtonElement | null;
    if (!runBtn) throw new Error("缺「开始检测」按钮");
    if (!runBtn.disabled) throw new Error("未选供应商时开始检测应为禁用");
    const historyBtn = byText("历史记录", section);
    if (!historyBtn) throw new Error("缺「历史记录」入口");
    // 19 针清单（r4）
    const codes = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11", "P12", "P13", "P14", "P15", "P16", "P17", "P18", "P19"];
    const names = ["连通与鉴权握手", "模型回显与跨档偷换", "响应 Schema 与 ID 规范", "SSE 真流式与假首字", "网关响应头指纹", "System 金丝雀服从", "隐藏注入与套壳嗅探", "多轮记忆保持", "Stop 序列截断", "Max Tokens 硬截断", "原生工具调用验真", "Strict JSON Schema", "动态逻辑与防背题", "并发混池快照", "识图多模态验真", "Responses 协议探测", "输入 Token 对账", "流式输出对账", "长前缀缓存命中"];
    for (const name of names) {
      if (!section.textContent?.includes(name)) throw new Error(`检测区缺探针「${name}」`);
    }
    return `检测页渲染：2 个选择器 + 开始检测(禁用) + 历史记录 + 19 针清单，无外框`;
  });

  await ui("设置中心", "模型检测历史弹层可打开（CR-058）", async () => {
    const pane = q('[aria-label="设置中心"]') as HTMLElement;
    const section = q('[aria-label="模型检测"]', pane) as HTMLElement;
    click(byText("历史记录", section), "历史记录按钮");
    await sleep(500);
    const dialog = await waitFor(() => q('[aria-label*="历史记录"]') as HTMLElement, 3000, "历史记录弹层");
    const body = dialog.textContent ?? "";
    if (!body.includes("最近 10 次")) throw new Error("历史弹层副标题缺失");
    return "历史弹层已打开";
  });

  await ui("设置中心", "切到 SDK 页并显示 CLI 卡", async () => {
    const pane = q('[aria-label="设置中心"]') as HTMLElement;
    click(byText("SDK", pane), "SDK 页签");
    await sleep(300);
    // 确认 SDK 页签真的被激活（set-pane 未隐藏）
    const visiblePane = qa('.set-pane').find((p) => !p.hasAttribute('hidden'));
    if (!visiblePane) throw new Error("没有可见的设置面板");
    const navActive = qa('.set-nav-btn').find((b) => b.getAttribute('aria-current') === 'page')?.textContent ?? "";
    if (!navActive.includes("SDK")) throw new Error(`SDK 页签未激活，当前：${navActive}`);
    return await (async () => {
    // sdk_list 会真实执行 npm 检测（3 个 CLI），需要更长时间
    await waitFor(() => {
      const t = (visiblePane.textContent ?? "").toLowerCase();
      return t.includes("claude") && t.includes("codex") && t.includes("grok");
    }, 30000, "SDK 卡片内容（npm 检测）");
    const text = visiblePane.textContent ?? "";
    const BS = String.fromCharCode(92);
    const versionRe = new RegExp(BS + "d+" + BS + "." + BS + "d+" + BS + "." + BS + "d+");
    const hasVersion = versionRe.test(text) || text.includes("已安装") || text.includes("未安装");
    if (!hasVersion) throw new Error("SDK 卡未显示版本或安装状态；可见面板文本：" + text.split("[").join(" ").slice(0, 300));
    const found = (text.match(versionRe) ?? []).slice(0, 3).join(",");
    for (const need of ["claude", "codex", "grok"]) {
      if (!text.includes(need)) throw new Error("SDK 页缺 " + need + " 卡片");
    }
    return `SDK 页签已激活；版本/状态：${found || "已安装标签"}`;
    })();
  });

  await ui("设置中心", "关闭设置恢复页面状态", async () => {
    click(q('[aria-label="关闭设置中心"]'), "关闭按钮");
    await sleep(300);
    if (q('[aria-label="设置中心"]')) throw new Error("设置弹框未关闭");
    return "已关闭";
  });

  /* ---------- 项目管理 ---------- */
  await ui("项目管理", "新建项目弹框可输入并渲染表单", async () => {
    click(byText("新建项目"), "新建项目按钮");
    const modal = await waitFor(() => q('[aria-label="新建项目"], .modal'), 4000, "新建项目弹框");
    const inputs = qa<HTMLInputElement>("input", modal as ParentNode);
    if (inputs.length < 2) throw new Error(`表单输入框不足：${inputs.length}`);
    typeInto(inputs[0], "UI自检项目", "项目名称");
    const segs = qa("button", modal as ParentNode).filter((b) => (b.textContent ?? "").includes("办公"));
    if (segs.length === 0) throw new Error("缺项目类型分段（编码/办公）");
    click(segs[0], "办公类型");
    return `表单可输入，含编码/办公分段`;
  });

  await ui("项目管理", "关闭新建弹框", async () => {
    const modal = q('.modal') as HTMLElement;
    const cancel = byText("取消", modal);
    click(cancel ?? q('[aria-label="关闭"]', modal), "取消");
    await sleep(300);
    if (q('.modal')) throw new Error("弹框未关闭");
    return "已关闭";
  });

  /* ---------- 知识库 ---------- */
  await ui("知识库", "切到知识库并渲染库列表/新建入口", async () => {
    click(byText("知识库"), "知识库导航");
    await sleep(600);
    const main = q(".main") as HTMLElement;
    if (!main) throw new Error("主区域缺失");
    const text = main.textContent ?? "";
    if (!text.includes("知识库")) throw new Error("知识库页未渲染");
    const add = byText("新建知识库", main) ?? byText("新建", main);
    if (!add) throw new Error("缺新建知识库入口");
    return `渲染库管理页（含新建入口）`;
  });

  await ui("知识库", "新建知识库弹框渲染字段与提示", async () => {
    click(byText("新建知识库") ?? byText("新建"), "新建知识库");
    const modal = await waitFor(() => q('.modal'), 4000, "知识库弹框");
    const text = (modal as HTMLElement).textContent ?? "";
    if (!text.includes("目录") && !text.includes("路径")) throw new Error("缺目录路径说明");
    const inputs = qa<HTMLInputElement>("input", modal as ParentNode);
    if (inputs.length < 2) throw new Error(`输入框不足：${inputs.length}`);
    return "弹框含名称+目录路径字段";
  });

  await ui("知识库", "关闭并返回项目列表", async () => {
    const modal = q('.modal') as HTMLElement;
    click(byText("取消", modal) ?? q('[aria-label="关闭"]', modal), "取消");
    await sleep(300);
    click(byText("项目管理"), "项目管理导航");
    await sleep(500);
    if (!(q(".main") as HTMLElement)?.textContent?.includes("项目")) throw new Error("未回到项目列表");
    return "已返回";
  });

  /* ---------- CR-051：内置图标与头像（UI-CR051-v1） ---------- */
  await ui("CR-051 图标", "项目/知识库图标砖真实渲染与同步", async () => {
    const dirs = await api.invoke<{ projectDir: string; kbDir: string }>("smoke_prepare_fixtures");
    // 14 类扩展名映射断言（唯一来源组件；未知扩展名回退 fileUnknown，不空白）。
    const tokens = new Set(Object.values(FILE_TYPE_GLYPHS).map((g) => g.token));
    for (const need of ["md", "text", "pdf", "word", "sheet", "slides", "image", "code", "archive", "audio", "video"]) {
      if (!tokens.has(need)) throw new Error(`缺文件类型令牌 ${need}`);
    }
    if (fileTypeGlyph("whatever-xyz").token !== "unknown") throw new Error("未知扩展名应回退 unknown 令牌");
    if (fileTypeGlyph("md").icon !== "fileMarkdown") throw new Error("md 应映射 fileMarkdown");
    if (fileTypeGlyph("html").icon !== "fileHtml") throw new Error("html 应映射 fileHtml");
    if (fileTypeGlyph(".mp3").icon !== "fileAudio" || fileTypeGlyph(".mkv").icon !== "fileVideo") throw new Error("音视频映射不符");
    if (fileTypeGlyph("whatever-xyz").icon !== "fileUnknown") throw new Error("未知扩展名应回退 fileUnknown");
    // 真实 IPC 建项目（办公）+ 图标；知识库走真实 UI 新建对话框（保证列表刷新）。
    const p = await api.createProject("UI 自检图标项目", "work", dirs.projectDir);
    await api.updateProject(p.id, "UI 自检图标项目", dirs.projectDir, "briefcase");
    click(byText("知识库"), "知识库导航");
    await sleep(700);
    click(byText("新建知识库"), "新建知识库按钮");
    const createDlg = await waitFor(() => q(".modal"), 4000, "新建知识库弹框");
    const inputs = qa<HTMLInputElement>("input", createDlg);
    if (inputs.length < 2) throw new Error(`新建知识库输入框不足：${inputs.length}`);
    typeInto(inputs[0], "UI 自检知识库", "知识库名称");
    typeInto(inputs[1], dirs.kbDir, "知识库目录");
    click(byText("创建并扫描", createDlg) ?? byText("创建", createDlg), "创建并扫描");
    await sleep(300);
    const main = q(".main") as HTMLElement;
    const card = await waitFor(
      () => qa(".kb-card", main).find((c) => (c.textContent ?? "").includes("UI 自检知识库")),
      15000, "UI 自检知识库卡片",
    );
    try {
      const kbTileIcon = card.querySelector(".cr51-tile-kb svg")?.getAttribute("data-icon");
      if (kbTileIcon !== "bookOpen") throw new Error(`managed-directory 库默认图标应为 bookOpen，实际 ${kbTileIcon}`);
      // CR-070：知识库图标选择改走卡片图标悬浮层（共用 50 图标 + 10 色卡）。
      const iconBtn = byText("图标", (card as HTMLElement) ?? main);
      if (!iconBtn) throw new Error("缺「图标」入口");
      click(iconBtn, "知识库图标入口");
      const pop = await waitFor(() => q(".icon-pop"), 4000, "知识库图标悬浮层");
      const groups = qa(".cr51-picker-group", pop);
      if (groups.length !== 6) throw new Error(`图标选择器应 6 组，实际 ${groups.length}`);
      const cells = qa(".cr51-picker-cell", pop);
      if (cells.length !== 51) throw new Error(`图标格应 50+1 清空，实际 ${cells.length}`);
      if (qa(".cr51-swatch:not(.cr51-swatch-clear)", pop).length !== 10) throw new Error("色卡应 10 个（不含回默认格）");
      const cancelIcon = byText("取消", pop);
      if (!cancelIcon) throw new Error("悬浮层缺取消");
      click(cancelIcon, "关闭悬浮层（未保存）");
      await sleep(300);
      if (q(".icon-pop")) throw new Error("悬浮层未关闭");
      const grantBtn = byText("授权", (card as HTMLElement) ?? main);
      if (!grantBtn) throw new Error("缺授权按钮");
      click(grantBtn, "授权按钮");
      const dlg = await waitFor(() => qa(".modal").find((m) => (m.textContent ?? "").includes("UI 自检图标项目")), 4000, "授权弹窗");
      const row = qa(".kb-grant-row", dlg).find((r) => (r.textContent ?? "").includes("UI 自检图标项目"));
      if (!row) throw new Error("授权弹窗缺项目行");
      const tile26 = row.querySelector(".cr51-tile svg")?.getAttribute("data-icon");
      if (tile26 !== "briefcase") throw new Error(`授权弹窗项目图标砖应为 briefcase，实际 ${tile26}`);
      click(byText("取消", dlg) ?? q('[aria-label="关闭"]', dlg), "关闭授权弹窗");
      await sleep(300);
      // 改图标后重新打开授权弹窗 → 项目行同步为 code。
      await api.updateProject(p.id, "UI 自检图标项目", dirs.projectDir, "code");
      click(byText("授权", card as HTMLElement) ?? grantBtn, "重新打开授权弹窗");
      const dlg2 = await waitFor(() => qa(".modal").find((m) => (m.textContent ?? "").includes("UI 自检图标项目")), 4000, "授权弹窗(二次)");
      const tile26b = qa(".kb-grant-row", dlg2).find((r) => (r.textContent ?? "").includes("UI 自检图标项目"))?.querySelector(".cr51-tile svg")?.getAttribute("data-icon");
      if (tile26b !== "code") throw new Error(`改图标后授权弹窗应为 code，实际 ${tile26b}`);
      click(byText("取消", dlg2) ?? q('[aria-label="关闭"]', dlg2), "关闭授权弹窗");
      await sleep(300);
      // 进入知识库 → 树 md 图标 + 类型小字 + 文档头 20px 图标。
      const enter = byText("进入", card as HTMLElement);
      if (!enter) throw new Error("缺「进入」按钮");
      click(enter, "进入知识库");
      await sleep(1000);
      const mdIcon = await waitFor(
        () => qa(".kb-tree-file.type-md svg").find((svg) => svg.getAttribute("data-icon") === "fileMarkdown"),
        5000, "md 类型图标 fileMarkdown",
      );
      if (!mdIcon) throw new Error("md 文件未渲染 fileMarkdown 类型图标");
      if (!qa(".kw-file-label small").some((x) => (x.textContent ?? "").toUpperCase().includes("MD"))) throw new Error("类型小字缺失");
      if (!qa(".kb-crumb .kb-tree-file svg").length) throw new Error("文档头缺少 20px 类型图标");
      const back = byText("知识库", q(".kb-crumb") as HTMLElement);
      if (back) click(back, "返回知识库列表");
      await sleep(400);
      return "库卡 40px(bookOpen) + 授权弹窗 26px(briefcase→code 同步) + 树/文档头 md 图标 + 14 类映射通过";
    } finally {
      const libs = await api.kbList().catch(() => [] as api.KnowledgeLibrary[]);
      const kbId2 = libs.find((l) => l.name === "UI 自检知识库")?.id;
      if (kbId2) await api.kbDelete(kbId2).catch(() => {});
      await api.deleteProject(p.id).catch(() => {});
    }
  });

  await ui("CR-051 头像", "侧栏头像渲染品牌帆船 Logo 且缺省风格 B（r6；CR-070 顶栏头像已删）", async () => {
    const root = document.querySelector(".nc-app");
    if (!root || !root.getAttribute("data-avatar-style")) throw new Error("App 根节点缺 data-avatar-style");
    if (root.getAttribute("data-avatar-style") !== "b") throw new Error(`缺省风格应为 b，实际 ${root.getAttribute("data-avatar-style")}`);
    // CR-070：顶栏头像删除，改从侧栏底部头像进入设置。
    if (q("button.nc-avatar") || q(".nc-avatar-frame")) throw new Error("顶栏头像应已删除（CR-070）");
    if (!q(".nc-side-user .cr51-avatar img[src*='logo-sail']")) throw new Error("侧栏头像未渲染品牌 Logo");
    const sideBtn = q(".nc-side-user") as HTMLElement;
    click(sideBtn, "侧栏头像");
    const dialog = await waitFor(() => q('dialog[aria-label="设置与账户"]'), 4000, "设置弹框");
    const setUser = dialog.querySelector(".set-user .cr51-avatar img[src*='logo-sail']");
    if (!setUser) throw new Error("设置左栏头像未渲染品牌 Logo");
    const radios = qa(".cr51-avatar-radio", dialog);
    if (radios.length !== 5) throw new Error(`头像风格单选应为 5 项，实际 ${radios.length}`);
    if (radios[1].getAttribute("aria-checked") !== "true") throw new Error("缺省风格应为 B（第二项选中）");
    if ((dialog.textContent ?? "").includes("LC")) throw new Error("设置内仍出现 LC 字母缩写");
    const close = byText("关闭", dialog);
    if (!close) throw new Error("缺关闭按钮");
    click(close, "关闭设置（未保存，恢复已保存风格）");
    await sleep(300);
    if (q('dialog[aria-label="设置与账户"]')) throw new Error("设置弹框未关闭");
    return "侧栏 Logo + 5 风格单选（缺省 B）+ 顶栏无头像通过";
  });

  await ui("CR-051 头像", "悬停编辑打开更换头像弹窗（固定 680×660、内置 5 + 自定义；CR-070 走侧栏入口）", async () => {
    const edit = q(".nc-side-avatar-frame .cr51-avatar-edit") as HTMLElement;
    if (!edit) throw new Error("缺侧栏头像悬停编辑角标");
    click(edit, "侧栏头像编辑角标");
    const modal = (await waitFor(() => q(".cr51-avatar-modal"), 4000, "更换头像弹窗")) as HTMLElement;
    if (modal.offsetWidth !== 680 || modal.offsetHeight !== 660) throw new Error(`弹窗应固定 680×660，实际 ${modal.offsetWidth}×${modal.offsetHeight}`);
    const presets = qa(".cr51-preset", modal);
    if (presets.length !== 6) throw new Error(`内置头像应 5 + 自定义 6 格，实际 ${presets.length}`);
    if (!presets[1].getAttribute("aria-pressed")) throw new Error("preset 缺 aria-pressed");
    if (presets[1].getAttribute("aria-pressed") !== "true") throw new Error("缺省应选中 B");
    if (!modal.querySelector(".cr51-crop-stage")) throw new Error("取景框应常驻");
    if (!modal.querySelector(".cr51-preset-custom")) throw new Error("缺自定义格");
    const cancel = byText("取消", modal);
    if (!cancel) throw new Error("缺取消按钮");
    click(cancel, "取消（不改已保存值）");
    await sleep(300);
    if (q(".cr51-avatar-modal")) throw new Error("取消后弹窗未关闭");
    return "680×660 / 6 格 / B 选中 / 取景框常驻 / 取消不改通过";
  });

  /* ---------- 服务器 ---------- */
  await ui("服务器", "切到服务器并渲染主机列表/新建入口", async () => {
    click(byText("服务器管理"), "服务器导航");
    await sleep(600);
    const main = q(".main") as HTMLElement;
    const text = main.textContent ?? "";
    if (!text.includes("主机") && !text.includes("服务器")) throw new Error("服务器页未渲染");
    const add = byText("新建主机", main) ?? byText("添加主机", main) ?? byText("新建", main);
    if (!add) throw new Error("缺新建主机入口");
    return "渲染主机列表页（含新建入口）";
  });

  await ui("服务器", "新建主机表单含三种认证方式", async () => {
    click(byText("新建主机") ?? byText("添加主机") ?? byText("新建"), "新建主机");
    const modal = await waitFor(() => q('.modal'), 4000, "主机弹框");
    const text = (modal as HTMLElement).textContent ?? "";
    for (const need of ["密码", "密钥"]) {
      if (!text.includes(need)) throw new Error(`认证方式缺 ${need}`);
    }
    if (!text.includes("免认证") && !text.includes("无凭据")) throw new Error("认证方式缺 none 选项");
    return "含 密码/密钥/免认证 三种方式";
  });

  await ui("服务器", "关闭主机弹框", async () => {
    const modal = q('.modal') as HTMLElement;
    click(byText("取消", modal) ?? q('[aria-label="关闭"]', modal), "取消");
    await sleep(300);
    if (q('.modal')) throw new Error("弹框未关闭");
    return "已关闭";
  });

  /* ---------- 最终回到项目页 ---------- */
  await ui("全局壳", "回到项目列表", async () => {
    click(byText("项目管理"), "项目管理");
    await sleep(400);
    return "ok";
  });

  /* ---------- 办公工作区（CR-043：文件树 + 查看器 + 统一 AI 侧栏） ---------- */
  await ui("办公工作区", "进入预置办公项目并渲染文件树", async () => {
    // 项目卡片是 .card div，不在 byText 的可点击选择器内
    const card = await waitFor(
      () => qa(".card").find(c => (c.textContent ?? "").includes("市场研究资料")) ?? null,
      5000,
      "办公项目卡片"
    );
    click(card, "办公项目卡片");
    const tree = await waitFor(() => q('[aria-label="办公目录与文件"]'), 5000, "办公文件树");
    const folders = qa('[role="treeitem"]', tree);
    if (folders.length < 3) throw new Error(`目录条目过少：${folders.length}`);
    const root = q(".office-root-row");
    if (!root || !(root.textContent ?? "").includes("市场研究资料")) throw new Error("根行未显示项目名");
    return `目录 ${folders.length} 条`;
  });

  await ui("办公工作区", "展开/折叠目录与点击文件打开查看器", async () => {
    const toggle = await waitFor(() => q('[aria-label^="折叠"]'), 4000, "折叠按钮");
    click(toggle, "折叠按钮");
    await sleep(250);
    const expand = q('[aria-label^="展开"]');
    if (!expand) throw new Error("折叠后未出现展开按钮");
    click(expand, "展开按钮");
    await sleep(250);
    const fileBtn = byText("社区活动预约调研报告.docx");
    if (!fileBtn) throw new Error("未找到样例文件");
    click(fileBtn, "样例文件");
    await sleep(300);
    const toolbar = q(".office-viewer-toolbar");
    if (!toolbar || !(toolbar.textContent ?? "").includes("社区活动预约调研报告")) throw new Error("查看器未打开文件");
    if (!(toolbar.textContent ?? "").includes("合成仿真")) throw new Error("缺少 DEMO 轻标记");
    return "ok";
  });

  await ui("办公工作区", "文件搜索命中保留祖先并可清空", async () => {
    const input = await waitFor(() => q<HTMLInputElement>('.office-search input'), 3000, "搜索框");
    typeInto(input, "台账", "搜索框");
    await sleep(300);
    const tree = q('[aria-label="办公目录与文件"]');
    const visible = qa('[role="treeitem"]', tree ?? document).length;
    if (visible === 0) throw new Error("搜索无命中");
    const clear = q(".office-search-clear");
    click(clear, "清空搜索");
    await sleep(250);
    const restored = qa('[role="treeitem"]', q('[aria-label="办公目录与文件"]') ?? document).length;
    if (restored <= visible) throw new Error("清空后未恢复完整树");
    return `命中 ${visible} → 恢复 ${restored}`;
  });

  await ui("办公工作区", "新建文件夹弹窗显示父路径并原位报错", async () => {
    const btn = await waitFor(() => q('[aria-label="新建文件夹"]'), 3000, "新建文件夹按钮");
    click(btn, "新建文件夹按钮");
    const modal = await waitFor(() => q('.modal'), 3000, "新建文件夹弹窗");
    if (!(modal.textContent ?? "").includes("父目录")) throw new Error("弹窗未显示父目录");
    const input = q<HTMLInputElement>('.modal input.input');
    typeInto(input, "社区活动预约调研报告.docx", "名称输入");
    click(q('.modal .btn.primary'), "创建按钮");
    await sleep(250);
    const err = q('.office-error');
    if (!err || !(err.textContent ?? "").includes("同名")) throw new Error("重名未原位报错");
    // 改名成功创建
    const input2 = q<HTMLInputElement>('.modal input.input');
    typeInto(input2, "冒烟目录", "名称输入");
    click(q('.modal .btn.primary'), "创建按钮");
    await sleep(300);
    if (q('.modal')) throw new Error("创建成功后弹窗未关闭");
    const created = byText("冒烟目录");
    if (!created) throw new Error("新目录未出现在树中");
    return "ok";
  });

  await ui("办公 AI 侧栏", "统一侧栏历史浮层覆盖在侧栏左侧并可关闭", async () => {
    // 先建一个会话（空项目无会话时步骤/演示数据随会话注入）
    const newBtn = byText("新会话");
    if (newBtn) {
      click(newBtn, "新会话");
      await sleep(500);
    }
    const histBtn = await waitFor(() => q("[data-chat-overlay-trigger='history']"), 4000, "历史按钮");
    click(histBtn, "历史按钮");
    const overlay = await waitFor(() => q('.chat-history'), 3000, "历史浮层");
    if (!(overlay.textContent ?? "").includes("会话历史")) throw new Error("浮层缺标题");
    if (!(overlay.textContent ?? "").includes("新会话")) throw new Error("浮层缺新会话入口");
    // CR-063：搜索行、已加载/全部计数、加载状态与行内删除入口
    if (!q('#chat-history-q')) throw new Error("浮层缺会话搜索框");
    const count = q('.chat-history-count')?.textContent ?? "";
    if (!count.includes("/")) throw new Error(`浮层计数应为「已加载 / 全部」，实际 ${count}`);
    if (!(overlay.textContent ?? "").includes("已到全部") && !(overlay.textContent ?? "").includes("继续加载")) throw new Error("浮层缺加载状态");
    // CR-065：无状态文字、无底部栏、有「…」入口与「重置」
    if (qa('.chat-hist-state', overlay).length) throw new Error("浮层不应再显示状态文字");
    if (q('.chat-history-foot')) throw new Error("浮层不应再有底部栏");
    if (!q('.chat-hist-more-btn')) throw new Error("浮层缺行操作入口");
    const resetBtn = [...overlay.querySelectorAll<HTMLButtonElement>(".chat-hist-all")].find(b => (b.textContent ?? "").includes("重置"));
    if (!resetBtn) throw new Error("浮层缺「重置」按钮");
    if (!resetBtn.disabled) throw new Error("无搜索词时「重置」应禁用");
    const closeBtn = q('[aria-label="关闭会话历史"]');
    click(closeBtn, "关闭按钮");
    await sleep(200);
    if (q('.chat-history')) throw new Error("浮层未关闭");
    return "ok";
  });

  await ui("办公 AI 侧栏", "顶部子智能体与后台任务下拉（演示数据）", async () => {
    const agentsBtn = await waitFor(() => byText("子智能体"), 4000, "子智能体入口");
    click(agentsBtn, "子智能体入口");
    const drop = await waitFor(() => q('.chat-drop'), 3000, "子智能体下拉");
    if (!(drop.textContent ?? "").includes("合成演示")) throw new Error("缺合成演示脚注");
    if (qa('.chat-agent-row', drop).length < 3) throw new Error("子智能体行不足");
    click(agentsBtn, "子智能体入口");
    await sleep(150);
    if (q('.chat-drop')) throw new Error("再次点击未收起");
    const bgBtn = byText("后台任务");
    if (!bgBtn) throw new Error("后台任务入口未显示");
    click(bgBtn, "后台任务入口");
    const bgDrop = await waitFor(() => q('.chat-drop-bg'), 3000, "后台下拉");
    if (!(bgDrop.textContent ?? "").includes("进行中")) throw new Error("缺进行中分组");
    const clearBtn = byText("清空已结束", bgDrop);
    if (!clearBtn) throw new Error("缺清空已结束");
    click(clearBtn, "清空已结束");
    await sleep(200);
    return "ok";
  });

  await ui("办公 AI 侧栏", "底部三统计浮层右对齐展开并互斥", async () => {
    const statBtn = await waitFor(() => q('[aria-label="会话统计"]'), 3000, "会话统计入口");
    click(statBtn, "会话统计入口");
    const pop = await waitFor(() => q('.chat-stat-pop'), 3000, "统计浮层");
    if (!(pop.textContent ?? "").includes("模型用时")) throw new Error("缺模型用时字段");
    const tokBtn = q('[aria-label="Token 用量"]');
    click(tokBtn, "Token 入口");
    await sleep(200);
    const pop2 = q('.chat-stat-pop');
    if (!pop2 || !(pop2.textContent ?? "").includes("缓存命中")) throw new Error("统计浮层未互斥切换");
    // Escape 收起
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(200);
    if (q('.chat-stat-pop')) throw new Error("Escape 未收起统计浮层");
    return "ok";
  });

  await ui("办公 AI 侧栏", "步骤折叠框头部计数与折叠保留", async () => {
    const steps = await waitFor(() => q('.chat-steps'), 3000, "步骤折叠框");
    if (!(steps.textContent ?? "").includes("执行步骤")) throw new Error("缺步骤标题");
    const head = q('.chat-steps-h', steps);
    click(head, "步骤头部");
    await sleep(200);
    if (q('.chat-steps-list', steps)) throw new Error("折叠后列表仍在");
    if (!(steps.textContent ?? "").match(/\d+\/\d+/)) throw new Error("折叠后头部计数丢失");
    click(q('.chat-steps-h', steps), "步骤头部");
    await sleep(200);
    if (!q('.chat-steps-list', steps)) throw new Error("展开失败");
    return "ok";
  });

  await ui("办公 AI 侧栏", "回到项目列表", async () => {
    click(byText("返回项目列表"), "返回按钮");
    await sleep(400);
    return "ok";
  });

  /* ---------- CR-049：滚动条按需显示（UI-SCROLL-001，真实 DOM 行为验证） ---------- */
  await ui("CR-049 滚动条", "恢复界面状态并打开冒烟演示项目", async () => {
    // 防御：历史用例可能泄漏打开的设置弹窗，先关闭再继续。
    const closeSettings = q('[aria-label="关闭设置"]');
    if (closeSettings) { click(closeSettings, "关闭设置"); await sleep(300); }
    // IPC 清理段会删除夹具项目；UI 段需要时经 IPC 重建（目录沿用 smoke 夹具）。
    const list = await import("@/api").then(m => m.listProjects()).catch(() => []);
    let target = list.find(p => p.name === "冒烟演示项目");
    if (!target) {
      const m = await import("@/api");
      const dataDir = await m.appDataDir();
      const sep = dataDir.includes("\\") ? "\\" : "/";
      const dir = `${dataDir.replace(/[\\/]+$/, "")}${sep}smoke${sep}proj-demo`;
      target = await m.createProject("冒烟演示项目", "code", dir);
    }
    if (!target) throw new Error("夹具项目创建失败");
    click(byText("项目管理"), "项目管理导航");
    await sleep(500);
    // CR-070：侧栏「当前项目」已删除；从项目列表页进入「冒烟演示项目」。
    const card = await waitFor(() => {
      return qa<HTMLElement>(".proj-card").find((el) => (el.textContent ?? "").includes("冒烟演示项目")) ?? null;
    }, 6000, "项目列表卡片");
    click(card.querySelector(".btn.sm") ?? card, "项目卡片打开");
    await waitFor(() => q(".req-tabs"), 6000, "需求页签条");
    const previewBtn = byText("全文预览");
    if (!previewBtn) throw new Error("缺全文预览入口");
    click(previewBtn, "全文预览");
    await waitFor(() => qa<HTMLElement>(".req-reader").find(el => (el.textContent ?? "").includes("全项目需求")), 6000, "全文预览正文");
    return `项目 ${target.id} 已打开并进入全文预览`;
  });

  /* ---------- CR-066：需求思维导图与阅读视图（真实 Tauri DOM） ---------- */
  await ui("CR-066 思维导图", "进入导图：整块画布、父子连线、同源导图目录", async () => {
    const mapBtn = byText("思维导图");
    if (!mapBtn) throw new Error("缺思维导图入口");
    click(mapBtn, "思维导图");
    const area = await waitFor(() => q<HTMLElement>(".req-map-area"), 6000, "导图画布");
    if (q(".req-reader")) throw new Error("导图模式仍渲染正文容器");
    const paths = qa<SVGPathElement>(".req-map-edges path");
    if (paths.length < 2) throw new Error(`导图缺少父子连线（实际 ${paths.length} 条）`);
    const outline = qa<HTMLElement>(".req-map-outline .req-tree-row");
    if (outline.length < 3) throw new Error(`导图目录条目过少（${outline.length}）`);
    const kinds = new Set(qa<HTMLElement>(".req-map-outline .req-kind").map((e) => (e.textContent ?? "").trim()));
    for (const need of ["Vision", "Epic"]) {
      if (!kinds.has(need)) throw new Error(`导图目录缺 ${need}（实际：${[...kinds].join(",")}）`);
    }
    const nodes = qa<HTMLElement>(".req-map-node");
    const xs = nodes.map((n) => n.offsetLeft);
    if (!xs.length || Math.min(...xs) === Math.max(...xs)) throw new Error("节点未按层级横向展开");
    return `连线 ${paths.length} 条、节点 ${nodes.length} 个、目录 ${outline.length} 条`;
  });

  await ui("CR-066 思维导图", "折叠控件在连线连接处且默认隐藏", async () => {
    const vision = q<HTMLElement>(".req-map-node.vision");
    const point = q<HTMLElement>(`.req-map-foldpoint[data-for="${vision?.getAttribute("data-node-id") ?? ""}"]`);
    if (!point) throw new Error("导图缺少连线连接处的折叠控件");
    const pr = point.getBoundingClientRect(), nr = vision!.getBoundingClientRect();
    if (Math.abs(pr.left + pr.width / 2 - nr.right) > 4) {
      throw new Error(`折叠控件未落在父节点右边缘（控件中心 ${Math.round(pr.left + pr.width / 2)} vs 节点右缘 ${Math.round(nr.right)}）`);
    }
    const style = getComputedStyle(point);
    if (style.opacity !== "0") throw new Error(`折叠控件默认应隐藏，实际 opacity=${style.opacity}`);
    const nodeTools = q<HTMLElement>(".req-map-node.vision .req-map-node-tools");
    const hasFoldInNode = nodeTools
      ? [...nodeTools.querySelectorAll("button")].some((b) => /折叠|展开/.test(b.getAttribute("aria-label") ?? ""))
      : false;
    if (hasFoldInNode) throw new Error("节点内仍有折叠按钮，与新增下级图标冲突");
    return `折叠控件位于父节点右边缘，默认 opacity=0；节点内无折叠按钮`;
  });

  await ui("CR-066 思维导图", "点击节点在右侧出现悬浮详情框", async () => {
    const epic = q<HTMLElement>(".req-map-node.epic");
    if (!epic) throw new Error("导图缺 Epic 节点");
    click(epic.querySelector<HTMLElement>(".req-map-node-hit"), "Epic 节点");
    const detail = await waitFor(() => q<HTMLElement>(".req-map-detail"), 4000, "右侧详情框");
    const area = q<HTMLElement>(".req-map-area")!;
    const dr = detail.getBoundingClientRect(), ar = area.getBoundingClientRect();
    if (dr.left < ar.right - dr.width - 2) throw new Error("详情框未贴在画布右侧");
    if (dr.width < 200) throw new Error(`详情框宽度异常（${Math.round(dr.width)}）`);
    const meta = qa<HTMLElement>(".req-map-detail-meta dt").length;
    if (meta < 3) throw new Error(`详情框元信息过少（${meta}）`);
    const close = q<HTMLElement>(".req-map-detail .icon-btn");
    click(close, "关闭详情");
    await sleep(200);
    if (q(".req-map-detail")) throw new Error("关闭后详情框仍在");
    return `详情框宽 ${Math.round(dr.width)}、元信息 ${meta} 项、可关闭`;
  });

  await ui("CR-066 思维导图", "模型作为独立分支融入导图（虚线关联）", async () => {
    const modelNodes = qa<HTMLElement>(".req-map-node.model");
    if (!modelNodes.length) throw new Error("导图未纳入数据库／领域设计模型节点");
    const dashed = qa<SVGPathElement>(".req-map-edges path.dashed");
    if (!dashed.length) throw new Error("模型关联未使用虚线");
    const outlineText = qa<HTMLElement>(".req-map-outline .req-tree-row").map((r) => (r.textContent ?? "").trim()).join("|");
    if (!outlineText.includes("模型")) throw new Error("模型未列入导图目录");
    return `模型节点 ${modelNodes.length} 个、虚线 ${dashed.length} 条、已列入目录`;
  });

  await ui("CR-066 预览", "预览为四级需求菜单且不含左侧需求树", async () => {
    const previewBtn = byText("全文预览");
    if (!previewBtn) throw new Error("缺全文预览入口");
    click(previewBtn, "全文预览");
    await waitFor(() => qa<HTMLElement>(".req-toc-item").length > 0, 6000, "全文目录");
    if (q(".req-tree-pane")) throw new Error("预览模式仍显示左侧需求树");
    const rows = qa<HTMLElement>(".req-toc-item");
    const kinds = new Set(rows.map((r) => (r.querySelector(".req-kind")?.textContent ?? "").trim()));
    for (const need of ["Vision", "Epic", "Feature", "Story"]) {
      if (!kinds.has(need)) throw new Error(`预览目录缺 ${need} 层级（实际：${[...kinds].join(",")}）`);
    }
    const levels = rows.map((r) => Number(r.style.getPropertyValue("--toc-level")) || 0);
    if (Math.max(...levels) > 4) throw new Error(`预览目录层级超过四级（最大 ${Math.max(...levels)}）`);
    return `目录 ${rows.length} 条、类型 ${[...kinds].join("/")}、最深 ${Math.max(...levels)} 级`;
  });

  await ui("CR-066 预览", "目录折叠子章节后其下级隐藏", async () => {
    const epicRow = qa<HTMLElement>(".req-toc-item").find((r) => (r.querySelector(".req-kind")?.textContent ?? "").trim() === "Epic");
    const caret = epicRow?.querySelector<HTMLElement>("button.req-toc-caret");
    if (!caret) throw new Error("预览目录的 Epic 行缺折叠按钮");
    const before = qa<HTMLElement>(".req-toc-item").length;
    click(caret, "Epic 折叠按钮");
    await sleep(300);
    const after = qa<HTMLElement>(".req-toc-item").length;
    if (after >= before) throw new Error(`折叠后条目未减少（${before} → ${after}）`);
    const still = qa<HTMLElement>(".req-toc-item").find((r) => (r.querySelector(".req-kind")?.textContent ?? "").trim() === "Epic");
    click(still?.querySelector<HTMLElement>("button.req-toc-caret") ?? null, "Epic 展开按钮");
    await sleep(300);
    const restored = qa<HTMLElement>(".req-toc-item").length;
    if (restored !== before) throw new Error(`展开后未恢复（${before} → ${restored}）`);
    return `折叠 ${before} → ${after}，展开恢复 ${restored}`;
  });

  await ui("CR-049 滚动条", "静止无活动滑块、悬停不唤醒", async () => {
    await sleep(900); // 等待初始化渲染期间的任何滚动计时结束
    const reader = await waitFor(() => q<HTMLElement>(".req-reader"), 4000, "正文容器");
    if (reader.scrollHeight <= reader.clientHeight) {
      // 夹具正文较短时临时收窄容器制造真实滚动（仅功能断言用，不作为视觉证据；结束后恢复）。
      (reader as HTMLElement & { __smokeCss?: string }).__smokeCss = reader.style.cssText;
      reader.style.height = `${Math.max(160, Math.floor(reader.clientHeight * 0.55))}px`;
      await sleep(150);
    }
    if (reader.scrollHeight <= reader.clientHeight) throw new Error("正文没有可滚动溢出");
    if (reader.classList.contains("scrollbar-active")) throw new Error("静止时已有 scrollbar-active");
    reader.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await sleep(200);
    if (reader.classList.contains("scrollbar-active")) throw new Error("悬停不应唤醒滑块");
    if (document.documentElement.classList.contains("scrollbar-active")) throw new Error("文档根不应被唤醒");
    return "初始无 scrollbar-active；悬停/聚焦不唤醒";
  });

  await ui("CR-049 滚动条", "滚动出现→连续滚动保持→停止700ms后隐藏", async () => {
    const reader = q<HTMLElement>(".req-reader");
    if (!reader) throw new Error("正文容器缺失");
    reader.scrollTop = 120;
    await sleep(150);
    if (!reader.classList.contains("scrollbar-active")) throw new Error("滚动后未出现 scrollbar-active");
    for (let i = 0; i < 4; i++) { reader.scrollTop += 40; await sleep(160); }
    await sleep(420); // 距最后一次滚动 ~420ms < 700ms
    if (!reader.classList.contains("scrollbar-active")) throw new Error("连续滚动期间提前隐藏（计时未重置）");
    await sleep(900); // > 700ms
    if (reader.classList.contains("scrollbar-active")) throw new Error("停止后 700ms 未隐藏");
    return "滚动显示/连续重置/停止隐藏 时序通过";
  });

  await ui("CR-049 滚动条", "嵌套容器独立计时，非滚动父区不被唤醒", async () => {
    const reader = q<HTMLElement>(".req-reader");
    if (!reader) throw new Error("正文容器缺失");
    const pane = reader.closest(".req-document-pane");
    const workspace = reader.closest(".req-workspace");
    reader.scrollTop += 80;
    await sleep(120);
    if (!reader.classList.contains("scrollbar-active")) throw new Error("子容器未显示");
    if (pane?.classList.contains("scrollbar-active") || workspace?.classList.contains("scrollbar-active")) {
      throw new Error("父区被子区滚动唤醒");
    }
    await sleep(850);
    if (reader.classList.contains("scrollbar-active")) throw new Error("子容器未按自己的计时隐藏");
    const styled = reader as HTMLElement & { __smokeCss?: string };
    if (styled.__smokeCss !== undefined) { reader.style.cssText = styled.__smokeCss; delete styled.__smokeCss; }
    return "仅目标容器显示/隐藏；.req-document-pane 与 .req-workspace 均无 class";
  });

  await ui("CR-049 滚动条", "textarea 编辑容器滚动不丢内容", async () => {
    await openProjectBySearch("市场研究资料");
    const fileBtn = await waitFor(() => byText("社区活动预约调研报告.docx"), 6000, "样例文件");
    click(fileBtn, "样例文件");
    await sleep(400);
    // 样例原件只读：工具栏精确匹配按钮文案，先创建编辑副本再进入编辑。
    const toolbarBtn = (label: string) => qa<HTMLElement>(".office-editor-toolbar .btn").find(b => (b.textContent ?? "").trim() === label) ?? null;
    let editBtn = toolbarBtn("编辑");
    if (!editBtn) {
      const copyBtn = toolbarBtn("创建编辑副本");
      if (!copyBtn) throw new Error("工具栏缺编辑/创建编辑副本入口");
      click(copyBtn, "创建编辑副本");
      await sleep(400);
      editBtn = toolbarBtn("编辑");
      if (!editBtn) throw new Error("副本创建后仍缺编辑入口");
    }
    click(editBtn, "编辑");
    const area = await waitFor(() => q<HTMLTextAreaElement>(".office-prose-edit"), 5000, "正文编辑 textarea");
    const original = area.value;
    typeInto(area, `${original}CR049滚动回归探针`, "docx 段落 textarea");
    await sleep(200);
    const scroller = area.closest(".office-document-scroll") as HTMLElement | null;
    if (!scroller) throw new Error("滚动容器缺失");
    if (scroller.scrollHeight > scroller.clientHeight) {
      scroller.scrollTop = 60;
      await sleep(150);
      if (!scroller.classList.contains("scrollbar-active")) throw new Error("滚动容器未显示活动滑块");
    }
    await sleep(900);
    const after = q<HTMLTextAreaElement>(".office-prose-edit");
    if (!after) throw new Error("滚动/显隐过程中 textarea 被重挂载");
    if (!after.value.includes("CR049滚动回归探针")) throw new Error("textarea 内容丢失");
    if (after.value !== `${original}CR049滚动回归探针`) throw new Error("textarea 内容被改写");
    click(byText("阅读预览"), "退出编辑");
    await sleep(200);
    return "显隐前后 textarea 内容与挂载保持";
  });

  /* ---------- CR-052：页签紧凑与溢出下拉（UI-TAB-001，真实 DOM 行为验证） ---------- */
  await ui("CR-052 页签溢出", "对象窗口/项目页签条无横向滚动条", async () => {
    // 确保处于已打开的项目窗口内（对象页签条中的「冒烟演示项目」）。
    const winTab = byText("冒烟演示项目");
    if (winTab) { click(winTab, "对象窗口页签"); await sleep(400); }
    const bars = [
      { sel: ".nc-window-tabs", label: "对象窗口页签" },
      { sel: ".pw-top", label: "项目页签" },
    ];
    for (const bar of bars) {
      const el = q<HTMLElement>(bar.sel);
      if (!el) throw new Error(`缺页签条 ${bar.label}`);
      if (el.scrollWidth > el.clientWidth) throw new Error(`${bar.label} 出现横向溢出（scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}）`);
      if (getComputedStyle(el).overflowX !== "hidden") throw new Error(`${bar.label} overflow-x=${getComputedStyle(el).overflowX}，应为 hidden`);
    }
    return "nc-window-tabs / pw-top 均 overflow:hidden 且无横向溢出";
  });

  await ui("CR-052 页签溢出", "需求内部文档页签 28px 紧凑单行", async () => {
    const tabs = await waitFor(() => q(".req-tabs"), 6000, "需求页签条");
    await sleep(300);
    const height = tabs.getBoundingClientRect().height;
    if (Math.round(height) !== 28) throw new Error(`页签条高度 ${height}px，应为 28px`);
    const firstTab = q(".req-tab");
    if (!firstTab) throw new Error("缺页签");
    const key = firstTab.querySelector(".req-tab-key");
    const title = firstTab.querySelector(".req-tab-title");
    if (!key || !title) throw new Error("页签缺编号/标题单行结构（.req-tab-key / .req-tab-title）");
    const tabHeight = firstTab.getBoundingClientRect().height;
    if (Math.abs(tabHeight - 27) > 2) throw new Error(`页签高度 ${tabHeight}px，应约 27px`);
    const closeBtn = firstTab.querySelector(".req-tab-close");
    if (!closeBtn) throw new Error("缺关闭按钮");
    return `页签条 ${Math.round(height)}px；编号+标题单行+关闭按钮结构齐全`;
  });

  await ui("CR-052 页签溢出", "打开全部文档后收缩出现「更多」，无横向滚动条", async () => {
    const rows = qa<HTMLElement>(".req-tree-row");
    for (const row of rows) {
      const open = row.querySelector<HTMLElement>(".req-tree-open");
      if (open) click(open, "需求树行");
    }
    await sleep(400);
    const tabs = q<HTMLElement>(".req-tabs");
    if (!tabs) throw new Error("缺页签条");
    const tabCount = tabs.querySelectorAll(".req-tab").length;
    if (tabCount < 4) throw new Error(`页签数量不足：${tabCount}`);
    // 收窄文档面板制造真实溢出（恢复前不作为视觉证据）。
    const pane = tabs.closest(".req-document-pane") as HTMLElement | null;
    if (!pane) throw new Error("缺文档面板");
    (pane as HTMLElement & { __smokeRestore?: string }).__smokeRestore = pane.style.cssText;
    pane.style.flex = "0 0 300px";
    pane.style.minWidth = "300px";
    await waitFor(() => {
      const more = q(".req-tabs .tab-more");
      return more && (more as HTMLElement).style.display !== "none" ? more : null;
    }, 3000, "「更多」按钮出现");
    await sleep(200);
    if (tabs.scrollWidth > tabs.clientWidth) throw new Error("页签条出现横向溢出");
    const more = q(".req-tabs .tab-more") as HTMLElement;
    const label = more.getAttribute("aria-label") ?? "";
    if (!label.includes("另有")) throw new Error(`aria-label 未记录收起数量：${label}`);
    const hiddenTabs = qa<HTMLElement>(".req-tabs .req-tab").filter(t => t.hidden);
    if (hiddenTabs.length === 0) throw new Error("没有页签被收起");
    const activeTab = q(".req-tabs .req-tab.on") as HTMLElement | null;
    if (!activeTab || activeTab.hidden) throw new Error("选中页签未保持可见");
    return `页签 ${tabCount} 个；${label}；选中页签可见`;
  });

  await ui("CR-052 页签溢出", "下拉按序列出全部页签、点击切换并关闭", async () => {
    const more = q(".req-tabs .tab-more") as HTMLElement | null;
    if (!more) throw new Error("「更多」按钮缺失");
    click(more, "更多按钮");
    const pop = await waitFor(() => q(".tab-more-pop"), 3000, "悬浮下拉");
    const items = qa(".tab-more-item", pop);
    const allTabs = qa(".req-tabs .req-tab");
    if (items.length !== allTabs.length) throw new Error(`下拉项 ${items.length} 与页签 ${allTabs.length} 不一致`);
    if (!(pop.textContent ?? "").includes(`共 ${allTabs.length} 个页签`)) throw new Error("下拉缺计数标题");
    const onItem = items.find(item => item.classList.contains("on"));
    if (!onItem) throw new Error("下拉未标注当前页签");
    const target = items.find(item => !item.classList.contains("on"));
    if (!target) throw new Error("无可切换项");
    const targetLabel = target.querySelector(".ellipsis")?.textContent ?? "";
    click(target, "下拉项");
    await sleep(300);
    if (q(".tab-more-pop")) throw new Error("选择后下拉未关闭");
    const activeTitle = q<HTMLElement>(".req-tabs .req-tab.on .req-tab-title")?.textContent ?? "";
    if (activeTitle !== targetLabel) throw new Error(`切换失败：期望「${targetLabel}」实际「${activeTitle}」`);
    return `下拉 ${items.length} 项含高亮；点击切换至「${targetLabel}」并关闭`;
  });

  await ui("CR-052 页签溢出", "Escape 关闭下拉；收缩恢复后「更多」消失", async () => {
    const more = q(".req-tabs .tab-more") as HTMLElement | null;
    if (!more) throw new Error("「更多」按钮缺失");
    click(more, "更多按钮");
    await waitFor(() => q(".tab-more-pop"), 3000, "悬浮下拉");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(200);
    if (q(".tab-more-pop")) throw new Error("Escape 未关闭下拉");
    const pane = q(".req-document-pane") as (HTMLElement & { __smokeRestore?: string }) | null;
    if (!pane) throw new Error("缺文档面板");
    pane.style.cssText = pane.__smokeRestore ?? "";
    delete pane.__smokeRestore;
    // 真实文档面板（约 450px）放不下 4 个页签，机制保持「更多」是正确行为；
    // 断言「放得下时消失」需要一个确实放得下的宽度（页签总宽约 700px）。
    pane.style.flex = "0 0 780px";
    pane.style.minWidth = "780px";
    await sleep(600);
    const tabs = q<HTMLElement>(".req-tabs");
    if (!tabs) throw new Error("缺页签条");
    const moreAfter = q(".req-tabs .tab-more") as HTMLElement | null;
    const fitsNow = tabs.scrollWidth <= tabs.clientWidth;
    if (!fitsNow) throw new Error(`780px 面板仍溢出：scrollWidth ${tabs.scrollWidth} > clientWidth ${tabs.clientWidth}`);
    if (moreAfter && moreAfter.style.display !== "none") {
      throw new Error(`放得下时「更多」仍显示（display=${moreAfter.style.display}，clientWidth=${tabs.clientWidth}）`);
    }
    const hiddenTabs = qa<HTMLElement>(".req-tabs .req-tab").filter(t => t.hidden);
    if (hiddenTabs.length > 0) throw new Error("恢复宽度后仍有页签被隐藏");
    if (tabs.scrollWidth > tabs.clientWidth) throw new Error("恢复宽度后页签条仍溢出");
    click(byText("项目管理"), "返回项目列表");
    await sleep(400);
    return "Escape 关闭；放得下时「更多」不显示不占位，页签全部恢复";
  });

  /* ---------- CR-054：会话中心工作台 ---------- */
  await ui("工作台", "默认进入工作台且页签为纯图标", async () => {
    click(byText("项目管理"), "返回项目列表");
    await sleep(400);
    const card = await waitFor(() => q<HTMLElement>(".nc-list-row, .proj-card, [data-project]"), 6000, "项目卡");
    click(card, "打开项目");
    await sleep(700);
    const iconTab = await waitFor(() => q<HTMLElement>(".pw-tab.wb-tab-icon"), 6000, "工作台图标页签");
    if (iconTab.getAttribute("aria-selected") !== "true") throw new Error("默认未选中工作台页签");
    if ((iconTab.textContent ?? "").trim()) throw new Error("工作台页签不应显示文字");
    if (iconTab.getAttribute("aria-label") !== "工作台") throw new Error("工作台页签缺少 aria-label");
    return "纯图标页签、aria-label=工作台、默认选中";
  });

  await ui("工作台", "三栏结构与单实例会话", async () => {
    const shell = await waitFor(() => q(".wb-shell"), 6000, "工作台容器");
    if (!q(".wb-hist", shell)) throw new Error("缺左栏会话历史");
    if (!q(".wb-conv", shell)) throw new Error("缺中栏当前会话");
    const panels = qa(".nc-chat-host .chat-panel").length;
    if (panels !== 0) throw new Error(`工作台页签下不应渲染侧栏 ChatPanel（实际 ${panels}）`);
    const inner = qa(".wb-conv .chat-panel").length;
    if (inner !== 1) throw new Error(`工作台内 ChatPanel 实例应为 1（实际 ${inner}）`);
    const hist = q(".wb-hist .chat-history-list");
    if (!hist) throw new Error("左栏未复用会话列表结构");
    return `左栏复用 chat-history-list；工作台内 ChatPanel=1、侧栏=0`;
  });

  await ui("工作台", "切页签不卸载会话", async () => {
    const before = q(".wb-conv .chat-panel");
    if (!before) throw new Error("切换前缺会话面板");
    const tab = qa<HTMLElement>(".pw-tab").find(t => (t.textContent ?? "").trim().length > 0);
    click(tab ?? null, "切到文字页签");
    await sleep(500);
    const stillMounted = q(".wb-conv .chat-panel");
    if (!stillMounted) throw new Error("切页签后会话面板被卸载（应 hidden 保留）");
    const iconTab = q<HTMLElement>(".pw-tab.wb-tab-icon");
    click(iconTab, "切回工作台");
    await sleep(400);
    if (q(".wb-conv .chat-panel") !== stillMounted) throw new Error("切回后会话实例被重建");
    return "切页签 hidden 保留挂载，实例未重建";
  });
}

export function uiReportSuffix(): string {
  const pass = uiResults.filter((r) => r.ok).length;
  const fail = uiResults.length - pass;
  const lines = ["", `## UI 交互自检（真实 DOM）`, "", `- 结果：**${pass} 通过 / ${fail} 失败 / 共 ${uiResults.length}**`, ""];
  let last = "";
  for (const r of uiResults) {
    if (r.section !== last) {
      lines.push(`### UI · ${r.section}`, "", "| 用例 | 结果 | 说明 |", "| --- | --- | --- |");
      last = r.section;
    }
    lines.push(`| ${r.name} | ${r.ok ? "PASS" : "**FAIL**"} | ${r.detail.replace(/\|/g, "/")} |`);
  }
  return lines.join("\n");
}
