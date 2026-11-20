import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import * as api from "@/api";
import type { EffortMap, Provider, ProviderDraft } from "@/api";
import { Field, useToast } from "@/components/ui";
import { EFFORT_LEVELS } from "./shared";
import { SettingsConfirm, SettingsDialog, SettingsIcon, SettingsSwitch } from "./SettingsDialog";

interface KeyDraft { id?: string; alias: string; secret: string; enabled: boolean }
interface EndpointDraft { id?: string; protocol: string; baseUrl: string; enabled: boolean }
interface ModelDraft {
  id?: string; modelId: string; displayName: string; text: boolean; vision: boolean | null; imageGen: boolean;
  efforts: EffortMap; defaultEffort: string | null; contextWindow: string; maxTokens: string; thinking?: boolean | null;
}
interface EditorDraft {
  id?: string; name: string; protocol: "anthropic" | "openai"; disabled: boolean; headers: { name: string; value: string }[];
  keys: KeyDraft[]; endpoints: EndpointDraft[]; models: ModelDraft[];
}
type DiscoveredModel = Awaited<ReturnType<typeof api.providerDiscoverModels>>[number];
type SubTab = "provider" | "models" | "advanced";
const NEW = "__new_provider__";
const SUBTABS: [SubTab, string][] = [["provider", "供应商配置"], ["models", "模型配置"], ["advanced", "高级配置"]];
const emptyModel = (): ModelDraft => ({ modelId: "", displayName: "", text: true, vision: null, imageGen: false, efforts: {}, defaultEffort: null, contextWindow: "", maxTokens: "", thinking: null });
const emptyDraft = (): EditorDraft => ({ name: "", protocol: "openai", disabled: false, headers: [], keys: [], endpoints: [{ protocol: "openai", baseUrl: "", enabled: true }], models: [] });
function toDraft(p: Provider): EditorDraft {
  let headers: EditorDraft["headers"] = [];
  if (p.headersJson) headers = Object.entries(JSON.parse(p.headersJson) as Record<string, string>).map(([name, value]) => ({ name, value }));
  return { id: p.id, name: p.name, protocol: p.protocol, disabled: p.disabled, headers,
    keys: p.keys.map(k => ({ id: k.id, alias: k.alias || "", secret: "", enabled: k.enabled })),
    endpoints: p.endpoints.map(e => ({ ...e })),
    models: p.models.map(m => ({ ...m, efforts: { ...m.efforts }, contextWindow: m.contextWindow == null ? "" : String(m.contextWindow), maxTokens: m.maxTokens == null ? "" : String(m.maxTokens) })),
  };
}
function buildDraft(d: EditorDraft): ProviderDraft | string {
  if (!d.name.trim()) return "供应商名称不能为空";
  const headers: Record<string, string> = Object.create(null);
  for (const h of d.headers) {
    if (!h.name.trim() && !h.value) continue;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(h.name.trim()) || /[\r\n]/.test(h.value)) return "请求头名称或值不合法";
    if (Object.keys(headers).some(n => n.toLowerCase() === h.name.trim().toLowerCase())) return "请求头名称不能重复";
    headers[h.name.trim()] = h.value;
  }
  const keys: ProviderDraft["keys"] = [];
  for (const k of d.keys) {
    if (!k.id && !k.secret.trim()) return "新密钥需填写密钥值";
    keys.push({ ...(k.id ? { id: k.id } : {}), alias: k.alias.trim() || undefined, enabled: k.enabled, ...(k.secret.trim() ? { secret: k.secret.trim() } : {}) });
  }
  const endpoints: ProviderDraft["endpoints"] = [];
  for (const e of d.endpoints) {
    if (!e.baseUrl.trim()) return "端点地址不能为空";
    try {
      const url = new URL(e.baseUrl.trim());
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) return "端点需为不含凭证的 HTTP(S) 地址";
    } catch { return "端点地址不是有效 URL"; }
    if (!["openai", "anthropic"].includes(e.protocol)) return "端点协议暂未支持";
    endpoints.push({ ...e, baseUrl: e.baseUrl.trim() });
  }
  const models: ProviderDraft["models"] = [];
  const ids = new Set<string>();
  for (const m of d.models) {
    const modelId = m.modelId.trim();
    if (!modelId || ids.has(modelId)) return "模型 ID 不能为空或重复";
    ids.add(modelId);
    if (m.vision == null) return "上游未提供视觉能力，请先明确配置未知模型的视觉能力";
    for (const value of [m.contextWindow, m.maxTokens]) if (value.trim() && (!Number.isSafeInteger(Number(value)) || Number(value) <= 0)) return "上下文窗口与最大输出需为正整数，未知请留空";
    const efforts: EffortMap = {};
    for (const level of EFFORT_LEVELS) if (Object.prototype.hasOwnProperty.call(m.efforts, level)) efforts[level] = m.efforts[level]?.trim() || null;
    if (m.defaultEffort && !efforts[m.defaultEffort]) return "默认思考档位必须已经配置下发拼写";
    models.push({ id: m.id, modelId, displayName: m.displayName.trim() || modelId, text: m.text, vision: m.vision, imageGen: m.imageGen, efforts, defaultEffort: m.defaultEffort, contextWindow: m.contextWindow.trim() ? Number(m.contextWindow) : null, maxTokens: m.maxTokens.trim() ? Number(m.maxTokens) : null });
  }
  return { id: d.id, name: d.name.trim(), protocol: d.protocol, disabled: d.disabled, headersJson: Object.keys(headers).length ? JSON.stringify(headers) : null, keys, endpoints, models };
}
const capability = (value: boolean | null | undefined) => value == null ? "未知" : value ? "支持" : "不支持";

export function SettingsModels() {
  const toast = useToast();
  const [list, setList] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, EditorDraft>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<SubTab>("provider");
  const [openModel, setOpenModel] = useState<number | null>(null);
  const [endpointsOpen, setEndpointsOpen] = useState(false);
  const [keyEdit, setKeyEdit] = useState<{ index: number; mode: "alias" | "value" | "protocol" | "scope" | "remove" } | null>(null);
  const [keyValue, setKeyValue] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [deleteProvider, setDeleteProvider] = useState<Provider | null>(null);
  const [deleteModel, setDeleteModel] = useState<number | null>(null);
  const [picker, setPicker] = useState<{ id: string; loading: boolean; error: boolean; models: DiscoveredModel[]; selected: string[]; confirmedVision: Record<string, boolean> } | null>(null);
  const [catalog, setCatalog] = useState<Record<string, DiscoveredModel[]>>({});
  const discoveryRequest = useRef(0);
  const recoveryIds = useRef(new Set<string>());
  useEffect(() => () => { discoveryRequest.current++; }, []);
  const refresh = useCallback(async () => {
    setLoading(true); setError(false);
    try {
      const providers = await api.providerList();
      const recovered = providers.filter(p => recoveryIds.current.has(p.id)).map(p => [p.id, toDraft(p)] as const);
      setList(providers);
      if (recovered.length) setDrafts(prev => ({ ...prev, ...Object.fromEntries(recovered) }));
      recovered.forEach(([id]) => recoveryIds.current.delete(id));
    } catch { setError(true); } finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const d = openId ? drafts[openId] : undefined;
  const update = (patch: Partial<EditorDraft>) => { if (openId && !busy) setDrafts(prev => ({ ...prev, [openId]: { ...prev[openId], ...patch } })); };
  const updateKey = (index: number, patch: Partial<KeyDraft>) => d && update({ keys: d.keys.map((k, i) => i === index ? { ...k, ...patch } : k) });
  const updateModel = (index: number, patch: Partial<ModelDraft>) => d && update({ models: d.models.map((m, i) => i === index ? { ...m, ...patch } : m) });
  const open = (p: Provider | null) => {
    if (busy) return;
    const id = p?.id || NEW;
    if (openId === id) { setOpenId(null); return; }
    try { if (!drafts[id]) setDrafts(prev => ({ ...prev, [id]: p ? toDraft(p) : emptyDraft() })); }
    catch { return toast("供应商配置读取失败，请检查已有请求头数据", "err"); }
    setOpenId(id); setSubTab("provider"); setOpenModel(null); setKeyEdit(null); setKeyValue(""); setEndpointsOpen(false);
  };
  const notify = () => window.dispatchEvent(new CustomEvent("app:settings-changed", { detail: { keys: ["providers"] } }));
  const persist = async (draft: EditorDraft, oldId: string): Promise<{ id: string; draft: EditorDraft } | null> => {
    if (recoveryIds.current.has(oldId)) { toast("上次保存后刷新失败，请先重新读取供应商配置", "warn"); return null; }
    const built = buildDraft(draft);
    if (typeof built === "string") { toast(built, "warn"); return null; }
    const id = await api.providerSave(built);
    setKeyEdit(null); setKeyValue("");
    const safeDraft = { ...draft, id, keys: draft.keys.map(k => ({ ...k, secret: "" })) };
    setDrafts(prev => { const next = { ...prev }; delete next[oldId]; next[id] = safeDraft; return next; });
    setOpenId(id); notify();
    try {
      const providers = await api.providerList();
      setList(providers);
      const saved = providers.find(p => p.id === id);
      if (!saved) throw new Error("saved provider unavailable");
      const canonical = toDraft(saved);
      canonical.models = canonical.models.map(m => ({ ...m, thinking: draft.models.find(x => x.modelId === m.modelId)?.thinking }));
      setDrafts(prev => ({ ...prev, [id]: canonical }));
      return { id, draft: canonical };
    } catch {
      recoveryIds.current.add(id); setError(true);
      toast("供应商已保存，但刷新失败；请先重新读取配置，避免重复新增密钥", "warn");
      return null;
    }
  };
  const save = async (draft = d) => {
    if (!draft || !openId || lock.current) return;
    if (keyEdit && ["value", "alias"].includes(keyEdit.mode)) return toast("请先将密钥行编辑保存到草稿或取消，再保存供应商", "warn");
    lock.current = true; setBusy(true);
    try { if (await persist(draft, openId)) toast("供应商已保存"); }
    catch { toast("保存失败，草稿已保留；请检查配置后重试", "err"); }
    finally { lock.current = false; setBusy(false); }
  };
  const discover = async () => {
    if (!d || !openId || lock.current) return;
    if (keyEdit && ["value", "alias"].includes(keyEdit.mode)) return toast("请先保存密钥行草稿或取消，再获取模型", "warn");
    const token = ++discoveryRequest.current;
    const originalId = openId;
    lock.current = true; setBusy(true);
    setPicker({ id: originalId, loading: true, error: false, models: [], selected: [], confirmedVision: {} });
    try {
      const saved = await persist(d, originalId);
      if (!saved) { if (token === discoveryRequest.current) setPicker(null); return; }
      if (token !== discoveryRequest.current) return;
      setPicker(prev => prev && ({ ...prev, id: saved.id }));
      const models = await api.providerDiscoverModels(saved.id);
      if (token !== discoveryRequest.current) return;
      setCatalog(prev => ({ ...prev, [saved.id]: models }));
      const existing = new Set(saved.draft.models.map(m => m.modelId));
      setPicker({ id: saved.id, loading: false, error: false, models: models.filter(m => !existing.has(m.modelId)), selected: [], confirmedVision: {} });
    } catch { if (token === discoveryRequest.current) setPicker(prev => prev && ({ ...prev, loading: false, error: true })); }
    finally { lock.current = false; setBusy(false); }
  };
  const saveSelected = async () => {
    if (!picker || !d || lock.current) return;
    const selected = picker.models.filter(m => picker.selected.includes(m.modelId));
    if (!selected.length) return toast("请先勾选模型", "warn");
    if (selected.some(m => m.vision == null && picker.confirmedVision[m.modelId] == null)) return toast("未知视觉能力不能猜测，请明确选择后保存", "warn");
    const added = selected.map(m => ({ ...emptyModel(), modelId: m.modelId, displayName: m.displayName, vision: m.vision ?? picker.confirmedVision[m.modelId], thinking: m.thinking, contextWindow: m.contextWindow == null ? "" : String(m.contextWindow) }));
    lock.current = true; setBusy(true);
    try { if (await persist({ ...d, models: [...d.models, ...added] }, picker.id)) { setPicker(null); toast("所选模型已保存；未知思考档位未自动填写"); } }
    catch { toast("模型保存失败，所选项已保留", "err"); }
    finally { lock.current = false; setBusy(false); }
  };
  const toggle = async (p: Provider, enabled: boolean) => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try {
      await api.providerSetDisabled(p.id, !enabled);
      setList(prev => prev.map(x => x.id === p.id ? { ...x, disabled: !enabled } : x));
      setDrafts(prev => prev[p.id] ? ({ ...prev, [p.id]: { ...prev[p.id], disabled: !enabled } }) : prev); notify();
    } catch { toast("供应商启停失败", "err"); } finally { lock.current = false; setBusy(false); }
  };
  const removeProvider = async () => {
    if (!deleteProvider || lock.current) return;
    lock.current = true; setBusy(true);
    try {
      await api.providerDelete(deleteProvider.id);
      const id = deleteProvider.id;
      setList(prev => prev.filter(p => p.id !== id));
      setDrafts(prev => { const next = { ...prev }; delete next[id]; return next; });
      if (openId === id) setOpenId(null);
      setDeleteProvider(null); notify(); toast("供应商已删除");
    } catch { toast("供应商删除失败", "err"); } finally { lock.current = false; setBusy(false); }
  };
  const autoConfigure = (index: number) => {
    if (!d) return;
    const model = d.models[index];
    const metadata = catalog[d.id || ""]?.find(m => m.modelId === model.modelId);
    if (!metadata) return toast("尚无该模型的真实能力数据，请先获取模型；不会按名称猜配置", "warn");
    updateModel(index, { ...(metadata.vision == null ? {} : { vision: metadata.vision }), ...(metadata.contextWindow == null ? {} : { contextWindow: String(metadata.contextWindow) }), thinking: metadata.thinking });
    toast("只填充上游明确提供的能力；未知项及思考下发拼写保留待配置");
  };
  const editor = () => {
    if (!d) return null;
    return <div className="set-provider-inline">
      <div className="set-tabs" role="tablist" aria-label="供应商配置页签">{SUBTABS.map(([id, label]) => <button key={id} role="tab" aria-selected={subTab === id} disabled={busy} onClick={() => setSubTab(id)}>{label}</button>)}</div>
      <fieldset className="set-fieldset set-provider-body" disabled={busy}>
        {subTab === "provider" && <>
          <section className="set-pm-section"><div className="row"><b>API 密钥</b><span className="spacer" /><button className="btn sm" disabled title="没有独立密钥探测契约；请在模型配置获取模型">自动探测</button></div>
            <div className="set-key-list">{d.keys.map((k, i) => <div className={`set-key-item ${keyEdit?.index === i ? "editing" : ""}`} key={k.id || `new-${i}`}>
              <div className="set-key-row"><input type="checkbox" checked={k.enabled} aria-label={`启用密钥 ${k.alias || i + 1}`} onChange={e => updateKey(i, { enabled: e.target.checked })} /><span className="set-key-value"><b>{k.alias || "未命名密钥"}</b><span className="mono set-caption">{k.id || k.secret ? "••••••••" : "待填写"}</span><span className="set-key-scope">供应商模型 · 独立范围未支持</span></span>
                <span className="set-key-actions">{([["protocol", "默认协议 ›"], ["scope", "模型"], ["alias", "别名"], ["value", "编辑"], ["remove", "删除"]] as const).map(([mode, text]) => <button key={mode} className={`set-link ${mode === "remove" ? "danger" : ""}`} onClick={() => { setKeyEdit({ index: i, mode }); setKeyValue(mode === "alias" ? k.alias : ""); }}>{text}</button>)}</span></div>
              {keyEdit?.index === i && <div className="set-key-form">
                {keyEdit.mode === "alias" && <Field label="别名"><input className="input" aria-label="密钥别名" value={keyValue} onChange={e => setKeyValue(e.target.value)} /></Field>}
                {keyEdit.mode === "value" && <Field label="密钥值" hint={k.id ? "原密钥不返回正文。留空保留现有引用，填写则替换。" : "只在保存请求中发送，不显示正文。"}><input className="input mono" type="password" autoComplete="new-password" aria-label="密钥值" value={keyValue} onChange={e => setKeyValue(e.target.value)} /></Field>}
                {keyEdit.mode === "protocol" && <><div className="set-chips">{["默认", "Chat", "Responses", "Anthropic"].map(text => <button className="set-chip" key={text} disabled>{text}</button>)}</div><p className="set-caption">当前接口没有逐密钥协议字段；沿用供应商协议，不会伪造保存。</p></>}
                {keyEdit.mode === "scope" && <><b>这个密钥可用的模型</b>{d.models.map(m => <label key={m.modelId} className="row small"><input type="checkbox" disabled />{m.displayName || m.modelId}</label>)}<p className="set-caption">逐密钥模型范围尚未接入，不能从此授予或收窄权限。</p></>}
                {keyEdit.mode === "remove" && <p className="set-caption">确认从草稿移除「{k.alias || "该密钥"}」？保存供应商后才生效。</p>}
                <div className="row">{!["scope", "protocol"].includes(keyEdit.mode) && <button className={`btn sm ${keyEdit.mode === "remove" ? "danger" : "primary"}`} onClick={() => {
                  if (keyEdit.mode === "remove") update({ keys: d.keys.filter((_, j) => j !== i) });
                  else if (keyEdit.mode === "alias") updateKey(i, { alias: keyValue });
                  else { if (!k.id && !keyValue.trim()) return toast("新密钥不能为空", "warn"); updateKey(i, { secret: keyValue }); }
                  setKeyEdit(null); setKeyValue("");
                }}>{keyEdit.mode === "remove" ? "确认删除" : "保存到草稿"}</button>}<button className="btn sm" onClick={() => { setKeyEdit(null); setKeyValue(""); }}>取消</button></div>
              </div>}
            </div>)}{!d.keys.length && <p className="set-caption set-pad">还没有密钥</p>}<button className="set-add" onClick={() => { update({ keys: [...d.keys, { alias: "", secret: "", enabled: true }] }); setKeyEdit({ index: d.keys.length, mode: "value" }); setKeyValue(""); }}><SettingsIcon name="plus" />添加另一个密钥</button></div>
            <p className="set-caption">悬停可编辑密钥；原已保存密钥沿用 ID 引用，正文不返回。变更需显式保存供应商。</p>
          </section>
          <section className="set-pm-section"><Field label="显示名称"><input className="input" value={d.name} aria-label="供应商名称" onChange={e => update({ name: e.target.value })} /></Field></section>
          <section className="set-pm-section"><b>API 协议</b><div className="set-seg">{([["openai", "Chat"], ["openai", "Responses"], ["anthropic", "Anthropic"], ["gemini", "Gemini API"]] as const).map(([value, text]) => <button key={text} aria-pressed={d.protocol === value && text !== "Responses"} disabled={value === "gemini" || text === "Responses"} title={text === "Responses" ? "当前接口只保存 OpenAI 协议族；wire API 由 CLI 适配器决定，不能独立保存" : value === "gemini" ? "当前后端不支持该协议" : undefined} onClick={() => value !== "gemini" && update({ protocol: value })}>{text}</button>)}</div><p className="set-caption">Chat / Responses 的实际执行由 CLI 适配器控制；不保存不存在的协议字段。</p></section>
          <section className="set-pm-section"><div className="row"><b>API 地址</b><span className="spacer" /><button className="btn sm" onClick={() => setEndpointsOpen(v => !v)}>{endpointsOpen ? "收起端点" : "更多端点"}<SettingsIcon name={endpointsOpen ? "up" : "down"} /></button></div>
            {(endpointsOpen ? d.endpoints : d.endpoints.slice(0, 1)).map((ep, i) => <div className="set-endpoint" key={ep.id || i}><SettingsSwitch checked={ep.enabled} label={`启用端点 ${i + 1}`} onChange={enabled => update({ endpoints: d.endpoints.map((e, j) => i === j ? { ...e, enabled } : e) })} /><select className="select" aria-label={`端点 ${i + 1} 协议`} value={ep.protocol} onChange={e => update({ endpoints: d.endpoints.map((x, j) => i === j ? { ...x, protocol: e.target.value } : x) })}>{!["openai", "anthropic"].includes(ep.protocol) && <option>{ep.protocol}</option>}<option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select><input className="input mono" value={ep.baseUrl} placeholder="https://…" aria-label={`端点 ${i + 1} 地址`} onChange={e => update({ endpoints: d.endpoints.map((x, j) => i === j ? { ...x, baseUrl: e.target.value } : x) })} />{endpointsOpen && <button className="set-icon-btn" aria-label={`移除端点 ${i + 1}`} onClick={() => update({ endpoints: d.endpoints.filter((_, j) => j !== i) })}><SettingsIcon name="trash" /></button>}</div>)}
            {endpointsOpen && <button className="set-add" onClick={() => update({ endpoints: [...d.endpoints, { protocol: d.protocol, baseUrl: "", enabled: true }] })}><SettingsIcon name="plus" />添加端点</button>}
          </section>
        </>}
        {subTab === "models" && <>
          <div className="row set-model-toolbar"><span className="set-caption">{d.models.length} 个模型 · 点击模型展开配置</span><span className="spacer" /><button className="btn sm" onClick={() => { update({ models: [...d.models, emptyModel()] }); setOpenModel(d.models.length); }}>手动添加</button><button className="btn primary sm" onClick={discover}><SettingsIcon name="plus" />获取模型</button></div>
          <div className="set-model-list">{d.models.map((m, i) => <div className="set-model-item" key={m.id || i}>
            <div className="set-model-head"><button className="set-model-select" aria-expanded={openModel === i} onClick={() => setOpenModel(openModel === i ? null : i)}><b>{m.displayName || m.modelId || "新模型"}</b><span className="mono set-model-id">{m.modelId || "待填写 ID"}</span><span className="set-model-tags">{m.text && <span className="tag">文本</span>}{m.vision && <span className="tag">图片</span>}{m.vision == null && <span className="tag">视觉未知</span>}{m.imageGen && <span className="tag">生图</span>}</span><span className="set-model-context">{m.contextWindow ? `${Math.round(Number(m.contextWindow) / 1000)}K` : "—"}</span><SettingsIcon name={openModel === i ? "up" : "down"} /></button><button className="set-icon-btn set-model-delete" aria-label={`删除模型 ${m.modelId || i + 1}`} onClick={() => setDeleteModel(i)}><SettingsIcon name="trash" /></button></div>
            {openModel === i && <div className="set-model-form">
              <div className="set-form-grid"><Field label="模型 ID"><input className="input mono" value={m.modelId} aria-label="模型 ID" onChange={e => updateModel(i, { modelId: e.target.value })} /></Field><Field label="显示名称"><input className="input" value={m.displayName} aria-label="模型显示名称" onChange={e => updateModel(i, { displayName: e.target.value })} /></Field></div>
              <Field label="支持模态"><div className="set-chips">{([["text", "文本"], ["vision", "图片"], ["imageGen", "生图"]] as const).map(([key, label]) => <button key={key} className={`set-chip ${m[key] ? "on" : ""}`} aria-pressed={m[key] === true} onClick={() => updateModel(i, key === "text" ? { text: !m.text, imageGen: !m.text ? false : m.imageGen } : key === "imageGen" ? { imageGen: !m.imageGen, text: !m.imageGen ? false : m.text, vision: !m.imageGen ? false : m.vision } : { vision: m.vision !== true, imageGen: m.vision !== true ? false : m.imageGen })}>{label}</button>)}</div>{m.vision == null && <select className="select" value="" aria-label="确认未知视觉能力" onChange={e => updateModel(i, { vision: e.target.value === "true" })}><option value="" disabled>上游未提供视觉能力，需明确配置</option><option value="false">不支持图片</option><option value="true">支持图片</option></select>}</Field>
              <div className="row"><b className="small">思考</b><span className="set-caption">上游能力：{capability(m.thinking)}</span><span className="spacer" /><button className="btn sm" onClick={() => autoConfigure(i)}>自动配置</button><SettingsSwitch checked={m.thinking === true || Object.values(m.efforts).some(v => !!v)} label="思考开关" disabled title="接口没有独立思考开关；请配置下方已核实档位，不会猜测下发参数" onChange={() => {}} /></div>
              <Field label="支持档位" hint="只配置你已核实的档位及下发拼写，不依据模型名猜测。"><div className="set-chips">{EFFORT_LEVELS.map(level => <button key={level} className={`set-chip ${m.efforts[level] != null ? "on" : ""}`} aria-pressed={m.efforts[level] != null} onClick={() => updateModel(i, { efforts: { ...m.efforts, [level]: m.efforts[level] == null ? "" : null }, defaultEffort: m.defaultEffort === level ? null : m.defaultEffort })}>{level}</button>)}</div><div className="set-effort-grid">{EFFORT_LEVELS.filter(level => m.efforts[level] != null).map(level => <Fragment key={level}><span className="mono small">{level}</span><input className="input mono" aria-label={`${level} 下发拼写`} placeholder="填写已核实的 wire 参数值" value={m.efforts[level] || ""} onChange={e => updateModel(i, { efforts: { ...m.efforts, [level]: e.target.value } })} /></Fragment>)}</div></Field>
              <div className="set-form-grid"><Field label="默认思考强度"><select className="select" aria-label="默认思考强度" value={m.defaultEffort || ""} onChange={e => updateModel(i, { defaultEffort: e.target.value || null })}><option value="">不下发默认档位</option>{EFFORT_LEVELS.filter(level => m.efforts[level]?.trim()).map(level => <option key={level}>{level}</option>)}</select></Field><Field label="上下文窗口"><input className="input" type="number" value={m.contextWindow} min={1} placeholder="未知请留空" aria-label="上下文窗口" onChange={e => updateModel(i, { contextWindow: e.target.value })} /></Field><Field label="最大输出"><input className="input" type="number" min={1} value={m.maxTokens} placeholder="未知请留空" aria-label="最大输出" onChange={e => updateModel(i, { maxTokens: e.target.value })} /></Field><Field label="状态" hint="当前接口无逐模型启停字段。"><SettingsSwitch checked={false} onChange={() => {}} label="模型启停未接入" disabled /></Field></div>
              <div className="row"><button className="btn sm primary" onClick={() => save()}>保存模型</button><button className="btn sm" onClick={() => { const original = list.find(p => p.id === d.id)?.models.find(x => x.id === m.id); if (original) updateModel(i, { ...original, efforts: { ...original.efforts }, contextWindow: original.contextWindow == null ? "" : String(original.contextWindow), maxTokens: original.maxTokens == null ? "" : String(original.maxTokens) }); else update({ models: d.models.filter((_, j) => j !== i) }); setOpenModel(null); }}>放弃修改</button><span className="set-caption">保存模型会显式保存本供应商全部草稿</span></div>
            </div>}
          </div>)}{!d.models.length && <div className="set-empty"><b>还没有模型</b><p>点击「获取模型」保存供应商后从上游拉取并勾选。</p></div>}</div>
        </>}
        {subTab === "advanced" && <>
          <section className="set-pm-section"><b>请求头</b><p className="set-caption">仅保存真实接口支持的请求头配置；不把密钥放入展示正文。</p>{d.headers.map((h, i) => <div className="set-header-row" key={i}><input className="input" aria-label={`请求头 ${i + 1} 名称`} placeholder="例如 x-company" value={h.name} onChange={e => update({ headers: d.headers.map((x, j) => i === j ? { ...x, name: e.target.value } : x) })} /><input className="input" type="password" autoComplete="new-password" aria-label={`请求头 ${i + 1} 值`} placeholder="值" value={h.value} onChange={e => update({ headers: d.headers.map((x, j) => i === j ? { ...x, value: e.target.value } : x) })} /><button className="set-icon-btn" aria-label={`删除请求头 ${i + 1}`} onClick={() => update({ headers: d.headers.filter((_, j) => j !== i) })}><SettingsIcon name="close" /></button></div>)}<button className="set-add" onClick={() => update({ headers: [...d.headers, { name: "", value: "" }] })}><SettingsIcon name="plus" />添加请求头</button></section>
          <section className="set-pm-section"><div className="row"><b>请求伪装</b><span className="spacer" /><div className="set-seg">{["关闭", "Codex", "Claude"].map(text => <button key={text} disabled>{text}</button>)}</div></div><p className="set-caption">请求伪装尚无持久化与执行字段，暂不可配置；不提供指纹检测入口。</p></section>
        </>}
      </fieldset>
      <div className="set-provider-foot"><span className="set-caption">草稿保留；仅显式保存，获取模型会先保存。</span><button className="btn primary" disabled={busy} onClick={() => save()}>{busy ? "处理中…" : "保存供应商"}</button></div>
    </div>;
  };
  return <>
    <div className="row set-toolbar"><span className="set-caption">{list.length} 个供应商 · 点击卡片展开配置</span><span className="spacer" /><button className="btn sm primary" disabled={busy || loading || error} onClick={() => open(null)}><SettingsIcon name="plus" />新建供应商</button></div>
    {loading && <p className="set-caption">加载供应商中…</p>}
    {error && <div className="set-note" role="alert">供应商读取失败，已有草稿保留。<button className="btn sm" disabled={busy} onClick={refresh}>重试</button></div>}
    {drafts[NEW] && <div className={`set-provider-card ${openId === NEW ? "open" : ""}`}><div className="set-provider-head"><button className="set-provider-select" disabled={busy} onClick={() => open(null)}><span className="set-provider-icon">新</span><span className="set-provider-info"><b>{drafts[NEW].name || "新供应商"}</b><span>未保存草稿</span></span><SettingsIcon name={openId === NEW ? "up" : "down"} /></button></div>{openId === NEW && editor()}</div>}
    {list.map(p => <div key={p.id} className={`set-provider-card ${openId === p.id ? "open" : ""}`}><div className="set-provider-head"><button className="set-provider-select" disabled={busy} onClick={() => open(p)} aria-expanded={openId === p.id}><span className="set-provider-icon">{p.name.slice(0, 2)}</span><span className="set-provider-info"><b>{p.name}</b><span>{p.protocol} · {p.keys.length} 个密钥 · {p.endpoints.length} 个端点 · {p.models.length} 个模型</span></span></button><span className={`set-status ${p.disabled ? "" : "good"}`}>{p.disabled ? "停用" : "启用"}</span><SettingsSwitch checked={!p.disabled} label={`启用供应商 ${p.name}`} disabled={busy} onChange={v => toggle(p, v)} /><button className="set-icon-btn" disabled={busy} aria-label={`删除供应商 ${p.name}`} onClick={() => setDeleteProvider(p)}><SettingsIcon name="trash" /></button><button className="set-icon-btn" disabled={busy} aria-label={`${openId === p.id ? "收起" : "展开"}供应商 ${p.name}`} onClick={() => open(p)}><SettingsIcon name={openId === p.id ? "up" : "down"} /></button></div>{openId === p.id && editor()}</div>)}
    {!loading && !error && !list.length && !drafts[NEW] && <div className="set-empty">尚无供应商，请新建。</div>}
    <div className="set-note"><SettingsIcon name="shield" />密钥只发送保存请求，已保存值沿用引用；未知模型能力不猜测，未实现范围明确禁用。</div>
    {deleteProvider && <SettingsConfirm title="删除供应商" message={`确定删除「${deleteProvider.name}」？其密钥、端点与模型配置将一并移除。`} busy={busy} onCancel={() => setDeleteProvider(null)} onOk={removeProvider} />}
    {deleteModel != null && d && <SettingsConfirm title="删除模型" message="确认从供应商草稿移除此模型？保存供应商后生效。" onCancel={() => setDeleteModel(null)} onOk={() => { update({ models: d.models.filter((_, i) => i !== deleteModel) }); setDeleteModel(null); setOpenModel(null); }} />}
    {picker && <SettingsDialog title="获取模型" subtitle={`${d?.name || "供应商"} · 保存后真实发现，未知字段不猜测`} busy={busy} onClose={() => { discoveryRequest.current++; setPicker(null); }} footer={<><button className="btn" disabled={busy} onClick={() => setPicker(null)}>取消</button><button className="btn primary" disabled={busy || picker.loading || picker.error} onClick={saveSelected}>保存所选</button></>}>
      {picker.loading ? <p className="set-caption">保存供应商并获取模型中…</p> : picker.error ? <div className="set-note" role="alert">上游模型发现失败，未生成虚构模型。<button className="btn sm" onClick={discover}>重试</button></div> : <div className="set-model-pick-list">{picker.models.map(m => <div className="set-model-pick-row" key={m.modelId}><label className="set-pick-main"><input type="checkbox" checked={picker.selected.includes(m.modelId)} onChange={e => setPicker(prev => prev && ({ ...prev, selected: e.target.checked ? [...prev.selected, m.modelId] : prev.selected.filter(id => id !== m.modelId) }))} /><span><b>{m.displayName}</b><span className="mono set-caption">{m.modelId}</span></span></label><span className="set-caption">{m.contextWindow == null ? "上下文未知" : `${Math.round(m.contextWindow / 1000)}K`}<br />思考{capability(m.thinking)}</span>{m.vision == null ? <select className="select set-pick-vision" aria-label={`${m.modelId} 视觉能力`} value={picker.confirmedVision[m.modelId] == null ? "" : String(picker.confirmedVision[m.modelId])} onChange={e => setPicker(prev => prev && ({ ...prev, confirmedVision: { ...prev.confirmedVision, [m.modelId]: e.target.value === "true" } }))}><option value="" disabled>视觉未知</option><option value="false">不支持图片</option><option value="true">支持图片</option></select> : <span className="tag">视觉{capability(m.vision)}</span>}</div>)}{!picker.models.length && <div className="set-empty"><b>没有更多模型</b><p>上游未返回更多未配置模型。</p></div>}</div>}
      <p className="set-caption">只保存勾选的模型；视觉未知需人工明确，思考档位与最大输出不会伪造填充。</p>
    </SettingsDialog>}
  </>;
}
