import { Icon } from "@/components/icons";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import * as api from "@/api";
import type { AttachmentMeta, ContextRef, FileNode, KnowledgeLibrary, McpServer, NoteNode, SessionMeta, SkillEntry, ToolEntry } from "@/api";
import type { OfficeFileRef } from "./MessageList";
import { useChatOverlay } from "./overlay";

interface DraftExtras { refs: ContextRef[]; atts: AttachmentMeta[] }
const extras = new Map<string, DraftExtras>();
export function migrateComposerDraft(from: string, to: string) {
  const value = extras.get(from);
  if (value && !extras.has(to)) extras.set(to, value);
}
export function clearComposerDraft(key: string) { extras.set(key, { refs: [], atts: [] }); }
/** 草稿文本在父级；refs/附件以 project/session scope 保留，不随切换泄露。 */
export function Composer(props: {
  scopeKey: string;
  rootUri?: string;
  projectId?: string;
  office?: boolean;
  officeFiles?: OfficeFileRef[];
  sessions: SessionMeta[];
  /** CR-063：会话候选按作用域查询；不传时退回已加载列表过滤。 */
  serverId?: string;
  onSessionSearch?: (q: string) => Promise<SessionMeta[]>;
  value: string;
  streaming: boolean;
  disabled?: boolean;
  controls: ReactNode;
  onChange: (v: string) => void;
  onSend: (text: string, refs: ContextRef[], atts: AttachmentMeta[]) => Promise<boolean>;
  onStop: () => void | Promise<void>;
  goal?: { text: string; state: "active" | "paused" | "cancelled" } | null;
  tasks?: { id: string; taskName: string; state: string }[];
  onCreateGoal?: (text: string) => void;
  onGoalStateChange?: (state: "active" | "paused" | "cancelled") => void;
  onCreateTask?: (taskName: string) => void;
}) {
  const overlay = useChatOverlay();
  const [saved, setSaved] = useState<DraftExtras>(() => extras.get(props.scopeKey) ?? { refs: [], atts: [] });
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"add" | "cmd">("add");
  const [goalDraft, setGoalDraft] = useState("");
  const [taskDraft, setTaskDraft] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scopeRef = useRef(props.scopeKey);
  const valueRef = useRef(props.value);
  valueRef.current = props.value;
  // scope改变时同步读Map；旧组件请求完成不清新会话草稿。
  const state = scopeRef.current === props.scopeKey ? saved : extras.get(props.scopeKey) ?? { refs: [], atts: [] };
  useEffect(() => {
    scopeRef.current = props.scopeKey;
    setSaved(extras.get(props.scopeKey) ?? { refs: [], atts: [] });
    overlay.close(false); setQuery("");
  }, [props.scopeKey]);
  const updateExtras = (value: DraftExtras) => { extras.set(props.scopeKey, value); setSaved(value); };
  useEffect(() => {
    const ta = taRef.current;
    if (ta) { ta.style.height = "auto"; ta.style.height = `${Math.max(62, Math.min(160, ta.scrollHeight))}px`; }
  }, [props.value]);
  const sending = useRef(false);
  const doSend = async () => {
    const text = props.value.trim();
    if (!text || props.disabled || sending.current) return;
    const key = props.scopeKey, original = props.value;
    const captured = { refs: [...state.refs], atts: [...state.atts] };
    sending.current = true; setBusy(true);
    try {
      const accepted = await props.onSend(text, captured.refs, captured.atts);
      if (!accepted) return; // IPC拒绝保留全部草稿
      extras.set(key, { refs: [], atts: [] });
      if (scopeRef.current === key && valueRef.current === original) {
        setSaved({ refs: [], atts: [] }); props.onChange("");
      }
    } finally { sending.current = false; setBusy(false); }
  };
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value; props.onChange(v);
    const caret = e.target.selectionStart ?? v.length;
    const found = /(^|\s)([@/])([^\s@/]*)$/.exec(v.slice(0, caret));
    if (found) { setQuery(found[3]); overlay.open(found[2] as "@" | "/", e.currentTarget); }
    else if (overlay.activeOverlay === "@" || overlay.activeOverlay === "/") overlay.close(false);
  };
  const pick = (ref: ContextRef, token?: string) => {
    updateExtras({ ...state, refs: state.refs.some(r => r.kind === ref.kind && r.objectId === ref.objectId && r.libraryId === ref.libraryId) ? state.refs : [...state.refs, ref] });
    const caret = taRef.current?.selectionStart ?? props.value.length;
    const at = overlay.activeOverlay === "@" || overlay.activeOverlay === "/";
    const before = at ? props.value.slice(0, caret).replace(/(^|\s)([@/])([^\s@/]*)$/, `$1${token ?? ""}`) : props.value.slice(0, caret);
    props.onChange(before + props.value.slice(caret)); overlay.close(false); taRef.current?.focus();
  };
  const onFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    updateExtras({ ...state, atts: [...state.atts, ...files.map(f => ({ name: f.name, mime: f.type || null, byteSize: f.size }))] });
    e.target.value = "";
  };
  return <>
    {overlay.activeOverlay === "+" && <div className="chat-refpop chat-addpop" data-chat-overlay="+" role="dialog" aria-label="添加与指令"><div className="chat-menu-tabs" role="tablist">{(["add", "cmd"] as const).map(t => <button role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} key={t} onClick={() => setTab(t)}>{t === "add" ? "添加" : "指令"}</button>)}</div><div className="chat-refpop-body">
      {tab === "add" ? <>
        <button className="chat-menu-row" onClick={() => { setQuery(""); overlay.open("@", taRef.current); }}>文件<span className="chat-cap">引用项目文件、对话或已授权知识</span></button>
        <button className="chat-menu-row" onClick={() => fileRef.current?.click()}>本地附件<span className="chat-cap">仅记录元信息，不读取正文</span></button>
                 <div className="chat-menu-section-title">会话状态</div>
         <div className="chat-inline-form"><input aria-label="会话目标" placeholder="输入本会话目标" value={goalDraft || props.goal?.text || ""} onChange={e => setGoalDraft(e.target.value)} /><button className="btn sm" disabled={!goalDraft.trim()} onClick={() => { props.onCreateGoal?.(goalDraft.trim()); setGoalDraft(""); }}>保存目标</button></div>
         {props.goal && <div className="chat-goal-actions"><span className={`chat-goal-state ${props.goal.state}`}>{props.goal.state === "active" ? "进行中" : props.goal.state === "paused" ? "已暂停" : "已取消"}</span>{props.goal.state === "active" ? <button className="link-btn" onClick={() => props.onGoalStateChange?.("paused")}>暂停</button> : props.goal.state === "paused" ? <button className="link-btn" onClick={() => props.onGoalStateChange?.("active")}>恢复</button> : null}<button className="link-btn danger" onClick={() => props.onGoalStateChange?.("cancelled")}>取消目标</button></div>}
         <div className="chat-inline-form"><input aria-label="新建会话任务" placeholder="添加任务名称" value={taskDraft} onChange={e => setTaskDraft(e.target.value)} /><button className="btn sm" disabled={!taskDraft.trim()} onClick={() => { props.onCreateTask?.(taskDraft.trim()); setTaskDraft(""); }}>添加任务</button></div>
         {props.tasks?.map(task => <div className="chat-task-row" key={task.id}><span className={`chat-task-dot ${task.state}`} /><span className="ellipsis">{task.taskName}</span><span>{task.state === "pending" ? "待处理" : task.state === "running" ? "进行中" : task.state === "completed" ? "已完成" : task.state === "failed" ? "失败" : task.state}</span></div>)}
      </> : <>
        <button className="chat-menu-row" disabled={overlay.getTrigger("perm")?.disabled} onClick={() => overlay.open("perm")}>权限<span className="chat-cap">查看已验证模式</span></button>
        <button className="chat-menu-row" disabled={overlay.getTrigger("model")?.disabled} onClick={() => overlay.open("model")}>模型<span className="chat-cap">模型与思考档位</span></button>
        <button className="chat-menu-row" onClick={() => { setQuery(""); overlay.open("/", taRef.current); }}>能力<span className="chat-cap">Skill / MCP / Tool</span></button>
        <Unavailable name="下载日志" reason="ZIP 导出引擎尚未提供" />
      </>}
    </div></div>}
    {(overlay.activeOverlay === "@" || overlay.activeOverlay === "/") && <ReferencePopover trigger={overlay.activeOverlay} query={query} rootUri={props.rootUri} projectId={props.projectId} serverId={props.serverId} office={props.office} officeFiles={props.officeFiles} sessions={props.sessions} onSessionSearch={props.onSessionSearch} onPick={pick} />}
    <div className="chat-composer">
      {(state.refs.length > 0 || state.atts.length > 0) && <div className="chat-chips">
        {state.refs.map(r => <span className="chat-chip" key={`${r.kind}-${r.objectId}-${r.libraryId ?? ""}`}><span className="ellipsis">{r.display}</span><button className="chat-chip-x" aria-label={`移除引用 ${r.display}`} onClick={() => updateExtras({ ...state, refs: state.refs.filter(x => x !== r) })}><Icon name="x" size={12} /></button></span>)}
        {state.atts.map((a, i) => <span className="chat-chip" key={`${a.name}-${i}`} title="仅附件元信息，不读取文件正文"><span className="ellipsis">{a.name}（元信息）</span><button className="chat-chip-x" aria-label={`移除附件 ${a.name}`} onClick={() => updateExtras({ ...state, atts: state.atts.filter((_, j) => j !== i) })}><Icon name="x" size={12} /></button></span>)}
      </div>}
      <textarea ref={taRef} className="chat-ta" rows={2} placeholder={props.office ? "描述办公意图，/ 调用指令，@ 项目资料或对话" : "描述你想构建的内容，/ 调用指令，@ 文件或对话"} value={props.value} onChange={handleChange} onKeyDown={e => {
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void doSend(); }
      }} />
      <div className="chat-tools"><button className="chat-ctl-chip icon-only" data-chat-overlay-trigger="+" title="添加" aria-label="添加" aria-expanded={overlay.activeOverlay === "+"} onClick={e => { setTab("add"); overlay.toggle("+", e.currentTarget); }}><Icon name="plus" /></button>
        {props.controls}
        <button className="chat-send" aria-label={props.streaming && !props.value.trim() ? "停止" : "发送"} title={props.streaming && !props.value.trim() ? "停止" : props.streaming ? "按设定立即发送或排队" : "发送"} disabled={busy || props.disabled || !props.streaming && !props.value.trim()} onClick={() => { if (props.streaming && !props.value.trim()) void props.onStop(); else void doSend(); }}>
          <Icon name={props.streaming && !props.value.trim() ? "stop" : "arrowUp"} />
        </button>
      </div>
    </div>
    <input type="file" multiple ref={fileRef} className="hidden-file-input" onChange={onFiles} />
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
}) {
  const [q, setQ] = useState(props.query);
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
  const officeRows = (props.officeFiles ?? []).filter(f => match(`${f.path} ${f.name}`));
  const fileRows = files.filter(f => match(f.path));
  const localSessionRows = props.sessions.filter(s => props.projectId ? s.projectId === props.projectId : !s.projectId && !s.serverId).filter(s => match(s.title));
  const sessionRows = props.onSessionSearch && sessionHits !== null ? sessionHits : localSessionRows;
  return <div className="chat-refpop" data-chat-overlay={props.trigger} role="dialog" aria-label={props.trigger === "@" ? "引用浮层" : "能力与指令"}>
    <div className="chat-refpop-head"><span>{props.trigger}</span><input autoFocus aria-label="筛选引用或能力" value={q} placeholder={props.trigger === "@" ? "筛选项目文件、对话、已授权知识" : "筛选 Skill / MCP / Tool"} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === "ArrowDown") { const first = e.currentTarget.closest(".chat-refpop")?.querySelector<HTMLButtonElement>("button.chat-ref-row"); if (first) { e.preventDefault(); first.focus(); } } }} /></div>
    <div className="chat-refpop-body" onKeyDown={e => { if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return; const target = e.target as HTMLElement; const current = target.closest<HTMLButtonElement>("button.chat-ref-row"); if (!current) return; const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button.chat-ref-row")); const index = buttons.indexOf(current); if (index < 0) return; const next = buttons[(index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]; if (next) { e.preventDefault(); next.focus(); } }}>{loading && <div className="chat-menu-hint">加载中…</div>}{error && <div className="chat-menu-hint">加载失败：{error}</div>}
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
        <div className="chat-ref-group-title">Skill</div>{skills.filter(s => match(`${s.name} ${s.description ?? ""}`)).map(s => <button className="chat-ref-row" key={s.id} onClick={() => props.onPick({ kind: "skill", objectId: s.name, display: `/${s.name}` }, `/${s.name} `)}><span className="name">{s.name}</span><span className="sub">已启用 · 随消息选择，不代表已执行</span></button>)}
        {!loading && !skills.length && <div className="chat-menu-hint">暂无启用 Skill</div>}
        <div className="chat-ref-group-title">MCP</div>{mcps.filter(m => match(m.name)).map(m => <div className="chat-ref-group" key={m.id}><details><summary>{m.name} · {m.tools.length} 个已发现工具</summary>{m.tools.map(t => <button className="chat-ref-row" key={t.name} onClick={() => props.onPick({ kind: "command", objectId: `mcp__${m.name}__${t.name}`, display: `/${m.name}/${t.name}` }, `请使用已启用的 MCP 工具 mcp__${m.name}__${t.name} `)}><span className="name">{t.name}</span><span className="sub">按消息请求，执行结果以真实事件为准</span></button>)}{!m.tools.length && <div className="chat-menu-hint">不可用：未发现工具；此处不启动服务器或伪调用。</div>}</details></div>)}
        {!loading && !mcps.length && <div className="chat-menu-hint">暂无启用 MCP</div>}
        <div className="chat-ref-group-title">Tool</div>{tools.filter(t => match(`${t.name} ${t.description ?? ""}`)).map(t => <button className="chat-ref-row" key={t.id} onClick={() => props.onPick({ kind: "command", objectId: t.name, display: `/${t.name}` }, `请使用已启用工具 ${t.name} `)}><span className="name">{t.name}</span><span className="sub">{t.risk}风险 · 请求不代表审批或已调用</span></button>)}
        {!loading && !tools.length && <div className="chat-menu-hint">暂无启用 Tool</div>}
      </>}
    </div>
  </div>;
}
