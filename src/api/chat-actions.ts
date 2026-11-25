/**
 * 聊天运行态横幅（待发命令恢复 / 配额 / 运行时退出）的 invoke 包装。
 *
 * 只读：调用后端 `chat_action_status`，不改变任何会话或运行状态。
 * invoke 复用 `@/api` 的统一入口（与 src/api/index.ts 一致），不修改该文件。
 */
import { invoke } from "@/api";

/** 配额视图；后端无真实配额数据源时整体为 null，前端不显示。 */
export interface ChatQuotaView {
  used: number | null;
  limit: number | null;
  label: string;
  detail: string | null;
}

/** 待发命令视图；后端无持久化队列来源时为空数组。 */
export interface ChatPendingCommandView {
  id: string;
  text: string;
  createdAt: number;
  source: string;
}

/** 运行时退出视图；无法确证进程异常退出时为 null。 */
export interface ChatRuntimeExitView {
  reason: string;
  detail: string;
  at: number;
}

/** 会话运行态横幅数据。 */
export interface ChatActionStatus {
  sessionId: string;
  updatedAt: number;
  /** 本进程内该会话是否有进行中的回合（真实内存状态）。 */
  running: boolean;
  quota: ChatQuotaView | null;
  runtimeExit: ChatRuntimeExitView | null;
  pendingCommands: ChatPendingCommandView[];
}

/**
 * 查询会话运行态横幅数据。空会话 ID 直接拒绝；返回值做字段归一化，避免后端字段缺失
 * 时把 undefined 当成有值。失败向上抛出，由调用方决定是否隐藏横幅，不伪造成功。
 */
export async function chatActionStatus(sessionId: string): Promise<ChatActionStatus> {
  const id = (sessionId ?? "").trim();
  if (!id) throw new Error("缺少会话 ID，无法查询运行状态");
  const raw = await invoke<ChatActionStatus>("chat_action_status", { sessionId: id });
  return {
    sessionId: raw?.sessionId ?? id,
    updatedAt: typeof raw?.updatedAt === "number" ? raw.updatedAt : 0,
    running: raw?.running === true,
    quota: raw?.quota ?? null,
    runtimeExit: raw?.runtimeExit ?? null,
    pendingCommands: Array.isArray(raw?.pendingCommands) ? raw.pendingCommands : [],
  };
}
