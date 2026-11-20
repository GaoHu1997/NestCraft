import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "@/api";
import type { McpServer, McpToolInfo } from "@/api";
import { Field, useToast } from "@/components/ui";
import { MCP_NAME_RE } from "./shared";
import { SettingsConfirm, SettingsDialog, SettingsIcon, SettingsSwitch } from "./SettingsDialog";

type McpDraft = Parameters<typeof api.mcpSave>[0];
interface McpForm { id?: string; name: string; transport: "stdio" | "http"; command: string; args: string; env: string; url: string; enabled: boolean }
const emptyForm = (): McpForm => ({ name: "", transport: "stdio", command: "", args: "", env: "", url: "", enabled: true });
function buildDraft(form: McpForm): McpDraft | string {
  if (!MCP_NAME_RE.test(form.name.trim())) return "名称限字母、数字、下划线与中划线，长度 1–32";
  let args: string[] = [], env: Record<string, string> = {};
  try {
    if (form.args.trim()) {
      const value = JSON.parse(form.args) as unknown;
      if (!Array.isArray(value) || value.some(v => typeof v !== "string")) return "参数需为 JSON 字符串数组，避免空格或引号被错误拆分";
      args = value;
    }
    if (form.env.trim()) {
      const value = JSON.parse(form.env) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some(v => typeof v !== "string")) return "环境变量需为 JSON 字符串对象";
      env = value as Record<string, string>;
    }
  } catch { return "参数或环境变量不是有效 JSON"; }
  if (form.transport === "stdio" && !form.command.trim()) return "stdio 需填写启动命令";
  if (form.transport === "http") {
    try { const url = new URL(form.url); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "HTTP 地址需有效且不含凭证"; }
    catch { return "HTTP 地址不是有效 URL"; }
  }
  return { id: form.id, name: form.name.trim(), transport: form.transport, command: form.transport === "stdio" ? form.command.trim() : undefined, args, env, url: form.transport === "http" ? form.url.trim() : undefined, enabled: form.enabled };
}
function formFrom(value: Record<string, unknown>, name: string): McpForm {
  const command = value.command;
  const url = value.url;
  const args = value.args ?? [];
  const env = value.env ?? {};
  if ((command != null && typeof command !== "string") || (url != null && typeof url !== "string") || !Array.isArray(args) || args.some(x => typeof x !== "string") || !env || typeof env !== "object" || Array.isArray(env) || Object.values(env).some(x => typeof x !== "string")) throw new Error("invalid config");
  if (value.transport && !["http", "stdio", "streamable-http"].includes(String(value.transport))) throw new Error("unsupported transport");
  return { name, transport: value.transport === "http" || value.transport === "streamable-http" || typeof url === "string" ? "http" : "stdio", command: typeof command === "string" ? command : "", url: typeof url === "string" ? url : "", args: JSON.stringify(args), env: JSON.stringify(env), enabled: value.enabled !== false };
}

export function SettingsMcp() {
  const toast = useToast();
  const [list, setList] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [mode, setMode] = useState<"add" | "import" | "edit" | null>(null);
  const [form, setForm] = useState<McpForm>(emptyForm());
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileName, setFileName] = useState("");
  const [imported, setImported] = useState<Record<string, McpForm>>({});
  const [importName, setImportName] = useState("");
  const [testResult, setTestResult] = useState<McpToolInfo[] | null>(null);
  const [testError, setTestError] = useState("");
  const [tested, setTested] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<McpServer | null>(null);
  const lock = useRef(false);
  const fileRequest = useRef(0);
  useEffect(() => () => { fileRequest.current++; }, []);
  const refresh = useCallback(async () => {
    setLoading(true); setError(false);
    try { setList(await api.mcpList()); } catch { setError(true); } finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const notify = () => window.dispatchEvent(new CustomEvent("app:settings-changed", { detail: { keys: ["mcp"] } }));
  const open = (next: "add" | "import" | "edit", s?: McpServer) => {
    fileRequest.current++; setMode(next); setForm(s ? { id: s.id, name: s.name, transport: s.transport, command: s.command || "", url: s.url || "", args: JSON.stringify(s.args), env: JSON.stringify(s.env), enabled: s.enabled } : emptyForm());
    setFormError(""); setFileName(""); setImported({}); setImportName(""); setFileLoading(false); setTestResult(null); setTestError("");
  };
  const close = () => { fileRequest.current++; setMode(null); setForm(emptyForm()); setImported({}); };
  const update = (patch: Partial<McpForm>) => { setForm(prev => ({ ...prev, ...patch })); setFormError(""); setTestResult(null); setTestError(""); };
  const readFile = async (file: File | undefined) => {
    if (!file) return;
    const request = ++fileRequest.current;
    setFileLoading(true); setFormError("");
    try {
      if (!/\.json$/i.test(file.name) || file.size > 2 * 1024 * 1024) throw new Error("invalid file");
      const value = JSON.parse(await file.text()) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid config");
      const root = value as Record<string, unknown>;
      const entries = root.mcpServers;
      const forms: Record<string, McpForm> = Object.create(null);
      if (entries && typeof entries === "object" && !Array.isArray(entries)) {
        for (const [name, config] of Object.entries(entries)) {
          if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("invalid server");
          forms[name] = formFrom(config as Record<string, unknown>, name);
        }
      } else if (typeof root.name === "string") forms[root.name] = formFrom(root, root.name);
      else throw new Error("missing servers");
      const names = Object.keys(forms);
      if (!names.length || names.length > 100) throw new Error("invalid server count");
      if (request !== fileRequest.current) return;
      setImported(forms); setImportName(names[0]); setForm(forms[names[0]]); setFileName(file.name);
    } catch { if (request === fileRequest.current) setFormError("导入失败：请选择 2 MB 内包含 mcpServers 或单个 name 配置的 JSON；不显示可能含凭证的原错误正文"); }
    finally { if (request === fileRequest.current) setFileLoading(false); }
  };
  const saveOrTest = async (test: boolean) => {
    if (lock.current || fileLoading) return;
    const built = buildDraft(form);
    if (typeof built === "string") return setFormError(built);
    if (list.some(s => s.name === built.name && s.id !== form.id)) return setFormError("同名 MCP 服务器已存在");
    if (mode === "import" && !fileName) return setFormError("请先选择本机配置文件");
    lock.current = true; setBusy(true); setFormError(""); setTestResult(null); setTestError("");
    try {
      const id = await api.mcpSave(built);
      setForm(prev => ({ ...prev, id }));
      setTested(prev => { const next = { ...prev }; delete next[id]; return next; });
      notify(); await refresh();
      if (test) {
        try {
          const result = await api.mcpDiscoverTools(id);
          setTestResult(result); setTested(prev => ({ ...prev, [id]: "本次发现成功" }));
          await refresh();
        } catch { setTestError("本次工具发现失败；配置已保存。启用状态不代表已连接。"); setTested(prev => ({ ...prev, [id]: "本次发现失败" })); }
      } else { close(); toast("MCP 配置已保存，未自动连接或启动进程"); }
    } catch { setFormError("MCP 保存失败，表单已保留；请检查配置后重试"); }
    finally { lock.current = false; setBusy(false); }
  };
  const toggle = async (s: McpServer, enabled: boolean) => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await api.mcpSetEnabled(s.id, enabled); setList(prev => prev.map(x => x.id === s.id ? { ...x, enabled } : x)); notify(); }
    catch { toast("MCP 启停配置保存失败", "err"); } finally { lock.current = false; setBusy(false); }
  };
  const remove = async () => {
    if (!deleteTarget || lock.current) return;
    lock.current = true; setBusy(true);
    try { await api.mcpDelete(deleteTarget.id); setList(prev => prev.filter(x => x.id !== deleteTarget.id)); setDeleteTarget(null); notify(); toast("MCP 已删除"); }
    catch { toast("MCP 删除失败", "err"); } finally { lock.current = false; setBusy(false); }
  };
  return <>
    <div className="row set-toolbar"><span className="set-caption">{list.length} 个服务器</span><span className="spacer" /><button className="btn sm" disabled={busy || loading || error} onClick={() => open("import")}><SettingsIcon name="upload" />导入</button><button className="btn sm primary" disabled={busy || loading || error} onClick={() => open("add")}><SettingsIcon name="plus" />添加 MCP</button></div>
    {loading && <p className="set-caption">加载 MCP 中…</p>}{error && <div className="set-note" role="alert">MCP 列表读取失败。<button className="btn sm" onClick={refresh}>重试</button></div>}
    <div className="set-cap-list">{list.map(s => <div className="set-cap-row" key={s.id}><span className="set-cap-icon"><SettingsIcon name="box" /></span><button className="set-cap-main" disabled={busy} aria-label={`编辑 MCP ${s.name}`} onClick={() => open("edit", s)}><b>{s.name}</b><span>{s.transport} · <span className="mono">{s.transport === "http" ? "HTTP 地址已配置" : s.command || "命令未知"}</span> · {s.tools.length} 个已发现工具</span></button><span className="set-status">{s.enabled ? tested[s.id] || "启用 · 未验证连接" : "已停用"}</span><SettingsSwitch checked={s.enabled} disabled={busy} label={`启用 MCP ${s.name}`} onChange={v => toggle(s, v)} /><button className="set-icon-btn set-cap-delete" disabled={busy} aria-label={`删除 MCP ${s.name}`} onClick={() => setDeleteTarget(s)}><SettingsIcon name="trash" /></button></div>)}{!loading && !error && !list.length && <div className="set-empty">尚无 MCP 服务器</div>}</div>
    {mode && <SettingsDialog title={mode === "import" ? "导入 MCP" : mode === "edit" ? "编辑 MCP" : "添加 MCP"} subtitle="仅保存配置；测试连接会启动所配置进程或访问 HTTP 地址" busy={busy} onClose={close} footer={<><button className="btn" disabled={busy || fileLoading} onClick={() => saveOrTest(true)}>{busy ? "处理中…" : "保存并测试连接"}</button><button className="btn" disabled={busy} onClick={close}>取消</button><button className="btn primary" disabled={busy || fileLoading} onClick={() => saveOrTest(false)}>保存</button></>}>
      <fieldset className="set-fieldset" disabled={busy}><div className="col">
        {mode === "import" && <><Field label="配置文件" hint="只读取用户选中的 JSON，不自动执行；每次明确导入一个服务器。"><input className="input" type="file" accept=".json,application/json" aria-label="选择 MCP 配置文件" disabled={fileLoading} onChange={e => { readFile(e.target.files?.[0]); e.target.value = ""; }} />{fileName && <span className="set-caption">{fileName}</span>}</Field>{Object.keys(imported).length > 1 && <Field label="选择要导入的服务器"><select className="select" aria-label="选择导入 MCP" value={importName} onChange={e => { setImportName(e.target.value); setForm(imported[e.target.value]); setTestResult(null); setTestError(""); }}>{Object.keys(imported).map(name => <option key={name}>{name}</option>)}</select></Field>}</>}
        <Field label="名称"><input className="input" aria-label="MCP 名称" value={form.name} onChange={e => update({ name: e.target.value })} /></Field>
        <Field label="传输"><select className="select" aria-label="MCP 传输方式" value={form.transport} onChange={e => update({ transport: e.target.value as McpForm["transport"] })}><option value="stdio">stdio</option><option value="http">HTTP</option></select></Field>
        {form.transport === "stdio" ? <><Field label="命令"><input className="input mono" aria-label="MCP 命令" value={form.command} onChange={e => update({ command: e.target.value })} placeholder="npx" /></Field><Field label="参数（JSON 字符串数组）"><input className="input mono" aria-label="MCP 参数" value={form.args} onChange={e => update({ args: e.target.value })} placeholder='["-y", "package-name"]' /></Field><Field label="环境变量（JSON 字符串对象）" hint="可能包含敏感值，不在列表或错误中展示。"><input className="input mono" type="password" autoComplete="new-password" aria-label="MCP 环境变量" value={form.env} onChange={e => update({ env: e.target.value })} placeholder="{}" /></Field></> : <Field label="HTTP 地址"><input className="input mono" type="password" autoComplete="new-password" aria-label="MCP HTTP 地址" value={form.url} onChange={e => update({ url: e.target.value })} placeholder="https://example.com/mcp" /></Field>}
        <div className="row small">启用配置<SettingsSwitch checked={form.enabled} label="启用 MCP 配置" onChange={enabled => update({ enabled })} /></div>
        {fileLoading && <p className="set-caption">读取配置中…</p>}{formError && <p className="set-err" role="alert">{formError}</p>}{testError && <p className="set-err" role="alert">{testError}</p>}{testResult && <div className="col"><b>本次发现 {testResult.length} 个工具</b><p className="set-caption">本次发现成功不代表保持连接或完成权限验证。</p>{testResult.map(t => <div className="row small" key={t.name}><span className="mono">{t.name}</span><span className="muted">{t.description || "暂无说明"}</span></div>)}</div>}
      </div></fieldset>
    </SettingsDialog>}
    {deleteTarget && <SettingsConfirm title="删除 MCP" message={`确定删除「${deleteTarget.name}」及其配置？`} busy={busy} onCancel={() => setDeleteTarget(null)} onOk={remove} />}
  </>;
}
