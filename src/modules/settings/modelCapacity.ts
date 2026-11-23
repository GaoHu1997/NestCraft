/** CR-068：模型配置的纯逻辑（容量解析、全量档位映射编译、CLI 协议过滤）。
 *  不含 React 与后端依赖，便于在 Node 中做针对性单测。 */

/** 七档思考档位顺序（与 shared.ts 的 EFFORT_LEVELS 一致）。 */
export const EFFORT_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const CAPACITY_HINT = "支持 K/M（如 128K、1M），留空表示未知；小数结果须为正整数";

/** 容量文本 → 安全正整数；空文本为未知（null）；非法输入抛出可展示的错误。 */
export function parseCapacity(text: string | null | undefined): number | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const hit = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(raw);
  const multiplier = hit ? ({ k: 1000, m: 1000000 } as Record<string, number>)[hit[2].toLowerCase()] ?? 1 : NaN;
  const value = hit ? Number(hit[1]) * multiplier : NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("容量须为正整数，支持 K/M（如 128K、1M）；留空表示未知");
  }
  return value;
}

/** 容量校验：合法或未知返回 null，非法返回错误文案。 */
export function capacityError(text: string | null | undefined): string | null {
  try { parseCapacity(text); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

/** 已存数值 → 设计稿风格的紧凑文本（128K / 1M）；不可整除时保留原数。 */
export function formatCapacity(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "";
  if (n >= 1_000_000 && n % 100_000 === 0) return `${n / 1_000_000}M`;
  if (n < 1_000_000 && n % 100 === 0) return `${n / 1000}K`;
  return String(n);
}

/** 编辑态文本 → 列表展示；非法文本原样保留，避免悄悄丢掉用户输入。 */
export function capacityLabel(text: string | null | undefined): string {
  const raw = String(text ?? "").trim();
  if (!raw) return "—";
  try { return formatCapacity(parseCapacity(raw)); } catch { return raw; }
}

/** 只编译“已启用档位”的 wire 映射；未选档位即使编辑过映射也不下发。
 *  同名预填：映射留空/未编辑时使用档位名；显式清空则保留 null（有效档位但不下发参数）。 */
export function compileEffortMap(
  supported: Iterable<string>,
  mappings: Record<string, string | null | undefined>,
  order: readonly string[] = EFFORT_ORDER,
): Record<string, string | null> {
  const enabled = supported instanceof Set ? supported : new Set(supported);
  const out: Record<string, string | null> = {};
  for (const level of order) {
    if (!enabled.has(level)) continue;
    const mapping = mappings[level];
    const text = mapping === undefined || mapping === null ? level : mapping.trim();
    out[level] = text || null;
  }
  return out;
}

export type CliWireProtocol = "openai" | "anthropic";

/** 当前 CLI 可执行的协议；未知 CLI 不缩小范围（由后端按实际 combo 拒绝）。 */
export function protocolsForCli(cliId: string | null | undefined): CliWireProtocol[] {
  if (cliId === "claude") return ["anthropic"];
  if (cliId === "codex" || cliId === "grok") return ["openai"];
  return ["openai", "anthropic"];
}

/** 模型候选协议是否可被当前 CLI 消费；provider/model 选择保持稳定。 */
export function protocolAllowed(protocol: string | null | undefined, cliId: string | null | undefined): boolean {
  const normalized = String(protocol ?? "").toLowerCase();
  return protocolsForCli(cliId).includes(normalized as CliWireProtocol);
}
