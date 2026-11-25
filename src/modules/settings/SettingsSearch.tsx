import { useCallback, useEffect, useState } from "react";
import * as api from "@/api";
import { useToast } from "@/components/ui";
import { errMsg } from "./shared";
import { SettingsSwitch } from "./SettingsDialog";
import "./settings-search.css";

export function SettingsSearch() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [backend, setBackend] = useState<"default" | "tavily">("default");
  const [base, setBase] = useState("https://api.tavily.com");
  const [key, setKey] = useState("");
  const [timeoutSec, setTimeoutSec] = useState(20);
  const [maxResults, setMaxResults] = useState(10);
  const [webFetch, setWebFetch] = useState(true);

  const [projects, setProjects] = useState<api.Project[]>([]);
  const [pid, setPid] = useState("");
  const [dirs, setDirs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [c, ps] = await Promise.all([api.searchConfigGet(), api.listProjects()]);
      setBackend(c.backend === "tavily" ? "tavily" : "default");
      setBase(c.tavilyBaseUrl || "https://api.tavily.com");
      setHasKey(c.hasTavilyKey);
      setTimeoutSec(c.timeoutSec); setMaxResults(c.maxResults); setWebFetch(c.webFetchEnabled);
      setProjects(ps);
      setPid(prev => prev || ps[0]?.id || "");
    } catch (e) { setError(errMsg(e)); } finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadConfig(); }, [loadConfig]);

  useEffect(() => {
    if (!pid) { setDirs([]); return; }
    let alive = true;
    api.searchAuthDirsGet(pid).then(d => { if (alive) setDirs(d); }).catch(() => { if (alive) setDirs([]); });
    return () => { alive = false; };
  }, [pid]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await api.searchConfigSet({ backend, tavilyBaseUrl: base, tavilyKey: key.trim() ? key : undefined, timeoutSec, maxResults, webFetchEnabled: webFetch });
      setKey(""); toast("搜索配置已保存"); await loadConfig();
    } catch (e) { toast(errMsg(e), "err"); } finally { setSaving(false); }
  };

  const addDir = async () => {
    if (!pid) { toast("请先选择项目", "err"); return; }
    setBusy(true);
    try {
      const picked = await api.pickProjectDirectory();
      if (!picked) return;
      const next = Array.from(new Set([...dirs, picked]));
      setDirs(await api.searchAuthDirsSet(pid, next));
    } catch (e) { toast(errMsg(e), "err"); } finally { setBusy(false); }
  };

  const removeDir = async (d: string) => {
    if (!pid) return;
    setBusy(true);
    try { setDirs(await api.searchAuthDirsSet(pid, dirs.filter(x => x !== d))); }
    catch (e) { toast(errMsg(e), "err"); } finally { setBusy(false); }
  };

  if (loading) return <p className="set-caption">加载搜索配置中…</p>;
  if (error) return <p className="set-err" role="alert">{error}<button className="btn sm" onClick={() => void loadConfig()}>重试</button></p>;

  return <div className="set-search">
    <section className="card set-search-card">
      <h3>联网搜索</h3>
      <p className="set-caption">默认免 API key：抓取 DuckDuckGo（Bing 备用）。配置 Tavily 后优先使用；失败或未配置会自动回退默认。</p>
      <div className="set-search-row"><span className="set-search-label">后端</span>
        <label className="set-radio"><input type="radio" checked={backend === "default"} onChange={() => setBackend("default")} /> 默认（免 key）</label>
        <label className="set-radio"><input type="radio" checked={backend === "tavily"} onChange={() => setBackend("tavily")} /> Tavily</label>
      </div>
      {backend === "tavily" && <>
        <div className="set-search-row"><span className="set-search-label">API 地址</span><input className="set-search-input" value={base} onChange={e => setBase(e.target.value)} placeholder="https://api.tavily.com" /></div>
        <div className="set-search-row"><span className="set-search-label">API Key</span><input className="set-search-input" type="password" value={key} onChange={e => setKey(e.target.value)} placeholder={hasKey ? "已配置（留空保持不变）" : "填写 Tavily Key"} /></div>
      </>}
      <div className="set-search-row"><span className="set-search-label">超时（秒）</span><input className="set-search-input narrow" type="number" min={3} max={120} value={timeoutSec} onChange={e => setTimeoutSec(Number(e.target.value) || 20)} /></div>
      <div className="set-search-row"><span className="set-search-label">结果数上限</span><input className="set-search-input narrow" type="number" min={1} max={30} value={maxResults} onChange={e => setMaxResults(Number(e.target.value) || 10)} /></div>
      <div className="set-search-row"><span className="set-search-label">启用网页抓取 web_fetch</span><SettingsSwitch checked={webFetch} label="启用网页抓取" onChange={setWebFetch} /></div>
      <div className="set-search-row"><button className="btn primary" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存搜索配置"}</button></div>
    </section>

    <section className="card set-search-card">
      <h3>本地搜索授权目录</h3>
      <p className="set-caption">AI 的 fs_grep / fs_glob 只在当前项目已授权的目录内搜索（按项目/会话生效）。未授权时本地搜索工具会提示先授权。</p>
      <div className="set-search-row">
        <span className="set-search-label">项目</span>
        <select className="set-search-input" value={pid} onChange={e => setPid(e.target.value)}>
          {projects.length === 0 && <option value="">（暂无项目）</option>}
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button className="btn sm" disabled={busy || !pid} onClick={() => void addDir()}>添加目录…</button>
      </div>
      {dirs.length === 0
        ? <p className="set-caption">该项目尚未授权任何目录。</p>
        : <ul className="set-search-dirs">{dirs.map(d => <li key={d}><span className="mono">{d}</span><button className="link-btn" disabled={busy} onClick={() => void removeDir(d)}>移除</button></li>)}</ul>}
    </section>
  </div>;
}
