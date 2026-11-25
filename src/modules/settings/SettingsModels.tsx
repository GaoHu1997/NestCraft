import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "@/api";
import type { EffortMap, KeyProbeOutcome, Provider, ProviderDraft } from "@/api";
import { Field, useToast } from "@/components/ui";
import { EFFORT_LEVELS, errMsg } from "./shared";
import { SettingsConfirm, SettingsDialog, SettingsIcon, SettingsSwitch } from "./SettingsDialog";
import { SettingsImageGen } from "./SettingsImageGen";
import { capacityError, capacityLabel, compileEffortMap, formatCapacity, parseCapacity } from "./modelCapacity";
import { dropIndex, maskKey, moveItem, resolvedModalities } from "./modelManagement";
import { ModelProtocolMenu } from "./ModelProtocolMenu";
import "./cr085-models.css";

/** CR-059：密钥协议 → 端点 wire（'' 沿用供应商默认）。 */
const KEY_WIRE: Record<string, "openai" | "anthropic"> = { Chat: "openai", Responses: "openai", Anthropic: "anthropic" };
const wireOf = (keyProtocol: string, providerProtocol: "openai" | "anthropic") =>
  keyProtocol ? KEY_WIRE[keyProtocol] ?? "openai" : providerProtocol;

interface KeyDraft {
  id?: string; alias: string; secret: string; masked?: string; enabled: boolean;
  /** CR-059：'' 沿用供应商默认；Chat/Responses → OpenAI；Anthropic → Anthropic。 */
  protocol: string;
  /** CR-059：可用模型（空 = 全部）。 */
  models: string[];
  scopeSource: string | null;
  probedAt: number | null;
}
interface EndpointDraft { id?: string; protocol: string; baseUrl: string; enabled: boolean }
interface ModelDraft {
  localId: string; modalityManual?: boolean; modalitySource?: string | null;
  id?: string; modelId: string; displayName: string; text: boolean; vision: boolean | null; imageGen: boolean;
  efforts: EffortMap; defaultEffort: string | null; contextWindow: string; maxTokens: string; thinking?: boolean | null;
  /** CR-068：全量七档映射草稿（仅编辑态；未选档也可编辑）。 */
  mappings: Record<string, string>;
  sortOrder: number;
}
interface EditorDraft {
  createId?: string; apiMode: "Chat" | "Responses" | "Anthropic";
  id?: string; name: string; protocol: "anthropic" | "openai"; disabled: boolean; headers: { name: string; value: string }[];
  keys: KeyDraft[]; endpoints: EndpointDraft[]; models: ModelDraft[];
}
type DiscoveredModel = Awaited<ReturnType<typeof api.providerDiscoverModels>>[number];
type SubTab = "provider" | "models";
const NEW = "__new_provider__";
const SUBTABS: [SubTab, string][] = [["provider", "供应商配置"], ["models", "模型配置"]];
const emptyModel = (sortOrder = 0): ModelDraft => ({
  localId: crypto.randomUUID(),
  modelId: "", displayName: "", text: true, vision: null, imageGen: false,
  efforts: {}, mappings: {}, defaultEffort: null, contextWindow: "", maxTokens: "", thinking: null, sortOrder,
});
const emptyDraft = (): EditorDraft => ({
  name: "", apiMode: "Chat", createId: "", protocol: "openai", disabled: false, headers: [],
  keys: [], endpoints: [
    { protocol: "openai", baseUrl: "", enabled: true },
    { protocol: "anthropic", baseUrl: "", enabled: false },
  ],
  models: [],
});
function toDraft(p: Provider): EditorDraft {
  let headers: EditorDraft["headers"] = [];
  if (p.headersJson) headers = Object.entries(JSON.parse(p.headersJson) as Record<string, string>).map(([name, value]) => ({ name, value }));
  return {
    id: p.id, name: p.name, apiMode: p.apiMode || (p.protocol === "anthropic" ? "Anthropic" : "Chat"), protocol: p.protocol, disabled: p.disabled, headers,
    keys: p.keys.map(k => ({
      id: k.id, alias: k.alias || "", secret: "", masked: k.masked, enabled: k.enabled,
      protocol: k.protocol || "", models: [...(k.models || [])],
      scopeSource: k.scopeSource ?? null, probedAt: k.probedAt ?? null,
    })),
    endpoints: ["openai", "anthropic"].map(protocol => ({ protocol, baseUrl: "", enabled: false, ...p.endpoints.find(e => e.protocol === protocol) })),
    models: p.models.map((m, index) => ({
      ...m,
      localId: m.id,
      efforts: { ...m.efforts },
      mappings: Object.fromEntries(Object.entries(m.efforts).map(([level, wire]) => [level, wire ?? level])),
      contextWindow: formatCapacity(m.contextWindow),
      maxTokens: formatCapacity(m.maxTokens),
      sortOrder: m.sortOrder ?? index,
    })),
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
    keys.push({
      ...(k.id ? { id: k.id } : {}),
      alias: k.alias.trim() || undefined,
      enabled: k.enabled,
      ...(k.secret.trim() ? { secret: k.secret.trim() } : {}),
      protocol: k.protocol,
      models: k.models,
      scopeSource: k.scopeSource,
    });
  }
  // CR-059 G7：端点固定 OpenAI/Anthropic 两种；只保存填了地址的，且协议去重。
  const endpoints: ProviderDraft["endpoints"] = [];
  const seenProtocol = new Set<string>();
  for (const e of d.endpoints) {
    if (!e.baseUrl.trim()) continue;
    try {
      const url = new URL(e.baseUrl.trim());
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) return "端点需为不含凭证的 HTTP(S) 地址";
    } catch { return "端点地址不是有效 URL"; }
    if (!["openai", "anthropic"].includes(e.protocol)) return "端点协议只支持 OpenAI 或 Anthropic";
    if (seenProtocol.has(e.protocol)) return "同一协议只能配置一个端点";
    seenProtocol.add(e.protocol);
    endpoints.push({ ...e, enabled: true, baseUrl: e.baseUrl.trim() });
  }
  const models: ProviderDraft["models"] = [];
  const ids = new Set<string>();
  d.models.forEach((m, index) => {
    const modelId = m.modelId.trim();
    if (!modelId || ids.has(modelId)) throw new Error("模型 ID 不能为空或重复");
    ids.add(modelId);
    const thinkingOn = m.thinking !== false && (m.thinking === true || Object.keys(m.efforts).length > 0);
    const efforts: EffortMap = thinkingOn ? compileEffortMap(EFFORT_LEVELS, m.mappings) : {};
    const defaultEffort = thinkingOn && m.defaultEffort ? m.defaultEffort : null;
    if (defaultEffort && !efforts[defaultEffort]) throw new Error("默认思考档位必须已经配置下发拼写");
    let contextWindow: number | null;
    let maxTokens: number | null;
    try {
      contextWindow = parseCapacity(m.contextWindow);
      maxTokens = parseCapacity(m.maxTokens);
    } catch (e) {
      throw new Error(`${m.displayName || modelId}：${errMsg(e)}`);
    }
    models.push({
      id: m.id, modelId, displayName: m.displayName.trim() || modelId,
      text: m.text, vision: m.vision ?? false, imageGen: m.imageGen,
      efforts, defaultEffort,
      contextWindow,
      maxTokens,
      sortOrder: index,
    });
  });
  return {
    ...(d.id ? { id: d.id } : { createId: d.createId?.trim() || undefined }), apiMode: d.apiMode,
    name: d.name.trim(), protocol: d.protocol, disabled: d.disabled,
    headersJson: Object.keys(headers).length ? JSON.stringify(headers) : null,
    keys, endpoints, models,
  };
}
const capability = (value: boolean | null | undefined) => value == null ? "未知" : value ? "支持" : "不支持";

/** CR-068：自动获取档位时保留用户已改写的映射，只补缺失档位。 */
const mergeResolvedMappings = (current: Record<string, string>, resolved: EffortMap): Record<string, string> => {
  const next = { ...current };
  for (const [level, wire] of Object.entries(resolved)) if (next[level] === undefined) next[level] = wire ?? level;
  return next;
};

export function SettingsModels() {
  const toast = useToast();
  const [list, setList] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, EditorDraft>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<SubTab>("provider");
  const [openModel, setOpenModel] = useState<string | null>(null);
  const [keyEdit, setKeyEdit] = useState<{ index: number; mode: "value" | "scope" | "remove"; isNew?: boolean } | null>(null);
  const [keyValue, setKeyValue] = useState("");
  const [keyAlias, setKeyAlias] = useState("");
  const [scopeDraft, setScopeDraft] = useState<string[]>([]);
  const [keyLoading, setKeyLoading] = useState(false);
  const keyRequest = useRef(0);
  const [protocolMenu, setProtocolMenu] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const closeProtocol = useCallback(() => setProtocolMenu(null), []);
  const [endpointOpen, setEndpointOpen] = useState<Record<string, boolean>>({});
  const [dropTarget, setDropTarget] = useState<{ kind: "provider" | "model"; index: number; after: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
const [saveError, setSaveError] = useState("");
  const lock = useRef(false);
  const [deleteProvider, setDeleteProvider] = useState<Provider | null>(null);
  const [deleteModel, setDeleteModel] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ id: string; loading: boolean; error: boolean; errorMsg?: string; models: DiscoveredModel[]; selected: string[] } | null>(null);
  const discoveryRequest = useRef(0);
  const recoveryIds = useRef(new Set<string>());
  const dragRef = useRef<{ kind: "provider" | "model"; index: number } | null>(null);

  useEffect(() => () => { discoveryRequest.current++; keyRequest.current++; }, []);
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
  /* CR-068 M06：生图入口只在设置标题行（index.tsx）出现，这里接收打开事件，不再渲染第二个入口。 */
  useEffect(() => {
    const openImageGen = () => setImageOpen(true);
    window.addEventListener("settings:open-imagegen", openImageGen);
    return () => window.removeEventListener("settings:open-imagegen", openImageGen);
  }, []);
  const d = openId ? drafts[openId] : undefined;
  const update = (patch: Partial<EditorDraft>) => { if (openId && !busy) setDrafts(prev => ({ ...prev, [openId]: { ...prev[openId], ...patch } })); };
  const updateKey = (index: number, patch: Partial<KeyDraft>) => d && update({ keys: d.keys.map((k, i) => i === index ? { ...k, ...patch } : k) });
  const updateModel = (id: string, patch: Partial<ModelDraft>) => d && update({ models: d.models.map(m => m.localId === id ? { ...m, ...patch } : m) });
  const open = (p: Provider | null) => {
    if (busy) return;
    const id = p?.id || NEW;
    if (openId === id) { keyRequest.current++; setKeyLoading(false); closeProtocol(); setKeyEdit(null); setKeyValue(""); setOpenId(null); return; }
    try { if (!drafts[id]) setDrafts(prev => ({ ...prev, [id]: p ? toDraft(p) : emptyDraft() })); }
    catch { return toast("供应商配置读取失败，请检查已有请求头数据", "err"); }
    keyRequest.current++; setKeyLoading(false); setProtocolMenu(null); setEndpointOpen({});
    setOpenId(id); setSubTab("provider"); setOpenModel(null); setKeyEdit(null); setKeyValue(""); setSaveError("");
  };
  useEffect(() => {
    const listener = () => { if (!busy && !loading && !error) { if (openId === NEW) setSubTab("provider"); else open(null); } };
    window.addEventListener("settings:new-provider", listener);
    return () => window.removeEventListener("settings:new-provider", listener);
  });
  const notify = () => window.dispatchEvent(new CustomEvent("app:settings-changed", { detail: { keys: ["providers"] } }));
  const persist = async (draft: EditorDraft, oldId: string): Promise<{ id: string; draft: EditorDraft } | null> => {
    const fail = (message: string) => { setSaveError(message); toast(message, "warn"); return null; };
    if (recoveryIds.current.has(oldId)) return fail("上次保存后刷新失败，请先重新读取供应商配置");
    let built: ProviderDraft | string;
    try { built = buildDraft(draft); }
    catch (e) { return fail(errMsg(e)); }
    if (typeof built === "string") return fail(built);
    let id: string;
    try {
      id = await api.providerSave(built);
    } catch (e) {
      const message = `保存失败，草稿已保留：${errMsg(e)}`;
      setSaveError(message);
      throw e;
    }
    setKeyEdit(null); setKeyValue("");
    const safeDraft = { ...draft, id, keys: draft.keys.map(k => ({ ...k, secret: "" })) };
    setDrafts(prev => { const next = { ...prev }; delete next[oldId]; next[id] = safeDraft; return next; });
    setOpenId(id); notify(); setSaveError("");
    try {
      const providers = await api.providerList();
      setList(providers);
      const saved = providers.find(p => p.id === id);
      if (!saved) throw new Error("saved provider unavailable");
      const canonical = toDraft(saved);
      canonical.models = canonical.models.map(m => {
        const original = draft.models.find(x => x.modelId === m.modelId);
        return { ...m, localId: original?.localId || m.localId, vision: original?.vision === null ? null : m.vision, modalityManual: original?.modalityManual, modalitySource: original?.modalitySource };
      });
      setDrafts(prev => ({ ...prev, [id]: canonical }));
      return { id, draft: canonical };
    } catch {
      recoveryIds.current.add(id); setError(true);
      setSaveError("供应商已保存，但刷新失败；编辑器与草稿保持展开，请先重新读取配置，避免重复新增密钥。");
      toast("供应商已保存，但刷新失败；请先重新读取配置，避免重复新增密钥", "warn");
      return null;
    }
  };
  /* CR-059 G12：保存后异步探测各密钥模型范围（≥2 启用密钥才探测）。完成后只弹一次自动消失的提示。 */
  const probeAfterSave = async (providerId: string) => {
    try {
      const outcomes: KeyProbeOutcome[] = await api.providerProbeKeyScopes(providerId);
      if (!outcomes.length) return;
      const skipped = outcomes.every(o => o.served == null && o.error && o.error.includes("无需探测"));
      if (skipped) return;
      const done = outcomes.filter(o => o.served != null);
      const failed = outcomes.length - done.length;
      if (!done.length) {
        toast("未取到密钥模型清单，已保留原范围", "warn");
        return;
      }
      toast(failed ? `已更新 ${done.length} 个密钥的模型范围；${failed} 个未取到清单已保留原范围` : "已根据探测结果更新各密钥的模型范围");
      await refresh();
    } catch (e) {
      // 探测失败不阻塞保存结果，也不写空范围。
      toast(`模型范围探测未完成：${errMsg(e)}`, "warn");
    }
  };
  const save = async (draft = d) => {
    if (!draft || !openId || lock.current) return;
    if (keyEdit) return toast("请先保存密钥行草稿或取消，再保存供应商", "warn");
    lock.current = true; setBusy(true);
    try {
      const saved = await persist(draft, openId);
      if (saved) {
        setSaveError("");
        setOpenId(null); setOpenModel(null); setKeyEdit(null); setKeyValue("");
        toast("供应商与模型修改已保存");
        void probeAfterSave(saved.id);
      }
    } catch (e) {
      const message = `保存失败，草稿已保留：${errMsg(e)}`;
      setSaveError(message);
      toast(message, "err");
    }
    finally { lock.current = false; setBusy(false); }
  };
  const discover = async () => {
    if (!d || !openId || lock.current) return;
    if (keyEdit) return toast("请先保存密钥行草稿或取消，再获取模型", "warn");
    const token = ++discoveryRequest.current;
    const originalId = openId;
    const keepSelected = picker?.selected ?? [];
    lock.current = true; setBusy(true);
    setPicker({ id: originalId, loading: true, error: false, models: [], selected: keepSelected });
    try {
      const saved = await persist(d, originalId);
      if (token !== discoveryRequest.current) return;
      if (!saved) {
        setPicker(prev => prev && ({ ...prev, loading: false, error: true, errorMsg: "供应商保存或配置读取失败，已保存模型与已选项均保留，请重试。" }));
        return;
      }
      setPicker(prev => prev && ({ ...prev, id: saved.id }));
      const models = await api.providerDiscoverModels(saved.id);
      if (token !== discoveryRequest.current) return;
      const existing = new Set(saved.draft.models.map(m => m.modelId));
      const available = models.filter(m => !existing.has(m.modelId));
      setPicker({
        id: saved.id, loading: false, error: false, models: available,
        selected: keepSelected.filter(id => available.some(m => m.modelId === id)),
      });
    } catch (e) {
      if (token === discoveryRequest.current) setPicker(prev => prev && ({ ...prev, loading: false, error: true, errorMsg: errMsg(e) }));
    }
    finally { lock.current = false; setBusy(false); }
  };
  const saveSelected = async () => {
    if (!picker || !d || lock.current) return;
    const selected = picker.models.filter(m => picker.selected.includes(m.modelId));
    if (!selected.length) return toast("请先点选模型卡片", "warn");
    const base = d.models.length;
    const added = selected.map((m, i) => ({
      ...emptyModel(base + i),
      modelId: m.modelId, displayName: m.displayName,
      contextWindow: formatCapacity(m.contextWindow),
      thinking: m.thinking,
    }));
    lock.current = true; setBusy(true);
    try {
      if (await persist({ ...d, models: [...d.models, ...added] }, picker.id)) {
        setPicker(null);
        toast("所选模型已保存；能力字段保持未知，可用「自动获取思考等级」补齐");
      }
    } catch { toast("模型保存失败，所选项已保留", "err"); }
    finally { lock.current = false; setBusy(false); }
  };
  /* CR-059 G1：批量补齐——只处理尚未配置档位且非生图的模型。 */
  const resolveAll = async () => {
    if (!d || !openId || lock.current || resolving) return;
    if (keyEdit) return toast("请先保存密钥行草稿或取消", "warn");
    const targets = d.models.filter(m => !m.imageGen);
    if (!targets.length) return toast("所有模型都已配置思考档位");
    lock.current = true; setResolving(true);
    try {
      const saved = await persist(d, openId);
      if (!saved) return;
      const results = await api.providerResolveEfforts(saved.id, targets.map(m => m.modelId));
      let resolved = 0;
      setDrafts(prev => {
        const draft = prev[saved.id]; if (!draft) return prev;
        const models = draft.models.map(m => {
          const hit = results.find(r => r.modelId === m.modelId);
          if (!hit) return m;
          const known = resolvedModalities(m, hit);
          if (!Object.keys(hit.efforts).length) return known;
          resolved++;
          return {
            ...known,
            efforts: Object.keys(m.efforts).length ? m.efforts : { ...hit.efforts },
            mappings: mergeResolvedMappings(m.mappings, hit.efforts),
            defaultEffort: m.defaultEffort ?? hit.defaultEffort,
            thinking: true,
            contextWindow: m.contextWindow || formatCapacity(hit.contextWindow),
            maxTokens: m.maxTokens || formatCapacity(hit.maxTokens),
          };
        });
        return { ...prev, [saved.id]: { ...draft, models } };
      });
      const missing = results.filter(r => !Object.keys(r.efforts).length).length;
      toast(missing
        ? `已为 ${targets.length - missing} 个模型回显思考等级；${missing} 个未找到可信档位，请手动配置`
        : `已为 ${targets.length} 个模型回显思考等级`);
    } catch (e) { toast(errMsg(e), "err"); }
    finally { lock.current = false; setResolving(false); }
  };
  /* CR-059 G1：单模型「一键获取」（只取当前模型）。 */
  const resolveOne = async (model: ModelDraft) => {
    if (!d || !openId || lock.current) return;
    if (keyEdit) return toast("请先保存密钥行草稿或取消", "warn");
    lock.current = true; setBusy(true);
    try {
      const saved = await persist(d, openId);
      if (!saved) return;
      const [hit] = await api.providerResolveEfforts(saved.id, [model.modelId]);
      if (!hit) return;
      const apply = (patch: Partial<ModelDraft>) => setDrafts(prev => {
        const current = prev[saved.id]; if (!current) return prev;
        return { ...prev, [saved.id]: { ...current, models: current.models.map(m => m.modelId === model.modelId
          ? { ...resolvedModalities({ ...m, modalityManual: model.modalityManual }, hit), ...patch } : m) } };
      });
      if (!Object.keys(hit.efforts).length) {
        apply({});
        toast(hit?.note || "未找到可信档位，请手动配置；不会按名称猜测", "warn");
        return;
      }
      apply({
        efforts: { ...hit.efforts }, mappings: mergeResolvedMappings(model.mappings, hit.efforts), defaultEffort: hit.defaultEffort, thinking: true,
        contextWindow: model.contextWindow || formatCapacity(hit.contextWindow),
        maxTokens: model.maxTokens || formatCapacity(hit.maxTokens),
      });
      toast(`已获取该模型 ${Object.keys(hit.efforts).length} 个档位`);
    } catch (e) { toast(errMsg(e), "err"); }
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
  /* CR-059 G2：供应商级放弃修改——丢弃草稿，回到最近保存快照。 */
  const discard = () => {
    if (!openId) return;
    const saved = list.find(p => p.id === openId);
    setDrafts(prev => ({ ...prev, [openId]: saved ? toDraft(saved) : emptyDraft() }));
    keyRequest.current++; setKeyLoading(false); closeProtocol(); setEndpointOpen({});
    setKeyEdit(null); setKeyValue(""); setOpenModel(null); setSaveError("");
    toast("已放弃未保存修改");
  };
  /* CR-059 G3：模型拖动排序（指针 + 键盘等价）。 */
  const moveModel = async (from: number, to: number) => {
    if (!d || !openId || lock.current) return;
    const models = moveItem(d.models, from, to).map((m, sortOrder) => ({ ...m, sortOrder }));
    if (from === to || to < 0 || to >= d.models.length) return;
    const originalId = openId, original = d.models;
    update({ models });
    // 已保存行独立落序；未保存新增/删除只保留在草稿中，不能提交整个表单。
    const stored = list.find(p => p.id === originalId)?.models;
    if (!stored || stored.length !== models.length || models.some(m => !stored.some(s => s.id === m.id))) return;
    lock.current = true; setBusy(true);
    try {
      await api.providerModelsReorder(originalId, models.map(m => m.id!));
      setList(prev => prev.map(p => p.id === originalId ? { ...p, models: models.map(m => stored.find(s => s.id === m.id)!) } : p));
      notify(); toast("模型顺序已保存");
      try { setList(await api.providerList()); } catch { toast("顺序已保存，回读失败；请重试读取配置", "warn"); }
    } catch {
      setDrafts(prev => ({ ...prev, [originalId]: { ...prev[originalId], models: original } }));
      toast("模型排序失败，已恢复原顺序", "err");
    } finally { lock.current = false; setBusy(false); }
  };
  const moveProvider = async (from: number, to: number) => {
    if (lock.current || from === to || to < 0 || to >= list.length) return;
    const original = list, next = moveItem(list, from, to);
    lock.current = true; setBusy(true); setList(next);
    try { await api.providerReorder(next.map(p => p.id)); notify(); toast("供应商顺序已保存");
      try { setList(await api.providerList()); } catch { toast("顺序已保存，回读失败；请重试读取配置", "warn"); }
    }
    catch { setList(original); toast("供应商排序失败，已恢复原顺序", "err"); }
    finally { lock.current = false; setBusy(false); }
  };
  const editKey = async (index: number) => {
    if (!d || keyLoading) return;
    const key = d.keys[index], token = ++keyRequest.current;
    setKeyEdit({ index, mode: "value" }); setKeyAlias(key.alias); setKeyValue(key.secret); closeProtocol();
    if (!key.id || key.secret) return;
    setKeyLoading(true);
    try { const secret = await api.providerKeyReveal(d.id!, key.id); if (token === keyRequest.current) setKeyValue(secret); }
    catch { if (token === keyRequest.current) { setKeyEdit(null); toast("密钥读取失败，请重试", "err"); } }
    finally { if (token === keyRequest.current) setKeyLoading(false); }
  };
  const cancelKey = () => { keyRequest.current++; setKeyLoading(false); setKeyEdit(null); setKeyValue(""); setKeyAlias(""); };
  const copyKey = async (key: KeyDraft) => {
    try { const secret = key.secret || (key.id && d?.id ? await api.providerKeyReveal(d.id, key.id) : "");
      if (!secret) throw new Error("empty"); await navigator.clipboard.writeText(secret); toast("密钥已复制"); }
    catch { toast("密钥复制失败，请重试或允许剪贴板访问", "err"); }
  };
  const editor = () => {
    if (!d) return null;
    return <div className="set-provider-inline">
      <div className="set-tabs" role="tablist" aria-label="供应商配置页签">{SUBTABS.map(([id, label]) => <button key={id} role="tab" aria-selected={subTab === id} disabled={busy} onClick={() => setSubTab(id)}>{label}</button>)}</div>
      {saveError && <div className="set-save-error" role="alert">{saveError}</div>}
      <fieldset className="set-fieldset set-provider-body" disabled={busy}>
        {subTab === "provider" && <>
          <section className="set-pm-section"><div className="row"><b>API 密钥</b></div>
            <div className="set-key-list">{d.keys.map((k, i) => <div className={`set-key-item ${keyEdit?.index === i ? "editing" : ""}`} key={k.id || `new-${i}`}>
              <div className="set-key-row cr085-key-row">
                <input type="checkbox" checked={k.enabled} aria-label={`启用密钥 ${k.alias || i + 1}`} onChange={e => updateKey(i, { enabled: e.target.checked })} />
                <span className="set-key-value cr085-key-identity"><b title={k.alias}>{k.alias || "未命名密钥"}</b>
                  <span className="mono set-caption">{k.secret ? maskKey(k.secret) : k.masked || "待填写"}</span>
                  <button className="set-icon-btn" aria-label={`复制密钥明文 ${k.alias || i + 1}`} title="复制密钥明文" onClick={() => void copyKey(k)}><SettingsIcon name="copy" /></button>
                </span>
                <span className="set-key-actions">
                  <button className="set-link" aria-haspopup="menu" aria-expanded={protocolMenu?.index === i} onClick={e => setProtocolMenu(protocolMenu?.index === i ? null : { index: i, anchor: e.currentTarget })}>{k.protocol || "默认协议"}<SettingsIcon name="down" /></button>
                  <button className="set-link" onClick={() => { cancelKey(); setKeyEdit({ index: i, mode: "scope" }); setScopeDraft([...k.models]); }}>{k.models.length ? `${k.models.length} 个模型` : "全部模型"}</button>
                  <button className="set-link" onClick={() => void editKey(i)}>编辑</button>
                  <button className="set-link danger" onClick={() => { cancelKey(); setKeyEdit({ index: i, mode: "remove" }); }}>删除</button>
                </span>
              </div>
              {keyEdit?.index === i && <div className="set-key-form">
                {keyEdit.mode === "value" && <div className="cr085-key-fields">
                  <Field label="别名"><input className="input" aria-label="密钥别名" disabled={keyLoading} value={keyAlias} onChange={e => setKeyAlias(e.target.value)} /></Field>
                  <Field label="密钥"><input className="input mono" type="password" autoComplete="new-password" aria-label="密钥值" disabled={keyLoading} value={keyValue} onChange={e => setKeyValue(e.target.value)} /></Field>
                </div>}
                {keyLoading && <span role="status">读取密钥中…</span>}
                {keyEdit.mode === "scope" && <><b>可用模型</b><div className="set-chips">
                  {d.models.map(m => <button key={m.localId} className={`set-chip ${scopeDraft.includes(m.modelId) ? "on" : ""}`} aria-pressed={scopeDraft.includes(m.modelId)} onClick={() => setScopeDraft(prev => prev.includes(m.modelId) ? prev.filter(id => id !== m.modelId) : [...prev, m.modelId])}>{m.displayName || m.modelId}</button>)}
                  {!d.models.length && <span>暂无模型</span>}
                </div></>}
                {keyEdit.mode === "remove" && <p>删除「{k.alias || "该密钥"}」？</p>}
                <div className="row set-form-actions">
                  {keyEdit.mode === "scope" && <button className="set-link" onClick={() => setScopeDraft([])}>全部模型</button>}
                  <span className="spacer" /><button className="btn sm" onClick={cancelKey}>取消</button>
                  <button className={`btn sm ${keyEdit.mode === "remove" ? "danger" : "primary"}`} disabled={keyLoading} onClick={() => {
                    if (keyEdit.mode === "remove") update({ keys: d.keys.filter((_, j) => j !== i) });
                    else if (keyEdit.mode === "scope") updateKey(i, { models: [...scopeDraft], scopeSource: scopeDraft.length ? "manual" : null });
                    else { if (!keyValue.trim()) return toast("密钥不能为空", "warn"); updateKey(i, { alias: keyAlias, secret: keyValue }); }
                    cancelKey();
                  }}>{keyEdit.mode === "remove" ? "删除" : "保存"}</button>
                </div>
              </div>}
            </div>)}{!d.keys.length && <p className="set-caption set-pad">还没有密钥</p>}
              <button className="set-link cr085-add-key" onClick={() => { cancelKey(); setKeyEdit({ index: d.keys.length, mode: "value", isNew: true }); }}><SettingsIcon name="plus" />添加密钥</button>
            </div>
          </section>
          <section className="set-pm-section cr085-provider-identity">
            <Field label="供应商 ID"><input className="input mono" value={d.id || d.createId || ""} placeholder="自动生成" aria-label="供应商 ID" disabled={!!d.id} onChange={e => update({ createId: e.target.value })} /></Field>
            <Field label="供应商名称"><input className="input" value={d.name} aria-label="供应商名称" onChange={e => update({ name: e.target.value })} /></Field>
          </section>
          <section className="set-pm-section"><b>默认协议</b><div className="set-seg-cards" role="radiogroup" aria-label="供应商默认协议">
            {(["Chat", "Responses", "Anthropic"] as const).map(mode => <button key={mode} role="radio" aria-checked={d.apiMode === mode} className={`set-seg-card ${d.apiMode === mode ? "on" : ""}`} onClick={() => update({ apiMode: mode, protocol: mode === "Anthropic" ? "anthropic" : "openai" })}>{mode}</button>)}
          </div></section>
          <section className="set-pm-section"><b>API 地址</b>
            {d.endpoints.map((ep, i) => <div className="cr085-endpoint" key={ep.protocol}>
              {ep.baseUrl || endpointOpen[ep.protocol] ? <><span>{ep.protocol === "openai" ? "OpenAI" : "Anthropic"}</span><input className="input mono" value={ep.baseUrl} placeholder="https://…" aria-label={`${ep.protocol} 端点地址`} onChange={e => { setEndpointOpen(prev => ({ ...prev, [ep.protocol]: true })); update({ endpoints: d.endpoints.map((x, j) => i === j ? { ...x, baseUrl: e.target.value, enabled: !!e.target.value.trim() } : x) }); }} /></>
              : <button className="set-link" aria-expanded="false" onClick={() => setEndpointOpen(prev => ({ ...prev, [ep.protocol]: true }))}><SettingsIcon name="plus" />{ep.protocol === "openai" ? "OpenAI" : "Anthropic"} 地址</button>}
            </div>)}
          </section>
        </>}
        {subTab === "models" && <>
          <div className="row set-model-toolbar">
            <span className="set-caption">{d.models.length} 个模型</span>
            <span className="spacer" />
            <button className="set-link" disabled={resolving} onClick={resolveAll}>{resolving ? "获取中…" : "自动获取思考等级"}</button>
            <button className="set-link" onClick={() => { const model = emptyModel(d.models.length); update({ models: [...d.models, model] }); setOpenModel(model.localId); }}>手动添加</button>
            <button className="set-link strong" onClick={discover}>获取模型</button>
          </div>
          <div className="set-model-list">{d.models.map((m, index) => {
            const key = m.localId;
            const opened = openModel === key;
            const thinkingOn = m.thinking === false ? false : m.thinking === true || Object.keys(m.efforts).length > 0;
            const ctxError = capacityError(m.contextWindow);
            const maxError = capacityError(m.maxTokens);
            return <div className={`set-model-item ${dropTarget?.kind === "model" && dropTarget.index === index ? `cr085-drop-${dropTarget.after ? "after" : "before"}` : ""}`} key={key}
              onDragOver={e => { if (dragRef.current?.kind !== "model") return; e.preventDefault(); e.stopPropagation(); const rect = e.currentTarget.getBoundingClientRect(); setDropTarget({ kind: "model", index, after: e.clientY > rect.top + rect.height / 2 }); }}
              onDrop={e => { if (dragRef.current?.kind !== "model") return; e.preventDefault(); e.stopPropagation(); const rect = e.currentTarget.getBoundingClientRect(); void moveModel(dragRef.current.index, dropIndex(dragRef.current.index, index, e.clientY > rect.top + rect.height / 2)); dragRef.current = null; setDropTarget(null); }}>
              <div className="set-model-head">
                <button className="set-drag cr085-drag" disabled={busy} draggable={!busy} title="拖动排序 · Alt+↑/↓" aria-label={`排序模型 ${m.displayName || m.modelId}`}
                  onDragStart={e => { e.stopPropagation(); dragRef.current = { kind: "model", index }; e.dataTransfer.setData("text/plain", key); }}
                  onDragEnd={() => { dragRef.current = null; setDropTarget(null); }}
                  onKeyDown={e => { if (e.altKey && ["ArrowUp", "ArrowDown"].includes(e.key)) { e.preventDefault(); void moveModel(index, index + (e.key === "ArrowUp" ? -1 : 1)); } }}><SettingsIcon name="drag" /></button>
                <button className="set-model-select" aria-expanded={opened} onClick={() => setOpenModel(opened ? null : key)}>
                  <b>{m.displayName || m.modelId || "新模型"}</b>
                  <span className="mono set-model-id">{m.modelId || "待填写 ID"}</span>
                  <span className="set-model-tags">
                    {m.text && <span className="tag">文本</span>}
                    {m.vision && <span className="tag">图片</span>}
                    {m.vision == null && <span className="tag">视觉未知</span>}
                    {m.imageGen && <span className="tag">生图</span>}
                    {!m.imageGen && m.thinking !== false && !Object.keys(m.efforts).length && <span className="tag warn">档位未配</span>}
                  </span>
                  <span className="set-model-context">{capacityLabel(m.contextWindow)}</span>
                  <SettingsIcon name={opened ? "up" : "down"} />
                </button>
                <button className="set-icon-btn set-model-delete" aria-label={`删除模型 ${m.modelId || index + 1}`} onClick={() => setDeleteModel(key)}><SettingsIcon name="trash" /></button>
              </div>
              {opened && <div className="set-model-form">
                <div className="set-form-grid"><Field label="模型 ID"><input className="input mono" value={m.modelId} aria-label="模型 ID" onChange={e => updateModel(key, { modelId: e.target.value })} /></Field><Field label="显示名称"><input className="input" value={m.displayName} aria-label="模型显示名称" onChange={e => updateModel(key, { displayName: e.target.value })} /></Field></div>
                <Field label="支持模态"><div className="set-chips">{([["text", "文本"], ["vision", "图片"], ["imageGen", "生图"]] as const).map(([field, label]) => <button key={field} className={`set-chip ${m[field] ? "on" : ""}`} aria-pressed={m[field] === true} onClick={() => {
                  if (field === "text") updateModel(key, { modalityManual: true, modalitySource: "manual", text: !m.text, imageGen: !m.text ? false : m.imageGen });
                  else if (field === "imageGen") updateModel(key, { modalityManual: true, modalitySource: "manual", imageGen: !m.imageGen, text: !m.imageGen ? false : m.text, vision: !m.imageGen ? false : m.vision });
                  else updateModel(key, { modalityManual: true, modalitySource: "manual", vision: m.vision !== true, imageGen: m.vision !== true ? false : m.imageGen });
                }}>{label}</button>)}</div></Field>
                <span className="set-caption">模态来源：{m.modalitySource === "manual" ? "手动" : m.modalitySource === "vendor" ? "供应商" : m.modalitySource === "knowledge" ? "知识库" : "未知"}</span>
                <div className="row set-thinking-row"><b className="small">思考</b><SettingsSwitch checked={thinkingOn} label="思考开关" onChange={() => updateModel(key, { thinking: !thinkingOn })} /><span className="spacer" /><button className="set-link" onClick={() => resolveOne(m)}>一键获取</button></div>
                {thinkingOn && <>
                  <Field label="支持档位" >
                    <div className="set-chips">{EFFORT_LEVELS.map(level => {
                      const enabled = Object.prototype.hasOwnProperty.call(m.efforts, level);
                      return <button key={level} type="button" className={`set-chip ${enabled ? "on" : ""}`} aria-pressed={enabled} onClick={() => {
                        if (enabled) {
                          const next = { ...m.efforts };
                          delete next[level];
                          updateModel(key, { efforts: next, defaultEffort: m.defaultEffort === level ? null : m.defaultEffort });
                        } else {
                          updateModel(key, { efforts: { ...m.efforts, [level]: m.mappings[level] ?? level } });
                        }
                      }}>{level}</button>;
                    })}</div>
                  </Field>
                  <details className="set-effort-mappings">
                    <summary>档位映射 <span className="set-caption">全部 7 档</span></summary>
                    <div className="set-effort-map-list">{EFFORT_LEVELS.map(level => <label className="set-effort-map-row" key={level}>
                      <span className="mono small">{level}</span>
                      <input className="input mono" aria-label={`${level} 映射`} value={m.mappings[level] ?? level} onChange={e => updateModel(key, { mappings: { ...m.mappings, [level]: e.target.value } })} />
                      <span className="set-caption">{Object.prototype.hasOwnProperty.call(m.efforts, level) ? "启用" : "未启用"}</span>
                    </label>)}</div>
                  </details>
                </>}
                <div className={`set-form-grid ${thinkingOn ? "three" : ""}`}>
                  {thinkingOn && <Field label="默认思考强度"><select className="select" aria-label="默认思考强度" value={m.defaultEffort || ""} onChange={e => updateModel(key, { defaultEffort: e.target.value || null })}><option value="">跟随记忆</option>{EFFORT_LEVELS.filter(level => Object.prototype.hasOwnProperty.call(m.efforts, level)).map(level => <option key={level}>{level}</option>)}</select></Field>}
                  <Field label="上下文窗口" hint="留空 = 未知；支持 128K / 1M"><input className="input" inputMode="decimal" value={m.contextWindow} placeholder="留空 = 未知" aria-label="上下文窗口" aria-invalid={!!ctxError} onChange={e => updateModel(key, { contextWindow: e.target.value })} /></Field>
                  <Field label="最大输出" hint="留空 = 未知；支持 128K / 1M"><input className="input" inputMode="decimal" value={m.maxTokens} placeholder="留空 = 未知" aria-label="最大输出" aria-invalid={!!maxError} onChange={e => updateModel(key, { maxTokens: e.target.value })} /></Field>
                </div>
                {(ctxError || maxError) && <p className="set-field-error" role="alert">{ctxError ? `上下文窗口：${ctxError}` : `最大输出：${maxError}`}</p>}
                <div className="row set-form-actions"><span className="spacer" /><button className="btn sm" onClick={() => {
                  const saved = list.find(p => p.id === d.id)?.models.find(x => x.modelId === m.modelId);
                  if (saved) {
                    const canonical = toDraft(list.find(p => p.id === d.id)!).models.find(x => x.modelId === m.modelId)!;
                    update({ models: d.models.map(x => x.modelId === m.modelId ? canonical : x) });
                  } else update({ models: d.models.filter(x => x.modelId !== m.modelId) });
                  setOpenModel(null);
                  toast("已放弃该模型的修改");
                }}>放弃修改</button></div>
              </div>}
            </div>;
          })}{!d.models.length && <div className="set-empty"><b>还没有模型</b><p>点击「获取模型」保存供应商后从上游拉取并点选卡片。</p></div>}</div>
        </>}
      </fieldset>
      <div className="set-provider-foot"><span className="spacer" /><button className="btn" disabled={busy} onClick={discard}>放弃修改</button><button className="btn primary" disabled={busy} onClick={() => save()}>{busy ? "处理中…" : "保存供应商"}</button></div>
    </div>;
  };
  return <>
    <div className="cr085-count">{list.length} 个供应商</div>
    {loading && <p className="set-caption">加载供应商中…</p>}
    {error && <div className="set-note" role="alert">供应商读取失败，已有草稿保留。<button className="btn sm" disabled={busy} onClick={refresh}>重试</button></div>}
    {drafts[NEW] && <div className={`set-provider-card ${openId === NEW ? "open" : ""}`}><div className="set-provider-head"><button className="set-provider-select" disabled={busy} onClick={() => open(null)}><span className="set-provider-info"><b>{drafts[NEW].name || "新供应商"}</b><span>未保存草稿</span></span><SettingsIcon name={openId === NEW ? "up" : "down"} /></button></div>{openId === NEW && editor()}</div>}
    {list.map((p, index) => <div key={p.id} className={`set-provider-card ${openId === p.id ? "open" : ""} ${dropTarget?.kind === "provider" && dropTarget.index === index ? `cr085-drop-${dropTarget.after ? "after" : "before"}` : ""}`}
      onDragOver={e => { if (dragRef.current?.kind !== "provider") return; e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); setDropTarget({ kind: "provider", index, after: e.clientY > rect.top + rect.height / 2 }); }}
      onDrop={e => { if (dragRef.current?.kind !== "provider") return; e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); void moveProvider(dragRef.current.index, dropIndex(dragRef.current.index, index, e.clientY > rect.top + rect.height / 2)); dragRef.current = null; setDropTarget(null); }}>
      <div className="set-provider-head">
        <button className="set-drag cr085-drag" disabled={busy} draggable={!busy} title="拖动排序 · Alt+↑/↓" aria-label={`排序供应商 ${p.name}`}
          onDragStart={e => { dragRef.current = { kind: "provider", index }; e.dataTransfer.setData("text/plain", p.id); }} onDragEnd={() => { dragRef.current = null; setDropTarget(null); }}
          onKeyDown={e => { if (e.altKey && ["ArrowUp", "ArrowDown"].includes(e.key)) { e.preventDefault(); void moveProvider(index, index + (e.key === "ArrowUp" ? -1 : 1)); } }}><SettingsIcon name="drag" /></button>
        <button className="set-provider-select" disabled={busy} onClick={() => open(p)} aria-expanded={openId === p.id}>
          <span className="set-provider-info"><b>{p.name}</b><span>{p.protocol} · {p.keys.length} 个密钥 · {p.endpoints.length} 个端点 · {p.models.length} 个模型</span></span>
        </button>
        <span className={`set-status ${p.disabled ? "" : "good"}`}>{p.disabled ? "停用" : "启用"}</span>
        <SettingsSwitch checked={!p.disabled} label={`启用供应商 ${p.name}`} disabled={busy} onChange={v => toggle(p, v)} />
        <button className="set-icon-btn" disabled={busy} aria-label={`删除供应商 ${p.name}`} onClick={() => setDeleteProvider(p)}><SettingsIcon name="trash" /></button>
        <button className="set-icon-btn" disabled={busy} aria-label={`${openId === p.id ? "收起" : "展开"}供应商 ${p.name}`} onClick={() => open(p)}><SettingsIcon name={openId === p.id ? "up" : "down"} /></button>
      </div>{openId === p.id && editor()}</div>)}
    {!loading && !error && !list.length && !drafts[NEW] && <div className="set-empty">尚无供应商，请新建。</div>}
    {deleteProvider && <SettingsConfirm title="删除供应商" message={`确定删除「${deleteProvider.name}」？其密钥、端点与模型配置将一并移除。`} busy={busy} onCancel={() => setDeleteProvider(null)} onOk={removeProvider} />}
    {deleteModel != null && d && <SettingsConfirm title="删除模型" message="确认从供应商草稿移除此模型？保存供应商后生效。" onCancel={() => setDeleteModel(null)} onOk={() => { update({ models: d.models.filter(m => m.localId !== deleteModel) }); setDeleteModel(null); setOpenModel(null); }} />}
    {protocolMenu && d && d.keys[protocolMenu.index] && <ModelProtocolMenu anchor={protocolMenu.anchor} value={d.keys[protocolMenu.index].protocol}
      available={d.endpoints.filter(ep => ep.baseUrl.trim()).map(ep => ep.protocol)} onClose={closeProtocol} onPick={protocol => updateKey(protocolMenu.index, { protocol })} />}
    {keyEdit?.isNew && d && <SettingsDialog title="添加密钥" onClose={cancelKey} footer={<><button className="btn" onClick={cancelKey}>取消</button><button className="btn primary" onClick={() => {
      if (!keyValue.trim()) return toast("请填写密钥", "warn");
      update({ keys: [...d.keys, { alias: keyAlias.trim(), secret: keyValue, enabled: true, protocol: "", models: [], scopeSource: null, probedAt: null }] }); cancelKey();
    }}>保存</button></>}><div className="cr085-key-fields"><Field label="别名"><input className="input" value={keyAlias} aria-label="新密钥别名" onChange={e => setKeyAlias(e.target.value)} /></Field><Field label="密钥"><input className="input mono" type="password" autoComplete="new-password" value={keyValue} aria-label="新密钥值" onChange={e => setKeyValue(e.target.value)} /></Field></div></SettingsDialog>}
    {imageOpen && <SettingsImageGen onClose={() => setImageOpen(false)} onSaved={() => { toast("生图配置已保存"); void refresh(); }} />}
    {picker && <SettingsDialog title="获取模型" subtitle={`${d?.name || "供应商"} · 保存后真实发现，未知字段不猜测`} busy={busy} onClose={() => { discoveryRequest.current++; setPicker(null); }} footer={<>
      <button className="btn" disabled={busy} onClick={() => { discoveryRequest.current++; setPicker(null); }}>取消</button>
      {picker.loading
        ? <button className="btn primary" disabled>保存所选</button>
        : picker.error
          ? <button className="btn primary" disabled={busy} onClick={() => void discover()}>重试</button>
          : <button className="btn primary" disabled={busy || !picker.selected.length} onClick={() => void saveSelected()}>保存所选{picker.selected.length ? `（${picker.selected.length}）` : ""}</button>}
    </>}>
      {picker.loading ? <div className="set-discovery-status" role="status">
        <b>获取模型清单中…</b>
        
      </div> : picker.error ? <div className="set-discovery-status error" role="alert">
        <b>获取模型失败</b>
        <p className="set-caption">{picker.errorMsg || "上游模型发现失败，未生成虚构模型。"}</p>
        <p className="set-caption">已保存模型与已选项目均保留；修正后可重试。</p>
      </div> : <div className="set-model-pick-list" role="group" aria-label="从上游选择模型">{picker.models.map(m => {
        const on = picker.selected.includes(m.modelId);
        return <label key={m.modelId} className={`set-pick-row ${on ? "on" : ""}`}>
          <input type="checkbox" checked={on} aria-label={`选择模型 ${m.displayName || m.modelId}`} onChange={e => {
            const checked = e.target.checked;
            setPicker(prev => prev && ({ ...prev, selected: checked
              ? (prev.selected.includes(m.modelId) ? prev.selected : [...prev.selected, m.modelId])
              : prev.selected.filter(id => id !== m.modelId) }));
          }} />
          <span className="set-pick-main"><b>{m.displayName || m.modelId}</b><span className="mono set-caption">{m.modelId}</span></span>
          <span className="set-pick-ctx set-caption">{m.contextWindow == null ? "上下文未知" : `${capacityLabel(String(m.contextWindow))} 上下文`}</span>
        </label>;
      })}{!picker.models.length && <div className="set-empty"><b>没有更多模型</b><p>上游返回的模型都已在列表中。</p></div>}</div>}
      
    </SettingsDialog>}
  </>;
}
