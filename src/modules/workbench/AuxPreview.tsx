import { Icon } from "@/components/icons";
import { useEffect, useState } from "react";
import type * as api from "@/api";
import * as apiNs from "@/api";
import type { AuxTarget } from "./Workbench";

/**
 * CR-054 / STORY-072：辅助栏只读预览。
 *
 * 约束：
 * - 只读：不写文件、不触发自动保存、不改变编辑草稿或选区；
 * - 不扩权：读取范围与现有能力一致（项目文件 / 需求源 / 已授权知识）；
 * - 失败显式：目标不存在、无权限、格式不支持都给明确说明，不伪造正文。
 */
export function AuxPreview({ target, project }: { target: AuxTarget; project: api.Project }) {
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; text?: string; message?: string }>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    const load = async () => {
      try {
        if (target.kind === "file") {
          if (!target.path) throw new Error("缺少文件路径");
          const text = await apiNs.fsReadFile(project.rootUri, target.path);
          if (alive) setState({ status: "ready", text });
          return;
        }
        if (target.kind === "requirement") {
          const sources = await apiNs.readRequirementSources(project.id);
          const id = target.key.replace(/^req:/, "");
          const body = (sources as unknown as Record<string, string>)[id];
          if (!body) throw new Error("该项目未提供此需求实体的正文");
          if (alive) setState({ status: "ready", text: body });
          return;
        }
        if (target.kind === "knowledge") {
          const [, libId, noteId] = target.key.split(":");
          if (!libId || !noteId) throw new Error("缺少知识库或笔记标识");
          const note = await apiNs.kbRead(libId, noteId);
          if (alive) setState({ status: "ready", text: note.content ?? "" });
          return;
        }
        if (target.kind === "office-file") {
          if (alive) setState({ status: "error", message: "办公文件请在「文档」页签查看：本栏不复制办公查看器，避免格式失真。" });
          return;
        }
        if (alive) setState({ status: "error", message: "不支持的目标类型" });
      } catch (e) {
        if (alive) setState({ status: "error", message: String(e instanceof Error ? e.message : e) });
      }
    };
    void load();
    return () => { alive = false; };
  }, [project.id, project.rootUri, target.key, target.kind, target.path]);

  const path = target.path ?? target.title;
  return <>
    <div className="wb-aux-path">
      <Icon name={target.kind === "requirement" ? "fileText" : target.kind === "knowledge" ? "database" : "file"} size={12} />
      <span className="ellipsis" title={path}>{path}</span>
    </div>
    <h3 className="wb-aux-title">{target.title}</h3>
    <div className="wb-aux-meta">
      <span className="tag">{kindLabel(target.kind)}</span>
      <span className="tag">只读</span>
      {target.line ? <span className="tag">定位到第 {target.line} 行</span> : null}
    </div>
    {state.status === "loading" && <div className="wb-aux-state" role="status">加载中…</div>}
    {state.status === "error" && (
      <div className="wb-aux-state error" role="alert">
        <b>无法预览</b>
        <span>{state.message}</span>
      </div>
    )}
    {state.status === "ready" && (
      <pre className="wb-aux-code">{highlightLine(state.text ?? "", target.line)}</pre>
    )}
    <p className="wb-aux-note">只读预览，不修改原件；真实能力以实现阶段既有查看器为准。</p>
  </>;
}

function kindLabel(kind: AuxTarget["kind"]): string {
  if (kind === "requirement") return "需求";
  if (kind === "knowledge") return "知识";
  if (kind === "office-file") return "办公文件";
  return "文件";
}

/** 只读文本呈现；指定行时标出行号，便于核对定位是否准确。 */
function highlightLine(text: string, line?: number): string {
  const lines = text.split("\n").slice(0, 400);
  if (!line) return lines.slice(0, 200).map((l, i) => `${String(i + 1).padStart(4, " ")}  ${l}`).join("\n");
  return lines.map((l, i) => `${i + 1 === line ? "▶" : " "}${String(i + 1).padStart(4, " ")}  ${l}`).join("\n");
}
