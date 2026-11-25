import { Icon, CliLogo } from "@/components/icons";
import { useApp } from "@/store/app";
import { ResizeHandle, usePaneWidth } from "@/components/pane-resize";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EffortMap, ModelCandidate, SdkState } from "@/api";
import { EFFORT_ORDER, protocolAllowed } from "@/modules/settings/modelCapacity";
import type { CSSProperties, ReactNode } from "react";
import "./model-picker.css";
import { ChatConfigPopup, useChatOverlay } from "./overlay";

/** 展示名不改变保存的原始 key 或 wire 映射。未知自定义档位保留，不推断其强弱。 */
const EFFORT_ALIASES: Record<string, string> = { "关闭": "off", "低": "low", "中": "medium", "高": "high", "极高": "xhigh", "最高": "max", none: "off" };
const EFFORT_LABELS: Record<string, string> = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" };
function effortKind(value: string): string { return EFFORT_ALIASES[value.toLowerCase()] ?? value.toLowerCase(); }
export function displayEffort(value: string): string { return EFFORT_LABELS[effortKind(value)] ?? value; }
/** null 是“不下发参数”的有效档位；仅排序有效声明，未知档位稳定放在已知阶梯之后。 */
export function effectiveEfforts(efforts?: EffortMap): string[] {
  const rank = (key: string) => { const index = (EFFORT_ORDER as readonly string[]).indexOf(effortKind(key)); return index < 0 ? EFFORT_ORDER.length : index; };
  return Object.keys(efforts ?? {}).filter(k => k.length > 0 && (efforts![k] === null || typeof efforts![k] === "string" && !!efforts![k]?.trim())).sort((a, b) => rank(a) - rank(b));
}
export function supportsThinking(efforts?: EffortMap): boolean {
  return effectiveEfforts(efforts).some(k => k.toLowerCase() !== "off" && typeof efforts![k] === "string" && !!efforts![k]?.trim());
}
export type PermissionId = "default" | "plan" | "agent" | "auto" | "full";
export function permissionSupported(cliId?: string | null): boolean { return cliId === "claude" || cliId === "codex"; }
function permissionOptions(cliId: string | null | undefined) {
  const known = cliId === "claude" || cliId === "codex";
  return [
    { id: "default" as const, name: "默认模式", desc: "保留 CLI 原生审批边界", enabled: known },
    { id: "plan" as const, name: "规划模式", desc: cliId === "claude" ? "Claude plan：只读规划语义" : "Codex read-only sandbox：只读执行", enabled: known },
    { id: "agent" as const, name: "代理模式", desc: cliId === "claude" ? "Claude acceptEdits：自动接受编辑" : "Codex workspace-write：保留沙箱", enabled: known },
    { id: "auto" as const, name: "自动审核", desc: "当前版本未核验原生审查通道", enabled: false },
    { id: "full" as const, name: "完全访问", desc: "需要已核验隔离与托管策略", enabled: false },
  ];
}

const PERMISSIONS = permissionOptions;

/** CR-079：助理（平台主代理）专属权限档位，由平台工具白名单与运行策略决定，与 CLI 档位分开。 */
export type PlatformPermissionId = "readonly" | "limited" | "full";
export const PLATFORM_PERMISSIONS: { id: PlatformPermissionId; name: string; desc: string }[] = [
  { id: "readonly", name: "只读", desc: "仅读取/查询类工具，不写文件、不执行命令" },
  { id: "limited", name: "受限", desc: "白名单工具可读，写入与命令需逐次确认" },
  { id: "full", name: "完全访问", desc: "白名单内全部工具【谨慎使用】" },
];

/** 不扩大可用性：输入仍是后端有效候选；仅进行通道协议、生图排除与稳定身份去重。 */
export function compatibleModels(candidates: ModelCandidate[], cliId: string | null, runner: "cli" | "platform" = "cli"): ModelCandidate[] {
  const seen = new Set<string>();
  return candidates.filter(m => {
    const extra = m as ModelCandidate & { image?: boolean; imageGen?: boolean; text?: boolean; modalities?: string[] };
    if (!protocolAllowed(m.protocol, runner === "platform" ? null : cliId)) return false;
    if (extra.image || extra.imageGen || extra.text === false || extra.modalities?.includes("生图")) return false;
    const identity = `${m.providerId}\u0000${m.modelId}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function fmtCtx(n: number | null): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1_000_000) return `${Number.isInteger(n / 1_000_000) ? n / 1_000_000 : (n / 1_000_000).toFixed(1)}M`;
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}
function defaultEffort(m: ModelCandidate): string {
  const keys = effectiveEfforts(m.efforts);
  return m.defaultEffort && keys.includes(m.defaultEffort) ? m.defaultEffort : keys.find(k => k.toLowerCase() === "off") ?? keys[0] ?? "";
}

export function ModelPicker(props: {
  addControl?: ReactNode;
  sendControl?: ReactNode;
  cliId: string | null;
  providerId: string | null;
  modelId: string | null;
  effort: string | null;
  permissionId?: PermissionId;
  cliCandidates: SdkState[];
  models: ModelCandidate[];
  locked?: boolean;
  onChange: (patch: { cliId?: string; providerId?: string; modelId?: string; effort?: string; permissionId?: PermissionId }) => void | Promise<void>;
  /** CR-069：会话运行通道（缺省 cli）。 */
  runner?: "cli" | "platform";
  /** CR-069：平台通道可用性（存在可用的供应商+端点+密钥+文本模型）。 */
  platformAvailable?: boolean;
  onRunnerChange?: (runner: "cli" | "platform") => void;
  /** CR-079：助理专属权限档位。 */
  platformPermission?: PlatformPermissionId;
  onPlatformPermissionChange?: (next: PlatformPermissionId) => void;
}) {
  const overlay = useChatOverlay();
  const { setSettingsOpen } = useApp();
  const runnerRef = useRef<HTMLButtonElement>(null);
  const cliRef = useRef<HTMLButtonElement>(null);
  const permissionRef = useRef<HTMLButtonElement>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
  const modelGridRef = useRef<HTMLDivElement>(null);
  const providerPane = usePaneWidth(overlay.scopeId, "model-providers", {
    default: 112, min: 96, max: 180, side: "left", containerRef: modelGridRef,
    reserve: 8, minCenter: 140, visible: true, disabled: props.locked,
  });
  const { registerTrigger } = overlay;
  useLayoutEffect(() => {
    registerTrigger("runner", runnerRef.current);
    registerTrigger("cli", cliRef.current);
    registerTrigger("perm", permissionRef.current);
    registerTrigger("model", modelRef.current);
    return () => { registerTrigger("cli", null); registerTrigger("perm", null); registerTrigger("model", null); };
  }, [registerTrigger]);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState(props.providerId);
  const runner = props.runner ?? "cli";
  const platformRunner = runner === "platform";
  // 平台支持两种已配置协议；CLI继续按自身协议过滤。选择键不变，由后端解析有效combo。
  const models = useMemo(() => compatibleModels(props.models, props.cliId, runner), [props.models, props.cliId, runner]);
  const curModel = models.find(m => m.providerId === props.providerId && m.modelId === props.modelId) ?? null;
  const groups = useMemo(() => {
    const map = new Map<string, { id: string; name: string; models: ModelCandidate[] }>();
    for (const m of models) {
      if (!map.has(m.providerId)) map.set(m.providerId, { id: m.providerId, name: m.providerName, models: [] });
      map.get(m.providerId)!.models.push(m);
    }
    return [...map.values()];
  }, [models]);
  useEffect(() => {
    if (overlay.activeOverlay === "model") { setProvider(props.providerId ?? groups[0]?.id ?? null); setQuery(""); }
  }, [overlay.activeOverlay]);
  // CR-069：运行通道；平台会话不使用 CLI 与权限档位，边界由平台工具白名单决定。
  const platformOk = props.platformAvailable ?? false;
  const effortKeys = effectiveEfforts(curModel?.efforts);
  const selectedEffort = props.effort || curModel?.defaultEffort || "";
  const effortStale = !!selectedEffort && !!curModel && !effortKeys.includes(selectedEffort);
  const cliStale = !!props.cliId && !props.cliCandidates.some(c => c.id === props.cliId);
  const modelStale = !!props.modelId && !curModel;
  const effortLabel = effortStale ? `${displayEffort(selectedEffort)}（失效）` : !curModel ? "未配置" : effortKeys.length ? selectedEffort ? displayEffort(selectedEffort) : "未选择档位" : "默认";
  const providerLabel = curModel?.providerName ?? props.models.find(m => m.providerId === props.providerId)?.providerName ?? props.providerId ?? "未配置";
  const modelLabel = `${curModel?.displayName || props.modelId || "未配置"}${modelStale ? "（失效）" : ""}`;
  const fullModelLabel = `${providerLabel} · ${modelLabel} ${effortLabel}`;
  const currentProvider = groups.find(g => g.id === provider) ?? groups[0];
  const rows = currentProvider?.models.filter(m => `${m.displayName} ${m.modelId}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  const currentPermission = props.permissionId ?? "default";
  const permissions = PERMISSIONS(props.cliId);
  const selectedPermission = permissions.find(p => p.id === currentPermission) ?? permissions[0];
  const nativePermission = selectedPermission?.desc ?? "当前 CLI 权限映射未验证";
  const platformPermission = PLATFORM_PERMISSIONS.find(p => p.id === (props.platformPermission ?? "limited")) ?? PLATFORM_PERMISSIONS[1];
  return <>
    <div className="chat-controls-leading">
      {props.addControl}
    {!platformRunner && <button ref={cliRef} className={`chat-ctl-chip cli ${cliStale ? "stale" : ""}`} data-chat-overlay-trigger="cli" aria-haspopup="dialog" aria-controls={`${overlay.scopeId}-config-cli`} disabled={props.locked} aria-label={`切换 CLI：${props.cliId ?? "未配置"}`} title={props.locked ? "运行快照已锁定" : `切换 CLI：${props.cliId ?? "未配置"}${cliStale ? "（已失效）" : ""}`} aria-expanded={overlay.activeOverlay === "cli"} onClick={e => overlay.toggle("cli", e.currentTarget)}>
      <CliLogo id={props.cliId ?? "unknown"} size={16} />
      {!props.cliId && <span className="chat-ctl-label">选择 CLI</span>}
    </button>}
    {platformRunner
      ? <button ref={permissionRef} className="chat-ctl-chip perm" data-chat-overlay-trigger="perm" aria-haspopup="dialog" aria-controls={`${overlay.scopeId}-config-perm`} disabled={props.locked} aria-label="助理权限" title={props.locked ? "运行快照已锁定" : `助理权限：${platformPermission?.desc ?? "受限"}`} aria-expanded={overlay.activeOverlay === "perm"} onClick={e => overlay.toggle("perm", e.currentTarget)}><ShieldIcon />{platformPermission.name}</button>
      : <button ref={permissionRef} className="chat-ctl-chip perm" data-chat-overlay-trigger="perm" aria-haspopup="dialog" aria-controls={`${overlay.scopeId}-config-perm`} disabled={props.locked} aria-label="权限模式" title={props.locked ? "运行快照已锁定" : nativePermission} aria-expanded={overlay.activeOverlay === "perm"} onClick={e => overlay.toggle("perm", e.currentTarget)}><ShieldIcon />{selectedPermission?.name ?? "未配置"}</button>}
    </div>
    <div className="chat-controls-trailing">
    <button ref={modelRef} className={`chat-ctl-chip model ${modelStale || effortStale ? "stale" : ""}`} data-chat-overlay-trigger="model" aria-haspopup="dialog" aria-controls={`${overlay.scopeId}-config-model`} disabled={props.locked} aria-label={`选择模型：${fullModelLabel}`} title={`${fullModelLabel}${props.locked ? " · 运行／审批快照已锁定" : ""}`} aria-expanded={overlay.activeOverlay === "model"} onClick={e => overlay.toggle("model", e.currentTarget)}>
      <span className="chat-model-name ellipsis">{providerLabel} · {modelLabel}</span><span className="chat-model-effort">{effortLabel}</span><Icon name="chevronDown" size={12} />
    </button>
      {props.sendControl}
    </div>
    {overlay.activeOverlay === "runner" && <ChatConfigPopup name="runner" className="chat-runner-pop" label="运行通道"><div className="chat-pop-head">运行通道<button className="chat-iconbtn chat-pop-close" aria-label="关闭运行通道选择" onClick={() => overlay.close(true)}><Icon name="x" size={14} /></button></div>
      <button className={`chat-menu-row ${runner === "cli" ? "sel" : ""}`} disabled={props.locked} onClick={() => { props.onRunnerChange?.("cli"); overlay.close(true); }}><Icon name="terminal" size={14} /><span className="chat-menu-main"><b>CLI 进程</b></span>{runner === "cli" && <Icon name="check" size={14} />}</button>
      <button className={`chat-menu-row ${runner === "platform" ? "sel" : ""}`} disabled={props.locked || !platformOk} onClick={() => { if (platformOk) { props.onRunnerChange?.("platform"); overlay.close(true); } }}><Icon name="sparkles" size={14} /><span className="chat-menu-main"><b>平台主代理</b>{!platformOk && <span>不可用</span>}</span>{runner === "platform" && <Icon name="check" size={14} />}</button>
      {!platformOk && <button className="chat-menu-row" onClick={() => { setSettingsOpen(true); overlay.close(true); }}><Icon name="settings" size={14} /><span className="chat-menu-main"><b>打开模型供应商设置</b></span></button>}
    </ChatConfigPopup>}
    {overlay.activeOverlay === "cli" && <ChatConfigPopup name="cli" className="chat-cli-pop" label="切换 CLI"><div className="chat-pop-head">切换 CLI<button className="chat-iconbtn chat-pop-close" aria-label="关闭 CLI 选择" onClick={() => overlay.close(true)}><Icon name="x" size={14} /></button></div>
      {!props.cliCandidates.length && <div className="chat-menu-hint">没有已安装且启用的 CLI；请在设置 → SDK 管理安装并启用。未虚构可用引擎。</div>}
      {props.cliCandidates.map(c => <button className={`chat-menu-row ${c.id === props.cliId ? "sel" : ""}`} key={c.id} disabled={props.locked} onClick={() => { void props.onChange({ cliId: c.id }); overlay.close(true); }}><CliLogo id={c.id} size={20} /><span className="chat-menu-main"><b>{c.id}</b><span>{c.version ?? "版本未知"}</span></span>{c.id === props.cliId && <Icon name="check" size={14} />}</button>)}
      {props.locked && <div className="chat-menu-hint">运行快照已锁定，静止后才可修改。</div>}
    </ChatConfigPopup>}
    {overlay.activeOverlay === "perm" && <ChatConfigPopup name="perm" className="chat-perm-pop" label={platformRunner ? "助理权限" : "权限模式"}><div className="chat-pop-head">{platformRunner ? "助理权限" : "权限模式"}<button className="chat-iconbtn chat-pop-close" aria-label="关闭权限选择" onClick={() => overlay.close(true)}><Icon name="x" size={14} /></button></div>
      {platformRunner
        ? PLATFORM_PERMISSIONS.map(p => <button className={`chat-menu-row perm ${p.id === (props.platformPermission ?? "limited") ? "sel" : ""}`} key={p.id} disabled={props.locked} title={p.desc} onClick={() => { props.onPlatformPermissionChange?.(p.id); overlay.close(true); }}><ShieldIcon /><span className="chat-menu-main"><b>{p.name}</b><span>{p.desc}</span></span>{p.id === (props.platformPermission ?? "limited") && <Icon name="check" size={14} />}</button>)
        : permissions.map(p => <button className={`chat-menu-row perm ${p.id === currentPermission ? "sel" : ""}`} key={p.id} disabled={!p.enabled || props.locked} title={p.enabled ? p.desc : `不可用：${p.desc}`} onClick={() => { if (p.enabled) void props.onChange({ permissionId: p.id }); overlay.close(true); }}><ShieldIcon /><span className="chat-menu-main"><b>{p.name}</b><span>{p.desc}{p.enabled ? "" : " · 暂未核验"}</span></span>{p.id === currentPermission && <Icon name="check" size={14} />}</button>)}
      <div className="chat-menu-hint">{platformRunner ? "助理权限由平台工具白名单与运行策略决定；不套用 CLI 档位。" : "权限语义由当前 CLI、版本证据和后端能力决定；不可用项不会静默回落。"}</div>
    </ChatConfigPopup>}
    {overlay.activeOverlay === "model" && <ChatConfigPopup name="model" className="chat-model-pop" label="选择模型">
      <div className="chat-pop-head">模型 <span title={fullModelLabel}><b>{modelLabel}</b> {providerLabel}</span><button className="chat-iconbtn chat-pop-close" aria-label="关闭模型选择" onClick={() => overlay.close(true)}><Icon name="x" size={14} /></button></div>
      <label className="chat-model-search"><SearchIcon /><input value={query} onChange={e => setQuery(e.target.value)} autoFocus placeholder="搜索模型…" aria-label="搜索模型" /></label>
      <div ref={modelGridRef} className="chat-model-grid pane-container"><div className={`chat-model-provider-pane ${providerPane.paneProps.className}`} style={providerPane.style} data-pane-side="left" data-pane-scope={providerPane.scope} data-pane-name={providerPane.pane}><div id={`${overlay.scopeId}-model-providers`} className="chat-model-providers">{groups.map(g => <button className={`chat-provider-row ${g.id === currentProvider?.id ? "on" : ""}`} key={g.id} disabled={props.locked} onClick={() => setProvider(g.id)}><span className="ellipsis">{g.name}</span><span>{g.models.length}</span></button>)}</div><ResizeHandle pane={providerPane} label="模型供应商列" controls={`${overlay.scopeId}-model-providers`} /></div>
        <div className="chat-model-list">{rows.map(m => <button className={`chat-model-row ${m.providerId === props.providerId && m.modelId === props.modelId ? "on" : ""}`} key={`${m.modelRowId}:${m.protocol}`} disabled={props.locked} title={m.modelId} onClick={() => { void props.onChange({ providerId: m.providerId, modelId: m.modelId, effort: defaultEffort(m) }); }}><span className="mr-name ellipsis">{m.displayName || m.modelId}</span><span className="mr-caps"><span className="m-cap ctx" role="img" title={`上下文 ${fmtCtx(m.contextWindow)}`} aria-label={`上下文 ${fmtCtx(m.contextWindow)}`}><b>{fmtCtx(m.contextWindow)}</b></span><span className={`m-cap vision ${m.vision ? "on" : "off"}`} role="img" title={`视觉：${m.vision ? "支持" : "不支持"}`} aria-label={`视觉：${m.vision ? "支持" : "不支持"}`}><EyeIcon /></span><span className={`m-cap think ${supportsThinking(m.efforts) ? "on" : "off"}`} role="img" title={`思考：${supportsThinking(m.efforts) ? "支持" : "未声明"}`} aria-label={`思考：${supportsThinking(m.efforts) ? "支持" : "未声明"}`}><ThinkingIcon /></span></span></button>)}
          {!rows.length && <div className="chat-menu-hint">{groups.length ? "没有匹配，换个关键词。" : "无可用模型；请在设置中配置供应商、密钥与端点。"}</div>}
        </div>
      </div>
      <div className={`chat-model-level ${!effortKeys.length ? "disabled" : ""}`}><div className="chat-level-head"><b>思考等级</b><span>{effortLabel}</span></div>
        {effortKeys.length > 0 ? <><input className="chat-effort-range" style={{ "--effort-percent": `${effortKeys.length > 1 ? Math.max(0, effortKeys.indexOf(selectedEffort)) / (effortKeys.length - 1) * 100 : 0}%` } as CSSProperties} type="range" min={0} max={Math.max(0, effortKeys.length - 1)} step={1} value={Math.max(0, effortKeys.indexOf(selectedEffort))} disabled={props.locked || effortKeys.length === 1} aria-label="思考等级" onChange={e => { void props.onChange({ effort: effortKeys[Number(e.target.value)] }); }} /><div className="chat-level-labels">{effortKeys.map(k => <button key={k} className={k === selectedEffort ? "on" : ""} disabled={props.locked} title={curModel?.efforts[k] === null ? "有效档位：不下发思考参数" : `下发 ${curModel?.efforts[k]}`} aria-pressed={k === selectedEffort} onClick={() => { void props.onChange({ effort: k }); }}>{displayEffort(k)}</button>)}</div></> : <div className="chat-level-note">{curModel ? "该模型未声明思考档位。" : "当前模型未配置或已失效。"}选择可用模型后可调整。</div>}
        {effortStale && <div className="chat-level-note">保留原值，但它已失效；发送前须重新选择。</div>}
      </div>
    </ChatConfigPopup>}
  </>;
}
function EyeIcon() { return <Icon name="eye" size={13} />; }
function ThinkingIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4z" /></svg>; }
export function ShieldIcon() { return <Icon name="shield" size={13} />; }
function SearchIcon() { return <Icon name="search" size={14} />; }
