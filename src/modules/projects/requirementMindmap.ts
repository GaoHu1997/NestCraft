import type { RequirementNode } from "@/api";
import type { ReadingSource } from "./requirementSources";
import type { DesignModel } from "./requirementModels";

/** UI-CR066：标准层级思维导图的布局与关系计算。
 *  层级固定为 Vision → Epic → Feature → Story/Bug；父在左、子在右，父节点垂直居中于其子树。
 *  本模块只做只读投影与几何计算，不写需求、不改父子关系。 */

export type MindmapKind = "vision" | "epic" | "feature" | "story" | "bug" | "model";

export interface MindmapNode {
  key: string;
  id: string;
  kind: MindmapKind;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  /** 父项编号缺失或不在集合内时为 true，表示关系待修复而非静默丢弃。 */
  broken: boolean;
}

export interface MindmapEdge { from: string; to: string; d: string; /** 模型关联是虚线，不是父子实线。 */ dashed?: boolean }

export interface MindmapLayout {
  nodes: MindmapNode[];
  edges: MindmapEdge[];
  width: number;
  height: number;
}

export const MINDMAP_H_GAP = 58;
export const MINDMAP_V_GAP = 16;
export const MINDMAP_NODE_HEIGHT = 46;

const KIND_ORDER: Record<string, number> = { vision: 0, epic: 1, feature: 2, story: 3, bug: 4, model: 5 };

/** 每个节点类型允许新增的直接下级；Story/Bug 没有下级。 */
export const MINDMAP_CHILD_KIND: Partial<Record<MindmapKind, MindmapKind>> = {
  vision: "epic", epic: "feature", feature: "story",
};

export function mindmapKindLabel(kind: string): string {
  return { vision: "Vision", epic: "Epic", feature: "Feature", story: "Story", bug: "Bug", model: "模型" }[kind] ?? kind;
}

/** 中文按全角、英文按半角估算像素宽；节点右侧还要放两个 22px 图标，一并计入。 */
export function mindmapNodeWidth(title: string): number {
  let width = 0;
  for (const ch of title || "") width += /[\u2E80-\u9FFF\uFF00-\uFFEF]/.test(ch) ? 13 : 7;
  return Math.round(Math.min(320, Math.max(200, width + 66 + 50)));
}

/** 收集一个节点的全部直接子项；折叠状态只影响渲染，不影响关系计算。 */
export function mindmapChildren(
  nodes: MindmapSourceNode[],
  node: { id: string; kind: string },
): MindmapSourceNode[] {
  const out = nodes.filter(candidate => candidate.id !== node.id && candidate.parentId === node.id);
  if (node.kind === "vision") {
    // 没有显式父项的条目仍挂在 Vision 下，避免丢失需求；但不会伪造父项文本。
    nodes.forEach(candidate => {
      if (candidate.id === node.id || candidate.kind === "vision") return;
      if (!candidate.parentId && !out.some(item => item.id === candidate.id)) out.push(candidate);
    });
    // 模型是项目级独立分支，与 Epic 平级挂在 Vision 下；不按名称猜关联、不成为 Story 父项。
    nodes.forEach(candidate => {
      if (candidate.kind !== "model") return;
      if (!out.some(item => item.id === candidate.id)) out.push(candidate);
    });
  }
  return out.sort((a, b) =>
    (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.id.localeCompare(b.id));
}

/** 层级布局：父在左、子在右；子节点纵向排开，父节点垂直居中于其子树。 */
export function layoutMindmap(
  root: { id: string; kind: string; title: string },
  nodes: MindmapSourceNode[],
  collapsed: Set<string>,
): MindmapLayout {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const placed: MindmapNode[] = [];
  const edges: MindmapEdge[] = [];
  const seen = new Set<string>();
  let cursor = 0;

  const place = (node: { id: string; kind: string; title: string; parentId?: string | null }, depth: number, x: number): MindmapNode | null => {
    if (seen.has(node.id)) return null;
    seen.add(node.id);
    const source = byId.get(node.id);
    const width = mindmapNodeWidth(node.title || node.id);
    const children = mindmapChildren(nodes, node as { id: string; kind: string })
      .filter(child => !collapsed.has(node.id));
    const childNodes: MindmapNode[] = [];
    children.forEach(child => {
      const result = place(child, depth + 1, x + width + MINDMAP_H_GAP);
      if (result) childNodes.push(result);
    });
    const y = childNodes.length
      ? (childNodes[0].y + childNodes[0].height / 2 + childNodes[childNodes.length - 1].y + childNodes[childNodes.length - 1].height / 2) / 2 - MINDMAP_NODE_HEIGHT / 2
      : (cursor += MINDMAP_NODE_HEIGHT + MINDMAP_V_GAP) - MINDMAP_NODE_HEIGHT - MINDMAP_V_GAP;
    if (!childNodes.length) cursor = y + MINDMAP_NODE_HEIGHT + MINDMAP_V_GAP;
    const entry: MindmapNode = {
      key: node.id, id: node.id, kind: node.kind as MindmapKind, title: node.title || node.id,
      x, y, width, height: MINDMAP_NODE_HEIGHT, depth,
      broken: node.kind !== "vision" && !!node.parentId && !byId.has(node.parentId),
    };
    placed.push(entry);
    /* 模型与 Vision 之间是关联线（虚线），不是父子实线。 */
    childNodes.forEach(child => edges.push({
      from: node.id, to: child.id, d: mindmapEdgePath(entry, child),
      dashed: child.kind === "model",
    }));
    return entry;
  };

  place({ ...root, parentId: null }, 0, 24);
  return {
    nodes: placed,
    edges,
    width: placed.reduce((max, node) => Math.max(max, node.x + node.width), 0) + 24,
    height: cursor + 24,
  };
}

/** 父右边缘到子左边缘的贝塞尔连线。 */
export function mindmapEdgePath(from: MindmapNode, to: MindmapNode): string {
  const x1 = from.x + from.width, y1 = from.y + from.height / 2;
  const x2 = to.x, y2 = to.y + to.height / 2;
  const bend = Math.max(24, (x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

/** 把需求源摊平为导图可用的集合（Vision 在前，其余按已解析的父子关系）。 */
export function mindmapSource(sources: ReadingSource[], models: DesignModel[] = []): MindmapSourceNode[] {
  const nodes: MindmapSourceNode[] = sources.map(source => ({
    id: source.entityId ?? source.key,
    kind: source.kind,
    parentId: source.node?.parentId ?? null,
    title: source.title,
  }));
  /* 模型作为项目级独立分支加入集合；不与需求条目混为一谈，也不覆盖同名需求条目。 */
  models.forEach(model => {
    if (nodes.some(node => node.id === model.id)) return;
    nodes.push({ id: model.id, kind: "model", parentId: null, title: model.title });
  });
  return nodes;
}

/** 导图集合中的最小形状：只依赖 id/kind/parentId/title，避免与 API 类型耦合。 */
export interface MindmapSourceNode {
  id: string;
  kind: MindmapKind | "file";
  parentId: string | null;
  title: string;
}

/** 需求树（含 Vision 根）投影为导图集合；用于正式软件的树形数据。 */
export function mindmapSourceFromTree(tree: RequirementNode[]): MindmapSourceNode[] {
  const out: MindmapSourceNode[] = [];
  const seen = new Set<string>();
  const visit = (node: RequirementNode) => {
    if (seen.has(node.entityId)) return;
    seen.add(node.entityId);
    out.push({ id: node.entityId, kind: node.kind, parentId: node.parentId, title: node.title });
    node.children.forEach(visit);
  };
  tree.forEach(visit);
  return out;
}
