import { useEffect, useRef, useState } from "react";
import { getSetting } from "@/api";
import { UserAvatar } from "@/components/icon-tiles";
import { useAvatarPhoto } from "@/components/avatar";
import { usePaneWidth, ResizeHandle } from "@/components/pane-resize";
import { SettingsGeneral } from "./SettingsGeneral";
import { SettingsModels } from "./SettingsModels";
import { SettingsModelProbe } from "./SettingsModelProbe";
import { SettingsSdk } from "./SettingsSdk";
import { SettingsSkill } from "./SettingsSkill";
import { SettingsMcp } from "./SettingsMcp";
import { SettingsTool } from "./SettingsTool";
import { SettingsSearch } from "./SettingsSearch";
import { SettingsConfirm, SettingsIcon } from "./SettingsDialog";
import "./settings.css";
import "./cr085-abilities.css";

const TABS = [
  { id: "general", label: "通用", icon: "settings", sub: "用户信息、代码样式与服务器默认值。" },
  { id: "models", label: "模型管理", icon: "cpu", sub: "供应商、密钥、端点与模型配置。" },
  { id: "probe", label: "模型检测", icon: "shield", sub: "固定 20 针黑盒探针，检测模型是否被中转掺水。" },
  { id: "sdk", label: "SDK 与 CLI", icon: "terminal", sub: "CLI 管理与 SDK 管理。" },
  { id: "skill", label: "能力 · Skill", icon: "layers", sub: "技能是过程性指令；启用不等于授权执行。" },
  { id: "mcp", label: "能力 · MCP", icon: "box", sub: "MCP 服务器发现工具与资源。" },
  { id: "tool", label: "能力 · Tools", icon: "zap", sub: "内置工具与风险等级。" },
  { id: "search", label: "搜索", icon: "zap", sub: "本地授权目录与联网搜索后端。" },
];
const normalizeTab = (tab: string) => ({ cli: "sdk", skills: "skill", tools: "tool" }[tab] || (TABS.some(t => t.id === tab) ? tab : "general"));

export function SettingsCenter(props: { initialTab: string; onOpenTab: (tab: string) => void; onClose: () => void }) {
  const [tab, setTab] = useState(normalizeTab(props.initialTab));
  // CR-091：通用页有未保存改动时，关闭设置前先确认。
  const [generalDirty, setGeneralDirty] = useState({ dirty: false, count: 0 });
  const [confirmClose, setConfirmClose] = useState(false);
  useEffect(() => {
    const onDirty = (event: Event) => {
      const detail = (event as CustomEvent<{ dirty?: boolean; count?: number }>).detail;
      setGeneralDirty({ dirty: Boolean(detail?.dirty), count: Number(detail?.count ?? 0) });
    };
    window.addEventListener("settings:general-dirty", onDirty);
    return () => window.removeEventListener("settings:general-dirty", onDirty);
  }, []);
  const requestClose = () => {
    if (tab === "general" && generalDirty.dirty) setConfirmClose(true);
    else props.onClose();
  };
  const [profile, setProfile] = useState({ name: "", email: "" });
  // CR-051 r6：设置左栏头像与通用页/弹窗同源（自定义照片优先，默认品牌 Logo）。
  const settingsPhoto = useAvatarPhoto();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  // CR-068 S01：左分类导航常驻（不再提供右下角收展按钮），会话内残留的折叠状态不再生效。
  const navigation = usePaneWidth("settings", "navigation", { default: 224, min: 176, max: 320, side: "left", containerRef: layoutRef, minCenter: 320, visible: true });
  useEffect(() => setTab(normalizeTab(props.initialTab)), [props.initialTab]);
  useEffect(() => {
    const dialog = dialogRef.current;
    // CR-068 S02：关闭后焦点回到打开前的入口（X／Escape／遮罩三条路径共用）。
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    let alive = true;
    Promise.all([getSetting("user.name"), getSetting("user.email")]).then(([name, email]) => {
      if (alive) setProfile({ name: name || "", email: email || "" });
    }).catch(() => {});
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ profile?: { name: string; email: string } }>).detail;
      if (detail?.profile) setProfile({ name: detail.profile.name, email: detail.profile.email });
    };
    window.addEventListener("app:settings-changed", changed);
    return () => { alive = false; window.removeEventListener("app:settings-changed", changed); };
  }, []);
  const selected = TABS.find(t => t.id === tab)!;
  const open = (id: string) => { setTab(id); props.onOpenTab(id); };
  useEffect(() => {
    const listener = (e: Event) => { const next=(e as CustomEvent<{tab?:string}>).detail?.tab;if(next){setTab(normalizeTab(next));props.onOpenTab(normalizeTab(next));} };
    window.addEventListener('settings:open-tab',listener);
    return ()=>window.removeEventListener('settings:open-tab',listener);
  },[props.onOpenTab]);
  return <dialog ref={dialogRef} className="set-modal" aria-label="设置与账户" onCancel={(e) => { e.preventDefault(); requestClose(); }} onMouseDown={(e) => {
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) requestClose();
  }}>
    <div className="set-shell pane-container" ref={layoutRef}>
      <nav {...navigation.paneProps} className={`${navigation.paneProps.className} set-nav`} style={navigation.style} aria-label="设置分类">
        <div className="set-user"><UserAvatar size={34} photo={settingsPhoto} /><div><b>{profile.name || "未设置名称"}</b><span>{profile.email || "未设置邮箱"}</span></div></div>
        <div className="set-nav-list">{TABS.map(t => <button key={t.id} className={`set-nav-btn ${tab === t.id ? "active" : ""}`} aria-current={tab === t.id ? "page" : undefined} onClick={() => open(t.id)}><SettingsIcon name={t.icon} />{t.label}</button>)}</div>
        <ResizeHandle pane={navigation} label="设置分类" />
      </nav>
      <section className="set-body">
        {/* CR-068 S01/S04：头部只放标题与说明。模型页生图图标若接到本行，按设计位于最右业务位（CSS margin-left:auto），
            头部右侧预留 58px，右上 X 独立定位在 14px，两者不重叠。 */}
        <div className="set-head"><div><h2>{selected.label}</h2></div>
          {tab === "models" && <div className="row cr085-head-actions"><button type="button" className="btn sm primary" onClick={() => window.dispatchEvent(new CustomEvent("settings:new-provider"))}><SettingsIcon name="plus" />新增供应商</button><button type="button" className="set-icon-btn set-head-imagegen" onClick={() => window.dispatchEvent(new CustomEvent("settings:open-imagegen"))} title="生图配置" aria-label="生图配置"><SettingsIcon name="image" /></button></div>}
        </div>
        <div className="set-scroll">
          <div hidden={tab !== "general"}><SettingsGeneral /></div>
          <div hidden={tab !== "models"}><SettingsModels /></div>
          {/* CR-058：模型检测十九针探针（左栏「模型管理」下方独立页签）。 */}
          <div hidden={tab !== "probe"}><SettingsModelProbe /></div>
          <div hidden={tab !== "sdk"}><SettingsSdk /></div>
          <div hidden={tab !== "skill"}><SettingsSkill /></div>
          <div hidden={tab !== "mcp"}><SettingsMcp /></div>
          <div hidden={tab !== "tool"}><SettingsTool /></div>
          <div hidden={tab !== "search"}><SettingsSearch /></div>
        </div>
      </section>
      {/* CR-068 S01/S02：右上角 X 关闭；左栏不再有「设置与账户」文案与关闭按钮。 */}
      <button type="button" className="set-icon-btn set-close" aria-label="关闭设置" title="关闭设置" onClick={requestClose}><SettingsIcon name="close" /></button>
      {confirmClose && <SettingsConfirm title="放弃未保存的更改？" message={`通用页有 ${generalDirty.count} 项更改尚未保存，关闭后不会写入。`}
        onCancel={() => setConfirmClose(false)}
        onOk={() => { setConfirmClose(false); props.onClose(); }} />}
    </div>
  </dialog>;
}
