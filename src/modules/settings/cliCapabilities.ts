/** CR-099 / FEAT-015：逐 CLI 权限能力。档位与该 CLI 真实可表达的启动参数一一对应（见
 *  `chat.rs::spawn_cli`），白名单在 `chat.rs::validate_permission` 同批放开，
 *  界面不再出现「未核验」灰项——不可用的档位直接不出现。 */
export type PermissionId = "default" | "plan" | "agent" | "auto" | "full";
export interface CliPermissionOption { id: PermissionId; name: string; desc: string; enabled: boolean; risk?: boolean }

export function permissionOptions(cliId: string | null | undefined): CliPermissionOption[] {
  // Grok 走无头通道，没有原生计划与自动审核，只给三档。
  if (cliId === "grok") return [
    { id: "default", name: "默认模式", desc: "逐次确认每次操作。", enabled: true },
    { id: "agent", name: "代理模式", desc: "按会话允许范围执行，不逐次确认。", enabled: true },
    { id: "full", name: "完全访问", desc: "跳过审批，全部允许；仅在已核验隔离环境使用。", enabled: true, risk: true },
  ];
  const known = cliId === "claude" || cliId === "codex";
  if (!known) return [];
  return [
    { id: "default", name: "默认模式", desc: cliId === "claude" ? "保留原生逐次审批。" : "请求原生审批，工作区可写。", enabled: true },
    { id: "plan", name: "规划模式", desc: cliId === "claude" ? "只读规划，不落盘修改。" : "只读执行边界，不落盘修改。", enabled: true },
    { id: "agent", name: "代理模式", desc: cliId === "claude" ? "自动接受文件编辑，其他操作仍审批。" : "保留工作区沙箱，不逐次请求审批。", enabled: true },
    { id: "auto", name: "自动审核", desc: "由原生审核通道判定审批请求，保留安全边界。", enabled: true },
    { id: "full", name: "完全访问", desc: "跳过权限检查与沙箱；仅在已核验隔离环境使用。", enabled: true, risk: true },
  ];
}
export function permissionSupported(cliId?: string | null): boolean { return permissionOptions(cliId).some(p => p.enabled); }
