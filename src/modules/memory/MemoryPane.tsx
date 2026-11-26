import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { memoryStats, memoryEnsureLibrary } from "@/api/memory";
import { listProjects } from "@/api";
import type { MemoryStats } from "@/api/memory";
import { MemoryList } from "./MemoryList";
import { MemoryProfile } from "./MemoryProfile";
import "@/theme/memory.css";

const KIND_LABELS: Record<string, string> = {
  fact: "事实",
  preference: "偏好",
  goal: "目标",
  event: "事件",
  decision: "决策",
  relation: "关系",
};

const KIND_ORDER = ["fact", "preference", "goal", "event", "decision", "relation"];

type MemoryTab = "list" | "profile" | "stats";

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

function StatsLoading() {
  return (
    <div className="memory-stats-grid" aria-busy="true" aria-label="统计加载中">
      {[0, 1, 2, 3, 4].map(index => (
        <div className="memory-stat memory-skeleton-card" key={index}>
          <div className="memory-skeleton memory-skeleton-stat" />
          <div className="memory-skeleton memory-skeleton-meta" />
        </div>
      ))}
    </div>
  );
}

function StatsPanel({ stats, error, onRetry }: {
  stats: MemoryStats | null;
  error: string | null;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <div className="memory-error" role="alert">
        <b>统计加载失败</b>
        <p>{error}</p>
        <button className="memory-btn" onClick={onRetry}>重试</button>
      </div>
    );
  }
  if (stats === null) return <StatsLoading />;

  const cards = [
    { label: "总记忆数", value: stats.total },
    { label: "生效中", value: stats.active },
    { label: "已被取代", value: stats.superseded },
    ...Object.entries(stats.byKind)
      .sort(([left], [right]) => {
        const leftIndex = KIND_ORDER.indexOf(left);
        const rightIndex = KIND_ORDER.indexOf(right);
        return (leftIndex === -1 ? KIND_ORDER.length : leftIndex) - (rightIndex === -1 ? KIND_ORDER.length : rightIndex);
      })
      .map(([kind, value]) => ({ label: kindLabel(kind), value })),
  ];
  return (
    <div className="memory-scroll">
      <div className="memory-stats-grid">
        {cards.map(card => (
          <div className="memory-stat" key={card.label}>
            <div className="memory-stat-n">{card.value}</div>
            <div className="memory-stat-l">{card.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MemoryPane() {
  const [tab, setTab] = useState<MemoryTab>("list");
  const [scope, setScope] = useState("global");
  const [editing, setEditing] = useState(false);
  const [projects, setProjects] = useState<Array<{id:string;name:string}>>([]);
  const [initError,setInitError] = useState<string|null>(null);
  useEffect(()=>{let alive=true;listProjects().then(rows=>{if(alive)setProjects(rows);}).catch(e=>{if(alive)setInitError(errText(e));});memoryEnsureLibrary().then(()=>{if(alive)setRefreshToken(v=>v+1);}).catch(e=>{if(alive)setInitError(errText(e));});return ()=>{alive=false;};},[]);
  const [refreshToken, setRefreshToken] = useState(0);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const statsSeq = useRef(0);

  const loadStats = useCallback(async () => {
    const seq = ++statsSeq.current;
    setStatsError(null);
    try {
      const next = await memoryStats(scope);
      if (seq !== statsSeq.current) return;
      setStats(next);
    } catch (error) {
      if (seq !== statsSeq.current) return;
      setStatsError(errText(error));
    }
  }, [scope]);

  useEffect(() => {
    setStats(null);
    void loadStats();
  }, [loadStats, refreshToken]);

  useEffect(() => () => { statsSeq.current += 1; }, []);

  const refresh = () => {
    if(editing && !window.confirm("刷新会放弃未保存的记忆编辑，继续？"))return;
    setEditing(false);
    setRefreshToken(value => value + 1);
    if (tab === "stats") setStats(null);
  };

  const switchScope=(next:string)=>{if(editing&&!window.confirm("切换范围会放弃未保存的编辑，继续？"))return;statsSeq.current++;setStats(null);setStatsError(null);setEditing(false);setScope(next);};
  const switchTab=(next:MemoryTab)=>{if(editing&&!window.confirm("切换视图会放弃未保存的编辑，继续？"))return;setEditing(false);setTab(next);};
  useEffect(()=>{const focus=()=>{if(!editing)setRefreshToken(v=>v+1);};window.addEventListener('focus',focus);return ()=>window.removeEventListener('focus',focus);},[editing]);
  return (
    <div className="memory-pane">
      <header className="memory-topbar">
        <span className="memory-crumb">知识库 · <b>记忆</b></span>
        <span className="memory-spacer" />
        <button className="memory-btn" onClick={refresh} title="重新读取记忆、画像与统计">
          <Icon name="refresh" size={13} />
          刷新
        </button>
      </header>

      <div className="memory-toolbar memory-scope-toolbar">
        <select className="memory-select" aria-label="记忆范围" value={scope} onChange={e=>switchScope(e.target.value)}>
          <option value="global">个人记忆（跨项目通用）</option>
          {projects.map(p=><option key={p.id} value={`project:${p.id}`}>{p.name}</option>)}
        </select>
        <span className="memory-hint">{scope==='global'?'同步到个人记忆知识库，跨项目通用。':'仅此项目可用，不进入个人通用记忆库。'}</span>
      </div>
      {initError&&<p className="memory-error" role="alert">{initError}</p>}
      <nav className="memory-tabs" role="tablist" aria-label="记忆视图">
        <button className="memory-tab" role="tab" aria-selected={tab === "list"} onClick={() => switchTab("list")}>记忆</button>
        <button className="memory-tab" role="tab" aria-selected={tab === "profile"} onClick={() => switchTab("profile")}>画像</button>
        <button className="memory-tab" role="tab" aria-selected={tab === "stats"} onClick={() => switchTab("stats")}>统计</button>
      </nav>

      <main className="memory-content" role="tabpanel">
        {tab === "list" && <MemoryList key={scope} scope={scope} onEditingChange={setEditing} refreshToken={refreshToken} onChanged={() => { void loadStats(); }} />}
        {tab === "profile" && <MemoryProfile key={scope} scope={scope} refreshToken={refreshToken} />}
        {tab === "stats" && (
          <StatsPanel
            stats={stats}
            error={statsError}
            onRetry={() => { setStats(null); void loadStats(); }}
          />
        )}
      </main>
    </div>
  );
}
