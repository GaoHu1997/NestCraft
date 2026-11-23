import { useState, type HTMLAttributes, type SVGProps } from "react";

/** UI-ICON-001-v1; names match the locked CR044 sprite, including compatibility symbols.
 *  CR-051 增量：新增 7 个符号（fileMarkdown/fileHtml/fileAudio/fileVideo/fileUnknown/briefcase/library），
 *  与 docs/UI/workbench-v4/icon-sprite.svg 及 public/ui/icon-sprite.svg 同步。 */
export const ICON_NAMES = [
  "home", "grid", "folder", "folderOpen", "book", "server", "settings", "search", "plus", "x",
  "chevronDown", "chevronRight", "chevronLeft", "chevronUp", "arrowLeft", "arrowUp", "play", "pause",
  "refresh", "check", "alert", "clock", "user", "users", "sparkles", "terminal", "file", "fileText",
  "filePdf", "fileSheet", "image", "csv", "git", "code", "database", "layers", "cpu", "send",
  "paperclip", "panelRight", "panelLeft", "history", "gauge", "eye", "bulb", "steps", "dots", "edit",
  "trash", "filter", "download", "upload", "shield", "key", "external", "box", "link", "bell", "sun",
  "moon", "branch", "stop", "lock", "globe", "zap", "inbox", "list", "target", "message", "more",
  "menu", "drag", "sliders", "bookOpen", "printer", "minimize", "maximize", "restore", "close",
  "error", "info", "help", "copy", "save", "undo", "redo", "arrowRight", "arrowDown", "folderPlus",
  "filePlus", "fileWord", "fileSlides", "fileCode", "fileArchive", "filterOff", "sort", "expand",
  "collapse", "layout", "alignLeft", "alignCenter", "alignRight", "palette", "checkCircle", "loader",
  "shieldCheck", "unlock", "gitMerge", "gitCommit", "command", "workflow", "bot", "wrench",
  "fileMarkdown", "fileHtml", "fileAudio", "fileVideo", "fileUnknown", "briefcase", "library",
  // CR-065：底部统计专用图标（会话统计 / Token 用量 / 上下文已用）
  "sessionStats", "tokenUsage", "contextUsage",
  // CR-065：AI 字标（用户指定以 A/I 字母设计的侧栏开关图标）
  "aiMark",
  // CR-065：AI 图像图标（机器人头，最终用于侧栏开关）
  "aiBot",
  // CR-054：工作台页签图标（坐在电脑前的小人）
  "atDesk",
  // CR-051 r2/r6：通用图标库（办公／商业／内容／产品／生活）+ 裁剪拖动提示
  "building", "calendar", "clipboard", "presentation", "mail", "idBadge",
  "chartBar", "chartLine", "chartPie", "wallet", "receipt", "cart", "tag", "scale",
  "megaphone", "camera", "music", "video", "mic", "newspaper", "pen", "brush",
  "rocket", "bug", "puzzle", "flag", "compass", "flask", "robot", "cloud",
  "school", "heart", "star", "hand",
] as const;
export type IconName = typeof ICON_NAMES[number];
export const ICON_ALIASES: Readonly<Record<string, IconName>> = {
  down: "chevronDown", up: "chevronUp", left: "chevronLeft", right: "chevronRight",
  doc: "fileText", panel: "panelRight", warning: "alert", gear: "settings",
};
const iconNames = new Set<string>(ICON_NAMES);
const warnedNames = new Set<string>();
export type IconProps = Omit<SVGProps<SVGSVGElement>, "name"> & {
  name: IconName | string;
  size?: number;
  title?: string;
};

export function Icon({ name, size = 16, className, title, children, ...props }: IconProps) {
  const resolved = iconNames.has(name) ? name : Object.prototype.hasOwnProperty.call(ICON_ALIASES, name) ? ICON_ALIASES[name] : undefined;
  const missing = !resolved;
  if (missing && !warnedNames.has(name)) {
    warnedNames.add(name);
    console.warn(`[UI-ICON-001] Icon "${name}" is not available in the locked sprite.`);
  }
  const description = missing ? `Icon not available: ${name}` : title;
  const labelled = !!(description || props["aria-label"] || props["aria-labelledby"]);
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" focusable="false"
    aria-hidden={labelled ? undefined : true} role={labelled ? "img" : undefined}
    aria-label={description} {...props} className={`ui-icon${missing ? " icon-missing" : ""}${className ? ` ${className}` : ""}`}
    data-icon={resolved ?? "alert"} data-icon-missing={missing ? name : undefined}>
    {description && <title>{description}</title>}
    <use href={`/ui/icon-sprite.svg#${resolved ?? "alert"}`} />
    {children}
  </svg>;
}

const CLI_BRANDS: Readonly<Record<string, { label: string; provenance: string }>> = {
  claude: { label: "Claude Code", provenance: "Claude family official brand mark" },
  codex: { label: "Codex", provenance: "OpenAI official manufacturer mark" },
  grok: { label: "Grok", provenance: "Grok official product mark, not CLI-exclusive" },
};
export type CliLogoProps = Omit<HTMLAttributes<HTMLSpanElement>, "id"> & { id: string; size?: number };

/** Original official asset colors and aspect ratios; unavailable assets never become letter badges. */
export function CliLogo({ id, size = 20, className, title, style, children, ...props }: CliLogoProps) {
  const [failedId, setFailedId] = useState<string | null>(null);
  const brand = Object.prototype.hasOwnProperty.call(CLI_BRANDS, id) ? CLI_BRANDS[id] : undefined;
  const unavailable = !brand || failedId === id;
  const description = unavailable ? `${id || "CLI"}: official brand asset not available` : `${brand.label} · ${brand.provenance}`;
  return <span role="img" aria-label={description} {...props}
    className={`cli-logo cli-brand${unavailable ? " asset-unavailable" : ""}${className ? ` ${className}` : ""}`}
    data-cli={id} title={unavailable ? description : title ?? description}
    style={{ width: size, height: size, ...style }}>
    {unavailable ? <Icon name="alert" size={size} aria-hidden="true" /> :
      <img src={`/ui/brand-icons/${id}.svg`} width={size} height={size} alt="" aria-hidden="true" draggable={false} onError={() => setFailedId(id)} />}
    {children}
  </span>;
}
