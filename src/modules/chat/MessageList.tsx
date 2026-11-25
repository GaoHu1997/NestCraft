import { Icon } from "@/components/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "@/components/ui";
import { useToast } from "@/components/ui";
import type { ToastKind } from "@/components/ui";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { AttachmentMeta, ChatMessage, ContextRef } from "@/api";
import { requestLocate } from "@/modules/locate";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { toolDisplayName } from "./sessionRuntime";
import { AttachmentImages, ImageGallery, type GalleryItem } from "./AttachmentImages";
import { changedInputPaths, classifyTool, formatMessageDuration, presentAgent, presentToolInput, summarizeTools, toolFailed, workDurationMs, type ToolCategory } from "./messagePresentation";
import { TurnNavigator, type TurnNavItem } from "./TurnNavigator";
import "./message-zcode.css";

/**
 * 消息流渲染（CR-034 / STORY-062）：
 * - 同一 toolId 的调用与结果配对为统一工具块（头部：工具名/参数摘要/状态/耗时估算；
 *   结果默认折叠，失败展开摘要）；配对缺失单侧成块并标注原因，不伪造配对（AC-01~03）；
 * - 图片等比缩放（宽≤100%、高≤360px）、点击放大浮层、失败占位（AC-04~06）；
 * - `路径:行[:列]` 渲染为链接，点击定位到编码区行；无项目上下文时退化为复制路径（AC-07~11）；
 * - CR-076 最新截图：中性过程摘要、思考真实时长、紧凑子代理；全部原文可展开。
 */

export type UiRole = ChatMessage["role"] | "error" | "subagent";

export interface UiMessage {
  id: string;
  role: UiRole;
  content: string;
  thinking: string | null;
  toolId: string | null;
  toolName: string | null;
  isError: boolean;
  inputJson: string | null;
  toolOutput?: string | null;
  exitCode?: number | null;
  refs: ContextRef[] | null;
  usage: { input: number; output: number } | null;
  model?: string | null;
  createdAt?: number;
  attachments?: AttachmentMeta[];
  streaming?: boolean;
  /** CR-056：思考阶段耗时（毫秒）。未知时仅显示思考，不编造时长。 */
  thinkingMs?: number | null;
  /** 来源标签：cli/model/agent 等，未知时由渲染层显示可读未知状态。 */
  sourceLabel?: string | null;
  producerId?: string | null;
  producerTask?: string | null;
  /** 产生这条内容的 CLI；子智能体未单独上报时继承父轮 CLI。 */
  cli?: string | null;
  /** CR-056：system 消息的 kind（context-breakpoint = 上下文断点卡）。 */
  kind?: string | null;
}

export interface OfficeFileRef {
  id: string;
  name: string;
  path: string;
}

function parseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** 构造渲染消息：缺省字段统一填充 */
export function mkMsg(p: Partial<UiMessage> & Pick<UiMessage, "id" | "role">): UiMessage {
  return {
    content: "",
    thinking: null,
    toolId: null,
    toolName: null,
    isError: false,
    inputJson: null,
    refs: null,
    usage: null,
    sourceLabel: null,
    producerId: null,
    producerTask: null,
    thinkingMs: null,
    cli: null,
    ...p,
  };
}

/** 后端 ChatMessage -> 渲染模型（metaJson：thinking / usage / toolId / input / isError） */
export function fromChatMessage(m: ChatMessage): UiMessage {
  const meta = parseJson<Record<string, unknown>>(m.metaJson) ?? {};
  const refs = parseJson<ContextRef[]>(m.refsJson);
  const u = (meta.usage ?? null) as { inputTokens?: number; outputTokens?: number } | null;
  return {
    id: m.id,
    role: m.role,
    content: m.role === "tool_use" ? "" : m.content,
    thinking: typeof meta.thinking === "string" ? meta.thinking : null,
    toolId: typeof meta.toolId === "string" ? meta.toolId : null,
    toolName: m.role === "tool_use" ? m.content : null,
    isError: meta.isError === true,
    inputJson: typeof meta.input === "string" ? meta.input : null,
    toolOutput: typeof meta.toolOutput === "string" ? meta.toolOutput : null,
    exitCode: typeof meta.exitCode === "number" ? meta.exitCode : null,
    refs: Array.isArray(refs) ? refs : null,
    model: typeof meta.model === "string" ? meta.model : typeof meta.modelId === "string" ? meta.modelId : null,
    createdAt: m.createdAt,
    attachments: Array.isArray(meta.attachments) ? meta.attachments as AttachmentMeta[] : [],
    usage: u ? { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0 } : null,
    sourceLabel: typeof meta.sourceLabel === "string" ? meta.sourceLabel : typeof meta.cli === "string" ? meta.cli : null,
    producerId: typeof meta.producerId === "string" ? meta.producerId : null,
    producerTask: typeof meta.producerTask === "string" ? meta.producerTask : null,
    kind: typeof meta.kind === "string" ? meta.kind : null,
    thinkingMs: typeof meta.thinkingMs === "number" ? meta.thinkingMs : null,
  };
}

/* ---------- 图片路径解析 ---------- */

function resolveImgSrc(src: string, rootUri?: string): string {
  if (/^(https?|data|blob|asset|http):/i.test(src)) return src;
  const abs = /^([a-zA-Z]:[\\/]|\/)/.test(src);
  const p = abs ? src : rootUri ? `${rootUri.replace(/[\\/]+$/, "")}/${src.replace(/^[\\/]+/, "")}` : src;
  try {
    return convertFileSrc(p);
  } catch {
    return p;
  }
}

/* ---------- Markdown 块（含图片/文件链接后处理） ---------- */

function Md(props: {
  text: string;
  projectId?: string;
  rootUri?: string;
  officeFiles?: OfficeFileRef[];
  canLocate: boolean;
  onImageOpen: (src: string, alt: string, el: HTMLElement) => void;
}) {
  const [html, setHtml] = useState("");
  const hostRef = useRef<HTMLDivElement | null>(null);
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    if (!props.text) {
      setHtml("");
      return;
    }
    renderMarkdown(props.text)
      .then(h => alive && setHtml(h))
      .catch(() => alive && setHtml(""));
    return () => {
      alive = false;
    };
  }, [props.text]);

  // 渲染后处理：图片约束/解析 + 文件路径链接化（AC-04~07）
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !html) return;

    // 重新处理时回到原始HTML，避免重复监听和双重链接化。
    host.innerHTML = html;
    // 表格保留原生横向滚动，宽屏铺满正文，窄屏不挤压消息宽度。
    for (const table of Array.from(host.querySelectorAll("table"))) {
      const wrapper = document.createElement("div");
      wrapper.className = "chat-table-scroll";
      table.before(wrapper);
      wrapper.appendChild(table);
    }

    // 代码块工具栏：语言标签 + 复制 + 自动换行（对齐 ZCode 代码块头）
    for (const pre of Array.from(host.querySelectorAll("pre"))) {
      if (pre.closest(".chat-code-block")) continue;
      const code = pre.querySelector("code");
      const langMatch = /(?:^|\s)language-([\w+#.-]+)/.exec(code?.className ?? "");
      const block = document.createElement("div");
      block.className = "chat-code-block";
      const head = document.createElement("div");
      head.className = "chat-code-head";
      const label = document.createElement("span");
      label.className = "chat-code-lang";
      label.textContent = langMatch ? langMatch[1] : "代码";
      const actions = document.createElement("div");
      actions.className = "chat-code-actions";
      const copyBtn = document.createElement("button");
      copyBtn.type = "button"; copyBtn.className = "chat-code-btn"; copyBtn.textContent = "复制"; copyBtn.title = "复制代码"; copyBtn.setAttribute("aria-label", "复制代码");
      copyBtn.addEventListener("click", () => {
        const text = code?.textContent ?? "";
        try {
          navigator.clipboard?.writeText(text).then(() => {
            copyBtn.textContent = "已复制";
            window.setTimeout(() => { copyBtn.textContent = "复制"; }, 1200);
          }).catch(() => {});
        } catch { /* 非安全上下文：忽略 */ }
      });
      const wrapBtn = document.createElement("button");
      wrapBtn.type = "button"; wrapBtn.className = "chat-code-btn"; wrapBtn.textContent = "换行"; wrapBtn.title = "自动换行"; wrapBtn.setAttribute("aria-label", "自动换行");
      wrapBtn.addEventListener("click", () => { const on = pre.classList.toggle("chat-code-wrap"); wrapBtn.classList.toggle("on", on); });
      actions.append(copyBtn, wrapBtn);
      head.append(label, actions);
      pre.before(block);
      block.append(head, pre);
    }

    // 1) 图片：等比缩放、本地路径解析、点击放大、失败占位
    for (const img of Array.from(host.querySelectorAll("img"))) {
      const raw = img.getAttribute("src") ?? "";
      img.classList.add("chat-img");
      img.setAttribute("referrerpolicy", "no-referrer");
      const alt = img.getAttribute("alt") || "图片";
      img.setAttribute("alt", alt);
      const resolved = resolveImgSrc(raw, props.rootUri);
      if (resolved !== raw) img.setAttribute("src", resolved);
      img.addEventListener("error", () => {
        img.classList.add("chat-img-broken");
        const ph = document.createElement("span");
        ph.className = "chat-img-placeholder";
        ph.textContent = `图片加载失败：${raw}`;
        img.replaceWith(ph);
      }, { once: true });
      img.addEventListener("click", () => props.onImageOpen(resolved, alt, img), { once: false });
    }

    // 2) 文件链接：文本节点中的 `路径:行[:列]`（含 code/文字；跳过已有链接内）
    const nameGroups = new Map<string, OfficeFileRef[]>();
    for (const f of props.officeFiles ?? []) nameGroups.set(f.name, [...(nameGroups.get(f.name) ?? []), f]);
    const officeByName = new Map([...nameGroups].filter(([, group]) => group.length === 1).map(([name, group]) => [name, group[0]]));
    const officeByPath = new Map((props.officeFiles ?? []).map(f => [f.path.replaceAll("\\", "/"), f]));
    // 路径不含空格；必须以 扩展名:数字 结尾；URL（://…）不作为文件链接
    const pattern = /((?:[A-Za-z]:[\\/])?[^\s<>"'`，。；：！？（）\[\]{}]+\.[A-Za-z0-9]{1,8}):(\d{1,6})(?::(\d{1,6}))?/;
    const prepareLink = (a: HTMLAnchorElement, path: string, line?: string, col?: string) => {
      a.classList.add("chat-loc"); a.dataset.path = path;
      if (line) a.dataset.line = line;
      if (col) a.dataset.col = col;
      a.href = "#";
      a.title = props.canLocate ? "点击打开并定位到该行" : "无项目上下文：点击复制路径";
    };
    // Markdown 显式文件链接也必须接入定位（保留真实HTTP链接原行为）。
    for (const a of Array.from(host.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
      const href = a.getAttribute("href") ?? "";
      if (/^(?:https?:|mailto:|data:|javascript:|#)/i.test(href)) continue;
      const match = pattern.exec(href);
      if (match) prepareLink(a, match[1], match[2], match[3]);
      else if (/\.[a-z0-9]{1,8}$/i.test(href)) prepareLink(a, href);
    }
    const walk = (node: Text) => {
      const text = node.textContent ?? "";
      if (!text || text.length > 2000) return;
      if (node.parentElement?.closest("a")) return;
      if (!/\.\w{1,8}:\d/.test(text)) return;
      const frag = document.createDocumentFragment();
      let rest: string = text;
      let made = false;
      while (rest) {
        const m = pattern.exec(rest);
        // 排除 URL 中的伪路径（:// 前缀）
        if (!m || rest.slice(Math.max(0, m.index - 8), m.index).endsWith("://")) {
          frag.appendChild(document.createTextNode(rest));
          break;
        }
        const before = rest.slice(0, m.index);
        if (before) frag.appendChild(document.createTextNode(before));
        const a = document.createElement("a");
        a.className = "chat-loc";
        const path = m[1];
        const line = m[2];
        const col = m[3];
        if (m[1].includes("://")) {
          frag.appendChild(document.createTextNode(before + m[0]));
          rest = rest.slice(m.index + m[0].length);
          continue;
        }
        prepareLink(a, path, line, col);
        a.textContent = `${path}${line ? `:${line}` : ""}${col ? `:${col}` : ""}`;
        a.setAttribute("title", props.canLocate ? "点击打开并定位到该行" : "无项目上下文：点击复制路径");
        frag.appendChild(a);
        made = true;
        rest = rest.slice(m.index + m[0].length);
      }
      if (made) node.replaceWith(frag);
    };

    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
    texts.forEach(walk);

    // 3) 办公文件名引用（CR-043：文件引用可定位同一树节点）
    if (officeByName.size > 0) {
      for (const a of Array.from(host.querySelectorAll<HTMLElement>("a.chat-loc"))) {
        const name = (a.dataset.path ?? "").split(/[\\/]/).pop() ?? "";
        const f = officeByPath.get((a.dataset.path ?? "").replaceAll("\\", "/")) ?? officeByName.get(name);
        if (f) {
          a.dataset.officeFile = f.id;
          a.dataset.officeProject = props.projectId ?? "";
        }
      }
      // 无行号的纯文件名（如 `报告.docx`）也链接化
      const walker2 = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      const texts2: Text[] = [];
      while (walker2.nextNode()) texts2.push(walker2.currentNode as Text);
      for (const node of texts2) {
        const text = node.textContent ?? "";
        if (!text || node.parentElement?.closest("a")) continue;
        let replaced = false;
        const frag = document.createDocumentFragment();
        let rest = text;
        while (rest) {
          let hit: { name: string; id: string; idx: number } | null = null;
          for (const [name, f] of officeByName) {
            const idx = rest.indexOf(name);
            if (idx >= 0 && (hit == null || idx < hit.idx)) hit = { name, id: f.id, idx };
          }
          if (!hit) {
            frag.appendChild(document.createTextNode(rest));
            break;
          }
          if (hit.idx > 0) frag.appendChild(document.createTextNode(rest.slice(0, hit.idx)));
          const a = document.createElement("a");
          a.className = "chat-loc";
          a.dataset.officeFile = hit.id;
          a.href = "#";
          a.textContent = hit.name;
          a.setAttribute("title", "点击定位到项目文件树");
          frag.appendChild(a);
          replaced = true;
          rest = rest.slice(hit.idx + hit.name.length);
        }
        if (replaced) node.replaceWith(frag);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, props.projectId, props.rootUri, props.canLocate, props.officeFiles]);

  // 链接点击统一处理（事件委托）
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest("a.chat-loc") as HTMLElement | null;
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      const officeId = a.dataset.officeFile;
      if (officeId && props.projectId) {
        requestLocate({ kind: "office-file", projectId: props.projectId!, fileId: officeId });
        return;
      }
      const path = a.dataset.path ?? "";
      const line = a.dataset.line ? Number(a.dataset.line) : undefined;
      const col = a.dataset.col ? Number(a.dataset.col) : undefined;
      if (props.canLocate) {
        requestLocate({ kind: "file", path, line, col, projectId: props.projectId, rootUri: props.rootUri });
      } else {
        navigator.clipboard?.writeText(path).catch(() => {});
        toast("当前会话未绑定项目目录，已复制路径", "warn");
      }
    };
    host.addEventListener("click", onClick);
    return () => host.removeEventListener("click", onClick);
  }, [props.canLocate, props.projectId, props.rootUri, toast]);

  return <div className="chat-md" ref={hostRef} dangerouslySetInnerHTML={{ __html: html }} />;
}

/* ---------- 工具块：同一 toolId 的调用与结果配对（AC-01~03） ---------- */

interface ToolPair {
  toolId: string;
  name: string | null;
  inputJson: string | null;
  result: { content: string; isError: boolean } | null;
  useMsg: UiMessage | null;
  resultMsg: UiMessage | null;
}

type ToolItem = { kind: "tool"; pair: ToolPair; part: "call" | "result" | "both" };
type Block = UiMessage | ToolItem;

function buildBlocks(msgs: UiMessage[]): Block[] {
  const out: Block[] = [];
  const pending = new Map<string, ToolItem>();
  for (const m of msgs) {
    if (m.role === "user") pending.clear();
    if (m.role === "system" && m.kind === "planUpdate") continue;
    if (m.role === "tool_use" && m.toolId) {
      const item: ToolItem = {
        kind: "tool", part: "call",
        pair: { toolId: m.toolId, name: m.toolName, inputJson: m.inputJson, result: null, useMsg: m, resultMsg: null },
      };
      out.push(item);
      pending.set(m.toolId, item);
      continue;
    }
    if (m.role === "tool_result" && m.toolId) {
      const call = pending.get(m.toolId);
      const pair: ToolPair = call?.pair ?? { toolId: m.toolId, name: null, inputJson: null, result: null, useMsg: null, resultMsg: null };
      pair.result = { content: m.content, isError: m.isError };
      pair.resultMsg = m;
      if (call && out[out.length - 1] === call) call.part = "both";
      else out.push({ kind: "tool", part: "result", pair });
      pending.delete(m.toolId);
      continue;
    }
    out.push(m);
  }
  return out;
}

function ToolSummaryIcon({ category }: { category: ToolCategory }) {
  return <Icon name={category === "change" ? "edit" : category === "run" ? "terminal" : category === "explore" ? "search" : "wrench"} size={16} />;
}

function BrainOutline() {
  return <svg className="chat-thinking-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5c-1-3-6-2-6 1-3 0-4 5-2 7-1 3 1 6 4 6 0 3 4 3 4 0V5Zm0 0c1-3 6-2 6 1 3 0 4 5 2 7 1 3-1 6-4 6 0 3-4 3-4 0" /><path d="M6 6c0 2 1 3 3 3M4 13c2-1 4 0 4 2M18 6c0 2-1 3-3 3m5 4c-2-1-4 0-4 2" /></svg>;
}

function ToolBlock({ pair, part }: ToolItem) {
  const item = { pair, part };
  const running = pair.result == null && !!pair.useMsg?.streaming;
  const orphanResult = pair.useMsg == null;
  const orphanUse = pair.result == null && !running;
  const failed = toolFailed(item);
  const status = failed ? "fail" : running ? "run" : pair.result ? "ok" : "pending";
  const statusText = part === "call" && pair.result ? "结果见下方" : orphanResult ? `来源调用未记录${failed ? " · 失败" : ""}` : failed ? "失败" : running ? "执行中" : orphanUse ? "结果未返回" : "完成";
  const failureSummary = part !== "call" && failed
    ? pair.result?.content.trim().replace(/\s+/g, " ").slice(0, 160) || "工具执行失败，未返回错误详情"
    : "";
  const { inputText, command, parametersText } = presentToolInput(pair.inputJson);
  const output = part === "call" && pair.result ? null : pair.result?.content ?? pair.useMsg?.toolOutput;
  const exitCode = part === "call" ? null : pair.resultMsg?.exitCode ?? pair.useMsg?.exitCode;
  const summary = summarizeTools([item]);
  return (
    <div className="chat-msg">
      <div className={`chat-toolblock ${status}`}>
        <details className="chat-tool-detail">
          <summary className="chat-tool-summary" aria-label={summary.text}><ToolSummaryIcon category={summary.category} /><span>{summary.text}</span><Icon className="chat-tool-chevron" name="chevronRight" size={14} /></summary>
          <div className="chat-toolblock-head">
            <span className="chat-tool-name">{toolDisplayName(pair.name) ?? pair.name ?? "工具调用"}{part === "result" && " · 结果"}</span>
            <span className={`chat-tool-state st-${status}`}>{statusText}{exitCode != null && ` · 退出码 ${exitCode}`}</span>
          </div>
          {failureSummary && <div className="chat-tool-fail-summary" title={pair.result?.content}>{failureSummary}</div>}
          {command !== null ? <pre className="chat-tool-command">{command || "（命令未记录）"}</pre> : inputText !== null && <pre>{inputText}</pre>}
          {parametersText && parametersText !== "{}" && <pre title="输入参数">{parametersText}</pre>}
          {output != null && <pre className={failed ? "chat-tool-err" : ""}>{output || "（无输出）"}</pre>}
          {exitCode != null && <div className="chat-tool-exit">退出码 {exitCode}</div>}
        </details>
      </div>
    </div>
  );
}
interface Turn {
  id: string;
  user: UiMessage | null;
  reply: Block[];
}

function buildTurns(blocks: Block[]): Turn[] {
  const turns: Turn[] = [];
  for (const block of blocks) {
    if (!("pair" in block) && block.role === "user") {
      turns.push({ id: block.id, user: block, reply: [] });
    } else {
      if (!turns.length) turns.push({ id: "history-start", user: null, reply: [] });
      turns[turns.length - 1].reply.push(block);
    }
  }
  return turns;
}

function toolKey({ pair, part }: ToolItem) { return (part === "result" ? pair.resultMsg?.id : pair.useMsg?.id) ?? pair.toolId; }

function ExecutionProcess({ blocks, working, visible, startedAt, endedAt, renderMessage }: {
  blocks: Block[];
  working: boolean;
  visible: boolean;
  startedAt?: number;
  endedAt?: number;
  renderMessage: (m: UiMessage) => React.ReactNode;
}) {
  const [open, setOpen] = useState(working);
  const wasWorking = useRef(working);
  const [clock, setClock] = useState<number | undefined>();
  useEffect(() => {
    if (wasWorking.current !== working) setOpen(working);
    wasWorking.current = working;
  }, [working]);
  useEffect(() => {
    if (!working || !visible || startedAt == null || !Number.isFinite(startedAt)) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      if (!document.hidden) {
        setClock(Date.now());
        timer = setInterval(() => setClock(Date.now()), 1000);
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => { if (timer !== undefined) clearInterval(timer); document.removeEventListener("visibilitychange", sync); };
  }, [working, visible, startedAt]);
  const steps: (UiMessage | ToolItem | ToolItem[])[] = [];
  for (const block of blocks) {
    if ("pair" in block && classifyTool(block.pair.name) !== null) {
      const last = steps[steps.length - 1];
      if (Array.isArray(last)) last.push(block);
      else steps.push([block]);
    } else steps.push(block);
  }
  const hasError = blocks.some(block => "pair" in block ? toolFailed(block) : block.role === "error");
  const duration = workDurationMs(startedAt, working ? clock : endedAt);
  const label = `${working ? "工作中" : "已工作"}${duration !== null ? ` ${formatMessageDuration(duration)}` : ""}`;
  return <details className="chat-turn-process" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary title="时长按本轮用户消息至最后记录的时间跨度估算，不代表实际运行耗时"><span className="chat-process-label">{label}</span><Icon className="chat-process-chevron" name="chevronRight" size={16} />{hasError && <span className="chat-process-status">有错误</span>}</summary>
    <div className="chat-turn-process-body">
      {steps.map(step => {
        if (!Array.isArray(step)) return "pair" in step ? <ToolBlock key={toolKey(step)} {...step} /> : renderMessage(step);
        if (step.length < 2) return <ToolBlock key={toolKey(step[0])} {...step[0]} />;
        const summary = summarizeTools(step);
        return <details className="chat-tool-group" key={toolKey(step[0])}>
          <summary aria-label={summary.text}><ToolSummaryIcon category={summary.category} /><span>{summary.text}</span><Icon className="chat-group-chevron" name="chevronRight" size={14} /></summary>
          <div className="chat-tool-group-body">{step.map(item => <ToolBlock key={toolKey(item)} {...item} />)}</div>
        </details>;
      })}
    </div>
  </details>;
}
/* ---------- 消息列表 ---------- */

export function MessageList(props: {
  msgs: UiMessage[];
  projectId?: string;
  rootUri?: string;
  officeFiles?: OfficeFileRef[];
  visible?: boolean;
  /** 本轮从提交到 settled 的 working 状态；独立于 assistant 消息创建。 */
  working?: boolean;
  stepsSlot?: React.ReactNode;
  /** CR-062：点开子智能体只读详情。 */
  onOpenAgent?: (agentId: string) => void;
  /** 新增（可选）：会话级滚动记忆键；缺失时以首条消息 id 兜底。 */
  sessionKey?: string;
  /** 新增（可选）：在该轮尾的终止错误消息上渲染「重试」。 */
  onRetryTurn?: (errorMsgId: string) => void;
  /** 新增（可选）：在用户消息上渲染「编辑」。 */
  onEditUserMessage?: (msgId: string, text: string) => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const toast = useToast();
  const canLocate = !!props.rootUri || (props.officeFiles?.length ?? 0) > 0;
  // 正文 Markdown 图片画廊：点击任一图片，可在该消息全部 Markdown 图片间切换（复用附件预览 UI）。
  const [gallery, setGallery] = useState<{ items: GalleryItem[]; index: number; back: HTMLElement } | null>(null);
  // 会话级滚动记忆（内存 Map）；键优先取 sessionKey，缺失时用首条消息 id 兜底。
  const scrollMemory = useRef<Map<string, number>>(new Map());
  const activeKeyRef = useRef<string | null>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [activeTurnId, setActiveTurnId] = useState<string | undefined>(undefined);
  const sessionKey = props.sessionKey ?? props.msgs[0]?.id ?? "chat";

  const syncScrollState = () => {
    const el = boxRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    stickRef.current = near;
    setShowScrollBottom(prev => (prev === !near ? prev : !near));
  };

  const syncActiveTurn = () => {
    const el = boxRef.current;
    if (!el) return;
    const secs = Array.from(el.querySelectorAll<HTMLElement>(".chat-turn[data-turn-id]"));
    if (!secs.length) { setActiveTurnId(undefined); return; }
    const boxTop = el.getBoundingClientRect().top;
    let best: HTMLElement = secs[0], bestDist = Infinity;
    for (const s of secs) {
      const d = Math.abs(s.getBoundingClientRect().top - boxTop - 8);
      if (d < bestDist) { bestDist = d; best = s; }
    }
    setActiveTurnId(best.getAttribute("data-turn-id") ?? undefined);
  };

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    syncScrollState();
    syncActiveTurn();
    // 记录当前会话的阅读位置；内存保存，不写持久化。
    scrollMemory.current.set(sessionKey, el.scrollTop);
  };

  // 切换会话时恢复 scrollTop；同会话新消息仅在底部附近时贴底；滚动位置写入 Map。
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    if (activeKeyRef.current !== sessionKey) {
      activeKeyRef.current = sessionKey;
      const saved = scrollMemory.current.get(sessionKey);
      if (saved != null) {
        el.scrollTop = saved;
        syncScrollState();
        // Markdown 异步渲染会撑开高度，下一帧再校正一次以贴近记忆位置。
        const raf = window.requestAnimationFrame(() => {
          const cur = boxRef.current;
          if (cur && activeKeyRef.current === sessionKey) { cur.scrollTop = saved; syncScrollState(); }
        });
        return () => window.cancelAnimationFrame(raf);
      }
      el.scrollTop = el.scrollHeight;
      stickRef.current = true;
      setShowScrollBottom(false);
      return;
    }
    if (stickRef.current) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, props.msgs]);

  const scrollToBottom = () => {
    const el = boxRef.current;
    if (!el) return;
    stickRef.current = true;
    setShowScrollBottom(false);
    try { el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); }
    catch { el.scrollTop = el.scrollHeight; }
  };

  const turns = useMemo(() => buildTurns(buildBlocks(props.msgs)), [props.msgs]);
  const navItems = useMemo<TurnNavItem[]>(() => turns.map((t, i) => ({ id: t.id, label: `第 ${i + 1} 轮 · ${(t.user?.content ?? "会话开始").replace(/\s+/g, " ").slice(0, 24)}`, kind: "user" as const })), [turns]);
  const jumpToTurn = (id: string) => {
    const el = boxRef.current?.querySelector<HTMLElement>(`.chat-turn[data-turn-id="${typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id}"]`);
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  // 回合导航：消息变化时刷新当前回合高亮（滚动时由 onScroll 更新）。
  useEffect(() => {
    syncActiveTurn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns.length, sessionKey]);
  const workingSince = useMemo(() => {
    for (let i = props.msgs.length - 1; i >= 0; i -= 1) {
      const m = props.msgs[i];
      if (m.role === "user" && m.createdAt != null) return m.createdAt;
    }
    return undefined;
  }, [props.msgs]);

  if (props.msgs.length === 0 && !props.stepsSlot && !props.working) {
    return (
      <div className="chat-msgs chat-zcode-messages" style={{ justifyContent: "center" }}>
        <div className="chat-empty">
          <div className="chat-empty-icon" aria-hidden>
            <Icon name="message" size={26} />
          </div>
          <div className="chat-empty-title">开始新的对话</div>
          <div className="small">在下方输入消息；@ 可引用项目文件与知识库，/ 选择能力</div>
        </div>
      </div>
    );
  }

  // 点击正文图片：从该消息 .chat-md 收集全部 Markdown 图片，打开可在其间切换的画廊。
  const openMarkdownGallery = (src: string, alt: string, el: HTMLElement) => {
    const host = el.closest(".chat-md");
    const imgs = host ? Array.from(host.querySelectorAll<HTMLImageElement>("img")) : [];
    const items: GalleryItem[] = imgs.map(img => ({ src: img.getAttribute("src") ?? "", name: img.getAttribute("alt") || "图片" }));
    if (!items.length) items.push({ src, name: alt });
    const index = Math.max(0, imgs.indexOf(el as HTMLImageElement));
    setGallery({ items, index, back: el });
  };
  const renderMessage = (m: UiMessage, opts: { replyActions?: boolean; onRetry?: () => void; onEdit?: () => void } = {}) => <MessageRow key={m.id} m={m} showReplyActions={opts.replyActions} onRetry={opts.onRetry} onEdit={opts.onEdit} projectId={props.projectId} rootUri={props.rootUri} officeFiles={props.officeFiles} canLocate={canLocate} onOpenAgent={props.onOpenAgent} onImageOpen={openMarkdownGallery} />;
  return (
    <>
      <div className="chat-msgs-wrap">
        <div className="chat-msgs chat-zcode-messages" ref={boxRef} onScroll={onScroll}>
          {turns.map((turn, index) => {
            const user = turn.user;
            const working = !!props.working && index === turns.length - 1;
            const tail = turn.reply[turn.reply.length - 1];
            const final = !working && tail && !("pair" in tail) && tail.role === "assistant" && !!tail.content && !tail.streaming ? tail : null;
            const terminalError = tail && !("pair" in tail) && tail.role === "error" ? tail : null;
            const process = final || terminalError ? turn.reply.slice(0, -1) : turn.reply;
            const endedAt = turn.reply.flatMap(block => "pair" in block ? [block.pair.useMsg?.createdAt, block.pair.resultMsg?.createdAt] : [block.createdAt]).filter((at): at is number => at != null && Number.isFinite(at));
            const hasProcess = process.some(block => "pair" in block || block.thinking || block.role === "subagent" || block.role === "assistant");
            const changedFiles = Array.from(new Set(turn.reply.flatMap(block => "pair" in block && classifyTool(block.pair.name) === "change" ? changedInputPaths(block.pair.inputJson) : [])));
            return <section className="chat-turn" key={turn.id} data-turn-id={turn.id}>
              {user && renderMessage(user, { onEdit: props.onEditUserMessage ? () => props.onEditUserMessage!(user.id, user.content) : undefined })}
              {hasProcess || working ? <ExecutionProcess blocks={process} working={working} visible={props.visible !== false} startedAt={turn.user?.createdAt} endedAt={endedAt.length ? Math.max(...endedAt) : undefined} renderMessage={renderMessage} /> : process.map(block => "pair" in block ? <ToolBlock key={toolKey(block)} {...block} /> : renderMessage(block))}
              {changedFiles.length > 0 && <details className="chat-turn-files">
                <summary><Icon name="file" size={13} /><span>本轮改动 {changedFiles.length} 个文件</span></summary>
                <div className="chat-turn-files-list">{changedFiles.map(p => <button type="button" key={p} className="chat-turn-file" title={p} onClick={() => { if (canLocate) requestLocate({ kind: "file", path: p, projectId: props.projectId, rootUri: props.rootUri }); else navigator.clipboard?.writeText(p).catch(() => {}); }}>{p.split(/[\\/]/).pop()}</button>)}</div>
              </details>}
              {final && renderMessage(final, { replyActions: true })}
              {terminalError && renderMessage(terminalError, { onRetry: props.onRetryTurn ? () => props.onRetryTurn!(terminalError.id) : undefined })}
            </section>;
          })}
          {props.working && (
            <div className="chat-msg assistant chat-working-row">
              <ThinkingIndicator since={workingSince} />
            </div>
          )}
          {props.stepsSlot}
        </div>
        {showScrollBottom && (
          <button type="button" className="chat-scroll-bottom" onClick={scrollToBottom} aria-label="回到底部" title="回到底部">
            <Icon name="arrowDown" size={14} />
            <span>回到底部</span>
          </button>
        )}
        <TurnNavigator items={navItems} activeId={activeTurnId} onJump={jumpToTurn} />
      </div>
      {gallery && gallery.items.length > 0 && (
        <ImageGallery
          items={gallery.items}
          index={Math.min(gallery.index, gallery.items.length - 1)}
          onIndexChange={next => setGallery(prev => (prev ? { ...prev, index: next } : prev))}
          onClose={() => setGallery(null)}
          origin={gallery.back}
          ariaLabel="图片预览"
        />
      )}
    </>
  );
}

/** 思考流式单行摘要：压缩空白并截取末尾，避免整段思考把摘要行撑高。 */
function summarizeThinking(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > 90 ? `…${flat.slice(-90)}` : flat;
}

function messageTime(ts?: number): string {
  return ts != null ? new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "时间未知";
}

function MessageRow(props: {
  m: UiMessage;
  projectId?: string;
  rootUri?: string;
  officeFiles?: OfficeFileRef[];
  canLocate: boolean;
  showReplyActions?: boolean;
  onOpenAgent?: (agentId: string) => void;
  onImageOpen: (src: string, alt: string, el: HTMLElement) => void;
  /** 可选：本轮终止错误的「重试」动作。 */
  onRetry?: () => void;
  /** 可选：用户消息的「编辑」动作。 */
  onEdit?: () => void;
}) {
  const { m } = props;
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const copyMessage = () => {
    if (!m.content) return;
    navigator.clipboard?.writeText(m.content).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200); }).catch(() => toast("复制失败", "warn"));
  };
  if (m.role === "user") {
    return (
      <div className="chat-msg user">
        <div className="chat-bubble">
          <div className="chat-bubble-user">
          {m.refs && m.refs.length > 0 && (
            <div className="chat-refs">
              {m.refs.map(r => (
                <RefChip key={`${r.kind}-${r.objectId}`} r={r} projectId={props.projectId} rootUri={props.rootUri} canLocate={props.canLocate} toast={toast} />
              ))}
            </div>
          )}
          {m.content}
          {m.attachments?.length ? <AttachmentImages attachments={m.attachments} /> : null}
          </div>
          {props.onEdit && (
            <div className="chat-msg-actions chat-msg-actions-user">
              <button type="button" className="chat-msg-action" onClick={props.onEdit} title="编辑这条消息">
                <Icon name="edit" size={13} />
                <span>编辑</span>
              </button>
            </div>
          )}
          <div className="chat-msg-name chat-msg-time">{messageTime(m.createdAt)}</div>
        </div>
      </div>
    );
  }
  if (m.role === "assistant") {
    const hasThinking = !!m.thinking?.trim();
    const empty = !m.content && !hasThinking;
    return (
      <div className="chat-msg assistant">
        <div className="chat-bubble">
        <div className="chat-card">
          {hasThinking && (
            <details className="chat-thinking-block">
              <summary><BrainOutline /><span>{m.streaming && !m.content ? "思考中" : "思考"}</span>{m.streaming && hasThinking && <span className="chat-think-live" title={m.thinking ?? undefined}>{summarizeThinking(m.thinking ?? "")}</span>}{m.thinkingMs != null && Number.isFinite(m.thinkingMs) && m.thinkingMs >= 0 && <span className="chat-think-duration">持续了 {formatMessageDuration(m.thinkingMs)}</span>}<Icon className="chat-thinking-chevron" name="chevronRight" size={14} /></summary>
              <div className="chat-thinking-content">{m.thinking}</div>
            </details>
          )}
          {empty ? (
            m.streaming ? (
              <span className="chat-typing">
                <i />
                <i />
                <i />
              </span>
            ) : null
          ) : (
            <Md
              text={m.content}
              projectId={props.projectId}
              rootUri={props.rootUri}
              officeFiles={props.officeFiles}
              canLocate={props.canLocate}
              onImageOpen={props.onImageOpen}
            />
          )}
          {props.showReplyActions === true && !m.streaming && !!m.content && (
            <div className="chat-msg-actions">
              <button type="button" className="chat-msg-action" onClick={copyMessage} title="复制这条回复的正文">
                <Icon name={copied ? "check" : "copy"} size={13} />
                <span>{copied ? "已复制" : "复制"}</span>
              </button>
            </div>
          )}
        </div>
        </div>
      </div>
    );
  }
  if (m.role === "subagent") {
    const hasOutput = !!m.content && m.content !== m.producerTask;
    const agent = presentAgent(m.sourceLabel);
    return (
      <div className="chat-msg subagent">
        <details className="chat-agent-event">
          <summary className="chat-agent-event-head">
            <span className={`chat-agent-glyph${agent.type === "Explore" ? " is-explore" : ""}`} aria-hidden="true"><i /><i /><i /></span>
            <span className={`chat-agent-kind${agent.type === "Explore" ? " is-explore" : ""}`}>{agent.type}</span>
            <span className="chat-agent-task" title={m.producerTask || "子智能体任务"}>{m.producerTask || "子智能体任务"}</span>
            <span className="chat-agent-state">{agent.status}</span>
            <Icon className="chat-agent-chevron" name="chevronRight" size={14} />
          </summary>
          <div className="chat-agent-details">
            <div className="chat-agent-full-task">{m.producerTask || "子智能体任务"}</div>
            <div className="chat-agent-meta">{m.producerId || "agent-id 未知"}{m.cli ? ` · ${m.cli}` : ""}</div>
            <div className="chat-agent-source">来源：{m.sourceLabel || "未记录"} · {messageTime(m.createdAt)}</div>
            {hasOutput && <div className="chat-agent-output">{m.content}</div>}
            {m.producerId && props.onOpenAgent && (
              <button type="button" className="chat-agent-open" title="查看子智能体只读详情" aria-label={`查看子智能体 ${m.producerTask || m.producerId} 的只读详情`} onClick={() => props.onOpenAgent?.(m.producerId!)}>
                查看只读详情 <Icon name="chevronRight" size={12} />
              </button>
            )}
          </div>
        </details>
      </div>
    );
  }
  if (m.role === "error") {
    return (
      <div className="chat-msg">
        <div className="chat-card error">
          <div>{m.content}</div>
          {props.onRetry && (
            <div className="chat-msg-actions chat-msg-actions-static">
              <button type="button" className="chat-msg-action" onClick={props.onRetry} title="重试这一轮">
                <Icon name="refresh" size={13} />
                <span>重试</span>
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }
  // CR-037 SR-01：上下文断点卡（role=system 的 context-breakpoint 消息，跨重启可见）。
  // 文案区分「上下文已重建 / 原线程不可续接」，与设计稿 chat-resume-design 一致。
  if (m.role === "system" && m.kind === "context-breakpoint") {
    const rebuilt = m.content.includes("上下文已重建");
    return (
      <div className="chat-msg">
        <div className={`chat-breakpoint ${rebuilt ? "ok" : "dead"}`} role="note" aria-label="上下文断点">
          <span className="chat-breakpoint-ico" aria-hidden>{rebuilt ? "↻" : "!"}</span>
          <div className="chat-breakpoint-main">
            <div className="chat-breakpoint-title">
              {rebuilt ? "上下文已重建" : "原线程不可续接"}
              <span className={`chat-breakpoint-tag ${rebuilt ? "good" : "bad"}`}>{rebuilt ? "fresh" : "blocked"}</span>
            </div>
            <div className="chat-breakpoint-reason">{m.content}</div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="chat-msg">
      <div className="chat-sysline">{m.content}</div>
    </div>
  );
}

/** 引用 chip：可定位（项目上下文）时点击打开对应内容（AC-09 / CR-043） */
function RefChip(props: { projectId?: string; rootUri?: string; r: ContextRef; canLocate: boolean; toast: (msg: string, t?: ToastKind) => void }) {
  const { r } = props;
  const onClick = () => {
    if (!props.canLocate) {
      navigator.clipboard?.writeText(r.display).catch(() => {});
      props.toast("当前会话未绑定项目上下文，已复制引用标识", "warn");
      return;
    }
    if (r.kind === "file") {
      if (r.objectId.startsWith("office:") && props.projectId) {
        requestLocate({ kind: "office-file", projectId: props.projectId!, fileId: r.objectId.slice("office:".length) });
      } else {
        requestLocate({ kind: "file", path: r.objectId, projectId: props.projectId, rootUri: props.rootUri });
      }
      return;
    }
    if (r.kind === "requirement") {
      requestLocate({ kind: "requirement", entityId: r.objectId });
      return;
    }
    if (r.kind === "knowledge" && r.libraryId) {
      requestLocate({ kind: "knowledge", libraryId: r.libraryId, noteId: r.objectId });
    }
  };
  const clickable = ["file", "requirement", "knowledge"].includes(r.kind);
  return (
    <button
      type="button"
      className={`chat-chip ${clickable ? "chat-chip-link" : ""}`}
      onClick={onClick}
      title={clickable ? "点击在左侧定位" : undefined}
    >
      <span className="ellipsis">{r.display}</span>
    </button>
  );
}
