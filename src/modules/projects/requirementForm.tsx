/** CR-073：需求实体表单与 front matter 工具的共享模块。
 *  由「编辑需求」弹窗（Workspace.tsx）与导图右侧内联编辑面板（requirements）共用，
 *  保证校验规则、AC 编号规则与写回格式只有一个来源。 */
import { Field } from "@/components/ui";
import type { RequirementNode } from "@/api";

export interface NodeForm {
  title: string;
  status: string;
  owner: string;
  summary: string;
  estimate: string;
  acs: string;
  body: string;
}

export const NODE_STATUSES = ["待澄清", "待确认", "已就绪", "设计中", "开发中", "验证中", "待验收", "已完成", "阻塞", "取消"];

export const blankNodeForm = (): NodeForm => ({ title: "", status: "待澄清", owner: "", summary: "", estimate: "", acs: "", body: "" });

export function frontMatter(text: string): Record<string, string> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1] ?? "";
  return Object.fromEntries(block.split(/\r?\n/).map(line => /^([^:]+):\s*(.*)$/.exec(line)).filter((m): m is RegExpExecArray => !!m).map(m => [m[1].trim(), m[2].trim().replace(/^"|"$/g, "")]));
}

export function patchFrontMatter(text: string, fields: Record<string, string>): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const lines = match ? match[1].split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(fields)) {
    const i = lines.findIndex(line => line.startsWith(`${key}:`));
    const line = `${key}: ${value.replace(/[\r\n]/g, " ")}`;
    if (i < 0) lines.push(line); else lines[i] = line;
  }
  return `---\n${lines.join("\n")}\n---\n\n${match ? text.slice(match[0].length).trimStart() : text.trimStart()}`;
}

export function stripFrontMatter(md: string): string {
  if (md.startsWith("---")) {
    const end = md.indexOf("---", 3);
    if (end >= 0) return md.slice(end + 3).trimStart();
  }
  return md;
}

export function acSection(body: string): string {
  return /(?:^|\n)##\s+验收标准[^\n]*\n([\s\S]*?)(?=\n##\s|$)/.exec(body)?.[1].trim() ?? "";
}

export function writeAcSection(body: string, acs: string): string {
  const section = /(?:^|\n)##\s+验收标准[^\n]*\n[\s\S]*?(?=\n##\s|$)/;
  if (section.test(body)) return body.replace(section, `\n## 验收标准\n\n${acs.trim()}\n`);
  return acs.trim() ? `${body.trimEnd()}\n\n## 验收标准\n\n${acs.trim()}\n` : body;
}

/** 可观察验收条目：每行一条，保留已有 AC 编号，缺编号则按序号补齐。 */
export function normalizeAcs(raw: string, entityId: string): string {
  return raw.split(/\r?\n/).filter(line => line.trim())
    .map((line, i) => /AC-/.test(line) ? line.trim() : `- AC-${entityId}-${String(i + 1).padStart(2, "0")}：${line.trim()}`)
    .join("\n");
}

export const KIND_DIR: Record<string, string> = { epic: "Epic", feature: "Feature", story: "Story", bug: "Story" };

export function NodeFields({ kind, form, setForm, parent, disabled }: {
  kind: RequirementNode["kind"];
  form: NodeForm;
  setForm: (f: NodeForm) => void;
  parent: string;
  disabled: boolean;
}) {
  const field = (key: keyof NodeForm, value: string) => setForm({ ...form, [key]: value });
  return <div className="project-form-grid">
    <div className="form-two"><Field label="类型"><input className="input" value={{ epic: "史诗 Epic", feature: "特性 Feature", story: "用户故事 Story", bug: "缺陷 Bug", vision: "愿景 Vision" }[kind]} readOnly /></Field>
      <Field label="状态"><select className="input" value={form.status} disabled={disabled} onChange={e => field("status", e.target.value)}>{[...new Set([...NODE_STATUSES, form.status])].map(s => <option key={s}>{s}</option>)}</select></Field></div>
    <Field label="标题"><input className="input" value={form.title} disabled={disabled} onChange={e => field("title", e.target.value)} /></Field>
    <Field label="摘要"><textarea className="textarea" rows={2} value={form.summary} disabled={disabled} onChange={e => field("summary", e.target.value)} /></Field>
    <div className="form-two"><Field label="负责人"><input className="input" value={form.owner} disabled={disabled} onChange={e => field("owner", e.target.value)} /></Field><Field label="工作量"><input className="input" value={form.estimate} disabled={disabled} placeholder="例如：2 人日" onChange={e => field("estimate", e.target.value)} /></Field></div>
    {(kind === "story" || kind === "bug") && <Field label="可观察验收（每行一条，保留已有 AC 编号）"><textarea className="textarea mono" rows={4} value={form.acs} disabled={disabled} onChange={e => field("acs", e.target.value)} /></Field>}
    <Field label="所属"><input className="input" value={parent} readOnly /></Field>
    <Field label="正文（Markdown）" hint="保留未涉及的章节、历史记录和 AC 编号。"><textarea className="textarea mono" rows={8} value={form.body} disabled={disabled} onChange={e => field("body", e.target.value)} /></Field>
  </div>;
}
