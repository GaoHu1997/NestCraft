/**
 * 会话运行时记录（CR-042 / CR-019 / STORY-062）。
 * - 步骤：来自本会话真实 toolUse/toolResult 事件的执行记录；不伪造步骤，
 *   无工具调用的会话不产生步骤。合成演示步骤只存在于显式 seedDemo 的演示会话。
 * - 子智能体 / 后台任务下拉：CR-042 §3.1 顶部下拉为合成演示（脚注标注），
 *   按会话隔离；「清空已结束」只清当前会话展示。
 * - 统计：TTFT / TPS / 模型用时 / 工具用时在发送侧测量；失败会话保留失败状态。
 */

export type StepState = "running" | "done" | "todo" | "failed";

export interface ChatStep {
  id: string;
  title: string;
  state: StepState;
  /** 已完成/失败附带的耗时或退出码说明；执行中为空 */
  meta?: string;
}

export type SessionGoalState = "active" | "paused" | "cancelled";

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
  status: SessionStatus;
  /** 步骤是否为合成演示（仅演示会话为 true，显示「推进演示」） */
  stepsDemo: boolean;
  /** 折叠状态在会话内保持 */
  stepsOpen: boolean;
  /** 各工具调用开始时间（toolId -> ts） */
  toolStart: Map<string, number>;
  /** 本轮流式开始时间 */
  streamStart: number | null;
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
    status: "read",
    stepsDemo: false,
    stepsOpen: true,
    toolStart: new Map(),
    streamStart: null,
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
  const goal: SessionGoal = {
    id: prior?.id ?? `goal-${sid}`,
    text: text.trim(),
    state: prior?.state === "paused" ? "paused" : "active",
    revision,
    history: [...(prior?.history ?? []), { revision, state: prior?.state === "paused" ? "paused" : "active", text: text.trim(), at: Date.now() }],
  };
  rt.goal = goal;
  return goal;
}

export function updateGoalState(sid: string, state: SessionGoalState): SessionGoal | null {
  const rt = getRuntime(sid);
  if (!rt.goal) return null;
  const revision = rt.goal.revision + 1;
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

export function upsertSubagent(sid: string, input: { id: string; task: string; status: string; cli?: string | null; model?: string | null; durationMs?: number | null; tokens?: number | null; output?: string | null; parentId?: string | null }) {
  const rt = getRuntime(sid);
  const status = input.status === "failed" ? "失败" : input.status === "done" || input.status === "success" || input.status === "completed" ? "成功" : input.status === "stopped" ? "已停止" : input.status === "running" ? "运行中" : "待确认";
  const prior = rt.subagents.find(a => a.id === input.id);
  const now = Date.now();
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
    startedAt: prior?.startedAt ?? now,
    endedAt: status === "运行中" || status === "待确认" ? prior?.endedAt : prior?.endedAt ?? now,
  };
  if (prior) Object.assign(prior, row); else rt.subagents.push(row);
  if (status === "运行中" || status === "待确认") {
    const task = rt.tasks.find(t => t.agentId === input.id);
    if (task) task.state = status === "运行中" ? "running" : "awaiting_user";
  }
  return row;
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
    rt.modelMs += Math.max(0, total - rt.turnToolMs);
    rt.timingKnown = true;
    rt.streamStart = null;
  }
}

/* ---------- 步骤：真实工具执行记录（不伪造） ---------- */

export function recordToolUse(sid: string, toolId: string, name: string) {
  const rt = getRuntime(sid);
  if (rt.stepsDemo) rt.steps = [];
  rt.stepsDemo = false;
  if (rt.toolStart.has(toolId)) return;
  rt.toolStart.set(toolId, Date.now());
  rt.steps.push({ id: `ST-${rt.generation}-${toolId}`, title: name, state: "running" });
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
    title: p.name || "来源调用未记录",
    state: p.completed ? (p.isError ? "failed" : "done") : "todo",
    meta: p.completed ? (p.isError ? "失败" : undefined) : "结果未返回",
  }));
}

/* ---------- 合成演示（仅演示会话；显式 seed，不自动出现） ---------- */

const DEMO_SUBAGENTS: SubagentRow[] = [
  { id: "SA-1", cli: "claude", title: "检索登录模块鉴权实现", model: "deepseek-v4.1", duration: "1m12s", tokens: "8.6k", status: "成功" },
  { id: "SA-2", cli: "codex", title: "复现并缩小失败用例", model: "gpt-5.2", duration: "2m31s", tokens: "12.4k", status: "待确认" },
  { id: "SA-3", cli: "claude", title: "汇总测试覆盖缺口", model: "deepseek-v4.1", duration: "48s", tokens: "5.1k", status: "成功" },
  { id: "SA-4", cli: "grok", title: "起草修复方案对比", model: "grok-4", duration: "1m47s", tokens: "9.9k", status: "失败" },
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
  rt.usageKnown = true;
  rt.cacheKnown = true;
}

/** 落库消息为整会话权威值；历史未上报的缓存/耗时保持未知。 */
export function hydrateUsage(sid: string, input: number, output: number, known: boolean, cache?: number) {
  const rt = getRuntime(sid);
  if (rt.active) return;
  rt.tokensIn = input;
  rt.tokensOut = output;
  rt.usageKnown = known;
  if (cache !== undefined) { rt.cacheRead = cache; rt.cacheKnown = true; }
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
