import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "@/components/icons";
import * as api from "@/api";

/**
 * CR-051 / UI-CR051-v6：项目与知识库图标砖、文件类型映射、头像风格与色卡。
 * 图标唯一来源是 ui/icon-sprite.svg（React Icon 内部 <use>）；未登记 id 回退
 * 类型默认图标，类型未知回退 file，不显示空白方块（CR-051 规则 9）。
 * r6：项目与知识库共用同一个 50 图标库；项目／知识库增加 10 个整块色卡；
 * 头像入口改为「头像框 → 悬停编辑 → 固定尺寸弹窗 → 取景框拖动裁剪」。
 */

/** 项目与知识库共用的 50 个图标（UI-CR051-v6 §3.1，6 组）。 */
export const ICON_GROUPS = [
  { name: "通用", hint: "类型 / 技术 / 资料 / 目标", icons: ["code", "terminal", "globe", "database", "layers", "box", "wrench", "gauge", "bulb", "target", "sparkles", "book", "bookOpen", "library", "shield", "users"] },
  { name: "办公", hint: "组织 / 计划 / 沟通", icons: ["briefcase", "building", "calendar", "clipboard", "presentation", "mail", "idBadge"] },
  { name: "商业", hint: "数据 / 财务 / 经营", icons: ["chartBar", "chartLine", "chartPie", "wallet", "receipt", "cart", "tag", "scale"] },
  { name: "内容", hint: "市场 / 媒体 / 创作", icons: ["megaphone", "camera", "music", "video", "mic", "newspaper", "pen", "brush"] },
  { name: "产品", hint: "研发 / 上线 / 探索", icons: ["rocket", "bug", "puzzle", "flag", "compass", "flask", "robot", "cloud"] },
  { name: "生活", hint: "学习 / 收藏 / 关怀", icons: ["school", "heart", "star"] },
] as const;

export const PROJECT_ICON_IDS = ICON_GROUPS.flatMap(g => g.icons) as unknown as readonly string[];
/** r6：知识库不再单独限制图标范围，与项目共用同一套。 */
export const KB_ICON_IDS = PROJECT_ICON_IDS;

export const ICON_LABELS: Record<string, string> = {
  code: "编码", terminal: "终端", globe: "网页", database: "数据", layers: "组合", box: "容器",
  wrench: "工具", gauge: "仪表", bulb: "灵感", target: "目标", sparkles: "特色",
  book: "书本", bookOpen: "本地目录", library: "资料库", shield: "授权", users: "团队",
  briefcase: "办公", building: "楼宇", calendar: "日程", clipboard: "清单", presentation: "演示",
  mail: "邮件", idBadge: "证件", chartBar: "柱状图", chartLine: "折线图", chartPie: "饼图",
  wallet: "钱包", receipt: "票据", cart: "采购", tag: "标签", scale: "天平",
  megaphone: "推广", camera: "摄影", music: "音乐", video: "视频", mic: "录音",
  newspaper: "资讯", pen: "写作", brush: "设计", rocket: "上线", bug: "缺陷", puzzle: "集成",
  flag: "里程碑", compass: "探索", flask: "实验", robot: "自动化", cloud: "云服务",
  school: "学习", heart: "关怀", star: "收藏",
};

/* ---------------- 背景色卡（UI-CR051-v6 §3.2，10 色，无文字） ---------------- */

export type IconColorId = "blue" | "teal" | "violet" | "amber" | "green" | "rose" | "indigo" | "orange" | "slate" | "sand";
export const ICON_COLORS: ReadonlyArray<{ id: IconColorId; soft: string; strong: string; darkSoft: string; darkStrong: string }> = [
  { id: "blue", soft: "#eaf1ff", strong: "#2b6cf6", darkSoft: "#1e2a44", darkStrong: "#8db3ff" },
  { id: "teal", soft: "#e8f7f3", strong: "#0b7d70", darkSoft: "#17302b", darkStrong: "#4fd1c5" },
  { id: "violet", soft: "#f0edfd", strong: "#6f5bd6", darkSoft: "#262238", darkStrong: "#b9a8ff" },
  { id: "amber", soft: "#fff4e2", strong: "#b76a00", darkSoft: "#2b2416", darkStrong: "#e0a04a" },
  { id: "green", soft: "#e7f8ef", strong: "#1a9d5a", darkSoft: "#16281d", darkStrong: "#4ccb83" },
  { id: "rose", soft: "#fdeef1", strong: "#c2345a", darkSoft: "#331a20", darkStrong: "#ff9ab0" },
  { id: "indigo", soft: "#eef0ff", strong: "#4356c9", darkSoft: "#1e2144", darkStrong: "#97a3ff" },
  { id: "orange", soft: "#fff0e6", strong: "#c2410c", darkSoft: "#331b12", darkStrong: "#f0906a" },
  { id: "slate", soft: "#eef1f5", strong: "#52627a", darkSoft: "#242a33", darkStrong: "#a7b6c8" },
  { id: "sand", soft: "#f8f1e3", strong: "#8a6420", darkSoft: "#2b2519", darkStrong: "#d8b06a" },
];
export const DEFAULT_PROJECT_COLOR: IconColorId = "blue";
export const DEFAULT_KB_COLOR: IconColorId = "teal";

export function normalizeIconColor(value: string | null | undefined, fallback: IconColorId): IconColorId {
  return ICON_COLORS.some(c => c.id === value) ? (value as IconColorId) : fallback;
}

/** 项目显示图标：已登记自选 id 优先，否则按类型推导（编码 code、办公 briefcase）。 */
export function projectIconId(project: Pick<api.Project, "icon" | "kind"> | null | undefined): IconName {
  const icon = project?.icon;
  if (icon && PROJECT_ICON_IDS.includes(icon)) return icon as IconName;
  return project?.kind === "work" ? "briefcase" : "code";
}

/** 项目显示色卡：自选色优先；旧项目（iconColor 为 NULL）沿用类型默认，不写回、不批量改写。 */
export function projectIconColor(project: Pick<api.Project, "iconColor" | "kind"> | null | undefined): IconColorId {
  const fallback: IconColorId = project?.kind === "work" ? "amber" : DEFAULT_PROJECT_COLOR;
  return normalizeIconColor(project?.iconColor, fallback);
}

/** 知识库显示图标：自选 id 优先；来源推导 managed-directory→bookOpen、connector→globe，未标注→library。 */
export function libraryIconId(library: Pick<api.KnowledgeLibrary, "icon" | "sourceKind"> | null | undefined): IconName {
  const icon = library?.icon;
  if (icon && KB_ICON_IDS.includes(icon)) return icon as IconName;
  if (library?.sourceKind === "connector") return "globe";
  if (library?.sourceKind === "managed-directory") return "bookOpen";
  return "library";
}

/** 知识库显示色卡：自选色优先，否则默认青绿。 */
export function libraryIconColor(library: Pick<api.KnowledgeLibrary, "iconColor"> | null | undefined): IconColorId {
  return normalizeIconColor(library?.iconColor, DEFAULT_KB_COLOR);
}

/** 项目图标砖。size 36=项目卡片、26=侧栏当前项目与授权弹窗项目行；图标 + 色卡成对显示。 */
export function ProjectIconTile({ project, size = 36 }: {
  project: Pick<api.Project, "icon" | "kind" | "iconColor">; size?: 26 | 36;
}) {
  const color = projectIconColor(project);
  return <span
    className={`cr51-tile cr51-color-${color}${size === 26 ? " cr51-tile-sm" : ""}`}
    style={{ width: size, height: size }}
    aria-hidden="true">
    <Icon name={projectIconId(project)} size={size === 26 ? 14 : 20} />
  </span>;
}

/** 知识库图标砖：40×40，图标 + 色卡成对显示。 */
export function LibraryIconTile({ library }: { library: Pick<api.KnowledgeLibrary, "icon" | "sourceKind" | "enabled" | "iconColor"> }) {
  const color = libraryIconColor(library);
  return <span className={`cr51-tile cr51-tile-kb cr51-color-${color}`} aria-hidden="true">
    <Icon name={libraryIconId(library)} size={20} />
  </span>;
}

/* ---------------- 文件类型映射（UI-CR051 §5.2 唯一来源） ---------------- */

export const FILE_TYPE_GLYPHS: Record<string, { icon: IconName; token: string }> = {
  md: { icon: "fileMarkdown", token: "md" }, markdown: { icon: "fileMarkdown", token: "md" }, mdx: { icon: "fileMarkdown", token: "md" },
  txt: { icon: "fileText", token: "text" }, log: { icon: "fileText", token: "text" }, ini: { icon: "fileText", token: "text" },
  conf: { icon: "fileText", token: "text" }, rtf: { icon: "fileText", token: "text" },
  pdf: { icon: "filePdf", token: "pdf" },
  doc: { icon: "fileWord", token: "word" }, docx: { icon: "fileWord", token: "word" }, odt: { icon: "fileWord", token: "word" },
  xls: { icon: "fileSheet", token: "sheet" }, xlsx: { icon: "fileSheet", token: "sheet" }, ods: { icon: "fileSheet", token: "sheet" },
  csv: { icon: "csv", token: "sheet" }, tsv: { icon: "csv", token: "sheet" },
  ppt: { icon: "fileSlides", token: "slides" }, pptx: { icon: "fileSlides", token: "slides" }, odp: { icon: "fileSlides", token: "slides" },
  png: { icon: "image", token: "image" }, jpg: { icon: "image", token: "image" }, jpeg: { icon: "image", token: "image" },
  gif: { icon: "image", token: "image" }, webp: { icon: "image", token: "image" }, svg: { icon: "image", token: "image" },
  ts: { icon: "fileCode", token: "code" }, js: { icon: "fileCode", token: "code" }, py: { icon: "fileCode", token: "code" },
  json: { icon: "fileCode", token: "code" }, yaml: { icon: "fileCode", token: "code" }, yml: { icon: "fileCode", token: "code" }, css: { icon: "fileCode", token: "code" },
  html: { icon: "fileHtml", token: "code" }, htm: { icon: "fileHtml", token: "code" },
  zip: { icon: "fileArchive", token: "archive" }, "7z": { icon: "fileArchive", token: "archive" }, rar: { icon: "fileArchive", token: "archive" },
  tar: { icon: "fileArchive", token: "archive" }, gz: { icon: "fileArchive", token: "archive" },
  mp3: { icon: "fileAudio", token: "audio" }, wav: { icon: "fileAudio", token: "audio" }, m4a: { icon: "fileAudio", token: "audio" }, flac: { icon: "fileAudio", token: "audio" },
  mp4: { icon: "fileVideo", token: "video" }, mov: { icon: "fileVideo", token: "video" }, mkv: { icon: "fileVideo", token: "video" }, webm: { icon: "fileVideo", token: "video" },
};

/** 扩展名 → 符号 + 类型色令牌；未知扩展名回退 fileUnknown（不阻止上传与元信息展示）。 */
export function fileTypeGlyph(type: string): { icon: IconName; token: string } {
  const ext = String(type || "").toLowerCase().replace(/^\./, "");
  return FILE_TYPE_GLYPHS[ext] ?? { icon: "fileUnknown", token: "unknown" };
}

/* ---------------- 用户头像（品牌帆船 Logo，5 种容器风格） ---------------- */
/* ---------------- 图标悬浮层（CR-070 / UI-CR070-v1） ---------------- */

/**
 * 项目/知识库图标悬浮层：点击卡片图标砖打开。
 * 顶部对象名 + 组合预览；「选择颜色」10 整块色卡一行（+清空回默认）；
 * 「选择图标」50 个 6 组网格（+默认格）；选择即时预览，保存成对回调 icon+iconColor。
 * 关闭按钮 / 遮罩按下 / Escape 均视为取消，不落库；正文超高时滚动，
 * 滚动条显隐由 UI-SCROLL-001 共享机制（scrollbar.ts + base.css）承担。
 */
export function IconPopover({ open, title, kind, icon, color, onSave, onClose }: {
  open: boolean;
  title: string;
  kind: "project" | "kb";
  /** 当前已保存图标（null=类型/来源默认）。 */
  icon: string | null;
  /** 当前已保存色卡（null=默认色）。 */
  color: string | null;
  onSave: (icon: string | null, color: string | null) => void;
  onClose: () => void;
}) {
  const [iconDraft, setIconDraft] = useState<string | null>(icon);
  const [colorDraft, setColorDraft] = useState<string | null>(color);
  const popRef = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);

  // 打开时重置草稿为已保存值（同一实例复用于不同对象）。
  useEffect(() => {
    if (open) { setIconDraft(icon); setColorDraft(color); setSaving(false); }
  }, [open, icon, color]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    popRef.current?.querySelector<HTMLElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); if (!saving) onClose(); }
    };
    const press = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest(".icon-pop")) return;
      if (!saving) onClose();
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("mousedown", press, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("mousedown", press, true);
      previous?.focus();
    };
  }, [open, onClose, saving]);

  if (!open) return null;
  const fallbackIcon = kind === "kb" ? "library" : "code";
  const fallbackColor: IconColorId = kind === "kb" ? "teal" : "blue";
  const shownIcon = (iconDraft && PROJECT_ICON_IDS.includes(iconDraft) ? iconDraft : fallbackIcon) as IconName;
  const shownColor = normalizeIconColor(colorDraft, fallbackColor);
  const preview = <span className={`cr51-tile ${kind === "kb" ? "cr51-tile-kb" : ""} cr51-color-${shownColor}`}>
    <Icon name={shownIcon} size={20} />
  </span>;
  const previewLabel = `${ICON_LABELS[shownIcon] ?? "默认"} · ${colorDraft ? (shownColor) : "默认色"}`;
  return createPortal(
    <div className="icon-pop-mask" onMouseDown={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div ref={popRef} className="icon-pop" role="dialog" aria-modal="true" aria-label={`选择图标与颜色：${title}`}>
        <div className="icon-pop-h"><b className="ellipsis">{title}</b>
          <button type="button" className="btn icon ghost sm" aria-label="关闭" disabled={saving} onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="icon-pop-b">
          <div className="icon-pop-current">{preview}<span className="caption">{kind === "kb" ? "点击下方色卡或图标即时预览；清空回来源默认，背景回默认青绿。" : "点击下方色卡或图标即时预览；清空回类型默认，背景回默认色。"}</span></div>
          <div className="icon-pop-sec">选择颜色</div>
          <div className="cr51-swatches icon-pop-swatches" role="group" aria-label="背景色卡（10 色，无文字）">
            {ICON_COLORS.map(sw => <button key={sw.id} type="button" className={`cr51-swatch cr51-color-${sw.id}`}
              aria-pressed={colorDraft === sw.id} aria-label={`背景色 ${sw.id}`} title=""
              disabled={saving} onClick={() => setColorDraft(sw.id)} />)}
            <button type="button" className="cr51-swatch cr51-swatch-clear" aria-pressed={colorDraft === null}
              aria-label="背景色回默认" title="清空回默认色" disabled={saving} onClick={() => setColorDraft(null)}>
              <Icon name="x" size={12} />
            </button>
          </div>
          <div className="icon-pop-sec">选择图标</div>
          <div className="cr51-picker-groups icon-pop-groups" role="group" aria-label={`${kind === "kb" ? "知识库" : "项目"}图标选择`}>
            {ICON_GROUPS.map(group => <div key={group.name} className="cr51-picker-group">
              <div className="cr51-picker-group-h"><b>{group.name}</b><span>{group.hint} · {group.icons.length}</span></div>
              <div className="cr51-picker">
                {group.icons.map(id => <button key={id} type="button" className="cr51-picker-cell" aria-pressed={iconDraft === id}
                  disabled={saving} onClick={() => setIconDraft(id)} title={ICON_LABELS[id] ?? id}>
                  <Icon name={id} size={20} /><span className="cr51-picker-name">{ICON_LABELS[id] ?? id}</span>
                </button>)}
              </div>
            </div>)}
            <button type="button" className="cr51-picker-cell cr51-picker-clear" aria-pressed={iconDraft === null}
              disabled={saving} onClick={() => setIconDraft(null)} title="清空回默认图标">
              <Icon name="x" size={14} /><span className="cr51-picker-name">默认</span>
            </button>
          </div>
        </div>
        <div className="icon-pop-f">
          <span className="caption">{previewLabel}；保存才生效，取消不改动。</span>
          <button type="button" className="btn" disabled={saving} onClick={onClose}>取消</button>
          <button type="button" className="btn primary" disabled={saving} onClick={() => { setSaving(true); onSave(iconDraft, colorDraft); }}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>, document.body);
}

/** 卡片图标砖的悬浮层触发按钮：图标与名称保持并排，点图标开悬浮层（CR-070）。 */
export function IconPopoverTrigger({ children, title, onOpen }: {
  children: React.ReactNode;
  title: string;
  onOpen: () => void;
}) {
  return <button type="button" className="icon-tile-btn" title={title} aria-label={title}
    onClick={e => { e.stopPropagation(); onOpen(); }}
    onKeyDown={e => { if (e.key === "Enter" || e.key === " ") e.stopPropagation(); }}>
    {children}
  </button>;
}

/* ---------------- 用户头像（品牌帆船 Logo，5 种容器风格） ---------------- */export const AVATAR_STYLE_IDS = ["a", "b", "c", "d", "e"] as const;
export type AvatarStyleId = (typeof AVATAR_STYLE_IDS)[number];
export const AVATAR_STYLE_LABELS: Record<AvatarStyleId, string> = {
  a: "A 原彩透明", b: "B 薄荷承载", c: "C 圆角方砖", d: "D 墨青实底", e: "E 双色光环",
};
/** r6：默认 B。 */
export const DEFAULT_AVATAR_STYLE: AvatarStyleId = "b";
export function normalizeAvatarStyle(value: string | null | undefined): AvatarStyleId {
  return AVATAR_STYLE_IDS.includes(value as AvatarStyleId) ? (value as AvatarStyleId) : DEFAULT_AVATAR_STYLE;
}

/** 用户头像：自定义图片优先，否则品牌帆船 Logo；容器风格由 [data-avatar-style] 承载。 */
export function UserAvatar({ size = 30, label, photo }: { size?: 24 | 26 | 30 | 34 | 72 | 96; label?: string; photo?: string | null }) {
  const hasPhoto = Boolean(photo);
  return <span className={`cr51-avatar${hasPhoto ? " has-photo" : ""}`} style={{ width: size, height: size }} aria-hidden={label ? undefined : true}>
    <img src={photo || "/brand/logo-sail.png"} alt={label ?? ""} draggable={false} />
  </span>;
}
