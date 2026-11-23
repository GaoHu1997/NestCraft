import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "@/api";
import type { SkillEntry, SkillFolderPreview, SkillScanGroup } from "@/api";
import { Field, useToast } from "@/components/ui";
import { SKILL_NAME_RE, errMsg } from "./shared";
import { SettingsConfirm, SettingsDialog, SettingsIcon, SettingsSwitch } from "./SettingsDialog";

/**
 * CR-059 F1～F3：Skill 管理。
 *
 * - 「添加技能」＝选择本地文件夹 → 识别 SKILL.md → 整目录复制为受管副本（app_data_dir/skills/<slug>/）；
 * - 「导入」＝只读扫描其他 agent 的技能目录，勾选后同样复制为受管副本；
 * - 副本独立于外部源：外部删除或修改不影响；
 * - 扫描只读目录与 SKILL.md，不执行其中任何指令。
 */

type Mode = "folder" | "scan" | "manual" | null;

export function SettingsSkill() {
  const toast = useToast();
  const [list, setList] = useState<SkillEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<{ name: string; content: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SkillEntry | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const lock = useRef(false);

  // 文件夹模式
  const [folderPath, setFolderPath] = useState("");
  const [folderPreview, setFolderPreview] = useState<SkillFolderPreview | null>(null);
  const [folderError, setFolderError] = useState("");
  const [folderBusy, setFolderBusy] = useState(false);
  const [slugDraft, setSlugDraft] = useState("");

  // 扫描模式
  const [scanGroups, setScanGroups] = useState<SkillScanGroup[]>([]);
  const [scanSelected, setScanSelected] = useState<Record<string, boolean>>({});
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState("");

  // 手动模式（保持既有能力：直接写 SKILL.md 正文）
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [formError, setFormError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try { setList(await api.skillList()); } catch (e) { setError(errMsg(e)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const notify = () => window.dispatchEvent(new CustomEvent("app:settings-changed", { detail: { keys: ["skills"] } }));

  const resetDialogs = () => {
    setFolderPath(""); setFolderPreview(null); setFolderError(""); setFolderBusy(false); setSlugDraft("");
    setScanGroups([]); setScanSelected({}); setScanError(""); setScanLoading(false);
    setName(""); setDescription(""); setContent(""); setFormError("");
  };
  const open = (next: Mode) => { resetDialogs(); setMode(next); if (next === "scan") void loadScan(); };
  const close = () => { if (!busy) { setMode(null); resetDialogs(); } };

  const loadScan = async () => {
    setScanLoading(true); setScanError("");
    try {
      const groups = await api.skillScanSources();
      setScanGroups(groups);
    } catch (e) { setScanError(errMsg(e)); }
    finally { setScanLoading(false); }
  };

  /** 系统目录选择：复用既有原生目录选择器，不新建第二套对话框。 */
  const pickFolder = async () => {
    setFolderError("");
    try {
      const picked = await api.pickProjectDirectory();
      if (!picked) return;
      setFolderBusy(true);
      const preview = await api.skillFolderPreview(picked);
      setFolderPath(picked);
      setFolderPreview(preview);
      setSlugDraft(preview.slug);
      if (!preview.valid) setFolderError("所选文件夹没有 SKILL.md，无法识别为技能。结构应为 <文件夹>/SKILL.md（可含附属资源）。");
    } catch (e) { setFolderError(errMsg(e)); }
    finally { setFolderBusy(false); }
  };

  const importFolder = async () => {
    if (lock.current || !folderPreview?.valid) return;
    if (!SKILL_NAME_RE.test(slugDraft.trim())) return setFolderError("标识仅可使用小写字母、数字与中划线（如 release-check）");
    if (list.some(s => s.name === slugDraft.trim())) return setFolderError("同名技能已存在");
    lock.current = true; setBusy(true); setFolderError("");
    try {
      const result = await api.skillImportFolder(folderPath, slugDraft.trim());
      const skipped = result.skipped.length ? `；跳过 ${result.skipped.length} 项（${result.skipped.slice(0, 3).join("、")}${result.skipped.length > 3 ? "…" : ""}）` : "";
      toast(`已添加技能 ${result.slug}（复制 ${result.copied} 个文件${skipped}）`);
      notify(); await refresh(); close();
    } catch (e) { setFolderError(errMsg(e)); } finally { lock.current = false; setBusy(false); }
  };

  const importSelected = async () => {
    if (lock.current) return;
    const items = scanGroups.flatMap(group => group.items
      .filter(item => !item.imported && !item.error && scanSelected[`${item.agent}:${item.source}`])
      .map(item => ({ agent: item.agent, source: item.source, slug: item.slug, name: item.name })));
    if (!items.length) return setScanError("请先勾选要导入的技能");
    lock.current = true; setBusy(true); setScanError("");
    let ok = 0; const failures: string[] = [];
    try {
      for (const item of items) {
        try { await api.skillImportFolder(item.source, item.slug); ok += 1; }
        catch (e) { failures.push(`${item.name}：${errMsg(e)}`); }
      }
      if (ok) { toast(`已导入 ${ok} 个技能${failures.length ? `，${failures.length} 个失败` : ""}`); notify(); await refresh(); }
      if (failures.length) setScanError(failures.join("；"));
      if (ok && !failures.length) close();
      else await loadScan();
    } finally { lock.current = false; setBusy(false); }
  };

  const submitManual = async () => {
    if (lock.current) return;
    const slug = name.trim();
    if (!SKILL_NAME_RE.test(slug)) return setFormError("标识仅可使用小写字母、数字与中划线（如 release-check）");
    if (list.some(s => s.name === slug)) return setFormError("同名技能已存在");
    if (!description.trim() || !content.trim()) return setFormError("说明与正文不能为空");
    lock.current = true; setBusy(true); setFormError("");
    try {
      await api.skillSave({ name: slug, description: description.trim(), content });
      notify(); close(); toast("技能已添加"); await refresh();
    } catch (e) { setFormError(errMsg(e)); } finally { lock.current = false; setBusy(false); }
  };

  const toggle = async (skill: SkillEntry, enabled: boolean) => {
    if (lock.current) return;
    lock.current = true; setPending(skill.name);
    try { await api.skillSetEnabled(skill.name, enabled); setList(previous => previous.map(x => x.name === skill.name ? { ...x, enabled } : x)); notify(); }
    catch (e) { toast(errMsg(e), "err"); } finally { lock.current = false; setPending(null); }
  };
  const remove = async () => {
    if (!deleteTarget || lock.current) return;
    lock.current = true; setBusy(true);
    try { await api.skillDelete(deleteTarget.name); setList(previous => previous.filter(s => s.name !== deleteTarget.name)); setDeleteTarget(null); notify(); toast("技能已删除"); }
    catch (e) { toast(errMsg(e), "err"); } finally { lock.current = false; setBusy(false); }
  };

  const selectableCount = scanGroups.reduce((total, group) =>
    total + group.items.filter(item => !item.imported && !item.error).length, 0);

  return <>
    <div className="row set-toolbar">
      <span className="set-caption">{list.length} 个技能 · 导入后为受管副本，外部删除不影响</span>
      <span className="spacer" />
      <button className="btn sm" disabled={loading || !!error} onClick={() => open("scan")}>
        <SettingsIcon name="search" />扫描导入
      </button>
      <button className="btn sm primary" disabled={loading || !!error} onClick={() => open("folder")}>
        <SettingsIcon name="folderPlus" />添加技能
      </button>
    </div>
    {loading && <p className="set-caption">加载技能中…</p>}
    {error && <div className="set-note" role="alert">技能读取失败：{error}<button className="btn sm" onClick={refresh}>重试</button></div>}
    <div className="set-cap-list">{list.map(skill => <div className="set-cap-row" key={skill.id}>
      <span className="set-cap-icon blue"><SettingsIcon name="layers" /></span>
      <button className="set-cap-main" aria-label={`查看技能 ${skill.name}`} onClick={async () => {
        if (lock.current) return;
        lock.current = true; setPending(skill.name);
        try { setView({ name: skill.name, content: await api.skillRead(skill.name) }); }
        catch (e) { toast(errMsg(e), "err"); }
        finally { lock.current = false; setPending(null); }
      }}>
        <b>{skill.name} <span className="mono set-caption">/{skill.name}</span>{skill.builtin && <span className="tag">内置</span>}</b>
        <span>{skill.description || "暂无说明"} · 来源 {skill.builtin ? "内置" : "受管副本"}</span>
      </button>
      <SettingsSwitch checked={skill.enabled} disabled={pending != null} label={`启用技能 ${skill.name}`} onChange={value => toggle(skill, value)} />
      <button className="set-icon-btn set-cap-delete" aria-label={`删除技能 ${skill.name}`} disabled={skill.builtin || pending != null}
        title={skill.builtin ? "内置技能不可删除" : "删除技能"} onClick={() => setDeleteTarget(skill)}><SettingsIcon name="trash" /></button>
    </div>)}{!loading && !error && !list.length && <div className="set-empty">尚无技能</div>}</div>

    {/* F1：文件夹添加 */}
    {mode === "folder" && <SettingsDialog title="添加技能" subtitle="选择本地文件夹 → 识别 SKILL.md → 复制为受管副本"
      busy={busy} onClose={close}
      footer={<>
        <button className="btn" disabled={busy} onClick={() => { setMode("manual"); setFormError(""); }}>手动填写</button>
        <button className="btn" disabled={busy} onClick={close}>取消</button>
        <button className="btn primary" disabled={busy || !folderPreview?.valid} onClick={importFolder}>
          {busy ? "复制中…" : "添加到我的技能"}
        </button>
      </>}>
      <fieldset className="set-fieldset" disabled={busy}>
        <Field label="技能文件夹" hint="必须包含 SKILL.md；整目录复制到应用数据目录 skills/<slug>/。">
          <div className="row">
            <button type="button" className="btn sm" disabled={folderBusy} onClick={() => void pickFolder()}>
              <SettingsIcon name="folderOpen" />选择文件夹…
            </button>
            <span className="mono set-caption ellipsis" title={folderPath}>{folderPath || "未选择"}</span>
          </div>
          {folderBusy && <p className="set-caption">正在识别所选文件夹…</p>}
        </Field>
        {folderPreview?.valid && <>
          <Field label="识别结果"><input className="input" value={folderPreview.name} readOnly aria-label="识别到的技能名称" /></Field>
          <Field label="标识（slug）" hint="作为受管目录名，重复会被拒绝。">
            <input className="input mono" value={slugDraft} aria-label="技能标识" onChange={e => setSlugDraft(e.target.value)} />
          </Field>
          <Field label="说明"><input className="input" value={folderPreview.description} readOnly aria-label="识别到的说明" /></Field>
          <Field label="正文预览（SKILL.md）" hint="原样复制，不修改内容。">
            <textarea className="textarea mono" rows={6} value={folderPreview.body} readOnly aria-label="技能正文预览" />
          </Field>
        </>}
        {folderError && <p className="set-err" role="alert">{folderError}</p>}
      </fieldset>
    </SettingsDialog>}

    {/* F2：跨 agent 扫描导入 */}
    {mode === "scan" && <SettingsDialog title="扫描导入技能" subtitle="扫描本机其他 agent 的技能目录 → 勾选 → 复制为受管副本"
      busy={busy} width={640} onClose={close}
      footer={<>
        <button className="btn" disabled={busy} onClick={close}>取消</button>
        <button className="btn primary" disabled={busy || loading} onClick={importSelected}>
          {busy ? "导入中…" : "导入所选"}
        </button>
      </>}>
      <fieldset className="set-fieldset" disabled={busy}>
        {scanLoading && <p className="set-caption">正在扫描…</p>}
        {scanError && <p className="set-err" role="alert">{scanError}</p>}
        {!scanLoading && scanGroups.map(group => <div className="scan-group" key={group.agent}>
          <div className="scan-group-h">
            <SettingsIcon name="bot" />
            <b>{group.agent}</b>
            <span className="mono set-caption ellipsis" title={group.root}>{group.root}</span>
            {!group.exists && <span className="tag">未安装</span>}
          </div>
          {group.exists && !group.items.length && <p className="set-caption">该目录下没有可导入的技能</p>}
          {group.items.map(item => {
            const key = `${item.agent}:${item.source}`;
            const disabled = item.imported || !!item.error;
            return <label className={`scan-row ${disabled ? "imported" : ""}`} key={key}>
              <input type="checkbox" checked={!!scanSelected[key]} disabled={disabled || busy}
                aria-label={`选择技能 ${item.name}`}
                onChange={e => setScanSelected(previous => ({ ...previous, [key]: e.target.checked }))} />
              <span className="scan-main">
                <b>{item.name} <span className="mono set-caption">/{item.slug}</span></b>
                <span>{item.error || item.description || "暂无说明"}</span>
              </span>
              {item.imported && <span className="tag">已导入</span>}
              {item.error && <span className="tag bad">不可用</span>}
            </label>;
          })}
        </div>)}
        {!scanLoading && !scanError && !selectableCount && <p className="set-caption">没有可导入的技能；也可以使用「添加技能」从本地文件夹导入。</p>}
        <p className="set-caption">只读扫描其他 agent 的技能目录与 SKILL.md，不执行其中指令，不读取任何凭据。</p>
      </fieldset>
    </SettingsDialog>}

    {/* 手动填写（既有能力保留） */}
    {mode === "manual" && <SettingsDialog title="手动添加技能" subtitle="直接写入受管技能的 SKILL.md；启用不等于授权执行"
      busy={busy} onClose={close}
      footer={<>
        <button className="btn" disabled={busy} onClick={close}>取消</button>
        <button className="btn primary" disabled={busy} onClick={submitManual}>{busy ? "保存中…" : "添加"}</button>
      </>}>
      <fieldset className="set-fieldset" disabled={busy}>
        <Field label="标识（slug）"><input className="input mono" value={name} aria-label="技能标识" placeholder="release-check" onChange={e => setName(e.target.value)} /></Field>
        <Field label="说明"><input className="input" value={description} aria-label="技能说明" onChange={e => setDescription(e.target.value)} /></Field>
        <Field label="正文" hint="Markdown 过程性指令"><textarea className="textarea mono" rows={8} aria-label="技能正文" value={content} onChange={e => setContent(e.target.value)} /></Field>
        {formError && <p className="set-err" role="alert">{formError}</p>}
      </fieldset>
    </SettingsDialog>}

    {view && <SettingsDialog title={`技能原文：${view.name}`} onClose={() => setView(null)} width={620}><pre className="set-pre">{view.content}</pre></SettingsDialog>}
    {deleteTarget && <SettingsConfirm title="删除技能" message={`确定删除「${deleteTarget.name}」？其受管技能目录将被移除。`}
      busy={busy} onCancel={() => setDeleteTarget(null)} onOk={remove} />}
  </>;
}
