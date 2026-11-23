import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

/* ---------- Toast ---------- */

interface ToastItem {
  id: number;
  text: string;
  kind: "info" | "warn" | "err";
}

const ToastCtx = createContext<(text: string, kind?: ToastItem["kind"]) => void>(() => {});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const push = useCallback((text: string, kind: ToastItem["kind"] = "info") => {
    const id = nextId.current++;
    setItems((prev) => [...prev, { id, text, kind }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), kind === "err" ? 6000 : 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind === "err" ? "err" : t.kind === "warn" ? "warn" : ""}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export type ToastKind = "info" | "warn" | "err";
export const useToast = () => useContext(ToastCtx) as (text: string, kind?: ToastKind) => void;

/* ---------- Modal ---------- */

export function Modal({ title, onClose, children, footer, width, heightRatio }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
  heightRatio?: number;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    /* CR-068 J01：记住打开前的焦点，关闭（含取消/Esc）后归还给触发按钮；
       React 直接卸载 dialog 会丢失原生焦点恢复，这里显式兜底。 */
    const previous = document.activeElement;
    restoreRef.current = previous instanceof HTMLElement && previous !== document.body ? previous : null;
    if (element && !element.open) element.showModal();
    return () => {
      if (element?.open) element.close();
      const target = restoreRef.current;
      if (target && target.isConnected) target.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      /* CR-068：未指定 heightRatio 的短业务弹窗按内容高度（nc-dialog-auto），
         超高时正文在弹窗内滚动、footer 紧随正文；固定尺寸头像弹窗不经此组件，不受影响。 */
      className={`modal nc-dialog${heightRatio ? "" : " nc-dialog-auto"}`}
      aria-label={title}
      aria-modal="true"
      style={{ width: width ?? 620, maxWidth: "calc(100vw - 24px)", maxHeight: "calc(100dvh - 48px)", height: heightRatio ? `${Math.round(heightRatio * 100)}vh` : undefined }}
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}
    >
      <div className="modal-head"><h2>{title}</h2><button className="modal-close" onClick={onClose} aria-label="关闭">×</button></div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </dialog>
  );
}

/* ---------- 开关 ---------- */

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      className="switch"
      role="switch"
      aria-checked={checked}
      aria-label={label ?? (checked ? "已启用" : "已停用")}
      onClick={() => onChange(!checked)}
    />
  );
}

/* ---------- 字段 ---------- */

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

/* ---------- 空状态 ---------- */

export function Empty({ title, desc, action }: { title: string; desc?: string; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <div className="big">{title}</div>
      {desc && <div className="small">{desc}</div>}
      {action}
    </div>
  );
}

/* ---------- 确认弹框 ---------- */

export function Confirm({
  title,
  message,
  onOk,
  onCancel,
  danger,
}: {
  title: string;
  message: string;
  onOk: () => void;
  onCancel: () => void;
  danger?: boolean;
}) {
  return (
    /* CR-068 J01：删除确认等短弹窗按内容高度，不再用固定 30vh 撑出下半空白。 */
    <Modal title={title} onClose={onCancel} width={420}>
      <p style={{ whiteSpace: "pre-wrap" }}>{message}</p>
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn" onClick={onCancel}>
          取消
        </button>
        <button className={`btn ${danger ? "danger" : "primary"}`} onClick={onOk}>
          确认
        </button>
      </div>
    </Modal>
  );
}

/* ---------- 树形展开容器 ---------- */

export function TreeRow({
  depth,
  selected,
  onClick,
  children,
  title,
}: {
  depth: number;
  selected?: boolean;
  onClick?: () => void;
  children?: React.ReactNode;
  title?: string;
}) {
  return (
    <div
      className="row clickable"
      title={title}
      onClick={onClick}
      style={{
        paddingLeft: 8 + depth * 16,
        paddingRight: 8,
        minHeight: 30,
        borderRadius: 6,
        background: selected ? "var(--node-sel-bg)" : undefined,
        outline: selected ? "1px solid var(--node-sel-line)" : undefined,
        fontSize: 13,
        userSelect: "none",
      }}
    >
      {children}
    </div>
  );
}

/** Markdown -> 安全 HTML（知识库/预览用；marked + DOMPurify，不执行脚本） */
export async function renderMarkdown(md: string, options: { restrictResources?: boolean } = {}): Promise<string> {
  const [{ marked }, DOMPurifyMod] = await Promise.all([import("marked"), import("dompurify")]);
  const raw = await marked.parse(md, { async: true });
  const purify =
    (DOMPurifyMod as unknown as { default: { sanitize: (s: string) => string } }).default ??
    (DOMPurifyMod as unknown as { sanitize: (s: string) => string });
  const doc = new DOMParser().parseFromString(purify.sanitize(raw), "text/html");
  const counts = new Map<string, number>();
  doc.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((heading, index) => {
    const stem = "h-" + (heading.textContent ?? "").trim().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}-]/gu, "").slice(0, 60);
    const count = counts.get(stem) ?? 0;
    counts.set(stem, count + 1);
    heading.id = stem === "h-" ? `h-section-${index}` : count ? `${stem}-${count}` : stem;
  });
  if (options.restrictResources) {
    doc.querySelectorAll("img,video,audio,iframe,object,embed,source,svg,form").forEach(element => element.remove());
    doc.querySelectorAll("[style], [src], [srcset], [background]").forEach(element => {
      ["style", "src", "srcset", "background"].forEach(attribute => element.removeAttribute(attribute));
    });
    doc.querySelectorAll<HTMLAnchorElement>("a[href]").forEach(link => {
      if (!(link.getAttribute("href") ?? "").startsWith("#")) {
        link.removeAttribute("href");
        link.title = "资料阅读不自动打开外部或本地资源";
      }
    });
  }
  return doc.body.innerHTML;
}

/** 从 Markdown 提取标题目录 */
export function extractToc(md: string): { level: number; text: string; id: string }[] {
  const out: { level: number; text: string; id: string }[] = [];
  let inCode = false;
  for (const line of md.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      const text = m[2].trim();
      const id = "h-" + text.replace(/\s+/g, "-").replace(/[^\p{L}\p{N}-]/gu, "").slice(0, 60) || `h-${out.length}`;
      out.push({ level: m[1].length, text, id });
    }
  }
  return out;
}
