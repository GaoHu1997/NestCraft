import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "@/api";
import type { McpScanGroup, McpServer, McpToolInfo } from "@/api";
import { Field, useToast } from "@/components/ui";
import { MCP_NAME_RE } from "./shared";
import { emptyMcpForm, formFromMcp, parseMcpJson, parseArgs, parseEnv, type McpForm } from "./capabilityHelpers";
import "./cr085-abilities.css";
import { SettingsConfirm, SettingsDialog, SettingsIcon, SettingsSwitch } from "./SettingsDialog";

/**
 * CR-059 F4/F5：MCP 管理。
 *
 * - 「导入」＝只读扫描其他 agent 的 MCP 配置（Claude Code ~/.claude.json、Codex config.toml、ZCode mcp.json），
 *   勾选导入为受管配置；敏感 env 只按受管密钥存储，列表与错误都不回显正文；
 * - 「添加 MCP」按图3表单：类型（STDIO/HTTP）/ 名称 / 命令（单行完整命令行）/ 额外参数（每行一个）/
 *   环境变量（每行一个 KEY=value）；footer 只有取消与保存；
 * - CR085：command为独立可执行路径；args/env使用可逆逐行编码，结构化导入不拼接后重拆。
 */

type McpDraft = Parameters<typeof api.mcpSave>[0];
const emptyForm = emptyMcpForm;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const isLoopbackUrl = (value: string) => {
  try { const url = new URL(value); return url.protocol === "https:" && LOOPBACK_HOSTS.has(url.hostname); } catch { return false; }
};
const MCP_AUTH_LABEL: Record<string, string> = {
  unauthenticated: "未授权", pending: "待浏览器回调", authenticated: "已授权",
  expired: "已过期", revoked: "已撤权", error: "连接失败",
};
const mcpAuthLabel = (status: string) => MCP_AUTH_LABEL[status] || "未知状态";

export const parseExtraArgs = parseArgs;
export const parseEnvLines = parseEnv;

export function buildDraft(form: McpForm): McpDraft | string {
  if (!MCP_NAME_RE.test(form.name.trim())) return "名称限字母、数字、下划线与中划线，长度 1–32";
  try {
    let command: string | undefined;
    let args: string[] = [];
    let env: Record<string, string> = {};
    if (form.transport === "stdio") {
      if (!form.commandLine.trim()) return "STDIO 需填写启动命令";
      command = form.commandLine;
      args = parseExtraArgs(form.argsText);
      env = parseEnvLines(form.envText);
    }
    if (form.transport === "http") {
      try {
        const url = new URL(form.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "HTTP 地址需有效且不含凭证";
      } catch { return "HTTP 地址不是有效 URL"; }
      if (form.authMode === "bearer" && !form.authToken.trim() && !form.id) return "静态令牌认证需要填写 Bearer 令牌";
      if (form.allowInsecureLocalTls && !isLoopbackUrl(form.url)) return "仅本机 loopback 的 HTTPS 地址可信任自签名证书";
    }
    return {
      id: form.id,
      name: form.name.trim(),
      transport: form.transport,
      command: form.transport === "stdio" ? command : undefined,
      args,
      env,
      url: form.transport === "http" ? form.url.trim() : undefined,
      enabled: form.enabled,
      authMode: form.transport === "http" ? form.authMode : "oauth",
      authToken: form.transport === "http" && form.authMode === "bearer" && form.authToken.trim() ? form.authToken.trim() : undefined,
      allowInsecureLocalTls: form.transport === "http" && form.allowInsecureLocalTls && isLoopbackUrl(form.url),
    };
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const formFromServer = formFromMcp;

export function SettingsMcp() {
  const toast = useToast();
  const [list, setList] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [mode, setMode] = useState<"add" | "edit" | "scan" | null>(null);
  const [form, setForm] = useState<McpForm>(emptyForm());
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<McpToolInfo[] | null>(null);
  const [testError, setTestError] = useState("");
  const [tested, setTested] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<McpServer | null>(null);
  const [scanGroups, setScanGroups] = useState<McpScanGroup[]>([]);
  const [scanSelected, setScanSelected] = useState<Record<string, boolean>>({});
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState("");
  const [legacyImport, setLegacyImport] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonMode, setJsonMode] = useState(false);
  const testing = useRef(new Set<string>());
  const [fileName, setFileName] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [imported, setImported] = useState<Record<string, McpForm>>({});
  const [importName, setImportName] = useState("");
  const lock = useRef(false);
  const authPoll = useRef<number | null>(null);
  const mounted = useRef(true);
  const fileRequest = useRef(0);
  useEffect(() => () => {
    mounted.current = false;
    fileRequest.current++;
    if (authPoll.current !== null) window.clearTimeout(authPoll.current);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true); setError(false);
    try { setList(await api.mcpList()); } catch { setError(true); } finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const notify = () => window.dispatchEvent(new CustomEvent("app:settings-changed", { detail: { keys: ["mcp"] } }));

  const resetDialogs = () => {
    setJsonText("");setJsonMode(false);
    setFormError(""); setFileName(""); setImported({}); setImportName(""); setFileLoading(false);
    setTestResult(null); setTestError(""); setScanGroups([]); setScanSelected({}); setScanError(""); setLegacyImport(false);
  };
  const open = (next: "add" | "edit" | "scan", server?: McpServer) => {
    fileRequest.current++;
    resetDialogs();
    setForm(server ? formFromServer(server) : emptyForm());
    setMode(next);
    if (next === "scan") void loadScan();
  };
  const close = () => { fileRequest.current++; setMode(null); resetDialogs(); setForm(emptyForm()); };
  const update = (patch: Partial<McpForm>) => { setForm(previous => {const next={...previous,...patch};if(importName)setImported(p=>({...p,[importName]:next}));return next;}); setFormError(""); setTestResult(null); setTestError(""); };

  const loadScan = async () => {
    setScanLoading(true); setScanError("");
    try { setScanGroups(await api.mcpScanSources()); }
    catch (e) { setScanError(String(e)); }
    finally { setScanLoading(false); }
  };

  const importScanned = async () => {
    if (lock.current) return;
    const picks = scanGroups.flatMap(group => group.items
      .filter(item => !item.imported && !item.error && scanSelected[`${item.agent}:${item.name}`])
      .map(item => ({ agent: item.agent, name: item.name })));
    if (!picks.length) return setScanError("请先勾选要导入的服务器");
    lock.current = true; setBusy(true); setScanError("");
    let ok = 0; const failures: string[] = [];
    try {
      for (const pick of picks) {
        try { await api.mcpImportSource(pick.agent, pick.name); ok += 1; }
        catch (e) { failures.push(`${pick.name}：${String(e).replace(/^Error:\s*/, "")}`); }
      }
      if (ok) { toast(`已导入 ${ok} 个 MCP 服务器${failures.length ? `，${failures.length} 个失败` : ""}`); notify(); await refresh(); }
      if (failures.length) setScanError(failures.join("；"));
      if (ok && !failures.length) close();
      else await loadScan();
    } finally { lock.current = false; setBusy(false); }
  };

  /** JSON 文件导入保留为扫描弹层内的次级入口（既有逻辑）。 */
  const readFile = async (file: File | undefined) => {
    if (!file) return;
    const request = ++fileRequest.current;
    setFileLoading(true); setFormError("");
    try {
      if (!/\.json$/i.test(file.name) || file.size > 2 * 1024 * 1024) throw new Error("invalid file");
      const text = await file.text();
      setJsonText(text);
      const forms = parseMcpJson(text);
      const names = Object.keys(forms);
      if (!names.length || names.length > 100) throw new Error("invalid server count");
      if (request !== fileRequest.current) return;
      setImported(forms); setImportName(names[0]); setForm(forms[names[0]]); setFileName(file.name);
      setMode("add");
      setJsonMode(true);
    } catch (e) {
      if (request === fileRequest.current) {setMode("add");setJsonMode(true);setFormError(e instanceof Error && e.message !== "invalid file" ? e.message : "请选择2 MB内的JSON文件");}
    } finally { if (request === fileRequest.current) setFileLoading(false); }
  };

  const verify = async (server: McpServer) => {
    if (testing.current.has(server.id)) return;
    testing.current.add(server.id);setTested(p=>({...p,[server.id]:"验证中…"}));
    try { const tools=await api.mcpDiscoverTools(server.id);setList(p=>p.map(s=>s.id===server.id?{...s,tools}:s));setTested(p=>({...p,[server.id]:`已连接 · ${tools.length} 个工具`}));notify(); }
    catch { setTested(p=>({...p,[server.id]:"连接失败"})); }
    finally { testing.current.delete(server.id); }
  };

  const save = async (_test: boolean) => {
    if (lock.current || fileLoading) return;
    const built = buildDraft(form);
    if (typeof built === "string") return setFormError(built);
    if (list.some(server => server.name === built.name && server.id !== form.id)) return setFormError("同名 MCP 服务器已存在");
    lock.current = true; setBusy(true); setFormError(""); setTestResult(null); setTestError("");
    try {
      const id = await api.mcpSave(built);
      setForm(previous => ({ ...previous, id }));
      setTested(previous => { const next = { ...previous }; delete next[id]; return next; });
      notify(); await refresh();
      close(); toast("MCP 配置已保存");
    } catch (e) {
      setFormError(`MCP 保存失败，表单已保留：${String(e).replace(/^Error:\s*/, "")}`);
    } finally { lock.current = false; setBusy(false); }
  };

  const pollAuth = async (serverId: string, rounds = 0): Promise<void> => {
    if (!mounted.current) return;
    if (rounds >= 300) { setList(previous => previous.map(x => x.id === serverId ? { ...x, authStatus: "expired" } : x)); return; }
    const status = await api.mcpAuthStatus(serverId);
    if (!mounted.current) return;
    setList(previous => previous.map(x => x.id === serverId ? { ...x, authStatus: status } : x));
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
      const result = await api.mcpAuthStart(server.id);
      setList(previous => previous.map(x => x.id === server.id ? { ...x, authStatus: "pending" } : x));
      toast(`已打开授权页面（${result.authorizationUrl ? "系统浏览器" : "外部浏览器"}），请完成授权`, "info");
      await pollAuth(server.id);
    } catch (error) {
      toast(String(error).replace(/^Error:\s*/, "") || "MCP 授权启动失败", "err");
      await refresh();
    } finally { lock.current = false; setBusy(false); }
  };
  const revoke = async (server: McpServer) => {
    if (lock.current || server.transport !== "http") return;
    lock.current = true; setBusy(true);
    try { await api.mcpAuthLogout(server.id); await refresh(); toast("MCP 授权已撤销"); }
    catch (error) { toast(String(error).replace(/^Error:\s*/, "") || "MCP 撤销失败", "err"); }
    finally { lock.current = false; setBusy(false); }
  };
  const toggle = async (server: McpServer, enabled: boolean) => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await api.mcpSetEnabled(server.id, enabled); setList(previous => previous.map(x => x.id === server.id ? { ...x, enabled } : x)); notify(); }
    catch { toast("MCP 启停配置保存失败", "err"); } finally { lock.current = false; setBusy(false); }
  };
  const remove = async () => {
    if (!deleteTarget || lock.current) return;
    lock.current = true; setBusy(true);
    try { await api.mcpDelete(deleteTarget.id); setList(previous => previous.filter(x => x.id !== deleteTarget.id)); setDeleteTarget(null); notify(); toast("MCP 已删除"); }
    catch { toast("MCP 删除失败", "err"); } finally { lock.current = false; setBusy(false); }
  };

  const selectable = scanGroups.reduce((total, group) =>
    total + group.items.filter(item => !item.imported && !item.error).length, 0);

  return <>
    <div className="row set-toolbar">
      <span className="set-caption">{list.length} 个服务器</span>
      <span className="spacer" />
      <button className="btn sm" disabled={busy || loading || error} onClick={() => open("scan")}>
        <SettingsIcon name="search" />导入
      </button>
      <button className="btn sm" disabled={busy} onClick={()=>{open("add");setJsonMode(true);}}>导入 JSON</button>
      <button className="btn sm primary" disabled={busy || loading || error} onClick={() => open("add")}>
        <SettingsIcon name="plus" />添加 MCP
      </button>
    </div>
    {loading && <p className="set-caption">加载 MCP 中…</p>}
    {error && <div className="set-note" role="alert">MCP 列表读取失败。<button className="btn sm" onClick={refresh}>重试</button></div>}
    <div className="set-cap-list cr085-mcp-list">{list.map(server => <div className="set-cap-row" key={server.id}>
      <span className="set-cap-icon"><SettingsIcon name="box" /></span>
      <button className="set-cap-main" disabled={busy} aria-label={`编辑 MCP ${server.name}`} onClick={() => open("edit", server)}>
        <b>{server.name}</b>
        <span className="mono cr085-mcp-target">{server.transport === "http" ? (server.url || "未填地址") : (server.command || "命令未知")}</span><span className={`cr085-mcp-state ${tested[server.id] === "连接失败" ? "error" : ""}`}>{tested[server.id] || "未验证连接"}</span>
      </button>
      <span className="set-status">{server.transport === "http"
        ? (server.authMode === "bearer" ? `静态令牌：${mcpAuthLabel(server.authStatus)}`
          : server.authMode === "none" ? "无认证" : `OAuth：${mcpAuthLabel(server.authStatus)}`)
        : (server.enabled ? "" : "已停用")}</span>
      {server.transport === "http" && server.authMode === "oauth" && <button className="btn sm" disabled={busy}
        onClick={() => server.authStatus === "authenticated" ? revoke(server) : authorize(server)}>
        {server.authStatus === "authenticated" ? "撤销授权" : server.authStatus === "pending" ? "等待回调" : "授权"}
      </button>}
      <button className="btn sm" disabled={tested[server.id] === "验证中…" || busy} onClick={() => void verify(server)}>{tested[server.id] === "验证中…" ? "验证中…" : tested[server.id] === "连接失败" ? "重试连接" : "验证连接"}</button>
      <button className="btn sm" disabled={busy || tested[server.id] === "验证中…"} onClick={() => open("edit", server)}>编辑</button>
      <SettingsSwitch checked={server.enabled} disabled={busy || tested[server.id] === "验证中…"} label={`启用 MCP ${server.name}`} onChange={value => toggle(server, value)} />
      <button className="set-icon-btn set-cap-delete" disabled={busy} aria-label={`删除 MCP ${server.name}`} onClick={() => setDeleteTarget(server)}><SettingsIcon name="trash" /></button>
    </div>)}{!loading && !error && !list.length && <div className="set-empty">尚无 MCP 服务器</div>}</div>

    {/* F4：扫描导入弹层（含 JSON 次级入口） */}
    {mode === "scan" && <SettingsDialog title="导入 MCP" subtitle="扫描本机其他 agent 的 MCP 配置 → 勾选 → 导入受管配置"
      busy={busy} width={640} onClose={close}
      footer={<>
        <button className="btn" disabled={busy} onClick={close}>取消</button>
        <button className="btn primary" disabled={busy || scanLoading} onClick={importScanned}>{busy ? "导入中…" : "导入所选"}</button>
      </>}>
      <fieldset className="set-fieldset" disabled={busy}>
        {scanLoading && <p className="set-caption">正在扫描…</p>}
        {scanError && <p className="set-err" role="alert">{scanError}</p>}
        {!scanLoading && scanGroups.map(group => <div className="scan-group" key={group.agent}>
          <div className="scan-group-h">
            <SettingsIcon name="bot" />
            <b>{group.agent}</b>
            <span className="mono set-caption ellipsis" title={group.root}>{group.root}</span>
            {!group.exists && <span className="tag">未找到配置</span>}
          </div>
          {group.exists && !group.items.length && <p className="set-caption">该配置中没有 MCP 服务器</p>}
          {group.items.map(item => {
            const key = `${item.agent}:${item.name}`;
            const disabled = item.imported || !!item.error;
            return <label className={`scan-row ${disabled ? "imported" : ""}`} key={key}>
              <input type="checkbox" checked={!!scanSelected[key]} disabled={disabled || busy}
                aria-label={`选择 MCP ${item.name}`}
                onChange={e => setScanSelected(previous => ({ ...previous, [key]: e.target.checked }))} />
              <span className="scan-main">
                <b>{item.name} <span className="tag">{item.transport}</span></b>
                <span className="mono ellipsis" title={item.url || item.command || ""}>{item.error || item.url || item.command || "未填地址"}</span>
                {!!item.envKeys.length && <span className="set-caption">环境变量 {item.envKeys.length} 个（值不回显）</span>}
              </span>
              {item.imported && <span className="tag">已导入</span>}
              {item.error && <span className="tag bad">不可用</span>}
            </label>;
          })}
        </div>)}
        {!scanLoading && !scanError && !selectable && <p className="set-caption">没有可导入的 MCP 配置。</p>}
        {legacyImport ? <Field label="JSON 文件">
          <div className="row">
            <input className="input" type="file" accept=".json,application/json" aria-label="选择 MCP 配置文件" disabled={fileLoading}
              onChange={e => { void readFile(e.target.files?.[0]); e.target.value = ""; }} />
            {fileName && <span className="set-caption">{fileName}</span>}
          </div>
        </Field> : <p className="set-caption">

          <button type="button" className="link-btn" onClick={() => setLegacyImport(true)}>从 JSON 文件导入…</button>
        </p>}
        {formError && <p className="set-err" role="alert">{formError}</p>}
      </fieldset>
    </SettingsDialog>}

    {/* F5：图3 表单（footer 只有取消/保存） */}
    {(mode === "add" || mode === "edit") && <SettingsDialog
      title={mode === "edit" ? "编辑 MCP" : "添加 MCP"}
      subtitle="仅保存配置；测试连接在列表行进行"
      busy={busy} width={620} onClose={close}
      footer={<>
        <button className="btn" disabled={busy || fileLoading} onClick={close}>取消</button>
        <button className="btn primary" disabled={busy || fileLoading} onClick={() => void save(false)}>{busy ? "保存中…" : "保存"}</button>
      </>}>
      <fieldset className="set-fieldset" disabled={busy}>
        {Object.keys(imported).length > 1 && <Field label="选择要导入的服务器">
          <select className="select" aria-label="选择导入 MCP" value={importName}
            onChange={e => { setImported(p=>({...p,[importName]:form}));setImportName(e.target.value); setForm(imported[e.target.value]); setTestResult(null); setTestError(""); }}>
            {Object.keys(imported).map(serverName => <option key={serverName}>{serverName}</option>)}
          </select>
        </Field>}
        <button className="btn sm" type="button" onClick={()=>setJsonMode(v=>!v)}>JSON 配置</button>
        {jsonMode && <Field label="JSON 配置"><textarea className="textarea mono cr085-json" rows={6} aria-label="MCP JSON 配置" value={jsonText} onChange={e=>setJsonText(e.target.value)}/><button className="btn sm" type="button" onClick={()=>{try {const forms=parseMcpJson(jsonText);const first=Object.keys(forms)[0];setImported(forms);setImportName(first);setForm(forms[first]);setFormError("");}catch(e){setFormError(e instanceof Error?e.message:"配置解析失败");}}}>解析并预览</button></Field>}
        <Field label="类型">
          <select className="select" aria-label="MCP 类型" value={form.transport}
            onChange={e => update({ transport: e.target.value as McpForm["transport"] })}>
            <option value="stdio">STDIO</option>
            <option value="http">HTTP</option>
          </select>
        </Field>
        <Field label="名称">
          <input className="input" aria-label="MCP 名称" placeholder="例如 workspace-files" value={form.name}
            onChange={e => update({ name: e.target.value })} />
        </Field>
        {form.transport === "stdio" ? <>
          <Field label="命令">
            <input className="input mono" aria-label="MCP 命令" value={form.commandLine}
              onChange={e => update({ commandLine: e.target.value })}
              placeholder="npx" />
          </Field>
          <Field label="参数（每行一项）">
            <textarea className="textarea mono" rows={3} aria-label="MCP 额外参数" value={form.argsText}
              onChange={e => update({ argsText: e.target.value })}
              placeholder={"-y\n@modelcontextprotocol/server-filesystem"} />
          </Field>
          <Field label="环境变量">
            <textarea className="textarea mono" rows={3} aria-label="MCP 环境变量" value={form.envText}
              onChange={e => update({ envText: e.target.value })}
              placeholder={"API_KEY=your-key-here\nDEBUG=true"} />
          </Field>
        </> : <>
          <Field label="URL">
            <input className="input mono" type="url" autoComplete="off" aria-label="MCP HTTP 地址"
              value={form.url} onChange={e => update({ url: e.target.value })} placeholder="https://example.com/mcp" />
          </Field>
          <Field label="认证方式">
            <select className="select" aria-label="MCP 认证方式" value={form.authMode}
              onChange={e => update({ authMode: e.target.value as McpForm["authMode"] })}>
              <option value="oauth">OAuth</option>
              <option value="bearer">静态令牌</option>
              <option value="none">无认证</option>
            </select>
          </Field>
          {form.authMode === "bearer" && <Field label="Bearer 令牌" >
            <input className="input mono" type="password" autoComplete="new-password" aria-label="MCP Bearer 令牌"
              value={form.authToken} onChange={e => update({ authToken: e.target.value })}
              placeholder={form.id ? "留空保留原令牌" : "粘贴服务提供的令牌"} />
          </Field>}
          {isLoopbackUrl(form.url) && <div className="row small">
            <span>信任本机自签名证书</span>
            <SettingsSwitch checked={form.allowInsecureLocalTls} label="信任本机自签名证书"
              onChange={allowInsecureLocalTls => update({ allowInsecureLocalTls })} />
          </div>}
        </>}

        {fileLoading && <p className="set-caption">读取配置中…</p>}
        {formError && <p className="set-err" role="alert">{formError}</p>}
        {testError && <p className="set-err" role="alert">{testError}</p>}
        {testResult && <div className="col">
          <b>本次发现 {testResult.length} 个工具</b>

          {testResult.map(tool => <div className="row small" key={tool.name}>
            <span className="mono">{tool.name}</span><span className="muted">{tool.description || "暂无说明"}</span>
          </div>)}
        </div>}
      </fieldset>
    </SettingsDialog>}

    {deleteTarget && <SettingsConfirm title="删除 MCP" message={`确定删除「${deleteTarget.name}」及其配置？`}
      busy={busy} onCancel={() => setDeleteTarget(null)} onOk={remove} />}
  </>;
}
