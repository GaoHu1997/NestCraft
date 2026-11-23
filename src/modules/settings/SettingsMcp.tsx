import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "@/api";
import type { McpScanGroup, McpServer, McpToolInfo } from "@/api";
import { Field, useToast } from "@/components/ui";
import { MCP_NAME_RE } from "./shared";
import { SettingsConfirm, SettingsDialog, SettingsIcon, SettingsSwitch } from "./SettingsDialog";

/**
 * CR-059 F4/F5：MCP 管理。
 *
 * - 「导入」＝只读扫描其他 agent 的 MCP 配置（Claude Code ~/.claude.json、Codex config.toml、ZCode mcp.json），
 *   勾选导入为受管配置；敏感 env 只按受管密钥存储，列表与错误都不回显正文；
 * - 「添加 MCP」按图3表单：类型（STDIO/HTTP）/ 名称 / 命令（单行完整命令行）/ 额外参数（每行一个）/
 *   环境变量（每行一个 KEY=value）；footer 只有取消与保存；
 * - 解析：命令按 shell 词法拆分（引号/转义），额外参数逐行追加，env 逐行按首个 = 拆分，非法行报行号。
 */

type McpDraft = Parameters<typeof api.mcpSave>[0];
interface McpForm {
  id?: string;
  name: string;
  transport: "stdio" | "http";
  commandLine: string;
  argsText: string;
  envText: string;
  url: string;
  enabled: boolean;
  authMode: "oauth" | "bearer" | "none";
  authToken: string;
  allowInsecureLocalTls: boolean;
}
const emptyForm = (): McpForm => ({
  name: "", transport: "stdio", commandLine: "", argsText: "", envText: "",
  url: "", enabled: true, authMode: "oauth", authToken: "", allowInsecureLocalTls: false,
});
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const isLoopbackUrl = (value: string) => {
  try { const url = new URL(value); return url.protocol === "https:" && LOOPBACK_HOSTS.has(url.hostname); } catch { return false; }
};
const MCP_AUTH_LABEL: Record<string, string> = {
  unauthenticated: "未授权", pending: "待浏览器回调", authenticated: "已授权",
  expired: "已过期", revoked: "已撤权", error: "连接失败",
};
const mcpAuthLabel = (status: string) => MCP_AUTH_LABEL[status] || "未知状态";

/**
 * 命令按 shell 词法拆分：支持单/双引号与反斜杠转义；未闭合引号报错。
 * 与参考实现的 dsh 命令词法保持一致的最小实现。
 */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === "\\" && quote === '"' && i + 1 < line.length) { current += line[++i]; continue; }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (ch === "\\" && i + 1 < line.length) { current += line[++i]; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started) { out.push(current); current = ""; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote) throw new Error(`命令中的 ${quote} 引号未闭合`);
  if (started) out.push(current);
  return out;
}

/** 额外参数：每行一个；空行忽略；以 # 开头的行视为注释。 */
export function parseExtraArgs(text: string): string[] {
  return text.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"));
}

/** 环境变量：每行一个 KEY=value；非法行报行号（1 起）。 */
export function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const eq = line.indexOf("=");
    if (eq <= 0) throw new Error(`环境变量第 ${index + 1} 行不是 KEY=value 格式`);
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`环境变量第 ${index + 1} 行键名不合法：${key}`);
    env[key] = value;
  });
  return env;
}

export function buildDraft(form: McpForm): McpDraft | string {
  if (!MCP_NAME_RE.test(form.name.trim())) return "名称限字母、数字、下划线与中划线，长度 1–32";
  try {
    let command: string | undefined;
    let args: string[] = [];
    let env: Record<string, string> = {};
    if (form.transport === "stdio") {
      const tokens = splitCommandLine(form.commandLine);
      if (!tokens.length) return "STDIO 需填写启动命令";
      command = tokens[0];
      args = [...tokens.slice(1), ...parseExtraArgs(form.argsText)];
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

/** 既有配置 → 表单：命令与 args 合成单行命令行，其余参数逐行展示。 */
function formFrom(value: Record<string, unknown>, name: string): McpForm {
  const command = value.command;
  const url = value.url;
  const args = value.args ?? [];
  const env = value.env ?? {};
  if ((command != null && typeof command !== "string") || (url != null && typeof url !== "string")
    || !Array.isArray(args) || args.some(x => typeof x !== "string")
    || !env || typeof env !== "object" || Array.isArray(env) || Object.values(env).some(x => typeof x !== "string")) {
    throw new Error("invalid config");
  }
  // 传输范围：仅 stdio 与 HTTP。streamable-http 是 HTTP 传输的规范名，按 http 处理；SSE/WebSocket 不支持。
  if (value.transport && !["http", "stdio", "streamable-http"].includes(String(value.transport))) throw new Error("仅支持 stdio 或 HTTP 传输");
  const transport = value.transport === "http" || value.transport === "streamable-http" || typeof url === "string" ? "http" : "stdio";
  const quote = (token: string) => /[\s"']/.test(token) ? `"${token.replace(/"/g, '\\"')}"` : token;
  return {
    name, transport,
    commandLine: typeof command === "string" ? [command, ...(args as string[])].map(quote).join(" ") : "",
    argsText: "",
    envText: Object.entries(env as Record<string, string>).map(([key, val]) => `${key}=${val}`).join("\n"),
    url: typeof url === "string" ? url : "",
    enabled: value.enabled !== false,
    authMode: "oauth", authToken: "", allowInsecureLocalTls: false,
  };
}

function formFromServer(server: McpServer): McpForm {
  const quote = (token: string) => /[\s"']/.test(token) ? `"${token.replace(/"/g, '\\"')}"` : token;
  return {
    id: server.id,
    name: server.name,
    transport: server.transport === "http" ? "http" : "stdio",
    commandLine: [server.command ?? "", ...(server.args ?? [])].filter(Boolean).map(quote).join(" "),
    argsText: "",
    envText: Object.entries(server.env ?? {}).map(([key, val]) => `${key}=${val}`).join("\n"),
    url: server.url ?? "",
    enabled: server.enabled,
    authMode: server.authMode === "bearer" || server.authMode === "none" ? server.authMode : "oauth",
    authToken: "",
    allowInsecureLocalTls: server.allowInsecureLocalTls === true,
  };
}

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
  const update = (patch: Partial<McpForm>) => { setForm(previous => ({ ...previous, ...patch })); setFormError(""); setTestResult(null); setTestError(""); };

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
      const value = JSON.parse(await file.text()) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid config");
      const root = value as Record<string, unknown>;
      const entries = root.mcpServers;
      const forms: Record<string, McpForm> = Object.create(null);
      if (entries && typeof entries === "object" && !Array.isArray(entries)) {
        for (const [serverName, config] of Object.entries(entries)) {
          if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("invalid server");
          forms[serverName] = formFrom(config as Record<string, unknown>, serverName);
        }
      } else if (typeof root.name === "string") forms[root.name] = formFrom(root, root.name);
      else throw new Error("missing servers");
      const names = Object.keys(forms);
      if (!names.length || names.length > 100) throw new Error("invalid server count");
      if (request !== fileRequest.current) return;
      setImported(forms); setImportName(names[0]); setForm(forms[names[0]]); setFileName(file.name);
      setMode("add");
    } catch {
      if (request === fileRequest.current) setFormError("导入失败：请选择 2 MB 内包含 mcpServers 或单个 name 配置的 JSON；不显示可能含凭证的原错误正文");
    } finally { if (request === fileRequest.current) setFileLoading(false); }
  };

  const save = async (test: boolean) => {
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
      if (test) {
        try {
          const result = await api.mcpDiscoverTools(id);
          setTestResult(result); setTested(previous => ({ ...previous, [id]: "本次发现成功" }));
          await refresh();
        } catch {
          setTestError(form.transport === "http" ? "HTTP MCP 工具发现失败；请先完成 NestCraft 授权后重试。" : "本次工具发现失败；配置已保存。启用状态不代表已连接。");
          setTested(previous => ({ ...previous, [id]: "本次发现失败" }));
        }
      } else { close(); toast("MCP 配置已保存，未自动连接或启动进程"); }
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
      <span className="set-caption">{list.length} 个服务器 · 导入后为受管配置，外部删除不影响</span>
      <span className="spacer" />
      <button className="btn sm" disabled={busy || loading || error} onClick={() => open("scan")}>
        <SettingsIcon name="search" />导入
      </button>
      <button className="btn sm primary" disabled={busy || loading || error} onClick={() => open("add")}>
        <SettingsIcon name="plus" />添加 MCP
      </button>
    </div>
    {loading && <p className="set-caption">加载 MCP 中…</p>}
    {error && <div className="set-note" role="alert">MCP 列表读取失败。<button className="btn sm" onClick={refresh}>重试</button></div>}
    <div className="set-cap-list">{list.map(server => <div className="set-cap-row" key={server.id}>
      <span className="set-cap-icon"><SettingsIcon name="box" /></span>
      <button className="set-cap-main" disabled={busy} aria-label={`编辑 MCP ${server.name}`} onClick={() => open("edit", server)}>
        <b>{server.name}</b>
        <span>{server.transport} · <span className="mono">{server.transport === "http" ? (server.url || "未填地址") : (server.command || "命令未知")}</span> · {server.tools.length} 个已发现工具</span>
      </button>
      <span className="set-status">{server.transport === "http"
        ? (server.authMode === "bearer" ? `静态令牌：${mcpAuthLabel(server.authStatus)}`
          : server.authMode === "none" ? "无认证" : `OAuth：${mcpAuthLabel(server.authStatus)}`)
        : (server.enabled ? tested[server.id] || "启用 · 未验证连接" : "已停用")}</span>
      {server.transport === "http" && server.authMode === "oauth" && <button className="btn sm" disabled={busy}
        onClick={() => server.authStatus === "authenticated" ? revoke(server) : authorize(server)}>
        {server.authStatus === "authenticated" ? "撤销授权" : server.authStatus === "pending" ? "等待回调" : "授权"}
      </button>}
      <SettingsSwitch checked={server.enabled} disabled={busy} label={`启用 MCP ${server.name}`} onChange={value => toggle(server, value)} />
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
        {legacyImport ? <Field label="JSON 文件" hint="只读取用户选中的 JSON，不自动执行。">
          <div className="row">
            <input className="input" type="file" accept=".json,application/json" aria-label="选择 MCP 配置文件" disabled={fileLoading}
              onChange={e => { void readFile(e.target.files?.[0]); e.target.value = ""; }} />
            {fileName && <span className="set-caption">{fileName}</span>}
          </div>
        </Field> : <p className="set-caption">
          只读扫描其他 agent 的 MCP 配置；含敏感值的环境变量按受管密钥写入，不在列表回显。
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
            onChange={e => { setImportName(e.target.value); setForm(imported[e.target.value]); setTestResult(null); setTestError(""); }}>
            {Object.keys(imported).map(serverName => <option key={serverName}>{serverName}</option>)}
          </select>
        </Field>}
        <Field label="类型">
          <select className="select" aria-label="MCP 类型" value={form.transport}
            onChange={e => update({ transport: e.target.value as McpForm["transport"] })}>
            <option value="stdio">STDIO</option>
            <option value="http">HTTP</option>
          </select>
        </Field>
        <Field label="名称" hint="必填；字母、数字、下划线、中划线，1–32 位。">
          <input className="input" aria-label="MCP 名称" placeholder="例如 workspace-files" value={form.name}
            onChange={e => update({ name: e.target.value })} />
        </Field>
        {form.transport === "stdio" ? <>
          <Field label="命令" hint="启动 MCP 服务器的完整命令行（按 shell 词法拆分）。">
            <input className="input mono" aria-label="MCP 命令" value={form.commandLine}
              onChange={e => update({ commandLine: e.target.value })}
              placeholder="npx -y @modelcontextprotocol/server-filesystem D:/work" />
          </Field>
          <Field label="额外参数" hint="每行一个参数，追加到命令后。">
            <textarea className="textarea mono" rows={3} aria-label="MCP 额外参数" value={form.argsText}
              onChange={e => update({ argsText: e.target.value })}
              placeholder={"-y\n@modelcontextprotocol/server-filesystem"} />
          </Field>
          <Field label="环境变量" hint="每行一个 KEY=value；敏感值按受管密钥保存，不回显。">
            <textarea className="textarea mono" rows={3} aria-label="MCP 环境变量" value={form.envText}
              onChange={e => update({ envText: e.target.value })}
              placeholder={"API_KEY=your-key-here\nDEBUG=true"} />
          </Field>
        </> : <>
          <Field label="URL">
            <input className="input mono" type="password" autoComplete="new-password" aria-label="MCP HTTP 地址"
              value={form.url} onChange={e => update({ url: e.target.value })} placeholder="https://example.com/mcp" />
          </Field>
          <Field label="认证方式" hint="OAuth 由 NestCraft 完成浏览器授权；静态令牌直接使用服务提供的 Bearer；无认证仅用于受控服务。">
            <select className="select" aria-label="MCP 认证方式" value={form.authMode}
              onChange={e => update({ authMode: e.target.value as McpForm["authMode"] })}>
              <option value="oauth">OAuth</option>
              <option value="bearer">静态令牌</option>
              <option value="none">无认证</option>
            </select>
          </Field>
          {form.authMode === "bearer" && <Field label="Bearer 令牌" hint={form.id ? "留空则保留已保存令牌；仅写入受管密钥，保存后不回显。" : "仅写入受管密钥，不在列表、日志或错误中展示。"}>
            <input className="input mono" type="password" autoComplete="new-password" aria-label="MCP Bearer 令牌"
              value={form.authToken} onChange={e => update({ authToken: e.target.value })}
              placeholder={form.id ? "留空保留原令牌" : "粘贴服务提供的令牌"} />
          </Field>}
          {isLoopbackUrl(form.url) && <div className="row small">
            <span>信任本机自签名证书<span className="set-caption"> · 仅 loopback HTTPS，默认关闭</span></span>
            <SettingsSwitch checked={form.allowInsecureLocalTls} label="信任本机自签名证书"
              onChange={allowInsecureLocalTls => update({ allowInsecureLocalTls })} />
          </div>}
        </>}
        <div className="row small">启用配置
          <SettingsSwitch checked={form.enabled} label="启用 MCP 配置" onChange={enabled => update({ enabled })} />
        </div>
        {fileLoading && <p className="set-caption">读取配置中…</p>}
        {formError && <p className="set-err" role="alert">{formError}</p>}
        {testError && <p className="set-err" role="alert">{testError}</p>}
        {testResult && <div className="col">
          <b>本次发现 {testResult.length} 个工具</b>
          <p className="set-caption">本次发现成功不代表保持连接或完成权限验证。</p>
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
