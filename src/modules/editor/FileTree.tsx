import { Icon } from "@/components/icons";
/**
 * 文件树（CR-014 AC-09）：fsListDir 懒加载（根一层，文件夹点击展开/折叠递归加载）。
 * 前端过滤 node_modules/.git/target/dist（后端 fs_list_tree 已滤，fs_list_dir 需前端滤）。
 * 树上方搜索按钮弹出 fsSearch 内容搜索结果浮层，点击结果打开对应文件页签。
 */
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import * as api from "@/api";
import { Empty, useToast } from "@/components/ui";

/* ---------- 模型 ---------- */

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  expanded: boolean;
  loading: boolean;
  children: TreeNode[] | null; // null = 未加载，[] = 已加载为空
}

const HIDDEN = new Set(["node_modules", ".git", "target", "dist"]);

function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** 过滤隐藏目录、构建节点并排序（文件夹在前，名称不区分大小写）。 */
function clean(list: api.FileNode[]): TreeNode[] {
  return list
    .filter(n => !HIDDEN.has(n.name))
    .map(n => ({ name: n.name, path: n.path, isDir: n.isDir, expanded: false, loading: false, children: n.isDir ? null : [] }))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.isDir ? -1 : 1));
}

/* ---------- 图标 ---------- */

function FolderIcon({ open }: { open: boolean }) {
  return <Icon name={open ? "folderOpen" : "folder"} size={14} />;
}
function FileIcon() { return <Icon name="file" size={14} />; }
const SearchIcon = <Icon name="search" size={14} />;

/* ---------- 组件 ---------- */

export function FileTree({ rootUri, onOpenFile }: { rootUri: string; onOpenFile: (path: string) => void }) {
  const toast = useToast();
  const [nodes, setNodes] = useState<TreeNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [hits, setHits] = useState<api.SearchHit[]>([]);

  const load = useCallback(() => {
    setNodes(null);
    setError(null);
    api.fsListDir(rootUri, "")
      .then(list => setNodes(clean(list)))
      .catch(e => setError(errMsg(e)));
  }, [rootUri]);

  useEffect(() => {
    setSearchOpen(false);
    setQuery("");
    setHits([]);
    setSearched(false);
    load();
  }, [rootUri, load]);

  /** 不可变更新树中指定路径节点。 */
  const patchNode = useCallback((path: string, fn: (n: TreeNode) => TreeNode) => {
    setNodes(prev => {
      if (!prev) return prev;
      const walk = (list: TreeNode[]): TreeNode[] =>
        list.map(n => (n.path === path ? fn(n) : n.children && n.children.length ? { ...n, children: walk(n.children) } : n));
      return walk(prev);
    });
  }, []);

  const toggleDir = useCallback(
    (node: TreeNode) => {
      const willOpen = !node.expanded;
      patchNode(node.path, n => ({ ...n, expanded: willOpen }));
      if (willOpen && node.children === null) {
        patchNode(node.path, n => ({ ...n, loading: true }));
        api.fsListDir(rootUri, node.path)
          .then(list => patchNode(node.path, n => ({ ...n, loading: false, children: clean(list) })))
          .catch(e => {
            // children 置回 null，下次展开可重试
            patchNode(node.path, n => ({ ...n, loading: false, children: null }));
            toast(errMsg(e), "err");
          });
      }
    },
    [patchNode, rootUri, toast]
  );

  const runSearch = useCallback(() => {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    api.fsSearch(rootUri, q, 50)
      .then(list => {
        setHits(list);
        setSearched(true);
      })
      .catch(e => toast(errMsg(e), "err"))
      .finally(() => setSearching(false));
  }, [query, rootUri, toast, searching]);

  const renderRows = (list: TreeNode[], depth: number): ReactNode =>
    list.map(n => (
      <div key={n.path}>
        <div
          className={`cda-tree-row clickable ${n.isDir ? "dir" : "file"}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          title={n.path}
          onClick={() => (n.isDir ? toggleDir(n) : onOpenFile(n.path))}
        >
          <span className={`cda-chevron ${n.isDir ? "" : "leaf"}`}>{n.isDir ? <Icon name={n.expanded ? "chevronDown" : "chevronRight"} size={12} /> : ""}</span>
          {n.isDir ? <FolderIcon open={n.expanded} /> : <FileIcon />}
          <span className="cda-tree-name ellipsis">{n.name}</span>
          {n.loading && <span className="cda-loading">…</span>}
        </div>
        {n.isDir && n.expanded && n.children && renderRows(n.children, depth + 1)}
      </div>
    ));

  return (
    <>
      <div className="cda-tree-head">
        <span className="cda-tree-title">文件</span>
        <span className="spacer" />
        <button className="btn icon sm ghost" title="搜索文件内容" aria-label="搜索文件内容" onClick={() => setSearchOpen(v => !v)}>
          {SearchIcon}
        </button>
      </div>
      {searchOpen && (
        <div className="cda-search">
          <div className="row">
            <input
              className="input"
              autoFocus
              placeholder="搜索文件内容，Enter 确认"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") runSearch();
                if (e.key === "Escape") setSearchOpen(false);
              }}
            />
            <button className="btn sm" onClick={runSearch} disabled={searching}>搜索</button>
          </div>
          <div className="cda-search-list">
            {searching ? (
              <div className="cda-search-note muted small">搜索中…</div>
            ) : hits.length > 0 ? (
              hits.map(h => (
                <div key={`${h.path}:${h.lineNo}`} className="cda-hit clickable" title={h.path} onClick={() => onOpenFile(h.path)}>
                  <div className="cda-hit-path mono ellipsis">{h.path}:{h.lineNo}</div>
                  <div className="cda-hit-text mono ellipsis">{h.lineText}</div>
                </div>
              ))
            ) : (
              <div className="cda-search-note muted small">
                {searched ? "无匹配结果" : "输入关键词后按 Enter 或点击「搜索」"}
              </div>
            )}
          </div>
        </div>
      )}
      <div className="cda-tree-body">
        {error ? (
          <Empty title="读取目录失败" desc={error} action={<button className="btn sm" onClick={load}>重试</button>} />
        ) : nodes === null ? (
          <div className="cda-search-note muted small">加载目录…</div>
        ) : nodes.length === 0 ? (
          <Empty title="空目录" desc="项目根目录没有可见文件" />
        ) : (
          renderRows(nodes, 0)
        )}
      </div>
    </>
  );
}
