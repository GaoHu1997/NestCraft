/* 仿真数据：全部为虚构夹具（DEMO），不对应真实项目、人员、主机或账单。 */
window.DEMO = (function () {
  "use strict";

  const user = { name: "林澈", initials: "LC", email: "lin.che@example.invalid", role: "研发负责人" };

  const projects = [
    {
      id: "PRJ-1042", key: "BOOKING", name: "预约服务", kind: "code", owner: "林澈", ownerInitials: "LC",
      desc: "社区活动预约：时段容量、幂等下单、取消回补与交付追溯。",
      stories: 11, done: 4, running: 3, updated: "今天 14:32", tone: "blue",
      repo: "D:/work/booking-service", branch: "feature/booking-idempotency", current: true
    },
    {
      id: "PRJ-1031", key: "OPS", name: "运维控制台", kind: "code", owner: "周野", ownerInitials: "ZY",
      desc: "多主机连接、巡检任务与受限命令执行，含高风险审批。",
      stories: 16, done: 9, running: 1, updated: "今天 11:07", tone: "violet",
      repo: "D:/work/ops-console", branch: "main"
    },
    {
      id: "PRJ-1018", key: "RESEARCH", name: "市场研究资料", kind: "work", owner: "陈雨", ownerInitials: "CY",
      desc: "活动预约场景的竞品调研、访谈纪要与结论沉淀。",
      stories: 8, done: 5, running: 0, updated: "昨天 18:20", tone: "amber"
    },
    {
      id: "PRJ-1009", key: "BRAND", name: "品牌与官网", kind: "work", owner: "陈雨", ownerInitials: "CY",
      desc: "命名、图形标志、官网信息架构与发布物料。",
      stories: 6, done: 6, running: 0, updated: "11-17 16:44", tone: "green"
    }
  ];

  /* ---------------- 预约服务：需求树 ---------------- */
  const statusMeta = {
    ready: { label: "已就绪", tone: "blue" },
    unconfirmed: { label: "待确认", tone: "gray" },
    unsynced: { label: "待同步", tone: "amber" },
    designing: { label: "设计中", tone: "violet" },
    running: { label: "开发中", tone: "blue" },
    verifying: { label: "验证中", tone: "violet" },
    blocked: { label: "阻塞", tone: "red" },
    pending: { label: "待验收", tone: "amber" },
    completed: { label: "已完成", tone: "green" },
    cancelled: { label: "已取消", tone: "gray" }
  };

  const requirements = [
    {
      /* UI-CR066：显式 Vision 父级，使 Vision → Epic → Feature → Story 为真实父子层级，
         导图连线与目录都按此父子关系绘制，不再靠「无父项」兜底推断。 */
      id: "VISION-01", kind: "vision", title: "预约服务产品愿景", project: "PRJ-1042", status: "running",
      summary: "让参与者在可信时段上完成预约，让运营看得见占用与审计；本节点为设计夹具中的显式愿景父级。",
      owner: "林澈", updated: "今天 14:10", estimate: "—"
    },
    {
      id: "EPIC-01", kind: "epic", parent: "VISION-01", title: "可预约的社区活动", project: "PRJ-1042", status: "running",
      summary: "参与者选择活动时段完成预约，满额拒绝、取消回补，运营可查看占用。",
      owner: "林澈", updated: "今天 14:20", estimate: "5 周", progress: 62
    },
    {
      id: "FEAT-011", kind: "feature", parent: "EPIC-01", title: "预约主流程", project: "PRJ-1042", status: "running",
      summary: "从选择时段到确认预约的完整链路，含容量与幂等约束。",
      owner: "林澈", updated: "今天 14:20", estimate: "8 人日", progress: 75
    },
    {
      id: "STORY-0101", kind: "story", parent: "FEAT-011", title: "冻结预约接口约定", project: "PRJ-1042", status: "completed",
      summary: "确定请求、响应、幂等键与错误码，作为前后端共同基线。",
      owner: "林澈", cli: "claude", model: "tierflow-pro", updated: "11-18 17:02", estimate: "1 人日",
      acs: [
        { id: "AC-01", text: "重复提交同一 idempotencyKey 只生成一个 bookingId。", state: "passed" },
        { id: "AC-02", text: "容量为 0 时返回 SLOT_FULL，且不扣减名额。", state: "passed" },
        { id: "AC-03", text: "取消仅将已有预约置为 cancelled，并归还一次名额。", state: "passed" }
      ],
      deps: [], tests: "6 / 6 通过", hash: "req 8f2c1a · design 41d0b7"
    },
    {
      id: "STORY-0102", kind: "story", parent: "FEAT-011", title: "时段容量与库存校验", project: "PRJ-1042", status: "running",
      summary: "并发占用下容量不能超卖，扣减与回补需要原子化。",
      owner: "周野", cli: "codex", model: "tierflow-pro", updated: "今天 14:32", estimate: "2 人日",
      acs: [
        { id: "AC-01", text: "并发 20 次抢 2 个名额，成功数不超过 2。", state: "passed" },
        { id: "AC-02", text: "扣减失败时返回可读原因，不产生半成品预约。", state: "running" },
        { id: "AC-03", text: "释放名额与预约状态在同一事务内提交。", state: "pending" }
      ],
      deps: ["STORY-0101"], tests: "运行中 · 2/3 项已通过", hash: "req 8f2c1a · design 5b77e2"
    },
    {
      id: "STORY-0103", kind: "story", parent: "FEAT-011", title: "幂等下单与重复请求", project: "PRJ-1042", status: "pending",
      summary: "同一幂等键在 24 小时内复用同一结果，跨用户不共享。",
      owner: "周野", cli: "codex", model: "tierflow-pro", updated: "今天 13:10", estimate: "2 人日",
      acs: [
        { id: "AC-01", text: "同一幂等键重放返回相同响应体与状态码。", state: "passed" },
        { id: "AC-02", text: "不同用户相同键互不影响。", state: "passed" },
        { id: "AC-03", text: "超过保留窗口的键按新请求处理并记录。", state: "passed" }
      ],
      deps: ["STORY-0102"], tests: "5 / 5 通过 · 待验收", hash: "req 8f2c1a · design 5b77e2"
    },
    {
      id: "STORY-0104", kind: "story", parent: "FEAT-011", title: "满额拒绝与可读提示", project: "PRJ-1042", status: "ready",
      summary: "满额、并发失败与网络超时给出不同提示，便于用户重试。",
      owner: "陈雨", cli: "claude", model: "tierflow-lite", updated: "11-18 20:15", estimate: "1 人日",
      acs: [
        { id: "AC-01", text: "满额返回 SLOT_FULL 并展示剩余 0 的时段状态。", state: "pending" },
        { id: "AC-02", text: "并发冲突提示稍后重试，不展示内部堆栈。", state: "pending" }
      ],
      deps: ["STORY-0102"], tests: "未执行", hash: "req 8f2c1a · design 9c21aa"
    },
    {
      id: "STORY-0105", kind: "story", parent: "FEAT-011", title: "取消预约与名额回补", project: "PRJ-1042", status: "unconfirmed",
      summary: "取消可重复调用，重复取消不重复归还名额。",
      owner: "林澈", cli: "claude", model: "tierflow-pro", updated: "11-18 18:40", estimate: "1.5 人日",
      acs: [
        { id: "AC-01", text: "重复取消返回同一 cancelled 状态。", state: "pending" }
      ],
      deps: ["STORY-0103"], tests: "未执行", hash: "req 8f2c1a · design —"
    },
    {
      id: "FEAT-012", kind: "feature", parent: "EPIC-01", title: "通知与提醒", project: "PRJ-1042", status: "blocked",
      summary: "预约结果与取消通知；当前受消息通道配置阻塞。",
      owner: "陈雨", updated: "今天 09:12", estimate: "3 人日", progress: 20
    },
    {
      id: "STORY-0201", kind: "story", parent: "FEAT-012", title: "预约成功站内信", project: "PRJ-1042", status: "blocked",
      summary: "预约成功后写入站内消息，包含活动、时段与取消入口。",
      owner: "陈雨", cli: "claude", model: "tierflow-lite", updated: "今天 09:12", estimate: "1 人日",
      acs: [
        { id: "AC-01", text: "预约成功后 5 秒内可查询到站内消息。", state: "pending" },
        { id: "AC-02", text: "消息内取消入口跳转到对应预约。", state: "pending" }
      ],
      deps: ["STORY-0103"], tests: "阻塞：消息通道未配置", hash: "req 2a91bb · design —", blocked: "等待「消息通道」配置确认"
    },
    {
      id: "STORY-0202", kind: "story", parent: "FEAT-012", title: "取消通知与回执", project: "PRJ-1042", status: "unconfirmed",
      summary: "取消后通知参与者和组织者，并保留回执。",
      owner: "陈雨", cli: "claude", model: "tierflow-lite", updated: "11-17 16:22", estimate: "1 人日",
      acs: [{ id: "AC-01", text: "取消后双方各收到一条通知，失败可重投。", state: "pending" }],
      deps: ["STORY-0201"], tests: "未执行", hash: "req 2a91bb · design —"
    },
    {
      id: "EPIC-02", kind: "epic", parent: "VISION-01", title: "运营看板与审计", project: "PRJ-1042", status: "running",
      summary: "运营查看时段占用、导出明细，管理员追溯关键操作。",
      owner: "周野", updated: "今天 12:02", estimate: "3 周", progress: 48
    },
    {
      id: "FEAT-021", kind: "feature", parent: "EPIC-02", title: "预约看板", project: "PRJ-1042", status: "running",
      summary: "按时段与活动维度查看占用、取消率与异常。",
      owner: "周野", updated: "今天 12:02", estimate: "4 人日", progress: 55
    },
    {
      id: "STORY-0301", kind: "story", parent: "FEAT-021", title: "时段占用看板", project: "PRJ-1042", status: "verifying",
      summary: "按活动分组展示容量、已用与剩余，支持切换日期。",
      owner: "周野", cli: "codex", model: "tierflow-pro", updated: "今天 12:02", estimate: "2 人日",
      acs: [
        { id: "AC-01", text: "切换日期后数据在同一请求内刷新。", state: "passed" },
        { id: "AC-02", text: "空数据展示空态与原因，不显示 0 行表格。", state: "passed" },
        { id: "AC-03", text: "窄屏下占用条可横向滚动且不丢列。", state: "running" }
      ],
      deps: ["STORY-0102"], tests: "3 / 4 通过", hash: "req 77c1e0 · design b208e4"
    },
    {
      id: "STORY-0302", kind: "story", parent: "FEAT-021", title: "导出预约明细", project: "PRJ-1042", status: "unsynced",
      summary: "按筛选条件导出 CSV，列与页面一致。",
      owner: "林澈", cli: "claude", model: "tierflow-lite", updated: "11-18 15:31", estimate: "1 人日",
      acs: [{ id: "AC-01", text: "导出行数与筛选结果一致。", state: "pending" }],
      deps: ["STORY-0301"], tests: "未执行", hash: "req 77c1e0 · design 草稿未同步"
    },
    {
      id: "FEAT-022", kind: "feature", parent: "EPIC-02", title: "权限与审计", project: "PRJ-1042", status: "completed",
      summary: "只读角色与关键操作审计日志。",
      owner: "林澈", updated: "11-18 11:20", estimate: "2 人日", progress: 100
    },
    {
      id: "STORY-0401", kind: "story", parent: "FEAT-022", title: "只读运营角色", project: "PRJ-1042", status: "completed",
      summary: "运营只读角色可查看看板与明细，不可修改预约。",
      owner: "林澈", cli: "claude", model: "tierflow-lite", updated: "11-18 11:20", estimate: "0.5 人日",
      acs: [
        { id: "AC-01", text: "只读角色调用写接口返回 403 并记录审计。", state: "passed" },
        { id: "AC-02", text: "界面不显示只读角色无权使用的按钮。", state: "passed" }
      ],
      deps: [], tests: "4 / 4 通过", hash: "req 51aa02 · design 0c91df"
    },
    {
      id: "STORY-0402", kind: "story", parent: "FEAT-022", title: "操作审计日志", project: "PRJ-1042", status: "completed",
      summary: "记录派发、取消、授权与导出操作，保留操作者与时间。",
      owner: "周野", cli: "codex", model: "tierflow-pro", updated: "11-18 10:04", estimate: "1 人日",
      acs: [
        { id: "AC-01", text: "关键操作可在 1 分钟内检索到。", state: "passed" },
        { id: "AC-02", text: "日志不含凭证与个人敏感字段。", state: "passed" }
      ],
      deps: [], tests: "5 / 5 通过", hash: "req 51aa02 · design 0c91df"
    },
    /* --- 运维控制台 --- */
    {
      id: "EPIC-11", kind: "epic", title: "多主机巡检与受限执行", project: "PRJ-1031", status: "running",
      summary: "统一连接多台主机，按白名单执行巡检命令，高风险操作逐次审批。",
      owner: "周野", updated: "今天 11:07", estimate: "4 周", progress: 56
    },
    {
      id: "FEAT-111", kind: "feature", parent: "EPIC-11", title: "连接与分组", project: "PRJ-1031", status: "completed",
      summary: "主机的分组、认证引用与连接保活。",
      owner: "周野", updated: "昨天 16:40", estimate: "3 人日", progress: 100
    },
    {
      id: "STORY-1101", kind: "story", parent: "FEAT-111", title: "主机分组与标签", project: "PRJ-1031", status: "completed",
      summary: "按环境与用途分组，支持标签筛选。",
      owner: "周野", cli: "codex", model: "tierflow-pro", updated: "昨天 16:40", estimate: "1 人日",
      acs: [{ id: "AC-01", text: "同一主机只属于一个分组，可附加多个标签。", state: "passed" }],
      deps: [], tests: "3 / 3 通过", hash: "req 1a2b3c · design 4d5e6f"
    },
    {
      id: "STORY-1102", kind: "story", parent: "FEAT-111", title: "连接保活与失败回显", project: "PRJ-1031", status: "completed",
      summary: "断线后保留原因与重试入口，不隐藏失败。",
      owner: "周野", cli: "claude", model: "tierflow-lite", updated: "昨天 15:10", estimate: "1.5 人日",
      acs: [{ id: "AC-01", text: "连接失败时列表显示离线与原因。", state: "passed" }],
      deps: [], tests: "4 / 4 通过", hash: "req 1a2b3c · design 7a8b9c"
    },
    {
      id: "FEAT-112", kind: "feature", parent: "EPIC-11", title: "只读巡检", project: "PRJ-1031", status: "running",
      summary: "按计划采集 CPU、内存、磁盘与日志摘要。",
      owner: "周野", updated: "今天 11:07", estimate: "4 人日", progress: 40
    },
    {
      id: "STORY-1103", kind: "story", parent: "FEAT-112", title: "巡检指标采集", project: "PRJ-1031", status: "running",
      summary: "每 5 秒采样，保留最近 24 小时。",
      owner: "周野", cli: "codex", model: "tierflow-pro", updated: "今天 11:07", estimate: "2 人日",
      acs: [
        { id: "AC-01", text: "采样失败不阻塞终端，指标显示未知。", state: "passed" },
        { id: "AC-02", text: "超过 24 小时的样本按策略清理。", state: "pending" }
      ],
      deps: ["STORY-1102"], tests: "1 / 2 通过", hash: "req 9f8e7d · design 6c5b4a"
    },
    {
      id: "STORY-1104", kind: "story", parent: "FEAT-112", title: "高风险命令逐次审批", project: "PRJ-1031", status: "blocked",
      summary: "rm -rf 等命令必须逐次确认，不能记忆放行。",
      owner: "林澈", cli: "claude", model: "tierflow-pro", updated: "11-18 10:20", estimate: "2 人日",
      acs: [{ id: "AC-01", text: "每次执行都生成独立审批记录。", state: "pending" }],
      deps: [], tests: "阻塞：审批通道未确认", hash: "req 9f8e7d · design —", blocked: "等待审批通道接入方式"
    },
    /* --- 市场研究资料 --- */
    {
      id: "EPIC-21", kind: "epic", title: "预约场景调研与结论", project: "PRJ-1018", status: "running",
      summary: "竞品对比、访谈纪要与可复用的研究结论。",
      owner: "陈雨", updated: "昨天 18:20", estimate: "2 周", progress: 64
    },
    {
      id: "FEAT-211", kind: "feature", parent: "EPIC-21", title: "竞品与访谈", project: "PRJ-1018", status: "running",
      summary: "4 款预约产品的公开信息对比与 6 位用户访谈。",
      owner: "陈雨", updated: "昨天 18:20", estimate: "3 人日", progress: 70
    },
    {
      id: "STORY-2101", kind: "story", parent: "FEAT-211", title: "竞品对比结论", project: "PRJ-1018", status: "completed",
      summary: "整理时段展示、满额提示与取消入口的共性。",
      owner: "陈雨", cli: "claude", model: "tierflow-lite", updated: "昨天 17:05", estimate: "1 人日",
      acs: [{ id: "AC-01", text: "每款产品给出可核对的来源与观察日期。", state: "passed" }],
      deps: [], tests: "2 / 2 通过", hash: "req 3c4d5e · design 8f9a0b"
    },
    {
      id: "STORY-2102", kind: "story", parent: "FEAT-211", title: "访谈纪要整理", project: "PRJ-1018", status: "pending",
      summary: "匿名化处理参与者信息，保留原话与结论。",
      owner: "陈雨", cli: "claude", model: "tierflow-lite", updated: "昨天 11:32", estimate: "1 人日",
      acs: [{ id: "AC-01", text: "纪要中不出现真实姓名与联系方式。", state: "passed" }],
      deps: [], tests: "待验收", hash: "req 3c4d5e · design 8f9a0b"
    },
    {
      id: "STORY-2103", kind: "story", parent: "FEAT-211", title: "研究结论与边界", project: "PRJ-1018", status: "ready",
      summary: "明确样本量与不可外推的范围，避免把结论当承诺。",
      owner: "陈雨", cli: "claude", model: "tierflow-lite", updated: "11-18 16:10", estimate: "0.5 人日",
      acs: [{ id: "AC-01", text: "结论页标注样本量与未验证项。", state: "pending" }],
      deps: ["STORY-2101"], tests: "未执行", hash: "req 3c4d5e · design —"
    },
    /* --- 品牌与官网 --- */
    {
      id: "EPIC-31", kind: "epic", title: "品牌与官网落地", project: "PRJ-1009", status: "completed",
      summary: "命名、图形标志与官网信息架构。",
      owner: "陈雨", updated: "11-17 16:44", estimate: "2 周", progress: 100
    },
    {
      id: "FEAT-311", kind: "feature", parent: "EPIC-31", title: "标志与命名", project: "PRJ-1009", status: "completed",
      summary: "中英文名称与图形标志定稿。",
      owner: "陈雨", updated: "11-17 16:44", estimate: "2 人日", progress: 100
    },
    {
      id: "STORY-3101", kind: "story", parent: "FEAT-311", title: "图形标志定稿", project: "PRJ-1009", status: "completed",
      summary: "确定青绿帆船图形与浅色底的处理。",
      owner: "陈雨", cli: "claude", model: "tierflow-lite", updated: "11-17 16:44", estimate: "1 人日",
      acs: [{ id: "AC-01", text: "浅色与深色下轮廓清晰可辨。", state: "passed" }],
      deps: [], tests: "通过", hash: "req 5e6f7a · design 9b0c1d"
    },
    {
      id: "STORY-3102", kind: "story", parent: "FEAT-311", title: "官网信息架构", project: "PRJ-1009", status: "completed",
      summary: "首页、能力、定价与文档四段结构。",
      owner: "陈雨", cli: "claude", model: "tierflow-lite", updated: "11-17 14:20", estimate: "1 人日",
      acs: [{ id: "AC-01", text: "首屏可直接到达文档与试用入口。", state: "passed" }],
      deps: [], tests: "通过", hash: "req 5e6f7a · design 9b0c1d"
    }
  ];

  const tasks = [
    /* CR-039：一次派发 = 一棵树。根为协调者，子为各 CLI 工作代理；role/parentId 是树结构唯一来源。 */
    {
      id: "RUN-2095", role: "coordinator", parentId: null,
      title: "时段容量与库存校验", story: "STORY-0102", project: "PRJ-1042",
      status: "running", cli: "claude", model: "tierflow-pro", branch: "—",
      started: "14:18", duration: "14 分钟", progress: 58, round: 1,
      mission: "拆分 STORY-0102，按能力派发给实现、用例与审查，回收结果后判断是否够格交付",
      steps: [
        { name: "读取需求", state: "done", time: "14:18" },
        { name: "拆分派发", state: "done", time: "14:20" },
        { name: "回收结果", state: "active", time: "14:26" },
        { name: "技术审查", state: "todo", time: "—" },
        { name: "交付", state: "todo", time: "—" }
      ],
      artifacts: [],
      logs: [
        ["14:18", "读取 STORY-0102、FEAT-011 与预约接口约定"],
        ["14:20", "拆分 3 项子工作：容量事务、并发用例、差异审查"],
        ["14:21", "派发 codex 处理容量事务边界"],
        ["14:24", "派发 claude 补充并发失败用例"],
        ["14:31", "答复 codex 提问：错误码沿用 AC-02 的 capacity_exceeded"],
        ["14:32", "等待 dsh 的差异审查结果"]
      ],
      usage: { tokens: "9.4K", cost: "¥0.29", commands: 3, files: 0 }
    },
    {
      id: "RUN-2096", role: "worker", parentId: "RUN-2095",
      title: "容量扣减加事务边界", story: "STORY-0102", project: "PRJ-1042",
      status: "running", cli: "codex", model: "tierflow-codex", branch: "agent/story-0102-capacity",
      started: "14:21", duration: "11 分钟", progress: 72, round: 1,
      mission: "把容量扣减与预约写入放进同一事务，失败时不占名额",
      steps: [
        { name: "准备", state: "done", time: "14:21" },
        { name: "实现", state: "active", time: "14:24" },
        { name: "验证", state: "todo", time: "—" },
        { name: "交付", state: "todo", time: "—" }
      ],
      artifacts: [{ name: "src/booking/capacity.ts", change: "+128 −0", state: "新增" }],
      logs: [
        ["14:22", "读取 STORY-0102 与接口约定（10 段）"],
        ["14:25", "提问：满额错误码用哪个？"],
        ["14:31", "收到答复：capacity_exceeded，继续实现"],
        ["14:32", "写入事务边界，运行 pnpm test capacity"]
      ],
      usage: { tokens: "22.6K", cost: "¥0.71", commands: 9, files: 1 }
    },
    {
      id: "RUN-2097", role: "worker", parentId: "RUN-2095",
      title: "并发失败用例", story: "STORY-0102", project: "PRJ-1042",
      status: "verifying", cli: "claude", model: "tierflow-lite", branch: "agent/story-0102-tests",
      started: "14:24", duration: "8 分钟", progress: 90, round: 1,
      mission: "补 10 并发下的满额用例，证明 AC-02 的并发失败提示",
      steps: [
        { name: "准备", state: "done", time: "14:24" },
        { name: "实现", state: "done", time: "14:28" },
        { name: "验证", state: "active", time: "14:30" },
        { name: "交付", state: "todo", time: "—" }
      ],
      artifacts: [{ name: "tests/capacity-concurrent.spec.ts", change: "+64 −0", state: "新增" }],
      logs: [
        ["14:28", "编写 10 并发用例，断言仅 5 个名额成功"],
        ["14:30", "运行 pnpm test capacity-concurrent（4 passed）"]
      ],
      usage: { tokens: "14.1K", cost: "¥0.44", commands: 6, files: 1 }
    },
    {
      id: "RUN-2098", role: "worker", parentId: "RUN-2095",
      title: "差异与凭证审查", story: "STORY-0102", project: "PRJ-1042",
      status: "waiting", cli: "dsh", model: "沿用主代理模型", branch: "—",
      started: "—", duration: "未开始", progress: 0, round: 0,
      mission: "审查合并前差异是否越界、是否含凭证，输出只读结论",
      reason: "等待 RUN-2096 产出候选修订",
      steps: [
        { name: "准备", state: "todo", time: "—" },
        { name: "审查", state: "todo", time: "—" },
        { name: "交付", state: "todo", time: "—" }
      ],
      artifacts: [],
      logs: [["14:26", "进入等待：缺少可消费的候选产物"]],
      usage: { tokens: "0", cost: "¥0.00", commands: 0, files: 0 }
    },
    {
      id: "RUN-2087", title: "时段容量与库存校验（单层派发）", story: "STORY-0102", project: "PRJ-1042",
      status: "running", cli: "codex", model: "tierflow-pro", branch: "agent/story-0102",
      started: "14:21", duration: "11 分钟", progress: 64, round: 2,
      steps: [
        { name: "准备", state: "done", time: "14:21" },
        { name: "实现", state: "active", time: "14:22" },
        { name: "验证", state: "todo", time: "—" },
        { name: "评审", state: "todo", time: "—" },
        { name: "交付", state: "todo", time: "—" }
      ],
      artifacts: [
        { name: "src/booking/capacity.ts", change: "+128 −0", state: "新增" },
        { name: "tests/capacity.spec.ts", change: "+86 −0", state: "新增" }
      ],
      logs: [
        ["14:22", "读取 STORY-0102 与预约接口约定（10 段）"],
        ["14:23", "定位 booking/slot.ts：容量扣减缺少事务边界"],
        ["14:24", "编辑 src/booking/capacity.ts"],
        ["14:31", "运行 pnpm test capacity（3 passed）"],
        ["14:32", "等待验证：AC-02 并发失败提示未覆盖"]
      ],
      usage: { tokens: "38.2K", cost: "¥1.18", commands: 14, files: 2 }
    },
    {
      id: "RUN-2086", role: "coordinator", parentId: null, title: "幂等下单与重复请求", story: "STORY-0103", project: "PRJ-1042",
      status: "pending", cli: "codex", model: "tierflow-pro", branch: "agent/story-0103",
      started: "13:02", duration: "26 分钟", progress: 100, round: 1,
      mission: "协调者直接完成，无下派：实现幂等键存储并自证 AC",
      steps: [
        { name: "准备", state: "done", time: "13:02" },
        { name: "实现", state: "done", time: "13:05" },
        { name: "验证", state: "done", time: "13:19" },
        { name: "评审", state: "done", time: "13:26" },
        { name: "交付", state: "done", time: "13:28" }
      ],
      artifacts: [
        { name: "src/booking/idempotency.ts", change: "+96 −4", state: "修改" },
        { name: "src/booking/service.ts", change: "+41 −12", state: "修改" },
        { name: "tests/idempotency.spec.ts", change: "+74 −0", state: "新增" }
      ],
      logs: [
        ["13:05", "实现幂等键存储与 24 小时窗口"],
        ["13:19", "pnpm test idempotency：5 passed"],
        ["13:26", "评审通过：无凭证落盘、错误码一致"],
        ["13:28", "交付待验收：产物 revision r3"]
      ],
      usage: { tokens: "52.6K", cost: "¥1.62", commands: 21, files: 3 }
    },
    {
      id: "RUN-2085", title: "满额拒绝与可读提示", story: "STORY-0104", project: "PRJ-1042",
      status: "waiting", cli: "claude", model: "tierflow-lite", branch: "—",
      started: "—", duration: "18 分钟", progress: 0, round: 0,
      reason: "前置 RUN-2087 尚未产出已验证的容量错误码",
      steps: [
        { name: "准备", state: "todo", time: "—" },
        { name: "实现", state: "todo", time: "—" },
        { name: "验证", state: "todo", time: "—" },
        { name: "评审", state: "todo", time: "—" },
        { name: "交付", state: "todo", time: "—" }
      ],
      artifacts: [], logs: [["14:14", "进入等待队列：依赖 RUN-2087 的产物 revision"]],
      usage: { tokens: "0", cost: "¥0.00", commands: 0, files: 0 }
    },
    {
      id: "RUN-2084", title: "时段占用看板", story: "STORY-0301", project: "PRJ-1042",
      status: "verifying", cli: "codex", model: "tierflow-pro", branch: "agent/story-0301",
      started: "11:40", duration: "22 分钟", progress: 88, round: 1,
      steps: [
        { name: "准备", state: "done", time: "11:40" },
        { name: "实现", state: "done", time: "11:44" },
        { name: "验证", state: "active", time: "11:58" },
        { name: "评审", state: "todo", time: "—" },
        { name: "交付", state: "todo", time: "—" }
      ],
      artifacts: [
        { name: "src/web/OccupancyBoard.tsx", change: "+164 −0", state: "新增" },
        { name: "src/web/occupancy.css", change: "+72 −6", state: "修改" }
      ],
      logs: [
        ["11:58", "运行 npm run test:e2e -- occupancy（2 passed）"],
        ["12:01", "窄屏用例失败：列 320px 被压缩"],
        ["12:02", "修正 min-width 后重新验证"]
      ],
      usage: { tokens: "44.1K", cost: "¥1.34", commands: 18, files: 2 }
    },
    {
      id: "RUN-2083", title: "只读运营角色", story: "STORY-0401", project: "PRJ-1042",
      status: "succeeded", cli: "claude", model: "tierflow-lite", branch: "agent/story-0401",
      started: "10:12", duration: "9 分钟", progress: 100, round: 1,
      steps: [
        { name: "准备", state: "done", time: "10:12" },
        { name: "实现", state: "done", time: "10:14" },
        { name: "验证", state: "done", time: "10:18" },
        { name: "评审", state: "done", time: "10:20" },
        { name: "交付", state: "done", time: "10:21" }
      ],
      artifacts: [
        { name: "src/auth/roles.ts", change: "+58 −3", state: "修改" },
        { name: "tests/roles.spec.ts", change: "+40 −0", state: "新增" }
      ],
      logs: [["10:21", "交付完成：4/4 AC 通过"]],
      usage: { tokens: "21.9K", cost: "¥0.68", commands: 8, files: 2 }
    },
    {
      id: "RUN-2082", title: "取消预约与名额回补", story: "STORY-0105", project: "PRJ-1042",
      status: "failed", cli: "claude", model: "tierflow-pro", branch: "agent/story-0105",
      started: "09:36", duration: "7 分钟", progress: 42, round: 1,
      reason: "模型端点 502；已保留日志，等待原运行重试",
      steps: [
        { name: "准备", state: "done", time: "09:36" },
        { name: "实现", state: "failed", time: "09:39" },
        { name: "验证", state: "todo", time: "—" },
        { name: "评审", state: "todo", time: "—" },
        { name: "交付", state: "todo", time: "—" }
      ],
      artifacts: [], logs: [
        ["09:39", "调用模型失败：502 upstream reset"],
        ["09:39", "未产生文件变更；工作区保留"]
      ],
      usage: { tokens: "6.4K", cost: "¥0.19", commands: 2, files: 0 }
    },
    {
      id: "RUN-2091", title: "巡检指标采集", story: "STORY-1103", project: "PRJ-1031",
      status: "running", cli: "codex", model: "tierflow-pro", branch: "agent/story-1103",
      started: "11:02", duration: "5 分钟", progress: 37, round: 1,
      steps: [
        { name: "准备", state: "done", time: "11:02" },
        { name: "实现", state: "active", time: "11:03" },
        { name: "验证", state: "todo", time: "—" },
        { name: "评审", state: "todo", time: "—" },
        { name: "交付", state: "todo", time: "—" }
      ],
      artifacts: [{ name: "src/metrics/sampler.ts", change: "+74 −0", state: "新增" }],
      logs: [["11:03", "读取 STORY-1103 与巡检白名单"], ["11:05", "实现 5 秒采样，写入环形缓冲"]],
      usage: { tokens: "12.8K", cost: "¥0.41", commands: 5, files: 1 }
    }
  ];

  const design = {
    prd: {
      name: "PRD-预约服务.md", updated: "今天 09:40", version: "v1.4",
      body: `# PRD：社区活动预约服务

## 1. 背景与目标
社区活动以时段为单位开放名额。参与者需要在移动端与桌面端完成预约，运营需要掌握占用情况。本版本只解决「按时段预约 + 满额拒绝 + 取消回补」，不包含支付、签到与实名核验。

## 2. 范围
- 活动详情与时段选择
- 提交预约（幂等）
- 满额拒绝与可读提示
- 取消预约与名额回补
- 运营只读看板与 CSV 导出

不做：付款、短信、真实邮件、生产发布。

## 3. 关键规则
1. 同一幂等键 24 小时内返回同一结果。
2. 容量扣减与预约写入在同一事务内完成。
3. 重复取消不重复归还名额。
4. 只读角色调用写接口返回 403 并记录审计。

## 4. 验收
逐条映射到 STORY-0101～0105、STORY-0301～0302 的可观察 AC；以当前冻结修订为准。`
    },
    ui: {
      name: "UI-预约主流程.md", updated: "今天 10:05", version: "v3",
      body: `# UI：预约主流程

## 页面
1. 活动详情：标题、时间、地点、剩余名额。
2. 时段选择：按日期分组，容量标签「余 1」。
3. 预约确认：参加者信息 + 取消政策。
4. 结果页：成功 / 满额 / 网络失败三种状态。

## 状态覆盖
- 加载：骨架屏，保留页头。
- 空数据：活动未开放时段。
- 满额：禁用提交，说明下一次开放时间。
- 并发失败：提示稍后重试，不展示内部堆栈。

## 视觉约束
沿用白底、浅灰分层、蓝色主操作；列表行高 48；不使用大面积渐变。`
    },
    lld: {
      name: "方案-容量与幂等.md", updated: "昨天 19:12", version: "v2",
      body: `# 方案：容量与幂等

## 容量扣减
使用 SQLite 事务 + 条件更新：

\`\`\`sql
UPDATE slots SET remaining = remaining - 1
WHERE id = ? AND remaining > 0;
\`\`\`

受影响行数为 0 时返回 SLOT_FULL，不进入预约写入。

## 幂等
booking_request 表以 (user_id, idempotency_key) 唯一索引；命中则返回原始响应快照，24 小时后允许复用。

## 失败处理
- 事务失败：回滚并返回 RETRYABLE。
- 网络超时：客户端可安全重试同一幂等键。
- 重复取消：返回当前状态，不重复回补。`
    },
    db: {
      name: "数据库-预约.md", updated: "昨天 18:48", version: "v2",
      body: `# 数据库设计

## booking
| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK | 预约主键 |
| activity_id | TEXT | NOT NULL | 活动编号 |
| slot_id | TEXT | NOT NULL | 时段编号 |
| user_id | TEXT | NOT NULL | 预约人 |
| status | TEXT | confirmed / cancelled | 当前状态 |
| created_at | TEXT | NOT NULL | ISO 时间 |

## slot
| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | TEXT | PK | 时段编号 |
| capacity | INTEGER | >= 0 | 总容量 |
| remaining | INTEGER | >= 0 | 剩余名额 |

## booking_request
| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| user_id | TEXT | 唯一(user_id,key) | 预约人 |
| idempotency_key | TEXT | 唯一(user_id,key) | 幂等键 |
| response | TEXT | NOT NULL | 首次响应快照 |
| expires_at | TEXT | NOT NULL | 保留窗口 |

索引：slot(activity_id, starts_at)、booking(slot_id, status)、booking_request(expires_at)。`
    },
    /* UI-CR073（用户第 9 项）：HTML 设计稿以页面预览呈现，不再默认显示源码。
       本样例为自包含静态页面，无脚本、无外部资源，可在沙箱 iframe 内完整渲染。 */
    html: {
      name: "UI-预约主流程原型.html", updated: "今天 10:20", version: "v3",
      body: `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>预约主流程 · 设计预览</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; font: 14px/1.7 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: #1f2937; background: #fff; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #6b7280; font-size: 12px; margin: 0 0 20px; }
  .flow { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
  .step { border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px; }
  .step b { display: block; font-size: 13px; margin-bottom: 6px; }
  .step span { color: #6b7280; font-size: 12px; }
  .tag { display: inline-block; padding: 1px 8px; border-radius: 999px; background: #eaf1ff; color: #2b6cf6; font-size: 11px; }
  .state { margin-top: 20px; padding: 12px 14px; border-radius: 10px; background: #f8fafc; font-size: 12px; color: #475569; }
  button { margin-top: 12px; padding: 7px 16px; border: 0; border-radius: 8px; background: #2b6cf6; color: #fff; font-size: 13px; cursor: pointer; }
  button[disabled] { background: #cbd5e1; cursor: not-allowed; }
</style></head>
<body>
  <h1>预约主流程</h1>
  <p class="sub">设计稿内嵌样例 · 用于验证「设计页显示页面效果而不是源码」</p>
  <div class="flow">
    <div class="step"><b>1 活动详情</b><span>标题、时间、地点、剩余名额。</span></div>
    <div class="step"><b>2 时段选择</b><span>按日期分组，容量标签「余 1」。</span></div>
    <div class="step"><b>3 预约确认</b><span>参加者信息 + 取消政策。</span></div>
    <div class="step"><b>4 结果页</b><span>成功 / 满额 / 网络失败三种状态。</span></div>
  </div>
  <div class="state"><span class="tag">满额</span> 提交按钮禁用，说明下一次开放时间；不展示内部堆栈。</div>
  <button disabled>确认预约</button>
</body></html>`
    }
  };

  const files = {
    "README.md": `# 预约服务（DEMO）

社区活动预约的仿真仓库。真实代码与运行能力未接入本原型。

## 开发

    pnpm install
    pnpm test
    pnpm dev

## 结构

- src/booking     容量、幂等与预约主流程
- src/web         活动页、时段选择与看板
- tests           单元与端到端用例
- docs/adr        关键决策记录
`,
    "src/booking/service.ts": `import { db } from "../db";
import { reserveCapacity, releaseCapacity } from "./capacity";
import { readIdempotency, writeIdempotency } from "./idempotency";

export type BookingResult =
  | { ok: true; bookingId: string; remaining: number }
  | { ok: false; code: "SLOT_FULL" | "RETRYABLE" | "DUPLICATE" };

export async function createBooking(input: CreateBookingInput): Promise<BookingResult> {
  const cached = await readIdempotency(input.userId, input.idempotencyKey);
  if (cached) return cached;

  return db.transaction(async (tx) => {
    const reserved = await reserveCapacity(tx, input.slotId);
    if (reserved === 0) return { ok: false, code: "SLOT_FULL" };

    const bookingId = await tx.insert("booking", {
      activity_id: input.activityId,
      slot_id: input.slotId,
      user_id: input.userId,
      status: "confirmed"
    });

    const result = { ok: true as const, bookingId, remaining: reserved - 1 };
    await writeIdempotency(tx, input.userId, input.idempotencyKey, result);
    return result;
  });
}

export async function cancelBooking(bookingId: string) {
  return db.transaction(async (tx) => {
    const booking = await tx.get("booking", bookingId);
    if (!booking || booking.status === "cancelled") return booking;

    await tx.update("booking", bookingId, { status: "cancelled" });
    await releaseCapacity(tx, booking.slot_id);
    return { ...booking, status: "cancelled" };
  });
}
`,
    "src/booking/capacity.ts": `import type { Tx } from "../db";

/** 原子扣减；返回扣减后的剩余名额，0 表示满额。 */
export async function reserveCapacity(tx: Tx, slotId: string): Promise<number> {
  const updated = await tx.run(
    "UPDATE slot SET remaining = remaining - 1 WHERE id = ? AND remaining > 0",
    [slotId]
  );
  if (updated.changes === 0) return 0;

  const slot = await tx.get("slot", slotId);
  return slot.remaining;
}

export async function releaseCapacity(tx: Tx, slotId: string): Promise<void> {
  await tx.run("UPDATE slot SET remaining = remaining + 1 WHERE id = ? AND remaining < capacity", [slotId]);
}
`,
    "src/web/BookingForm.tsx": `export function BookingForm({ slot }: { slot: Slot }) {
  const [state, setState] = useState<"idle" | "submitting" | "full" | "error">("idle");
  const soldOut = slot.remaining <= 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setState("submitting");
    const result = await api.createBooking({
      activityId: slot.activityId,
      slotId: slot.id,
      idempotencyKey: keyForCurrentAttempt()
    });
    if (result.ok) return location.assign("/booking/" + result.bookingId);
    setState(result.code === "SLOT_FULL" ? "full" : "error");
  }

  return (
    <form onSubmit={submit} className="booking-form">
      <SlotSummary slot={slot} />
      {soldOut || state === "full" ? (
        <p className="notice">该时段已满，可切换到其他时段。</p>
      ) : (
        <button type="submit" disabled={state === "submitting"}>
          {state === "submitting" ? "提交中…" : "确认预约"}
        </button>
      )}
      {state === "error" && <p className="error">网络繁忙，请稍后重试。</p>}
    </form>
  );
}
`,
    "tests/capacity.spec.ts": `import { describe, expect, it } from "vitest";
import { createBooking } from "../src/booking/service";

describe("容量", () => {
  it("并发 20 次抢 2 个名额，成功数不超过 2", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        createBooking({ activityId: "A1", slotId: "S1", userId: "u" + i, idempotencyKey: "k" + i })
      )
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
  });

  it("满额返回 SLOT_FULL 且不扣减", async () => {
    await createBooking({ activityId: "A1", slotId: "S1", userId: "u0", idempotencyKey: "k0" });
    const again = await createBooking({ activityId: "A1", slotId: "S1", userId: "u1", idempotencyKey: "k1" });
    expect(again).toMatchObject({ ok: false, code: "SLOT_FULL" });
  });
});
`,
    "docs/adr/001-idempotency.md": `# ADR-001 幂等键与响应快照

## 决策
以 (user_id, idempotency_key) 唯一索引保存首次响应快照，保留 24 小时。

## 理由
重复请求多来自网络重试与双击；快照可保证响应完全一致，包括创建时间。

## 代价
需要定期清理过期行；响应体较大时占用额外存储。

## 备选
- 只记录 booking_id：响应细节可能变化，不满足 AC-01。
- 依赖前端防抖：无法覆盖网络重试。
`
  };

  /* CR-067：Git 面板样例按参考图补齐——仓库路径、本地/远程分支树、带父提交的提交图谱、
     提交人/分支/时间筛选、ai 侧状态。全部为合成夹具，不对应真实仓库。 */
  const git = {
    repoPath: "D:\\github\\AI_Delelovelop",
    branch: "feature/booking-idempotency",
    base: "main",
    ahead: 3,
    behind: 0,
    upstream: "origin/feature/booking-idempotency",
    accel: { on: true, url: "https://gh-proxy.com/" },
    credentialHosts: [{ host: "github.com", user: "oauth2", savedAt: "2026-11-21" }],
    changes: [
      { file: "src/booking/service.ts", state: "M", add: 41, del: 12, staged: true },
      { file: "src/booking/idempotency.ts", state: "A", add: 96, del: 0, staged: true },
      { file: "src/web/BookingForm.tsx", state: "M", add: 18, del: 6, staged: false },
      { file: "tests/idempotency.spec.ts", state: "A", add: 74, del: 0, staged: false },
      { file: "docs/adr/001-idempotency.md", state: "M", add: 12, del: 2, staged: false }
    ],
    /* 本地/远程分支树：当前分支带 ↑↓ 轨道数，远程按 remote 分组。 */
    branches: {
      locals: [
        { name: "feature/booking-idempotency", current: true, ahead: 3, behind: 0 },
        { name: "main", current: false, ahead: 0, behind: 0 },
        { name: "fix/capacity-race", current: false, ahead: 1, behind: 2 }
      ],
      remotes: [
        { remote: "origin", branches: [
          { name: "origin/feature/booking-idempotency", short: "feature/booking-idempotency", ahead: 3, behind: 0 },
          { name: "origin/main", short: "main", ahead: 0, behind: 0 },
          { name: "origin/fix/capacity-race", short: "fix/capacity-race", ahead: 1, behind: 2 }
        ] }
      ]
    },
    /* 提交带 parents，用于图谱车道；refs 区分 HEAD / tag / 远程 / 本地。 */
    commits: [
      { sha: "a1f7c2d", msg: "feat(booking): 幂等键与响应快照", author: "周野", time: "2026/11/22 13:26", parents: ["9d04b18"], refs: ["HEAD -> main", "origin/main", "origin/HEAD"] },
      { sha: "9d04b18", msg: "test(booking): 满额与并发用例", author: "周野", time: "2026/11/22 12:48", parents: ["3c9e510"], refs: ["tag: v0.2.0"] },
      { sha: "3c9e510", msg: "refactor: 容量扣减改为条件更新", author: "林澈", time: "2026/11/21 19:02", parents: ["b27d401", "8e5c1a3"], refs: [] },
      { sha: "b27d401", msg: "Merge origin/main into feat/booking-idempotency", author: "林澈", time: "2026/11/21 18:40", parents: ["c04a8e2", "77b2f10"], refs: ["origin/feat/booking-idempotency"] },
      { sha: "c04a8e2", msg: "docs(adr): 记录幂等键取舍与回滚", author: "周野", time: "2026/11/21 16:12", parents: ["77b2f10"], refs: [] },
      { sha: "77b2f10", msg: "chore: 升级依赖并同步锁文件", author: "林澈", time: "2026/11/21 10:05", parents: ["5a1c9d0"], refs: [] },
      { sha: "5a1c9d0", msg: "feat(booking): 预约表单校验与提交", author: "周野", time: "2026/11/20 21:30", parents: [], refs: ["tag: v0.1.0"] }
    ],
    commitFiles: {
      "a1f7c2d": [
        { path: "src/booking/service.ts", state: "M", add: 41, del: 12 },
        { path: "src/booking/idempotency.ts", state: "A", add: 96, del: 0 }
      ],
      "9d04b18": [
        { path: "tests/idempotency.spec.ts", state: "A", add: 74, del: 0 }
      ]
    },
    remoteManager: [
      { name: "origin", url: "https://github.com/GaoHu1997/NestCraft.git" },
      { name: "upstream", url: "https://github.com/example/nestcraft.git" }
    ],
    diff: `@@ -38,12 +38,24 @@ export async function createBooking(input: CreateBookingInput) {
-  const bookingId = await tx.insert("booking", {
-    activity_id: input.activityId,
-    slot_id: input.slotId,
-    user_id: input.userId,
-    status: "confirmed"
-  });
-  return { ok: true, bookingId };
+  const cached = await readIdempotency(input.userId, input.idempotencyKey);
+  if (cached) return cached;
+
+  return db.transaction(async (tx) => {
+    const reserved = await reserveCapacity(tx, input.slotId);
+    if (reserved === 0) return { ok: false, code: "SLOT_FULL" };
+
+    const bookingId = await tx.insert("booking", {
+      activity_id: input.activityId,
+      slot_id: input.slotId,
+      user_id: input.userId,
+      status: "confirmed"
+    });
+
+    const result = { ok: true as const, bookingId, remaining: reserved - 1 };
+    await writeIdempotency(tx, input.userId, input.idempotencyKey, result);
+    return result;
+  });`
  };

  const office = {
    "PRJ-1018": [
      {
        name: "竞品对比-预约产品.md", updated: "昨天 17:05",
        body: `# 预约类产品对比

## 样本
4 款公开可访问的预约工具，观察日期 2026-11-17。

## 观察
1. 时段卡片同时显示剩余与下次开放，减少无效点击。
2. 满额后仍保留活动信息与替代时段。
3. 取消入口在结果页与站内信中重复出现。
4. 并发失败提示可重试，不暴露内部错误。

## 边界
仅公开页面观察，未注册、未采集用户数据；样本量小，结论不外推为行业结论。`
      },
      {
        name: "访谈纪要-组织者.md", updated: "昨天 11:32",
        body: `# 访谈纪要 · 组织者（匿名）

## 场景
社区活动每周 2 场，每场 20 个名额，使用表格手工登记。

## 原话摘录
- 「满了我还要一个个回，最怕重复报名。」
- 「取消的人如果不说，我就不知道名额空出来了。」

## 结论
- 需要自动满额拒绝与名额回补。
- 组织者需要一眼看到剩余名额。

## 脱敏
姓名、联系方式与具体社区已移除；纪要仅用于内部研究。`
      },
      {
        name: "研究结论-v2.md", updated: "11-18 16:10",
        body: `# 研究结论 v2

## 可落地
1. 时段卡片展示「剩余 / 下次开放」。
2. 满额拒绝与取消回补必须原子化。
3. 取消入口在两处重复出现。

## 未验证
- 真实并发下的超卖概率。
- 通知到达率与延迟。

## 建议
先实现主流程与幂等，再评估通知通道。`
      }
    ],
    "PRJ-1009": [
      {
        name: "品牌定稿说明.md", updated: "11-17 16:44",
        body: `# 品牌定稿说明

## 名称
中文「栖造」，英文「NestCraft」。

## 图形
青绿色帆船，浅色底使用深青描边，深色底使用浅青填充。

## 使用
最小尺寸 24px；不拉伸、不叠加渐变；单色场景使用纯色版本。`
      },
      {
        name: "官网信息架构.md", updated: "11-17 14:20",
        body: `# 官网信息架构

1. 首页：一句话定位 + 主操作
2. 能力：任务闭环、知识授权、服务器运维
3. 文档：快速开始、概念、参考
4. 定价与试用

首屏必须能直接到达文档与试用入口；不使用轮播。`
      }
    ]
  };

  const knowledge = {
    libraries: [
      {
        id: "KB-01", name: "研发手册", desc: "交付流程、接口约定与评审标准", docs: 7, updated: "今天 09:20",
        granted: true, owner: "林澈", tone: "blue"
      },
      {
        id: "KB-02", name: "竞品与用户研究", desc: "预约类产品的对比、访谈纪要与结论", docs: 5, updated: "昨天 17:05",
        granted: true, owner: "陈雨", tone: "amber"
      },
      {
        id: "KB-03", name: "运维手册", desc: "主机巡检、发布与回滚步骤", docs: 15, updated: "11-18 14:12",
        granted: false, owner: "周野", tone: "violet"
      }
    ],
    docs: {
      "KB-01": [
        { id: "KD-011", title: "研发交付指南", path: "流程/交付.md", updated: "今天 09:20", size: "4.2 KB" },
        { id: "KD-012", title: "预约接口约定", path: "接口/预约.md", updated: "今天 08:41", size: "6.8 KB" },
        { id: "KD-013", title: "评审清单", path: "流程/评审.md", updated: "昨天 16:02", size: "3.1 KB" },
        { id: "KD-014", title: "发布与回滚", path: "发布/步骤.md", updated: "11-17 15:20", size: "5.4 KB" },
        { id: "KD-015", title: "发布检查表", path: "发布/检查表.md", updated: "11-16 10:10", size: "2.6 KB" },
        { id: "KD-016", title: "常见故障与恢复", path: "运维/故障.md", updated: "11-15 17:40", size: "4.8 KB" },
        { id: "KD-017", title: "术语表", path: "概念/术语.md", updated: "11-14 09:30", size: "2.2 KB" }
      ],
      "KB-02": [
        { id: "KD-021", title: "预约类产品对比", path: "对比/预约.md", updated: "昨天 17:05", size: "7.6 KB" },
        { id: "KD-022", title: "访谈纪要 · 组织者", path: "访谈/组织者-01.md", updated: "昨天 11:32", size: "3.9 KB" },
        { id: "KD-023", title: "访谈纪要 · 参与者", path: "访谈/参与者-02.md", updated: "11-18 18:10", size: "4.4 KB" },
        { id: "KD-024", title: "研究结论 v2", path: "结论/研究.md", updated: "11-18 16:10", size: "3.2 KB" },
        { id: "KD-025", title: "样本与限制", path: "结论/限制.md", updated: "11-18 15:02", size: "1.8 KB" }
      ],
      "KB-03": []
    },
    content: {
      "KD-011": `# 研发交付指南

## 1. 派发前
确认需求已确认、设计已同步、AC 可观察。预检会列出范围、依赖与共享资源，确认后一次派发。

## 2. 执行中
- 一个 Story 同一时间只运行一个 Run。
- 失败保留原记录，重试必须基于原 Run。
- 高风险命令逐次审批，不因「之前允许过」自动放行。

## 3. 交付
技术交付成功不等于验收。交付包需要列出冻结范围、逐条 AC 结果、失败尝试与恢复办法。

## 4. 终止
取消与失败都不会释放后代依赖；需要显式重新确认范围。
`,
      "KD-012": `# 预约接口约定

## 请求

    POST /demo/bookings
    {
      "activityId": "DEMO-ACTIVITY-01",
      "slotId": "DEMO-SLOT-01",
      "attendeeEmail": "visitor@example.invalid",
      "idempotencyKey": "DEMO-REQUEST-01"
    }

## 响应

    { "bookingId": "DEMO-BOOKING-001", "status": "confirmed", "remaining": 0 }

## 规则
1. 同一幂等键返回同一 bookingId。
2. 容量为 0 时返回 SLOT_FULL，不创建预约。
3. 取消只改变状态并归还一次名额。
4. 只读角色写请求返回 403。

## 未实测
真实并发、延迟、token 与费用均未知；本页为设计夹具。
`,
      "KD-013": `# 评审清单

- [ ] 需求与设计修订已冻结
- [ ] AC 有当前有效的验证证据
- [ ] 没有凭证、个人敏感信息进入日志
- [ ] 失败与未知如实标注
- [ ] 界面变更与设计稿同条件对照
- [ ] 未授权范围没有被顺手修改

评审通过只说明技术证据有效，不代表用户验收。
`,
      "KD-021": `# 预约类产品对比
## 观察范围
覆盖 4 款预约工具的活动页、时段选择与取消流程，只看公开信息，不采集真实用户数据。

## 结论
1. 时段卡片需要同时显示「剩余」与「下一次开放」，减少无效点击。
2. 满额后仍保留活动信息，避免用户迷路。
3. 取消入口在结果页与站内信中重复出现，降低找不到的概率。
4. 并发失败提示必须可重试，且不暴露内部错误。

## 风险
样本量小，结论需在真实流量中复核；当前不构成发布承诺。
`,
      "KD-015": `# 发布检查表

## 发布前
- [ ] 变更范围与版本号已确认
- [ ] 回滚路径与负责人明确
- [ ] 数据库迁移已在样例库演练
- [ ] 监控与告警阈值已确认

## 发布中
- [ ] 按批次发布，每批留观察窗口
- [ ] 错误率与延迟在阈值内

## 发布后
- [ ] 核心路径冒烟通过
- [ ] 记录实际版本、时间与执行人

本表只用于演示，未连接真实发布系统。
`,
      "KD-016": `# 常见故障与恢复

## 模型端点 502
保留原运行记录，检查端点健康后从原 Run 重试；不要新建 Run 覆盖证据。

## 数据库锁等待
确认是否有长事务；不要直接重启进程，先保留现场。

## 终端命令被拒绝
高风险命令需要逐次审批；白名单之外一律拒绝并记录。

## 恢复原则
先止损，再定位，最后才修复；任何恢复动作都要留下可核对的记录。
`,
      "KD-017": `# 术语表

- **Run**：一次任务执行记录；失败保留，重试基于原 Run。
- **Story**：可独立交付与验收的用户价值单元。
- **AC**：可观察的验收标准。
- **预检**：派发前对范围、依赖、资源与配置的检查。
- **设计同步**：把当前设计修订绑定到需求，未同步不得开发。
- **技术交付**：实现与验证完成；不等于用户验收。
`,
      "KD-024": `# 研究结论 v2

## 可落地
1. 时段卡片展示「剩余 / 下次开放」。
2. 满额拒绝与取消回补必须原子化。
3. 取消入口在两处重复出现。

## 未验证
- 真实并发下的超卖概率。
- 通知到达率与延迟。

## 建议
先完成主流程与幂等，再评估通知通道；结论需在真实流量中复核。
`,
      "KD-025": `# 样本与限制

## 样本
- 4 款产品公开页面
- 6 位用户访谈（3 位组织者、3 位参与者）
- 观察窗口：2026-11-10 ～ 2026-11-18

## 限制
- 未覆盖付费档位与大型活动
- 访谈为便利样本，不代表整体人群
- 指标为自报，未做行为埋点验证

## 使用
可作为设计依据的一部分，不作为效果承诺。
`
    }
  };

  const servers = [
    {
      id: "SRV-01", name: "预约服务 · 测试", host: "ops@192.0.2.24", group: "测试", status: "online",
      os: "Ubuntu 24.04 LTS", uptime: "12 天 6 小时", last: "刚刚", cpu: [16, 24, 32, 24],
      mem: { used: 3.1, total: 8 }, disk: { used: 33.6, total: 80 }, load: [0.36, 0.28, 0.22],
      files: ["/var/log/booking.log", "/srv/booking/.env.example", "/srv/booking/releases/20261119-1410"]
    },
    {
      id: "SRV-02", name: "构建机 · CI", host: "ci@203.0.113.51", group: "CI", status: "online",
      os: "Debian 12", uptime: "3 天 2 小时", last: "4 分钟前", cpu: [62, 58, 44, 71],
      mem: { used: 12.4, total: 32 }, disk: { used: 210, total: 500 }, load: [3.12, 2.84, 2.40],
      files: ["/var/lib/ci/queue.json", "/home/ci/workspace"]
    },
    {
      id: "SRV-03", name: "归档 · 开发", host: "ops@198.51.100.28", group: "开发", status: "offline",
      os: "Ubuntu 22.04", uptime: "—", last: "昨天 22:10", cpu: [], mem: null, disk: null, load: [],
      files: []
    }
  ];

  const terminal = {
    "SRV-01": [
      { cmd: "uptime", out: " 14:32:10 up 12 days,  6:02,  1 user,  load average: 0.36, 0.28, 0.22" },
      { cmd: "free -h", out: "               total        used        free      shared  buff/cache   available\nMem:           8.0Gi       3.1Gi       4.0Gi        64Mi       1.0Gi       5.0Gi\nSwap:          2.0Gi          0B       2.0Gi" },
      { cmd: "df -h /dev/demo", out: "Filesystem      Size  Used Avail Use% Mounted on\n/dev/demo        80G   34G   46G  43% /srv" }
    ],
    "SRV-02": [
      { cmd: "systemctl status ci-runner", out: "● ci-runner.service - CI Runner\n     Active: active (running) since Mon 2026-11-17 09:20:11 UTC\n   Main PID: 1221 (ci-runner)\n      Tasks: 42 (limit: 4096)" },
      { cmd: "nvidia-smi --query-gpu=utilization.gpu --format=csv", out: "utilization.gpu [%]\n71 %" }
    ],
    "SRV-03": []
  };

  const providers = [
    {
      id: "PRV-01", name: "TierFlow", protocol: "Anthropic / OpenAI 双协议", enabled: true,
      keys: 2, models: 3, endpoints: 2, updated: "今天 10:12",
      modelList: [
        { name: "tierflow-pro", type: "文本 / 视觉", context: "200K", effort: "中", on: true },
        { name: "tierflow-lite", type: "文本", context: "128K", effort: "低", on: true },
        { name: "tierflow-image", type: "生图", context: "—", effort: "—", on: false }
      ]
    },
    {
      id: "PRV-02", name: "本地网关", protocol: "OpenAI 兼容", enabled: true,
      keys: 1, models: 1, endpoints: 1, updated: "昨天 21:40",
      modelList: [{ name: "local-qwen-72b", type: "文本", context: "32K", effort: "关闭", on: true }]
    },
    {
      id: "PRV-03", name: "备用直连", protocol: "Anthropic", enabled: false,
      keys: 0, models: 0, endpoints: 1, updated: "11-16 09:02", modelList: []
    }
  ];

  const sdks = [
    { id: "claude", name: "Claude Code", version: "2.0.14", latest: "2.0.14", installed: true, enabled: true, path: "~/.local/bin/claude", engines: "Claude 4.5 / Haiku" },
    { id: "codex", name: "Codex CLI", version: "0.48.2", latest: "0.49.0", installed: true, enabled: true, path: "~/.npm-global/bin/codex", engines: "GPT-5 Codex" },
    { id: "grok", name: "Grok CLI", version: "—", latest: "0.12.1", installed: false, enabled: false, path: "—", engines: "Grok 4" },
    { id: "dsh", name: "DSH Runtime", version: "1.0.0", latest: "1.0.0", installed: true, enabled: true, path: "内置", engines: "DeepSeek V4" }
  ];

  const agents = [
    { id: "dsh", name: "DSH 主代理", role: "编排、评审与交付", model: "deepseek-v4.1", effort: "中", status: "在岗", runs: 42, avatar: "DS" },
    { id: "codex", name: "Codex 执行器", role: "实现与测试", model: "gpt-5-codex", effort: "高", status: "运行中", runs: 28, avatar: "CX" },
    { id: "claude", name: "Claude 评审", role: "代码评审与文档", model: "claude-4.5-sonnet", effort: "中", status: "空闲", runs: 16, avatar: "CL" },
    { id: "grok", name: "Grok 检索", role: "资料检索与对比", model: "grok-4", effort: "低", status: "未安装", runs: 0, avatar: "GK" }
  ];

  const skills = [
    { name: "需求拆解", slug: "requirement-split", desc: "按业务成果拆 Epic / Feature / Story，附可观察 AC。", on: true, uses: 36 },
    { name: "代码审查", slug: "code-review", desc: "检查幂等、事务边界与秘密零落盘。", on: true, uses: 21 },
    { name: "发布检查", slug: "release-check", desc: "对照发布清单，确认回滚路径与证据。", on: false, uses: 4 }
  ];

  const mcp = [
    { name: "filesystem", transport: "stdio", target: "demo-mcp-fs --root D:/work/booking-service", on: true, tools: 6 },
    { name: "knowledge-gateway", transport: "HTTP", target: "https://knowledge.demo.invalid/mcp", on: true, tools: 3 },
    { name: "browser", transport: "stdio", target: "demo-mcp-browser", on: false, tools: 4 }
  ];

  const tools = [
    { name: "fs.read", risk: "低", desc: "读取受管目录内文件", on: true, calls: 184 },
    { name: "fs.write", risk: "中", desc: "写入需审批，限工作区", on: true, calls: 52 },
    { name: "code-search", risk: "低", desc: "仓库内符号与文本检索", on: true, calls: 96 },
    { name: "local-exec", risk: "高", desc: "本机命令，逐次审批", on: true, calls: 31 },
    { name: "ssh-exec", risk: "高", desc: "远程主机命令，逐次审批", on: true, calls: 7 },
    { name: "web-fetch", risk: "中", desc: "抓取公开页面，禁内网地址", on: false, calls: 12 }
  ];

  const session = {
    goal: "让 STORY-0102 的容量校验通过 AC-02 与 AC-03，并把证据整理到交付包。",
    model: "deepseek-v4.1",
    effort: "中",
    permission: "工作区写入",
    context: 41,
    tokens: "128.4K",
    cost: "¥4.26",
    messages: [
      { role: "user", time: "14:18", text: "继续 STORY-0102。先看 RUN-2087 卡在哪，别重复已经通过的 AC。" },
      {
        role: "assistant", time: "14:19", text: "我先读运行记录与容量实现，确认缺口后再改代码。",
        thinking: "先确认 RUN-2087 的失败阶段：如果卡在用例执行，就与实现无关。已通过的 AC 不重复跑，只看失败分支的日志与退出码。",
        thinkMs: "12 秒",
        tools: [
          { name: "fs.read", arg: "docs/Plan/Story/STORY-0102.md", state: "完成", detail: "读取 1.2 KB · 3 条 AC" },
          { name: "code-search", arg: "reserveCapacity", state: "完成", detail: "2 处引用：capacity.ts / service.ts" }
        ]
      },
      {
        role: "assistant", time: "14:21", text: "缺口是并发失败时没有可读错误码：`reserveCapacity` 与预约写入已经同事务，但失败分支直接抛错。我补一个 RETRYABLE 分支，并加一条并发用例。",
        thinking: "失败分支与事务边界在同一函数内，改这里不会影响已通过的 AC-01/02。用例要覆盖两个并发请求同时扣减，断言第二个拿到 RETRYABLE 而不是泛化异常。",
        thinkMs: "2 分 06 秒",
        tools: [
          { name: "fs.write", arg: "src/booking/capacity.ts", state: "完成", detail: "+18 −2" },
          { name: "local-exec", arg: "pnpm vitest run tests/capacity.spec.ts", state: "运行中", detail: "3 passed · 1 running" }
        ]
      },
      {
        role: "assistant", time: "14:31", text: "AC-02 已通过。AC-03 还需要事务回滚用例；是否继续由我补齐？这会新增一个测试文件。",
        approval: {
          title: "允许写入测试文件？",
          detail: "tests/capacity-rollback.spec.ts · 预计 +42 行",
          state: "pending"
        }
      }
    ],
    tasks: [
      { title: "补齐 AC-02 并发失败提示", state: "完成" },
      { title: "补齐 AC-03 事务回滚用例", state: "进行中" },
      { title: "整理交付证据与失败记录", state: "待开始" }
    ],
    background: [
      { cmd: "pnpm vitest run tests/capacity.spec.ts", state: "运行中", time: "00:42", exit: null },
      { cmd: "pnpm tsc --noEmit", state: "完成", time: "00:11", exit: 0 },
      { cmd: "git status --short", state: "完成", time: "00:01", exit: 0 }
    ]
  };

  return {
    user, projects, statusMeta, requirements, tasks, design, files, office, git, knowledge, servers, terminal,
    settings: { providers, sdks, agents, skills, mcp, tools }, session,
    /* UI-CR066 r2：数据库／领域设计模型（对应项目 docs/DB 下的设计文档）。
       合成夹具，只用于演示模型作为项目级独立分支在导图与预览中的位置。 */
    designModels: [
      { id: "DB-001", title: "预约与容量模型", project: "PRJ-1042", relPath: "docs/DB/DB-001-预约与容量模型.md", summary: "booking、slot 与容量扣减的表结构与约束；取消回补在同一事务内提交。" },
      { id: "DB-002", title: "用户与角色权限模型", project: "PRJ-1042", relPath: "docs/DB/DB-002-用户与角色权限模型.md", summary: "user、role 与只读运营角色的授权关系；操作审计留痕。" },
      { id: "DB-003", title: "通知与消息模型", project: "PRJ-1042", relPath: "docs/DB/DB-003-通知与消息模型.md", summary: "站内消息与回执的读写路径；当前受消息通道配置阻塞。" },
      { id: "DB-011", title: "主机与巡检模型", project: "PRJ-1031", relPath: "docs/DB/DB-011-主机与巡检模型.md", summary: "host、group 与巡检指标的存储；高风险命令逐次审批留档。" }
    ],
    clock: "14:32", date: "2026-11-19 周四"
  };
})();

