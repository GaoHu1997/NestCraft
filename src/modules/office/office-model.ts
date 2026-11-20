/**
 * 办公项目内存模型（CR-043 / LLD-FEAT-006 §1）。
 * - Folder(id, projectId, parentId, name) + File.folderId；null 父节点代表项目根；
 * - 同父内文件与目录共用名称空间，归一化（NFC + 小写）冲突拒绝；跨目录同名允许；
 * - 不做真实磁盘目录创建、移动、递归删除：树操作只改内存，界面如实标注「仿真样例」；
 * - 折叠状态按项目保存；搜索是树的投影（命中保留祖先），清空恢复展开状态；
 * - 变更通过 notify() 广播，订阅方（树/查看器/侧栏）刷新。
 */

export interface OfficeFolder {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
}

export type DocBlock =
  | { t: "h"; level: 1 | 2 | 3; text: string }
  | { t: "p"; text: string }
  | { t: "bullets"; items: string[] }
  | { t: "table"; head: string[]; rows: string[][]; formula?: Record<string, string> }
  | { t: "slides"; pages: { title: string; bullets: string[]; note?: string }[] }
  | { t: "pdf"; pages: { title: string; text: string }[] };

export type OfficeContent = DocBlock[] | string;
export interface OfficeVersion {
  number: number;
  content: OfficeContent;
  savedAt: number;
}

export interface OfficeFile {
  id: string;
  projectId: string;
  folderId: string | null;
  name: string;
  /** 原件（导入资料）只读；新建文件可编辑 */
  readonly: boolean;
  /** 结构化内容（docx/xlsx/pptx/pdf）；md/txt 为字符串 */
  content: OfficeContent;
  /** 手工/已接受 AI 草稿，仅内存，重启不保留；保存成功后才进入成果版本。 */
  draft: OfficeContent | null;
  /** 已保存版本数；不得随编辑或接受建议递增。 */
  versions: number;
  history?: OfficeVersion[];
  sourceFileId?: string;
  provenance?: string;
  editGeneration?: number;
  updated: number;
}

export type OfficeScenario = "normal" | "import-failed" | "save-failed" | "version-conflict" | "model-unavailable" | "no-permission" | "scanned-pdf";
export interface OfficeProjectState {
  scenario?: OfficeScenario;
  folders: OfficeFolder[];
  files: OfficeFile[];
  loaded: boolean;
  collapsed: string[];
  selectedFileId: string | null;
  openFileIds?: string[];
  selectedFolderId: string | null;
  search: string;
  seq: number;
}

const projects = new Map<string, OfficeProjectState>();
const listeners = new Set<() => void>();

function blank(projectId: string): OfficeProjectState {
  return {
    folders: [],
    files: [],
    loaded: false,
    collapsed: [],
    selectedFileId: null,
    selectedFolderId: null,
    search: "",
    seq: 1,
  };
}

export function st(projectId: string): OfficeProjectState {
  let s = projects.get(projectId);
  if (!s) {
    s = blank(projectId);
    projects.set(projectId, s);
  }
  return s;
}

export function setOfficeScenario(projectId: string, scenario: OfficeScenario): void {
  st(projectId).scenario = scenario;
  officeNotify();
}

export function officeSubscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function officeNotify() {
  for (const cb of listeners) cb();
}

/* ---------- 名称校验（CR-043 §1） ---------- */

const RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

export function validateName(raw: string): { ok: true; name: string } | { ok: false; message: string } {
  const normalized = raw.normalize("NFC");
  if (!normalized.trim()) return { ok: false, message: "名称不能为空" };
  // 必须在 trim 前校验尾字符，不能把非法尾空格静默变成合法名称。
  if (/[.\s]$/.test(normalized)) return { ok: false, message: "名称不能以点或空格结尾" };
  const name = normalized.trimStart();
  if (name.length > 100) return { ok: false, message: "名称不能超过 100 个字符" };
  if (name === "." || name === "..") return { ok: false, message: "名称不能为 . 或 .." };
  if (/[\\/:*?"<>|]/.test(name)) return { ok: false, message: "名称不能包含 \\ / : * ? \" < > |" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return { ok: false, message: "名称不能包含控制字符" };
  if (name.endsWith(".") || name.endsWith(" ")) return { ok: false, message: "名称不能以点或空格结尾" };
  if (RESERVED.has(name.split(".")[0].toUpperCase())) return { ok: false, message: "名称使用了系统保留名" };
  return { ok: true, name };
}

function normalizeName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

function nameTaken(s: OfficeProjectState, parentId: string | null, name: string): boolean {
  const n = normalizeName(name);
  return (
    s.folders.some(f => f.parentId === parentId && normalizeName(f.name) === n) ||
    s.files.some(f => f.folderId === parentId && normalizeName(f.name) === n)
  );
}

/* ---------- 路径 ---------- */

export function folderPath(projectId: string, folderId: string | null): string {
  const s = st(projectId);
  if (!folderId) return "";
  const parts: string[] = [];
  let cur: OfficeFolder | undefined = s.folders.find(f => f.id === folderId);
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    parts.unshift(cur.name);
    cur = cur.parentId ? s.folders.find(f => f.id === cur!.parentId) : undefined;
  }
  return parts.join("/");
}

export function filePath(projectId: string, fileId: string): string {
  const s = st(projectId);
  const f = s.files.find(x => x.id === fileId);
  if (!f) return "";
  const dir = folderPath(projectId, f.folderId);
  return dir ? `${dir}/${f.name}` : f.name;
}

export function getOfficeFile(projectId: string, fileId: string): OfficeFile | undefined {
  return st(projectId).files.find(f => f.id === fileId);
}

/* ---------- 树投影：搜索命中保留祖先；目录在前 ---------- */

export interface TreeFolder {
  folder: OfficeFolder;
  depth: number;
  open: boolean;
  children: TreeFolder[];
  files: OfficeFile[];
}

export function buildTree(projectId: string): { rootFiles: OfficeFile[]; tree: TreeFolder[]; visibleCount: number } {
  const s = st(projectId);
  const q = s.search.trim().toLowerCase();
  const matchFile = (f: OfficeFile) => !q || filePath(projectId, f.id).toLowerCase().includes(q);

  const shownFiles = s.files.filter(matchFile);
  // 命中文件的祖先目录全保留；目录自身按路径匹配
  const keepFolders = new Set<string>();
  const addAncestors = (id: string | null) => {
    let curId = id;
    const guard = new Set<string>();
    while (curId && !guard.has(curId)) {
      guard.add(curId);
      if (keepFolders.has(curId)) break;
      keepFolders.add(curId);
      const f = s.folders.find(x => x.id === curId);
      curId = f?.parentId ?? null;
    }
  };
  shownFiles.forEach(f => addAncestors(f.folderId));
  const matchedFolders = s.folders.filter(f => !q || folderPath(projectId, f.id).toLowerCase().includes(q));
  matchedFolders.forEach(f => addAncestors(f.id));

  const build = (parentId: string | null, depth: number): TreeFolder[] =>
    s.folders
      .filter(f => f.parentId === parentId && keepFolders.has(f.id))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
      .map(f => ({
        folder: f,
        depth,
        // 搜索时命中路径强制展开
        open: !!q || !s.collapsed.includes(f.id),
        children: build(f.id, depth + 1),
        files: shownFiles.filter(x => x.folderId === f.id).sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
      }));

  const tree = build(null, 0);
  const rootFiles = shownFiles.filter(f => f.folderId === null).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  return { rootFiles, tree, visibleCount: shownFiles.length + matchedFolders.length };
}

/* ---------- 选择 / 折叠 / 搜索 ---------- */

export function selectFile(projectId: string, fileId: string | null) {
  const s = st(projectId);
  const f = fileId ? s.files.find(x => x.id === fileId) : null;
  if (fileId && !f) return;
  s.selectedFileId = fileId;
  if (f) {
    s.selectedFolderId = f.folderId;
    const opened = s.openFileIds ?? [];
    s.openFileIds = opened.includes(f.id) ? opened : [...opened, f.id];
    let parent = f.folderId;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      s.collapsed = s.collapsed.filter(id => id !== parent);
      parent = s.folders.find(dir => dir.id === parent)?.parentId ?? null;
    }
  }
  officeNotify();
}

/** 定位到树节点（会话引用/答复链接）：文件不存在时返回 false，由调用方提示 */
export function locateFile(projectId: string, fileId: string): boolean {
  const s = st(projectId);
  if (!s.files.some(f => f.id === fileId)) return false;
  selectFile(projectId, fileId);
  return true;
}

export function selectFolder(projectId: string, folderId: string | null) {
  const s = st(projectId);
  if (folderId !== null && !s.folders.some(f => f.id === folderId)) return;
  s.selectedFolderId = folderId;
  s.selectedFileId = null;
  officeNotify();
}

export function toggleFolder(projectId: string, folderId: string) {
  const s = st(projectId);
  s.collapsed = s.collapsed.includes(folderId) ? s.collapsed.filter(x => x !== folderId) : [...s.collapsed, folderId];
  officeNotify();
}

export function setSearch(projectId: string, q: string) {
  const s = st(projectId);
  s.search = q;
  officeNotify();
}

export function getSearch(projectId: string): string {
  return st(projectId).search;
}

/* ---------- 创建（内存；磁盘不动） ---------- */

export type CreateError = { code: "NAME" | "PARENT" | "DUPLICATE" | "FORMAT"; message: string; suggestion?: string };

function suggestName(s: OfficeProjectState, parentId: string | null, base: string, ext: string): string {
  for (let i = 1; i < 50; i++) {
    const cand = `${base}-副本${i > 1 ? `-${i}` : ""}${ext}`;
    if (!nameTaken(s, parentId, cand)) return cand;
  }
  return `${base}-${Date.now()}${ext}`;
}

export function createFolder(projectId: string, parentId: string | null, rawName: string):
  { ok: true; id: string } | { ok: false; error: CreateError } {
  const s = st(projectId);
  if (parentId && !s.folders.some(f => f.id === parentId)) {
    return { ok: false, error: { code: "PARENT", message: "父目录不存在或不属于当前项目" } };
  }
  const v = validateName(rawName);
  if (!v.ok) return { ok: false, error: { code: "NAME", message: v.message } };
  if (nameTaken(s, parentId, v.name)) return { ok: false, error: { code: "DUPLICATE", message: "同级已存在同名文件或文件夹（大小写不敏感）" } };
  const id = `OFD-${projectId}-${s.seq++}`;
  s.folders = [...s.folders, { id, projectId, parentId, name: v.name }];
  // 创建后展开父级并选中新目录
  s.collapsed = s.collapsed.filter(x => x !== parentId);
  s.selectedFolderId = id;
  s.selectedFileId = null;
  officeNotify();
  return { ok: true, id };
}

const ALLOWED_NEW_EXT = new Set(["md", "docx", "txt", "xlsx", "pptx"]);

function fileNameFor(rawName: string, ext: string): ReturnType<typeof validateName> {
  const raw = validateName(rawName);
  if (!raw.ok) return raw;
  const dot = raw.name.lastIndexOf(".");
  if (dot >= 0) {
    if (!raw.name.slice(0, dot).trim()) return { ok: false, message: "文件名主体不能为空" };
    if (raw.name.slice(dot + 1).toLowerCase() !== ext) return { ok: false, message: "文件名后缀与选择的格式不一致，请改名" };
    return raw;
  }
  return validateName(`${raw.name}.${ext}`);
}

/** 表单文本只构造合成对象；不是 Office 二进制解析器。 */
export function officeContentFor(ext: string, text: string): OfficeContent {
  if (ext === "xlsx") {
    const rows = text.split(/\r?\n/).map(row => row.split("\t"));
    return [{ t: "h", level: 2, text: "工作表1" }, { t: "table", head: rows[0] ?? [""], rows: rows.slice(1) }];
  }
  if (ext === "pptx") return [{ t: "slides", pages: text.split(/\r?\n---\r?\n/).map(part => {
    const lines = part.split(/\r?\n/);
    return { title: lines.shift() || "未命名页", bullets: lines };
  }) }];
  if (ext === "pdf") return [{ t: "pdf", pages: text.split(/\r?\n---\r?\n/).map(part => {
    const lines = part.split(/\r?\n/);
    return { title: lines.shift() || "PDF 只读样例", text: lines.join("\n") };
  }) }];
  return text;
}

export function createFile(projectId: string, parentId: string | null, rawName: string, ext: string, content: string):
  { ok: true; id: string } | { ok: false; error: CreateError } {
  const s = st(projectId);
  if (parentId && !s.folders.some(f => f.id === parentId)) {
    return { ok: false, error: { code: "PARENT", message: "父目录不存在或不属于当前项目" } };
  }
  const extLc = ext.toLowerCase().replace(/^\./, "");
  if (!ALLOWED_NEW_EXT.has(extLc)) return { ok: false, error: { code: "FORMAT", message: "新建文件支持 md / docx / txt / xlsx / pptx 合成草稿" } };
  const base = rawName.slice(0, rawName.lastIndexOf(".") > 0 ? rawName.lastIndexOf(".") : rawName.length);
  const v = fileNameFor(rawName, extLc);
  if (!v.ok) return { ok: false, error: { code: "NAME", message: v.message } };
  if (nameTaken(s, parentId, v.name)) {
    return {
      ok: false,
      error: { code: "DUPLICATE", message: "同级已存在同名文件或文件夹（大小写不敏感）", suggestion: suggestName(s, parentId, base, `.${extLc}`) },
    };
  }
  const id = `OFF-${projectId}-${s.seq++}`;
  const file: OfficeFile = {
    id,
    projectId,
    folderId: parentId,
    name: v.name,
    readonly: false,
    content: officeContentFor(extLc, content),
    draft: officeContentFor(extLc, content),
    history: [],
    provenance: "手工填写的会话草稿 · 非原生 Office 文件 · 重启丢失",
    editGeneration: 1,
    versions: 0,
    updated: Date.now(),
  };
  s.files = [...s.files, file];
  s.collapsed = s.collapsed.filter(x => x !== parentId);
  s.openFileIds = [...(s.openFileIds ?? []), id];
  s.selectedFileId = id;
  s.selectedFolderId = parentId;
  officeNotify();
  return { ok: true, id };
}

/** 导入资料（添加资料）：原件只读，进入所选目录 */
export function importFile(projectId: string, parentId: string | null, rawName: string, ext: string, content: string):
  { ok: true; id: string } | { ok: false; error: CreateError } {
  const s = st(projectId);
  if (s.scenario === "import-failed") return { ok: false, error: { code: "FORMAT", message: "导入失败（合成故障）：未写入记录，表单内容保留，可恢复正常状态后重试" } };
  if (parentId && !s.folders.some(f => f.id === parentId)) {
    return { ok: false, error: { code: "PARENT", message: "父目录不存在或不属于当前项目" } };
  }
  const extLc = ext.toLowerCase().replace(/^\./, "");
  if (!["md", "txt", "docx", "xlsx", "pptx", "pdf"].includes(extLc)) {
    return { ok: false, error: { code: "FORMAT", message: "支持的资料类型：md / txt / docx / xlsx / pptx / pdf" } };
  }
  const base = rawName.slice(0, rawName.lastIndexOf(".") > 0 ? rawName.lastIndexOf(".") : rawName.length);
  const v = fileNameFor(rawName, extLc);
  if (!v.ok) return { ok: false, error: { code: "NAME", message: v.message } };
  if (nameTaken(s, parentId, v.name)) {
    return {
      ok: false,
      error: { code: "DUPLICATE", message: "同级已存在同名文件或文件夹（大小写不敏感）", suggestion: suggestName(s, parentId, base, `.${extLc}`) },
    };
  }
  const id = `OFF-${projectId}-${s.seq++}`;
  s.files = [
    ...s.files,
    {
      id,
      projectId,
      folderId: parentId,
      name: v.name,
      readonly: true,
      content: officeContentFor(extLc, content),
      draft: null,
      provenance: "用户填写的导入仿真 · 未读取真实文件 · 未解析二进制格式",
      history: [],
      versions: 0,
      updated: Date.now(),
    },
  ];
  s.collapsed = s.collapsed.filter(x => x !== parentId);
  s.openFileIds = [...(s.openFileIds ?? []), id];
  s.selectedFileId = id;
  s.selectedFolderId = parentId;
  officeNotify();
  return { ok: true, id };
}

/** 接受建议或人工编辑只入草稿；不递增成果版本、不写磁盘。 */
export function saveDraft(projectId: string, fileId: string, content: OfficeContent): boolean {
  const f = getOfficeFile(projectId, fileId);
  if (!f || f.readonly || /\.pdf$/i.test(f.name)) return false;
  if (JSON.stringify(currentOfficeContent(f)) === JSON.stringify(content)) return true;
  f.draft = f.versions > 0 && JSON.stringify(f.content) === JSON.stringify(content) ? null : cloneOfficeContent(content);
  f.editGeneration = (f.editGeneration ?? 0) + 1;
  officeNotify();
  return true;
}

export function cloneOfficeContent(content: OfficeContent): OfficeContent {
  return typeof content === "string" ? content : JSON.parse(JSON.stringify(content)) as DocBlock[];
}

export function currentOfficeContent(file: OfficeFile): OfficeContent {
  return file.draft ?? file.content;
}

/** 会话内保存成功才生成不可变版本；与真实耐久写入/原生格式保存不同。 */
export function saveOfficeFile(projectId: string, fileId: string): { ok: true; version: number; unchanged?: boolean } | { ok: false; message: string } {
  const f = getOfficeFile(projectId, fileId);
  if (!f || f.readonly) return { ok: false, message: "原件只读或文件不存在，草稿未写入" };
  if (f.draft === null) return { ok: true, version: f.versions, unchanged: true };
  const scenario = st(projectId).scenario;
  if (scenario === "save-failed" || scenario === "version-conflict") return { ok: false,
    message: scenario === "save-failed" ? "保存失败（合成故障）· 草稿保留；恢复正常状态后重试" : "版本冲突（合成故障）· 草稿保留；可创建副本或恢复正常状态后重试" };
  if (f.versions > 0 && JSON.stringify(f.draft) === JSON.stringify(f.content)) {
    f.draft = null;
    officeNotify();
    return { ok: true, version: f.versions, unchanged: true };
  }
  // 老内存样例没有 history 时仅补当前已有版本，不伪造已丢失的历史正文。
  const history = f.history ?? (f.versions ? [{ number: f.versions, content: cloneOfficeContent(f.content), savedAt: f.updated }] : []);
  f.content = cloneOfficeContent(f.draft);
  f.draft = null;
  f.versions += 1;
  f.updated = Date.now();
  f.history = [...history, { number: f.versions, content: cloneOfficeContent(f.content), savedAt: f.updated }];
  f.editGeneration = (f.editGeneration ?? 0) + 1;
  officeNotify();
  return { ok: true, version: f.versions };
}

export function officeVersions(file: OfficeFile): OfficeVersion[] {
  return file.history ?? (file.versions ? [{ number: file.versions, content: cloneOfficeContent(file.content), savedAt: file.updated }] : []);
}

export function restoreOfficeVersion(projectId: string, fileId: string, number: number): boolean {
  const f = getOfficeFile(projectId, fileId);
  if (!f || f.readonly) return false;
  const version = officeVersions(f).find(v => v.number === number);
  if (!version) return false;
  f.draft = cloneOfficeContent(version.content);
  f.editGeneration = (f.editGeneration ?? 0) + 1;
  officeNotify();
  return true;
}

export function copyOfficeFile(projectId: string, fileId: string): { ok: true; id: string } | { ok: false; message: string } {
  const s = st(projectId), source = getOfficeFile(projectId, fileId);
  if (!source || /\.pdf$/i.test(source.name)) return { ok: false, message: "该资料不可创建编辑副本" };
  if (source.readonly && s.scenario === "no-permission") return { ok: false, message: "源资料无权限（合成状态），无法创建副本" };
  const at = source.name.lastIndexOf("."), ext = source.name.slice(at + 1).toLowerCase();
  if (!ALLOWED_NEW_EXT.has(ext)) return { ok: false, message: "此格式未支持编辑，原件保留" };
  const name = suggestName(s, source.folderId, source.name.slice(0, at), source.name.slice(at));
  const checked = validateName(name);
  if (!checked.ok) return { ok: false, message: checked.message };
  const id = `OFF-${projectId}-${s.seq++}`, content = cloneOfficeContent(currentOfficeContent(source));
  s.files = [...s.files, { id, projectId, folderId: source.folderId, name: checked.name, readonly: false,
    content, draft: cloneOfficeContent(content), versions: 0, history: [], updated: Date.now(), editGeneration: 1,
    sourceFileId: source.id, provenance: `编辑副本 · 来源：${filePath(projectId, source.id)} · 仅会话内存` }];
  selectFile(projectId, id);
  return { ok: true, id };
}

export function discardOfficeDraft(projectId: string, fileId: string): void {
  const s = st(projectId), f = getOfficeFile(projectId, fileId);
  if (!f || f.readonly) return;
  f.draft = null;
  f.editGeneration = (f.editGeneration ?? 0) + 1;
  if (!f.versions) {
    s.files = s.files.filter(x => x.id !== fileId);
    s.openFileIds = (s.openFileIds ?? []).filter(id => id !== fileId);
    if (s.selectedFileId === fileId) s.selectedFileId = null;
  }
  officeNotify();
}

export function closeOfficeFile(projectId: string, fileId: string): void {
  const s = st(projectId);
  s.openFileIds = (s.openFileIds ?? []).filter(id => id !== fileId);
  if (!s.selectedFileId || s.selectedFileId === fileId) selectFile(projectId, s.openFileIds[s.openFileIds.length - 1] ?? null);
  else officeNotify();
}

export interface OfficeCloseRequest { fileIds: string[]; finish: () => void }
const pendingCloses = new Map<string, OfficeCloseRequest>();
export function getOfficeCloseRequest(projectId: string): OfficeCloseRequest | undefined { return pendingCloses.get(projectId); }
export function cancelOfficeClose(projectId: string): void { pendingCloses.delete(projectId); officeNotify(); }
export function requestOfficeClose(projectId: string, finish: () => void, fileId?: string): boolean {
  if (pendingCloses.has(projectId)) return false;
  const fileIds = st(projectId).files.filter(f => f.draft !== null && (!fileId || f.id === fileId)).map(f => f.id);
  if (!fileIds.length) { finish(); return true; }
  pendingCloses.set(projectId, { fileIds, finish });
  officeNotify();
  return false;
}
export function resolveOfficeClose(projectId: string, save: boolean): { ok: boolean; message?: string } {
  const request = pendingCloses.get(projectId);
  if (!request) return { ok: false, message: "关闭请求已失效" };
  // 先检查全部目标，不能先关闭再发现保存失败。
  if (save && request.fileIds.some(id => { const f = getOfficeFile(projectId, id); return !f || f.readonly; }))
    return { ok: false, message: "文件不可保存，草稿与窗口保留" };
  if (save && ["save-failed", "version-conflict"].includes(st(projectId).scenario ?? "normal"))
    return { ok: false, message: "保存失败或版本冲突（合成故障），草稿与窗口保留；恢复正常状态后重试" };
  for (const id of request.fileIds) {
    if (save) {
      const result = saveOfficeFile(projectId, id);
      if (!result.ok) return result;
    } else discardOfficeDraft(projectId, id);
  }
  pendingCloses.delete(projectId);
  request.finish();
  officeNotify();
  return { ok: true };
}

/** 载入演示样例（空项目显式载入，不自动覆盖，AC-STORY-065-10） */
export function markLoaded(projectId: string) {
  st(projectId).loaded = true;
  officeNotify();
}

export function isLoaded(projectId: string): boolean {
  return st(projectId).loaded;
}

export function officeFileCount(projectId: string): { files: number; folders: number } {
  const s = st(projectId);
  return { files: s.files.length, folders: s.folders.length };
}

export function officeFileList(projectId: string): { id: string; name: string; path: string }[] {
  const s = st(projectId);
  return s.files.map(f => ({ id: f.id, name: f.name, path: filePath(projectId, f.id) }));
}

/** 办公文件的可读文本（供引用注入提示词；发送时快照冻结）。 */
export function officeFileContentText(projectId: string, fileId: string): string | null {
  const f = getOfficeFile(projectId, fileId);
  if (!f) return null;
  const scenario = st(projectId).scenario;
  if (f.readonly && scenario === "no-permission") return null;
  if (/\.pdf$/i.test(f.name) && scenario === "scanned-pdf") return null;
  const body = currentOfficeContent(f);
  return typeof body === "string" ? body : officeContentText(body);
}

export function officeContentText(blocks: OfficeContent): string {
  if (typeof blocks === "string") return blocks;
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.t === "h") parts.push(`${"#".repeat(b.level)} ${b.text}`);
    else if (b.t === "p") parts.push(b.text);
    else if (b.t === "bullets") parts.push(b.items.map(x => `- ${x}`).join("\n"));
    else if (b.t === "table")
      parts.push([b.head.join(" | "), b.head.map(() => "---").join(" | "), ...b.rows.map(r => r.join(" | "))].join("\n"));
    else if (b.t === "slides")
      parts.push(b.pages.map((p, i) => `## 第 ${i + 1} 页 · ${p.title}\n${p.bullets.map(x => `- ${x}`).join("\n")}`).join("\n\n"));
    else if (b.t === "pdf") parts.push(b.pages.map(p => `## ${p.title}\n${p.text}`).join("\n\n"));
  }
  return parts.join("\n\n");
}
