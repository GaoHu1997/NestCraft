// CR-089 / FEAT-009: 知识图谱只读接口封装。
// 后端 kb_graph 只返回 id/label/path/kind/degree 与边，不含正文；本文件仅做类型与 invoke 透传。
import { invoke } from './index';

export interface GraphNode {
  id: string;
  label: string;
  path: string;
  /** note | attachment | missing */
  kind: 'note' | 'attachment' | 'missing';
  degree: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** 未解析边保留原始 [[...]]，其余为显示标签。 */
  label: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  noteId?: string | null;
  message?: string | null;
}

export interface GraphQuery {
  /** 局部图中心；为空或不传即整库总览。 */
  noteId?: string | null;
  /** 1..3，默认 1，后端会夹取。 */
  depth?: number;
  includeAttachments?: boolean;
  onlyUnresolved?: boolean;
}

export const kbGraph = (libraryId: string, query: GraphQuery = {}) =>
  invoke<GraphData>('kb_graph', {
    libraryId,
    noteId: query.noteId ?? null,
    depth: query.depth ?? null,
    includeAttachments: query.includeAttachments ?? null,
    onlyUnresolved: query.onlyUnresolved ?? null,
  });
