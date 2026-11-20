/** 预置项目按受信 ID/容器路径识别；同名用户项目不得自动载入。 */
import * as api from "@/api";
import { loadSample } from "./office-samples";
import type { SampleKind } from "./office-samples";
import { isLoaded } from "./office-model";

const SEED_FLAG = "office.demo.seeded";
const ID_FLAG = "office.demo.projectIds";
const DEMOS: { name: string; kind: SampleKind; originalId: string }[] = [
  { name: "市场研究资料", kind: "research", originalId: "PRJ-1018" },
  { name: "品牌与官网", kind: "brand", originalId: "PRJ-1009" },
];
const trustedIds = new Map<string, SampleKind>();
let pending: Promise<void> | null = null;
let completed = false;
const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export function isOfficeDemoProject(project: Pick<api.Project, "id" | "kind" | "name" | "rootUri">): boolean {
  if (project.kind !== "work") return false;
  return trustedIds.has(project.id) || DEMOS.some(d => d.originalId === project.id && d.name === project.name);
}
export function ensureOfficeProjectSample(project: Pick<api.Project, "id" | "kind" | "name" | "rootUri">): boolean {
  if (!isOfficeDemoProject(project) || isLoaded(project.id)) return false;
  const kind = trustedIds.get(project.id) ?? DEMOS.find(d => d.originalId === project.id)?.kind;
  return kind ? loadSample(project.id, kind) : false;
}

export function ensureOfficeDemoProjects(): Promise<void> {
  if (completed) return Promise.resolve();
  if (pending) return pending;
  pending = seed().then(() => { completed = true; }).finally(() => { pending = null; });
  return pending;
}

async function seed(): Promise<void> {
  const [flag, ids, list] = await Promise.all([api.getSetting(SEED_FLAG), api.getSetting(ID_FLAG), api.listProjects()]);
  let stored: Record<string, SampleKind> = {};
  if (ids) {
    try {
      const value: unknown = JSON.parse(ids);
      if (value && typeof value === "object" && !Array.isArray(value)) for (const [id, kind] of Object.entries(value))
        if (kind === "research" || kind === "brand") stored[id] = kind;
    } catch { /* 旧标记损坏不按名称猜身份。 */ }
  }
  for (const p of list) {
    const original = DEMOS.find(d => d.originalId === p.id && d.name === p.name);
    if (p.kind === "work" && (stored[p.id] || original)) trustedIds.set(p.id, stored[p.id] ?? original!.kind);
  }
  for (const demo of DEMOS) {
    if (ids && flag) continue; // 已登记稳定 ID 后不再按名称/目录重认新项目。
    // 旧版本只记录 seeded 时间：复用受管容器的精确路径核查身份，不拿同名新项目冒充。
    const dir = await api.appDataEnsureDir(`office-demo/${demo.name}`);
    const existing = !ids ? list.find(p => p.kind === "work" && p.name === demo.name && normalizePath(p.rootUri) === normalizePath(dir)) : undefined;
    if (existing) trustedIds.set(existing.id, demo.kind);
    else if (!flag && !list.some(p => p.name === demo.name)) {
      const created = await api.createProject(demo.name, "work", dir);
      trustedIds.set(created.id, demo.kind);
    }
  }
  // 删除过的项目不复活；仅存稳定身份，绝不存正文或覆盖用户草稿。
  const record = Object.fromEntries(trustedIds);
  await api.setSetting(ID_FLAG, JSON.stringify(record));
  if (!flag) await api.setSetting(SEED_FLAG, new Date().toISOString());
  for (const p of await api.listProjects()) ensureOfficeProjectSample(p);
}
