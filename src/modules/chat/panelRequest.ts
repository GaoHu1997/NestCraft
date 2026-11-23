/**
 * CR-054 / STORY-073：AI 请求打开右侧辅助栏。
 *
 * 规则（CR-054 §6 已确认）：
 * 1. AI 只能“请求”，实际是否打开由前端决定；
 * 2. **不需要人工逐次确认**：符合规则时直接打开；
 * 3. 用户手动关闭后，同一轮不得自动重开抢焦点（运行态按轮次，非运行态按时间窗）；
 * 4. 非法或缺类型必须拒绝并返回可读原因码；
 * 5. 面板打开本身不构成任何权限（不写文件、不联网、不扩授权）。
 *
 * 本模块只维护请求通道与拒绝规则，不持有 UI 状态；UI 通过订阅者响应 opened。
 */

export type PanelKind = "ui-preview" | "browser" | "file" | "requirement" | "knowledge" | "office-file";

export interface PanelRequest {
  kind: PanelKind;
  /** 目标键：文件路径 / 实体 ID / 知识 noteId / 办公 fileId；ui-preview 与 browser 可省略。 */
  key?: string;
}

export type PanelResultCode = "opened" | "invalid_request" | "unsupported" | "declined_by_user";

export interface PanelResult {
  ok: boolean;
  code: PanelResultCode;
  message: string;
}

/** 受支持的面板类型；新增类型必须同时在此登记，否则返回 unsupported。 */
const SUPPORTED: Readonly<Record<PanelKind, string>> = {
  "ui-preview": "UI 预览",
  browser: "浏览器结果",
  file: "文件",
  requirement: "需求",
  knowledge: "知识",
  "office-file": "办公文件",
};

/** 用户关闭后的静默窗口（非运行态）；运行态按轮次判定。 */
const CLOSE_WINDOW_MS = 120_000;

interface GuardState {
  closedAt: number;
  turn: string | null;
}

const guards = new Map<string, GuardState>();
const listeners = new Set<(projectId: string, req: PanelRequest) => void>();

/** 标记用户主动关闭右栏；turn 为当前轮次标识（运行态），非运行态传 null。 */
export function markPanelClosedByUser(projectId: string, turn: string | null) {
  guards.set(projectId, { closedAt: Date.now(), turn });
}

/** 当前是否处于“用户刚关闭过、本轮不得重开”的状态。 */
export function isPanelClosedByUser(projectId: string, turn: string | null): boolean {
  const guard = guards.get(projectId);
  if (!guard || !guard.closedAt) return false;
  if (Date.now() - guard.closedAt >= CLOSE_WINDOW_MS) return false;
  return turn === null ? guard.turn === null : guard.turn === turn;
}

/** 用户重新打开面板时清除守卫，使后续 AI 请求可再次生效。 */
export function clearPanelGuard(projectId: string) {
  guards.delete(projectId);
}

/** 订阅“AI 请求已通过校验”的通知；返回取消订阅函数。 */
export function onPanelRequest(handler: (projectId: string, req: PanelRequest) => void): () => void {
  listeners.add(handler);
  return () => { listeners.delete(handler); };
}

/**
 * AI 侧调用入口。
 * @param projectId 当前项目；跨项目请求一律拒绝（面板只呈现本项目内容）。
 * @param req 请求的面板类型与目标
 * @param currentProjectId 调用方所在项目；与 projectId 不一致即视为跨项目
 * @param turn 当前轮次标识（运行态）；非运行态传 null
 */
export function requestPanel(
  projectId: string,
  req: PanelRequest | null | undefined,
  options: { currentProjectId?: string; turn?: string | null } = {},
): PanelResult {
  const turn = options.turn ?? null;
  if (!req || !req.kind) {
    return { ok: false, code: "invalid_request", message: "缺少面板类型" };
  }
  if (!Object.prototype.hasOwnProperty.call(SUPPORTED, req.kind)) {
    return { ok: false, code: "unsupported", message: `不支持的面板类型：${String(req.kind)}` };
  }
  if (options.currentProjectId && options.currentProjectId !== projectId) {
    return { ok: false, code: "unsupported", message: "跨项目面板请求已拒绝：面板只呈现本项目内容" };
  }
  if (isPanelClosedByUser(projectId, turn)) {
    return { ok: false, code: "declined_by_user", message: "用户已在本轮关闭该面板，不自动重开" };
  }
  listeners.forEach(handler => handler(projectId, req));
  return { ok: true, code: "opened", message: `已打开${SUPPORTED[req.kind]}面板` };
}

export const PANEL_LABELS = SUPPORTED;
