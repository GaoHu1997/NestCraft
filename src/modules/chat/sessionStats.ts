/** FEAT-012：只投影权威闭合步骤，不把消息、工具或 CLI done 当成 DSH 步骤。 */
export const SESSION_STATS_SCHEMA = "dsh.closed-steps.v1";

export type SessionStatsScope = "session" | "window" | "partial" | "unknown";
export interface SessionStatsProjection {
  rounds: number | null;
  steps: number | null;
  scope: SessionStatsScope;
  source: string;
}
export interface SessionStatsOptions {
  sessionId?: string | null;
  /** 默认只保证已载入窗口；全量必须由调用方确认完整覆盖，不能从消息数推断。 */
  scope?: "session" | "window";
  complete?: boolean;
}

const outcomes = new Set(["completed", "failed", "cancelled", "max_tokens"]);
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const identity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;

function metadata(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try { return record(JSON.parse(value)); } catch { return null; }
}

/**
 * 支持两种明确输入：
 * 1. {type:"step/end", sessionId, turnId, stepId, outcome}；
 * 2. 消息 metaJson.sessionStats = {schema:SESSION_STATS_SCHEMA, source:"dsh",
 *    sessionId, closedSteps:[{type:"step/end", turnId, stepId, outcome}]}。
 * sessionId 可继承记录或调用方会话身份；显式冲突/非法身份不接纳。
 * 空 closedSteps 标记可声明窗口内确有零闭合步骤；无标记保持未知。
 * 元信息批次仅保证窗口覆盖，不采信其中的全量/snapshot 声明。
 * 不支持仅 rounds/steps 数字的 snapshot，也不读取 content 等消息正文。
 */
export function projectSessionStats(
  rows: readonly unknown[], options: SessionStatsOptions = {},
): SessionStatsProjection {
  const steps = new Set<string>();
  const turns = new Set<string>();
  let known = false;
  let windowOnly = false;
  const session = (value: unknown, inherited: unknown): string | null => {
    const id = value === undefined ? inherited : value;
    return identity(id) && (options.sessionId == null || id === options.sessionId) ? id : null;
  };
  const addClosed = (value: unknown, owner: string | null): boolean => {
    const step = record(value);
    if (!step || step.type !== "step/end" || !identity(step.turnId) || !identity(step.stepId)
      || typeof step.outcome !== "string" || !outcomes.has(step.outcome)) return false;
    const sid = session(step.sessionId, owner);
    if (!sid || (owner !== null && sid !== owner)) return false;
    steps.add(JSON.stringify([sid, step.turnId, step.stepId]));
    turns.add(JSON.stringify([sid, step.turnId]));
    known = true;
    return true;
  };

  for (const value of rows) {
    const row = record(value);
    if (!row) continue;
    const owner = session(row.sessionId, options.sessionId);
    // 显式的错误会话身份不能通过嵌套元信息绕过隔离。
    if (row.sessionId !== undefined && owner === null) continue;
    const accepted = addClosed(row, owner);
    if (row.type === "step/end" && (!accepted || row.scope === "window")) windowOnly = true;
    const marker = record(metadata(row.metaJson)?.sessionStats);
    if (!marker || marker.schema !== SESSION_STATS_SCHEMA
      || !(marker.source === "dsh" || (marker.source === "platform" && marker.rule === "dsh"))
      || !Array.isArray(marker.closedSteps)) continue;
    const markerOwner = session(marker.sessionId, owner);
    if (!markerOwner || (owner !== null && markerOwner !== owner)) continue;
    windowOnly = true;
    // 数字 snapshot 或非法/open 事件不能把未知变成已知零。
    if (marker.closedSteps.length === 0) known = true;
    for (const step of marker.closedSteps) addClosed(step, markerOwner);
  }

  if (!known) return {
    rounds: null, steps: null, scope: "unknown",
    source: "未上报权威闭合步骤边界；轮次和步数未知",
  };
  const scope = options.scope === "session" && options.complete === true && !windowOnly ? "session" : "window";
  return {
    rounds: turns.size, steps: steps.size, scope,
    source: scope === "session" ? "DSH 闭合步骤；完整会话覆盖"
      : "DSH 闭合步骤；仅已载入窗口，非全会话累计",
  };
}

export interface PersistentSessionStats extends SessionStatsProjection {
  sessionId: string;
  modelMs: number | null;
  ttftMs: number | null;
  tps: number | null;
}

/** 只读统计API的版本化完整性声明；旧/CLI不报闭合，不能从消息数补齐。 */
export function parseSessionStatsSnapshot(value: unknown, sessionId: string): PersistentSessionStats | null {
  const v = record(value);
  const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const measure = (n: unknown): n is number | null => n === null || (typeof n === "number" && Number.isFinite(n) && n >= 0);
  if (!v || v.schema !== "dsh.session-stats.snapshot.v1" || v.rule !== "dsh" || v.sessionId !== sessionId
    || !count(v.observedTurns) || !count(v.unobservedTurns) || typeof v.complete !== "boolean"
    || !measure(v.modelMs) || !measure(v.ttftMs) || !measure(v.tps)) return null;
  if (v.scope === "unknown") {
    if (v.source !== "unknown" || v.complete || v.observedTurns !== 0 || v.rounds !== null || v.steps !== null
      || v.modelMs !== null || v.ttftMs !== null || v.tps !== null) return null;
  } else {
    if (v.source !== "platform" || v.observedTurns === 0 || !count(v.rounds) || !count(v.steps)
      || v.rounds > v.observedTurns || v.steps < v.rounds || (v.rounds === 0 && v.steps !== 0)) return null;
    if (v.scope === "session") {if (!v.complete || v.unobservedTurns !== 0) return null;}
    else if (v.scope === "partial") {if (v.complete || v.modelMs !== null) return null;}
    else return null;
  }
  return {
    sessionId, rounds: v.rounds as number | null, steps: v.steps as number | null,
    scope: v.scope as SessionStatsScope, modelMs: v.modelMs, ttftMs: v.ttftMs, tps: v.tps,
    source: v.scope === "unknown" ? "当前通道未上报权威闭合步骤边界；轮次和步数未知"
      : v.scope === "session" ? "平台生成步骤（按 DSH 规则）；整会话完整覆盖"
        : `平台生成步骤（按 DSH 规则）；仅已记录部分，${v.unobservedTurns} 个未观测轮或本轮尚未结束`,
  };
}
