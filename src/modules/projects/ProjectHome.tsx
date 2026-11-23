import { Icon } from "@/components/icons";
import { ProjectIconTile, ICON_GROUPS, ICON_LABELS, ICON_COLORS } from "@/components/icon-tiles";
import { useCallback, useEffect, useState } from "react";
import * as api from "@/api";
import { useApp } from "@/store/app";
import { Confirm, Empty, Field, Modal, useToast } from "@/components/ui";
import "./projects.css";

export function ProjectHome() {
  const { openObject } = useApp();
  const toast = useToast();
  const [projects, setProjects] = useState<api.Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<api.Project | null>(null);
  const [delTarget, setDelTarget] = useState<api.Project | null>(null);
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

  useEffect(() => { void reload(); }, [reload]);
  /* CR-054 / AC-STORY-071-01：两类项目新建窗口打开时都默认进入「工作台」。 */
  const openProject = (p: api.Project) => openObject({ page: "project", projectId: p.id, tab: "workbench" });
  const q = keyword.trim().toLowerCase();
  const shown = projects.filter(p => (filter === "all" || p.kind === filter) && (!q || `${p.name} ${p.id} ${p.rootUri}`.toLowerCase().includes(q)));

  return (
    <div className="pagebody project-home">
      <div className="project-page-head">
        <div><h1>项目管理</h1><p className="small muted">点击卡片或「打开」进入项目；点击编辑修改项目信息。</p></div>
        <div className="row">
          <div className="segment" role="group" aria-label="项目分类">
            {(["all", "code", "work"] as const).map((kind, i) => <button key={kind} aria-pressed={filter === kind} onClick={() => setFilter(kind)}>{["全部", "编码", "办公"][i]}</button>)}
          </div>
          <button className="btn primary" onClick={() => setCreateOpen(true)}><Icon name="plus" /> 新建项目</button>
        </div>
      </div>
      <div className="project-toolbar row">
        <input className="input" aria-label="搜索项目" placeholder="搜索项目名称、编号或目录" value={keyword} onChange={e => setKeyword(e.target.value)} />
        <span className="spacer" /><span className="small muted">{shown.length} 个项目</span>
      </div>
      {loading ? <Empty title="加载中…" /> : error ? <Empty title="读取项目失败" desc={error} action={<button className="btn" onClick={() => void reload()}>重试</button>} /> : shown.length === 0 ? (
        <Empty title={projects.length ? "没有匹配的项目" : "还没有项目"} desc={projects.length ? "换一个关键词或切换类型。" : "选择本地目录，创建编码或办公项目。"} />
      ) : (
        <div className="proj-grid">
          {shown.map(p => <article key={p.id} className="card proj-card" tabIndex={0} aria-label={`打开项目 ${p.name}`}
            onClick={() => openProject(p)} onKeyDown={e => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openProject(p); } }}>
            <div className="proj-card-h">
              <ProjectIconTile project={p} size={36} />
              <div className="proj-card-t"><b className="ellipsis">{p.name}</b><span>{p.id} · {p.kind === "code" ? "编码" : "办公"}</span></div>
              <button className="btn icon ghost sm" aria-label={`编辑项目 ${p.name}`} title="编辑项目" onClick={e => { e.stopPropagation(); setEditTarget(p); }}>
                <Icon name="edit" />
              </button>
            </div>
            <p className="proj-card-desc mono" title={p.rootUri}>{p.rootUri}</p>
            <div className="proj-card-tags"><span className={`tag ${p.kind === "code" ? "blue" : "violet"}`}>{p.kind === "code" ? "编码项目" : "办公项目"}</span><span className="tag">本地目录</span></div>
            <div className="proj-card-progress small muted">需求进度、运行数与负责人暂未接入</div>
            <div className="proj-card-f">
              <span className="small muted">更新于 {new Date(p.updatedAt).toLocaleDateString()}</span>
              <button className="btn ghost sm" onClick={e => { e.stopPropagation(); setDelTarget(p); }}>删除</button>
              <button className="btn sm" onClick={e => { e.stopPropagation(); openProject(p); }}>打开</button>
            </div>
          </article>)}
        </div>
      )}
      {createOpen && <ProjectFormModal onClose={() => setCreateOpen(false)} onSaved={p => { setCreateOpen(false); void reload(); openProject(p); }} />}
      {editTarget && <ProjectFormModal project={editTarget} onClose={() => setEditTarget(null)} onSaved={() => { setEditTarget(null); void reload(); }} />}
      {delTarget && <Confirm title="删除项目" message={`确定删除项目「${delTarget.name}」？\n仅移除工作台内的项目记录与索引，不删除磁盘目录内容。`} danger onCancel={() => setDelTarget(null)} onOk={async () => {
        try { await api.deleteProject(delTarget.id); toast("已删除"); setDelTarget(null); void reload(); } catch (e) { toast(String(e), "err"); }
      }} />}
    </div>
  );
}

function ProjectFormModal({ project, onClose, onSaved }: { project?: api.Project; onClose: () => void; onSaved: (p: api.Project) => void }) {
  const toast = useToast();
  const [name, setName] = useState(project?.name ?? "");
  const [kind, setKind] = useState<"code" | "work">(project?.kind ?? "code");
  const [rootUri, setRootUri] = useState(project?.rootUri ?? "");
  // CR-051：图标与色卡草稿本地保存；取消/关闭不落库，保存才生效（null=清空回默认）。
  const [iconDraft, setIconDraft] = useState<string | null>(project?.icon ?? null);
  const [colorDraft, setColorDraft] = useState<string | null>(project?.iconColor ?? null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const pick = async () => {
    setPicking(true);
    try { const path = await api.pickProjectDirectory(); if (path) setRootUri(path); } catch (e) { toast(String(e), "err"); } finally { setPicking(false); }
  };
  const submit = async () => {
    if (!name.trim()) return toast("项目名称不能为空", "warn");
    if (!rootUri.trim()) return toast("必须选择项目目录", "warn");
    setBusy(true);
    try {
      const saved = project
        ? await api.updateProject(project.id, name.trim(), rootUri, iconDraft, colorDraft)
        : await api.createProject(name.trim(), kind, rootUri);
      toast(project ? "项目已保存" : "项目已创建");
      onSaved(saved);
      // 卡片、侧栏、授权弹窗三处同步：App 监听该事件统一刷新。
      window.dispatchEvent(new CustomEvent("app:projects-changed"));
    } catch (e) { toast(String(e), "err"); } finally { setBusy(false); }
  };
  return <Modal title={project ? "编辑项目" : "新建项目"} onClose={() => { if (!busy && !picking) onClose(); }} width={620}
    footer={<><button className="btn" disabled={busy || picking} onClick={onClose}>取消</button><button className="btn primary" disabled={busy || picking} onClick={submit}>{busy ? "保存中…" : project ? "保存" : "创建项目"}</button></>}>
    <div className="project-form-grid">
      <Field label="项目名称"><input className="input" value={name} onChange={e => setName(e.target.value)} disabled={busy} placeholder="例如：活动签到" /></Field>
      <div className="form-two">
        <Field label="项目标识"><input className="input" value={project?.id ?? "创建后自动生成"} readOnly /></Field>
        <Field label="类型"><select className="input" value={kind} disabled={!!project || busy} onChange={e => setKind(e.target.value as "code" | "work")}><option value="code">编码项目</option><option value="work">办公项目</option></select></Field>
      </div>
      {project && <Field label="图标与背景色" hint="项目与知识库共用 50 个图标；图标 + 背景色成对保存。清空回类型默认（编码 code + 蓝、办公 briefcase + 琥珀）。旧项目保持原显示，手动修改后才写入。">
        <div className="cr51-picker-groups" role="group" aria-label="项目图标选择">
          {ICON_GROUPS.map(group => <div key={group.name} className="cr51-picker-group">
            <div className="cr51-picker-group-h"><b>{group.name}</b><span>{group.hint} · {group.icons.length}</span></div>
            <div className="cr51-picker">
              {group.icons.map(id => <button key={id} type="button" className="cr51-picker-cell" aria-pressed={iconDraft === id}
                onClick={() => setIconDraft(id)} title={ICON_LABELS[id] ?? id}>
                <Icon name={id} size={20} /><span className="cr51-picker-name">{ICON_LABELS[id] ?? id}</span>
              </button>)}
            </div>
          </div>)}
          <button type="button" className="cr51-picker-cell cr51-picker-clear" aria-pressed={iconDraft === null}
            onClick={() => setIconDraft(null)} title="清空回类型默认">
            <Icon name="x" size={14} /><span className="cr51-picker-name">默认</span>
          </button>
        </div>
        <div className="cr51-swatches" role="group" aria-label="背景色卡（10 色，无文字）">
          {ICON_COLORS.map(sw => <button key={sw.id} type="button" className={`cr51-swatch cr51-color-${sw.id}`}
            aria-pressed={colorDraft === sw.id} aria-label={`背景色 ${sw.id}`} title=""
            onClick={() => setColorDraft(sw.id)} />)}
          <button type="button" className="cr51-swatch cr51-swatch-clear" aria-pressed={colorDraft === null}
            onClick={() => setColorDraft(null)} title="清空回默认色">
            <Icon name="x" size={12} />
          </button>
        </div>
        <div className="cr51-combo-preview">
          <span className={`cr51-tile cr51-color-${colorDraft ?? (project.kind === "work" ? "amber" : "blue")}`}>
            <Icon name={iconDraft ?? (project.kind === "work" ? "briefcase" : "code")} size={20} />
          </span>
          <span className="caption">组合预览：{ICON_LABELS[iconDraft ?? (project.kind === "work" ? "briefcase" : "code")] ?? "默认"} · {colorDraft ?? "默认色"}</span>
        </div>
      </Field>}
      <Field label="负责人"><input className="input" placeholder="未接入项目负责人存储" disabled /></Field>
      <Field label="项目描述"><textarea className="textarea" rows={3} placeholder="未接入项目描述存储" disabled /></Field>
      <Field label="本地目录" hint="从本机目录选择；取消选择后保留当前表单。">
        <div className="input-with-btn"><input className="input mono" value={rootUri} placeholder="尚未选择" readOnly /><button className="btn" type="button" disabled={busy || picking} onClick={pick}>{picking ? "选择中…" : "浏览…"}</button></div>
      </Field>
      <Field label="成员"><input className="input" placeholder="未接入项目成员存储" disabled /></Field>
    </div>
  </Modal>;
}
