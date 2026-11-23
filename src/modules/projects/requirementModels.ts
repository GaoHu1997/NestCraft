import * as api from "@/api";

/** UI-CR066 r2：数据库／领域设计模型的只读投影。
 *  CR-029 §2.2 明确：模型沿用设计工作区「数据库设计」含义，不是供应商 AI 模型；
 *  模型与需求是关联关系，不是 Story 的第二个父项；未关联模型单独收纳在项目模型分支。
 *  本模块只读 `docs/DB/` 下的 Markdown 标题，不解析表结构、不执行 SQL、不写库。 */

export interface DesignModel {
  /** 稳定身份：DB-<编号>；无编号时用相对路径做稳定键。 */
  id: string;
  title: string;
  /** 项目内相对路径，例如 docs/DB/DB-CR027-设计资料索引与模型记录.md（用于显示） */
  relPath: string;
  /** 绝对路径（与 fsListTree / fsReadFile 一致），用于定位到设计页签的对应文件。 */
  absPath: string;
}

export function projectRelativePath(root: string, path: string): string {
  const normalize = (value: string) => value.replace(/\\/g, "/");
  const base = normalize(root).replace(/\/$/, "");
  const full = normalize(path);
  return full.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? full.slice(base.length + 1) : full;
}

/** 从 Markdown 首行标题提取模型身份。
 *  优先取 `DB-<编号>：<标题>`；没有编号但标题含「模型」时也识别为模型，编号回落到文件名；
 *  都不满足时按普通文档处理（标题原样，编号用文件名派生），不伪造 DB 编号。 */
export function parseModelTitle(markdown: string, relPath: string, absPath = ""): DesignModel {
  const heading = markdown.split(/\r?\n/).find(line => /^#\s+/.test(line)) ?? "";
  const raw = heading.replace(/^#\s+/, "").trim();
  const fileName = relPath.split("/").pop() ?? relPath;
  const numbered = /^(DB-[A-Za-z0-9-]+)\s*[：:]\s*(.+)$/.exec(raw);
  if (numbered) return { id: numbered[1], title: numbered[2].trim(), relPath, absPath };
  const plain = /^([^：:]+)\s*[：:]\s*(.+)$/.exec(raw);
  if (plain && /模型/.test(plain[1]) && /模型/.test(plain[2])) {
    return { id: fileName.replace(/[^\w.-]+/g, "-").replace(/\.md$/i, ""), title: plain[2].trim(), relPath, absPath };
  }
  return { id: fileName.replace(/[^\w.-]+/g, "-").replace(/\.md$/i, ""), title: raw || fileName, relPath, absPath };
}

/** 读取项目 `docs/DB/` 下的数据库设计文档；目录缺失或读取失败时返回空列表，不伪造模型。 */
export async function readDesignModels(rootUri: string): Promise<DesignModel[]> {
  let tree: api.FileNode[];
  try {
    /* 深度上限与设计工作区一致（20）；夹具与真实后端都接受该范围。 */
    tree = await api.fsListTree(rootUri, 20);
  } catch {
    return [];
  }
  const candidates = tree.filter(file => {
    if (file.isDir) return false;
    const rel = projectRelativePath(rootUri, file.path).toLowerCase();
    return rel.startsWith("docs/db/") && /\.(md|markdown)$/.test(rel);
  });
  const models: DesignModel[] = [];
  for (const file of candidates) {
    const relPath = projectRelativePath(rootUri, file.path);
    try {
      const text = await api.fsReadFile(rootUri, file.path);
      models.push(parseModelTitle(text, relPath, file.path));
    } catch {
      // 单个模型文档读不到时不静默丢弃，也不伪造标题；用路径占位并由调用方标注未读取。
      models.push({ id: relPath.replace(/[^\w.-]+/g, "-"), title: relPath, relPath, absPath: file.path });
    }
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}
