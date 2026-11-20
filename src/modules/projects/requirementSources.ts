import type { RequirementNode, RequirementSources } from "@/api";

/** CR-045: the manifest owns source completeness; the indexed tree only supplies known relationships. */
export interface ReadingSource {
  key: string;
  sourceUri: string;
  node: RequirementNode | null;
  title: string;
  kind: RequirementNode["kind"] | "file";
  entityId: string | null;
  error: string | null;
  warning: string | null;
}
export interface ReadingRow { source: ReadingSource; depth: number; parentKey: string | null }

export function normalizedSource(root: string, path: string): string {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/^\/\/?\?\//, "").replace(/\/$/, "");
  const base = normalize(root), value = normalize(path);
  return (value.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? value.slice(base.length + 1) : value).toLowerCase();
}
export function readingIdentity(projectId: string, root: string, sourceUri: string, kind: string, entityId: string | null): string {
  return JSON.stringify([projectId, normalizedSource("", root), kind, entityId, normalizedSource(root, sourceUri)]);
}
export function flattenRequirements(nodes: RequirementNode[]): RequirementNode[] {
  const out: RequirementNode[] = [], seen = new Set<RequirementNode>();
  const visit = (node: RequirementNode) => {
    if (seen.has(node)) return;
    seen.add(node); out.push(node); node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return out;
}
export function mergeRequirementSources(projectId: string, root: string, tree: RequirementNode[], manifest: RequirementSources | null): ReadingSource[] {
  const indexed = flattenRequirements(tree);
  const byPath = new Map(indexed.map(node => [normalizedSource(root, node.sourceUri), node]));
  const seen = new Set<string>();
  const sources: ReadingSource[] = [];
  const add = (sourceUri: string, manifestNode: RequirementNode | null, error: string | null, warning: string | null) => {
    const path = normalizedSource(root, sourceUri);
    if (seen.has(path)) return;
    seen.add(path);
    const known = byPath.get(path);
    // A manifest's file-only entry must not be silently promoted to a fabricated entity.
    const node = manifestNode ? { ...manifestNode, ...(known ? { parentId: known.parentId, children: known.children } : {}) } : null;
    const kind = node?.kind ?? "file", entityId = node?.entityId ?? null;
    sources.push({ key: readingIdentity(projectId, root, sourceUri, kind, entityId), sourceUri, node, kind, entityId,
      title: node?.title || sourceUri.replace(/\\/g, "/").split("/").pop() || sourceUri, error, warning });
  };
  manifest?.sources.forEach(source => add(source.sourceUri, source.node, source.error, source.warning));
  indexed.forEach(node => {
    if (!seen.has(normalizedSource(root, node.sourceUri))) add(node.sourceUri, node, null, manifest ? "索引中的源未列入本次清单；请刷新核验。" : "完整源清单不可用；此处仅为索引中的已知文档，不代表项目全文完整。");
  });
  return sources;
}

/** Every source appears once, including ambiguous parents, orphaned documents and cycles. */
export function orderReadingSources(sources: ReadingSource[]): ReadingRow[] {
  const byId = new Map<string, ReadingSource[]>();
  sources.forEach(source => { if (source.entityId) byId.set(source.entityId, [...(byId.get(source.entityId) ?? []), source]); });
  const parents = new Map<string, string | null>();
  const vision = sources.find(source => source.kind === "vision");
  for (const source of sources) {
    const candidates = source.node?.parentId ? byId.get(source.node.parentId) ?? [] : [];
    const parent = candidates.length === 1 && candidates[0].key !== source.key ? candidates[0] : null;
    parents.set(source.key, parent?.key ?? (vision && source.kind === "epic" && !source.node?.parentId ? vision.key : null));
  }
  const children = new Map<string, ReadingSource[]>();
  sources.forEach(source => {
    const parent = parents.get(source.key);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), source]);
  });
  const seen = new Set<string>(), rows: ReadingRow[] = [];
  const walk = (source: ReadingSource, depth: number, parentKey: string | null) => {
    if (seen.has(source.key)) return;
    seen.add(source.key); rows.push({ source, depth, parentKey });
    children.get(source.key)?.forEach(child => walk(child, depth + 1, source.key));
  };
  sources.filter(source => source.kind === "vision").forEach(source => walk(source, 0, null));
  sources.filter(source => !parents.get(source.key)).forEach(source => walk(source, 0, null));
  sources.forEach(source => walk(source, 0, null));
  return rows;
}

export function closeReadingTab(tabs: string[], active: string | null, key: string, fallback: string | null): { tabs: string[]; active: string | null } {
  const index = tabs.indexOf(key);
  if (index < 0) return { tabs, active };
  const next = tabs.filter(tab => tab !== key);
  if (!next.length) return { tabs: fallback ? [fallback] : [], active: fallback };
  return { tabs: next, active: active === key ? next[Math.max(0, index - 1)] : active };
}

export function splitReadingFrontMatter(markdown: string): { metadata: string; body: string } {
  const match = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(markdown);
  return match ? { metadata: match[0], body: markdown.slice(match[0].length) } : { metadata: "", body: markdown };
}
