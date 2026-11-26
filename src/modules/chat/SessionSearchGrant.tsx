import { useCallback, useEffect, useState } from "react";
import * as api from "@/api";
import "./session-search-grant.css";

/** CR-104：会话级搜索授权。默认范围是会话项目根；这里只管理「本会话额外目录」。 */
export function SessionSearchGrant({ sessionId }: { sessionId: string }) {
  const [scope, setScope] = useState<api.SearchSessionScope | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setScope(await api.searchSessionScopeGet(sessionId));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId]);

  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    if (busy) return;
    let picked: string | null = null;
    try { picked = await api.pickProjectDirectory(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return; }
    if (!picked) return;
    setBusy(true);
    try { await api.searchSessionDirsAdd(sessionId, picked); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const remove = async (dir: string) => {
    if (busy) return;
    setBusy(true);
    try { await api.searchSessionDirsRemove(sessionId, dir); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return <div className="search-grant">
    <p className="set-caption">本地搜索默认包含当前项目根目录，无需授权；此处添加的目录仅本会话有效。</p>
    <div className="search-grant-root">
      <span className="mono" title={scope?.projectRoot ?? ""}>{scope?.projectRoot ?? "未绑定项目，仅可使用下方额外目录"}</span>
      <span className="set-caption">{scope?.projectRoot ? "项目根 · 默认包含，不可移除" : "未绑定项目"}</span>
    </div>
    {scope?.permissionMode === "plan" && <p className="set-caption">当前会话为规划模式：只搜索项目根，额外目录不生效。</p>}
    <div className="search-grant-list">
      {(scope?.extraDirs ?? []).length > 0
        ? scope!.extraDirs.map(dir => <div className="search-grant-row" key={dir}>
            <span className="mono ellipsis" title={dir}>{dir}</span>
            <button type="button" className="link-btn" disabled={busy} onClick={() => void remove(dir)}>移除</button>
          </div>)
        : <p className="set-caption">尚未添加额外目录。</p>}
    </div>
    {error && <p className="set-err" role="alert">{error}</p>}
    <div className="search-grant-actions">
      <button type="button" className="btn sm" disabled={busy} onClick={() => void add()}>添加目录（仅本会话）</button>
    </div>
  </div>;
}
