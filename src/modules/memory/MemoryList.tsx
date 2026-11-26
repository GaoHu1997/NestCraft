import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, useToast } from "@/components/ui";
import { memoryDeleteItem, memoryListItems, memoryUpdateItem } from "@/api/memory";
import type { MemoryItem } from "@/api/memory";

const KIND_LABELS: Record<string, string> = {
  fact: "事实",
  preference: "偏好",
  goal: "目标",
  event: "事件",
  decision: "决策",
  relation: "关系",
};

const SOURCE_LABELS: Record<string, string> = {
  message: "对话",
  session: "会话",
  manual: "手动",
  doc: "文档",
};

const KINDS = ["fact", "preference", "goal", "event", "decision", "relation"];

type StatusFilter = "active" | "all" | "superseded";

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

function stars(importance: number): string {
  const count = Math.max(0, Math.min(5, Math.round(importance)));
  return "★".repeat(count) + "☆".repeat(5 - count);
}

function formatTime(value: number): string {
  if (!value) return "—";
  const date = new Date(value < 1_000_000_000_000 ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sourceText(item: MemoryItem): string {
  const source = SOURCE_LABELS[item.sourceType] ?? item.sourceType;
  return `来源：${source || "未知"}${item.sourceRef ? ` · ${item.sourceRef}` : ""}`;
}

function LoadingCards() {
  return (
    <div className="memory-loading" aria-busy="true" aria-label="记忆加载中">
      {[0, 1, 2].map(index => (
        <div className="memory-card memory-skeleton-card" key={index}>
          <div className="memory-skeleton memory-skeleton-head" />
          <div className="memory-skeleton memory-skeleton-body" />
          <div className="memory-skeleton memory-skeleton-meta" />
        </div>
      ))}
    </div>
  );
}

function DeleteDialog({ item, busy, onCancel, onConfirm }: {
  item: MemoryItem;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (hard: boolean) => void;
}) {
  return (
    <Modal
      title="删除记忆"
      width={520}
      onClose={() => { if (!busy) onCancel(); }}
      footer={<>
        <button className="memory-btn" disabled={busy} onClick={onCancel}>取消</button>
        <button className="memory-btn" disabled={busy} onClick={() => onConfirm(false)}>软删除</button>
        <button className="memory-btn memory-btn-danger" disabled={busy} onClick={() => onConfirm(true)}>彻底删除</button>
      </>}
    >
      <div className="memory-delete-dialog">
        <p>确定删除这条记忆？</p>
        <blockquote className="memory-delete-quote">{item.content}</blockquote>
        <p className="memory-hint">软删除后列表不再显示，记录仍保留可追溯；彻底删除会物理移除且不可恢复。</p>
      </div>
    </Modal>
  );
}

export function MemoryList({ scope, onEditingChange, refreshToken, onChanged }: { scope:string; onEditingChange:(v:boolean)=>void; refreshToken: number; onChanged: () => void }) {
  const toast = useToast();
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftImportance, setDraftImportance] = useState(3);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MemoryItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setError(null);
    try {
      const rows = await memoryListItems({ scope, limit: 500 });
      if (seq !== loadSeq.current) return;
      setItems(rows);
    } catch (loadError) {
      if (seq !== loadSeq.current) return;
      setError(errText(loadError));
    }
  }, [scope]);

  useEffect(() => {
    setItems(null);
    setEditingId(null);
    void load();
  }, [load, refreshToken]);

  useEffect(() => () => { loadSeq.current += 1; }, []);
  useEffect(()=>{onEditingChange(editingId!==null||saving||deleting);},[editingId,saving,deleting,onEditingChange]);

  const needle = query.trim().toLowerCase();
  const rows = (items ?? [])
    .filter(item => item.status !== "deleted")
    .filter(item => statusFilter === "all" || item.status === statusFilter)
    .filter(item => !kindFilter || item.kind === kindFilter)
    .filter(item => {
      if (!needle) return true;
      return item.content.toLowerCase().includes(needle)
        || (item.memKey ?? "").toLowerCase().includes(needle)
        || (item.sourceRef ?? "").toLowerCase().includes(needle);
    })
    .sort((left, right) => Number(left.trust === "external") - Number(right.trust === "external"));
  const filtersActive = Boolean(needle) || Boolean(kindFilter) || statusFilter !== "active";

  const beginEdit = (item: MemoryItem) => {
    setEditingId(item.id);
    setDraft(item.content);
    setDraftImportance(Math.max(1, Math.min(5, item.importance || 3)));
  };

  const cancelEdit = () => {
    if (saving) return;
    setEditingId(null);
    setDraft("");
  };

  const saveEdit = async (item: MemoryItem) => {
    const content = draft.trim();
    if (!content || saving) return;
    setSaving(true);
    try {
      await memoryUpdateItem(item.id, content, draftImportance);
      setItems(previous => previous?.map(row => row.id === item.id
        ? { ...row, content, importance: draftImportance, updatedAt: Date.now() }
        : row) ?? previous);
      setEditingId(null);
      setDraft("");
      toast("记忆已更新");
      onChanged();
      void load();
    } catch (saveError) {
      toast(`保存失败：${errText(saveError)}`, "err");
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async (hard: boolean) => {
    const target = deleteTarget;
    if (!target || deleting) return;
    setDeleting(true);
    try {
      await memoryDeleteItem(target.id, hard);
      setItems(previous => previous?.filter(row => row.id !== target.id) ?? previous);
      setDeleteTarget(null);
      if (editingId === target.id) setEditingId(null);
      toast(hard ? "记忆已彻底删除" : "记忆已删除");
      onChanged();
      void load();
    } catch (deleteError) {
      toast(`删除失败：${errText(deleteError)}`, "err");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="memory-toolbar">
        <div className="memory-search">
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="搜索记忆…"
            aria-label="搜索记忆"
          />
        </div>
        <select
          className="memory-select"
          value={kindFilter}
          onChange={event => setKindFilter(event.target.value)}
          aria-label="按类型筛选"
        >
          <option value="">全部类型</option>
          {KINDS.map(kind => <option key={kind} value={kind}>{kindLabel(kind)}</option>)}
        </select>
        <select
          className="memory-select"
          value={statusFilter}
          onChange={event => setStatusFilter(event.target.value as StatusFilter)}
          aria-label="按状态筛选"
        >
          <option value="active">生效中</option>
          <option value="all">全部状态</option>
          <option value="superseded">已被取代</option>
        </select>
      </div>

      {error ? (
        <div className="memory-error" role="alert">
          <b>记忆加载失败</b>
          <p>{error}</p>
          <button className="memory-btn" onClick={() => { setItems(null); void load(); }}>重试</button>
        </div>
      ) : items === null ? (
        <LoadingCards />
      ) : rows.length === 0 ? (
        <div className="memory-empty" role="status">
          <div className="memory-empty-icon" aria-hidden="true">🗂️</div>
          <div>{filtersActive ? "没有匹配的记忆" : "还没有记忆"}</div>
          <div className="memory-hint">
            {filtersActive ? "调整搜索词或筛选条件后再试。" : (scope==='global'?"通用偏好会进入个人记忆；项目约束请在对应项目范围查看。":"当前项目尚无记忆，不会展示其他项目的记录。")}
          </div>
        </div>
      ) : (
        <div className="memory-scroll" aria-label="记忆列表">
          {rows.map(item => {
            const editing = editingId === item.id;
            return (
              <article className="memory-card" key={item.id}>
                <div className="memory-card-head">
                  <span className={`memory-badge memory-badge-${item.kind}`}>{kindLabel(item.kind)}</span>
                  <span className="memory-badge">{item.scope==='global'?'个人记忆':'项目记忆'}</span>
                  <span className="memory-stars" title={`重要度 ${item.importance}/5`} aria-label={`重要度 ${item.importance}/5`}>
                    {stars(item.importance)}
                  </span>
                  {item.status === "superseded" && <span className="memory-badge">已被取代</span>}
                  {item.trust === "external" && <span className="memory-badge" title="外部来源，低信任">外部</span>}
                  {!editing && (
                    <div className="memory-row-actions">
                      <button className="memory-mini" onClick={() => beginEdit(item)}>编辑</button>
                      <button className="memory-mini memory-mini-danger" onClick={() => setDeleteTarget(item)}>删除</button>
                    </div>
                  )}
                </div>

                {editing ? (
                  <div className="memory-edit">
                    <textarea
                      value={draft}
                      maxLength={2048}
                      autoFocus
                      disabled={saving}
                      onChange={event => setDraft(event.target.value)}
                      aria-label="编辑记忆内容"
                    />
                    <div className="memory-edit-foot">
                      <label className="memory-importance">
                        重要度
                        <select
                          className="memory-select"
                          value={draftImportance}
                          disabled={saving}
                          onChange={event => setDraftImportance(Number(event.target.value))}
                          aria-label="重要度"
                        >
                          {[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value} 星</option>)}
                        </select>
                      </label>
                      <span className="memory-edit-count">{draft.length}/2048</span>
                      <button className="memory-btn" disabled={saving} onClick={cancelEdit}>取消</button>
                      <button className="memory-btn memory-btn-primary" disabled={saving || !draft.trim()} onClick={() => void saveEdit(item)}>
                        {saving ? "保存中…" : "保存"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="memory-card-body">{item.content}</div>
                    <div className="memory-meta">
                      <span>{sourceText(item)}</span>
                      <span>{formatTime(item.updatedAt || item.createdAt)}</span>
                    </div>
                  </>
                )}
              </article>
            );
          })}
        </div>
      )}

      {deleteTarget && (
        <DeleteDialog
          item={deleteTarget}
          busy={deleting}
          onCancel={() => { if (!deleting) setDeleteTarget(null); }}
          onConfirm={hard => void confirmDelete(hard)}
        />
      )}
    </>
  );
}
