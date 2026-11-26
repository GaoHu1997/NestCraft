import { CliLogo } from "@/components/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "@/api";
import type { ModelCandidate, SdkJob, SdkState } from "@/api";
import { Field, useToast } from "@/components/ui";
import { errMsg } from "./shared";
import { CliRoute, PermissionSelect, emptyRoute, parseRoute, type CliDetection, type RouteConfig } from "./CliRoute";
import { SettingsConfirm, SettingsIcon, SettingsSwitch } from "./SettingsDialog";
import {
  actionLabel, busyJob, finishInstant, beginInstant, hydrate, onOperationSettled, stopTracking,
  subscribe, trackJob, type SdkOperation, type SdkTrackerSnapshot,
} from "./sdkTaskTracker";
import "./cr085-sdk.css";

/**
 * CR-085 D/E：CLI 管理与 SDK 管理。
 *
 * - 权限挡位按各 CLI 自身能力（与 AI 侧栏同源），未核验挡位禁用并给原因；
 * - 任务模型路由：单行折叠，0～5 槽＋兜底；兜底可跟随主 agent 或指定模型，
 *   思考档位只来自所选模型已配置的档位，切换模型清理失效档位；
 * - SDK 折叠头：过期显示「当前 → 最新」＋「有新版本」，只在未安装时标「未安装」；
 * - 安装与版本合为一个按钮；任务从发起跟踪到真实终态，期间禁用重复操作；
 * - 右下「操作记录」保留最近五次操作与脱敏日志；
 * - 「刷新」一次完成本机检测与版本列表，失败保留上次成功值。
 */

const SDK_IDS = ["claude", "codex", "grok"] as const;
const sdkName = (id: string) => ({ claude: "Claude Code", codex: "Codex", grok: "Grok CLI" }[id] || id);
const PHASE_LABEL: Record<SdkJob["phase"], string> = { queued: "排队中", running: "执行中", done: "已完成", failed: "失败", cancelled: "已取消", timeout: "已超时" };
const EMPTY_TRACKER: SdkTrackerSnapshot = { tracking: {}, operations: [] };

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
      preference: { route, permission: typeof parsed.permission === "string" ? parsed.permission : "default" },
      migrated: legacy || trimmed,
    };
  } catch {
    return { preference: { route: emptyRoute(), permission: "default" }, migrated: false };
  }
}

const fmtTime = (at: number) => new Date(at).toLocaleTimeString("zh-CN", { hour12: false });

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
  const [tracker, setTracker] = useState<SdkTrackerSnapshot>(EMPTY_TRACKER);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [recordSelected, setRecordSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [uninstallTarget, setUninstallTarget] = useState<SdkState | null>(null);
  const pendingRef = useRef(new Set<string>());
  const alive = useRef(true);
  const detectRef = useRef(new Set<string>());
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  /* 模块级任务追踪：设置关闭后继续轮询，重开后恢复显示。 */
  useEffect(() => {
    void hydrate();
    const unsubscribe = subscribe(setTracker);
    return unsubscribe;
  }, []);

  const detect = useCallback(async (id: string, force: boolean): Promise<string | null> => {
    if (detectRef.current.has(id)) return null;
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
      if (alive.current) setDetections(previous => ({ ...previous, [id]: { state, checking: false, error: "" } }));
      return null;
    } catch (e) {
      // 单卡失败不拖累其他；保留上次成功值并显式报错。
      const message = errMsg(e);
      if (alive.current) {
        setDetections(previous => {
          const current = previous[id];
          return current ? { ...previous, [id]: { ...current, checking: false, error: message } } : previous;
        });
      }
      return message;
    } finally {
      detectRef.current.delete(id);
    }
  }, []);

  /** 首次挂载：缓存快照立刻上屏（无整页 loading），再并发逐项刷新。 */
  const boot = useCallback(async () => {
    setBootError("");
    try {
      const snapshot = await api.sdkSnapshot();
      if (alive.current) {
        setSnapshotAt(snapshot.checkedAt);
        setDetections(previous => {
          const next = { ...previous };
          for (const state of snapshot.states) next[state.id] = { state, checking: false, error: "" };
          return next;
        });
      }
    } catch (e) {
      if (alive.current) setBootError(errMsg(e));
    }
    await Promise.all(SDK_IDS.map(id => detect(id, false)));
    if (alive.current) setSnapshotAt(Date.now());
  }, [detect]);

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
        if (migrated) void api.setSetting(`cli.preferences.${id}`, JSON.stringify(preference)).catch(() => {});
      }).catch(() => {
        if (!alive.current) return;
        setPrefReady(previous => ({ ...previous, [id]: true }));
        toast(`${sdkName(id)} 的偏好读取失败，不允许覆盖已有值`, "err");
      });
    }
  }, [prefReady, toast]);

  const loadVersions = useCallback(async (id: string): Promise<string | null> => {
    if (pendingRef.current.has(`versions:${id}`)) return null;
    pendingRef.current.add(`versions:${id}`);
    setVersionLoading(previous => ({ ...previous, [id]: true }));
    setVersionError(previous => { const next = { ...previous }; delete next[id]; return next; });
    try {
      const data = await api.sdkVersions(id);
      if (alive.current) setVersions(previous => ({ ...previous, [id]: data }));
      return null;
    } catch (e) {
      const message = errMsg(e);
      // 失败保留上一次成功的版本列表，只记录错误。
      if (alive.current) setVersionError(previous => ({ ...previous, [id]: message }));
      return message;
    } finally {
      pendingRef.current.delete(`versions:${id}`);
      if (alive.current) setVersionLoading(previous => ({ ...previous, [id]: false }));
    }
  }, []);

  /* CR-085 AC-06：SDK 页签首次打开即后台预取版本列表（不阻塞首帧）。 */
  useEffect(() => {
    if (tab !== "sdk" || versionsPrefetched) return;
    setVersionsPrefetched(true);
    for (const id of SDK_IDS) void loadVersions(id);
  }, [tab, versionsPrefetched, loadVersions]);

  /* 任务到达终态后刷新真实检测与版本，保证界面与后端一致。 */
  useEffect(() => onOperationSettled(id => {
    void detect(id, true);
    void loadVersions(id);
  }), [detect, loadVersions]);

  const operation = async (id: string, action: () => Promise<void>) => {
    if (pendingRef.current.has(id)) return;
    pendingRef.current.add(id); setPending(previous => ({ ...previous, [id]: true }));
    try { await action(); } catch (e) { toast(errMsg(e), "err"); }
    finally { pendingRef.current.delete(id); if (alive.current) setPending(previous => ({ ...previous, [id]: false })); }
  };

  /** CR-085 AC-06：一次刷新＝本机检测＋版本列表；两步分别保留旧成功值。 */
  const refresh = (id: string) => operation(`refresh:${id}`, async () => {
    if (pendingRef.current.has(`refresh-lock:${id}`)) return;
    pendingRef.current.add(`refresh-lock:${id}`);
    const opId = await beginInstant(id, "refresh");
    try {
      const [detectError, versionErrorValue] = await Promise.all([detect(id, true), loadVersions(id)]);
      const failures = [detectError, versionErrorValue].filter((value): value is string => Boolean(value));
      await finishInstant(opId, failures.length ? failures.join("；") : undefined);
      if (failures.length) toast(`${sdkName(id)} 刷新未完成：${failures.join("；")}（已保留上次结果）`, "warn");
    } finally {
      pendingRef.current.delete(`refresh-lock:${id}`);
    }
  });

  const runJob = (state: SdkState, kind: "install" | "uninstall", target?: string) => operation(state.id, async () => {
    if (busyJob(state.id)) return;
    const version = kind === "install" ? (target || versionSelected[state.id] || versions[state.id]?.[0] || undefined) : undefined;
    const id = await api.sdkRunJob(state.id, kind, version);
    await trackJob(state.id, id, kind, version ?? null);
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

  /** CR-099：模型候选为空时必须说明原因，否则用户只看到「未选择」。
   *  原因来自真实过滤口径：有无供应商、是否全部停用、该 CLI 需要的协议有没有可对话模型。 */
  const modelEmptyReason = (id: string): string => {
    if (!models.length) return "尚未配置供应商：先到「模型管理」新增供应商与文本模型。";
    const compatible = compatibleModels(id);
    if (compatible.length) return "";
    return id === "claude"
      ? "没有 Anthropic 协议的可对话模型：该 CLI 只认 Anthropic 端点，请检查供应商的 Anthropic 地址与密钥是否启用。"
      : "没有 OpenAI 协议的可对话模型：该 CLI 只认 Chat／Responses 端点，请检查端点与密钥的启用状态。";
  };

  const cliBody = (state: SdkState) => {
    const preference = preferences[state.id] || { route: emptyRoute(), permission: "default" };
    const detection = detections[state.id];
    const disabled = !prefReady[state.id] || !!pending[state.id];
    const emptyReason = modelEmptyReason(state.id);
    return <div className="set-cli-body"><fieldset className="set-fieldset" disabled={disabled}>
      <CliRoute cliId={state.id} cliName={sdkName(state.id)} route={preference.route}
        models={compatibleModels(state.id)} disabled={disabled}
        onChange={route => updatePreference(state.id, { route })} />
      {emptyReason && <p className="set-caption cr099-model-empty" role="status">{emptyReason}</p>}
      <div>
        <label className="set-field-label">权限模式</label>
        <PermissionSelect cliId={state.id} value={preference.permission} disabled={disabled}
          onChange={permission => updatePreference(state.id, { permission })} />
      </div>
      <div className="row">
        <button className="btn sm primary" disabled={disabled} onClick={() => operation(state.id, async () => {
          await api.setSetting(`cli.preferences.${state.id}`, JSON.stringify(preference));
          window.dispatchEvent(new CustomEvent("app:settings-changed", { detail: { keys: [`cli.preferences.${state.id}`] } }));
          toast("CLI 偏好已保存；仅对之后的新会话生效");
        })}>保存</button>
        <button type="button" className="btn sm" disabled={disabled}
          onClick={() => operation(state.id, async () => {
            const value = await api.getSetting(`cli.preferences.${state.id}`);
            if (!alive.current) return;
            const { preference: saved } = readPreference(value);
            setPreferences(previous => ({ ...previous, [state.id]: saved }));
            toast("已放弃未保存修改");
          })}>放弃修改</button>
        <button type="button" className="btn sm" disabled={!!pending[`refresh:${state.id}`]} onClick={() => refresh(state.id)}>刷新</button>
        {detection?.checking && <span className="caption">检测中…</span>}
      </div>
    </fieldset></div>;
  };

  /** 状态标签：只在未安装／检测中／失败时出现；最新已安装不标记。 */
  const statusOf = (state: SdkState) => {
    const detection = detections[state.id];
    const installed = detection?.state.installState === "installed";
    if (!detection) return { detection, installed: false, text: "检测中…", tone: "" };
    if (detection.state.installState === "error") return { detection, installed: false, text: "检测失败", tone: "bad" };
    if (!installed) return { detection, installed: false, text: "未安装", tone: "" };
    return { detection, installed: true, text: "", tone: "good" };
  };

  const ver = (value: string | null | undefined) => String(value || "").replace(/^v/, "");
  const latestOf = (id: string) => versions[id]?.[0];

  /** CR-085 AC-03：过期时折叠头显示「当前 → 最新」并标「有新版本」。 */
  const headlineVersion = (state: SdkState) => {
    const current = ver(state.version);
    const latest = ver(latestOf(state.id));
    const outdated = Boolean(current && latest && current !== latest);
    return { current, latest, outdated, label: outdated ? `${state.version} → v${latest}` : (state.version || "版本未知") };
  };

  /** CR-085 AC-04：目标版本等于当前版本时按钮禁用并直接展示「当前版本」。 */
  const installAction = (state: SdkState) => {
    const installed = state.installState === "installed";
    const current = ver(state.version);
    const target = ver(versionSelected[state.id] || latestOf(state.id) || "");
    const busy = !!busyJob(state.id) || !!pending[state.id];
    const upToDate = installed && Boolean(target) && target === current;
    const label = busy
      ? "处理中…"
      : !installed
        ? (target ? `安装到 v${target}` : "安装")
        : upToDate
          ? `当前版本 ${state.version}`
          : (target ? `升级到 v${target}` : "安装目标版本");
    return { installed, current, target, busy, upToDate, label };
  };

  const versionOptions = (state: SdkState) => {
    const list = (versions[state.id] || []).slice(0, 10);
    const current = ver(state.version);
    const options = list.map((v, index) => <option key={v} value={v}>{v}{index === 0 ? "（最新稳定）" : ""}</option>);
    if (current && current !== "未知" && !list.includes(current)) {
      options.push(<option key={`current-${current}`} value={current}>{current}（当前）</option>);
    }
    return options;
  };

  const sdkBody = (state: SdkState) => {
    const loading = versionLoading[state.id];
    const failure = versionError[state.id];
    const latest = latestOf(state.id);
    const action = installAction(state);
    const job = busyJob(state.id);
    return <div className="set-sdk-body">
      <Field label="目标版本">
        <div className="row">
          <select className="select" aria-label={`${state.id} 目标版本`} value={versionSelected[state.id] || ""}
            disabled={action.busy || loading}
            onChange={event => setVersionSelected(previous => ({ ...previous, [state.id]: event.target.value }))}>
            {!versionOptions(state).length && <option value="">{loading ? "版本列表加载中…" : failure ? "版本列表获取失败，点刷新重试" : "暂无版本"}</option>}
            {versionOptions(state)}
          </select>
          <button className="btn sm" disabled={action.busy || !!pending[`refresh:${state.id}`]} onClick={() => refresh(state.id)}>
            <SettingsIcon name="refresh" />{loading ? "加载中…" : "刷新"}
          </button>
        </div>
      </Field>
      <div className="row">
        <button className="btn sm primary" disabled={action.busy || !action.target || action.upToDate}
          onClick={() => runJob(state, "install", action.target)}>
          {action.label}
        </button>
        {action.installed && <button className="btn sm danger" disabled={action.busy} onClick={() => setUninstallTarget(state)}>卸载</button>}
      </div>
      {failure && <p className="set-err" role="alert">版本列表刷新失败：{failure}（保留上次结果）</p>}
      {job && <p className="caption">任务 {PHASE_LABEL[job.phase]}{job.phase !== "done" ? ` · ${job.logs.slice(-1)[0] ?? ""}` : ""}</p>}
      <div className="caption">当前版本 {state.version || "未知"} · 最新稳定 {latest || (failure ? "未取到" : "尚未查询")}</div>
      <div className="set-sdk-path mono">{state.path || "路径尚未检测到"}</div>
    </div>;
  };

  const cliList = SDK_IDS.map(id => {
    const detection = detections[id];
    const state = detection?.state ?? { id, package: "", enabled: true, installState: "checking" as const, version: null, path: null };
    const { installed, text, tone } = statusOf(state);
    const open = tab === "cli" ? cliOpen === id : expanded === id;
    const job = busyJob(id);
    const headline = tab === "sdk" ? headlineVersion(state) : null;
    return <div className="set-sdk-card" key={id}>
      <div className="set-sdk-head">
        <button className="set-sdk-select" aria-expanded={open}
          onClick={() => tab === "cli" ? setCliOpen(open ? null : id) : setExpanded(open ? null : id)}>
          <CliLogo id={id} size={24} className="set-cli-logo" />
          <span className="set-sdk-info"><b>{sdkName(id)}
            {headline?.outdated && <span className="tag warn">有新版本</span>}
            {text && <span className={`tag ${tone}`}>{text}</span>}
            {job && <span className="tag blue">{PHASE_LABEL[job.phase]}</span>}
          </b><span>{state.package || "包名待检测"}</span></span>
          <span className="caption">{headline ? headline.label : (state.version || "版本未知")}</span>
          <SettingsIcon name={open ? "chevronUp" : "chevronDown"} />
        </button>
        {tab === "cli" && <SettingsSwitch checked={state.enabled} disabled={!installed || !!job || !!pending[id]}
          label={`启用 CLI ${sdkName(id)}`} onChange={value => toggle(state, value)} />}
      </div>
      {detection?.error && <p className="set-err" role="alert">检测失败：{detection.error}（保留上次结果）</p>}
      {open && (tab === "cli" ? cliBody(state) : sdkBody(state))}
    </div>;
  });

  const operations = tracker.operations;
  const selectedRecord = operations.find(item => item.id === recordSelected) ?? operations[0] ?? null;

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
      </div>
    </div>}
    <div className="set-sdk-cards">{cliList}</div>
    {tab === "sdk" && <div className="cr085-sdk-records">
      <button type="button" className="btn sm cr085-sdk-records-toggle" aria-expanded={recordsOpen}
        onClick={() => setRecordsOpen(value => !value)}>
        <SettingsIcon name="history" />操作记录 {operations.length ? `· ${operations.length}` : ""}
      </button>
      {recordsOpen && <div className="cr085-sdk-records-panel" role="region" aria-label="SDK 操作记录">
        <header>
          <b>操作记录</b><span className="caption">最近 {operations.length} 次</span>
          <button type="button" className="set-icon-btn" aria-label="关闭操作记录" onClick={() => setRecordsOpen(false)}><SettingsIcon name="close" /></button>
        </header>
        {operations.length ? <div className="cr085-sdk-records-body">
          <ul className="cr085-sdk-records-list">
            {operations.map(item => <li key={item.id}>
              <button type="button" aria-current={selectedRecord?.id === item.id}
                onClick={() => setRecordSelected(item.id)}>
                <span className="cr085-rec-title">{sdkName(item.sdkId)} · {actionLabel(item.action)}{item.target ? ` v${ver(item.target)}` : ""}</span>
                <span className="cr085-rec-meta"><span>{fmtTime(item.at)}</span>
                  <span className={item.status === "error" ? "err" : item.status === "running" ? "run" : "ok"}>
                    {item.status === "running" ? "进行中" : item.status === "error" ? "失败" : "成功"}
                  </span></span>
              </button>
            </li>)}
          </ul>
          <div className="cr085-sdk-records-log">
            {selectedRecord ? <>
              <div className="cr085-rec-log-head">
                <b>{sdkName(selectedRecord.sdkId)} · {actionLabel(selectedRecord.action)}</b>
                <span className="caption">{fmtTime(selectedRecord.at)} · {selectedRecord.status === "running" ? "进行中" : selectedRecord.status === "error" ? "失败" : "成功"}</span>
              </div>
              {selectedRecord.error && <p className="set-err" role="alert">{selectedRecord.error}</p>}
              <pre className="set-pre cr085-rec-log">{selectedRecord.logs.join("\n") || "暂无日志"}</pre>
              {tracker.tracking[selectedRecord.sdkId] && <button type="button" className="btn sm" onClick={() => void stopTracking(selectedRecord.sdkId)}>
                停止跟踪本地任务
              </button>}
            </> : <p className="caption">暂无记录</p>}
          </div>
        </div> : <p className="caption">还没有操作记录。安装、卸载或刷新后会在此保留最近五次。</p>}
      </div>}
    </div>}
    {uninstallTarget && <SettingsConfirm title="卸载 SDK"
      message={`将从全局 npm 环境卸载 ${uninstallTarget.package}。确定继续？`}
      busy={!!pending[uninstallTarget.id]}
      onCancel={() => setUninstallTarget(null)}
      onOk={() => runJob(uninstallTarget, "uninstall")} />}
  </>;
}