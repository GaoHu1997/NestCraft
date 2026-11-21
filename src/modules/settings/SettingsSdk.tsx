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

/* ---------- CR-053：CLI 命令工具（Shell） ---------- */
/** 能力分层标签（AC-06）：Claude 可指定类型、Codex 实验性、Grok 仅展示；不跨层宣称。 */
const SHELL_CAP: Record<string, { tag: string; cls: string }> = {
  claude: { tag: "可指定类型", cls: "" },
  codex: { tag: "实验性", cls: "violet" },
  grok: { tag: "仅展示", cls: "" },
};
interface ShellUiState {
  candidates: api.ShellCandidate[] | null;
  setting: api.ShellSetting | null;
  missing: boolean;
  checkedAt: number | null;
  detecting: boolean;
  attempted: boolean;
  detectError: string;
  saveError: string;
  savedMsg: string;
  selected: string;
  touched: boolean;
}
const EMPTY_SHELL: ShellUiState = { candidates: null, setting: null, missing: false, checkedAt: null, detecting: false, attempted: false, detectError: "", saveError: "", savedMsg: "", selected: "auto", touched: false };
const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);

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
  /* ---------- CR-053：Shell 探测/读取/保存 ---------- */
  const shellLoading = useRef(new Map<string, Promise<void>>());
  const loadShell = useCallback((id: string): Promise<void> => {
    const inflight = shellLoading.current.get(id);
    if (inflight) return inflight;
    const p = (async () => {
      setShell(prev => ({ ...prev, [id]: { ...(prev[id] || EMPTY_SHELL), detecting: true, attempted: true, detectError: "", saveError: "", savedMsg: "" } }));
      try {
        const [candidates, view] = await Promise.all([api.cliShellCandidates(id), api.cliShellGet(id)]);
        if (!alive.current) return;
        setShell(prev => {
          const cur = prev[id] || EMPTY_SHELL;
          return { ...prev, [id]: { ...cur, candidates, setting: view.setting, missing: view.missing, selected: cur.touched ? cur.selected : view.setting.mode, checkedAt: Date.now(), detecting: false, detectError: "" } };
        });
      } catch (e) {
        // 检测失败可见（AC-07）：保留上次成功的候选/设置，不清空、不当作 auto。
        if (!alive.current) return;
        setShell(prev => ({ ...prev, [id]: { ...(prev[id] || EMPTY_SHELL), detecting: false, detectError: errMsg(e) } }));
      } finally {
        shellLoading.current.delete(id);
      }
    })();
    shellLoading.current.set(id, p);
    return p;
  }, []);
  const [shell, setShell] = useState<Record<string, ShellUiState>>({});
  useEffect(() => {
    if (tab !== "cli" || !cliOpen) return;
    if (shell[cliOpen]?.attempted || shellLoading.current.has(cliOpen)) return;
    void loadShell(cliOpen);
  }, [cliOpen, tab, shell, loadShell]);
  const selectShell = (id: string, mode: string) => setShell(prev => ({ ...prev, [id]: { ...(prev[id] || EMPTY_SHELL), selected: mode, touched: true, savedMsg: "" } }));
  const redetectShell = (id: string) => operation(`shell:${id}`, () => loadShell(id));
  const shellSaveDisabled = (s: SdkState): boolean => {
    if (s.id === "grok") return false; // Grok 命令工具仅展示；偏好照常保存
    const st = shell[s.id];
    if (!st || st.detecting || !st.candidates || !st.setting) return true;
    if (st.selected === "auto") return false;
    const cand = st.candidates.find(c => c.kind === st.selected);
    if (!cand?.available) return true;
    if (st.setting.mode === st.selected && st.missing) return true; // 已保存值失效且未改选
    return false;
  };
  const footMsg = (s: SdkState): string => {
    const st = shell[s.id];
    if (s.id === "grok") return st?.savedMsg || "偏好保存后仅影响之后的新会话；命令工具仅展示。";
    if (!st || !st.setting || st.detecting) return st?.detecting ? "检测完成后才能保存。" : "偏好保存后仅影响之后的新会话。";
    if (st.savedMsg) return st.savedMsg;
    if (st.touched) {
      if (st.selected === "auto") return s.id === "claude" ? "自动：由 CLI 自行选择，优先固定位置的 PowerShell 7。" : "自动：由 CLI 自行选择，不注入 Shell 参数。";
      if (s.id === "claude" && st.selected === "pwsh") return "只启用 PowerShell 工具；路径不可自定义。";
      const cand = st.candidates?.find(c => c.kind === st.selected);
      return `已选择 ${cand?.label || st.selected}；点保存后写入偏好。`;
    }
    if (st.setting.mode !== "auto" && st.missing) return "所选命令工具不可用，保存已禁用。";
    return "偏好保存后仅影响之后的新会话。";
  };
  const cliBody = (s: SdkState) => {
    const pref = preferences[s.id] || defaultPreference();
    const model = models.find(m => modelValue(m) === pref.model);
    const compatible = models.filter(m => s.id === "claude" ? m.protocol === "anthropic" : m.protocol === "openai");
    const st = shell[s.id];
    const cap = SHELL_CAP[s.id] || { tag: s.id, cls: "" };
    const selectedSavedMissing = !!st?.setting && st.setting.mode !== "auto" && st.setting.mode === st.selected && st.missing;
    const best = st?.candidates?.find(c => c.available);
    const checkedAtText = st?.detecting ? "正在检测…" : st?.checkedAt ? `检测于 ${hhmm(st.checkedAt)}` : "尚未检测";
    const saveDisabled = shellSaveDisabled(s);
    return <div className="set-cli-body"><fieldset className="set-fieldset" disabled={!prefReady[s.id] || pending[s.id]}>
      <div className="set-form-grid"><Field label="模型"><select className="select" value={pref.model} aria-label={`${s.id} 默认模型`} onChange={e => updatePreference(s.id, { model: e.target.value, effort: "" })}><option value="">沿用会话选择</option>{pref.model && !compatible.some(m => modelValue(m) === pref.model) && <option value={pref.model}>已保存模型不可用</option>}{compatible.map(m => <option key={modelValue(m)} value={modelValue(m)}>{m.providerName} · {m.displayName}</option>)}</select></Field><Field label="思考等级"><select className="select" aria-label={`${s.id} 思考等级`} value={pref.effort} onChange={e => updatePreference(s.id, { effort: e.target.value })}><option value="">沿用会话选择</option>{pref.effort && !model?.efforts[pref.effort] && <option value={pref.effort}>已保存档位不可用</option>}{EFFORT_LEVELS.filter(lv => model?.efforts[lv]).map(lv => <option key={lv}>{lv}</option>)}</select></Field></div>
      <Field label="最低任务难度" hint="仅保存偏好；任务调度门槛尚未接入。"><select className="select" aria-label={`${s.id} 最低任务难度`} value={pref.minDifficulty} onChange={e => updatePreference(s.id, { minDifficulty: e.target.value })}><option value="">未配置</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></Field>
      <Field label="任务类型"><div className="set-chips">{TASK_TYPES.map(t => <button key={t} className={`set-chip ${pref.types.includes(t) ? "on" : ""}`} aria-pressed={pref.types.includes(t)} onClick={() => updatePreference(s.id, { types: pref.types.includes(t) ? pref.types.filter(x => x !== t) : [...pref.types, t] })}>{t}</button>)}</div></Field>
      <Field label="权限模式" hint="仅保存偏好；不改变原生 CLI 审批或绕过执行门禁。"><select className="select" aria-label={`${s.id} 权限模式`} value={pref.permission} onChange={e => updatePreference(s.id, { permission: e.target.value })}>{!["default", "plan", "agent", "auto", "full"].includes(pref.permission) && <option>{pref.permission}</option>}<option value="default">默认</option><option value="plan">规划</option><option value="agent">代理</option><option value="auto">自动审批（执行未接入）</option><option value="full">全自动（执行未接入）</option></select></Field>
      {/* CR-053：命令工具（Shell）分组——位于权限模式之后、保存按钮之前；按能力分层渲染，不伪造可选。 */}
      <div className="set-shell-group" aria-busy={st?.detecting ? "true" : undefined}>
        <div className="set-shell-h"><b>命令工具（Shell）</b><span className={`tag ${cap.cls}`}>{cap.tag}</span><span className="spacer" /><span className="set-shell-caption">{checkedAtText}</span><button type="button" className="btn sm" disabled={st?.detecting || !!pending[`shell:${s.id}`] || !!pending[s.id]} onClick={() => redetectShell(s.id)}>重新检测</button></div>
        {st?.detectError && <p className="set-shell-err" role="alert">检测失败：{st.detectError}；已保留上次成功值，未当作「自动」处理。</p>}
        {st?.saveError && <p className="set-shell-err" role="alert">保存失败：{st.saveError}；已保留上次成功值。</p>}
        {s.id === "grok" ? <>
          <div className="set-shell-readonly"><span>自动（CLI 默认）</span>{best && <span className="mono">{best.label} · {best.path}{best.version ? ` · ${best.version}` : ""}</span>}<span className="set-shell-caption">已检测</span></div>
          <p className="set-shell-note"><span className="dot" /><span>Grok CLI 未提供 Shell 配置项，本版只展示检测结果，不提供选择，也不伪造「已切换」。</span></p>
        </> : <>
          {st?.detecting && <div className="set-shell-checking"><span className="set-shell-spinner" />正在检测命令工具与版本…</div>}
          {!st && <p className="set-shell-caption">正在打开命令工具检测…</p>}
          {st && !st.candidates && !st.detecting && !st.detectError && <p className="set-shell-caption">尚未检测命令工具。</p>}
          {st?.candidates && <fieldset className="set-shell-opts" disabled={st.detecting || !!pending[s.id]} aria-label={`${sdkName(s.id)} 命令工具候选`}>
            <label className={`set-shell-opt ${st.selected === "auto" ? "sel" : ""}`}>
              <input type="radio" className="set-shell-radio" name={`shell-${s.id}`} value="auto" checked={st.selected === "auto"} onChange={() => selectShell(s.id, "auto")} />
              <span className="set-shell-dot" aria-hidden="true" />
              <span className="set-shell-main"><b>自动（CLI 默认）</b><small>{s.id === "claude" ? "由 Claude Code 自行选择；优先固定位置的 PowerShell 7" : "由 Codex 自行选择"}</small></span>
            </label>
            {st.candidates.map(c => {
              const isSavedKind = st.setting?.mode === c.kind && st.setting.mode !== "auto";
              const rowMissing = isSavedKind && st.selected === c.kind && (st.missing || !c.available);
              const radioDisabled = !c.available && !(isSavedKind && !st.missing);
              const pathShown = isSavedKind && st.selected === c.kind && st.missing ? st.setting!.path : c.path;
              const statusCls = rowMissing ? "bad" : c.available ? "good" : "";
              const statusText = rowMissing ? "未找到" : c.available ? "检测到" : "不可用";
              return <label key={c.kind} className={`set-shell-opt ${st.selected === c.kind ? "sel" : ""} ${rowMissing ? "bad" : ""}`}>
                <input type="radio" className="set-shell-radio" name={`shell-${s.id}`} value={c.kind} disabled={radioDisabled} checked={st.selected === c.kind} onChange={() => selectShell(s.id, c.kind)} />
                <span className="set-shell-dot" aria-hidden="true" />
                <span className="set-shell-main"><b>{c.label} {statusText && <span className={`tag ${statusCls}`}>{statusText}</span>}</b><small>{rowMissing ? `${pathShown} · 未找到` : `${pathShown || c.detail || "未找到"}${c.available && c.version ? ` · ${c.version}` : ""}${!c.available && c.detail ? ` · ${c.detail}` : ""}`}</small></span>
              </label>;
            })}
          </fieldset>}
          {s.id === "claude" && <p className="set-shell-note"><span className="dot" /><span>Claude Code 只从固定绝对位置识别 PowerShell（不查 PATH）；本版不支持自定义安装路径。选择 Git Bash 时以 CLAUDE_CODE_GIT_BASH_PATH 指定 bash.exe。</span></p>}
          {s.id === "codex" && <p className="set-shell-note warn"><span className="dot" /><span>Codex 通过环境变量传递 Shell 选择，语义待实测；实测通过前不承诺生效，保存只记录偏好。派发时带 --ignore-user-config，用户 config.toml 里的相关配置不会生效。</span></p>}
          {selectedSavedMissing && <p className="set-shell-note warn" role="alert"><span className="dot" /><span>所选命令工具已不存在：请重新检测或改选「自动」。保存已禁用，不会静默回落到其他 Shell。</span></p>}
        </>}
      </div>
      <div className="row"><button className="btn sm primary" disabled={saveDisabled} onClick={() => operation(s.id, async () => {
        if (s.id !== "grok") {
          const st2 = shell[s.id];
          if (!st2?.setting || st2.detecting || !st2.candidates) throw new Error("命令工具尚未检测完成，保存已取消");
          const sel = st2.selected;
          const path = sel === "auto" ? null : (st2.candidates.find(c => c.kind === sel)?.path ?? null);
          let saved: api.ShellSetting;
          try {
            saved = await api.cliShellSave(s.id, sel, path);
          } catch (e) {
            setShell(prev => ({ ...prev, [s.id]: { ...(prev[s.id] || EMPTY_SHELL), saveError: errMsg(e) } }));
            throw e;
          }
          await api.setSetting(`cli.preferences.${s.id}`, JSON.stringify(pref));
          window.dispatchEvent(new CustomEvent("app:settings-changed", { detail: { keys: [`cli.preferences.${s.id}`, `cli.shell.${s.id}`] } }));
          setShell(prev => ({ ...prev, [s.id]: { ...(prev[s.id] || EMPTY_SHELL), setting: saved, missing: false, saveError: "", savedMsg: `已保存 · ${hhmm(Date.now())}`, touched: false, selected: saved.mode } }));
          toast("CLI 偏好与命令工具已保存；仅对之后的新会话生效，不改变原生权限执行");
          return;
        }
        await api.setSetting(`cli.preferences.${s.id}`, JSON.stringify(pref));
        window.dispatchEvent(new CustomEvent("app:settings-changed", { detail: { keys: [`cli.preferences.${s.id}`] } }));
        toast("CLI 偏好已保存；不代表调度或原生权限已经执行");
      })}>保存</button><button className="btn sm" onClick={refresh}>重新检测</button><span className="set-caption">{footMsg(s)}</span></div>
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
