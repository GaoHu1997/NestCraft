import { Icon } from "@/components/icons";
import { useEffect, useState } from "react";
import { Modal, useToast } from "@/components/ui";
import {
  buildTree,
  createFile,
  createFolder,
  filePath,
  folderPath,
  importFile,
  isLoaded,
  officeSubscribe,
  selectFile,
  selectFolder,
  setSearch,
  st,
  toggleFolder,
} from "./office-model";
import type { OfficeFile, TreeFolder } from "./office-model";
import { loadSample, sampleKindFor } from "./office-samples";

/**
 * 办公项目文件树（CR-043 §1 / UI-CR043 §1）：
 * - 260px 左栏：根行 + 目录/文件混排（目录在前），行高 30px、缩进 14px/级、单行省略、hover 完整路径；
 * - 顶部：新建文件夹 / 新建文件 / 添加资料；搜索按名称/路径，命中保留祖先，清空恢复展开；
 * - 弹窗显示父路径；空值/非法名/同名在弹窗内原位报错（不只 toast）；取消无副作用；
 * - 创建后展开父级并选中新节点；选中文件默认其父目录为新建落点；
 * - 只改内存，不创建真实磁盘目录（LLD-FEAT-006 §1 / CR-043 §1）。
 */

const FILE_GLYPH: Record<string, string> = {
  md: "fileText", docx: "fileWord", xlsx: "fileSheet", pptx: "fileSlides", pdf: "filePdf", txt: "fileText",
};

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

function FileGlyph({ name }: { name: string }) {
  const ext = extOf(name);
  return <span className={`office-glyph platform-glyph ${FILE_GLYPH[ext] ? `g-${ext}` : "g-bin"}`}><Icon name={FILE_GLYPH[ext] ?? "file"} size={14} /></span>;
}

function FolderGlyph({ open }: { open: boolean }) {
  return (
    <Icon name={open ? "folderOpen" : "folder"} size={14} aria-hidden />
  );
}

/** 订阅办公模型变更（树/查看器共用） */
export function useOfficeVersion(): number {
  const [ver, setVer] = useState(0);
  useEffect(() => officeSubscribe(() => setVer(v => v + 1)), []);
  return ver;
}

export function OfficeFileTree(props: { projectId: string; projectName: string }) {
  const ver = useOfficeVersion();
  const s = st(props.projectId);
  const toast = useToast();
  const [dialog, setDialog] = useState<null | "folder" | "new" | "import">(null);
  void ver;

  const { rootFiles, tree, visibleCount } = buildTree(props.projectId);
  const loaded = isLoaded(props.projectId);

  const renderFile = (f: OfficeFile, depth: number): React.ReactNode => (
    <li key={f.id} role="treeitem" aria-level={depth + 1} aria-selected={s.selectedFileId === f.id}>
      <div
        className={`office-tree-row file ${s.selectedFileId === f.id ? "selected" : ""}`}
        style={{ paddingLeft: depth * 14 + 18 }}
      >
        <button
          className="office-tree-label"
          title={`${filePath(props.projectId, f.id)}${f.draft != null ? "（有未保存草稿）" : ""}`}
          onClick={() => selectFile(props.projectId, f.id)}
        >
          <FileGlyph name={f.name} />
          <span>{f.name}</span>
          {f.draft != null ? <i className="office-dirty-dot" title="有未保存草稿">●</i> : f.versions > 0 ? <small>v{f.versions}</small> : null}
        </button>
      </div>
    </li>
  );

  const renderFolder = (node: TreeFolder): React.ReactNode => {
    const f = node.folder;
    const selected = s.selectedFolderId === f.id && !s.selectedFileId;
    const path = folderPath(props.projectId, f.id);
    return (
      <li key={f.id} role="treeitem" aria-level={node.depth + 1} aria-expanded={node.open} aria-selected={selected}>
        <div className={`office-tree-row folder ${selected ? "selected" : ""}`} style={{ paddingLeft: node.depth * 14 }}>
          <button
            className="office-tree-toggle"
            aria-label={node.open ? `折叠 ${f.name}` : `展开 ${f.name}`}
            onClick={() => toggleFolder(props.projectId, f.id)}
          >
            <Icon name={node.open ? "chevronDown" : "chevronRight"} size={13} />
          </button>
          <button className="office-tree-label" title={path || f.name} onClick={() => selectFolder(props.projectId, f.id)}>
            <FolderGlyph open={node.open} />
            <span>{f.name}</span>
          </button>
        </div>
        {node.open && (
          <ul role="group">
            {node.children.map(renderFolder)}
            {node.files.map(file => renderFile(file, node.depth + 1))}
          </ul>
        )}
      </li>
    );
  };

  const rootSelected = s.selectedFolderId === null && !s.selectedFileId;

  return (
    <aside className="office-files" aria-label="项目文件树">
      <div className="office-files-head">
        <b>文件</b>
        <span className="spacer" />
        <button className="chat-iconbtn" title="新建文件夹" aria-label="新建文件夹" onClick={() => setDialog("folder")}>
          <Icon name="folderPlus" size={14} />
        </button>
        <button className="chat-iconbtn" title="新建文件" aria-label="新建文件" onClick={() => setDialog("new")}>
          <Icon name="filePlus" size={14} />
        </button>
        <button className="chat-iconbtn" title="添加资料" aria-label="添加资料" onClick={() => setDialog("import")}>
          <Icon name="upload" size={14} />
        </button>
      </div>
      <label className="office-search">
        <Icon name="search" size={13} />
        <input
          value={s.search}
          placeholder="搜索文件或路径"
          aria-label="搜索文件或路径"
          onChange={e => setSearch(props.projectId, e.target.value)}
        />
        {s.search && (
          <button className="office-search-clear" aria-label="清空搜索" onClick={() => setSearch(props.projectId, "")}>
            <Icon name="x" size={12} />
          </button>
        )}
      </label>
      <div className="office-tree-scroll">
        <button
          className={`office-root-row ${rootSelected ? "selected" : ""}`}
          title="项目根目录"
          onClick={() => selectFolder(props.projectId, null)}
        >
          <FolderGlyph open />
          <b>{props.projectName}</b>
        </button>
        <ul className="office-file-tree" role="tree" aria-label="办公目录与文件">
          {tree.map(renderFolder)}
          {rootFiles.map(f => renderFile(f, 0))}
        </ul>
        {visibleCount === 0 && s.search && <p className="office-empty-note">没有匹配文件或目录</p>}
        {visibleCount === 0 && !s.search && loaded && <p className="office-empty-note">目录为空，可创建文件夹或添加资料</p>}
      </div>
      <div className="office-files-foot">
        <span>仿真样例 · {s.files.length} 文件 / {s.folders.length} 文件夹</span>
        {!loaded && (
          <button
            className="btn ghost sm"
            onClick={() => {
              const result = loadSample(props.projectId, sampleKindFor(props.projectName));
              toast(result ? "已载入演示样例（合成数据，不写磁盘）" : "当前项目已有内容，未覆盖文件或草稿", result ? "info" : "warn");
            }}
          >
            载入演示样例
          </button>
        )}
      </div>

      {dialog === "folder" && <FolderDialog projectId={props.projectId} onClose={() => setDialog(null)} />}
      {dialog === "new" && <FileDialog projectId={props.projectId} kind="new" onClose={() => setDialog(null)} />}
      {dialog === "import" && <FileDialog projectId={props.projectId} kind="import" onClose={() => setDialog(null)} />}
    </aside>
  );
}

/* ---------- 新建文件夹弹窗（父路径显示 + 原位报错） ---------- */

function FolderDialog(props: { projectId: string; onClose: () => void }) {
  const s = st(props.projectId);
  const [parentId] = useState(s.selectedFolderId);
  const parentPath = folderPath(props.projectId, parentId) || "项目根目录";
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const r = createFolder(props.projectId, parentId, name);
    if (!r.ok) {
      setError(r.error.message);
      return;
    }
    props.onClose();
  };
  return (
    <Modal
      title="新建文件夹"
      onClose={props.onClose}
      width={440}
      heightRatio={0.4}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>取消</button>
          <button className="btn primary" onClick={submit}>创建文件夹</button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <p className="small muted" style={{ margin: 0 }}>父目录：{parentPath}（只在当前项目的样例中创建，不修改磁盘）</p>
        {error && <div className="office-error" role="alert">{error}</div>}
        <label className="col" style={{ gap: 6 }}>
          <span className="small">文件夹名称</span>
          <input
            className="input"
            autoFocus
            maxLength={100}
            value={name}
            placeholder="例如：12月汇报"
            onChange={e => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={e => e.key === "Enter" && submit()}
          />
        </label>
      </div>
    </Modal>
  );
}

/* ---------- 新建文件 / 添加资料弹窗 ---------- */

function FileDialog(props: { projectId: string; kind: "new" | "import"; onClose: () => void }) {
  const s = st(props.projectId);
  const toast = useToast();
  const [parentId] = useState(s.selectedFolderId);
  const parentPath = folderPath(props.projectId, parentId) || "项目根目录";
  const [name, setName] = useState("");
  const [ext, setExt] = useState("md");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const extOptions = props.kind === "new" ? ["md", "docx", "txt", "xlsx", "pptx"] : ["md", "txt", "docx", "xlsx", "pptx", "pdf"];

  const submit = () => {
    const r =
      props.kind === "new"
        ? createFile(props.projectId, parentId, name, ext, content)
        : importFile(props.projectId, parentId, name, ext, content);
    if (!r.ok) {
      setError(r.error.message + (r.error.suggestion ? `（建议：${r.error.suggestion}）` : ""));
      return;
    }
    toast(props.kind === "new" ? "已创建草稿（内存样例，不写磁盘）" : "资料已添加（内存样例，不写磁盘）");
    props.onClose();
  };

  return (
    <Modal
      title={props.kind === "new" ? "新建文件" : "添加资料"}
      onClose={props.onClose}
      width={480}
      heightRatio={0.62}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>取消</button>
          <button className="btn primary" onClick={submit}>{props.kind === "new" ? "创建草稿" : "确认添加"}</button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <p className="small muted" style={{ margin: 0 }}>目标目录：{parentPath}（只在当前项目的样例中创建，不修改磁盘）</p>
        {error && <div className="office-error" role="alert">{error}</div>}
        <label className="col" style={{ gap: 6 }}>
          <span className="small">名称</span>
          <input
            className="input"
            autoFocus
            maxLength={100}
            value={name}
            placeholder="例如：调研报告"
            onChange={e => {
              setName(e.target.value);
              setError(null);
            }}
          />
        </label>
        <label className="col" style={{ gap: 6 }}>
          <span className="small">类型</span>
          <select className="input" value={ext} onChange={e => { setExt(e.target.value); setError(null); }}>
            {extOptions.map(x => (
              <option key={x} value={x}>{x}</option>
            ))}
          </select>
        </label>
        <label className="col" style={{ gap: 6 }}>
          <span className="small">初始内容</span>
          <textarea
            className="textarea"
            style={{ minHeight: 120 }}
            value={content}
            onChange={e => {
              setContent(e.target.value);
              setError(null);
            }}
            placeholder={props.kind === "new" ? "输入初始正文；留空则创建空白草稿" : "粘贴资料文本；仅作样例记录，不解析原件格式"}
          />
        </label>
        <p className="small muted" style={{ margin: 0 }}>
          {props.kind === "new"
            ? "新建文件进入所选目录；保存后才进入本会话成果，重启不保留。"
            : "导入资料为只读仿真对象；不是原生 Office 解析，可创建副本后编辑。"}
          表格用 Tab 分列、换行分行；PPT/PDF 用独立一行 --- 分页。不读取真实文件。
        </p>
      </div>
    </Modal>
  );
}
