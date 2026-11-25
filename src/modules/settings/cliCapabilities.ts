/** CR-085 / FEAT-015：设置与AI侧栏同源的逐CLI权限能力；不扩大原生权限。 */
export type PermissionId = "default" | "plan" | "agent" | "auto" | "full";
export interface CliPermissionOption { id: PermissionId; name: string; desc: string; enabled: boolean }
export function permissionOptions(cliId: string | null | undefined): CliPermissionOption[] {
  if (cliId === "grok") return [
    { id: "default", name: "默认模式", desc: "Grok ACP 权限请求：审批桥未核验", enabled: false },
    { id: "agent", name: "代理模式", desc: "Grok ACP 允许范围：原生通道未核验", enabled: false },
    { id: "full", name: "完全访问", desc: "Grok always-approve：审批能力未核验", enabled: false },
  ];
  const known = cliId === "claude" || cliId === "codex";
  if (!known) return [];
  return [
    { id: "default", name: "默认模式", desc: cliId === "claude" ? "Claude default：保留原生逐次审批" : "Codex on-request + workspace-write：请求原生审批", enabled: true },
    { id: "plan", name: "规划模式", desc: cliId === "claude" ? "Claude plan：只读规划语义" : "Codex read-only + never：只读执行边界", enabled: true },
    { id: "agent", name: "代理模式", desc: cliId === "claude" ? "Claude acceptEdits：自动接受编辑" : "Codex workspace-write + never：保留工作区沙箱", enabled: true },
    { id: "auto", name: "自动审核", desc: "当前版本未核验原生审查通道", enabled: false },
    { id: "full", name: "完全访问", desc: "需要已核验隔离与托管策略", enabled: false },
  ];
}
export function permissionSupported(cliId?: string | null): boolean { return permissionOptions(cliId).some(p => p.enabled); }
