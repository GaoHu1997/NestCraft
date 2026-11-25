/**
 * CR-075：主机系统标识与列表展示工具。
 *
 * 系统标识只由连接后检测到的系统文本派生，映射到 public/brand/os/ 下的官方标识；
 * 不提供用户选择、上传或自定义入口（用户评审第三条）。
 */

export interface OsMeta {
  id: string;
  /** 展示用系统名，用于 title／aria-label，不替代完整系统文本。 */
  label: string;
  /** public/brand/os/ 下的文件名。 */
  file: string;
}

const OS_RULES: Array<{ re: RegExp; meta: OsMeta }> = [
  { re: /ubuntu/i, meta: { id: "ubuntu", label: "Ubuntu", file: "ubuntu.svg" } },
  { re: /debian/i, meta: { id: "debian", label: "Debian", file: "debian.svg" } },
  { re: /centos/i, meta: { id: "centos", label: "CentOS", file: "centos.svg" } },
  { re: /rocky/i, meta: { id: "rocky", label: "Rocky Linux", file: "rockylinux.svg" } },
  { re: /alma/i, meta: { id: "alma", label: "AlmaLinux", file: "almalinux.svg" } },
  { re: /fedora/i, meta: { id: "fedora", label: "Fedora", file: "fedora.svg" } },
  { re: /arch\s*linux|\barch\b/i, meta: { id: "arch", label: "Arch Linux", file: "archlinux.svg" } },
  { re: /open\s*suse|\bsuse\b|\bsles\b/i, meta: { id: "opensuse", label: "openSUSE", file: "opensuse.svg" } },
  { re: /alpine/i, meta: { id: "alpine", label: "Alpine Linux", file: "alpinelinux.svg" } },
  { re: /amazon/i, meta: { id: "amazon", label: "Amazon Linux", file: "amazon.svg" } },
  { re: /oracle/i, meta: { id: "oracle", label: "Oracle Linux", file: "oracle.svg" } },
  { re: /red\s*hat|\brhel\b/i, meta: { id: "redhat", label: "Red Hat", file: "redhat.svg" } },
  { re: /freebsd/i, meta: { id: "freebsd", label: "FreeBSD", file: "freebsd.svg" } },
  { re: /windows/i, meta: { id: "windows", label: "Windows", file: "windows.svg" } },
  { re: /mac\s*os|macos|darwin|os\s*x/i, meta: { id: "macos", label: "macOS", file: "apple.svg" } },
  { re: /linux/i, meta: { id: "linux", label: "Linux", file: "linux.svg" } },
];

/** 系统文本 → 标识；未知（空、"未知"、无匹配）返回 null，调用方用中性占位。 */
export function osMeta(os: string | null | undefined): OsMeta | null {
  const text = String(os ?? "").trim();
  if (!text || text === "未知" || text === "系统未知") return null;
  return OS_RULES.find((rule) => rule.re.test(text))?.meta ?? null;
}

/** 标识图片地址；未知返回 null。 */
export function osLogoSrc(os: string | null | undefined): string | null {
  const meta = osMeta(os);
  return meta ? `/brand/os/${meta.file}` : null;
}

/** 系统展示名：已知返回映射名，未知统一"系统未知"。 */
export function osLabel(os: string | null | undefined): string {
  return osMeta(os)?.label ?? "系统未知";
}

/** 列表与工作台统一地址：user@host:port。 */
export function hostAddress(host: { username: string; host: string; port: number }): string {
  const raw = String(host.host ?? "").trim();
  const at = raw.indexOf("@");
  if (at >= 0) return `${raw.slice(0, at)}@${raw.slice(at + 1)}:${host.port}`;
  return `${host.username || "root"}@${raw}:${host.port}`;
}

/** 指标百分数；无采样返回 null（界面显示「—」）。 */
export function pctText(value: number | null | undefined): string {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return `${Math.round(Number(value))}%`;
}

/** 上次采样：未采样返回"未采样"，其余给相对时间。 */
export function lastSeenText(ms: number | null | undefined): string {
  if (!ms) return "未采样";
  const delta = Date.now() - Number(ms);
  if (!Number.isFinite(delta)) return "未采样";
  if (delta < 60_000) return "上次采样 刚刚";
  if (delta < 3_600_000) return `上次采样 ${Math.floor(delta / 60_000)} 分钟前`;
  const label = new Date(Number(ms)).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `上次采样 ${label}`;
}