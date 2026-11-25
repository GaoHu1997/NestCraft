import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import "./composer-hat.css";

/**
 * CR-079：会话框顶部“帽子”运行栏，与输入区同属一张圆角卡片。
 * 左侧 CLI／助理切换；右侧当前 git 分支（可展开查看分支）；最右 worktree 开关。
 * 分支列表只读查看：真实切分支仍走编码页 Git 面板，避免脏改动被静默覆盖。
 */
export function ComposerHat(props: {
  runner: "cli" | "platform";
  platformAvailable: boolean;
  branch: string | null;
  branches: { name: string; current: boolean }[];
  worktree: boolean;
  locked?: boolean;
  onRunnerChange: (next: "cli" | "platform") => void;
  onWorktreeChange: (next: boolean) => void;
}) {
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const platform = props.runner === "platform";
  const platformOk = props.platformAvailable;
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element)) return;
      if (!e.target.closest("[data-hat-branch]")) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown, true); document.removeEventListener("keydown", onKey); };
  }, [menu]);
  return (
    <div className="chat-hat" role="group" aria-label="运行与工作区">
      <div className="chat-hat-seg" role="tablist" aria-label="运行通道">
        <button type="button" role="tab" aria-selected={!platform} className={`chat-hat-opt ${!platform ? "on" : ""}`} disabled={props.locked} title="CLI 进程：由已安装的 CLI 作答，支持原生续接" onClick={() => { if (platform) props.onRunnerChange("cli"); }}>
          <Icon name="terminal" size={13} />CLI
        </button>
        <button type="button" role="tab" aria-selected={platform} className={`chat-hat-opt ${platform ? "on" : ""}`} disabled={props.locked || !platformOk} title={platformOk ? "助理：平台主代理直接调用已配置模型作答" : "助理不可用：需要已启用的供应商、端点与密钥"} onClick={() => { if (!platform && platformOk) props.onRunnerChange("platform"); }}>
          <Icon name="sparkles" size={13} />助理
        </button>
      </div>
      <span className="chat-hat-spacer" />
      {props.branch && (
        <div className="chat-hat-branch-wrap" ref={box} data-hat-branch>
          <button type="button" className="chat-hat-branch" aria-haspopup="menu" aria-expanded={menu} title={`当前分支：${props.branch}（点击查看分支）`} onClick={() => setMenu(v => !v)}>
            <Icon name="branch" size={13} />
            <span className="ellipsis">{props.branch}</span>
            <Icon name={menu ? "chevronUp" : "chevronDown"} size={12} />
          </button>
          {menu && (
            <div className="chat-hat-branch-menu" role="menu" aria-label="分支列表">
              {props.branches.length ? props.branches.map(b => (
                <button key={b.name} type="button" role="menuitem" className={`chat-hat-branch-item ${b.current ? "on" : ""}`} title={b.current ? "当前分支" : `${b.name} · 请在编码页 Git 面板切换`} onClick={() => setMenu(false)}>
                  {b.current ? <Icon name="check" size={12} /> : <span className="chat-hat-branch-dot" />}
                  <span className="ellipsis">{b.name}</span>
                </button>
              )) : <div className="chat-hat-branch-empty">没有可查看的分支</div>}
              <div className="chat-hat-branch-foot">切换分支请在编码页 Git 面板操作</div>
            </div>
          )}
        </div>
      )}
      <label className="chat-hat-worktree" title="勾选后当前会话将在独立 git worktree 工作区执行">
        <input type="checkbox" checked={props.worktree} disabled={props.locked} onChange={e => props.onWorktreeChange(e.currentTarget.checked)} />
        <span>worktree</span>
      </label>
    </div>
  );
}
