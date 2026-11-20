/**
 * UI 层自检：在真实 DOM 上用原生事件走通各模块核心交互（点击/输入/断言渲染结果）。
 * 与 IPC 套件互补：IPC 验证后端契约，本套件验证界面真的能操作、状态真的更新。
 */

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
    click(byText("设置与账户"), "设置入口");
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
    const histBtn = await waitFor(() => q("[data-act='chat-history-toggle']"), 4000, "历史按钮");
    click(histBtn, "历史按钮");
    const overlay = await waitFor(() => q('.chat-history'), 3000, "历史浮层");
    if (!(overlay.textContent ?? "").includes("会话历史")) throw new Error("浮层缺标题");
    if (!(overlay.textContent ?? "").includes("新会话")) throw new Error("浮层缺新会话入口");
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
