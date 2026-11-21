import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "@/api";
import type { McpServer, McpToolInfo } from "@/api";
import { Field, useToast } from "@/components/ui";
import { MCP_NAME_RE } from "./shared";
import { SettingsConfirm, SettingsDialog, SettingsIcon, SettingsSwitch } from "./SettingsDialog";

type McpDraft = Parameters<typeof api.mcpSave>[0];
interface McpForm { id?: string; name: string; transport: "stdio" | "http"; command: string; args: string; env: string; url: string; enabled: boolean; authMode: "oauth" | "bearer" | "none"; authToken: string; allowInsecureLocalTls: boolean }
const emptyForm = (): McpForm => ({ name: "", transport: "stdio", command: "", args: "", env: "", url: "", enabled: true, authMode: "oauth", authToken: "", allowInsecureLocalTls: false });
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const isLoopbackUrl = (value: string) => {
  try { const url = new URL(value); return url.protocol === "https:" && LOOPBACK_HOSTS.has(url.hostname); } catch { return false; }
};
const MCP_AUTH_LABEL: Record<string, string> = {
  unauthenticated: "未授权",
  pending: "待浏览器回调",
  authenticated: "已授权",
  expired: "已过期",
  revoked: "已撤权",
  error: "连接失败",
};
const mcpAuthLabel = (status: string) => MCP_AUTH_LABEL[status] || "未知状态";
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
    if (form.authMode === "bearer" && !form.authToken.trim() && !form.id) return "静态令牌认证需要填写 Bearer 令牌";
    if (form.allowInsecureLocalTls && !isLoopbackUrl(form.url)) return "仅本机 loopback 的 HTTPS 地址可信任自签名证书";
  }
  return { id: form.id, name: form.name.trim(), transport: form.transport, command: form.transport === "stdio" ? form.command.trim() : undefined, args, env, url: form.transport === "http" ? form.url.trim() : undefined, enabled: form.enabled,
    authMode: form.transport === "http" ? form.authMode : "oauth",
    authToken: form.transport === "http" && form.authMode === "bearer" && form.authToken.trim() ? form.authToken.trim() : undefined,
    allowInsecureLocalTls: form.transport === "http" && form.allowInsecureLocalTls && isLoopbackUrl(form.url) };
}
function formFrom(value: Record<string, unknown>, name: string): McpForm {
  const command = value.command;
  const url = value.url;
  const args = value.args ?? [];
  const env = value.env ?? {};
  if ((command != null && typeof command !== "string") || (url != null && typeof url !== "string") || !Array.isArray(args) || args.some(x => typeof x !== "string") || !env || typeof env !== "object" || Array.isArray(env) || Object.values(env).some(x => typeof x !== "string")) throw new Error("invalid config");
  // 传输范围：仅 stdio 与 HTTP。streamable-http 是 HTTP 传输的规范名，按 http 处理；SSE/WebSocket 不支持。
  if (value.transport && !["http", "stdio", "streamable-http"].includes(String(value.transport))) throw new Error("仅支持 stdio 或 HTTP 传输");
  return { name, transport: value.transport === "http" || value.transport === "streamable-http" || typeof url === "string" ? "http" : "stdio", command: typeof command === "string" ? command : "", url: typeof url === "string" ? url : "", args: JSON.stringify(args), env: JSON.stringify(env), enabled: value.enabled !== false, authMode: "oauth", authToken: "", allowInsecureLocalTls: false };
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
  const authPoll = useRef<number | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
    fileRequest.current++;
    if (authPoll.current !== null) window.clearTimeout(authPoll.current);
  }, []);
  const fileRequest = useRef(0);
  useEffect(() => () => { fileRequest.current++; }, []);
  const refresh = useCallback(async () => {
    setLoading(true); setError(false);
    try { setList(await api.mcpList()); } catch { setError(true); } finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const notify = () => window.dispatchEvent(new CustomEvent("app:settings-changed", { detail: { keys: ["mcp"] } }));
  const open = (next: "add" | "import" | "edit", s?: McpServer) => {
    fileRequest.current++; setMode(next); setForm(s ? { id: s.id, name: s.name, transport: s.transport, command: s.command || "", url: s.url || "", args: JSON.stringify(s.args), env: JSON.stringify(s.env), enabled: s.enabled, authMode: s.authMode === "bearer" || s.authMode === "none" ? s.authMode : "oauth", authToken: "", allowInsecureLocalTls: s.allowInsecureLocalTls === true } : emptyForm());
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
        } catch { setTestError(form.transport === "http" ? "HTTP MCP工具发现失败；请先完成NestCraft授权后重试。" : "本次工具发现失败；配置已保存。启用状态不代表已连接。"); setTested(prev => ({ ...prev, [id]: "本次发现失败" })); }
      } else { close(); toast("MCP 配置已保存，未自动连接或启动进程"); }
    } catch { setFormError("MCP 保存失败，表单已保留；请检查配置后重试"); }
    finally { lock.current = false; setBusy(false); }
  };
  const pollAuth = async (serverId: string, rounds = 0): Promise<void> => {
    if (!mounted.current) return;
    if (rounds >= 300) { setList(prev => prev.map(x => x.id === serverId ? { ...x, authStatus: "expired" } : x)); return; }
    const status = await api.mcpAuthStatus(serverId);
    if (!mounted.current) return;
    setList(prev => prev.map(x => x.id === serverId ? { ...x, authStatus: status } : x));
    if (status === "pending") {
      await new Promise<void>(resolve => { authPoll.current = window.setTimeout(resolve, 1000); });
      if (!mounted.current) return;
      return pollAuth(serverId, rounds + 1);
    }
    await refresh();
  };
  const authorize = async (server: McpServer) => {
    if (lock.current || server.transport !== "http") return;
    lock.current = true; setBusy(true); setTestError("");
    try {
      // 后端负责打开系统浏览器；前端不再二次打开，避免双开与误判拦截。
      const result = await api.mcpAuthStart(server.id);
      setList(prev => prev.map(x => x.id === server.id ? { ...x, authStatus: "pending" } : x));
      toast(`已打开授权页面（${result.authorizationUrl ? "系统浏览器" : "外部浏览器"}），请完成授权`, "info");
      await pollAuth(server.id);
    } catch (error) { toast(String(error).replace(/^Error:\s*/, "") || "MCP授权启动失败", "err"); await refresh(); }
    finally { lock.current = false; setBusy(false); }
  };
  const revoke = async (server: McpServer) => {
    if (lock.current || server.transport !== "http") return;
    lock.current = true; setBusy(true);
    try { await api.mcpAuthLogout(server.id); await refresh(); toast("MCP授权已撤销"); }
    catch (error) { toast(String(error).replace(/^Error:\s*/, "") || "MCP撤销失败", "err"); }
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
    <div className="set-cap-list">{list.map(s => <div className="set-cap-row" key={s.id}><span className="set-cap-icon"><SettingsIcon name="box" /></span><button className="set-cap-main" disabled={busy} aria-label={`编辑 MCP ${s.name}`} onClick={() => open("edit", s)}><b>{s.name}</b><span>{s.transport} · <span className="mono">{s.transport === "http" ? "HTTP 地址已配置" : s.command || "命令未知"}</span> · {s.tools.length} 个已发现工具</span></button><span className="set-status">{s.transport === "http" ? (s.authMode === "bearer" ? `静态令牌：${mcpAuthLabel(s.authStatus)}` : s.authMode === "none" ? "无认证" : `OAuth：${mcpAuthLabel(s.authStatus)}`) : (s.enabled ? tested[s.id] || "启用 · 未验证连接" : "已停用")}</span>{s.transport === "http" && s.authMode === "oauth" && <button className="btn sm" disabled={busy} onClick={() => s.authStatus === "authenticated" ? revoke(s) : authorize(s)}>{s.authStatus === "authenticated" ? "撤销授权" : s.authStatus === "pending" ? "等待回调" : "授权"}</button>}<SettingsSwitch checked={s.enabled} disabled={busy} label={`启用 MCP ${s.name}`} onChange={v => toggle(s, v)} /><button className="set-icon-btn set-cap-delete" disabled={busy} aria-label={`删除 MCP ${s.name}`} onClick={() => setDeleteTarget(s)}><SettingsIcon name="trash" /></button></div>)}{!loading && !error && !list.length && <div className="set-empty">尚无 MCP 服务器</div>}</div>
    {mode && <SettingsDialog title={mode === "import" ? "导入 MCP" : mode === "edit" ? "编辑 MCP" : "添加 MCP"} subtitle="仅保存配置；测试连接会启动所配置进程或访问 HTTP 地址" busy={busy} onClose={close} footer={<><button className="btn" disabled={busy || fileLoading} onClick={() => saveOrTest(true)}>{busy ? "处理中…" : "保存并测试连接"}</button><button className="btn" disabled={busy} onClick={close}>取消</button><button className="btn primary" disabled={busy || fileLoading} onClick={() => saveOrTest(false)}>保存</button></>}>
      <fieldset className="set-fieldset" disabled={busy}><div className="col">
        {mode === "import" && <><Field label="配置文件" hint="只读取用户选中的 JSON，不自动执行；每次明确导入一个服务器。"><input className="input" type="file" accept=".json,application/json" aria-label="选择 MCP 配置文件" disabled={fileLoading} onChange={e => { readFile(e.target.files?.[0]); e.target.value = ""; }} />{fileName && <span className="set-caption">{fileName}</span>}</Field>{Object.keys(imported).length > 1 && <Field label="选择要导入的服务器"><select className="select" aria-label="选择导入 MCP" value={importName} onChange={e => { setImportName(e.target.value); setForm(imported[e.target.value]); setTestResult(null); setTestError(""); }}>{Object.keys(imported).map(name => <option key={name}>{name}</option>)}</select></Field>}</>}
        <Field label="名称"><input className="input" aria-label="MCP 名称" value={form.name} onChange={e => update({ name: e.target.value })} /></Field>
        <Field label="传输"><select className="select" aria-label="MCP 传输方式" value={form.transport} onChange={e => update({ transport: e.target.value as McpForm["transport"] })}><option value="stdio">stdio</option><option value="http">HTTP</option></select></Field>
        {form.transport === "stdio" ? <><Field label="命令"><input className="input mono" aria-label="MCP 命令" value={form.command} onChange={e => update({ command: e.target.value })} placeholder="npx" /></Field><Field label="参数（JSON 字符串数组）"><input className="input mono" aria-label="MCP 参数" value={form.args} onChange={e => update({ args: e.target.value })} placeholder='["-y", "package-name"]' /></Field><Field label="环境变量（JSON 字符串对象）" hint="可能包含敏感值，不在列表或错误中展示。"><input className="input mono" type="password" autoComplete="new-password" aria-label="MCP 环境变量" value={form.env} onChange={e => update({ env: e.target.value })} placeholder="{}" /></Field></> : <>
          <Field label="HTTP 地址"><input className="input mono" type="password" autoComplete="new-password" aria-label="MCP HTTP 地址" value={form.url} onChange={e => update({ url: e.target.value })} placeholder="https://example.com/mcp" /></Field>
          <Field label="认证方式" hint="OAuth 由 NestCraft 完成浏览器授权；静态令牌直接使用服务提供的 Bearer；无认证仅用于受控服务。">
            <select className="select" aria-label="MCP 认证方式" value={form.authMode} onChange={e => update({ authMode: e.target.value as McpForm["authMode"] })}>
              <option value="oauth">OAuth</option><option value="bearer">静态令牌</option><option value="none">无认证</option>
            </select>
          </Field>
          {form.authMode === "bearer" && <Field label="Bearer 令牌" hint={form.id ? "留空则保留已保存令牌；仅写入受管密钥，保存后不回显。" : "仅写入受管密钥，不在列表、日志或错误中展示。"}><input className="input mono" type="password" autoComplete="new-password" aria-label="MCP Bearer 令牌" value={form.authToken} onChange={e => update({ authToken: e.target.value })} placeholder={form.id ? "留空保留原令牌" : "粘贴服务提供的令牌"} /></Field>}
          {isLoopbackUrl(form.url) && <div className="row small"><span>信任本机自签名证书<span className="set-caption"> · 仅 loopback HTTPS，默认关闭</span></span><SettingsSwitch checked={form.allowInsecureLocalTls} label="信任本机自签名证书" onChange={allowInsecureLocalTls => update({ allowInsecureLocalTls })} /></div>}
        </>}
        <div className="row small">启用配置<SettingsSwitch checked={form.enabled} label="启用 MCP 配置" onChange={enabled => update({ enabled })} /></div>
        {fileLoading && <p className="set-caption">读取配置中…</p>}{formError && <p className="set-err" role="alert">{formError}</p>}{testError && <p className="set-err" role="alert">{testError}</p>}{testResult && <div className="col"><b>本次发现 {testResult.length} 个工具</b><p className="set-caption">本次发现成功不代表保持连接或完成权限验证。</p>{testResult.map(t => <div className="row small" key={t.name}><span className="mono">{t.name}</span><span className="muted">{t.description || "暂无说明"}</span></div>)}</div>}
      </div></fieldset>
    </SettingsDialog>}
    {deleteTarget && <SettingsConfirm title="删除 MCP" message={`确定删除「${deleteTarget.name}」及其配置？`} busy={busy} onCancel={() => setDeleteTarget(null)} onOk={remove} />}
  </>;
}
