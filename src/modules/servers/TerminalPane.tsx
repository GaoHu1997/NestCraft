import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { serverTermOpen, serverTermInput, serverTermResize, serverTermClose } from "@/api";
import { errText } from "./HostForm";

/**
 * 前端兜底超时：后端对锁等待（3s）与通道开启/pty/shell（各 8s）分别限时并先返回具体错误，
 * 本计时只防 IPC 本身无响应。它不是连接判定门槛，也不代表任何提速倍数。
 */
const OPEN_WATCHDOG_MS = 30_000;

/**
 * 隐藏保留已打开的 shell 与滚动记录，但不打开、输入或 resize；离线／卸载关闭。
 * 终端就绪与文件树／监控相互独立：辅助请求再慢也不会让本组件等待它们，
 * 未就绪时既不缓存也不发送键盘输入，避免终端打开前把缓冲内容当命令执行。
 */
export function TerminalPane({ hostId, connected = false, visible = true }: { hostId: string; connected?: boolean; visible?: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failMsg, setFailMsg] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
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
    setReady(false);
    let disposed = false;
    let opening = false;
    let failed = false;
    let readyInner = false;
    let timedOut = false;
    let watchdog = 0;
    let termId: string | null = null;
    let fitRaf = 0;
    const term = new Terminal({
      fontFamily: "Consolas, 'Cascadia Mono', 'JetBrains Mono', monospace",
      fontSize: 12,
      cursorBlink: true,
      disableStdin: true,
      scrollback: 5000,
      theme: { background: "#12151a", foreground: "#e6eaef", cursor: "#e6eaef", selectionBackground: "#2b6cf655" },
    });
    terminalRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    try {
      term.open(container);
    } catch (e) {
      /* 容器在隐藏或 0 尺寸时无法初始化渲染器：保留可读失败态，不让异常冒泡成全局错误。 */
      terminalRef.current = null;
      term.dispose();
      if (!disposed) setFailMsg(`终端无法初始化：${errText(e)}`);
      return () => {
        disposed = true;
      };
    }
    const reportError = (e: unknown) => { if (!disposed && activeRef.current) setFailMsg(errText(e)); };
    const input = term.onData((data) => {
      // 未就绪或未激活时不缓存也不发送：终端打开前不执行任何输入。
      if (disposed || !activeRef.current || !readyInner || !termId) return;
      void serverTermInput(hostId, termId, data).catch(reportError);
    });
    const sized = () => container.clientWidth > 0 && container.clientHeight > 0;
    const doFit = () => {
      fitRaf = 0;
      if (disposed || !activeRef.current) return;
      /* 隐藏或 0 尺寸容器上 fit 会让 xterm 内部尺寸同步读到未初始化的 renderer（dimensions 未定义），
         这里直接跳过本次 fit，等下一次有尺寸时再算。 */
      if (!sized()) return;
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
      if (disposed || !activeRef.current || opening || failed || timedOut) return;
      if (termId) { scheduleFit(); return; }
      opening = true;
      /* open 之后同一帧 fit 会读到尚未初始化的渲染器尺寸（xterm 内部 dimensions 未定义）；
         放到下一帧再算，失败由 doFit 的尺寸检查兜住。 */
      if (sized()) {
        requestAnimationFrame(() => {
          if (disposed || !activeRef.current) return;
          try {
            fit.fit();
          } catch {
            /* 使用默认尺寸。 */
          }
        });
      }
      term.write("正在打开终端…\r\n");
      const openPromise = serverTermOpen(hostId, term.cols || 80, term.rows || 24, (data) => {
        // 已有 shell 的输出保留到滚动记录；隐藏时不会向远端发送输入。
        if (!disposed) term.write(data);
      });
      // 超时后迟到的 termId 立即关闭；否则远端 shell 与 TERMS 记录会失去所有者。
      openPromise.then((id) => { if (disposed || timedOut) void serverTermClose(id).catch(() => {}); }).catch(() => {});
      watchdog = window.setTimeout(() => {
        if (disposed || readyInner) return;
        // 保持 opening = true：这次打开仍视为在途，避免可见性切换时并行再开一个 shell。
        timedOut = true;
        // 即使此刻被隐藏也要记录失败，切回可见时才能看到原因和重试入口。
        if (!disposed) setFailMsg(`打开终端超时（${OPEN_WATCHDOG_MS / 1000} 秒），请重试`);
      }, OPEN_WATCHDOG_MS);
      openPromise.then((id) => {
        window.clearTimeout(watchdog);
        opening = false;
        if (disposed || timedOut) return;
        termId = id;
        readyInner = true;
        setReady(true);
        if (activeRef.current) { term.focus(); scheduleFit(); }
      }).catch((e) => {
        window.clearTimeout(watchdog);
        opening = false;
        failed = true;
        if (!disposed) setFailMsg(errText(e));
      });
    };
    activateRef.current = activate;
    activate();
    return () => {
      disposed = true;
      activateRef.current = null;
      terminalRef.current = null;
      window.clearTimeout(watchdog);
      if (fitRaf) cancelAnimationFrame(fitRaf);
      ro.disconnect(); input.dispose(); term.dispose();
      if (termId) void serverTermClose(termId).catch(() => {});
    };
  }, [hostId, connected, attempt]);

  useEffect(() => {
    // 就绪前禁止输入（不缓存按键）；就绪后仅在可见且已连接时接受输入。
    if (terminalRef.current) terminalRef.current.options.disableStdin = !active || !ready;
    if (active) activateRef.current?.();
  }, [active, ready]);

  return <div className="term-host">
    <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    {failMsg && <div className="term-fail" role="alert"><div>终端不可用：{failMsg}</div><button className="btn sm" disabled={!active} onClick={() => setAttempt((n) => n + 1)}>重新打开终端</button></div>}
  </div>;
}
