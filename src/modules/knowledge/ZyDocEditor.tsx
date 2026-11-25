import { useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { Editor, Toolbar } from "@wangeditor/editor-for-react";
import type { IDomEditor, IEditorConfig, IToolbarConfig } from "@wangeditor/editor";
import "@wangeditor/editor/dist/css/style.css";
import { Icon } from "@/components/icons";
import { MarkdownContent } from "./MarkdownContent";
import "./zy-doc.css";

/** 与 zyplayer Edit.vue 的 mavon toolbars 同一组开关。 */
const MARKDOWN_TOOLS: { id: string; label: string }[] = [
  { id: "bold", label: "粗体" },
  { id: "italic", label: "斜体" },
  { id: "header", label: "标题" },
  { id: "underline", label: "下划线" },
  { id: "strikethrough", label: "中划线" },
  { id: "mark", label: "标记" },
  { id: "superscript", label: "上角标" },
  { id: "subscript", label: "下角标" },
  { id: "quote", label: "引用" },
  { id: "ol", label: "有序列表" },
  { id: "ul", label: "无序列表" },
  { id: "link", label: "链接" },
  { id: "imagelink", label: "图片" },
  { id: "code", label: "代码" },
  { id: "table", label: "表格" },
  { id: "undo", label: "上一步" },
  { id: "redo", label: "下一步" },
  { id: "trash", label: "清空" },
  { id: "save", label: "保存" },
  { id: "subfield", label: "双栏" },
  { id: "preview", label: "预览" },
  { id: "fullscreen", label: "全屏" },
  { id: "readmodel", label: "阅读" },
  { id: "navigation", label: "导航目录" },
  { id: "alignleft", label: "左对齐" },
  { id: "aligncenter", label: "居中" },
  { id: "alignright", label: "右对齐" },
];

function wrapSelection(value: string, start: number, end: number, before: string, after: string) {
  const selected = value.slice(start, end) || "文本";
  const next = value.slice(0, start) + before + selected + after + value.slice(end);
  const cursor = start + before.length + selected.length + after.length;
  return { next, cursor };
}

function prefixLines(value: string, start: number, end: number, prefix: (index: number) => string) {
  const from = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const to = value.indexOf("\n", end);
  const endAt = to < 0 ? value.length : to;
  const lines = value.slice(from, endAt).split("\n");
  const replaced = lines.map((line, index) => prefix(index) + line.replace(/^(#{1,6}\s+|>\s+|[-*]\s+|\d+\.\s+)/, "")).join("\n");
  return { next: value.slice(0, from) + replaced + value.slice(endAt), cursor: from + replaced.length };
}

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function storedZip(files: { name: string; data: Uint8Array }[]) {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (value: number) => Uint8Array.of(value & 255, (value >> 8) & 255);
  const u32 = (value: number) => Uint8Array.of(value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >> 24) & 255);
  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.data);
    const local = [u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(file.data.length), u32(file.data.length), u16(name.length), u16(0), name, file.data];
    const localBytes = local.reduce((sum, part) => sum + part.length, 0);
    const centralHeader = [u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(file.data.length), u32(file.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name];
    parts.push(...local);
    central.push(...centralHeader);
    offset += localBytes;
  }
  const centralBytes = central.reduce((sum, part) => sum + part.length, 0);
  const end = [u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(centralBytes), u32(offset), u16(0)];
  const chunks = [...parts, ...central, ...end];
  const out = new Uint8Array(chunks.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const chunk of chunks) { out.set(chunk, cursor); cursor += chunk.length; }
  return out;
}
function exportWord(title: string) {
  const page = document.getElementById("pageContentBox");
  const inner = page?.innerHTML || "";
  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Strict//EN" "http://www.w3.org/TR/html4/strict.dtd">\n<html lang="zh"><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8" /></head><body>${inner}</body></html>`;
  const encoder = new TextEncoder();
  const bytes = storedZip([
    { name: "[Content_Types].xml", data: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="htm" ContentType="text/html"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`) },
    { name: "_rels/.rels", data: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`) },
    { name: "word/document.xml", data: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:altChunk r:id="htmlChunk"/></w:body></w:document>`) },
    { name: "word/_rels/document.xml.rels", data: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="htmlChunk" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="afchunk.htm"/></Relationships>`) },
    { name: "word/afchunk.htm", data: encoder.encode(html) },
  ]);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${title || "文档"}.docx`;
  link.click();
  URL.revokeObjectURL(url);
}

export function ZyDocEditor(props: {
  kind: "markdown" | "html";
  title: string;
  body: string;
  modified?: string;
  startInEdit?: boolean;
  saving?: boolean;
  onSave: (title: string, body: string) => Promise<void>;
  onDelete: () => void;
  onUploadImage?: (file: File) => Promise<string>;
  onToggleTree?: () => void;
}) {
  const [editing, setEditing] = useState(!!props.startInEdit);
  const [title, setTitle] = useState(props.title);
  const [body, setBody] = useState(props.body);
  const [error, setError] = useState("");
  const [subfield, setSubfield] = useState(true);
  const [preview, setPreview] = useState(true);
  const [readmodel, setReadmodel] = useState(false);
  const [full, setFull] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const history = useRef<string[]>([props.body]);
  const future = useRef<string[]>([]);
  const editorRef = useRef<IDomEditor | null>(null);
  const uploadRef = useRef(props.onUploadImage);
  uploadRef.current = props.onUploadImage;
  const toolbarConfig: Partial<IToolbarConfig> = { excludeKeys: ["fullScreen", "undo", "redo", "emotion", "|", "lineHeight", "fontFamily"] };
  const editorConfig: Partial<IEditorConfig> = {
    placeholder: "请输入文档内容",
    scroll: false,
    MENU_CONF: {
      uploadImage: {
        maxFileSize: 25 * 1024 * 1024,
        async customUpload(file: File, insertFn: (url: string, alt: string, href: string) => void) {
          const url = await uploadRef.current?.(file);
          if (url) insertFn(url, file.name, url);
        },
      },
      uploadVideo: { maxFileSize: 25 * 1024 * 1024, async customUpload(file: File, insertFn: (url: string) => void) { const url = await uploadRef.current?.(file); if (url) insertFn(url); } },
    },
  };

  useEffect(() => {
    setTitle(props.title);
    setBody(props.body);
    history.current = [props.body];
    future.current = [];
  }, [props.title, props.body, props.kind]);
  useEffect(() => { if (props.startInEdit) setEditing(true); }, [props.startInEdit]);

  useEffect(() => () => { editorRef.current?.destroy(); editorRef.current = null; }, []);

  const pushBody = (next: string) => {
    if (next === body) return;
    history.current.push(body);
    future.current = [];
    setBody(next);
  };
  const apply = (id: string) => {
    const input = area.current;
    if (!input && id !== "save" && id !== "trash" && id !== "undo" && id !== "redo" && id !== "subfield" && id !== "preview" && id !== "fullscreen" && id !== "readmodel") return;
    const start = input?.selectionStart ?? body.length;
    const end = input?.selectionEnd ?? body.length;
    const put = (next: string, cursor: number) => {
      pushBody(next);
      requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(cursor, cursor); });
    };
    if (id === "bold") put(wrapSelection(body, start, end, "**", "**").next, wrapSelection(body, start, end, "**", "**").cursor);
    else if (id === "italic") { const r = wrapSelection(body, start, end, "*", "*"); put(r.next, r.cursor); }
    else if (id === "underline") { const r = wrapSelection(body, start, end, "<u>", "</u>"); put(r.next, r.cursor); }
    else if (id === "strikethrough") { const r = wrapSelection(body, start, end, "~~", "~~"); put(r.next, r.cursor); }
    else if (id === "mark") { const r = wrapSelection(body, start, end, "==", "=="); put(r.next, r.cursor); }
    else if (id === "superscript") { const r = wrapSelection(body, start, end, "<sup>", "</sup>"); put(r.next, r.cursor); }
    else if (id === "subscript") { const r = wrapSelection(body, start, end, "<sub>", "</sub>"); put(r.next, r.cursor); }
    else if (id === "code") { const r = wrapSelection(body, start, end, "```\n", "\n```"); put(r.next, r.cursor); }
    else if (id === "header") { const r = prefixLines(body, start, end, () => "# "); put(r.next, r.cursor); }
    else if (id === "quote") { const r = prefixLines(body, start, end, () => "> "); put(r.next, r.cursor); }
    else if (id === "ul") { const r = prefixLines(body, start, end, () => "- "); put(r.next, r.cursor); }
    else if (id === "ol") { const r = prefixLines(body, start, end, index => `${index + 1}. `); put(r.next, r.cursor); }
    else if (id === "link") { const r = wrapSelection(body, start, end, "[", "](https://)"); put(r.next, r.cursor); }
    else if (id === "imagelink") { const r = wrapSelection(body, start, end, "![", "](https://)"); put(r.next, r.cursor); }
    else if (id === "table") { const table = "\n| 列1 | 列2 |\n| --- | --- |\n|  |  |\n"; put(body.slice(0, end) + table + body.slice(end), end + table.length); }
    else if (id === "alignleft") { const r = prefixLines(body, start, end, () => ""); put(r.next, r.cursor); }
    else if (id === "aligncenter") { const r = wrapSelection(body, start, end, "<center>", "</center>"); put(r.next, r.cursor); }
    else if (id === "alignright") { const r = wrapSelection(body, start, end, "<p align=\"right\">", "</p>"); put(r.next, r.cursor); }
    else if (id === "undo") { const prev = history.current.pop(); if (prev !== undefined) { future.current.push(body); setBody(prev); } }
    else if (id === "redo") { const next = future.current.pop(); if (next !== undefined) { history.current.push(body); setBody(next); } }
    else if (id === "trash") pushBody("");
    else if (id === "save") void save();
    else if (id === "subfield") setSubfield(value => !value);
    else if (id === "preview") setPreview(value => !value);
    else if (id === "readmodel") setReadmodel(value => !value);
    else if (id === "fullscreen") setFull(value => !value);
  };
  const save = async () => {
    const name = title.trim();
    if (!name) { setError("标题不能为空"); return; }
    setError("");
    const content = props.kind === "html" ? (editorRef.current?.getHtml() || body) : body;
    try { await props.onSave(name, content); setEditing(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const cancel = () => {
    const content = props.kind === "html" ? (editorRef.current?.getHtml() || body) : body;
    if ((title !== props.title || content !== props.body) && !window.confirm("确定要离开编辑页吗？离开后编辑的内容将不会被保存")) return;
    setTitle(props.title);
    setBody(props.body);
    setEditing(false);
    setError("");
  };
  const safeHtml = DOMPurify.sanitize(props.body || "", { USE_PROFILES: { html: true } });

  if (!editing) {
    return <div className="zy-page-show">
      <div className="zy-view-head">
        {props.onToggleTree && <button type="button" className="zy-icon-btn" title="折叠目录" onClick={props.onToggleTree}><Icon name="panelLeft" size={16} /></button>}
        <div className="zy-title-time">
          <div className="wiki-title">{props.title}</div>
          <div className="time">最近修改：{props.modified || "接口未提供"}</div>
        </div>
        <div className="zy-view-actions">
          <button type="button" className="zy-icon-btn" title="编辑文档" onClick={() => setEditing(true)}><Icon name="edit" size={16} /></button>
          <span className="zy-menu">
            <button type="button" className="zy-icon-btn" title="更多" onClick={event => event.currentTarget.parentElement?.classList.toggle("open")}><Icon name="more" size={16} /></button>
            <span className="zy-menu-pop" role="menu">
              <button type="button" onClick={() => exportWord(props.title)}><Icon name="fileWord" size={14} /> 导出为Word</button>
              <button type="button" className="danger" onClick={props.onDelete}><Icon name="trash" size={14} /> 删除</button>
            </span>
          </span>
        </div>
      </div>
      <div className="zy-view-body" id="pageContentBox">
        {props.kind === "markdown"
          ? <MarkdownContent documentKey={props.title} source={props.body} onToc={() => undefined} />
          : <div className="wang-editor-body" dangerouslySetInnerHTML={{ __html: safeHtml }} />}
      </div>
    </div>;
  }

  return <div className={`page-edit-vue ${full ? "is-full" : ""}`}>
    <div className="fake-header">
      {props.onToggleTree && <button type="button" className="zy-icon-btn" title="折叠目录" onClick={props.onToggleTree}><Icon name="panelLeft" size={16} /></button>}
      <input className="page-title-input" maxLength={40} placeholder="请输入标题" value={title} onChange={event => setTitle(event.target.value)} />
      <div className="fake-header-actions">
        <button type="button" className="zy-primary" disabled={props.saving} onClick={() => void save()}>{props.saving ? "保存中…" : "保存"}</button>
        <button type="button" onClick={cancel}>取消</button>
      </div>
    </div>
    {error && <p className="zy-edit-error" role="alert">{error}</p>}
    {props.kind === "html" ? <div className="wang-editor-box">
      <div className="editor-toolbar-box fix-top">
        <Toolbar editor={editorRef.current} defaultConfig={toolbarConfig} mode="default" className="editor-toolbar" />
      </div>
      <div className="wang-editor-content">
        <div className="editor-container"><div className="page-editor-body">
          <Editor defaultConfig={editorConfig} defaultHtml={body || "<p><br></p>"} onCreated={editor => { editorRef.current = editor; }} onChange={editor => setBody(editor.getHtml())} mode="default" style={{ minHeight: 420 }} />
        </div></div>
      </div>
    </div> : <div className="zy-mavon">
      <div className="zy-mavon-bar">
        {MARKDOWN_TOOLS.map(tool => <button type="button" key={tool.id} title={tool.label} onClick={() => apply(tool.id)}>{tool.label}</button>)}
      </div>
      <div className={`zy-mavon-body ${subfield && preview && !readmodel ? "split" : ""}`}>
        {!readmodel && <textarea ref={area} className="zy-mavon-input" placeholder="请录入文档内容" value={body} onChange={event => pushBody(event.target.value)} />}
        {(preview || readmodel) && <div className="zy-mavon-preview"><MarkdownContent documentKey={title || "draft"} source={body} onToc={() => undefined} /></div>}
      </div>
    </div>}
  </div>;
}
