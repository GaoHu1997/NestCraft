import { Icon } from "@/components/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "@/components/ui";
import { useToast } from "@/components/ui";
import type { ToastKind } from "@/components/ui";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { AttachmentMeta, ChatMessage, ContextRef } from "@/api";
import { requestLocate } from "@/modules/locate";
import { ThinkingIndicator, formatElapsed } from "./ThinkingIndicator";
import { toolDisplayName } from "./sessionRuntime";

/**
 * 消息流渲染（CR-034 / STORY-062）：
 * - 同一 toolId 的调用与结果配对为统一工具块（头部：工具名/参数摘要/状态/耗时估算；
 *   结果默认折叠，失败展开摘要）；配对缺失单侧成块并标注原因，不伪造配对（AC-01~03）；
 * - 图片等比缩放（宽≤100%、高≤360px）、点击放大浮层、失败占位（AC-04~06）；
 * - `路径:行[:列]` 渲染为链接，点击定位到编码区行；无项目上下文时退化为复制路径（AC-07~11）；
 * - 思考块收起态显示内容规模提示（AC-13）。
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
  refs: ContextRef[] | null;
  usage: { input: number; output: number } | null;
  model?: string | null;
  createdAt?: number;
  attachments?: AttachmentMeta[];
  streaming?: boolean;
  /** CR-056：思考阶段耗时（毫秒）。未知时折叠态只显示字数，不编造时长。 */
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

/** 按顺序把消息折叠为渲染单元：普通消息原样；tool_use/tool_result 合并为工具块 */
function buildBlocks(msgs: UiMessage[]): (UiMessage | { kind: "tool"; pair: ToolPair })[] {
  const out: (UiMessage | { kind: "tool"; pair: ToolPair })[] = [];
  const index = new Map<string, number>(); // toolId -> out 下标
  for (const m of msgs) {
    if (m.role === "tool_use" && m.toolId) {
      const i = out.length;
      out.push({
        kind: "tool",
        pair: { toolId: m.toolId, name: m.toolName, inputJson: m.inputJson, result: null, useMsg: m, resultMsg: null },
      });
      index.set(m.toolId, i);
      continue;
    }
    if (m.role === "tool_result" && m.toolId) {
      if (index.has(m.toolId)) {
        const blk = out[index.get(m.toolId)!] as { kind: "tool"; pair: ToolPair };
        blk.pair.result = { content: m.content, isError: m.isError };
        blk.pair.resultMsg = m;
        index.delete(m.toolId); // toolId重复时不能覆盖早期已配对结果
      } else out.push({ kind: "tool", pair: { toolId: m.toolId, name: null, inputJson: null, result: { content: m.content, isError: m.isError }, useMsg: null, resultMsg: m } });
      continue;
    }
    out.push(m);
  }
  return out;
}

function briefOf(inputJson: string | null): string {
  try {
    const obj = JSON.parse(inputJson ?? "{}") as Record<string, unknown>;
    const first = Object.values(obj).find(v => typeof v === "string");
    return typeof first === "string" ? first.slice(0, 90) : "";
  } catch {
    return inputJson?.slice(0, 90) ?? "";
  }
}

function ToolBlock({ pair }: { pair: ToolPair }) {
  const open = pair.result?.isError === true; // 失败时展开错误摘要（AC-02）
  const running = pair.result == null && !!pair.useMsg?.streaming;
  const orphanResult = pair.useMsg == null;
  const orphanUse = pair.result == null && !running;
  const status = running ? "run" : pair.result?.isError ? "fail" : pair.result ? "ok" : "pending";
  const statusText = orphanResult ? "来源调用未记录" : running ? "执行中" : pair.result?.isError ? "失败" : orphanUse ? "结果未返回" : "完成";
  const { pretty } = useMemo(() => {
    let obj: Record<string, unknown> = {};
    try {
      obj = JSON.parse(pair.inputJson ?? "{}") as Record<string, unknown>;
    } catch {
      /* 非 JSON 原文显示 */
    }
    return { pretty: JSON.stringify(obj, null, 2) };
  }, [pair.inputJson]);
  return (
    <div className="chat-msg">
      <div className={`chat-toolblock ${status}`}>
        <div className="chat-toolblock-head">
          <span className={`tag ${status === "fail" ? "bad" : status === "ok" ? "good" : "blue"}`}>{toolDisplayName(pair.name) ?? "工具调用"}</span>
          {briefOf(pair.inputJson) && <span className="small muted ellipsis chat-toolblock-brief">{briefOf(pair.inputJson)}</span>}
          <span className="spacer" />
          <span className={`chat-tool-state st-${status}`}>{statusText}</span>
        </div>
        {(pair.inputJson || pair.result) && (
          <details className="chat-tool-detail" open={open}>
            <summary>
              {pair.result ? (pair.result.isError ? "失败摘要与输入参数" : "查看结果与输入参数") : "输入参数"}
            </summary>
            {pretty !== "{}" && <pre>{pretty}</pre>}
            {pair.result && (
              <pre className={pair.result.isError ? "chat-tool-err" : ""}>
                {pair.result.content || "（无输出）"}
              </pre>
            )}
          </details>
        )}
      </div>
    </div>
  );
}

/* ---------- 消息列表 ---------- */

export function MessageList(props: {
  msgs: UiMessage[];
  projectId?: string;
  rootUri?: string;
  officeFiles?: OfficeFileRef[];
  visible?: boolean;
  stepsSlot?: React.ReactNode;
  /** CR-062：点开子智能体只读详情。 */
  onOpenAgent?: (agentId: string) => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const toast = useToast();
  const canLocate = !!props.rootUri || (props.officeFiles?.length ?? 0) > 0;
  const [zoom, setZoom] = useState<{ src: string; alt: string; back: HTMLElement } | null>(null);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  };

  useEffect(() => {
    const el = boxRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [props.msgs]);

  // 放大浮层：Esc 与点击遮罩关闭，关闭后焦点回到原图（AC-05）
  useEffect(() => {
    if (!zoom || props.visible === false) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setZoom(null);
        zoom.back.focus?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom, props.visible]);

  const blocks = useMemo(() => buildBlocks(props.msgs), [props.msgs]);

  if (props.msgs.length === 0 && !props.stepsSlot) {
    return (
      <div className="chat-msgs" style={{ justifyContent: "center" }}>
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

  return (
    <>
      <div className="chat-msgs" ref={boxRef} onScroll={onScroll}>
        {blocks.map((b, i) =>
          "pair" in b ? (
            <ToolBlock key={`tb-${b.pair.toolId}-${i}`} pair={b.pair} />
          ) : (
            <MessageRow key={b.id} m={b} projectId={props.projectId} rootUri={props.rootUri} officeFiles={props.officeFiles} canLocate={canLocate} onOpenAgent={props.onOpenAgent} onImageOpen={(src, alt, el) => setZoom({ src, alt, back: el })} />
          )
        )}
        {props.stepsSlot}
      </div>
      {zoom && (
        <div className="chat-img-zoom" role="dialog" aria-label="图片放大" onClick={() => { setZoom(null); zoom.back.focus?.(); }}>
          <img src={zoom.src} alt={zoom.alt} onClick={e => e.stopPropagation()} />
          <div className="chat-img-zoom-cap">{zoom.alt}</div>
        </div>
      )}
    </>
  );
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
  onOpenAgent?: (agentId: string) => void;
  onImageOpen: (src: string, alt: string, el: HTMLElement) => void;
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
          <div className="chat-msg-name chat-msg-time">{messageTime(m.createdAt)}</div>
          <div className="chat-bubble-user">
          {m.refs && m.refs.length > 0 && (
            <div className="chat-refs">
              {m.refs.map(r => (
                <RefChip key={`${r.kind}-${r.objectId}`} r={r} projectId={props.projectId} rootUri={props.rootUri} canLocate={props.canLocate} toast={toast} />
              ))}
            </div>
          )}
          {m.content}
          {m.attachments?.map((a, i) => <div className="chat-attachment" key={`${a.name}-${i}`} title="仅附件元信息，未读取正文">{a.name} · 附件元信息</div>)}
          </div>
        </div>
      </div>
    );
  }
  if (m.role === "assistant") {
    const empty = !m.content && !m.thinking;
    return (
      <div className="chat-msg assistant">
        <div className="chat-bubble">
          <div className="chat-msg-name chat-msg-time">{messageTime(m.createdAt)}</div>
        <div className="chat-card">
          {m.streaming && <ThinkingIndicator since={m.createdAt} />}
          {(m.thinking || (m.streaming && !m.content)) && (
            <details className="chat-thinking-block">
              <summary><span className="chat-thinking-mark">✦</span><span>{m.streaming ? "思考中…" : "思考"}</span><span className="chat-think-size">{m.thinkingMs != null ? `持续 ${formatElapsed(m.thinkingMs)}` : m.thinking ? `${m.thinking.length} 字` : "正在分析"}</span></summary>
              <div className="chat-thinking-content">{m.thinking || "正在分析请求并准备下一步…"}</div>
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
          {!m.streaming && !!m.content && (
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
    return (
      <div className="chat-msg subagent">
        <div className="chat-agent-event">
          <div className="chat-agent-event-head"><Icon name="bot" size={15} /><span className="chat-agent-kind">General Purpose</span><span className="chat-agent-state">{m.sourceLabel || "状态未知"}</span><span className="chat-agent-time">{messageTime(m.createdAt)}</span>
            {m.producerId && props.onOpenAgent && (
              <button type="button" className="chat-agent-open" title="查看子智能体只读详情" aria-label={`查看子智能体 ${m.producerTask || m.producerId} 的只读详情`} onClick={() => props.onOpenAgent?.(m.producerId!)}>
                查看 <Icon name="chevronRight" size={12} />
              </button>
            )}
          </div>
          <div className="chat-agent-task">{m.producerTask || "子智能体任务"}</div>
          <div className="chat-agent-meta">{m.producerId || "agent-id 未知"}{m.cli ? ` · ${m.cli}` : ""}</div>
          {hasOutput && <div className="chat-agent-output">{m.content}</div>}
        </div>
      </div>
    );
  }
  if (m.role === "error") {
    return (
      <div className="chat-msg">
        <div className="chat-card error">{m.content}</div>
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
