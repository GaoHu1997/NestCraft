// Image lightbox/menu adapted from DeepSeek UI 0.2.2-rc.5 (MIT; Copyright (c) 2026 DeepSeek; see chat-dock.LICENSE).
// CR-076: explicitly authorized code-first implementation; requirement/design backfill is coordinated by lead.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/ui";
import type { AttachmentMeta } from "@/api";
import "./chat-turn.css";

export const imageTypes = ["image/png", "image/jpeg", "image/webp"];
export const maxImages = 8;
export const maxImageBytes = 10 * 1024 * 1024;

export function imageSource(a: AttachmentMeta): string | null {
  return a.imageBase64 && a.mime && imageTypes.includes(a.mime) ? `data:${a.mime};base64,${a.imageBase64}` : null;
}

export async function readImage(file: File): Promise<AttachmentMeta> {
  if (!imageTypes.includes(file.type)) throw new Error("请选择 PNG、JPEG 或 WebP 图片");
  if (!file.size || file.size > maxImageBytes) throw new Error("每张图片须大于 0 字节且不超过 10 MiB");
  const src = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("图片读取失败"));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
  const img = new Image();
  img.src = src;
  await img.decode().catch(() => { throw new Error("图片解码失败"); });
  return { name: file.name, mime: file.type, byteSize: file.size, imageBase64: src.slice(src.indexOf(",") + 1) };
}

export function AttachmentImages({ attachments, onRemove }: { attachments: AttachmentMeta[]; onRemove?: (index: number) => void }) {
  const [preview, setPreview] = useState<{ src: string; name: string; back: HTMLElement } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const composing = useRef(false);
  const keyboardComposing = useRef(false);
  const hasAttachments = attachments.length > 0;
  const toast = useToast();
  useEffect(() => {
    if (!hasAttachments) {
      setMenu(null);
      setPreview(null);
      return;
    }
    const previewDialog = dialog.current;
    if (!preview || !previewDialog) return;
    if (!previewDialog.open) previewDialog.showModal();
    const button = closeButton.current;
    if (button?.isConnected && previewDialog.contains(button)) button.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      const ownsFocus = active === document.body || active === preview.back || (active !== null && previewDialog.contains(active));
      if (previewDialog.open) previewDialog.close();
      composing.current = false;
      keyboardComposing.current = false;
      // Caller keys isolate sessions. Never refocus a removed, hidden or inert origin, or steal another view's focus.
      const origin = preview.back;
      if (ownsFocus && origin.isConnected && !origin.closest("[hidden], [inert]") && origin.getClientRects().length && getComputedStyle(origin).visibility === "visible") {
        origin.focus({ preventScroll: true });
      }
    };
  }, [preview, hasAttachments]);
  useLayoutEffect(() => {
    const list = menuElement.current;
    if (!menu || !list) return;
    const position = () => {
      const bounds = list.getBoundingClientRect();
      list.style.left = `${Math.max(12, Math.min(menu.x, window.innerWidth - bounds.width - 12))}px`;
      list.style.top = `${Math.max(12, Math.min(menu.y, window.innerHeight - bounds.height - 12))}px`;
    };
    position();
    list.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus({ preventScroll: true });
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [menu]);
  const focusClose = () => {
    const button = closeButton.current;
    if (dialog.current?.open && button?.isConnected) button.focus({ preventScroll: true });
  };
  const closeMenu = () => {
    setMenu(null);
    focusClose();
  };
  const close = () => {
    setMenu(null);
    setPreview(null);
  };
  const onPreviewKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    // Keep shortcuts local, but let composition and native button/IME editing retain their default behavior.
    event.stopPropagation();
    keyboardComposing.current = composing.current || event.nativeEvent.isComposing || event.keyCode === 229;
    if (keyboardComposing.current || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key === "Escape" && event.repeat) { event.preventDefault(); return; }
    if ((event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) && event.target instanceof HTMLImageElement) {
      event.preventDefault();
      const bounds = event.target.getBoundingClientRect();
      setMenu({ x: bounds.left, y: bounds.bottom });
      return;
    }
    if (menu) {
      const items = Array.from(menuElement.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? []);
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape") {
        event.preventDefault();
        if (!event.repeat) closeMenu();
      } else if (event.key === "Tab") {
        event.preventDefault();
        if (event.shiftKey) closeMenu();
        else if (index >= 0) items[index].click();
        else items[0]?.focus();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : index < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1) : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus(); // Native focus reveals the active item in a short menu viewport.
      }
    } else if (event.key === "Tab") {
      event.preventDefault();
      focusClose();
    }
  };
  const save = (src: string, name: string) => {
    const link = document.createElement("a");
    link.href = src;
    link.download = name;
    link.click();
  };
  const copy = async (src: string) => {
    try {
      const bitmap = await createImageBitmap(await (await fetch(src)).blob());
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
      bitmap.close();
      const png = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve));
      if (!png || !navigator.clipboard?.write) throw new Error("clipboard unavailable");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      toast("已复制图片", "info");
    } catch {
      toast("复制图片失败", "warn");
    }
  };
  if (!attachments.length) return null;
  const singleImage = !onRemove && attachments.filter(imageSource).length === 1;
  return <>
    <div className={onRemove ? "chat-composer-images" : "chat-message-images"}>
      {attachments.map((attachment, index) => {
        const src = imageSource(attachment);
        if (!src) return <div className="chat-attachment" key={`${attachment.name}-${index}`}>{attachment.name} · 附件元信息{onRemove && <button type="button" className="chat-chip-x" onClick={() => onRemove(index)} aria-label={`移除附件 ${attachment.name}`}><Icon name="x" size={12} /></button>}</div>;
        return <div className={onRemove ? "chat-draft-image" : "chat-message-image"} key={`${attachment.name}-${index}`}>
          <ImageThumbnail src={src} name={attachment.name} single={singleImage} onOpen={back => setPreview({ src, name: attachment.name, back })} />
          {onRemove && <button type="button" className="chat-image-remove" onClick={() => onRemove(index)} title="移除图片" aria-label={`移除图片 ${attachment.name}`}><Icon name="x" size={12} /></button>}
        </div>;
      })}
    </div>
    {preview && createPortal(<dialog ref={dialog} className="chat-img-zoom chat-attachment-dialog" aria-label="图片放大"
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; keyboardComposing.current = false; }}
      onKeyDown={onPreviewKeyDown} onKeyUp={event => { keyboardComposing.current = false; event.stopPropagation(); }}
      onCancel={event => { event.preventDefault(); if (composing.current || keyboardComposing.current) return; if (menu) closeMenu(); else close(); }}>
      <div className="chat-attachment-preview-stage">
        <div className="chat-attachment-preview-mask" aria-hidden="true" onClick={close} />
        <img className="chat-attachment-preview-image" src={preview.src} alt={preview.name} tabIndex={0}
          aria-haspopup="menu" aria-expanded={!!menu} aria-controls={menu ? menuId : undefined}
          onClick={event => { if (menu) closeMenu(); event.currentTarget.focus({ preventScroll: true }); }}
          onContextMenu={event => { event.preventDefault(); event.stopPropagation(); if (!composing.current) setMenu({ x: event.clientX, y: event.clientY }); }} />
        <button ref={closeButton} type="button" className="chat-attachment-preview-close" autoFocus aria-label="关闭"
          onClick={event => { if (!event.detail && (composing.current || keyboardComposing.current)) return; close(); }}>
          <svg width={16} height={16} viewBox="0 0 16 16" fill="none" strokeWidth={1} aria-hidden="true" focusable="false"><path d="M2.5 2.5L13.5 13.5" stroke="currentColor" /><path d="M13.5 2.5L2.5 13.5" stroke="currentColor" /></svg>
        </button>
        {menu && <div ref={menuElement} id={menuId} className="chat-attachment-preview-menu" role="menu" aria-label="图片操作"
          style={{ left: menu.x, top: menu.y }} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); closeMenu(); }}>
          <div className="chat-attachment-preview-menu-viewport" role="presentation">
            <button type="button" role="menuitem" tabIndex={-1} onClick={event => { if (!event.detail && (composing.current || keyboardComposing.current)) return; closeMenu(); void copy(preview.src); }}><Icon name="copy" size={14} /><span>复制图片</span></button>
            <button type="button" role="menuitem" tabIndex={-1} onClick={event => { if (!event.detail && (composing.current || keyboardComposing.current)) return; closeMenu(); save(preview.src, preview.name); }}><Icon name="download" size={14} /><span>保存图片</span></button>
          </div>
        </div>}
      </div>
    </dialog>, document.body)}
  </>;
}

// Adapted from @deepseek-ai/dsh-client-ui-attachment (MIT; see chat-dock.LICENSE).
function singleImageFit(width: number, height: number) {
  const natural = width / height;
  const ratio = Math.min(4, Math.max(0.25, natural));
  const boxWidth = ratio >= 1 ? 240 : 240 * ratio;
  const boxHeight = ratio >= 1 ? 240 / ratio : 240;
  const scale = Math.min(1, width / boxWidth, height / boxHeight);
  return {
    width: Math.max(1, Math.round(boxWidth * scale)),
    height: Math.max(1, Math.round(boxHeight * scale)),
    objectPosition: natural < 0.25 ? "center top" : natural > 4 ? "left center" : "center",
  };
}

function ImageThumbnail({ src, name, single, onOpen }: { src: string; name: string; single: boolean; onOpen: (el: HTMLElement) => void }) {
  const [failedSrc, setFailedSrc] = useState("");
  const [size, setSize] = useState<{ src: string; width: number; height: number }>();
  const fit = single && size?.src === src ? singleImageFit(size.width, size.height) : undefined;
  const frameWidth = fit ? Math.max(44, fit.width) : undefined;
  const frameHeight = fit ? Math.max(44, fit.height) : undefined;
  return failedSrc === src ? <span className="chat-attachment">{name} · 图片无法加载</span> :
    <button type="button" className="chat-image-thumbnail" data-single={single || undefined}
      style={fit && { width: frameWidth, aspectRatio: `${frameWidth} / ${frameHeight}` }}
      title={name} aria-label={`预览图片 ${name}`} onClick={e => onOpen(e.currentTarget)}>
      <img src={src} alt={name} style={fit && { objectPosition: fit.objectPosition }} onError={() => setFailedSrc(src)}
        onLoad={({ currentTarget: { naturalWidth, naturalHeight } }) => {
          if (naturalWidth && naturalHeight) setSize({ src, width: naturalWidth, height: naturalHeight });
        }} />
    </button>;
}
