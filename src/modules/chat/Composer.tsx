import { Icon } from "@/components/icons";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import * as api from "@/api";
import type { AttachmentMeta, ContextRef, FileNode, KnowledgeLibrary, McpServer, NoteNode, SessionMeta, SkillEntry, ToolEntry } from "@/api";
import type { OfficeFileRef } from "./MessageList";
import { useChatOverlay } from "./overlay";

import { AttachmentImages, imageTypes, maxImages, readImage } from "./AttachmentImages";
import "./composer-reference.css";

interface DraftExtras { refs: ContextRef[]; atts: AttachmentMeta[] }
const empty: DraftExtras = { refs: [], atts: [] };
const extras = new Map<string, DraftExtras>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const getDraft = (key: string) => extras.get(key) ?? empty;
const setDraft = (key: string, value: DraftExtras) => {
  if (value === empty) extras.delete(key);
  else extras.set(key, value);
  listeners.forEach(listener => listener());
};
export function migrateComposerDraft(from: string, to: string) {
  if (from === to || !extras.has(from) || extras.has(to)) return;
  setDraft(to, getDraft(from));
  setDraft(from, empty);
}
export function clearComposerDraft(key: string, sent?: DraftExtras) {
  const current = getDraft(key);
  if (!sent || (sent.refs === current.refs && sent.atts === current.atts)) setDraft(key, empty);
}
export function restoreComposerDraft(key: string, refs: ContextRef[], atts: AttachmentMeta[]) {
  if (!refs.length && !atts.length) return;
  const current = getDraft(key);
  const mergedRefs = [...current.refs];
  for (const ref of refs) {
    if (!mergedRefs.some(r => r.kind === ref.kind && r.objectId === ref.objectId && r.libraryId === ref.libraryId)) mergedRefs.push(ref);
  }
  setDraft(key, { refs: mergedRefs, atts: [...current.atts, ...atts] });
}

function detectTrigger(value: string, caret: number) {
  const before = value.slice(0, caret);
  const at = /(?:^|\s)@(?:"([^"\n]*)|([^\s@"]*))$/u.exec(before);
  if (at) return { kind: "@" as const, query: at[1] ?? at[2], from: at.index + at[0].indexOf("@") };
  const slash = /(?:^|[\s(\[{:：，、])\/([^\s/@]*)$/u.exec(before);
  if (!slash || /(?:\S:\/\/|https?:)\S*$/iu.test(before)) return null;
  return { kind: "/" as const, query: slash[1], from: slash.index + slash[0].indexOf("/") };
}

function visibleReferenceRows(root: ParentNode | null | undefined) {
  return Array.from(root?.querySelectorAll<HTMLButtonElement>("button.chat-ref-row:not(:disabled)") ?? []).filter(row => row.getClientRects().length && !row.closest("details:not([open])"));
}

export function Composer(props: {
  scopeKey: string;
  rootUri?: string;
  projectId?: string;
  office?: boolean;
  officeFiles?: OfficeFileRef[];
  sessions: SessionMeta[];
  serverId?: string;
  onSessionSearch?: (q: string) => Promise<SessionMeta[]>;
  value: string;
  streaming: boolean;
  disabled?: boolean;
  controls?: ReactNode;
  renderControls?: (controls: { add: ReactNode; send: ReactNode }) => ReactNode;
  onChange: (v: string) => void;
  onSend: (text: string, refs: ContextRef[], atts: AttachmentMeta[]) => Promise<boolean>;
  onStop: () => void | Promise<void>;
  runner?: "cli" | "platform";
  cliId?: string | null;
  onCreateGoal?: (text: string) => void;
  onOpenGoal?: () => void;
}) {
  const overlay = useChatOverlay();
  const draft = useSyncExternalStore(subscribe, () => getDraft(props.scopeKey));
  const [busy, setBusy] = useState(false);
  const [imageError, setImageError] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"add" | "cmd">("add");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const range = useRef<{ from: number; to: number } | null>(null);
  const scope = useRef(props.scopeKey);
  const value = useRef(props.value);
  const sending = useRef(false);
  scope.current = props.scopeKey;
  value.current = props.value;
  const imageEnabled = props.runner !== "platform" && props.cliId === "codex";
  const hasImages = draft.atts.some(a => Boolean(a.imageBase64));
  const canSend = Boolean(props.value.trim()) || hasImages;
  const stop = props.streaming && !canSend;
  const blockedImage = "当前通道暂不支持图片，请切换到 Codex 或移除图片";
  useEffect(() => {
    composing.current = false;
    range.current = null;
    overlay.close(false);
    setQuery("");
    setImageError("");
  }, [props.scopeKey]);
  useEffect(() => {
    const ta = textarea.current;
    if (ta) { ta.style.height = "auto"; ta.style.height = `${Math.max(36, Math.min(336, ta.scrollHeight))}px`; }
  }, [props.value]);
  const doSend = async () => {
    const text = props.value.trim();
    if (!canSend || props.disabled || sending.current) return;
    const goal = /^\/goal(?:\s+([\s\S]*))?$/.exec(text);
    if (goal) {
      const target = goal[1]?.trim();
      if (target && props.onCreateGoal) props.onCreateGoal(target);
      else if (!target && props.onOpenGoal) props.onOpenGoal();
      else return;
      overlay.close(false);
      props.onChange("");
      return;
    }
    if (hasImages && !imageEnabled) return;
    sending.current = true;
    setBusy(true);
    try {
      await props.onSend(text, draft.refs, draft.atts);
    } finally { sending.current = false; setBusy(false); }
  };
  const updateTrigger = (ta: HTMLTextAreaElement) => {
    if (composing.current) return;
    const caret = ta.selectionStart;
    const found = ta.selectionEnd === caret ? detectTrigger(ta.value, caret) : null;
    range.current = found ? { from: found.from, to: caret } : null;
    if (found) { setQuery(found.query); if (overlay.activeOverlay !== found.kind) overlay.open(found.kind, ta); }
    else if (overlay.activeOverlay === "@" || overlay.activeOverlay === "/") overlay.close(false);
  };
  const insertToken = (token: string) => {
    const caret = textarea.current?.selectionStart ?? value.current.length;
    const { from, to } = range.current ?? { from: caret, to: caret };
    overlay.close(false);
    range.current = null;
    props.onChange(value.current.slice(0, from) + token + value.current.slice(to));
    const key = props.scopeKey;
    requestAnimationFrame(() => {
      if (scope.current !== key) return;
      textarea.current?.focus({ preventScroll: true });
      textarea.current?.setSelectionRange(from + token.length, from + token.length);
    });
  };
  const pick = (ref: ContextRef, token = "") => {
    const current = getDraft(props.scopeKey);
    if (!current.refs.some(r => r.kind === ref.kind && r.objectId === ref.objectId && r.libraryId === ref.libraryId)) {
      setDraft(props.scopeKey, { ...current, refs: [...current.refs, ref] });
    }
    insertToken(token);
  };
  const addImages = async (files: File[]) => {
    if (!files.length || !imageEnabled || props.disabled) return;
    const key = props.scopeKey;
    const tooMany = "每条消息最多添加 8 张图片";
    setImageError("");
    try {
      if (getDraft(key).atts.length + files.length > maxImages) throw new Error(tooMany);
      const added = await Promise.all(files.map(readImage));
      const current = getDraft(key);
      if (current.atts.length + added.length > maxImages) throw new Error(tooMany);
      setDraft(key, { ...current, atts: [...current.atts, ...added] });
    } catch (error) {
      if (scope.current === key) setImageError(error instanceof Error ? error.message : "图片读取失败");
    }
  };
  const openMenu = (kind: "@" | "/") => {
    range.current = null;
    setQuery("");
    overlay.open(kind, textarea.current);
  };
  const isPicker = overlay.activeOverlay === "@" || overlay.activeOverlay === "/";
  const options = () => visibleReferenceRows(overlay.scopeRef.current?.querySelector(`[data-chat-overlay="${overlay.activeOverlay}"]`));
  const addControl = <button type="button" className="chat-ctl-chip icon-only" data-chat-overlay-trigger="+" title="添加" aria-label="添加" aria-expanded={overlay.activeOverlay === "+"} onClick={e => { setTab("add"); overlay.toggle("+", e.currentTarget); }}><Icon name="plus" /></button>;
  const sendControl = <button type="button" className="chat-send" aria-label={stop ? "停止" : "发送"} title={stop ? "停止" : props.streaming ? "按设定立即发送或排队" : "发送"} disabled={busy || props.disabled || !canSend && !stop || hasImages && !imageEnabled} onClick={() => { if (stop) void props.onStop(); else void doSend(); }}><Icon name={stop ? "stop" : "arrowUp"} /></button>;
  return <>
    {overlay.activeOverlay === "+" && <div className="chat-refpop chat-addpop" data-chat-overlay="+" role="dialog" aria-label="添加与指令">
      <div className="chat-menu-tabs" role="tablist">{(["add", "cmd"] as const).map(t => <button type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} key={t} onClick={() => setTab(t)}>{t === "add" ? "添加" : "指令"}</button>)}</div>
      <div className="chat-refpop-body">{tab === "add" ? <>
        <button type="button" className="chat-menu-row" onClick={() => openMenu("@")}>引用文件或资料</button>
        {imageEnabled ? <button type="button" className="chat-menu-row" disabled={props.disabled} onClick={() => { overlay.close(true); fileInput.current?.click(); }}>添加图片</button> : <Unavailable name="添加图片" reason="当前通道暂不支持图片" />}
      </> : <>
        <button type="button" className="chat-menu-row" disabled={overlay.getTrigger("perm")?.disabled} onClick={() => overlay.open("perm")}>权限</button>
        <button type="button" className="chat-menu-row" disabled={overlay.getTrigger("model")?.disabled} onClick={() => overlay.open("model")}>模型</button>
        <button type="button" className="chat-menu-row" onClick={() => openMenu("/")}>能力与指令</button>
        <Unavailable name="下载日志" reason="ZIP 导出未接入" />
      </>}</div>
    </div>}
    {(overlay.activeOverlay === "@" || overlay.activeOverlay === "/") && <ReferencePopover key={overlay.activeOverlay} trigger={overlay.activeOverlay} query={query} rootUri={props.rootUri} projectId={props.projectId} serverId={props.serverId} office={props.office} officeFiles={props.officeFiles} sessions={props.sessions} onSessionSearch={props.onSessionSearch} onPick={pick} onGoal={props.onCreateGoal || props.onOpenGoal ? () => insertToken("/goal ") : undefined} focusSearch={range.current === null} />}
    <div className="chat-composer" onDragOver={e => { if (imageEnabled && e.dataTransfer.types.includes("Files")) e.preventDefault(); }} onDrop={e => { if (!imageEnabled || !e.dataTransfer.files.length) return; e.preventDefault(); void addImages(Array.from(e.dataTransfer.files)); }}>
      {draft.refs.length > 0 && <div className="chat-chips">
        {draft.refs.map(r => <span className="chat-chip" key={`${r.kind}-${r.objectId}-${r.libraryId ?? ""}`}><span className="ellipsis">{r.display}</span><button type="button" className="chat-chip-x" aria-label={`移除引用 ${r.display}`} onClick={() => setDraft(props.scopeKey, { ...draft, refs: draft.refs.filter(x => x !== r) })}><Icon name="x" size={12} /></button></span>)}
      </div>}
      <AttachmentImages key={props.scopeKey} attachments={draft.atts} onRemove={i => { setDraft(props.scopeKey, { ...draft, atts: draft.atts.filter((_, j) => j !== i) }); setImageError(""); }} />
      {(imageError || hasImages && !imageEnabled) && <div className="chat-composer-error small" role="alert">{imageError || blockedImage}</div>}
      <textarea ref={textarea} className="chat-ta" data-chat-overlay-trigger="input" rows={1}
        placeholder={props.office ? "描述办公意图，/ 调用指令，@ 项目资料或对话" : "描述你想构建的内容，/ 调用指令，@ 文件或对话"}
        value={props.value}
        onChange={e => { props.onChange(e.currentTarget.value); if (!composing.current && !(e.nativeEvent as InputEvent).isComposing) updateTrigger(e.currentTarget); }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={e => { composing.current = false; updateTrigger(e.currentTarget); }}
        onClick={e => updateTrigger(e.currentTarget)}
        onKeyUp={e => { if (!e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229 && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) updateTrigger(e.currentTarget); }}
        onPaste={e => {
          const files = Array.from(e.clipboardData.files).filter(file => file.type.startsWith("image/"));
          if (files.length && !e.clipboardData.getData("text/plain")) { e.preventDefault(); if (imageEnabled) void addImages(files); else setImageError(blockedImage); }
        }}
        onKeyDown={e => {
          if (composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) { e.stopPropagation(); return; }
          if (isPicker && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            const rows = options();
            const row = e.key === "ArrowDown" ? rows[0] : rows[rows.length - 1];
            if (row) { e.preventDefault(); row.focus(); return; }
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            const row = isPicker && options()[0];
            if (row) row.click();
            else void doSend();
          }
        }} />
      <div className="chat-tools">
        {props.renderControls ? props.renderControls({ add: addControl, send: sendControl }) : <>{addControl}{props.controls}{sendControl}</>}
      </div>
    </div>
    <input type="file" accept={imageTypes.join(",")} multiple ref={fileInput} className="hidden-file-input" onChange={e => { const files = Array.from(e.currentTarget.files ?? []); e.currentTarget.value = ""; void addImages(files); }} />
  </>;
}

function Unavailable({ name, reason }: { name: string; reason: string }) { return <div className="chat-unavailable-row"><button className="chat-menu-row" disabled title={`不可用：${reason}`}>{name}<span className="chat-cap">不可用</span></button><span>{reason}</span></div>; }

function ReferencePopover(props: {
  trigger: "@" | "/";
  query: string;
  rootUri?: string;
  projectId?: string;
  office?: boolean;
  officeFiles?: OfficeFileRef[];
  sessions: SessionMeta[];
  serverId?: string;
  onSessionSearch?: (q: string) => Promise<SessionMeta[]>;
  onPick: (ref: ContextRef, token?: string) => void;
  onGoal?: () => void;
  focusSearch: boolean;
}) {
  const [q, setQ] = useState(props.query);
  const searchComposing = useRef(false);
  const [files, setFiles] = useState<FileNode[]>([]);
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [mcps, setMcps] = useState<McpServer[]>([]);
  const [tools, setTools] = useState<ToolEntry[]>([]);
  const [libs, setLibs] = useState<KnowledgeLibrary[]>([]);
  const [notes, setNotes] = useState<{ lib: KnowledgeLibrary; note: NoteNode }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => setQ(props.query), [props.query]);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError("");
    const flatten = (nodes: NoteNode[]): NoteNode[] => nodes.flatMap(n => n.isDir ? flatten(n.children ?? []) : [n]);
    const load = async () => {
      try {
        if (props.trigger === "/") {
          const [ss, mm, tt] = await Promise.all([api.skillList(), api.mcpList(), api.toolList()]);
          if (alive) { setSkills(ss.filter(s => s.enabled)); setMcps(mm.filter(m => m.enabled)); setTools(tt.filter(t => t.enabled)); }
        } else {
          const treePromise = !props.office && props.rootUri ? api.fsListTree(props.rootUri, 6) : Promise.resolve([] as FileNode[]);
          const libPromise = props.projectId ? Promise.all([api.kbList(), api.kbGrants(props.projectId)]).then(([ll, gg]) => {
            const allowed = new Set(gg.filter(g => g.readAllowed).map(g => g.libraryId));
            return ll.filter(l => l.enabled && allowed.has(l.id));
          }) : Promise.resolve([] as KnowledgeLibrary[]); // 无 project 身份默认拒绝
          const [ff, ll] = await Promise.all([treePromise, libPromise]);
          const nn = (await Promise.all(ll.map(async lib => ({ lib, tree: await api.kbTree(lib.id) })))).flatMap(({ lib, tree }) => flatten(tree).map(note => ({ lib, note })));
          if (alive) { setFiles(ff.filter(f => !f.isDir)); setLibs(ll); setNotes(nn); }
        }
      } catch (e) { if (alive) setError(String(e)); }
      finally { if (alive) setLoading(false); }
    };
    void load(); return () => { alive = false; };
  }, [props.trigger, props.projectId, props.rootUri, props.office]);
  const match = (text: string) => text.toLowerCase().includes(q.toLowerCase());
  // CR-063：会话候选按关键词向后端查询，未加载的老会话也能被引用；查询失败退回本地列表。
  const [sessionHits, setSessionHits] = useState<SessionMeta[] | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const searchRef = useRef(props.onSessionSearch);
  searchRef.current = props.onSessionSearch;
  useEffect(() => {
    const search = searchRef.current;
    if (props.trigger !== "@" || !search) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      setSessionBusy(true);
      search(q.trim())
        .then(rows => { if (alive) setSessionHits(rows); })
        .catch(() => { if (alive) setSessionHits(null); })
        .finally(() => { if (alive) setSessionBusy(false); });
    }, 250);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [q, props.trigger]);
  const mcpRows = mcps.flatMap(m => {
    if (match(m.name)) return [m];
    const matchingTools = m.tools.filter(t => match(t.name));
    return matchingTools.length ? [{ ...m, tools: matchingTools }] : [];
  });
  const officeRows = (props.officeFiles ?? []).filter(f => match(`${f.path} ${f.name}`));
  const fileRows = files.filter(f => match(f.path));
  const localSessionRows = props.sessions.filter(s => props.projectId ? s.projectId === props.projectId : !s.projectId && !s.serverId).filter(s => match(s.title));
  const sessionRows = props.onSessionSearch && sessionHits !== null ? sessionHits : localSessionRows;
  return <div className="chat-refpop" data-chat-overlay={props.trigger} role="dialog" aria-busy={loading} aria-label={props.trigger === "@" ? "引用浮层" : "能力与指令"}>
    <div className="chat-refpop-head"><span>{props.trigger}</span><input autoFocus={props.focusSearch} aria-label="筛选引用或能力" value={q} placeholder={props.trigger === "@" ? "筛选项目文件、对话、已授权知识" : "筛选 Skill / MCP / Tool"} onChange={e => setQ(e.target.value)} onCompositionStart={() => { searchComposing.current = true; }} onCompositionEnd={e => { searchComposing.current = false; setQ(e.currentTarget.value); }} onKeyDown={e => { if (searchComposing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) { e.stopPropagation(); return; } if (e.key === "ArrowDown") { const first = visibleReferenceRows(e.currentTarget.closest(".chat-refpop"))[0]; if (first) { e.preventDefault(); first.focus(); } } }} /></div>
    <div className="chat-refpop-body" onKeyDown={e => { if (searchComposing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) { e.stopPropagation(); return; } if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return; const target = e.target as HTMLElement; const current = target.closest<HTMLButtonElement>("button.chat-ref-row"); if (!current) return; const buttons = visibleReferenceRows(e.currentTarget); const index = buttons.indexOf(current); if (index < 0) return; const next = buttons[(index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]; if (next) { e.preventDefault(); next.focus(); } }}>{loading && <div className="chat-menu-hint">加载中…</div>}{error && <div className="chat-menu-hint" role="alert">加载失败：{error}</div>}
      {props.trigger === "@" ? <>
        <div className="chat-ref-group-title">项目文件</div>
        {props.office ? officeRows.map(f => <button className="chat-ref-row" key={f.id} onClick={() => props.onPick({ kind: "file", objectId: `office:${f.id}`, display: f.path })}><span className="name">{f.name}</span><span className="sub">{f.path}</span></button>) : fileRows.map(f => <button className="chat-ref-row" key={f.path} onClick={() => props.onPick({ kind: "file", objectId: f.path, display: f.path })}><span className="name">{f.name}</span><span className="sub">{f.path}</span></button>)}
        {!loading && !(props.office ? officeRows : fileRows).length && <div className="chat-menu-hint">暂无匹配项目文件</div>}
        <div className="chat-ref-group-title">当前项目会话</div>{sessionRows.map(s => <button className="chat-ref-row" key={s.id} onClick={() => props.onPick({ kind: "session", objectId: s.id, display: s.title })}><span className="name">{s.title}</span><span className="sub">引用仅本项目会话正文</span></button>)}
        {props.trigger === "@" && sessionBusy && <div className="chat-menu-hint">搜索会话中…</div>}
        {!sessionRows.length && !sessionBusy && <div className="chat-menu-hint">暂无匹配会话</div>}
        <div className="chat-ref-group-title">已授权知识</div>{notes.filter(n => match(`${n.note.title} ${n.lib.name} ${n.note.relativeUri}`)).map(({ lib, note }) => <button className="chat-ref-row" key={`${lib.id}:${note.noteId}`} onClick={() => props.onPick({ kind: "knowledge", objectId: note.noteId, display: note.title, libraryId: lib.id })}><span className="name">{note.title}</span><span className="sub">{lib.name} · {note.relativeUri}</span></button>)}
        {!loading && !libs.length && <div className="chat-menu-hint">{props.projectId ? "当前项目无已授权知识库" : "未绑定项目身份，知识访问不可用"}</div>}
      </> : <>
        {props.onGoal && match("goal 会话目标") && <button type="button" className="chat-ref-row" onClick={props.onGoal}>/goal</button>}
        <div className="chat-ref-group-title">Skill</div>{skills.filter(s => match(`${s.name} ${s.description ?? ""}`)).map(s => <button className="chat-ref-row" key={s.id} onClick={() => props.onPick({ kind: "skill", objectId: s.name, display: `/${s.name}` }, `/${s.name} `)}><span className="name">{s.name}</span><span className="sub">已启用 · 随消息选择，不代表已执行</span></button>)}
        {!loading && !skills.length && <div className="chat-menu-hint">暂无启用 Skill</div>}
        <div className="chat-ref-group-title">MCP</div>{mcpRows.map(m => <div className="chat-ref-group" key={m.id}><details><summary>{m.name} · {m.tools.length} 个已发现工具</summary>{m.tools.map(t => <button className="chat-ref-row" key={t.name} onClick={() => props.onPick({ kind: "command", objectId: `mcp__${m.name}__${t.name}`, display: `/${m.name}/${t.name}` }, `请使用已启用的 MCP 工具 mcp__${m.name}__${t.name} `)}><span className="name">{t.name}</span><span className="sub">按消息请求，执行结果以真实事件为准</span></button>)}{!m.tools.length && <div className="chat-menu-hint">不可用：未发现工具；此处不启动服务器或伪调用。</div>}</details></div>)}
        {!loading && !mcps.length && <div className="chat-menu-hint">暂无启用 MCP</div>}
        <div className="chat-ref-group-title">Tool</div>{tools.filter(t => match(`${t.name} ${t.description ?? ""}`)).map(t => <button className="chat-ref-row" key={t.id} onClick={() => props.onPick({ kind: "command", objectId: t.name, display: `/${t.name}` }, `请使用已启用工具 ${t.name} `)}><span className="name">{t.name}</span><span className="sub">{t.risk}风险 · 请求不代表审批或已调用</span></button>)}
        {!loading && !tools.length && <div className="chat-menu-hint">暂无启用 Tool</div>}
        {!loading && !error && !(props.onGoal && match("goal 会话目标")) && !skills.some(s => match(`${s.name} ${s.description ?? ""}`)) && !mcpRows.length && !tools.some(t => match(`${t.name} ${t.description ?? ""}`)) && <div className="chat-menu-hint" role="status">没有匹配，换个关键词。</div>}
      </>}
    </div>
  </div>;
}
