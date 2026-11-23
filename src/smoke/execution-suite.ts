/**
 * IPC 冒烟：执行账本（FEAT-019）与双向同步（FEAT-004）的真实命令链路。
 *
 * 与 ui-suite 相同的断言风格；本文件只经 `api.invoke` 调用后端命令，
 * 不走任何前端组件，用于证明 Tauri IPC 契约（参数名、返回结构、错误文案）与单测一致。
 */
import * as api from "@/api";

type Case = { section: string; name: string; ok: boolean; detail: string };

const expect = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error("断言失败: " + msg);
};

async function expectError(promise: Promise<unknown>, keyword: string, label: string): Promise<string> {
  try {
    await promise;
  } catch (e) {
    const msg = String(e);
    if (!msg.includes(keyword)) {
      throw new Error(`${label}：错误信息未包含「${keyword}」——实际：${msg.slice(0, 200)}`);
    }
    return msg.slice(0, 160);
  }
  throw new Error(`${label}：期望失败但命令成功返回`);
}

export interface ExecutionSuiteResult {
  cases: Case[];
}

/** 跑执行账本 + 同步的全部 IPC 用例。projectId 必须已存在且可用。 */
export async function runExecutionSuite(
  projectId: string,
  projectDir: string,
  record: (section: string, name: string, fn: () => Promise<string>) => Promise<void>
): Promise<void> {
  const t = record;

  /* ---------- FEAT-019 执行账本：批次与依赖 ---------- */
  let batchId = "";
  let taskA = "";
  let taskB = "";

  await t("执行账本", "execution_batch_create：两 Story + 依赖", async () => {
    const batch = await api.invoke<{
      id: string;
      status: string;
      tasks: { id: string; storyId: string; status: string }[];
      dependencies: { gateState: string }[];
    }>("execution_batch_create", {
      input: {
        projectId,
        scopeKind: "story",
        storyIds: ["STORY-1", "STORY-2"],
        featureId: "FEAT-001",
        baselineHash: "sha256:base",
        idempotencyKey: "smoke-req-1",
        requestDigest: "digest-1",
        dependencies: [
          { successorStoryId: "STORY-2", predecessorStoryId: "STORY-1", requiredArtifactKey: "artifact" },
        ],
      },
    });
    expect(batch.status === "running", `批次状态应为 running，实际 ${batch.status}`);
    expect(batch.tasks.length === 2, `应有 2 个任务，实际 ${batch.tasks.length}`);
    expect(batch.dependencies.length === 1, "应有 1 条依赖");
    expect(batch.dependencies[0]!.gateState === "waiting", "依赖初始应为 waiting");
    batchId = batch.id;
    taskA = batch.tasks.find((x) => x.storyId === "STORY-1")!.id;
    taskB = batch.tasks.find((x) => x.storyId === "STORY-2")!.id;
    return `batch=${batchId.slice(0, 12)} tasks=${batch.tasks.length}`;
  });

  await t("执行账本", "execution_batch_create 幂等键重放返回同批次", async () => {
    const again = await api.invoke<{ id: string }>("execution_batch_create", {
      input: {
        projectId,
        scopeKind: "story",
        storyIds: ["STORY-1", "STORY-2"],
        featureId: "FEAT-001",
        baselineHash: "sha256:base",
        idempotencyKey: "smoke-req-1",
        requestDigest: "digest-1",
        dependencies: [],
      },
    });
    expect(again.id === batchId, "同幂等键必须返回原批次");
    return again.id;
  });

  await t("执行账本", "execution_batch_create 同幂等键异摘要被拒", async () => {
    return expectError(
      api.invoke("execution_batch_create", {
        input: {
          projectId,
          scopeKind: "story",
          storyIds: ["STORY-1"],
          featureId: "FEAT-001",
          baselineHash: "sha256:base",
          idempotencyKey: "smoke-req-1",
          requestDigest: "digest-CHANGED",
          dependencies: [],
        },
      }),
      "幂等键",
      "异摘要应被拒"
    );
  });

  await t("执行账本", "execution_batch_create 依赖成环被整体回滚", async () => {
    const before = await api.invoke<{ id: string }[]>("execution_batch_list", { projectId });
    const msg = await expectError(
      api.invoke("execution_batch_create", {
        input: {
          projectId,
          scopeKind: "story",
          storyIds: ["STORY-C1", "STORY-C2"],
          featureId: "FEAT-001",
          baselineHash: "sha256:base",
          idempotencyKey: "smoke-req-cycle",
          requestDigest: "digest-cycle",
          dependencies: [
            { successorStoryId: "STORY-C2", predecessorStoryId: "STORY-C1", requiredArtifactKey: "a" },
            { successorStoryId: "STORY-C1", predecessorStoryId: "STORY-C2", requiredArtifactKey: "a" },
          ],
        },
      }),
      "环",
      "环依赖应被拒"
    );
    const after = await api.invoke<{ id: string }[]>("execution_batch_list", { projectId });
    expect(after.length === before.length, `失败批次不得残留：前 ${before.length} 后 ${after.length}`);
    return msg;
  });

  await t("执行账本", "execution_batch_list / get 可读回", async () => {
    const list = await api.invoke<{ id: string }[]>("execution_batch_list", { projectId });
    expect(list.some((b) => b.id === batchId), "列表应含新批次");
    const got = await api.invoke<{ id: string; tasks: unknown[] }>("execution_batch_get", {
      projectId,
      batchId,
    });
    expect(got.id === batchId && got.tasks.length === 2, "详情应含 2 任务");
    return `${list.length} 个批次`;
  });

  /* ---------- FEAT-019 执行账本：领取、依赖门禁、fence ---------- */
  let fence = 0;
  let revisionA = 0;

  await t("执行账本", "前置未完成时后继领取被依赖门禁拒绝", async () => {
    const b = await api.invoke<{ tasks: { id: string; revision: number }[] }>("execution_batch_get", {
      projectId,
      batchId,
    });
    const tb = b.tasks.find((x) => x.id === taskB)!;
    const msg = await expectError(
      api.invoke("execution_task_claim", {
        projectId,
        taskId: taskB,
        ownerId: "smoke-owner",
        expectedRevision: tb.revision,
        leaseMs: 60000,
        runnerEpoch: "epoch-1",
      }),
      "DEPENDENCY_UNMET",
      "依赖未满足应拒绝领取"
    );
    return msg;
  });

  await t("执行账本", "execution_task_claim 领取前置任务并推进到 succeeded", async () => {
    const b = await api.invoke<{ tasks: { id: string; revision: number }[] }>("execution_batch_get", {
      projectId,
      batchId,
    });
    const ta = b.tasks.find((x) => x.id === taskA)!;
    const claim = await api.invoke<{
      task: { revision: number; status: string };
      attemptId: string;
      taskFence: number;
    }>("execution_task_claim", {
      projectId,
      taskId: taskA,
      ownerId: "smoke-owner",
      expectedRevision: ta.revision,
      leaseMs: 60000,
      runnerEpoch: "epoch-1",
    });
    expect(claim.task.status === "preparing", `领取后应为 preparing，实际 ${claim.task.status}`);
    expect(claim.taskFence === 1, `首次领取 fence 应为 1，实际 ${claim.taskFence}`);
    fence = claim.taskFence;
    revisionA = claim.task.revision;

    // 检查点在租约内可保存。
    const ckpt = await api.invoke<{ taskFence: number }>("execution_checkpoint_save", {
      input: {
        projectId,
        taskId: taskA,
        attemptId: claim.attemptId,
        taskFence: fence,
        stepCursor: "implement",
        planHash: "sha256:plan",
      },
    });
    expect(ckpt.taskFence === fence, "检查点应记录当前 fence");

    // 旧 fence 写入必须被 LEASE_LOST 拒绝。
    await expectError(
      api.invoke("execution_checkpoint_save", {
        input: {
          projectId,
          taskId: taskA,
          attemptId: claim.attemptId,
          taskFence: fence + 999,
          stepCursor: "implement",
        },
      }),
      "LEASE_LOST",
      "陈旧 fence 检查点应被拒"
    );

    for (const status of ["running", "verifying", "succeeded"]) {
      const moved = await api.invoke<{ revision: number; fencingToken: number; status: string }>(
        "execution_task_transition",
        {
          projectId,
          taskId: taskA,
          expectedRevision: revisionA,
          fencingToken: fence,
          toStatus: status,
        }
      );
      expect(moved.status === status, `应推进到 ${status}，实际 ${moved.status}`);
      revisionA = moved.revision;
      fence = moved.fencingToken;
    }
    return `taskA=${taskA.slice(0, 10)} fence=${fence}`;
  });

  await t("执行账本", "前置 succeeded 后后继可领取", async () => {
    const b = await api.invoke<{ tasks: { id: string; revision: number }[] }>("execution_batch_get", {
      projectId,
      batchId,
    });
    const tb = b.tasks.find((x) => x.id === taskB)!;
    const claim = await api.invoke<{ task: { status: string } }>("execution_task_claim", {
      projectId,
      taskId: taskB,
      ownerId: "smoke-owner",
      expectedRevision: tb.revision,
      leaseMs: 60000,
      runnerEpoch: "epoch-1",
    });
    expect(claim.task.status === "preparing", "后继应可领取");
    return claim.task.status;
  });

  await t("执行账本", "非法状态转换被拒（queued → succeeded）", async () => {
    const b = await api.invoke<{ tasks: { id: string; revision: number; status: string }[] }>(
      "execution_batch_get",
      { projectId, batchId }
    );
    const ta = b.tasks.find((x) => x.id === taskA)!;
    return expectError(
      api.invoke("execution_task_transition", {
        projectId,
        taskId: taskA,
        expectedRevision: ta.revision,
        fencingToken: fence,
        toStatus: "queued",
      }),
      "非法状态转换",
      "succeeded → queued 应被拒"
    );
  });

  /* ---------- FEAT-019：检查点、恢复预检 ---------- */
  await t("执行账本", "execution_checkpoint_latest 读回最新检查点", async () => {
    const latest = await api.invoke<{ stepCursor: string | null } | null>("execution_checkpoint_latest", {
      projectId,
      taskId: taskA,
    });
    expect(!!latest, "应存在检查点");
    expect(latest!.stepCursor === "implement", `stepCursor 应为 implement，实际 ${latest!.stepCursor}`);
    return latest!.stepCursor!;
  });

  await t("执行账本", "execution_recovery_inspect 列出可恢复性", async () => {
    const view = await api.invoke<{
      resumable: boolean;
      blockers: string[];
      liveAttempts: { status: string }[];
    }>("execution_recovery_inspect", { projectId, taskId: taskA });
    expect(typeof view.resumable === "boolean", "应返回 resumable");
    expect(Array.isArray(view.blockers), "应返回 blockers 数组");
    return `resumable=${view.resumable} blockers=${view.blockers.join("|") || "无"}`;
  });

  /* ---------- FEAT-019：工作包与义务覆盖（CR-047） ---------- */
  let packageId = "";
  let packageRevision = 0;

  await t("工作包", "execution_package_create：缺任务映射时不可确认", async () => {
    const pkg = await api.invoke<{
      id: string;
      revision: number;
      state: string;
      coverage: { ready: boolean; missingMethod: string[]; missingMapping: string[] };
    }>("execution_package_create", {
      input: {
        projectId,
        featureId: "FEAT-001",
        workLevel: "feature",
        sourceManifestHash: "sha256:src",
        packageHash: "sha256:pkg-smoke",
        stories: [
          {
            storyId: "STORY-1",
            featureId: "FEAT-001",
            sourceHash: "sha256:s1",
            disposition: "execute",
          },
        ],
        obligations: [
          {
            obligationId: "AC-SMOKE-1",
            ownerStoryId: "STORY-1",
            kind: "ac",
            sourceLocator: "docs/Plan/Story/STORY-1.md#AC-SMOKE-1",
            sourceHash: "sha256:ac",
            applicability: "required",
            methodRef: "test:auto",
            manifestItemHash: "sha256:ac-smoke",
          },
        ],
      },
    });
    expect(!pkg.coverage.ready, "未映射任务不得 ready");
    expect(pkg.coverage.missingMethod.length === 0, "已给验证方法，不应报缺方法");
    expect(pkg.coverage.missingMapping.includes("AC-SMOKE-1"), "应报缺失任务映射");
    await expectError(
      api.invoke("execution_package_confirm", { projectId, packageId: pkg.id, revision: pkg.revision }),
      "未就绪",
      "未就绪工作包不得确认"
    );
    packageId = pkg.id;
    packageRevision = pkg.revision;
    return `missingMapping=${pkg.coverage.missingMapping.join(",")}`;
  });

  await t("工作包", "execution_obligation_map 映射后覆盖就绪并可确认", async () => {
    const mapped = await api.invoke<{
      revision: number;
      coverage: { ready: boolean; mapped: number; missingMapping: string[] };
    }>("execution_obligation_map", {
      input: {
        projectId,
        packageId,
        packageRevision,
        obligationId: "AC-SMOKE-1",
        taskId: taskA,
        validationItemId: "test:auto",
      },
    });
    expect(mapped.coverage.ready, `映射后应 ready，缺=[${mapped.coverage.missingMapping.join(",")}]`);
    expect(mapped.coverage.mapped === 1, `应映射 1 条，实际 ${mapped.coverage.mapped}`);
    packageRevision = mapped.revision;
    const confirmed = await api.invoke<{ state: string }>("execution_package_confirm", {
      projectId,
      packageId,
      revision: packageRevision,
    });
    expect(confirmed.state === "confirmed", `确认后应为 confirmed，实际 ${confirmed.state}`);
    return `confirmed mapped=${mapped.coverage.mapped}`;
  });

  await t("工作包", "execution_package_get 读回工作包", async () => {
    const got = await api.invoke<{ id: string; obligations: unknown[] }>("execution_package_get", {
      projectId,
      packageId,
      revision: packageRevision,
    });
    expect(got.id === packageId, "应读回同一工作包");
    expect(got.obligations.length === 1, `应有 1 条义务，实际 ${got.obligations.length}`);
    return got.id.slice(0, 12);
  });

  /* ---------- FEAT-019：G-PLAN 计划与授权门禁 ---------- */
  let planId = "";

  await t("计划门禁", "execution_plan_create 建立任务计划", async () => {
    const plan = await api.invoke<{ id: string; planHash: string; taskId: string }>("execution_plan_create", {
      input: {
        projectId,
        taskId: taskB,
        phase: "implement",
        planHash: "sha256:plan-smoke",
        hashRuleVersion: "v1",
        requirementHash: "sha256:req",
        designHash: "sha256:design",
        acHash: "sha256:ac",
        selectedCli: "claude",
        modelRef: "tierflow",
        permissionPolicyHash: "sha256:perm",
        capabilityManifestHash: "sha256:cap",
      },
    });
    expect(plan.planHash === "sha256:plan-smoke", "计划 hash 应一致");
    planId = plan.id;
    return plan.id.slice(0, 12);
  });

  await t("计划门禁", "无授权时 execution_plan_check 给出 NO_AUTHORIZATION", async () => {
    const check = await api.invoke<{ ready: boolean; blockers: string[] }>("execution_plan_check", {
      projectId,
      planId,
    });
    expect(!check.ready, "无授权不得 ready");
    expect(check.blockers.includes("NO_AUTHORIZATION"), `应含 NO_AUTHORIZATION，实际 ${check.blockers.join(",")}`);
    return check.blockers.join(",");
  });

  await t("计划门禁", "execution_plan_authorize 后 ready", async () => {
    await api.invoke("execution_plan_authorize", {
      input: {
        projectId,
        planId,
        actorRef: "user:smoke",
        source: "explicit",
        scope: "once",
      },
    });
    const check = await api.invoke<{ ready: boolean; blockers: string[] }>("execution_plan_check", {
      projectId,
      planId,
    });
    expect(check.ready, `授权后应 ready，当前 blockers=${check.blockers.join(",")}`);
    return "ready";
  });

  await t("计划门禁", "execution_plan_task_status 反映任务侧状态", async () => {
    const status = await api.invoke<{ ready: boolean } | null>("execution_plan_task_status", {
      projectId,
      taskId: taskB,
    });
    expect(!!status, "任务应有关联计划");
    return `ready=${status!.ready}`;
  });

  /* ---------- FEAT-019：审批 ---------- */
  let approvalId = "";

  await t("审批", "execution_approval_request 建待批项", async () => {
    const a = await api.invoke<{ id: string; decision: string }>("execution_approval_request", {
      input: {
        projectId,
        planHash: "sha256:plan-smoke",
        taskId: taskB,
        toolCallId: "call-smoke-1",
        finalArgsHash: "sha256:args",
        risk: "medium",
      },
    });
    expect(a.decision === "pending", `初始应为 pending，实际 ${a.decision}`);
    approvalId = a.id;
    const pending = await api.invoke<{ id: string }[]>("execution_approval_pending", { projectId });
    expect(pending.some((x) => x.id === approvalId), "待批列表应含新项");
    return approvalId.slice(0, 12);
  });

  await t("审批", "execution_approval_decide 通过并离开待批列表", async () => {
    const decided = await api.invoke<{ decision: string; decidedBy: string | null }>(
      "execution_approval_decide",
      { projectId, approvalId, decision: "approved", actorRef: "user:smoke" }
    );
    expect(decided.decision === "approved", `应为 approved，实际 ${decided.decision}`);
    expect(decided.decidedBy === "user:smoke", "应记录决定人");
    const pending = await api.invoke<{ id: string }[]>("execution_approval_pending", { projectId });
    expect(!pending.some((x) => x.id === approvalId), "已决定项应离开待批列表");
    const got = await api.invoke<{ decision: string }>("execution_approval_get", { projectId, approvalId });
    expect(got.decision === "approved", "读回应为 approved");
    return decided.decision;
  });

  await t("审批", "execution_approval_decide 非法决定被拒", async () => {
    return expectError(
      api.invoke("execution_approval_decide", {
        projectId,
        approvalId,
        decision: "approve",
        actorRef: "user:smoke",
      }),
      "未知审批决定",
      "非法决定应被拒"
    );
  });

  /* ---------- FEAT-019：调度循环 ---------- */
  await t("调度", "execution_dispatch_once 按依赖推进并汇总", async () => {
    const batch = await api.invoke<{ id: string; tasks: { id: string; test?: string }[] }>(
      "execution_batch_create",
      {
        input: {
          projectId,
          scopeKind: "story",
          storyIds: ["STORY-D1", "STORY-D2"],
          featureId: "FEAT-001",
          baselineHash: "sha256:base",
          idempotencyKey: "smoke-req-dispatch",
          requestDigest: "digest-dispatch",
          dependencies: [
            { successorStoryId: "STORY-D2", predecessorStoryId: "STORY-D1", requiredArtifactKey: "a" },
          ],
        },
      }
    );
    const summary = await api.invoke<{
      started: string[];
      succeeded: string[];
      skipped: string[];
    }>("execution_dispatch_once", {
      input: {
        projectId,
        ownerId: "smoke-owner",
        maxTasks: 4,
        leaseMs: 60000,
        runnerEpoch: "epoch-dispatch",
        simulate: "succeed",
      },
    });
    expect(summary.succeeded.length >= 1, `应至少完成 1 个，实际 ${summary.succeeded.length}`);
    // 同一轮内前置先完成后，后继依赖即时满足，可能同轮就被领取；
    // 因此再跑一轮兜底，最终断言两个任务都 succeeded（而不是要求第二轮必有产出）。
    await api.invoke<{ succeeded: string[] }>("execution_dispatch_once", {
      input: {
        projectId,
        ownerId: "smoke-owner",
        maxTasks: 4,
        leaseMs: 60000,
        runnerEpoch: "epoch-dispatch-2",
        simulate: "succeed",
      },
    });
    const after = await api.invoke<{ tasks: { status: string }[] }>("execution_batch_get", {
      projectId,
      batchId: batch.id,
    });
    expect(after.tasks.every((x) => x.status === "succeeded"), `全部任务应 succeeded，实际 ${after.tasks.map((x) => x.status).join(",")}`);
    return `第一轮完成 ${summary.succeeded.length} 个，最终全部 succeeded`;
  });

  /* ---------- FEAT-019：事件流 ---------- */
  await t("执行账本", "execution_event_list 记录状态迁移事件", async () => {
    const events = await api.invoke<{ eventType: string; taskId: string | null }[]>(
      "execution_event_list",
      { projectId, taskId: taskA, limit: 200 }
    );
    const types = events.map((e) => e.eventType);
    expect(types.includes("task.claimed"), `应有 task.claimed，实际 ${types.join(",")}`);
    expect(types.includes("task.running"), `应有 task.running，实际 ${types.join(",")}`);
    expect(types.includes("task.succeeded"), `应有 task.succeeded，实际 ${types.join(",")}`);
    return types.join(",");
  });

  /* ---------- FEAT-004 双向同步：基线 ---------- */
  let baselineId = "";
  let syncBatchId = "";
  let syncBatchRevision = 0;
  const targetRel = "docs/UI/UI设计.md";

  await t("双向同步", "sync_baseline_publish 首次发布共同基线", async () => {
    const base = await api.invoke<{ id: string; coverage: string }>("sync_baseline_publish", {
      input: {
        projectId,
        branchRef: "refs/heads/main",
        headCommit: "abc123",
        codeManifestRef: "manifest:code-1",
        codeManifestHash: "sha256:code-1",
        sourceRefs: [{ id: "FEAT-001", hash: "sha256:doc" }],
        coverage: "complete-in-scope",
      },
    });
    expect(base.coverage === "complete-in-scope", "覆盖度应回读");
    baselineId = base.id;
    const current = await api.invoke<{ id: string } | null>("sync_baseline_current", { projectId });
    expect(current?.id === baselineId, "当前基线应指向新发布");
    return baselineId.slice(0, 12);
  });

  await t("双向同步", "sync_baseline_current 只读回当前有效基线", async () => {
    const current = await api.invoke<{ id: string; supersededAt?: number | null } | null>(
      "sync_baseline_current",
      { projectId }
    );
    expect(!!current && current.id === baselineId, "应为刚发布的基线");
    return current!.id.slice(0, 12);
  });

  await t("双向同步", "sync_batch_create：文档来源批次", async () => {
    const batch = await api.invoke<{ id: string; state: string; revision: number }>("sync_batch_create", {
      input: {
        projectId,
        origin: "document",
        causationId: "cause-smoke-1",
        idempotencyKey: "sync-smoke-1",
        baseId: baselineId,
        inputManifestHash: "sha256:in",
        proposalRef: "proposal:smoke-1",
        proposalHash: "sha256:prop",
      },
    });
    expect(batch.state === "prepared", `初始应为 prepared，实际 ${batch.state}`);
    syncBatchId = batch.id;
    syncBatchRevision = batch.revision;
    return `${batch.id.slice(0, 12)} ${batch.state}`;
  });

  await t("双向同步", "sync_batch_create 文档增量缺基线引用被拒", async () => {
    return expectError(
      api.invoke("sync_batch_create", {
        input: {
          projectId,
          origin: "document",
          idempotencyKey: "sync-smoke-nobase",
          inputManifestHash: "sha256:in",
          proposalRef: "proposal:nobase",
          proposalHash: "sha256:prop",
        },
      }),
      "基线",
      "document 增量缺基线应被拒"
    );
  });

  await t("双向同步", "sync_batch_create recovery 禁止引用历史基线", async () => {
    return expectError(
      api.invoke("sync_batch_create", {
        input: {
          projectId,
          origin: "recovery",
          idempotencyKey: "sync-smoke-recovery",
          baseId: baselineId,
          inputManifestHash: "sha256:in",
          proposalRef: "proposal:recovery",
          proposalHash: "sha256:prop",
        },
      }),
      "禁止引用",
      "recovery 带基线应被拒"
    );
  });

  await t("双向同步", "sync_target_stage 登记目标并生成暂存与新 hash", async () => {
    const newContent = "# UI 设计\n\n白蓝简洁风。\n\n- AC-SMOKE-NEW：新增验收行。\n";
    // baseHash 必须是目标文件的真实内容指纹；先以占位登记，再按预览回填的 currentHash 重登。
    const stage = (baseHash: string) =>
      api.invoke<{ targetId: string; applyState: string; newHash: string }>("sync_target_stage", {
        input: {
          batchId: syncBatchId,
          targetId: "tgt-1",
          kind: "document",
          baseHash,
          newHash: "",
          targetUri: `${projectDir}/${targetRel}`,
          content: newContent,
        },
      });
    let journal = await stage("sha256:placeholder");
    expect(journal.applyState === "staged", `应进入 staged，实际 ${journal.applyState}`);
    expect(journal.newHash.startsWith("sha256:"), "应回填内容 hash");
    const probe = await api.invoke<{ currentHash: string | null }>("sync_target_preview", {
      projectId,
      batchId: syncBatchId,
      targetId: "tgt-1",
    });
    expect(!!probe.currentHash, "应能读到目标当前 hash");
    journal = await stage(probe.currentHash!);
    expect(journal.newHash !== probe.currentHash, "新旧 hash 必须不同，否则无法验证写入");
    return `base=${probe.currentHash!.slice(0, 15)}…`;
  });

  await t("双向同步", "sync_target_preview 给出行级 diff 与语义 delta", async () => {
    const preview = await api.invoke<{
      diff: { kind: string; text: string }[];
      semantic: { addedAcs: string[]; addedHeadings: string[] };
      currentMatchesBase: boolean;
    }>("sync_target_preview", { projectId, batchId: syncBatchId, targetId: "tgt-1" });
    expect(preview.diff.length > 0, "应有行级差异");
    expect(preview.semantic.addedAcs.includes("AC-SMOKE-NEW"), `语义应识别新增 AC，实际 ${preview.semantic.addedAcs.join(",")}`);
    return `diff=${preview.diff.length} 新增AC=${preview.semantic.addedAcs.length}`;
  });

  await t("双向同步", "sync_batch_decide accept 进入待对账", async () => {
    const decided = await api.invoke<{ state: string; revision: number }>("sync_batch_decide", {
      projectId,
      batchId: syncBatchId,
      expectedRevision: syncBatchRevision,
      decision: "accept",
    });
    expect(decided.state === "applied_pending_reconcile", `实际 ${decided.state}`);
    syncBatchRevision = decided.revision;
    return decided.state;
  });

  await t("双向同步", "sync_target_write 条件写入并回填 applied", async () => {
    const after = await api.invoke<{ id: string; targets: { applyState: string }[] }>("sync_target_write", {
      input: { projectId, batchId: syncBatchId, targetId: "tgt-1" },
    });
    expect(after.targets[0]!.applyState === "applied", `写入后应为 applied，实际 ${after.targets[0]!.applyState}`);
    const text = await api.fsReadFile(projectDir, targetRel);
    expect(text.includes("AC-SMOKE-NEW"), "文件应真的被写入");
    return "applied";
  });

  await t("双向同步", "sync_target_write 重复调用幂等", async () => {
    const again = await api.invoke<{ targets: { applyState: string }[] }>("sync_target_write", {
      input: { projectId, batchId: syncBatchId, targetId: "tgt-1" },
    });
    expect(again.targets[0]!.applyState === "applied", "重复写入仍应为 applied");
    return "idempotent";
  });

  await t("双向同步", "sync_reconcile_pending 对账已应用目标", async () => {
    const summary = await api.invoke<{ checked: number; applied: number }>("sync_reconcile_pending", {
      projectId,
    });
    expect(summary.checked >= 1, "应至少检查 1 条");
    return `checked=${summary.checked} applied=${summary.applied}`;
  });

  await t("双向同步", "sync_batch_reconcile 标记批次已完成对账", async () => {
    const done = await api.invoke<{ state: string }>("sync_batch_reconcile", {
      projectId,
      batchId: syncBatchId,
      expectedRevision: syncBatchRevision,
    });
    expect(done.state === "reconciled", `实际 ${done.state}`);
    return done.state;
  });

  await t("双向同步", "sync_publish_baseline 从已对账批次发布基线", async () => {
    const base = await api.invoke<{ id: string; publishedBatchId: string | null }>("sync_publish_baseline", {
      projectId,
      batchId: syncBatchId,
    });
    expect(base.publishedBatchId === syncBatchId, "新基线应记录来源批次");
    const current = await api.invoke<{ id: string } | null>("sync_baseline_current", { projectId });
    expect(current?.id === base.id, "当前基线应换成新发布");
    return base.id.slice(0, 12);
  });

  await t("双向同步", "sync_batch_list 汇总目标与冲突计数", async () => {
    const list = await api.invoke<{ id: string; state: string }[]>("sync_batch_list", { projectId });
    expect(list.some((b) => b.id === syncBatchId && b.state === "reconciled"), "列表应含已对账批次");
    return `${list.length} 个批次`;
  });
}

export type { Case as ExecutionCase };
