import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "@/api";
import type { ToolEntry } from "@/api";
import { useToast } from "@/components/ui";
import { errMsg } from "./shared";
import { SettingsSwitch } from "./SettingsDialog";

const RISK_CLASS: Record<ToolEntry["risk"], string> = { low: "", medium: "warn", high: "bad" };
const RISK_LABEL: Record<ToolEntry["risk"], string> = { low: "低", medium: "中", high: "高" };
export function SettingsTool() {
  const toast = useToast();
  const [list, setList] = useState<ToolEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const lock = useRef(false);
  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try { setList(await api.toolList()); } catch (e) { setError(errMsg(e)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const toggle = async (tool: ToolEntry, enabled: boolean) => {
    if (lock.current) return;
    lock.current = true; setPending(tool.name);
    try { await api.toolSetEnabled(tool.name, enabled); setList(prev => prev.map(t => t.name === tool.name ? { ...t, enabled } : t)); window.dispatchEvent(new CustomEvent("app:settings-changed", { detail: { keys: ["tools"] } })); }
    catch (e) { toast(errMsg(e), "err"); } finally { lock.current = false; setPending(null); }
  };
  return <>
    <p className="set-caption set-toolbar">开关保存工具注册配置，不等于原生 CLI 安全门禁或授权已经生效。</p>
    {loading && <p className="set-caption">加载工具中…</p>}
    {error && <div className="set-note" role="alert">工具读取失败：{error}<button className="btn sm" onClick={refresh}>重试</button></div>}
    <div className="set-tool-table-wrap"><table className="set-tool-table"><thead><tr><th>工具</th><th>风险</th><th>说明</th><th>今日调用</th><th>状态</th></tr></thead><tbody>{list.map(t => <tr key={t.id}><td className="mono">{t.name}</td><td><span className={`tag ${RISK_CLASS[t.risk]}`}>{RISK_LABEL[t.risk]}</span></td><td className="muted">{t.description || "暂无说明"}</td><td className="muted" title="当前接口没有调用计数">—</td><td><SettingsSwitch checked={t.enabled} disabled={pending != null} label={`启用工具 ${t.name}`} onChange={v => toggle(t, v)} /></td></tr>)}</tbody></table>{!loading && !error && !list.length && <div className="set-empty">暂无内置工具</div>}</div>
  </>;
}
