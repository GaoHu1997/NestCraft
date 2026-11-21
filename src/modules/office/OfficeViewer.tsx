import { Icon } from "@/components/icons";
import { useEffect, useRef, useState } from "react";
import { usePaneWidth, ResizeHandle, PaneToggle } from "@/components/pane-resize";
import { TabMoreDropdown, TabMoreIcon, useTabOverflow } from "@/components/tab-overflow";
import { Empty, Modal, renderMarkdown, useToast } from "@/components/ui";
import {
  cancelOfficeClose, closeOfficeFile, copyOfficeFile, currentOfficeContent, filePath,
  getOfficeCloseRequest, getOfficeFile, officeContentText, officeVersions, requestOfficeClose,
  resolveOfficeClose, restoreOfficeVersion, saveDraft, saveOfficeFile, selectFile, setOfficeScenario, st,
} from "./office-model";
import type { DocBlock, OfficeContent, OfficeFile, OfficeScenario } from "./office-model";
import { useOfficeVersion } from "./OfficeFileTree";

const extOf = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase();
const canEdit = (f: OfficeFile) => !f.readonly && ["md", "docx", "txt", "xlsx", "pptx"].includes(extOf(f.name));
const timeLabel = (time: number) => new Date(time).toLocaleString("zh-CN", { hour12: false });

const SCENARIOS: Record<OfficeScenario, string> = { normal: "正常", "import-failed": "导入失败", "save-failed": "保存失败", "version-conflict": "版本冲突", "model-unavailable": "模型不可用", "no-permission": "源无权限", "scanned-pdf": "扫描 PDF" };
export function OfficeSessionNote({ projectId }: { projectId: string }) {
  useOfficeVersion();
  return <div className="office-session-note"><span title="未读取真实文件、未调用模型；刷新/重启丢失内存修改">DEMO · 合成仿真样例</span><details className="office-scenario-menu"><summary>演示状态</summary><label>选择场景<select aria-label="演示状态" value={st(projectId).scenario ?? "normal"} onChange={event => setOfficeScenario(projectId, event.target.value as OfficeScenario)}>{Object.entries(SCENARIOS).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label></details></div>;
}

/** BUG-013 / UI-CR043-v1：仅合成对象与会话内存，不是原生 Office 解析/保存引擎。 */
export function OfficeViewer({ projectId, visible = true }: { projectId: string; visible?: boolean }) {
  useOfficeVersion();
  const s = st(projectId);
  const file = s.selectedFileId ? getOfficeFile(projectId, s.selectedFileId) : undefined;
  const opened = Array.from(new Set([...(s.openFileIds ?? []), ...(file ? [file.id] : [])]));
  // CR-052 / UI-TAB-001：打开文件页签溢出统一走共享「更多」下拉，不出现横向滚动条。
  const officeTabItems = opened.map(id => { const f = getOfficeFile(projectId, id); return { key: id, label: f?.name ?? id, active: id === file?.id }; });
  const officeTabSig = officeTabItems.map(item => `${item.key}:${item.label}:${item.active ? 1 : 0}`).join("|");
  const officeTabsOverflow = useTabOverflow({ tabSelector: ".office-open-tab", items: officeTabItems, deps: [officeTabSig] });
  return <section className="office-viewer office-main">
    <OfficeSessionNote projectId={projectId} />
    <div className="office-open-tabs" aria-label="打开的文件">
      {opened.map(id => {
        const f = getOfficeFile(projectId, id);
        return f ? <div key={id} className={`office-open-tab ${id === file?.id ? "selected" : ""}`}>
          <button type="button" title={filePath(projectId, id)} onClick={() => selectFile(projectId, id)}>{f.name}{f.draft !== null ? " ●" : ""}</button>
          <button type="button" aria-label={`关闭 ${f.name}`} onClick={() => requestOfficeClose(projectId, () => closeOfficeFile(projectId, id), id)}><Icon name="x" size={12} /></button>
        </div> : null;
      })}
      {opened.length > 0 && <button {...officeTabsOverflow.moreProps}><TabMoreIcon /></button>}
    </div>
    {officeTabsOverflow.dropdownOpen && <TabMoreDropdown anchorRef={officeTabsOverflow.moreRef} items={officeTabItems} onPick={id => selectFile(projectId, id)} onClose={officeTabsOverflow.closeDropdown} />}
    {file ? <Viewer key={`${projectId}:${file.id}`} file={file} visible={visible} /> :
      <div className="office-empty"><h1>从一份资料开始</h1><p>从左侧添加资料或新建文档。编辑副本只有保存成功后才进入本会话成果。</p><small>合成仿真 · 未访问真实资料 · 内存修改重启不保留</small></div>}
    <OfficeCloseGuard projectId={projectId} visible={visible} />
  </section>;
}

/** 主壳 keepmounted 时保留草稿；关闭请求只能在可见工作区弹出。 */
export function OfficeCloseGuard({ projectId, visible = true }: { projectId: string; visible?: boolean }) {
  useOfficeVersion();
  const request = getOfficeCloseRequest(projectId);
  const [error, setError] = useState("");
  useEffect(() => setError(""), [request]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (st(projectId).files.some(f => f.draft !== null)) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [projectId]);
  if (!request || !visible) return null;
  const decide = (save: boolean) => {
    const result = resolveOfficeClose(projectId, save);
    if (!result.ok) setError(result.message ?? "无法关闭，草稿保留");
  };
  return <Modal title="有未保存的编辑" onClose={() => cancelOfficeClose(projectId)} width={520} heightRatio={0.38}
    footer={<><button className="btn" onClick={() => cancelOfficeClose(projectId)}>继续编辑</button><button className="btn" onClick={() => decide(false)}>不保存并关闭</button><button className="btn primary" onClick={() => decide(true)}>保存并关闭</button></>}>
    <p>{request.fileIds.map(id => getOfficeFile(projectId, id)?.name ?? id).join("、")}</p>
    <p>保存成功后再关闭；失败时保留草稿与窗口。保存仅更新本会话内存，重启仍会丢失，不是真实磁盘写入。</p>
    {error && <div className="office-error" role="alert">{error}</div>}
  </Modal>;
}

function Viewer({ file, visible }: { file: OfficeFile; visible: boolean }) {
  const toast = useToast();
  const ext = extOf(file.name);
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<"versions" | "export" | null>(null);
  const [error, setError] = useState("");
  const save = () => {
    const result = saveOfficeFile(file.projectId, file.id);
    if (!result.ok) { setError(result.message); return; }
    setError("");
    if (!result.unchanged) toast(`已保存到本会话成果 v${result.version}（内存；重启不保留）`);
  };
  useEffect(() => {
    if (!visible) return;
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && !document.querySelector('[role="dialog"]')) {
        event.preventDefault();
        if (canEdit(file)) save();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [visible, file.projectId, file.id, file.draft]);
  const copy = () => {
    const result = copyOfficeFile(file.projectId, file.id);
    if (!result.ok) setError(result.message);
  };
  const content = currentOfficeContent(file);
  return <>
    <div className="office-editor-toolbar">
      <span className={`office-format ${ext}`}>{ext.toUpperCase()}</span>
      <b className="office-file-title" title={filePath(file.projectId, file.id)}>{file.name}</b>
      <span className={`office-save-status ${file.draft !== null ? "dirty" : "saved"}`} role="status">{file.readonly ? "原件只读" : file.draft !== null ? "未保存草稿" : file.versions ? `已保存 v${file.versions}` : "未保存"}</span>
      <span className="spacer" />
      {file.readonly && !["pdf"].includes(ext) ? <button className="btn sm" onClick={copy}>创建编辑副本</button> : canEdit(file) ? <>
        <button className="btn sm" onClick={() => setEditing(value => !value)}>{editing ? "阅读预览" : "编辑"}</button>
        <button className="btn primary sm" disabled={file.draft === null} onClick={save}>保存</button>
      </> : <span className="small muted">只读</span>}
      <button className="btn sm" disabled={!file.versions} onClick={() => setDialog("versions")}>版本</button>
    </div>
    <details className="office-provenance"><summary>{file.readonly ? "来源 · 只读" : file.draft !== null ? "草稿" : "成果"} · 来源与格式边界</summary><p>{file.provenance ?? "合成业务情景 · 非真实文件解析"}</p><p>原生 Office 解析、复杂格式往返与磁盘写入未实现。保存仅更新本会话内存；重启不保留。</p></details>
    {error && <div className="office-error" role="alert">{error}<button className="btn sm" onClick={() => { setOfficeScenario(file.projectId, "normal"); setError(""); }}>恢复正常状态</button></div>}
    <Rendered key={file.id} file={file} content={content} editing={editing && canEdit(file)} />
    <div className="office-document-foot"><span>合成仿真 · 内存修改重启不保留</span><button className="btn ghost sm" onClick={() => setDialog("export")}>导出检查</button></div>
    {dialog === "versions" && <OfficeVersionsDialog file={file} onClose={() => setDialog(null)} />}
    {dialog === "export" && <OfficeExportDialog file={file} onClose={() => setDialog(null)} />}
  </>;
}

function Rendered({ file, content, editing }: { file: OfficeFile; content: OfficeContent; editing: boolean }) {
  const ext = extOf(file.name);
  const scenario = st(file.projectId).scenario;
  if (scenario === "no-permission" && file.readonly) {
    return <Empty title="来源不可读取" desc="合成无权限场景：未显示正文、未发送资料。切回正常状态后可继续阅读；真实权限集成仍需另行验证。" />;
  }
  if (scenario === "scanned-pdf" && ext === "pdf") {
    return <Empty title="扫描 PDF 无可读取文本" desc="合成扫描件场景：当前未实现 OCR，不编造正文或可引用片段。" />;
  }
  const edit = (value: OfficeContent) => saveDraft(file.projectId, file.id, value);
  if (ext === "xlsx" && Array.isArray(content)) return <SheetPane blocks={content} editing={editing} onEdit={edit} />;
  if (ext === "pptx" && Array.isArray(content)) return <SlidesPane scopeId={`${file.projectId}:${file.id}`} blocks={content} editing={editing} onEdit={edit} />;
  if (ext === "pdf" && Array.isArray(content)) return <PdfPane blocks={content} />;
  if (editing && ext === "docx") {
    const parts = officeContentText(content).split(/\n\s*\n/);
    return <div className="office-document-scroll"><article className="office-paper editing"><span className="office-paper-meta">DOCX · 编辑副本 · 合成对象编辑</span>{parts.map((part, i) =>
      <section className="office-paragraph" key={i}><label className="office-block-label" htmlFor={`office-block-${file.id}-${i}`}>第 {i + 1} 段</label><textarea id={`office-block-${file.id}-${i}`} className="office-prose-edit" rows={Math.min(10, Math.max(2, part.split("\n").length + 1))} value={part} onChange={event => { const next = parts.slice(); next[i] = event.target.value; edit(next.join("\n\n")); }} /></section>)}
      <button className="btn sm" onClick={() => edit(`${officeContentText(content)}\n\n新段落`)}>+ 添加段落</button>
    </article></div>;
  }
  if (editing) return <div className="office-md-edit"><label className="office-field"><span>{ext === "md" ? "Markdown 源文草稿" : "源文草稿"}</span><textarea className="textarea mono" value={officeContentText(content)} onChange={event => edit(event.target.value)} spellCheck={false} aria-label="草稿编辑" rows={24} /></label><p className="office-format-note">切换文件自动保留当前草稿，保存前不会成为成果版本。</p></div>;
  if (Array.isArray(content)) return <div className="office-document-scroll"><article className="office-paper"><span className="office-paper-meta">{ext.toUpperCase()} · {file.readonly ? "原件只读" : "编辑副本"} · 中文正文</span>{content.map((block, i) => <BlockView key={i} block={block} />)}</article></div>;
  if (["md", "docx"].includes(ext)) return <div className="office-document-scroll"><MarkdownPane text={content} /></div>;
  return <div className="office-document-scroll"><pre className="office-paper office-plain">{content}</pre></div>;
}

function MarkdownPane({ text }: { text: string }) {
  const [result, setResult] = useState<{ text: string; html: string; error?: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    renderMarkdown(text).then(html => { if (alive) setResult({ text, html }); }).catch(() => { if (alive) setResult({ text, html: "", error: true }); });
    return () => { alive = false; };
  }, [text]);
  if (!result || result.text !== text) return <div className="office-paper">正在呈现当前草稿…</div>;
  if (result.error) return <div className="office-paper"><p role="alert">预览失败，源文仍保留</p><pre>{text}</pre></div>;
  return <div className="office-paper office-md" dangerouslySetInnerHTML={{ __html: result.html }} />;
}

function BlockView({ block }: { block: DocBlock }) {
  if (block.t === "h") { const Tag = (["h1", "h2", "h3"] as const)[block.level - 1]; return <Tag>{block.text}</Tag>; }
  if (block.t === "p") return <p>{block.text}</p>;
  if (block.t === "bullets") return <ul>{block.items.map((text, i) => <li key={i}>{text}</li>)}</ul>;
  if (block.t === "table") return <table><thead><tr>{block.head.map((text, i) => <th key={i}>{text}</th>)}</tr></thead><tbody>{block.rows.map((row, i) => <tr key={i}>{row.map((text, j) => <td key={j}>{text}</td>)}</tr>)}</tbody></table>;
  return null;
}

const columnName = (index: number): string => { let name = "", n = index + 1; while (n > 0) { n--; name = String.fromCharCode(65 + n % 26) + name; n = Math.floor(n / 26); } return name; };
const columnIndex = (name: string) => Array.from(name.toUpperCase()).reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
type TableBlock = Extract<DocBlock, { t: "table" }>;
function cellRaw(table: TableBlock, row: number, col: number): string { return table.formula?.[`${columnName(col)}${row + 1}`] ?? (row === 0 ? table.head[col] : table.rows[row - 1]?.[col]) ?? ""; }
/** 有界矩形 SUM；未知公式显示原值，不冒充完整 Excel 引擎。 */
function cellValue(table: TableBlock, row: number, col: number, seen = new Set<string>()): string {
  const raw = cellRaw(table, row, col), key = `${row}:${col}`;
  if (!raw.startsWith("=")) return raw;
  if (seen.has(key)) return "#循环引用";
  const match = /^=SUM\(([A-Z]+)([1-9]\d*):([A-Z]+)([1-9]\d*)\)$/i.exec(raw);
  if (!match) return raw;
  const r1 = Number(match[2]) - 1, r2 = Number(match[4]) - 1, c1 = columnIndex(match[1]), c2 = columnIndex(match[3]);
  if (r1 > r2 || c1 > c2 || (r2 - r1 + 1) * (c2 - c1 + 1) > 10000 || r2 > table.rows.length || c2 >= Math.max(table.head.length, ...table.rows.map(r => r.length))) return "#范围错误";
  const nextSeen = new Set(seen); nextSeen.add(key);
  let total = 0;
  for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
    const value = cellValue(table, r, c, nextSeen);
    if (value.startsWith("#") || value.startsWith("=")) return value;
    const number = Number(value); if (Number.isFinite(number)) total += number;
  }
  return String(total);
}

function SheetPane({ blocks, editing, onEdit }: { blocks: DocBlock[]; editing: boolean; onEdit: (content: OfficeContent) => void }) {
  const tables = blocks.flatMap((block, index) => block.t === "table" ? [{ table: block, index, name: index > 0 && blocks[index - 1].t === "h" ? (blocks[index - 1] as Extract<DocBlock, { t: "h" }>).text : `工作表${index + 1}` }] : []);
  const [selection, setSelection] = useState({ sheet: 0, row: 0, col: 0 });
  const item = tables[Math.min(selection.sheet, tables.length - 1)];
  if (!item) return <Empty title="暂无工作表内容" />;
  const { table } = item, row = Math.min(selection.row, table.rows.length), col = selection.col;
  const columns = Math.max(3, table.head.length, ...table.rows.map(r => r.length));
  const raw = cellRaw(table, row, col);
  const update = (value: string) => {
    const next = JSON.parse(JSON.stringify(blocks)) as DocBlock[], t = next[item.index] as TableBlock;
    const cell = `${columnName(col)}${row + 1}`;
    if (t.formula) delete t.formula[cell];
    if (row === 0) t.head[col] = value;
    else t.rows[row - 1][col] = value;
    onEdit(next);
  };
  return <div className="office-sheet"><div className="office-formula"><span className="office-cell-name">{columnName(col)}{row + 1}</span><label htmlFor="office-formula-input">fx</label><input id="office-formula-input" className="input" value={raw} readOnly={!editing} onChange={event => update(event.target.value)} aria-label={`公式条：${columnName(col)}${row + 1}`} /></div>
    <div className="office-sheet-scroll"><table className="office-grid" aria-label={item.name}><thead><tr><th></th>{Array.from({ length: columns }, (_, c) => <th key={c}>{columnName(c)}</th>)}</tr></thead><tbody>{[table.head, ...table.rows].map((_, r) => <tr key={r}><th>{r + 1}</th>{Array.from({ length: columns }, (_, c) => <td key={c}><button type="button" className={r === row && c === col ? "selected" : ""} aria-label={`${columnName(c)}${r + 1}: ${cellValue(table, r, c) || "空白"}`} onClick={() => setSelection({ ...selection, row: r, col: c })}>{cellValue(table, r, c) || "\u00a0"}</button></td>)}</tr>)}</tbody></table></div>
    <div className="office-sheet-tabs">{tables.map((sheet, i) => <button key={sheet.index} className={`btn sm ${selection.sheet === i ? "selected" : ""}`} aria-pressed={selection.sheet === i} onClick={() => setSelection({ sheet: i, row: 0, col: 0 })}>{sheet.name}</button>)}</div>
    <p className="office-format-note">{editing ? "在公式条编辑所选单元格；切换文件自动保留草稿。" : "只读查看；创建副本后可编辑。"}仅合成仿真 SUM 矩形范围求和；不运行宏，不是完整计算引擎。</p>
  </div>;
}

function SlidesPane({ scopeId, blocks, editing, onEdit }: { scopeId: string; blocks: DocBlock[]; editing: boolean; onEdit: (content: OfficeContent) => void }) {
  const layoutRef = useRef<HTMLDivElement>(null);
  const thumbnails = usePaneWidth(`office:${scopeId}`, "thumbnails", { default: 124, min: 96, max: 220, side: "left", containerRef: layoutRef, minCenter: 240 });
  const blockIndex = blocks.findIndex(block => block.t === "slides");
  const slides = blocks[blockIndex] as Extract<DocBlock, { t: "slides" }> | undefined;
  const [cur, setCur] = useState(0);
  const index = Math.max(0, Math.min(cur, (slides?.pages.length ?? 0) - 1)), page = slides?.pages[index];
  if (!slides || !page) return <Empty title="暂无已接受页面" desc="接受候选页后在这里编辑" />;
  const update = (key: "title" | "bullets", value: string) => {
    const next = JSON.parse(JSON.stringify(blocks)) as DocBlock[], block = next[blockIndex] as Extract<DocBlock, { t: "slides" }>;
    if (key === "title") block.pages[index].title = value; else block.pages[index].bullets = value.split("\n");
    onEdit(next);
  };
  return <div className="office-presentation pane-container" ref={layoutRef} style={{ gridTemplateColumns: `${thumbnails.overlay ? 0 : thumbnails.width}px minmax(0,1fr)` }}><nav {...thumbnails.paneProps} className={`${thumbnails.paneProps.className} office-thumbnails`} style={thumbnails.style} aria-label="幻灯片缩略图"><ResizeHandle pane={thumbnails} label="幻灯片缩略图" />{slides.pages.map((p, i) => <button key={i} className={`office-thumbnail ${i === index ? "selected" : ""}`} aria-label={`第${i + 1}页 ${p.title}`} aria-pressed={i === index} onClick={() => setCur(i)}><small>{i + 1}</small><b>{p.title}</b><span>{p.bullets.join("\n").slice(0, 48)}</span></button>)}</nav>
    <div className="office-slide-area"><article className="office-slide office-paper" aria-label={`第 ${index + 1} 页`}>{editing ? <><label className="office-field"><span>本页标题</span><input className="input" value={page.title} onChange={event => update("title", event.target.value)} /></label><label className="office-field"><span>本页正文</span><textarea className="textarea" rows={8} value={page.bullets.join("\n")} onChange={event => update("bullets", event.target.value)} /></label></> : <><div className="office-slide-kicker">{index + 1} / {slides.pages.length} · 合成演示内容</div><h1>{page.title}</h1><p>{page.bullets.join("\n")}</p></>}</article><p className="office-format-note">逐页标题／正文可编辑；不承诺动画、母版或复杂布局保真。</p></div>
    <div className="pane-controls"><PaneToggle pane={thumbnails} label="幻灯片缩略图" /></div>
  </div>;
}

function PdfPane({ blocks }: { blocks: DocBlock[] }) {
  const pdf = blocks.find((block): block is Extract<DocBlock, { t: "pdf" }> => block.t === "pdf");
  const [cur, setCur] = useState(0);
  const index = Math.max(0, Math.min(cur, (pdf?.pages.length ?? 0) - 1)), page = pdf?.pages[index];
  if (!pdf || !page) return <Empty title="暂无可预览页面" desc="原生 PDF 解析与 OCR 未实现，不编造正文" />;
  return <div className="office-pdf"><div className="office-pagination"><button className="btn sm" disabled={index === 0} onClick={() => setCur(index - 1)}>上一页</button><span>第 {index + 1} / {pdf.pages.length} 页 · 只读</span><button className="btn sm" disabled={index === pdf.pages.length - 1} onClick={() => setCur(index + 1)}>下一页</button></div><article className="office-paper office-pdf-page"><span className="office-paper-meta">只读分页仿真 · 第 {index + 1} 页</span><h2>{page.title}</h2><p>{page.text}</p></article></div>;
}

export function OfficeArtifacts({ projectId, onOpenFile }: { projectId: string; onOpenFile?: (fileId: string) => void }) {
  useOfficeVersion();
  const files = st(projectId).files.filter(f => f.versions > 0);
  const [dialog, setDialog] = useState<{ type: "versions" | "export"; fileId: string } | null>(null);
  const file = dialog ? getOfficeFile(projectId, dialog.fileId) : undefined;
  const open = (id: string) => { selectFile(projectId, id); onOpenFile?.(id); };
  return <section className="office-main office-results"><div className="office-results-head"><h1>项目成果</h1><p>同一文件的已保存版本。接受 AI 建议只入草稿，不会自动出现在这里。仅本会话内存，重启不保留。</p></div>
    {files.length ? <div className="office-result-list">{files.map(f => <article className="office-result" key={f.id}><span className={`office-format ${extOf(f.name)}`}>{extOf(f.name).toUpperCase()}</span><div><h2>{f.name}</h2><p>v{f.versions} · {timeLabel(f.updated)} · {f.sourceFileId ? "有编辑来源" : "合成样例／手工内容"} · 待人工核对{f.draft !== null ? " · 有未保存草稿" : ""}</p></div><div className="office-row"><button className="btn sm" onClick={() => open(f.id)}>打开</button><button className="btn sm" onClick={() => setDialog({ type: "versions", fileId: f.id })}>版本</button><button className="btn sm" onClick={() => setDialog({ type: "export", fileId: f.id })}>导出检查</button></div></article>)}</div> : <div className="office-empty"><h2>还没有已保存成果</h2><p>先编辑或审阅候选，再点击保存。全部拒绝的 AI 候选不会产生新成果。</p></div>}
    {file && dialog?.type === "versions" && <OfficeVersionsDialog file={file} onClose={() => setDialog(null)} onRestored={() => open(file.id)} />}
    {file && dialog?.type === "export" && <OfficeExportDialog file={file} onClose={() => setDialog(null)} />}
  </section>;
}

function OfficeVersionsDialog({ file, onClose, onRestored }: { file: OfficeFile; onClose: () => void; onRestored?: () => void }) {
  const [replace, setReplace] = useState<number | null>(null);
  const restore = (number: number) => {
    if (!restoreOfficeVersion(file.projectId, file.id, number)) return;
    onClose(); onRestored?.();
  };
  if (replace !== null) return <Modal title="替换当前草稿？" onClose={() => setReplace(null)} width={500} heightRatio={0.34} footer={<><button className="btn" onClick={() => setReplace(null)}>取消</button><button className="btn primary" onClick={() => restore(replace)}>确认恢复为新草稿</button></>}><p>历史版本保持不变，当前未保存草稿将被所选版本替换。若需保留，请取消后先保存或创建副本。</p></Modal>;
  return <Modal title="成果版本" onClose={onClose} width={640} footer={<button className="btn" onClick={onClose}>关闭</button>}><p>{file.name} · 恢复只生成新草稿，不改写历史。内存版本重启不保留。</p><div className="office-version-list">{officeVersions(file).slice().reverse().map(v => <article key={v.number}><div className="office-row"><h3>v{v.number}</h3><span>{timeLabel(v.savedAt)}</span><span>待人工核对</span></div><details><summary>查看此版本内容</summary><pre>{officeContentText(v.content)}</pre></details><button className="btn sm" disabled={file.readonly} title={file.readonly ? "原件只读，请先创建编辑副本" : ""} onClick={() => file.draft !== null ? setReplace(v.number) : restore(v.number)}>恢复为新草稿</button></article>)}</div></Modal>;
}

function OfficeExportDialog({ file, onClose }: { file: OfficeFile; onClose: () => void }) {
  const [checked, setChecked] = useState(false);
  const [useSaved, setUseSaved] = useState(false);
  return <Modal title="导出前检查" onClose={onClose} width={560} footer={<><button className="btn" onClick={onClose}>关闭</button><button className="btn primary" onClick={() => setChecked(true)}>运行导出检查</button><button className="btn" disabled title="未接入原生导出引擎">下载不可用</button></>}>
    <div className="office-form"><label className="office-field"><span>导出文件名</span><input className="input" value={file.name} readOnly /></label><p>当前已保存版本：{file.versions ? `v${file.versions}` : "无"}</p><label className="office-check-label"><input type="checkbox" checked={useSaved} onChange={event => { setUseSaved(event.target.checked); setChecked(false); }} />明确使用已保存版本，不包含未保存草稿</label></div>
    {checked && <div className="office-export-checks" role="status"><p className={file.versions && (file.draft === null || useSaved) ? "pass" : "warn"}><b>保存版本</b><span>{!file.versions ? "尚无已保存成果；请先保存" : file.draft !== null && !useSaved ? "请先保存草稿或明确选择已有保存版本" : `检查目标 v${file.versions}，不含当前未保存修改`}</span></p><p className="warn"><b>原生格式／写入／来源／版面校验未实现</b><span>没有接入导出引擎、真实文件或目标目录权限检查，检查未通过，没有生成或下载任何文件。</span></p></div>}
    <p className="office-caveat">仅会话内存状态核对，不承诺格式保真，不将文本改后缀冒充 Office 文件。真实导出不可用。</p>
  </Modal>;
}
