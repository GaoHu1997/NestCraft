import { Icon, CliLogo } from "@/components/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "@/api";
import type { AttachmentMeta, ChatEvent, ContextRef, ModelCandidate, SdkState, SessionBinding, SessionMeta } from "@/api";
import { Confirm, Modal, useToast } from "@/components/ui";
import { MessageList, fromChatMessage, mkMsg } from "./MessageList";
import type { OfficeFileRef, UiMessage } from "./MessageList";
import { Composer, migrateComposerDraft, clearComposerDraft, restoreComposerDraft } from "./Composer";
import { SessionHistory, HistoryIcon } from "./SessionHistory";
import type { HistoryLoading } from "./SessionHistory";
import { SubagentPanel } from "./SubagentPanel";
import { ModelPicker, effectiveEfforts, permissionSupported } from "./ModelPicker";
import { StatsBar } from "./StatsBar";
import { projectSessionStats, parseSessionStatsSnapshot } from "./sessionStats";
import type { PersistentSessionStats } from "./sessionStats";
import { GoalBar, TodoPanel } from "./ChatDock";
import { emptyPlan, projectPlan } from "./sessionPlan";
import { ChatOverlayProvider, useChatOverlay } from "./overlay";
import { addUsage, finishOnce, getRuntime, hydrateUsage, isCurrentTurn, markFirstDelta, markStreamStart, outputTps, recordToolResult, recordToolUse, rebuildStepsFromPairs, clearEndedBackground, dropRuntime, setStatus, setGoal, updateGoalState, upsertSubagent, hasBlockingChildren, settleSubagents } from "./sessionRuntime";
import { officeFileContentText } from "@/modules/office/office-model";
import { requestPanel } from "./panelRequest";
import type { PanelKind, PanelRequest } from "./panelRequest";
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
  /** CR-054：把本实例的会话数据与操作暴露给工作台左栏。
   *  工作台与 AI 侧栏共用同一 ChatPanel 实例，禁止另建第二个实例（会产生双订阅）。 */
  onController?: (controller: ChatController | null) => void;
  /** CR-054：工作台形态下隐藏侧栏自己的历史入口（左栏已常驻），其余行为不变。 */
  variant?: "sidebar" | "workbench";
}

/** CR-054：工作台左栏需要的只读视图与操作；全部指向同一 ChatPanel 实例。 */
export interface ChatController {
  sessions: SessionMeta[];
  currentId: string | null;
  runningIds: string[];
  total: number;
  hasMore: boolean;
  loading: HistoryLoading;
  error: string | null;
  keyword: string;
  openSession: (meta: SessionMeta) => void;
  newSession: () => void;
  loadMore: () => void;
  search: (q: string) => void;
  showAll: () => void;
  retry: () => void;
  remove: (id: string) => void;
  copyId: (meta: SessionMeta) => void;
  fork: (meta: SessionMeta) => void;
  pin: (meta: SessionMeta) => void;
  rename: (meta: SessionMeta, title: string) => void;
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
/**
 * CR-068 J12 / AC-STORY-032-CR068-02：正常会话（native / fresh）不再常驻「已续接」标签。
 * 只有需要用户处理的绑定状态才显示短标签，原因与出路由消息流断点卡和下方阻塞横幅承担；
 * 不因为存在原生引用就宣称本轮已经续接成功。
 */
const BINDING_PILL: Record<string, string> = {
  freshPending: "待确认",
  blocked: "不可续接",
};
/** CR-068 J11：发送失败要有可读的真实原因，不吞成空串/[object Object]。 */
const sendFailureText = (e: unknown): string => {
  if (e instanceof Error) return e.message || String(e);
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    const message = (e as { message?: unknown }).message;
    if (message != null && String(message).trim()) return String(message);
  }
  return String(e);
};
interface Turn {
  sid: string;
  generation: number;
  request: PendingSend;
  buffer: { kind: "text" | "thinking"; text: string } | null;
  streamTail: { kind: "text" | "thinking"; id: string } | null;
  streamRows: number;
  firstRow: number;
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
  // CR-062：主会话与子智能体只读详情共用一个侧栏位置；主会话保持挂载以保留草稿/运行轮次。
  const [agentView, setAgentView] = useState<{ parentId: string; agentId: string } | null>(null);
  const panelVisible = props.visible !== false && !agentView;
  const width = props.width ? Math.min(620, Math.max(320, props.width)) : undefined;
  return (
    <ChatOverlayProvider visible={panelVisible}>
      <Panel
        {...props}
        visible={panelVisible}
        onOpenAgent={(parentId, agentId) => setAgentView({ parentId, agentId })}
      />
      {agentView && (
        <SubagentPanel
          parentId={agentView.parentId}
          agentId={agentView.agentId}
          onBack={() => setAgentView(null)}
          visible={props.visible !== false}
          width={width}
          height={props.height}
        />
      )}
    </ChatOverlayProvider>
  );
}

interface PanelProps extends ChatPanelProps {
  /** CR-062：打开子智能体只读详情（主会话保持在后台运行）。 */
  onOpenAgent?: (parentId: string, agentId: string) => void;
}

/** CR-063：会话历史每批条数与分页状态。 */
const SESSION_PAGE_SIZE = 20;

interface SessionsPageState {
  scopeKey: string;
  total: number;
  hasMore: boolean;
  cursor: { pinnedAt: number; updatedAt: number; id: string } | null;
  keyword: string;
  loading: HistoryLoading;
  error: string | null;
}

const blankSessionsPage = (scopeKey: string): SessionsPageState => ({
  scopeKey, total: 0, hasMore: false, cursor: null, keyword: "", loading: "idle", error: null,
});

/** CR-065：复制文本（剪贴板 API + 隐藏 textarea 回退）。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* 回退 */ }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch { return false; }
}

/** CR-063：与后端 chat_sessions_page 的作用域分支一一对应（含 server-only 不限制 projectId 的既有语义）。 */
export function inSessionScope(
  s: { projectId: string | null; serverId: string | null },
  projectId?: string,
  serverId?: string,
): boolean {
  if (projectId && serverId) return s.projectId === projectId && s.serverId === serverId;
  if (projectId) return s.projectId === projectId;
  if (serverId) return s.serverId === serverId;
  return !s.projectId && !s.serverId;
}

function Panel(props: PanelProps) {
  const toast = useToast();
  const overlay = useChatOverlay();
  const scope = sessionScope(props);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  // CR-063：会话历史分页状态（分批、搜索、加载/失败）。
  const [sessionsPage, setSessionsPage] = useState<SessionsPageState>(() => blankSessionsPage(`${props.projectId ?? ""}|${props.serverId ?? ""}`));
  const sessionsReq = useRef(0);
  const sessionsPageRef = useRef(sessionsPage);
  sessionsPageRef.current = sessionsPage;
  const [cur, setCur] = useState<SessionMeta | null>(null);
  // CR-069：新会话运行通道草稿；创建会话后以 meta.runner 为准。默认 cli（与后端一致）。
  const [runnerDraft, setRunnerDraft] = useState<"cli" | "platform">("cli");
  const [msgs, setMsgs] = useState<UiMessage[]>([]);
  const [statsSnapshot, setStatsSnapshot] = useState<PersistentSessionStats | null>(null);
  const statsReq = useRef(0);
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
  const composerFocusAfterClear = useRef<{ sid: string; scope: string } | null>(null);
  scopeRef.current = scope;
  visibleRef.current = props.visible !== false;
  curRef.current = cur;
  const viewing = (sid: string, targetScope = scope) => mounted.current && scopeRef.current === targetScope && currentIdRef.current === sid;
  const refreshSessionStats = async (sid: string, targetScope = scopeRef.current) => {
    const request = ++statsReq.current;
    try {
      const value = await api.chatSessionStats(sid);
      if (request === statsReq.current && viewing(sid, targetScope)) setStatsSnapshot(parseSessionStatsSnapshot(value, sid));
    } catch {
      if (request === statsReq.current && viewing(sid, targetScope)) setStatsSnapshot(null);
    }
  };
  useEffect(() => {
    ++statsReq.current;
    setStatsSnapshot(null);
    if (cur?.id) void refreshSessionStats(cur.id, scope);
    return () => { ++statsReq.current; };
  }, [cur?.id, scope]);
  const curRt = cur ? getRuntime(cur.id) : null;
  const running = !!cur && runningIds.includes(cur.id);
  // J08：working 绑定本轮发送代次；本轮已结算即收起，不等待后端彻底静止或 assistant 消息创建。
  const working = running && !turns.current.get(cur?.id ?? "")?.finished;
  // CR-037：当前会话绑定状态（阻塞时禁输入但保留草稿与历史；REF_NOT_READY 可直接重试）
  const binding = cur?.sessionRole === "executor" ? null : cur?.binding ?? null;
  const composerLocked =
    cfgBusy ||
    (binding?.state === "blocked" && binding.reasonCode !== "REF_NOT_READY") ||
    binding?.state === "freshPending";
  const executionLocked = running || (cur ? hasBlockingChildren(cur.id) : false);

  // 清除会卸载 GoalBar 与 Confirm；等弹窗清理后仅恢复原会话的输入焦点。
  useEffect(() => {
    const request = composerFocusAfterClear.current;
    composerFocusAfterClear.current = null;
    if (!request || !visibleRef.current || !viewing(request.sid, request.scope)) return;
    overlay.scopeRef.current?.querySelector<HTMLTextAreaElement>("textarea.chat-ta")?.focus({ preventScroll: true });
  });

  /** AC-06：fresh 重建确认 → CAS 清空旧引用 + 断点卡；失败（已有新轮）提示刷新。 */
  const confirmFresh = async (info: SessionBinding) => {
    const sid = curRef.current?.id;
    if (!sid) return;
    try {
      await api.chatSessionConfirmFresh(sid, info.expectedRevision, info.reasonCode);
      setFreshConfirm(null);
      const meta = await api.chatSessionGet(sid);
      updateSessionRow(meta);
      if (viewing(sid)) {
        curRef.current = { ...curRef.current!, ...meta };
        setCur(curRef.current);
        const token = loadSerial.current;
        const gen = getRuntime(sid).generation;
        const snapshot = await api.chatMessages(sid);
        if (viewing(sid) && token === loadSerial.current && getRuntime(sid).generation === gen && !getRuntime(sid).active) setMsgs(syncMessages(sid, snapshot));
      }
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
      insertSessionRow(created);
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
    setBgOpenId(null); setFreshConfirm(null); setCliSwitchTarget(null); setGoalDraft(null); overlay.close(false);
  };
  const filterSessions = (ss: SessionMeta[], project = props.projectId, server = props.serverId) => ss.filter(s =>
    project ? s.projectId === project && (!server || s.serverId === server) : server ? s.serverId === server : !s.projectId && !s.serverId
  );
  const syncMessages = (sid: string, snapshot: api.ChatMessage[]) => {
    const plan = emptyPlan();
    const ms: UiMessage[] = [];
    for (const row of snapshot) {
      const m = fromChatMessage(row);
      if (m.role === "system" && m.kind === "planUpdate") {
        try { projectPlan(plan, { type: "planUpdate", items: JSON.parse(row.metaJson ?? "{}").items }); } catch { /* 无效快照不覆盖已有清单 */ }
        continue;
      }
      if (m.role === "user") projectPlan(plan, { type: "turn" });
      if (m.role === "tool_use" && m.toolId) projectPlan(plan, { type: "toolUse", toolId: m.toolId, name: m.toolName, inputJson: m.inputJson });
      if (m.role === "tool_result" && m.toolId) projectPlan(plan, { type: "toolResult", toolId: m.toolId, content: m.content, isError: m.isError });
      ms.push(m);
    }
    projectPlan(plan, { type: "turn" });
    getRuntime(sid).plan = plan;
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
    const withUsage = ms.filter(m => m.usage);
    const lastUsage = withUsage.length ? withUsage[withUsage.length - 1].usage : null;
    hydrateUsage(
      sid,
      withUsage.reduce((n, m) => n + (m.usage?.input ?? 0), 0),
      withUsage.reduce((n, m) => n + (m.usage?.output ?? 0), 0),
      known,
      undefined,
      // CR-068 J10：历史恢复的当前窗口取最近一条带 usage 的消息；0/未上报保持未知，不填 0。
      lastUsage && lastUsage.input > 0 ? lastUsage.input : null,
    );
    bumpRt();
    return ms;
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
      else setMsgs(syncMessages(meta.id, ms));
      if (await api.chatStatus(meta.id)) setRunningIds(prev => prev.includes(meta.id) ? prev : [...prev, meta.id]);
      else if (viewing(meta.id, targetScope)) setRunningIds(prev => prev.filter(id => id !== meta.id));
      await markRead(meta, targetScope); bumpRt();
    } catch (e) { if (viewing(meta.id, targetScope)) toast(String(e), "err"); }
  };
  const createSession = (preserveNewDraft = false, featureId?: string | null): Promise<SessionMeta> => {
    if (createPromise.current) return createPromise.current;
    const targetScope = scope;
    const previous = curRef.current;
    const args: Parameters<typeof api.chatSessionCreate>[0] = {
      ...(props.projectId ? { projectId: props.projectId } : {}), ...(props.serverId ? { serverId: props.serverId } : {}),
      ...(previous?.cliId ? { cliId: previous.cliId } : cliCands[0] ? { cliId: cliCands[0].id } : {}),
      ...(previous?.providerId ? { providerId: previous.providerId } : {}), ...(previous?.modelId ? { modelId: previous.modelId } : {}),
      ...(previous?.effort ? { effort: previous.effort } : {}),
      ...(featureId ? { featureId } : {}),
      ...(runnerDraft === "platform" ? { runner: "platform" as const } : {}),
    };
    const work = (async () => {
      await saveDraftNow(); // 新会话也必须先保存旧会话，包含空草稿
      const meta = await api.chatSessionCreate(args);
      if (mounted.current && scopeRef.current === targetScope) {
        ++loadSerial.current;
        insertSessionRow(meta);
        let pendingDraft = "";
        if (!previous && preserveNewDraft) {
          const newDraftKey = `${targetScope}:new`;
          pendingDraft = drafts.get(newDraftKey) ?? "";
          migrateComposerDraft(newDraftKey, `${targetScope}:${meta.id}`);
          drafts.delete(newDraftKey);
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
  const [goalDraft, setGoalDraft] = useState<string | null>(null);
  const createGoal = async (text: string) => {
    const objective = text.trim();
    if (!objective) return;
    try {
      const meta = curRef.current ?? await createSession(true, props.featureTarget?.featureId);
      setGoal(meta.id, objective);
      if (viewing(meta.id)) { setGoalDraft(null); bumpRt(); }
    } catch (error) {
      if (mounted.current && scopeRef.current === scope) setGoalDraft(objective);
      toast(String(error), "err");
    }
  };
  const newSession = () => { void createSession(false, props.featureTarget?.featureId).catch(e => toast(String(e), "err")); };
  const deleteSession = async (id: string) => {
    try { await api.chatSessionDelete(id); }
    catch (e) { toast(String(e), "err"); return; }
    turns.current.delete(id); queues.current.delete(id); messageCache.current.delete(id); dropRuntime(id);
    drafts.delete(`${scope}:${id}`);
    clearComposerDraft(`${scope}:${id}`);
    const wasListed = sessions.some(s => s.id === id);
    const rest = sessions.filter(s => s.id !== id);
    setSessions(rest); setRunningIds(prev => prev.filter(x => x !== id));
    // 搜索态只对命中项扣减；非搜索态删除钉住行（不在 items）也要扣减总数。
    setSessionsPage(prev => (wasListed || !prev.keyword ? { ...prev, total: Math.max(0, prev.total - 1) } : prev));
    if (currentIdRef.current === id) {
      setCurrent(null, ""); setMsgs([]);
      if (rest[0]) void openSession(rest[0]);
    }
  };
  /** CR-063：应用一页结果，替换已加载主体。 */
  const applySessionPage = (page: api.SessionPage, keyword: string, targetScope: string) => {
    if (!mounted.current || scopeRef.current !== targetScope) return;
    setSessions(page.items);
    setSessionsPage({
      scopeKey: `${props.projectId ?? ""}|${props.serverId ?? ""}`,
      total: page.total, hasMore: page.hasMore, cursor: page.nextCursor, keyword, loading: "idle", error: null,
    });
    setCur(prev => (prev ? page.items.find(s => s.id === prev.id) ?? prev : prev));
    const current = page.items.find(s => s.id === currentIdRef.current);
    if (current) void markRead(current, targetScope);
  };

  /** CR-063：取值一页（首批或搜索首查）；keyword 为空即全部分批浏览。 */
  const loadSessionPage = async (keyword: string, mode: "first" | "search", targetScope = scope) => {
    const req = ++sessionsReq.current;
    const trimmed = keyword.trim();
    setSessionsPage(prev => ({ ...prev, keyword: trimmed, loading: mode === "search" ? "search" : "first", error: null }));
    try {
      const page = await api.chatSessionsPage({
        ...(props.projectId ? { projectId: props.projectId } : {}),
        ...(props.serverId ? { serverId: props.serverId } : {}),
        ...(trimmed ? { keyword: trimmed } : {}),
        limit: SESSION_PAGE_SIZE,
      });
      if (req !== sessionsReq.current) return;
      applySessionPage(page, trimmed, targetScope);
    } catch (e) {
      if (req !== sessionsReq.current) return;
      setSessionsPage(prev => ({ ...prev, loading: "idle", error: String(e) }));
    }
  };

  /** CR-063：追加下一页；按 id 去重，避免键集边界重复。 */
  const loadMoreSessions = async () => {
    const page = sessionsPageRef.current;
    if (page.loading !== "idle" || !page.hasMore || !page.cursor) return;
    const req = ++sessionsReq.current;
    setSessionsPage(prev => ({ ...prev, loading: "more", error: null }));
    try {
      const next = await api.chatSessionsPage({
        ...(props.projectId ? { projectId: props.projectId } : {}),
        ...(props.serverId ? { serverId: props.serverId } : {}),
        ...(page.keyword ? { keyword: page.keyword } : {}),
        cursorPinnedAt: page.cursor.pinnedAt,
        cursorUpdatedAt: page.cursor.updatedAt,
        cursorId: page.cursor.id,
        limit: SESSION_PAGE_SIZE,
      });
      if (req !== sessionsReq.current) return;
      setSessions(prev => {
        const seen = new Set(prev.map(s => s.id));
        return [...prev, ...next.items.filter(s => !seen.has(s.id))];
      });
      setSessionsPage(prev => ({ ...prev, total: next.total, hasMore: next.hasMore, cursor: next.nextCursor, loading: "idle" }));
    } catch (e) {
      if (req !== sessionsReq.current) return;
      setSessionsPage(prev => ({ ...prev, loading: "idle", error: String(e) }));
    }
  };

  /** CR-063：搜索当前作用域全部会话标题。 */
  const searchSessions = (keyword: string) => {
    if (!keyword.trim()) { void loadSessionPage("", "first"); return; }
    void loadSessionPage(keyword, "search");
  };
  /** CR-063：「全部」/清除搜索：回到第 1 页按 20 条浏览。 */
  const showAllSessions = () => { void loadSessionPage("", "first"); };
  /** CR-063：失败重试；已有分页进度时继续追加，否则重取首页。 */
  const retrySessions = () => {
    const page = sessionsPageRef.current;
    if (page.hasMore && page.cursor) void loadMoreSessions();
    else void loadSessionPage(page.keyword, page.keyword ? "search" : "first");
  };

  /** CR-063：只更新单行，不重置分页（发送/标题/未读变化）。 */
  const updateSessionRow = (meta: SessionMeta, targetScope = scope) => {
    if (!mounted.current || scopeRef.current !== targetScope) return;
    setSessions(prev => prev.map(s => (s.id === meta.id ? { ...s, ...meta } : s)));
    setCur(prev => (prev?.id === meta.id ? { ...prev, ...meta } : prev));
  };

  /** CR-063：新建会话插入列表；搜索态仅当命中关键词时插入并计数。 */
  const insertSessionRow = (meta: SessionMeta) => {
    const page = sessionsPageRef.current;
    const hit = !page.keyword || meta.title.toLowerCase().includes(page.keyword.toLowerCase());
    if (!hit) return;
    setSessions(prev => [meta, ...prev.filter(s => s.id !== meta.id)]);
    setSessionsPage(prev => ({ ...prev, total: prev.total + 1 }));
  };

  /** CR-065：复制会话 ID。 */
  const copySessionId = async (s: SessionMeta) => {
    const ok = await copyText(s.id);
    toast(ok ? "已复制会话 ID" : "复制失败，请手动复制", ok ? undefined : "err");
  };

  /** CR-065：分叉会话；新会话插入列表并切换过去。 */
  const forkSession = async (s: SessionMeta) => {
    try {
      const meta = await api.chatSessionFork(s.id);
      insertSessionRow(meta);
      await openSession(meta);
      toast("已分叉会话，上下文已保留");
    } catch (e) { toast(String(e), "err"); }
  };

  /** CR-065：置顶/取消置顶；重取首页保证排序与游标一致。 */
  const pinSession = async (s: SessionMeta) => {
    const next = !((s.pinnedAt ?? 0) > 0);
    try {
      await api.chatSessionPin(s.id, next);
      toast(next ? "已置顶会话" : "已取消置顶");
      const page = sessionsPageRef.current;
      await loadSessionPage(page.keyword, page.keyword ? "search" : "first");
    } catch (e) { toast(String(e), "err"); }
  };

  /** CR-065：重命名（原位编辑提交）；空标题拒绝。 */
  const renameSession = async (s: SessionMeta, title: string) => {
    const next = title.trim();
    if (!next) { toast("标题不能为空", "warn"); return; }
    if (next === s.title) return;
    try {
      await api.chatSessionUpdate({ id: s.id, title: next });
      updateSessionRow({ ...s, title: next });
    } catch (e) { toast(String(e), "err"); }
  };

  /* FEAT-021 / CR-074：只有列表快照改变才发布，父布局重绘不产生发布环；
     动作身份稳定，但调用始终读取本次render的闭包（包含最新scope/featureTarget）。 */
  const onControllerRef = useRef(props.onController);
  onControllerRef.current = props.onController;
  type ControllerActions = Pick<ChatController, "openSession" | "newSession" | "loadMore" | "search" | "showAll" | "retry" | "remove" | "copyId" | "fork" | "pin" | "rename">;
  const latestActions: ControllerActions = {
    openSession: meta => { void openSession(meta); }, newSession,
    loadMore: () => { void loadMoreSessions(); }, search: searchSessions,
    showAll: showAllSessions, retry: retrySessions,
    remove: id => { void deleteSession(id); }, copyId: meta => { void copySessionId(meta); },
    fork: meta => { void forkSession(meta); }, pin: meta => { void pinSession(meta); },
    rename: (meta, title) => { void renameSession(meta, title); },
  };
  const controllerActionsRef = useRef(latestActions);
  controllerActionsRef.current = latestActions;
  const stableActions = useMemo<ControllerActions>(() => ({
    openSession: meta => controllerActionsRef.current.openSession(meta),
    newSession: () => controllerActionsRef.current.newSession(),
    loadMore: () => controllerActionsRef.current.loadMore(),
    search: keyword => controllerActionsRef.current.search(keyword),
    showAll: () => controllerActionsRef.current.showAll(),
    retry: () => controllerActionsRef.current.retry(),
    remove: id => controllerActionsRef.current.remove(id),
    copyId: meta => controllerActionsRef.current.copyId(meta),
    fork: meta => controllerActionsRef.current.fork(meta),
    pin: meta => controllerActionsRef.current.pin(meta),
    rename: (meta, title) => controllerActionsRef.current.rename(meta, title),
  }), []);
  const controller = useMemo<ChatController>(() => ({
    sessions, currentId: cur?.id ?? null, runningIds,
    total: sessionsPage.total, hasMore: sessionsPage.hasMore,
    loading: sessionsPage.loading, error: sessionsPage.error, keyword: sessionsPage.keyword,
    ...stableActions,
  }), [sessions, cur?.id, runningIds, sessionsPage, stableActions]);
  useEffect(() => { onControllerRef.current?.(controller); }, [controller, props.onController]);
  useEffect(() => () => onControllerRef.current?.(null), []);

  useEffect(() => {
    mounted.current = true;
    return () => { void saveDraftNow(); mounted.current = false; };
  }, []);
  useEffect(() => {
    const requestEpoch = ++epoch.current;
    ++loadSerial.current;
    const req = ++sessionsReq.current;
    const scopeKey = `${props.projectId ?? ""}|${props.serverId ?? ""}`;
    setCurrent(null, drafts.get(`${scope}:new`) ?? ""); setMsgs([]); setSessions([]);
    setSessionsPage({ ...blankSessionsPage(scopeKey), loading: "first" });
    let alive = true;
    void (async () => {
      try {
        const page = await api.chatSessionsPage({
          ...(props.projectId ? { projectId: props.projectId } : {}),
          ...(props.serverId ? { serverId: props.serverId } : {}),
          limit: SESSION_PAGE_SIZE,
        });
        if (!alive || epoch.current !== requestEpoch || req !== sessionsReq.current) return;
        setSessions(page.items);
        setSessionsPage({ scopeKey, total: page.total, hasMore: page.hasMore, cursor: page.nextCursor, keyword: "", loading: "idle", error: null });
        if (page.items[0]) await openSession(page.items[0]);
      } catch (e) {
        if (alive) {
          toast(String(e), "err");
          setSessionsPage(prev => ({ ...prev, loading: "idle", error: String(e) }));
        }
      }
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
    const chunk = turn.buffer;
    turn.buffer = null;
    if (!chunk?.text) return;
    markFirstDelta(turn.sid);
    const tail = turn.msgs[turn.msgs.length - 1];
    const thinking = chunk.kind === "thinking";
    if (turn.streamTail?.kind === chunk.kind && tail?.id === turn.streamTail.id) {
      turn.msgs[turn.msgs.length - 1] = thinking
        ? { ...tail, thinking: (tail.thinking ?? "") + chunk.text, thinkingMs: turn.thinkMs }
        : { ...tail, content: tail.content + chunk.text };
    } else {
      const id = `stream-${turn.sid}-${turn.generation}-${turn.streamRows++}`;
      turn.streamTail = { kind: chunk.kind, id };
      turn.msgs.push(mkMsg({ id, role: "assistant", streaming: true, model: turn.request.model,
        ...(thinking ? { thinking: chunk.text, thinkingMs: turn.thinkMs } : { content: chunk.text }), createdAt: Date.now() }));
    }
    publish(turn);
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
    restoreComposerDraft(key, request.refs, request.atts);
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
    projectPlan(getRuntime(turn.sid).plan, { type: "turn" });
    if (turn.thinkMs === null && turn.thinkStarted !== null) turn.thinkMs = Date.now() - turn.thinkStarted;
    turn.msgs = turn.msgs.map((m, i) => i < turn.firstRow ? m : {
      ...m,
      streaming: false,
      ...(m.thinking && m.thinkingMs == null ? { thinkingMs: turn.thinkMs } : {}),
    });
    // CR-062：本轮结束仍未收到子智能体终态时标“待确认/已停止”，不替它宣布成功。
    if (settleSubagents(turn.sid, stopped)) bumpRt();
    if (error || stopped) turn.msgs.push(mkMsg({ id: `error-${turn.sid}-${turn.generation}`, role: "error", content: error ?? "已停止本次生成", isError: true, createdAt: Date.now() }));
    publish(turn); bumpRt();
    try {
      await waitSettled(turn.sid); // done可能早于后端移除RUNNING；绝不能抢跑下一轮
      // 完成/失败/停止均只刷新独立统计，保护原正文、error卡及队列处理。
      void refreshSessionStats(turn.sid, turn.request.scope);
      if (getRuntime(turn.sid).generation !== turn.generation) return;
      if (!error && !stopped) {
        const ms = await api.chatMessages(turn.sid);
        if (getRuntime(turn.sid).generation !== turn.generation) return;
        const ui = syncMessages(turn.sid, ms);
        if (viewing(turn.sid, turn.request.scope)) setMsgs(ui);
      }
      const meta = await api.chatSessionGet(turn.sid);
      let row = meta;
      if (meta.title === "新会话" && turn.request.text.trim()) {
        const title = turn.request.text.trim().slice(0, 32);
        await api.chatSessionUpdate({ id: turn.sid, title });
        row = { ...meta, title }; // 合并新标题，避免用更新前的旧标题覆盖列表
      }
      if (scopeRef.current === turn.request.scope) updateSessionRow(row, turn.request.scope);
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
    const { plan } = getRuntime(request.sid);
    projectPlan(plan, { type: "turn" });
    const msgs = [...(messageCache.current.get(request.sid) ?? [])];
    const turn: Turn = { sid: request.sid, generation, request, buffer: null, streamTail: null, streamRows: 0,
      firstRow: msgs.length, thinkStarted: null, thinkMs: null, msgs, finished: false, accepted: false, timer: null };
    turns.current.set(request.sid, turn);
    const uid = `user-${request.sid}-${generation}`;
    turn.msgs.push(mkMsg({ id: uid, role: "user", content: request.text, refs: request.refs, attachments: request.atts, createdAt: Date.now() }));
    publish(turn); setRunningIds(prev => prev.includes(request.sid) ? prev : [...prev, request.sid]); bumpRt();
    const onEvent = (ev: ChatEvent) => {
      // 停止会先结束本地turn；后端闭合/持久通知仍须刷新，不回放正文。
      if (ev.type === "sessionStats" && ev.sessionId === request.sid) {
        void refreshSessionStats(request.sid, request.scope); return;
      }
      if (turn.finished || !isCurrentTurn(request.sid, generation)) return;
      switch (ev.type) {
        case "delta": case "thinking": {
          if (!ev.delta) break;
          const kind = ev.type === "thinking" ? "thinking" : "text";
          if (kind === "thinking" && turn.thinkStarted === null) turn.thinkStarted = Date.now();
          if (kind === "text" && turn.thinkMs === null && turn.thinkStarted !== null) turn.thinkMs = Date.now() - turn.thinkStarted;
          if (turn.buffer?.kind !== kind) flush(turn);
          if (turn.buffer) turn.buffer.text += ev.delta;
          else turn.buffer = { kind, text: ev.delta };
          if (turn.timer === null) turn.timer = window.setTimeout(() => {
            turn.timer = null;
            if (!turn.finished && isCurrentTurn(turn.sid, turn.generation)) flush(turn);
          }, 50);
          break;
        }
        case "toolUse": {
          if (turn.msgs.some(m => m.id === `tu-${generation}-${ev.toolId}`)) break;
          flush(turn); recordToolUse(request.sid, ev.toolId, ev.name);
          projectPlan(plan, ev);
          // CR-054 / STORY-073：AI 通过 workbench.open_panel 真实请求打开右栏。
          // 是否真正打开、用户关闭后是否重开、跨项目拒绝都交给 panelRequest 规则；
          // 不在这里写文件或扩授权。
          if (props.projectId && ev.name === "mcp__workbench__open_panel") {
            const request = panelRequestFromToolInput(ev.inputJson);
            if (request) {
              const result = requestPanel(props.projectId, request, { currentProjectId: props.projectId, turn: String(generation) });
              if (!result.ok && result.code !== "declined_by_user") {
                // 非法/不支持/跨项目：如实提示，不静默吞掉。
                toast(`右栏请求未生效：${result.message}`, "warn");
              }
            }
          }
          turn.msgs.push(mkMsg({ id: `tu-${generation}-${ev.toolId}`, role: "tool_use", toolId: ev.toolId, toolName: ev.name, inputJson: ev.inputJson, streaming: true, createdAt: Date.now() }));
          publish(turn); bumpRt(); break;
        }
        case "toolUpdate": {
          const at = turn.msgs.findIndex(m => m.id === `tu-${generation}-${ev.toolId}`);
          if (at >= 0) {
            turn.msgs[at] = { ...turn.msgs[at], toolOutput: ev.content };
            publish(turn);
          }
          break;
        }
        case "planUpdate":
          flush(turn);
          turn.streamTail = null;
          projectPlan(plan, ev);
          bumpRt(); break;
        case "toolResult": {
          flush(turn);
          const resultId = `tr-${generation}-${ev.toolId}`;
          if (turn.msgs.some(m => m.id === resultId)) break;
          recordToolResult(request.sid, ev.toolId, ev.isError);
          projectPlan(plan, ev);
          turn.msgs.push(mkMsg({ id: resultId, role: "tool_result", content: ev.content, toolId: ev.toolId, isError: ev.isError, exitCode: ev.exitCode, createdAt: Date.now() }));
          publish(turn); bumpRt(); break;
        }
        case "usage": addUsage(request.sid, ev.inputTokens, ev.outputTokens, ev.cacheReadTokens, String(generation)); bumpRt(); break;
        case "subagent": {
          flush(turn);
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
          flush(turn);
          setStatus(request.sid, "pending");
          turn.msgs.push(mkMsg({ id: `approval-${ev.requestId}`, role: "system", content: `待处理：${ev.toolName}。当前非交互CLI适配器未提供可用的人工审批流程，未自动放行。` })); publish(turn); bumpRt(); break;
        case "retrying":
          flush(turn);
          turn.msgs.push(mkMsg({ id: `retry-${request.sid}-${generation}-${ev.attempt}`, role: "system", kind: "retrying", content: `供应商暂时不可用（${ev.reason}），${ev.delayMs}ms 后重试（${ev.attempt}/${ev.maxAttempts}）`, createdAt: Date.now() }));
          publish(turn); bumpRt(); break;
        case "error": void finalize(turn, ev.message); break;
        case "done":
          // CR-068 J11：原生续接失败不再按成功收尾（后端 done 带 blocked 时显式失败 + 真实原因）。
          if (ev.blocked) void finalize(turn, `原线程续接失败：${reasonLabel(ev.reasonCode)}。本轮没有开始新上下文，消息与历史已保留。`);
          else {
            // 适配器静默换线不是正常续接：明确告知并保留消息流断点卡，不静默 fresh。
            if (ev.freshContext) toast("CLI 未回到原线程，已写入上下文断点卡；历史保留，不再自动送入模型", "warn");
            void finalize(turn);
          }
          break;
      }
    };
    try {
      const meta = await api.chatSessionGet(request.sid);
      const permissionId = request.permissionId || "default";
      // CR-037 / CR-068：freshPending/blocked 会话在后端被拒（用户消息未持久化，草稿保留）。
      // 横幅与弹窗使用后端返回的真实绑定状态，不靠前端猜测；原因与出路同时给出。
      const b = meta.binding;
      if (b?.state === "freshPending" || (b?.state === "blocked" && b.reasonCode !== "REF_NOT_READY")) {
        turn.msgs = turn.msgs.filter(m => m.id !== uid);
        rejectBeforeSend(turn);
        updateSessionRow(meta);
        if (b.state === "freshPending") {
          setFreshConfirm(b);
          toast(`当前会话需要确认重建上下文后才能发送（${reasonLabel(b.reasonCode)}）；草稿已保留`, "warn");
        } else {
          toast(`原线程不可续接（${reasonLabel(b.reasonCode)}），草稿已保留；请重建上下文或另建会话`, "err");
        }
        return false;
      }
      await api.chatSend({ sessionId: request.sid, content: request.text, refs: request.refs, attachments: request.atts, ...(permissionId ? { permissionId } : {}) }, onEvent);
      turn.accepted = true;
      return true;
    } catch (e) {
      turn.msgs = turn.msgs.filter(m => m.id !== uid);
      // 后端绑定拒绝（BINDING_FRESH_REQUIRED/BINDING_BLOCKED）：打开确认弹窗/横幅而非只留一次提示。
      const msg = sendFailureText(e);
      const bindMatch = /BINDING_(FRESH_REQUIRED|BLOCKED)\|([^|]*)\|(\d+)\|([^|]*)/.exec(msg);
      if (bindMatch) {
        const info: SessionBinding = {
          state: bindMatch[1] === "FRESH_REQUIRED" ? "freshPending" : "blocked",
          reasonCode: bindMatch[2],
          refFingerprint: null,
          expectedRevision: Number(bindMatch[3]),
        };
        rejectBeforeSend(turn);
        // 以真实落库的绑定状态刷新横幅（原因 + 出路），不只依赖会消失的 toast。
        try { updateSessionRow(await api.chatSessionGet(request.sid)); } catch { /* 刷新失败不覆盖已有提示 */ }
        if (bindMatch[1] === "FRESH_REQUIRED") setFreshConfirm(info);
        const detail = bindMatch[4]?.trim() || reasonLabel(info.reasonCode);
        toast(`发送被拒绝（${detail}）；草稿已保留，可重建上下文或另建会话`, bindMatch[1] === "FRESH_REQUIRED" ? "warn" : "err");
        return false;
      }
      // CR-068 J11：请求未获接受时草稿仍在输入框，错误卡显示真实原因而不是掩盖成成功。
      void finalize(turn, `${msg}（草稿已保留，可修改后重试）`);
      return false;
    }
  };

  const startSend = async (text: string, refs: ContextRef[], atts: AttachmentMeta[]): Promise<boolean> => {
    if ((!text.trim() && !atts.length) || sendLock.current || cfgLock.current) return false;
    sendLock.current = true;
    const targetScope = scope;
    const originalDraft = draftRef.current;
    try {
      const meta = curRef.current ?? await createSession(true, props.featureTarget?.featureId);
      if (scopeRef.current !== targetScope) return false;
      // CR-069：平台会话不依赖 CLI；校验平台模型（provider+model 在候选内）。
      const sessionRunner = meta.runner ?? "cli";
      if (sessionRunner === "platform") {
        if (!meta.providerId || !meta.modelId || !models.some(m => m.providerId === meta!.providerId && m.modelId === meta!.modelId)) { toast("请先在模型浮层选择平台模型", "err"); return false; }
      } else if (!meta.cliId || !cliCands.some(c => c.id === meta!.cliId)) { toast("CLI 未配置或已失效，请重新选择已安装且启用的 CLI", "err"); return false; }
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
          // CR-063：按会话真实归属校验，不依赖已加载列表（未加载的老会话也可引用）。
          const sourceMeta = await api.chatSessionGet(ref.objectId).catch(() => null);
          if (!sourceMeta || !inSessionScope(sourceMeta, props.projectId, props.serverId)) { toast("引用会话不属于当前项目，未发送", "err"); return false; }
          // 现有后端不处理 session 引用；真实读取当前项目会话并明确注入消息，不伪调用。
          const source = await api.chatMessages(ref.objectId);
          text += `\n\n[引用当前项目会话：${ref.display}]\n${source.filter(m => m.role === "user" || m.role === "assistant").map(m => `${m.role}: ${m.content}`).join("\n").slice(0, 12000)}`;
          // 引用已展开为受检会话正文；现后端没有session类型，不能仍发送不支持的引用。
        } else enriched.push(ref);
      }
      const request: PendingSend = { sid: meta.id, text, refs: enriched.map(r => ({ ...r })), atts: atts.map(a => ({ ...a })), model: meta.modelId, cliId: meta.cliId ?? null, permissionId: permissionBySession[meta.id] ?? "default", scope: targetScope };
      const active = turns.current.get(meta.id);
      const acceptDraft = () => {
        const key = `${targetScope}:${meta.id}`;
        // 未编辑过的会话可能尚未写入 drafts。与会话加载使用同一个草稿初值。
        if ((drafts.get(key) ?? meta.draft ?? "") !== originalDraft) return;
        clearComposerDraft(key, { refs, atts });
        drafts.set(key, "");
        if (viewing(meta.id, targetScope)) onDraftChange("");
        else void persistDraft(meta.id, "");
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
            const token = loadSerial.current;
            const gen = getRuntime(sid).generation;
            const ms = await api.chatMessages(sid);
            if (!getRuntime(sid).active && gen === getRuntime(sid).generation && token === loadSerial.current && viewing(sid)) {
              setMsgs(syncMessages(sid, ms));
              updateSessionRow(await api.chatSessionGet(sid));
            }
          }
        }).catch(() => {});
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [runningIds]);

  /** CR-069：切换运行通道。新会话只改草稿；已有会话走后端校验（有消息/运行中会被拒绝）。 */
  const switchRunner = async (next: "cli" | "platform") => {
    if (next === (curRef.current?.runner ?? runnerDraft)) return;
    if (!curRef.current) { setRunnerDraft(next); return; }
    if (cfgLock.current || sendLock.current || executionLocked) { toast("当前会话仍有运行中的请求或子任务，配置已锁定；完成后再调整", "warn"); return; }
    const meta = curRef.current;
    if (meta.messageCount > 0 || meta.binding) { toast("已有消息的会话不能切换运行通道；请新建会话", "warn"); return; }
    try {
      if (await api.chatStatus(meta.id)) throw new Error("会话仍在运行，通道未切换");
      await api.chatSessionUpdate({ id: meta.id, runner: next });
      const updated = { ...meta, runner: next };
      curRef.current = updated; setCur(updated);
      setSessions(prev => prev.map(s => s.id === updated.id ? updated : s));
    } catch (e) { toast(String(e), "warn"); }
  };

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

  const statsData = useMemo(() => {
    const model = models.find(m => m.providerId === cur?.providerId && m.modelId === cur?.modelId);
    // DSH turns 只由权威 closed step 投影；当前消息未保留该元信息时为未知。
    const persisted = statsSnapshot?.sessionId === cur?.id ? statsSnapshot : null;
    const closedStats = persisted ?? projectSessionStats(msgs, { sessionId: cur?.id });
    return {
      rounds: closedStats.rounds, steps: closedStats.steps, statsSource: closedStats.source, msgs: msgs.length,
      modelMs: persisted?.modelMs ?? null, toolMs: curRt?.timingKnown ? curRt.toolMs : null,
      ttftMs: persisted?.ttftMs ?? null,
      timingSource: persisted ? "平台逐生成步骤测量；模型用时仅完整覆盖才累计，TTFT/TPS取最近闭合步骤" : "权威生成计时未上报",
      // CR-068 J10：TPS 只在「本轮输出 tokens + 生成窗口」都已知时给值，否则保持未知。
      tps: persisted?.tps ?? null,
      tokensIn: curRt?.usageKnown ? curRt.tokensIn : null, tokensOut: curRt?.usageKnown ? curRt.tokensOut : null,
      cacheRead: curRt?.cacheKnown ? curRt.cacheRead : null,
      // 上下文是最近一次请求上报的当前窗口占用，不是累计 tokens；上限只认模型声明的 contextWindow。
      contextUsed: curRt?.lastPromptTokens ?? null,
      contextLimit: model?.contextWindow ?? null,
    };
  }, [msgs, statsSnapshot, cur?.id, cur?.providerId, cur?.modelId, models, curRt?.tokensIn, curRt?.tokensOut, curRt?.cacheRead, curRt?.timingKnown, curRt?.ttftMs, curRt?.lastPromptTokens, curRt?.lastOutTokens, curRt?.lastGenMs]);
  const agentRows = curRt?.subagents ?? [], bgRows = curRt?.background ?? [];
  const agentCount = agentRows.length, bgCount = bgRows.length;
  // CR-068 J12：只有真正需要用户处理（重建/另建）的绑定状态才显示标签与横幅；
  // REF_NOT_READY 是可直接重试的竞态（composerLocked 已放行），失败原因由本轮错误卡与提示承担。
  const bindingBlocks = !!binding && (binding.state === "freshPending" || (binding.state === "blocked" && binding.reasonCode !== "REF_NOT_READY"));
  const bindingPill = bindingBlocks && binding ? BINDING_PILL[binding.state] ?? null : null;
  const newButton = <button className="chat-iconbtn" title="新会话" aria-label="新会话" onClick={newSession}><Icon name="plus" /></button>;
  return <div ref={overlay.scopeRef} className={`chat-panel ${props.className ?? ""}`} hidden={props.visible === false} aria-label="AI 会话" data-ai-scope={scope} style={{ height: props.height ?? "100%", ...(props.width ? { width: Math.min(620, Math.max(320, props.width)) } : {}) }}>
    <div className="chat-head">
      {props.variant !== "workbench" && <button className={`chat-iconbtn ${overlay.activeOverlay === "history" ? "active" : ""}`} data-chat-overlay-trigger="history" title="会话历史" aria-label="会话历史" aria-expanded={overlay.activeOverlay === "history"} onClick={e => { if (overlay.activeOverlay !== "history") void loadSessionPage("", "first"); overlay.toggle("history", e.currentTarget); }}><HistoryIcon /></button>}
      {agentCount > 0 && <div className="chat-drop-wrap"><button className="chat-count-btn" data-chat-overlay-trigger="agents" aria-expanded={overlay.activeOverlay === "agents"} onClick={e => overlay.toggle("agents", e.currentTarget)}><Icon name="users" size={14} />{agentCount} 子智能体 <Icon name="chevronDown" size={12} /></button>
        {overlay.activeOverlay === "agents" && <div className="chat-drop" data-chat-overlay="agents" role="dialog" aria-label="子智能体"><div className="chat-drop-h"><b>子智能体</b><span className="chat-drop-cap">{agentCount} 个 · 仅本会话</span></div><div className="chat-drop-list">{agentRows.map(a => <button type="button" key={a.id} className="chat-agent-row" title={`查看子智能体：${a.title}`} aria-label={`查看子智能体 ${a.title}，只读`} onClick={() => { overlay.close(false); if (cur) props.onOpenAgent?.(cur.id, a.id); }}><CliLogo id={a.cli ?? "unknown"} size={20} /><span className="chat-agent-main"><b>{a.title}</b><span>{a.cli ?? "CLI 未知"} · {a.model ?? "模型未知"} · {a.duration ?? "耗时未知"} · {a.tokens ?? "tokens 未知"}</span></span><span className={`tag ${a.status === "失败" ? "bad" : a.status === "待确认" ? "warn" : "good"}`}>{a.status}</span><Icon name="chevronRight" size={12} /></button>)}</div><div className="chat-drop-f">{curRt?.recordsDemo ? "合成演示 · " : ""}点击行查看只读详情；记录仅本次运行可见</div></div>}
      </div>}
      {bgCount > 0 && <div className="chat-drop-wrap"><button className="chat-count-btn" data-chat-overlay-trigger="bg" aria-expanded={overlay.activeOverlay === "bg"} onClick={e => overlay.toggle("bg", e.currentTarget)}><Icon name="terminal" size={14} />{bgCount} 后台任务 <Icon name="chevronDown" size={12} /></button>
        {overlay.activeOverlay === "bg" && cur && <div className="chat-drop chat-drop-bg" data-chat-overlay="bg" role="dialog" aria-label="后台任务"><div className="chat-drop-h"><b>后台任务</b><span className="chat-drop-cap">仅本会话</span></div><div className="chat-drop-list">{[true, false].map(active => { const rows = bgRows.filter(b => (b.state === "运行中") === active); return <div className="chat-bg-group" key={String(active)}><div className="chat-bg-group-h"><span>{active ? "进行中" : "已结束"} {rows.length}</span>{!active && <button className="chat-bg-clear" disabled={!rows.length} onClick={() => { clearEndedBackground(cur.id); setBgOpenId(null); if (!getRuntime(cur.id).background.length) overlay.close(false); bumpRt(); }}>清空已结束</button>}</div>{!rows.length && <div className="chat-bg-empty">暂无记录</div>}{rows.map(b => <div className="chat-bg-row" key={b.id}><button className="chat-bg-head" aria-expanded={bgOpenId === b.id} onClick={() => setBgOpenId(prev => prev === b.id ? null : b.id)}><span className={`chat-bg-dot ${b.state === "运行中" ? "run" : b.state === "完成" ? "ok" : "fail"}`} /><span className="chat-bg-main"><b>{b.cmd}</b><span>{b.state} · 退出码 {b.exit} · {b.duration}</span></span><Icon name="chevronDown" size={12} /></button>{bgOpenId === b.id && <div className="chat-bg-detail"><span className="chat-bg-jobid">jobId {b.id}</span><pre>{b.output || "暂无输出"}</pre></div>}</div>)}</div>; })}</div><div className="chat-drop-f">{curRt?.recordsDemo ? "合成演示 · " : ""}只清展示，不终止任务</div></div>}
      </div>}
      <span className="spacer" />{cur?.sessionRole === "executor" && cur.featureId && <span className="chat-scope-tag" title={`执行特性：${cur.featureTitle ?? cur.featureId}；本会话仅实现该Feature`} aria-label={`执行特性：${cur.featureTitle ?? cur.featureId}，单特性执行会话`}>FEAT · <b>{cur.featureId}</b></span>}{bindingPill && binding && <span className={`chat-binding-pill ${binding.state}`} title={binding.state === "blocked" ? `原线程不可续接：${reasonLabel(binding.reasonCode)}` : "上下文需要确认重建后才能发送"}>{bindingPill}</span>}{newButton}
    </div>
    <div className="chat-fade" />
    {overlay.activeOverlay === "history" && <SessionHistory
      scopeId={scope}
      items={sessions}
      current={cur}
      currentId={cur?.id ?? null}
      total={sessionsPage.total}
      hasMore={sessionsPage.hasMore}
      loading={sessionsPage.loading}
      error={sessionsPage.error}
      keyword={sessionsPage.keyword}
      runningIds={runningIds}
      onLoadMore={() => void loadMoreSessions()}
      onSearch={searchSessions}
      onShowAll={showAllSessions}
      onRetry={retrySessions}
      onSwitch={openSession}
      onDelete={id => void deleteSession(id)}
      onCopyId={s => void copySessionId(s)}
      onFork={s => void forkSession(s)}
      onPin={s => void pinSession(s)}
      onRename={(s, title) => void renameSession(s, title)}
      onClose={() => overlay.close(true)}
    />}
    <MessageList msgs={msgs} projectId={props.projectId} rootUri={props.rootUri} officeFiles={props.officeFiles} visible={props.visible} working={working} onOpenAgent={id => { if (cur) props.onOpenAgent?.(cur.id, id); }} stepsSlot={queued > 0 ? <div className="chat-queued">已排队 {queued} 条，当前静止后发送</div> : undefined} />
    {bindingBlocks && binding && <div className="chat-block-banner" role="alert" aria-label="绑定阻塞横幅">
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
      {cur && curRt && <>
        <TodoPanel items={[...curRt.plan.tasks.values(), ...curRt.plan.todos]} expanded={curRt.todoExpanded} onToggle={() => { curRt.todoExpanded = !curRt.todoExpanded; bumpRt(); }} />
        {curRt.goal && curRt.goal.state !== "cancelled" && curRt.goal.state !== "complete" && <GoalBar key={curRt.goal.id} goal={curRt.goal} disarmed={!curRt.goalArmed} onEdit={text => { setGoal(cur.id, text); bumpRt(); }} onStateChange={state => { updateGoalState(cur.id, state); bumpRt(); }} onCleared={() => { composerFocusAfterClear.current = { sid: cur.id, scope }; }} />}
      </>}
      <Composer scopeKey={`${scope}:${cur?.id ?? "new"}`} rootUri={props.rootUri} projectId={props.projectId} office={props.office} officeFiles={props.officeFiles} sessions={sessions} serverId={props.serverId} value={draft} streaming={running} disabled={composerLocked} runner={cur?.runner ?? runnerDraft} cliId={cur ? cur.cliId : cliCands[0]?.id ?? null} onCreateGoal={text => { void createGoal(text); }} onOpenGoal={() => setGoalDraft("")} onChange={onDraftChange} onSend={startSend} onStop={stopSend} renderControls={({ add, send }) => <ModelPicker addControl={add} sendControl={send} cliId={cur?.cliId ?? null} providerId={cur?.providerId ?? null} modelId={cur?.modelId ?? null} effort={cur?.effort ?? null} cliCandidates={cliCands} models={models} permissionId={(cur?.id && permissionBySession[cur.id] as any) || "default"} locked={executionLocked || cfgBusy} onChange={applyCfg} runner={cur?.runner ?? runnerDraft} platformAvailable={models.length > 0} onRunnerChange={next => { void switchRunner(next); }} />} onSessionSearch={async (q: string) => (await api.chatSessionsPage({ ...(props.projectId ? { projectId: props.projectId } : {}), ...(props.serverId ? { serverId: props.serverId } : {}), ...(q.trim() ? { keyword: q.trim() } : {}), limit: 20 })).items} />
      {goalDraft !== null && <Modal title="创建目标" onClose={() => setGoalDraft(null)} footer={<>
        <button type="button" className="btn" onClick={() => setGoalDraft(null)}>取消</button>
        <button type="submit" form="chat-goal-create" className="btn primary" disabled={!goalDraft.trim()}>创建目标</button>
      </>}>
        <form id="chat-goal-create" className="chat-goal-create" onSubmit={e => { e.preventDefault(); void createGoal(goalDraft); }}>
          <textarea aria-label="目标内容" ref={element => element?.setAttribute("autofocus", "")} rows={3} value={goalDraft} onChange={e => setGoalDraft(e.target.value)} />
        </form>
      </Modal>}
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
    </div>
  </div>;
}

/**
 * CR-054 / STORY-073：把 workbench.open_panel 的 tool_use 输入解析成右栏请求。
 * 输入可能是完整 JSON 或 CLI 给的截断/字符串化版本；解析失败返回 null（不抛错、不影响本轮）。
 */
function panelRequestFromToolInput(inputJson: string | null | undefined): PanelRequest | null {
  if (!inputJson) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(inputJson); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  const kind = typeof value.kind === "string" ? value.kind.trim() : "";
  const key = typeof value.key === "string" ? value.key.trim() : "";
  if (!kind || !key) return null;
  return { kind: kind as PanelKind, key };
}
