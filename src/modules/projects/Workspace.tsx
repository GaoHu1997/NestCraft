import { Icon } from "@/components/icons";
/** 项目工作区：需求贯通阅读 / 设计（UI/模型）/ 编码（文件/Git + 编辑器 + AI）；
 *  办公项目（CR-043）：文件树 + 文档查看器 + 统一 AI 侧栏。 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "@/api";
import type { RequirementNode } from "@/api";
import { useApp } from "@/store/app";
import { Empty, Field, Modal, extractToc, renderMarkdown, useToast } from "@/components/ui";
import { GitPanel } from "@/modules/git";
import { CodeArea } from "@/modules/editor";
import { onLocate } from "@/modules/locate";
import { OfficeFileTree } from "@/modules/office/OfficeFileTree";
import { OfficeViewer } from "@/modules/office/OfficeViewer";
import { locateFile as officeLocateFile } from "@/modules/office/office-model";
import { ensureOfficeProjectSample, OfficeArtifacts } from "@/modules/office";
import { ProjectHome } from "./ProjectHome";
import type { ChatController } from "@/modules/chat/ChatPanel";
import { Workbench, emptyAuxState } from "@/modules/workbench/Workbench";
import type { AuxTarget, WorkbenchAuxState } from "@/modules/workbench/Workbench";
import { RequirementsReading } from "./RequirementsReading";
import { blankNodeForm, frontMatter, patchFrontMatter, stripFrontMatter, acSection, writeAcSection, NodeFields, KIND_DIR, type NodeForm } from "./requirementForm";
import { flattenRequirements, mergeRequirementSources, normalizedSource } from "./requirementSources";
import { PaneToggle, ResizeHandle, usePaneWidth } from "@/components/pane-resize";
import { TabMoreDropdown, TabMoreIcon, useTabOverflow } from "@/components/tab-overflow";
import "./projects.css";
import "@/modules/office/office.css";

type Tab = "workbench" | "requirements" | "design" | "tasks" | "code";

export function ProjectWorkspace(props: { projectId: string; tab: Tab; visible?: boolean; chatController?: ChatController | null; chatSlotRef?: (slot: HTMLDivElement | null) => void }) {
  const { go, route, aiVisible, setAiVisible } = useApp();
  const toast = useToast();
  const [project, setProject] = useState<api.Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>(props.tab);
  const [reqFocus, setReqFocus] = useState<string | null>(null);
  /* UI-CR066 r2：从需求导图打开模型文档时，定位「设计 → 数据库」的对应文件。 */
  const [designFocus, setDesignFocus] = useState<{ section: DesignSection; path: string } | null>(null);
  /* CR-054：辅助栏状态按项目记忆（切页签后仍保留）。 */
  const [auxByProject, setAuxByProject] = useState<Record<string, WorkbenchAuxState>>({});
  const auxState = auxByProject[props.projectId] ?? emptyAuxState();
  const setAuxState = useCallback((next: WorkbenchAuxState) => {
    setAuxByProject(prev => ({ ...prev, [props.projectId]: next }));
  }, [props.projectId]);
  const openInTab = useCallback((target: AuxTarget) => {
    if (target.kind === "requirement") { setReqFocus(target.key.replace(/^req:/, "")); changeTab("requirements"); return; }
    if (target.kind === "office-file") { changeTab("code"); return; }
    changeTab("code");
  }, []);
  const active = props.visible !== false && route.page === "project" && route.projectId === props.projectId;
  useEffect(() => setTab(props.tab), [props.tab]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listProjects();
      setProject(list.find(p => p.id === props.projectId) ?? null);
    } catch (e) { toast(String(e), "err"); } finally { setLoading(false); }
  }, [props.projectId, toast]);
  useEffect(() => { void reload(); }, [reload]);
  const changeTab = (next: Tab) => { setTab(next); go({ page: "project", projectId: props.projectId, tab: next }); };
  // CR-052 / UI-TAB-001：项目页签溢出统一走共享「更多」下拉；右侧 AI 入口固定不受收缩影响。
  /* CR-054：代码与办公两类项目都在最前加入「工作台」。
     CR-082：页签形态由纯图标改为「电脑（显示器）图标 + 文字『工作台』」。 */
  const pwTabList: [Tab, string][] = project?.kind === "code"
    ? [["workbench", "工作台"], ["requirements", "需求"], ["design", "设计"], ["tasks", "任务"], ["code", "编码"]]
    : [["workbench", "工作台"], ["code", "文档"], ["design", "成果"]];
  const pwTabItems = pwTabList.map(([key, label]) => ({ key, label, active: tab === key }));
  const pwTabSig = pwTabItems.map(item => `${item.key}:${item.label}:${item.active ? 1 : 0}`).join("|");
  const pwTabsOverflow = useTabOverflow({ tabSelector: ".pw-tab", items: pwTabItems, deps: [pwTabSig] });

  useEffect(() => {
    if (!project) return;
    return onLocate(d => {
      // FEAT-021：可见工作台由Workbench进辅助栏，不触发本区页签切换。
      if (active && tab === "workbench") return;
      if (d.kind === "file") {
        if ((d.projectId && d.projectId !== project.id) || (d.rootUri && normalizePath(d.rootUri) !== normalizePath(project.rootUri))) return;
        if (!d.projectId && !d.rootUri) return;
        setTab("code");
      } else if (d.kind === "requirement") {
        if (!active || project.kind !== "code" || (d.projectId && d.projectId !== project.id)) return;
        setReqFocus(d.entityId);
        setTab("requirements");
      } else if (d.kind === "office-file" && d.projectId === project.id && project.kind === "work") {
        officeLocateFile(project.id, d.fileId);
        setTab("code");
      }
    });
  }, [project, active, tab]);

  if (loading) return <div className="pagebody"><Empty title="加载项目…" /></div>;
  if (!project) return <div className="pagebody"><Empty title="项目不存在或已删除" /></div>;
  return <div className="pw-shell">
    <div ref={pwTabsOverflow.barRef} className="pw-top" role="tablist" aria-label="项目页签">
      <div ref={pwTabsOverflow.hostRef} className="tab-overflow-host">
        {pwTabList.map(([key, label]) => (
          key === "workbench"
            ? <button key={key} className="pw-tab wb-tab-icon" role="tab" aria-selected={tab === key} aria-label={label} title={label} onClick={() => changeTab(key as Tab)}><Icon name="monitor" size={16} /><span>{label}</span></button>
            : <button key={key} className="pw-tab" role="tab" aria-selected={tab === key} onClick={() => changeTab(key as Tab)}>{label}</button>
        ))}
        <button {...pwTabsOverflow.moreProps}><TabMoreIcon /></button>
      </div>
      <span className="spacer" />
      {/* CR-096 R5：工作台页签已内含会话区，右上角不再显示 AI 侧栏开关（UI-CR096-v1）。
          其它页签保持原行为。侧栏偏好不被改写，切回其它页签即恢复。 */}
      {tab !== "workbench" && <button className={`pw-ai-toggle ${aiVisible ? "on" : ""}`} aria-label="AI 侧栏" aria-pressed={aiVisible} title={aiVisible ? "收起 AI 侧栏" : "展开 AI 侧栏"} onClick={() => setAiVisible(!aiVisible)}>
        <Icon name="aiBot" size={18} />
      </button>}
      {pwTabsOverflow.dropdownOpen && <TabMoreDropdown anchorRef={pwTabsOverflow.moreRef} items={pwTabItems} onPick={key => changeTab(key as Tab)} onClose={pwTabsOverflow.closeDropdown} />}
    </div>
    <div className="pw-body">
      {/* CR-054：工作台。两类项目共用；hidden 保留挂载，切页签不卸载会话（不新建、不中断）。 */}
      <section className="pw-pane" role="tabpanel" hidden={tab !== "workbench"}>
        <Workbench
          project={project}
          active={active && tab === "workbench"}
          aux={auxState}
          onAuxChange={setAuxState}
          onOpenInTab={openInTab}
          controller={props.chatController ?? null}
          chatSlotRef={props.chatSlotRef}
        />
      </section>
      {project.kind === "code" ? <>
        <section className="pw-pane" role="tabpanel" hidden={tab !== "requirements"}><RequirementsPane project={project} focusEntityId={reqFocus} onFocusDone={() => setReqFocus(null)} onOpenModel={model => { setDesignFocus({ section: "DB", path: model.absPath }); changeTab("design"); }} /></section>
        <section className="pw-pane" role="tabpanel" hidden={tab !== "design"}><DesignPane project={project} focus={designFocus} /></section>
        <section className="pw-pane" role="tabpanel" hidden={tab !== "tasks"}><TasksPane project={project} onRequirements={() => changeTab("requirements")} /></section>
        <section className="pw-pane" role="tabpanel" hidden={tab !== "code"}><CodePane project={project} visible={active && tab === "code"} /></section>
      </> : <OfficeWorkspace project={project} tab={tab} active={active} onOpenFile={() => changeTab("code")} />}
    </div>
  </div>;
}

function OfficeWorkspace({ project, tab, active, onOpenFile }: { project: api.Project; tab: Tab; active: boolean; onOpenFile: () => void }) {
  useEffect(() => { ensureOfficeProjectSample(project); }, [project.id, project.name]);
  const rootRef = useRef<HTMLDivElement>(null);
  const filePane = usePaneWidth(`project:${project.id}`, "office-files", { default: 260, min: 180, max: 480, side: "left", containerRef: rootRef, reserve: 0, minCenter: 320, disabled: !active || tab !== "code" });
  return <>
    <section className="pw-pane" hidden={tab !== "code"}>
      <div ref={rootRef} className="office-shell">
        <div {...filePane.paneProps} className={`office-tree-col ${filePane.paneProps.className}`}><OfficeFileTree projectId={project.id} projectName={project.name} /><ResizeHandle pane={filePane} label="办公文件" /></div>
        <div className="office-main-col"><OfficeViewer projectId={project.id} visible={active && tab === "code"} /></div>
        <div className="pane-controls"><PaneToggle pane={filePane} label="办公文件" /></div>
      </div>
    </section>
    <section className="pw-pane" hidden={tab !== "design"}><OfficeArtifacts projectId={project.id} onOpenFile={fileId => { officeLocateFile(project.id, fileId); onOpenFile(); }} /></section>
  </>;
}

function normalizePath(path: string) { return path.replace(/\\/g, "/").replace(/^\/\/?\?\//, "").replace(/\/$/, "").toLowerCase(); }

/* ============ 需求 ============ */

function RequirementsPane(props: { project: api.Project; focusEntityId?: string | null; onFocusDone?: () => void; onOpenModel?: (model: import("./requirementModels").DesignModel) => void }) {
  const { project } = props;
  const [tree, setTree] = useState<RequirementNode[]>([]);
  const [manifest, setManifest] = useState<api.RequirementSources | null>(null);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const request = useRef(0);
  const [editTarget, setEditTarget] = useState<RequirementNode | null>(null);
  const [createParent, setCreateParent] = useState<RequirementNode | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [delTarget, setDelTarget] = useState<RequirementNode | null>(null);
  const [dispatchTarget, setDispatchTarget] = useState<RequirementNode | null>(null);
  /* UI-CR066 r2：模型文档跳转到「设计 → 数据库」页签，定位到对应文件。 */
  const [designTarget, setDesignTarget] = useState<{ section: "PRD" | "UI" | "LLD" | "DB"; path: string } | null>(null);
  const addChild = (parent: RequirementNode | null) => { setCreateParent(parent); setCreateOpen(true); };
  const reload = useCallback(async () => {
    const seq = ++request.current;
    setLoading(true);
    const results = await Promise.allSettled([api.readRequirements(project.id), api.readRequirementSources(project.id)]);
    if (request.current !== seq) return;
    const [indexed, sources] = results, failures: string[] = [];
    if (indexed.status === "fulfilled") setTree(indexed.value);
    else { setTree([]); failures.push(`需求关系索引读取失败：${String(indexed.reason)}`); }
    if (sources.status === "fulfilled" && normalizedSource("", sources.value.rootUri) === normalizedSource("", project.rootUri)) setManifest(sources.value);
    else { setManifest(null); failures.push(sources.status === "rejected" ? `完整源清单读取失败：${String(sources.reason)}；不能证明全文完整。` : "源清单根目录与当前项目不一致，未读取该清单正文。"); }
    setErrors(failures); setRevision(value => value + 1); setLoading(false);
  }, [project.id, project.rootUri]);
  useEffect(() => { void reload(); return () => { request.current++; }; }, [reload]);
  const sources = useMemo(() => mergeRequirementSources(project.id, project.rootUri, tree, manifest), [project.id, project.rootUri, tree, manifest]);
  /* UI-CR073：导图右侧面板的就地编辑与新建（不再弹窗），与弹窗共用同一套表单与写回规则。 */
  const [panelEdit, setPanelEdit] = useState<RequirementNode | null>(null);
  const [panelCreate, setPanelCreate] = useState<{ parent: RequirementNode | null; kind: RequirementNode["kind"] } | null>(null);
  const closePanel = useCallback(() => { setPanelEdit(null); setPanelCreate(null); }, []);
  return <>
    <RequirementsReading key={JSON.stringify([project.id, project.rootUri])} project={project} sources={sources} loading={loading} errors={errors} warnings={manifest?.warnings ?? []} complete={manifest !== null} revision={revision}
      focusEntityId={props.focusEntityId} onFocusDone={props.onFocusDone} onReload={() => void reload()} onNew={() => addChild(null)} onAddChild={addChild} onEdit={setEditTarget} onDelete={setDelTarget} onDispatch={setDispatchTarget} onOpenModel={props.onOpenModel}
      panelEdit={panelEdit}
      panelEditForm={panelEdit ? <NodeEditorPanel project={project} node={panelEdit} onClose={closePanel} onSaved={() => { closePanel(); void reload(); }} /> : null}
      panelCreate={panelCreate}
      panelCreateForm={panelCreate ? <NodeEditorPanel project={project} parent={panelCreate.parent} kind={panelCreate.kind} tree={tree} onClose={closePanel} onSaved={() => { closePanel(); void reload(); }} /> : null}
      onPanelEdit={node => { setPanelCreate(null); setPanelEdit(node); }}
      onPanelCreate={(parent, kind) => { setPanelEdit(null); setPanelCreate({ parent, kind }); }}
    />
    {editTarget && <DocEditModal project={project} node={editTarget} onClose={() => setEditTarget(null)} onSaved={() => { setEditTarget(null); void reload(); }} />}
    {createOpen && <CreateNodeModal project={project} parent={createParent} tree={tree} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); void reload(); }} />}
    {delTarget && <DeleteNodeModal project={project} node={delTarget} onClose={() => setDelTarget(null)} onDeleted={() => { setDelTarget(null); void reload(); }} />}
    {dispatchTarget && <DispatchModal project={project} tree={tree} node={dispatchTarget} onClose={() => setDispatchTarget(null)} />}
  </>;
}

/** CR-047：Story/Bug 沿父链找唯一Feature；父链缺失或父不是Feature时不猜测。 */
function findAncestorFeature(tree: RequirementNode[], entityId: string): RequirementNode | null {
  const flat = flattenRequirements(tree);
  const self = flat.find(n => n.entityId === entityId);
  if (!self) return null;
  const seen = new Set([self.entityId]);
  let parentId = self.parentId;
  while (parentId) {
    if (seen.has(parentId)) return null;
    seen.add(parentId);
    const parent = flat.find(n => n.entityId === parentId);
    if (!parent) return null;
    if (parent.kind === "feature") return parent;
    if (parent.kind !== "epic") return null;
    parentId = parent.parentId;
  }
  return null;
}

function statusTag(status: string | null) {
  if (!status) return null;
  const cls = status === "已完成" ? "good" : status === "阻塞" || status === "取消" ? "bad" : status === "待验收" ? "warn" : "blue";
  return <span className={`tag ${cls}`}>{status}</span>;
}

function TreeLine(props: {
  node: RequirementNode; depth: number; showChildren: boolean;
  onOpen: (n: RequirementNode) => void; onEdit: (n: RequirementNode) => void;
  onDelete: (n: RequirementNode) => void; onAddChild: (n: RequirementNode | null) => void;
  onDispatch: (n: RequirementNode) => void;
}) {
  const [open, setOpen] = useState(props.depth < 1);
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { node } = props;
  const hasChildren = node.children.length > 0 && props.showChildren;
  useEffect(() => {
    if (!menu) return;
    const outside = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node) && !triggerRef.current?.contains(e.target as Node)) setMenu(null); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setMenu(null); triggerRef.current?.focus(); } };
    window.addEventListener("mousedown", outside); window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", outside); window.removeEventListener("keydown", key); };
  }, [menu]);
  const menuAction = (fn: () => void) => { setMenu(null); fn(); };
  return <div className="req-branch">
    <div className={`req-line row ${node.kind}`} style={{ paddingLeft: 8 + props.depth * 20 }} onDoubleClick={() => props.onOpen(node)}>
      {hasChildren ? <button className="req-caret" aria-label={open ? "折叠" : "展开"} aria-expanded={open} onClick={() => setOpen(!open)}><Icon name={open ? "chevronDown" : "chevronRight"} size={14} /></button> : <span className="req-caret req-caret-empty" />}
      <span className={`req-kind-dot ${node.kind}`} /><span className="req-id">{node.entityId}</span>
      <button className="req-title ellipsis" onClick={() => props.onOpen(node)} title={node.title}>{node.title}</button>
      {statusTag(node.status)}
      <button ref={triggerRef} className="req-more" aria-label={`更多操作 ${node.entityId}`} aria-haspopup="menu" aria-expanded={!!menu} onClick={e => {
        const r = e.currentTarget.getBoundingClientRect();
        setMenu(menu ? null : { left: Math.max(8, Math.min(r.right - 184, window.innerWidth - 192)), top: Math.max(8, Math.min(r.bottom + 4, window.innerHeight - 190)) });
      }}><Icon name="more" size={14} /></button>
    </div>
    {menu && <div ref={menuRef} className="req-menu" role="menu" style={menu}>
      {(node.kind === "epic" || node.kind === "feature") && <button role="menuitem" onClick={() => menuAction(() => props.onAddChild(node))}><Icon name="plus" size={14} /> {node.kind === "epic" ? "新增特性" : "新增用户故事"}</button>}
      <button role="menuitem" onClick={() => menuAction(() => props.onEdit(node))}>编辑</button>
      <button role="menuitem" disabled={node.kind === "vision"} onClick={() => menuAction(() => props.onDispatch(node))}>派发{node.kind === "story" || node.kind === "bug" ? "" : "范围"}</button>
      <div className="menu-sep" />
      <button role="menuitem" className="danger" disabled={node.kind === "vision"} onClick={() => menuAction(() => props.onDelete(node))}>删除</button>
    </div>}
    {open && hasChildren && node.children.map(c => <TreeLine key={c.entityId} {...props} node={c} depth={props.depth + 1} />)}
  </div>;
}

function DeleteNodeModal({ project, node, onClose }: { project: api.Project; node: RequirementNode; onClose: () => void; onDeleted: () => void }) {
  const reason = node.children.length ? `存在 ${node.children.length} 个直接子项，必须先处理子项，不能级联删除。` : "任务／设计引用关系尚不能完整核验，暂不允许删除文档。";
  return <Modal title="删除需求" onClose={onClose} width={460} heightRatio={0.3} footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn danger" disabled>删除</button></>}>
    <p>删除「{node.entityId} {node.title}」？</p><div className="requirement-note">{reason}</div><div className="small muted">项目：{project.name}；不会移除磁盘文档或子项。</div>
  </Modal>;
}

function DispatchModal({ project, tree, node, onClose }: { project: api.Project; tree: RequirementNode[]; node: RequirementNode; onClose: () => void }) {
  const { setFeatureTarget } = useApp();
  const stories = flattenRequirements([node]).filter(n => n.kind === "story" || n.kind === "bug");
  // CR-047：从所选范围直接解析唯一Feature；Story上溯Feature，Feature即自身；Epic/全范围不猜一个Feature。
  const feature = node.kind === "feature" ? node : node.kind === "story" || node.kind === "bug"
    ? findAncestorFeature(tree, node.entityId) : null;
  const featureBlocked = !feature || node.kind === "epic" || node.kind === "vision";
  const useFeature = () => {
    if (!feature) return;
    setFeatureTarget(project.id, { featureId: feature.entityId, featureTitle: feature.title });
    window.dispatchEvent(new CustomEvent("app:new-execution-session", { detail: { projectId: project.id, featureId: feature.entityId } }));
    onClose();
  };
  return <Modal title="派发预检" onClose={onClose} width={760} footer={<><button className="btn" onClick={onClose}>关闭</button>{feature && <button className="btn primary" onClick={useFeature}>为 {feature.entityId} 创建执行会话</button>}</>}>
    <div className="requirement-note">任务执行器与派发 API 尚未接入。本步骤只把所选特性设为 AI 新建执行会话的归属，不创建 Run、不推进需求状态或伪造执行成功。</div>
    <h3>{node.entityId} · {node.title}</h3>
    {feature && <p className="small"><b>执行特性：</b>{feature.entityId} · {feature.title}（本执行会话仅实现该Feature）</p>}
    {!feature && <p className="requirement-note" role="alert">当前范围不能确定唯一执行特性：{node.kind === "epic" ? "Epic 下可能有多个特性，请逐特性派发或新建独立执行会话，不能合并到一个会话。" : "Story 的父链缺失或不是特性，请先修复源关系。"}</p>}
    {stories.map(n => <div key={n.entityId} className="dispatch-item"><span className="req-id">{n.entityId}</span><span className="grow">{n.title}</span>{statusTag(n.status)}</div>)}
    {!stories.length && <Empty title="范围内没有 Story" />}
  </Modal>;
}

function DocEditModal(props: { project: api.Project; node: RequirementNode; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [text, setText] = useState<string | null>(null);
  const [form, setForm] = useState<NodeForm>(blankNodeForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.fsReadFile(props.project.rootUri, props.node.sourceUri).then(md => {
      if (!alive) return;
      setText(md);
      const fm = frontMatter(md), body = stripFrontMatter(md);
      setForm({ title: fm.title ?? props.node.title, status: fm.status ?? props.node.status ?? "待澄清", owner: fm.owner ?? "", summary: fm.summary ?? "", estimate: fm.estimate ?? "", acs: acSection(body), body });
    }).catch(e => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [props.node, props.project.rootUri]);
  const save = async () => {
    if (text === null || busy) return;
    if (!form.title.trim()) return toast("标题不能为空", "warn");
    setBusy(true);
    try {
      const latest = await api.fsReadFile(props.project.rootUri, props.node.sourceUri);
      if (latest !== text) return toast("磁盘文档已变化，请关闭并重新载入后合并；当前草稿保留。", "warn");
      let body = form.body;
      if ((props.node.kind === "story" || props.node.kind === "bug") && form.acs !== acSection(stripFrontMatter(text))) body = writeAcSection(body, form.acs);
      const originalFm = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)?.[0] ?? "";
      const content = patchFrontMatter(originalFm + body, { title: form.title.trim(), status: form.status, owner: form.owner, summary: form.summary, estimate: form.estimate });
      await api.fsWriteFile(props.project.rootUri, props.node.sourceUri, content);
      toast("已保存"); props.onSaved();
    } catch (e) { toast(String(e), "err"); } finally { setBusy(false); }
  };
  return <Modal title={`编辑 ${props.node.entityId}`} onClose={() => { if (!busy) props.onClose(); }} width={620} footer={<><button className="btn" disabled={busy} onClick={props.onClose}>取消</button><button className="btn primary" disabled={busy || text === null} onClick={save}>{busy ? "保存中…" : "保存"}</button></>}>
    {error ? <Empty title="读取文档失败" desc={error} /> : text === null ? <Empty title="加载中…" /> : <NodeFields kind={props.node.kind} form={form} setForm={setForm} parent={props.node.parentId ?? props.project.name} disabled={busy} />}
  </Modal>;
}


function CreateNodeModal(props: { project: api.Project; parent: RequirementNode | null; tree: RequirementNode[]; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const { parent } = props;
  const kind = parent === null ? "epic" : parent.kind === "epic" ? "feature" : "story";
  const [form, setForm] = useState<NodeForm>(blankNodeForm);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!form.title.trim()) return toast("标题不能为空", "warn");
    if (busy) return;
    setBusy(true);
    try {
      const prefix = kind === "epic" ? "EPIC" : kind === "feature" ? "FEAT" : "STORY";
      const dir = `docs/Plan/${KIND_DIR[kind]}`;
      const siblings = await api.fsListDir(props.project.rootUri, dir);
      const ids = [...collectIds(await api.readRequirements(props.project.id)), ...siblings.map(f => f.name.split(/[-：]/).slice(0, 2).join("-"))];
      const max = ids.filter(id => id.startsWith(`${prefix}-`)).reduce((m, id) => Math.max(m, Number(/(\d+)$/.exec(id)?.[1] ?? 0)), 0);
      const entityId = `${prefix}-${String(max + 1).padStart(3, "0")}`;
      const file = `${dir}/${entityId}.md`;
      if (siblings.some(f => f.name === `${entityId}.md`)) return toast("编号已被占用，请重试", "warn");
      const header = `# ${entityId}：${form.title.trim()}\n\n`;
      const acs = form.acs.split(/\r?\n/).filter(line => line.trim()).map((line, i) => /AC-/.test(line) ? line : `- AC-${entityId}-${String(i + 1).padStart(2, "0")}：${line}`).join("\n");
      const body = kind === "story" ? writeAcSection(header + form.body, acs) : header + form.body;
      const content = patchFrontMatter(body, { id: entityId, type: kind, ...(parent ? { parent: parent.entityId } : {}), status: form.status, owner: form.owner, title: form.title.trim(), summary: form.summary, estimate: form.estimate });
      await api.fsWriteFile(props.project.rootUri, file, content);
      toast(`已创建 ${entityId}`); props.onCreated();
    } catch (e) { toast(`创建失败：${String(e)}；请确认 docs/Plan/${KIND_DIR[kind]} 目录已存在。`, "err"); } finally { setBusy(false); }
  };
  return <Modal title={parent ? `在 ${parent.entityId} 下新建` : "新建史诗"} onClose={() => { if (!busy) props.onClose(); }} width={620} footer={<><button className="btn" disabled={busy} onClick={props.onClose}>取消</button><button className="btn primary" disabled={busy} onClick={create}>{busy ? "创建中…" : "创建"}</button></>}>
    <NodeFields kind={kind} form={form} setForm={setForm} parent={parent ? `${parent.entityId} · ${parent.title}` : props.project.name} disabled={busy} />
  </Modal>;
}


/** UI-CR073：导图右侧就地编辑／新建面板。
 *  与 DocEditModal、CreateNodeModal 共用 NodeFields 与 front matter 规则；
 *  不弹窗、不切换阅读方式，保存后由外层重新扫描需求源。 */
function NodeEditorPanel(props: {
  project: api.Project;
  node?: RequirementNode;
  parent?: RequirementNode | null;
  kind?: RequirementNode["kind"];
  tree?: RequirementNode[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const editing = Boolean(props.node);
  const parent = props.parent ?? null;
  const kind: RequirementNode["kind"] = props.node?.kind ?? props.kind ?? (parent === null ? "epic" : parent.kind === "epic" ? "feature" : "story");
  const [text, setText] = useState<string | null>(editing ? null : "");
  const [form, setForm] = useState<NodeForm>(blankNodeForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.node) return;
    let alive = true;
    api.fsReadFile(props.project.rootUri, props.node.sourceUri).then(md => {
      if (!alive) return;
      setText(md);
      const fm = frontMatter(md), body = stripFrontMatter(md);
      setForm({ title: fm.title ?? props.node!.title, status: fm.status ?? props.node!.status ?? "待澄清", owner: fm.owner ?? "", summary: fm.summary ?? "", estimate: fm.estimate ?? "", acs: acSection(body), body });
    }).catch(e => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [props.node, props.project.rootUri]);

  const save = async () => {
    if (busy) return;
    if (!form.title.trim()) return toast("标题不能为空", "warn");
    setBusy(true);
    try {
      if (props.node && props.node.sourceUri) {
        if (text === null) return;
        const latest = await api.fsReadFile(props.project.rootUri, props.node.sourceUri);
        if (latest !== text) return toast("磁盘文档已变化，请关闭面板重新载入后合并；当前草稿保留。", "warn");
        let body = form.body;
        if ((kind === "story" || kind === "bug") && form.acs !== acSection(stripFrontMatter(text))) body = writeAcSection(body, form.acs);
        const originalFm = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)?.[0] ?? "";
        const content = patchFrontMatter(originalFm + body, { title: form.title.trim(), status: form.status, owner: form.owner, summary: form.summary, estimate: form.estimate });
        await api.fsWriteFile(props.project.rootUri, props.node.sourceUri, content);
        toast("已保存");
      } else {
        const prefix = kind === "epic" ? "EPIC" : kind === "feature" ? "FEAT" : "STORY";
        const dir = `docs/Plan/${KIND_DIR[kind]}`;
        const siblings = await api.fsListDir(props.project.rootUri, dir);
        const ids = [...collectIds(await api.readRequirements(props.project.id)), ...siblings.map(f => f.name.split(/[-：]/).slice(0, 2).join("-"))];
        const max = ids.filter(id => id.startsWith(`${prefix}-`)).reduce((m, id) => Math.max(m, Number(/(\d+)$/.exec(id)?.[1] ?? 0)), 0);
        const entityId = `${prefix}-${String(max + 1).padStart(3, "0")}`;
        const file = `${dir}/${entityId}.md`;
        if (siblings.some(f => f.name === `${entityId}.md`)) return toast("编号已被占用，请重试", "warn");
        const header = `# ${entityId}：${form.title.trim()}\n\n`;
        const acs = form.acs.split(/\r?\n/).filter(line => line.trim()).map((line, i) => /AC-/.test(line) ? line : `- AC-${entityId}-${String(i + 1).padStart(2, "0")}：${line}`).join("\n");
        const body = kind === "story" ? writeAcSection(header + form.body, acs) : header + form.body;
        const content = patchFrontMatter(body, { id: entityId, type: kind, ...(parent ? { parent: parent.entityId } : {}), status: form.status, owner: form.owner, title: form.title.trim(), summary: form.summary, estimate: form.estimate });
        await api.fsWriteFile(props.project.rootUri, file, content);
        toast(`已创建 ${entityId}`);
      }
      props.onSaved();
    } catch (e) {
      toast(`保存失败：${String(e)}${editing ? "" : `；请确认 docs/Plan/${KIND_DIR[kind]} 目录已存在。`}`, "err");
    } finally { setBusy(false); }
  };

  const title = editing ? `编辑 ${props.node!.entityId}` : parent ? `在 ${parent.entityId} 下新建${kind === "feature" ? "特性" : "用户故事"}` : "新建史诗";
  return <aside className="req-map-detail req-map-editor" role="dialog" aria-label={title} data-panel-kind={kind} data-panel-mode={editing ? "edit" : "create"}>
    <header className="req-map-detail-head">
      <span className={`req-kind ${kind}`}>{kind === "epic" ? "Epic" : kind === "feature" ? "Feature" : kind === "bug" ? "Bug" : "Story"}</span>
      <b>{editing ? props.node!.entityId : "新建"}</b>
      <span className="caption">{editing ? "编辑" : "未保存"}</span>
      <button className="icon-btn" aria-label="关闭面板" disabled={busy} onClick={props.onClose}><Icon name="x" size={14} /></button>
    </header>
    <div className="req-map-detail-scroll">
      {error ? <Empty title="读取文档失败" desc={error} />
        : editing && text === null ? <Empty title="加载中…" />
          : <NodeFields kind={kind} form={form} setForm={setForm} parent={parent ? `${parent.entityId} · ${parent.title}` : props.node?.parentId ?? props.project.name} disabled={busy} />}
    </div>
    <footer className="req-map-detail-foot">
      <button className="btn sm primary" disabled={busy || (editing && text === null)} onClick={save}>{busy ? "保存中…" : editing ? "保存" : "创建"}</button>
      <button className="btn sm" disabled={busy} onClick={props.onClose}>取消</button>
    </footer>
  </aside>;
}

function collectIds(nodes: RequirementNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: RequirementNode[]) => {
    for (const n of ns) {
      out.push(n.entityId);      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/* ============ 设计 ============ */

const DESIGN_SECTIONS = [
  { key: "PRD", label: "PRD", title: "产品需求文档", icon: "doc" },
  { key: "UI", label: "UI", title: "界面与交互设计", icon: "layers" },
  { key: "LLD", label: "方案", title: "技术实现方案", icon: "code" },
  { key: "DB", label: "数据库", title: "数据库设计", icon: "database" },
] as const;
type DesignSection = typeof DESIGN_SECTIONS[number]["key"];
interface DesignDraft { saved: string; text: string; editing: boolean }

function DesignPane({ project, focus }: { project: api.Project; focus?: { section: DesignSection; path: string } | null }) {
  const toast = useToast();
  const [section, setSection] = useState<DesignSection>("PRD");
  const [files, setFiles] = useState<api.FileNode[]>([]);
  const [currentBySection, setCurrentBySection] = useState<Partial<Record<DesignSection, string>>>({});
  const [drafts, setDrafts] = useState<Record<string, DesignDraft>>({});
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [html, setHtml] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const tocPane = usePaneWidth(`project:${project.id}`, "design-toc", { default: 240, min: 160, max: 360, side: "right", containerRef: rootRef, reserve: 56, minCenter: 320, overlayInset: 56 });
  const [busy, setBusy] = useState(false);
  /* UI-CR073：HTML 设计文件的预览／源码切换（预览为默认）。 */
  const [sourceView, setSourceView] = useState(false);
  const docRef = useRef<HTMLDivElement>(null);
  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const tree = await api.fsListTree(project.rootUri, 20);
      setFiles(tree.filter(f => !f.isDir && projectRelativePath(project.rootUri, f.path).startsWith("docs/")).sort((a, b) => a.path.localeCompare(b.path)));
    } catch (e) { setError(String(e)); } finally { setLoading(false); }
  }, [project.rootUri]);
  useEffect(() => { void reload(); }, [reload]);
  /* UI-CR066 r2：从导图打开模型文档时切到对应分区并定位文件。 */
  useEffect(() => {
    if (!focus) return;
    setSection(focus.section);
    setCurrentBySection(previous => ({ ...previous, [focus.section]: focus.path }));
  }, [focus]);
  const shown = useMemo(() => files.filter(f => projectRelativePath(project.rootUri, f.path).toLowerCase().startsWith(`docs/${section.toLowerCase()}/`)), [files, project.rootUri, section]);
  const current = currentBySection[section] && shown.some(f => f.path === currentBySection[section]) ? currentBySection[section]! : shown[0]?.path ?? null;
  const draft = current ? drafts[current] : null;
  useEffect(() => {
    if (!current || drafts[current]) { setReading(false); setReadError(null); return; }
    let alive = true;
    setReading(true); setReadError(null);
    api.fsReadFile(project.rootUri, current).then(text => {
      if (alive) setDrafts(prev => ({ ...prev, [current]: { saved: text, text, editing: false } }));
    }).catch(e => { if (alive) setReadError(String(e)); }).finally(() => { if (alive) setReading(false); });
    return () => { alive = false; };
  }, [current, project.rootUri, drafts]);
  const body = stripFrontMatter(draft?.text ?? "");
  const markdown = !!current && /\.(md|markdown)$/i.test(current);
  /* UI-CR073：HTML 设计文件走沙箱页面预览（不是源码）。 */
  const htmlPreview = !!current && /\.html?$/i.test(current);
  useEffect(() => {
    let alive = true;
    if (!markdown || !draft) { setHtml(""); return; }
    renderMarkdown(body).then(result => { if (alive) setHtml(result); }).catch(e => { if (alive) setReadError(String(e)); });
    return () => { alive = false; };
  }, [body, markdown]);
  const toc = markdown ? extractToc(body) : [];
  const fm = frontMatter(draft?.text ?? "");
  const patch = (update: Partial<DesignDraft>) => { if (current && draft) setDrafts(prev => ({ ...prev, [current]: { ...prev[current], ...update } })); };
  const save = async () => {
    if (!current || !draft || busy) return;
    setBusy(true);
    try {
      if (await api.fsReadFile(project.rootUri, current) !== draft.saved) return toast("磁盘文档已变化，当前草稿保留；请合并后再保存。", "warn");
      const content = draft.text;
      await api.fsWriteFile(project.rootUri, current, content);
      setDrafts(prev => ({ ...prev, [current]: { ...prev[current], saved: content, editing: false } }));
      toast("文档已保存到项目目录");
    } catch (e) { toast(String(e), "err"); } finally { setBusy(false); }
  };
  const exportDoc = () => {
    if (!draft || !current) return;
    const url = URL.createObjectURL(new Blob([draft.text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = current.split(/[\\/]/).pop() ?? "document.md"; a.click(); URL.revokeObjectURL(url);
  };
  return <div ref={rootRef} className="design-shell">
    {/* UI-CR073（用户第 10 项）：左轨只保留四个分区入口；「关联需求」「目录」移出。 */}
    <nav className="design-rail" aria-label="设计资料">
      {DESIGN_SECTIONS.map(item => <button key={item.key} className={`rail-btn ${section === item.key ? "active" : ""}`} aria-label={item.title} aria-pressed={section === item.key} title={item.title} onClick={() => setSection(item.key)}><WorkspaceIcon name={item.icon} /></button>)}
    </nav>
    <section className="design-main">
      <div className="design-topbar">
        <select className="input design-file-select" aria-label="设计文档" value={current ?? ""} disabled={loading || !shown.length || busy} onChange={e => { setCurrentBySection(prev => ({ ...prev, [section]: e.target.value })); setReadError(null); }}>
          {!shown.length && <option value="">docs/{section}/</option>}{shown.map(f => <option key={f.path} value={f.path}>{projectRelativePath(project.rootUri, f.path)}</option>)}
        </select>
        <span className="spacer" />
        {/* UI-CR073：目录显隐移到顶部文档操作区（原先在左轨）。 */}
        <PaneToggle pane={tocPane} label="目录" className="btn sm"><Icon name="panelRight" size={14} />目录</PaneToggle>
        <button className="btn sm" disabled={!draft || busy || htmlPreview} onClick={() => patch({ editing: !draft?.editing })}>{draft?.editing ? "预览" : "编辑"}</button>
        <button className="btn sm" disabled={!draft} onClick={exportDoc}>导出</button>
      </div>
      {loading ? <Empty title="读取设计资料…" /> : error ? <Empty title="读取目录失败" desc={error} action={<button className="btn sm" onClick={() => void reload()}>重试</button>} /> : !current ? <Empty title="暂无设计文档" desc={`项目 docs/${section}/ 目录下没有可列出的文件。不会载入示例或生成虚构版本。`} /> : readError ? <Empty title="无法读取此文档" desc={readError} /> : reading || !draft ? <Empty title="读取文档…" /> : htmlPreview ? (
        /* UI-CR073（用户第 9 项）：.html 设计文件渲染页面预览（沙箱 iframe），不再默认显示源码。 */
        <div className="design-preview-host">
          <div className="design-preview-bar">
            <span>页面预览（沙箱渲染，只读）</span><span className="spacer" />
            <button className="btn sm" onClick={() => setSourceView(prev => !prev)}>{sourceView ? "预览" : "源码"}</button>
          </div>
          {sourceView
            ? <pre className="design-source mono" style={{ flex: "1 1 auto", overflow: "auto", margin: 0, padding: 16 }}>{draft.text}</pre>
            : <iframe className="design-preview-frame" title={`设计页面预览：${projectRelativePath(project.rootUri, current)}`} sandbox="" referrerPolicy="no-referrer" srcDoc={draft.text} />}
          <div className="design-preview-note">预览不执行脚本、不加载外部资源；相对路径的资源不会显示。</div>
        </div>
      ) : draft.editing ? (
        <div className="design-edit"><textarea className="textarea mono" spellCheck={false} value={draft.text} disabled={busy} onChange={e => patch({ text: e.target.value })} />
          <div className="row"><button className="btn primary sm" disabled={busy} onClick={save}>{busy ? "保存中…" : "保存"}</button><button className="btn sm" disabled={busy} onClick={() => patch({ text: draft.saved, editing: false })}>取消</button><span className="small muted">{draft.text === draft.saved ? "无未保存修改" : "未保存草稿"}</span></div>
        </div>
      ) : markdown ? <div ref={docRef} className="design-doc kb-content" dangerouslySetInnerHTML={{ __html: html }} /> : <div className="design-doc"><div className="small muted">源码阅读；不执行脚本、不加载外部资源。</div><pre className="design-source mono">{draft.text}</pre></div>}
    </section>
    <aside {...tocPane.paneProps} className={`design-toc ${tocPane.paneProps.className}`}>
      <ResizeHandle pane={tocPane} label="设计目录" />
      <div className="design-toc-info"><b>文档信息</b>
        <div className="meta-row"><span>版本</span><b>{fm.version || "未登记"}</b></div>
        <div className="meta-row"><span>更新</span><b>{fm.updated || fm.updatedAt || "未登记"}</b></div>
        <div className="meta-row"><span>负责人</span><b>{fm.owner || "未登记"}</b></div>
        <div className="meta-row"><span>关联 Story</span><b>{[...new Set((draft?.text ?? "").match(/STORY-\d+/g) ?? [])].join("、") || "未登记"}</b></div>
        <button className="btn sm" disabled={loading} onClick={() => void reload()}>刷新资料目录</button><span className="small muted">同步设计依据未接入，不标记已同步。</span>
      </div>
      <div className="design-toc-list"><div className="small muted">本页目录</div>{toc.map((t, i) => <button key={i} className="toc-line" style={{ paddingLeft: 8 + (t.level - 1) * 12 }} onClick={() => docRef.current?.querySelector(`[id="${t.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>{t.text}</button>)}{!toc.length && <span className="small muted">无章节</span>}</div>
    </aside>
  </div>;
}

function projectRelativePath(root: string, path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\/\/?\?\//, "");
  const base = root.replace(/\\/g, "/").replace(/^\/\/?\?\//, "").replace(/\/$/, "");
  return normalized.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? normalized.slice(base.length + 1) : normalized;
}

const PLAN_BLOCKER: Record<string, string> = {
  NO_AUTHORIZATION: "未授权",
  AUTHORIZATION_EXPIRED: "授权过期",
  TASK_NOT_READY: "任务状态不可执行",
};

const TASK_STATUS: Record<string, { label: string; cls: string }> = {
  queued: { label: "排队", cls: "queued" },
  waiting_dependency: { label: "等待依赖", cls: "wait" },
  waiting_resource: { label: "等待资源", cls: "wait" },
  preparing: { label: "准备中", cls: "run" },
  running: { label: "运行中", cls: "run" },
  verifying: { label: "验证中", cls: "verify" },
  integrating: { label: "集成中", cls: "verify" },
  succeeded: { label: "已完成", cls: "ok" },
  retry_wait: { label: "等待重试", cls: "wait" },
  blocked: { label: "阻塞", cls: "block" },
  paused: { label: "已暂停", cls: "queued" },
  cancelled: { label: "已取消", cls: "queued" },
  failed: { label: "失败", cls: "fail" },
};

function taskClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function eventDescription(event: api.ExecutionEvent): string {
  switch (event.eventType) {
    case "task.claimed":
      return "执行者领取任务，登记租约与 fence";
    case "task.running":
      return "进入运行";
    case "task.verifying":
      return "进入验证，等待证据";
    case "task.succeeded":
      return "完成并通过当前门槛";
    case "task.failed":
      return "失败，保留证据";
    case "task.blocked":
      return "阻塞，需人工处理";
    case "task.checkpoint":
      return "写入检查点";
    case "task.recovery_resume":
      return "受控恢复，fencingToken 前进";
    case "approval.requested":
      return "登记工具审批请求";
    case "approval.decided":
      return "审批已决定";
    case "approval.expired":
      return "审批已过期";
    default:
      return event.payloadJson ?? "";
  }
}

function TasksPane({ project, onRequirements }: { project: api.Project; onRequirements: () => void }) {
  const [view, setView] = useState<"tree" | "detail" | "sync">("tree");
  const rootRef = useRef<HTMLDivElement>(null), detailRef = useRef<HTMLElement>(null), listRef = useRef<HTMLElement>(null);
  const detailPane = usePaneWidth(`project:${project.id}`, "task-detail", { default: 360, min: 240, max: 520, side: "right", containerRef: rootRef, reserve: 88, minCenter: 320, overlayInset: 56 });
  const [tasks, setTasks] = useState<api.ExecutionTask[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<api.ExecutionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<api.PlanCheck | null | undefined>(undefined);
  const [approvals, setApprovals] = useState<api.ApprovalView[]>([]);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    api.executionTaskList(project.id)
      .then(list => {
        setTasks(list);
        setSelected(prev => (prev && list.some(t => t.id === prev) ? prev : (list[0]?.id ?? null)));
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [project.id]);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    if (!selected) { setEvents([]); return; }
    let alive = true;
    api.executionEventList(project.id, selected, 50)
      .then(list => { if (alive) setEvents(list); })
      .catch(() => { if (alive) setEvents([]); });
    return () => { alive = false; };
  }, [project.id, selected]);

  const batches = useMemo(() => {
    const map = new Map<string, api.ExecutionTask[]>();
    for (const task of tasks) {
      const list = map.get(task.batchId) ?? [];
      list.push(task);
      map.set(task.batchId, list);
    }
    return [...map.entries()];
  }, [tasks]);

  const counts = useMemo(() => ({
    batches: batches.length,
    tasks: tasks.length,
    running: tasks.filter(t => ["preparing", "running", "verifying", "integrating"].includes(t.status)).length,
    waiting: tasks.filter(t => ["queued", "waiting_dependency", "waiting_resource", "retry_wait"].includes(t.status)).length,
    done: tasks.filter(t => t.status === "succeeded").length,
  }), [tasks, batches.length]);

  const current = tasks.find(t => t.id === selected) ?? null;
  const approvalRisk = approvals.some(item => item.risk === "high")
    ? "高风险"
    : approvals.some(item => item.risk === "medium")
      ? "中风险"
      : approvals.length
        ? "低风险"
        : null;

  useEffect(() => {
    const taskId = current?.id;
    if (!taskId) { setPlan(undefined); return; }
    let alive = true;
    setPlan(undefined);
    api.planTaskStatus(project.id, taskId)
      .then(value => { if (alive) setPlan(value); })
      .catch(() => { if (alive) setPlan(null); });
    return () => { alive = false; };
  }, [project.id, current?.id]);

  useEffect(() => {
    const taskId = current?.id;
    if (!taskId) { setApprovals([]); return; }
    let alive = true;
    api.approvalPending(project.id)
      .then(list => {
        if (alive) setApprovals(list.filter(item => item.taskId === taskId || item.taskId === null));
      })
      .catch(() => { if (alive) setApprovals([]); });
    return () => { alive = false; };
  }, [project.id, current?.id]);

  const selectView = (next: "tree" | "detail" | "sync") => {
    setView(next);
    if (next === "detail") detailPane.setVisible(view !== "detail" || !detailPane.visible);
    requestAnimationFrame(() => (next === "detail" ? detailRef.current : listRef.current)?.focus({ preventScroll: true }));
  };

  return <div ref={rootRef} className="task-workspace" data-task-view={view} data-ui-version="UI-FEAT-019-v1">
    <nav className="req-rail" aria-label="任务工作区">
      <button className={`rail-btn ${view === "tree" ? "on" : ""}`} aria-label="派发树" aria-pressed={view === "tree"} onClick={() => selectView("tree")}><Icon name="workflow" size={18} /><span>派发树</span></button>
      <button className={`rail-btn ${view === "detail" ? "on" : ""}`} aria-label="任务详情" aria-pressed={view === "detail"} onClick={() => selectView("detail")}><Icon name="fileText" size={18} /><span>详情</span></button>
      <button className={`rail-btn ${view === "sync" ? "on" : ""}`} aria-label="同步批次" aria-pressed={view === "sync"} onClick={() => selectView("sync")}><Icon name="git" size={18} /><span>同步</span></button>
    </nav>
    <div className="tasks-pane">
      {view === "sync" ? <SyncPane project={project} /> : (<>
      <div className="task-stats">
        {([["派发批次", counts.batches], ["任务", counts.tasks], ["运行中", counts.running], ["等待", counts.waiting], ["已完成", counts.done]] as const).map(([label, value]) => (
          <div key={label}><span className="small muted">{label}</span><b>{value}</b></div>
        ))}
      </div>
      <div className="task-body">
        <section ref={listRef} className="task-list-pane" tabIndex={-1}>
          <div className="task-pane-head"><h3>派发树</h3><span className="small muted">{project.name} · 只读</span></div>
          {loading ? <Empty title="读取任务…" /> : error ? (
            <Empty title="无法读取任务" desc={error} action={<button className="btn sm" onClick={reload}>重试</button>} />
          ) : !tasks.length ? (
            <Empty
              title="该项目还没有可读取的运行"
              desc="任务执行账本已就绪，但真实 CLI runner 尚未接入。派发、暂停、重试与验收在 runner 与审批界面完成前保持不可用。"
              action={<button className="btn primary" onClick={onRequirements}>查看需求</button>}
            />
          ) : (
            <div className="task-batch-list">
              {batches.map(([batchId, list]) => (
                <div className="task-batch" key={batchId}>
                  <div className="task-batch-head"><span>{batchId}</span><span className="small muted">{list.length} 任务</span></div>
                  {list.map(task => {
                    const meta = TASK_STATUS[task.status] ?? { label: task.status, cls: "queued" };
                    return <button
                      key={task.id}
                      className={`task-row ${task.id === selected ? "sel" : ""}`}
                      onClick={() => { setSelected(task.id); selectView("detail"); }}
                    >
                      <span className="task-id">{task.id.replace(/^task-/, "").slice(0, 8)}</span>
                      <span className="task-name">{task.storyId}</span>
                      <span className={`task-badge ${meta.cls}`}>{meta.label}</span>
                    </button>;
                  })}
                </div>
              ))}
            </div>
          )}
        </section>
        <aside {...detailPane.paneProps} ref={detailRef} className={`task-detail-pane ${detailPane.paneProps.className}`} tabIndex={-1}>
          <ResizeHandle pane={detailPane} label="任务详情" />
          {!current ? <Empty title="未选择任务" desc="从左侧选择任务查看状态与事件。" /> : (
            <div className="task-detail">
              <div className="task-detail-head">
                <div><h3>{current.storyId}</h3><p className="small muted">{current.id} · {current.featureId ?? "未绑定特性"}</p></div>
                <span className={`task-badge ${(TASK_STATUS[current.status] ?? { cls: "queued" }).cls}`}>{(TASK_STATUS[current.status] ?? { label: current.status }).label}</span>
              </div>
              <div className="task-detail-grid">
                <div className="task-cell"><span className="small muted">状态</span><b>{current.status}</b></div>
                <div className="task-cell"><span className="small muted">Fence</span><b>{current.fencingToken}</b></div>
                <div className="task-cell"><span className="small muted">Revision</span><b>{current.revision}</b></div>
                <div className="task-cell"><span className="small muted">活动键</span><b>{current.activeKeyHeld ? "持有" : "释放"}</b></div>
              </div>
              {current.blockedReason && <div className="task-callout warn">{current.blockedReason}</div>}
              <div className="task-section-title">执行计划</div>
              {plan === undefined ? <p className="small muted">读取执行计划…</p> : plan === null ? (
                <div className="task-plan-card"><span className="small muted">尚未冻结执行计划；真实执行前必须有不可变计划与有效授权。</span></div>
              ) : (
                <div className="task-plan-card">
                  <div><span className="small muted">计划 hash</span><b>{plan.plan.planHash.slice(0, 18)}…</b></div>
                  <div><span className="small muted">CLI · 档位</span><b>{plan.plan.selectedCli}{plan.plan.effort ? ` · ${plan.plan.effort}` : ""}</b></div>
                  <div><span className="small muted">授权</span><b className={plan.ready ? "task-plan-ok" : "task-plan-warn"}>{plan.ready ? "有效" : plan.blockers.map(item => PLAN_BLOCKER[item] ?? item).join(" / ")}</b></div>
                </div>
              )}
              {approvals.length > 0 && (
                <div className="task-approval-line">
                  <span className="task-badge wait">待审批 {approvals.length}</span>
                  {approvalRisk && (
                    <span className={`task-badge ${approvalRisk === "高风险" ? "fail" : "wait"}`}>{approvalRisk}</span>
                  )}
                  <span className="small muted">高风险命令需人工确认后才能执行</span>
                </div>
              )}
              <div className="task-section-title">事件时间线</div>
              {events.length ? <div className="task-timeline">{events.slice().reverse().map(event => (
                <div className="task-event" key={event.seq}>
                  <span className="t">{taskClock(event.createdAt)}</span>
                  <span className="type">{event.eventType}</span>
                  <span className="desc">{eventDescription(event)}</span>
                </div>
              ))}</div> : <p className="small muted">暂无事件</p>}
              <div className="task-callout info">只读视图：暂停、取消与重试需 runner 控制通道与审批界面，当前不可用。</div>
            </div>
          )}
        </aside>
      </div>
      </>)}
    </div>
  </div>;
}

const SYNC_STATE: Record<string, { label: string; cls: string }> = {
  prepared: { label: "待应用", cls: "wait" },
  applied_pending_reconcile: { label: "待对账", cls: "run" },
  reconciled: { label: "已对账", cls: "ok" },
  conflict: { label: "冲突", cls: "fail" },
  rejected: { label: "已拒绝", cls: "queued" },
  cancelled: { label: "已取消", cls: "queued" },
  failed: { label: "失败", cls: "fail" },
};

const TARGET_STATE: Record<string, { label: string; cls: string }> = {
  staged: { label: "待写入", cls: "wait" },
  applied: { label: "已应用", cls: "ok" },
  pending: { label: "待重试", cls: "wait" },
  conflict: { label: "冲突", cls: "fail" },
  compensated: { label: "已补偿", cls: "queued" },
};

function SyncPane({ project }: { project: api.Project }) {
  const [batches, setBatches] = useState<api.SyncBatchSummary[]>([]);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [detail, setDetail] = useState<api.SyncBatchDetail | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [preview, setPreview] = useState<api.SyncTargetPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.syncBatchList(project.id)
      .then(list => {
        setBatches(list);
        setBatchId(prev => (prev && list.some(b => b.id === prev) ? prev : (list[0]?.id ?? null)));
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [project.id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!batchId) { setDetail(null); setTargetId(null); return; }
    let alive = true;
    api.syncBatchGet(project.id, batchId)
      .then(d => {
        if (!alive) return;
        setDetail(d);
        setTargetId(prev => (prev && d.targets.some(t => t.targetId === prev) ? prev : (d.targets[0]?.targetId ?? null)));
      })
      .catch(e => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [project.id, batchId]);

  useEffect(() => {
    if (!batchId || !targetId) { setPreview(null); return; }
    let alive = true;
    api.syncTargetPreview(project.id, batchId, targetId)
      .then(p => { if (alive) setPreview(p); })
      .catch(() => { if (alive) setPreview(null); });
    return () => { alive = false; };
  }, [project.id, batchId, targetId]);

  const reconcile = async () => {
    setBusy(true);
    try {
      await api.syncReconcilePending(project.id);
      load();
      if (batchId) setDetail(await api.syncBatchGet(project.id, batchId));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!batchId) return;
    setBusy(true);
    try {
      await api.syncPublishBaseline(project.id, batchId);
      load();
      setDetail(await api.syncBatchGet(project.id, batchId));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const targets = detail?.targets ?? [];
  const pendingCount = targets.filter(t => t.applyState !== "applied").length;
  const conflictCount = targets.filter(t => t.applyState === "conflict").length;
  const appliedCount = targets.filter(t => t.applyState === "applied").length;
  const oldLines = preview ? preview.diff.filter(line => line.kind !== "add") : [];
  const newLines = preview ? preview.diff.filter(line => line.kind !== "remove") : [];

  return <>
    <div className="task-stats">
      <div><span className="small muted">批次</span><b>{batches.length}</b></div>
      <div><span className="small muted">待对账目标</span><b>{pendingCount}</b></div>
      <div><span className="small muted">冲突</span><b>{conflictCount}</b></div>
      <div><span className="small muted">已应用</span><b>{appliedCount}</b></div>
    </div>
    <div className="sync-body">
      <aside className="sync-batch-list">
        {loading ? <p className="small muted">读取批次…</p> : error ? <p className="small muted">{error}</p> : !batches.length ? (
          <div className="empty" style={{ padding: "24px 8px" }}>
            <h3>还没有同步批次</h3>
            <p>同步批次由文档或代码变更提案创建；发布唯一共同基线后才能开始增量同步。</p>
          </div>
        ) : batches.map(batch => (
          <button
            key={batch.id}
            className={`sync-batch ${batch.id === batchId ? "sel" : ""}`}
            onClick={() => setBatchId(batch.id)}
          >
            <div className="sync-batch-head"><span>{batch.id}</span><span className="small muted">{batch.origin === "document" ? "文档 → 代码" : batch.origin === "code" ? "代码 → 文档" : "逆向"}</span></div>
            <div className="sync-batch-meta">
              <span>{batch.targetCount} 个目标 · {batch.conflictCount} 冲突</span>
              <span className={`task-badge ${(SYNC_STATE[batch.state] ?? { cls: "queued" }).cls}`}>{(SYNC_STATE[batch.state] ?? { label: batch.state }).label}</span>
            </div>
          </button>
        ))}
      </aside>
      <section className="sync-detail">
        {!detail ? <Empty title="选择一个批次" desc="从左侧选择同步批次查看目标对账。" /> : (<>
          <div className="task-detail-head">
            <div><h3>{detail.id}</h3><p className="small muted">{detail.origin} · revision {detail.revision}</p></div>
            <span className={`task-badge ${(SYNC_STATE[detail.state] ?? { cls: "queued" }).cls}`}>{(SYNC_STATE[detail.state] ?? { label: detail.state }).label}</span>
          </div>
          <div className="sync-targets">
            {targets.map(target => {
              const meta = TARGET_STATE[target.applyState] ?? { label: target.applyState, cls: "queued" };
              return <button
                key={target.targetId}
                className={`sync-target ${target.targetId === targetId ? "sel" : ""}`}
                onClick={() => setTargetId(target.targetId)}
              >
                <span className="task-name">{target.targetId}</span>
                <span className={`task-badge ${meta.cls}`}>{meta.label}</span>
                <span className="small muted sync-target-hash">{target.applyState === "conflict" ? "第三方内容" : `${target.newHash.slice(0, 16)}…`}</span>
              </button>;
            })}
            {!targets.length && <p className="small muted" style={{ padding: 10 }}>该批次还没有登记目标。</p>}
          </div>
          {preview ? (<>
            <div className="sync-semantic">
              {preview.semantic.addedHeadings.length > 0 && <span>新增章节：{preview.semantic.addedHeadings.join("、")}</span>}
              {preview.semantic.removedHeadings.length > 0 && <span>删除章节：{preview.semantic.removedHeadings.join("、")}</span>}
              {preview.semantic.addedAcs.length > 0 && <span>新增 AC：{preview.semantic.addedAcs.join("、")}</span>}
              {preview.semantic.removedAcs.length > 0 && <span>删除 AC：{preview.semantic.removedAcs.join("、")}</span>}
            </div>
            <div className="sync-diff-head"><span>当前内容（人工稿）</span><span>提案内容</span></div>
            <div className="sync-diff">
              <div className="sync-diff-col">{oldLines.map((line, i) => (
                <div key={i} className={`sync-diff-line ${line.kind}`}><span className="no">{i + 1}</span><span>{line.text}</span></div>
              ))}</div>
              <div className="sync-diff-col">{newLines.map((line, i) => (
                <div key={i} className={`sync-diff-line ${line.kind}`}><span className="no">{i + 1}</span><span>{line.text}</span></div>
              ))}</div>
            </div>
            {!preview.diff.length && <p className="small muted">暂无可显示的差异（内容缺失或被截断）。</p>}
          </>) : <p className="small muted">选择目标查看当前与提案差异。</p>}
          {conflictCount > 0 && <div className="task-callout warn">冲突目标未被覆盖：磁盘内容既不是基线也不是提案，系统保留人工稿，等待核对或重新生成提案。</div>}
          <div className="row">
            <button className="btn sm" onClick={reconcile} disabled={busy}>{busy ? "对账中…" : "重新对账"}</button>
            <button
              className="btn sm"
              onClick={publish}
              disabled={busy || !detail || detail.state !== "reconciled" || conflictCount > 0}
            >完成并发布基线</button>
          </div>
        </>)}
      </section>
    </div>
  </>;
}

function WorkspaceIcon({ name }: { name: string }) {
  return <Icon name={name} size={18} />;
}

/* ============ 编码 ============ */

function CodePane({ project, visible }: { project: api.Project; visible: boolean }) {
  const [leftTab, setLeftTab] = useState<"file" | "git">("file");
  const rootRef = useRef<HTMLDivElement>(null);
  const gitPane = usePaneWidth(`project:${project.id}`, "code-git", { default: 260, min: 180, max: 480, side: "left", containerRef: rootRef, reserve: 56, minCenter: 320, overlayInset: 56, disabled: !visible });
  return <div ref={rootRef} className="code-shell">
    <nav className="code-rail" aria-label="编码管理">
      <button className={`rail-btn ${leftTab === "file" ? "active" : ""}`} aria-label="资源管理" title="资源管理" aria-pressed={leftTab === "file"} onClick={() => setLeftTab("file")}><WorkspaceIcon name="folder" /></button>
      <button className={`rail-btn ${leftTab === "git" ? "active" : ""}`} aria-label="Git 管理" title="Git 管理" aria-pressed={leftTab === "git"} onClick={() => { setLeftTab("git"); gitPane.setVisible(true); }}><WorkspaceIcon name="git" /></button>
      <button className="rail-btn" aria-label="外部编辑器尚未接入" title="外部编辑器尚未接入" disabled><WorkspaceIcon name="external" /></button>
    </nav>
    <div className={`code-left ${leftTab === "git" ? "git-active" : ""}`}>
      <div {...gitPane.paneProps} className={`code-git-panel ${gitPane.paneProps.className}`} hidden={leftTab !== "git" || !gitPane.visible}><GitPanel repoPath={project.rootUri} /><ResizeHandle pane={gitPane} label="Git 管理" /></div>
      <CodeArea rootUri={project.rootUri} projectId={project.id} hideTree={leftTab === "git"} visible={visible} />
    </div>
  </div>;
}

export { ProjectHome };
