import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { Empty } from "@/components/ui";
import {
  MINDMAP_CHILD_KIND, layoutMindmap, mindmapChildren, mindmapKindLabel, mindmapSource,
  type MindmapSourceNode,
} from "./requirementMindmap";
import type { ReadingSource } from "./requirementSources";
import type { DesignModel } from "./requirementModels";

/** UI-CR073：拖拽判定位移阈值（像素）。 */
const PAN_THRESHOLD = 4;

/** UI-CR066：标准层级思维导图面板。
 *  整块为画布 + 右侧面板；层级 Vision → Epic → Feature → Story，模型为独立分支。
 *  左侧「导图目录」与画布同源；节点可直接新增下级；折叠控件在连线连接处，悬浮才显示。
 *  UI-CR073：画布支持空白处拖拽平移与 Ctrl/⌘ + 滚轮缩放；右侧面板改为可编辑表单，
 *  新建下级复用同一面板（不弹窗）。 */

interface MindmapPaneProps {
  sources: ReadingSource[];
  models: DesignModel[];
  vision: ReadingSource | null;
  zoom: number;
  collapsed: Set<string>;
  selectedId: string | null;
  onZoom: (next: number) => void;
  onToggleFold: (id: string) => void;
  onSelect: (id: string) => void;
  onCloseDetail: () => void;
  onAddChild: (source: ReadingSource) => void;
  onOpenDoc: (source: ReadingSource) => void;
  onOpenModel: (model: DesignModel) => void;
  /** ratio=1 表示重置为 100%；ratio=0 表示按画布可用区域适应窗口。 */
  onFit: (ratio: number) => void;
  /** CR-073：右侧面板内的就地编辑（不弹窗）。 */
  onEditNode?: (source: ReadingSource) => void;
  /** CR-073：面板内保存后的重新扫描。 */
  onReload?: () => void;
  /** CR-073：进入"新建下级"草稿后，由外层提供的面板内容（新建态）。 */
  createPanel?: React.ReactNode;
  /** CR-073：编辑态面板内容（由外层提供，内部含表单与保存）。 */
  editPanel?: React.ReactNode;
  /** CR-073：是否处于新建草稿态（画布显示占位节点）。 */
  creating?: { parentId: string; kind: string; title: string } | null;
}

export function RequirementMindmapPane(props: MindmapPaneProps) {
  const { sources, models, vision, zoom, collapsed, selectedId } = props;
  const canvasRef = useRef<HTMLDivElement>(null);
  const [locate, setLocate] = useState<string | null>(null);
  /* 画布滚动位置按项目保留；切换阅读方式回来时回到原处。 */
  const scrollRef = useRef<[number, number]>([0, 0]);

  const nodes = useMemo<MindmapSourceNode[]>(() => mindmapSource(sources, models), [sources, models]);
  const byId = useMemo(() => new Map(sources.map(source => [source.entityId ?? source.key, source])), [sources]);
  const modelById = useMemo(() => new Map(models.map(model => [model.id, model])), [models]);
  const modelIds = useMemo(() => new Set(models.map(model => model.id)), [models]);

  const layout = useMemo(() => {
    if (!vision) return null;
    const rootId = vision.entityId ?? vision.key;
    return layoutMindmap(
      { id: rootId, kind: vision.kind, title: vision.title },
      nodes,
      collapsed,
    );
  }, [vision, nodes, collapsed]);

  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const selectedVisible = selected && layout?.nodes.some(node => node.id === selectedId) ? selected : null;
  /* 模型节点不在需求源集合里，单独取；模型被折叠隐藏时不显示详情。 */
  const selectedModel = selectedId && !selected && modelIds.has(selectedId)
    && layout?.nodes.some(node => node.id === selectedId) ? modelById.get(selectedId) ?? null : null;

  // 目录与画布同源：折叠状态共享，点击目录即选中并定位画布节点。
  const outline = useMemo(() => {
    if (!vision) return [];
    const rootId = vision.entityId ?? vision.key;
    const rows: { id: string; kind: string; title: string; depth: number }[] = [];
    const walk = (id: string, depth: number) => {
      const source = byId.get(id);
      const model = modelById.get(id);
      if (!source && !model) return;
      rows.push({ id, kind: source?.kind ?? "model", title: source?.title ?? model!.title, depth });
      mindmapChildren(nodes, { id, kind: source?.kind ?? "model" })
        .filter(child => !collapsed.has(id))
        .forEach(child => walk(child.id, depth + 1));
    };
    walk(rootId, 0);
    return rows;
  }, [vision, byId, modelById, nodes, collapsed]);

  useEffect(() => {
    if (!locate) return;
    const canvas = canvasRef.current;
    const target = canvas?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(locate)}"]`);
    if (!canvas || !target) return;
    const scale = zoom || 1;
    canvas.scrollTo({
      left: Math.max(0, target.offsetLeft * scale - canvas.clientWidth / 2 + target.offsetWidth * scale / 2),
      top: Math.max(0, target.offsetTop * scale - canvas.clientHeight / 2 + target.offsetHeight * scale / 2),
    });
    setLocate(null);
  }, [locate, zoom]);

  /* 恢复上次滚动位置（首次渲染不覆盖默认位置）。 */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.scrollLeft = scrollRef.current[0];
    canvas.scrollTop = scrollRef.current[1];
  }, []);

  /* UI-CR073：画布拖拽平移。只在空白处（未命中节点、折叠点、面板）开始；
     位移小于 PAN_THRESHOLD 视为点击，平移结束后抑制一次点击，避免误选节点。 */
  const panRef = useRef<{ id: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const [panning, setPanning] = useState(false);
  const onCanvasPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest(".req-map-node, .req-map-foldpoint, .req-map-detail, .req-map-controls, a, input, textarea, select")) return;
    const canvas = event.currentTarget;
    panRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: canvas.scrollLeft, top: canvas.scrollTop, moved: false };
    canvas.setPointerCapture?.(event.pointerId);
  };
  const onCanvasPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.id !== event.pointerId) return;
    const dx = event.clientX - pan.x, dy = event.clientY - pan.y;
    if (!pan.moved && Math.abs(dx) < PAN_THRESHOLD && Math.abs(dy) < PAN_THRESHOLD) return;
    const canvas = event.currentTarget;
    if (!pan.moved) { pan.moved = true; setPanning(true); }
    canvas.scrollLeft = pan.left - dx;
    canvas.scrollTop = pan.top - dy;
    scrollRef.current = [canvas.scrollLeft, canvas.scrollTop];
  };
  const onCanvasPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    const canvas = event.currentTarget;
    if (pan && pan.moved) {
      /* UI-CR073：只抑制「平移结束随即产生」的那一次点击，避免误选节点；
         不能用常驻 once 监听，否则会吞掉用户稍后的正常点击。 */
      const swallow = (e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); };
      canvas.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => canvas.removeEventListener("click", swallow, { capture: true }), 0);
    }
    try { if (pan && canvas.hasPointerCapture?.(pan.id)) canvas.releasePointerCapture(pan.id); } catch { /* 已释放 */ }
    panRef.current = null;
    setPanning(false);
  };
  /* UI-CR073：Ctrl／⌘ + 滚轮以画布中心为锚点缩放；不按修饰键保持原生滚动。 */
  const onCanvasWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const delta = event.deltaY > 0 ? -0.1 : 0.1;
    const next = Math.max(0.5, Math.min(1.8, Math.round((zoom + delta) * 10) / 10));
    if (next !== zoom) props.onZoom(next);
  };

  if (!vision || !layout) {
    return <section className="req-map-area"><div className="req-map-controls"><b>思维导图</b></div>
      <Empty title="愿景源未提供" desc="项目没有可识别的真实愿景文件，无法绘制 Vision → Epic → Feature → Story 层级；不会用项目名称合成愿景关系。" /></section>;
  }

  const scaledWidth = Math.round(layout.width * zoom), scaledHeight = Math.round(layout.height * zoom);

  /* 适应窗口：按画布可用区域计算缩放比例，保证整图可见。 */
  const fitToView = () => {
    const canvas = canvasRef.current;
    if (!canvas || !layout.width || !layout.height) return;
    const availableW = canvas.clientWidth - 48, availableH = canvas.clientHeight - 48;
    if (availableW <= 0 || availableH <= 0) return;
    const ratio = Math.min(1, availableW / layout.width, availableH / layout.height);
    props.onFit(Math.max(0.4, Math.round(ratio * 20) / 20));
  };

  return <>
    <aside className="req-map-outline-pane req-tree-pane">
      <div className="req-tree-head"><b className="head-title">导图目录</b></div>
      <div className="req-tree-scroll req-map-outline" role="tree" aria-label="思维导图目录">
        {outline.map(row => <div key={row.id} className={`req-tree-row ${selectedId === row.id ? " on" : ""}`} style={{ "--req-depth": row.depth } as React.CSSProperties} role="treeitem" aria-selected={selectedId === row.id}>
          <span className="req-tree-caret" />
          <button className="req-tree-open" onClick={() => { props.onSelect(row.id); setLocate(row.id); }} title={`${row.id} ${row.title}`}>
            <span className={`req-kind ${row.kind}`}>{mindmapKindLabel(row.kind)}</span>
            <span className="ellipsis">{row.title}</span>
            <small>{row.id}</small>
          </button>
        </div>)}
      </div>
    </aside>
    <section className="req-map-area" data-mode="map">
      <div className="req-map-controls">
        <b>思维导图</b>
        <button className="btn sm" aria-label="缩小" onClick={() => props.onZoom(Math.max(.5, Math.round((zoom - .1) * 10) / 10))}>−</button>
        <span className="req-map-zoom">{Math.round(zoom * 100)}%</span>
        <button className="btn sm" aria-label="放大" onClick={() => props.onZoom(Math.min(1.8, Math.round((zoom + .1) * 10) / 10))}>+</button>
        <button className="btn sm" onClick={() => props.onFit(1)}>重置</button>
        <button className="btn sm" onClick={fitToView}>适应窗口</button>
        <button className="btn sm" onClick={() => props.onToggleFold("__all__")}>全部展开</button>
        <span className="spacer" />
        <span className="caption">空白处拖动平移 · Ctrl+滚轮缩放</span>
        <button className="btn sm" onClick={() => { const source = byId.get(vision.entityId ?? vision.key); if (source) props.onAddChild(source); }}><Icon name="plus" size={14} />新增 Epic</button>
      </div>
      <div className="req-map-stage">
        <div ref={canvasRef}
          className={`req-map-scroll${panning ? " is-panning" : ""}`}
          onScroll={event => { const el = event.currentTarget; scrollRef.current = [el.scrollLeft, el.scrollTop]; }}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
          onPointerCancel={onCanvasPointerUp}
          onWheel={onCanvasWheel}>
          <div className="req-map-scaled" style={{ width: scaledWidth, height: scaledHeight }}>
            <div className="req-map-inner" style={{ width: layout.width, height: layout.height }}>
              <svg className="req-map-edges" width={layout.width} height={layout.height} aria-hidden="true">
                {layout.edges.map(edge => <path key={`${edge.from}->${edge.to}`} className={edge.dashed ? "req-map-edge dashed" : "req-map-edge"} d={edge.d} />)}
              </svg>
              {layout.nodes.map(node => {
                const source = byId.get(node.id);
                const model = modelById.get(node.id);
                const childKind = MINDMAP_CHILD_KIND[node.kind];
                const hasKids = mindmapChildren(nodes, { id: node.id, kind: node.kind }).length > 0;
                const shut = collapsed.has(node.id);
                const on = selectedId === node.id;
                return <div key={node.id} className={`req-map-node ${node.kind}${on ? " on" : ""}${node.broken ? " broken" : ""}`}
                  data-node-id={node.id}
                  style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
                  tabIndex={0} role="treeitem" aria-selected={on}
                  aria-label={`${mindmapKindLabel(node.kind)} ${node.id} ${node.title}`}>
                  <button className="req-map-node-hit" onClick={() => props.onSelect(node.id)}>
                    <small>{mindmapKindLabel(node.kind)}{node.id ? ` · ${node.id}` : ""}</small>
                    <b>{node.title}</b>
                  </button>
                  <span className="req-map-node-tools">
                    {childKind && source && <button aria-label={`在${node.title}下新增${mindmapKindLabel(childKind)}`} title={`新增${mindmapKindLabel(childKind)}`} onClick={() => props.onAddChild(source)}><Icon name="plus" size={14} /></button>}
                    {source && <button aria-label={`在文档中打开${node.title}`} title="在文档中打开" onClick={() => props.onOpenDoc(source)}><Icon name="fileText" size={14} /></button>}
                    {model && <button aria-label={`打开模型文档${node.title}`} title="打开模型文档" onClick={() => props.onOpenModel(model)}><Icon name="database" size={14} /></button>}
                  </span>
                </div>;
              })}
              {/* UI-CR073：新建下级草稿——画布先出现虚线占位节点（不落盘）。 */}
              {props.creating && (() => {
                const parent = layout.nodes.find(node => node.id === props.creating!.parentId);
                if (!parent) return null;
                return <div className="req-map-node req-map-draft" data-draft-kind={props.creating.kind}
                  style={{ left: parent.x + parent.width + 58, top: parent.y + parent.height + 16, width: 200, height: 46 }}
                  aria-label={`新建${mindmapKindLabel(props.creating.kind)}占位`}>
                  <span className="req-map-draft-tag">未保存</span>
                  <span className="req-map-node-hit"><small>{mindmapKindLabel(props.creating.kind)} · 新建</small><b>{props.creating.title || "填写标题后保存"}</b></span>
                </div>;
              })()}
              {/* UI-CR066 r2：折叠控件落在父子连线的连接处，悬浮才显示，避免与新增图标冲突。 */}
              {layout.nodes.map(node => {
                if (!mindmapChildren(nodes, { id: node.id, kind: node.kind }).length) return null;
                const shut = collapsed.has(node.id);
                return <button key={`fold-${node.id}`} className="req-map-foldpoint" data-for={node.id} aria-expanded={!shut}
                  aria-label={`${shut ? "展开" : "折叠"}${node.title}的子级`} title={shut ? "展开子级" : "折叠子级"}
                  style={{ left: node.x + node.width, top: node.y + node.height / 2 }}
                  onClick={() => props.onToggleFold(node.id)}>
                  <Icon name={shut ? "plus" : "minimize"} size={12} />
                </button>;
              })}
            </div>
          </div>
        </div>
        {/* UI-CR073：右侧面板改为可编辑——新建草稿用外层提供的表单，编辑用外层表单，否则给出编辑入口。 */}
        {props.creating
          ? props.createPanel
          : props.editPanel
            ? props.editPanel
            : selectedVisible && (() => {
              return <aside className="req-map-detail req-map-editor" role="dialog" aria-label={`${selectedVisible.title}编辑`}>
                <header className="req-map-detail-head">
                  <span className={`req-kind ${selectedVisible.kind}`}>{mindmapKindLabel(selectedVisible.kind)}</span>
                  <b>{selectedVisible.entityId ?? "文件"}</b>
                  <span className="caption">编辑</span>
                  <button className="icon-btn" aria-label="关闭面板" onClick={props.onCloseDetail}><Icon name="x" size={14} /></button>
                </header>
                <div className="req-map-detail-scroll">
                  <h3>{selectedVisible.title}</h3>
                  <dl className="req-map-detail-meta">
                    <dt>状态</dt><dd>{selectedVisible.node?.status ?? "未登记状态"}</dd>
                    <dt>负责人</dt><dd>{selectedVisible.node?.owner ?? "未提供"}</dd>
                    <dt>来源</dt><dd className="req-map-detail-uri">{selectedVisible.sourceUri}</dd>
                  </dl>
                  <p className="req-map-detail-summary muted">点下方「编辑」在此直接修改标题、状态、负责人、摘要、工作量、验收条目与正文；保存写回项目源文档，不弹窗。</p>
                </div>
                <footer className="req-map-detail-foot">
                  <button className="btn sm primary" onClick={() => props.onEditNode?.(selectedVisible)}><Icon name="edit" size={14} />编辑</button>
                  <button className="btn sm" onClick={() => props.onOpenDoc(selectedVisible)}><Icon name="fileText" size={14} />文档</button>
                </footer>
              </aside>;
            })()}
        {!props.creating && !props.editPanel && selectedModel && <aside className="req-map-detail" role="dialog" aria-label={`${selectedModel.title}详情`}>
          <header className="req-map-detail-head">
            <span className="req-kind model">模型</span>
            <b>{selectedModel.id}</b>
            <button className="icon-btn" aria-label="关闭详情" onClick={props.onCloseDetail}><Icon name="x" size={14} /></button>
          </header>
          <div className="req-map-detail-scroll">
            <h3>{selectedModel.title}</h3>
            <dl className="req-map-detail-meta">
              <dt>类型</dt><dd>数据库／领域设计模型</dd>
              <dt>关联</dt><dd>项目级独立分支，不作为 Story 的第二父项</dd>
              <dt>来源</dt><dd className="req-map-detail-uri">{selectedModel.relPath}</dd>
            </dl>
            <p className="req-map-detail-summary muted">模型正文在「设计 → 数据库」页签阅读；此处只读展示身份与来源，不解析表结构、不执行迁移。</p>
          </div>
          <footer className="req-map-detail-foot">
            <button className="btn sm" onClick={() => props.onOpenModel(selectedModel)}><Icon name="database" size={14} />打开模型文档</button>
          </footer>
        </aside>}
      </div>
      <div className="req-map-help">整块为思维导图：Vision 连接 Epic、Epic 连接 Feature、Feature 连接 Story，模型为 Vision 下的独立分支（虚线关联）；点击节点在右侧面板直接编辑，左侧「导图目录」可定位节点，节点上可直接新增下级（同样在右侧面板填写）。</div>
    </section>
  </>;
}

