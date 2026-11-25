import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "@/api";
import type { ProbeAttribution, ProbeHistoryItem, ProbeItemState, ProbeProgressEvent, ProbeReport, Provider } from "@/api";
import { useToast } from "@/components/ui";
import { SettingsIcon } from "./SettingsDialog";
import { errMsg } from "./shared";

// CR-058：模型检测探针（设置左栏「模型检测」页签；r4 十九针，r5 结果区置顶 + 历史改悬浮下拉；r5(CR-058 r5) 增 P20 行为指纹与归因面板）。
// 固定 20 针、无探针选择入口；端点与密钥取自已保存供应商配置；历史保留最近 10 次。
const PROBE_STATUS_LABEL: Record<string, string> = { pass: "通过", warn: "警示", fail: "不通过", skip: "未执行", na: "不适用" };
const EMPTY_ITEMS: ProbeItemState[] = [];
const PENDING_SLOTS = 20;
// 固定 20 针清单：与后端 PROBE_CODES / PROBE_NAMES 一致（r5 末位 P20 行为指纹与归因，权重 0 辅助信号）。
// 名称在此固定，保证「执行中」阶段就能显示编号+名称，不依赖后端回传（AC-03）。
const PROBE_LIST: [string, string][] = [
  ["P1", "连通与鉴权握手"],
  ["P2", "模型回显与跨档偷换"],
  ["P3", "响应 Schema 与 ID 规范"],
  ["P4", "SSE 真流式与假首字"],
  ["P5", "网关响应头指纹"],
  ["P6", "System 金丝雀服从"],
  ["P7", "隐藏注入与套壳嗅探"],
  ["P8", "多轮记忆保持"],
  ["P9", "Stop 序列截断"],
  ["P10", "Max Tokens 硬截断"],
  ["P11", "原生工具调用验真"],
  ["P12", "Strict JSON Schema"],
  ["P13", "动态逻辑与防背题"],
  ["P14", "并发混池快照"],
  ["P15", "识图多模态验真"],
  ["P16", "Responses 协议探测"],
  ["P17", "输入 Token 对账"],
  ["P18", "流式输出对账"],
  ["P19", "长前缀缓存命中"],
  ["P20", "行为指纹与归因"],
];

interface Slot {
  phase: "idle" | "running" | "settled";
  status?: ProbeItemState["status"];
  ms?: number;
  note?: string;
}
const freshSlots = (): Slot[] => Array.from({ length: PENDING_SLOTS }, () => ({ phase: "idle" as const }));
const gradeClass = (grade: string) => `grade-badge ${grade.toLowerCase()}`;
const fmtDuration = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const fmtTime = (createdAt: number) =>
  new Date(createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const verdictTone = (verdict: string) => (verdict === "真实" ? "good" : verdict === "存疑" ? "warn" : "bad");

function Dot({ slot }: { slot: Slot }) {
  const cls = slot.phase === "running" ? "running" : slot.phase === "settled" ? slot.status || "skip" : "pending";
  const label = slot.phase === "running" ? "执行中" : slot.phase === "settled" ? PROBE_STATUS_LABEL[slot.status || "skip"] : "等待";
  return <span className={`probe-dot ${cls}`} role="img" aria-label={label} />;
}

function ProbeRows({ slots, items }: { slots: Slot[]; items: ProbeItemState[] }) {
  return <div className="probe-rows" role="list" aria-label="二十针探针结果">
    {slots.map((slot, i) => {
      // 名称取固定清单（后端回传仅用于覆盖状态与证据，不作为名称来源）。
      const [code, name] = PROBE_LIST[i] || [`P${i + 1}`, ""];
      const item = items[i];
      return <div className="probe-row" key={i} role="listitem">
        <span className="p-code mono">{code}</span>
        <Dot slot={slot} />
        <span className="p-name">{name}{slot.phase === "settled" && slot.note ? <span className="p-note mono">{slot.note}</span> : null}{slot.phase === "running" ? <span className="p-note">探针执行中…</span> : null}</span>
        <span className="p-ms">{slot.phase === "settled" && slot.ms != null ? `${slot.ms}ms` : slot.phase === "running" ? "—" : ""}</span>
      </div>;
    })}
  </div>;
}

/* CR-058 r5：P20 归因面板（结果区下方、逐针列表上方；仅完成/历史回看态渲染）。
   一致性三态 + top-3「最像的已知候选」距离条；概率性提示，措辞不得出现实锤断言（AC-18）。 */
const ATTR_CONSISTENCY: Record<string, { label: string; tone: string }> = {
  match: { label: "与声称家族一致", tone: "good" },
  mismatch: { label: "与声称家族不一致", tone: "warn" },
  unknown: { label: "无法判定", tone: "gray" },
};
function AttributionPanel({ attr }: { attr: ProbeAttribution }) {
  const c = ATTR_CONSISTENCY[attr.consistency] || ATTR_CONSISTENCY.unknown;
  const maxD = Math.max(0.001, ...attr.candidates.map(x => x.distance));
  return <div className="probe-attr" aria-label="行为指纹归因">
    <div className="probe-attr-head">
      <span className="probe-attr-title">行为指纹归因</span>
      <span className={`tag ${c.tone}`}>{c.label}</span>
      <span className="set-caption probe-attr-claimed">声称家族 · <span className="mono">{attr.claimedFamily || "未知"}</span></span>
      <span className="set-caption probe-attr-hint">最像的已知候选 · 概率性提示，不构成实锤</span>
    </div>
    <div className="probe-attr-list" role="list">
      {attr.candidates.length ? attr.candidates.map((x, i) => <div className="probe-attr-cand" key={i} role="listitem">
        <span className="a-rank mono">#{i + 1}</span>
        <span className="a-name mono">{x.name}</span>
        <span className="a-bar" aria-hidden="true"><span className={`a-bar-fill${i === 0 ? " top" : ""}`} style={{ width: `${Math.round((1 - x.distance / maxD) * 100)}%` }} /></span>
        <span className="a-dist mono">d={x.distance.toFixed(2)}</span>
      </div>) : <p className="set-caption probe-attr-empty">与所有已知候选都不像（基线库外）；无法判定，不指认。</p>}
    </div>
    {attr.note ? <p className="set-caption probe-attr-note">{attr.note}</p> : null}
  </div>;
}

export function SettingsModelProbe() {
  const toast = useToast();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerState, setProviderState] = useState<"loading" | "ready" | "error">("loading");
  const [providerError, setProviderError] = useState("");
  const [providerNotice, setProviderNotice] = useState("");
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [slots, setSlots] = useState<Slot[]>(freshSlots());
  const [items, setItems] = useState<ProbeItemState[]>(EMPTY_ITEMS);
  const [report, setReport] = useState<ProbeReport | null>(null);
  const [running, setRunning] = useState(false);
  const [runningLabel, setRunningLabel] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<ProbeHistoryItem[]>([]);
  const [historyState, setHistoryState] = useState<"loading" | "ready" | "error">("loading");
  const [historyError, setHistoryError] = useState("");
  const [viewing, setViewing] = useState<ProbeHistoryItem | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const providerIdRef = useRef(providerId); providerIdRef.current = providerId;
  const modelIdRef = useRef(modelId); modelIdRef.current = modelId;
  const runningRef = useRef(running); runningRef.current = running;
  const reloadTimer = useRef<number | undefined>(undefined);

  /* CR-068 P01：检测页必须读取配置权威，并订阅供应商增删启停事件；读取失败保留旧候选并可重试。 */
  const loadProviders = useCallback(async () => {
    setProviderState(prev => (prev === "ready" ? "ready" : "loading"));
    setProviderError("");
    try {
      const list = await api.providerList();
      const enabled = list.filter(p => !p.disabled);
      setProviders(enabled);
      setProviderState("ready");
      if (runningRef.current) return;
      const pid = providerIdRef.current;
      if (pid && !enabled.some(p => p.id === pid)) {
        setProviderId(""); setModelId("");
        setProviderNotice("原选择的供应商已停用或删除，候选已清理，请重新选择。");
        return;
      }
      const mid = modelIdRef.current;
      if (pid && mid) {
        const p = enabled.find(x => x.id === pid);
        if (!(p?.models || []).some(m => m.modelId === mid && !m.imageGen)) {
          setModelId("");
          setProviderNotice("原选择的模型已删除或停用，已清理该选择，请重新选择。");
        }
      }
    } catch (e) {
      setProviderState("error");
      setProviderError(errMsg(e));
    }
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryState(prev => (prev === "ready" ? "ready" : "loading"));
    setHistoryError("");
    try {
      setHistory(await api.modelProbeHistoryList());
      setHistoryState("ready");
    } catch (e) {
      setHistoryState("error");
      setHistoryError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void loadProviders();
    void loadHistory();
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ keys?: string[]; command?: string }>).detail;
      const relevant = detail?.keys?.includes("providers") || /^provider_(save|delete|set_disabled)$/.test(detail?.command || "");
      if (!relevant) return;
      if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
      reloadTimer.current = window.setTimeout(() => { void loadProviders(); }, 120);
    };
    window.addEventListener("app:settings-changed", onChanged);
    return () => {
      window.removeEventListener("app:settings-changed", onChanged);
      if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
    };
  }, [loadProviders, loadHistory]);

  const provider = providers.find(p => p.id === providerId);
  const models = (provider?.models || []).filter(m => !m.imageGen);
  // 禁用原因必须说清，否则用户只知道按钮点不了、不知道为什么（AC-10 前端侧）。
  const blockReason = providerState === "error"
    ? "供应商配置读取失败，请先重试"
    : providerState === "loading" && !providers.length
      ? "正在读取供应商配置…"
      : !providerId
        ? "先选择供应商"
        : !provider
          ? "该供应商不可用（已停用或已删除）"
          : models.length === 0
            ? "该供应商没有可检测的模型（生图模型不参与检测）"
            : !modelId
              ? "再选择要检测的模型"
              : running
                ? "检测进行中"
                : "";
  // 历史悬浮框：点击外部或 Esc 收起（不用弹窗）。
  useEffect(() => {
    if (!historyOpen) return;
    const onDown = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) setHistoryOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setHistoryOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [historyOpen]);

  const onEvent = (ev: ProbeProgressEvent) => {
    if (ev.type !== "probe") return;
    setSlots(prev => prev.map((slot, i) => (i === ev.index ? (ev.phase === "running" ? { phase: "running" } : { phase: "settled", status: ev.status, ms: ev.ms, note: ev.note }) : slot)));
    if (ev.phase === "running") setRunningLabel(`${ev.code} ${ev.name}`);
    // 逐针证据同步累积：运行中即可看到已完成各针的状态与摘要（AC-03）。
    if (ev.phase === "settled" && ev.status) {
      const status = ev.status;
      setItems(prev => {
        const next = prev.slice();
        next[ev.index] = { code: ev.code, name: ev.name, status, ms: ev.ms || 0, note: ev.note || "" };
        return next;
      });
    }
  };
  const run = async () => {
    if (!providerId || !modelId || running) return;
    setRunning(true);
    setViewing(null);
    setSlots(freshSlots());
    setItems(EMPTY_ITEMS);
    setReport(null);
    setRunningLabel("正在连接目标网关…");
    try {
      const finalReport = await api.modelProbeRun(providerId, modelId, onEvent);
      setItems(finalReport.items || EMPTY_ITEMS);
      setReport(finalReport);
      toast(`检测完成：${finalReport.score} 分 · ${finalReport.grade} 级 · ${finalReport.verdict}`);
      void loadHistory();
    } catch (error) {
      toast(String(error).replace(/^Error:\s*/, "") || "检测失败", "err");
    } finally {
      setRunning(false);
      setRunningLabel("");
    }
  };

  // 选中历史：下拉收起，结果区与 20 针列表切到该次结果。
  const openHistory = () => { setHistoryOpen(v => !v); if (!historyOpen) void loadHistory(); };
  const pickHistory = (h: ProbeHistoryItem) => {
    setHistoryOpen(false);
    setViewing(h);
    setReport(null);
    setRunning(false);
    setItems(h.items || EMPTY_ITEMS);
    setSlots((h.items || []).map(item => ({ phase: "settled" as const, status: item.status, ms: item.ms, note: item.note })));
  };

  const doneCount = slots.filter(s => s.phase === "settled").length;
  const progressPct = Math.round((doneCount / PENDING_SLOTS) * 100);
  const shown = report || viewing;

  // 空闲态：结果区只写「待检测」，高度与进行中/已检测一致，状态切换不引起下方列表跳动。
  const idleBlock = () => {
    const target = provider && modelId
      ? `${provider.name} · ${models.find(m => m.modelId === modelId)?.displayName || modelId}`
      : provider ? `${provider.name}（未选模型）` : "尚未选择供应商";
    return <div className="probe-result-top">
      <span className="probe-result-title">待检测</span>
      <span className="set-caption probe-result-note">{target}</span>
    </div>;
  };

  return <section className="set-section probe-section" aria-label="模型检测">
    <div className="probe-head">
      <div>
        <h3>模型检测</h3>
        <p className="set-caption">固定 20 针黑盒探针 · 检测中转掺水（偷换模型 / 吞指令 / 裁历史 / 假流式）· P20 行为指纹给出「最像的已知候选」归因提示 · 结果仅本地展示，不改写配置</p>
      </div>
      <div className="probe-hist-wrap" ref={historyRef}>
        <button className="btn sm" aria-expanded={historyOpen} onClick={openHistory}>
          <SettingsIcon name="history" />历史记录<SettingsIcon name={historyOpen ? "chevronUp" : "chevronDown"} />
        </button>
        {historyOpen && <div className="probe-hist-pop" role="listbox" aria-label="历史检测记录">
          {history.length ? history.map(h => <button
            key={h.id}
            type="button"
            role="option"
            aria-selected={viewing?.id === h.id}
            className={`probe-hist-item ${viewing?.id === h.id ? "on" : ""}`}
            onClick={() => pickHistory(h)}
          >
            <span className="h-when">{fmtTime(h.createdAt)}</span>
            <span className="h-target">{h.providerName}<span className="mono"> · {h.modelId}</span></span>
            <span className="h-score mono">{h.score}</span>
            <span className={gradeClass(h.grade)}>{h.grade}</span>
          </button>) : historyState === "error" ? <div className="probe-hist-state" role="alert">
            <p className="set-caption">历史记录读取失败：{historyError}</p>
            <button className="btn sm" onClick={() => void loadHistory()}>重试</button>
          </div> : <p className="set-caption probe-hist-empty">{historyState === "loading" ? "正在读取历史…" : "还没有检测记录"}</p>}
        </div>}
      </div>
    </div>

    <div className="probe-pick">
      <select className="select" aria-label="选择供应商" value={providerId} disabled={running || (providerState === "loading" && !providers.length)} onChange={e => { setProviderNotice(""); setProviderId(e.target.value); setModelId(""); setSlots(freshSlots()); setItems(EMPTY_ITEMS); setReport(null); setViewing(null); }}>
        <option value="" disabled>选择供应商</option>
        {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <select className="select" aria-label="选择模型" value={modelId} disabled={!provider || running} onChange={e => { setProviderNotice(""); setModelId(e.target.value); setSlots(freshSlots()); setItems(EMPTY_ITEMS); setReport(null); setViewing(null); }}>
        <option value="" disabled>{provider ? "选择模型" : "先选择供应商"}</option>
        {models.map(m => <option key={m.modelId} value={m.modelId}>{m.displayName || m.modelId} · {m.modelId}</option>)}
      </select>
      <button className="btn sm primary" disabled={!providerId || !modelId || running || providerState === "error"} onClick={() => void run()}>{running ? "检测中…" : "开始检测"}</button>
      {viewing && <button className="btn sm" onClick={() => { setViewing(null); setItems(EMPTY_ITEMS); setSlots(freshSlots()); }}>退出历史回看</button>}
    </div>
    {providerState === "error" && <div className="set-note probe-error" role="alert">
      <span>供应商配置读取失败：{providerError}</span>
      <button className="btn sm" disabled={running} onClick={() => void loadProviders()}>重试</button>
    </div>}
    {providerNotice && <p className="set-caption probe-hint" role="status">{providerNotice}<button className="set-link" onClick={() => setProviderNotice("")}>知道了</button></p>}
    {blockReason && <p className="set-caption probe-hint">{blockReason}</p>}

    {/* 结果区紧贴 20 针列表上方：空闲 → 进行中（进度）→ 完成 / 历史回看 */}
    <div className={`probe-result ${running ? "running" : shown ? "done" : "idle"}`}>
      {running && <>
        <div className="probe-result-top">
          <span className="probe-result-title">检测中</span>
          <span className="set-caption probe-result-note">{runningLabel || "正在连接目标网关…"}</span>
          <span className="probe-count mono">{doneCount}/{PENDING_SLOTS}</span>
        </div>
        <div className="probe-progress" role="progressbar" aria-valuemin={0} aria-valuemax={PENDING_SLOTS} aria-valuenow={doneCount}>
          <span className="probe-progress-fill" style={{ width: `${progressPct}%` }} />
        </div>
      </>}
      {!running && shown && <>
        <div className="probe-result-top">
          <span className="probe-result-title">已检测</span>
          <span className="probe-score"><b>{shown.score}</b><span className="set-caption">/ 100</span></span>
          <span className={gradeClass(shown.grade)}>{shown.grade}</span>
          <span className="probe-tags">
            <span className={`tag ${verdictTone(shown.verdict)}`}>真伪 · {shown.verdict}</span>
            <span className="tag">渠道 · {shown.channel}</span>
            <span className="tag">{fmtDuration(shown.durationMs)}</span>
          </span>
          {viewing && !report && <span className="tag gray">历史回看 · {fmtTime(viewing.createdAt)}</span>}
        </div>
        <p className="set-caption probe-result-summary">{shown.summary}</p>
      </>}
      {!running && !shown && idleBlock()}
    </div>

    {/* r5：归因面板仅在完成/历史回看态渲染（待检测与运行中不出现，不影响结果区 108px 固定高度） */}
    {!running && shown?.attribution ? <AttributionPanel attr={shown.attribution} /> : null}

    <ProbeRows slots={slots} items={items} />
  </section>;
}
