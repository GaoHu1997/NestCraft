/** 设置中心共享工具与常量（校验正则、档位表、错误提取与兜底）。 */

/** 后端 error → 可展示字符串（Tauri invoke 失败可能是 string 或 Error）。 */
export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

type Toast = (text: string, kind?: "info" | "warn" | "err") => void;

/** 包装一次异步操作：失败时统一 toast 后端错误字符串。 */
export async function guard(toast: Toast, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    toast(errMsg(e), "err");
  }
}

/** 思考档位七档（与后端 EffortMap 对应；null = 该档不下发参数）。 */
export const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 技能名：kebab-case（docs/tmp/ref-analysis-dsh-skill-mcp-panel.md 校验规则）。 */
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** MCP 服务器名（同上参考的 SERVER_NAME_RE 语义）。 */
export const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
