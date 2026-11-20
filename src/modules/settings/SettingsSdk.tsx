import { CliLogo } from "@/components/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "@/api";
import type { ModelCandidate, SdkJob, SdkState } from "@/api";
import { Field, useToast } from "@/components/ui";
import { EFFORT_LEVELS, errMsg } from "./shared";
import { SettingsConfirm, SettingsIcon, SettingsSwitch } from "./SettingsDialog";

const TERMINAL = new Set(["done", "failed", "cancelled", "timeout"]);
const PHASE_LABEL: Record<SdkJob["phase"], string> = { queued: "排队中", running: "执行中", done: "已完成", failed: "失败", cancelled: "已取消", timeout: "已超时" };
const TASK_TYPES = ["仓库探索", "代码定位", "资料检索", "方案核验", "影响分析", "功能开发", "缺陷修复", "测试验证", "代码审查", "数据处理", "模块重构", "方案设计", "文档整理"];
interface CliPreference { model: string; effort: string; minDifficulty: string; types: string[]; permission: string }
const defaultPreference = (): CliPreference => ({ model: "", effort: "", minDifficulty: "", types: [], permission: "default" });
const sdkName = (id: string) => ({ claude: "Claude Code", codex: "Codex", grok: "Grok CLI" }[id] || id);
const modelValue = (m: ModelCandidate) => `${m.providerId}/${m.modelId}`;

export function SettingsSdk() {
  const toast = useToast();
  const [tab, setTab] = useState("cli");
  const [registry, setRegistry] = useState("");
  const [list, setList] = useState<SdkState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [registryReady, setRegistryReady] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [cliOpen, setCliOpen] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<Record<string, CliPreference>>({});
  const [prefReady, setPrefReady] = useState<Record<string, boolean>>({});
  const [models, setModels] = useState<ModelCandidate[]>([]);
  const [versions, setVersions] = useState<Record<string, string[]>>({});
  const [versionLoading, setVersionLoading] = useState<Record<string, boolean>>({});
  const [versionSelected, setVersionSelected] = useState<Record<string, string>>({});
  const [jobs, setJobs] = useState<Record<string, { id: string; at: number }>>({});
  const [jobView, setJobView] = useState<Record<string, SdkJob | null>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const pendingRef = useRef(new Set<string>());
  const [uninstallTarget, setUninstallTarget] = useState<SdkState | null>(null);
  const jobsRef = useRef(jobs); jobsRef.current = jobs;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try { const data = await api.sdkList(); if (alive.current) setList(data); }
    catch (e) { if (alive.current) setError(errMsg(e)); }
    finally { if (alive.current) setLoading(false); }
  }, []);
  useEffect(() => {
    refresh();
    api.getSetting("npmRegistry").then(v => { if (alive.current) { setRegistry(v || ""); setRegistryReady(true); } }).catch(() => toast("npm registry 读取失败，保存已禁用", "err"));
    const readModels = () => api.modelCandidates().then(data => { if (alive.current) setModels(data); }).catch(() => {});
    readModels();
    window.addEventListener("app:settings-changed", readModels);
    return () => window.removeEventListener("app:settings-changed", readModels);
  }, [refresh, toast]);
  useEffect(() => {
    for (const s of list) if (!prefReady[s.id]) {
      api.getSetting(`cli.preferences.${s.id}`).then(value => {
        if (!alive.current) return;
        let preference = defaultPreference();
        if (value) {
          const raw = JSON.parse(value) as Record<string, unknown>;
          if (!raw || Array.isArray(raw)) throw new Error("invalid preference");
          preference = { model: typeof raw.model === "string" ? raw.model : "", effort: typeof raw.effort === "string" ? raw.effort : "", minDifficulty: typeof raw.minDifficulty === "string" ? raw.minDifficulty : "", types: Array.isArray(raw.types) ? raw.types.filter((x): x is string => typeof x === "string") : [], permission: typeof raw.permission === "string" ? raw.permission : "default" };
        }
        setPreferences(prev => ({ ...prev, [s.id]: preference })); setPrefReady(prev => ({ ...prev, [s.id]: true }));
      }).catch(() => toast(`${sdkName(s.id)} 的偏好读取失败，不允许覆盖已有值`, "err"));
    }
  }, [list, toast]);
  const operation = async (id: string, action: () => Promise<void>) => {
    if (pendingRef.current.has(id)) return;
    pendingRef.current.add(id); setPending(prev => ({ ...prev, [id]: true }));
    try { await action(); } catch (e) { toast(errMsg(e), "err"); }
    finally { pendingRef.current.delete(id); if (alive.current) setPending(prev => ({ ...prev, [id]: false })); }
  };
  useEffect(() => {
    if (!Object.keys(jobs).length) return;
    let polling = false;
    const interval = window.setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        for (const [sdkId, job] of Object.entries(jobsRef.current)) {
          if (Date.now() - job.at > 15 * 60_000) {
            setJobs(prev => { const next = { ...prev }; delete next[sdkId]; return next; });
            toast("SDK 任务超过 15 分钟；停止跟踪不等于已取消后端任务", "warn"); continue;
          }
          try {
            const data = await api.sdkJob(job.id);
            if (!alive.current) return;
            setJobView(prev => ({ ...prev, [sdkId]: data }));
            if (!data || TERMINAL.has(data.phase)) {
              setJobs(prev => { const next = { ...prev }; delete next[sdkId]; return next; });
              if (!data) toast("SDK 任务记录不可用，请重新检测实际状态", "warn");
              else if (data.phase !== "done") toast(data.error || PHASE_LABEL[data.phase], "warn");
              await refresh();
            }
          } catch { /* 后续轮询继续跟踪，不把请求失败视为任务完成。 */ }
        }
      } finally { polling = false; }
    }, 2000);
    return () => window.clearInterval(interval);
  }, [jobs, refresh, toast]);
  const runJob = (s: SdkState, kind: "install" | "uninstall") => operation(s.id, async () => {
    if (jobsRef.current[s.id]) return;
    const id = await api.sdkRunJob(s.id, kind, kind === "install" ? versionSelected[s.id] || undefined : undefined);
    const entry = { id, at: Date.now() };
    jobsRef.current = { ...jobsRef.current, [s.id]: entry };
    setJobs(prev => ({ ...prev, [s.id]: entry })); setJobView(prev => ({ ...prev, [s.id]: null })); setUninstallTarget(null);
  });
  const loadVersions = (id: string) => operation(`versions:${id}`, async () => {
    setVersionLoading(prev => ({ ...prev, [id]: true }));
    try { const data = await api.sdkVersions(id); setVersions(prev => ({ ...prev, [id]: data.filter(v => /^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(v)) })); }
    finally { setVersionLoading(prev => ({ ...prev, [id]: false })); }
  });
  const toggle = (s: SdkState, enabled: boolean) => operation(s.id, async () => {
    await api.sdkSetEnabled(s.id, enabled); setList(prev => prev.map(x => x.id === s.id ? { ...x, enabled } : x));
    window.dispatchEvent(new CustomEvent("app:settings-changed", { detail: { keys: ["sdks"] } }));
  });
  const updatePreference = (id: string, patch: Partial<CliPreference>) => setPreferences(prev => ({ ...prev, [id]: { ...(prev[id] || defaultPreference()), ...patch } }));
  const cliBody = (s: SdkState) => {
    const pref = preferences[s.id] || defaultPreference();
    const model = models.find(m => modelValue(m) === pref.model);
    const compatible = models.filter(m => s.id === "claude" ? m.protocol === "anthropic" : m.protocol === "openai");
    return <div className="set-cli-body"><fieldset className="set-fieldset" disabled={!prefReady[s.id] || pending[s.id]}>
      <div className="set-form-grid"><Field label="模型"><select className="select" value={pref.model} aria-label={`${s.id} 默认模型`} onChange={e => updatePreference(s.id, { model: e.target.value, effort: "" })}><option value="">沿用会话选择</option>{pref.model && !compatible.some(m => modelValue(m) === pref.model) && <option value={pref.model}>已保存模型不可用</option>}{compatible.map(m => <option key={modelValue(m)} value={modelValue(m)}>{m.providerName} · {m.displayName}</option>)}</select></Field><Field label="思考等级"><select className="select" aria-label={`${s.id} 思考等级`} value={pref.effort} onChange={e => updatePreference(s.id, { effort: e.target.value })}><option value="">沿用会话选择</option>{pref.effort && !model?.efforts[pref.effort] && <option value={pref.effort}>已保存档位不可用</option>}{EFFORT_LEVELS.filter(lv => model?.efforts[lv]).map(lv => <option key={lv}>{lv}</option>)}</select></Field></div>
      <Field label="最低任务难度" hint="仅保存偏好；任务调度门槛尚未接入。"><select className="select" aria-label={`${s.id} 最低任务难度`} value={pref.minDifficulty} onChange={e => updatePreference(s.id, { minDifficulty: e.target.value })}><option value="">未配置</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></Field>
      <Field label="任务类型"><div className="set-chips">{TASK_TYPES.map(t => <button key={t} className={`set-chip ${pref.types.includes(t) ? "on" : ""}`} aria-pressed={pref.types.includes(t)} onClick={() => updatePreference(s.id, { types: pref.types.includes(t) ? pref.types.filter(x => x !== t) : [...pref.types, t] })}>{t}</button>)}</div></Field>
      <Field label="权限模式" hint="仅保存偏好；不改变原生 CLI 审批或绕过执行门禁。"><select className="select" aria-label={`${s.id} 权限模式`} value={pref.permission} onChange={e => updatePreference(s.id, { permission: e.target.value })}>{!["default", "plan", "agent", "auto", "full"].includes(pref.permission) && <option>{pref.permission}</option>}<option value="default">默认</option><option value="plan">规划</option><option value="agent">代理</option><option value="auto">自动审批（执行未接入）</option><option value="full">全自动（执行未接入）</option></select></Field>
      <div className="row"><button className="btn sm primary" onClick={() => operation(s.id, async () => { await api.setSetting(`cli.preferences.${s.id}`, JSON.stringify(pref)); window.dispatchEvent(new CustomEvent("app:settings-changed", { detail: { keys: [`cli.preferences.${s.id}`] } })); toast("CLI 偏好已保存；不代表调度或原生权限已经执行"); })}>保存</button><button className="btn sm" onClick={refresh}>重新检测</button></div>
    </fieldset></div>;
  };
  return <>
    <div className="set-tabs" role="tablist" aria-label="SDK 与 CLI">{[["cli", "CLI 管理"], ["sdk", "SDK 管理"]].map(([id, text]) => <button role="tab" key={id} aria-selected={tab === id} onClick={() => setTab(id)}>{text}</button>)}</div>
    {error && <div className="set-note" role="alert">SDK 列表读取失败：{error}<button className="btn sm" onClick={refresh}>重试</button></div>}
    {loading && <p className="set-caption">正在检测 CLI…</p>}
    {tab === "sdk" && <div className="set-registry"><label>npm registry</label><div className="row"><input className="input" value={registry} aria-label="npm registry" disabled={!registryReady || pending.registry} placeholder="https://registry.npmjs.org" onChange={e => setRegistry(e.target.value)} /><button className="btn sm" disabled={!registryReady || pending.registry} onClick={() => operation("registry", async () => { const value = registry.trim(); if (value) { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("registry 需为不含凭证的 HTTP(S) URL"); } await api.setSetting("npmRegistry", value || null); toast("npm registry 已保存，后续安装使用此配置"); })}>保存</button><button className="btn sm" disabled={loading} onClick={refresh}>全部重新检测</button></div><p className="set-caption">可选镜像源；只影响后续 npm 安装。</p></div>}
    <div className="set-sdk-cards">{list.map(s => {
      const installed = s.installState === "installed";
      const status = installed ? "已安装" : s.installState === "error" ? "检测失败" : s.installState === "checking" ? "检测中" : "未安装";
      const job = jobs[s.id], view = jobView[s.id];
      const open = tab === "sdk" ? expanded === s.id : cliOpen === s.id;
      return <div className="set-sdk-card" key={s.id}><div className="set-sdk-head"><button className="set-sdk-select" aria-expanded={open} onClick={() => tab === "sdk" ? setExpanded(open ? null : s.id) : setCliOpen(open ? null : s.id)}><CliLogo id={s.id} size={24} className="set-cli-logo" /><span className="set-sdk-info"><b>{sdkName(s.id)}<span className={`tag ${installed ? "good" : s.installState === "error" ? "bad" : ""}`}>{status}</span>{job && <span className="tag blue">{PHASE_LABEL[view?.phase || "queued"]}</span>}</b><span>{s.package}</span></span><span className="set-caption">{s.version || "版本未知"}</span><SettingsIcon name={open ? "up" : "down"} /></button>{tab === "cli" && <SettingsSwitch checked={s.enabled} disabled={!installed || !!job || pending[s.id]} label={`启用 CLI ${sdkName(s.id)}`} onChange={v => toggle(s, v)} />}</div>
        {open && (tab === "cli" ? cliBody(s) : <div className="set-sdk-body"><Field label="目标版本"><div className="row"><select className="select" aria-label={`${s.id} 目标版本`} value={versionSelected[s.id] || ""} disabled={!!job || pending[s.id] || versionLoading[s.id]} onChange={e => setVersionSelected(prev => ({ ...prev, [s.id]: e.target.value }))}><option value="">最新稳定版</option>{(versions[s.id] || []).map(v => <option key={v}>{v}</option>)}</select><button className="btn sm" disabled={versionLoading[s.id]} onClick={() => loadVersions(s.id)}>{versionLoading[s.id] ? "加载中…" : "刷新版本"}</button></div><span className="set-caption">版本列表仅列正式版；检测和安装来自真实 SDK API。</span></Field>
          <div className="row"><button className="btn sm" disabled>当前版本 {s.version || "未知"}</button>{installed && <button className="btn sm danger" disabled={!!job || pending[s.id]} onClick={() => setUninstallTarget(s)}>卸载</button>}<button className="btn sm" disabled={!!job || pending[s.id] || loading} onClick={refresh}>重新检测</button><button className="btn sm primary" disabled={!!job || pending[s.id]} onClick={() => runJob(s, "install")}>{installed ? "安装目标版本" : "安装"}</button>{job && <button className="btn sm" disabled={pending[s.id]} onClick={() => operation(s.id, async () => { await api.sdkCancel(job.id); toast("已请求取消，等待后端终态"); })}>取消任务</button>}</div>
          <div className="set-caption">当前版本 {s.version || "未知"} · 最新稳定 {versions[s.id]?.[0] || "尚未查询"}</div><div className="set-sdk-path mono">{s.path || "路径尚未检测到"}</div>{view && <div className="set-caption">任务：{PHASE_LABEL[view.phase]}{view.error && <p className="set-err">{view.error}</p>}<pre className="set-pre">{view.logs.slice(-8).join("\n") || "暂无日志"}</pre></div>}
        </div>)}
      </div>;
    })}</div>
    {!loading && !error && !list.length && <div className="set-empty">后端未登记 CLI SDK；不创建仿真内置项。</div>}
    {uninstallTarget && <SettingsConfirm title="卸载 SDK" message={`将从全局 npm 环境卸载 ${uninstallTarget.package}。确定继续？`} busy={pending[uninstallTarget.id]} onCancel={() => setUninstallTarget(null)} onOk={() => runJob(uninstallTarget, "uninstall")} />}
  </>;
}
