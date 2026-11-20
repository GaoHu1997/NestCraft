import { Icon, CliLogo } from "@/components/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "@/api";
import type { AttachmentMeta, ChatEvent, ContextRef, ModelCandidate, SdkState, SessionMeta } from "@/api";
import { useToast } from "@/components/ui";
import { MessageList, fromChatMessage, mkMsg } from "./MessageList";
import type { OfficeFileRef, UiMessage } from "./MessageList";
import { Composer, migrateComposerDraft, clearComposerDraft } from "./Composer";
import { SessionHistory, HistoryIcon } from "./SessionHistory";
import { ModelPicker, effectiveEfforts, permissionSupported } from "./ModelPicker";
import { StatsBar } from "./StatsBar";
import { StepsBox } from "./StepsBox";
import { ChatOverlayProvider, useChatOverlay } from "./overlay";
import { addUsage, finishOnce, getRuntime, hydrateUsage, isCurrentTurn, markFirstDelta, markStreamStart, recordToolResult, recordToolUse, rebuildStepsFromPairs, clearEndedBackground, dropRuntime, setStatus } from "./sessionRuntime";
import { officeFileContentText } from "@/modules/office/office-model";
import "./chat.css";

interface ChatPanelProps {
  projectId?: string;
  serverId?: string;
  rootUri?: string;
  office?: boolean;
  officeFiles?: OfficeFileRef[];
  visible?: boolean;
  width?: number;
  height?: string;
  className?: string;
}
interface PendingSend {
  sid: string;
  text: string;
  refs: ContextRef[];
  atts: AttachmentMeta[];
  model: string | null;
  scope: string;
}
interface Turn {
  sid: string;
  generation: number;
  request: PendingSend;
  buffer: { text: string; thinking: string };
  msgs: UiMessage[];
  finished: boolean;
  accepted: boolean;
  timer: number | null;
}
const drafts = new Map<string, string>();
const sessionScope = (props: ChatPanelProps) => `${props.office ? "office" : "chat"}:${props.projectId ?? ""}:${props.serverId ?? ""}`;

/** BUG-013：同一渲染器、同 scope 单一 overlay；宽度/拖动开关由 App 负责。 */
export function ChatPanel(props: ChatPanelProps) {
  return <ChatOverlayProvider visible={props.visible !== false}><Panel {...props} /></ChatOverlayProvider>;
}

function Panel(props: ChatPanelProps) {
  const toast = useToast();
  const overlay = useChatOverlay();
  const scope = sessionScope(props);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [cur, setCur] = useState<SessionMeta | null>(null);
  const [msgs, setMsgs] = useState<UiMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [runningIds, setRunningIds] = useState<string[]>([]);
  const [cliCands, setCliCands] = useState<SdkState[]>([]);
  const [models, setModels] = useState<ModelCandidate[]>([]);
  const [sendMode, setSendMode] = useState<"queue" | "immediate">("queue");
  const [queued, setQueued] = useState(0);
  const [cfgBusy, setCfgBusy] = useState(false);
  const [bgOpenId, setBgOpenId] = useState<string | null>(null);
  const [, bump] = useState(0);
  const bumpRt = () => bump(v => v + 1);
  const currentIdRef = useRef<string | null>(null);
  const curRef = useRef<SessionMeta | null>(null);
  const scopeRef = useRef(scope);
  const visibleRef = useRef(props.visible !== false);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const draftRef = useRef("");
  const draftTimer = useRef<number | null>(null);
  const draftsPending = useRef<Map<string, Promise<unknown>>>(new Map());
  const turns = useRef(new Map<string, Turn>());
  const queues = useRef(new Map<string, PendingSend[]>());
  const sendLock = useRef(false);
  const cfgLock = useRef(false);
  const createPromise = useRef<Promise<SessionMeta> | null>(null);
  const loadSerial = useRef(0);
  const messageCache = useRef(new Map<string, UiMessage[]>());
  scopeRef.current = scope;
  visibleRef.current = props.visible !== false;
  curRef.current = cur;
  const viewing = (sid: string, targetScope = scope) => mounted.current && scopeRef.current === targetScope && currentIdRef.current === sid;
  const curRt = cur ? getRuntime(cur.id) : null;
  const running = !!cur && runningIds.includes(cur.id);

  const persistDraft = (sid: string, value: string) => {
    const prior = draftsPending.current.get(sid) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => api.chatSessionUpdate({ id: sid, draft: value }));
    draftsPending.current.set(sid, next);
    return next.catch(() => {});
  };
  const saveDraftNow = (targetScope = scopeRef.current) => {
    if (draftTimer.current !== null) { window.clearTimeout(draftTimer.current); draftTimer.current = null; }
    const sid = currentIdRef.current;
    drafts.set(`${targetScope}:${sid ?? "new"}`, draftRef.current);
    return sid ? persistDraft(sid, draftRef.current) : Promise.resolve();
  };
  const onDraftChange = (value: string) => {
    setDraft(value); draftRef.current = value;
    const sid = currentIdRef.current;
    drafts.set(`${scope}:${sid ?? "new"}`, value);
    if (draftTimer.current !== null) window.clearTimeout(draftTimer.current);
    if (sid) draftTimer.current = window.setTimeout(() => {
      draftTimer.current = null;
      void persistDraft(sid, value); // 捕获 sid/value，不能读取其他会话的草稿
    }, 800);
  };
  const setCurrent = (meta: SessionMeta | null, value: string) => {
    currentIdRef.current = meta?.id ?? null; curRef.current = meta;
    setCur(meta); setDraft(value); draftRef.current = value;
    setQueued(meta ? queues.current.get(meta.id)?.length ?? 0 : 0);
    setBgOpenId(null); overlay.close(false);
  };
  const filterSessions = (ss: SessionMeta[], project = props.projectId, server = props.serverId) => ss.filter(s =>
    project ? s.projectId === project && (!server || s.serverId === server) : server ? s.serverId === server : !s.projectId && !s.serverId
  );
  const syncMessages = (sid: string, ms: UiMessage[]) => {
    messageCache.current.set(sid, ms);
    const pairs: { toolId: string; name: string; isError: boolean; completed: boolean }[] = [];
    for (const m of ms) {
      if (m.role === "tool_use") pairs.push({ toolId: m.toolId ?? m.id, name: m.toolName ?? "工具", isError: false, completed: false });
      if (m.role === "tool_result") {
        const hit = [...pairs].reverse().find(p => p.toolId === m.toolId && !p.completed);
        if (hit) { hit.completed = true; hit.isError = m.isError; }
        else pairs.push({ toolId: m.toolId ?? m.id, name: "来源调用未记录", isError: m.isError, completed: true });
      }
    }
    rebuildStepsFromPairs(sid, pairs);
    const known = ms.some(m => m.usage);
    hydrateUsage(sid, ms.reduce((n, m) => n + (m.usage?.input ?? 0), 0), ms.reduce((n, m) => n + (m.usage?.output ?? 0), 0), known);
  };
  const markRead = async (meta: SessionMeta, targetScope = scope) => {
    if (!meta.unread || !visibleRef.current || !viewing(meta.id, targetScope)) return;
    try {
      await api.chatSessionUpdate({ id: meta.id, unread: "" });
      if (!viewing(meta.id, targetScope)) return;
      setSessions(prev => prev.map(s => s.id === meta.id ? { ...s, unread: null } : s));
      setCur(prev => prev?.id === meta.id ? { ...prev, unread: null } : prev);
      setStatus(meta.id, "read");
    } catch { /* 后端仍保留未读，不假装已读 */ }
  };
  const openSession = async (meta: SessionMeta) => {
    const targetScope = scope, token = ++loadSerial.current;
    await saveDraftNow();
    if (!mounted.current || scopeRef.current !== targetScope || token !== loadSerial.current) return;
    setCurrent(meta, drafts.get(`${scope}:${meta.id}`) ?? meta.draft ?? "");
    setMsgs(messageCache.current.get(meta.id) ?? []);
    const gen = getRuntime(meta.id).generation;
    try {
      const ms = await api.chatMessages(meta.id);
      if (!viewing(meta.id, targetScope) || token !== loadSerial.current || getRuntime(meta.id).generation !== gen) return;
      const local = turns.current.get(meta.id);
      if (local && !local.finished) setMsgs(local.msgs);
      else { const ui = ms.map(fromChatMessage); syncMessages(meta.id, ui); setMsgs(ui); }
      if (await api.chatStatus(meta.id)) setRunningIds(prev => prev.includes(meta.id) ? prev : [...prev, meta.id]);
      else if (viewing(meta.id, targetScope)) setRunningIds(prev => prev.filter(id => id !== meta.id));
      await markRead(meta, targetScope); bumpRt();
    } catch (e) { if (viewing(meta.id, targetScope)) toast(String(e), "err"); }
  };
  const createSession = (preserveNewDraft = false): Promise<SessionMeta> => {
    if (createPromise.current) return createPromise.current;
    const targetScope = scope;
    const previous = curRef.current;
    const pendingDraft = !previous && preserveNewDraft ? draftRef.current : "";
    const args: Parameters<typeof api.chatSessionCreate>[0] = {
      ...(props.projectId ? { projectId: props.projectId } : {}), ...(props.serverId ? { serverId: props.serverId } : {}),
      ...(previous?.cliId ? { cliId: previous.cliId } : cliCands[0] ? { cliId: cliCands[0].id } : {}),
      ...(previous?.providerId ? { providerId: previous.providerId } : {}), ...(previous?.modelId ? { modelId: previous.modelId } : {}),
      ...(previous?.effort ? { effort: previous.effort } : {}),
    };
    const work = (async () => {
      await saveDraftNow(); // 新会话也必须先保存旧会话，包含空草稿
      const meta = await api.chatSessionCreate(args);
      if (mounted.current && scopeRef.current === targetScope) {
        ++loadSerial.current;
        setSessions(prev => [meta, ...prev.filter(s => s.id !== meta.id)]);
        if (!previous && preserveNewDraft) {
          migrateComposerDraft(`${targetScope}:new`, `${targetScope}:${meta.id}`);
          drafts.set(`${targetScope}:${meta.id}`, pendingDraft);
          void persistDraft(meta.id, pendingDraft);
        }
        setCurrent(meta, pendingDraft); setMsgs([]);
      }
      return meta;
    })();
    createPromise.current = work;
    void work.finally(() => { if (createPromise.current === work) createPromise.current = null; }).catch(() => {});
    return work;
  };
  const newSession = () => { void createSession().catch(e => toast(String(e), "err")); };
  const deleteSession = async (id: string) => {
    try { await api.chatSessionDelete(id); }
    catch (e) { toast(String(e), "err"); return; }
    turns.current.delete(id); queues.current.delete(id); messageCache.current.delete(id); dropRuntime(id);
    drafts.delete(`${scope}:${id}`);
    const rest = sessions.filter(s => s.id !== id);
    setSessions(rest); setRunningIds(prev => prev.filter(x => x !== id));
    if (currentIdRef.current === id) {
      setCurrent(null, ""); setMsgs([]);
      if (rest[0]) void openSession(rest[0]);
    }
  };
  const refreshSessions = async (targetScope = scope) => {
    try {
      const list = filterSessions(await api.chatSessions(props.projectId));
      if (!mounted.current || scopeRef.current !== targetScope) return;
      setSessions(list);
      setCur(prev => prev ? list.find(s => s.id === prev.id) ?? prev : prev);
      const current = list.find(s => s.id === currentIdRef.current);
      if (current) void markRead(current, targetScope);
    } catch { /* 不以失败的刷新覆盖现有会话 */ }
  };

  useEffect(() => {
    mounted.current = true;
    return () => { void saveDraftNow(); mounted.current = false; };
  }, []);
  useEffect(() => {
    const requestEpoch = ++epoch.current;
    ++loadSerial.current;
    setCurrent(null, drafts.get(`${scope}:new`) ?? ""); setMsgs([]); setSessions([]);
    let alive = true;
    void (async () => {
      try {
        const ss = filterSessions(await api.chatSessions(props.projectId));
        if (!alive || epoch.current !== requestEpoch) return;
        setSessions(ss);
        if (ss[0]) await openSession(ss[0]);
      } catch (e) { if (alive) toast(String(e), "err"); }
    })();
    return () => { alive = false; void saveDraftNow(scope); };
  }, [scope]);
  useEffect(() => {
    let alive = true, inventoryGeneration = 0;
    const load = async () => {
      const gen = ++inventoryGeneration;
      const [clis, mds] = await Promise.all([api.sdkCliCandidates().catch(() => [] as SdkState[]), api.modelCandidates().catch(() => [] as ModelCandidate[])]);
      const value = await api.getSetting("chat.sendMode").catch(() => null) ?? await api.getSetting("chat.sendBehavior").catch(() => null);
      if (!alive || gen !== inventoryGeneration) return;
      setCliCands(clis.filter(c => c.enabled && c.installState === "installed")); setModels(mds);
      setSendMode(value === "immediate" ? "immediate" : "queue");
    };
    void load();
    window.addEventListener("app:settings-changed", load);
    return () => { alive = false; window.removeEventListener("app:settings-changed", load); };
  }, []);
  useEffect(() => { if (props.visible !== false && cur) void markRead(cur); }, [props.visible, cur?.id, cur?.unread]);

  const publish = (turn: Turn) => {
    messageCache.current.set(turn.sid, turn.msgs);
    if (viewing(turn.sid, turn.request.scope)) setMsgs([...turn.msgs]);
  };
  const flush = (turn: Turn) => {
    if (turn.timer !== null) { window.clearTimeout(turn.timer); turn.timer = null; }
    const b = turn.buffer;
    if (!b.text && !b.thinking) return;
    markFirstDelta(turn.sid);
    const id = `stream-${turn.sid}-${turn.generation}`;
    let message = turn.msgs.find(m => m.id === id);
    if (!message) { message = mkMsg({ id, role: "assistant", streaming: true, model: turn.request.model, createdAt: Date.now() }); turn.msgs.push(message); }
    message.content += b.text; message.thinking = (message.thinking ?? "") + b.thinking;
    turn.buffer = { text: "", thinking: "" }; publish(turn);
  };
  const waitSettled = async (sid: string) => {
    for (let i = 0; i < 60; i++) {
      if (!await api.chatStatus(sid)) return;
      await new Promise(r => window.setTimeout(r, 100));
    }
    throw new Error("当前请求尚未静止，请稍后重试；没有启动下一轮");
  };
  const restoreQueued = (request: PendingSend, message: string) => {
    const key = `${request.scope}:${request.sid}`;
    const value = [drafts.get(key), request.text].filter(Boolean).join("\n");
    drafts.set(key, value); void persistDraft(request.sid, value);
    if (viewing(request.sid, request.scope)) { onDraftChange(value); toast(message, "err"); }
  };
  const finalize = async (turn: Turn, error?: string, stopped = false) => {
    if (turn.finished || !isCurrentTurn(turn.sid, turn.generation)) return;
    flush(turn);
    const failedTool = getRuntime(turn.sid).steps.some(s => s.state === "failed");
    if (!finishOnce(turn.sid, turn.generation, error || stopped || failedTool ? "failed" : "success")) return;
    turn.finished = true;
    turn.msgs = turn.msgs.map(m => ({ ...m, streaming: false }));
    if (error || stopped) turn.msgs.push(mkMsg({ id: `error-${turn.sid}-${turn.generation}`, role: "error", content: error ?? "已停止本次生成", isError: true, createdAt: Date.now() }));
    publish(turn); bumpRt();
    try {
      await waitSettled(turn.sid); // done可能早于后端移除RUNNING；绝不能抢跑下一轮
      if (getRuntime(turn.sid).generation !== turn.generation) return;
      if (!error && !stopped) {
        const ms = await api.chatMessages(turn.sid);
        if (getRuntime(turn.sid).generation !== turn.generation) return;
        const ui = ms.map(fromChatMessage); syncMessages(turn.sid, ui);
        if (viewing(turn.sid, turn.request.scope)) setMsgs(ui);
      }
      const meta = await api.chatSessionGet(turn.sid);
      if (meta.title === "新会话" && turn.request.text.trim()) await api.chatSessionUpdate({ id: turn.sid, title: turn.request.text.trim().slice(0, 32) });
      if (scopeRef.current === turn.request.scope) await refreshSessions(turn.request.scope);
    } catch (e) {
      // 静止状态未知时阻止自动排队，不假设后端已经停下。
      if (viewing(turn.sid, turn.request.scope)) toast(String(e), "warn");
      return;
    }
    if (mounted.current) setRunningIds(prev => prev.filter(x => x !== turn.sid));
    const next = queues.current.get(turn.sid)?.shift();
    if (viewing(turn.sid, turn.request.scope)) setQueued(queues.current.get(turn.sid)?.length ?? 0);
    if (next) {
      try { if (!await dispatch(next)) restoreQueued(next, "排队消息发送失败，内容已保留为该会话草稿"); }
      catch (e) { restoreQueued(next, String(e)); }
    }
  };
  const dispatch = async (request: PendingSend): Promise<boolean> => {
    await waitSettled(request.sid);
    const generation = markStreamStart(request.sid);
    const turn: Turn = { sid: request.sid, generation, request, buffer: { text: "", thinking: "" }, msgs: [...(messageCache.current.get(request.sid) ?? [])], finished: false, accepted: false, timer: null };
    turns.current.set(request.sid, turn);
    const uid = `user-${request.sid}-${generation}`;
    turn.msgs.push(mkMsg({ id: uid, role: "user", content: request.text, refs: request.refs, attachments: request.atts, createdAt: Date.now() }));
    publish(turn); setRunningIds(prev => prev.includes(request.sid) ? prev : [...prev, request.sid]); bumpRt();
    const onEvent = (ev: ChatEvent) => {
      if (turn.finished || !isCurrentTurn(request.sid, generation)) return;
      switch (ev.type) {
        case "delta": case "thinking":
          if (ev.type === "delta") turn.buffer.text += ev.delta; else turn.buffer.thinking += ev.delta;
          if (turn.timer === null) turn.timer = window.setTimeout(() => { turn.timer = null; if (!turn.finished) flush(turn); }, 50);
          break;
        case "toolUse":
          flush(turn); recordToolUse(request.sid, ev.toolId, ev.name);
          if (!turn.msgs.some(m => m.id === `tu-${generation}-${ev.toolId}`)) turn.msgs.push(mkMsg({ id: `tu-${generation}-${ev.toolId}`, role: "tool_use", toolId: ev.toolId, toolName: ev.name, inputJson: ev.inputJson, streaming: true, createdAt: Date.now() }));
          publish(turn); bumpRt(); break;
        case "toolResult":
          flush(turn); recordToolResult(request.sid, ev.toolId, ev.isError);
          if (!turn.msgs.some(m => m.id === `tr-${generation}-${ev.toolId}`)) turn.msgs.push(mkMsg({ id: `tr-${generation}-${ev.toolId}`, role: "tool_result", content: ev.content, toolId: ev.toolId, isError: ev.isError, createdAt: Date.now() }));
          publish(turn); bumpRt(); break;
        case "usage": addUsage(request.sid, ev.inputTokens, ev.outputTokens, ev.cacheReadTokens, String(generation)); bumpRt(); break;
        case "subagent": {
          const rt = getRuntime(request.sid);
          const row = { id: ev.id, cli: "unknown", title: ev.task, model: "未知", duration: "未上报", tokens: "未上报", status: ev.status === "failed" ? "失败" as const : ev.status === "done" || ev.status === "success" ? "成功" as const : "待确认" as const };
          const index = rt.subagents.findIndex(a => a.id === ev.id);
          if (index >= 0) rt.subagents[index] = row; else rt.subagents.push(row);
          bumpRt(); break;
        }
        case "approvalRequest":
          setStatus(request.sid, "pending");
          turn.msgs.push(mkMsg({ id: `approval-${ev.requestId}`, role: "system", content: `待处理：${ev.toolName}。当前非交互CLI适配器未提供可用的人工审批流程，未自动放行。` })); publish(turn); bumpRt(); break;
        case "error": void finalize(turn, ev.message); break;
        case "done": void finalize(turn); break;
      }
    };
    try {
      const meta = await api.chatSessionGet(request.sid);
      const permissionId = permissionSupported(meta.cliId) ? "agent" : undefined;
      await api.chatSend({ sessionId: request.sid, content: request.text, refs: request.refs, attachments: request.atts, ...(permissionId ? { permissionId } : {}) }, onEvent);
      turn.accepted = true;
      return true;
    } catch (e) {
      turn.msgs = turn.msgs.filter(m => m.id !== uid);
      void finalize(turn, String(e));
      return false;
    }
  };

  const startSend = async (text: string, refs: ContextRef[], atts: AttachmentMeta[]): Promise<boolean> => {
    if (!text.trim() || sendLock.current || cfgLock.current) return false;
    sendLock.current = true;
    const targetScope = scope;
    const originalDraft = draftRef.current;
    try {
      let meta = curRef.current;
      if (!meta) {
        const unsent = draftRef.current;
        meta = await createSession(true);
        drafts.set(`${targetScope}:${meta.id}`, unsent);
        migrateComposerDraft(`${targetScope}:new`, `${targetScope}:${meta.id}`);
        if (viewing(meta.id, targetScope)) onDraftChange(unsent);
      }
      if (scopeRef.current !== targetScope) return false;
      if (!meta.cliId || !cliCands.some(c => c.id === meta!.cliId)) { toast("CLI 未配置或已失效，请重新选择已安装且启用的 CLI", "err"); return false; }
      const model = models.find(m => m.providerId === meta!.providerId && m.modelId === meta!.modelId);
      if (meta.modelId && !model) { toast("会话模型已失效，请重新选择可用模型", "err"); return false; }
      if (model && meta.effort && !effectiveEfforts(model.efforts).includes(meta.effort)) { toast("思考档位已失效，请在模型浮层重新选择", "err"); return false; }
      const enriched: ContextRef[] = [];
      for (const ref of refs) {
        if (ref.objectId.startsWith("office:")) {
          if (!props.projectId || !props.officeFiles?.some(f => `office:${f.id}` === ref.objectId)) { toast("办公引用不属于当前项目，未发送", "err"); return false; }
          const content = officeFileContentText(props.projectId, ref.objectId.slice(7));
          if (!content) { toast(`引用不可读取：${ref.display}，草稿已保留`, "err"); return false; }
          enriched.push({ ...ref, content: content.slice(0, 12000) });
        } else if (ref.kind === "session") {
          if (!sessions.some(s => s.id === ref.objectId)) { toast("引用会话不属于当前项目，未发送", "err"); return false; }
          // 现有后端不处理 session 引用；真实读取当前项目会话并明确注入消息，不伪调用。
          const source = await api.chatMessages(ref.objectId);
          text += `\n\n[引用当前项目会话：${ref.display}]\n${source.filter(m => m.role === "user" || m.role === "assistant").map(m => `${m.role}: ${m.content}`).join("\n").slice(0, 12000)}`;
          // 引用已展开为受检会话正文；现后端没有session类型，不能仍发送不支持的引用。
        } else enriched.push(ref);
      }
      const request: PendingSend = { sid: meta.id, text, refs: enriched.map(r => ({ ...r })), atts: atts.map(a => ({ ...a })), model: meta.modelId, scope: targetScope };
      const active = turns.current.get(meta.id);
      const acceptDraft = () => {
        // 请求等待期间用户新写的文本/附件不能被完成回调清掉。
        if (drafts.get(`${targetScope}:${meta!.id}`) !== originalDraft) return;
        clearComposerDraft(`${targetScope}:${meta!.id}`);
        drafts.set(`${targetScope}:${meta!.id}`, "");
        if (viewing(meta!.id, targetScope)) onDraftChange("");
        else void persistDraft(meta!.id, "");
      };
      if ((active && !active.finished) || await api.chatStatus(meta.id)) {
        if (sendMode === "queue") {
          const list = queues.current.get(meta.id) ?? []; list.push(request); queues.current.set(meta.id, list); setQueued(list.length);
          acceptDraft();
          return true;
        }
        const cancelled = queues.current.get(meta.id) ?? [];
        queues.current.delete(meta.id); setQueued(0);
        for (const pending of cancelled) restoreQueued(pending, "立即发送取消了旧排队，内容已保留");
        const aborting = api.chatAbort(meta.id);
        const finishing = active && !active.finished ? finalize(active, undefined, true) : Promise.resolve();
        await aborting;
        await finishing;
        await waitSettled(meta.id);
      }
      const accepted = await dispatch(request);
      if (accepted) acceptDraft();
      return accepted;
    } catch (e) { toast(String(e), "err"); return false; }
    finally { sendLock.current = false; }
  };
  const stopSend = async () => {
    const sid = currentIdRef.current; if (!sid) return;
    // 用户停止也取消待发送队列，保留文本到原会话；不能停完立即又自动发送。
    const pending = queues.current.get(sid) ?? [];
    queues.current.delete(sid); setQueued(0);
    for (const request of pending) restoreQueued(request, "已取消排队，内容已恢复到草稿");
    const turn = turns.current.get(sid);
    try {
      const aborting = api.chatAbort(sid);
      const finishing = turn && !turn.finished ? finalize(turn, undefined, true) : Promise.resolve();
      await aborting;
      await finishing;
      if (!turn) { await waitSettled(sid); setRunningIds(prev => prev.filter(x => x !== sid)); }
    } catch (e) { toast(String(e), "err"); }
  };
  // 恢复的运行没有本地Channel时只轮询状态，不造工具或回复。
  useEffect(() => {
    if (!runningIds.length) return;
    const timer = window.setInterval(() => {
      for (const sid of runningIds) {
        if (turns.current.get(sid) && !turns.current.get(sid)!.finished) continue;
        void api.chatStatus(sid).then(async busy => {
          if (busy || !mounted.current) return;
          setRunningIds(prev => prev.filter(x => x !== sid));
          if (viewing(sid)) {
            const ms = (await api.chatMessages(sid)).map(fromChatMessage);
            if (!getRuntime(sid).active && viewing(sid)) { syncMessages(sid, ms); setMsgs(ms); await refreshSessions(); }
          }
        }).catch(() => {});
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [runningIds]);

  const applyCfg = async (patch: { cliId?: string; providerId?: string; modelId?: string; effort?: string }) => {
    if (cfgLock.current || sendLock.current || running) { toast("运行快照已锁定，停止并静止后再调整执行配置", "warn"); return; }
    cfgLock.current = true; setCfgBusy(true);
    try {
      const meta = curRef.current ?? await createSession(true);
      if (await api.chatStatus(meta.id)) throw new Error("会话仍在运行，配置未更改");
      await api.chatSessionUpdate({ id: meta.id, ...patch });
      const updated = { ...meta, ...patch };
      if (viewing(meta.id)) { curRef.current = updated; setCur(updated); }
      setSessions(prev => prev.map(s => s.id === meta.id ? updated : s));
    } catch (e) { toast(String(e), "warn"); }
    finally { cfgLock.current = false; setCfgBusy(false); }
  };

  const statsData = useMemo(() => ({
    rounds: msgs.filter(m => m.role === "user").length, msgs: msgs.length,
    modelMs: curRt?.timingKnown ? curRt.modelMs : null, toolMs: curRt?.timingKnown ? curRt.toolMs : null,
    ttftMs: curRt?.ttftMs ?? null, tps: null,
    tokensIn: curRt?.usageKnown ? curRt.tokensIn : null, tokensOut: curRt?.usageKnown ? curRt.tokensOut : null,
    cacheRead: curRt?.cacheKnown ? curRt.cacheRead : null, contextUsed: null,
    contextLimit: models.find(m => m.providerId === cur?.providerId && m.modelId === cur?.modelId)?.contextWindow ?? null,
  }), [msgs, cur, models, curRt?.tokensIn, curRt?.tokensOut, curRt?.cacheRead, curRt?.timingKnown, curRt?.ttftMs]);
  const agentCount = curRt?.subagents.length ?? 0, bgCount = curRt?.background.length ?? 0;
  const newButton = <button className="chat-iconbtn" title="新会话" aria-label="新会话" onClick={newSession}><Icon name="plus" /></button>;
  return <div ref={overlay.scopeRef} className={`chat-panel ${props.className ?? ""}`} hidden={props.visible === false} aria-label="AI 会话" data-ai-scope={scope} style={{ height: props.height ?? "100%", ...(props.width ? { width: Math.min(620, Math.max(320, props.width)) } : {}) }}>
    <div className="chat-head">
      <button className={`chat-iconbtn ${overlay.activeOverlay === "history" ? "active" : ""}`} data-chat-overlay-trigger="history" title="会话历史" aria-label="会话历史" aria-expanded={overlay.activeOverlay === "history"} onClick={e => overlay.toggle("history", e.currentTarget)}><HistoryIcon /></button>
      {agentCount > 0 && <div className="chat-drop-wrap"><button className="chat-count-btn" data-chat-overlay-trigger="agents" aria-expanded={overlay.activeOverlay === "agents"} onClick={e => overlay.toggle("agents", e.currentTarget)}><Icon name="users" size={14} />{agentCount} 子智能体 <Icon name="chevronDown" size={12} /></button>
        {overlay.activeOverlay === "agents" && <div className="chat-drop" data-chat-overlay="agents" role="dialog" aria-label="子智能体"><div className="chat-drop-h"><b>子智能体</b><span className="chat-drop-cap">{agentCount} 个 · 仅本会话</span></div><div className="chat-drop-list">{curRt!.subagents.map(a => <div key={a.id} className="chat-agent-row"><CliLogo id={a.cli} size={20} /><span className="chat-agent-main"><b>{a.title}</b><span>{a.model} · {a.duration} · {a.tokens}</span></span><span className={`tag ${a.status === "失败" ? "bad" : a.status === "待确认" ? "warn" : "good"}`}>{a.status}</span></div>)}</div><div className="chat-drop-f">{curRt!.recordsDemo ? "合成演示 · 不调用真实 CLI" : "来自本会话子代理事件 · 未上报的用量/引擎保持未知"}</div></div>}
      </div>}
      {bgCount > 0 && <div className="chat-drop-wrap"><button className="chat-count-btn" data-chat-overlay-trigger="bg" aria-expanded={overlay.activeOverlay === "bg"} onClick={e => overlay.toggle("bg", e.currentTarget)}><Icon name="terminal" size={14} />{bgCount} 后台任务 <Icon name="chevronDown" size={12} /></button>
        {overlay.activeOverlay === "bg" && <div className="chat-drop chat-drop-bg" data-chat-overlay="bg" role="dialog" aria-label="后台任务"><div className="chat-drop-h"><b>后台任务</b><span className="chat-drop-cap">仅本会话</span></div><div className="chat-drop-list">{[true, false].map(active => { const rows = curRt!.background.filter(b => (b.state === "运行中") === active); return <div className="chat-bg-group" key={String(active)}><div className="chat-bg-group-h"><span>{active ? "进行中" : "已结束"} {rows.length}</span>{!active && <button className="chat-bg-clear" disabled={!rows.length} onClick={() => { clearEndedBackground(cur!.id); setBgOpenId(null); if (!getRuntime(cur!.id).background.length) overlay.close(false); bumpRt(); }}>清空已结束</button>}</div>{!rows.length && <div className="chat-bg-empty">暂无记录</div>}{rows.map(b => <div className="chat-bg-row" key={b.id}><button className="chat-bg-head" aria-expanded={bgOpenId === b.id} onClick={() => setBgOpenId(prev => prev === b.id ? null : b.id)}><span className={`chat-bg-dot ${b.state === "运行中" ? "run" : b.state === "完成" ? "ok" : "fail"}`} /><span className="chat-bg-main"><b>{b.cmd}</b><span>{b.state} · 退出码 {b.exit} · {b.duration}</span></span><Icon name="chevronDown" size={12} /></button>{bgOpenId === b.id && <div className="chat-bg-detail"><span className="chat-bg-jobid">jobId {b.id}</span><pre>{b.output || "暂无输出"}</pre></div>}</div>)}</div>; })}</div><div className="chat-drop-f">{curRt!.recordsDemo ? "合成演示 · " : ""}只清展示，不终止任务</div></div>}
      </div>}
      <span className="spacer" />{newButton}
    </div>
    <div className="chat-fade" />
    {overlay.activeOverlay === "history" && <SessionHistory sessions={sessions} currentId={cur?.id ?? null} runningIds={runningIds} onSwitch={openSession} onNew={newSession} onDelete={deleteSession} onClose={() => overlay.close(true)} />}
    <MessageList msgs={msgs} projectId={props.projectId} rootUri={props.rootUri} officeFiles={props.officeFiles} visible={props.visible} stepsSlot={<>{queued > 0 && <div className="chat-queued">已排队 {queued} 条，当前静止后发送</div>}{curRt && curRt.steps.length > 0 && <StepsBox steps={curRt.steps} demo={curRt.stepsDemo} preview={Boolean((window as unknown as { __DESIGN_PREVIEW__?: boolean }).__DESIGN_PREVIEW__)} open={curRt.stepsOpen} sid={cur!.id} onToggle={() => { curRt.stepsOpen = !curRt.stepsOpen; bumpRt(); }} bump={bumpRt} />}</>} />
    <div className="chat-composer-wrap">
      <Composer scopeKey={`${scope}:${cur?.id ?? "new"}`} rootUri={props.rootUri} projectId={props.projectId} office={props.office} officeFiles={props.officeFiles} sessions={sessions} value={draft} streaming={running} disabled={cfgBusy} onChange={onDraftChange} onSend={startSend} onStop={stopSend} controls={<ModelPicker cliId={cur?.cliId ?? null} providerId={cur?.providerId ?? null} modelId={cur?.modelId ?? null} effort={cur?.effort ?? null} cliCandidates={cliCands} models={models} locked={running || cfgBusy} onChange={applyCfg} />} />
      <StatsBar data={statsData} />
      <div className="chat-foot"><span>Enter 发送 · Shift+Enter 换行</span><span>{cur?.cliId ?? "CLI 未配置"} · {permissionSupported(cur?.cliId) ? "代理模式" : "权限未验证"}</span></div>
    </div>
  </div>;
}
