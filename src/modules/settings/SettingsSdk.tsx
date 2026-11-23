import { CliLogo } from "@/components/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "@/api";
import type { ModelCandidate, SdkJob, SdkState } from "@/api";
import { Field, useToast } from "@/components/ui";
import { errMsg } from "./shared";
import { CliRoute, PermissionSelect, emptyRoute, parseRoute, type CliDetection, type RouteConfig } from "./CliRoute";
import { SettingsConfirm, SettingsIcon, SettingsSwitch } from "./SettingsDialog";

/**
 * CR-059 D/E：CLI 管理与 SDK 管理。
 *
 * D1～D5：无任务难度/CLI 级类型；任务模型路由（单行折叠，0～5 槽＋兜底）；
 *         中文权限挡位与 AI 侧栏一致；打开即渲染缓存、后台并发刷新、TTL 10 分钟短路。
 * E1～E4：官方 logo＋名称＋包名＋版本＋箭头的卡片；版本下拉最新 10 稳定版＋当前补入；
 *         版本列表 HTTP 直连 registry（后端实现），不 spawn npm。
 */

const TERMINAL = new Set(["done", "failed", "cancelled", "timeout"]);
const PHASE_LABEL: Record<SdkJob["phase"], string> = { queued: "排队中", running: "执行中", done: "已完成", failed: "失败", cancelled: "已取消", timeout: "已超时" };
const sdkName = (id: string) => ({ claude: "Claude Code", codex: "Codex", grok: "Grok CLI" }[id] || id);
const SDK_IDS = ["claude", "codex", "grok"] as const;

interface CliPreference { route: RouteConfig; permission: string }

/** 旧偏好兼容：丢弃 minDifficulty/types；slots 变长数组 0～5。 */
function readPreference(raw: string | null): { preference: CliPreference; migrated: boolean } {
  if (!raw) return { preference: { route: emptyRoute(), permission: "default" }, migrated: false };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    const { route, trimmed } = parseRoute(parsed);
    const legacy = "minDifficulty" in parsed || "types" in parsed || "model" in parsed || "effort" in parsed;
    return {
      preference: {
        route,
        permission: typeof parsed.permission === "string" ? parsed.permission : "default",
      },
      migrated: legacy || trimmed,
    };
  } catch {
    return { preference: { route: emptyRoute(), permission: "default" }, migrated: false };
  }
}

export function SettingsSdk() {
  const toast = useToast();
  const [tab, setTab] = useState<"cli" | "sdk">("cli");
  const [registry, setRegistry] = useState("");
  const [registryReady, setRegistryReady] = useState(false);

  // 缓存先行：首帧来自 sdk_snapshot，随后逐项并发刷新。
  const [detections, setDetections] = useState<Record<string, CliDetection>>({});
  const [snapshotAt, setSnapshotAt] = useState<number | null>(null);
  const [bootError, setBootError] = useState("");

  const [expanded, setExpanded] = useState<string | null>(null);
  const [cliOpen, setCliOpen] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<Record<string, CliPreference>>({});
  const [prefReady, setPrefReady] = useState<Record<string, boolean>>({});
  const [models, setModels] = useState<ModelCandidate[]>([]);
  const [versions, setVersions] = useState<Record<string, string[]>>({});
  const [versionLoading, setVersionLoading] = useState<Record<string, boolean>>({});
  const [versionError, setVersionError] = useState<Record<string, string>>({});
  const [versionSelected, setVersionSelected] = useState<Record<string, string>>({});
  const [versionsPrefetched, setVersionsPrefetched] = useState(false);
  const [jobs, setJobs] = useState<Record<string, { id: string; at: number }>>({});
  const [jobView, setJobView] = useState<Record<string, SdkJob | null>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [uninstallTarget, setUninstallTarget] = useState<SdkState | null>(null);
  const pendingRef = useRef(new Set<string>());
  const jobsRef = useRef(jobs); jobsRef.current = jobs;
  const alive = useRef(true);
  const detectRef = useRef(new Set<string>());
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  /** 首次挂载：缓存快照立刻上屏（无整页 loading），再并发逐项刷新。 */
  const boot = useCallback(async () => {
    setBootError("");
    try {
      const snapshot = await api.sdkSnapshot();
      if (!alive.current) return;
      setSnapshotAt(snapshot.checkedAt);
      setDetections(previous => {
        const next = { ...previous };
        for (const state of snapshot.states) {
          next[state.id] = { state, checking: false, error: "" };
        }
        return next;
      });
    } catch (e) {
      if (alive.current) setBootError(errMsg(e));
    }
    await Promise.all(SDK_IDS.map(id => detect(id, false)));
    if (alive.current) setSnapshotAt(Date.now());
  }, []);

  const detect = useCallback(async (id: string, force: boolean) => {
    if (detectRef.current.has(id)) return;
    detectRef.current.add(id);
    const mark = (checking: boolean) => setDetections(previous => {
      const current = previous[id];
      if (!current) return previous;
      return { ...previous, [id]: { ...current, checking } };
    });
    // 无缓存时先给占位，保证「检测中…」逐卡可见。
    setDetections(previous => previous[id] ? previous : {
      ...previous,
      [id]: {
        state: { id, package: "", enabled: true, installState: "checking", version: null, path: null },
        checking: true,
        error: "",
      },
    });
    mark(true);
    try {
      const state = await api.sdkDetectOne(id, force);
      if (!alive.current) return;
      setDetections(previous => ({ ...previous, [id]: { state, checking: false, error: "" } }));
    } catch (e) {
      // 单卡失败不拖累其他；保留上次成功值并显式报错。
      if (!alive.current) return;
      setDetections(previous => {
        const current = previous[id];
        return current ? { ...previous, [id]: { ...current, checking: false, error: errMsg(e) } } : previous;
      });
      if (force) toast(`${sdkName(id)} 检测失败：${errMsg(e)}`, "err");
    } finally {
      detectRef.current.delete(id);
    }
  }, [toast]);

  const detectAll = useCallback(async (force: boolean) => {
    await Promise.all(SDK_IDS.map(id => detect(id, force)));
    if (alive.current && force) setSnapshotAt(Date.now());
  }, [detect]);

  useEffect(() => { void boot(); }, [boot]);
  useEffect(() => {
    api.getSetting("npmRegistry").then(v => { if (alive.current) { setRegistry(v || ""); setRegistryReady(true); } })
      .catch(() => { if (alive.current) { setRegistryReady(true); setBootError("npm registry 读取失败，保存已禁用"); } });
    const readModels = () => api.modelCandidates().then(data => { if (alive.current) setModels(data); }).catch(() => {});
    readModels();
    window.addEventListener("app:settings-changed", readModels);
    return () => window.removeEventListener("app:settings-changed", readModels);
  }, []);

  // 偏好读取（逐 CLI，互不阻塞）
  useEffect(() => {
    for (const id of SDK_IDS) {
      if (prefReady[id]) continue;
      api.getSetting(`cli.preferences.${id}`).then(value => {
        if (!alive.current) return;
        const { preference, migrated } = readPreference(value);
        setPreferences(previous => ({ ...previous, [id]: preference }));
        setPrefReady(previous => ({ ...previous, [id]: true }));
        if (migrated) {
          // CR-059 §4.4：旧结构（最低难度/CLI 级类型/固定 5 槽）读取后按新结构落盘一次。
          void api.setSetting(`cli.preferences.${id}`, JSON.stringify(preference)).catch(() => {});
        }
      }).catch(() => {
        if (!alive.current) return;
        setPrefReady(previous => ({ ...previous, [id]: true }));
        toast(`${sdkName(id)} 的偏好读取失败，不允许覆盖已有值`, "err");
      });
    }
  }, [prefReady, toast]);

  const loadVersions = useCallback(async (id: string) => {
    if (pendingRef.current.has(`versions:${id}`)) return;
    pendingRef.current.add(`versions:${id}`);
    setVersionLoading(previous => ({ ...previous, [id]: true }));
    setVersionError(previous => { const next = { ...previous }; delete next[id]; return next; });
    try {
      const data = await api.sdkVersions(id);
      if (alive.current) setVersions(previous => ({ ...previous, [id]: data }));
    } catch (e) {
      if (alive.current) setVersionError(previous => ({ ...previous, [id]: errMsg(e) }));
    } finally {
      pendingRef.current.delete(`versions:${id}`);
      if (alive.current) setVersionLoading(previous => ({ ...previous, [id]: false }));
    }
  }, []);

  /* CR-059 E3/E4：SDK 页签首次打开即后台预取版本列表（不阻塞首帧）。 */
  useEffect(() => {
    if (tab !== "sdk" || versionsPrefetched) return;
    setVersionsPrefetched(true);
    for (const id of SDK_IDS) void loadVersions(id);
  }, [tab, versionsPrefetched, loadVersions]);

  useEffect(() => {
    if (!Object.keys(jobs).length) return;
    let polling = false;
    const interval = window.setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        for (const [sdkId, job] of Object.entries(jobsRef.current)) {
          if (Date.now() - job.at > 15 * 60_000) {
            setJobs(previous => { const next = { ...previous }; delete next[sdkId]; return next; });
            toast("SDK 任务超过 15 分钟；停止跟踪不等于已取消后端任务", "warn"); continue;
          }
          try {
            const data = await api.sdkJob(job.id);
            if (!alive.current) return;
            setJobView(previous => ({ ...previous, [sdkId]: data }));
            if (!data || TERMINAL.has(data.phase)) {
              setJobs(previous => { const next = { ...previous }; delete next[sdkId]; return next; });
              if (!data) toast("SDK 任务记录不可用，请重新检测实际状态", "warn");
              else if (data.phase !== "done") toast(data.error || PHASE_LABEL[data.phase], "warn");
              await detect(sdkId, true);
            }
          } catch { /* 后续轮询继续跟踪，不把请求失败视为任务完成。 */ }
        }
      } finally { polling = false; }
    }, 2000);
    return () => window.clearInterval(interval);
  }, [jobs, detect, toast]);

  const operation = async (id: string, action: () => Promise<void>) => {
    if (pendingRef.current.has(id)) return;
    pendingRef.current.add(id); setPending(previous => ({ ...previous, [id]: true }));
    try { await action(); } catch (e) { toast(errMsg(e), "err"); }
    finally { pendingRef.current.delete(id); if (alive.current) setPending(previous => ({ ...previous, [id]: false })); }
  };

  const runJob = (state: SdkState, kind: "install" | "uninstall") => operation(state.id, async () => {
    if (jobsRef.current[state.id]) return;
    const id = await api.sdkRunJob(state.id, kind, kind === "install" ? versionSelected[state.id] || undefined : undefined);
    const entry = { id, at: Date.now() };
    jobsRef.current = { ...jobsRef.current, [state.id]: entry };
    setJobs(previous => ({ ...previous, [state.id]: entry }));
    setJobView(previous => ({ ...previous, [state.id]: null }));
    setUninstallTarget(null);
  });
  const toggle = (state: SdkState, enabled: boolean) => operation(state.id, async () => {
    await api.sdkSetEnabled(state.id, enabled);
    setDetections(previous => previous[state.id]
      ? { ...previous, [state.id]: { ...previous[state.id], state: { ...previous[state.id].state, enabled } } }
      : previous);
    window.dispatchEvent(new CustomEvent("app:settings-changed", { detail: { keys: ["sdks"] } }));
  });

  const updatePreference = (id: string, patch: Partial<CliPreference>) =>
    setPreferences(previous => ({ ...previous, [id]: { ...(previous[id] || { route: emptyRoute(), permission: "default" }), ...patch } }));

  /** 兼容协议过滤：claude→anthropic，codex/grok→openai（与会话候选口径一致）。 */
  const compatibleModels = (id: string) => models.filter(m => {
    const extra = m as ModelCandidate & { image?: boolean; imageGen?: boolean; text?: boolean };
    if (extra.image || extra.imageGen || extra.text === false) return false;
    return id === "claude" ? m.protocol === "anthropic" : m.protocol === "openai";
  });

  const cliBody = (state: SdkState) => {
    const preference = preferences[state.id] || { route: emptyRoute(), permission: "default" };
    const detection = detections[state.id];
    const disabled = !prefReady[state.id] || !!pending[state.id];
    return <div className="set-cli-body"><fieldset className="set-fieldset" disabled={disabled}>
      <p className="caption">由主 agent 决定使用哪个 CLI；这里只配置该 CLI 内「哪类任务用哪个模型」。模型不可用时使用兜底模型。</p>
      <CliRoute cliId={state.id} cliName={sdkName(state.id)} route={preference.route}
        models={compatibleModels(state.id)} disabled={disabled}
        onChange={route => updatePreference(state.id, { route })} />
      <div>
        <label className="set-field-label">权限模式</label>
        <PermissionSelect cliId={state.id} value={preference.permission} disabled={disabled}
          onChange={permission => updatePreference(state.id, { permission })} />
        <p className="caption">与 AI 侧栏权限挡位一致；自动审核 / 完全访问在原生通道核验前不可选。</p>
      </div>
      <div className="row">
        <button className="btn sm primary" disabled={disabled} onClick={() => operation(state.id, async () => {
          await api.setSetting(`cli.preferences.${state.id}`, JSON.stringify(preference));
          window.dispatchEvent(new CustomEvent("app:settings-changed", { detail: { keys: [`cli.preferences.${state.id}`] } }));
          toast("CLI 偏好已保存；仅对之后的新会话生效，不代表调度或原生权限已执行");
        })}>保存</button>
        <button type="button" className="btn sm" disabled={disabled || detection?.checking}
          onClick={() => operation(state.id, async () => {
            const value = await api.getSetting(`cli.preferences.${state.id}`);
            if (!alive.current) return;
            const { preference: saved } = readPreference(value);
            setPreferences(previous => ({ ...previous, [state.id]: saved }));
            toast("已放弃未保存修改");
          })}>放弃修改</button>
        <button type="button" className="btn sm" disabled={detection?.checking} onClick={() => void detect(state.id, true)}>重新检测</button>
        <span className="caption">保存仅影响之后的新会话。</span>
      </div>
    </fieldset></div>;
  };

  const statusOf = (state: SdkState) => {
    const detection = detections[state.id];
    const installed = detection?.state.installState === "installed";
    const text = !detection ? "检测中…" : installed ? "已安装" : detection.state.installState === "error" ? "检测失败" : "未安装";
    const tone = installed ? "good" : detection?.state.installState === "error" ? "bad" : "";
    return { detection, installed, text, tone };
  };

  /** CR-059 E3：最新 10 稳定版倒序 + 当前版补入。 */
  const versionOptions = (state: SdkState) => {
    const list = (versions[state.id] || []).slice(0, 10);
    const current = (state.version || "").replace(/^v/, "");
    const options = list.map((v, index) => <option key={v} value={v}>{v}{index === 0 ? "（最新稳定）" : ""}</option>);
    if (current && current !== "未知" && !list.includes(current)) {
      options.push(<option key={`current-${current}`} value={current}>{current}（当前）</option>);
    }
    return options;
  };

  const sdkBody = (state: SdkState) => {
    const { installed } = statusOf(state);
    const job = jobs[state.id];
    const view = jobView[state.id];
    const loading = versionLoading[state.id];
    const failure = versionError[state.id];
    const latest = versions[state.id]?.[0];
    return <div className="set-sdk-body">
      <Field label="目标版本">
        <div className="row">
          <select className="select" aria-label={`${state.id} 目标版本`} value={versionSelected[state.id] || ""}
            disabled={!!job || !!pending[state.id] || loading}
            onChange={event => setVersionSelected(previous => ({ ...previous, [state.id]: event.target.value }))}>
            {loading ? <option value="">最新稳定版（加载中…）</option>
              : failure ? <option value="">版本列表获取失败，点击刷新重试</option>
                : versionOptions(state)}
          </select>
          <button className="btn sm" disabled={loading} onClick={() => void loadVersions(state.id)}>
            <SettingsIcon name="refresh" />{loading ? "加载中…" : "刷新版本"}
          </button>
        </div>
        <p className="caption">只列正式版（不含 alpha／beta）· 最新 10 个稳定版，当前版不在其中时补入。</p>
      </Field>
      <div className="row">
        <button className="btn sm" disabled>当前版本 {state.version || "未知"}</button>
        {installed && <button className="btn sm danger" disabled={!!job || !!pending[state.id]} onClick={() => setUninstallTarget(state)}>卸载</button>}
        <button className="btn sm" disabled={!!job || !!pending[state.id]} onClick={() => void detect(state.id, true)}>重新检测</button>
        <button className="btn sm primary" disabled={!!job || !!pending[state.id]} onClick={() => runJob(state, "install")}>
          {installed ? "安装目标版本" : "安装"}
        </button>
        {job && <button className="btn sm" disabled={pending[state.id]} onClick={() => operation(state.id, async () => {
          await api.sdkCancel(job.id); toast("已请求取消，等待后端终态");
        })}>取消任务</button>}
      </div>
      <div className="caption">当前版本 {state.version || "未知"} · 最新稳定 {latest || (failure ? "未取到" : "尚未查询")}</div>
      <div className="set-sdk-path mono">{state.path || "路径尚未检测到"}</div>
      {view && <div className="caption">任务：{PHASE_LABEL[view.phase]}
        {view.error && <p className="set-err">{view.error}</p>}
        <pre className="set-pre">{view.logs.slice(-8).join("\n") || "暂无日志"}</pre>
      </div>}
    </div>;
  };

  const cliList = SDK_IDS.map(id => {
    const detection = detections[id];
    const state = detection?.state ?? { id, package: "", enabled: true, installState: "checking" as const, version: null, path: null };
    const { installed, text, tone } = statusOf(state);
    const open = tab === "cli" ? cliOpen === id : expanded === id;
    const job = jobs[id];
    return <div className="set-sdk-card" key={id}>
      <div className="set-sdk-head">
        <button className="set-sdk-select" aria-expanded={open}
          onClick={() => tab === "cli" ? setCliOpen(open ? null : id) : setExpanded(open ? null : id)}>
          <CliLogo id={id} size={24} className="set-cli-logo" />
          <span className="set-sdk-info"><b>{sdkName(id)}
            <span className={`tag ${tone}`}>{text}</span>
            {job && <span className="tag blue">{PHASE_LABEL[jobView[id]?.phase || "queued"]}</span>}
          </b><span>{state.package || "包名待检测"}</span></span>
          <span className="caption">{state.version || "版本未知"}</span>
          <SettingsIcon name={open ? "up" : "down"} />
        </button>
        {tab === "cli" && <SettingsSwitch checked={state.enabled} disabled={!installed || !!job || !!pending[id]}
          label={`启用 CLI ${sdkName(id)}`} onChange={value => toggle(state, value)} />}
      </div>
      {detection?.error && <p className="set-err" role="alert">检测失败：{detection.error}（保留上次结果）</p>}
      {open && (tab === "cli" ? cliBody(state) : sdkBody(state))}
    </div>;
  });

  return <>
    <div className="set-tabs" role="tablist" aria-label="SDK 与 CLI">
      {([["cli", "CLI 管理"], ["sdk", "SDK 管理"]] as const).map(([id, text]) =>
        <button role="tab" key={id} aria-selected={tab === id} onClick={() => setTab(id)}>{text}</button>)}
    </div>
    {bootError && <div className="set-note" role="alert">{bootError}<button className="btn sm" onClick={() => void detectAll(true)}>重试</button></div>}
    {tab === "sdk" && <div className="set-registry">
      <label>npm registry</label>
      <div className="row">
        <input className="input" value={registry} aria-label="npm registry" disabled={!registryReady || !!pending.registry}
          placeholder="https://registry.npmjs.org"
          onChange={event => setRegistry(event.target.value)} />
        <button className="btn sm" disabled={!registryReady || !!pending.registry} onClick={() => operation("registry", async () => {
          const value = registry.trim();
          if (value) {
            const url = new URL(value);
            if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("registry 需为不含凭证的 HTTP(S) URL");
          }
          await api.setSetting("npmRegistry", value || null);
          setVersions({}); setVersionsPrefetched(false);
          toast("npm registry 已保存，后续安装与版本查询使用此配置");
        })}>保存</button>
        <button className="btn sm" disabled={!!pending.all} onClick={() => operation("all", () => detectAll(true))}>全部重新检测</button>
      </div>
      <p className="caption">可选镜像源；只影响后续 npm 安装与版本查询。</p>
    </div>}
    <p className="caption cli-load-note">
      打开即显示上次缓存（{snapshotAt ? new Date(snapshotAt).toLocaleTimeString() : "尚无"}），后台逐项刷新；「重新检测」强制刷新。
      新鲜缓存 10 分钟内直接复用。
    </p>
    <div className="set-sdk-cards">{cliList}</div>
    {uninstallTarget && <SettingsConfirm title="卸载 SDK"
      message={`将从全局 npm 环境卸载 ${uninstallTarget.package}。确定继续？`}
      busy={!!pending[uninstallTarget.id]}
      onCancel={() => setUninstallTarget(null)}
      onOk={() => runJob(uninstallTarget, "uninstall")} />}
  </>;
}
