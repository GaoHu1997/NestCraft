/**
 * CR-085 / FEAT-015：SDK 操作任务追踪与最近五次操作记录。
 *
 * 设计要点（UI-CR085-v1 AC-STORY-077-CR085-04～06）：
 * - 任务一旦发起即进入「全程锁」：只有后端 job 到达终态才释放，不用固定超时或
 *   `null` 记录当成完成；记录查询失败时保持跟踪并继续轮询，不释放锁。
 * - 追踪器是模块级单例，设置中心关闭/组件卸载后继续轮询，重开后立即恢复显示。
 * - 最近五次操作写入 setting（不含凭证、只保留脱敏日志），关闭重开仍可查看。
 * - 刷新（检测＋版本）作为瞬时操作同样入账，失败明确入账且保留上一次成功值。
 *
 * 本模块只做状态编排，不发起真实安装：真正的 job 由后端 `sdk_run_job` 创建。
 */
import * as api from "@/api";
import type { SdkJob } from "@/api";
import { errMsg } from "./shared";

export type SdkAction = "install" | "uninstall" | "refresh";
export type SdkOperationStatus = "running" | "success" | "error";

export interface SdkOperation {
  id: string;
  sdkId: string;
  action: SdkAction;
  /** 目标版本；uninstall/refresh 为 null。 */
  target: string | null;
  /** 后端任务 id；仅 install/uninstall 有值。 */
  jobId: string | null;
  at: number;
  updatedAt: number;
  status: SdkOperationStatus;
  logs: string[];
  error: string | null;
}

export interface SdkTrackerSnapshot {
  /** sdkId → 正在跟踪的任务（job 为后端最新快照，可能短暂为 null）。 */
  tracking: Record<string, { jobId: string; job: SdkJob | null }>;
  operations: SdkOperation[];
}

export const SDK_HISTORY_KEY = "sdk.operationHistory.cr085";
export const SDK_HISTORY_MAX = 5;
const TERMINAL = new Set<string>(["done", "failed", "cancelled", "timeout"]);
const POLL_MS = 1500;
const LOG_LIMIT = 400;

const ACTION_LABEL: Record<SdkAction, string> = { install: "安装", uninstall: "卸载", refresh: "刷新" };
export const actionLabel = (action: SdkAction) => ACTION_LABEL[action] ?? action;

interface Tracked { jobId: string; opId: string; job: SdkJob | null; startedAt: number }

const tracked = new Map<string, Tracked>();
let operations: SdkOperation[] = [];
let timer: number | null = null;
let polling = false;
let hydrated = false;
let hydrateTask: Promise<void> | null = null;
let serial = 0;
const listeners = new Set<(snapshot: SdkTrackerSnapshot) => void>();
const completions = new Set<(sdkId: string) => void>();

function logSlice(logs: string[] | undefined): string[] {
  return (logs ?? []).slice(-LOG_LIMIT).map(line => String(line).replace(/\b(sk-[A-Za-z0-9_-]{6,}|npm_[A-Za-z0-9]{6,})\b/g, "***"));
}

function sanitizeOperation(raw: unknown): SdkOperation | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const action = value.action;
  if (action !== "install" && action !== "uninstall" && action !== "refresh") return null;
  const status = value.status;
  if (status !== "running" && status !== "success" && status !== "error") return null;
  const id = typeof value.id === "string" ? value.id : "";
  const sdkId = typeof value.sdkId === "string" ? value.sdkId : "";
  if (!id || !sdkId) return null;
  return {
    id, sdkId, action,
    target: typeof value.target === "string" ? value.target : null,
    jobId: typeof value.jobId === "string" ? value.jobId : null,
    at: typeof value.at === "number" ? value.at : Date.now(),
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
    status,
    logs: Array.isArray(value.logs) ? logSlice(value.logs.filter((line): line is string => typeof line === "string")) : [],
    error: typeof value.error === "string" ? value.error : null,
  };
}

function snapshot(): SdkTrackerSnapshot {
  const tracking: SdkTrackerSnapshot["tracking"] = {};
  for (const [sdkId, entry] of tracked) tracking[sdkId] = { jobId: entry.jobId, job: entry.job };
  return { tracking, operations: operations.map(item => ({ ...item, logs: [...item.logs] })) };
}

function emit(): void {
  const value = snapshot();
  for (const listener of [...listeners]) {
    try { listener(value); } catch { /* A failing subscriber must not break tracking. */ }
  }
}

function trim(): void {
  operations = operations
    .slice()
    .sort((a, b) => b.at - a.at)
    .slice(0, SDK_HISTORY_MAX);
}

async function persist(): Promise<void> {
  trim();
  try { await api.setSetting(SDK_HISTORY_KEY, JSON.stringify(operations)); }
  catch { /* 持久化失败不影响内存中的本轮记录与锁。 */ }
}

function startPolling(): void {
  if (timer != null) return;
  timer = window.setInterval(() => { void poll(); }, POLL_MS);
}

function stopPolling(): void {
  if (timer == null) return;
  window.clearInterval(timer);
  timer = null;
}

async function poll(): Promise<void> {
  if (polling || !tracked.size) return;
  polling = true;
  let changed = false;
  try {
    for (const [sdkId, entry] of [...tracked]) {
      let job: SdkJob | null;
      try { job = await api.sdkJob(entry.jobId); }
      // 记录暂时不可用：保持跟踪与锁，下一轮继续，不当作完成。
      catch { continue; }
      entry.job = job;
      const operation = operations.find(item => item.id === entry.opId);
      if (operation && job?.logs) {
        operation.logs = logSlice(job.logs);
        operation.updatedAt = Date.now();
        changed = true;
      }
      if (job && TERMINAL.has(job.phase)) {
        tracked.delete(sdkId);
        if (operation) {
          operation.status = job.phase === "done" ? "success" : "error";
          operation.error = job.phase === "done" ? null : (job.error || `任务${job.phase}`);
          operation.logs = logSlice(job.logs);
          operation.updatedAt = Date.now();
        }
        changed = true;
        for (const listener of [...completions]) {
          try { listener(sdkId); } catch { /* isolate */ }
        }
      }
    }
  } finally {
    polling = false;
    if (!tracked.size) stopPolling();
    if (changed) await persist();
    emit();
  }
}

export function subscribe(listener: (snapshot: SdkTrackerSnapshot) => void): () => void {
  listeners.add(listener);
  listener(snapshot());
  return () => { listeners.delete(listener); };
}

/** 任务到达终态（成功或失败）时通知；用于刷新该 SDK 的真实检测结果。 */
export function onOperationSettled(listener: (sdkId: string) => void): () => void {
  completions.add(listener);
  return () => { completions.delete(listener); };
}

/** 读取持久化记录并恢复未完成任务的跟踪；幂等。 */
export function hydrate(): Promise<void> {
  if (hydrateTask) return hydrateTask;
  hydrateTask = (async () => {
    if (!hydrated) {
      hydrated = true;
      try {
        const raw = await api.getSetting(SDK_HISTORY_KEY);
        if (raw) {
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) operations = parsed.map(sanitizeOperation).filter((item): item is SdkOperation => item !== null);
        }
      } catch { operations = []; }
      trim();
      // 上次关闭时仍在运行的任务：恢复跟踪，等后端终态。
      for (const operation of operations) {
        if (operation.status === "running" && operation.jobId && !tracked.has(operation.sdkId)) {
          tracked.set(operation.sdkId, { jobId: operation.jobId, opId: operation.id, job: null, startedAt: operation.at });
        }
      }
      if (tracked.size) startPolling();
    }
    emit();
  })();
  return hydrateTask;
}

function createOperation(sdkId: string, action: SdkAction, target: string | null, jobId: string | null): SdkOperation {
  const operation: SdkOperation = {
    id: `sdkop-${Date.now()}-${++serial}`,
    sdkId, action, target, jobId,
    at: Date.now(), updatedAt: Date.now(),
    status: jobId ? "running" : "success",
    logs: [], error: null,
  };
  // 同一 SDK 只保留最新一条进行中记录，历史压缩到 5 条。
  operations = [operation, ...operations.filter(item => !(item.sdkId === sdkId && item.status === "running"))];
  trim();
  return operation;
}

/** 登记一个已创建的后端任务并开始全程跟踪。 */
export async function trackJob(sdkId: string, jobId: string, action: "install" | "uninstall", target: string | null): Promise<void> {
  await hydrate();
  const operation = createOperation(sdkId, action, target, jobId);
  tracked.set(sdkId, { jobId, opId: operation.id, job: null, startedAt: Date.now() });
  startPolling();
  await persist();
  emit();
}

/** 瞬时操作（刷新/检测）入账；成功或失败都留记录。 */
export async function recordInstant(sdkId: string, action: SdkAction, error?: string): Promise<void> {
  await hydrate();
  const operation = createOperation(sdkId, action, null, null);
  operation.status = error ? "error" : "success";
  operation.error = error ?? null;
  operation.updatedAt = Date.now();
  await persist();
  emit();
}

/** 把一次进行中的瞬时操作写回结果（用于刷新开始时先入账 running）。 */
export async function beginInstant(sdkId: string, action: SdkAction): Promise<string> {
  await hydrate();
  const operation = createOperation(sdkId, action, null, null);
  operation.status = "running";
  await persist();
  emit();
  return operation.id;
}

export async function finishInstant(id: string, error?: string): Promise<void> {
  const operation = operations.find(item => item.id === id);
  if (!operation) return;
  operation.status = error ? "error" : "success";
  operation.error = error ?? null;
  operation.updatedAt = Date.now();
  await persist();
  emit();
}

/** 当前被锁定的 SDK（有进行中任务）。 */
export function isBusy(sdkId: string): boolean {
  return tracked.has(sdkId);
}

export function busyJob(sdkId: string): SdkJob | null {
  return tracked.get(sdkId)?.job ?? null;
}

/** 用户显式停止跟踪：仅解除本地锁，不伪造后端终态，并保留可见记录。 */
export async function stopTracking(sdkId: string): Promise<void> {
  const entry = tracked.get(sdkId);
  if (!entry) return;
  tracked.delete(sdkId);
  const operation = operations.find(item => item.id === entry.opId);
  if (operation) {
    operation.status = "error";
    operation.error = "已停止跟踪本地任务状态；后端任务可能仍在执行，请重新检测确认";
    operation.updatedAt = Date.now();
  }
  if (!tracked.size) stopPolling();
  await persist();
  emit();
}

export function operationsOf(sdkId: string): SdkOperation[] {
  return operations.filter(item => item.sdkId === sdkId);
}

export { errMsg };