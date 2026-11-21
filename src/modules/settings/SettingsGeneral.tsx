import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { getAvatarStyle, getSetting, setAvatarStyle, setSetting } from "@/api";
import * as api from "@/api";
import { useToast } from "@/components/ui";
import { UserAvatar, AVATAR_STYLE_IDS, AVATAR_STYLE_LABELS, normalizeAvatarStyle, type AvatarStyleId } from "@/components/icon-tiles";
import { AvatarField } from "@/components/avatar";
import { useApp } from "@/store/app";
import { errMsg } from "./shared";
import { SettingsSwitch } from "./SettingsDialog";

type General = {
  name: string; email: string; role: string; timezone: string;
  codeTheme: string; fontSize: string; tabSize: string; wrap: boolean;
  port: string; defaultUser: string; auth: string; confirmDanger: boolean; sendMode: string;
  /** CR-051：头像风格（a–e，缺省 b）。 */
  avatarStyle: string;
};
const DEFAULTS: General = { name: "", email: "", role: "", timezone: "Asia/Shanghai", codeTheme: "system", fontSize: "13", tabSize: "2", wrap: true, port: "22", defaultUser: "", auth: "key", confirmDanger: true, sendMode: "queue", avatarStyle: "b" };
const KEYS: Record<Exclude<keyof General, "avatarStyle" | "wrap" | "confirmDanger">, string> = {
  name: "user.name", email: "user.email", role: "user.role", timezone: "user.timezone", codeTheme: "editor.theme", fontSize: "editor.fontSize", tabSize: "editor.tabSize",
  port: "server.port", defaultUser: "server.defaultUser", auth: "server.auth", sendMode: "chat.sendMode",
};
function Row({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return <div className="set-field"><div className="set-field-label"><b>{label}</b><span>{hint}</span></div><div className="set-field-control">{children}</div></div>;
}

export function SettingsGeneral() {
  const toast = useToast();
  const { theme } = useApp();
  const [form, setForm] = useState<General>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // CR-051 r6：自定义头像（本机引用）；空=品牌 Logo。
  const [avatarPhoto, setAvatarPhoto] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError("");
    Promise.all([
      ...Object.entries(KEYS).map(async ([field, key]) => [field, await getSetting(key)] as const),
      getAvatarStyle().then(style => ["avatarStyle", style] as const).catch(() => ["avatarStyle", "b"] as const),
    ]).then(values => {
      if (!alive) return;
      const next = { ...DEFAULTS };
      for (const [field, value] of values) {
        if (value == null) continue;
        if (field === "wrap" || field === "confirmDanger") next[field] = value === "true";
        else if (field === "avatarStyle") next.avatarStyle = normalizeAvatarStyle(value as string);
        else next[field as Exclude<keyof General, "wrap" | "confirmDanger" | "avatarStyle">] = value as string;
      }
      setForm(next);
      api.getAvatarImage().then(img => { if (alive) setAvatarPhoto(api.avatarPhotoSrc(img?.path)); }).catch(() => {});
    }).catch(e => { if (alive) setError(errMsg(e)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [attempt]);
  const update = (patch: Partial<General>) => setForm(f => ({ ...f, ...patch }));
  const save = async () => {
    if (saving || loading || error) return;
    const fontSize = Number(form.fontSize), tabSize = Number(form.tabSize), port = Number(form.port);
    if (!Number.isInteger(fontSize) || fontSize < 12 || fontSize > 16) return toast("字号需为 12–16 的整数", "warn");
    if (![2, 4].includes(tabSize)) return toast("Tab 宽度需为 2 或 4", "warn");
    if (!Number.isInteger(port) || port < 1 || port > 65535) return toast("端口需为 1–65535 的整数", "warn");
    if (!["system", "light", "dark"].includes(form.codeTheme) || !["queue", "immediate"].includes(form.sendMode) || !["key", "password", "jump"].includes(form.auth)) return toast("请检查主题、认证及发送行为选项", "warn");
    const normalized = { ...form, confirmDanger: true, name: form.name.trim(), email: form.email.trim(), role: form.role.trim(), defaultUser: form.defaultUser.trim(), fontSize: String(fontSize), tabSize: String(tabSize), port: String(port), avatarStyle: normalizeAvatarStyle(form.avatarStyle) };
    setSaving(true);
    try {
      for (const [field, key] of Object.entries(KEYS)) await setSetting(key, String(normalized[field as keyof typeof KEYS]));
      await setAvatarStyle(normalized.avatarStyle);
      await setSetting("settings.general", JSON.stringify(normalized));
      setForm(normalized);
      window.dispatchEvent(new CustomEvent("app:settings-changed", { detail: { keys: [...Object.values(KEYS), "ui.avatarStyle", "settings.general"], profile: { name: normalized.name, email: normalized.email, role: normalized.role, timezone: normalized.timezone }, general: normalized, avatarStyle: normalized.avatarStyle } }));
      toast("设置已保存；未接入的执行选项仍只作为偏好记录");
    } catch (e) { toast(`保存未全部完成，请重试：${errMsg(e)}`, "err"); } finally { setSaving(false); }
  };
  if (loading) return <p className="set-caption">加载设置中…</p>;
  if (error) return <div className="set-note" role="alert">读取设置失败：{error}<button className="btn sm" onClick={() => setAttempt(n => n + 1)}>重试</button></div>;
  const dark = form.codeTheme === "dark" || (form.codeTheme === "system" && theme === "dark");
  return <fieldset className="set-fieldset" disabled={saving}>
    <section className="set-section"><h3>用户基本信息</h3>
      <Row label="显示名称" hint="用于账户显示"><input className="input" aria-label="显示名称" value={form.name} onChange={e => update({ name: e.target.value })} /></Row>
      <Row label="邮箱" hint="仅保存信息，不发送邮件"><input className="input" type="email" aria-label="邮箱" value={form.email} onChange={e => update({ email: e.target.value })} /></Row>
      <Row label="角色" hint="账户显示信息，不授予权限"><input className="input" aria-label="角色" value={form.role} onChange={e => update({ role: e.target.value })} /></Row>
      <Row label="时区" hint="保存为时间显示偏好"><select className="select" aria-label="时区" value={form.timezone} onChange={e => update({ timezone: e.target.value })}>{!["Asia/Shanghai", "UTC"].includes(form.timezone) && <option>{form.timezone}</option>}<option>Asia/Shanghai</option><option>UTC</option></select></Row>
    </section>
    <section className="set-section"><h3>代码样式</h3>
      <Row label="编辑器主题" hint="下方预览即时更新"><div className="set-seg">{[["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]].map(([value, text]) => <button key={value} type="button" aria-pressed={form.codeTheme === value} onClick={() => update({ codeTheme: value })}>{text}</button>)}</div></Row>
      <Row label="字号 / Tab" hint="12–16px，2/4 空格"><div className="row"><input className="input set-num" type="number" min={12} max={16} aria-label="编辑器字号" value={form.fontSize} onChange={e => update({ fontSize: e.target.value })} /><select className="select set-tabsize" aria-label="Tab 宽度" value={form.tabSize} onChange={e => update({ tabSize: e.target.value })}>{!["2", "4"].includes(form.tabSize) && <option>{form.tabSize}</option>}<option>2</option><option>4</option></select><SettingsSwitch checked={form.wrap} onChange={wrap => update({ wrap })} label="自动换行" /></div></Row>
      <Row label="预览" hint="仅此预览即时消费全部配置"><pre className={`set-code-preview ${dark ? "dark" : "light"}`} style={{ fontSize: `${Math.max(12, Math.min(16, Number(form.fontSize) || 13))}px`, whiteSpace: form.wrap ? "pre-wrap" : "pre", tabSize: Number(form.tabSize) || 2 }}>{'const booking = await createBooking({\n\tslotId: "DEMO-SLOT-01",\n\tidempotencyKey: "DEMO-REQUEST-01"\n});'}</pre></Row>
    </section>
    <section className="set-section"><h3>服务器配置</h3>
      <Row label="默认端口 / 用户" hint="仅保存默认值，不发起连接"><div className="row"><input className="input set-num" type="number" min={1} max={65535} aria-label="默认端口" value={form.port} onChange={e => update({ port: e.target.value })} /><input className="input set-default-user" aria-label="默认用户" value={form.defaultUser} onChange={e => update({ defaultUser: e.target.value })} /></div></Row>
      <Row label="默认认证" hint="密钥文件 / 密码 / 跳板机"><select className="select" aria-label="默认认证" value={form.auth} onChange={e => update({ auth: e.target.value })}><option value="key">密钥文件</option><option value="password">密码</option><option value="jump">跳板机（执行未接入）</option></select></Row>
      <Row label="高风险命令确认" hint="逐次确认，不允许从此关闭"><SettingsSwitch checked={true} onChange={() => {}} disabled label="高风险命令确认" title="确认由后端安全规则控制，不能通过界面偏好关闭" /></Row>
    </section>
    <section className="set-section"><h3>界面外观</h3>
      <Row label="头像风格" hint="品牌帆船 Logo 的 5 种容器风格；保存设置后作用于顶栏、侧栏与设置三处">
        <div className="cr51-avatar-group" role="radiogroup" aria-label="头像风格">
          {AVATAR_STYLE_IDS.map(style => <button key={style} type="button" role="radio" aria-checked={normalizeAvatarStyle(form.avatarStyle) === style}
            className="cr51-avatar-radio" onClick={() => update({ avatarStyle: style })}>
            <UserAvatar size={26} /><b>{AVATAR_STYLE_LABELS[style as AvatarStyleId]}</b>
          </button>)}
        </div>
      </Row>
      <Row label="头像" hint="悬停头像出现编辑；内置 5 种样式或自定义图片（PNG / JPG / WebP，≤200KB）。应用后同步三处">
        <AvatarField
          style={normalizeAvatarStyle(form.avatarStyle)}
          photo={avatarPhoto}
          onChange={({ style, photo }) => { setAvatarPhoto(api.avatarPhotoSrc(photo)); update({ avatarStyle: style }); }}
        />
      </Row>
      <Row label="预览" hint="当前所选风格与头像图片（24 / 34px）">
        <div className="row" style={{ gap: 10 }}><UserAvatar size={24} photo={avatarPhoto} /><UserAvatar size={34} photo={avatarPhoto} /><span className="set-caption">{AVATAR_STYLE_LABELS[normalizeAvatarStyle(form.avatarStyle)]}</span></div>
      </Row>
    </section>
    <section className="set-section"><h3>会话</h3>
      <Row label="生成中再次发送" hint="立即发送打断；排队等当前完成"><div className="set-seg">{[["immediate", "立即发送"], ["queue", "排队"]].map(([value, text]) => <button key={value} type="button" aria-pressed={form.sendMode === value} onClick={() => update({ sendMode: value })}>{text}</button>)}</div></Row>
    </section>
    <div className="set-actions"><button className="btn primary" onClick={save}>{saving ? "保存中…" : "保存设置"}</button><span className="set-caption">偏好保存不等于编辑器、服务器或 CLI 已消费；原生权限仍由执行端控制。</span></div>
  </fieldset>;
}
