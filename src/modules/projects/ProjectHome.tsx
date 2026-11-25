import { Icon } from "@/components/icons";
import { ProjectIconTile, IconPopover, IconPopoverTrigger, anchorOf } from "@/components/icon-tiles";
import type { ProjectIconAnchor } from "@/components/icon-tiles";
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "@/api";
import { useApp } from "@/store/app";
import { Confirm, Empty, Field, Modal, useToast } from "@/components/ui";
import "./projects.css";

/** CR-072：负责人首字母圆（中文取首字，英文取首字母）。 */
function ownerInitial(owner: string): string {
  const t = owner.trim();
  return t ? t.slice(0, 1).toUpperCase() : "";
}

function splitTags(raw: string): string[] {
  return raw.split(/[，,、\s]+/).map(s => s.trim()).filter(Boolean);
}

export function ProjectHome() {
  const { openObject } = useApp();
  const toast = useToast();
  const [projects, setProjects] = useState<api.Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<api.Project | null>(null);
  const [delTarget, setDelTarget] = useState<api.Project | null>(null);
  // CR-070：卡片图标悬浮层目标；CR-073：记录锚点矩形，悬浮层就近定位并限高。
  const [iconTarget, setIconTarget] = useState<{ project: api.Project; anchor: ProjectIconAnchor | null } | null>(null);
  const [filter, setFilter] = useState<"all" | "code" | "work">("all");
  const [keyword, setKeyword] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProjects(await api.listProjects());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // CR-070：悬浮层保存（成对传入；null=清空回类型默认）。
  const saveIcon = useCallback(async (target: api.Project, icon: string | null, color: string | null) => {
    try {
      await api.updateProject(target.id, target.name, target.rootUri, icon, color);
      window.dispatchEvent(new CustomEvent("app:projects-changed"));
      setIconTarget(null);
      void reload();
    } catch (e) {
      toast(String(e), "err");
      setIconTarget(null);
    }
  }, [reload, toast]);

  useEffect(() => { void reload(); }, [reload]);
  /* CR-054 / AC-STORY-071-01：两类项目新建窗口打开时都默认进入「工作台」。 */
  const openProject = (p: api.Project) => openObject({ page: "project", projectId: p.id, tab: "workbench" });
  const q = keyword.trim().toLowerCase();
  // CR-072：搜索范围含名称/编号/负责人/描述/标签/目录。
  const shown = projects.filter(p => (filter === "all" || p.kind === filter) && (!q ||
    `${p.name} ${p.id} ${p.owner} ${p.description} ${p.tags.join(" ")} ${p.rootUri}`.toLowerCase().includes(q)));

  return (
    <div className="pagebody project-home">
      <div className="project-page-head">
        <div><h1>项目管理</h1><p className="small muted">双击卡片或点击「打开」进入项目；点击编辑修改项目信息。</p></div>
        <div className="row">
          <div className="segment" role="group" aria-label="项目分类">
            {(["all", "code", "work"] as const).map((kind, i) => <button key={kind} aria-pressed={filter === kind} onClick={() => setFilter(kind)}>{["全部", "编码", "办公"][i]}</button>)}
          </div>
          <button className="btn primary" onClick={() => setCreateOpen(true)}><Icon name="plus" /> 新建项目</button>
        </div>
      </div>
      <div className="project-toolbar row">
        <input className="input" aria-label="搜索项目" placeholder="搜索项目、负责人或标签" value={keyword} onChange={e => setKeyword(e.target.value)} />
        <span className="spacer" /><span className="small muted">{shown.length} 个项目</span>
      </div>
      {loading ? <Empty title="加载中…" /> : error ? <Empty title="读取项目失败" desc={error} action={<button className="btn" onClick={() => void reload()}>重试</button>} /> : shown.length === 0 ? (
        <Empty title={projects.length ? "没有匹配的项目" : "还没有项目"} desc={projects.length ? "换一个关键词或切换类型。" : "选择本地目录，创建编码或办公项目。"} />
      ) : (
        <div className="proj-grid">
          {shown.map(p => {
            const pct = p.storyTotal ? Math.round(p.storyDone / p.storyTotal * 100) : 0;
            return <article key={p.id} className="card proj-card" tabIndex={0} aria-label={`打开项目 ${p.name}`}
              onClick={() => openProject(p)}
              onDoubleClick={() => openProject(p)}
              onKeyDown={e => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openProject(p); } }}>
              <div className="proj-card-h">
                <IconPopoverTrigger title="选择项目图标与颜色" onOpen={() => setIconTarget({ project: p, anchor: anchorOf(document.querySelector(`[data-icon-trigger="${p.id}"]`)) })}>
                  <span data-icon-trigger={p.id}><ProjectIconTile project={p} size={36} /></span>
                </IconPopoverTrigger>
                <div className="proj-card-t"><b className="ellipsis">{p.name}</b><span>{p.id} · {p.kind === "code" ? "编码" : "办公"}</span></div>
                <button className="btn icon ghost sm" aria-label={`编辑项目 ${p.name}`} title="编辑项目" onClick={e => { e.stopPropagation(); setEditTarget(p); }}>
                  <Icon name="edit" />
                </button>
              </div>
              <p className={`proj-card-desc${p.description ? "" : " none"}`} title={p.description || p.rootUri}>{p.description || p.rootUri}</p>
              <div className="proj-card-tags">
                {p.tags.map(t => <span key={t} className="tag">{t}</span>)}
                {p.runningCount > 0 && <span className="tag blue">{p.runningCount} 个运行</span>}
              </div>
              <div className="proj-progress">
                <div className="proj-bar" aria-hidden><i style={{ width: `${pct}%` }} /></div>
                <span className="num">{p.storyDone}/{p.storyTotal}</span>
              </div>
              <div className="proj-card-f">
                <span className="proj-owner">{p.owner ? <><span className="av">{ownerInitial(p.owner)}</span><span className="caption">{p.owner}</span></> : <span className="caption">未分配负责人</span>}</span>
                <span className="caption">更新于 {new Date(p.updatedAt).toLocaleDateString()}</span>
                <button className="btn sm" onClick={e => { e.stopPropagation(); openProject(p); }}>打开</button>
              </div>
            </article>;
          })}
        </div>
      )}
      <div className="project-page-foot"><span>项目数据来自本机工作台，不读取目录内容</span><span>共 {projects.length} 个项目</span></div>
      {createOpen && <ProjectFormModal onClose={() => setCreateOpen(false)} onSaved={p => { setCreateOpen(false); void reload(); openProject(p); }} />}
      {editTarget && <ProjectFormModal project={editTarget} onClose={() => setEditTarget(null)} onSaved={() => { setEditTarget(null); void reload(); }} onRequestDelete={p => { setEditTarget(null); setDelTarget(p); }} onIconChanged={p => { setEditTarget(p); void reload(); }} />}
      {delTarget && <Confirm title="删除项目" message={`确定删除项目「${delTarget.name}」？\n仅移除工作台内的项目记录与索引，不删除磁盘目录内容。`} danger onCancel={() => setDelTarget(null)} onOk={async () => {
        try { await api.deleteProject(delTarget.id); toast("已删除"); setDelTarget(null); void reload(); } catch (e) { toast(String(e), "err"); }
      }} />}
      {iconTarget && <IconPopover open title={iconTarget.project.name} kind="project"
        icon={iconTarget.project.icon} color={iconTarget.project.iconColor} anchor={iconTarget.anchor}
        onClose={() => setIconTarget(null)}
        onSave={(icon, color) => void saveIcon(iconTarget.project, icon, color)} />}
    </div>
  );
}

function ProjectFormModal({ project, onClose, onSaved, onRequestDelete, onIconChanged }: {
  project?: api.Project;
  onClose: () => void;
  onSaved: (p: api.Project) => void;
  onRequestDelete?: (p: api.Project) => void;
  /** CR-073：弹窗内改图标后回传最新项目，父级刷新卡片与侧栏。 */
  onIconChanged?: (p: api.Project) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(project?.name ?? "");
  const [kind, setKind] = useState<"code" | "work">(project?.kind ?? "code");
  const [rootUri, setRootUri] = useState(project?.rootUri ?? "");
  const [owner, setOwner] = useState(project?.owner ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [tagsText, setTagsText] = useState((project?.tags ?? []).join("、"));
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  /* CR-073：弹窗内图标悬浮层——名称行图标砖为入口，保存后立即回显新图标。 */
  const [iconAnchor, setIconAnchor] = useState<ProjectIconAnchor | null>(null);
  const [liveIcon, setLiveIcon] = useState<{ icon: string | null; color: string | null } | null>(null);
  const tileRef = useRef<HTMLButtonElement>(null);
  const pick = async () => {
    setPicking(true);
    try { const path = await api.pickProjectDirectory(); if (path) setRootUri(path); } catch (e) { toast(String(e), "err"); } finally { setPicking(false); }
  };
  /** CR-073：图标砖保存（成对写入），成功后同步弹窗内与列表卡片。 */
  const saveDialogIcon = async (icon: string | null, color: string | null) => {
    if (!project) return;
    try {
      await api.updateProject(project.id, project.name, undefined, icon, color);
      setLiveIcon({ icon, color });
      setIconAnchor(null);
      window.dispatchEvent(new CustomEvent("app:projects-changed"));
      onIconChanged?.({ ...project, icon, iconColor: color });
      toast("图标已保存");
    } catch (e) {
      setIconAnchor(null);
      toast(String(e), "err");
    }
  };
  const shownProject: Pick<api.Project, "icon" | "kind" | "iconColor"> = liveIcon
    ? { icon: liveIcon.icon, iconColor: liveIcon.color, kind }
    : { icon: project?.icon ?? null, iconColor: project?.iconColor ?? null, kind };
  const submit = async () => {
    if (!name.trim()) return toast("项目名称不能为空", "warn");
    if (!rootUri.trim()) return toast("必须选择项目目录", "warn");
    setBusy(true);
    try {
      const tags = splitTags(tagsText);
      const saved = project
        ? await api.updateProject(project.id, name.trim(), rootUri, undefined, undefined, owner.trim(), description.trim(), tags)
        : await api.createProject(name.trim(), kind, rootUri, owner.trim(), description.trim(), tags);
      toast(project ? "项目已保存" : "项目已创建");
      onSaved(saved);
      // 卡片、侧栏、授权弹窗三处同步：App 监听该事件统一刷新。
      window.dispatchEvent(new CustomEvent("app:projects-changed"));
    } catch (e) { toast(String(e), "err"); } finally { setBusy(false); }
  };
  return <Modal title={project ? "编辑项目" : "新建项目"} onClose={() => { if (!busy && !picking) onClose(); }} width={620}
    footer={<>{project && onRequestDelete ? <button className="btn danger" disabled={busy || picking} onClick={() => onRequestDelete(project)}>删除项目</button> : null}<span className="grow" /><button className="btn" disabled={busy || picking} onClick={onClose}>取消</button><button className="btn primary" disabled={busy || picking} onClick={submit}>{busy ? "保存中…" : project ? "保存" : "创建项目"}</button></>}>
    <div className="project-form-grid">
      {/* CR-073：项目名称与图标砖同一行；图标砖可点击直接改（无成员字段）。 */}
      <Field label="项目名称">
        <div className="project-name-row">
          {project
            ? <button type="button" ref={tileRef} className="project-name-tile" title="点击修改图标与颜色" aria-label="点击修改项目图标与颜色"
                onClick={() => setIconAnchor(anchorOf(tileRef.current))}>
                <ProjectIconTile project={shownProject} size={36} />
              </button>
            : <span className="project-name-tile"><ProjectIconTile project={{ icon: null, iconColor: null, kind }} size={36} /></span>}
          <input className="input" value={name} onChange={e => setName(e.target.value)} disabled={busy} placeholder="例如：活动签到" />
          {!project && <span className="caption">创建后可修改图标</span>}
        </div>
      </Field>
      <div className="form-two">
        <Field label="项目标识"><input className="input" value={project?.id ?? "创建后自动生成"} readOnly /></Field>
        <Field label="类型"><select className="input" value={kind} disabled={!!project || busy} onChange={e => setKind(e.target.value as "code" | "work")}><option value="code">编码项目</option><option value="work">办公项目</option></select></Field>
      </div>
      <Field label="负责人"><input className="input" value={owner} onChange={e => setOwner(e.target.value)} disabled={busy} placeholder="填写负责人" /></Field>
      <Field label="项目描述"><textarea className="textarea" rows={3} value={description} onChange={e => setDescription(e.target.value)} disabled={busy} placeholder="一句话说明项目目标" /></Field>
      <Field label="项目标签" hint="用顿号或逗号分隔，例如：核心、基础设施、研究"><input className="input" value={tagsText} onChange={e => setTagsText(e.target.value)} disabled={busy} placeholder="核心、研究" /></Field>
      <Field label="本地目录" hint="从本机目录选择；取消选择后保留当前表单。">
        <div className="input-with-btn"><input className="input mono" value={rootUri} placeholder="尚未选择" readOnly /><button className="btn" type="button" disabled={busy || picking} onClick={pick}>{picking ? "选择中…" : "浏览…"}</button></div>
      </Field>
    </div>
    {iconAnchor && project && <IconPopover open title={project.name} kind="project"
      icon={liveIcon ? liveIcon.icon : project.icon} color={liveIcon ? liveIcon.color : project.iconColor}
      anchor={iconAnchor}
      host={tileRef.current?.closest("dialog") ?? null}
      onClose={() => setIconAnchor(null)}
      onSave={(icon, color) => void saveDialogIcon(icon, color)} />}
  </Modal>;
}
