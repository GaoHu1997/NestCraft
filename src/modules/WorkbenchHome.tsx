import { useEffect, useState } from "react";
import * as api from "@/api";
import { useApp } from "@/store/app";
import { Empty } from "@/components/ui";

interface RequirementItem {
  projectId: string;
  projectName: string;
  node: api.RequirementNode;
}

export function WorkbenchHome() {
  const { go } = useApp();
  const [requirements, setRequirements] = useState<RequirementItem[]>([]);
  const [libraries, setLibraries] = useState<api.KnowledgeLibrary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const projects = await api.listProjects();
        const list: RequirementItem[] = [];
        for (const project of projects.filter(project => project.kind === "code")) {
          const tree = await api.readRequirements(project.id);
          const add = (nodes: api.RequirementNode[]) => {
            for (const node of nodes) {
              list.push({ projectId: project.id, projectName: project.name, node });
              add(node.children);
            }
          };
          add(tree);
        }
        const libraries = await api.kbList();
        if (alive) {
          setRequirements(list);
          setLibraries(libraries);
        }
      } catch (error) {
        if (alive) setError(String(error));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const completed = requirements.filter(item => item.node.status === "已完成");
  const waiting = requirements.filter(item => ["待验收", "阻塞", "待确认", "待澄清"].includes(item.node.status ?? ""));
  const open = (item: RequirementItem) => go({ page: "project", projectId: item.projectId, tab: "requirements" });

  return (
    <div className="pagebody nc-home">
      <div className="nc-page-heading">
        <div><h1>工作台</h1><p>今天需要处理什么、哪些运行还在跑，都集中这里。</p></div>
        <button className="btn" onClick={() => go({ page: "projects" })}>全部项目</button>
      </div>
      {error && <div className="nc-error" role="alert">部分数据读取失败：{error}</div>}
      <div className="nc-stats">
        <div><span>运行中</span><strong className="c-blue">—<small>个</small></strong></div>
        <div><span>等待依赖</span><strong className="c-amber">—<small>个</small></strong></div>
        <div><span>已完成需求</span><strong className="c-green">{loading ? "—" : completed.length}<small>条</small></strong></div>
        <div><span>待我处理</span><strong>{loading ? "—" : waiting.length}<small>项</small></strong></div>
      </div>
      <div className="nc-dashboard-grid">
        <section className="card nc-dashboard-card">
          <div className="nc-card-heading"><h3>活动运行</h3><span className="muted small">执行内核未接入</span></div>
          <Empty title="暂无可读取的项目运行" desc="当前未提供项目 Task／Run 数据，不用演示数量冒充实际执行。" />
        </section>
        <section className="card nc-dashboard-card">
          <div className="nc-card-heading"><h3>待我处理</h3><span className="muted small">{waiting.length} 项</span></div>
          {waiting.length === 0 ? <Empty title={loading ? "加载中…" : "没有待处理项"} /> : waiting.map(item => (
            <button key={`${item.projectId}-${item.node.entityId}`} className="nc-list-row" onClick={() => open(item)}>
              <span className="nc-kind">{item.node.kind.toUpperCase()}</span>
              <span className="grow"><b>{item.node.title}</b><small>{item.node.entityId} · {item.projectName}</small></span>
              <span className="tag">{item.node.status}</span>
            </button>
          ))}
        </section>
        <section className="card nc-dashboard-card">
          <div className="nc-card-heading"><h3>最近完成</h3></div>
          {completed.length === 0 ? <Empty title={loading ? "加载中…" : "暂无已完成需求"} /> : completed.slice(0, 4).map(item => (
            <button key={`${item.projectId}-${item.node.entityId}`} className="nc-list-row" onClick={() => open(item)}>
              <span className="tag good">已完成</span><span className="grow ellipsis">{item.node.title}</span><small>{item.node.entityId}</small>
            </button>
          ))}
        </section>
        <section className="card nc-dashboard-card">
          <div className="nc-card-heading"><h3>最近更新的知识</h3></div>
          {libraries.length === 0 ? <Empty title={loading ? "加载中…" : "暂无知识库"} /> : libraries.slice(0, 4).map(library => (
            <button key={library.id} className="nc-list-row" onClick={() => go({ page: "knowledge-lib", libId: library.id })}>
              <span className="grow">{library.name}</span><small>{library.noteCount} 篇 · 版本 {library.revision}</small>
            </button>
          ))}
        </section>
      </div>
      <div className="nc-page-foot"><span>需求和知识取自已登记项目；运行数量未知，不展示合成成绩。</span><span>栖造 · NestCraft</span></div>
    </div>
  );
}
