import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { serverTermOpen, serverTermInput, serverTermResize, serverTermClose } from "@/api";
import { errText } from "./HostForm";

/** 隐藏保留已打开的 shell 与滚动记录，但不打开、输入或 resize；离线／卸载关闭。 */
export function TerminalPane({ hostId, connected = false, visible = true }: { hostId: string; connected?: boolean; visible?: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failMsg, setFailMsg] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const active = connected && visible;
  const activeRef = useRef(active);
  activeRef.current = active;
  const activateRef = useRef<(() => void) | null>(null);
  const terminalRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !connected) return;
    setFailMsg(null);
    let disposed = false;
    let opening = false;
    let failed = false;
    let termId: string | null = null;
    let fitRaf = 0;
    const term = new Terminal({
      fontFamily: "Consolas, 'Cascadia Mono', 'JetBrains Mono', monospace",
      fontSize: 12,
      cursorBlink: true,
      disableStdin: !activeRef.current,
      scrollback: 5000,
      theme: { background: "#12151a", foreground: "#e6eaef", cursor: "#e6eaef", selectionBackground: "#2b6cf655" },
    });
    terminalRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    const reportError = (e: unknown) => { if (!disposed && activeRef.current) setFailMsg(errText(e)); };
    const input = term.onData((data) => {
      if (!disposed && activeRef.current && termId) void serverTermInput(hostId, termId, data).catch(reportError);
    });
    const doFit = () => {
      fitRaf = 0;
      if (disposed || !activeRef.current) return;
      try {
        fit.fit();
        if (termId && term.cols > 0 && term.rows > 0) void serverTermResize(hostId, termId, term.cols, term.rows).catch(reportError);
      } catch { /* 容器尺寸为 0 时忽略本次 fit。 */ }
    };
    const scheduleFit = () => {
      if (disposed || !activeRef.current) return;
      if (fitRaf) cancelAnimationFrame(fitRaf);
      fitRaf = requestAnimationFrame(doFit);
    };
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(container);
    const activate = () => {
      if (disposed || !activeRef.current || opening || failed) return;
      if (termId) { scheduleFit(); return; }
      opening = true;
      try { fit.fit(); } catch { /* 使用默认尺寸。 */ }
      void serverTermOpen(hostId, term.cols || 80, term.rows || 24, (data) => {
        // 已有 shell 的输出保留到滚动记录；隐藏时不会向远端发送输入。
        if (!disposed) term.write(data);
      }).then((id) => {
        opening = false;
        if (disposed) { void serverTermClose(id).catch(() => {}); return; }
        termId = id;
        if (activeRef.current) { term.focus(); scheduleFit(); }
      }).catch((e) => { opening = false; failed = true; if (!disposed) setFailMsg(errText(e)); });
    };
    activateRef.current = activate;
    activate();
    return () => {
      disposed = true;
      activateRef.current = null;
      terminalRef.current = null;
      if (fitRaf) cancelAnimationFrame(fitRaf);
      ro.disconnect(); input.dispose(); term.dispose();
      if (termId) void serverTermClose(termId).catch(() => {});
    };
  }, [hostId, connected, attempt]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.disableStdin = !active;
    if (active) activateRef.current?.();
  }, [active]);

  return <div className="term-host">
    <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    {failMsg && <div className="term-fail" role="alert"><div>终端不可用：{failMsg}</div><button className="btn sm" disabled={!active} onClick={() => setAttempt((n) => n + 1)}>重新打开终端</button></div>}
  </div>;
}
