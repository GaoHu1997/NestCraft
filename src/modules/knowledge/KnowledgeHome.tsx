import { Icon } from "@/components/icons";
import { LibraryIconTile, ProjectIconTile, IconPopover, IconPopoverTrigger } from "@/components/icon-tiles";
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "@/api";
import type { KnowledgeLibrary, LibraryGrant, Project } from "@/api";
import { Confirm, Empty, Field, Modal, useToast } from "@/components/ui";
import { useApp } from "@/store/app";
import "./knowledge.css";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** BUG-013 / UI-CR036-v4：库卡片与按库管理项目多选授权；权限仍由原 IPC 判定。 */
export function Home() {
  return <HomeView />;
}

function HomeView() {
  const { openObject } = useApp();
  const toast = useToast();
  const [libs, setLibs] = useState<KnowledgeLibrary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [grants, setGrants] = useState<LibraryGrant[] | null>(null);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [grantTarget, setGrantTarget] = useState<KnowledgeLibrary | null>(null);
  // CR-051：库图标选择弹窗目标。CR-070：改为卡片图标悬浮层。
  const [iconTarget, setIconTarget] = useState<KnowledgeLibrary | null>(null);
  const [delTarget, setDelTarget] = useState<KnowledgeLibrary | null>(null);
  const [scanningId, setScanningId] = useState<string | null>(null);
  const scanBusy = useRef(false);
  const loadSeq = useRef(0);

  const reloadGrants = useCallback(async () => {
    try {
      setGrants(await api.kbGrants());
      setGrantError(null);
    } catch (e) {
      setGrants(null);
      setGrantError(errText(e));
    }
  }, []);

  const reload = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const rows = await api.kbList();
      if (seq !== loadSeq.current) return;
      setLibs(rows);
      setLoadError(null);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setLoadError(errText(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    void reloadGrants();
    return () => { loadSeq.current += 1; };
  }, [reload, reloadGrants]);

  const rescan = async (lib?: KnowledgeLibrary) => {
    if (scanBusy.current || !libs) return;
    scanBusy.current = true;
    let failed = 0;
    for (const item of lib ? [lib] : libs) {
      setScanningId(item.id);
      try {
        const n = await api.kbScan(item.id);
        toast(`「${item.name}」已索引 ${n} 篇 Markdown`);
      } catch (e) {
        failed += 1;
        toast(`「${item.name}」扫描失败：${errText(e)}`, "err");
      }
    }
    scanBusy.current = false;
    setScanningId(null);
    void reload();
    if (failed) toast(`${failed} 个库扫描失败，原件未修改`, "warn");
  };

  const doDelete = async () => {
    const t = delTarget;
    if (!t) return;
    setDelTarget(null);
    try {
      await api.kbDelete(t.id);
      toast("知识库已删除，本地原件保留");
      void reload();
      void reloadGrants();
    } catch (e) {
      toast("删除失败：" + errText(e), "err");
    }
  };

  // CR-070：知识库图标悬浮层保存（成对写入；null=清空回来源默认/默认青绿）。
  const saveIcon = async (target: KnowledgeLibrary, icon: string | null, color: string | null) => {
    try {
      await api.kbSetAppearance(target.id, icon, color);
      toast("知识库图标已保存" + (icon ? `：${icon}` : "（回来源默认）"));
    } catch (e) {
      toast("保存失败：" + errText(e), "err");
    } finally {
      setIconTarget(null);
      void reload();
    }
  };

  return (
    <div className="kb-home">
      <div className="kb-head">
        <div className="grow">
          <h1>知识库</h1>
          <p className="muted small">本地文件为原件；授权到项目后，AI 才能检索与引用。当前索引仅支持 Markdown。</p>
        </div>
        <div className="row kb-page-actions">
          <button className="btn" disabled={!libs?.length || scanningId !== null} onClick={() => void rescan()}>
            {scanningId ? "索引中…" : "重新索引"}
          </button>
          <button className="btn primary" onClick={() => setCreateOpen(true)}>新建知识库</button>
        </div>
      </div>
      {loadError ? (
        <Empty title="知识库列表加载失败" desc={loadError} action={<button className="btn" onClick={() => void reload()}>重试</button>} />
      ) : libs === null ? (
        <div className="kb-cards" aria-label="知识库加载中">
          {[0, 1, 2].map((i) => <div key={i} className="card kb-card kb-skel-card"><div className="kb-skel" /><div className="kb-skel" /></div>)}
        </div>
      ) : libs.length === 0 ? (
        <Empty title="还没有知识库" desc="新建知识库并绑定包含 .md 文件的本地目录，扫描后即可阅读。" action={<button className="btn primary" onClick={() => setCreateOpen(true)}>新建知识库</button>} />
      ) : (
        <div className="kb-cards">
          {libs.map((lib) => {
            const allowed = grants?.filter((g) => g.libraryId === lib.id && g.projectId && g.readAllowed) ?? [];
            return (
              <div key={lib.id} className="card kb-card">
                <div className="row">
                  <IconPopoverTrigger title="选择知识库图标与颜色" onOpen={() => setIconTarget(lib)}>
                    <LibraryIconTile library={lib} />
                  </IconPopoverTrigger>
                  <h3 className="grow ellipsis" title={lib.name}>{lib.name}</h3>
                  <span className={`tag ${lib.enabled ? "good" : "bad"}`}>{lib.enabled ? "已启用" : "已停用"}</span>
                </div>
                <div className="kb-src mono ellipsis" title={lib.sourceRef}>{lib.sourceRef}</div>
                <div className="kb-tags"><span className={`tag ${allowed.length ? "blue" : ""}`}>{grants ? (allowed.length ? `${allowed.length} 个项目授权` : "未授权") : grantError ? "授权状态未知" : "授权加载中…"}</span></div>
                <div className="row kb-meta"><span>{lib.noteCount} 篇</span><span className="muted small">索引版本 {lib.revision}</span></div>
                <div className="row kb-actions">
                  <button className="btn sm" onClick={() => setIconTarget(lib)} title="选择内置图标"><Icon name="palette" size={13} /> 图标</button>
                  <button className="btn sm" onClick={() => setGrantTarget(lib)}>{allowed.length ? "管理授权" : "授权"}</button>
                  <button className="btn sm primary" onClick={() => openObject({ page: "knowledge-lib", libId: lib.id })}>进入</button>
                  <button className="btn sm" disabled={scanningId !== null} onClick={() => void rescan(lib)}>{scanningId === lib.id ? "扫描中…" : "重新扫描"}</button>
                  <button className="btn sm danger" onClick={() => setDelTarget(lib)}>删除</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="kb-page-foot"><span>缺少授权记录默认拒绝；索引不改写原件，不调用模型嵌入。</span><span>{libs ? `${libs.length} 个库 · ${libs.reduce((n, l) => n + l.noteCount, 0)} 篇 Markdown` : "统计未知"}</span></div>
      {createOpen && <CreateDialog onClose={() => setCreateOpen(false)} onCreated={() => { void reload(); void reloadGrants(); }} />}
      {iconTarget && <IconPopover open title={iconTarget.name} kind="kb"
        icon={iconTarget.icon} color={iconTarget.iconColor}
        onClose={() => setIconTarget(null)}
        onSave={(icon, color) => void saveIcon(iconTarget, icon, color)} />}
      {grantTarget && <GrantDialog library={grantTarget} onClose={() => setGrantTarget(null)} onSaved={() => void reloadGrants()} />}
      {delTarget && <div className="kb-dialog kb-confirm kb-dialog-fit"><Confirm title="删除知识库" message={`确定删除知识库「${delTarget.name}」？\n将移除该库及其索引记录；本地目录中的文件不受影响。`} onOk={() => void doDelete()} onCancel={() => setDelTarget(null)} danger /></div>}
    </div>
  );
}

/** 逐项目 IPC 不是事务：失败保留未保存勾选，仅将成功项推进到新基线。 */
export function GrantDialog({ library, onClose, onSaved, visible = true }: { library: KnowledgeLibrary; onClose: () => void; onSaved?: () => void; visible?: boolean }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [baseline, setBaseline] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const visibility = useRef(visible);
  visibility.current = visible;
  const loaded = useRef(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (!visibility.current) return;
    const seq = ++generation.current;
    setProjects(null);
    setError(null);
    try {
      const [ps, gs] = await Promise.all([api.listProjects(), api.kbGrants()]);
      if (generation.current !== seq) return;
      const granted = new Set(gs.filter((g) => g.libraryId === library.id && g.projectId && g.readAllowed).map((g) => g.projectId as string));
      loaded.current = true;
      setProjects(ps);
      setBaseline(granted);
      setSelected(new Set(granted));
    } catch (e) {
      if (generation.current === seq) setError("授权状态加载失败，未更改任何权限：" + errText(e));
    }
  }, [library.id]);
  useEffect(() => {
    loaded.current = false;
    return () => { generation.current += 1; };
  }, [library.id]);
  useEffect(() => { if (visible && !loaded.current) void load(); }, [load, visible]);

  const save = async () => {
    if (busy.current || !projects || !visibility.current) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    const seq = generation.current;
    const next = new Set(baseline);
    const failures: string[] = [];
    // 只处理本次列出的现有项目；不创建通配权限，不将缺失记录当授权。
    for (const p of projects) {
      const allowed = selected.has(p.id);
      if (allowed === baseline.has(p.id)) continue;
      try {
        await api.kbGrantSet(p.id, library.id, allowed);
        if (allowed) next.add(p.id); else next.delete(p.id);
      } catch (e) {
        failures.push(`${p.name}：${errText(e)}`);
      }
    }
    if (generation.current !== seq) return;
    setBaseline(next);
    setSaving(false);
    busy.current = false;
    onSaved?.();
    if (failures.length) setError("部分项目保存失败；成功项已生效，失败项保留勾选，可重试：\n" + failures.join("\n"));
    else onClose();
  };

  if (!visible) return null;
  return (
    <div className="kb-dialog kb-dialog-fit">
      <Modal title="授权知识库" width={620} onClose={() => { if (!busy.current) onClose(); }} footer={<><button className="btn" disabled={saving} onClick={onClose}>取消</button><button className="btn primary" disabled={saving || projects === null} onClick={() => void save()}>{saving ? "保存中…" : "保存授权"}</button></>}>
        <div className="kb-grant-box">
          <b>{library.name}</b>
          <p className="muted small">选择可以访问该知识库的项目，可多选。未选中的项目保持默认拒绝。</p>
          {projects === null ? (error ? <button className="btn" onClick={() => void load()}>重新加载授权</button> : <p className="muted small">授权状态加载中…</p>) : projects.length === 0 ? <Empty title="暂无项目" desc="先创建项目，再为其授权知识库。" /> : (
            <div className="kb-grant-list" role="group" aria-label="可授权的项目列表">
              {projects.map((p) => <label key={p.id} className="kb-grant-row"><input type="checkbox" checked={selected.has(p.id)} disabled={saving} onChange={(e) => { const checked = e.target.checked; setSelected((prev) => { const next = new Set(prev); if (checked) next.add(p.id); else next.delete(p.id); return next; }); }} /><ProjectIconTile project={p} size={26} /><span className="kb-grant-main"><b>{p.name}</b><span>{p.id} · {p.kind === "work" ? "办公" : "编码"}</span></span></label>)}
            </div>
          )}
          <div className="kb-grant-all"><div><b>所有项目开放</b><span className="muted small">暂不可用：当前接口不支持持久的全项目权限，新建项目不会自动获得访问权。</span></div><button className="switch" role="switch" aria-label="所有项目开放（当前接口不支持）" aria-checked={false} disabled /></div>
          <div className="kb-grant-note">授权仅用于只读检索与引用，不授予写入、命令执行或未授权目录访问；现有接口返回整篇 Markdown，尚无有界切片读取。</div>
          {error && <p className="kb-form-error" role="alert">{error}</p>}
        </div>
      </Modal>
    </div>
  );
}
/* CR-070：知识库图标选择改由卡片图标悬浮层（icon-tiles.tsx IconPopover）承接；
   旧 LibraryIconDialog 独立弹窗移除，保存语义不变（kbSetAppearance 成对写入）。 */


function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {  const toast = useToast();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const busy = useRef(false);
  const canSave = name.trim().length > 0 && path.trim().length > 0 && !saving;

  const submit = async () => {
    if (!canSave || busy.current) return;
    busy.current = true;
    setSaving(true);
    let id = createdId;
    try {
      id = id ?? await api.kbSave(name.trim(), path.trim());
      setCreatedId(id);
      onCreated();
      const n = await api.kbScan(id);
      toast(`知识库已创建，已索引 ${n} 篇 Markdown`);
      onCreated();
      onClose();
    } catch (e) {
      toast((id ? "知识库已创建，但扫描失败；重试不会重复创建：" : "创建失败：") + errText(e), "err");
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  return (
    <div className="kb-dialog"><Modal title="新建知识库" onClose={() => { if (!busy.current) onClose(); }} width={620} heightRatio={0.42} footer={<><button className="btn" disabled={saving} onClick={onClose}>取消</button><button className="btn primary" disabled={!canSave} onClick={() => void submit()}>{saving ? "扫描中…" : createdId ? "重试扫描" : "创建并扫描"}</button></>}>
      <div className="col"><Field label="名称"><input className="input" value={name} disabled={saving || !!createdId} onChange={(e) => setName(e.target.value)} placeholder="例如：产品协作约定" autoFocus /></Field><Field label="本地目录路径" hint="当前扫描仅索引 .md 文件；后端校验目录可访问性，不会复制或修改原件。"><input className="input mono" value={path} disabled={saving || !!createdId} onChange={(e) => setPath(e.target.value)} placeholder={"例如：D:\\notes\\docs"} /></Field></div>
    </Modal></div>
  );
}
