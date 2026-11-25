import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import * as api from "@/api";
import { getSetting, setSetting } from "@/api";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/ui";
import { AvatarButton, useAvatarChoice } from "@/components/avatar";
import { AVATAR_STYLE_LABELS } from "@/components/icon-tiles";
import { useApp, type ThemeMode } from "@/store/app";
import { errMsg } from "./shared";
import "./general.css";

type Density = "standard" | "compact";
type CodeTheme = "auto" | "light" | "dark";
type SendMode = "immediate" | "queue";
type Auth = "key" | "password" | "jump";

type Form = {
  name: string; email: string; role: string; timezone: string;
  themeMode: ThemeMode; density: Density;
  codeTheme: CodeTheme; fontSize: string; tabSize: string; wrap: boolean;
  sendMode: SendMode; notifyDone: boolean; restoreLastWindow: boolean;
  port: string; defaultUser: string; auth: Auth;
  dataDir: string;
};

const DEFAULTS: Form = {
  name: "", email: "", role: "", timezone: "Asia/Shanghai",
  themeMode: "system", density: "standard",
  codeTheme: "auto", fontSize: "13", tabSize: "2", wrap: true,
  sendMode: "queue", notifyDone: true, restoreLastWindow: true,
  port: "22", defaultUser: "", auth: "key",
  dataDir: "",
};

type SettingField = "name" | "email" | "role" | "timezone" | "codeTheme" | "fontSize" | "tabSize" | "wrap" | "sendMode" | "density" | "notifyDone" | "restoreLastWindow" | "port" | "defaultUser" | "auth";
const KEYS: Record<SettingField, string> = {
  name: "user.name", email: "user.email", role: "user.role", timezone: "user.timezone",
  codeTheme: "editor.theme", fontSize: "editor.fontSize", tabSize: "editor.tabSize", wrap: "editor.wrap",
  sendMode: "chat.sendMode", density: "ui.density", notifyDone: "chat.notifyDone", restoreLastWindow: "ui.restoreLastWindow",
  port: "server.port", defaultUser: "server.defaultUser", auth: "server.auth",
};
const TZ = ["Asia/Shanghai", "Asia/Tokyo", "Asia/Singapore", "Europe/London", "America/New_York", "UTC"];
const DIRS = ["db", "chat", "knowledge", "skills", "mcp", "secrets", "avatar", "logs", "recycle", "index", "examples"];
const GROUPS: { id: string; label: string; short: string; icon: string }[] = [
  { id: "identity", label: "个人资料", short: "个人资料", icon: "user" },
  { id: "appearance", label: "外观与显示", short: "外观", icon: "palette" },
  { id: "behavior", label: "会话与行为", short: "会话", icon: "sliders" },
  { id: "host", label: "新建主机默认值", short: "主机默认", icon: "server" },
  { id: "storage", label: "数据与存储", short: "数据", icon: "database" },
  { id: "about", label: "关于", short: "关于", icon: "info" },
];

const codeThemeKey = (value: string | null): CodeTheme => {
  if (value === "light" || value === "浅色") return "light";
  if (value === "dark" || value === "深色") return "dark";
  return "auto";
};
const authKey = (value: string | null): Auth => value === "password" || value === "密码" ? "password" : value === "jump" || value === "跳板机" ? "jump" : "key";
const resolveTheme = (mode: ThemeMode): "light" | "dark" =>
  mode === "system" ? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light") : mode;

function Row({ label, children, hint, error }: { label: string; children: ReactNode; hint?: ReactNode; error?: string }) {
  return <div className="g-row"><div className="g-label"><b>{label}</b></div><div className="g-control">{children}
    {error ? <p className="g-err" role="alert">{error}</p> : hint && <span className="g-hint">{hint}</span>}
  </div></div>;
}
function Group({ group, tag, children }: { group: typeof GROUPS[number]; tag?: string; children: ReactNode }) {
  return <section className="g-group" data-group={group.id} id={`g-${group.id}`}>
    <header className="g-group-h"><span className="g-ico"><Icon name={group.icon} size={14} /></span><h3>{group.label}</h3>{tag && <span className="g-group-tag">{tag}</span>}</header>
    <div className="g-rows">{children}</div>
  </section>;
}
function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (next: T) => void; label: string }) {
  return <div className="segment" role="radiogroup" aria-label={label}>{options.map(([v, text]) => <button key={v} type="button" role="radio" aria-pressed={value === v} onClick={() => onChange(v)}>{text}</button>)}</div>;
}
function Switch({ checked, onChange, label, disabled, title }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean; title?: string }) {
  return <button type="button" className="switch" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} title={title} onClick={() => onChange(!checked)} />;
}

export function SettingsGeneral() {
  const toast = useToast();
  const { theme, themeMode, setThemeMode } = useApp();
  const avatar = useAvatarChoice();
  const [form, setForm] = useState<Form>(DEFAULTS);
  const [saved, setSaved] = useState<Form | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [errors, setErrors] = useState<Partial<Record<keyof Form | "dataDir", string>>>({});
  const [restartRequired, setRestartRequired] = useState(false);
  const [version, setVersion] = useState("");
  const [active, setActive] = useState("identity");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError("");
    const reads = (Object.keys(KEYS) as SettingField[]).map(async field => ({ field, value: await getSetting(KEYS[field]) }));
    Promise.all([
      ...reads,
      api.storageDataDir().then(location => ["dataDir", location.path] as const).catch(() => ["dataDir", ""] as const),
      getVersion().catch(() => ""),
    ]).then(values => {
      if (!alive) return;
      const next: Form = { ...DEFAULTS, themeMode };
      const appVersion = values.find(item => typeof item === "string");
      if (typeof appVersion === "string") setVersion(appVersion);
      for (const entry of values) {
        if (typeof entry === "string" || entry == null) continue;
        if (!("field" in entry)) continue;
        const field = entry.field as SettingField;
        const value = entry.value as string | null;
        if (value == null) continue;
        if (field === "wrap" || field === "notifyDone" || field === "restoreLastWindow") (next as unknown as Record<string, unknown>)[field] = String(value) !== "false";
        else if (field === "codeTheme") next.codeTheme = codeThemeKey(String(value));
        else if (field === "auth") next.auth = authKey(String(value));
        else if (field === "density") next.density = String(value) === "compact" ? "compact" : "standard";
        else if (field === "sendMode") next.sendMode = String(value) === "immediate" ? "immediate" : "queue";
        else (next as unknown as Record<string, unknown>)[field] = String(value);
      }
      setForm(next); setSaved(next);
      api.storageDataDir().then(location => { if (alive) setRestartRequired(Boolean(location.restartRequired)); }).catch(() => {});
    }).catch(e => { if (alive) setError(errMsg(e)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [attempt]);

  const dirty = useMemo(() => {
    if (!saved) return false;
    return (Object.keys(KEYS) as SettingField[]).some(key => {
      const left = form[key], right = saved[key];
      return typeof left === "boolean" ? left !== right : String(left) !== String(right);
    }) || form.dataDir !== saved.dataDir || form.themeMode !== saved.themeMode;
  }, [form, saved]);
  const dirtyCount = useMemo(() => {
    if (!saved) return 0;
    let count = 0;
    (Object.keys(KEYS) as SettingField[]).forEach(key => { if (String(form[key]) !== String(saved[key])) count += 1; });
    if (form.dataDir !== saved.dataDir) count += 1;
    if (form.themeMode !== saved.themeMode) count += 1;
    return count;
  }, [form, saved]);

  const update = <K extends keyof Form>(key: K, value: Form[K]) => setForm(previous => ({ ...previous, [key]: value }));

  /* 即时预览：主题与密度在选择后立即作用于界面；放弃或关闭时按已保存值回滚。 */
  useEffect(() => {
    document.documentElement.dataset.theme = resolveTheme(form.themeMode);
  }, [form.themeMode]);
  useEffect(() => {
    document.documentElement.dataset.density = form.density;
    return () => { document.documentElement.dataset.density = saved?.density ?? "standard"; };
  }, [form.density, saved?.density]);
  useEffect(() => () => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("settings:general-dirty", { detail: { dirty, count: dirtyCount } }));
  }, [dirty, dirtyCount]);

  function validate(next: Form) {
    const result: Partial<Record<keyof Form, string>> = {};
    if (next.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email.trim())) result.email = "邮箱格式不正确";
    if (next.name.trim().length > 40) result.name = "名称最多 40 个字符";
    if (next.role.trim().length > 24) result.role = "角色最多 24 个字符";
    const fontSize = Number(next.fontSize);
    if (!Number.isInteger(fontSize) || fontSize < 12 || fontSize > 16) result.fontSize = "字号需为 12–16 的整数";
    if (!["2", "4"].includes(String(next.tabSize))) result.tabSize = "Tab 宽度只能是 2 或 4";
    const port = Number(next.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) result.port = "端口需为 1–65535 的整数";
    if (next.defaultUser.trim() && !/^[A-Za-z0-9._-]{1,32}$/.test(next.defaultUser.trim())) result.defaultUser = "用户名只允许字母、数字与 . _ -";
    if (!TZ.includes(next.timezone)) result.timezone = "未知的时区";
    return result;
  }

  async function save() {
    if (saving || loading || !saved) return;
    const found = validate(form);
    if (Object.keys(found).length) {
      setErrors(found);
      const firstKey = Object.keys(found)[0];
      document.getElementById(`g-${firstKey}`)?.focus();
      toast(`${Object.keys(found).length} 项需要修正`, "warn");
      return;
    }
    setSaving(true);
    try {
      const normalized: Form = {
        ...form,
        name: form.name.trim(), email: form.email.trim(), role: form.role.trim(),
        defaultUser: form.defaultUser.trim(), dataDir: form.dataDir.trim(),
        fontSize: String(Number(form.fontSize)), tabSize: String(form.tabSize), port: String(Number(form.port)),
      };
      for (const key of Object.keys(KEYS) as SettingField[]) {
        const value = normalized[key];
        await setSetting(KEYS[key], typeof value === "boolean" ? String(value) : String(value));
      }
      await setThemeMode(normalized.themeMode);
      await api.storageSetDataDir(normalized.dataDir || null);
      const location = await api.storageDataDir().catch(() => null);
      setForm(normalized); setSaved(normalized); setErrors({});
      setRestartRequired(Boolean(location?.restartRequired));
      window.dispatchEvent(new CustomEvent("app:settings-changed", {
        detail: {
          profile: { name: normalized.name, email: normalized.email, role: normalized.role, timezone: normalized.timezone },
          general: normalized, avatarStyle: avatar.style,
        },
      }));
      toast(location?.restartRequired ? "设置已保存；数据位置将在重启后迁移生效" : "设置已保存");
    } catch (e) {
      toast(`保存未全部完成，请重试：${errMsg(e)}`, "err");
    } finally { setSaving(false); }
  }

  function discard() {
    if (!saved) return;
    setForm(saved); setErrors({});
    document.documentElement.dataset.theme = resolveTheme(saved.themeMode);
    document.documentElement.dataset.density = saved.density;
  }

  function restoreDefaults() {
    const next: Form = { ...DEFAULTS, themeMode: "system", dataDir: form.dataDir };
    setForm(next); setErrors({});
    document.documentElement.dataset.theme = resolveTheme(next.themeMode);
    toast("已恢复本页默认值，尚未保存", "warn");
  }

  /* 分组跳转与滚动高亮 */
  useEffect(() => {
    const body = document.querySelector<HTMLElement>(".set-scroll");
    if (!body) return;
    const onScroll = () => {
      const limit = body.getBoundingClientRect().top + 64;
      let current = GROUPS[0].id;
      body.querySelectorAll<HTMLElement>(".g-group").forEach(node => {
        if (node.getBoundingClientRect().top <= limit) current = node.dataset.group || current;
      });
      setActive(current);
    };
    onScroll();
    body.addEventListener("scroll", onScroll, { passive: true });
    return () => body.removeEventListener("scroll", onScroll);
  }, [loading]);

  async function checkUpdate() {
    try {
      const result = await api.updateCheck();
      toast(result.update_available && result.manifest?.version ? `发现新版本 ${result.manifest.version}` : "当前已是最新版本");
    } catch (e) {
      toast(`检查更新失败：${errMsg(e)}`, "err");
    }
  }

  if (loading) return <p className="set-caption">加载设置中…</p>;
  if (error) return <div className="g-err" role="alert">读取设置失败：{error}
    <button className="btn sm" type="button" onClick={() => setAttempt(value => value + 1)}>重试</button>
  </div>;

  const codeDark = (form.codeTheme === "auto" ? resolveTheme(form.themeMode) : form.codeTheme) === "dark";
  const dataChanged = Boolean(saved) && form.dataDir.trim() !== (saved as Form).dataDir.trim();
  const timezoneOptions = TZ.includes(form.timezone) ? TZ : [form.timezone, ...TZ];
  const input = (key: keyof Form, extra?: { type?: string; num?: boolean; short?: boolean; mono?: boolean; aria?: string; min?: number; max?: number }) =>
    <input className={`input${extra?.num ? " g-num" : ""}${extra?.short ? " g-short" : ""}`} id={`g-${String(key)}`} value={String(form[key])}
      type={extra?.type} aria-label={extra?.aria} min={extra?.min} max={extra?.max}
      aria-invalid={Boolean(errors[key])} style={extra?.mono ? { fontFamily: "var(--mono, ui-monospace, monospace)" } : undefined}
      onChange={event => update(key, event.target.value as never)} />;

  return <div className="g-general" ref={scrollRef}>
    <div className="g-bar">
      <nav className="g-jump" aria-label="通用设置分组">
        {GROUPS.map(group => <button key={group.id} type="button" aria-current={active === group.id} aria-label={`跳转到${group.label}`}
          onClick={() => document.getElementById(`g-${group.id}`)?.scrollIntoView({ block: "start", behavior: "smooth" })}>{group.short}</button>)}
      </nav>
      <span className="g-bar-space" />
      <span className="g-dirty" data-clean={dirtyCount === 0}>{dirtyCount ? `${dirtyCount} 项未保存` : "已保存"}</span>
      <button className="btn" type="button" disabled={!dirty || saving} onClick={discard}>放弃</button>
      <button className="btn primary" type="button" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</button>
    </div>

    <Group group={GROUPS[0]} tag="仅用于显示">
      <Row label="头像" hint={`当前样式 ${AVATAR_STYLE_LABELS[avatar.style]}；应用后立即生效，不随本页保存。`}>
        <AvatarButton style={avatar.style} photo={avatar.photo} label={AVATAR_STYLE_LABELS[avatar.style]} />
      </Row>
      <Row label="显示名称" error={errors.name}>{input("name", { aria: "显示名称" })}</Row>
      <Row label="邮箱" error={errors.email}>{input("email", { type: "email", aria: "邮箱" })}</Row>
      <Row label="角色" error={errors.role}>{input("role", { aria: "角色" })}</Row>
      <Row label="时区" error={errors.timezone} hint="影响时间显示，不改系统时区。">
        <select className="select" aria-label="时区" value={form.timezone} onChange={event => update("timezone", event.target.value)}>
          {timezoneOptions.map(zone => <option key={zone} value={zone}>{zone}</option>)}
        </select>
      </Row>
    </Group>

    <Group group={GROUPS[1]}>
      <Row label="界面主题" hint="跟随系统时随操作系统深浅色自动切换；选择即时预览。">
        <Seg<ThemeMode> label="界面主题" value={form.themeMode} onChange={value => update("themeMode", value)}
          options={[["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]]} />
      </Row>
      <Row label="界面密度" hint="紧凑会收紧列表与表单行距，不改变字号。">
        <Seg<Density> label="界面密度" value={form.density} onChange={value => update("density", value)}
          options={[["standard", "标准"], ["compact", "紧凑"]]} />
      </Row>
      <div className="g-sub-h">代码编辑器</div>
      <Row label="代码高亮">
        <Seg<CodeTheme> label="代码高亮" value={form.codeTheme} onChange={value => update("codeTheme", value)}
          options={[["auto", "跟随界面"], ["light", "浅色"], ["dark", "深色"]]} />
      </Row>
      <Row label="字号 / Tab / 换行" error={errors.fontSize || errors.tabSize}>
        <div className="row" style={{ gap: 8 }}>
          {input("fontSize", { type: "number", num: true, min: 12, max: 16, aria: "编辑器字号" })}
          <select className="select" aria-label="Tab 宽度" value={form.tabSize} style={{ minWidth: 88, maxWidth: 88 }} onChange={event => update("tabSize", event.target.value)}>
            <option value="2">2 空格</option><option value="4">4 空格</option>
          </select>
          <Switch checked={form.wrap} onChange={value => update("wrap", value)} label="自动换行" />
          <span className="g-inline">自动换行</span>
        </div>
      </Row>
      <Row label="预览">
        <pre className={`g-preview ${codeDark ? "dark" : "light"}`}
          style={{ fontSize: `${Math.max(12, Math.min(16, Number(form.fontSize) || 13))}px`, tabSize: Number(form.tabSize) === 4 ? 4 : 2, whiteSpace: form.wrap ? "pre-wrap" : "pre" }}>
          <span className="tk-k">const</span> booking = <span className="tk-k">await</span> createBooking({"\n"}
          {"  "}slotId: <span className="tk-s">{'"DEMO-SLOT-01"'}</span>,{"\n"}
          {"  "}idempotencyKey: <span className="tk-s">{'"DEMO-REQUEST-01"'}</span>{"\n"}
          {"});"}
        </pre>
      </Row>
    </Group>

    <Group group={GROUPS[2]}>
      <Row label="生成中再次发送" hint="立即发送会打断当前生成；排队等当前回合结束后再发。">
        <Seg<SendMode> label="生成中再次发送" value={form.sendMode} onChange={value => update("sendMode", value)}
          options={[["immediate", "立即发送"], ["queue", "排队"]]} />
      </Row>
      <Row label="完成后通知" hint="偏好已保存；提示通道尚未接入，当前不会弹出系统通知。">
        <Switch checked={form.notifyDone} onChange={value => update("notifyDone", value)} label="完成后通知" />
      </Row>
      <Row label="启动时恢复窗口" hint="偏好已保存；启动恢复逻辑尚未接入，当前启动固定打开工作台。">
        <Switch checked={form.restoreLastWindow} onChange={value => update("restoreLastWindow", value)} label="启动时恢复窗口" />
      </Row>
    </Group>

    <Group group={GROUPS[3]} tag="不影响已建主机">
      <Row label="默认端口 / 用户" error={errors.port || errors.defaultUser} hint="只作为新建主机表单的初始值，不发起连接、不覆盖已有主机。">
        <div className="row" style={{ gap: 8 }}>
          {input("port", { type: "number", num: true, min: 1, max: 65535, aria: "默认端口" })}
          {input("defaultUser", { short: true, aria: "默认用户" })}
        </div>
      </Row>
      <Row label="默认认证" hint={form.auth === "jump" ? "跳板机执行通道尚未接入，选择后新建表单会要求补充跳板配置。" : undefined}>
        <select className="select" aria-label="默认认证" value={form.auth} onChange={event => update("auth", event.target.value as Auth)}>
          <option value="key">密钥文件</option><option value="password">密码</option><option value="jump">跳板机</option>
        </select>
      </Row>
      <Row label="高风险命令确认">
        <span className="g-inline"><Icon name="lock" size={14} />由执行层逐次确认，属强制安全策略，不能在此关闭</span>
      </Row>
    </Group>

    <Group group={GROUPS[4]} tag={dataChanged ? "重启后生效" : (restartRequired ? "待重启" : undefined)}>
      <Row label="数据存储位置"
        hint={dataChanged ? "已改为新位置：保存并重启后迁移生效，旧目录保留不删除。" : `默认位于安装目录下的 data；知识库根目录 ${form.dataDir ? `${form.dataDir}${form.dataDir.includes("\\") ? "\\" : "/"}knowledge` : "（加载中）"}`}>
        <div className="row" style={{ gap: 8, width: "100%" }}>
          {input("dataDir", { aria: "数据存储位置", mono: true })}
          <button className="btn" type="button" onClick={() => void api.pickProjectDirectory().then(path => { if (path) update("dataDir", path); }).catch(e => toast(errMsg(e), "err"))}>选择目录</button>
          <button className="btn" type="button" onClick={() => void navigator.clipboard?.writeText(form.dataDir || "").then(() => toast("路径已复制")).catch(() => toast("复制失败", "err"))}>复制路径</button>
        </div>
      </Row>
      <Row label="位置分类" hint="各分类位于上述数据目录下；占用统计尚未接入，可到目录自行查看。">
        <span className="g-dirs">{DIRS.map(dir => <span className="g-dir" key={dir}>{dir}</span>)}</span>
      </Row>
      <Row label="知识库目录" hint="可直接把文件拷进该文件夹，刷新后进入索引；不在此处修改。">
        <input className="input" readOnly aria-label="知识库目录" style={{ fontFamily: "var(--mono, ui-monospace, monospace)" }}
          value={form.dataDir ? `${form.dataDir}${form.dataDir.includes("\\") ? "\\" : "/"}knowledge` : ""} />
      </Row>
    </Group>

    <Group group={GROUPS[5]} tag={version ? `v${version}` : undefined}>
      <Row label="版本">
        <span className="g-about">
          <span className="g-version">{version ? `v${version}` : "未知"}</span>
          <span className="g-about-meta">本机安装</span>
          <button className="btn sm" type="button" onClick={() => void checkUpdate()}><Icon name="refresh" size={14} />检查更新</button>
        </span>
      </Row>
      <Row label="日志目录" hint="诊断或反馈问题时附上该目录内的最近日志。">
        <div className="row" style={{ gap: 8, width: "100%" }}>
          <input className="input" readOnly aria-label="日志目录" style={{ fontFamily: "var(--mono, ui-monospace, monospace)" }}
            value={form.dataDir ? `${form.dataDir}${form.dataDir.includes("\\") ? "\\" : "/"}logs` : ""} />
          <button className="btn" type="button" onClick={() => void navigator.clipboard?.writeText(form.dataDir ? `${form.dataDir}${form.dataDir.includes("\\") ? "\\" : "/"}logs` : "").then(() => toast("路径已复制")).catch(() => toast("复制失败", "err"))}>复制路径</button>
        </div>
      </Row>
      <Row label="本页设置" hint="只影响通用页；恢复后仍需点击保存才写入。">
        <button className="btn" type="button" onClick={restoreDefaults}>恢复本页默认值</button>
      </Row>
    </Group>
  </div>;
}