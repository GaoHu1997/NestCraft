/* UI-CR054-v1：会话中心工作台设计稿交互。
   全部为合成样例，不读取真实磁盘、不连接模型、不写任何存储。
   目的：证明三栏结构、会话共享语义、右栏预览与两类项目的一致性可在设计层被检查。 */

(() => {
  const ICON = {
    layout: '<path d="M3 4h18v16H3z"/><path d="M3 9h18M9 9v11"/>',
    message: '<path d="M4 5h16v11H9l-5 4z"/>',
    fileText: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
    file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4.3-4.3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    panelRight: '<path d="M4 4h16v16H4z"/><path d="M14 4v16"/>',
    panelLeft: '<path d="M4 4h16v16H4z"/><path d="M9 4v16"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    paperclip: '<path d="M20 11.5 11 20.5a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L9 18.5a2 2 0 0 1-3-3l8-8"/>',
    at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
    slash: '<path d="M17 4 7 20"/>',
    send: '<path d="M4 12 20 4l-7 16-3-7z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    check: '<path d="m5 13 4 4 10-10"/>',
    code: '<path d="m9 8-5 4 5 4M15 8l5 4-5 4"/>',
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5h6v2"/>',
    book: '<path d="M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M17 7a3 3 0 0 1 3 3v10h-3"/>',
    database: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/>',
    folder: '<path d="M3 6h6l2 2h10v11H3z"/>',
    external: '<path d="M14 4h6v6M20 4l-8 8"/><path d="M18 14v5H5V6h5"/>',
    x: '<path d="m6 6 12 12M18 6 6 18"/>',
  };
  const ico = (n, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n] || ''}</svg>`;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------------- 合成样例：同一套会话数据，两个项目 ---------------- */
  const PROJECTS = {
    code: {
      id: 'PRJ-1042', name: '预约服务', kind: 'code',
      tabs: [['workbench', '工作台', 'layout', null], ['requirements', '需求', null, 38], ['design', '设计', null, 4], ['tasks', '任务', null, 6], ['code', '编码', null, null]],
      meta: '编码项目',
    },
    work: {
      id: 'PRJ-1018', name: '市场研究资料', kind: 'work',
      tabs: [['workbench', '工作台', 'layout', null], ['code', '文档', null, null], ['design', '成果', null, null]],
      meta: '办公项目',
    },
  };

  /* 会话集合：项目级唯一。标记来源页签，用于证明“不隔离”。 */
  const SESSIONS = {
    code: [
      { id: 'S-8', title: '实现预约改期接口与校验', group: '今天', state: 'run', origin: '编码', meta: 'claude · 12 步', pinned: true },
      { id: 'S-7', title: '拆分改期需求的验收标准', group: '今天', state: 'unread-ok', origin: '需求', meta: 'codex · 刚刚' },
      { id: 'S-6', title: '生成预约服务数据模型草案', group: '今天', state: 'read', origin: '设计', meta: 'claude · 2 小时前' },
      { id: 'S-5', title: '排查时区导致的重叠校验异常', group: '今天', state: 'unread-bad', origin: '编码', meta: 'codex · 3 小时前' },
      { id: 'S-4', title: '补充派发前的依赖检查说明', group: '昨天', state: 'read', origin: '任务', meta: 'claude · 昨天' },
      { id: 'S-3', title: '预约服务错误码统一梳理', group: '昨天', state: 'read', origin: '编码', meta: 'grok · 昨天' },
      { id: 'S-2', title: '整理会议时间冲突的业务规则', group: '更早', state: 'read', origin: '需求', meta: 'claude · 11-19' },
      { id: 'S-1', title: '初始项目结构确认', group: '更早', state: 'read', origin: '编码', meta: 'claude · 11-18' },
    ],
    work: [
      { id: 'W-6', title: '汇总竞品定价并更新台账', group: '今天', state: 'run', origin: '文档', meta: 'claude · 8 步', pinned: true },
      { id: 'W-5', title: '把访谈要点并进研究报告', group: '今天', state: 'unread-ok', origin: '文档', meta: 'codex · 1 小时前' },
      { id: 'W-4', title: '生成品牌官网内容提纲', group: '今天', state: 'read', origin: '成果', meta: 'claude · 4 小时前' },
      { id: 'W-3', title: '核对 Q3 预算表口径', group: '昨天', state: 'unread-bad', origin: '文档', meta: 'codex · 昨天' },
      { id: 'W-2', title: '竞品官网信息架构对比', group: '更早', state: 'read', origin: '文档', meta: 'claude · 11-19' },
      { id: 'W-1', title: '项目资料入库与分类', group: '更早', state: 'read', origin: '文档', meta: 'claude · 11-18' },
    ],
  };

  /* 预览目标：右栏按类型渲染 */
  const TARGETS = {
    code: {
      'file:src/booking/reschedule.ts': {
        type: 'file', title: 'reschedule.ts', path: 'src/booking/reschedule.ts',
        meta: ['TypeScript', '186 行', '工作分支 feature/reschedule'],
        code: [
          "import { assertSlotFree } from './slots';",
          "import { RescheduleError } from './errors';",
          "",
          "export async function reschedule(id: string, next: Slot) {",
          "  const current = await repo.find(id);",
          "  if (!current) throw new RescheduleError('NOT_FOUND');",
          "  if (!(await assertSlotFree(next))) {",
          "    throw new RescheduleError('SLOT_TAKEN');",
          "  }",
          "  return repo.update(id, { slot: next, updatedAt: now() });",
          "}",
        ], hl: 7,
      },
      'file:src/booking/slots.ts': {
        type: 'file', title: 'slots.ts', path: 'src/booking/slots.ts',
        meta: ['TypeScript', '92 行'],
        code: ["export async function assertSlotFree(slot: Slot) {", "  const rows = await db.query(slotQuery(slot));", "  return rows.length === 0;", "}"], hl: 2,
      },
      'req:STORY-058': {
        type: 'req', title: 'STORY-058：预约改期与冲突校验', path: 'docs/Plan/Story/STORY-058-预约改期与冲突校验.md',
        meta: ['Feature FEAT-014', '状态：开发中', '版本 r3'],
        body: [
          ['h3', '目标'], ['p', '作为预约服务用户，我希望在有空档时改期，以便不改号就能调整时间。'],
          ['h3', '验收标准'],
        ],
        acs: [
          ['AC-058-01', '给定目标时段已被占用，当提交改期，则提示冲突且原预约不变。'],
          ['AC-058-02', '给定时段空闲，当提交改期，则预约时间更新并保留历史记录。'],
          ['AC-058-03', '给定请求并发提交，则只有一次成功，另一次返回冲突。'],
        ],
      },
      'req:STORY-061': {
        type: 'req', title: 'STORY-061：预约服务数据模型', path: 'docs/Plan/Story/STORY-061-预约服务数据模型.md',
        meta: ['Feature FEAT-014', '状态：已完成'],
        body: [['h3', '目标'], ['p', '建立预约、时段、服务项的基础实体与约束。']],
        acs: [['AC-061-01', '预约必须归属唯一服务项与时段。'], ['AC-061-02', '时段不可跨日重复占用。']],
      },
      'kb:KB-03': {
        type: 'kb', title: '预约系统接口约定', path: '知识库 / 工程规范 / 预约系统接口约定',
        meta: ['已授权本项目', '只读', 'v4'],
        body: [['h3', '通用约定'], ['p', '所有写接口需幂等键；时间统一使用带时区的 ISO 8601。'], ['p', '错误码分段：1xxx 参数、2xxx 业务、5xxx 依赖。']],
      },
      'tool:web': {
        type: 'tool', title: '网页抓取 · 演示结果', path: '工具调用 · web-fetch（用户自配 MCP）',
        meta: ['演示样例', '不访问真实网络'],
        body: [['h3', '结果摘要'], ['p', '页面标题与三个小节已提取，正文 1.2k 字。真实执行需用户自配 MCP 工具，本设计不内置浏览器。']],
        note: '浏览器/网页抓取不在首期范围，独立立项；此处只证明右栏可承载工具结果。',
      },
    },
    work: {
      'work:office-report': {
        type: 'office', title: 'Q3 竞品研究报告.docx', path: '市场研究资料 / 报告 / Q3 竞品研究报告.docx',
        meta: ['Word', '18 页', '只读预览'],
        body: [['h3', '摘要'], ['p', '三家主要竞品在本季度均上调了年费，其中两家新增了团队版阶梯价。'], ['h3', '结论'], ['p', '建议在 10 月前完成定价调整评估，并在官网同步更新价格页。']],
        note: '真实预览按现有 Office 查看器能力执行；不支持的格式显式说明并提供下载原件。',
      },
      'work:office-sheet': {
        type: 'office', title: '竞品定价台账.xlsx', path: '市场研究资料 / 台账 / 竞品定价台账.xlsx',
        meta: ['Excel', '12 行 × 6 列', '只读预览'],
        code: ['产品 | 基础版 | 团队版 | 年费变动', 'A 竞品 | 99 | 299 | +12%', 'B 竞品 | 129 | 359 | +8%', 'C 竞品 | 89 | 249 | 0%'],
        note: '表格为只读文本呈现，不宣称表格引擎能力。',
      },
      'work:office-outline': {
        type: 'office', title: '品牌官网内容提纲.md', path: '市场研究资料 / 成果 / 品牌官网内容提纲.md',
        meta: ['Markdown', '成果文件'],
        body: [['h3', '首页'], ['p', '一句主张 + 三段价值 + 客户证言 + 转化入口。'], ['h3', '产品页'], ['p', '按场景分组，每组含适用对象、关键能力、部署方式。']],
      },
      'kb:KB-07': {
        type: 'kb', title: '竞品访谈纪要', path: '知识库 / 市场 / 竞品访谈纪要',
        meta: ['已授权本项目', '只读', 'v2'],
        body: [['h3', '要点'], ['p', '客户最在意的是迁移成本与稳定性，价格敏感度低于预期。']],
      },
      'tool:web': {
        type: 'tool', title: '网页抓取 · 演示结果', path: '工具调用 · web-fetch（用户自配 MCP）',
        meta: ['演示样例', '不访问真实网络'],
        body: [['h3', '结果摘要'], ['p', '竞品官网定价页价格与更新日期已提取。真实执行需用户自配 MCP 工具。']],
        note: '不内置浏览器。',
      },
    },
  };

  /* 每个项目一组会话（用于渲染消息） */
  const MESSAGES = {
    code: {
      'S-8': [
        ['user', '把改期接口做完，冲突要返回明确错误码，并补上并发用例。', ['file:src/booking/reschedule.ts', 'req:STORY-058']],
        ['ai', '已读取 <code>reschedule.ts</code> 与 STORY-058 的三条验收标准。<br>当前实现缺少并发保护，我会先确认时段查询是否在同一事务内。', ['req:STORY-058']],
        ['user', '顺带看一下时区问题是不是还没处理。', ['file:src/booking/slots.ts']],
        ['ai', '时段判断用的是无时区时间，跨日边界会算错。建议统一为带时区 ISO 值再比较；这会同时影响 AC-058-01/02。'],
      ],
      'S-7': [
        ['user', '把改期需求拆成可独立验收的几条。', ['req:STORY-058']],
        ['ai', '已按“成功、冲突、并发、历史记录”四条拆分，并标注哪条依赖数据模型。', ['req:STORY-058', 'req:STORY-061']],
      ],
      'S-6': [
        ['user', '先给数据模型草案，注意时段唯一性。', ['req:STORY-061']],
        ['ai', '草案包含预约、时段、服务项三张表；时段唯一性用 (serviceId, startAt) 唯一约束表达。', ['req:STORY-061']],
      ],
      'S-5': [
        ['user', '这个重叠校验为什么偶发失败？', ['file:src/booking/slots.ts']],
        ['ai', '边界落在跨日时被判定为不同天；需要统一时区后再比较。已在 <code>slots.ts</code> 定位到第 2 行查询条件。', ['file:src/booking/slots.ts']],
      ],
    },
    work: {
      'W-6': [
        ['user', '把三家竞品的价格汇总到台账，并在报告里加一段结论。', ['work:office-report', 'work:office-sheet']],
        ['ai', '已读取台账与报告。三家均上调年费，其中两家新增团队版阶梯价；建议在报告中补充定价调整建议。', ['work:office-sheet', 'work:office-report']],
        ['user', '结论再压缩成两句。', ['work:office-report']],
        ['ai', '已压缩。同时把官网内容提纲里的价格页标记为待更新。', ['work:office-outline']],
      ],
      'W-5': [
        ['user', '把访谈要点并进研究报告，别改原有结论。', ['kb:KB-07', 'work:office-report']],
        ['ai', '已把“客户更在意迁移成本”并入第二段，原结论保留。', ['work:office-report']],
      ],
      'W-4': [
        ['user', '给品牌官网出一版内容提纲。', ['work:office-outline']],
        ['ai', '已按首页、产品页、案例页、价格页四部分给出提纲。', ['work:office-outline']],
      ],
    },
  };

  const STEPS = {
    code: {
      run: [
        ['done', '读取 STORY-058 与 reschedule.ts', '0.4s'],
        ['done', '检索 slots.ts 时段查询', '0.2s'],
        ['run', '运行改期相关测试', ''],
        ['todo', '整理冲突错误码说明', ''],
      ],
      idle: [
        ['done', '读取上下文与引用文件', '0.6s'],
        ['done', '生成答复', '2.1s'],
      ],
    },
    work: {
      run: [
        ['done', '读取竞品定价台账.xlsx', '0.5s'],
        ['done', '读取 Q3 竞品研究报告.docx', '0.8s'],
        ['run', '汇总三家价格并生成结论段', ''],
        ['todo', '标记官网内容提纲待更新项', ''],
      ],
      idle: [
        ['done', '读取办公文件与引用资料', '0.7s'],
        ['done', '生成答复', '1.8s'],
      ],
    },
  };

  /* 右栏打开时的默认标签（按项目） */
  const AUX_TABS = {
    code: [['file:src/booking/reschedule.ts', 'reschedule.ts', 'fileText'], ['req:STORY-058', 'STORY-058', 'fileText']],
    work: [['work:office-report', 'Q3 竞品研究报告.docx', 'fileText'], ['work:office-sheet', '竞品定价台账.xlsx', 'database']],
  };
  /* 右栏“来源”列表（未打开任何目标时的入口） */
  const AUX_SOURCES = {
    code: [
      ['文件', [['file:src/booking/reschedule.ts', 'reschedule.ts', '186 行'], ['file:src/booking/slots.ts', 'slots.ts', '92 行']]],
      ['需求', [['req:STORY-058', 'STORY-058 预约改期与冲突校验', '开发中'], ['req:STORY-061', 'STORY-061 预约服务数据模型', '已完成']]],
      ['知识', [['kb:KB-03', '预约系统接口约定', '已授权']]],
      ['工具结果', [['tool:web', '网页抓取 · 演示', '演示']]],
    ],
    work: [
      ['成果文件', [['work:office-report', 'Q3 竞品研究报告.docx', 'Word'], ['work:office-sheet', '竞品定价台账.xlsx', 'Excel'], ['work:office-outline', '品牌官网内容提纲.md', 'Markdown']]],
      ['知识', [['kb:KB-07', '竞品访谈纪要', '已授权']]],
      ['工具结果', [['tool:web', '网页抓取 · 演示', '演示']]],
    ],
  };

  /* 场景：用于评审逐项检查 */
  const SCENARIOS = [
    { id: 'layout', name: 'S-01 三栏默认（右栏关闭）', kind: 'code', right: 0, sess: 'S-8' },
    { id: 'preview-file', name: 'S-02 点击文件 → 右栏定位到行', kind: 'code', right: 1, sess: 'S-8', open: 'file:src/booking/reschedule.ts' },
    { id: 'preview-req', name: 'S-03 点击需求 → 右栏预览正文', kind: 'code', right: 1, sess: 'S-8', open: 'req:STORY-058' },
    { id: 'history-run', name: 'S-04 左栏全量历史（含运行/未读/失败）', kind: 'code', right: 0, sess: 'S-8', focusHist: true },
    { id: 'shared-origin', name: 'S-05 其他页签创建的会话可见', kind: 'code', right: 0, sess: 'S-7' },
    { id: 'aux-empty', name: 'S-06 右栏打开但未选目标', kind: 'code', right: 1, sess: 'S-6', open: null },
    { id: 'work-layout', name: 'S-07 办公项目三栏', kind: 'work', right: 0, sess: 'W-6' },
    { id: 'work-preview', name: 'S-08 办公项目点击成果 → 右栏预览', kind: 'work', right: 1, sess: 'W-6', open: 'work:office-report' },
    { id: 'work-sheet', name: 'S-09 办公项目表格只读预览', kind: 'work', right: 1, sess: 'W-6', open: 'work:office-sheet' },
    { id: 'tool-result', name: 'S-10 工具结果在右栏呈现', kind: 'code', right: 1, sess: 'S-8', open: 'tool:web' },
    { id: 'new-session', name: 'S-11 新会话空态（不自动创建）', kind: 'code', right: 0, sess: 'NEW' },
    { id: 'dark', name: 'S-12 深色主题（编码项目）', kind: 'code', right: 1, sess: 'S-8', open: 'req:STORY-058', theme: 'dark' },
  ];

  const state = {
    kind: 'code', theme: 'light', view: '1440', right: false,
    session: 'S-8', auxTabs: [], auxActive: null, histOpen: false,
    focusHist: false, scenario: 'layout',
  };

  const $ = sel => document.querySelector(sel);
  const win = $('#win');

  /* ---------------- 工具 ---------------- */
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  function sessions() { return SESSIONS[state.kind]; }
  function currentSession() {
    if (state.session === 'NEW') return null;
    return sessions().find(s => s.id === state.session) || null;
  }
  function targets() { return TARGETS[state.kind]; }

  function addAuxTab(key) {
    if (!key) return;
    if (!state.auxTabs.includes(key)) state.auxTabs.push(key);
    state.auxActive = key;
  }

  /* ---------------- 页签 ---------------- */
  function renderTabs() {
    const p = PROJECTS[state.kind];
    const tabs = p.tabs.map(([key, label, icon, n]) => {
      const on = key === 'workbench';
      return `<button class="tab" role="tab" aria-selected="${on}" data-tab="${key}">
        ${icon ? ico(icon) : ''}<span>${esc(label)}</span>${n != null ? `<span class="n">${n}</span>` : ''}
      </button>`;
    }).join('');
    $('#tabbar').innerHTML = tabs +
      `<span class="tab-spacer"></span>
       <button class="tab-ai ${state.right ? 'on' : ''}" data-act="toggle-right" title="${state.right ? '收起辅助栏' : '展开辅助栏'}" aria-label="辅助栏" aria-pressed="${state.right}">${ico('panelRight')}</button>
       <button class="tab-more" data-act="tab-more" aria-label="更多页签">${ico('chevron')}</button>`;
    // 溢出判定：不足以容纳时显示更多
    const bar = $('#tabbar');
    bar.classList.toggle('overflow', bar.scrollWidth > bar.clientWidth + 1);
  }

  /* ---------------- 左：历史 ---------------- */
  function stateDot(s) {
    if (s.state === 'run') return '<span class="st run" aria-hidden="true"></span>';
    if (s.state === 'unread-ok') return '<span class="st ok" aria-hidden="true"></span>';
    if (s.state === 'unread-bad') return '<span class="st bad" aria-hidden="true"></span>';
    return '<span class="st idle" aria-hidden="true"></span>';
  }
  function stateLabel(s) {
    if (s.state === 'run') return '运行中';
    if (s.state === 'unread-ok') return '未读';
    if (s.state === 'unread-bad') return '未读 · 失败';
    return '已读';
  }

  function renderHistory() {
    const p = PROJECTS[state.kind];
    const list = sessions();
    const pinned = list.filter(s => s.pinned);
    const groups = [];
    for (const s of list) {
      if (s.pinned) continue;
      let g = groups.find(x => x.name === s.group);
      if (!g) { g = { name: s.group, rows: [] }; groups.push(g); }
      g.rows.push(s);
    }
    const row = s => `<button class="hrow ${s.id === state.session ? 'on' : ''}" data-sess="${s.id}" aria-current="${s.id === state.session}">
        ${stateDot(s)}
        <span class="h-main">
          <span class="h-title">${esc(s.title)}</span>
          <span class="h-meta">${esc(s.meta)} · ${esc(s.origin)}页签</span>
        </span>
        <span class="h-tag" title="来自${esc(s.origin)}页签">${ico(s.origin === '需求' ? 'book' : s.origin === '设计' ? 'layout' : s.origin === '任务' ? 'check' : s.origin === '成果' ? 'briefcase' : s.origin === '文档' ? 'fileText' : 'code')}</span>
      </button>`;

    const body = list.length === 0
      ? `<div class="hist-empty">当前项目还没有会话。<br>发送第一条消息或点击「新会话」后出现。</div>`
      : `${pinned.length ? `<div class="hgroup">运行中</div>${pinned.map(row).join('')}` : ''}
         ${groups.map(g => `<div class="hgroup">${esc(g.name)}</div>${g.rows.map(row).join('')}`).join('')}
         <div class="hist-more"><button data-act="load-more">继续加载</button></div>`;

    return `<aside class="hist" aria-label="会话历史">
      <div class="hist-h">
        <b>会话</b><span class="n">${list.length} 个</span><span class="spacer"></span>
        <button class="icon-btn" data-act="new-session" title="新会话" aria-label="新会话">${ico('plus')}</button>
      </div>
      <div class="hist-search">
        <label class="search">${ico('search')}<input id="histSearch" type="search" placeholder="搜索当前项目全部会话" aria-label="搜索会话标题"></label>
        <button class="btn-all" data-act="reset-search">重置</button>
      </div>
      <div class="hist-list" id="histList">${body}</div>
      <div class="hist-foot"><span class="num">已加载 ${list.length}</span><span>·</span><span>分批 20 条/批</span><span class="spacer" style="flex:1"></span><span>${esc(p.kind === 'work' ? '办公' : '编码')}项目</span></div>
    </aside>`;
  }

  /* ---------------- 中：会话 ---------------- */
  function refChip(key, label, iconName = 'fileText') {
    const t = targets()[key];
    const name = label || (t ? t.title : key);
    return `<button class="ref ${state.auxActive === key && state.right ? 'on' : ''}" data-open="${esc(key)}" title="${esc(t ? t.path : key)}">${ico(iconName)}<span>${esc(name)}</span></button>`;
  }

  function renderMessages(sess) {
    const list = MESSAGES[state.kind][sess.id];
    if (!list) return `<div class="msg ai"><div class="bubble">这个会话的历史消息未在本设计样例中展开。</div></div>`;
    return list.map(([who, text, refs]) => {
      const chips = (refs || []).map(k => refChip(k)).join('');
      return `<div class="msg ${who === 'user' ? 'user' : 'ai'}">
        <span class="who">${who === 'user' ? '你' : 'AI'}</span>
        <div class="bubble"><p>${text}</p></div>
        ${chips ? `<div class="refline">${chips}</div>` : ''}
      </div>`;
    }).join('');
  }

  function renderSteps(sess) {
    const steps = sess.state === 'run' ? STEPS[state.kind].run : STEPS[state.kind].idle;
    const done = steps.filter(s => s[0] === 'done').length;
    return `<section class="steps" aria-label="执行步骤">
      <div class="steps-h"><b>执行步骤</b><span>${done}/${steps.length}</span><span class="spacer"></span><span>${steps.some(s => s[0] === 'run') ? '进行中' : '已完成'}</span></div>
      <div class="steps-body">
        ${steps.map(([st, title, meta]) => `<div class="step ${st}"><span class="dot">${st === 'done' ? '✓' : st === 'fail' ? '!' : ''}</span><span>${esc(title)}</span>${meta ? `<span class="s-meta">${esc(meta)}</span>` : ''}</div>`).join('')}
      </div>
    </section>`;
  }

  function renderConversation() {
    const sess = currentSession();
    const p = PROJECTS[state.kind];
    const isNew = !sess;
    const title = isNew ? '新会话' : sess.title;
    const sub = isNew ? `${p.name} · 发送后开始记录` : `${p.name} · ${sess.origin}页签创建 · ${stateLabel(sess)}`;
    const head = `<div class="conv-h">
      <button class="icon-btn" data-act="drawer-left" aria-label="会话历史">${ico('panelLeft')}</button>
      <div class="conv-t"><b>${esc(title)}</b><span>${esc(sub)}</span></div>
      <span class="spacer"></span>
      ${!isNew && sess.state === 'run' ? `<span class="pill run">${ico('clock')}运行中</span>` : ''}
      <span class="pill" title="本项目所有页签共用同一会话集合">${ico('message')}项目级共享</span>
      <button class="icon-btn" data-act="toggle-right" aria-label="辅助栏" aria-pressed="${state.right}">${ico('panelRight')}</button>
    </div>`;

    const scroll = isNew
      ? `<div class="conv-scroll"><div class="pv-empty" style="padding:64px 16px">
           <b>新会话</b>
           只有你主动新建时才会出现。<br>切换页签或页面不会创建新会话。
         </div></div>`
      : `<div class="conv-scroll">${renderMessages(sess)}${renderSteps(sess)}</div>`;

    const running = !!sess && sess.state === 'run';
    const composer = `<div class="composer">
      <div class="box">
        <textarea aria-label="输入消息" placeholder="描述你要做的事，或用 @ 引用文件、需求、会话"></textarea>
        <div class="composer-bar">
          <button class="cbtn">${ico('plus')}添加</button>
          <button class="cbtn">${ico('at')}引用</button>
          <button class="cbtn">${ico('slash')}能力</button>
          <button class="cbtn on">claude</button>
          <button class="cbtn">自动审核</button>
          <span class="spacer"></span>
          <button class="send ${running ? 'stop' : ''}" data-act="${running ? 'stop' : 'send'}" aria-label="${running ? '停止' : '发送'}">${ico(running ? 'stop' : 'send')}</button>
        </div>
      </div>
      <div class="cstats"><span>会话 <b class="num">12.4k</b> tokens</span><span>本轮 <b class="num">8.1k</b></span><span>上下文 <b class="num">31%</b></span><span>TTFT <b class="num">0.9s</b></span></div>
      <div class="chint">切换页签、切换到首页或其他项目再回来，都会回到这条会话；执行不会中断。</div>
    </div>`;

    return `<section class="conv" aria-label="当前会话">${head}${scroll}${composer}</section>`;
  }

  /* ---------------- 右：辅助栏 ---------------- */
  function renderPreview(key) {
    const t = targets()[key];
    if (!t) return `<div class="pv-empty"><b>无法预览</b>目标不存在或已移动。</div>`;
    const path = `<div class="pv-path">${ico(t.type === 'req' ? 'book' : t.type === 'kb' ? 'database' : t.type === 'tool' ? 'external' : t.type === 'office' ? 'briefcase' : 'file')}<span class="ellipsis">${esc(t.path)}</span></div>`;
    const meta = `<div class="pv-meta">${(t.meta || []).map(m => `<span class="tag">${esc(m)}</span>`).join('')}</div>`;
    let body = '';
    if (t.code) {
      body = `<pre class="pv-code">${t.code.map((line, i) => `<span class="${t.hl === i + 1 ? 'hl' : ''}"><span class="ln">${i + 1}</span>${esc(line)}</span>`).join('\n')}</pre>`;
    } else {
      body = `<div class="pv-doc">${(t.body || []).map(([tag, text]) => `<${tag}>${esc(text)}</${tag}>`).join('')}
        ${t.acs ? `<div class="pv-acs">${t.acs.map(([id, text]) => `<div class="pv-ac"><span class="tag accent">${esc(id)}</span><span>${esc(text)}</span></div>`).join('')}</div>` : ''}
      </div>`;
    }
    const note = t.note ? `<p class="pv-note">${esc(t.note)}</p>` : '';
    return `${path}<h3 class="pv-title">${esc(t.title)}</h3>${meta}${body}${note}`;
  }

  function renderAux() {
    const tabs = state.auxTabs.map(key => {
      const t = targets()[key];
      const name = t ? (t.type === 'file' || t.type === 'office' ? t.title : t.title.split('：')[0]) : key;
      const on = key === state.auxActive;
      return `<button class="auxtab" role="tab" aria-selected="${on}" data-aux="${esc(key)}">
        <span>${esc(name)}</span><span class="x" data-close-aux="${esc(key)}" title="关闭">${ico('x','')}</span>
      </button>`;
    }).join('');

    let body;
    if (state.auxTabs.length === 0) {
      const groups = AUX_SOURCES[state.kind];
      body = `<div class="pv-empty" style="padding:14px 4px 10px"><b>辅助栏</b>点击会话里的文件、需求或成果，会在这里只读预览。<br>不会修改原文件，也不会切换页签。</div>
        ${groups.map(([g, rows]) => `<div class="hgroup" style="padding-left:4px">${esc(g)}</div><div class="pv-list">${rows.map(([key, name, meta]) => `<button class="pv-row" data-open="${esc(key)}">${ico('fileText')}<span class="fname">${esc(name)}</span><span class="meta">${esc(meta)}</span></button>`).join('')}</div>`).join('')}`;
    } else {
      body = renderPreview(state.auxActive);
    }

    const t = state.auxActive ? targets()[state.auxActive] : null;
    const openIn = t
      ? (t.type === 'req' ? '在需求中打开' : t.type === 'office' || t.type === 'kb' ? '在文档中打开' : '在编码中打开')
      : '在编码中打开';

    return `<aside class="aux" aria-label="辅助栏">
      <div class="aux-h">
        <b>辅助栏</b><span class="tag">只读</span><span class="spacer"></span>
        <button class="icon-btn" data-act="clear-aux" title="关闭全部预览" aria-label="关闭全部预览">${ico('close')}</button>
      </div>
      ${state.auxTabs.length ? `<div class="aux-tabs" role="tablist">${tabs}</div>` : ''}
      <div class="aux-body" id="auxBody">${body}</div>
      <div class="aux-foot">
        <button class="btn-all" data-act="open-in" ${t ? '' : 'disabled'} style="${t ? '' : 'opacity:.45;cursor:not-allowed'}">${ico('external')} ${esc(openIn)}</button>
        <span class="spacer"></span>
        <span class="tag">${esc(state.kind === 'work' ? '办公预览' : '代码预览')}</span>
      </div>
    </aside>`;
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    document.documentElement.setAttribute('data-theme', state.theme);
    win.setAttribute('data-w', state.view);
    const p = PROJECTS[state.kind];
    $('#tbTitle').textContent = `${p.name} · ${p.meta}`;
    $('#tbKind').textContent = p.kind === 'work' ? '办公' : '编码';

    renderTabs();
    const shell = $('#shell');
    shell.className = `shell${state.right ? '' : ' no-right'}${state.histOpen ? ' drawer-left' : ''}${state.auxOpenDrawer ? ' drawer-right' : ''}`;
    shell.innerHTML = `${renderHistory()}<div class="split left" role="separator" aria-label="调整会话历史宽度" tabindex="0"></div>
      ${renderConversation()}
      <div class="split right" role="separator" aria-label="调整辅助栏宽度" tabindex="0"></div>
      ${renderAux()}
      <div class="drawer-backdrop" data-act="close-drawers"></div>`;

    $('#stageNote').innerHTML = noteFor();
    bindScrollbars();
  }

  function noteFor() {
    const p = PROJECTS[state.kind];
    if (state.kind === 'work') {
      return `<b>办公项目：</b>页签为「工作台 / 文档 / 成果」，与编码项目共用同一工作台容器和会话集合；右栏只预览办公成果文件、知识库与工具结果。中间区回退目标是「文档」页签。`;
    }
    return `<b>编码项目：</b>页签为「工作台 / 需求 / 设计 / 任务 / 编码」；左栏列出本项目全部会话（含其他页签创建），切页签不新建、不中断。右栏默认关闭，点击文件/需求只读预览。`;
  }

  /* ---------------- 滚动条按需显示（UI-SCROLL-001） ---------------- */
  function bindScrollbars() {
    document.querySelectorAll('.hist-list,.conv-scroll,.aux-body,.aux-tabs').forEach(el => {
      if (el.dataset.sbBound) return;
      el.dataset.sbBound = '1';
      let t = null;
      el.addEventListener('scroll', () => {
        el.classList.add('scrollbar-active');
        clearTimeout(t);
        t = setTimeout(() => el.classList.remove('scrollbar-active'), 700);
      }, { passive: true });
    });
  }

  /* ---------------- 事件 ---------------- */
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act],[data-sess],[data-open],[data-aux],[data-close-aux],[data-tab]');
    if (!el) return;

    if (el.dataset.closeAux) {
      e.stopPropagation();
      const key = el.dataset.closeAux;
      state.auxTabs = state.auxTabs.filter(k => k !== key);
      if (state.auxActive === key) state.auxActive = state.auxTabs[state.auxTabs.length - 1] || null;
      if (!state.auxTabs.length) state.right = false;
      render(); return;
    }
    if (el.dataset.open) { addAuxTab(el.dataset.open); state.right = true; state.auxOpenDrawer = state.view === '390'; render(); return; }
    if (el.dataset.aux) { state.auxActive = el.dataset.aux; render(); return; }
    if (el.dataset.sess) {
      state.session = el.dataset.sess;
      state.histOpen = false; state.auxOpenDrawer = false;
      if (state.session === 'NEW') { state.auxTabs = []; state.auxActive = null; }
      render(); return;
    }
    if (el.dataset.tab) {
      if (el.dataset.tab !== 'workbench') { toast('本设计只演示“工作台”页签；其他页签保持现状，切换不会新建或中断会话'); return; }
      return;
    }

    switch (el.dataset.act) {
      case 'toggle-right':
        state.right = !state.right;
        if (!state.right) state.auxOpenDrawer = false;
        /* 窄屏下右栏是覆盖式抽屉：打开时进入抽屉态，避免压掉中栏。 */
        else if (state.view === '390') state.auxOpenDrawer = true;
        if (state.right && state.auxTabs.length && !state.auxActive) state.auxActive = state.auxTabs[0];
        if (state.right && !state.auxTabs.length) state.auxActive = null;
        render(); return;
      case 'clear-aux':
        state.auxTabs = []; state.auxActive = null; state.right = false; render(); return;
      case 'new-session':
        state.session = 'NEW'; state.auxTabs = []; state.auxActive = null; render();
        toast('只有主动点击「新会话」才创建；切换页签/页面不会新建'); return;
      case 'send':
        toast('设计演示：不会真实发送'); return;
      case 'stop':
        toast('设计演示：不会真实停止'); return;
      case 'load-more':
        toast('设计演示：按 CR-063 每批 20 条追加，位置不跳、不重复'); return;
      case 'reset-search':
        const inp = $('#histSearch'); if (inp) inp.value = '';
        return;
      case 'open-in':
        toast('设计演示：将跳转到对应页签并定位（工作台内不跳页签）'); return;
      case 'drawer-left': state.histOpen = !state.histOpen; state.auxOpenDrawer = false; render(); return;
      case 'close-drawers': state.histOpen = false; state.auxOpenDrawer = false; render(); return;
      case 'tab-more': toast('设计演示：页签溢出沿用 CR-052 的「更多」下拉'); return;
    }
  });

  /* 评审控制条 */
  $('#segKind').addEventListener('click', e => {
    const b = e.target.closest('[data-kind]'); if (!b) return;
    state.kind = b.dataset.kind;
    state.session = sessionForKind();
    state.auxTabs = []; state.auxActive = null; state.right = false;
    [...$('#segKind').children].forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    syncScenario(); render();
  });
  $('#segTheme').addEventListener('click', e => {
    const b = e.target.closest('[data-theme-btn]'); if (!b) return;
    state.theme = b.dataset.themeBtn;
    [...$('#segTheme').children].forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    render();
  });
  $('#segView').addEventListener('click', e => {
    const b = e.target.closest('[data-view]'); if (!b) return;
    state.view = b.dataset.view;
    if (state.view !== '390') state.auxOpenDrawer = false;
    [...$('#segView').children].forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    render();
  });
  $('#segRight').addEventListener('click', e => {
    const b = e.target.closest('[data-right]'); if (!b) return;
    state.right = b.dataset.right === '1';
    if (state.right && !state.auxTabs.length) { /* 保持空态，展示入口列表 */ }
    if (!state.right) { /* 保留标签，便于再次打开 */ }
    [...$('#segRight').children].forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    render();
  });

  function sessionForKind() {
    return state.kind === 'work' ? 'W-6' : 'S-8';
  }

  /* ---------------- 场景 ---------------- */
  function buildScenarioOptions() {
    $('#scenario').innerHTML = SCENARIOS.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  }

  function syncScenario() {
    const s = SCENARIOS.find(x => x.id === state.scenario);
    if (!s) return;
    if (s.kind !== state.kind) {
      state.kind = s.kind;
      [...$('#segKind').children].forEach(x => x.setAttribute('aria-pressed', String(x.dataset.kind === s.kind)));
    }
  }

  function applyScenario(id) {
    const s = SCENARIOS.find(x => x.id === id);
    if (!s) return;
    state.scenario = id;
    state.kind = s.kind;
    state.session = s.sess;
    state.right = !!s.right;
    state.theme = s.theme || state.theme;
    state.focusHist = !!s.focusHist;
    state.auxTabs = [];
    state.auxActive = null;
    if (s.open) addAuxTab(s.open);
    /* 窄屏下右栏以覆盖式抽屉呈现，不挤占中栏 */
    state.auxOpenDrawer = state.view === '390' && !!s.right;
    [...$('#segKind').children].forEach(x => x.setAttribute('aria-pressed', String(x.dataset.kind === s.kind)));
    [...$('#segTheme').children].forEach(x => x.setAttribute('aria-pressed', String(x.dataset.themeBtn === state.theme)));
    [...$('#segRight').children].forEach(x => x.setAttribute('aria-pressed', String((x.dataset.right === '1') === state.right)));
    render();
    if (state.focusHist) {
      const el = document.querySelector('.hrow.on');
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  }

  $('#scenario').addEventListener('change', e => applyScenario(e.target.value));

  /* 演示：拖拽分隔条（视觉验证用，实际实现按 pane-resize 契约） */
  document.addEventListener('pointerdown', e => {
    const sp = e.target.closest('.split');
    if (!sp) return;
    const pane = sp.classList.contains('left') ? $('.hist') : $('.aux');
    if (!pane) return;
    e.preventDefault();
    const startX = e.clientX, startW = pane.getBoundingClientRect().width;
    const dir = sp.classList.contains('left') ? 1 : -1;
    document.body.classList.add('dragging');
    sp.setPointerCapture?.(e.pointerId);
    const move = ev => {
      const w = Math.max(220, Math.min(520, startW + (ev.clientX - startX) * dir));
      pane.style.width = w + 'px';
    };
    const up = () => {
      document.body.classList.remove('dragging');
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });

  /* 初始化 */
  buildScenarioOptions();
  applyScenario('layout');
})();
