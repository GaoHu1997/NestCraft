import { Icon } from "@/components/icons";
/** 项目工作区：需求（全宽树 + AI）/ 设计（UI/模型）/ 编码（文件/Git + 编辑器 + AI）；
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
import "./projects.css";
import "@/modules/office/office.css";

type Tab = "requirements" | "design" | "tasks" | "code";

export function ProjectWorkspace(props: { projectId: string; tab: Tab; visible?: boolean }) {
  const { go, route, aiVisible, setAiVisible } = useApp();
  const toast = useToast();
  const [project, setProject] = useState<api.Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>(props.tab);
  const [reqFocus, setReqFocus] = useState<string | null>(null);
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
    <div className="pw-top" role="tablist" aria-label="项目页签">
      {(project.kind === "code" ? [["requirements", "需求"], ["design", "设计"], ["tasks", "任务"], ["code", "编码"]] : [["code", "文档"], ["design", "成果"]]).map(([key, label]) => (
        <button key={key} className="pw-tab" role="tab" aria-selected={tab === key} onClick={() => changeTab(key as Tab)}>{label}</button>
      ))}
      <span className="spacer" />
      <button className={`pw-ai-toggle ${aiVisible ? "on" : ""}`} aria-label="AI 侧栏" aria-pressed={aiVisible} title={aiVisible ? "收起 AI 侧栏" : "展开 AI 侧栏"} onClick={() => setAiVisible(!aiVisible)}>
        <Icon name="panelRight" size={18} />
      </button>
    </div>
    <div className="pw-body">
      {project.kind === "code" ? <>
        <section className="pw-pane" role="tabpanel" hidden={tab !== "requirements"}><RequirementsPane project={project} focusEntityId={reqFocus} onFocusDone={() => setReqFocus(null)} /></section>
        <section className="pw-pane" role="tabpanel" hidden={tab !== "design"}><DesignPane project={project} /></section>
        <section className="pw-pane" role="tabpanel" hidden={tab !== "tasks"}><TasksPane project={project} onRequirements={() => changeTab("requirements")} /></section>
        <section className="pw-pane" role="tabpanel" hidden={tab !== "code"}><CodePane project={project} visible={active && tab === "code"} /></section>
      </> : <OfficeWorkspace project={project} tab={tab} active={active} onOpenFile={() => changeTab("code")} />}
    </div>
  </div>;
}

function OfficeWorkspace({ project, tab, active, onOpenFile }: { project: api.Project; tab: Tab; active: boolean; onOpenFile: () => void }) {
  useEffect(() => { ensureOfficeProjectSample(project); }, [project.id, project.name]);
  return <>
    <section className="pw-pane" hidden={tab !== "code"}>
      <div className="office-shell">
        <div className="office-tree-col"><OfficeFileTree projectId={project.id} projectName={project.name} /></div>
        <div className="office-main-col"><OfficeViewer projectId={project.id} visible={active && tab === "code"} /></div>
      </div>
    </section>
    <section className="pw-pane" hidden={tab !== "design"}><OfficeArtifacts projectId={project.id} onOpenFile={fileId => { officeLocateFile(project.id, fileId); onOpenFile(); }} /></section>
  </>;
}

function normalizePath(path: string) { return path.replace(/\\/g, "/").replace(/^\/\/?\?\//, "").replace(/\/$/, "").toLowerCase(); }

/* ============ 需求 ============ */

function RequirementsPane(props: { project: api.Project; focusEntityId?: string | null; onFocusDone?: () => void }) {
  const { project } = props;
  const toast = useToast();
  const [tree, setTree] = useState<RequirementNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState(false);
  const [detail, setDetail] = useState<RequirementNode | null>(null);
  const [editTarget, setEditTarget] = useState<RequirementNode | null>(null);
  const [createParent, setCreateParent] = useState<RequirementNode | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [delTarget, setDelTarget] = useState<RequirementNode | null>(null);
  const [query, setQuery] = useState("");
  const [dispatchTarget, setDispatchTarget] = useState<RequirementNode | null>(null);
  const addChild = (parent: RequirementNode | null) => { setCreateParent(parent); setCreateOpen(true); };

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setTree(await api.readRequirements(project.id));
    } catch (e) {
      toast(String(e), "err");
    } finally {
      setLoading(false);
    }
  }, [project.id, toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 会话引用定位：打开对应需求条目详情（AC-STORY-062-09）
  useEffect(() => {
    const id = props.focusEntityId;
    if (!id || loading || tree.length === 0) return;
    const find = (nodes: RequirementNode[]): RequirementNode | null => {
      for (const n of nodes) {
        if (n.entityId === id) return n;
        const hit = find(n.children);
        if (hit) return hit;
      }
      return null;
    };
    const hit = find(tree);
    if (hit) setDetail(hit);
    props.onFocusDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focusEntityId, loading, tree]);

  const flat = useMemo(() => flattenRequirements(tree), [tree]);
  const roots = useMemo(() => query.trim() ? flat.filter(n => `${n.entityId} ${n.title}`.toLowerCase().includes(query.trim().toLowerCase())) : tree, [tree, flat, query]);
  const stories = flat.filter(n => n.kind === "story" || n.kind === "bug");
  const epics = useMemo(() => tree.filter(n => n.kind === "epic"), [tree]);
  const visions = useMemo(() => tree.filter(n => n.kind === "vision"), [tree]);

  if (preview) {
    return <PreviewPage project={project} epics={epics} visions={visions} onClose={() => setPreview(false)} />;
  }

  return (
    <div className="req-shell">
      <div className="req-tree-col">
        <div className="req-toolbar row">
          <input className="input" aria-label="搜索需求" placeholder="搜索编号或标题" value={query} onChange={e => setQuery(e.target.value)} />
          <span className="spacer" /><span className="small muted">{stories.length} 条 Story · {stories.filter(n => n.status === "已完成").length} 已完成</span>
          <button className="btn sm" onClick={() => void reload()}>刷新</button>
          <button className="btn sm" onClick={() => setPreview(true)}>预览</button>
          <button className="btn primary sm" onClick={() => addChild(null)}><Icon name="plus" size={14} /> 新建史诗</button>
        </div>
        <div className="req-tree" role="tree" aria-label="需求树">
          {roots.map(n => <TreeLine key={n.entityId} node={n} depth={0} onOpen={setDetail} onEdit={setEditTarget} onDelete={setDelTarget} onAddChild={addChild} onDispatch={setDispatchTarget} showChildren={!query.trim()} />)}
          {loading && <Empty title="加载中…" />}
          {!loading && roots.length === 0 && <Empty title={query.trim() ? "没有匹配的需求" : "暂无需求文档"} desc="从 Epic 开始拆解；正文保存于项目 docs/Plan。" />}
        </div>
      </div>

      {detail && <DocDetailModal project={project} node={detail} onClose={() => setDetail(null)} />}
      {editTarget && <DocEditModal project={project} node={editTarget} onClose={() => setEditTarget(null)} onSaved={() => { setEditTarget(null); void reload(); }} />}
      {createOpen && <CreateNodeModal project={project} parent={createParent} tree={tree} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); void reload(); }} />}
      {delTarget && <DeleteNodeModal project={project} node={delTarget} onClose={() => setDelTarget(null)} onDeleted={() => { setDelTarget(null); void reload(); }} />}
      {dispatchTarget && <DispatchModal node={dispatchTarget} onClose={() => setDispatchTarget(null)} />}
    </div>
  );
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

function flattenRequirements(nodes: RequirementNode[]): RequirementNode[] { return nodes.flatMap(n => [n, ...flattenRequirements(n.children)]); }

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

function DispatchModal({ node, onClose }: { node: RequirementNode; onClose: () => void }) {
  const stories = flattenRequirements([node]).filter(n => n.kind === "story" || n.kind === "bug");
  return <Modal title="派发预检" onClose={onClose} width={760} footer={<><button className="btn" onClick={onClose}>关闭</button><button className="btn primary" disabled>确认派发</button></>}>
    <div className="requirement-note">任务执行器与派发 API 尚未接入。仅列出当前范围，不创建 Run、不推进需求状态或伪造执行成功。</div>
    <h3>{node.entityId} · {node.title}</h3>
    {stories.map(n => <div key={n.entityId} className="dispatch-item"><span className="req-id">{n.entityId}</span><span className="grow">{n.title}</span>{statusTag(n.status)}</div>)}
    {!stories.length && <Empty title="范围内没有 Story" />}
  </Modal>;
}

function DocDetailModal(props: { project: api.Project; node: RequirementNode; onClose: () => void }) {
  const [html, setHtml] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.fsReadFile(props.project.rootUri, props.node.sourceUri).then(async md => {
      const result = await renderMarkdown(stripFrontMatter(md));
      if (alive) setHtml(result);
    }).catch(e => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [props.project.rootUri, props.node.sourceUri]);
  return <Modal title={`${props.node.entityId} ${props.node.title}`} onClose={props.onClose} width={620}>
    <div className="row">{statusTag(props.node.status)}<span className="small muted">负责人：{props.node.owner || "未分配"}</span></div>
    {error ? <Empty title="读取文档失败" desc={error} /> : html ? <div className="kb-content" dangerouslySetInnerHTML={{ __html: html }} /> : <Empty title="加载中…" />}
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

/* ============ 预览 ============ */

function PreviewPage(props: {
  project: api.Project;
  epics: RequirementNode[];
  visions: RequirementNode[];
  onClose: () => void;
}) {
  const [html, setHtml] = useState("");
  const [toc, setToc] = useState<{ level: number; text: string; id: string }[]>([]);
  useEffect(() => {
    (async () => {
      const parts: string[] = [];
      for (const v of props.visions) {
        const md = await api.readDoc(v.sourceUri).catch(() => "");
        parts.push(stripFrontMatter(md));
      }
      for (const e of props.epics) {
        const emd = await api.readDoc(e.sourceUri).catch(() => "");
        parts.push(`# ${e.entityId} ${e.title}\n\n` + stripH1(stripFrontMatter(emd)));
        for (const f of e.children) {
          const fmd = await api.readDoc(f.sourceUri).catch(() => "");
          parts.push(`## ${f.entityId} ${f.title}\n\n` + stripH1(stripFrontMatter(fmd)));
          for (const s of f.children) {
            const smd = await api.readDoc(s.sourceUri).catch(() => "");
            parts.push(`### ${s.entityId} ${s.title}\n\n` + stripH1(stripFrontMatter(smd)));
          }
        }
      }
      const md = parts.join("\n\n");
      setHtml(await renderMarkdown(md));
      setToc(extractToc(md));
    })();
  }, [props.epics, props.visions]);
  return (
    <div className="preview-shell">
      <div className="row" style={{ padding: "10px 16px", borderBottom: "1px solid var(--line)" }}>
        <button className="backlink" onClick={props.onClose}><Icon name="arrowLeft" size={14} /> 返回需求树</button>
        <strong>需求预览</strong>
      </div>
      <div className="preview-body">
        <div className="preview-doc kb-content" dangerouslySetInnerHTML={{ __html: html }} />
        <aside className="preview-toc">
          <div className="small muted" style={{ padding: "8px 12px" }}>目录</div>
          {toc.map((t, i) => (
            <div key={i} className="toc-line clickable ellipsis" style={{ paddingLeft: 12 + (t.level - 1) * 12 }}
              onClick={() => document.getElementById(t.id)?.scrollIntoView({ behavior: "smooth" })}>
              {t.text}
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}

function stripH1(md: string): string {
  return md.replace(/^#\s+.*\n/, "").trimStart();
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

function DesignPane({ project }: { project: api.Project }) {
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
  const [tocOpen, setTocOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const docRef = useRef<HTMLDivElement>(null);
  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const tree = await api.fsListTree(project.rootUri, 32);
      setFiles(tree.filter(f => !f.isDir && projectRelativePath(project.rootUri, f.path).startsWith("docs/")).sort((a, b) => a.path.localeCompare(b.path)));
    } catch (e) { setError(String(e)); } finally { setLoading(false); }
  }, [project.rootUri]);
  useEffect(() => { void reload(); }, [reload]);
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
  return <div className={`design-shell ${tocOpen ? "" : "toc-closed"}`}>
    <nav className="design-rail" aria-label="设计资料">
      {DESIGN_SECTIONS.map(item => <button key={item.key} className={`rail-btn ${section === item.key ? "active" : ""}`} aria-label={item.title} aria-pressed={section === item.key} title={item.title} onClick={() => setSection(item.key)}><WorkspaceIcon name={item.icon} /></button>)}
      <div className="rail-sep" /><button className="rail-btn" aria-label="关联需求" title="关联需求" onClick={() => setTocOpen(true)}><WorkspaceIcon name="link" /></button>
      <button className="rail-btn" aria-label={tocOpen ? "收起目录" : "展开目录"} title={tocOpen ? "收起目录" : "展开目录"} onClick={() => setTocOpen(!tocOpen)}><WorkspaceIcon name="panel" /></button>
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
    {tocOpen && <aside className="design-toc">
      <div className="design-toc-info"><b>文档信息</b>
        <div className="meta-row"><span>版本</span><b>{fm.version || "未登记"}</b></div>
        <div className="meta-row"><span>更新</span><b>{fm.updated || fm.updatedAt || "未登记"}</b></div>
        <div className="meta-row"><span>负责人</span><b>{fm.owner || "未登记"}</b></div>
        <div className="meta-row"><span>关联 Story</span><b>{[...new Set((draft?.text ?? "").match(/STORY-\d+/g) ?? [])].join("、") || "未登记"}</b></div>
        <button className="btn sm" disabled={loading} onClick={() => void reload()}>刷新资料目录</button><span className="small muted">同步设计依据未接入，不标记已同步。</span>
      </div>
      <div className="design-toc-list"><div className="small muted">本页目录</div>{toc.map((t, i) => <button key={i} className="toc-line" style={{ paddingLeft: 8 + (t.level - 1) * 12 }} onClick={() => docRef.current?.querySelector(`[id="${t.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>{t.text}</button>)}{!toc.length && <span className="small muted">无章节</span>}</div>
    </aside>}
  </div>;
}

function projectRelativePath(root: string, path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\/\/?\?\//, "");
  const base = root.replace(/\\/g, "/").replace(/^\/\/?\?\//, "").replace(/\/$/, "");
  return normalized.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? normalized.slice(base.length + 1) : normalized;
}

function TasksPane({ project, onRequirements }: { project: api.Project; onRequirements: () => void }) {
  return <div className="tasks-pane">
    <div className="task-stats">{["派发批次", "子任务", "执行中", "等待依赖", "已交付 / 待验收"].map(label => <div key={label}><span className="small muted">{label}</span><b>—</b></div>)}</div>
    <div className="task-body"><section className="task-list-pane"><div className="task-pane-head"><h3>派发树</h3><span className="small muted">{project.name} · 每次派发一棵</span></div>
      <div className="task-columns small muted"><span>任务 / 执行器</span><span>状态</span><span>耗时</span></div>
      <Empty title="该项目还没有可读取的运行" desc="任务与 runner API 尚未接入，不能派发、暂停、重试或验收；此处不展示虚构任务数据或成功状态。" action={<button className="btn primary" onClick={onRequirements}>查看需求</button>} />
    </section><aside className="task-detail-pane"><Empty title="未选择任务" desc="接入真实运行记录后，显示协调者、子任务、日志、产物与用量。" /></aside></div>
  </div>;
}

function WorkspaceIcon({ name }: { name: string }) {
  return <Icon name={name} size={18} />;
}

/* ============ 编码 ============ */

function CodePane({ project, visible }: { project: api.Project; visible: boolean }) {
  const [leftTab, setLeftTab] = useState<"file" | "git">("file");
  return <div className="code-shell">
    <nav className="code-rail" aria-label="编码管理">
      <button className={`rail-btn ${leftTab === "file" ? "active" : ""}`} aria-label="资源管理" title="资源管理" aria-pressed={leftTab === "file"} onClick={() => setLeftTab("file")}><WorkspaceIcon name="folder" /></button>
      <button className={`rail-btn ${leftTab === "git" ? "active" : ""}`} aria-label="Git 管理" title="Git 管理" aria-pressed={leftTab === "git"} onClick={() => setLeftTab("git")}><WorkspaceIcon name="git" /></button>
      <button className="rail-btn" aria-label="外部编辑器尚未接入" title="外部编辑器尚未接入" disabled><WorkspaceIcon name="external" /></button>
    </nav>
    <div className={`code-left ${leftTab === "git" ? "git-active" : ""}`}>
      <div className="code-git-panel" hidden={leftTab !== "git"}><GitPanel repoPath={project.rootUri} /></div>
      <CodeArea rootUri={project.rootUri} projectId={project.id} hideTree={leftTab === "git"} visible={visible} />
    </div>
  </div>;
}

export { ProjectHome };
