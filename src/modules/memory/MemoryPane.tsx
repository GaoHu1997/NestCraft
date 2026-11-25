import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { memoryStats } from "@/api/memory";
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
  const [refreshToken, setRefreshToken] = useState(0);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const statsSeq = useRef(0);

  const loadStats = useCallback(async () => {
    const seq = ++statsSeq.current;
    setStatsError(null);
    try {
      const next = await memoryStats(null);
      if (seq !== statsSeq.current) return;
      setStats(next);
    } catch (error) {
      if (seq !== statsSeq.current) return;
      setStatsError(errText(error));
    }
  }, []);

  useEffect(() => {
    setStats(null);
    void loadStats();
  }, [loadStats, refreshToken]);

  useEffect(() => () => { statsSeq.current += 1; }, []);

  const refresh = () => {
    setRefreshToken(value => value + 1);
    if (tab === "stats") setStats(null);
  };

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

      <nav className="memory-tabs" role="tablist" aria-label="记忆视图">
        <button className="memory-tab" role="tab" aria-selected={tab === "list"} onClick={() => setTab("list")}>记忆</button>
        <button className="memory-tab" role="tab" aria-selected={tab === "profile"} onClick={() => setTab("profile")}>画像</button>
        <button className="memory-tab" role="tab" aria-selected={tab === "stats"} onClick={() => setTab("stats")}>统计</button>
      </nav>

      <main className="memory-content" role="tabpanel">
        {tab === "list" && <MemoryList refreshToken={refreshToken} onChanged={() => { void loadStats(); }} />}
        {tab === "profile" && <MemoryProfile refreshToken={refreshToken} />}
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
