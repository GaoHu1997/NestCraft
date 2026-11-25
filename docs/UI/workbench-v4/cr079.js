/* UI-CR079-v1（设计稿）：会话框顶部“帽子”运行栏——运行通道 CLI/助理、当前分支、worktree 开关。
   仅设计原型，不改正式软件；UI-SCROLL-001 继承（分支下拉内部滚动复用共享规则）。 */
window.CR079 = (function () {
  "use strict";
  const { store, toast, render } = UI;
  store.aiWorktree = Boolean(store.aiWorktree);
  store.platformPermission = store.platformPermission || "受限";
  store.aiBranchMenu = Boolean(store.aiBranchMenu);
  // 合成分支列表（演示查看/选择；真实项目从 git 读取，无仓库则不显示分支 chip）。
  if (!Array.isArray(store.gitBranches) || !store.gitBranches.length) {
    store.gitBranches = ["main", store.gitBranch || "feature/booking-idempotency", "develop", "release/2026.11"];
  }

  // 助理（平台主代理）专属权限档位，由平台工具白名单与运行策略决定，与 CLI 档位分开。
  const platformPermissions = [
    { id: "readonly", name: "只读", icon: "eye", desc: "仅读取/查询类工具，不写文件、不执行命令", available: true },
    { id: "limited", name: "受限", icon: "shield", desc: "白名单工具可读，写入与命令需逐次确认", available: true },
    { id: "full", name: "完全访问", icon: "zap", desc: "白名单内全部工具【谨慎使用】", available: true },
  ];

  // 当前模型若不属于本通道的候选（如静态夹具遗留的供应商），校正为第一个可用模型，
  // 避免触发器显示“（不可用）默认”而无法选择。仅演示夹具，不改真实配置。
  (function alignCurrent() {
    const cat = UI.D.ai.modelCatalog;
    if (!cat || !Array.isArray(cat.providers)) return;
    const list = cat.providers.filter(p => p.models && p.models.length);
    if (!list.length) return;
    const owner = list.find(p => p.name === cat.current.provider && p.models.some(m => m.name === cat.current.model));
    if (owner) return;
    const p = list[0], m = p.models[0];
    cat.current.provider = p.name;
    cat.current.model = m.name;
    const levels = UI.CR074 && UI.CR074.efforts ? UI.CR074.efforts(m) : (m.levels || []);
    if (levels.length && !levels.includes(cat.current.level)) {
      cat.current.level = levels.find(x => String(x).toLowerCase() === "high") || levels[0];
    } else if (!levels.length) cat.current.level = "—";
  })();

  function bind() {
    const actions = window.__actions;
    if (!actions) { window.setTimeout(bind, 0); return; }
    if (!actions["ai-worktree"]) {
      actions["ai-worktree"] = el => {
        store.aiWorktree = Boolean(el.checked);
        toast(el.checked ? "已启用：当前会话将在独立 worktree 工作区执行（执行隔离后续接入）" : "已关闭独立 worktree 工作区");
        render();
      };
    }
    if (!actions["ai-platform-perm-set"]) {
      actions["ai-platform-perm-set"] = el => { store.platformPermission = el.dataset.name; store.aiPop = null; render(); };
    }
    if (!actions["ai-branch"]) {
      actions["ai-branch"] = () => {
        store.aiBranchMenu = !store.aiBranchMenu;
        render();
        if (store.aiBranchMenu) requestAnimationFrame(() => {
          const btn = document.querySelector(".ai-hat-branch");
          const menu = document.querySelector(".ai-branch-menu");
          if (btn && menu) {
            const r = btn.getBoundingClientRect();
            menu.style.top = (r.bottom + 6) + "px";
            menu.style.left = Math.max(8, r.right - menu.offsetWidth) + "px";
          }
        });
      };
    }
    if (!actions["ai-branch-pick"]) {
      actions["ai-branch-pick"] = el => {
        const b = el.dataset.branch;
        store.aiBranchMenu = false;
        if (b !== store.gitBranch) toast("设计演示：将切换到分支 " + b + "（真实切换需 Git 权限与脏改动校验）");
        render();
      };
    }
  }
  bind();

  return { platformPermissions };
})();
