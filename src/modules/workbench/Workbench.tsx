import { Icon } from "@/components/icons";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type * as api from "@/api";
import type { ChatController } from "@/modules/chat/ChatPanel";
import { SessionHistoryList } from "@/modules/chat/SessionList";
import { ResizeHandle, usePaneWidth } from "@/components/pane-resize";
import { onLocate } from "@/modules/locate";
import type { LocateDetail } from "@/modules/locate";
import { clearPanelGuard, markPanelClosedByUser, onPanelRequest } from "@/modules/chat/panelRequest";
import type { PanelRequest } from "@/modules/chat/panelRequest";
import { AuxPreview } from "./AuxPreview";
import "./workbench.css";

/**
 * CR-054 / STORY-071・072：会话中心工作台。
 *
 * 结构：左历史会话 / 中当前会话 / 右只读辅助栏（默认关闭）。
 * 关键约束：
 * - 会话按项目唯一：ProjectWindow持有唯一ChatPanel；本组件仅提供布局槽并读公共ChatController，
 *   不建第二份会话数据，也不挂第二个实例（否则会双订阅 chat:event）；
 * - 切页签不新建、不中断：组件随项目窗口 hidden 保留挂载；
 * - 右栏只读：不写文件、不扩授权，只呈现预览与“在对应页签打开”的回退。
 */

export type AuxTargetKind = "file" | "requirement" | "knowledge" | "office-file";

export interface AuxTarget {
  kind: AuxTargetKind;
  key: string;
  title: string;
  path?: string;
  line?: number;
}

interface WorkbenchProps {
  project: api.Project;
  active: boolean;
  /** 右栏状态按项目记忆；父级持有，切换页签后仍保留。 */
  aux: WorkbenchAuxState;
  onAuxChange: (next: WorkbenchAuxState) => void;
  /** 在对应页签打开（显式回退）。 */
  onOpenInTab: (target: AuxTarget) => void;
  /** FEAT-021：ProjectWindow唯一会话的列表快照，不建立本地会话状态。 */
  controller?: ChatController | null;
  chatSlotRef?: (slot: HTMLDivElement | null) => void;
}

export interface WorkbenchAuxState {
  open: boolean;
  tabs: AuxTarget[];
  active: string | null;
  /** AI 请求来源条；用于告知用户“是 AI 请求打开的”。 */
  requestedByAi: boolean;
}

export const emptyAuxState = (): WorkbenchAuxState => ({ open: false, tabs: [], active: null, requestedByAi: false });

export function Workbench({ project, active, aux, onAuxChange, onOpenInTab, controller = null, chatSlotRef }: WorkbenchProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);

  const hist = usePaneWidth(`project:${project.id}`, "wb-hist", { default: 288, min: 220, max: 420, side: "left", containerRef: shellRef, minCenter: 360, disabled: !active });
  const side = usePaneWidth(`project:${project.id}`, "wb-aux", { default: 360, min: 280, max: 520, side: "right", containerRef: shellRef, minCenter: 360, disabled: !active || !aux.open });

  const pushAux = useCallback((targets: AuxTarget[], requestedByAi = false) => {
    const merged = [...aux.tabs];
    for (const target of targets) if (!merged.some(t => t.key === target.key)) merged.push(target);
    const activeKey = targets[targets.length - 1]?.key ?? aux.active ?? merged[merged.length - 1]?.key ?? null;
    onAuxChange({ open: true, tabs: merged, active: activeKey, requestedByAi });
    clearPanelGuard(project.id);
  }, [aux.active, aux.tabs, onAuxChange, project.id]);

  const closeAux = useCallback(() => {
    markPanelClosedByUser(project.id, null);
    onAuxChange({ ...aux, open: false, requestedByAi: false });
  }, [aux, onAuxChange, project.id]);

  /* CR-054：定位分流。工作台内点击链接一律进右栏，不跳页签；其他页签保持原行为。 */
  useEffect(() => {
    if (!active) return;
    return onLocate((detail: LocateDetail) => {
      const targets = locateToTargets(detail, project);
      if (targets.length) pushAux(targets, false);
    });
  }, [active, project, pushAux]);

  /* CR-054：AI 请求开栏。 */
  useEffect(() => {
    return onPanelRequest((projectId, req: PanelRequest) => {
      if (projectId !== project.id) return;
      const target = panelRequestToTarget(req, project);
      pushAux(target ? [target] : [], true);
    });
  }, [project, pushAux]);

  const auxVisible = aux.open && aux.tabs.length > 0;
  const activeTarget = useMemo(() => aux.tabs.find(t => t.key === aux.active) ?? aux.tabs[aux.tabs.length - 1] ?? null, [aux.active, aux.tabs]);

  return (
    <div className="wb-shell" ref={shellRef} data-project={project.id}>
      {/* 左：会话历史（复用 AI 侧栏同一列表组件与样式） */}
      <aside {...hist.paneProps} className={`wb-hist ${hist.paneProps.className}`} style={hist.style} aria-label="会话历史">
        {controller
          ? <SessionHistoryList
            items={controller.sessions}
            currentId={controller.currentId}
            runningIds={controller.runningIds}
            total={controller.total}
            hasMore={controller.hasMore}
            loading={controller.loading}
            error={controller.error}
            keyword={controller.keyword}
            onSwitch={controller.openSession}
            onNew={controller.newSession}
            onLoadMore={controller.loadMore}
            onSearch={controller.search}
            onShowAll={controller.showAll}
            onRetry={controller.retry}
            onDelete={controller.remove}
            onCopyId={controller.copyId}
            onFork={controller.fork}
            onPin={controller.pin}
            onRename={controller.rename}
            pinned={null}
          />
          : <div className="wb-hist-loading" role="status" aria-live="polite">加载会话…</div>}
        <ResizeHandle pane={hist} label="会话历史" />
      </aside>

      {/* 中：当前会话。全项目唯一的 ChatPanel 实例。 */}
      <section className="wb-conv" aria-label="当前会话">
        <div ref={chatSlotRef} className="project-chat-slot" data-project-chat-slot="workbench" />
      </section>

      {/* 右：只读辅助栏 */}
      {auxVisible && (
        <>
          <ResizeHandle pane={side} label="辅助栏" />
          <aside {...side.paneProps} className={`wb-aux ${side.paneProps.className}`} style={side.style} aria-label="辅助栏">
            <div className="wb-aux-head">
              <b>辅助栏</b><span className="tag">只读</span>
              <span className="spacer" />
              <button className="chat-iconbtn" title="关闭辅助栏" aria-label="关闭辅助栏" onClick={closeAux}><Icon name="x" size={14} /></button>
            </div>
            {aux.requestedByAi && (
              <div className="wb-aux-req" role="status">
                <Icon name="sparkles" size={12} />
                <span>AI 请求打开该面板</span>
                <button className="chat-iconbtn" title="收起" aria-label="收起 AI 请求提示" onClick={() => onAuxChange({ ...aux, requestedByAi: false })}><Icon name="x" size={12} /></button>
              </div>
            )}
            <div className="wb-aux-tabs" role="tablist">
              {aux.tabs.map(t => (
                <button key={t.key} role="tab" aria-selected={t.key === activeTarget?.key} className="wb-aux-tab" onClick={() => onAuxChange({ ...aux, active: t.key })}>
                  <span className="ellipsis">{t.title}</span>
                  <span
                    className="wb-aux-x"
                    role="button"
                    aria-label={`关闭 ${t.title}`}
                    onClick={e => {
                      e.stopPropagation();
                      const tabs = aux.tabs.filter(x => x.key !== t.key);
                      onAuxChange({ ...aux, tabs, active: tabs[tabs.length - 1]?.key ?? null, open: tabs.length > 0 });
                    }}
                  >✕</span>
                </button>
              ))}
            </div>
            <div className="wb-aux-body">
              {activeTarget ? <AuxPreview target={activeTarget} project={project} /> : <div className="wb-aux-empty">没有打开的目标</div>}
            </div>
            <div className="wb-aux-foot">
              <button className="btn sm" disabled={!activeTarget} onClick={() => activeTarget && onOpenInTab(activeTarget)}>
                <Icon name="external" size={12} /> {openInLabel(activeTarget, project)}
              </button>
              <span className="spacer" />
              <span className="tag">{project.kind === "work" ? "办公预览" : "代码预览"}</span>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}

function openInLabel(target: AuxTarget | null, project: api.Project): string {
  if (!target) return "在对应页签打开";
  if (target.kind === "requirement") return "在需求中打开";
  if (target.kind === "knowledge" || target.kind === "office-file") return "在文档中打开";
  return "在编码中打开";
}

/** 定位事件 → 右栏目标。只转换当前项目的目标，不读未授权内容。 */
function locateToTargets(detail: LocateDetail, project: api.Project): AuxTarget[] {
  if (detail.kind === "file") {
    if (detail.projectId && detail.projectId !== project.id) return [];
    if (detail.rootUri && project.rootUri && detail.rootUri !== project.rootUri) return [];
    if (!detail.projectId && !detail.rootUri) return [];
    return [{ kind: "file", key: `file:${detail.path}`, title: detail.path.split("/").pop() ?? detail.path, path: detail.path, line: detail.line }];
  }
  if (detail.kind === "requirement") {
    if (detail.projectId && detail.projectId !== project.id) return [];
    if (project.kind !== "code") return [];
    return [{ kind: "requirement", key: `req:${detail.entityId}`, title: detail.entityId }];
  }
  if (detail.kind === "knowledge") {
    if (detail.projectId && detail.projectId !== project.id) return [];
    return [{ kind: "knowledge", key: `kb:${detail.libraryId}:${detail.noteId}`, title: detail.noteId }];
  }
  if (detail.projectId !== project.id) return [];
  return [{ kind: "office-file", key: `office:${detail.fileId}`, title: detail.fileId }];
}

/** AI 请求 → 右栏目标。ui-preview / browser 无具体目标，打开空态面板由用户判断。 */
function panelRequestToTarget(req: PanelRequest, project: api.Project): AuxTarget | null {
  if (!req.key) return null;
  const kindMap: Record<string, AuxTargetKind> = {
    file: "file", requirement: "requirement", knowledge: "knowledge", "office-file": "office-file",
  };
  const kind = kindMap[req.kind];
  if (!kind) return null;
  const isOffice = req.kind === "office-file";
  if (isOffice && project.kind !== "work") return null;
  if (req.kind === "requirement" && project.kind !== "code") return null;
  return { kind, key: `${kind === "office-file" ? "office" : kind === "requirement" ? "req" : kind}:${req.key}`, title: req.key };
}

