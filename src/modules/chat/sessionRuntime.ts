import { emptyPlan, type SessionPlan } from "./sessionPlan";

/**
 * 会话运行时记录（CR-042 / CR-019 / STORY-062）。
 * - 步骤：来自本会话真实 toolUse/toolResult 事件的执行记录；不伪造步骤，
 *   无工具调用的会话不产生步骤。合成演示步骤只存在于显式 seedDemo 的演示会话。
 * - 子智能体 / 后台任务下拉：CR-042 §3.1 顶部下拉为合成演示（脚注标注），
 *   按会话隔离；「清空已结束」只清当前会话展示。
 * - 统计：TTFT / TPS / 模型用时 / 工具用时在发送侧测量；失败会话保留失败状态。
 * - CR-068 J10：Token 为整会话累计（按 requestId 去重）；上下文只取最近一次请求上报的
 *   提示词用量（当前窗口），不累计历史窗口，未上报保持 null（未知不填 0）。
 */

export type StepState = "running" | "done" | "todo" | "failed";

export interface ChatStep {
  id: string;
  title: string;
  state: StepState;
  /** 已完成/失败附带的耗时或退出码说明；执行中为空 */
  meta?: string;
}

export type SessionGoalState = "active" | "paused" | "blocked" | "cancelled" | "complete";

export interface SessionGoal {
  id: string;
  text: string;
  state: SessionGoalState;
  revision: number;
  history: { revision: number; state: SessionGoalState; text: string; at: number }[];
}

export type SessionTaskState = "pending" | "running" | "completed" | "failed" | "cancelled" | "awaiting_user";

export interface SessionTask {
  id: string;
  taskName: string;
  state: SessionTaskState;
  source: "user" | "agent" | "tool";
  startedAt: number | null;
  endedAt: number | null;
  agentId?: string | null;
}

/** CR-062：子智能体过程事件，只读详情按时间顺序展示；未知字段不补造。 */
export interface SubagentEvent {
  at: number;
  /** 事件种类：状态变化 / 正文 / 工具调用 / 工具结果 / 最终产出 */
  kind: "status" | "text" | "tool" | "result" | "output";
  status?: string;
  text?: string;
  toolName?: string;
  isError?: boolean;
}

export interface SubagentRow {
  id: string;
  cli: string | null;
  title: string;
  model: string | null;
  duration: string | null;
  tokens: string | null;
  status: "运行中" | "成功" | "待确认" | "失败" | "已停止";
  output?: string | null;
  parentId?: string | null;
  /** CR-062：执行任务标识（事件携带时显示，否则保持未知）。 */
  taskId?: string | null;
  /** CR-062：本次运行内的过程记录；刷新或重启后不承诺恢复。 */
  events?: SubagentEvent[];
  startedAt?: number;
  endedAt?: number;
}

export interface BackgroundRow {
  id: string;
  cmd: string;
  state: "运行中" | "完成" | "失败";
  exit: string;
  duration: string;
  output: string;
}

export type SessionStatus = "success" | "failed" | "pending" | "read";

export interface SessionRuntime {
  goal: SessionGoal | null;
  goalArmed: boolean;
  plan: SessionPlan;
  todoExpanded: boolean;
  /** CR-103：待发队列面板折叠状态（会话内保持，内存） */
  queueFolded: boolean;
  tasks: SessionTask[];
  steps: ChatStep[];
  subagents: SubagentRow[];
  background: BackgroundRow[];
  /** 累计 token（整会话） */
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  /** 累计模型用时 / 工具用时（ms，客户端测量） */
  modelMs: number;
  toolMs: number;
  ttftMs: number | null;
  /** 最近一轮输出 tokens / 耗时（用于 TPS 估算） */
  lastOutTokens: number;
  lastStreamMs: number;
  /** 最近一轮扣掉工具调用后的生成窗口（ms）；TPS 分母，未知保持 0。 */
  lastGenMs: number;
  /**
   * CR-068 J10：最近一次请求上报的提示词用量（未缓存输入 + 缓存读取，互斥字段相加）。
   * 上下文是**当前窗口**占用，不是整会话累计；没有上报时保持 null（未知不填 0）。
   */
  lastPromptTokens: number | null;
  /** 最近一次记录窗口用量的请求代次，只允许不早于它的请求覆盖，旧事件不能改写当前窗口。 */
  lastPromptSeq: number | null;
  status: SessionStatus;
  /** 步骤是否为合成演示（仅演示会话为 true，显示「推进演示」） */
  stepsDemo: boolean;
  /** 折叠状态在会话内保持 */
  stepsOpen: boolean;
  /** 各工具调用开始时间（toolId -> ts） */
  toolStart: Map<string, number>;
  /** 本轮流式开始时间 */
  streamStart: number | null;
  /**
   * CR-101：本轮已接收输出的 token 估算（按码点密度累加，含思考与工具参数）。
   * 这是实时流速的**分子**，只在流式过程中有意义；不是 provider 的权威计量。
   */
  liveEstimatedTokens: number;
  /** CR-101：本轮实时流速采样器；每步一个新实例，终态清空。 */
  liveSampler: StreamingRateSampler | null;
  /** CR-101：由已结算步骤校准的 token 密度修正因子，钳在 0.5～2，无样本时为 1。 */
  liveTokenScale: number;
  /** CR-101：本轮首个输出增量的时间戳（仅用于判断是否已开始输出）。 */
  liveStart: number | null;
  /** 绑定会话代次；stop/finish 后同轮迟到事件无效。 */
  generation: number;
  active: boolean;
  turnToolMs: number;
  /** 每个 request 的累计上报：在 request 内取最大差值，跨 request 累加。 */
  usageByRequest: Map<string, { input: number; output: number; cache: number }>;
  usageKnown: boolean;
  cacheKnown: boolean;
  timingKnown: boolean;
  recordsDemo: boolean;
}

const store = new Map<string, SessionRuntime>();

function blank(): SessionRuntime {
  return {
    goal: null,
    goalArmed: false,
    plan: emptyPlan(),
    todoExpanded: false,
    queueFolded: false,
    tasks: [],
    steps: [],
    subagents: [],
    background: [],
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    modelMs: 0,
    toolMs: 0,
    ttftMs: null,
    lastOutTokens: 0,
    lastStreamMs: 0,
    lastGenMs: 0,
    lastPromptTokens: null,
    lastPromptSeq: null,
    status: "read",
    stepsDemo: false,
    stepsOpen: true,
    toolStart: new Map(),
    streamStart: null,
    liveEstimatedTokens: 0,
    liveSampler: null,
    liveTokenScale: 1,
    liveStart: null,
    generation: 0,
    active: false,
    turnToolMs: 0,
    usageByRequest: new Map(),
    usageKnown: false,
    cacheKnown: false,
    timingKnown: false,
    recordsDemo: false,
  };
}

export function getRuntime(sid: string): SessionRuntime {
  let rt = store.get(sid);
  if (!rt) {
    rt = blank();
    store.set(sid, rt);
  }
  return rt;
}

export function setGoal(sid: string, text: string): SessionGoal {
  const rt = getRuntime(sid);
  const prior = rt.goal;
  const revision = (prior?.revision ?? 0) + 1;
  const isNew = !prior || prior.state === "cancelled" || prior.state === "complete";
  const state = isNew ? "active" : prior.state;
  const goal: SessionGoal = {
    id: isNew ? `goal-${sid}-${revision}` : prior.id,
    text: text.trim(),
    state,
    revision,
    history: [...(prior?.history ?? []), { revision, state, text: text.trim(), at: Date.now() }],
  };
  rt.goal = goal;
  if (isNew) rt.goalArmed = true;
  return goal;
}

export function updateGoalState(sid: string, state: SessionGoalState): SessionGoal | null {
  const rt = getRuntime(sid);
  if (!rt.goal) return null;
  const revision = rt.goal.revision + 1;
  rt.goalArmed = state === "active";
  rt.goal = { ...rt.goal, state, revision, history: [...rt.goal.history, { revision, state, text: rt.goal.text, at: Date.now() }] };
  return rt.goal;
}

export function addSessionTask(sid: string, taskName: string): SessionTask {
  const rt = getRuntime(sid);
  const task: SessionTask = { id: `task-${sid}-${Date.now()}-${rt.tasks.length}`, taskName: taskName.trim(), state: "pending", source: "user", startedAt: null, endedAt: null };
  rt.tasks.push(task);
  return task;
}

export function hasBlockingChildren(sid: string): boolean {
  const rt = getRuntime(sid);
  return rt.subagents.some(a => ["运行中", "待确认"].includes(a.status)) || rt.tasks.some(t => ["running", "awaiting_user"].includes(t.state));
}

export function upsertSubagent(sid: string, input: { id: string; task: string; status: string; cli?: string | null; model?: string | null; durationMs?: number | null; tokens?: number | null; output?: string | null; parentId?: string | null; taskId?: string | null; content?: string | null; kind?: string | null; toolName?: string | null; isError?: boolean | null }) {
  const rt = getRuntime(sid);
  const status = input.status === "failed" ? "失败" : input.status === "done" || input.status === "success" || input.status === "completed" ? "成功" : input.status === "stopped" ? "已停止" : input.status === "running" ? "运行中" : "待确认";
  const prior = rt.subagents.find(a => a.id === input.id);
  const now = Date.now();
  const statusChanged = !prior || prior.status !== status;
  const events = prior?.events ?? [];
  const row: SubagentRow = {
    id: input.id,
    cli: input.cli ?? prior?.cli ?? null,
    title: input.task || prior?.title || "子代理任务",
    model: input.model ?? prior?.model ?? null,
    duration: input.durationMs != null ? formatDur(input.durationMs) : prior?.duration ?? null,
    tokens: input.tokens != null ? `${input.tokens >= 1000 ? (input.tokens / 1000).toFixed(1) + "k" : input.tokens}` : prior?.tokens ?? null,
    status,
    output: input.output ?? prior?.output ?? null,
    parentId: input.parentId ?? prior?.parentId ?? null,
    taskId: input.taskId ?? prior?.taskId ?? null,
    events,
    startedAt: prior?.startedAt ?? now,
    endedAt: status === "运行中" || status === "待确认" ? prior?.endedAt : prior?.endedAt ?? now,
  };
  if (prior) Object.assign(prior, row); else rt.subagents.push(row);
  const target = prior ?? row;
  // CR-062：状态变化与过程内容进入只读详情时间线；刷新后不承诺恢复。
  if (statusChanged) pushAgentEvent(target, { at: now, kind: "status", status });
  if (input.content && input.content.trim()) {
    const kind = input.kind === "tool_use" || input.kind === "tool_result" ? "tool" : input.kind === "output" ? "output" : "text";
    pushAgentEvent(target, { at: now, kind, text: input.content, toolName: input.toolName ?? undefined, isError: input.isError ?? undefined });
  }
  if (input.output && input.output !== prior?.output) {
    pushAgentEvent(target, { at: now, kind: "output", text: input.output });
  }
  if (status === "运行中" || status === "待确认") {
    const task = rt.tasks.find(t => t.agentId === input.id);
    if (task) task.state = status === "运行中" ? "running" : "awaiting_user";
  }
  return target;
}

/** CR-062：同一状态/文本不重复追加，避免流式完整消息重复刷屏。 */
function pushAgentEvent(row: SubagentRow, ev: SubagentEvent) {
  if (!row.events) row.events = [];
  if (ev.kind !== "status" && ev.text) {
    const tail = row.events.slice(-20);
    if (tail.some(x => x.kind === ev.kind && x.text === ev.text && x.toolName === ev.toolName)) return;
  }
  row.events.push(ev);
  if (row.events.length > 200) row.events.splice(0, row.events.length - 200);
}

/** CR-062：流结束仍未收到子代理终态时只标“待确认”，不替它宣布成功。 */
export function settleSubagents(sid: string, stopped = false): number {
  const rt = getRuntime(sid);
  const next = stopped ? "已停止" : "待确认";
  let count = 0;
  for (const a of rt.subagents) {
    if (a.status !== "运行中" && a.status !== "待确认") continue;
    a.status = next;
    a.endedAt = a.endedAt ?? Date.now();
    pushAgentEvent(a, { at: Date.now(), kind: "status", status: next });
    count++;
  }
  return count;
}

/** CR-062：只读详情按 id 取当前行（含本次运行的事件）。 */
export function findSubagent(sid: string, agentId: string): SubagentRow | null {
  return getRuntime(sid).subagents.find(a => a.id === agentId) ?? null;
}


export function markStreamStart(sid: string): number {
  const rt = getRuntime(sid);
  rt.generation++;
  rt.active = true;
  rt.status = "pending";
  rt.streamStart = Date.now();
  rt.turnToolMs = 0;
  rt.ttftMs = null;
  rt.lastOutTokens = 0;
  rt.lastStreamMs = 0;
  rt.lastGenMs = 0;
  // CR-101：新轮从零开始，不继承上一轮的实时流速中间态；密度因子保留（同一模型的密度稳定）。
  rt.liveEstimatedTokens = 0;
  rt.liveSampler = new StreamingRateSampler();
  rt.liveStart = null;
  rt.toolStart.clear();
  if (rt.stepsDemo) rt.steps = [];
  rt.stepsDemo = false;
  // 真实请求不能混入先前的合成子代理/后台记录。
  if (rt.recordsDemo) { rt.subagents = []; rt.background = []; rt.recordsDemo = false; }
  return rt.generation;
}

export function isCurrentTurn(sid: string, generation: number): boolean {
  const rt = getRuntime(sid);
  return rt.active && rt.generation === generation;
}

/** done/error/stop/IPC拒绝均只能结束一次。 */
export function finishOnce(sid: string, generation: number, status: SessionStatus): boolean {
  if (!isCurrentTurn(sid, generation)) return false;
  const rt = getRuntime(sid);
  rt.active = false;
  const u = rt.usageByRequest.get(String(generation));
  markStreamEnd(sid, u?.output ?? 0);
  rt.status = status;
  for (const step of rt.steps) {
    if (step.state === "running") {
      step.state = "todo";
      step.meta = "结果未返回";
    }
  }
  rt.toolStart.clear();
  return true;
}

export function markFirstDelta(sid: string) {
  const rt = getRuntime(sid);
  if (rt.streamStart != null && rt.ttftMs == null) {
    rt.ttftMs = Date.now() - rt.streamStart;
  }
}

export function markStreamEnd(sid: string, outTokens: number) {
  const rt = getRuntime(sid);
  if (rt.streamStart != null) {
    const total = Date.now() - rt.streamStart;
    rt.lastStreamMs = total;
    rt.lastOutTokens = outTokens;
    // 工具用时在 recordToolResult 时已累计进 rt.toolMs，模型用时=总耗时-工具用时
    const modelMs = Math.max(0, total - rt.turnToolMs);
    rt.lastGenMs = modelMs;
    rt.modelMs += modelMs;
    rt.timingKnown = true;
    rt.streamStart = null;
  }
  // CR-101：本轮闭合后用 provider 的权威 output tokens 校准 token 密度，
  // 让下一轮的实时估算收敛到实际模型；随后立即停止刷新并清空中间态，
  // 不冻结过期数字——闭合后的 TPS 只由权威测量（outputTps）提供。
  if (rt.liveEstimatedTokens > 0 && outTokens > 0) {
    const scale = outTokens / rt.liveEstimatedTokens;
    rt.liveTokenScale = Math.min(MAX_MEASURED_SCALE, Math.max(MIN_MEASURED_SCALE, scale));
  }
  rt.liveEstimatedTokens = 0;
  rt.liveSampler = null;
  rt.liveStart = null;
}

/* ---------------- CR-101：生成中实时流速（有界滑动窗口估算） ----------------
 * 口径参考 DSH 运行环境中已启用的统计行插件（dsh-token-total 的 StreamingRateSampler），
 * 用它证明可行的三条规则保持读数诚实：
 * 1. 分子只取「窗口内观察到的增长」，绝不用累计值——窗口开启前产生的文本不能被计入；
 * 2. 窗口有下界（首块突发不读数）也有上界（不退化成整步平均）；
 * 3. 发布值经过平滑，且只有真正增长的一帧才能推进窗口；重复帧不推进。
 * 与 DSH 官方 settled 口径的区别：官方 decodeMs 是「首 token → 消息组装」，
 * 这里额外要求官方没有的「生成中」读数，因此额外做了积压帧检测与重锚。
 */

/**
 * DeepSeek 官方文本密度（api-docs.deepseek.com「Token 用量计算」）：
 * 一个中文字符 ≈ 0.6 token，一个英文字符 ≈ 0.3 token。
 * 按码点逐字取较密的一档，是保守侧；不使用「四字符一 token」的启发式（会低估中文）。
 */
const CJK_TOKENS_PER_CHAR = 0.6;
const ASCII_TOKENS_PER_CHAR = 0.3;

/** 发布实时读数的最短窗口；短于此首块突发会读成几百 tok/s。 */
const MIN_STREAM_WINDOW_MS = 200;
/** 实时读数允许跨越的最长窗口；超过即丢弃旧样本，避免退化成整步平均。 */
const MAX_STREAM_WINDOW_MS = 2_000;
/** 窗口内样本数上限，仅作无界增长的兜底。 */
const MAX_WINDOW_SAMPLES = 512;
/** 采样能分辨的最高速率（tokens/ms，即 1500 tok/s）；超过即判定为 UI 积压帧。 */
const MAX_SAMPLED_TOKENS_PER_MS = 1.5;
/** 合理性检查可判断的最短跨度；避免同帧两次观测把正常首块判成异常。 */
const MIN_SLOPE_SPAN_MS = 50;
/** 发布值的一阶低通时间常数。 */
const SMOOTHING_TAU_MS = 1_000;
/** 校准因子的上下界：单个不具代表性的样本不能把估算拉离官方密度。 */
const MIN_MEASURED_SCALE = 0.5;
const MAX_MEASURED_SCALE = 2;

/** 一段文本在官方密度下的 token 先验估算。 */
export function priorTokens(text: string): number {
  let tokens = 0;
  for (const character of text) {
    tokens += (character.codePointAt(0) ?? 0) <= 0x7f ? ASCII_TOKENS_PER_CHAR : CJK_TOKENS_PER_CHAR;
  }
  return tokens;
}

/**
 * 生成中实时解码速率的**有界滑动窗口**估算器。
 *
 * 三条规则（对应上面的注释）：分子只取窗口内增长；窗口上下界都有限；发布值平滑且只由增长帧推进。
 * 所有状态变更都发生在 {@link observe}，{@link ratePerSecond} 只读——
 * 这样渲染阶段的一次读取不会反过来决定下一次要发布什么。
 */
export class StreamingRateSampler {
  /** 窗口内的 (时间, token) 观测，最旧在前。 */
  private samples: { at: number; tokens: number }[] = [];
  /**
   * 最后发布的速度（tok/s）；窗口还没有可用跨度时为 null。
   * 静默期保留上一次可测得的读数，而不是回落到整段平均后凭空跳一下。
   */
  private published: number | null = null;
  /** 该读数的墙钟时间，用于计算平滑权重。 */
  private publishedAt = 0;

  /** 观测一次本轮当前的 token 估算值，并推进发布值。 */
  observe(tokens: number, now: number): void {
    const last = this.samples[this.samples.length - 1];
    // 首次观测锚定窗口；估算值下降（重试、块被整体替换）也重新锚定——
    // 否则会去测量流并没有产生的增长。锚定不发布，因为它还没有跨度。
    if (last === undefined || tokens < last.tokens) {
      this.samples = [{ at: now, tokens }];
      return;
    }
    // 重复帧不携带信息：只会把窗口远端往前推，让读数无端向整段平均下沉。
    if (tokens === last.tokens) return;
    this.samples.push({ at: now, tokens });
    // 窗口上界：超过一个窗口的样本离开，包括最前面的零锚点
    // （它的跨度量的是等首 token 的时间，不是解码时间）。
    while (this.samples.length > 1 && now - this.samples[0]!.at > MAX_STREAM_WINDOW_MS) {
      this.samples.shift();
    }
    if (this.samples.length >= MAX_WINDOW_SAMPLES) {
      this.samples.splice(0, this.samples.length - MAX_WINDOW_SAMPLES / 2);
    }
    const first = this.samples[0]!;
    const span = now - first.at;
    const grown = tokens - first.tokens;
    // 斜率超过任何真实供应商的输出速度：这一帧携带的是窗口开启前就产生的数量
    // （切回标签页、主线程卡顿都会批量推帧）。重新锚定而不发布，
    // 让读数从真正到达的增量重新开始。此检查必须在下面的下界之前，
    // 否则早到的积压帧会以「跨度不足、不读数」留在窗口里，由下一帧把积压读成速率。
    if (grown > Math.max(span, MIN_SLOPE_SPAN_MS) * MAX_SAMPLED_TOKENS_PER_MS) {
      this.samples = [{ at: now, tokens }];
      return;
    }
    // 下界：跨度太短不可信，不发布，屏幕上已有的读数保持不变。
    if (span < MIN_STREAM_WINDOW_MS) return;
    const rate = grown / (span / 1_000);
    if (this.published === null) {
      this.published = rate;
    } else {
      const weight = Math.min(1, (now - this.publishedAt) / SMOOTHING_TAU_MS);
      this.published += weight * (rate - this.published);
    }
    this.publishedAt = now;
  }

  /** 要显示的读数；从未测得时为 null，由调用方回落到权威结算值。 */
  ratePerSecond(): number | null {
    return this.published;
  }

  /** 估算的计价尺度变了：丢弃窗口，但保留已发布值（速度没变，只是单位变了）。 */
  reset(): void {
    this.samples = [];
  }
}

/**
 * CR-101：记录一段真实输出增量（正文或思考），按码点密度累加进本轮估算。
 * 思考与工具调用参数同样计入，因为 provider 的 outputTokens 包含它们；
 * 只算可见答复会让工具密集的步骤明显低于它自己的结算值。
 */
export function noteLiveDelta(sid: string, text: string) {
  const rt = getRuntime(sid);
  if (!text) return;
  const tokens = priorTokens(text);
  if (!(tokens > 0)) return;
  if (rt.liveStart == null) rt.liveStart = Date.now();
  rt.liveEstimatedTokens += tokens;
  if (rt.liveSampler === null) rt.liveSampler = new StreamingRateSampler();
}

/** CR-101：工具调用参数属于输出 tokens，一并计入本轮估算。 */
export function noteLiveToolArgs(sid: string, argsJson: string | undefined) {
  if (!argsJson) return;
  noteLiveDelta(sid, argsJson);
}

/**
 * CR-101 R-CR101-8：按固定节拍采样一次，返回平滑后的实时速率。
 * 只应在运行中调用；无采样器或样本不足时返回 null。
 */
export function tickLiveRate(sid: string, now = Date.now()): number | null {
  const rt = getRuntime(sid);
  const sampler = rt.liveSampler;
  if (sampler === null) return null;
  sampler.observe(rt.liveEstimatedTokens * rt.liveTokenScale, now);
  return sampler.ratePerSecond();
}

export interface LiveTps {
  /** 每秒输出速度（tok/s）。 */
  tps: number;
  /** true 表示由 token 密度估算，展示必须标注为估算。 */
  estimated: boolean;
}

/**
 * CR-101 R-CR101-9/10：当前要展示的实时速率。
 * 未测得（新建会话、窗口刚重锚）返回 null，由展示层回落到权威结算值，绝不填 0。
 */
export function liveTps(rt: SessionRuntime): LiveTps | null {
  const rate = rt.liveSampler?.ratePerSecond() ?? null;
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return null;
  return { tps: rate, estimated: true };
}

/**
 * CR-068 J10：最近一轮输出速度（tok/s）。
 * 只有「本轮输出 tokens」和「扣除工具调用后的生成窗口」都已知时才给值；否则保持未知（null），不推算。
 */
export function outputTps(rt: SessionRuntime): number | null {
  if (!(rt.lastOutTokens > 0) || !(rt.lastGenMs > 0)) return null;
  return Math.round((rt.lastOutTokens * 1000) / rt.lastGenMs);
}

/* ---------- 步骤：真实工具执行记录（不伪造） ---------- */

/**
 * CR-059 / UI-CR059：内置工作台工具名 → 侧栏中文显示名（仅显示文案；映射未命中原样显示）。
 * 与后端 ai_tools.rs TOOL_LABELS 对齐。
 */
const WORKBENCH_TOOL_LABELS: Record<string, string> = {
  get_context: "工作台·当前上下文",
  list_projects: "工作台·项目清单",
  create_project: "工作台·创建项目",
  update_project: "工作台·更新项目",
  get_requirements: "工作台·需求树",
  read_requirement_doc: "工作台·读需求文档",
  write_requirement_doc: "工作台·写需求文档",
  list_kbs: "工作台·知识库清单",
  create_kb: "工作台·创建知识库",
  set_kb_grant: "工作台·设置知识授权",
  list_servers: "工作台·服务器清单",
  save_server: "工作台·保存服务器",
  // CR-059 G4：生图工具
  generate_image: "工作台·生成图片",
  read_skill: "工作台·读取技能",
  // CR-059 / BUG-CR059-01：原有 6 项内置工具真实注入后的中文名（与后端 TOOL_LABELS 一致）
  fs_read: "工作台·读文件",
  knowledge_list: "工作台·知识清单",
  knowledge_search: "工作台·知识检索",
  knowledge_read: "工作台·读知识",
  knowledge_read_many: "工作台·批量读知识",
  ssh_exec: "工作台·服务器命令",
  // CR-105：AI 侧连接/断开主机（与后端 TOOL_LABELS 一致）
  ssh_connect: "工作台·连接服务器",
  ssh_disconnect: "工作台·断开服务器",
  // CR-059 二期：审批结论查询
  ssh_exec_status: "工作台·审批结论",
  // CR-054 / STORY-073：右栏请求
  open_panel: "工作台·打开预览面板",
  // CR-069 / STORY-091：派发工作给受管执行（与后端 ai_tools.rs TOOL_LABELS 一致）
  dispatch_work: "工作台·派发工作",
};

export function toolDisplayName(name: string | null | undefined): string | null {
  if (!name) return name ?? null;
  const m = /^mcp__workbench__(.+)$/.exec(name);
  if (m && WORKBENCH_TOOL_LABELS[m[1]]) return WORKBENCH_TOOL_LABELS[m[1]];
  return name;
}

export function recordToolUse(sid: string, toolId: string, name: string) {
  const rt = getRuntime(sid);
  if (rt.stepsDemo) rt.steps = [];
  rt.stepsDemo = false;
  if (rt.toolStart.has(toolId)) return;
  rt.toolStart.set(toolId, Date.now());
  rt.steps.push({ id: `ST-${rt.generation}-${toolId}`, title: toolDisplayName(name) ?? "工具", state: "running" });
}

export function recordToolResult(sid: string, toolId: string, isError: boolean, meta?: string) {
  const rt = getRuntime(sid);
  const start = rt.toolStart.get(toolId);
  const dur = start != null ? Date.now() - start : null;
  if (start != null) { rt.toolMs += dur ?? 0; rt.turnToolMs += dur ?? 0; }
  rt.toolStart.delete(toolId);
  const step = rt.steps.find(s => s.id === `ST-${rt.generation}-${toolId}`);
  if (step && step.state !== "running") return;
  if (step) {
    step.state = isError ? "failed" : "done";
    step.meta = isError ? meta ?? "失败" : dur != null ? formatDur(dur) : undefined;
  }
  if (isError && rt.status !== "failed") rt.status = "failed";
}

/** 会话加载时从既有消息重建步骤（只依真实工具消息，不虚构） */
export function rebuildStepsFromPairs(sid: string, pairs: { toolId: string; name: string; isError: boolean; completed?: boolean }[]) {
  const rt = getRuntime(sid);
  if (rt.active || rt.stepsDemo) return; // 切回运行中会话不能用落库半成品覆盖实时记录
  rt.steps = pairs.map((p, i) => ({
    id: `ST-history-${i}-${p.toolId}`,
    title: toolDisplayName(p.name) || "来源调用未记录",
    state: p.completed ? (p.isError ? "failed" : "done") : "todo",
    meta: p.completed ? (p.isError ? "失败" : undefined) : "结果未返回",
  }));
}

/* ---------- 合成演示（仅演示会话；显式 seed，不自动出现） ---------- */

const DEMO_SUBAGENTS: SubagentRow[] = [
  { id: "SA-1", taskId: "RUN-3182-A", cli: "claude", title: "检索登录模块鉴权实现", model: "deepseek-v4.1", duration: "1m12s", tokens: "8.6k", status: "成功", output: "鉴权入口位于 src/auth/session.ts；校验分支 3 处，均已覆盖失败路径。", events: [
    { at: 0, kind: "status", status: "运行中" },
    { at: 0, kind: "text", text: "先按调用链定位登录入口与 token 校验点。" },
    { at: 0, kind: "tool", toolName: "code-search", text: "search: login|authenticate|verifyToken" },
    { at: 0, kind: "result", text: "命中 src/auth/session.ts、src/api/login.ts 共 11 处。" },
    { at: 0, kind: "output", text: "鉴权入口位于 src/auth/session.ts；校验分支 3 处，均已覆盖失败路径。" },
    { at: 0, kind: "status", status: "成功" },
  ] },
  { id: "SA-2", taskId: "RUN-3182-B", cli: "codex", title: "复现并缩小失败用例", model: "gpt-5.2", duration: "2m31s", tokens: "12.4k", status: "待确认", output: "已稳定复现，最小用例待确认是否保留并发回补断言。", events: [
    { at: 0, kind: "status", status: "运行中" },
    { at: 0, kind: "tool", toolName: "shell", text: "pnpm vitest run tests/capacity.spec.ts -t 回补" },
    { at: 0, kind: "result", text: "1 failed · 期望 2 实际 1（演示输出）", isError: true },
    { at: 0, kind: "text", text: "失败点在并发回补断言，需要人工确认保留范围。" },
    { at: 0, kind: "status", status: "待确认" },
  ] },
  { id: "SA-3", taskId: "RUN-3182-C", cli: "claude", title: "汇总测试覆盖缺口", model: "deepseek-v4.1", duration: "48s", tokens: "5.1k", status: "成功", output: "覆盖率缺口集中在取消回补与超时分支。", events: [
    { at: 0, kind: "status", status: "运行中" },
    { at: 0, kind: "text", text: "对照特性验收标准检查现有用例覆盖。" },
    { at: 0, kind: "output", text: "覆盖率缺口集中在取消回补与超时分支。" },
    { at: 0, kind: "status", status: "成功" },
  ] },
  { id: "SA-4", taskId: "RUN-3182-D", cli: "grok", title: "起草修复方案对比", model: "grok-4", duration: "1m47s", tokens: "9.9k", status: "失败", output: "CLI 退出码 1：模型端拒绝请求（演示失败，不代表真实结论）。", events: [
    { at: 0, kind: "status", status: "运行中" },
    { at: 0, kind: "text", text: "准备比较三种回补策略的副作用。" },
    { at: 0, kind: "status", status: "失败" },
  ] },
];

const DEMO_BACKGROUND: BackgroundRow[] = [
  { id: "JOB-3182", cmd: "pnpm vitest run tests/capacity.spec.ts", state: "运行中", exit: "—", duration: "00:42", output: "RUN v2.1.0 …（演示输出）\n✓ tests/login.spec.ts (12)\n↳ 其余用例执行中" },
  { id: "JOB-3179", cmd: "npm run lint -- --max-warnings 0", state: "完成", exit: "0", duration: "00:18", output: "✔ 无 lint 告警（演示输出）" },
  { id: "JOB-3180", cmd: "cargo clippy --all-targets", state: "完成", exit: "0", duration: "01:05", output: "Finished dev profile（演示输出）" },
  { id: "JOB-3181", cmd: "node scripts/verify-dispatch.mjs", state: "失败", exit: "1", duration: "00:09", output: "TypeError: 数据源未配置（演示失败输出，仅用于状态展示）" },
];

export function seedDemo(sid: string) {
  const rt = getRuntime(sid);
  if (rt.active || rt.steps.some(s => !s.id.startsWith("ST-D"))) return;
  rt.recordsDemo = true;
  if (rt.subagents.length === 0) rt.subagents = DEMO_SUBAGENTS.map(x => ({ ...x }));
  if (rt.background.length === 0) rt.background = DEMO_BACKGROUND.map(x => ({ ...x }));
  if (rt.steps.length === 0) {
    rt.stepsDemo = true;
    rt.steps = [
      { id: "ST-D1", title: "读取会话上下文与引用文件", state: "done", meta: "0.8s" },
      { id: "ST-D2", title: "检索相关代码与知识条目", state: "done", meta: "1.2s" },
      { id: "ST-D3", title: "执行修改并运行针对性检查", state: "running", meta: "进行中" },
      { id: "ST-D4", title: "汇总差异与后续建议", state: "todo" },
      { id: "ST-D5", title: "输出验证结论", state: "todo" },
    ];
  }
}

/** 推进演示：只推进本会话的合成步骤（下一条转为执行中） */
export function advanceDemoStep(sid: string): boolean {
  const rt = getRuntime(sid);
  if (!rt.stepsDemo) return false;
  const running = rt.steps.find(s => s.state === "running");
  if (running) {
    running.state = "done";
    running.meta = "1.4s";
  }
  const next = rt.steps.find(s => s.state === "todo");
  if (next) {
    next.state = "running";
    next.meta = "进行中";
  }
  return Boolean(next);
}

/* ---------- 用量与状态 ---------- */

export function addUsage(sid: string, input: number, output: number, cacheRead: number, requestId = String(getRuntime(sid).generation)) {
  const rt = getRuntime(sid);
  const prior = rt.usageByRequest.get(requestId) ?? { input: 0, output: 0, cache: 0 };
  const finite = (n: number) => Number.isFinite(n) && n >= 0 ? n : 0;
  const next = { input: Math.max(prior.input, finite(input)), output: Math.max(prior.output, finite(output)), cache: Math.max(prior.cache, finite(cacheRead)) };
  rt.tokensIn += next.input - prior.input;
  rt.tokensOut += next.output - prior.output;
  rt.cacheRead += next.cache - prior.cache;
  rt.usageByRequest.set(requestId, next);
  // CR-068 J10：上下文窗口取最近一次请求的提示词用量（互斥字段相加），不累加历史窗口。
  const seq = Number(requestId);
  if (!Number.isFinite(seq)) rt.lastPromptTokens = next.input + next.cache;
  else if (rt.lastPromptSeq === null || seq >= rt.lastPromptSeq) {
    rt.lastPromptTokens = next.input + next.cache;
    rt.lastPromptSeq = seq;
  }
  rt.usageKnown = true;
  rt.cacheKnown = true;
}

/** 落库消息为整会话权威值；历史未上报的缓存/耗时保持未知。
 *  CR-068 J10：`lastPrompt` 是最近一条带 usage 的消息的提示词用量（当前窗口），不传则保持未知。 */
export function hydrateUsage(sid: string, input: number, output: number, known: boolean, cache?: number, lastPrompt?: number | null) {
  const rt = getRuntime(sid);
  if (rt.active) return;
  rt.tokensIn = input;
  rt.tokensOut = output;
  rt.usageKnown = known;
  if (cache !== undefined) { rt.cacheRead = cache; rt.cacheKnown = true; }
  if (lastPrompt !== undefined) {
    rt.lastPromptTokens = lastPrompt;
    rt.lastPromptSeq = null;
  }
}

export function dropRuntime(sid: string) { store.delete(sid); }

export function setStatus(sid: string, status: SessionStatus) {
  const rt = getRuntime(sid);
  rt.status = status;
}

export function clearEndedBackground(sid: string) {
  const rt = getRuntime(sid);
  rt.background = rt.background.filter(b => b.state === "运行中");
}

export function formatDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${String(s).padStart(2, "0")}s`;
}
