import { Icon } from "@/components/icons";
import { TabMoreDropdown, TabMoreIcon, useTabOverflow } from "@/components/tab-overflow";
/**
 * 编辑器页签（CR-014 AC-09）：文件名、脏标记圆点、× 关闭。
 * 多页签切换由 CodeArea 保留各自内容与滚动位置。
 * CR-052 / UI-TAB-001：溢出统一走共享「更多」下拉，不出现横向滚动条。
 */

export interface TabInfo {
  path: string;
  dirty: boolean;
}

export function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

export function EditorTabs({
  tabs,
  active,
  onSelect,
  onClose,
}: {
  tabs: TabInfo[];
  active: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const items = tabs.map(t => ({ key: t.path, label: baseName(t.path), active: active === t.path }));
  const sig = items.map(item => `${item.key}:${item.label}:${item.active ? 1 : 0}`).join("|");
  const overflow = useTabOverflow({ tabSelector: ".cda-tab", items, deps: [sig] });
  return (
    <>
      <div ref={overflow.barRef} className="cda-tabs" role="tablist" aria-label="打开的文件">
        {tabs.length === 0 && <span className="cda-tabs-empty muted small">无打开文件</span>}
        {tabs.map(t => (
          <div
            key={t.path}
            role="tab"
            aria-selected={active === t.path}
            title={t.path}
            className={`cda-tab clickable ${active === t.path ? "active" : ""}`}
            onClick={() => onSelect(t.path)}
          >
            <span className="cda-tab-name ellipsis">{baseName(t.path)}</span>
            {t.dirty && <span className="cda-dirty" title="有未保存修改" />}
            <button
              className="cda-tab-close"
              aria-label={`关闭 ${t.path}`}
              onClick={e => {
                e.stopPropagation();
                onClose(t.path);
              }}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
        {tabs.length > 0 && <button {...overflow.moreProps}><TabMoreIcon /></button>}
      </div>
      {overflow.dropdownOpen && <TabMoreDropdown anchorRef={overflow.moreRef} items={items} onPick={onSelect} onClose={overflow.closeDropdown} />}
    </>
  );
}
