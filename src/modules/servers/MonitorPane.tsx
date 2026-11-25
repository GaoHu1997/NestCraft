import { useEffect, useRef, useState } from "react";
import { serverMetrics, type HostMetrics } from "@/api";
import { errText } from "./HostForm";

const POLL_MS = 5000;
const HISTORY_LIMIT = 40;
function pct(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null; }
function fmtMb(mb: number): string { return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`; }

/** UI-CR036-v4：纯监控栏，无 AI 运维或命令执行；隐藏／离线不访问远端。 */
export function MonitorPane({ hostId, hostName, address, connected = false, visible = true }: { hostId: string; hostName: string; address?: string; connected?: boolean; visible?: boolean }) {
  const [metrics, setMetrics] = useState<HostMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const historyHost = useRef(hostId);
  const active = connected && visible;
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (historyHost.current !== hostId || !connected) { historyHost.current = hostId; setMetrics(null); setHistory([]); setError(null); }
    setLoading(active);
    if (!active) return;
    const tick = async () => {
      if (!alive || !activeRef.current) return;
      try {
        const sample = await serverMetrics(hostId);
        if (!alive || !activeRef.current) return;
        setMetrics(sample); setError(null); setLoading(false);
        // 无核心／非有限值不是 0%，不填入曲线。
        const value = sample.cpuCores?.length ? pct(sample.cpuAvg) : null;
        if (value !== null) setHistory((prev) => [...prev, value].slice(-HISTORY_LIMIT));
      } catch (e) {
        if (!alive || !activeRef.current) return;
        setError(errText(e)); setLoading(false);
      } finally {
        // await后安排下一次，避免慢采样重叠与隐藏后补发。
        if (alive && activeRef.current) timer = setTimeout(() => void tick(), POLL_MS);
      }
    };
    void tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [hostId, connected, visible, active]);

  const current = connected && !error ? metrics : null;

  /* CR-075：未连接时不铺满"未知（主机未连接）"这类重复提示，只给一行状态，
     避免把连接状态说明堆成正文；连接由工作台自动发起，失败原因在中间区域显示。 */
  if (!connected) {
    return (
      <aside className="wb-monitor" aria-label="实时监控">
        <div className="mon-head"><b>实时监控</b><span /></div>
        <div className="mon-offline">无数据</div>
      </aside>
    );
  }

  const cpu = current?.cpuCores?.length ? pct(current.cpuAvg) : null;
  const cores = current?.cpuCores ?? [];
  const memKnown = !!current && Number.isFinite(current.memTotalMb) && current.memTotalMb > 0 && Number.isFinite(current.memUsedMb) && current.memUsedMb >= 0 && current.memUsedMb <= current.memTotalMb;
  const memoryPct = memKnown && current ? current.memUsedMb / current.memTotalMb * 100 : null;
  const points = history.map((v, i) => `${i * 200 / Math.max(1, history.length - 1)},${40 - v * .4}`).join(" ");
  const unknown = !connected ? "未知（主机未连接）" : error ? "未知（采样失败）" : loading && !metrics ? "等待采样…" : "未知";

  return (
    <aside className="wb-monitor" aria-label="实时监控">
      <div className="mon-head"><b>实时监控</b><span>{!connected ? "未连接" : !visible ? "已暂停" : "每 5 秒刷新"}</span></div>
      {error && connected && <div className="mon-stale" role="status">采样不可用：{error}；显示未知，等待重试。</div>}
      <section className="mon-host" aria-label="主机信息">
        <div className="row"><b className="grow ellipsis">{hostName}</b><span className={connected ? "tag good" : "tag"}>{connected ? error ? "采样失败" : "已连接" : "未连接"}</span></div>
        <div className="mon-kv"><span>系统</span><b title={current?.os}>{current?.os || unknown}</b></div>
        <div className="mon-kv"><span>地址</span><b className="mono" title={address}>{address ?? "未知"}</b></div>
        <div className="mon-kv"><span>运行时长</span><b>{current?.uptime || unknown}</b></div>
        <div className="mon-kv"><span>主机名</span><b>{current?.hostname || unknown}</b></div>
      </section>
      <section className="mon-block" aria-label="CPU 使用率">
        <div className="row between"><span>CPU 使用率</span><b>{cpu === null ? unknown : `${cpu.toFixed(1)}%`}</b></div>
        {connected && !error && history.length > 1 ? <svg className="mon-spark" viewBox="0 0 200 40" preserveAspectRatio="none" role="img" aria-label="当前工作区采样历史曲线"><polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.6" /></svg> : <div className="mon-loading">{cpu === null ? unknown : "等待更多采样形成曲线"}</div>}
        {cores.length > 0 && <div className="mon-core-grid" style={{ gridTemplateColumns: `repeat(${Math.min(8, cores.length)}, 1fr)` }}>{cores.map((v, i) => { const value = pct(v); return <span key={i} className="mon-core" title={`Core ${i}：${value === null ? "未知" : value.toFixed(1) + "%"}`}>{value !== null && <i style={{ height: `${value}%` }} />}</span>; })}</div>}
        <div className="mon-caption">{cores.length ? `每核心占用 · 共 ${cores.length} 核` : "核心数量未知"}</div>
        <div className="mon-caption">当前接口为自启动累计 CPU 近似；曲线仅记录本工作区取得的采样，不是瞬时负载。</div>
      </section>
      <section className="mon-block" aria-label="内存">
        <div className="row between"><span>内存</span><b>{memKnown && current ? `${fmtMb(current.memUsedMb)} / ${fmtMb(current.memTotalMb)}` : unknown}</b></div>
        {memoryPct !== null && <div className="mon-bar"><i style={{ width: `${memoryPct}%` }} /></div>}
      </section>
      <section className="mon-block" aria-label="磁盘"><div className="row between"><span>磁盘</span><b>未知</b></div><div className="mon-caption">当前采样接口未提供磁盘容量／用量。</div></section>
      <section className="mon-block" aria-label="负载"><div className="row between"><span>负载</span><b>未知</b></div><div className="mon-caption">1 / 5 / 15 分钟 · 当前仅有无有效性标记的 load1，不能据默认 0 判断已测负载。</div></section>
    </aside>
  );
}
