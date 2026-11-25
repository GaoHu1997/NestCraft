import type { SessionTaskState } from "./sessionRuntime";

export interface PlanItem {
  id: string;
  text: string;
  state: SessionTaskState;
}

export interface SessionPlan {
  tasks: Map<string, PlanItem>;
  todos: PlanItem[];
  pending: Map<string, { name: string; input: string | null }>;
  seen: Set<string>;
}

export const emptyPlan = (): SessionPlan => ({ tasks: new Map(), todos: [], pending: new Map(), seen: new Set() });

export type PlanEvent =
  | { type: "turn" }
  | { type: "toolUse"; toolId: string; name: string | null; inputJson: string | null }
  | { type: "toolResult"; toolId: string; content: string; isError: boolean }
  | { type: "planUpdate"; items: unknown };

/** Replay and live updates advance the same ordered projection. */
export function projectPlan(plan: SessionPlan, event: PlanEvent) {
  switch (event.type) {
    case "turn":
      plan.pending.clear();
      plan.seen.clear();
      break;
    case "planUpdate":
      replaceTodos(plan, event.items);
      break;
    case "toolUse":
      if (event.name && isPlanTool(event.name) && !plan.seen.has(event.toolId)) {
        plan.seen.add(event.toolId);
        plan.pending.set(event.toolId, { name: event.name, input: event.inputJson });
      }
      break;
    case "toolResult": {
      const call = plan.pending.get(event.toolId);
      plan.pending.delete(event.toolId);
      plan.seen.add(event.toolId);
      if (call && !event.isError) applyPlanTool(plan, call.name, call.input, event.content);
      break;
    }
  }
}

const planTools = new Set(["TaskCreate", "TaskUpdate", "TodoWrite"]);
export const isPlanTool = (name: string | null | undefined) => !!name && planTools.has(name);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parse(value: string | null | undefined): unknown {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

function status(value: unknown): SessionTaskState | undefined {
  switch (value) {
    case "pending": case "completed": case "failed": case "cancelled": case "awaiting_user": return value;
    case "running": case "in_progress": return "running";
    default: return undefined;
  }
}

function taskId(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

function createdTaskId(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const block of value) {
      const id = createdTaskId(block);
      if (id) return id;
    }
    return null;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (text.startsWith("{") || text.startsWith("[") || text.startsWith('"')) return createdTaskId(parse(text));
    return /^Task #([^\s:]+) created successfully(?:\b|$)/m.exec(text)?.[1] ?? null;
  }
  const result = record(value);
  if (!result || result.success === false || result.isError === true) return null;
  return taskId(result.taskId ?? record(result.task)?.id) ?? createdTaskId(result.text ?? result.content);
}

/** A complete list replaces the previous one, including an explicitly empty list. */
export function replaceTodos(plan: SessionPlan, value: unknown) {
  if (!Array.isArray(value)) return;
  const todos: PlanItem[] = [];
  for (const [index, item] of value.entries()) {
    const data = record(item);
    const text = data?.text ?? data?.content;
    const state = status(data?.status) ?? (data?.completed === true ? "completed" : data?.completed === false ? "pending" : undefined);
    if (typeof text !== "string" || !text.trim() || !state) return;
    todos.push({ id: `todo:${index}`, text: text.trim(), state });
  }
  plan.todos = todos;
}

export function applyPlanTool(plan: SessionPlan, name: string, inputJson: string | null, output: string) {
  const input = record(parse(inputJson));
  if (!input) return;
  switch (name) {
    case "TodoWrite":
      replaceTodos(plan, input.todos);
      break;
    case "TaskCreate": {
      const id = createdTaskId(output);
      const text = typeof input.subject === "string" ? input.subject.trim() : "";
      if (!id || !text || plan.tasks.has(id)) return;
      plan.tasks.set(id, { id: `task:${id}`, text, state: "pending" });
      break;
    }
    case "TaskUpdate": {
      const id = taskId(input.taskId);
      const task = id && plan.tasks.get(id);
      if (!id || !task) return;
      if (input.status === "deleted") { plan.tasks.delete(id); return; }
      const text = typeof input.subject === "string" ? input.subject.trim() : "";
      plan.tasks.set(id, { ...task, text: text || task.text, state: status(input.status) ?? task.state });
      break;
    }
  }
}
