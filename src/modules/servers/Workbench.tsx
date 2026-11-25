import { Icon } from "@/components/icons";
import { usePaneWidth, ResizeHandle, PaneToggle } from "@/components/pane-resize";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { serverList, serverConnect, serverDisconnect, serverMetrics, serverTree, serverReadFile, serverExec, serverExecApproved, serverExecReject, type FileNode, type ServerHost, type ExecResult } from "@/api";
import { useToast, Empty, Modal, Confirm } from "@/components/ui";
import { useApp } from "@/store/app";
import { errText } from "./HostForm";
import { hostAddress, osLabel, osLogoSrc } from "./hostVisual";
import { TerminalPane } from "./TerminalPane";
import { MonitorPane } from "./MonitorPane";

/**
 * 服务器工作台（CR-075）：左文件树 / 中终端 / 右监控。
 *
 * 打开即自动连接（不再有"连接/断开"按钮），关闭工作台页签由外层自动断开；
 * 失败只提供"重试"，不伪造已连接，也不显示旧主机的陈旧数据。
 */

const ROOT_PATH = "/";
const PREVIEW_LIMIT = 100 * 1024; // >100KB 只预览前 100KB 并提示

/* ---------------- 文件树 ---------------- */

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
  expanded: boolean;
  loading: boolean;
  children: TreeNode[] | null;
}

function toTreeNode(f: FileNode): TreeNode {
  return { name: f.name, path: f.path, isDir: f.isDir, size: f.size, expanded: false, loading: false, children: null };
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => (b.isDir ? 1 : 0) - (a.isDir ? 1 : 0) || a.name.localeCompare(b.name));
}

function mapTree(nodes: TreeNode[], path: string, fn: (n: TreeNode) => TreeNode): TreeNode[] {
  return nodes.map((n) => (n.path === path ? fn(n) : { ...n, children: n.children ? mapTree(n.children, path, fn) : null }));
}

function fmtSize(size: number | null): string {
  if (size == null) return "";
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

function FileTree({ hostId, connected, visible }: { hostId: string; connected: boolean; visible: boolean }) {
  const active = connected && visible;
  const activeRef = useRef(active);
  activeRef.current = active;
  const generation = useRef(0);
  const rootSeq = useRef(0);
  const previewSeq = useRef(0);
  const loadedRoot = useRef<string | null>(null);
  const toast = useToast();
  const [rootPath, setRootPath] = useState(ROOT_PATH);
  const [pathInput, setPathInput] = useState(ROOT_PATH);
  const [nodes, setNodes] = useState<TreeNode[] | null>(null);
  const [rootLoading, setRootLoading] = useState(false);
  const [rootErr, setRootErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; content: string; truncated: boolean; loading: boolean } | null>(null);

  const loadRoot = useCallback(
    async (path: string) => {
      if (!activeRef.current) return;
      const gen = generation.current;
      const seq = ++rootSeq.current;
      setRootLoading(true);
      setRootErr(null);
      try {
        const list = await serverTree(hostId, path);
        if (gen !== generation.current || seq !== rootSeq.current || !activeRef.current) return;
        setNodes(sortNodes(list.map(toTreeNode)));
        loadedRoot.current = path;
        setRootPath(path);
        setPathInput(path);
      } catch (e) {
        if (gen !== generation.current || seq !== rootSeq.current || !activeRef.current) return;
        setRootErr(errText(e));
        setNodes(null);
      } finally {
        if (gen === generation.current && seq === rootSeq.current) setRootLoading(false);
      }
    },
    [hostId]
  );

  useEffect(() => {
    generation.current += 1;
    setRootLoading(false);
    setPreview((prev) => !connected || prev?.loading ? null : prev);
    if (!connected) {
      loadedRoot.current = null;
      setNodes(null);
      setRootErr(null);
    } else {
      const clearLoading = (list: TreeNode[]): TreeNode[] => list.map(node => ({
        ...node, loading: false, children: node.children ? clearLoading(node.children) : null,
      }));
      setNodes(previous => previous ? clearLoading(previous) : previous);
    }
    if (active && loadedRoot.current !== rootPath) void loadRoot(rootPath);
    return () => { generation.current += 1; };
    // 切回可见状态保留已加载的树；只有首次读取、断线重连或显式刷新才重建。
  }, [active, connected, loadRoot]);

  const toggleDir = async (node: TreeNode) => {
    if (!activeRef.current || node.loading) return;
    const gen = generation.current;
    if (node.children) {
      // 折叠/展开已加载的目录
      setNodes((prev) => (prev ? mapTree(prev, node.path, (n) => ({ ...n, expanded: !n.expanded })) : prev));
      return;
    }
    setNodes((prev) => (prev ? mapTree(prev, node.path, (n) => ({ ...n, loading: true })) : prev));
    try {
      const list = await serverTree(hostId, node.path);
      if (gen !== generation.current || !activeRef.current) return;
      setNodes((prev) =>
        prev ? mapTree(prev, node.path, (n) => ({ ...n, loading: false, expanded: true, children: sortNodes(list.map(toTreeNode)) })) : prev
      );
    } catch (e) {
      if (gen !== generation.current || !activeRef.current) return;
      setNodes((prev) => (prev ? mapTree(prev, node.path, (n) => ({ ...n, loading: false })) : prev));
      toast(`读取目录失败：${errText(e)}`, "err");
    }
  };

  const openFile = async (node: TreeNode) => {
    if (!activeRef.current) return;
    const gen = generation.current;
    const seq = ++previewSeq.current;
    setPreview({ path: node.path, content: "", truncated: false, loading: true });
    try {
      const text = await serverReadFile(hostId, node.path);
      if (gen !== generation.current || seq !== previewSeq.current || !activeRef.current) return;
      const truncated = text.length > PREVIEW_LIMIT;
      setPreview({ path: node.path, content: truncated ? text.slice(0, PREVIEW_LIMIT) : text, truncated, loading: false });
    } catch (e) {
      if (gen !== generation.current || seq !== previewSeq.current || !activeRef.current) return;
      setPreview(null);
      toast(`SFTP 读取文件失败：${errText(e)}`, "err");
    }
  };

  const renderNodes = (list: TreeNode[], depth: number): ReactNode =>
    list.map((n) => (
      <div key={n.path}>
        <div
          className="ft-row clickable"
          style={{ paddingLeft: 6 + depth * 14 }}
          title={n.path}
          onClick={() => (n.isDir ? void toggleDir(n) : void openFile(n))}
        >
          <span className={`ft-caret ${n.isDir ? "" : "blank"}`}><Icon name={n.expanded ? "chevronDown" : "chevronRight"} size={12} /></span>
          <span className={`ft-icon ${n.isDir ? "dir" : ""}`} aria-hidden>
            {n.isDir ? (
              <Icon name={n.expanded ? "folderOpen" : "folder"} size={13} />
            ) : (
              <Icon name="file" size={13} />
            )}
          </span>
          <span className="ft-name">{n.name}</span>
          {n.loading && <span className="ft-note">…</span>}
          {!n.isDir && n.size != null && <span className="ft-file-size">{fmtSize(n.size)}</span>}
        </div>
        {n.isDir && n.expanded && n.children && (n.children.length > 0 ? renderNodes(n.children, depth + 1) : <div className="ft-note" style={{ paddingLeft: 34 + depth * 14 }}>（空目录）</div>)}
      </div>
    ));

  return (
    <div className="wb-tree">
      <div className="ft-head">
        <div className="ft-title">
          <h3>文件</h3>
          <button className="btn ghost sm" disabled={!active || rootLoading} onClick={() => void loadRoot(rootPath)} title="刷新当前目录" aria-label="刷新当前目录">
            刷新
          </button>
        </div>
        <div className="ft-path-row">
          <input
            className="input mono"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && active && pathInput.trim()) void loadRoot(pathInput.trim());
            }}
            placeholder="输入路径跳转"
            disabled={!active}
            aria-label="远端路径"
          />
          <button className="btn sm" disabled={!active || !pathInput.trim()} onClick={() => void loadRoot(pathInput.trim())}>
            跳转
          </button>
        </div>
        <span className="ft-note mono ellipsis">当前：{rootPath}</span>
      </div>
      <div className="ft-body">
        {!active ? (
          <div className="ft-hint">等待连接</div>
        ) : rootLoading ? (
          <div className="ft-hint">读取目录中…</div>
        ) : rootErr ? (
          <div className="ft-hint">
            SFTP 不可用或目录读取失败：{rootErr}
            <div style={{ marginTop: 8 }}>
              <button className="btn sm" onClick={() => void loadRoot(rootPath)}>
                重试
              </button>
            </div>
          </div>
        ) : nodes ? (
          nodes.length > 0 ? (
            renderNodes(nodes, 0)
          ) : (
            <div className="ft-hint">（空目录）</div>
          )
        ) : null}
      </div>

      {preview && visible && (
        <div className="srv-dialog"><Modal title={preview.path} onClose={() => { previewSeq.current += 1; setPreview(null); }} width={760} heightRatio={0.72}>
          {preview.loading ? (
            <div className="mon-loading">读取文件中…</div>
          ) : (
            <>
              {preview.truncated && (
                <div className="file-truncate-note">文件超过 100KB，仅显示前 100KB 内容。</div>
              )}
              <pre className="file-pre">{preview.content || "（空文件）"}</pre>
            </>
          )}
        </Modal></div>
      )}
    </div>
  );
}

/* ---------------- 受控命令（保留现有 IPC，不自动执行） ---------------- */

export function ControlledCommandPanel({ hostId, connected, visible }: { hostId: string; connected: boolean; visible: boolean }) {
  const [command, setCommand] = useState("");
  const [result, setResult] = useState<ExecResult | null>(null);
  const [executedCommand, setExecutedCommand] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const active = connected && visible;
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const perform = async (action: "execute" | "approve" | "reject") => {
    if (busyRef.current || !activeRef.current) return;
    const text = command.trim();
    const requestId = result?.requestId;
    if (action === "execute" ? (!text || result?.needsApproval) : !requestId) return;
    busyRef.current = true; setBusy(true); setError(null); setConfirming(false);
    try {
      if (action === "reject") {
        await serverExecReject(requestId!);
        if (alive.current) setResult(null);
      } else {
        const next = action === "approve" ? await serverExecApproved(requestId!) : await serverExec(hostId, text);
        if (!alive.current) return;
        if (action === "execute") setExecutedCommand(text);
        setResult(next);
        if (next.needsApproval && !next.requestId) setError("审批响应缺少 requestId，不能批准执行。");
      }
    } catch (e) { if (alive.current) setError(errText(e)); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };
  return <section className="wb-command" aria-label="受控命令">
    <div className="exec-row"><input className="input mono" aria-label="受控命令" placeholder="输入命令，显式执行；高风险逐次审批" value={command} disabled={busy || !!result?.needsApproval || !active} onChange={(e) => setCommand(e.target.value)} /><button className="btn sm" disabled={!active || busy || !command.trim() || !!result?.needsApproval} onClick={() => void perform("execute")}>{busy ? "处理中…" : "执行"}</button></div>
    {error && <div className="exec-note" role="alert">操作失败：{error}</div>}
    {result?.needsApproval ? <div className="approval-card"><b>高风险命令待审批</b><div className="cmd">{executedCommand}</div><div className="approval-kv">风险：{result.risk ?? "未知"} · 请求：{result.requestId ?? "缺失"}</div><div className="row"><button className="btn danger sm" disabled={!active || busy || !result.requestId} onClick={() => setConfirming(true)}>批准执行</button><button className="btn sm" disabled={!active || busy || !result.requestId} onClick={() => void perform("reject")}>拒绝</button></div></div> : result && <div className="exec-result"><div className="head"><span className="cmd-text">{executedCommand}</span><span className={result.exitCode === 0 ? "tag good" : "tag"}>退出码 {result.exitCode ?? "未知"}</span></div><pre className="exec-out">{result.output ?? "（无输出）"}</pre></div>}
    {confirming && active && <div className="srv-dialog"><Confirm title="批准高风险命令" message={`将在当前主机执行：\n${executedCommand}\n仅批准本次请求，不记忆放行。`} danger onOk={() => void perform("approve")} onCancel={() => setConfirming(false)} /></div>}
  </section>;
}

/* ---------------- 工作台 ---------------- */

export function Workbench({ hostId, visible = true }: { hostId: string; visible?: boolean }) {
  const { go } = useApp();
  const [host, setHost] = useState<ServerHost | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [connPhase, setConnPhase] = useState<"idle" | "connecting" | "fail">("idle");
  const [connError, setConnError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const loadSeq = useRef(0);
  const connectBusy = useRef(false);
  /** 每次进入本次工作台只自动试连一次；失败后等用户点"重试"，避免反复重连。 */
  const autoTried = useRef(false);
  const layoutRef = useRef<HTMLDivElement>(null);
  const files = usePaneWidth(`server:${hostId}`, "files", { default: 248, min: 180, max: 480, side: "left", containerRef: layoutRef, minCenter: 320, disabled: !visible });
  const monitor = usePaneWidth(`server:${hostId}`, "monitor", { default: 300, min: 220, max: 440, side: "right", containerRef: layoutRef, reserve: files.overlay ? 0 : files.width, minCenter: 320, disabled: !visible });

  const reload = useCallback(async () => {
    if (!visibleRef.current) return;
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const list = await serverList();
      if (seq !== loadSeq.current || !visibleRef.current) return;
      setHost(list.find((h) => h.id === hostId) ?? null);
      setLoadErr(null);
    } catch (e) {
      if (seq === loadSeq.current && visibleRef.current) setLoadErr(errText(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [hostId]);

  const connect = useCallback(async () => {
    if (connectBusy.current || !visibleRef.current) return;
    connectBusy.current = true;
    setConnPhase("connecting");
    setConnError(null);
    try {
      await serverConnect(hostId);
      // 工作台已被关掉：不留常驻连接（关闭页签即断开）。
      if (!visibleRef.current) {
        void serverDisconnect(hostId);
        return;
      }
      // 连接成功后采样一次，列表"上次采样"随之更新；采样失败不影响连接。
      try {
        await serverMetrics(hostId);
      } catch {
        /* 采样失败忽略 */
      }
      await reload();
      setConnPhase("idle");
    } catch (e) {
      if (visibleRef.current) {
        setConnPhase("fail");
        setConnError(errText(e));
      }
    } finally {
      connectBusy.current = false;
    }
  }, [hostId, reload]);

  useEffect(() => {
    if (!visible) return;
    autoTried.current = false;
    void reload();
    return () => {
      loadSeq.current += 1;
    };
  }, [reload, visible]);

  // 打开工作台自动连接：只在本次进入且当前确实未连接时发起一次。
  useEffect(() => {
    if (!visible || !host || host.connected || autoTried.current) return;
    autoTried.current = true;
    void connect();
  }, [visible, host, connect]);

  const retry = () => {
    autoTried.current = true;
    void connect();
  };

  if (loadErr) {
    return (
      <div className="wb-root">
        <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Empty title="主机信息读取失败" desc={loadErr} action={<button className="btn" onClick={() => void reload()}>重试</button>} />
        </div>
      </div>
    );
  }

  if (loading && !host && !loadErr) return <div className="wb-root"><div className="wb-status mon-loading">主机信息加载中…</div></div>;

  if (!host) {
    return (
      <div className="wb-root">
        <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Empty
            title="未找到该主机"
            desc="可能已被删除"
            action={
              <button className="btn" onClick={() => go({ page: "servers" })}>
                返回主机列表
              </button>
            }
          />
        </div>
      </div>
    );
  }

  const connected = host.connected;
  const connecting = !connected && connPhase !== "fail";
  const failed = !connected && connPhase === "fail";
  const logo = osLogoSrc(host.os);
  const address = hostAddress(host);

  return (
    <div className="srv-wb">
      <header className="srv-wb-head">
        <span className={`srv-wb-os${logo ? "" : " unknown"}`} title={osLabel(host.os)}>
          {logo ? <img src={logo} alt={`${osLabel(host.os)} 标识`} /> : <Icon name="server" size={16} />}
        </span>
        <b>{host.name}</b>
        <span className="mono srv-wb-addr">{address}</span>
        <span className="spacer" />
        <span className={`srv-wb-conn${connected ? " ok" : failed ? " fail" : " connecting"}`}>
          {!connected && <span className="srv-spin" aria-hidden />}
          {connected ? `已连接 · ${host.os || "系统未知"}` : failed ? "连接失败" : "正在连接"}
        </span>
      </header>

      <div className="wb-root pane-container" ref={layoutRef} style={{ gridTemplateColumns: `${files.overlay ? 0 : files.width}px minmax(0,1fr) ${monitor.overlay ? 0 : monitor.width}px` }}>
        <aside {...files.paneProps} className={`${files.paneProps.className} wb-file-pane`} style={files.style}>
          <FileTree hostId={hostId} connected={connected} visible={visible && files.visible} />
          <ResizeHandle pane={files} label="服务器文件" />
        </aside>

        <div className="wb-center">
          <div className="wb-term-strip">
            <span className={`dot ${connected ? "good" : "neutral"}`} aria-hidden />
            <span className="host-name">shell 1</span>
            <span className="spacer" />
            <span className="mono muted small">{address}</span>
          </div>
          {connected ? (
            <div className="wb-term-body">
              <TerminalPane hostId={hostId} connected={connected} visible={visible} />
            </div>
          ) : (
            <div className="srv-conn-state">
              {failed ? (
                <>
                  <b>连接失败</b>
                  <span className="srv-conn-sub">{connError || "无法建立连接"}</span>
                  <button className="btn sm" onClick={retry}>
                    重试
                  </button>
                </>
              ) : (
                <>
                  <span className="srv-spin lg" aria-hidden />
                  <b>正在连接</b>
                  <span className="srv-conn-sub">{address}</span>
                </>
              )}
            </div>
          )}
          <ControlledCommandPanel key={hostId} hostId={hostId} connected={connected} visible={visible} />
        </div>

        <aside {...monitor.paneProps} className={`${monitor.paneProps.className} wb-monitor-pane`} style={monitor.style}>
          <MonitorPane hostId={hostId} hostName={host.name} address={`${host.host}:${host.port}`} connected={connected} visible={visible && monitor.visible} />
          <ResizeHandle pane={monitor} label="服务器监控" />
        </aside>
        <div className="pane-controls"><PaneToggle pane={files} label="服务器文件" /><PaneToggle pane={monitor} label="服务器监控" /></div>
      </div>
    </div>
  );
}
