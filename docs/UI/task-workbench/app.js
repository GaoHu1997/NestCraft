/* CR-016 可操作评审稿。仅本机状态仿真，所有真实执行能力均未接入。 */
(function () {
  "use strict";
  const S = window.TaskReviewScheduler, storageKey = "cr016-task-review-v1";
  const $ = selector => document.querySelector(selector);
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const terminal = status => ["succeeded", "failed", "cancelled", "blocked"].includes(status);
  const stateLabels = { queued: "排队中", waiting_dependency: "等依赖", waiting_resource: "等资源", preparing: "准备中", running: "运行中", verifying: "验证中", integrating: "集成中", retry_wait: "等待重试", paused: "已暂停", blocked: "被前置阻塞", succeeded: "成功", failed: "失败", cancelled: "已取消" };
  const storyLabels = { ready: "已就绪", unconfirmed: "待确认", unsynced: "待同步", executing: "开发中", verifying: "验证中", blocked: "阻塞", pending_acceptance: "待验收", completed: "已完成", cancelled: "已取消" };
  const batchLabels = { running: "进行中", succeeded: "全部成功", partial: "部分成功", failed: "失败", cancelled: "已取消" };
  const stepLabels = { prepare: "准备", run: "执行", verify: "验证", integrate: "集成", deliver: "交付" };
  const resultLabels = { pending: "未执行", running: "进行中", passed: "仿真通过", failed: "仿真失败", not_applicable: "不适用" };
  const scenarioLabels = {
    normal: "正常场景：先契约，再前后端并行；审计独立执行，共享数据资源自动串行。", "network-retry": "后端出现一次暂时故障，调度器自动建立新 attempt；无实际网络请求。",
    "retry-exhausted": "后端暂时故障持续，自动重试到限后失败；独立分支继续。", "verify-rework": "前端 AC 验证一次失败，保留失败证据并自动返工一次。",
    "verify-exhausted": "契约 AC 验证持续失败，返工到限，后代阻塞而独立分支继续。", "parent-failure": "契约永久失败，前后端与交付后代阻塞，独立审计和资源任务继续。",
    "parent-cancel": "契约运行中被模拟取消，后代不会把取消当成功；独立分支继续。", "config-invalid": "批次执行配置失效，预检直接拒绝，不创建任务。",
    "model-invalid": "仿真时钟第 4 步禁用 Codex 样例模型，相关分支停止，独立 Claude 审计继续。", "permission-invalid": "第 4 步撤销 Codex 样例写权限，相关分支停止。",
    "requirement-change": "第 4 步改变契约需求 hash，受影响运行和后代失效，不改变未选择范围。", cycle: "人为设置显式执行 DAG 循环；业务父树不变，预检拒绝派发。",
    budget: "批次预算仅 6 个仿真单位，到限止损；真实账单与真实 usage 均未知。", "auto-accept": "显式客观自动验收演示模式：仿真 AC / 产物 / 集成全通过才将 DEMO Story 标完成；不代表用户实际验收。"
  };
  const defaultUI = () => ({ page:"projects",projectId:"DEMO-PROJECT-01",tab:"requirements",selectedRequirement:"DEMO-EPIC-01",collapsed:new Set(["DEMO-EPIC-02"]),batch:"all",status:"all",query:"",taskId:null,artifactRevision:null,projectQuery:"",designKind:"ui",codeKind:"files",file:"README.md",note:"guide",knowledgeQuery:"",serverId:"demo-staging",commentDraft:"",settingsTab:"general" });
  let state = S.createState(), ui = defaultUI(), preview = null, dialogMode = null, returnFocus = null;
  let timer = null, scheduledCallback = null, timerGeneration = 0, intervalMs = 700, callbackCount = 0, toastTimer = null;
  let storage = { mode: "local", message: "仅本机评审快照 · 关页停止仿真 · 不是 daemon" };
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) { state = S.restore(JSON.parse(raw)); storage.message = "已恢复本机评审快照 · 关页期间没有执行 · 单一页面计时器继续仿真 · 不是 daemon"; }
  } catch (error) { storage = { mode: "memory", message: "评审快照无法读取或恢复；使用独立空样例在内存运行。" }; }

  function statusBadge(status) { return `<span class="status status-${escape(status)}">${escape(stateLabels[status] || status)}</span>`; }
  function facts(entries) { return `<dl class="facts">${entries.map(([key, value]) => `<dt>${escape(key)}</dt><dd>${value}</dd>`).join("")}</dl>`; }
  function empty(title, description, action = "") { return `<div class="empty"><strong>${escape(title)}</strong><p>${escape(description)}</p>${action}</div>`; }
  function button(text, action, id = "", extra = "", cls = "") { return `<button type="button" class="btn sm ${cls}" data-action="${action}" ${id ? `data-id="${escape(id)}"` : ""} data-key="${action}:${escape(id)}" ${extra}>${escape(text)}</button>`; }
  const taskFor = id => state.tasks.find(t => t.id === id);
  const requirementFor = id => state.requirements.find(r => r.id === id);
  const batchFor = id => state.batches.find(b => b.id === id);

  function save(manual = false) {
    try { localStorage.setItem(storageKey, JSON.stringify(S.snapshot(state))); if (storage.mode === "memory") storage.message = "本机评审快照可用 · 仅保存样例 · 关页停止 · 不是 daemon"; storage.mode = "local"; if (manual) toast("评审快照已保存；关页后不会继续执行"); }
    catch (error) { storage = { mode: "memory", message: "本机存储不可用，当前在内存运行；刷新会丢失未保存的评审状态。正式后台未实现。" }; if (manual) toast("写入存储失败，仍可在内存中评审"); }
    updateTop();
  }

  function updateTop() {
    $("#clock-label").textContent = `仿真时钟 ${state.clock}${state.paused ? " · 暂停" : ""}`;
    if ($("#task-count")) $("#task-count").remove();
    $("#storage-notice").textContent = storage.message;
    $("#storage-notice").classList.toggle("error", storage.mode === "memory");
    $("#scenario-description").textContent = scenarioLabels[state.scenario] || scenarioLabels.normal;
    $("#scenario-select").value = state.scenario;
    const stories = state.requirements.filter(r => r.kind === "story"), injection = $("#injection-story");
    if (injection && injection.options.length !== stories.length) { const selected = injection.value; injection.innerHTML = stories.map(r => `<option value="${escape(r.id)}">${escape(r.id)} · ${escape(r.title)}</option>`).join(""); if (stories.some(r => r.id === selected)) injection.value = selected; }
  }

  function toast(message) {
    clearTimeout(toastTimer); $("#toast").textContent = message; $("#toast").hidden = false;
    toastTimer = setTimeout(() => { $("#toast").hidden = true; }, 3600);
  }

  function stopClock() { timerGeneration++; if (timer !== null) clearTimeout(timer); timer = null; scheduledCallback = null; }
  function startClock() {
    stopClock();
    if (state.paused || !state.tasks.some(t => !terminal(t.status) && t.status !== "paused")) return;
    const currentGeneration = timerGeneration, currentEpoch = state.epoch;
    scheduledCallback = function () {
      if (currentGeneration !== timerGeneration || currentEpoch !== state.epoch) return;
      timer = null; callbackCount++; state = S.tick(state, currentEpoch); save(); render(); startClock();
    };
    timer = setTimeout(scheduledCallback, intervalMs);
  }

  function apply(next) { state = next; save(); render(); startClock(); }
  function selectTab(tab) { ui.tab = tab; render(); }

  function descendantStories(id) {
    const collected = [];
    function collect(parent) { for (const child of state.requirements.filter(r => r.parent === parent)) { if (child.kind === "story") collected.push(child); else collect(child.id); } }
    const node = requirementFor(id); if (node?.kind === "story") return [node]; collect(id); return collected;
  }

  function renderRequirements() {
    const row = (node, depth) => {
      const children = state.requirements.filter(r => r.parent === node.id), collapsed = ui.collapsed.has(node.id), stories = descendantStories(node.id);
      const tag = node.kind === "story" ? storyLabels[node.status] : `${stories.length} Story`;
      const line = `<div class="tree-row depth-${depth}${ui.selectedRequirement === node.id ? " selected" : ""}" role="treeitem" aria-level="${depth + 1}" aria-selected="${ui.selectedRequirement === node.id}" ${children.length ? `aria-expanded="${!collapsed}"` : ""} data-node="${node.id}">
        <div class="node-label">${children.length ? `<button class="caret" type="button" data-action="collapse" data-id="${node.id}" data-key="collapse:${node.id}" aria-label="${collapsed ? "展开" : "折叠"}${escape(node.title)}" aria-expanded="${!collapsed}">${collapsed ? "▸" : "▾"}</button>` : '<span class="kind-dot" aria-hidden="true"></span>'}<button class="node-open" type="button" data-action="node" data-id="${node.id}" data-key="node:${node.id}"><span>${node.id}</span><strong>${escape(node.title)}</strong></button></div>
        <span class="tag ${node.kind === "story" && node.status === "ready" ? "blue" : ""}">${escape(tag)}</span><button type="button" class="btn sm link" data-action="preflight" data-type="${node.kind}" data-id="${node.id}" data-key="dispatch:${node.id}" aria-label="派发 ${node.id}">派发</button></div>`;
      return line + (!collapsed ? children.map(child => row(child, depth + 1)).join("") : "");
    };
    const selected = requirementFor(ui.selectedRequirement) || requirementFor("DEMO-EPIC-01"), stories = descendantStories(selected.id);
    const selectedDetails = selected.kind === "story" ? facts([
      ["编号", escape(selected.id)], ["需求状态", escape(storyLabels[selected.status])], ["前置", escape(selected.dependencies.map(d => d.storyId).join("、") || "无，可独立执行")],
      ["样例执行器", escape(`${selected.executor.cli} / ${selected.executor.model}`)], ["资源", escape(selected.resources.join("、") || "无共享资源")],
      ["需求修订", `<code>${escape(selected.requirementHash)}</code>`], ["设计修订", `<code>${escape(selected.designHash)}</code>`], ["AC 修订", `<code>${escape(selected.acHash)}</code>`]
    ]) + `<div class="detail-section"><h3>可观察验收（DEMO）</h3><ul class="simple-list">${selected.ac.map(ac => `<li>${escape(ac)}：产物符合冻结规则，验证与适用集成通过。</li>`).join("")}</ul></div>` : facts([
      ["业务归属", escape(selected.id)], ["下级故事", `${stories.length} 个 DEMO Story`], ["当前范围", "仅当前评审项目，不包含正式仓库需求"], ["默认交付", "技术交付成功后待验收"], ["执行依赖", "显式 DAG 决定，父子层级不决定启动顺序"]
    ]);
    return `<div class="page-heading"><div><h2>需求与迭代</h2><p>在需求中冻结派发范围，在任务中持续观察执行。</p></div><button type="button" class="btn primary" id="dispatch-all" data-action="preflight" data-type="project" data-key="dispatch:all">派发全部合格需求</button></div>
      <div class="requirement-layout"><div class="panel"><div class="tree-header"><span>当前项目：DEMO-PROJECT-01</span><span>业务树 · 12 个样例 Story</span></div><div class="tree" role="tree" aria-label="Epic Feature Story 需求树">${state.requirements.filter(r => r.kind === "epic").map(node => row(node, 0)).join("")}</div></div>
      <aside class="panel requirement-aside"><div class="panel-head"><h3>${escape(selected.title)}</h3><span class="tag">${selected.kind}</span></div><div class="panel-body stack">${selectedDetails}<div class="note">先预检，再一次确认。不会自动加入范围外的必要前置，也不会把尚未确认、未同步、已完成或已取消故事投入执行。</div><div class="note warning">默认终点：待验收。任务成功与用户验收是两条状态链；没有生产发布。</div></div></aside></div>`;
  }

  function visibleTasks() {
    const query = ui.query.trim().toLowerCase();
    return state.tasks.filter(t => (ui.batch === "all" || t.batchId === ui.batch) && (ui.status === "all" || t.status === ui.status) && (!query || `${t.id} ${t.storyId} ${t.title} ${t.executor.cli}`.toLowerCase().includes(query)));
  }

  function renderTaskDetail(task) {
    if (!task) return `<aside class="panel detail">${empty("选择任务查看证据", "前置产物、等待原因、执行器与验证结果在此显示。")}</aside>`;
    const paused = task.status === "paused", done = terminal(task.status);
    const dependencies = task.dependencies.length ? task.dependencies.map(dep => {
      const consumed = task.consumedArtifacts.find(a => a.artifactId === dep.requiredArtifact), artifact = state.artifacts[dep.requiredArtifact];
      return `<div class="preflight-item">${escape(dep.storyId)} → ${escape(dep.requiredArtifact)}<small>门槛：${escape(dep.verificationGate)}<br>${consumed ? `已消费 ${escape(consumed.revision)} · tick ${consumed.consumedAt}` : artifact ? `产物 ${escape(artifact.revision)} · 尚未消费${artifact.stale ? " · 已失效" : ""}` : "尚无已验证且集成通过的产物修订"}</small></div>`;
    }).join("") : '<p class="muted">无执行前置，可在资源与并发允许时独立启动。</p>';
    const verification = task.verification ? `<ul class="simple-list">${task.verification.checks.map(check => `<li>${escape(check.id)} · ${escape(resultLabels[check.result])}</li>`).join("")}</ul><p class="muted">来源：仿真规则判定，未运行真实测试。</p>` : '<p class="muted">未执行验证；模拟 exit 0 仍需经过验证与适用集成。</p>';
    return `<aside class="panel detail" id="task-detail" data-task-detail="${task.id}" tabindex="-1"><div class="panel-head"><h3>任务详情</h3>${statusBadge(task.status)}</div><div class="panel-body">
      <div class="detail-heading"><div><strong>${escape(task.title)}</strong><small class="muted">${task.id} · ${task.storyId}</small></div></div>
      <div class="actions">${button(paused ? "继续任务" : "暂停任务", paused ? "resume-task" : "pause-task", task.id, done ? "disabled" : "")}${button("取消任务", "cancel-task", task.id, done ? "disabled" : "", "danger")}${button("定位需求", "locate-requirement", task.storyId)}${button("定位编码证据", "locate-code", task.id, task.artifactRevision ? "" : "disabled")}</div>
      <div class="note ${task.status === "failed" || task.status === "blocked" ? "error" : task.status.includes("waiting") || task.status === "retry_wait" ? "warning" : ""}"><strong>当前原因 / why waiting</strong><br>${escape(task.reason)}${paused ? `<br>暂停前：${escape(stateLabels[task.resumeStatus])}；旧计时器失效。` : ""}</div>
      <ol class="steps" aria-label="执行步骤">${task.steps.map(item => `<li class="${item.status}" title="${escape(resultLabels[item.status])}">${stepLabels[item.key]}<br>${escape(resultLabels[item.status])}</li>`).join("")}</ol>
      ${facts([["执行器", escape(`${task.executor.cli} / ${task.executor.model}（样例）`)], ["批次", escape(task.batchId)], ["工作区", task.workspace ? `<code>${escape(task.workspace.path)}</code><br><small>${escape(task.workspace.branch)}<br>基线 ${escape(task.workspace.baseSha)} · 样例 SHA</small>` : "未准备样例工作区"], ["资源锁", escape(task.resources.join("、") || "无")], ["范围修订", `<code>${escape(task.baseline.requirement)}<br>${escape(task.baseline.design)}<br>${escape(task.baseline.ac)}</code>`], ["Story 终点", escape(storyLabels[requirementFor(task.storyId).status])]])}
      <div class="detail-section"><h3>前置产物与消费修订</h3>${dependencies}</div>
      <div class="detail-section"><h3>尝试记录 · ${task.attempts.length} 次</h3><div class="attempt-list">${task.attempts.length ? task.attempts.map(attempt => `<div class="attempt-item"><strong>Attempt ${attempt.number} · ${escape(attempt.reason)} · ${escape(stateLabels[attempt.status] || attempt.status)}</strong><br>模拟 exit：${attempt.exitCode === null ? "未结束" : attempt.exitCode} · tick ${attempt.startedAt}${attempt.endedAt === null ? " → 进行中" : ` → ${attempt.endedAt}`}<br>${escape(attempt.outcome || "当前仿真步骤执行中")}${attempt.verification ? `<br>该尝试验证：${escape(resultLabels[attempt.verification.status])}` : ""}</div>`).join("") : '<p class="muted">尚未领取执行槽；没有尝试记录。</p>'}</div><small class="muted">自动重试 ${task.retries}/${batchFor(task.batchId).policy.maxRetries} · 返工 ${task.reworks}/${batchFor(task.batchId).policy.maxRework}，失败记录不会覆盖。</small></div>
      <div class="detail-section"><h3>验证与集成（样例）</h3>${verification}<small class="muted">适用集成：${task.integration ? escape(resultLabels[task.integration.status]) : task.integrationRequired ? "未执行" : "不适用"} · 产物：${escape(task.artifactRevision || "尚未记录 revision")}</small></div>
      <div class="detail-section"><h3>用量与来源</h3><p class="muted">${escape(task.usage.source)}。输入 / 输出 token：未知；实际费用：未知。仿真消耗 ${task.usage.demoUnits} 单位，不能视为实际账单。</p></div>
      <div class="detail-section"><h3>日志（评审样例）</h3><div class="log-list">${task.logs.map(log => `<div class="log-entry ${log.type}"><span class="log-time">[样例 tick ${log.tick}]</span> ${escape(log.message)}</div>`).join("")}</div></div>
    </div></aside>`;
  }

  function renderTasks() {
    const tasks = visibleTasks();
    if (!tasks.some(t => t.id === ui.taskId)) ui.taskId = tasks[0]?.id || null;
    const scoped = state.tasks.filter(t => ui.batch === "all" || t.batchId === ui.batch), target = ui.batch;
    const metrics = [[scoped.length, "任务总数"], [scoped.filter(t => ["preparing", "running", "verifying", "integrating"].includes(t.status)).length, "运行 / 验证 / 集成"], [scoped.filter(t => ["waiting_dependency", "waiting_resource", "retry_wait"].includes(t.status)).length, "等待"], [scoped.filter(t => t.status === "succeeded").length, "技术交付成功"], [scoped.filter(t => ["failed", "blocked", "cancelled"].includes(t.status)).length, "失败 / 阻塞 / 取消"]];
    const scopedBatches = state.batches.filter(b => ui.batch === "all" || b.id === ui.batch).slice().reverse();
    const batches = scopedBatches.map(b => `<div class="batch-item"><div><strong>${b.id}</strong> · ${escape(batchLabels[b.status])}${b.paused ? " · 已暂停" : ""}<small class="muted"> · 冻结 ${b.taskIds.length} 个 Story · 仿真 ${b.used}/${b.policy.budget} 单位</small></div>${button("结果报告", "report", b.id)}</div>`).join("");
    const list = tasks.length ? `<div class="task-table-head"><span>任务 / 需求</span><span>运行状态</span><span class="task-executor">样例执行器</span></div><div class="task-list" aria-label="任务列表">${tasks.map(t => `<button type="button" class="task-row${ui.taskId === t.id ? " selected" : ""}" data-action="task" data-id="${t.id}" data-key="task:${t.id}" aria-pressed="${ui.taskId === t.id}"><span><span class="task-title">${escape(t.title)}</span><span class="task-id">${t.id} · ${t.storyId}</span></span>${statusBadge(t.status)}<span class="task-executor">${escape(t.executor.cli)}<br>${escape(t.executor.model)}</span></button>`).join("")}</div>` : empty(state.tasks.length ? "没有匹配的任务" : "尚未创建评审批次", state.tasks.length ? "试试其他批次、状态或关键词。" : "前往需求页预检范围并一次确认，任务会自动推进。", button(state.tasks.length ? "清空筛选" : "返回需求页", state.tasks.length ? "clear-filters" : "tab-requirements"));
    const dependencyList = scoped.length ? `<div class="panel"><div class="panel-head"><h3>执行依赖 · 可读 DAG 列表</h3><span class="tag">与业务父树分离</span></div><div class="dependency-list">${scoped.map(t => `<div class="dependency-item"><strong>${escape(t.storyId)} · ${escape(t.title)}</strong><span class="muted">${t.dependencies.length ? `${escape(t.dependencies.map(d => d.storyId).join(" + "))} → ${t.storyId}；需验证 / 集成产物` : "独立入口，无执行前置"}</span><span>${t.consumedArtifacts.length ? `已消费 ${escape(t.consumedArtifacts.map(a => a.revision).join("、"))}` : "尚未消费前置修订"}${t.resources.includes("demo.shared-schema") ? " · 共享 demo.shared-schema，自动互斥" : ""}</span></div>`).join("")}</div></div>` : "";
    return `<div class="page-heading"><div><h2>项目任务</h2><p>跨页签持续执行；此处观察与控制，结果始终归属原冻结批次。</p></div><div class="actions">${button("暂停", "pause-batch", target, scoped.some(t => !terminal(t.status) && t.status !== "paused") ? "" : "disabled")}${button("继续", "resume-batch", target, scoped.some(t => t.status === "paused") ? "" : "disabled")}${button("取消", "cancel-batch", target, scoped.some(t => !terminal(t.status)) ? "" : "disabled", "danger")}</div></div>
      <div class="metrics">${metrics.map(([value, label]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join("")}</div>
      <div class="filter-bar"><label for="filter-batch">批次</label><select id="filter-batch"><option value="all">全部批次</option>${state.batches.map(b => `<option value="${b.id}" ${ui.batch === b.id ? "selected" : ""}>${b.id} · ${batchLabels[b.status]}</option>`).join("")}</select><label for="filter-status">状态</label><select id="filter-status"><option value="all">全部状态</option>${S.TASK_STATES.map(status => `<option value="${status}" ${ui.status === status ? "selected" : ""}>${stateLabels[status]}</option>`).join("")}</select><label class="sr-only" for="filter-query">搜索任务、Story 或执行器</label><input type="search" id="filter-query" value="${escape(ui.query)}" placeholder="搜索任务、Story 或执行器">${button("清空筛选", "clear-filters")}</div>
      <div class="batch-list">${batches}</div><div class="task-layout"><div class="stack"><div class="panel"><div class="panel-head"><h3>任务列表</h3><span class="muted">${tasks.length} 条</span></div>${list}</div>${dependencyList}</div>${renderTaskDetail(taskFor(ui.taskId))}</div>`;
  }

  function renderDesign() {
    return `<div class="page-heading"><div><h2>需求派发与执行设计</h2><p>CR-016 评审方案；任务引擎、真实 CLI 隔离与后台恢复尚未实现。</p></div></div><div class="design-grid"><div class="panel"><div class="panel-head"><h3>一次授权与自动交付</h3></div><div class="panel-body design-flow"><div class="flow-step"><strong>01 · 需求范围预检</strong><p>选择 Story / Feature / Epic / 当前项目全部合格需求，排除草稿与不合格前置。</p></div><div class="flow-step"><strong>02 · 冻结授权与基线</strong><p>需求 / 设计 / AC 修订、CLI / 模型、写入范围、并发、预算与重试上限固定。</p></div><div class="flow-step"><strong>03 · 受管调度</strong><p>等待验证产物，消费 revision 后领取并发槽、资源锁与样例工作区。</p></div><div class="flow-step"><strong>04 · 验证与串行集成</strong><p>模拟 exit 0 仅结束运行；产物、AC、差异与适用集成通过才记录交付修订。</p></div><div class="flow-step"><strong>05 · 批次报告与待验收</strong><p>成功、部分成功、失败、取消分别终结；保留尝试、日志和失败路径。</p></div></div></div><div class="panel"><div class="panel-head"><h3>当前 DEMO 执行 DAG</h3><span class="tag">不是需求父树</span></div><div class="panel-body stack"><pre>契约 01 ──→ 后端 02 ─┐\n        └─→ 前端 03 ─┴─→ 端到端 04 ──→ 手册 08\n\n审计 05 ── 独立运行\n索引 06 ─┐\n约束 07 ─┴─ 共享资源锁：自动串行</pre><div class="note warning">工作区与 SHA 都是样例；独立 worktree 不是 OS 安全边界，真实隔离与集成未验证。</div><ul class="simple-list"><li>失败 / 取消前置不放行后代；独立分支继续。</li><li>暂时故障最多一次自动重试，验证返工最多一次；尝试历史保留。</li><li>模型 / 权限 / 需求修订失效停止相关分支，不自动切换引擎。</li><li>localStorage 仅为本机评审快照，关页不继续执行。</li></ul></div></div></div>`;
  }

  function renderCode() {
    const artifacts = Object.values(state.artifactHistory).reverse();
    if (!artifacts.some(a => a.revision === ui.artifactRevision)) ui.artifactRevision = artifacts[0]?.revision || null;
    const selected = state.artifactHistory[ui.artifactRevision];
    const historical = artifact => state.artifacts[artifact.id]?.revision !== artifact.revision || state.artifacts[artifact.id]?.stale;
    return `<div class="page-heading"><div><h2>编码证据 · 仿真</h2><p>仅展示已验证的样例产物；没有写文件、提交、合并或发布。</p></div></div><div class="code-layout"><div class="panel"><div class="panel-head"><h3>样例产物修订</h3><span class="tag">${artifacts.length}</span></div>${artifacts.length ? artifacts.map(a => `<button type="button" class="artifact-button${a.revision === ui.artifactRevision ? " selected" : ""}" data-action="artifact" data-id="${a.revision}" data-key="artifact:${a.revision}">${escape(a.storyId)}<small>${escape(a.revision)}${historical(a) ? " · 历史修订" : ""}</small></button>`).join("") : empty("暂无交付证据", "模拟进程退出后还需验证与适用集成。")}</div><div class="panel"><div class="panel-head"><h3>${selected ? escape(selected.id) : "代码证据预览"}</h3><span class="tag">${selected && historical(selected) ? "历史样例" : "样例"}</span></div><div class="panel-body stack">${selected ? facts([["来源任务", escape(selected.producerTaskId)], ["产物修订", escape(selected.revision)], ["需求修订", escape(selected.baseline.requirement)], ["集成基线", `${escape(selected.integratedHead)}（样例 SHA）`], ["验证门槛", `${escape(resultLabels[selected.verification])} / 集成 ${escape(resultLabels[selected.integration])}`]]) + `<pre id="code-evidence">${escape(selected.content)}</pre><div class="actions">${button("定位来源任务", "locate-task", selected.producerTaskId)}${button("定位需求", "locate-requirement", selected.storyId)}</div>` : '<div class="note">真实编码区属于正式应用，此独立评审页只模拟任务交付证据定位。</div>'}</div></div></div>`;
  }

  function captureFocus() {
    const element = document.activeElement;
    if (!$("#view").contains(element)) return null;
    return { id: element.id, key: element.dataset?.key, start: element.selectionStart, end: element.selectionEnd };
  }
  function restoreFocus(saved) {
    if (!saved) return;
    const target = saved.id ? document.getElementById(saved.id) : saved.key ? document.querySelector(`[data-key="${CSS.escape(saved.key)}"]`) : null;
    if (target) { target.focus({ preventScroll: true }); if (typeof target.setSelectionRange === "function" && saved.start !== null) { try { target.setSelectionRange(saved.start, saved.end); } catch (error) { /* search/select 的支持差异不影响状态。 */ } } }
  }
  function render() {
    updateTop();
    for (const tab of document.querySelectorAll("[role=tab]")) { const selected = tab.dataset.tab === ui.tab; tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1; }
    $("#view").setAttribute("aria-labelledby", `tab-${ui.tab}`);
    if ($("#review-dialog").open) return;
    const focus = captureFocus();
    $("#view").innerHTML = ui.tab === "requirements" ? renderRequirements() : ui.tab === "tasks" ? renderTasks() : ui.tab === "design" ? renderDesign() : renderCode();
    restoreFocus(focus);
  }

  function openDialog(title, body, footer, mode) {
    const element = document.activeElement; returnFocus = { id: element.id, key: element.dataset?.key };
    dialogMode = mode; $("#dialog-content").innerHTML = `<div class="dialog-header"><h2 id="dialog-title">${title}</h2>${button("关闭", "close-dialog", "", 'aria-label="关闭弹框"')}</div><div class="dialog-body">${body}</div><div class="dialog-footer">${footer}</div>`;
    $("#review-dialog").showModal(); $("#review-dialog [data-action=close-dialog]").focus();
  }
  function closeDialog() { $("#review-dialog").close(); }
  $("#review-dialog").addEventListener("close", () => { if ($("#review-dialog").open) return; dialogMode = null; preview = null; render(); restoreFocus(returnFocus); returnFocus = null; });
  $("#review-dialog").addEventListener("cancel", event => { event.preventDefault(); closeDialog(); });

  function showPreflight(scope,executionRequests={}) {
    preview = S.preflight(state, scope,{},executionRequests);
    const executionHtml=window.TaskExecutionDesign?window.TaskExecutionDesign.renderPreflight(preview):'';
    const scopeLabel = scope.type === "project" ? "当前项目 DEMO-PROJECT-01 的全部合格 Story" : `${scope.id} 及其业务下级 Story`;
    const dependencies = preview.frozen.flatMap(r => r.dependencies.map(dep => `${r.id} ← ${dep.storyId}：${dep.requiredArtifact} / ${dep.verificationGate}${dep.externalTaskId ? ` / 引用已授权前置Run ${dep.externalTaskId}（跨批次等待产物）` : dep.externalRevision ? ` / 已有 ${dep.externalRevision}` : " / 本批次产物门槛"}`));
    const body = `<div class="note"><strong>本次范围：${escape(scopeLabel)}</strong><br>冻结 ${preview.frozen.length} 个 Story，排除 ${preview.excluded.length} 个；新增或改动的未选项不会被自动加入。</div>${preview.errors.length ? `<div class="note error" role="alert">${preview.errors.map(escape).join("<br>")}</div>` : ""}
      <div class="detail-section"><h3>冻结需求 / 设计 / AC 范围</h3><div class="preflight-list">${preview.frozen.map(r => `<div class="preflight-item">${escape(r.id)} · ${escape(r.title)}<small>${escape(r.baseline.requirement)} / ${escape(r.baseline.design)} / ${escape(r.baseline.ac)}</small></div>`).join("") || '<p class="muted">没有合格需求，不会启动任务。</p>'}</div></div>
      <div class="detail-section"><h3>排除项与原因</h3><div class="preflight-list">${preview.excluded.map(r => `<div class="preflight-item excluded">${escape(r.id)} · ${escape(r.title)}<small>${escape(r.reason)}</small></div>`).join("") || '<p class="muted">本范围没有排除项。</p>'}</div></div>
      <div class="detail-section"><h3>必要前置与消费门槛</h3>${dependencies.length ? `<ul class="simple-list">${dependencies.map(item => `<li>${escape(item)}</li>`).join("")}</ul>` : '<p class="muted">本次合格任务无执行前置。</p>'}</div>
      ${facts([["执行允许集", preview.policy.allowed.map(p => `${escape(p.cli)} / ${escape(p.model)}（样例）`).join("<br>")], ["必要能力", escape([...new Set(preview.frozen.flatMap(r => r.capabilities))].join("、") || "无可执行任务")], ["并发 / 锁", `${preview.policy.maxConcurrent} 个全局并发槽；任务声明资源互斥；集成串行`], ["重试 / 返工", `${preview.policy.maxRetries} 次自动重试 / ${preview.policy.maxRework} 次返工，不无限循环`], ["预算", `${preview.policy.budget} 个仿真单位；真实费用与 usage 未知`], ["写入范围", `<code>${escape(preview.policy.writeScope.join("、"))}</code>（仅样例）`], ["授权版本", escape(preview.policyVersion)], ["终点", escape(preview.endpoint)]])}
      ${executionHtml}<button class="btn" type="button" data-action="execution-demo-load">明确载入闭环DEMO目录并重检（不覆盖现有记录/草稿）</button><div class="note warning">只确认一次并自动推进；不逐任务审批。不运行真实 CLI / Git / 网络，不推送、不合并受保护分支、无生产发布。默认 Story 待验收。</div>`;
    openDialog("派发预检 · 冻结范围与执行边界", body, `${button("返回修改范围", "close-dialog")}${button("确认范围并启动仿真", "confirm-dispatch", "", preview.ok ? "" : "disabled", "primary")}`, "preflight");
  }

  function showReport(id) {
    const batch = batchFor(id); if (!batch) return;
    const tasks = batch.taskIds.map(taskFor), report = batch.report;
    const body = `<div class="note ${batch.status === "partial" ? "warning" : batch.status === "failed" ? "error" : ""}"><strong>${batch.id} · ${escape(batchLabels[batch.status])}</strong><br>${report ? "批次已终结，失败 / 取消历史保留。" : "批次尚在执行，本报告不能当作已完成交付。"}</div><div class="report-grid">${[[tasks.filter(t => t.status === "succeeded").length, "技术成功"], [tasks.filter(t => t.status === "failed" || t.status === "blocked").length, "失败 / 阻塞"], [tasks.filter(t => t.status === "cancelled").length, "取消"]].map(([value, label]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join("")}</div>
      <div class="detail-section"><h3>逐任务交付与 Story 状态</h3><div class="preflight-list">${tasks.map(t => `<div class="preflight-item">${escape(t.storyId)} · ${escape(t.title)} · ${statusBadge(t.status)}<small>Story：${escape(storyLabels[t.storyOutcome || requirementFor(t.storyId).status])}（当次交付） · ${escape(t.artifactRevision || "没有已交付产物")}<br>${escape(t.reason)}</small></div>`).join("")}</div></div>
      ${facts([["冻结范围", `${batch.taskIds.length} 个 DEMO Story，排除 ${batch.excluded.length} 个`], ["尝试记录", `${tasks.reduce((sum, t) => sum + t.attempts.length, 0)} 次仿真尝试；失败记录保留`], ["默认终点", batch.policy.autoAcceptance ? "显式 DEMO 客观自动验收演示" : "待验收；未冒称用户已验收"], ["预算与用量", `${batch.used}/${batch.policy.budget} 仿真单位；实际账单 / token / usage 未知`], ["交付边界", "所有日志、测试、工作区、SHA、产物均为样例；真实引擎未实现"]])}${window.TaskExecutionDesign?.renderDelivery(batch)||''}<div class="note warning">任务 succeeded 只表示仿真技术交付通过。默认 Story 待验收；本评审稿不提供生产发布操作。</div>`;
    openDialog(`批次交付报告 · ${escape(batchLabels[batch.status])}`, body, button("关闭报告", "close-dialog"), "report");
  }

  function reset(scenario = "normal") { stopClock(); state = S.createState({ scenario }); window.WindowNav?.reset(); setUI(defaultUI()); if ($("#review-dialog").open) closeDialog(); preview = null; save(); render(); toast("已载入独立评审样例；管理首页固定，项目与资料在独立窗口打开"); }
  function clearFilters() { ui.batch = "all"; ui.status = "all"; ui.query = ""; render(); }
  function debugStep() {
    if (state.tasks.some(t => !terminal(t.status) && t.status !== "paused")) { toast("先暂停整个评审批次，再使用确定性单步"); return; }
    if (!state.tasks.length || !state.tasks.some(t => !terminal(t.status))) { toast("当前没有可单步推进的评审任务"); return; }
    const resumed = S.resume(state), stepped = S.tick(resumed, resumed.epoch); apply(S.pause(stepped));
  }

  document.addEventListener("click", event => {
    const element = event.target.closest("[data-action]"); if (!element || element.disabled) return;
    const { action, id, tab, type } = element.dataset;
    if (action === "tab") selectTab(tab);
    else if (action === "tab-requirements") selectTab("requirements");
    else if (action === "theme") { const dark = document.documentElement.dataset.theme !== "dark"; document.documentElement.dataset.theme = dark ? "dark" : "light"; $("#theme-button").textContent = dark ? "浅色" : "深色"; }
    else if (action === "node") { ui.selectedRequirement = id; render(); }
    else if (action === "collapse") { if (ui.collapsed.has(id)) ui.collapsed.delete(id); else ui.collapsed.add(id); render(); }
    else if (action === "preflight") showPreflight({ type, id: type === "project" ? state.projectId : id, projectId: state.projectId });
    else if (action === "close-dialog") closeDialog();
    else if(action==='execution-demo-load'){const scope=preview?.scope||{type:'project'};const result=window.TaskExecutionCatalog?.loadDemo();if(!result?.ok){toast(result?.reason||'演示目录不可用');return;}showPreflight(scope);}
    else if (action === "confirm-dispatch" && dialogMode === "preflight" && preview) {
      if(window.TaskExecutionDesign){const captured=window.TaskExecutionDesign.captureConfirmedPlans(preview.frozen.map(x=>x.id));if(!captured.ok){toast(captured.errors.join('；'));showPreflight(preview.scope);return;}}
      const result = S.dispatch(state, preview);
      if (!result.ok) { toast(result.error); $("#dialog-content .dialog-body").insertAdjacentHTML("afterbegin", `<div class="note error" role="alert">${escape(result.error)}</div>`); element.disabled = true; return; }
      state = result.state; ui.tab = "tasks"; ui.batch = result.batchId; ui.status = "all"; ui.query = ""; ui.taskId = state.batches.find(batch => batch.id === result.batchId)?.taskIds[0] || null; closeDialog(); save(); render(); startClock(); toast(result.replayed ? "同一请求已处理，已定位原批次；没有重复创建任务" : "一次确认已启动仿真，调度器会自动推进");
    }
    else if (action === "task") { ui.taskId = id; render(); if (window.matchMedia("(max-width: 680px)").matches) $("#task-detail")?.scrollIntoView({ block: "start", behavior: "auto" }); }
    else if (["pause-task", "pause-batch"].includes(action)) apply(S.pause(state, id));
    else if (["resume-task", "resume-batch"].includes(action)) apply(S.resume(state, id));
    else if (["cancel-task", "cancel-batch"].includes(action)) apply(S.cancel(state, id));
    else if (action === "clear-filters") clearFilters();
    else if (action === "report") showReport(id);
    else if (action === "locate-requirement") { ui.selectedRequirement = id; let node = requirementFor(id); while (node) { ui.collapsed.delete(node.id); node = requirementFor(node.parent); } selectTab("requirements"); document.querySelector(`[data-node="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center" }); }
    else if (action === "locate-code") { ui.artifactRevision = taskFor(id)?.artifactRevision || null; ui.codeKind = "evidence"; selectTab("code"); }
    else if (action === "locate-task") { ui.taskId = id; ui.batch = "all"; ui.status = "all"; ui.query = ""; selectTab("tasks"); }
    else if (action === "artifact") { ui.artifactRevision = id; render(); }
    else if (action === "load-scenario") reset($("#scenario-select").value);
    else if (action === "reset") reset();
    else if (action === "inject") { const injection = { type: $("#injection-select").value, storyId: $("#injection-story").value, cli: "codex", model: "DEMO-CODER" }; apply(S.inject(state, injection)); toast("评审事件已注入；没有实际命令或网络操作"); }
    else if (action === "debug-step") debugStep();
    else if (action === "save") save(true);
  });

  document.addEventListener("input", event => { if (event.target.id === "filter-query") { ui.query = event.target.value; render(); } });
  document.addEventListener("change", event => {
    if (event.target.id === "filter-batch") { ui.batch = event.target.value; ui.taskId = null; render(); }
    else if (event.target.id === "filter-status") { ui.status = event.target.value; ui.taskId = null; render(); }
  });
  document.addEventListener("keydown", event => {
    // 原生 dialog 会隔离页面，但浏览器工具栏仍可被 Tab 聚焦；模态内显式循环焦点。
    if ($("#review-dialog").open && event.key === "Tab") {
      const focusable = Array.from($("#review-dialog").querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')).filter(element => element.getClientRects().length && !element.hidden);
      const first = focusable[0], last = focusable.at(-1), active = document.activeElement;
      if (!focusable.length) event.preventDefault();
      else if (!focusable.includes(active) || (!event.shiftKey && active === last)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
    }
    const focused = event.target.closest("#project-tabs [role=tab]");
    if (focused && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault(); const tabs = Array.from(document.querySelectorAll("#project-tabs [role=tab]")), index = tabs.indexOf(focused);
      const target = tabs[event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
      selectTab(target.dataset.tab); target.focus();
    }
    if (event.target.matches(".node-open") && ["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); const nodes = Array.from(document.querySelectorAll(".node-open")), index = nodes.indexOf(event.target); nodes[Math.max(0, Math.min(nodes.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus(); }
  });
  window.addEventListener("pagehide", stopClock);
  $("#injection-story").innerHTML = state.requirements.filter(r => r.kind === "story").map(r => `<option value="${r.id}">${escape(r.id)} · ${escape(r.title)}</option>`).join("");
  // CR-017：同一壳、同一需求/运行源；这里只保存非执行模块的本机样例及查看偏好。
  const auxKey = "cr017-workspace-samples-v1";
  const aux = {
    projects: [{id:"DEMO-PROJECT-01",name:"预约服务",kind:"code",owner:"林澈",description:"需求、设计、执行、评审与验收统一闭环"},{id:"DEMO-WORK-01",name:"市场研究资料",kind:"work",owner:"陈雨",description:"源资料解读与办公产物样例"}],
    files: [{name:"README.md",text:"# 预约服务\n\n当前设计工作台的本机样例，不读取正式源文件。",baseline:"# 预约服务\n",staged:false},{name:"src/booking.ts",text:"export const booking = { status: 'ready' };",baseline:"export const booking = {};",staged:false}],
    branches:["main","feature/booking"], branch:"main", commits:[], designs:{},
    libraries:[{id:"demo-handbook",name:"研发手册",description:"研发交付流程与预约接口约定",noteIds:["guide","contract"]},{id:"demo-empty",name:"待整理资料",description:"空知识库导航样例",noteIds:[]}],
    notes:[{id:"guide",title:"研发交付指南",path:"流程/交付.md",text:"# 研发交付指南\n\n## 需求确认\n先确认范围和验收标准。\n\n## 技术交付\n运行结束不等于需求完成。\n\n## 评审与验收\n有效证据与当前需求修订一致后，才可验收。"},{id:"contract",title:"预约接口约定",path:"接口/预约.md",text:"# 预约接口约定\n\n## 响应字段\n保留status与预约编号。\n\n## 失败处理\n失败证据不能当通过，不放行依赖。"}],
    servers:[{id:"demo-staging",name:"预约服务 · 测试",host:"ops@192.0.2.24",online:true,connected:false,authorized:false,output:"尚未连接本机主机样例。"},{id:"demo-offline",name:"归档 · 开发",host:"ops@198.51.100.28",online:false,connected:false,authorized:false,output:"主机样例离线。"}],
    office:[{name:"研究计划.md",text:"# 市场研究计划\n\n统一价格口径并记录来源。"},{name:"会议纪要.docx",text:"会议纪要（结构预览样例）\n决策：按年度报价比较。"}],
    skills:[{name:"拆解需求",on:true},{name:"代码审查",on:true}],mcp:[{name:"workspace-files",on:true},{name:"knowledge-gateway",on:true}],tools:[{name:"文件读取",on:true},{name:"构建验证",on:true}], profile:{name:"林澈",email:"demo@example.invalid"}
  };
  try { const raw=localStorage.getItem(auxKey), saved=JSON.parse(raw || "null"); if (saved && Array.isArray(saved.projects) && Array.isArray(saved.files)) Object.assign(aux,saved); else if(raw===null&&window.WorkbenchSampleFixtures) Object.assign(aux,window.WorkbenchSampleFixtures.createWorkspace()); } catch (_) { /* 有旧快照或存储异常不自动载入新夹具，不影响单一状态机。 */ }
  Object.assign(ui,{page:"projects",projectId:state.projectId,projectQuery:"",designKind:"ui",codeKind:"files",file:aux.files[0]?.name,note:"guide",knowledgeQuery:"",serverId:"demo-staging",commentDraft:"",settingsTab:"general"});
  const cliIcon = (cli,size=24) => window.WorkbenchCliIcons?.render(cli,{size}) || `<span class="cli-icon" role="img" aria-label="${escape(cli || "未知CLI")}" title="${escape(cli || "未知CLI")}">?</span>`;
  const cliLabel = cli => window.WorkbenchCliIcons?.label(cli) || cli || "未知CLI";
  const summaryFor = id => typeof S.requirementSummary === "function" ? S.requirementSummary(state,id) : {status:requirementFor(id)?.status,label:storyLabels[requirementFor(id)?.status] || "状态机接口准备中",counts:{total:descendantStories(id).length,completed:0,cancelled:0,blocked:0,pending:0},latestTaskId:state.tasks.filter(t=>t.storyId===id).at(-1)?.id};
  const currentProject = () => aux.projects.find(p=>p.id===ui.projectId) || aux.projects[0];
  const currentLibrary = () => aux.libraries.find(lib=>lib.id===(ui.libId||"demo-handbook"));
  const latestTask = id => state.tasks.filter(t=>t.storyId===id).at(-1);
  function validTechnical(task) { const r=task&&requirementFor(task.storyId),a=r&&state.artifacts[r.artifactId]; return !!(task && task.status==="succeeded" && a && !a.stale && a.revision===task.artifactRevision && JSON.stringify(a.baseline)===JSON.stringify(task.baseline)); }
  function saveAux(){try{localStorage.setItem(auxKey,JSON.stringify(aux));return true;}catch(_){storage.mode="memory";return false;}}
  const saveBase=save; save=function(manual=false){saveBase(manual);saveAux();};
  // CR-033：窗口切换会让 ui 指向不同窗口的页面状态；所有按引用读取 ui 的模块上下文同步换对象。
  const moduleCtx={aux,ui,saveAux,toast,render:()=>render(),showSettings:tab=>showSettings(tab),
    openLibrary:id=>window.WindowNav?.open('knowledge',id),openProject:id=>window.WindowNav?.open('project',id),
    projects:()=>aux.projects,stories:()=>state.requirements.filter(r=>r.kind==='story'),
    linkedRequirement:()=>requirementFor(ui.selectedRequirement)?.kind==='story'?requirementFor(ui.selectedRequirement):state.requirements.find(r=>r.kind==='story'),
    markPending:()=>{const r=requirementFor(ui.selectedRequirement)?.kind==='story'?requirementFor(ui.selectedRequirement):state.requirements.find(r=>r.kind==='story');return r?invokeUI('saveRequirement',r.id,{designReady:true,synchronized:false,reason:'CR-027本机设计资料保存，关联设计待同步'}):{ok:false,error:'没有关联Story'};},
    confirmSync:()=>{const r=requirementFor(ui.selectedRequirement)?.kind==='story'?requirementFor(ui.selectedRequirement):state.requirements.find(r=>r.kind==='story');return r?invokeUI('saveRequirement',r.id,{designReady:true,synchronized:true,reason:'明确确认设计依据同步，仅DEMO'}):{ok:false,error:'没有关联Story'};}};
  function setUI(next){ui=next;moduleCtx.ui=next;}
  const oldUpdateTop=updateTop; updateTop=function(){
    oldUpdateTop();
    const win=window.WindowNav?.active();
    $("#project-tabs").hidden=!(win&&win.kind==='project')||currentProject()?.kind!=="code";
    $("#current-title").textContent=win?(win.kind==='project'?currentProject().name:win.title):({projects:"项目管理",knowledge:"知识库",servers:"服务器管理",baselines:"设计基线与覆盖"})[ui.page]||"项目工作台";
    $("#side-project-name").textContent=currentProject().name;
    const activePage=win?null:ui.page;
    for(const n of document.querySelectorAll(".sidebar [data-page],.mobile-nav [data-page]")){const selected=!!activePage&&n.dataset.page===activePage;n.classList.toggle("current",selected);if(selected)n.setAttribute("aria-current","page");else n.removeAttribute("aria-current");}
  };
  selectTab=function(tab){ui.tab=tab;render();};
  const oldStartClock=startClock; startClock=function(){
    if(state.wakeups?.some(w=>w.enabled&&(w.fireCount||0)<(w.maxFires||w.rule?.maxFires||1))&&!state.paused&&!state.tasks.some(t=>!terminal(t.status)&&t.status!=="paused")){
      stopClock();const g=timerGeneration,e=state.epoch;scheduledCallback=()=>{if(g!==timerGeneration||e!==state.epoch)return;timer=null;callbackCount++;state=S.tick(state,e);save();render();startClock();};timer=setTimeout(scheduledCallback,intervalMs);return;
    }oldStartClock();
  };
  function invokeUI(name,...args){
    if(typeof S[name]!=="function")return {ok:false,state,error:"状态机接口尚未就绪，请稍后重新打开；未产生操作。"};
    try{const result=S[name](state,...args);if(!result?.ok)return result||{ok:false,state,error:"操作未生效"};state=result.state;save();render();startClock();return result;}catch(error){return {ok:false,state,error:String(error.message||error)};}
  }
  function showError(message){const box=$("#ui-error")||$("#dialog-content .dialog-body");if(box)box.innerHTML=escape(message);else toast(message);}
  function uiForm(title,kind,id,body,submit="保存",extra={}){
    ui.form={kind,id,extra,workflowVersion:requirementFor(id)?.workflowVersion,round:taskFor(id)?.round};
    openDialog(escape(title),`<form id="ui-form" data-ui-form="${kind}" class="form-grid">${body}<p id="ui-error" role="alert" class="error"></p></form>`,`${button("取消","close-dialog")}<button class="btn primary" type="submit" form="ui-form">${escape(submit)}</button>`,"ui-form");
  }
  const inputField=(label,name,value="",type="text",required=true)=>`<label>${escape(label)}<input name="${name}" type="${type}" value="${escape(value)}" ${required?"required":""} maxlength="180"></label>`;
  const areaField=(label,name,value="",required=true)=>`<label>${escape(label)}<textarea name="${name}" ${required?"required":""} rows="3" maxlength="4000">${escape(value)}</textarea></label>`;
  const options=(items,selected)=>items.map(([value,label])=>`<option value="${escape(value)}" ${value===selected?"selected":""}>${escape(label)}</option>`).join("");
  function requirementEditor(id=null,kind="story",parent=null){
    const r=requirementFor(id),parents=state.requirements.filter(n=>n.kind===(kind==="story"?"feature":"epic"));
    uiForm(id?`编辑需求 · ${id}`:`新增${{story:"用户故事",feature:"特性",epic:"史诗"}[kind]}`,"requirement",id,
      `<p class="note warning">保存变更会产生新需求修订；当前旧运行与证据可能失效。不会直接修改状态为已完成。</p>${inputField("标题","title",r?.title)}${areaField("背景与描述","description",r?.description||"")}${areaField("用户目标","goal",r?.goal||"")}${kind!=="epic"?`<label>唯一父项<select name="parent" ${id?'disabled':''}>${options(parents.map(p=>[p.id,p.id+" · "+p.title]),r?.parent||parent||parents[0]?.id)}</select>${id?'<small>既有需求父项只读，本轮不迁移归属；不会忽略可编辑字段。</small>':''}</label>`:""}${kind==="story"?areaField("验收标准（每行一条）","ac",r?.ac?.map(a=>typeof a==="string"?a:a.text||a.id).join("\n")||"产物满足本次目标，验证有有效证据"):""}${areaField("变更原因","reason",id?"":"新增需求")}`,id?"保存新修订":"创建需求",{kind});
  }
  function nextActions(r){const sum=summaryFor(r.id),t=latestTask(r.id);return `<div class="actions">${button("编辑","ui-edit",r.id)}${button("删除","ui-delete",r.id)}${r.kind!=="story"?button("新增子项","ui-create",r.id):`${!r.confirmed?button("确认需求","ui-confirm",r.id):""}${(!r.designReady||!r.synchronized)?button("去设计并同步","ui-design",r.id):""}${button("仅分配CLI","ui-assign",r.id)}${t?button("查看运行与记录","ui-open-task",t.id):""}${t&&["failed","cancelled","blocked"].includes(t.status)?button("修复配置","ui-settings-task",t.id)+button("重试原运行","ui-retry",t.id):""}${validTechnical(t)?button("评审通过","ui-review-approve",t.id)+button("评审退回","ui-review-reject",t.id)+button("验收通过","ui-accept-approve",r.id)+button("验收退回","ui-accept-reject",r.id):""}${button("取消需求","ui-cancel-requirement",r.id)}${button("创建条件唤醒","ui-wakeup-create",r.id)}`}</div>`;}
  function discussion(id,taskId=null){const r=requirementFor(id),comments=r?.comments||[];return `<section class="detail-section"><h3>需求讨论与运行续接</h3><div class="log-list">${comments.map(c=>`<div class="comment"><strong>${escape(c.actor||"user")}</strong> · ${escape(c.text)}<small>${escape(c.taskId||"仅讨论，未执行")} · tick ${escape(c.tick??c.createdAt??"")}</small></div>`).join("")||"暂无评论"}</div><form data-ui-form="comment" data-story="${escape(id)}" data-task="${escape(taskId||"")}"><label class="sr-only" for="discussion-text">补充消息</label><textarea id="discussion-text" name="text" required rows="2" placeholder="写入同一需求讨论；运行中消息续接到原运行">${escape(ui.commentDraft)}</textarea><button class="btn sm" type="submit">发送补充消息</button></form></section>`;}
  const oldRenderRequirements=renderRequirements;
  renderRequirements=function(){
    const row=(r,depth)=>{const c=state.requirements.filter(x=>x.parent===r.id),sum=summaryFor(r.id);return `<div class="tree-row depth-${depth}${ui.selectedRequirement===r.id?" selected":""}" data-node="${r.id}" role="treeitem" aria-level="${depth+1}"><div class="node-label">${c.length?button(ui.collapsed.has(r.id)?"▸":"▾","collapse",r.id):""}<button class="node-open" data-action="node" data-id="${r.id}" data-key="node:${r.id}"><span>${escape(r.id)}</span><strong>${escape(r.title)}</strong></button></div><span class="tag" data-business-status="${escape(sum.status)}">${escape(sum.label)}</span>${button("派发","preflight",r.id,`data-type="${r.kind}"`)}</div>${r.kind==="story"?`<div class="req-run-chip">${cliIcon(r.executor?.cli,16)}${escape(cliLabel(r.executor?.cli))}${sum.runStatus?` · ${escape(stateLabels[sum.runStatus]||sum.runStatus)}`:" · 尚未派发"}</div>`:""}${!ui.collapsed.has(r.id)?c.map(x=>row(x,depth+1)).join(""):""}`;};
    const r=requirementFor(ui.selectedRequirement)||state.requirements.find(n=>n.kind==="epic");
    if(!r)return `<div class="page-heading"><div><h2>需求与迭代</h2><p>当前项目暂无需求，按史诗→特性→故事继续建立闭环。</p></div>${button("新建史诗","ui-create-epic")}</div>${empty("暂无需求","先创建史诗，再添加特性与可确认的用户故事；不会凭空启动任务。")}`;
    const sum=summaryFor(r.id),counts=sum.counts||{},t=latestTask(r.id);
    return `<div class="page-heading"><div><h2>需求与迭代</h2><p>需求、设计、运行、评审与验收共享同一状态源。</p></div><div class="actions">${button("新建史诗","ui-create-epic")}${button("新建故事","ui-create-story")}<button class="btn primary" id="dispatch-all" data-action="preflight" data-type="project">派发全部合格需求</button></div></div><div class="requirement-layout"><section class="panel"><div class="tree-header"><span>当前项目：${escape(state.projectId)}</span><span>${state.requirements.filter(n=>n.kind==="story").length} 条故事 · 实际聚合</span></div><div class="tree" role="tree">${state.requirements.filter(n=>n.kind==="epic").map(n=>row(n,0)).join("")||empty("暂无需求","先新建史诗与特性，再添加故事。")}</div></section><aside class="panel requirement-aside"><div class="panel-head"><h3>${escape(r.title)}</h3><span class="tag" data-summary-status="${escape(sum.status)}">${escape(sum.label)}</span></div><div class="panel-body stack">${facts([["编号",escape(r.id)],["业务阶段",escape(sum.label)],["运行状态",escape(stateLabels[sum.runStatus]||sum.runStatus||"尚未运行")],["汇总",`总${counts.total||0} / 完成${counts.completed||0} / 取消${counts.cancelled||0} / 阻塞${counts.blocked||0}`],["确认与设计",r.kind==="story"?`${r.confirmed?"需求已确认":"需求待确认"} · ${r.designReady&&r.synchronized?"设计已同步":"设计未就绪"}`:"来自子项真实聚合"]])}${nextActions(r)}${r.kind==="story"?`<div class="detail-section"><h3>验收标准</h3><ul class="simple-list">${(r.ac||[]).map(a=>`<li>${escape(typeof a==="string"?a:a.text||a.id)}</li>`).join("")}</ul></div><div class="note">需求 ${escape(r.requirementHash)}<br>设计 ${escape(r.designHash)}<br>AC ${escape(r.acHash)}</div>${discussion(r.id,t?.id)}${renderWakeups(r.id)}`:""}<div class="note warning">运行结束不是业务完成；验收只使用当前有效技术证据，所有操作为DEMO。</div></div></aside></div>`;
  };
  const oldRenderTaskDetail=renderTaskDetail;
  renderTaskDetail=function(t){let html=oldRenderTaskDetail(t);if(!t)return html;const r=requirementFor(t.storyId),sum=summaryFor(r.id),valid=validTechnical(t);const extra=`<section class="detail-section"><h3>${cliIcon(t.executor.cli,20)}运行历史 / Run</h3><div class="actions">${button("查看transcript与工具事件","ui-transcript",t.id)}${button("修复配置/Runtime","ui-settings-task",t.id)}${["failed","cancelled","blocked"].includes(t.status)?button("原CLI重试","ui-retry",t.id):""}${button("评审通过","ui-review-approve",t.id,valid?"":"disabled")}${button("评审退回","ui-review-reject",t.id,valid?"":"disabled")}${button("验收通过","ui-accept-approve",r.id,valid?"":"disabled")}${button("验收退回","ui-accept-reject",r.id,valid?"":"disabled")}</div><p>业务阶段：<strong>${escape(sum.label)}</strong> · 运行轮次 ${t.round||1} · 当前技术证据${valid?"有效":"尚不可验收"}</p>${(t.terminalHistory||[]).map(h=>`<div class="attempt-item">${cliIcon(t.executor.cli,16)}历史轮次 ${h.round} · ${escape(h.status)} · ${escape(h.reason)}<small>${escape(h.artifactRevision||"无成功产物")}</small></div>`).join("")}${t.attempts.map(a=>`<div class="attempt-item">${cliIcon(a.executor?.cli||t.executor.cli,16)}Run / Attempt ${a.number} · ${escape(a.status)} · 仿真耗时 ${Math.max(0,(a.endedAt??state.clock)-a.startedAt)} tick · usage真实未知${button('查看本次记录','ui-view-attempt',t.id,`data-number="${a.number}"`)}</div>`).join("")}${discussion(r.id,t.id)}${renderWakeups(r.id)}</section>`;return html.replace(/<\/div><\/aside>$/,`${extra}</div></aside>`);};
  const oldRenderTasks=renderTasks;
  renderTasks=function(){let html=oldRenderTasks();html=html.replace(/(<button type="button" class="task-row[^>]*data-id="([^"]+)"[^>]*>)/g,(all,tag,id)=>tag+cliIcon(taskFor(id)?.executor.cli));return html;};
  function renderWakeups(storyId){const rules=(state.wakeups||[]).filter(w=>(w.storyId||w.rule?.storyId)===storyId),history=(state.wakeupHistory||[]).filter(w=>w.storyId===storyId);return `<section class="detail-section"><h3>条件唤醒与触发历史</h3><div class="actions">${button("创建唤醒","ui-wakeup-create",storyId)}${button("模拟CI事件","ui-demo-ci",storyId)}</div>${rules.map(w=>`<div class="attempt-item"><strong>${escape(w.kind||w.rule?.kind||"条件")}</strong> · ${w.enabled?"启用":"停用"} · 触发${w.fireCount||0}/${w.maxFires||w.rule?.maxFires||1}<p>到期 tick ${escape(w.expiresAt)}${w.endedReason?' · '+escape(w.endedReason):''}；旧阶段/到期/耗尽规则需要明确创建新规则，不免费重置。</p><div class="actions">${button("停用","ui-wakeup-disable",w.id,w.enabled?"":"disabled")}${button("重新启用","ui-wakeup-enable",w.id,w.enabled?"disabled":"")}${button("立即触发","ui-wakeup-trigger",w.id,w.enabled?"":"disabled")}${button("删除规则","ui-wakeup-delete",w.id)}</div>${(w.triggerHistory||[]).map(h=>`<small>tick ${h.tick} · ${escape(h.type)} · ${escape(h.result||h.reason)} ${escape(h.taskId||"")}</small>`).join("")}</div>`).join("")||"<p class='muted'>暂无唤醒规则，创建不会偷偷立即派发工作。</p>"}${history.map(w=>`<div class="attempt-item">已删除规则 ${escape(w.id)} · 历史触发${w.fireCount||0}次${(w.triggerHistory||[]).map(h=>`<small>tick ${h.tick} · ${escape(h.type)} · ${escape(h.result||h.reason)}</small>`).join('')}</div>`).join('')}</section>`;}
  function renderProjects(){const items=aux.projects.filter(p=>(p.name+" "+p.owner).toLowerCase().includes(ui.projectQuery.toLowerCase()));return `<div class="page-heading"><div><h2>项目管理</h2><p>同一设计入口管理研发与办公，本机样例。</p></div>${button("新建项目","ui-new-project")}</div><input id="project-search" type="search" placeholder="搜索项目或负责人" value="${escape(ui.projectQuery)}"><div class="project-grid">${items.map(p=>`<article class="panel"><div class="panel-body stack"><span class="tag">${p.kind==="code"?"编码":"办公"}</span><h3>${escape(p.name)}</h3><p>${escape(p.description)}</p><small>${escape(p.owner)}</small>${p.id===state.projectId?`<p>需求 ${state.requirements.filter(r=>r.kind==="story").length} · 完成 ${state.requirements.filter(r=>r.kind==="story"&&summaryFor(r.id).status==="completed").length} · 运行 ${state.tasks.filter(t=>!terminal(t.status)).length}</p>`:""}<div class="actions">${button("打开项目","ui-open-project",p.id)}${button("编辑项目","ui-edit-project",p.id)}</div></div></article>`).join("")||empty("无匹配项目","修改搜索词。")}</div>`;}
  function renderDesign17(){if(window.ProjectDesignResources)return window.ProjectDesignResources.render();const stories=state.requirements.filter(r=>r.kind==="story"),r=requirementFor(ui.selectedRequirement)?.kind==="story"?requirementFor(ui.selectedRequirement):stories[0],d=aux.designs[r.id]||{notes:"页面：输入预约资料 → 确认 → 展示结果。\n状态：加载、成功、失败与取消。",name:"bookings",fields:"id|integer|PK|预约主键\nstatus|text||当前状态"};return `<div class="page-heading"><div><h2>UI与模型设计</h2><p>保存设计草稿会影响准入，同步后可回到同一需求派发。</p></div>${button("返回关联需求","locate-requirement",r.id)}</div><div class="actions"><button class="btn" role="tab" data-action="ui-design-kind" data-kind="ui" aria-selected="${ui.designKind==='ui'}">UI设计</button><button class="btn" role="tab" data-action="ui-design-kind" data-kind="model" aria-selected="${ui.designKind==='model'}">模型设计</button><select id="design-story">${options(stories.map(x=>[x.id,x.id+" · "+x.title]),r.id)}</select></div><div class="design-grid"><section class="panel"><div class="panel-head"><h3>${ui.designKind==="ui"?"设计稿与意见":"数据模型"}</h3></div><div class="panel-body stack">${ui.designKind==="ui"?`<div class="ui-blueprint"><h3>${escape(r.title)}</h3><div class="blueprint-fields"><span>填写预约信息</span><span>确认范围</span><span>查看结果</span></div><p>需求状态：${escape(summaryFor(r.id).label)}</p></div><form data-ui-form="design" data-story="${r.id}">${areaField("页面、交互与异常说明","notes",d.notes)}<input type="hidden" name="name" value="${escape(d.name)}"><input type="hidden" name="fields" value="${escape(d.fields)}"><button class="btn" type="submit">保存设计草稿</button></form>`:`<form data-ui-form="design" data-story="${r.id}">${inputField("表名","name",d.name)}${areaField("字段：名称|类型|约束|说明（逐行）","fields",d.fields)}<input type="hidden" name="notes" value="${escape(d.notes)}"><button class="btn" type="submit">保存模型草稿</button></form><table class="data-table"><thead><tr><th>字段</th><th>类型</th><th>约束</th><th>说明</th></tr></thead><tbody>${d.fields.split('\n').map(line=>`<tr>${line.split('|').map(value=>`<td>${escape(value)}</td>`).join('')}</tr>`).join('')}</tbody></table>`}</div></section><aside class="panel"><div class="panel-body stack"><h3>设计准入与同步</h3>${facts([["关联Story",escape(r.id)],["需求确认",r.confirmed?"已确认":"待确认"],["设计材料",r.designReady?"已准备":"未准备"],["同步",r.synchronized?"已同步":"待同步"],["设计修订",escape(r.designHash)]])}${button("同步设计依据","ui-design-sync",r.id)}${button("返回需求派发","locate-requirement",r.id)}<div class="note warning">这里只更新DEMO设计材料与准入状态，不运行数据库迁移或真实设计生成服务。</div></div></aside></div>`;}
  const codeEvidenceBase=renderCode;
  renderCode=function(){const data=aux.files.find(f=>f.name===ui.file)||aux.files[0];let body;
    if(ui.codeKind==="evidence")body=codeEvidenceBase();
    else if(ui.codeKind==="git")body=`<div class="code-layout"><section class="panel"><div class="panel-head"><h3>未提交变更</h3></div><div class="panel-body stack">${aux.files.filter(f=>f.text!==f.baseline).map(f=>`<div>${escape(f.name)} · ${f.staged?"已暂存":"未暂存"}${button(f.staged?"取消暂存":"暂存","ui-stage",f.name)}${button("查看差异","ui-diff",f.name)}</div>`).join('')||'工作区样例无变更'}<form data-ui-form="git-commit">${inputField("提交说明","message")}<button class="btn" type="submit">提交本机样例</button></form></div></section><section class="panel"><div class="panel-body stack"><h3>分支与提交历史</h3><select id="git-branch">${options(aux.branches.map(b=>[b,b]),aux.branch)}</select>${button("新建分支","ui-new-branch")}${aux.commits.map(c=>`<div class="attempt-item">${escape(c.id)} · ${escape(c.message)} · ${escape(c.branch)}</div>`).join('')||'暂无样例提交'}<div class="note">无真实Git命令/远端；提交与分支只更新当前本机样例。</div></div></section></div>`;
    else body=`<div class="code-layout"><section class="panel"><div class="panel-head"><h3>文件目录</h3></div>${aux.files.map(f=>button(f.name,"ui-file",f.name,"",ui.file===f.name?"selected":"")).join('')}</section><section class="panel"><div class="panel-head"><h3>${escape(data.name)}</h3><span class="tag">${escape(aux.branch)} · 本机样例</span></div><div class="panel-body"><form data-ui-form="file-save" data-file="${escape(data.name)}"><textarea class="sample-editor" name="text" rows="12">${escape(aux.fileDrafts?.[data.name]??data.text)}</textarea><div class="actions"><button class="btn" type="submit">保存样例文件</button>${button("放弃草稿","ui-discard-file",data.name)}</div></form></div></section></div>`;
    return `<div class="actions code-tabs"><button class="btn" role="tab" data-action="ui-code-kind" data-kind="files">文件</button><button class="btn" role="tab" data-action="ui-code-kind" data-kind="git">Git</button><button class="btn" role="tab" data-action="ui-code-kind" data-kind="evidence">交付证据</button></div>${body}`;};
  function markdownView(note){const headings=[];let html='';for(const line of note.text.split('\n')){const m=line.match(/^(#{1,4})\s+(.+)$/);if(m){const id=`note-heading-${headings.length}`;headings.push({id,text:m[2]});html+=`<h${m[1].length} id="${id}" tabindex="-1">${escape(m[2])}</h${m[1].length}>`;}else if(line.trim())html+=`<p>${escape(line)}</p>`;}return {html,headings};}
  function renderKnowledge(){return `<div class="page-heading"><div><h2>知识库</h2><p>选择一个知识库进入阅读；目录、正文和正文目录在库内展示。</p></div>${button("查看管理与授权设计","ui-baselines","",'data-module="knowledge"')}</div><div class="stack">${aux.libraries.map(lib=>`<article class="panel"><div class="panel-body server-card"><div><h3>${escape(lib.name)}</h3><p>${escape(lib.description)}</p></div><span class="tag">${lib.noteIds.length} 篇笔记 · DEMO</span>${button("进入知识库","ui-open-library",lib.id)}</div></article>`).join('')||empty("暂无知识库","管理页保留工作台导航。")}</div>`;}
  function renderLibrary(){
    const lib=currentLibrary();if(!lib)return empty("知识库不存在或已移除","请使用左上角返回知识库管理，不展示其他库正文。");
    const all=aux.notes.filter(n=>lib.noteIds.includes(n.id)),notes=all.filter(n=>(n.title+n.path+n.text).includes(ui.knowledgeQuery)),n=notes.find(n=>n.id===ui.note)||notes[0],model=n?markdownView(n):{html:'',headings:[]};
    return `<div class="page-heading"><h2>知识库 · ${escape(lib.name)}</h2></div><div class="reader-grid"><section class="panel"><div class="panel-body"><h3>文件目录</h3><input id="knowledge-search" aria-label="搜索本库文件与正文" placeholder="搜索文件与正文" value="${escape(ui.knowledgeQuery)}">${notes.map(n=>button(n.title,"ui-note",n.id,'',ui.note===n.id?'selected':'')).join('')||'无匹配资料'}</div></section><article class="panel knowledge-document">${notes.length?model.html:empty(all.length?'搜索无匹配':'该知识库暂无笔记',all.length?'不会展示旧正文作为搜索结果。':'左上角可返回知识库管理。')}</article><nav class="panel panel-body" aria-label="正文目录"><h3>正文目录</h3>${model.headings.map(h=>button(h.text,"ui-heading",h.id)).join('')||'暂无正文目录'}</nav></div>`;
  }
  function renderServers(){return `<div class="page-heading"><h2>服务器管理</h2></div><div class="stack">${aux.servers.map(s=>`<article class="panel"><div class="panel-body server-card"><div><h3>${escape(s.name)}</h3><p>${escape(s.host)}</p></div><span class="tag">${s.online?'在线样例':'离线样例'}</span>${button('进入工作台','ui-open-server',s.id)}</div></article>`).join('')}</div>`;}
  function renderServer(){const s=aux.servers.find(s=>s.id===ui.serverId)||aux.servers[0];return `<div class="page-heading"><h2>${escape(s.name)}</h2></div><div class="reader-grid"><section class="panel"><div class="panel-body stack"><h3>主机与文件</h3><p>${escape(s.host)}</p>${button(s.authorized?'撤销授权':'授权模拟操作','ui-server-auth',s.id)}${button(s.connected?'断开连接':'模拟连接','ui-server-connect',s.id)}<p>${s.connected?'已连接':'未连接'}</p>${button('/var/log/booking.log','ui-server-file',s.id)}</div></section><section class="panel"><div class="panel-head"><h3>终端 · 本机样例</h3></div><div class="panel-body"><pre class="sample-terminal">${escape(s.output)}</pre><form data-ui-form="terminal" data-server="${s.id}"><input name="command" required placeholder="help / uptime / free -h / df -h"><button class="btn" type="submit">运行样例命令</button></form></div></section><aside class="panel panel-body"><h3>性能指标</h3><p>CPU ${s.connected?'24%':'未知'}</p><p>内存 ${s.connected?'38%':'未知'}</p><p>磁盘 ${s.connected?'42%':'未知'}</p><p>高风险或非白名单命令拒绝，未连接真实主机。</p></aside></div>`;}
  function renderOffice(){const f=aux.office.find(f=>f.name===ui.officeFile)||aux.office[0];return `<div class="page-heading"><h2>${escape(currentProject().name)} · 文档工作区</h2></div><div class="code-layout"><section class="panel panel-body">${aux.office.map(f=>button(f.name,'ui-office-file',f.name)).join('')}</section><section class="panel panel-body stack"><h3>${escape(f.name)}</h3><pre>${escape(f.text)}</pre>${button('解读资料','ui-office-read',f.name)}${button('生成报告样例','ui-office-generate',f.name)}<div id="office-result">${escape(ui.officeResult||'选择资料进行解读，不覆盖源资料。')}</div></section></div>`;}
  function settingsContent(tab){
    if(tab==="general")return `<form data-ui-form="profile">${inputField('用户名称','name',aux.profile.name)}${inputField('邮箱','email',aux.profile.email,'email',false)}<button class="btn" type="submit">保存账户资料样例</button></form><div class="note">同一个入口和同一需求/执行数据源；这里不保存真实凭证。</div>`;
    if(tab==="models"||tab==="sdk")return button('查看完整设计基线','ui-baselines','',`data-module="${tab==='models'?'providers':'sdk'}"`)+'<div class="note warning">任务执行修复新设计（待正式实现）：以下仅演示CLI、模型与Runtime修复，不替代完整供应商四页签或SDK界面。原授权能力未取消，完整基线及缺口由主代理在同壳设计资源中登记；不能以本卡片宣称存量设计已完整覆盖。</div>'+Object.entries(state.config.executors).map(([cli,c])=>`<article class="panel"><div class="panel-body stack"><h3>${cliIcon(cli)}${escape(cliLabel(cli))}</h3><p>${c.enabled?'已安装/启用样例':'已停用'} · Runtime ${c.online===false?'离线':'在线'} · ${escape(c.models.join(' / '))}</p><div class="actions">${button(c.enabled?'停用CLI':'启用/修复CLI','ui-config-enable',cli)}${button(c.online===false?'恢复Runtime':'设为离线','ui-config-online',cli)}${button('查看并修复配置','ui-config-fix',cli)}</div></div></article>`).join('');
    const items=aux[tab==='skill'?'skills':tab==='mcp'?'mcp':'tools'];return items.map((x,i)=>`<div class="attempt-item"><strong>${escape(x.name)}</strong>${button(x.on?'停用':'启用','ui-capability',String(i),`data-group="${tab}"`)} · ${x.on?'启用':'停用'}</div>`).join('')+button('新增本机配置','ui-new-capability','',`data-group="${tab}"`);
  }
  function showSettings(tab="general"){ui.settingsTab=tab;const menu=[['general','基础设置'],['models','模型设置'],['sdk','智能体管理'],['skill','Skill'],['mcp','MCP'],['tool','Tool']];const body=`<div class="settings-layout"><nav class="settings-nav" aria-label="设置分类">${menu.map(([value,label])=>`<button class="btn" role="tab" data-action="ui-settings-tab" data-tab="${value}" aria-selected="${value===tab}">${label}</button>`).join('')}</nav><section class="stack">${settingsContent(tab)}${button('返回原任务','ui-return-task',ui.taskId||'',ui.taskId?'':'disabled')}</section></div>`;if($("#review-dialog").open){$("#dialog-content .dialog-body").innerHTML=body;dialogMode="ui-settings";}else openDialog('设置与账户 · 统一配置',body,button('关闭设置','close-dialog'),'ui-settings');}
  function renderBaselines17(){
    const B=window.WorkbenchDesignBaselines;
    if(!B)return empty('设计基线暂不可读','资源尚未加载，不能据此开发软件。',button('返回原工作区','ui-baseline-return'));
    const module=ui.baselineModule||'all',scenes=B.list(module==='all'?undefined:module);
    if(!scenes.some(s=>s.id===ui.baselineScene))ui.baselineScene=scenes[0]?.id||null;
    const names={all:'全部设计资源',providers:'供应商配置',sdk:'SDK完整设计',knowledge:'知识与授权',servers:'主机与认证',projects:'项目与需求',design:'UI与模型',files:'文件与Git',chat:'AI会话',office:'办公',settings:'基础与能力'};
    return `<div class="page-heading"><div><h2>完整设计基线与场景覆盖</h2><p>新任务设计与有效存量设计分别登记；只读资源不是第二套需求应用，不证明软件视觉一致。</p></div>${button('返回原工作区','ui-baseline-return')}</div><div class="filter-bar"><label for="baseline-module">设计范围</label><select id="baseline-module">${Object.entries(names).map(([value,label])=>`<option value="${value}" ${module===value?'selected':''}>${label}</option>`).join('')}</select><span class="muted">${scenes.length} 个场景 · 数量不在Tab显示</span></div><div class="baseline-browser-layout"><aside class="panel baseline-scene-list">${scenes.map(s=>`<button type="button" class="baseline-scene-button ${s.id===ui.baselineScene?'selected':''}" data-action="ui-baseline-scene" data-id="${escape(s.id)}"><strong>${escape(s.title)}</strong><small>${escape(s.status)} · ${escape(s.version)}</small></button>`).join('')}</aside><section class="baseline-scene-view">${ui.baselineScene?B.render(ui.baselineScene):empty('无该范围资源','该部分设计缺失，不允许对应软件开发。')}</section></div>`;
  }
  // UI-CR022-v1 最小接入：独立补稿，不接正式IPC，不改CR017/019运行状态与库阅读。
  // CR-027 仅替换设计主区；CR-033 让项目／知识库／服务器由管理首页在独立窗口打开。
  window.ProjectDesignResources?.attach(moduleCtx);
  const stockDesign=window.WorkbenchStockDesign;
  if(stockDesign){
    stockDesign.attach(moduleCtx);
    const originalLibraryReader=renderLibrary;
     window.WorkbenchKnowledgeDesign?.attach(moduleCtx);
     renderLibrary=()=>{const l=currentLibrary();return l?.knowledgeLocal&&window.WorkbenchKnowledgeDesign?window.WorkbenchKnowledgeDesign.renderLibrary(l.id):originalLibraryReader();};
     const originalSettingsContent=settingsContent;
    settingsContent=function(tab){const extension=stockDesign.settings(tab);return ['models','sdk'].includes(tab)?extension+`<section class="stock-runtime-preserved" data-task-runtime-preserved><h3>TaskRuntime配置修复 · 独立保留（不是SDK库存）</h3>${originalSettingsContent(tab)}</section>`:tab==='general'?originalSettingsContent(tab)+extension:extension;};
    renderKnowledge=()=>stockDesign.renderKnowledge();
    renderServers=()=>stockDesign.renderServers();
    const originalServerDetail=renderServer;
    renderServer=()=>stockDesign.enhanceServer(originalServerDetail());
  }
  // CR-033：固定管理首页；点击项目／知识库／服务器在独立窗口打开，同一对象只聚焦原窗口。
  window.WindowNav?.attach({projects:()=>aux.projects,libraries:()=>aux.libraries,servers:()=>aux.servers,
    getUI:()=>ui,setUI:next=>setUI(next),defaultUI,getAux:()=>aux,state:()=>state,saveAux,
    render:()=>render(),toast,openDialog:(title,body,footer,mode)=>openDialog(title,body,footer,mode)});
  const oldRender=render;render=function(){updateTop();if($("#review-dialog").open)return;if(ui.page==='baselines'){const focus=captureFocus();$("#view").setAttribute('aria-labelledby','current-title');$("#view").innerHTML=renderBaselines17();restoreFocus(focus);return;}if(ui.page==="project"&&currentProject().id===state.projectId){const focus=captureFocus();for(const tab of document.querySelectorAll('#project-tabs [role=tab]')){const active=tab.dataset.tab===ui.tab;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;}$("#view").setAttribute('aria-labelledby',`tab-${ui.tab}`);$("#view").innerHTML=ui.tab==='requirements'?renderRequirements():ui.tab==='design'?renderDesign17():ui.tab==='tasks'?renderTasks():renderCode();restoreFocus(focus);}
    else{const focus=captureFocus();$("#view").setAttribute('aria-labelledby','current-title');$("#view").innerHTML=ui.page==='projects'?renderProjects():ui.page==='knowledge'?renderKnowledge():ui.page==='knowledge-lib'?renderLibrary():ui.page==='servers'?renderServers():ui.page==='server'?renderServer():currentProject().kind==='work'?renderOffice():empty('该项目暂无研发需求','当前本机执行闭环在预约服务项目中演示。',button('在预约服务窗口打开','ui-open-project',state.projectId));restoreFocus(focus);}
    window.WindowNav?.sync();
  };
  // CR-029：仅包装需求阅读，不写原需求/模型，不改变AI、任务或导航。
  window.RequirementsReading?.attach({state:()=>state,project:currentProject,projectId:()=>currentProject().id,models:()=>aux.projectDesignResources?.[state.projectId]?.models||[],render:()=>render()});
  const requirementTree29=renderRequirements;
  renderRequirements=()=>window.RequirementsReading?window.RequirementsReading.render(requirementTree29()):requirementTree29();
  function uiAction(action,element){const id=element.dataset.id,r=requirementFor(id),t=taskFor(id);const reqOptions=()=>options(Object.entries(state.config.executors).flatMap(([cli,c])=>c.models.map(model=>[cli+'|'+model,cliLabel(cli)+' / '+model])),r?.executor?.cli+'|'+r?.executor?.model);
    if(action==='ui-baselines'){ui.baselineReturn={page:ui.page,projectId:ui.projectId,tab:ui.tab};if($("#review-dialog").open)closeDialog();ui.page='baselines';ui.baselineModule=element.dataset.module||'all';render();window.scrollTo(0,0);}
    else if(action==='ui-baseline-return'){Object.assign(ui,ui.baselineReturn||{page:'project',projectId:state.projectId,tab:'requirements'});render();}
    else if(action==='ui-baseline-scene'){ui.baselineScene=id;render();}
    else if(action==='ui-navigate'){window.WindowNav?.homeTo(element.dataset.page);window.scrollTo(0,0);}
    else if(action==='ui-open-project')window.WindowNav?.open('project',id);
    else if(action==='ui-open-library')window.WindowNav?.open('knowledge',id);
    else if(action==='ui-open-server')window.WindowNav?.open('server',id);
    else if(action==='ui-window-focus')window.WindowNav?.activate(id);
    else if(action==='ui-window-home')window.WindowNav?.home();
    else if(action==='ui-window-close')window.WindowNav?.requestClose(id||window.WindowNav?.active()?.key);
    else if(action==='ui-window-close-confirm'){closeDialog();window.WindowNav?.close(id,{discard:true});}
    else if(action==='ui-create-epic')requirementEditor(null,'epic');
    else if(action==='ui-create-story')requirementEditor(null,'story');
    else if(action==='ui-create')requirementEditor(null,r.kind==='epic'?'feature':'story',r.id);
    else if(action==='ui-edit')requirementEditor(id,r.kind);
    else if(action==='ui-delete')uiForm('删除需求（保留引用保护）','delete-requirement',id,`<p>删除 ${escape(id)}？有子项、运行或历史引用时拒绝，不级联。</p>`,'确认删除');
    else if(action==='ui-confirm'){const result=invokeUI('saveRequirement',id,{confirmed:true,reason:'用户在统一需求界面确认范围'});if(!result.ok)toast(result.error);}
    else if(action==='ui-design'){ui.selectedRequirement=id;selectTab('design');}
    else if(action==='ui-design-kind'){ui.designKind=element.dataset.kind;render();}
    else if(action==='ui-design-sync'){const result=invokeUI('saveRequirement',id,{designReady:true,synchronized:true,reason:'用户确认当前设计依据同步'});if(!result.ok)toast(result.error);}
    else if(action==='ui-assign')uiForm('仅分配执行器，不启动任务','assign',id,`<label>CLI / 模型<select name="executor">${reqOptions()}</select></label><p>原运行保持旧CLI，只有需求派发或明确重试才执行。</p>`,'保存分配');
    else if(action==='ui-open-task'){ui.taskId=id;ui.batch='all';ui.status='all';ui.query='';selectTab('tasks');}
    else if(action==='ui-retry')uiForm('从原运行重试','retry',id,areaField('重试原因','reason','已检查并修复失败原因')+`<label><input type="checkbox" name="fresh">明确新上下文重跑（旧CLI不变）</label><p>${escape(cliLabel(t.executor.cli))} / ${escape(t.executor.model)}；不重置授权、预算或历史。</p>`,'确认重试');
    else if(action==='ui-settings'||action==='ui-settings-task'){if(t)ui.taskId=id;showSettings(action==='ui-settings-task'?'sdk':'general');}
    else if(action==='ui-settings-tab')showSettings(element.dataset.tab);
    else if(action==='ui-return-task'){closeDialog();ui.taskId=id;selectTab('tasks');}
    else if(action==='ui-view-attempt'){const a=t?.attempts.find(a=>a.number===Number(element.dataset.number));if(!a)throw Error('本次运行记录不存在');openDialog(`Run / Attempt ${a.number} · 只读记录`,`<section data-attempt-record="${a.number}"><h3>${cliIcon(a.executor?.cli||t.executor.cli)}原CLI：${escape(cliLabel(a.executor?.cli||t.executor.cli))} / ${escape(t.executor.model)}</h3><p>round ${escape(a.round||1)} · ${escape(a.contextMode||'原上下文样例')} · exit ${escape(a.exitCode??'未结束')} · ${escape(a.status)}</p><pre>${escape((a.logs||[]).map(l=>'[tick '+l.tick+'] '+l.message).join('\n')||'本次尚无记录')}</pre><p>本次结果/错误：${escape(a.outcome||'尚未结束')}</p><p>验证：${escape(a.verification?.status||'未执行')} · 集成：${escape(a.integration?.status||'未执行')}</p><p>仿真耗时 ${Math.max(0,(a.endedAt??state.clock)-a.startedAt)} tick；真实usage未知。</p></section>`,button('返回当前任务','ui-return-attempt',t.id),'attempt');}
    else if(action==='ui-return-attempt'){closeDialog();ui.taskId=id;ui.batch='all';ui.status='all';selectTab('tasks');}
    else if(action==='ui-transcript'){openDialog(`Run transcript · ${escape(id)}`,`<div>${cliIcon(t.executor.cli)}${escape(cliLabel(t.executor.cli))} / ${escape(t.executor.model)}</div><h3>运行输出与错误（仿真）</h3><pre>${escape(t.logs.map(l=>'[tick '+l.tick+'] '+l.message).join('\n'))}</pre><h3>工具/步骤事件 · DEMO命令</h3><table class="data-table" data-tool-events><thead><tr><th>样例调用</th><th>输入范围</th><th>结果</th></tr></thead><tbody>${t.steps.map(s=>`<tr><td><code>DEMO.${escape(s.key)}</code></td><td>${escape(t.storyId)} / ${escape(t.frozen.writePaths.join('、'))}</td><td>${escape(resultLabels[s.status]||s.status)}${s.key==='deliver'&&t.artifactRevision?'<br>'+escape(t.artifactRevision):''}${s.key==='verify'&&t.verification?.checks?'<br>'+escape(t.verification.checks.map(c=>c.id+':'+c.result).join('；')):''}</td></tr>`).join('')}</tbody></table><p>步骤事件来自同一状态机执行记录；未执行不得标通过。elapsed为仿真tick，真实usage/tokens/费用未知，未调用真实工具。</p>`,button('返回运行','close-dialog'),'transcript');}
    else if(action.startsWith('ui-review-'))uiForm('模拟评审 · 绑定当前运行','review',id,areaField('评审理由','reason',action.endsWith('approve')?'本次有效证据符合冻结范围':''),action.endsWith('approve')?'评审通过':'退回返工',{decision:action.endsWith('approve')?'approve':'reject'});
    else if(action.startsWith('ui-accept-'))uiForm('模拟验收 · 只接受当前有效产物','accept',id,areaField('验收理由','reason',action.endsWith('approve')?'已核对当前产物与AC':''),action.endsWith('approve')?'确认验收':'退回',{decision:action.endsWith('approve')?'approve':'reject'});
    else if(action==='ui-cancel-requirement')uiForm('取消需求与全部关联运行','cancel-requirement',id,areaField('取消原因','reason'),'确认取消');
    else if(action==='ui-wakeup-create')uiForm('创建条件唤醒','wakeup',id,`<label>条件<select name="kind">${options([['clock','仿真时钟'],['comment','评论到达'],['anotherStory','另一需求有效完成'],['children','阶段子项完成'],['demoCI','模拟CI结果']], 'clock')}</select></label><label>关联需求<select name="targetStoryId">${options(state.requirements.map(x=>[x.id,x.id+' · '+x.kind+' · '+x.title]),id)}</select></label>${inputField('唤醒tick','at',state.clock+3,'number')}${inputField('到期tick','expiresAt',state.clock+30,'number')}${inputField('最多触发次数','maxFires',1,'number')}${areaField('醒来后执行说明','instruction','检查当前需求与有效产物后继续工作')}`,'创建规则');
    else if(action==='ui-wakeup-disable'||action==='ui-wakeup-trigger'||action==='ui-wakeup-enable'){const result=invokeUI('wakeup',{op:action.endsWith('disable')?'disable':action.endsWith('enable')?'enable':'trigger',id});if(!result.ok)toast(result.error);}
    else if(action==='ui-wakeup-delete')uiForm('删除唤醒规则（历史保留）','wakeup-delete',id,'<p>停止并删除此规则。已有运行不自动取消，触发历史保留，不改变需求状态。</p>','确认删除');
    else if(action==='ui-demo-ci')uiForm('模拟CI事件（不执行Git或网络）','demo-ci',id,`<label>模拟结果<select name="status">${options([['passed','检查通过'],['failed','检查失败'],['merged','已合并样例'],['conflicts','冲突样例'],['pending','仍在等待']],'passed')}</select></label><p>事件只更新DEMO记录，唤醒还需绑定版本和条件验证。</p>`,'记录模拟事件');
    else if(action==='ui-config-enable'||action==='ui-config-online'){const c=state.config.executors[id],result=invokeUI('configure',action.endsWith('enable')?{cli:id,enabled:!c.enabled}:{cli:id,online:c.online===false});if(result.ok)showSettings(ui.settingsTab);else toast(result.error);}
    else if(action==='ui-config-fix'){const c=state.config.executors[id],target=taskFor(ui.taskId);const result=invokeUI('configure',{cli:id,valid:true,enabled:true,online:true,models:state.config.policy.allowed.filter(a=>a.cli===id).map(a=>a.model),permissions:(id==='claude'?['demo.write','demo.verify']:['demo.write','demo.verify','demo.integrate']).filter(p=>p!=='demo.verify'||aux.tools.find(t=>t.name==='构建验证')?.on!==false),...(target?{fault:{storyId:target.storyId,permanentFailure:false,networkRemaining:0,verifyRemaining:0}}:{})});if(result.ok)showSettings(ui.settingsTab);else toast(result.error);}
    else if(action==='ui-code-kind'){ui.codeKind=element.dataset.kind;render();}
    else if(action==='ui-file'){ui.file=id;render();}
    else if(action==='ui-discard-file'){if(aux.fileDrafts)delete aux.fileDrafts[id];render();}
    else if(action==='ui-stage'){const f=aux.files.find(x=>x.name===id);f.staged=!f.staged;save();render();}
    else if(action==='ui-diff'){const f=aux.files.find(x=>x.name===id);openDialog('本机Git差异',`<pre>${escape('--- '+f.name+'\n'+f.baseline.split('\n').map(l=>'- '+l).join('\n')+'\n+++ '+f.name+'\n'+f.text.split('\n').map(l=>'+ '+l).join('\n'))}</pre>`,button('关闭','close-dialog'),'diff');}
    else if(action==='ui-new-branch')uiForm('新建样例分支','branch',null,inputField('分支名称','name','feature/new-work'),'创建分支');
    else if(action==='ui-note'){ui.note=id;render();}
    else if(action==='ui-heading')document.getElementById(id)?.scrollIntoView({block:'start'});
    else if(action==='ui-server-auth'){const s=aux.servers.find(x=>x.id===id);s.authorized=!s.authorized;save();render();}
    else if(action==='ui-server-connect'){const s=aux.servers.find(x=>x.id===id);if(s.connected){s.connected=false;s.output+='\n已断开样例连接。';}else if(!s.online)s.output+='\n连接失败：主机样例离线。';else{s.connected=true;s.output+='\n模拟连接已建立。';}save();render();}
    else if(action==='ui-server-file'){const s=aux.servers.find(x=>x.id===id);s.output+=s.connected?'\n[日志样例] booking request 200 · no real SSH':'\n未连接，不能读取主机样例文件。';render();}
    else if(action==='ui-new-project'||action==='ui-edit-project'){const p=aux.projects.find(p=>p.id===id);uiForm(p?'编辑项目':'新建本机项目','project',id,inputField('项目名称','name',p?.name)+inputField('负责人','owner',p?.owner||'林澈')+`<label>项目类型<select name="kind">${options([['work','办公'],['code','编码']],p?.kind||'work')}</select></label>`+areaField('简介','description',p?.description||'本机项目资料'),'保存项目');}
    else if(action==='ui-capability'){const list=aux[element.dataset.group==='skill'?'skills':element.dataset.group==='mcp'?'mcp':'tools'],item=list[Number(id)];item.on=!item.on;if(element.dataset.group==='tool'&&item.name==='构建验证'){for(const [cli,c] of Object.entries(state.config.executors)){const permissions=item.on?[...new Set([...c.permissions,'demo.verify'])]:c.permissions.filter(p=>p!=='demo.verify');const result=invokeUI('configure',{cli,permissions});if(!result.ok){item.on=!item.on;throw Error(result.error);}}}save();showSettings(ui.settingsTab);}
    else if(action==='ui-new-capability')uiForm('新增本机配置','capability',null,inputField('名称','name'),'创建',{group:element.dataset.group});
    else if(action==='ui-office-file'){ui.officeFile=id;render();}
    else if(action==='ui-office-read'){ui.officeResult='资料解读（仿真）：'+aux.office.find(f=>f.name===id).text;render();}
    else if(action==='ui-office-generate'){aux.office.push({name:'研究报告-'+(aux.office.length+1)+'.docx',text:'源自 '+id+'\n'+aux.office.find(f=>f.name===id).text+'\n生成的本机预览样例，不写真实Office文件。'});ui.officeFile=aux.office.at(-1).name;save();render();}
  }
  document.addEventListener('click',event=>{const el=event.target.closest('[data-action^="ui-"]');if(!el||el.disabled)return;event.preventDefault();event.stopImmediatePropagation();el.focus({preventScroll:true});try{uiAction(el.dataset.action,el);}catch(error){toast('未应用：'+error.message);}},true);
  document.addEventListener('submit',event=>{const f=event.target;if(!f.dataset.uiForm)return;event.preventDefault();event.stopImmediatePropagation();const data=new FormData(f),v=Object.fromEntries(data),meta=ui.form||{},id=meta.id;let result={ok:true};
    try{
      if(f.dataset.uiForm==='requirement'){const patch={title:v.title,description:v.description,goal:v.goal,...(v.ac?{ac:v.ac.split('\n').map(s=>s.trim()).filter(Boolean)}:{}),reason:v.reason};result=id?invokeUI('saveRequirement',id,patch):invokeUI('createRequirement',{...patch,kind:meta.extra.kind,parent:v.parent||null,confirmed:false,synchronized:false,designReady:false});if(result.ok){ui.selectedRequirement=result.id||result.requirementId||id;ui.page='project';ui.tab='requirements';}}
      else if(f.dataset.uiForm==='delete-requirement')result=invokeUI('deleteRequirement',id);
      else if(f.dataset.uiForm==='assign'){const [cli,model]=v.executor.split('|');result=invokeUI('assign',id,{cli,model,start:false});}
      else if(f.dataset.uiForm==='retry'){result=invokeUI('retryTask',id,{requestId:'UI-RETRY-'+state.epoch+'-'+Date.now(),reason:v.reason,fresh:data.has('fresh')});if(result.ok){ui.taskId=result.taskId||id;ui.page='project';ui.tab='tasks';}}
      else if(f.dataset.uiForm==='review'){if(taskFor(id)?.round!==meta.round)result={ok:false,error:'运行阶段已变化，请关闭后重新打开评审'};else result=invokeUI('review',id,{decision:meta.extra.decision,reason:v.reason});}
      else if(f.dataset.uiForm==='accept'){if(requirementFor(id)?.workflowVersion!==meta.workflowVersion)result={ok:false,error:'需求修订已变化，旧验收不能使用'};else result=invokeUI('accept',id,{decision:meta.extra.decision,reason:v.reason});}
      else if(f.dataset.uiForm==='cancel-requirement')result=invokeUI('saveRequirement',id,{status:'cancelled',reason:v.reason});
      else if(f.dataset.uiForm==='wakeup-delete')result=invokeUI('wakeup',{op:'delete',id});
      else if(f.dataset.uiForm==='demo-ci')result=invokeUI('configure',{demoCI:{storyId:id,status:v.status}});
      else if(f.dataset.uiForm==='wakeup')result=invokeUI('wakeup',{op:'create',rule:{storyId:id,kind:v.kind,targetStoryId:v.targetStoryId,at:Number(v.at),expiresAt:Number(v.expiresAt),maxFires:Number(v.maxFires),instruction:v.instruction}});
      else if(f.dataset.uiForm==='comment'){result=invokeUI('comment',f.dataset.story,{text:v.text,actor:'user',...(f.dataset.task?{taskId:f.dataset.task}:{})});if(result.ok){ui.commentDraft='';render();return;}else{toast(result.error);return;}}
      else if(f.dataset.uiForm==='design'){if(!/^[A-Za-z_]\w*$/.test(v.name)||!v.fields.split('\n').every(l=>/^[A-Za-z_]\w*\|(integer|text|boolean|datetime)\|/.test(l)))throw Error('模型名称和逐行字段格式无效');result=invokeUI('saveRequirement',f.dataset.story,{designReady:true,synchronized:false,reason:'保存设计/模型草稿，尚未确认同步'});if(result.ok){aux.designs[f.dataset.story]={notes:v.notes,name:v.name,fields:v.fields};save();render();return;}else{toast(result.error);return;}}
      else if(f.dataset.uiForm==='file-save'){aux.files.find(x=>x.name===f.dataset.file).text=v.text;save();render();return;}
      else if(f.dataset.uiForm==='git-commit'){const selected=aux.files.filter(x=>x.staged);if(!selected.length)throw Error('没有暂存项，未提交');for(const file of selected){file.baseline=file.text;file.staged=false;}aux.commits.unshift({id:'DEMO-COMMIT-'+(aux.commits.length+1),message:v.message,branch:aux.branch});save();render();return;}
      else if(f.dataset.uiForm==='branch'){if(!/^[A-Za-z0-9][A-Za-z0-9_\/-]*$/.test(v.name)||aux.branches.includes(v.name))throw Error('分支名无效或重复');aux.branches.push(v.name);save();}
      else if(f.dataset.uiForm==='project'){if(aux.projects.some(p=>p.id!==id&&p.name===v.name))throw Error('项目名重复');if(id)Object.assign(aux.projects.find(p=>p.id===id),v);else aux.projects.push({id:'DEMO-LOCAL-'+(aux.projects.length+1),...v});save();}
      else if(f.dataset.uiForm==='profile'){aux.profile={name:v.name,email:v.email};save();showSettings('general');return;}
      else if(f.dataset.uiForm==='capability'){const list=aux[meta.extra.group==='skill'?'skills':meta.extra.group==='mcp'?'mcp':'tools'];if(list.some(x=>x.name===v.name))throw Error('配置名重复');list.push({name:v.name,on:true});save();closeDialog();return;}
      else if(f.dataset.uiForm==='terminal'){const s=aux.servers.find(x=>x.id===f.dataset.server),commands=window.WorkbenchSampleFixtures?.terminal()||{help:'支持 uptime / free -h / df -h',uptime:'up 12 days · load 0.36', 'free -h':'Mem: 8Gi total, 3Gi used','df -h':'/dev/demo 80G 42%'};s.output+='\n$ '+v.command+'\n'+(!s.connected?'未连接，拒绝执行':!s.authorized?'未授权，拒绝执行':commands[v.command]||'非白名单/高风险命令：拒绝，未执行');save();render();return;}
      if(!result.ok){showError(result.error);return;}closeDialog();render();startClock();
    }catch(error){if($("#review-dialog").open)showError(error.message);else toast(error.message);}
  },true);
  document.addEventListener('input',event=>{if(event.target.id==='project-search'){ui.projectQuery=event.target.value;render();}if(event.target.id==='knowledge-search'){ui.knowledgeQuery=event.target.value;render();}if(event.target.id==='discussion-text')ui.commentDraft=event.target.value;if(event.target.name==='text'&&event.target.closest('form[data-ui-form=file-save]')){aux.fileDrafts||={};aux.fileDrafts[event.target.form.dataset.file]=event.target.value;}});
  document.addEventListener('change',event=>{if(event.target.id==='baseline-module'){ui.baselineModule=event.target.value;ui.baselineScene=null;render();}if(event.target.id==='design-story'){ui.selectedRequirement=event.target.value;render();}if(event.target.id==='git-branch'){if(aux.files.some(f=>f.text!==f.baseline)){toast('有未提交样例改动，不能切换分支');event.target.value=aux.branch;}else{aux.branch=event.target.value;save();render();}}});
  document.addEventListener('keydown',event=>{const el=event.target.closest('[role=tab][data-action^="ui-"]');if(!el||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();event.stopImmediatePropagation();const action=el.dataset.action,items=Array.from(el.parentElement.querySelectorAll(`[role=tab][data-action="${action}"]`)),index=items.indexOf(el),target=items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(['ArrowRight','ArrowDown'].includes(event.key)?1:-1)+items.length)%items.length];target?.click();const attribute=target?.dataset.tab!==undefined?'data-tab':'data-kind',value=target?.dataset.tab??target?.dataset.kind??'';document.querySelector(`[role=tab][data-action="${action}"][${attribute}="${value}"]`)?.focus();},true);
  // REVIEW-2026-11-19：默认视图等同软件界面。非评审模式清除设计注记文本；?review=1 时保留原文。
  const NOTE_TEXT_RULES = [
    [/DEMO-PROJECT-01/g, 'PROJECT-01'], [/DEMO-WORK-01/g, 'WORK-01'],
    [/DEMO-(EPIC|FEAT|STORY|AC|RUN|CHAT|COMMIT|LOCAL)-/g, '$1-'],
    [/DEMO-(CODER|GENERAL|IMAGE-ONLY|AUDIT|REVIEWER)/g, '$1'],
    [/（样例）/g, ''], [/（DEMO）/g, ''], [/（评审样例）/g, ''], [/（当次交付）/g, ''],
    [/样例执行器/g, '执行器'], [/样例产物修订/g, '产物修订'], [/样例 SHA/g, 'SHA'], [/样例 tick/g, 'tick'],
    [/编码证据 · 仿真/g, '编码证据'], [/当前 DEMO 执行 DAG/g, '当前执行 DAG'],
    [/本机样例/g, ''], [/在线样例/g, '在线'], [/离线样例/g, '离线'],
    [/保存样例文件/g, '保存文件'], [/运行样例命令/g, '运行命令'], [/提交本机样例/g, '提交'],
    [/工作区样例无变更/g, '工作区无变更'], [/暂无样例提交/g, '暂无提交'],
    [/已安装\/启用样例/g, '已安装/启用'], [/保存账户资料样例/g, '保存账户资料'],
    [/新建本机项目/g, '新建项目'], [/本机项目资料/g, '项目资料'],
    [/模拟 exit/g, 'exit'], [/仿真尝试/g, '尝试'], [/仿真单位/g, '单位'],
    [/可观察验收（DEMO）/g, '可观察验收'], [/个 DEMO Story/g, '个 Story'],
    [/业务树 · 12 个样例 Story/g, '业务树 · 12 个 Story'],
    [/尚未创建评审批次/g, '尚未创建批次'], [/评审批次/g, '批次'],
    [/\s*·\s*DEMO\b/g, ''], [/\bDEMO\b/g, ''],
    [/样例/g, ''], [/仿真/g, '']
  ];
  const NOTE_BLOCK = /评审|未实现|未接通|未实测|不证明|不调用|不执行|演示|样例|DEMO|仿真|真实值未知|不代表|不能作为|仅用于|不是生产/;
  const stripText = text => {
    let next = text;
    for (const [re, to] of NOTE_TEXT_RULES) next = next.replace(re, to);
    return next
      .replace(/[（(]\s*[)）]/g, '')
      .replace(/[，、；：]\s*[。]/g, '。')
      .replace(/[(（]\s*[)）]/g, '')
      .replace(/\s+([，。；：、])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim();
  };
  function stripReviewNotes(root) {
    if (!root || document.documentElement.hasAttribute('data-review-mode')) return;
    root.querySelectorAll('.note, .page-heading p').forEach(el => {
      if (el.closest('[data-review-only]')) return;
      const text = el.textContent.trim();
      if (!text || !NOTE_BLOCK.test(text)) return;
      if (el.matches('.page-heading p') && !/评审方案|未实现|不证明|仅展示|不调用|不执行真实|真实值未知|不能作为|只模拟|本独立/.test(text)) {
        el.textContent = stripText(text);
        if (!el.textContent.trim()) el.remove();
        return;
      }
      el.remove();
    });
    root.querySelectorAll('.tag').forEach(el => { if (/^DEMO$/.test(el.textContent.trim())) el.remove(); });
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest('pre, code, textarea, script, style, [data-review-only]')) continue;
      if (/\bDEMO\b|样例|仿真/.test(node.nodeValue)) texts.push(node);
    }
    for (const node of texts) {
      const next = stripText(node.nodeValue);
      if (next !== node.nodeValue) node.nodeValue = next;
    }
  }
  const paintView = render;
  render = function () { paintView(); stripReviewNotes(document.body); };
  const openDialogBase = openDialog;
  openDialog = function (...args) { openDialogBase(...args); stripReviewNotes(document.querySelector('#dialog-content')); };

  render(); startClock();

  // 仅评审调试接口，测试通过该接口读取快照或控制仿真速度。没有真实执行入口。
  const executionRenderDetail=renderTaskDetail;renderTaskDetail=function(task){const html=executionRenderDetail(task);const selected=task||taskFor(ui.taskId);const extension=selected&&window.TaskExecutionDesign?'<div id="execution-details">'+window.TaskExecutionDesign.renderTask(selected)+window.TaskExecutionDesign.renderRetry(selected)+'</div>':'';return extension?html.replace('<div class="panel-body">','<div class="panel-body">'+extension):html;};
  let executionChange=null,executionReturnScope=null;
  function showExecutionChange(task,kind){
   const P=window.TaskExecutionPlanModel,D=window.TaskExecutionDesign,C=window.TaskExecutionCatalog;
   if(task.stopPending||!terminal(task.status)){toast('旧writer尚未确认停止；不能变更执行计划');return;}
   if(kind==='review'){const q=C.requestFor({...task.frozen,id:task.storyId}),plan=D.createPhasePlan(task,{...q,requiredCapabilities:['native.fs.read'],requiredSkills:[]});executionChange={taskId:task.id,kind,plan};openDialog('只读阶段计划预检',D.renderPlan(plan,{title:'当前有效产物的独立只读评审'}),button('取消','close-dialog')+button('确认计划并执行评审DEMO','execution-confirm','',plan.status==='ready'?'':'disabled'),'execution-review');return;}
   const q=C.requestFor({...task.frozen,id:task.storyId});q.sourceRun=task.id;const item={...task.frozen,id:task.storyId,executionRequest:q};const draft={frozen:[item]};executionChange={taskId:task.id,kind,draft};openDialog('新执行组合 · 重新预检授权',D.renderPreflight(draft)+'<label>变更理由<input id="execution-change-reason" value="明确调整执行组合" required></label>',button('取消','close-dialog')+button('确认新计划并开始新尝试','execution-confirm','',item.executionPlan?.status==='ready'?'':'disabled'),'execution-replacement');
  }
  document.addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(!b)return;if(b.dataset.action==='execution-return'){const saved=executionReturnScope;closeDialog();if(saved)showPreflight(saved);return;}if(b.dataset.action!=='execution-confirm'||!executionChange)return;const {taskId,kind,draft}=executionChange;let plan;
   if(kind==='review'){const raw=executionChange.plan;try{plan=window.TaskExecutionPlanModel.freeze(raw,{id:'DEMO-PHASE-AUTH-'+raw.hash,confirmed:true,planHash:raw.hash});}catch(err){toast(err.message);return;}}
   else{const captured=window.TaskExecutionDesign.captureConfirmedPlans(draft.frozen.map(x=>x.id));if(!captured.ok){toast(captured.errors.join('；'));return;}plan=captured.plans[draft.frozen[0].id];}
   const result=kind==='review'?invokeUI('executeReviewPlan',taskId,{plan}):invokeUI('approveExecutionPlan',taskId,{plan,reason:document.querySelector('#execution-change-reason')?.value});if(result.ok){executionChange=null;closeDialog();render();}else toast(result.error);
  });
  document.addEventListener('cr026:action',event=>{const {action,taskId}=event.detail||{};
   if(action==='management'){executionReturnScope=preview?.scope;closeDialog();showSettings('sdk');if(executionReturnScope)document.querySelector('#dialog-content .dialog-footer')?.insertAdjacentHTML('afterbegin',button('返回派发并重检','execution-return'));}
   else if(action==='retry'||action==='fresh'){const t=taskFor(taskId);if(!t)return;const result=invokeUI('retryTask',t.id,{requestId:'EXEC-RETRY-'+Date.now(),reason:'按原冻结执行计划重试',fresh:action==='fresh'});if(!result.ok)toast(result.error);}
   else if(action==='preview-changed'||action==='recheck'){if(executionChange?.kind==='replacement'){const b=document.querySelector('[data-action="execution-confirm"]');if(b)b.disabled=executionChange.draft.frozen.some(x=>x.executionPlan?.status!=='ready');return;}if(preview){Object.assign(preview,S.preflight(state,preview.scope,{},window.TaskExecutionDesign.getRequests()));const b=document.querySelector('[data-action="confirm-dispatch"]');if(b)b.disabled=!preview.ok;}}
   else if(action==='replacement'||action==='review'){const t=taskFor(taskId);if(t)showExecutionChange(t,action);}
  });
  window.TaskReviewApp = Object.freeze({ getState: () => S.snapshot(state).state, getUI: () => ({ ...ui, collapsed: [...ui.collapsed] }), getWindows: () => window.WindowNav ? { mode: window.WindowNav.mode(), active: window.WindowNav.active(), list: window.WindowNav.list() } : null, reset, debugStep,
    setIntervalForReview(ms) { if (!Number.isInteger(ms) || ms < 30 || ms > 5000) throw new Error("评审间隔需为 30～5000ms"); intervalMs = ms; startClock(); },
    getTimerInfo: () => ({ scheduled: timer !== null, generation: timerGeneration, epoch: state.epoch, intervalMs, callbackCount }), getScheduledCallback: () => scheduledCallback, storageKey });
})();
