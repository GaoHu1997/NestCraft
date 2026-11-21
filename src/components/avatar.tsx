import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icons";
import * as api from "@/api";
import { AVATAR_STYLE_IDS, AVATAR_STYLE_LABELS, UserAvatar, type AvatarStyleId } from "@/components/icon-tiles";

const MAX_BYTES = 200 * 1024;
const FRAME = 200;
const LOGO = "/brand/logo-sail.png";
type Choice = { style: AvatarStyleId; photo: string | null };
type Crop = { zoom: number; x: number; y: number };
const INITIAL_CROP: Crop = { zoom: 100, x: 0, y: 0 };

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片无法解码，请重新选择"));
    img.src = src;
  });
}
function geometry(image: HTMLImageElement, crop: Crop) {
  const scale = Math.max(FRAME / image.naturalWidth, FRAME / image.naturalHeight) * crop.zoom / 100;
  const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
  const x = Math.max(-(width - FRAME) / 2, Math.min((width - FRAME) / 2, crop.x));
  const y = Math.max(-(height - FRAME) / 2, Math.min((height - FRAME) / 2, crop.y));
  return { width, height, scale, x, y };
}
function drawCrop(canvas: HTMLCanvasElement, image: HTMLImageElement, crop: Crop) {
  const g = geometry(image, crop), ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建头像预览");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, ((g.width - FRAME) / 2 - g.x) / g.scale,
    ((g.height - FRAME) / 2 - g.y) / g.scale, FRAME / g.scale, FRAME / g.scale,
    0, 0, canvas.width, canvas.height);
}

export function useAvatarPhoto(): string | null {
  const [photo, setPhoto] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => { api.avatarImageData().then(value => { if (alive) setPhoto(value); }).catch(() => {}); };
    load();
    window.addEventListener("app:avatar-changed", load);
    window.addEventListener("app:settings-changed", load);
    return () => { alive = false; window.removeEventListener("app:avatar-changed", load); window.removeEventListener("app:settings-changed", load); };
  }, []);
  return photo;
}
export function AvatarHoverEdit({ style, photo, onApply }: Choice & { onApply?: (next: Choice) => void }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="cr51-avatar-edit" aria-label="更换头像" title="更换头像" onClick={e => { e.stopPropagation(); setOpen(true); }}><Icon name="camera" size={12} /></button>
    {open && <AvatarDialog style={style} photo={photo} onClose={() => setOpen(false)} onApply={next => { onApply?.(next); setOpen(false); }} />}
  </>;
}
export function AvatarField({ style, photo, onChange }: Choice & { onChange: (next: Choice) => void }) {
  const [open, setOpen] = useState(false);
  return <>
    <div className="cr51-avatar-field">
      <div className="cr51-avatar-frame" data-avatar-style={style}>
        <UserAvatar size={72} photo={photo} label="当前头像" />
        <button type="button" className="cr51-avatar-edit" aria-label="更换头像" onClick={() => setOpen(true)}><Icon name="camera" size={14} /></button>
      </div>
      <div className="cr51-avatar-field-main"><b>头像</b><p className="set-caption">内置样式或自定义图片，PNG / JPG / WebP，不超过 200KB。</p></div>
      <button className="btn sm" type="button" onClick={() => setOpen(true)}>更换头像…</button>
    </div>
    {open && <AvatarDialog style={style} photo={photo} onClose={() => setOpen(false)} onApply={next => { onChange(next); setOpen(false); }} />}
  </>;
}

function AvatarDialog({ style, photo, onClose, onApply }: Choice & { onClose: () => void; onApply: (next: Choice) => void }) {
  const [draftStyle, setStyle] = useState(style);
  const [source, setSource] = useState<string | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<Crop>(INITIAL_CROP);
  const [fileName, setFileName] = useState(photo ? "当前头像" : "品牌 Logo");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(Boolean(photo));
  const [saving, setSaving] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ x: number; y: number; crop: Crop } | null>(null);
  const sequence = useRef(0);
  const busy = loading || saving;
  const g = image ? geometry(image, crop) : null;

  useEffect(() => {
    let alive = true;
    if (!photo) return;
    const seq = ++sequence.current;
    (async () => {
      const data = photo.startsWith("data:") ? photo : await api.avatarImageData();
      if (!data) throw new Error("当前头像文件已失效，请重新选择");
      const decoded = await loadImage(data);
      if (alive && sequence.current === seq) { setSource(data); setImage(decoded); }
    })().catch(e => { if (alive) setError(String(e)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [photo]);
  useEffect(() => {
    if (canvasRef.current && image) drawCrop(canvasRef.current, image, crop);
  }, [image, crop]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopImmediatePropagation(); if (!saving) onClose(); }
      if (event.key === "Tab") {
        const nodes = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]):not([hidden]),[tabindex="0"]') ?? []);
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); previous?.focus(); };
  }, [onClose, saving]);
  function preset(id: AvatarStyleId) {
    sequence.current++;
    setLoading(false); setStyle(id); setSource(null); setImage(null); setCrop(INITIAL_CROP); setError(""); setFileName("品牌 Logo");
  }
  async function choose(file?: File) {
    if (!file) return;
    setError("");
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return setError("请选择 PNG、JPG 或 WebP 图片，当前头像保持不变。");
    if (file.size > MAX_BYTES) return setError("图片超过 200KB，请压缩后重新选择，当前头像保持不变。");
    const seq = ++sequence.current;
    setLoading(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("读取图片失败")); reader.readAsDataURL(file);
      });
      const decoded = await loadImage(data);
      if (sequence.current !== seq) return;
      setSource(data); setImage(decoded); setCrop(INITIAL_CROP); setFileName(`${file.name} · ${Math.ceil(file.size / 1024)}KB`);
    } catch { if (sequence.current === seq) setError("图片无法读取，请重新选择，当前头像保持不变。"); }
    finally { if (sequence.current === seq) setLoading(false); }
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || !image) return;
    const next = { ...drag.crop, x: drag.crop.x + event.clientX - drag.x, y: drag.crop.y + event.clientY - drag.y };
    const bounds = geometry(image, next);
    setCrop({ ...next, x: bounds.x, y: bounds.y });
  }
  async function apply() {
    if (busy) return;
    setSaving(true); setError("");
    try {
      let output = "";
      if (image) {
        const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 256;
        drawCrop(canvas, image, crop); output = canvas.toDataURL("image/png");
        // 噪点较多的图片输出 PNG 可能超过200KB，保持原始上传限额并用JPEG压缩裁剪副本。
        if (Math.ceil(output.split(",")[1].length * 3 / 4) > MAX_BYTES) output = canvas.toDataURL("image/jpeg", .9);
      }
      await api.saveAvatar(output, draftStyle);
      window.dispatchEvent(new CustomEvent("app:avatar-changed"));
      window.dispatchEvent(new CustomEvent("app:settings-changed"));
      onApply({ style: draftStyle, photo: output || null });
    } catch (e) { setError(`保存失败：${String(e)}。当前头像保持不变，请重试。`); setSaving(false); }
  }
  return createPortal(<div className="cr51-modal-mask" onMouseDown={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
    <div ref={dialogRef} className="cr51-avatar-modal" role="dialog" aria-modal="true" aria-labelledby="cr51-avatar-title" data-avatar-style={draftStyle}>
      <div className="cr51-avatar-modal-h"><b id="cr51-avatar-title">更换头像</b><span className="set-caption">内置样式或自定义图片</span><button className="btn icon ghost sm" type="button" aria-label="关闭" disabled={saving} onClick={onClose}><Icon name="x" size={14} /></button></div>
      <div className="cr51-avatar-modal-b" data-scroll>
        <div className="cr51-avatar-preview">
          {image ? <canvas ref={canvasRef} width={192} height={192} className={`cr51-live-preview${draftStyle === "c" ? " square" : ""}`} aria-label="裁剪结果实时预览" /> : <UserAvatar size={96} />}
          <span className="cr51-preview-label">{image ? `自定义图片 · 容器 ${draftStyle.toUpperCase()}` : AVATAR_STYLE_LABELS[draftStyle]}</span>
          <span className="set-caption">应用后同步顶栏、侧栏与设置。</span>
        </div>
        <div className="cr51-avatar-choose">
          <div className="cr51-block-h"><b>内置头像</b><span className="set-caption">5 种样式</span></div>
          <div className="cr51-presets" role="group" aria-label="内置头像">
            {AVATAR_STYLE_IDS.map(id => <button key={id} type="button" className="cr51-preset" data-avatar-style={id} aria-pressed={!source && draftStyle === id} onClick={() => preset(id)} disabled={saving} title={AVATAR_STYLE_LABELS[id]}><UserAvatar size={34} /><span>{id.toUpperCase()}</span></button>)}
            <button className="cr51-preset cr51-preset-custom" type="button" aria-pressed={Boolean(source)} disabled={saving} onClick={() => inputRef.current?.click()}>{source ? <img className="cr51-preset-thumb" src={source} alt="" /> : <span className="cr51-preset-plus"><Icon name="camera" size={14} /></span>}<span>自定义</span></button>
          </div>
          <div className="cr51-crop">
            <div className={`cr51-crop-stage${image ? "" : " is-builtin"}`} tabIndex={image ? 0 : -1} aria-label="拖动图片调整头像显示区域"
              onPointerDown={e => { if (image && !busy) { dragRef.current = { x: e.clientX, y: e.clientY, crop }; e.currentTarget.setPointerCapture(e.pointerId); } }}
              onPointerMove={move} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}
              onKeyDown={e => { if (!image || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return; e.preventDefault(); const next = { ...crop, x: crop.x + (e.key === "ArrowLeft" ? -4 : e.key === "ArrowRight" ? 4 : 0), y: crop.y + (e.key === "ArrowUp" ? -4 : e.key === "ArrowDown" ? 4 : 0) }; const b = geometry(image, next); setCrop({ ...next, x: b.x, y: b.y }); }}>
              <img src={source || LOGO} alt="" draggable={false} style={g ? { width: g.width, height: g.height, transform: `translate(-50%,-50%) translate(${g.x}px,${g.y}px)` } : { width: 150, height: 150, objectFit: "contain", transform: "translate(-50%,-50%)" }} />
              <div className={`cr51-crop-mask${draftStyle === "c" ? " square" : ""}`} />
            </div>
            <p className="cr51-crop-hint"><Icon name="hand" size={12} />{loading ? "正在读取头像…" : image ? "拖动图片调整位置；框内就是最终显示区域。" : "内置 Logo 无需裁剪，可选择自定义图片。"}</p>
            <label className="cr51-crop-row"><span className="set-caption">缩放</span><input type="range" min={100} max={300} value={crop.zoom} disabled={!image || busy} aria-label="缩放头像" onChange={e => { const next = { ...crop, zoom: Number(e.target.value) }; if (image) { const b = geometry(image, next); setCrop({ ...next, x: b.x, y: b.y }); } }} /><span className="cr51-crop-value">{crop.zoom}%</span></label>
            <div className="cr51-crop-row"><button className="btn sm" type="button" disabled={busy} onClick={() => inputRef.current?.click()}>{image ? "重新选择" : "选择图片"}</button><span className="set-caption">{fileName}</span></div>
          </div>
          {error && <p className="cr51-upload-error" role="alert">{error}</p>}
          <p className="set-caption">PNG / JPG / WebP，≤200KB；建议 ≥256×256。图片只保存在本机。</p>
          <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; void choose(file); }} />
        </div>
      </div>
      <div className="cr51-avatar-modal-f"><button className="btn sm" type="button" disabled={saving} onClick={() => preset("b")}>恢复默认 Logo</button><span className="grow" /><button className="btn" type="button" disabled={saving} onClick={onClose}>取消</button><button className="btn primary" type="button" disabled={busy} onClick={() => void apply()}>{saving ? "保存中…" : "应用"}</button></div>
    </div>
  </div>, document.body);
}
