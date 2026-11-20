import { Icon, CliLogo } from "@/components/icons";
import { ResizeHandle, usePaneWidth } from "@/components/pane-resize";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EffortMap, ModelCandidate, SdkState } from "@/api";
import { ChatConfigPopup, useChatOverlay } from "./overlay";

/** null 是“不下发参数”的有效档位；思考能力只看非 off 的有效 wire 映射。 */
export function effectiveEfforts(efforts?: EffortMap): string[] {
  return Object.keys(efforts ?? {}).filter(k => k.length > 0 && (efforts![k] === null || typeof efforts![k] === "string" && !!efforts![k]?.trim()));
}
export function supportsThinking(efforts?: EffortMap): boolean {
  return effectiveEfforts(efforts).some(k => k.toLowerCase() !== "off" && typeof efforts![k] === "string" && !!efforts![k]?.trim());
}
/** 已核验的后端 agent 路径；其它模式仍不可用，不新增 bypass。 */
export function permissionSupported(cliId?: string | null): boolean { return cliId === "claude" || cliId === "codex"; }
function fmtCtx(n: number | null): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1_000_000) return `${Number.isInteger(n / 1_000_000) ? n / 1_000_000 : (n / 1_000_000).toFixed(1)}M`;
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}
function defaultEffort(m: ModelCandidate): string {
  const keys = effectiveEfforts(m.efforts);
  return m.defaultEffort && keys.includes(m.defaultEffort) ? m.defaultEffort : keys.find(k => k.toLowerCase() === "off") ?? keys[0] ?? "";
}
const PERMISSIONS = [
  { id: "default", name: "默认模式", desc: "需要手动确认每个操作" },
  { id: "plan", name: "规划模式", desc: "仅使用只读工具，生成计划后审批" },
  { id: "agent", name: "代理模式", desc: "复用当前已验证的 CLI 原生执行策略" },
  { id: "auto", name: "自动审批", desc: "提供商原生审查器处理审批" },
  { id: "full", name: "全自动", desc: "绕过权限检查：本软件未开放" },
];

export function ModelPicker(props: {
  cliId: string | null;
  providerId: string | null;
  modelId: string | null;
  effort: string | null;
  cliCandidates: SdkState[];
  models: ModelCandidate[];
  locked?: boolean;
  onChange: (patch: { cliId?: string; providerId?: string; modelId?: string; effort?: string }) => void | Promise<void>;
}) {
  const overlay = useChatOverlay();
  const cliRef = useRef<HTMLButtonElement>(null);
  const permissionRef = useRef<HTMLButtonElement>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
  const modelGridRef = useRef<HTMLDivElement>(null);
  const providerPane = usePaneWidth(overlay.scopeId, "model-providers", {
    default: 112, min: 96, max: 180, side: "left", containerRef: modelGridRef,
    reserve: 6, minCenter: 160, visible: true, disabled: props.locked,
  });
  const { registerTrigger } = overlay;
  useLayoutEffect(() => {
    registerTrigger("cli", cliRef.current);
    registerTrigger("perm", permissionRef.current);
    registerTrigger("model", modelRef.current);
    return () => { registerTrigger("cli", null); registerTrigger("perm", null); registerTrigger("model", null); };
  }, [registerTrigger]);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState(props.providerId);
  const models = props.models.filter(m => {
    const extra = m as ModelCandidate & { image?: boolean; imageGen?: boolean; text?: boolean; modalities?: string[] };
    return !extra.image && !extra.imageGen && extra.text !== false && !extra.modalities?.includes("生图");
  });
  const curModel = models.find(m => m.providerId === props.providerId && m.modelId === props.modelId) ?? null;
  const groups = useMemo(() => {
    const map = new Map<string, { id: string; name: string; models: ModelCandidate[] }>();
    for (const m of models) {
      if (!map.has(m.providerId)) map.set(m.providerId, { id: m.providerId, name: m.providerName, models: [] });
      map.get(m.providerId)!.models.push(m);
    }
    return [...map.values()];
  }, [props.models]);
  useEffect(() => {
    if (overlay.activeOverlay === "model") { setProvider(props.providerId ?? groups[0]?.id ?? null); setQuery(""); }
  }, [overlay.activeOverlay]);
  const effortKeys = effectiveEfforts(curModel?.efforts);
  const selectedEffort = props.effort || curModel?.defaultEffort || "";
  const effortStale = !!selectedEffort && !!curModel && !effortKeys.includes(selectedEffort);
  const cliStale = !!props.cliId && !props.cliCandidates.some(c => c.id === props.cliId);
  const modelStale = !!props.modelId && !curModel;
  const effortLabel = effortStale ? `${selectedEffort}（失效）` : !curModel ? "未配置" : supportsThinking(curModel.efforts) ? selectedEffort || "未选择档位" : effortKeys.length ? selectedEffort || "不下发参数" : "无思考档位";
  const currentProvider = groups.find(g => g.id === provider) ?? groups[0];
  const rows = currentProvider?.models.filter(m => `${m.displayName} ${m.modelId}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  const supported = permissionSupported(props.cliId);
  const nativePermission = props.cliId === "claude" ? "Claude acceptEdits：自动接受文件编辑，其他操作沿用原生边界" : props.cliId === "codex" ? "Codex 默认执行策略：保留原生沙箱与审批边界，未追加绕过参数" : "当前 CLI 权限映射未验证";
  return <>
    <button ref={cliRef} className={`chat-ctl-chip cli ${cliStale ? "stale" : ""}`} data-chat-overlay-trigger="cli" aria-haspopup="dialog" aria-controls={`${overlay.scopeId}-config-cli`} disabled={props.locked} aria-label={`切换 CLI：${props.cliId ?? "未配置"}`} title={props.locked ? "运行快照已锁定" : `切换 CLI：${props.cliId ?? "未配置"}${cliStale ? "（已失效）" : ""}`} aria-expanded={overlay.activeOverlay === "cli"} onClick={e => overlay.toggle("cli", e.currentTarget)}>
      <CliLogo id={props.cliId ?? "unknown"} size={16} />
    </button>
    <button ref={permissionRef} className="chat-ctl-chip perm" data-chat-overlay-trigger="perm" aria-haspopup="dialog" aria-controls={`${overlay.scopeId}-config-perm`} disabled={props.locked} aria-label="权限模式" title={props.locked ? "运行快照已锁定" : nativePermission} aria-expanded={overlay.activeOverlay === "perm"} onClick={e => overlay.toggle("perm", e.currentTarget)}><ShieldIcon />{supported ? "代理模式" : "未验证"}</button>
    <button ref={modelRef} className={`chat-ctl-chip model ${modelStale || effortStale ? "stale" : ""}`} data-chat-overlay-trigger="model" aria-haspopup="dialog" aria-controls={`${overlay.scopeId}-config-model`} disabled={props.locked} aria-label="选择模型" title={props.locked ? "运行快照已锁定" : `${curModel?.displayName ?? props.modelId ?? "模型未配置"} · ${effortLabel}`} aria-expanded={overlay.activeOverlay === "model"} onClick={e => overlay.toggle("model", e.currentTarget)}>
      <span className="ellipsis">{curModel?.displayName ?? props.modelId ?? "未配置"}{modelStale ? "（失效）" : ""} · {effortLabel}</span>
    </button>
    {overlay.activeOverlay === "cli" && <ChatConfigPopup name="cli" className="chat-cli-pop" label="切换 CLI"><div className="chat-pop-head">切换 CLI<button className="chat-iconbtn chat-pop-close" aria-label="关闭 CLI 选择" onClick={() => overlay.close(true)}><Icon name="x" size={14} /></button></div>
      {!props.cliCandidates.length && <div className="chat-menu-hint">没有已安装且启用的 CLI；请在设置 → SDK 管理安装并启用。未虚构可用引擎。</div>}
      {props.cliCandidates.map(c => <button className={`chat-menu-row ${c.id === props.cliId ? "sel" : ""}`} key={c.id} disabled={props.locked} onClick={() => { void props.onChange({ cliId: c.id }); overlay.close(true); }}><CliLogo id={c.id} size={20} /><span className="chat-menu-main"><b>{c.id}</b><span>{c.version ?? "版本未知"}</span></span>{c.id === props.cliId && <Icon name="check" size={14} />}</button>)}
      {props.locked && <div className="chat-menu-hint">运行快照已锁定，静止后才可修改。</div>}
    </ChatConfigPopup>}
    {overlay.activeOverlay === "perm" && <ChatConfigPopup name="perm" className="chat-perm-pop" label="权限模式"><div className="chat-pop-head">权限模式<button className="chat-iconbtn chat-pop-close" aria-label="关闭权限选择" onClick={() => overlay.close(true)}><Icon name="x" size={14} /></button></div>
      {PERMISSIONS.map(p => <button className={`chat-menu-row perm ${p.id === "agent" && supported ? "sel" : ""}`} key={p.id} disabled={p.id !== "agent" || !supported || props.locked} title={p.id === "agent" ? nativePermission : "不可用：后端未提供已验证的此模式映射，未生效"} onClick={() => overlay.close(true)}><ShieldIcon /><span className="chat-menu-main"><b>{p.name}</b><span>{p.id === "agent" && supported ? nativePermission : `${p.desc} · 不可用，权限映射未验证`}</span></span>{p.id === "agent" && supported && <Icon name="check" size={14} />}</button>)}
      <div className="chat-menu-hint">只允许当前已验证的 agent 路径；按钮文字不能改变后端权限。没有添加 bypass。</div>
    </ChatConfigPopup>}
    {overlay.activeOverlay === "model" && <ChatConfigPopup name="model" className="chat-model-pop" label="选择模型">
      <div className="chat-pop-head">模型 <span>{curModel?.providerName ?? "未配置"} · {curModel?.displayName ?? props.modelId ?? "未配置"}</span><button className="chat-iconbtn chat-pop-close" aria-label="关闭模型选择" onClick={() => overlay.close(true)}><Icon name="x" size={14} /></button></div>
      <label className="chat-model-search"><SearchIcon /><input value={query} onChange={e => setQuery(e.target.value)} autoFocus placeholder="搜索模型…" aria-label="搜索模型" /></label>
      <div ref={modelGridRef} className="chat-model-grid pane-container"><div className={`chat-model-provider-pane ${providerPane.paneProps.className}`} style={providerPane.style} data-pane-side="left" data-pane-scope={providerPane.scope} data-pane-name={providerPane.pane}><div id={`${overlay.scopeId}-model-providers`} className="chat-model-providers">{groups.map(g => <button className={`chat-provider-row ${g.id === currentProvider?.id ? "on" : ""}`} key={g.id} disabled={props.locked} onClick={() => setProvider(g.id)}><span className="ellipsis">{g.name}</span><span>{g.models.length}</span></button>)}</div><ResizeHandle pane={providerPane} label="模型供应商列" controls={`${overlay.scopeId}-model-providers`} /></div>
        <div className="chat-model-list">{rows.map(m => <button className={`chat-model-row ${m.providerId === props.providerId && m.modelId === props.modelId ? "on" : ""}`} key={m.modelRowId} disabled={props.locked} title={m.modelId} onClick={() => { void props.onChange({ providerId: m.providerId, modelId: m.modelId, effort: defaultEffort(m) }); }}><span className="mr-name ellipsis">{m.displayName || m.modelId}</span><span className="mr-caps"><span className="m-cap ctx" title={`上下文 ${fmtCtx(m.contextWindow)}`} aria-label={`上下文 ${fmtCtx(m.contextWindow)}`}><GaugeIcon /><b>{fmtCtx(m.contextWindow)}</b></span><span className={`m-cap vision ${m.vision ? "on" : "off"}`} title={`视觉：${m.vision ? "支持" : "不支持"}`} aria-label={`视觉：${m.vision ? "支持" : "不支持"}`}><EyeIcon /></span><span className={`m-cap think ${supportsThinking(m.efforts) ? "on" : "off"}`} title={`思考：${supportsThinking(m.efforts) ? "支持" : "未声明"}`} aria-label={`思考：${supportsThinking(m.efforts) ? "支持" : "未声明"}`}><BulbIcon /></span></span></button>)}
          {!rows.length && <div className="chat-menu-hint">{groups.length ? "没有匹配，换个关键词。" : "无可用模型；请在设置中配置供应商、密钥与端点。"}</div>}
        </div>
      </div>
      <div className={`chat-model-level ${!effortKeys.length ? "disabled" : ""}`}><div className="chat-level-head"><b>思考等级</b><span>{effortLabel}</span></div>
        {effortKeys.length > 0 ? <><input className="chat-effort-range" type="range" min={0} max={Math.max(0, effortKeys.length - 1)} step={1} value={Math.max(0, effortKeys.indexOf(selectedEffort))} disabled={props.locked || effortKeys.length === 1} aria-label="思考等级" onChange={e => { void props.onChange({ effort: effortKeys[Number(e.target.value)] }); }} /><div className="chat-level-labels">{effortKeys.map(k => <button key={k} className={k === selectedEffort ? "on" : ""} disabled={props.locked} title={curModel?.efforts[k] === null ? "有效档位：不下发思考参数" : `下发 ${curModel?.efforts[k]}`} onClick={() => { void props.onChange({ effort: k }); }}>{k}</button>)}</div></> : <div className="chat-level-note">{curModel ? "该模型未声明思考档位。" : "当前模型未配置或已失效。"}选择可用模型后可调整。</div>}
        {effortStale && <div className="chat-level-note">保留原值，但它已失效；发送前须重新选择。</div>}
      </div>
    </ChatConfigPopup>}
  </>;
}
function GaugeIcon() { return <Icon name="gauge" size={13} />; }
function EyeIcon() { return <Icon name="eye" size={13} />; }
function BulbIcon() { return <Icon name="bulb" size={13} />; }
export function ShieldIcon() { return <Icon name="shield" size={13} />; }
function SearchIcon() { return <Icon name="search" size={14} />; }
