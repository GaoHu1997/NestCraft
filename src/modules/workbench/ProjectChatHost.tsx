import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import "./project-chat-host.css";

export type ProjectChatLayout = "workbench" | "sidebar" | "parked";

/** FEAT-021 / WP-074-F021：portal的目标容器永远不变；只移动容器，绝不重挂会话。
 * 会话/附件/引用/队列/订阅仍由唯一ChatPanel持有。隐藏窗口不恢复焦点。 */
export function ProjectChatHost({ layout, workbenchSlot, sidebarSlot, visible, children }: {
  layout: ProjectChatLayout;
  workbenchSlot: HTMLDivElement | null;
  sidebarSlot: HTMLDivElement | null;
  visible: boolean;
  children: ReactNode;
}) {
  const parking = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef(new Map<HTMLElement, { top: number; left: number }>());
  const [surface] = useState(() => {
    const node = document.createElement("div");
    node.className = "project-chat-surface";
    node.dataset.projectChatHost = "persistent";
    return node;
  });

  useLayoutEffect(() => {
    const target = (layout === "workbench" ? workbenchSlot : layout === "sidebar" ? sidebarSlot : null) ?? parking.current;
    if (!target || surface.parentElement === target) return;
    const focused = document.activeElement instanceof HTMLElement && surface.contains(document.activeElement)
      ? document.activeElement : null;
    // hidden容器的scrollTop/尺寸可能回报0，不能以它覆盖可见期快照。
    if (surface.getClientRects().length) {
      scrollPositions.current.clear();
      for (const node of surface.querySelectorAll<HTMLElement>("*")) {
        if (node.scrollTop || node.scrollLeft || node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth)
          scrollPositions.current.set(node, { top: node.scrollTop, left: node.scrollLeft });
      }
    }
    target.appendChild(surface);
    for (const [node, position] of scrollPositions.current) { node.scrollTop = position.top; node.scrollLeft = position.left; }
    if (visible && layout !== "parked" && focused && focused.getClientRects().length) focused.focus({ preventScroll: true });
  }, [surface, layout, workbenchSlot, sidebarSlot, visible]);

  useLayoutEffect(() => () => { surface.remove(); }, [surface]);

  return <>
    <div ref={parking} className="project-chat-parking" hidden aria-hidden="true" />
    {createPortal(children, surface)}
  </>;
}
