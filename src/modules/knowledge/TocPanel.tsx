/** 右栏标题目录（TOC）：按标题级别缩进，点击平滑定位到正文对应标题（CR-014 AC-03）。
 *  id 由 renderMarkdown 注入、extractToc 提取，两边规则一致（见 components/ui.tsx）。 */

export interface TocEntry {
  level: number;
  text: string;
  id: string;
}

export function TocPanel(props: { toc: TocEntry[]; onJump: (id: string) => void }) {
  const { toc, onJump } = props;
  return (
    <div className="kb-toc-panel">
      <div className="kb-toc-head">正文目录</div>
      {toc.length === 0 ? (
        <div className="muted small kb-toc-empty">暂无目录</div>
      ) : (
        <nav className="kb-toc-list">
          {toc.map((t, i) => (
            <button
              key={`${t.id}-${i}`}
              className="kb-toc-item ellipsis"
              style={{ paddingLeft: 8 + (t.level - 1) * 14 }}
              title={t.text}
              onClick={() => onJump(t.id)}
            >
              {t.text}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
