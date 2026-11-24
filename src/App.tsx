import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "@/api";
import { useApp, routeKey } from "@/store/app";
import type { Route } from "@/store/app";
import { Modal } from "@/components/ui";
import { Icon } from "@/components/icons";
import { UserAvatar, normalizeAvatarStyle, type AvatarStyleId } from "@/components/icon-tiles";
import { AvatarHoverEdit } from "@/components/avatar";
import { usePaneWidth, ResizeHandle, PaneToggle } from "@/components/pane-resize";
import { TabMoreDropdown, TabMoreIcon, useTabOverflow } from "@/components/tab-overflow";
import { useWindowChrome } from "@/store/window-chrome";
import { WorkbenchHome } from "@/modules/WorkbenchHome";
import { ChatPanel } from "@/modules/chat/ChatPanel";
import { officeFileList } from "@/modules/office/office-model";
import { useOfficeVersion } from "@/modules/office/OfficeFileTree";
import { onLocate } from "@/modules/locate";
import * as ProjectsModule from "@/modules/projects";
import * as KnowledgeModule from "@/modules/knowledge";
import * as ServersModule from "@/modules/servers";
import { SettingsCenter } from "@/modules/settings";
import { UpdateBadge } from "@/modules/update/UpdateBadge";

const NAV_ITEMS = [
  { page: "workbench", label: "工作台", icon: "grid" },
  { page: "projects", label: "项目管理", icon: "folder" },
  { page: "knowledge", label: "知识库", icon: "book" },
  { page: "servers", label: "服务器管理", icon: "server" },
] as const;

export default function App() {
  const { route, go, openObject, windows, activateWindow, closeWindow, settingsOpen, setSettingsOpen, theme, toggleTheme } = useApp();
  const chrome = useWindowChrome();
  const [settingsTab, setSettingsTab] = useState("general");
  const [projects, setProjects] = useState<api.Project[]>([]);
  const [libraries, setLibraries] = useState<api.KnowledgeLibrary[]>([]);
  const [hosts, setHosts] = useState<api.ServerHost[]>([]);
  const [profile, setProfile] = useState({ name: "未设置", email: "", role: "个人工作台" });
  // CR-051：头像风格偏好（a–e，缺省 b）与自定义头像，作用于顶栏、侧栏与设置三处。
  const [avatarStyle, setAvatarStyle] = useState<AvatarStyleId>("b");
  const [avatarPhoto, setAvatarPhoto] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  /* CR-059 二期：内置 AI 工具（ssh_exec）的高风险命令跨进程审批。
     工具进程把待批请求写入共享 SQLite，这里轮询并在界面弹出审批卡片。 */
  const [approvals, setApprovals] = useState<api.PendingApproval[]>([]);
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const [closingTab, setClosingTab] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const navigation = usePaneWidth("home", "navigation", { default: 224, min: 176, max: 320, side: "left", containerRef: bodyRef, minCenter: 480, disabled: routeKey(route) !== "home" });

  const refresh = useCallback(() => {
    api.listProjects().then(setProjects).catch(() => {});
    api.kbList().then(setLibraries).catch(() => {});
    api.serverList().then(setHosts).catch(() => {});
    api.getAvatarStyle().then(style => setAvatarStyle(normalizeAvatarStyle(style))).catch(() => {});
    api.getAvatarImage().then(img => setAvatarPhoto(api.avatarPhotoSrc(img?.path))).catch(() => {});
    Promise.all([api.getSetting("user.name"), api.getSetting("user.email"), api.getSetting("user.role")])
      .then(([name, email, role]) => setProfile({ name: name || "未设置", email: email || "", role: role || "个人工作台" })).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const listener = () => refresh();
    window.addEventListener("app:settings-changed", listener);
    window.addEventListener("app:projects-changed", listener);
    window.addEventListener("app:avatar-changed", listener);
    return () => {
      window.removeEventListener("app:settings-changed", listener);
      window.removeEventListener("app:projects-changed", listener);
      window.removeEventListener("app:avatar-changed", listener);
    };
  }, [refresh]);

  useEffect(() => {
    void import("@/modules/office/office-seed").then(module => module.ensureOfficeDemoProjects()).then(refresh).catch(() => {});
  }, [refresh]);

  useEffect(() => onLocate(detail => {
    if ((detail.kind === "file" || detail.kind === "requirement") && detail.projectId) {
      const key = `project:${detail.projectId}`;
      const window = windows.find(window => window.key === key);
      if (window?.route.page === "project") {
        activateWindow(key);
        go({ ...window.route, tab: detail.kind === "file" ? "code" : "requirements" });
      }
    } else if (detail.kind === "office-file" && detail.projectId) {
      activateWindow(`project:${detail.projectId}`);
    }
  }), [windows, activateWindow, go]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  /* CR-059 二期：轮询待审批命令（3 秒）。失败静默——审批不是主流程，不打扰用户。 */
  useEffect(() => {
    let alive = true;
    const poll = () => {
      api.serverPendingApprovals()
        .then(list => { if (alive) setApprovals(previous => (JSON.stringify(previous) === JSON.stringify(list) ? previous : list)); })
        .catch(() => {});
    };
    poll();
    const timer = window.setInterval(poll, 3000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  const decideApproval = async (item: api.PendingApproval, decision: "approve" | "reject") => {
    if (approvalBusy) return;
    setApprovalBusy(item.id);
    try {
      await api.serverDecideApproval(item.id, decision);
      setApprovals(previous => previous.filter(entry => entry.id !== item.id));
    } catch (e) {
      // 过期/已处理：从列表移除并如实提示。
      setApprovals(previous => previous.filter(entry => entry.id !== item.id));
      window.alert(String(e instanceof Error ? e.message : e));
    } finally {
      setApprovalBusy(null);
    }
  };

  const activePage = route.page === "project" ? "projects" : route.page === "knowledge-lib" ? "knowledge" : route.page === "server" ? "servers" : route.page;
  const windowTitle = (item: Route) => item.page === "project" ? projects.find(project => project.id === item.projectId)?.name ?? "项目"
    : item.page === "knowledge-lib" ? libraries.find(library => library.id === item.libId)?.name ?? "知识库"
      : item.page === "server" ? hosts.find(host => host.id === item.hostId)?.name ?? "服务器" : "工作台";
  // CR-052 / UI-TAB-001：对象窗口页签溢出统一走共享「更多」下拉，不出现横向滚动条。
  const openWindows = windows.filter(window => window.open !== false);
  const windowTabItems = openWindows.map(window => ({ key: window.key, label: window.key === "home" ? "首页" : windowTitle(window.route), active: routeKey(route) === window.key }));
  const windowTabSig = windowTabItems.map(item => `${item.key}:${item.label}:${item.active ? 1 : 0}`).join("|");
  const windowTabsOverflow = useTabOverflow<HTMLElement>({ tabSelector: ".nc-window-tab", items: windowTabItems, deps: [windowTabSig] });
  const preview = (window as Window & { __DESIGN_PREVIEW__?: boolean }).__DESIGN_PREVIEW__ === true;
  const detail = routeKey(route) !== "home";

  return (
    <div className={`nc-app ${detail ? "object-detail" : ""} ${chrome.focused ? "" : "window-unfocused"}`} data-preview={preview || undefined} data-avatar-style={avatarStyle}>
      <header className="topbar nc-topbar">
        <div className="brand nc-brand" aria-label="栖造 NestCraft">
          <span className="brand-mark"><img src="/brand/logo-sail.png" alt="栖造青绿色帆船 Logo" /></span>
          <span className="brand-copy"><b>栖造</b><span>NESTCRAFT</span></span>
        </div>
        <span className="nc-top-sep" />
        <span className="nc-context">个人工作台<span>/</span>{route.page === "project" || route.page === "server" || route.page === "knowledge-lib" ? windowTitle(route) : NAV_ITEMS.find(item => item.page === activePage)?.label}</span>
        <div className="nc-window-drag" title={chrome.native ? "拖动窗口；双击最大化或还原" : "窗口拖动热区（预览）"} onPointerDown={event => { if (event.button === 0 && event.detail < 2) void chrome.act("drag"); }} onDoubleClick={() => void chrome.act("maximize")} />
        <UpdateBadge />
        <button className="chat-iconbtn" aria-label="切换主题" title="切换主题" onClick={toggleTheme}><Icon name={theme === "dark" ? "sun" : "moon"} /></button>
        <button className="chat-iconbtn" aria-label="通知" title="通知" onClick={() => setNotificationsOpen(true)}><Icon name="bell" /></button>
        {/* CR-070：顶栏右上角头像删除；设置与头像编辑统一走侧栏底部头像入口。 */}
        <span className="nc-window-sep" />
        <div className="nc-window-controls" aria-label={chrome.native ? "窗口控制" : "窗口控制（预览）"}>
          <button className="nc-window-control" aria-label="最小化" title="最小化" onClick={() => void chrome.act("minimize")}><Icon name="minimize" size={14} /></button>
          <button className="nc-window-control" aria-label={chrome.maximized ? "还原" : "最大化"} title={chrome.maximized ? "还原" : "最大化"} onClick={() => void chrome.act("maximize")}><Icon name={chrome.maximized ? "restore" : "maximize"} size={14} /></button>
          <button className="nc-window-control window-close" aria-label="关闭窗口" title="关闭窗口" onClick={() => void chrome.act("close")}><Icon name="close" size={14} /></button>
        </div>
      </header>
      <nav ref={windowTabsOverflow.barRef} className="nc-window-tabs" aria-label="首页与打开的对象">
        {openWindows.map(window => <div key={window.key} className={`nc-window-tab ${window.key === "home" ? "home-tab" : ""} ${routeKey(route) === window.key ? "active" : ""}`}>
          <button className="nc-tab-focus" onClick={() => activateWindow(window.key)}><Icon name={window.key === "home" ? "home" : window.route.page === "project" ? "folder" : window.route.page === "knowledge-lib" ? "book" : "server"} size={14} />{window.key === "home" ? "首页" : windowTitle(window.route)}</button>
          {window.key !== "home" && <button className="nc-tab-close" aria-label={`关闭 ${windowTitle(window.route)}`} title="关闭此Tab，保留内存状态" onClick={() => setClosingTab(window.key)}><Icon name="close" size={13} /></button>}
        </div>)}
        <button {...windowTabsOverflow.moreProps}><TabMoreIcon /></button>
      </nav>
      {windowTabsOverflow.dropdownOpen && <TabMoreDropdown anchorRef={windowTabsOverflow.moreRef} items={windowTabItems} onPick={key => activateWindow(key)} onClose={windowTabsOverflow.closeDropdown} />}
      <div className="nc-body pane-container" ref={bodyRef}>
        <aside {...navigation.paneProps} className={`${navigation.paneProps.className} sidebar nc-sidebar`} hidden={detail || !navigation.visible} style={{ ...navigation.style, flexBasis: navigation.width }}>
          <div className="nav-label">工作空间</div>
          {NAV_ITEMS.map(item => (
            <button key={item.page} className={`nav-item ${activePage === item.page ? "active" : ""}`} onClick={() => go({ page: item.page })}>
              <Icon name={item.icon} /><span>{item.label}</span>
              {item.page !== "workbench" && <span className="nc-nav-count">{item.page === "projects" ? projects.length : item.page === "knowledge" ? libraries.length : hosts.length}</span>}
            </button>
          ))}
          {/* CR-070：侧栏「当前项目」「快捷入口」分区删除；仅保留工作空间导航与底部头像入口。 */}
          <span className="cr51-avatar-frame nc-side-avatar-frame">
            <button className="nc-side-user" onClick={() => setSettingsOpen(true)} aria-label="设置与账户">
              <UserAvatar size={30} photo={avatarPhoto} /><span className="grow"><b>{profile.name}</b><small>{profile.role}</small></span><Icon name="settings" size={15} />
            </button>
            <AvatarHoverEdit style={normalizeAvatarStyle(avatarStyle)} photo={avatarPhoto}
              onApply={next => { setAvatarStyle(next.style); setAvatarPhoto(api.avatarPhotoSrc(next.photo)); }} />
          </span>
          <ResizeHandle pane={navigation} label="管理导航" />
        </aside>
        <main className="main nc-main">
          <div className="nc-window-content">
            {windows.map(window => <section key={window.key} className="nc-window-pane" hidden={routeKey(route) !== window.key}>
              <WindowContent route={window.route} visible={routeKey(route) === window.key} />
            </section>)}
          </div>
          {preview && <div className="nc-preview-note">合成仿真 · 隔离内存数据，不连接真实 CLI／SSH／供应商</div>}
        </main>
        {!detail && <div className="pane-controls"><PaneToggle pane={navigation} label="管理导航" /></div>}
      </div>
      {settingsOpen && <SettingsCenter initialTab={settingsTab} onOpenTab={setSettingsTab} onClose={() => setSettingsOpen(false)} />}
      {searchOpen && <Modal title="搜索项目、需求、文档" onClose={() => setSearchOpen(false)} width={620}>
        <input className="input" autoFocus placeholder="搜索项目名称" value={search} onChange={event => setSearch(event.target.value)} />
        <div className="nc-search-results">{projects.filter(project => project.name.toLowerCase().includes(search.toLowerCase())).map(project => <button key={project.id} className="nc-list-row" onClick={() => {
          openObject({ page: "project", projectId: project.id, tab: "workbench" }); setSearchOpen(false);
        }}>{project.name}<small>{project.kind === "code" ? "编码" : "办公"}</small></button>)}</div>
      </Modal>}
      {closingTab && <Modal title="关闭对象 Tab？" width={460} onClose={() => setClosingTab(null)} footer={<><button className="btn" onClick={() => setClosingTab(null)}>取消，保留 Tab</button><button className="btn primary" onClick={() => { closeWindow(closingTab); setClosingTab(null); }}>保留状态并关闭 Tab</button></>}><p>关闭只移除此 Tab，内存中的未保存内容和会话实例保留，重新打开可继续查看；不删除文件，不停止会话或连接。内存状态在退出应用后仍会丢失，请先保存重要内容。</p></Modal>}
      {chrome.closeToken && <Modal title="关闭栖造窗口？" width={460} onClose={() => void chrome.cancelClose()} footer={<><button className="btn" onClick={() => void chrome.cancelClose()}>取消，继续编辑</button><button className="btn danger" onClick={() => void chrome.confirmClose()}>确认退出</button></>}><p>退出会结束当前应用，尚未保存的编辑和内存仿真草稿可能丢失，正在运行的本机会话也会随进程结束。此操作不会删除项目目录。若需要保存，请取消并先保存。</p>{chrome.error && <p role="alert">{chrome.error}</p>}</Modal>}
      {chrome.error && !chrome.closeToken && <div className="nc-window-error" role="status">{chrome.error}<button aria-label="关闭窗口操作提示" onClick={chrome.clearError}><Icon name="close" size={14} /></button></div>}
      {notificationsOpen && <Modal title="通知" width={460} onClose={() => setNotificationsOpen(false)}><p>目前没有可读取的系统通知。项目的待处理需求在工作台中查看。</p></Modal>}
      {/* CR-059 二期：内置 AI 工具提交的高风险命令待审批。批准即执行，故给出完整命令与主机。 */}
      {approvals.length > 0 && <Modal title="高风险命令待审批" width={560} onClose={() => { /* 审批必须显式决定，不允许静默关闭 */ }} footer={<span className="small muted">批准后立即在对应主机执行一次；拒绝不执行。</span>}>
        <p className="small">AI 通过内置工具提交了 {approvals.length} 条高风险命令，需要你逐条决定。</p>
        {approvals.map(item => <div key={item.id} className="approval-card" style={{ marginBottom: 10 }}>
          <b>{item.hostName ?? item.hostId} · 高风险</b>
          <pre className="mono small" style={{ whiteSpace: "pre-wrap", margin: "6px 0" }}>{item.command}</pre>
          <div className="row">
            <button className="btn danger sm" disabled={approvalBusy === item.id} onClick={() => void decideApproval(item, "approve")}>{approvalBusy === item.id ? "处理中…" : "批准执行"}</button>
            <button className="btn sm" disabled={approvalBusy === item.id} onClick={() => void decideApproval(item, "reject")}>拒绝</button>
            <span className="small muted">提交于 {new Date(item.createdAt).toLocaleTimeString()}，10 分钟内有效</span>
          </div>
        </div>)}
      </Modal>}
    </div>
  );
}

function WindowContent({ route, visible }: { route: Route; visible: boolean }) {
  if (route.page === "project") return <ProjectWindow projectId={route.projectId} tab={route.tab} visible={visible} />;
  if (route.page === "knowledge-lib") return <KnowledgeModule.Reader libId={route.libId} noteId={route.noteId} visible={visible} />;
  if (route.page === "server") return <ServersModule.Workbench hostId={route.hostId} visible={visible} />;
  return <HomeWindow route={route} visible={visible} />;
}

function HomeWindow({ route, visible }: { route: Route; visible: boolean }) {
  return <div className="nc-home-window">
    <section hidden={route.page !== "workbench"}><WorkbenchHome /></section>
    <section hidden={route.page !== "projects"}><ProjectsModule.Home /></section>
    <section hidden={route.page !== "knowledge"}><KnowledgeModule.Home /></section>
    <section hidden={route.page !== "servers"}><ServersModule.Home /></section>
  </div>;
}

function ProjectWindow({ projectId, tab, visible }: { projectId: string; tab: "workbench" | "requirements" | "design" | "tasks" | "code"; visible: boolean }) {
  const { aiVisible, aiWidth, setAiWidth, featureTargets } = useApp();
  const [project, setProject] = useState<api.Project | null>(null);
  const officeVersion = useOfficeVersion();
  const layoutRef = useRef<HTMLDivElement>(null);
  const ai = usePaneWidth(`project:${projectId}`, "ai", { default: 372, min: 320, max: 620, side: "right", containerRef: layoutRef, minCenter: 376, disabled: !visible });
  const preferencesRef = useRef({ visible: aiVisible, width: aiWidth });
  if (visible) preferencesRef.current = { visible: aiVisible, width: aiWidth };
  const preferences = preferencesRef.current;
  useEffect(() => {
    let alive = true;
    api.listProjects().then(projects => { if (alive) setProject(projects.find(project => project.id === projectId) ?? null); }).catch(() => {});
    return () => { alive = false; };
  }, [projectId]);
  useEffect(() => {
    if (!visible) return;
    setAiWidth(ai.preferred);
  }, [ai.preferred, setAiWidth, visible]);
  const officeFiles = project?.kind === "work" ? officeFileList(project.id) : undefined;
  void officeVersion;
  /* CR-054：工作台页签自带会话视图（全项目唯一的 ChatPanel）。
     此页签下不再渲染侧栏 ChatPanel，避免同一会话出现两个实例与两套流式订阅。 */
  const onWorkbench = tab === "workbench";
  const showSidebar = preferences.visible && ai.visible && !onWorkbench;
  return (
    <div className="nc-project-window pane-container" ref={layoutRef}>
      <div className="nc-project-content"><ProjectsModule.Workspace projectId={projectId} tab={tab} visible={visible} /></div>
      {project && showSidebar && <aside {...ai.paneProps} className={`${ai.paneProps.className} nc-chat-host`} style={ai.style}>
        <ResizeHandle pane={ai} label="AI 侧栏" />
        <ChatPanel projectId={project.id} rootUri={project.rootUri} office={project.kind === "work"} officeFiles={officeFiles} visible={visible && showSidebar} width={ai.width}
          featureTarget={featureTargets[project.id] ?? null} />
      </aside>}
      {project && onWorkbench && preferences.visible && <div className="pane-controls"><span className="nc-workbench-note" title="工作台已包含会话区，此页签不显示独立 AI 侧栏">会话区已合并在工作台</span></div>}
    </div>
  );
}
