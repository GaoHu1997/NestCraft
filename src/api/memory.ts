import { invoke } from "./index";

/** CR-092 / FEAT-026：个人记忆 Tauri 命令。命令名与 LLD-FEAT-026 §4.3 对齐。 */

export type MemoryKind = "fact" | "preference" | "goal" | "event" | "decision" | "relation";
export type MemoryStatus = "active" | "superseded" | "deleted";

export interface MemoryItem {
  id: string;
  scope: string;
  kind: MemoryKind | string;
  memKey: string | null;
  content: string;
  sourceType: string;
  sourceRef: string | null;
  trust: string;
  importance: number;
  confidence: number;
  status: MemoryStatus | string;
  supersededBy: string | null;
  accessCount: number;
  lastAccessAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryProfile {
  scope: string;
  fieldsJson: string;
  summary: string;
  revision: number;
}

export interface MemoryStats {
  scope: string;
  total: number;
  active: number;
  superseded: number;
  deleted: number;
  external: number;
  byKind: Record<string, number>;
}

export interface MemoryListOptions {
  scope?: string | null;
  kind?: string | null;
  status?: string | null;
  limit?: number;
}

type RawRecord = Record<string, unknown>;

const asRecord = (value: unknown): RawRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RawRecord : {};

const asText = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : value === null || value === undefined ? fallback : String(value);

const asOptionalText = (value: unknown): string | null => {
  const text = asText(value).trim();
  return text ? text : null;
};

const asNumber = (value: unknown, fallback = 0): number => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const asOptionalNumber = (value: unknown): number | null => {
  const number = Number(value);
  return value === null || value === undefined || !Number.isFinite(number) ? null : number;
};

/** 兼容后端可能返回 camelCase 或数据库原列名，避免并行实现期间字段名漂移直接白屏。 */
function normalizeItem(value: unknown): MemoryItem {
  const item = asRecord(value);
  return {
    id: asText(item.id),
    scope: asText(item.scope, "global"),
    kind: asText(item.kind),
    memKey: asOptionalText(item.memKey ?? item.mem_key),
    content: asText(item.content),
    sourceType: asText(item.sourceType ?? item.source_type, "manual"),
    sourceRef: asOptionalText(item.sourceRef ?? item.source_ref),
    trust: asText(item.trust, "own"),
    importance: asNumber(item.importance, 3),
    confidence: asNumber(item.confidence, 0.7),
    status: asText(item.status, "active"),
    supersededBy: asOptionalText(item.supersededBy ?? item.superseded_by),
    accessCount: asNumber(item.accessCount ?? item.access_count),
    lastAccessAt: asOptionalNumber(item.lastAccessAt ?? item.last_access_at),
    createdAt: asNumber(item.createdAt ?? item.created_at),
    updatedAt: asNumber(item.updatedAt ?? item.updated_at),
  };
}

function normalizeList(value: unknown): MemoryItem[] {
  const rows = Array.isArray(value)
    ? value
    : (() => {
        const record = asRecord(value);
        const candidate = record.items ?? record.rows ?? record.list;
        return Array.isArray(candidate) ? candidate : [];
      })();
  return rows.map(normalizeItem).filter(item => item.id.length > 0);
}

/** 列表：scope 为空时由后端按默认范围处理；status 为空包含 active/superseded/deleted。 */
export const memoryListItems = async (options: MemoryListOptions = {}): Promise<MemoryItem[]> => {
  const raw = await invoke<unknown>("memory_list_items", {
    scope: options.scope ?? null,
    kind: options.kind ?? null,
    status: options.status ?? null,
    limit: options.limit ?? 500,
  });
  return normalizeList(raw);
};

export const memoryGetItem = async (id: string): Promise<MemoryItem | null> => {
  const raw = await invoke<unknown>("memory_get_item", { id });
  const item = normalizeItem(raw);
  return item.id ? item : null;
};

export const memoryUpdateItem = (id: string, content: string, importance?: number | null) =>
  invoke<void>("memory_update_item", { id, content, importance: importance ?? null });

/** hard=false 为软删（status=deleted）；hard=true 物理删除，界面必须二次确认。 */
export const memoryDeleteItem = (id: string, hard = false) =>
  invoke<void>("memory_delete_item", { id, hard });

export const memoryGetProfile = async (scope: string | null = null): Promise<MemoryProfile> => {
  const raw = await invoke<unknown>("memory_get_profile", { scope });
  const record = asRecord(raw);
  const profile = asRecord(record.profile ?? record);
  const rawFields = profile.fieldsJson ?? profile.fields_json;
  return {
    scope: asText(profile.scope, scope ?? "global"),
    fieldsJson: typeof rawFields === "string" ? rawFields : rawFields === null || rawFields === undefined ? "{}" : JSON.stringify(rawFields),
    summary: asText(profile.summary),
    revision: asNumber(profile.revision),
  };
};

export const memoryUpdateProfile = (scope: string | null, fieldsJson?: string | null, summary?: string | null) =>
  invoke<void>("memory_update_profile", {
    scope,
    fieldsJson: fieldsJson ?? null,
    summary: summary ?? null,
  });

export const memoryStats = async (scope: string | null = null): Promise<MemoryStats> => {
  const raw = await invoke<unknown>("memory_stats", { scope });
  const record = asRecord(raw);
  const stats = asRecord(record.stats ?? record);
  const rawKinds = asRecord(stats.byKind ?? stats.by_kind);
  const byKind: Record<string, number> = {};
  for (const [kind, count] of Object.entries(rawKinds)) {
    byKind[kind] = asNumber(count);
  }
  return {
    scope: asText(stats.scope, scope ?? "global"),
    total: asNumber(stats.total),
    active: asNumber(stats.active),
    superseded: asNumber(stats.superseded),
    deleted: asNumber(stats.deleted),
    external: asNumber(stats.external),
    byKind,
  };
};

/** 首启/修复内置个人记忆库登记。 */
export const memoryEnsureLibrary = () => invoke<unknown>("memory_ensure_library");

/** 手动沉淀指定会话。 */
export const memoryResedimentSession = (sessionId: string) =>
  invoke<unknown>("memory_resediment_session", { sessionId });
