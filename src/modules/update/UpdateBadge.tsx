import { useEffect, useRef, useState } from "react";
import * as api from "@/api";
import { useToast } from "@/components/ui";
import "./update.css";

/**
 * CR-046：标题栏右上角软件更新徽标。
 * 无更新不渲染；有更新显示绿色「更新」；下载并校验后显示橙色「重启」。
 * 设计基准 docs/UI/文档/UI-CR046-右上角更新入口.md。
 */

type Phase = "hidden" | "available" | "downloading" | "ready" | "applying";

const BADGE = { width: 54, height: 22, pad: 1.4, radius: 5 };
const CHECK_DELAY_MS = 2000;
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 700;

function ringPath(): string {
  const { width, height, pad, radius } = BADGE;
  const x0 = pad;
  const y0 = pad;
  const x1 = width - pad;
  const y1 = height - pad;
  const mid = (x0 + x1) / 2;
  return (
    `M ${mid} ${y0} H ${x1 - radius} A ${radius} ${radius} 0 0 1 ${x1} ${y0 + radius} ` +
    `V ${y1 - radius} A ${radius} ${radius} 0 0 1 ${x1 - radius} ${y1} ` +
    `H ${x0 + radius} A ${radius} ${radius} 0 0 1 ${x0} ${y1 - radius} ` +
    `V ${y0 + radius} A ${radius} ${radius} 0 0 1 ${x0 + radius} ${y0} H ${mid}`
  );
}

function ringPerimeter(): number {
  const { width, height, pad, radius } = BADGE;
  return (
    2 * (width - 2 * pad - 2 * radius) +
    2 * (height - 2 * pad - 2 * radius) +
    2 * Math.PI * radius
  );
}

function inTauri(): boolean {
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export function UpdateBadge() {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>("hidden");
  const [progress, setProgress] = useState(0);
  const [manifest, setManifest] = useState<api.UpdateManifest | null>(null);
  const [asset, setAsset] = useState<api.UpdateAsset | null>(null);
  const phaseRef = useRef<Phase>("hidden");
  const aliveRef = useRef(true);

  const moveTo = (next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  useEffect(() => {
    if (!inTauri()) return;
    let alive = true;
    aliveRef.current = true;
    let firstTimer: number | undefined;
    let checkTimer: number | undefined;
    let unlisten: (() => void) | undefined;
    let checking = false;

    const applyStatus = (status: api.UpdateStatus) => {
      if (!alive) return;
      if (status.phase === "ready") {
        moveTo("ready");
        setProgress(100);
      } else if (status.phase === "downloading" || status.phase === "verifying") {
        if (phaseRef.current !== "ready" && phaseRef.current !== "applying") {
          moveTo("downloading");
          setProgress(status.total > 0 ? Math.min(100, (status.done / status.total) * 100) : 0);
        }
      } else if (status.phase === "applying") {
        moveTo("applying");
      }
    };

    const check = async () => {
      if (!alive || checking) return;
      if (phaseRef.current === "downloading" || phaseRef.current === "ready" || phaseRef.current === "applying") return;
      checking = true;
      try {
        const result = await api.updateCheck();
        if (!alive) return;
        if (result.update_available && result.manifest && result.asset) {
          setManifest(result.manifest);
          setAsset(result.asset);
          moveTo("available");
        }
      } catch {
        /* 例行检查失败静默，不打扰用户。 */
      } finally {
        checking = false;
      }
    };

    void (async () => {
      try {
        const environment = await api.updateEnvironment();
        if (!alive || !environment.updatable) return;
        applyStatus(await api.updateStatus());
        try {
          const { listen } = await import("@tauri-apps/api/event");
          if (!alive) return;
          unlisten = await listen<api.UpdateStatus>("update-progress", event => applyStatus(event.payload));
        } catch {
          /* 无事件 API 时依赖状态轮询与主动检查。 */
        }
        firstTimer = window.setTimeout(() => void check(), CHECK_DELAY_MS);
        checkTimer = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
      } catch {
        /* 非 Tauri、后端不可用或开发环境：不显示入口。 */
      }
    })();

    return () => {
      alive = false;
      aliveRef.current = false;
      if (firstTimer) window.clearTimeout(firstTimer);
      if (checkTimer) window.clearInterval(checkTimer);
      unlisten?.();
    };
  }, []);

  const download = async () => {
    if (phaseRef.current !== "available" || !manifest || !asset) return;
    moveTo("downloading");
    setProgress(0);
    let poll: number | undefined;
    try {
      poll = window.setInterval(() => {
        if (phaseRef.current !== "downloading") return;
        void api
          .updateStatus()
          .then(status => {
            if (phaseRef.current !== "downloading") return;
            if (status.phase === "ready") {
              moveTo("ready");
              setProgress(100);
            } else if (status.phase === "downloading" || status.phase === "verifying") {
              setProgress(status.total > 0 ? Math.min(100, (status.done / status.total) * 100) : 0);
            }
          })
          .catch(() => {
            /* 忽略单次轮询失败。 */
          });
      }, POLL_INTERVAL_MS);
      await api.updateDownload(manifest.version, asset.sha256);
      if (aliveRef.current) {
        moveTo("ready");
        setProgress(100);
      }
    } catch (error) {
      if (aliveRef.current) {
        moveTo("available");
        setProgress(0);
        toast(`更新下载失败：${String(error)}`, "err");
      }
    } finally {
      if (poll) window.clearInterval(poll);
    }
  };

  const apply = async () => {
    if (phaseRef.current !== "ready") return;
    moveTo("applying");
    try {
      await api.updateApply(asset?.sha256 ?? null);
    } catch (error) {
      if (aliveRef.current) {
        moveTo("ready");
        toast(`重启安装失败：${String(error)}`, "err");
      }
    }
  };

  if (phase === "hidden") return null;

  const restart = phase === "ready" || phase === "applying";
  const busy = phase === "downloading" || phase === "applying";
  const percent = Math.max(0, Math.min(100, progress));
  const perimeter = ringPerimeter();
  const path = ringPath();
  const label = restart ? "重启" : "更新";
  const title =
    phase === "available"
      ? `发现新版本 v${manifest?.version ?? ""}，点击下载`
      : phase === "downloading"
        ? `正在下载更新 ${Math.round(percent)}%`
        : phase === "ready"
          ? "更新已下载并通过校验，点击重启并安装"
          : "正在重启并安装更新…";
  const aria =
    phase === "available"
      ? `发现新版本 v${manifest?.version ?? ""}，点击下载更新`
      : phase === "downloading"
        ? "正在下载更新"
        : phase === "ready"
          ? "更新已就绪，点击重启并安装"
          : "正在重启并安装更新";

  return (
    <button
      type="button"
      className="update-badge"
      data-phase={phase}
      title={title}
      aria-label={aria}
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={() => {
        if (phase === "available") void download();
        else if (phase === "ready") void apply();
      }}
    >
      <span className="ub">
        <svg className="ub-frame" viewBox={`0 0 ${BADGE.width} ${BADGE.height}`} aria-hidden="true">
          <path className="ub-track" d={path} />
          <path
            className="ub-bar"
            d={path}
            style={{ strokeDasharray: perimeter, strokeDashoffset: perimeter * (1 - percent / 100) }}
          />
        </svg>
        <span className="ub-lb">{label}</span>
        <span className="ub-loading" aria-hidden="true">
          <span className="ub-spinner" />
        </span>
      </span>
    </button>
  );
}
