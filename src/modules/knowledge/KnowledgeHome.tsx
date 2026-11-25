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
  // CR-072：编辑知识库信息（负责人/描述/名称）。
  const [metaTarget, setMetaTarget] = useState<KnowledgeLibrary | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
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
  // CR-072：项目名映射（授权标签展示）。
  useEffect(() => { api.listProjects().then(setProjects).catch(() => {}); }, []);

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
          <p className="muted small">本地多格式文件为原件；授权到项目后，AI 才能检索并读取有界片段。</p>
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
        <Empty title="还没有知识库" desc="新建后会在数据目录的 knowledge/名称 下建立明文文件夹。直接拷入文件，刷新目录即可使用。" action={<button className="btn primary" onClick={() => setCreateOpen(true)}>新建知识库</button>} />
      ) : (
        <div className="kb-cards kb-list">
          {libs.map((lib) => {
            const allowed = grants?.filter((g) => g.libraryId === lib.id && g.projectId && g.readAllowed) ?? [];
            const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
            return (
              <div key={lib.id} className="card kb-card kb-card-row">
                <IconPopoverTrigger title="选择知识库图标与颜色" onOpen={() => setIconTarget(lib)}>
                  <LibraryIconTile library={lib} />
                </IconPopoverTrigger>
                <div className="kb-main">
                  <div className="kb-card-title"><b className="ellipsis" title={lib.name}>{lib.name}</b><span className={`tag ${lib.enabled ? "good" : "bad"}`}>{lib.enabled ? "已启用" : "已停用"}</span></div>
                  <p className="kb-sub ellipsis" title={`${lib.description}${lib.owner ? " · " + lib.owner : ""}`}>{lib.description || "暂无描述"}{lib.owner ? ` · ${lib.owner}` : ""}</p>
                  <div className="kb-tags">
                    {grants ? (allowed.length ? allowed.map((g) => <span key={g.projectId} className="tag blue">{projectName(g.projectId as string)}</span>) : <span className="tag gray">未授权</span>) : <span className="tag">{grantError ? "授权状态未知" : "授权加载中…"}</span>}
                  </div>
                </div>
                <div className="kb-side">
                  <span className="kb-count">{lib.noteCount} 篇</span>
                  <span className="caption">索引版本 {lib.revision}</span>
                  <div className="kb-side-actions">
                    <button className="btn sm" onClick={() => setIconTarget(lib)} title="选择内置图标"><Icon name="palette" size={13} /> 图标</button>
                    <button className="btn sm" onClick={() => setGrantTarget(lib)}>{allowed.length ? "管理授权" : "授权"}</button>
                    <button className="btn sm" onClick={() => setMetaTarget(lib)}>编辑</button>
                    <button className="btn sm primary" onClick={() => openObject({ page: "knowledge-lib", libId: lib.id })}>进入</button>
                    <button className="btn ghost sm" disabled={scanningId !== null} onClick={() => void rescan(lib)}>{scanningId === lib.id ? "扫描中…" : "重新扫描"}</button>
                    <button className="btn ghost sm danger" onClick={() => setDelTarget(lib)}>删除</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="kb-page-foot"><span>检索为本地索引仿真，不调用模型嵌入；缺少授权记录默认拒绝。</span><span>{libs ? `${libs.length} 个库 · ${libs.reduce((n, l) => n + l.noteCount, 0)} 篇 Markdown` : "统计未知"}</span></div>
      {metaTarget && <MetaDialog library={metaTarget} onClose={() => setMetaTarget(null)} onSaved={() => { void reload(); }} />}
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


/** CR-072：编辑知识库名称/负责人/描述。 */
function MetaDialog({ library, onClose, onSaved }: { library: KnowledgeLibrary; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(library.name);
  const [owner, setOwner] = useState(library.owner ?? "");
  const [description, setDescription] = useState(library.description ?? "");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await api.kbUpdateMeta(library.id, { name: name.trim(), owner: owner.trim(), description: description.trim() });
      toast("知识库信息已保存");
      onSaved();
      onClose();
    } catch (e) { toast(String(e), "err"); } finally { setBusy(false); }
  };
  return (
    <div className="kb-dialog"><Modal title="编辑知识库信息" width={560} onClose={() => { if (!busy) onClose(); }}
      footer={<><button className="btn" disabled={busy} onClick={onClose}>取消</button><button className="btn primary" disabled={busy} onClick={() => void submit()}>{busy ? "保存中…" : "保存"}</button></>}>
      <div className="col">
        <Field label="名称"><input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} /></Field>
        <Field label="负责人"><input className="input" value={owner} onChange={(e) => setOwner(e.target.value)} disabled={busy} placeholder="例如：陈雨" /></Field>
        <Field label="描述"><textarea className="textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} placeholder="一句话说明知识库内容" /></Field>
      </div>
    </Modal></div>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {  const toast = useToast();  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [root, setRoot] = useState("");
  const busy = useRef(false);
  const canSave = name.trim().length > 0 && !saving;
  useEffect(() => { api.storageDataDir().then(location => setRoot(location.knowledgeRoot)).catch(() => setRoot("")); }, []);

  const submit = async () => {
    if (!canSave || busy.current) return;
    busy.current = true;
    setSaving(true);
    let id = createdId;
    try {
      id = id ?? await api.kbCreateLibrary(name.trim());
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
      <div className="col"><Field label="名称"><input className="input" value={name} disabled={saving || !!createdId} onChange={(e) => setName(e.target.value)} placeholder="例如：产品协作约定" autoFocus /></Field><p className="muted small">明文目录：{root || "数据目录/knowledge"}/{name.trim() || "名称"}。直接把文件拷进该文件夹，刷新目录即可使用，不必走上传。</p></div>
    </Modal></div>
  );
}
