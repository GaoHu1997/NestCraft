/* CR-016 纯评审状态机。没有 DOM、计时器、文件、CLI、Git 或网络调用。 */
(function (root) {
  "use strict";

  const TASK_STATES = Object.freeze(["queued", "waiting_dependency", "waiting_resource", "preparing", "running", "verifying", "integrating", "retry_wait", "paused", "blocked", "succeeded", "failed", "cancelled"]);
  const BATCH_STATES = Object.freeze(["running", "succeeded", "partial", "failed", "cancelled"]);
  const TERMINAL = new Set(["blocked", "succeeded", "failed", "cancelled"]);
  const ACTIVE = new Set(["preparing", "running", "verifying", "integrating"]);
  const clone = value => JSON.parse(JSON.stringify(value));
  let generation = 0;
  const epoch = old => (generation = Math.max(generation + 1, (old || 0) + 1));
  const storyId = n => `DEMO-STORY-${String(n).padStart(2, "0")}`;
  const artifactId = id => `DEMO-ARTIFACT-${id.slice(-2)}`;
  const sameBaseline = (a, b) => a && b && ["requirement", "design", "ac"].every(k => a[k] === b[k]);
  const baseline = requirement => requirement ? ({ requirement: requirement.requirementHash, design: requirement.designHash, ac: requirement.acHash }) : null;
  const taskActive = task => ACTIVE.has(task.status) || (task.status === "paused" && ACTIVE.has(task.resumeStatus));
  const taskDone = task => TERMINAL.has(task.status);
  const taskFor = (state, id) => state.tasks.find(t => t.id === id);
  const requirementFor = (state, id) => state.requirements.find(r => r.id === id);
  const batchFor = (state, id) => state.batches.find(b => b.id === id);

  function demoRequirements() {
    const requirements = [
      { id: "DEMO-EPIC-01", kind: "epic", parent: null, title: "交付可验证的预约服务" },
      { id: "DEMO-FEAT-01", kind: "feature", parent: "DEMO-EPIC-01", title: "预约主流程" },
      { id: "DEMO-FEAT-02", kind: "feature", parent: "DEMO-EPIC-01", title: "运营与审计保障" },
      { id: "DEMO-EPIC-02", kind: "epic", parent: null, title: "待整理的后续诉求" },
      { id: "DEMO-FEAT-03", kind: "feature", parent: "DEMO-EPIC-02", title: "准入排除样例" }
    ];
    const definitions = [
      [1, "冻结预约接口契约", 1, [], ["demo.contract"], true],
      [2, "实现预约后端", 1, [1], ["demo.backend"], true],
      [3, "实现预约前端", 1, [1], ["demo.frontend"], true],
      [4, "验证预约端到端流程", 1, [2, 3], ["demo.flow"], true],
      [5, "独立权限审计", 2, [], ["demo.audit"], false],
      [6, "校验预约索引方案", 2, [], ["demo.shared-schema"], true],
      [7, "校验预约约束方案", 2, [], ["demo.shared-schema"], true],
      [8, "整理运营验收手册", 2, [4], ["demo.handbook"], false],
      [9, "尚未确认的提醒诉求", 3, [], [], false],
      [10, "存在未同步设计草稿", 3, [], [], false],
      [11, "已经完成的历史故事", 3, [], [], false],
      [12, "已取消的历史诉求", 3, [], [], false]
    ];
    for (const [number, title, feature, dependencies, resources, integration] of definitions) {
      const id = storyId(number), reviewer = number === 5 || number === 8;
      requirements.push({
        id, kind: "story", parent: `DEMO-FEAT-0${feature}`, title,
        status: number === 9 ? "unconfirmed" : number === 10 ? "unsynced" : number === 11 ? "completed" : number === 12 ? "cancelled" : "ready",
        confirmed: number !== 9, synchronized: number !== 10, designReady: true,
        requirementHash: `DEMO-REQ-${number}-r1`, designHash: `DEMO-DESIGN-${number}-r1`, acHash: `DEMO-AC-${number}-r1`,
        ac: [`AC-${id}-01`, `AC-${id}-02`],
        dependencies: dependencies.map(n => ({ storyId: storyId(n), requiredArtifact: artifactId(storyId(n)), verificationGate: "verified_integrated" })),
        resources, integration, executor: { cli: reviewer ? "claude" : "codex", model: reviewer ? "DEMO-REVIEWER" : "DEMO-CODER" },
        capabilities: integration ? ["demo.write", "demo.verify", "demo.integrate"] : ["demo.write", "demo.verify"],
        writePaths: [`DEMO-WORKSPACE/${id}/**`], artifactId: artifactId(id), acceptance: "none", revision: 1, workflowVersion: 1, comments: [], acceptanceHistory: []
      });
    }
    return requirements;
  }

  function createState(options = {}) {
    const state = {
      version: 1, projectId: "DEMO-PROJECT-01", projectTitle: "预约服务 · 研发评审", epoch: epoch(), clock: 0,
      paused: false, nextBatch: 1, nextTask: 1, nextEvent: 1, codeHead: "DEMO-HEAD-000", headRevision: 0,
      requirements: demoRequirements(), tasks: [], batches: [], artifacts: {}, artifactHistory: {}, locks: {}, integrationOwner: null,
      events: [], dispatchKeys: {}, faults: {}, scenario: options.scenario || "normal", scheduledInjection: null,
      wakeups: [], nextWakeup: 1, nextComment: 1, requestKeys: {}, demoCI: {}, nextRequirementIds: { story: 13, feature: 4, epic: 3 },
      config: {
        version: "DEMO-POLICY-1", valid: true,
        policy: { maxConcurrent: 3, maxRetries: 1, maxRework: 1, retryDelay: 2, budget: 120, autoAcceptance: false, localIntegration: true,
          allowed: [{ cli: "codex", model: "DEMO-CODER" }, { cli: "claude", model: "DEMO-REVIEWER" }, { cli: "grok", model: "DEMO-GROK" }], writeScope: ["DEMO-WORKSPACE/**"], maxManualRetries: 2, maxReviewRounds: 2 },
        executors: {
          codex: { enabled: true, online: true, models: ["DEMO-CODER"], permissions: ["demo.write", "demo.verify", "demo.integrate"] },
          claude: { enabled: true, online: true, models: ["DEMO-REVIEWER"], permissions: ["demo.write", "demo.verify"] },
          grok: { enabled: true, online: true, models: ["DEMO-GROK"], permissions: ["demo.write", "demo.verify", "demo.integrate"], source: "明确DEMO仿真，不证明真实Grok兼容" }
        }
      }
    };
    if (options.policy) Object.assign(state.config.policy, clone(options.policy));
    const fault = (n, value) => { state.faults[storyId(n)] = value; };
    switch (state.scenario) {
      case "network-retry": fault(2, { networkRemaining: 1 }); break;
      case "retry-exhausted": fault(2, { networkRemaining: 4 }); break;
      case "verify-rework": fault(3, { verifyRemaining: 1 }); break;
      case "verify-exhausted": fault(1, { verifyRemaining: 4 }); break;
      case "parent-failure": fault(1, { permanentFailure: true }); break;
      case "parent-cancel": fault(1, { cancelAtRunning: true }); break;
      case "config-invalid": state.config.valid = false; break;
      case "model-invalid": state.scheduledInjection = { at: 4, type: "model-disabled", cli: "codex", model: "DEMO-CODER" }; break;
      case "permission-invalid": state.scheduledInjection = { at: 4, type: "permission-disabled", cli: "codex", permission: "demo.write" }; break;
      case "requirement-change": state.scheduledInjection = { at: 4, type: "requirement-change", storyId: storyId(1) }; break;
      case "cycle": requirementFor(state, storyId(1)).dependencies.push({ storyId: storyId(4), requiredArtifact: artifactId(storyId(4)), verificationGate: "verified_integrated" }); break;
      case "budget": state.config.policy.budget = 6; break;
      case "auto-accept": state.config.policy.autoAcceptance = true; break;
    }
    return state;
  }

  function event(state, task, message, type = "info") {
    const entry = { id: `DEMO-EVENT-${state.nextEvent++}`, tick: state.clock, taskId: task ? task.id : null, type, message, source: "评审仿真" };
    state.events.push(entry);
    if (task) { task.logs.push(entry); const attempt = task.attempts.at(-1); if (attempt && !attempt.endedAt) attempt.logs.push(entry); }
  }

  function policyErrors(state, policy) {
    const errors = [];
    if (!policy || typeof policy !== "object") return ["策略结构无效"];
    for (const key of ["maxManualRetries", "maxReviewRounds"]) if (policy[key] !== undefined && (!Number.isInteger(policy[key]) || policy[key] < 0 || policy[key] > 3)) errors.push(`${key} 必须是0到3的有界整数`);
    if (!state.config.valid) errors.push("执行配置已失效，拒绝启动仿真批次");
    for (const key of ["maxConcurrent", "maxRetries", "maxRework", "retryDelay", "budget"]) {
      if (!Number.isInteger(policy[key]) || policy[key] < (key === "maxConcurrent" || key === "budget" || key === "retryDelay" ? 1 : 0)) errors.push(`${key} 必须是有效的有界整数`);
    }
    if (policy.maxConcurrent > 8 || policy.maxRetries > 3 || policy.maxRework > 3 || policy.budget > 10000 || policy.retryDelay > 20) errors.push("评审策略超出有限仿真允许值");
    if (typeof policy.autoAcceptance !== "boolean" || typeof policy.localIntegration !== "boolean") errors.push("验收与集成策略必须明确");
    if (!Array.isArray(policy.allowed) || !policy.allowed.length || policy.allowed.some(item => !item || typeof item.cli !== "string" || typeof item.model !== "string")) errors.push("CLI / 模型允许集为空或格式失效");
    if (!Array.isArray(policy.writeScope) || !policy.writeScope.length || policy.writeScope.some(p => p !== "DEMO-WORKSPACE/**")) errors.push("写入范围必须限定在 DEMO 样例工作区");
    return errors;
  }

  function executorError(state, requirement, policy) {
    if(requirement.executionPlan){const check=globalThis.TaskExecutionPlanModel?.revalidate(requirement.executionPlan,globalThis.TaskExecutionCatalog?.snapshot()||{});return check?.ok?null:check?.reasons?.map(x=>x.message).join('；')||'原冻结计划缺少受管目录';}
    const chosen = requirement.executor, executor = state.config.executors[chosen.cli];
    if (!state.config.valid) return "执行配置失效";
    if (!policy.allowed.some(item => item.cli === chosen.cli && item.model === chosen.model)) return "CLI / 模型不在冻结允许集中";
    if (!executor || !executor.enabled || !executor.models.includes(chosen.model)) return "CLI 或模型配置已失效";
    if (requirement.capabilities.some(capability => !executor.permissions.includes(capability))) return "必要写入、验证或集成权限已失效";
    if (requirement.integration && !policy.localIntegration) return "需要本地集成验证，当前策略未允许";
    if (requirement.writePaths.some(path => !path.startsWith("DEMO-WORKSPACE/"))) return "写入路径超出样例授权范围";
    return null;
  }

  function scopeStories(state, scope) {
    if (!scope || (scope.projectId && scope.projectId !== state.projectId)) return [];
    const stories = state.requirements.filter(r => r.kind === "story");
    if (scope.type === "project") return stories;
    if (scope.type === "selection") return stories.filter(r => scope.ids.includes(r.id));
    const selected = requirementFor(state, scope.id);
    if (!selected || selected.kind !== scope.type) return [];
    const descendant = requirement => {
      let current = requirement;
      const seen = new Set();
      while (current && !seen.has(current.id)) { if (current.id === selected.id) return true; seen.add(current.id); current = requirementFor(state, current.parent); }
      return false;
    };
    return stories.filter(descendant);
  }

  function cyclePath(stories) {
    const byId = new Map(stories.map(r => [r.id, r])), visited = new Set(), stack = [];
    function visit(id) {
      const position = stack.indexOf(id);
      if (position >= 0) return stack.slice(position).concat(id);
      if (visited.has(id) || !byId.has(id)) return null;
      stack.push(id);
      for (const dep of byId.get(id).dependencies) { const cycle = visit(dep.storyId); if (cycle) return cycle; }
      stack.pop(); visited.add(id); return null;
    }
    for (const story of stories) { const cycle = visit(story.id); if (cycle) return cycle; }
    return null;
  }

  function artifactValid(state, dependency, frozenBaseline, boundTask) {
    const artifact = state.artifacts[dependency.requiredArtifact];
    if (!artifact || artifact.id !== dependency.requiredArtifact || artifact.storyId !== dependency.storyId || artifact.stale || artifact.verification !== "passed" || !["passed", "not_applicable"].includes(artifact.integration) || !sameBaseline(artifact.baseline, frozenBaseline)) return false;
    if (!["verified", "verified_integrated"].includes(dependency.verificationGate)) return false;
    if (dependency.verificationGate === "verified_integrated" && artifact.integration !== "passed") return false;
    if (boundTask && (boundTask.status !== "succeeded" || artifact.producerTaskId !== boundTask.id)) return false;
    return Boolean(artifact.revision);
  }

  function authorizedExternalTask(state, dependency) {
    const predecessor = requirementFor(state, dependency.storyId);
    if (!predecessor || !predecessor.confirmed || !predecessor.synchronized || !predecessor.designReady || predecessor.status === "cancelled") return null;
    const task = state.tasks.filter(item => item.storyId === predecessor.id && item.projectId === state.projectId).at(-1);
    if (!task || !batchFor(state, task.batchId) || !sameBaseline(task.baseline, baseline(predecessor)) || !workflowMatches(predecessor, task)) return null;
    if (!taskDone(task) || task.runtimePaused) return task;
    return task.status === "succeeded" && currentProduct(state, predecessor.id) ? task : null;
  }

  function preflight(state, scope = { type: "project" }, overrides = {}, executionRequests = {}) {
    const policy = Object.assign(clone(state.config.policy), clone(overrides));
    const errors = policyErrors(state, policy), requested = scopeStories(state, scope), excluded = [], eligible = [], plans=new Map(), requests=new Map();
    const registry=globalThis.TaskExecutionCatalog?.snapshot(),P=globalThis.TaskExecutionPlanModel;
    if (!requested.length) errors.push("当前项目范围没有可检查的 Story");
    for (const requirement of requested) {
      let reason = !requirement.confirmed ? "需求尚未确认" : !requirement.synchronized ? "需求 / 设计存在未同步草稿" : !requirement.designReady ? "缺少可执行设计" : requirement.status === "completed" ? "故事已完成" : requirement.status === "cancelled" ? "故事已取消" : requirement.status === "pending_acceptance" ? "相同基线已交付，等待验收" : null;
      if (!reason && requirement.dependencies.some(dep => !["verified", "verified_integrated"].includes(dep.verificationGate) || requirementFor(state, dep.storyId)?.artifactId !== dep.requiredArtifact)) reason = "前置产物契约缺失、不一致或验证门槛无效";
      if (!reason && state.tasks.some(t => t.storyId === requirement.id && !taskDone(t))) reason = "已有活动任务，拒绝重复写入（包含不同基线的未停止任务）";
      if(!reason&&!errors.length&&registry&&P){const q=executionRequests[requirement.id]||globalThis.TaskExecutionCatalog.requestFor(requirement);requests.set(requirement.id,q);const plan=P.resolve(q,registry);plans.set(requirement.id,plan);if(plan.status!=='ready')reason=plan.blockedReasons.map(x=>x.message).join('；');}
      else if (!reason && !errors.length) reason = executorError(state, requirement, policy);
      if (reason) excluded.push({ id: requirement.id, title: requirement.title, reason }); else eligible.push(requirement);
    }
    const cycle = cyclePath(eligible);
    if (cycle) errors.push(`循环依赖，拒绝派发：${cycle.join(" → ")}`);
    if (!cycle && !errors.length) {
      let changed;
      do {
        changed = false;
        for (let i = eligible.length - 1; i >= 0; i--) {
          const requirement = eligible[i];
          const missing = requirement.dependencies.find(dep => {
            if (eligible.some(r => r.id === dep.storyId)) return false;
            const predecessor = requirementFor(state, dep.storyId);
            return !predecessor || (!authorizedExternalTask(state, dep) && !artifactValid(state, dep, baseline(predecessor)));
          });
          if (missing) { eligible.splice(i, 1); excluded.push({ id: requirement.id, title: requirement.title, reason: `必要前置 ${missing.storyId} 不在合格冻结范围内，且没有可消费的已验证产物；不会扩大派发范围` }); changed = true; }
        }
      } while (changed);
    }
    const frozen = eligible.map(r => ({ id: r.id, title: r.title, baseline: baseline(r), ac: clone(r.ac), executor:plans.has(r.id)?{cli:plans.get(r.id).selectedExecutor.cliId,model:plans.get(r.id).model.remoteModelId}:clone(r.executor),originalExecutor:clone(r.executor),...(plans.has(r.id)?{executionPlan:clone(plans.get(r.id)),executionRequest:clone(requests.get(r.id))}:{}),resources: clone(r.resources), capabilities: clone(r.capabilities), writePaths: clone(r.writePaths), integration: r.integration, artifactId: r.artifactId, workflowVersion: r.workflowVersion || 1,
      dependencies: r.dependencies.map(dep => {
        const internal = eligible.some(item => item.id === dep.storyId);
        const external = internal ? null : authorizedExternalTask(state, dep);
        return { ...clone(dep), baseline: baseline(requirementFor(state, dep.storyId)), externalTaskId: external?.id || null,
          externalRevision: internal || external ? null : state.artifacts[dep.requiredArtifact]?.revision || null };
      }) }));
    const fingerprint = dispatchFingerprint(state.projectId,frozen,state.config.version,policy);
    return { ok: !errors.length && Boolean(frozen.length), scope: clone(scope), projectId: state.projectId, requested: requested.map(r => r.id), frozen, excluded, errors,
      executionCandidates:requested.filter(r=>plans.has(r.id)).map(r=>({...clone(r),executionRequest:clone(requests.get(r.id)),executionPlan:clone(plans.get(r.id))})),policy, policyVersion: state.config.version, fingerprint, idempotencyKey: `DEMO-DISPATCH-${state.nextBatch}:${fingerprint}`, endpoint: policy.autoAcceptance ? "显式客观自动验收演示（仅 DEMO）" : "待验收", source: "评审仿真" };
  }

  function dispatchFingerprint(projectId,frozen,policyVersion,policy){return JSON.stringify({projectId,frozen:frozen.map(x=>({...x,executionPlan:x.executionPlan?.hash,phasePlans:(x.phasePlans||[]).map(p=>p.hash)})),policyVersion,policy});}
  function dispatch(state, input = { type: "project" }) {
    const preview = input.frozen ? clone(input) : preflight(state, input);
    const existingBatchId = state.dispatchKeys[preview.idempotencyKey];
    if (existingBatchId) {
      const existingBatch = state.batches.find(batch => batch.id === existingBatchId);
      const replayFingerprint = dispatchFingerprint(preview.projectId,preview.frozen,preview.policyVersion,preview.policy);
      if (!existingBatch || existingBatch.fingerprint !== preview.fingerprint || replayFingerprint !== preview.fingerprint || JSON.stringify(existingBatch.scope) !== JSON.stringify(preview.scope) || JSON.stringify(existingBatch.excluded) !== JSON.stringify(preview.excluded)) {
        return { ok: false, state, preview, code: "IDEMPOTENCY_MISMATCH", error: "同一幂等键对应不同范围或执行请求，拒绝覆盖原批次", batchId: existingBatchId };
      }
      return { ok: true, state, preview, replayed: true, batchId: existingBatchId };
    }
    if (!preview.ok) return { ok: false, state, preview, error: preview.errors.join("；") || "没有合格需求可派发" };
    const checked = preflight(state, { type: "selection", ids: preview.frozen.map(r => r.id), projectId: preview.projectId }, preview.policy,Object.fromEntries(preview.frozen.map(x=>[x.id,x.executionRequest]).filter(x=>x[1])));
    if (!checked.ok || checked.fingerprint !== preview.fingerprint) return { ok: false, state, preview: checked, error: "冻结需求、前置或执行授权已变化，请重新预检；未启动任何任务" };
    for(const x of preview.frozen)if(x.executionPlan&&!x.executionPlan.frozen)return {ok:false,state,preview,error:'计划尚未明确授权冻结，不启动'};
    const next = clone(state), batchId = `DEMO-BATCH-${String(next.nextBatch++).padStart(3, "0")}`;
    const batch = { id: batchId, projectId: next.projectId, scope: preview.scope, status: "running", paused: false, createdAt: next.clock, endedAt: null,
      frozen: preview.frozen, excluded: preview.excluded, policy: preview.policy, policyVersion: preview.policyVersion, fingerprint: preview.fingerprint, taskIds: [], used: 0, report: null };
    next.batches.push(batch); next.dispatchKeys[preview.idempotencyKey] = batchId; next.paused = false;
    for (const frozen of preview.frozen) {
      const id = `DEMO-TASK-${String(next.nextTask++).padStart(3, "0")}`;
      const task = { id, batchId, projectId: next.projectId, storyId: frozen.id, title: frozen.title, status: "queued", resumeStatus: null, reason: "等待调度器预检前置与资源", baseline: frozen.baseline,
        frozen: clone(frozen), dependencies: clone(frozen.dependencies), resources: clone(frozen.resources), executor: clone(frozen.executor), capabilities: clone(frozen.capabilities), integrationRequired: frozen.integration,
        attempts: [], executionPlanRef:frozen.executionPlan?.id,steps: ["prepare", "run", "verify", "integrate", "deliver"].map(key => ({ key, status: key === "integrate" && !frozen.integration ? "not_applicable" : "pending" })),
        retries: 0, reworks: 0, runProgress: 0, integrationProgress: 0, nextEligibleAt: 0, nextAttemptReason: "initial", consumedArtifacts: [], logs: [],
        workspace: null, pendingArtifact: null, artifactRevision: null, verification: null, integration: null, failureType: null, storyOutcome: null, createdAt: next.clock, endedAt: null,
        round: 1, workflowVersion: frozen.workflowVersion || 1, comments: [], terminalHistory: [], reviewRecords: [], manualRetries: 0, reviewReworks: 0, userCancelled: false,
        usage: { inputTokens: null, outputTokens: null, actualCost: null, source: "未知：未调用真实 CLI，未取得 usage", demoUnits: 0 } };
      batch.taskIds.push(id); next.tasks.push(task); requirementFor(next, task.storyId).status = "ready"; requirementFor(next, task.storyId).latestTaskId = id; event(next, task, "冻结范围已获一次评审确认；任务入队，不再逐任务审批");
    }
    for (const task of next.tasks.filter(t => t.batchId === batchId)) {
      for (const dep of task.dependencies) dep.producerTaskId = next.tasks.find(t => t.batchId === batchId && t.storyId === dep.storyId)?.id || dep.externalTaskId || next.artifacts[dep.requiredArtifact]?.producerTaskId || null;
    }
    next.epoch = epoch(next.epoch);
    refreshBusiness(next); return { ok: true, state: next, batchId, preview };
  }

  function release(state, task) {
    for (const resource of Object.keys(state.locks)) if (state.locks[resource] === task.id) delete state.locks[resource];
    if (state.integrationOwner === task.id) state.integrationOwner = null;
  }

  function finishAttempt(state, task, status, reason) {
    const attempt = task.attempts.at(-1);
    if (attempt && attempt.endedAt === null) { attempt.status = status; attempt.endedAt = state.clock; attempt.outcome = reason; attempt.verification = clone(task.verification); attempt.integration = clone(task.integration); }
  }

  function terminate(state, task, status, reason, failureType = null) {
    if (taskDone(task)) return;
    event(state, task, reason, status === "cancelled" ? "notice" : "error");
    finishAttempt(state, task, status, reason); task.status = status; task.resumeStatus = null; task.reason = reason; task.failureType = failureType; task.endedAt = state.clock; task.pendingArtifact = null;
    release(state, task);
    const requirement = requirementFor(state, task.storyId);
    if (requirement && workflowMatches(requirement, task) && requirement.status !== "cancelled") { requirement.status = status === "cancelled" ? (requirement.confirmed && requirement.synchronized && requirement.designReady ? "ready" : "unconfirmed") : "blocked"; requirement.lastExecution = status; requirement.blockedReason = reason; }
    task.storyOutcome = requirement ? requirement.status : null;
  }

  function cascade(state) {
    let changed;
    do {
      changed = false;
      for (const task of state.tasks.filter(t => !taskDone(t))) {
        const bad = task.dependencies.find(dep => { const predecessor = taskFor(state, dep.producerTaskId); return predecessor && ["failed", "cancelled", "blocked"].includes(predecessor.status); });
        if (bad) { const predecessor = taskFor(state, bad.producerTaskId); terminate(state, task, "blocked", `前置 ${bad.storyId} ${predecessor.status}，缺少有效产物；独立任务可继续`, predecessor.status === "cancelled" ? "dependency_cancelled" : "dependency_failed"); changed = true; }
      }
    } while (changed);
  }

  function invalidate(state) {
    for (const task of state.tasks.filter(t => !taskDone(t))) {
      const requirement = requirementFor(state, task.storyId), batch = batchFor(state, task.batchId);
      const changed = !sameBaseline(baseline(requirement), task.baseline);
      const dependencyChanged = task.dependencies.some(dep => !sameBaseline(baseline(requirementFor(state, dep.storyId)), dep.baseline));
      const configFailure = executorError(state, {...task.frozen,executionPlan:task.activeExecutionPlan||task.frozen.executionPlan}, batch.policy);
      const consumedInvalid = task.attempts.length > 0 && task.dependencies.some(dep => { const a = state.artifacts[dep.requiredArtifact]; const c = task.consumedArtifacts.find(item => item.artifactId === dep.requiredArtifact); return c && (!a || a.stale || a.revision !== c.revision); });
      if (!changed && !dependencyChanged && !configFailure && consumedInvalid) { terminate(state, task, "blocked", "消费的前置产物修订已失效，先停止再等待新有效产物", "dependency_artifact_invalid"); continue; }
      if (changed || dependencyChanged || configFailure) terminate(state, task, "failed", changed || dependencyChanged ? "冻结需求或前置 requirement / design / AC 修订失效，停止受影响分支" : configFailure, changed || dependencyChanged ? "baseline_invalid" : "configuration_invalid");
    }
    cascade(state);
  }

  function aggregate(state) {
    refreshBusiness(state);
    for (const batch of state.batches) {
      const tasks = batch.taskIds.map(id => taskFor(state, id)), successes = tasks.filter(t => t.status === "succeeded").length;
      batch.paused = tasks.some(t => t.status === "paused");
      if (tasks.some(t => !taskDone(t))) batch.status = "running";
      else if (successes === tasks.length) batch.status = "succeeded";
      else if (successes) batch.status = "partial";
      else if (tasks.every(t => t.status === "cancelled" || (t.status === "blocked" && t.failureType === "dependency_cancelled"))) batch.status = "cancelled";
      else batch.status = "failed";
      if (batch.status !== "running") {
        if (batch.endedAt === null) batch.endedAt = state.clock;
        if (!batch.report) batch.report = { status: batch.status, succeeded: successes, failed: tasks.filter(t => t.status === "failed").length, blocked: tasks.filter(t => t.status === "blocked").length,
          cancelled: tasks.filter(t => t.status === "cancelled").length, artifactRevisions: tasks.filter(t => t.artifactRevision).map(t => t.artifactRevision),
          pendingAcceptance: tasks.filter(t => t.status === "succeeded" && requirementFor(state, t.storyId).status === "pending_acceptance").length,
          simulatedAutoAcceptance: tasks.filter(t => t.status === "succeeded" && requirementFor(state, t.storyId).acceptance === "simulated_automatic").length,
          demoUnits: batch.used, actualUsage: "未知；未调用真实 CLI", endpoint: batch.policy.autoAcceptance ? "DEMO 客观自动验收演示" : "待验收", source: "评审仿真" };
      }
    }
    refreshReports(state);
    for (const rule of state.wakeups || []) if (["completed", "cancelled"].includes(requirementFor(state, rule.storyId)?.status)) { rule.enabled = false; rule.endedReason = "需求已完成或取消，规则停用"; }
    return state;
  }

  function charge(state, task, units) {
    const batch = batchFor(state, task.batchId);
    const plan=task.activeExecutionPlan||task.frozen.executionPlan;if(plan&&task.usage.demoUnits+units>plan.budget){terminate(state,task,'failed','原冻结任务预算耗尽，不自动清零','budget_exhausted');return false;}
    if (batch.used + units > batch.policy.budget) {
      for (const unfinished of state.tasks.filter(t => t.batchId === batch.id && !taskDone(t))) terminate(state, unfinished, "failed", `批次仿真预算 ${batch.policy.budget} 单位已触达止损线；未产生实际账单`, "budget_exhausted");
      return false;
    }
    batch.used += units; task.usage.demoUnits += units; return true;
  }

  function step(task, key, status) { task.steps.find(item => item.key === key).status = status; }

  function startAttempt(state, task) {
    task.status = "preparing"; task.resumeStatus = null; task.reason = "准备独立样例工作区"; task.runProgress = 0; task.integrationProgress = 0;
    task.verification = null; task.integration = null; task.pendingArtifact = null;
    for (const item of task.steps) item.status = item.key === "integrate" && !task.integrationRequired ? "not_applicable" : "pending";
    step(task, "prepare", "running");
    task.workspace = { path: `DEMO-WORKSPACE/${task.storyId}`, branch: `DEMO-BRANCH/${task.id}`, baseSha: state.codeHead, source: "样例 SHA 与工作区；未创建真实分支或目录" };
    task.attempts.push({ number: task.attempts.length + 1, round: task.round || 1, sourceRunId: task.id, sourceAttempt: task.attempts.length || null, planRef:(task.activeExecutionPlan||task.frozen.executionPlan)?.id,planHash:(task.activeExecutionPlan||task.frozen.executionPlan)?.hash,phasePlanRefs:(task.frozen.phasePlans||[]).map(p=>p.id),contextMode: task.fresh ? "fresh" : "continue", reason: task.nextAttemptReason, status: "preparing", startedAt: state.clock, endedAt: null, exitCode: null, verification: null, integration: null, logs: [], source: "评审仿真；上下文选择不是实际CLI续接" });
    for (const resource of task.resources) state.locks[resource] = task.id;
    event(state, task, `开始仿真 attempt ${task.attempts.length}；已领取并发槽与声明资源`);
  }

  function retry(state, task, kind, reason) {
    const batch = batchFor(state, task.batchId), allowed = kind === "retry" ? task.retries < batch.policy.maxRetries : task.reworks < batch.policy.maxRework;
    event(state, task, reason, "error");
    finishAttempt(state, task, "failed", reason); release(state, task); task.pendingArtifact = null;
    if (!allowed) { terminate(state, task, "failed", `${reason}；${kind === "retry" ? "自动重试" : "返工"}上限已用尽`, kind === "retry" ? "retry_exhausted" : "rework_exhausted"); return; }
    if (kind === "retry") task.retries++; else task.reworks++;
    task.status = "retry_wait"; task.reason = `${reason}；有限${kind === "retry" ? "重试" : "返工"}等待`; task.nextEligibleAt = state.clock + batch.policy.retryDelay; task.nextAttemptReason = kind;
  }

  function succeed(state, task) {
    const revision = task.pendingArtifact.revision;
    state.artifacts[task.frozen.artifactId] = { id: task.frozen.artifactId, revision, producerTaskId: task.id, storyId: task.storyId, baseline: clone(task.baseline), verification: "passed",
      integration: task.integrationRequired ? "passed" : "not_applicable", integratedHead: state.codeHead, stale: false, content: task.pendingArtifact.content, recordedAt: state.clock, source: "样例产物；未写实际文件" };
    state.artifactHistory[revision] = clone(state.artifacts[task.frozen.artifactId]);
    task.artifactRevision = revision; step(task, "deliver", "passed"); event(state, task, `目标产物 ${revision} 已记录，验证 / 适用集成通过后才可被下游消费`);
    finishAttempt(state, task, "succeeded", "仿真产物交付通过"); task.status = "succeeded"; task.reason = "技术交付成功，默认等待需求验收"; task.endedAt = state.clock; task.pendingArtifact = null; release(state, task);
    const requirement = requirementFor(state, task.storyId), batch = batchFor(state, task.batchId);
    const objectivePass = task.verification?.status === "passed" && task.verification.checks.every(check => check.result === "passed") && (!task.integrationRequired || task.integration?.status === "passed");
    requirement.status = batch.policy.autoAcceptance && objectivePass ? "completed" : "pending_acceptance";
    requirement.acceptance = requirement.status === "completed" ? "simulated_automatic" : "pending";
    task.storyOutcome = requirement.status; task.review = { decision: "approve", actor: "DEMO-verifier", tick: state.clock, source: "模拟自动技术评审" };
    recoverDependents(state, task);
    if (requirement.status === "completed") event(state, task, "显式 DEMO 自动验收规则满足；仅演示完成，不代表用户实际验收");
  }

  function progressTask(state, task) {
    const fault = state.faults[task.storyId] || {}, attempt = task.attempts.at(-1);
    if (!runtimeOnline(state, task)) { task.reason = "Runtime离线，保留当前attempt与资源，恢复在线后继续"; return; }
    if (task.status === "preparing") {
      step(task, "prepare", "passed"); step(task, "run", "running"); task.status = "running"; task.reason = "CLI 仿真执行中"; attempt.status = "running";
      event(state, task, "CLI / 模型 / 权限检查通过；仿真执行，不运行真实命令");
    } else if (task.status === "running") {
      if (fault.cancelAtRunning) { fault.cancelAtRunning = false; terminate(state, task, "cancelled", "评审事件：取消前置任务，保留仿真历史", "dependency_cancelled"); return; }
      if (!charge(state, task, 1)) return;
      if (++task.runProgress < 2) return;
      if (fault.permanentFailure) { attempt.exitCode = 1; step(task, "run", "failed"); terminate(state, task, "failed", "评审永久故障：前置执行失败，不自动切换引擎", "permanent_failure"); return; }
      if (fault.networkRemaining > 0) { fault.networkRemaining--; attempt.exitCode = 75; step(task, "run", "failed"); retry(state, task, "retry", "评审暂时网络故障（没有实际网络请求）"); return; }
      attempt.exitCode = 0; step(task, "run", "passed"); step(task, "verify", "running"); task.status = "verifying"; attempt.status = "verifying";
      task.reason = "模拟 exit 0；等待产物、AC 与差异审查验证";
      task.pendingArtifact = { revision: `DEMO-REV-${task.id.slice(-3)}-A${attempt.number}`, content: `// ${task.storyId} · ${task.title}\n// 仅评审样例，不是生成到磁盘的真实代码。\nexport const reviewEvidence = { verified: true, story: "${task.storyId}" };` };
      event(state, task, "模拟 CLI exit 0，仅转 verifying；尚无可消费产物 revision");
    } else if (task.status === "verifying") {
      if (!charge(state, task, 2)) return;
      const failed = fault.verifyRemaining > 0;
      if (failed) fault.verifyRemaining--;
      task.verification = { status: failed ? "failed" : "passed", revision: task.pendingArtifact.revision, checks: task.frozen.ac.concat(["目标产物存在", "最终差异审查"]).map((id, index) => ({ id, result: failed && index === 0 ? "failed" : "passed", source: "仿真规则判定；未运行真实测试" })) };
      step(task, "verify", failed ? "failed" : "passed");
      if (failed) { retry(state, task, "rework", "评审 AC 验证失败，保留失败证据且不降低 AC"); return; }
      if (task.integrationRequired) { task.status = "integrating"; attempt.status = "integrating"; task.reason = "技术验证通过，等待串行集成与集成验证"; step(task, "integrate", "running"); event(state, task, "验证通过，进入本地集成仿真队列；尚未交付产物"); }
      else { task.integration = { status: "not_applicable", source: "审计 / 文档产物无代码集成" }; succeed(state, task); }
    } else if (task.status === "integrating") {
      if (state.integrationOwner && state.integrationOwner !== task.id) { task.reason = `等待串行集成槽（${state.integrationOwner}）`; return; }
      if (!state.integrationOwner) { state.integrationOwner = task.id; task.integrationProgress = 1; task.reason = "执行样例集成验证"; event(state, task, "领取串行集成槽；重新验证样例代码基线"); return; }
      if (!charge(state, task, 1)) return;
      if (fault.integrationRemaining > 0) { fault.integrationRemaining--; task.integration = { status: "failed", source: "仿真集成冲突" }; step(task, "integrate", "failed"); retry(state, task, "rework", "评审集成验证失败"); return; }
      state.codeHead = `DEMO-HEAD-${String(++state.headRevision).padStart(3, "0")}`;
      task.integration = { status: "passed", head: state.codeHead, source: "样例集成与 SHA；未运行 Git" }; step(task, "integrate", "passed"); succeed(state, task);
    }
  }

  function scheduleTask(state, task) {
    if (!["queued", "waiting_dependency", "waiting_resource", "retry_wait"].includes(task.status)) return;
    if (task.status === "retry_wait" && state.clock < task.nextEligibleAt) return;
    const unavailable = task.dependencies.find(dep => {
      const bound = taskFor(state, dep.producerTaskId), artifact = state.artifacts[dep.requiredArtifact];
      return !artifactValid(state, dep, dep.baseline, bound) || (dep.externalRevision && artifact.revision !== dep.externalRevision);
    });
    if (unavailable) { task.status = "waiting_dependency"; task.reason = `等待 ${unavailable.storyId} 的 ${unavailable.requiredArtifact}：需要验证 / 集成通过并记录可消费 revision`; return; }
    const locked = task.resources.find(resource => state.locks[resource] && state.locks[resource] !== task.id);
    const batch = batchFor(state, task.batchId), active = state.tasks.filter(taskActive);
    if (!runtimeOnline(state, task)) { task.status = "waiting_resource"; task.reason = `Runtime ${task.executor.cli} 离线，恢复配置后自动领取`; return; }
    if (locked || active.length >= state.config.policy.maxConcurrent || active.filter(t => t.batchId === batch.id).length >= batch.policy.maxConcurrent) {
      task.status = "waiting_resource"; task.reason = locked ? `资源 ${locked} 被 ${state.locks[locked]} 持有，自动串行等待` : "等待可用并发槽（全局与冻结批次上限同时校验）"; return;
    }
    task.consumedArtifacts = task.dependencies.map(dep => ({ storyId: dep.storyId, artifactId: dep.requiredArtifact, revision: state.artifacts[dep.requiredArtifact].revision, integratedHead: state.artifacts[dep.requiredArtifact].integratedHead, consumedAt: state.clock, source: "仿真产物消费" }));
    for (const consumed of task.consumedArtifacts) event(state, task, `已消费前置 ${consumed.storyId} 的 ${consumed.revision}，才允许启动`);
    startAttempt(state, task);
  }

  function mutateInjection(state, injection) {
    const requirement = injection.storyId && requirementFor(state, injection.storyId);
    if (["requirement-change", "design-change"].includes(injection.type) && requirement) {
      if (injection.type === "requirement-change") requirement.requirementHash += "-changed"; else requirement.designHash += "-changed";
      requirement.revision = (requirement.revision || 1) + 1; requirement.workflowVersion = (requirement.workflowVersion || 1) + 1;
      invalidateArtifactTree(state, requirement.id);
      requirement.status = injection.type === "design-change" ? "unsynced" : "unconfirmed"; requirement.confirmed = injection.type === "design-change" ? requirement.confirmed : false; requirement.synchronized = injection.type === "design-change" ? false : requirement.synchronized; requirement.acceptance = "none";
    }
    else if (injection.type === "model-disabled") { const executor = state.config.executors[injection.cli || "codex"]; if (executor) executor.models = executor.models.filter(model => model !== (injection.model || "DEMO-CODER")); }
    else if (injection.type === "permission-disabled") { const executor = state.config.executors[injection.cli || "codex"]; if (executor) executor.permissions = executor.permissions.filter(permission => permission !== (injection.permission || "demo.write")); }
    else if (injection.type === "code-head") { state.codeHead = `DEMO-HEAD-${String(++state.headRevision).padStart(3, "0")}`; }
    else if (injection.type === "network-failure" && requirement) { state.faults[requirement.id] = { ...state.faults[requirement.id], networkRemaining: injection.count || 1 }; }
    else if (injection.type === "verification-failure" && requirement) { state.faults[requirement.id] = { ...state.faults[requirement.id], verifyRemaining: injection.count || 1 }; }
    else if (injection.type === "cancel-parent" && requirement) { const task = state.tasks.find(t => t.storyId === requirement.id && !taskDone(t)); if (task) terminate(state, task, "cancelled", "评审事件：前置任务已取消", "dependency_cancelled"); }
    event(state, null, `评审事件 ${injection.type}；没有实际外部操作`, "notice");
  }

  function tick(state, expectedEpoch = state.epoch) {
    if (expectedEpoch !== state.epoch || state.paused || (!state.tasks.some(t => !taskDone(t) && t.status !== "paused") && !(state.wakeups || []).some(r => r.enabled))) return state;
    const next = clone(state); next.clock++;
    if (next.scheduledInjection && next.clock >= next.scheduledInjection.at) { mutateInjection(next, next.scheduledInjection); next.scheduledInjection = null; }
    invalidate(next);
    const activeIds = next.tasks.filter(t => ACTIVE.has(t.status)).map(t => t.id);
    for (const id of activeIds) { const task = taskFor(next, id); if (!taskDone(task)) progressTask(next, task); }
    cascade(next);
    for (const task of next.tasks) scheduleTask(next, task);
    evaluateWakeups(next);
    return aggregate(next);
  }

  function selectedTasks(state, target) {
    if (!target || target === "all") return state.tasks;
    return state.tasks.filter(t => t.id === target || t.batchId === target || t.storyId === target);
  }

  function pause(state, target = "all") {
    const next = clone(state); next.epoch = epoch(next.epoch);
    for (const task of selectedTasks(next, target).filter(t => !taskDone(t) && t.status !== "paused")) { task.resumeStatus = task.status; task.status = "paused"; event(next, task, "仿真暂停；冻结当前步骤并保留资源归属"); }
    if (target === "all") next.paused = true;
    return aggregate(next);
  }

  function resume(state, target = "all") {
    const next = clone(state); next.epoch = epoch(next.epoch); next.paused = false;
    for (const task of selectedTasks(next, target).filter(t => t.status === "paused")) { task.status = task.resumeStatus || "queued"; task.resumeStatus = null; event(next, task, "继续仿真；重新使用当前代际回调"); }
    invalidate(next); return aggregate(next);
  }

  function cancel(state, target = "all") {
    const next = clone(state); next.epoch = epoch(next.epoch);
    for (const task of selectedTasks(next, target).filter(t => !taskDone(t))) { task.userCancelled = true; terminate(next, task, "cancelled", "评审控制：取消任务，旧回调失效且历史保留", "dependency_cancelled"); }
    cascade(next); return aggregate(next);
  }

  function inject(state, injection) {
    const next = clone(state); next.epoch = epoch(next.epoch); mutateInjection(next, clone(injection)); invalidate(next); return aggregate(next);
  }

  function snapshot(state) { return { version: 1, source: "仅本机评审快照，不是 daemon", state: clone(state) }; }

  function invariantErrors(state) {
    const errors = [];
    if (state.tasks.some(t => !TASK_STATES.includes(t.status))) errors.push("存在非法任务状态");
    if (state.batches.some(b => !BATCH_STATES.includes(b.status))) errors.push("存在非法批次状态");
    const active = state.tasks.filter(taskActive);
    if (active.length > state.config.policy.maxConcurrent) errors.push("超过全局并发上限");
    for (const batch of state.batches) if (active.filter(t => t.batchId === batch.id).length > batch.policy.maxConcurrent) errors.push("超过冻结批次并发上限");
    for (const [resource, owner] of Object.entries(state.locks)) if (!taskFor(state, owner) || !taskActive(taskFor(state, owner)) || !taskFor(state, owner).resources.includes(resource)) errors.push(`无效资源锁 ${resource}`);
    for (const task of active) for (const resource of task.resources) if (state.locks[resource] !== task.id) errors.push(`资源 ${resource} 互斥失效`);
    if (state.integrationOwner && taskFor(state, state.integrationOwner)?.status !== "integrating" && !(taskFor(state, state.integrationOwner)?.status === "paused" && taskFor(state, state.integrationOwner).resumeStatus === "integrating")) errors.push("串行集成归属失效");
    for (const task of state.tasks.filter(t => t.status === "succeeded")) if (!task.artifactRevision || task.verification?.status !== "passed" || (task.integrationRequired && task.integration?.status !== "passed")) errors.push("成功任务缺少有效验证 / 集成 / 产物");
    for (const task of state.tasks.filter(t => t.status === "succeeded")) {
      const recorded = state.artifactHistory?.[task.artifactRevision];
      if (!recorded || recorded.producerTaskId !== task.id || !sameBaseline(recorded.baseline, task.baseline) || recorded.verification !== "passed" || (task.integrationRequired && recorded.integration !== "passed")) errors.push("成功任务缺少已记录的对应产物历史");
    }
    return errors;
  }

  function restore(saved) {
    if (!saved || saved.version !== 1 || !saved.state || saved.state.version !== 1 || saved.state.projectId !== "DEMO-PROJECT-01") throw new Error("不是受支持的 CR-016 评审快照");
    const state = clone(saved.state);
    ensureClosedLoop(state);
    // 兼容本评审稿较早的 v1 快照；仅从已有已记录产物迁移，不伪造丢失证据。
    if (!state.artifactHistory && state.artifacts) state.artifactHistory = Object.fromEntries(Object.values(state.artifacts).map(artifact => [artifact.revision, clone(artifact)]));
    if (!Array.isArray(state.tasks) || !Array.isArray(state.requirements) || !Array.isArray(state.batches) || !Array.isArray(state.events) || !state.config || !state.artifacts || !state.locks || !state.dispatchKeys || !state.faults) throw new Error("评审快照结构不完整");
    if (policyErrors(state, state.config.policy).some(error => !error.includes("配置已失效"))) throw new Error("评审快照策略无效");
    if (state.batches.some(batch => !batch || !batch.policy || policyErrors(state, batch.policy).some(error => !error.includes("配置已失效")))) throw new Error("评审快照批次策略无效");
    if (["epoch", "nextBatch", "nextTask", "nextEvent"].some(key => !Number.isInteger(state[key]) || state[key] < 1) || !Number.isInteger(state.clock) || state.clock < 0) throw new Error("评审快照时钟或代际无效");
    if (new Set(state.tasks.map(t => t.id)).size !== state.tasks.length || state.tasks.some(t => !t.id.startsWith("DEMO-TASK-") || !requirementFor(state, t.storyId) || !batchFor(state, t.batchId) || !Array.isArray(t.dependencies) || !Array.isArray(t.resources) || !Array.isArray(t.attempts))) throw new Error("评审快照任务关系无效");
    if (state.wakeups.some(rule => !rule || !requirementFor(state, rule.storyId) || !["comment", "anotherStory", "children", "demoCI", "clock"].includes(rule.kind) || typeof rule.enabled !== "boolean" || !Number.isInteger(rule.maxFires) || rule.maxFires < 1 || rule.maxFires > 5 || !Number.isInteger(rule.fireCount) || rule.fireCount < 0 || rule.fireCount > rule.maxFires || !Array.isArray(rule.triggerHistory) || !Number.isInteger(rule.expiresAt))) throw new Error("评审快照唤醒规则无效");
    const errors = invariantErrors(state); if (errors.length) throw new Error(`评审快照无效：${errors.join("；")}`);
    state.epoch = epoch(state.epoch); invalidate(state); return aggregate(state);
  }

  // CR-017：需求仍是唯一DEMO业务源；下面的操作只返回新的评审状态。
  function ensureClosedLoop(state) {
    state.wakeups ||= []; state.nextWakeup ||= 1; state.nextComment ||= 1; state.requestKeys ||= {}; state.demoCI ||= {};
    state.nextRequirementIds ||= { story: 13, feature: 4, epic: 3 };
    for (const r of state.requirements || []) { r.revision ||= 1; r.workflowVersion ||= 1; r.comments ||= []; r.acceptanceHistory ||= []; }
    for (const t of state.tasks || []) { t.round ||= 1; t.workflowVersion ||= t.frozen?.workflowVersion || 1; t.comments ||= []; t.terminalHistory ||= []; t.reviewRecords ||= []; t.manualRetries ||= 0; t.reviewReworks ||= 0; }
    for (const b of state.batches || []) b.reportHistory ||= [];
  }
  const failure = (state, error, code) => ({ ok: false, state, error, ...(code ? { code } : {}) });
  const workflowMatches = (r, t) => Boolean(r && t && (r.workflowVersion || 1) === (t.workflowVersion || 1) && sameBaseline(baseline(r), t.baseline));
  const latestTask = (state, id) => state.tasks.filter(t => t.storyId === id).at(-1);
  const runtimeOnline = (state, task) => state.config.online !== false && state.config.executors[task.executor.cli]?.online !== false;
  const labels = { unconfirmed: "待确认", unsynced: "待同步", ready: "已就绪", executing: "开发中", verifying: "验证中", blocked: "阻塞", pending_acceptance: "待验收", completed: "已完成", cancelled: "取消" };
  function refreshBusiness(state) {
    ensureClosedLoop(state);
    for (const r of state.requirements.filter(x => x.kind === "story")) {
      const t = latestTask(state, r.id); if (!workflowMatches(r, t) || r.status === "cancelled") continue;
      if (["queued", "waiting_dependency", "waiting_resource"].includes(t.status)) r.status = "ready";
      else if (ACTIVE.has(t.status)) r.status = !runtimeOnline(state, t) ? "blocked" : ["verifying", "integrating"].includes(t.status) ? "verifying" : "executing";
      else if (t.status === "paused") r.status = ["verifying", "integrating"].includes(t.resumeStatus) ? "verifying" : ACTIVE.has(t.resumeStatus) ? "executing" : "ready";
      else if (["failed", "blocked", "retry_wait"].includes(t.status)) r.status = "blocked";
      else if (t.status === "cancelled") r.status = r.confirmed && r.designReady && r.synchronized ? "ready" : "unconfirmed";
      else if (t.status === "succeeded") r.status = state.artifacts[r.artifactId]?.stale ? "blocked" : ["simulated_manual", "simulated_automatic"].includes(r.acceptance) ? "completed" : "pending_acceptance";
      r.blockedReason = r.status === "blocked" ? t.reason : ""; r.latestTaskId = t.id; r.runStatus = t.status;
      r.workflowStage = r.status === "completed" ? "done" : r.status === "pending_acceptance" ? "acceptance" : r.status === "verifying" ? "verification" : "development";
    }
  }
  function requirementSummary(state, id) {
    const r = requirementFor(state, id); if (!r) return { status: "missing", label: "需求不存在", runStatus: null, latestTaskId: null, counts: { total: 0, completed: 0, cancelled: 0, pending: 0, blocked: 0 }, acceptance: "none" };
    const leaves = r.kind === "story" ? [r] : scopeStories(state, { type: r.kind, id });
    const counts = { total: leaves.length, completed: leaves.filter(x => x.status === "completed").length, cancelled: leaves.filter(x => x.status === "cancelled").length, pending: leaves.filter(x => !["completed", "cancelled"].includes(x.status)).length, blocked: leaves.filter(x => x.status === "blocked").length };
    let status = r.status || "ready";
    if (r.kind !== "story") status = counts.total && counts.completed === counts.total ? "completed" : counts.total && counts.cancelled === counts.total ? "cancelled" : ["blocked", "verifying", "executing", "pending_acceptance", "unsynced", "unconfirmed"].find(key => leaves.some(x => x.status === key)) || (counts.completed > 0 ? "in_progress" : "ready");
    const t = r.kind === "story" ? latestTask(state, id) : state.tasks.filter(x => leaves.some(leaf => leaf.id === x.storyId)).at(-1);
    return { status, label: status === "in_progress" ? "进行中" : labels[status] || status, runStatus: t?.status || null, latestTaskId: t?.id || null, counts, acceptance: r.kind === "story" ? r.acceptance || "none" : status === "completed" ? "derived" : "pending", runStale: Boolean(t && !workflowMatches(requirementFor(state, t.storyId), t)), source: "同一DEMO需求源；验收仅模拟" };
  }
  function refreshReports(state) {
    for (const b of state.batches) {
      b.reportHistory ||= [];
      if (b.status === "running") { if (b.report) { b.reportHistory.push({ ...clone(b.report), historical: true }); b.report = null; b.endedAt = null; } continue; }
      const tasks = b.taskIds.map(id => taskFor(state, id)), signature = JSON.stringify(tasks.map(t => [t.id, t.round || 1, t.status, t.artifactRevision, workflowMatches(requirementFor(state, t.storyId), t) ? requirementFor(state, t.storyId).status : t.storyOutcome]));
      b.reportIsHistorical = tasks.some(t => !workflowMatches(requirementFor(state, t.storyId), t));
      if (!b.report || b.report.signature !== signature) {
        if (b.report?.signature) b.reportHistory.push({ ...clone(b.report), historical: true });
        const old = b.report || {}; b.reportRevision = (b.reportRevision || 0) + 1;
        b.report = { ...old, status: b.status, succeeded: tasks.filter(t => t.status === "succeeded").length, failed: tasks.filter(t => t.status === "failed").length, blocked: tasks.filter(t => t.status === "blocked").length, cancelled: tasks.filter(t => t.status === "cancelled").length,
          artifactRevisions: tasks.filter(t => t.artifactRevision).map(t => t.artifactRevision), pendingAcceptance: tasks.filter(t => t.status === "succeeded" && (workflowMatches(requirementFor(state, t.storyId), t) ? requirementFor(state, t.storyId).status : t.storyOutcome) === "pending_acceptance").length,
          simulatedAutoAcceptance: tasks.filter(t => t.status === "succeeded" && requirementFor(state, t.storyId).acceptance === "simulated_automatic").length, demoUnits: b.used, actualUsage: "未知；未调用真实CLI", endpoint: b.policy.autoAcceptance ? "DEMO客观自动验收" : "待验收", source: "评审仿真", signature, revision: b.reportRevision, rounds: tasks.map(t => ({ taskId: t.id, round: t.round || 1 })) };
      }
    }
  }
  function invalidateArtifactTree(state, id) {
    const queue = [id], seen = new Set();
    while (queue.length) { const current = queue.shift(); if (seen.has(current)) continue; seen.add(current);
      const r = requirementFor(state, current); if (r && state.artifacts[r.artifactId]) state.artifacts[r.artifactId].stale = true;
      if (r) { r.acceptance = "none"; if (current !== id && ["completed", "pending_acceptance"].includes(r.status)) { r.status = "blocked"; r.blockedReason = "消费前置产物失效，旧证据只保留历史"; } }
      queue.push(...state.requirements.filter(item => item.dependencies?.some(dep => dep.storyId === current)).map(item => item.id));
    }
  }
  function currentProduct(state, storyId, visited = new Set()) {
    if (visited.has(storyId)) return null; const seen = new Set(visited); seen.add(storyId);
    const r = requirementFor(state, storyId), t = latestTask(state, storyId); if (!workflowMatches(r, t) || t.status !== "succeeded") return null;
    const a = state.artifacts[r.artifactId];
    if (!a || a.stale || a.revision !== t.artifactRevision || a.producerTaskId !== t.id || !artifactValid(state, { requiredArtifact: r.artifactId, storyId, verificationGate: t.integrationRequired ? "verified_integrated" : "verified" }, baseline(r), t) || t.verification?.checks.some(c => c.result !== "passed")) return null;
    for (const dep of t.dependencies) if (!artifactValid(state, dep, dep.baseline, taskFor(state, dep.producerTaskId)) || !t.consumedArtifacts.some(c => c.artifactId === dep.requiredArtifact && c.revision === state.artifacts[dep.requiredArtifact]?.revision) || !currentProduct(state, dep.storyId, seen)) return null;
    return { requirement: r, task: t, artifact: a };
  }
  function archiveRound(state, task, reason) {
    const b = batchFor(state, task.batchId); b.reportHistory ||= [];
    if (b.report) { b.reportHistory.push({ ...clone(b.report), historical: true }); b.report = null; }
    task.terminalHistory ||= []; task.terminalHistory.push({ round: task.round || 1, status: task.status, endedAt: task.endedAt, artifactRevision: task.artifactRevision, verification: clone(task.verification), integration: clone(task.integration), reason: task.reason, source: "历史仿真运行" });
    invalidateArtifactTree(state, task.storyId);
    task.round = (task.round || 1) + 1; task.status = "queued"; task.resumeStatus = null; task.endedAt = null; task.pendingArtifact = null; task.artifactRevision = null; task.verification = null; task.integration = null; task.failureType = null; task.runProgress = 0; task.integrationProgress = 0; task.nextEligibleAt = state.clock; task.nextAttemptReason = reason; task.userCancelled = false;
    task.reason = `${reason}；原CLI/模型、预算与历史保留，等待重新领取`; release(state, task); b.status = "running"; b.endedAt = null;
    const r = requirementFor(state, task.storyId); r.status = "ready"; r.acceptance = "none"; task.storyOutcome = "ready"; event(state, task, task.reason, "notice");
  }
  function recoverDependents(state) {
    let changed;
    do { changed = false;
      for (const t of state.tasks.filter(t => !t.userCancelled && ((t.status === "blocked" && /^dependency_/.test(t.failureType || "")) || (t.status === "succeeded" && state.artifacts[t.frozen.artifactId]?.stale)))) {
        const r = requirementFor(state, t.storyId), b = batchFor(state, t.batchId);
        if (!workflowMatches(r, t) || executorError(state, {...t.frozen,executionPlan:t.activeExecutionPlan||t.frozen.executionPlan}, b.policy) || b.used >= b.policy.budget || t.dependencies.some(d => !artifactValid(state, d, d.baseline, taskFor(state, d.producerTaskId)))) continue;
        if (t.attempts.length && (t.dependencyRefreshes || 0) >= (b.policy.maxReviewRounds ?? 2)) continue;
        if (t.attempts.length) t.dependencyRefreshes = (t.dependencyRefreshes || 0) + 1;
        archiveRound(state, t, "前置新有效产物已可消费，安全恢复依赖阻塞任务"); changed = true;
      }
    } while (changed);
  }
  function selectionError(state, r, chosen) {
    if (!chosen || !["codex", "claude", "grok"].includes(chosen.cli) || typeof chosen.model !== "string") return "请选择明确的DEMO CLI和模型";
    return executorError(state, { ...r, executor: chosen }, state.config.policy);
  }
  function saveRequirement(state, id, patch = {}) {
    const original = requirementFor(state, id); if (!original || !patch || typeof patch !== "object") return failure(state, "需求或patch不存在");
    const allowed = new Set(["title", "description", "goal", "ac", "confirmed", "synchronized", "designReady", "executor", "status", "reason", "dependencies", "resources", "integration", "capabilities", "writePaths", "stage"]);
    if (Object.keys(patch).some(k => !allowed.has(k))) return failure(state, "patch含未授权字段");
    for (const key of ["confirmed", "synchronized", "designReady", "integration"]) if (patch[key] !== undefined && typeof patch[key] !== "boolean") return failure(state, `${key}必须是布尔值`);
    for (const key of ["description", "goal", "reason"]) if (patch[key] !== undefined && typeof patch[key] !== "string") return failure(state, `${key}必须是文本`);
    for (const key of ["resources", "capabilities", "writePaths"]) if (patch[key] !== undefined && (!Array.isArray(patch[key]) || patch[key].some(x => typeof x !== "string" || !x.trim()))) return failure(state, `${key}必须是有效文本数组`);
    if (patch.dependencies !== undefined && (!Array.isArray(patch.dependencies) || patch.dependencies.some(d => !d || typeof d !== "object" || d.storyId === id || requirementFor(state, d.storyId)?.kind !== "story" || !["verified", "verified_integrated"].includes(d.verificationGate) || d.requiredArtifact !== requirementFor(state, d.storyId).artifactId))) return failure(state, "依赖必须引用有效Story产物且不能自依赖");
    if (patch.title !== undefined && (typeof patch.title !== "string" || !patch.title.trim())) return failure(state, "需求标题必填");
    if (patch.ac !== undefined && (!Array.isArray(patch.ac) || patch.ac.some(x => typeof x !== "string" || !x.trim()))) return failure(state, "AC必须是非空文本数组");
    if (patch.status === "completed") return failure(state, "完成只能经最新有效产物模拟验收");
    if (patch.status && !Object.hasOwn(labels, patch.status)) return failure(state, "非法业务状态");
    if (patch.executor && selectionError(state, original, patch.executor)) return failure(state, selectionError(state, original, patch.executor));
    const next = clone(state); ensureClosedLoop(next); const r = requirementFor(next, id), fields = Object.keys(patch).filter(k => !["reason", "executor"].includes(k)), changed = fields.some(k => JSON.stringify(r[k]) !== JSON.stringify(patch[k]));
    for (const key of fields) r[key] = clone(patch[key]); if (patch.executor) r.executor = clone(patch.executor);
    if (r.kind === "story") {
      if (r.confirmed && (!r.ac?.length || !r.title?.trim())) return failure(state, "确认前必须有标题和AC");
      if (patch.status === "ready" && (!r.confirmed || !r.synchronized || !r.designReady)) return failure(state, "就绪需要确认、同步设计与AC");
      if (changed) { r.revision++; r.workflowVersion++; r.requirementHash = `DEMO-REQ-${r.id}-r${r.revision}`; if (patch.ac) r.acHash = `DEMO-AC-${r.id}-r${r.revision}`; if (patch.designReady !== undefined || patch.synchronized !== undefined) r.designHash = `DEMO-DESIGN-${r.id}-r${r.revision}`; r.acceptance = "none"; invalidateArtifactTree(next, r.id); }
      if (patch.status === "cancelled") { r.status = "cancelled"; for (const t of next.tasks.filter(t => t.storyId === id && !taskDone(t))) { t.userCancelled = true; terminate(next, t, "cancelled", "需求明确取消，停止本需求运行", "requirement_cancelled"); } }
      else if (changed) { const modifiesContent = fields.some(k => ["title", "description", "goal", "ac", "dependencies", "resources", "integration", "capabilities", "writePaths"].includes(k)); if (modifiesContent && patch.confirmed !== true) r.confirmed = false; r.status = !r.confirmed ? "unconfirmed" : !r.synchronized || !r.designReady ? "unsynced" : "ready"; }
    } else if (changed) { r.revision++; r.workflowVersion++; }
    if (cyclePath(next.requirements.filter(x => x.kind === "story"))) return failure(state, "修改形成循环依赖，未应用");
    next.epoch = epoch(next.epoch); invalidate(next); event(next, null, `需求 ${id} 已受控保存：${patch.reason || "同源DEMO修改"}；旧版本运行不能推进新阶段`, "notice"); return { ok: true, state: aggregate(next), requirementId: id, id };
  }
  function createRequirement(state, draft = {}) {
    const kind = String(draft.kind || "story").toLowerCase(), parent = draft.parent || null, owner = parent && requirementFor(state, parent);
    if (!['epic', 'feature', 'story'].includes(kind) || typeof draft.title !== "string" || !draft.title.trim()) return failure(state, "类型和标题必填");
    if ((kind === "epic" && parent) || (kind === "feature" && owner?.kind !== "epic") || (kind === "story" && owner?.kind !== "feature")) return failure(state, "父类型不合法");
    if (draft.ac !== undefined && (!Array.isArray(draft.ac) || draft.ac.some(a => typeof a !== "string" || !a.trim()))) return failure(state, "AC格式无效");
    const next = clone(state); ensureClosedLoop(next); const id = `DEMO-${{story:'STORY',feature:'FEAT',epic:'EPIC'}[kind]}-${String(next.nextRequirementIds[kind]++).padStart(2,'0')}`;
    const r = { id, kind, parent, title: draft.title.trim(), description: draft.description || "", goal: draft.goal || "", revision: 1, workflowVersion: 1, comments: [], acceptanceHistory: [], status: "unconfirmed" };
    if (kind === "story") Object.assign(r, { confirmed: false, synchronized: false, designReady: false, requirementHash: `DEMO-REQ-${id}-r1`, designHash: `DEMO-DESIGN-${id}-r1`, acHash: `DEMO-AC-${id}-r1`, ac: draft.ac || [], executor: { cli:'codex', model:'DEMO-CODER' }, dependencies: [], resources: [`demo.${id}`], integration: false, capabilities: ["demo.write", "demo.verify"], writePaths: [`DEMO-WORKSPACE/${id}/**`], artifactId: `DEMO-ARTIFACT-${id}`, acceptance: "none", stage: draft.stage || 1 });
    next.requirements.push(r); next.epoch = epoch(next.epoch); event(next,null,`新增 ${id}，待确认/同步，不凭空运行`); return { ok:true, state:next, id, requirementId:id };
  }
  function deleteRequirement(state, id) {
    const r = requirementFor(state,id); if (!r) return failure(state,"需求不存在");
    if (state.requirements.some(x=>x.parent===id) || state.requirements.some(x=>x.dependencies?.some(d=>d.storyId===id)) || state.tasks.some(t=>t.storyId===id || t.dependencies.some(d=>d.storyId===id)) || (state.wakeups||[]).some(w=>w.storyId===id || w.targetStoryId===id)) return failure(state,"需求有子项、运行历史或依赖引用，不能删除");
    const next=clone(state); ensureClosedLoop(next); next.requirements=next.requirements.filter(x=>x.id!==id); next.epoch=epoch(next.epoch); event(next,null,`删除未被引用的需求 ${id}`); return {ok:true,state:next,id};
  }
  function assign(state, storyId, chosen = {}) {
    const r=requirementFor(state,storyId); if (r?.kind!=="story" || chosen.start===true) return failure(state,"分配仅作用Story且不允许直接启动");
    const error=selectionError(state,r,chosen); if(error)return failure(state,error);
    const next=clone(state); ensureClosedLoop(next); requirementFor(next,storyId).executor={cli:chosen.cli,model:chosen.model};requirementFor(next,storyId).assignmentExplicit=true; event(next,null,`已分配 ${storyId} 给 ${chosen.cli}/${chosen.model}；旧运行执行器不变，不启动任务`); return {ok:true,state:next,storyId};
  }
  function retryTask(state, taskId, options = {}) {
    const t=taskFor(state,taskId); if(!t)return failure(state,"运行不存在");
    if(typeof options.requestId!=="string" || !options.requestId.trim() || typeof options.reason!=="string" || !options.reason.trim())return failure(state,"重试必须有requestId和原因");
    const key=`retry:${taskId}:${options.requestId}`, digest=JSON.stringify({taskId,reason:options.reason,fresh:Boolean(options.fresh)}), previous=state.requestKeys?.[key];
    if(previous)return previous.digest===digest ? {ok:true,state,taskId,batchId:t.batchId,replayed:true} : failure(state,"相同requestId对应不同请求","IDEMPOTENCY_MISMATCH");
    const r=requirementFor(state,t.storyId), b=batchFor(state,t.batchId);
     if(t.stopPending)return failure(state,'旧writer停止未证明，保持写锁');
     const ep=t.activeExecutionPlan||t.frozen.executionPlan;if(ep){const c=globalThis.TaskExecutionPlanModel.retry(ep,globalThis.TaskExecutionCatalog.snapshot(),{used:t.usage?.demoUnits||0,retries:(t.manualRetries||0)+(t.retries||0),status:t.status,stopPending:t.stopPending,fresh:options.fresh});if(!c.ok)return failure(state,c.reasons.map(x=>x.message).join('；'));}
    if(!["failed","cancelled","blocked"].includes(t.status))return failure(state,"只有终结或阻塞运行可以重试");
    if(!workflowMatches(r,t) || !r.confirmed || !r.synchronized || !r.designReady || r.status==='cancelled')return failure(state,"基线/工作流已变或需求不可执行，请重新预检派发新版本","BASELINE_CHANGED");
    const error=executorError(state,{...t.frozen,executionPlan:t.activeExecutionPlan||t.frozen.executionPlan},b.policy); if(error)return failure(state,`${error}，先修复设置再重试`);
    if(b.used>=b.policy.budget || (t.manualRetries||0)>=(b.policy.maxManualRetries ?? 2))return failure(state,"重试次数或原批次预算已用尽，不能免费重置");
    if(t.dependencies.some(d=>!artifactValid(state,d,d.baseline,taskFor(state,d.producerTaskId))))return failure(state,"前置产物仍不可消费，不能绕依赖重试");
    const next=clone(state); ensureClosedLoop(next); const task=taskFor(next,taskId); task.manualRetries++; archiveRound(next,task,options.fresh ? "明确新上下文手动重试" : "同原上下文手动重试"); task.fresh=Boolean(options.fresh); next.requestKeys[key]={digest,round:task.round}; next.epoch=epoch(next.epoch); return {ok:true,state:aggregate(next),taskId,batchId:task.batchId};
  }

  function approveExecutionPlan(state,taskId,input={}){
   const task=taskFor(state,taskId),P=globalThis.TaskExecutionPlanModel,registry=globalThis.TaskExecutionCatalog?.snapshot();
   if(!task||!P||!registry||!input.plan||!input.plan.frozen||!input.reason?.trim())return failure(state,'缺已确认执行计划与变更理由');
   if(task.stopPending||!taskDone(task))return failure(state,'旧writer未停止，不能更换执行组合');
   if(!workflowMatches(requirementFor(state,task.storyId),task)||requirementFor(state,task.storyId).status==='completed')return failure(state,'需求版本失效或已验收，需新授权范围');
   const check=P.revalidate(input.plan,registry);if(!check.ok)return failure(state,check.reasons.map(x=>x.message).join('；'));
   const batch=batchFor(state,task.batchId);if(batch.used>=batch.policy.budget||(task.manualRetries||0)>=batch.policy.maxManualRetries)return failure(state,'原预算或重试上限耗尽');
   if(input.plan.taskId!==task.storyId||input.plan.sourceRun!==task.id)return failure(state,'新计划与来源Run不匹配');
   const next=clone(state),t=taskFor(next,taskId);t.planHistory||=[];t.planHistory.push({plan:clone(t.activeExecutionPlan||t.frozen.executionPlan),reason:input.reason,round:t.round,sourceRunId:t.id});
   archiveRound(next,t,'明确授权新执行组合：'+input.reason);t.activeExecutionPlan=clone(input.plan);t.executor={cli:input.plan.selectedExecutor.cliId,model:input.plan.model.remoteModelId};t.manualRetries++;t.fresh=true;next.epoch=epoch(next.epoch);return {ok:true,state:aggregate(next),taskId};
  }
  function executeReviewPlan(state,taskId,input={}){
   const task=taskFor(state,taskId),product=task&&currentProduct(state,task.storyId),P=globalThis.TaskExecutionPlanModel;
   if(!task||!product||product.task.id!==taskId||!input.plan?.frozen||input.plan.phase!=='review'||input.plan.permission.effective!=='read')return failure(state,'只读阶段必须绑定当前有效技术产物和已确认计划');
   const parent=globalThis.TaskExecutionDesign.parentAuthorization(task,true),registry={...globalThis.TaskExecutionCatalog.snapshot(),parentAuthorization:parent};
   const check=P.revalidate(input.plan,registry);if(!check.ok)return failure(state,check.reasons.map(x=>x.message).join('；'));
   if(task.stopPending)return failure(state,'旧writer停止未知');const next=clone(state),t=taskFor(next,taskId);if(!charge(next,t,1))return failure(state,'阶段预算耗尽');
   t.phaseRuns||=[];t.phaseRuns.push({id:t.id+'-review-'+(t.phaseRuns.length+1),phase:'review',status:'completed-demo',plan:clone(input.plan),artifactRevision:product.artifact.revision,tick:next.clock,source:'显式只读评审DEMO，不是真实AI审核'});
   event(next,t,'只读阶段DEMO完成，实际计划 '+input.plan.id+'；Story仍待验收');return {ok:true,state:aggregate(next),taskId};
  }

  function comment(state, storyId, input = {}) {
    const r=requirementFor(state,storyId), t=input.taskId ? taskFor(state,input.taskId) : latestTask(state,storyId);
    if(!r || typeof input.text!=="string" || !input.text.trim() || (input.taskId && (!t || t.storyId!==storyId)))return failure(state,"评论为空或跨需求运行");
    const next=clone(state); ensureClosedLoop(next); const entry={id:`DEMO-COMMENT-${next.nextComment++}`,tick:next.clock,text:input.text.trim(),actor:input.actor||'user',storyId,taskId:t?.id||null,workflowVersion:r.workflowVersion||1,source:"DEMO讨论，不表示真实CLI已收到"};
    requirementFor(next,storyId).comments.push(entry);
    if(t){const target=taskFor(next,t.id);target.comments.push(clone(entry));if(!taskDone(target)&&workflowMatches(requirementFor(next,storyId),target))event(next,target,`运行补充消息：${entry.text}`,'comment');}
    return {ok:true,state:next,commentId:entry.id,taskId:t?.id||null};
  }
  function returnForReview(state, task, reason, kind) {
    const b=batchFor(state,task.batchId); if(!reason?.trim())return failure(state,"退回原因必填");
    if((task.reviewReworks||0)>=(b.policy.maxReviewRounds ?? 2)||b.used>=b.policy.budget)return failure(state,"评审返工上限或原预算已用尽");
    const next=clone(state); ensureClosedLoop(next); const t=taskFor(next,task.id); t.reviewReworks++; t.reviewRecords.push({decision:'reject',reason,tick:next.clock,round:t.round,kind,source:'模拟评审/验收'}); archiveRound(next,t,`${kind}退回：${reason}`); next.epoch=epoch(next.epoch); return {ok:true,state:aggregate(next),taskId:t.id,batchId:t.batchId};
  }
  function review(state, taskId, input = {}) {
    const t=taskFor(state,taskId), product=t&&currentProduct(state,t.storyId);
    if(!product || product.task.id!==taskId || !['approve','reject'].includes(input.decision))return failure(state,"只能评审最新有效技术产物，旧阶段或失败证据不允许通过");
    if(input.decision==='reject')return returnForReview(state,t,input.reason,'评审');
    const next=clone(state); ensureClosedLoop(next); const task=taskFor(next,taskId); task.review={decision:'approve',tick:next.clock,actor:'DEMO-reviewer',artifactRevision:product.artifact.revision,source:'仅模拟评审'}; task.reviewRecords.push({...task.review,reason:input.reason||'',round:task.round}); event(next,task,'模拟评审通过，Story仍待验收'); return {ok:true,state:aggregate(next),taskId};
  }
  function accept(state, storyId, input = {}) {
    const product=currentProduct(state,storyId);
    if(!product || !['approve','reject'].includes(input.decision))return failure(state,"验收需要最新有效技术产物和相同需求/AC/设计版本");
    if(input.decision==='reject')return returnForReview(state,product.task,input.reason,'验收');
    if(product.requirement.status==='completed'&&product.requirement.acceptance==='simulated_manual')return {ok:true,state,storyId,replayed:true};
    const next=clone(state); ensureClosedLoop(next); const r=requirementFor(next,storyId), t=taskFor(next,product.task.id); r.status='completed'; r.acceptance='simulated_manual'; r.acceptanceHistory.push({decision:'approve',tick:next.clock,artifactRevision:t.artifactRevision,workflowVersion:r.workflowVersion,actor:'DEMO-user',source:'模拟人工验收，不是用户真实授权'}); t.storyOutcome='completed'; event(next,t,'DEMO模拟验收通过；不代表真实用户验收或发布','notice'); return {ok:true,state:aggregate(next),storyId};
  }
  function configure(state, patch = {}) {
    if(!patch||typeof patch!=='object')return failure(state,'配置格式无效');
    const next=clone(state); ensureClosedLoop(next);
    if(patch.valid!==undefined) { if(typeof patch.valid!=='boolean')return failure(state,'valid必须布尔'); next.config.valid=patch.valid; }
    if(patch.online!==undefined) { if(typeof patch.online!=='boolean')return failure(state,'online必须布尔'); if(patch.cli){if(!next.config.executors[patch.cli])return failure(state,'未知CLI');next.config.executors[patch.cli].online=patch.online;}else next.config.online=patch.online; }
    if(patch.cli){const e=next.config.executors[patch.cli];if(!e)return failure(state,'未知DEMO执行器');if(patch.enabled!==undefined){if(typeof patch.enabled!=='boolean')return failure(state,'enabled必须布尔');e.enabled=patch.enabled;}if(patch.models){if(!Array.isArray(patch.models)||patch.models.some(m=>!next.config.policy.allowed.some(a=>a.cli===patch.cli&&a.model===m)))return failure(state,'模型超出已声明允许集');e.models=clone(patch.models);}if(patch.permissions){if(!Array.isArray(patch.permissions)||patch.permissions.some(p=>!(patch.cli==='claude'?['demo.write','demo.verify']:['demo.write','demo.verify','demo.integrate']).includes(p)))return failure(state,'权限超出DEMO范围');e.permissions=clone(patch.permissions);}}
    if(patch.fault){if(!requirementFor(next,patch.fault.storyId))return failure(state,'故障需求不存在');const allowed=['permanentFailure','networkRemaining','verifyRemaining','integrationRemaining','cancelAtRunning'];if(Object.keys(patch.fault).some(k=>k!=='storyId'&&!allowed.includes(k)))return failure(state,'故障修复字段非法');next.faults[patch.fault.storyId]={...next.faults[patch.fault.storyId],...clone(patch.fault)};}
    if(patch.demoCI){if(!requirementFor(next,patch.demoCI.storyId)||!['pending','passed','failed','merged','conflicts'].includes(patch.demoCI.status))return failure(state,'DEMO CI字段无效');next.demoCI[patch.demoCI.storyId]={status:patch.demoCI.status,tick:next.clock,source:'模拟CI，未运行网络/Git'};}
    next.epoch=epoch(next.epoch);invalidate(next);event(next,null,'DEMO配置已修复/调整，原运行模型与预算不被改写','notice');return {ok:true,state:aggregate(next)};
  }
  function wakeCondition(state, rule) {
    const owner=requirementFor(state,rule.storyId), target=requirementFor(state,rule.targetStoryId||rule.storyId);
    if(rule.kind==='clock')return state.clock>=rule.at ? `clock:${rule.at}` : null;
    if(rule.kind==='comment')return owner.comments.length>rule.commentCursor ? `comments:${owner.comments.length}` : null;
    if(rule.kind==='anotherStory') { const p=currentProduct(state,target?.id);return p&&(!rule.status||target.status===rule.status) ? `artifact:${p.artifact.revision}:${target.status}` : null; }
    if(rule.kind==='children'){if(!target)return null;const leaves=scopeStories(state,{type:target.kind,id:target.id}).filter(r=>rule.stage===null||(r.stage||1)<=rule.stage);return leaves.length&&leaves.every(r=>r.status!=='cancelled'&&currentProduct(state,r.id)) ? `children:${leaves.map(r=>currentProduct(state,r.id).artifact.revision).join(':')}` : null;}
    if(rule.kind==='demoCI'){const ci=state.demoCI[target?.id];return ci&&ci.status===(rule.status||'passed') ? `ci:${target.id}:${ci.tick}:${ci.status}` : null;}
    return null;
  }
  function fireWakeup(state, rule, type, key) {
    const owner=requirementFor(state,rule.storyId);rule.triggerHistory ||= [];
    if(!rule.enabled||rule.fireCount>=rule.maxFires||rule.triggerHistory.some(h=>h.key===key))return;
    const stale=!owner||(owner.workflowVersion||1)!==rule.workflowVersion||(owner.kind==='story'&&(owner.workflowStage||'development')!==rule.boundStage)||(rule.boundTaskId && (taskFor(state,rule.boundTaskId)?.round||1)!==rule.boundRound);
    if(stale || ['completed','cancelled'].includes(owner?.status)){rule.enabled=false;rule.endedReason='旧工作流/运行版本或完成取消，不能推进新阶段';rule.triggerHistory.push({id:`${rule.id}-H${rule.triggerHistory.length+1}`,tick:state.clock,type:'stale',key,result:'rejected',reason:rule.endedReason,source:'评审仿真'});return;}
    let result='not_run', taskId=null, reason='条件满足，记录唤醒但不绕过技术或验收门槛';const active=state.tasks.find(t=>t.storyId===owner.id&&!taskDone(t));
    if(active){taskId=active.id;result='joined';event(state,active,`条件唤醒续接：${rule.instruction}`,'wakeup');}
    else if(owner.kind==='story'&&['failed','blocked','cancelled'].includes(latestTask(state,owner.id)?.status)){const old=latestTask(state,owner.id), response=retryTask(state,old.id,{requestId:`wakeup:${rule.id}:${key}`,reason:rule.instruction});if(response.ok){Object.assign(state,response.state);taskId=old.id;result='retry';}else reason=response.error;}
    else if(owner.kind==='story'&&owner.status==='ready'){const response=dispatch(state,{type:'story',id:owner.id,projectId:state.projectId});if(response.ok){Object.assign(state,response.state);taskId=response.state.batches.find(b=>b.id===response.batchId).taskIds[0];result='dispatched';}else reason=response.error;}
    const live=(state.wakeups||[]).find(w=>w.id===rule.id)||rule;live.fireCount++;live.lastFingerprint=key;live.commentCursor=owner?.comments.length||0;live.triggerHistory.push({id:`${live.id}-H${live.triggerHistory.length+1}`,tick:state.clock,type,key,taskId,result,reason,source:'评审仿真'});if(live.fireCount>=live.maxFires){live.enabled=false;live.endedReason='触发次数上限';}
  }
  function evaluateWakeups(state) {
    ensureClosedLoop(state);
    for(const id of state.wakeups.filter(r=>r.enabled).map(r=>r.id)){const rule=state.wakeups.find(r=>r.id===id), owner=requirementFor(state,rule.storyId);if(!owner||(owner.workflowVersion||1)!==rule.workflowVersion||(owner.kind==='story'&&(owner.workflowStage||'development')!==rule.boundStage)||(rule.boundTaskId&&(taskFor(state,rule.boundTaskId)?.round||1)!==rule.boundRound)){fireWakeup(state,rule,'condition',`stale:${state.clock}`);continue;}if(state.clock>=rule.expiresAt){rule.enabled=false;rule.endedReason='到期';rule.triggerHistory.push({id:`${rule.id}-H${rule.triggerHistory.length+1}`,tick:state.clock,type:'expired',result:'expired',reason:'仿真时钟到期，不执行真实定时任务',source:'评审仿真'});continue;}const fingerprint=wakeCondition(state,rule);if(fingerprint&&fingerprint!==rule.lastFingerprint)fireWakeup(state,rule,'condition',fingerprint);}
  }
  function wakeup(state, input = {}) {
    if(!input||!['create','disable','enable','trigger','delete'].includes(input.op))return failure(state,'唤醒操作无效');
    const next=clone(state);ensureClosedLoop(next);
    if(input.op==='create'){const draft=input.rule||{},owner=requirementFor(next,draft.storyId),kind=draft.kind||draft.condition||draft.event;if(!owner||['completed','cancelled'].includes(owner.status)||!['comment','anotherStory','children','demoCI','clock'].includes(kind))return failure(state,'需求或条件无效/已完成取消');const maxFires=draft.maxFires??1,at=draft.at??next.clock+2,expiresAt=draft.expiresAt??next.clock+60;if(!Number.isInteger(maxFires)||maxFires<1||maxFires>5||!Number.isInteger(at)||at<0||!Number.isInteger(expiresAt)||expiresAt<=next.clock)return failure(state,'唤醒次数和仿真到期时钟必须有界');if(draft.targetStoryId&&!requirementFor(next,draft.targetStoryId))return failure(state,'条件目标不存在');const bound=latestTask(next,owner.id),id=`DEMO-WAKEUP-${next.nextWakeup++}`;next.wakeups.push({id,storyId:owner.id,kind,targetStoryId:draft.targetStoryId||null,stage:draft.stage??null,status:draft.status||null,at,expiresAt,maxFires,fireCount:0,enabled:true,instruction:draft.instruction||'按当前冻结范围继续DEMO任务',workflowVersion:owner.workflowVersion||1,boundStage:owner.kind==='story'?(owner.workflowStage||'development'):null,boundTaskId:bound?.id||null,boundRound:bound?.round||1,commentCursor:owner.comments.length,lastFingerprint:null,triggerHistory:[],source:'DEMO规则，不是宿主schedule'});return {ok:true,state:next,id,ruleId:id};}
    const rule=next.wakeups.find(r=>r.id===input.id);if(!rule)return failure(state,'规则不存在');
    if(input.op==='disable'){rule.enabled=false;rule.endedReason='人工停用';}
    if(input.op==='enable'){
      const owner=requirementFor(next,rule.storyId);
      if(!owner||['completed','cancelled'].includes(owner.status)||(owner.workflowVersion||1)!==rule.workflowVersion||(owner.kind==='story'&&(owner.workflowStage||'development')!==rule.boundStage)||(rule.boundTaskId&&(taskFor(next,rule.boundTaskId)?.round||1)!==rule.boundRound))return failure(state,'需求或原工作流/运行阶段已失效，请显式新建规则');
      if(next.clock>=rule.expiresAt||rule.fireCount>=rule.maxFires)return failure(state,'规则已到期或触发次数耗尽，请显式新建规则');
      if(rule.enabled)return {ok:true,state,id:rule.id,ruleId:rule.id,replayed:true};
      rule.enabled=true;rule.endedReason=null;
      rule.triggerHistory.push({id:`${rule.id}-H${rule.triggerHistory.length+1}`,tick:next.clock,type:'enabled',result:'enabled',reason:'按原绑定重新启用，次数/期限/触发历史未重置',source:'评审仿真'});
    }
    if(input.op==='delete'){next.wakeupHistory ||= [];next.wakeupHistory.push({...clone(rule),deleted:true});next.wakeups=next.wakeups.filter(r=>r.id!==rule.id);}
    if(input.op==='trigger')fireWakeup(next,rule,'manual',`manual:${input.requestId||next.clock}`);
    return {ok:true,state:aggregate(next),id:rule.id,ruleId:rule.id};
  }

  const safeWrite = operation => (state, ...args) => { try { return operation(state, ...args); } catch (error) { return failure(state, `评审输入无效：${error.message}`); } };
  root.TaskReviewScheduler = Object.freeze({ TASK_STATES, BATCH_STATES, createState, preflight, dispatch, tick, pause, resume, cancel, inject, snapshot, restore, invariantErrors, requirementSummary,
    saveRequirement: safeWrite(saveRequirement), createRequirement: safeWrite(createRequirement), deleteRequirement: safeWrite(deleteRequirement), assign: safeWrite(assign), retryTask: safeWrite(retryTask), approveExecutionPlan:safeWrite(approveExecutionPlan), executeReviewPlan:safeWrite(executeReviewPlan), comment: safeWrite(comment), review: safeWrite(review), accept: safeWrite(accept), configure: safeWrite(configure), wakeup: safeWrite(wakeup) });
})(typeof globalThis !== "undefined" ? globalThis : this);
