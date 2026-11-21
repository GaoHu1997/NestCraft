import { Icon, CliLogo } from "@/components/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "@/api";
import type { AttachmentMeta, ChatEvent, ContextRef, ModelCandidate, SdkState, SessionBinding, SessionMeta } from "@/api";
import { Confirm, useToast } from "@/components/ui";
import { MessageList, fromChatMessage, mkMsg } from "./MessageList";
import type { OfficeFileRef, UiMessage } from "./MessageList";
import { Composer, migrateComposerDraft, clearComposerDraft } from "./Composer";
import { SessionHistory, HistoryIcon } from "./SessionHistory";
import { ModelPicker, effectiveEfforts, permissionSupported } from "./ModelPicker";
import { StatsBar } from "./StatsBar";
import { StepsBox } from "./StepsBox";
import { ChatOverlayProvider, useChatOverlay } from "./overlay";
import { addUsage, finishOnce, getRuntime, hydrateUsage, isCurrentTurn, markFirstDelta, markStreamStart, recordToolResult, recordToolUse, rebuildStepsFromPairs, clearEndedBackground, dropRuntime, setStatus, setGoal, updateGoalState, addSessionTask, upsertSubagent, hasBlockingChildren } from "./sessionRuntime";
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
  /** CR-047：本工作区当前选定的特性；新建会话绑定它，已有会话保留原绑定。 */
  featureTarget?: { featureId: string; featureTitle: string } | null;
}
interface PendingSend {
  sid: string;
  text: string;
  refs: ContextRef[];
  atts: AttachmentMeta[];
  model: string | null;
  /** CR-056：本轮 CLI，子智能体等派生行未单独上报时继承它。 */
  cliId: string | null;
  permissionId: string | null;
  scope: string;
}

/** CR-037：原因码 → 中文摘要（横幅/弹窗共用；与后端 reason_text 口径一致）。 */
const REASON_TEXT: Record<string, string> = {
  REF_MISSING: "引用缺失（历史无原生绑定）",
  REF_STALE: "原线程引用已过期",
  REF_NOT_READY: "引用尚未就绪，请重试",
  INCOMPATIBLE_CLI: "CLI 或版本不兼容",
  INCOMPATIBLE_STORE: "后端实例或存储位置不兼容",
  GRANT_REVOKED: "知识授权已变化或撤销",
  STOPPED: "本轮已停止",
  LATE: "本轮结果迟到",
  ADAPTER_REFUSED: "适配器未确认回到同一线程",
  UNSUPPORTED_CLI: "当前 CLI 不支持原生续接",
};
const reasonLabel = (code: string | null | undefined) =>
  (code && REASON_TEXT[code]) || code || "原因未知";
const BINDING_PILL: Record<string, string> = {
  native: "已续接",
  fresh: "fresh 上下文",
  freshPending: "待确认",
  blocked: "不可续接",
};
interface Turn {
  sid: string;
  generation: number;
  request: PendingSend;
  buffer: { text: string; thinking: string };
  /** CR-056：思考阶段计时（首段 thinking → 首段正文），用于折叠态显示"思考 持续 N 秒"。 */
  thinkStarted: number | null;
  thinkMs: number | null;
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
  const [permissionBySession, setPermissionBySession] = useState<Record<string, string>>({});
  const [sendMode, setSendMode] = useState<"queue" | "immediate">("queue");
  const [queued, setQueued] = useState(0);
  const [cfgBusy, setCfgBusy] = useState(false);
  const [bgOpenId, setBgOpenId] = useState<string | null>(null);
  // CR-037：fresh 重建确认弹窗与切换 CLI 另建会话确认弹窗
  const [freshConfirm, setFreshConfirm] = useState<SessionBinding | null>(null);
  const [cliSwitchTarget, setCliSwitchTarget] = useState<string | null>(null);
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
  // CR-037：当前会话绑定状态（阻塞时禁输入但保留草稿与历史；REF_NOT_READY 可直接重试）
  const binding = cur?.sessionRole === "executor" ? null : cur?.binding ?? null;
  const composerLocked =
    cfgBusy ||
    (binding?.state === "blocked" && binding.reasonCode !== "REF_NOT_READY") ||
    binding?.state === "freshPending";
  const executionLocked = running || (cur ? hasBlockingChildren(cur.id) : false);

  /** AC-06：fresh 重建确认 → CAS 清空旧引用 + 断点卡；失败（已有新轮）提示刷新。 */
  const confirmFresh = async (info: SessionBinding) => {
    const sid = curRef.current?.id;
    if (!sid) return;
    try {
      await api.chatSessionConfirmFresh(sid, info.expectedRevision, info.reasonCode);
      setFreshConfirm(null);
      const meta = await api.chatSessionGet(sid);
      setSessions(prev => prev.map(s => s.id === meta.id ? { ...s, binding: meta.binding ?? null, messageCount: meta.messageCount } : s));
      if (viewing(sid)) {
        curRef.current = { ...curRef.current!, binding: meta.binding ?? null, messageCount: meta.messageCount };
        setCur(curRef.current);
        const ui = (await api.chatMessages(sid)).map(fromChatMessage);
        syncMessages(sid, ui); setMsgs(ui);
      }
      void refreshSessions();
    } catch (e) { toast(String(e), "err"); }
  };

  /** STORY-011 AC-05 / AC-06：非空会话切 CLI → 确认后另建会话，保留原 CLI/模型配置与历史。 */
  const switchCliNewSession = async (cliId: string) => {
    const meta = curRef.current;
    setCliSwitchTarget(null);
    if (!meta) return;
    try {
      const created = await api.chatSessionCreate({
        ...(props.projectId ? { projectId: props.projectId } : {}),
        ...(props.serverId ? { serverId: props.serverId } : {}),
        cliId,
        ...(meta.providerId ? { providerId: meta.providerId } : {}),
        ...(meta.modelId ? { modelId: meta.modelId } : {}),
        ...(meta.effort ? { effort: meta.effort } : {}),
        ...(meta.featureId ? { featureId: meta.featureId } : {}),
      });
      ++loadSerial.current;
      setSessions(prev => [created, ...prev.filter(s => s.id !== created.id)]);
      setCurrent(created, drafts.get(`${scope}:${created.id}`) ?? "");
      setMsgs([]);
    } catch (e) { toast(String(e), "err"); }
  };

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
    setBgOpenId(null); setFreshConfirm(null); setCliSwitchTarget(null); overlay.close(false);
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
  const createSession = (preserveNewDraft = false, featureId?: string | null): Promise<SessionMeta> => {
    if (createPromise.current) return createPromise.current;
    const targetScope = scope;
    const previous = curRef.current;
    const pendingDraft = !previous && preserveNewDraft ? draftRef.current : "";
    const args: Parameters<typeof api.chatSessionCreate>[0] = {
      ...(props.projectId ? { projectId: props.projectId } : {}), ...(props.serverId ? { serverId: props.serverId } : {}),
      ...(previous?.cliId ? { cliId: previous.cliId } : cliCands[0] ? { cliId: cliCands[0].id } : {}),
      ...(previous?.providerId ? { providerId: previous.providerId } : {}), ...(previous?.modelId ? { modelId: previous.modelId } : {}),
      ...(previous?.effort ? { effort: previous.effort } : {}),
      ...(featureId ? { featureId } : {}),
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
  const newSession = () => { void createSession(false, props.featureTarget?.featureId).catch(e => toast(String(e), "err")); };
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
    const create = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; featureId?: string }>).detail;
      if (!detail?.featureId || detail.projectId !== props.projectId) return;
      void createSession(false, detail.featureId).catch(e => toast(String(e), "err"));
    };
    window.addEventListener("app:new-execution-session", create);
    return () => window.removeEventListener("app:new-execution-session", create);
  }, [createSession, props.projectId, toast]);
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
    if (b.thinking && turn.thinkStarted === null) turn.thinkStarted = Date.now();
    if (b.text && turn.thinkMs === null && turn.thinkStarted !== null) turn.thinkMs = Date.now() - turn.thinkStarted;
    const id = `stream-${turn.sid}-${turn.generation}`;
    let message = turn.msgs.find(m => m.id === id);
    if (!message) { message = mkMsg({ id, role: "assistant", streaming: true, model: turn.request.model, createdAt: Date.now() }); turn.msgs.push(message); }
    message.content += b.text; message.thinking = (message.thinking ?? "") + b.thinking;
    if (turn.thinkMs !== null) message.thinkingMs = turn.thinkMs;
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
  /** CR-037：发送在进入 CLI 前被绑定拒绝——只清理本轮 UI 状态，不写错误卡、不触发排队。 */
  const rejectBeforeSend = (turn: Turn) => {
    if (turn.finished || !isCurrentTurn(turn.sid, turn.generation)) return;
    turn.finished = true;
    finishOnce(turn.sid, turn.generation, "failed");
    publish(turn);
    if (mounted.current) setRunningIds(prev => prev.filter(x => x !== turn.sid));
  };
  const finalize = async (turn: Turn, error?: string, stopped = false) => {
    if (turn.finished || !isCurrentTurn(turn.sid, turn.generation)) return;
    flush(turn);
    const failedTool = getRuntime(turn.sid).steps.some(s => s.state === "failed");
    if (!finishOnce(turn.sid, turn.generation, error || stopped || failedTool ? "failed" : "success")) return;
    turn.finished = true;
    if (turn.thinkMs === null && turn.thinkStarted !== null) turn.thinkMs = Date.now() - turn.thinkStarted;
    turn.msgs = turn.msgs.map(m => (m.role === "assistant" && m.thinkingMs == null && turn.thinkMs !== null ? { ...m, streaming: false, thinkingMs: turn.thinkMs } : { ...m, streaming: false }));
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
    const turn: Turn = { sid: request.sid, generation, request, buffer: { text: "", thinking: "" }, thinkStarted: null, thinkMs: null, msgs: [...(messageCache.current.get(request.sid) ?? [])], finished: false, accepted: false, timer: null };
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
          const row = upsertSubagent(request.sid, ev);
          // 子智能体没有自带 CLI 上报时沿用本轮 CLI，避免显示成"未知"。
          const agentCli = row.cli ?? request.cliId ?? null;
          const existing = turn.msgs.find(m => m.id === `subagent-${ev.id}`);
          if (existing) {
            existing.content = row.output || row.title;
            existing.sourceLabel = row.status;
            existing.producerTask = row.title;
            existing.producerId = row.id;
            existing.cli = agentCli;
          } else {
            turn.msgs.push(mkMsg({ id: `subagent-${ev.id}`, role: "subagent", content: row.output || row.title, sourceLabel: row.status, producerId: row.id, producerTask: row.title, cli: agentCli, createdAt: Date.now() }));
          }
          publish(turn); bumpRt(); break;
        }
        case "approvalRequest":
          setStatus(request.sid, "pending");
          turn.msgs.push(mkMsg({ id: `approval-${ev.requestId}`, role: "system", content: `待处理：${ev.toolName}。当前非交互CLI适配器未提供可用的人工审批流程，未自动放行。` })); publish(turn); bumpRt(); break;
        case "retrying":
          turn.msgs.push(mkMsg({ id: `retry-${request.sid}-${generation}-${ev.attempt}`, role: "system", kind: "retrying", content: `供应商暂时不可用（${ev.reason}），${ev.delayMs}ms 后重试（${ev.attempt}/${ev.maxAttempts}）`, createdAt: Date.now() }));
          publish(turn); bumpRt(); break;
        case "error": void finalize(turn, ev.message); break;
        case "done": void finalize(turn); break;
      }
    };
    try {
      const meta = await api.chatSessionGet(request.sid);
      const permissionId = request.permissionId || "default";
      // CR-037：freshPending/blocked 会话在后端被拒（用户消息未持久化，草稿保留）。
      const b = meta.binding;
      if (b?.state === "freshPending") {
        turn.msgs = turn.msgs.filter(m => m.id !== uid);
        rejectBeforeSend(turn);
        setFreshConfirm(b);
        toast("当前会话需要确认重建上下文后才能发送", "warn");
        return false;
      }
      if (b?.state === "blocked" && b.reasonCode !== "REF_NOT_READY") {
        turn.msgs = turn.msgs.filter(m => m.id !== uid);
        rejectBeforeSend(turn);
        toast(`原线程不可续接（${reasonLabel(b.reasonCode)}），请重建上下文或另建会话`, "err");
        return false;
      }
      await api.chatSend({ sessionId: request.sid, content: request.text, refs: request.refs, attachments: request.atts, ...(permissionId ? { permissionId } : {}) }, onEvent);
      turn.accepted = true;
      return true;
    } catch (e) {
      turn.msgs = turn.msgs.filter(m => m.id !== uid);
      // 后端绑定拒绝（BINDING_FRESH_REQUIRED/BINDING_BLOCKED）：打开确认弹窗而非报错。
      const msg = String(e);
      const bindMatch = /BINDING_(FRESH_REQUIRED|BLOCKED)\|([^|]*)\|(\d+)\|/.exec(msg);
      if (bindMatch) {
        const info: SessionBinding = {
          state: bindMatch[1] === "FRESH_REQUIRED" ? "freshPending" : "blocked",
          reasonCode: bindMatch[2],
          refFingerprint: null,
          expectedRevision: Number(bindMatch[3]),
        };
        rejectBeforeSend(turn);
        if (bindMatch[1] === "FRESH_REQUIRED") setFreshConfirm(info);
        else toast(`原线程不可续接（${reasonLabel(info.reasonCode)}），请重建上下文或另建会话`, "err");
        return false;
      }
      void finalize(turn, msg);
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
        meta = await createSession(true, props.featureTarget?.featureId);
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
      const request: PendingSend = { sid: meta.id, text, refs: enriched.map(r => ({ ...r })), atts: atts.map(a => ({ ...a })), model: meta.modelId, cliId: meta.cliId ?? null, permissionId: permissionBySession[meta.id] ?? "default", scope: targetScope };
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

  const applyCfg = async (patch: { cliId?: string; providerId?: string; modelId?: string; effort?: string; permissionId?: string }) => {
    if (cfgLock.current || sendLock.current || executionLocked) { toast("当前会话仍有运行中的请求或子任务，配置已锁定；完成后再调整", "warn"); return; }
    if (patch.permissionId && curRef.current) {
      setPermissionBySession(prev => ({ ...prev, [curRef.current!.id]: patch.permissionId! }));
      return;
    }
    // CR-037 / STORY-011 AC-05：非空会话（有消息或已有绑定）切 CLI 须确认后另建会话；后端亦拒绝原地改。
    if (patch.cliId && curRef.current && patch.cliId !== curRef.current.cliId
      && (curRef.current.messageCount > 0 || curRef.current.binding)) {
      setCliSwitchTarget(patch.cliId);
      return;
    }
    cfgLock.current = true; setCfgBusy(true);
    try {
      const meta = curRef.current ?? await createSession(true, props.featureTarget?.featureId);
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
        {overlay.activeOverlay === "agents" && <div className="chat-drop" data-chat-overlay="agents" role="dialog" aria-label="子智能体"><div className="chat-drop-h"><b>子智能体</b><span className="chat-drop-cap">{agentCount} 个 · 仅本会话</span></div><div className="chat-drop-list">{curRt!.subagents.map(a => <div key={a.id} className="chat-agent-row"><CliLogo id={a.cli ?? "unknown"} size={20} /><span className="chat-agent-main"><b>{a.title}</b><span>{a.cli ?? "CLI 未知"} · {a.model ?? "模型未知"} · {a.duration ?? "耗时未知"} · {a.tokens ?? "tokens 未知"}</span></span><span className={`tag ${a.status === "失败" ? "bad" : a.status === "待确认" ? "warn" : "good"}`}>{a.status}</span></div>)}</div><div className="chat-drop-f">{curRt!.recordsDemo ? "合成演示 · 不调用真实 CLI" : "事件未提供用量或引擎信息时保持未知，不把未知填成 0"}</div></div>}
      </div>}
      {bgCount > 0 && <div className="chat-drop-wrap"><button className="chat-count-btn" data-chat-overlay-trigger="bg" aria-expanded={overlay.activeOverlay === "bg"} onClick={e => overlay.toggle("bg", e.currentTarget)}><Icon name="terminal" size={14} />{bgCount} 后台任务 <Icon name="chevronDown" size={12} /></button>
        {overlay.activeOverlay === "bg" && <div className="chat-drop chat-drop-bg" data-chat-overlay="bg" role="dialog" aria-label="后台任务"><div className="chat-drop-h"><b>后台任务</b><span className="chat-drop-cap">仅本会话</span></div><div className="chat-drop-list">{[true, false].map(active => { const rows = curRt!.background.filter(b => (b.state === "运行中") === active); return <div className="chat-bg-group" key={String(active)}><div className="chat-bg-group-h"><span>{active ? "进行中" : "已结束"} {rows.length}</span>{!active && <button className="chat-bg-clear" disabled={!rows.length} onClick={() => { clearEndedBackground(cur!.id); setBgOpenId(null); if (!getRuntime(cur!.id).background.length) overlay.close(false); bumpRt(); }}>清空已结束</button>}</div>{!rows.length && <div className="chat-bg-empty">暂无记录</div>}{rows.map(b => <div className="chat-bg-row" key={b.id}><button className="chat-bg-head" aria-expanded={bgOpenId === b.id} onClick={() => setBgOpenId(prev => prev === b.id ? null : b.id)}><span className={`chat-bg-dot ${b.state === "运行中" ? "run" : b.state === "完成" ? "ok" : "fail"}`} /><span className="chat-bg-main"><b>{b.cmd}</b><span>{b.state} · 退出码 {b.exit} · {b.duration}</span></span><Icon name="chevronDown" size={12} /></button>{bgOpenId === b.id && <div className="chat-bg-detail"><span className="chat-bg-jobid">jobId {b.id}</span><pre>{b.output || "暂无输出"}</pre></div>}</div>)}</div>; })}</div><div className="chat-drop-f">{curRt!.recordsDemo ? "合成演示 · " : ""}只清展示，不终止任务</div></div>}
      </div>}
      <span className="spacer" />{cur?.sessionRole === "executor" && cur.featureId && <span className="chat-scope-tag" title={`执行特性：${cur.featureTitle ?? cur.featureId}；本会话仅实现该Feature`} aria-label={`执行特性：${cur.featureTitle ?? cur.featureId}，单特性执行会话`}>FEAT · <b>{cur.featureId}</b></span>}{binding && <span className={`chat-binding-pill ${binding.state}`} title={binding.state === "blocked" ? `原线程不可续接：${reasonLabel(binding.reasonCode)}` : binding.state === "freshPending" ? "上下文需要确认重建后才能发送" : binding.state === "fresh" ? "已确认重建上下文" : "已绑定原线程，续轮自动续接"}>{BINDING_PILL[binding.state] ?? binding.state}</span>}{newButton}
    </div>
    <div className="chat-fade" />
    {overlay.activeOverlay === "history" && <SessionHistory scopeId={scope} sessions={sessions} currentId={cur?.id ?? null} runningIds={runningIds} onSwitch={openSession} onNew={newSession} onDelete={deleteSession} onClose={() => overlay.close(true)} />}
    <MessageList msgs={msgs} projectId={props.projectId} rootUri={props.rootUri} officeFiles={props.officeFiles} visible={props.visible} stepsSlot={<>{queued > 0 && <div className="chat-queued">已排队 {queued} 条，当前静止后发送</div>}{curRt && curRt.steps.length > 0 && <StepsBox steps={curRt.steps} demo={curRt.stepsDemo} preview={Boolean((window as unknown as { __DESIGN_PREVIEW__?: boolean }).__DESIGN_PREVIEW__)} open={curRt.stepsOpen} sid={cur!.id} onToggle={() => { curRt.stepsOpen = !curRt.stepsOpen; bumpRt(); }} bump={bumpRt} />}</>} />
    {(binding?.state === "blocked" || binding?.state === "freshPending") && <div className="chat-block-banner" role="alert" aria-label="绑定阻塞横幅">
      <span className="chat-block-ico" aria-hidden>!</span>
      <div className="chat-block-main">
        <div className="chat-block-title">{binding.state === "blocked" ? "原线程不可续接，已暂停发送" : "上下文待确认重建"}</div>
        <div className="chat-block-reason">原因：{reasonLabel(binding.reasonCode)}。历史记录仍可查看；未发送草稿已保留。</div>
        <div className="chat-block-foot">
          {draft.length > 0 && <span className="chat-block-draft">草稿已保留（{draft.length} 字）</span>}
          {binding.state === "freshPending" && <button className="chat-block-btn primary" onClick={() => setFreshConfirm(binding)}>确认重建…</button>}
          {binding.state === "blocked" && <button className="chat-block-btn primary" onClick={() => setFreshConfirm(binding)}>重建上下文…</button>}
          <button className="chat-block-btn" onClick={e => overlay.toggle("cli", e.currentTarget)}>切换 CLI 另建会话</button>
        </div>
      </div>
    </div>}
    <div className="chat-composer-wrap">
      <Composer scopeKey={`${scope}:${cur?.id ?? "new"}`} rootUri={props.rootUri} projectId={props.projectId} office={props.office} officeFiles={props.officeFiles} sessions={sessions} value={draft} streaming={running} disabled={composerLocked} goal={curRt?.goal ?? null} tasks={curRt?.tasks ?? []} onCreateGoal={text => { if (cur) { setGoal(cur.id, text); bumpRt(); } }} onGoalStateChange={state => { if (cur) { updateGoalState(cur.id, state); bumpRt(); } }} onCreateTask={taskName => { if (cur) { addSessionTask(cur.id, taskName); bumpRt(); } }} onChange={onDraftChange} onSend={startSend} onStop={stopSend} controls={<ModelPicker cliId={cur?.cliId ?? null} providerId={cur?.providerId ?? null} modelId={cur?.modelId ?? null} effort={cur?.effort ?? null} cliCandidates={cliCands} models={models} permissionId={(cur?.id && permissionBySession[cur.id] as any) || "default"} locked={executionLocked || cfgBusy} onChange={applyCfg} />} />
      {freshConfirm && cur && <Confirm
        title="无法续接原线程，是否重建上下文？"
        message={`本轮开始前检测到原生引用不可用。重建后将开启全新上下文；历史消息保留可见，不再自动送给模型。\n\n原因：${reasonLabel(freshConfirm.reasonCode)}\n引用指纹：${freshConfirm.refFingerprint ?? "—"} · 绑定版本：#${freshConfirm.expectedRevision}`}
        onOk={() => void confirmFresh(freshConfirm)}
        onCancel={() => setFreshConfirm(null)}
      />}
      {cliSwitchTarget && <Confirm
        title="切换 CLI 将另建会话"
        message={`当前会话已有消息或原生绑定，不能原地更换 CLI。将另建一个会话继续（携带原模型配置，CLI 改为 ${cliSwitchTarget}）；本会话的历史与绑定保留不变。`}
        danger
        onOk={() => void switchCliNewSession(cliSwitchTarget)}
        onCancel={() => setCliSwitchTarget(null)}
      />}
      <StatsBar data={statsData} />
      <div className="chat-foot"><span>Enter 发送 · Shift+Enter 换行</span><span>{cur?.cliId ?? "CLI 未配置"} · {permissionBySession[cur?.id ?? ""] ?? "default"}</span></div>
    </div>
  </div>;
}
