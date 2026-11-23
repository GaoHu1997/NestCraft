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
import { Workbench, emptyAuxState } from "@/modules/workbench/Workbench";
import type { AuxTarget, WorkbenchAuxState } from "@/modules/workbench/Workbench";
import { RequirementsReading } from "./RequirementsReading";
import { flattenRequirements, mergeRequirementSources, normalizedSource } from "./requirementSources";
import { PaneToggle, ResizeHandle, usePaneWidth } from "@/components/pane-resize";
import { TabMoreDropdown, TabMoreIcon, useTabOverflow } from "@/components/tab-overflow";
import "./projects.css";
import "@/modules/office/office.css";

type Tab = "workbench" | "requirements" | "design" | "tasks" | "code";

export function ProjectWorkspace(props: { projectId: string; tab: Tab; visible?: boolean }) {
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
  /* CR-054：代码与办公两类项目都在最前加入「工作台」，纯图标、不显示文字。 */
  const pwTabList: [Tab, string][] = project?.kind === "code"
    ? [["workbench", "工作台"], ["requirements", "需求"], ["design", "设计"], ["tasks", "任务"], ["code", "编码"]]
    : [["workbench", "工作台"], ["code", "文档"], ["design", "成果"]];
  const pwTabItems = pwTabList.map(([key, label]) => ({ key, label, active: tab === key }));
  const pwTabSig = pwTabItems.map(item => `${item.key}:${item.label}:${item.active ? 1 : 0}`).join("|");
  const pwTabsOverflow = useTabOverflow({ tabSelector: ".pw-tab", items: pwTabItems, deps: [pwTabSig] });

  useEffect(() => {
    if (!project) return;
    return onLocate(d => {
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
  }, [project, active]);

  if (loading) return <div className="pagebody"><Empty title="加载项目…" /></div>;
  if (!project) return <div className="pagebody"><Empty title="项目不存在或已删除" /></div>;
  return <div className="pw-shell">
    <div ref={pwTabsOverflow.barRef} className="pw-top" role="tablist" aria-label="项目页签">
      <div ref={pwTabsOverflow.hostRef} className="tab-overflow-host">
        {pwTabList.map(([key, label]) => (
          key === "workbench"
            ? <button key={key} className="pw-tab wb-tab-icon" role="tab" aria-selected={tab === key} aria-label={label} title={label} onClick={() => changeTab(key as Tab)}><Icon name="atDesk" size={18} /></button>
            : <button key={key} className="pw-tab" role="tab" aria-selected={tab === key} onClick={() => changeTab(key as Tab)}>{label}</button>
        ))}
        <button {...pwTabsOverflow.moreProps}><TabMoreIcon /></button>
      </div>
      <span className="spacer" />
      <button className={`pw-ai-toggle ${aiVisible ? "on" : ""}`} aria-label="AI 侧栏" aria-pressed={aiVisible} title={aiVisible ? "收起 AI 侧栏" : "展开 AI 侧栏"} onClick={() => setAiVisible(!aiVisible)}>
        <Icon name="aiBot" size={18} />
      </button>
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
  return <>
    <RequirementsReading key={JSON.stringify([project.id, project.rootUri])} project={project} sources={sources} loading={loading} errors={errors} warnings={manifest?.warnings ?? []} complete={manifest !== null} revision={revision}
      focusEntityId={props.focusEntityId} onFocusDone={props.onFocusDone} onReload={() => void reload()} onNew={() => addChild(null)} onAddChild={addChild} onEdit={setEditTarget} onDelete={setDelTarget} onDispatch={setDispatchTarget} onOpenModel={props.onOpenModel} />
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

function stripFrontMatter(md: string): string {
  if (md.startsWith("---")) {
    const end = md.indexOf("---", 3);
    if (end >= 0) return md.slice(end + 3).trimStart();
  }
  return md;
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

interface NodeForm { title: string; status: string; owner: string; summary: string; estimate: string; acs: string; body: string }
const NODE_STATUSES = ["待澄清", "待确认", "已就绪", "设计中", "开发中", "验证中", "待验收", "已完成", "阻塞", "取消"];
const blankNodeForm = (): NodeForm => ({ title: "", status: "待澄清", owner: "", summary: "", estimate: "", acs: "", body: "" });
function frontMatter(text: string): Record<string, string> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1] ?? "";
  return Object.fromEntries(block.split(/\r?\n/).map(line => /^([^:]+):\s*(.*)$/.exec(line)).filter((m): m is RegExpExecArray => !!m).map(m => [m[1].trim(), m[2].trim().replace(/^"|"$/g, "")]));
}
function patchFrontMatter(text: string, fields: Record<string, string>): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const lines = match ? match[1].split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(fields)) {
    const i = lines.findIndex(line => line.startsWith(`${key}:`));
    const line = `${key}: ${value.replace(/[\r\n]/g, " ")}`;
    if (i < 0) lines.push(line); else lines[i] = line;
  }
  return `---\n${lines.join("\n")}\n---\n\n${match ? text.slice(match[0].length).trimStart() : text.trimStart()}`;
}
function acSection(body: string): string { return /(?:^|\n)##\s+验收标准[^\n]*\n([\s\S]*?)(?=\n##\s|$)/.exec(body)?.[1].trim() ?? ""; }
function writeAcSection(body: string, acs: string): string {
  const section = /(?:^|\n)##\s+验收标准[^\n]*\n[\s\S]*?(?=\n##\s|$)/;
  if (section.test(body)) return body.replace(section, `\n## 验收标准\n\n${acs.trim()}\n`);
  return acs.trim() ? `${body.trimEnd()}\n\n## 验收标准\n\n${acs.trim()}\n` : body;
}
function NodeFields({ kind, form, setForm, parent, disabled }: { kind: RequirementNode["kind"]; form: NodeForm; setForm: (f: NodeForm) => void; parent: string; disabled: boolean }) {
  const field = (key: keyof NodeForm, value: string) => setForm({ ...form, [key]: value });
  return <div className="project-form-grid">
    <div className="form-two"><Field label="类型"><input className="input" value={{ epic: "史诗 Epic", feature: "特性 Feature", story: "用户故事 Story", bug: "缺陷 Bug", vision: "愿景 Vision" }[kind]} readOnly /></Field>
      <Field label="状态"><select className="input" value={form.status} disabled={disabled} onChange={e => field("status", e.target.value)}>{[...new Set([...NODE_STATUSES, form.status])].map(s => <option key={s}>{s}</option>)}</select></Field></div>
    <Field label="标题"><input className="input" value={form.title} disabled={disabled} onChange={e => field("title", e.target.value)} /></Field>
    <Field label="摘要"><textarea className="textarea" rows={2} value={form.summary} disabled={disabled} onChange={e => field("summary", e.target.value)} /></Field>
    <div className="form-two"><Field label="负责人"><input className="input" value={form.owner} disabled={disabled} onChange={e => field("owner", e.target.value)} /></Field><Field label="工作量"><input className="input" value={form.estimate} disabled={disabled} placeholder="例如：2 人日" onChange={e => field("estimate", e.target.value)} /></Field></div>
    {(kind === "story" || kind === "bug") && <Field label="可观察验收（每行一条，保留已有 AC 编号）"><textarea className="textarea mono" rows={4} value={form.acs} disabled={disabled} onChange={e => field("acs", e.target.value)} /></Field>}
    <Field label="所属"><input className="input" value={parent} readOnly /></Field>
    <Field label="正文（Markdown）" hint="保留未涉及的章节、历史记录和 AC 编号。"><textarea className="textarea mono" rows={8} value={form.body} disabled={disabled} onChange={e => field("body", e.target.value)} /></Field>
  </div>;
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

const KIND_DIR: Record<string, string> = { epic: "Epic", feature: "Feature", story: "Story", bug: "Story" };

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

function collectIds(nodes: RequirementNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: RequirementNode[]) => {
    for (const n of ns) {
      out.push(n.entityId);
      walk(n.children);
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
    <nav className="design-rail" aria-label="设计资料">
      {DESIGN_SECTIONS.map(item => <button key={item.key} className={`rail-btn ${section === item.key ? "active" : ""}`} aria-label={item.title} aria-pressed={section === item.key} title={item.title} onClick={() => setSection(item.key)}><WorkspaceIcon name={item.icon} /></button>)}
      <div className="rail-sep" /><button className="rail-btn" aria-label="关联需求" title="关联需求" onClick={() => tocPane.setVisible(true)}><WorkspaceIcon name="link" /></button>
      <PaneToggle pane={tocPane} label="目录" className="rail-btn"><WorkspaceIcon name="panel" /></PaneToggle>
    </nav>
    <section className="design-main">
      <div className="design-topbar">
        <select className="input design-file-select" aria-label="设计文档" value={current ?? ""} disabled={loading || !shown.length || busy} onChange={e => { setCurrentBySection(prev => ({ ...prev, [section]: e.target.value })); setReadError(null); }}>
          {!shown.length && <option value="">docs/{section}/</option>}{shown.map(f => <option key={f.path} value={f.path}>{projectRelativePath(project.rootUri, f.path)}</option>)}
        </select>
        <span className="spacer" />
        <button className="btn sm" disabled={!draft || busy} onClick={() => patch({ editing: !draft?.editing })}>{draft?.editing ? "预览" : "编辑"}</button>
        <button className="btn sm" disabled={!draft} onClick={exportDoc}>导出</button>
      </div>
      {loading ? <Empty title="读取设计资料…" /> : error ? <Empty title="读取目录失败" desc={error} action={<button className="btn sm" onClick={() => void reload()}>重试</button>} /> : !current ? <Empty title="暂无设计文档" desc={`项目 docs/${section}/ 目录下没有可列出的文件。不会载入示例或生成虚构版本。`} /> : readError ? <Empty title="无法读取此文档" desc={readError} /> : reading || !draft ? <Empty title="读取文档…" /> : draft.editing ? (
        <div className="design-edit"><textarea className="textarea mono" spellCheck={false} value={draft.text} disabled={busy} onChange={e => patch({ text: e.target.value })} />
          <div className="row"><button className="btn primary sm" disabled={busy} onClick={save}>{busy ? "保存中…" : "保存"}</button><button className="btn sm" disabled={busy} onClick={() => patch({ text: draft.saved, editing: false })}>取消</button><span className="small muted">{draft.text === draft.saved ? "无未保存修改" : "未保存草稿"}</span></div>
        </div>
      ) : markdown ? <div ref={docRef} className="design-doc kb-content" dangerouslySetInnerHTML={{ __html: html }} /> : <div className="design-doc"><div className="small muted">源码阅读；HTML 不执行脚本。交互 UI 预览尚未接入。</div><pre className="design-source mono">{draft.text}</pre></div>}
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

function TasksPane({ project, onRequirements }: { project: api.Project; onRequirements: () => void }) {
  const [view, setView] = useState<"tree" | "detail">("tree");
  const rootRef = useRef<HTMLDivElement>(null), detailRef = useRef<HTMLElement>(null), listRef = useRef<HTMLElement>(null);
  const detailPane = usePaneWidth(`project:${project.id}`, "task-detail", { default: 360, min: 240, max: 520, side: "right", containerRef: rootRef, reserve: 88, minCenter: 320, overlayInset: 56 });
  const selectView = (next: "tree" | "detail") => {
    setView(next);
    if (next === "detail") detailPane.setVisible(view !== "detail" || !detailPane.visible);
    requestAnimationFrame(() => (next === "detail" ? detailRef.current : listRef.current)?.focus({ preventScroll: true }));
  };
  return <div ref={rootRef} className="task-workspace" data-task-view={view} data-ui-version="UI-CR045-v1.1">
    <nav className="req-rail" aria-label="任务工作区">
      <button className={`rail-btn ${view === "tree" ? "on" : ""}`} aria-label="派发树" aria-pressed={view === "tree"} onClick={() => selectView("tree")}><Icon name="workflow" size={18} /><span>派发树</span></button>
      <button className={`rail-btn ${view === "detail" ? "on" : ""}`} aria-label="任务详情" aria-pressed={view === "detail"} onClick={() => selectView("detail")}><Icon name="fileText" size={18} /><span>详情</span></button>
    </nav>
    <div className="tasks-pane">
      <div className="task-stats">{["派发批次", "子任务", "执行中", "等待依赖", "已交付 / 待验收"].map(label => <div key={label}><span className="small muted">{label}</span><b>—</b></div>)}</div>
      <div className="task-body"><section ref={listRef} className="task-list-pane" tabIndex={-1}><div className="task-pane-head"><h3>派发树</h3><span className="small muted">{project.name} · 每次派发一棵</span></div>
        <div className="task-columns small muted"><span>任务 / 执行器</span><span>状态</span><span>耗时</span></div>
        <Empty title="该项目还没有可读取的运行" desc="任务与 runner API 尚未接入，不能派发、暂停、重试或验收；此处不展示虚构任务数据或成功状态。" action={<button className="btn primary" onClick={onRequirements}>查看需求</button>} />
      </section><aside {...detailPane.paneProps} ref={detailRef} className={`task-detail-pane ${detailPane.paneProps.className}`} tabIndex={-1}><ResizeHandle pane={detailPane} label="任务详情" /><Empty title="未选择任务" desc="接入真实运行记录后，显示协调者、子任务、日志、产物与用量。" /></aside></div>
    </div>
  </div>;
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
