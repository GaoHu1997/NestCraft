import { useEffect, useRef, useState } from "react";
import "./thinking-indicator.css";

/**
 * UI-CR056 / C56-06A：运行态 logo。
 * 粒子来自 logo 自身像素（不是外挂装饰点）：logo 聚合 → 整体打散成粒子 →
 * 粒子绕中心旋转 → 回流重组成 logo，循环播放；背景透明，颜色取自 logo。
 */

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) return `${hours} 时 ${minutes} 分 ${seconds} 秒`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

const LOGO_SRC = "/brand/logo-sail.png";
/** 画布 CSS 尺寸：打散重组需要物理空间，30px 下粒子会糊成一团噪点。 */
const SIZE = 44;
/** 内部渲染倍率：粒子更密，散开时仍能看出粒子结构。 */
const SCALE = 3;
const CYCLE = 2800;

interface Particle {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: string;
  size: number;
}

function smooth(x: number): number {
  const v = Math.min(1, Math.max(0, x));
  return v * v * (3 - 2 * v);
}

/** 打散进度：停留 → 炸开 → 停留旋转 → 回流 → 停留。 */
function scatterAt(u: number): number {
  if (u < 0.1) return 0;
  if (u < 0.34) return smooth((u - 0.1) / 0.24);
  if (u < 0.5) return 1;
  if (u < 0.84) return 1 - smooth((u - 0.5) / 0.34);
  return 0;
}

function useLogoParticles(sizePx: number): Particle[] | null {
  const [particles, setParticles] = useState<Particle[] | null>(null);
  useEffect(() => {
    let alive = true;
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      if (!alive) return;
      const off = document.createElement("canvas");
      off.width = sizePx;
      off.height = sizePx;
      const ctx = off.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        setParticles([]);
        return;
      }
      const logoSize = sizePx * 0.56;
      ctx.drawImage(img, (sizePx - logoSize) / 2, (sizePx - logoSize) / 2, logoSize, logoSize);
      let data: ImageData;
      try {
        data = ctx.getImageData(0, 0, sizePx, sizePx);
      } catch {
        setParticles([]);
        return;
      }
      const cx = sizePx / 2;
      const cy = sizePx / 2;
      const list: Particle[] = [];
      for (let y = 0; y < sizePx; y += 1) {
        for (let x = 0; x < sizePx; x += 1) {
          const i = (y * sizePx + x) * 4;
          if (data.data[i + 3] < 110) continue;
          // 散开目标：保留粒子的方向身份，角度扰动让粒子云不是规整圆环。
          const angle = Math.atan2(y - cy, x - cx) + (Math.random() - 0.5) * 1.1;
          const radius = sizePx * (0.13 + Math.random() * 0.35);
          list.push({
            x0: x,
            y0: y,
            x1: cx + Math.cos(angle) * radius,
            y1: cy + Math.sin(angle) * radius,
            color: `rgb(${data.data[i]},${data.data[i + 1]},${data.data[i + 2]})`,
            size: Math.random() < 0.3 ? 1.5 : 1,
          });
        }
      }
      setParticles(list);
    };
    img.onerror = () => {
      if (alive) setParticles([]);
    };
    img.src = LOGO_SRC;
    return () => {
      alive = false;
    };
  }, [sizePx]);
  return particles;
}

export function ThinkingIndicator(props: { since?: number; label?: string }) {
  const since = props.since ?? Date.now();
  const [now, setNow] = useState(() => Date.now());
  const px = Math.round(SIZE * SCALE);
  const particles = useLogoParticles(px);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!particles || particles.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const cx = px / 2;
    const cy = px / 2;
    const start = performance.now();
    let raf = 0;

    const draw = (time: number) => {
      const u = reduceMotion ? 0 : ((time - start) % CYCLE) / CYCLE;
      const s = reduceMotion ? 0 : scatterAt(u);
      const rot = reduceMotion ? 0 : Math.PI * 2 * 1.25 * Math.pow(u, 0.92);
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      ctx.clearRect(0, 0, px, px);
      ctx.globalAlpha = 0.68 + 0.32 * Math.pow(1 - s, 0.7);
      for (const p of particles) {
        // 绕画布中心旋转散开目标；s=0 时回到 logo 原位，所以 logo 始终正立。
        const tx = cx + cos * (p.x1 - cx) - sin * (p.y1 - cy);
        const ty = cy + sin * (p.x1 - cx) + cos * (p.y1 - cy);
        const x = p.x0 + (tx - p.x0) * s;
        const y = p.y0 + (ty - p.y0) * s;
        ctx.fillStyle = p.color;
        ctx.fillRect(x, y, p.size, p.size);
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [particles, px]);

  return (
    <div className="chat-working" role="status" aria-live="polite">
      <span className="chat-working-logo" aria-hidden="true">
        <canvas ref={canvasRef} className="chat-working-canvas" width={px} height={px} style={{ width: SIZE, height: SIZE }} />
        {particles && particles.length === 0 && <img className="chat-working-fallback" src={LOGO_SRC} alt="" draggable={false} />}
      </span>
      <span className="chat-working-label">{props.label ?? "工作中…"}</span>
      <span className="chat-working-duration">{formatElapsed(now - since)}</span>
    </div>
  );
}
