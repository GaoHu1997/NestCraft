import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "@/api";
import type { SkillEntry } from "@/api";
import { Field, useToast } from "@/components/ui";
import { SKILL_NAME_RE, errMsg } from "./shared";
import { SettingsConfirm, SettingsDialog, SettingsIcon, SettingsSwitch } from "./SettingsDialog";

export function SettingsSkill() {
  const toast = useToast();
  const [list, setList] = useState<SkillEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"add" | "import" | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [fileName, setFileName] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [view, setView] = useState<{ name: string; content: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SkillEntry | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const lock = useRef(false);
  const fileRequest = useRef(0);
  useEffect(() => () => { fileRequest.current++; }, []);
  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try { setList(await api.skillList()); } catch (e) { setError(errMsg(e)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const notify = () => window.dispatchEvent(new CustomEvent("app:settings-changed", { detail: { keys: ["skills"] } }));
  const open = (next: "add" | "import") => { fileRequest.current++; setMode(next); setName(""); setDescription(""); setContent(""); setFileName(""); setFormError(""); setFileLoading(false); };
  const close = () => { fileRequest.current++; setMode(null); };
  const readFile = async (file: File | undefined) => {
    if (!file) return;
    const request = ++fileRequest.current;
    setFormError(""); setFileLoading(true);
    try {
      if (!/\.md$/i.test(file.name) || file.size > 2 * 1024 * 1024) throw new Error("请选择不超过 2 MB 的 Markdown 技能文件");
      const text = await file.text();
      if (request !== fileRequest.current) return;
      setContent(text); setFileName(file.name);
      const metadata = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] || text;
      const rawName = /^name:\s*(.+)$/m.exec(metadata)?.[1]?.trim().replace(/^["']|["']$/g, "");
      const rawDescription = /^description:\s*(.+)$/m.exec(metadata)?.[1]?.trim().replace(/^["']|["']$/g, "");
      if (rawName && SKILL_NAME_RE.test(rawName)) setName(rawName);
      if (rawDescription) setDescription(rawDescription);
    } catch (e) { if (request === fileRequest.current) setFormError(errMsg(e)); }
    finally { if (request === fileRequest.current) setFileLoading(false); }
  };
  const submit = async () => {
    if (lock.current || fileLoading) return;
    const slug = name.trim();
    if (!SKILL_NAME_RE.test(slug)) return setFormError("标识仅可使用小写字母、数字与中划线（如 release-check）");
    if (list.some(s => s.name === slug)) return setFormError("同名技能已存在");
    if (!description.trim() || !content.trim()) return setFormError("说明与技能正文不能为空");
    if (mode === "import" && !fileName) return setFormError("请先选择本机 Markdown 文件");
    lock.current = true; setSaving(true); setFormError("");
    try {
      await api.skillSave({ name: slug, description: description.trim(), content });
      notify(); close(); toast(mode === "import" ? "技能已导入" : "技能已添加"); await refresh();
    } catch (e) { setFormError(errMsg(e)); } finally { lock.current = false; setSaving(false); }
  };
  const toggle = async (s: SkillEntry, enabled: boolean) => {
    if (lock.current) return;
    lock.current = true; setPending(s.name);
    try { await api.skillSetEnabled(s.name, enabled); setList(prev => prev.map(x => x.name === s.name ? { ...x, enabled } : x)); notify(); }
    catch (e) { toast(errMsg(e), "err"); } finally { lock.current = false; setPending(null); }
  };
  const remove = async () => {
    if (!deleteTarget || lock.current) return;
    lock.current = true; setSaving(true);
    try { await api.skillDelete(deleteTarget.name); setList(prev => prev.filter(s => s.name !== deleteTarget.name)); setDeleteTarget(null); notify(); toast("技能已删除"); }
    catch (e) { toast(errMsg(e), "err"); } finally { lock.current = false; setSaving(false); }
  };
  return <>
    <div className="row set-toolbar"><span className="set-caption">{list.length} 个技能</span><span className="spacer" /><button className="btn sm" disabled={loading || !!error} onClick={() => open("import")}><SettingsIcon name="upload" />导入</button><button className="btn sm primary" disabled={loading || !!error} onClick={() => open("add")}><SettingsIcon name="plus" />添加技能</button></div>
    {loading && <p className="set-caption">加载技能中…</p>}
    {error && <div className="set-note" role="alert">技能读取失败：{error}<button className="btn sm" onClick={refresh}>重试</button></div>}
    <div className="set-cap-list">{list.map(s => <div className="set-cap-row" key={s.id}><span className="set-cap-icon blue"><SettingsIcon name="layers" /></span><button className="set-cap-main" aria-label={`查看技能 ${s.name}`} onClick={async () => { if (lock.current) return; lock.current = true; setPending(s.name); try { setView({ name: s.name, content: await api.skillRead(s.name) }); } catch (e) { toast(errMsg(e), "err"); } finally { lock.current = false; setPending(null); } }}><b>{s.name} <span className="mono set-caption">/{s.name}</span>{s.builtin && <span className="tag">内置</span>}</b><span>{s.description || "暂无说明"} · 来源 {s.builtin ? "内置" : "本机"}</span></button><SettingsSwitch checked={s.enabled} disabled={pending != null} label={`启用技能 ${s.name}`} onChange={v => toggle(s, v)} /><button className="set-icon-btn set-cap-delete" aria-label={`删除技能 ${s.name}`} disabled={s.builtin || pending != null} title={s.builtin ? "内置技能不可删除" : "删除技能"} onClick={() => setDeleteTarget(s)}><SettingsIcon name="trash" /></button></div>)}{!loading && !error && !list.length && <div className="set-empty">尚无技能</div>}</div>
    {mode && <SettingsDialog title={mode === "import" ? "导入技能" : "添加技能"} subtitle="保存到本机技能列表；启用不等于授权执行" busy={saving} onClose={close} footer={<><button className="btn" disabled={saving} onClick={close}>取消</button><button className="btn primary" disabled={saving || fileLoading} onClick={submit}>{saving ? "保存中…" : mode === "import" ? "导入" : "添加"}</button></>}>
      <fieldset className="set-fieldset" disabled={saving}><div className="col"><Field label="技能名称" hint="独立显示名称尚无接口字段，当前沿用标识。"><input className="input" value={name} aria-label="技能名称" disabled /></Field><Field label="标识（slug）"><input className="input" value={name} aria-label="技能标识" placeholder="release-check" onChange={e => setName(e.target.value)} /></Field><Field label="说明"><input className="input" value={description} aria-label="技能说明" onChange={e => setDescription(e.target.value)} /></Field>
        {mode === "import" && <Field label="来源" hint="只读用户选中的文件；不会执行其中指令。"><input className="input" type="file" accept=".md,text/markdown" aria-label="选择技能文件" disabled={fileLoading} onChange={e => { readFile(e.target.files?.[0]); e.target.value = ""; }} />{fileName && <span className="set-caption">{fileName}</span>}</Field>}
        <Field label={mode === "import" ? "导入正文预览" : "正文"} hint={mode === "import" ? "原正文保留为技能内容；现有保存接口会包装名称与说明，非逐字节原格式导入。" : "Markdown 过程性指令"}><textarea className="textarea mono" rows={8} aria-label="技能正文" value={content} onChange={e => setContent(e.target.value)} /></Field>
        {fileLoading && <p className="set-caption">正在读取所选文件…</p>}{formError && <p className="set-err" role="alert">{formError}</p>}
      </div></fieldset>
    </SettingsDialog>}
    {view && <SettingsDialog title={`技能原文：${view.name}`} onClose={() => setView(null)} width={620}><pre className="set-pre">{view.content}</pre></SettingsDialog>}
    {deleteTarget && <SettingsConfirm title="删除技能" message={`确定删除「${deleteTarget.name}」？其本机技能文件将被移除。`} busy={saving} onCancel={() => setDeleteTarget(null)} onOk={remove} />}
  </>;
}
