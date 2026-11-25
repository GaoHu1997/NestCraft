// CR-089 / FEAT-009：知识图谱组件（局部/整库），轻量力导向 canvas，无新增依赖；只读投影，仅回调 onOpen/onExpand。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { kbGraph, type GraphData, type GraphNode, type GraphQuery } from '../../api/knowledge-graph';
import './knowledge-graph.css';

export interface KnowledgeGraphProps {
  libraryId: string;
  noteId?: string | null;
  /** local=以当前笔记为中心；all=整库总览。 */
  mode?: 'local' | 'all';
  onOpen?: (noteId: string, path: string) => void;
  onExpand?: (noteId: string) => void;
  loader?: (libraryId: string, query: GraphQuery) => Promise<GraphData>;
  fixture?: GraphData;
  fixtureError?: string;
  /** 测试辅助：注入后暴露节点屏幕坐标与选择/展开方法，不影响生产交互。 */
  testApiRef?: { current: (id: string) => { x: number; y: number } | null } | null;
}
type Status = 'loading' | 'ready' | 'error';
interface SimNode extends GraphNode { x: number; y: number; vx: number; vy: number; }
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3;
const emptyMessage = '还没有链接关系';
function radius(kind: GraphNode['kind']) { return kind === 'note' ? 16 : kind === 'attachment' ? 11 : 9; }

export function KnowledgeGraph(props: KnowledgeGraphProps) {
  const { libraryId, noteId = null, onOpen, onExpand } = props;
  const [mode, setMode] = useState<'local' | 'all'>(props.mode ?? (noteId ? 'local' : 'all'));
  const [depth, setDepth] = useState(1);
  const [includeAttachments, setIncludeAttachments] = useState(false);
  const [onlyUnresolved, setOnlyUnresolved] = useState(false);
  const [status, setStatus] = useState<Status>(props.fixture || props.fixtureError ? (props.fixtureError ? 'error' : 'ready') : 'loading');
  const [data, setData] = useState<GraphData | null>(props.fixture ?? null);
  const [errorText, setErrorText] = useState(props.fixtureError ?? '');
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<{ label: string; x: number; y: number } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const view = useRef({ zoom: 1, ox: 0, oy: 0 });
  const sim = useRef<{ nodes: SimNode[]; raf: number; dragNode: string | null; panning: boolean; lastX: number; lastY: number }>(
    { nodes: [], raf: 0, dragNode: null, panning: false, lastX: 0, lastY: 0 });

  // —— 数据加载 ——
  useEffect(() => {
    if (props.fixture) { setData(props.fixture); setStatus('ready'); return; }
    if (props.fixtureError) { setErrorText(props.fixtureError); setStatus('error'); return; }
    let alive = true;
    setStatus('loading');
    const loader = props.loader ?? kbGraph;
    const query: GraphQuery = { noteId: mode === 'local' ? noteId : null, depth, includeAttachments, onlyUnresolved };
    loader(libraryId, query)
      .then((d) => { if (alive) { setData(d); setStatus('ready'); } })
      .catch((e) => { if (alive) { setErrorText(String(e?.message ?? e)); setStatus('error'); } });
    return () => { alive = false; };
  }, [libraryId, mode, noteId, depth, includeAttachments, onlyUnresolved, reloadKey, props.fixture, props.fixtureError, props.loader]);

  const neighbors = useMemo(() => {
    const map = new Map<string, Set<string>>();
    (data?.edges ?? []).forEach((e) => {
      if (!map.has(e.source)) map.set(e.source, new Set());
      if (!map.has(e.target)) map.set(e.target, new Set());
      map.get(e.source)!.add(e.target); map.get(e.target)!.add(e.source);
    });
    return map;
  }, [data]);

  // —— 初始化物理节点 ——
  useEffect(() => {
    const nodes: SimNode[] = (data?.nodes ?? []).map((n, i) => {
      const angle = (i / Math.max(1, data?.nodes.length ?? 1)) * Math.PI * 2;
      const r = 120 + (i % 5) * 18;
      return { ...n, x: Math.cos(angle) * r, y: Math.sin(angle) * r, vx: 0, vy: 0 };
    });
    sim.current.nodes = nodes;
    view.current = { zoom: 1, ox: 0, oy: 0 };
    setSelected(null);
  }, [data]);

  const toScreen = (x: number, y: number, w: number, h: number) => ({
    x: w / 2 + (x + view.current.ox) * view.current.zoom, y: h / 2 + (y + view.current.oy) * view.current.zoom });

  // —— 渲染与物理循环 ——
  useEffect(() => {
    const canvas = canvasRef.current; const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(r.width * dpr));
      canvas.height = Math.max(1, Math.floor(r.height * dpr));
      canvas.style.width = `${r.width}px`; canvas.style.height = `${r.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(wrap);

    const css = getComputedStyle(wrap);
    const v = (name: string, fb: string) => css.getPropertyValue(name).trim() || fb;
    const colNote = v('--primary', '#2b6cf6'), colAtt = v('--warning', '#b76a00');
    const colMissing = v('--danger', '#d93b3b'), colLine = v('--line', '#e6e8eb');
    const colInk = v('--ink', '#1f2329'), colBg = v('--surface', '#ffffff');

    const tick = () => {
      const nodes = sim.current.nodes;
      const edges = data?.edges ?? [];
      // 斥力 + 弹簧 + 向心 + 阻尼
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          const d2 = dx * dx + dy * dy || 0.01;
          const f = 4200 / d2, d = Math.sqrt(d2);
          dx /= d; dy /= d;
          a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
        }
      }
      const byId = new Map(nodes.map((n) => [n.id, n]));
      edges.forEach((e) => {
        const a = byId.get(e.source), b = byId.get(e.target);
        if (!a || !b) return;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d - 110) * 0.02;
        a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      });
      nodes.forEach((n) => {
        n.vx -= n.x * 0.008; n.vy -= n.y * 0.008; // 向心
        n.vx *= 0.86; n.vy *= 0.86; // 阻尼
        if (sim.current.dragNode !== n.id) { n.x += n.vx; n.y += n.vy; }
      });
      draw();
      sim.current.raf = requestAnimationFrame(tick);
    };

    const draw = () => {
      const w = canvas.clientWidth || 1; const h = canvas.clientHeight || 1;
      ctx.clearRect(0, 0, w, h);
      const edges = data?.edges ?? [];
      const byId = new Map(sim.current.nodes.map((n) => [n.id, n]));
      ctx.lineWidth = 1;
      edges.forEach((e) => {
        const a = byId.get(e.source), b = byId.get(e.target);
        if (!a || !b) return;
        const p = toScreen(a.x, a.y, w, h); const q = toScreen(b.x, b.y, w, h);
        const un = a.kind === 'missing' || b.kind === 'missing';
        ctx.strokeStyle = un ? colMissing : colLine;
        ctx.setLineDash(un ? [4, 4] : []);
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      });
      ctx.setLineDash([]);
      sim.current.nodes.forEach((n) => {
        const p = toScreen(n.x, n.y, w, h);
        const r = radius(n.kind) * view.current.zoom;
        const active = !selected || selected === n.id || neighbors.get(selected)?.has(n.id);
        ctx.globalAlpha = active ? 1 : 0.28;
        const fill = n.kind === 'note' ? colNote : n.kind === 'attachment' ? colAtt : colBg;
        ctx.strokeStyle = n.kind === 'missing' ? colMissing : n.kind === 'attachment' ? colAtt : colNote;
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (n.kind === 'attachment') ctx.rect(p.x - r, p.y - r, r * 2, r * 2);
        else ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        if (n.kind === 'note') { ctx.fillStyle = fill; ctx.fill(); }
        else if (n.kind === 'attachment') { ctx.fillStyle = colBg; ctx.fill(); }
        ctx.setLineDash(n.kind === 'missing' ? [3, 3] : []);
        ctx.stroke(); ctx.setLineDash([]);
        if (selected === n.id) {
          ctx.beginPath(); ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
          ctx.strokeStyle = colInk; ctx.lineWidth = 1.5; ctx.stroke();
        }
        // 标签：整库节点多时仅选中/邻接显示，避免糊屏
        const showLabel = view.current.zoom >= 1.2 || selected === n.id || (selected && neighbors.get(selected)?.has(n.id)) || sim.current.nodes.length <= 24;
        if (showLabel && n.kind !== 'missing') {
          ctx.globalAlpha = active ? 0.9 : 0.3;
          ctx.fillStyle = colInk; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center';
          ctx.fillText(n.label, p.x, p.y + r + 12, 120);
        }
        ctx.globalAlpha = 1;
      });
    };

    const hit = (mx: number, my: number) => {
      const w = canvas.clientWidth || 1; const h = canvas.clientHeight || 1;
      for (let i = sim.current.nodes.length - 1; i >= 0; i--) {
        const n = sim.current.nodes[i];
        const p = toScreen(n.x, n.y, w, h);
        const r = radius(n.kind) * view.current.zoom + 3;
        if ((mx - p.x) ** 2 + (my - p.y) ** 2 <= r * r) return n;
      }
      return null;
    };

    const onDown = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect(); const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      const n = hit(mx, my);
      if (n) { sim.current.dragNode = n.id; setSelected(n.id); }
      else { sim.current.panning = true; sim.current.dragNode = null; setSelected(null); }
      sim.current.lastX = mx; sim.current.lastY = my;
      canvas.style.cursor = n ? 'grabbing' : 'move';
    };
    const onMove = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect(); const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      if (sim.current.dragNode) {
        const n = sim.current.nodes.find((x) => x.id === sim.current.dragNode);
        if (n) { n.x += (mx - sim.current.lastX) / view.current.zoom; n.y += (my - sim.current.lastY) / view.current.zoom; n.vx = n.vy = 0; }
        sim.current.lastX = mx; sim.current.lastY = my; return;
      }
      if (sim.current.panning) {
        view.current.ox += (mx - sim.current.lastX) / view.current.zoom;
        view.current.oy += (my - sim.current.lastY) / view.current.zoom;
        sim.current.lastX = mx; sim.current.lastY = my; return;
      }
      const n = hit(mx, my);
      setHover(n ? { label: n.label, x: mx, y: my } : null);
      canvas.style.cursor = n ? 'pointer' : 'grab';
    };
    const onUp = () => { sim.current.dragNode = null; sim.current.panning = false; canvas.style.cursor = 'grab'; };
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect(); const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      const w = canvas.clientWidth || 1; const h = canvas.clientHeight || 1;
      const before = ((mx - w / 2) / view.current.zoom - view.current.ox);
      const beforeY = ((my - h / 2) / view.current.zoom - view.current.oy);
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.current.zoom * (ev.deltaY < 0 ? 1.12 : 0.89)));
      view.current.zoom = next;
      view.current.ox = (mx - w / 2) / next - before;
      view.current.oy = (my - h / 2) / next - beforeY;
    };
    const onDbl = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect(); const n = hit(ev.clientX - rect.left, ev.clientY - rect.top);
      if (n && n.kind !== 'missing' && onExpand) onExpand(n.id);
    };

    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDbl);
    if (props.testApiRef) {
      props.testApiRef.current = (id: string) => {
        const n = sim.current.nodes.find((x) => x.id === id); if (!n) return null;
        const r = canvas.getBoundingClientRect();
        const p = toScreen(n.x, n.y, canvas.clientWidth || 1, canvas.clientHeight || 1);
        return { x: r.left + p.x, y: r.top + p.y };
      };
    }
    sim.current.raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(sim.current.raf);
      ro.disconnect();
      canvas.removeEventListener('mousedown', onDown);
      canvas.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDbl);
    };
  }, [data, selected, neighbors, onExpand]);

  const openSelected = useCallback(() => {
    const n = sim.current.nodes.find((x) => x.id === selected);
    if (n && n.kind !== 'missing' && onOpen) onOpen(n.id, n.path);
  }, [selected, onOpen]);

  const hasData = status === 'ready' && data && data.nodes.length > 0;

  return (
    <div className="kg-root" ref={wrapRef} data-status={status} data-selected={selected ?? ''} data-node-count={data?.nodes.length ?? 0} data-edge-count={data?.edges.length ?? 0}>
      <div className="kg-toolbar" role="toolbar" aria-label="图谱筛选">
        <div className="kg-mode" role="tablist" aria-label="图谱范围">
          <button role="tab" aria-selected={mode === 'local'} disabled={!noteId} onClick={() => setMode('local')}>局部</button>
          <button role="tab" aria-selected={mode === 'all'} onClick={() => setMode('all')}>整库总览</button>
        </div>
        <span className="kg-sep" />
        <label className="kg-depth">深度
          <select aria-label="邻居深度" value={depth} onChange={(e) => setDepth(Number(e.target.value))}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select>
        </label>
        <label className="kg-check"><input type="checkbox" checked={includeAttachments} onChange={(e) => setIncludeAttachments(e.target.checked)} />含附件</label>
        <label className="kg-check"><input type="checkbox" checked={onlyUnresolved} onChange={(e) => setOnlyUnresolved(e.target.checked)} />只看未解析</label>
        <span className="kg-spacer" />
        <button className="kg-open" disabled={!selected || sim.current.nodes.find((n) => n.id === selected)?.kind === 'missing'} onClick={openSelected}>打开</button>
      </div>

      {status === 'loading' && <div className="kg-skeleton" role="status" aria-label="加载中"><span /><span /><span /></div>}
      {status === 'error' && <div className="kg-error" role="alert"><p>图谱加载失败</p><p className="kg-error-text">{errorText}</p><button onClick={() => setReloadKey((k) => k + 1)}>重试</button></div>}
      {status === 'ready' && data && data.nodes.length === 0 && <div className="kg-empty" role="status">{emptyMessage}</div>}
      {status === 'ready' && data && data.nodes.length > 0 && <>
        <canvas ref={canvasRef} className="kg-canvas" aria-label={`知识图谱，${data.nodes.length} 个节点，${data.edges.length} 条关系`} />
        {hover && <div className="kg-tip" style={{ left: hover.x + 12, top: hover.y + 12 }}>{hover.label}</div>}
        {data.truncated && <div className="kg-truncated" role="status">已截断：节点≤200、边≤400，仅显示部分结果</div>}
        {data.message && <div className="kg-notice" role="status">{data.message}</div>}
      </>}
    </div>
  );
}

export default KnowledgeGraph;
