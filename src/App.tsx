import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "@/api";
import { useApp, routeKey } from "@/store/app";
import type { Route } from "@/store/app";
import { Modal } from "@/components/ui";
import { Icon } from "@/components/icons";
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

const NAV_ITEMS = [
  { page: "workbench", label: "工作台", icon: "grid" },
  { page: "projects", label: "项目管理", icon: "folder" },
  { page: "knowledge", label: "知识库", icon: "book" },
  { page: "servers", label: "服务器管理", icon: "server" },
] as const;

export default function App() {
  const { route, go, openObject, windows, activateWindow, closeWindow, settingsOpen, setSettingsOpen, theme, toggleTheme } = useApp();
  const chrome = useWindowChrome();
  const openProject = (project: api.Project, tab: "requirements" | "design" | "tasks" | "code") => openObject({ page: "project", projectId: project.id, tab });
  const [settingsTab, setSettingsTab] = useState("general");
  const [projects, setProjects] = useState<api.Project[]>([]);
  const [libraries, setLibraries] = useState<api.KnowledgeLibrary[]>([]);
  const [hosts, setHosts] = useState<api.ServerHost[]>([]);
  const [profile, setProfile] = useState({ name: "未设置", email: "", role: "个人工作台" });
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [closingTab, setClosingTab] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.listProjects().then(setProjects).catch(() => {});
    api.kbList().then(setLibraries).catch(() => {});
    api.serverList().then(setHosts).catch(() => {});
    Promise.all([api.getSetting("user.name"), api.getSetting("user.email"), api.getSetting("user.role")])
      .then(([name, email, role]) => setProfile({ name: name || "未设置", email: email || "", role: role || "个人工作台" })).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const listener = () => refresh();
    window.addEventListener("app:settings-changed", listener);
    window.addEventListener("app:projects-changed", listener);
    return () => {
      window.removeEventListener("app:settings-changed", listener);
      window.removeEventListener("app:projects-changed", listener);
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

  const activePage = route.page === "project" ? "projects" : route.page === "knowledge-lib" ? "knowledge" : route.page === "server" ? "servers" : route.page;
  const windowTitle = (item: Route) => item.page === "project" ? projects.find(project => project.id === item.projectId)?.name ?? "项目"
    : item.page === "knowledge-lib" ? libraries.find(library => library.id === item.libId)?.name ?? "知识库"
      : item.page === "server" ? hosts.find(host => host.id === item.hostId)?.name ?? "服务器" : "工作台";
  const currentProject = route.page === "project" ? projects.find(project => project.id === route.projectId) : projects.find(project => project.kind === "code");
  const initials = profile.name === "未设置" ? "我" : Array.from(profile.name).slice(0, 2).join("");
  const preview = (window as Window & { __DESIGN_PREVIEW__?: boolean }).__DESIGN_PREVIEW__ === true;
  const detail = routeKey(route) !== "home";

  return (
    <div className={`nc-app ${detail ? "object-detail" : ""} ${chrome.focused ? "" : "window-unfocused"}`} data-preview={preview || undefined}>
      <header className="topbar nc-topbar">
        <div className="brand nc-brand" aria-label="栖造 NestCraft">
          <span className="brand-mark"><img src="/brand/logo-sail.png" alt="栖造青绿色帆船 Logo" /></span>
          <span className="brand-copy"><b>栖造</b><span>NESTCRAFT</span></span>
        </div>
        <span className="nc-top-sep" />
        <span className="nc-context">个人工作台<span>/</span>{route.page === "project" || route.page === "server" || route.page === "knowledge-lib" ? windowTitle(route) : NAV_ITEMS.find(item => item.page === activePage)?.label}</span>
        <div className="nc-window-drag" title={chrome.native ? "拖动窗口；双击最大化或还原" : "窗口拖动热区（预览）"} onPointerDown={event => { if (event.button === 0 && event.detail < 2) void chrome.act("drag"); }} onDoubleClick={() => void chrome.act("maximize")} />
        <button className="nc-searchbox" onClick={() => setSearchOpen(true)}><Icon name="search" />搜索项目、需求、文档<kbd>Ctrl K</kbd></button>
        <button className="chat-iconbtn" aria-label="切换主题" title="切换主题" onClick={toggleTheme}><Icon name={theme === "dark" ? "sun" : "moon"} /></button>
        <button className="chat-iconbtn" aria-label="通知" title="通知" onClick={() => setNotificationsOpen(true)}><Icon name="bell" /></button>
        <button className="nc-avatar" aria-label="设置与账户" onClick={() => setSettingsOpen(true)}>{initials}</button>
        <span className="nc-window-sep" />
        <div className="nc-window-controls" aria-label={chrome.native ? "窗口控制" : "窗口控制（预览）"}>
          <button className="nc-window-control" aria-label="最小化" title="最小化" onClick={() => void chrome.act("minimize")}><Icon name="minimize" size={14} /></button>
          <button className="nc-window-control" aria-label={chrome.maximized ? "还原" : "最大化"} title={chrome.maximized ? "还原" : "最大化"} onClick={() => void chrome.act("maximize")}><Icon name={chrome.maximized ? "restore" : "maximize"} size={14} /></button>
          <button className="nc-window-control window-close" aria-label="关闭窗口" title="关闭窗口" onClick={() => void chrome.act("close")}><Icon name="close" size={14} /></button>
        </div>
      </header>
      <nav className="nc-window-tabs" aria-label="首页与打开的对象">
        {windows.filter(window => window.open !== false).map(window => <div key={window.key} className={`nc-window-tab ${window.key === "home" ? "home-tab" : ""} ${routeKey(route) === window.key ? "active" : ""}`}>
          <button className="nc-tab-focus" onClick={() => activateWindow(window.key)}><Icon name={window.key === "home" ? "home" : window.route.page === "project" ? "folder" : window.route.page === "knowledge-lib" ? "book" : "server"} size={14} />{window.key === "home" ? "首页" : windowTitle(window.route)}</button>
          {window.key !== "home" && <button className="nc-tab-close" aria-label={`关闭 ${windowTitle(window.route)}`} title="关闭此Tab，保留内存状态" onClick={() => setClosingTab(window.key)}><Icon name="close" size={13} /></button>}
        </div>)}
      </nav>
      <div className="nc-body">
        <aside className="sidebar nc-sidebar" hidden={detail}>
          <div className="nav-label">工作空间</div>
          {NAV_ITEMS.map(item => (
            <button key={item.page} className={`nav-item ${activePage === item.page ? "active" : ""}`} onClick={() => go({ page: item.page })}>
              <Icon name={item.icon} /><span>{item.label}</span>
              {item.page !== "workbench" && <span className="nc-nav-count">{item.page === "projects" ? projects.length : item.page === "knowledge" ? libraries.length : hosts.length}</span>}
            </button>
          ))}
          <div className="nav-label nc-nav-section">当前项目</div>
          {currentProject ? <button className="nc-side-project" onClick={() => openProject(currentProject, currentProject.kind === "work" ? "code" : "requirements")}>
            <span className="nc-project-avatar">{Array.from(currentProject.name).slice(0, 2).join("")}</span>
            <span className="grow"><b>{currentProject.name}</b><small title={currentProject.rootUri}>{currentProject.rootUri}</small></span>
          </button> : <span className="nc-side-empty">尚未打开项目</span>}
          <div className="nav-label nc-nav-section">快捷入口</div>
          <button className="nav-item" onClick={() => currentProject ? go({ page: "project", projectId: currentProject.id, tab: "tasks" }) : go({ page: "projects" })}><Icon name="grid" /><span>运行队列</span></button>
          <button className="nav-item" onClick={() => currentProject ? go({ page: "project", projectId: currentProject.id, tab: "design" }) : go({ page: "projects" })}><Icon name="book" /><span>设计资料</span></button>
          <button className="nc-side-user" onClick={() => setSettingsOpen(true)} aria-label="设置与账户">
            <span className="nc-avatar">{initials}</span><span className="grow"><b>{profile.name}</b><small>{profile.role} · 设置与账户</small></span><Icon name="settings" size={15} />
          </button>
        </aside>
        <main className="main nc-main">
          <div className="nc-window-content">
            {windows.map(window => <section key={window.key} className="nc-window-pane" hidden={routeKey(route) !== window.key}>
              <WindowContent route={window.route} visible={routeKey(route) === window.key} />
            </section>)}
          </div>
          {preview && <div className="nc-preview-note">合成仿真 · 隔离内存数据，不连接真实 CLI／SSH／供应商</div>}
        </main>
      </div>
      {settingsOpen && <SettingsCenter initialTab={settingsTab} onOpenTab={setSettingsTab} onClose={() => setSettingsOpen(false)} />}
      {searchOpen && <Modal title="搜索项目、需求、文档" onClose={() => setSearchOpen(false)} width={620}>
        <input className="input" autoFocus placeholder="搜索项目名称" value={search} onChange={event => setSearch(event.target.value)} />
        <div className="nc-search-results">{projects.filter(project => project.name.toLowerCase().includes(search.toLowerCase())).map(project => <button key={project.id} className="nc-list-row" onClick={() => {
          openObject({ page: "project", projectId: project.id, tab: project.kind === "work" ? "code" : "requirements" }); setSearchOpen(false);
        }}>{project.name}<small>{project.kind === "code" ? "编码" : "办公"}</small></button>)}</div>
      </Modal>}
      {closingTab && <Modal title="关闭对象 Tab？" width={460} onClose={() => setClosingTab(null)} footer={<><button className="btn" onClick={() => setClosingTab(null)}>取消，保留 Tab</button><button className="btn primary" onClick={() => { closeWindow(closingTab); setClosingTab(null); }}>保留状态并关闭 Tab</button></>}><p>关闭只移除此 Tab，内存中的未保存内容和会话实例保留，重新打开可继续查看；不删除文件，不停止会话或连接。内存状态在退出应用后仍会丢失，请先保存重要内容。</p></Modal>}
      {chrome.closeToken && <Modal title="关闭栖造窗口？" width={460} onClose={() => void chrome.cancelClose()} footer={<><button className="btn" onClick={() => void chrome.cancelClose()}>取消，继续编辑</button><button className="btn danger" onClick={() => void chrome.confirmClose()}>确认退出</button></>}><p>退出会结束当前应用，尚未保存的编辑和内存仿真草稿可能丢失，正在运行的本机会话也会随进程结束。此操作不会删除项目目录。若需要保存，请取消并先保存。</p>{chrome.error && <p role="alert">{chrome.error}</p>}</Modal>}
      {chrome.error && !chrome.closeToken && <div className="nc-window-error" role="status">{chrome.error}<button aria-label="关闭窗口操作提示" onClick={chrome.clearError}><Icon name="close" size={14} /></button></div>}
      {notificationsOpen && <Modal title="通知" width={460} onClose={() => setNotificationsOpen(false)}><p>目前没有可读取的系统通知。项目的待处理需求在工作台中查看。</p></Modal>}
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

function ProjectWindow({ projectId, tab, visible }: { projectId: string; tab: "requirements" | "design" | "tasks" | "code"; visible: boolean }) {
  const { aiVisible, aiWidth, setAiWidth } = useApp();
  const [project, setProject] = useState<api.Project | null>(null);
  const officeVersion = useOfficeVersion();
  const preferencesRef = useRef({ visible: aiVisible, width: aiWidth });
  if (visible) preferencesRef.current = { visible: aiVisible, width: aiWidth };
  const preferences = preferencesRef.current;
  useEffect(() => {
    let alive = true;
    api.listProjects().then(projects => { if (alive) setProject(projects.find(project => project.id === projectId) ?? null); }).catch(() => {});
    return () => { alive = false; };
  }, [projectId]);
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const initialX = event.clientX;
    const initialWidth = preferences.width;
    const move = (event: PointerEvent) => setAiWidth(initialWidth + initialX - event.clientX);
    const finish = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    event.preventDefault();
  };
  const officeFiles = project?.kind === "work" ? officeFileList(project.id) : undefined;
  void officeVersion;
  return (
    <div className="nc-project-window">
      <div className="nc-project-content"><ProjectsModule.Workspace projectId={projectId} tab={tab} visible={visible} /></div>
      {project && <aside className="nc-chat-host" style={{ width: preferences.width }} hidden={!preferences.visible}>
        <div className="nc-chat-resize" role="separator" aria-orientation="vertical" aria-label="调整 AI 侧栏宽度" title="拖动调整宽度" onPointerDown={startResize} />
        <ChatPanel projectId={project.id} rootUri={project.rootUri} office={project.kind === "work"} officeFiles={officeFiles} visible={visible && preferences.visible} width={preferences.width} />
      </aside>}
    </div>
  );
}
