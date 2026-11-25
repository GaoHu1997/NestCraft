import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { anchoredMenu } from "./modelManagement";

export function ModelProtocolMenu({ anchor, value, available, onPick, onClose }: {
  anchor: HTMLElement; value: string; available: string[]; onPick: (value: string) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<ReturnType<typeof anchoredMenu>>();
  useLayoutEffect(() => {
    const menu = ref.current!;
    setPosition(anchoredMenu(anchor.getBoundingClientRect(), menu.scrollHeight, { width: innerWidth, height: innerHeight }));
    menu.querySelector<HTMLButtonElement>('button[aria-checked="true"]:not(:disabled)')?.focus({ preventScroll: true });
    const outside = (e: PointerEvent) => { if (!menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose(); };
    const scroll = (e: Event) => { if (e.target !== menu && !menu.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); onClose(); anchor.focus({ preventScroll: true }); }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault(); const options = Array.from(menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const current = options.indexOf(document.activeElement as HTMLButtonElement);
        options[e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : (current + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
      }
    };
    document.addEventListener("pointerdown", outside, true); document.addEventListener("scroll", scroll, true);
    document.addEventListener("keydown", key, true); window.addEventListener("resize", onClose);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("scroll", scroll, true);
      document.removeEventListener("keydown", key, true); window.removeEventListener("resize", onClose); };
  }, [anchor, onClose]);
  return createPortal(<div ref={ref} className="cr085-protocol-pop" role="menu" aria-label="密钥协议" style={{ ...position, visibility: position ? "visible" : "hidden" }}>
    {["", "Chat", "Responses", "Anthropic"].map(option => <button key={option} role="menuitemradio" aria-checked={value === option}
      disabled={!!option && !available.includes(option === "Anthropic" ? "anthropic" : "openai")}
      onClick={() => { onPick(option); onClose(); anchor.focus({ preventScroll: true }); }}>{option || "默认协议"}</button>)}
  </div>, anchor.closest("dialog") || document.body);
}
