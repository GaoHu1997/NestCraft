// CR-102：流式重连提示的定向回归（实际 MessageList 组件静态渲染，不调用真实上游/IPC）。
// 覆盖 AC-CR102-01/02/04 的组件层行为与 AC-CR102-03 的错误卡不变性；不替代真实桌面端验收。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const ts = require('typescript');

const load = (file, deps = {}) => {
  const source = readFileSync(file, 'utf8');
  const out = ts.transpileModule(source, { fileName: file, reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
  const diags = (out.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(diags.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [], `${file} 转译无错误`);
  const exports = {};
  vm.runInNewContext(out.outputText, { exports, require: id => deps[id] ?? require(id), console }, { filename: file + '.cjs' });
  return exports;
};

const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// 依赖桩：只提供 MessageList 用到的导出名；Icon 渲染为空 i 元素。
const stubs = {
  '@/components/icons': { Icon: (p) => React.createElement('i', { className: p?.className }) },
  '@/components/ui': {
    renderMarkdown: (text) => React.createElement('div', { className: 'md' }, text),
    useToast: () => () => {},
  },
  '@tauri-apps/api/core': { convertFileSrc: (p) => p },
  '@/modules/locate': { requestLocate: () => {} },
  './ThinkingIndicator': { ThinkingIndicator: () => null },
  './sessionRuntime': { toolDisplayName: (n) => n },
  './AttachmentImages': { AttachmentImages: () => null, ImageGallery: () => null },
  './messagePresentation': {
    changedInputPaths: () => [], classifyTool: () => 'other', formatMessageDuration: () => '',
    presentAgent: () => ({ type: 'general', status: '' }), presentToolInput: () => ({}),
    summarizeTools: () => [], toolFailed: () => false, workDurationMs: () => null,
  },
  './TurnNavigator': { TurnNavigator: () => null },
  './message-zcode.css': {},
};

const ml = load('src/modules/chat/MessageList.tsx', stubs);
const { MessageList, mkMsg } = ml;

const RAW = 'Reconnecting... 1/5 (unexpected status 502 Bad Gateway: Upstream service temporarily unavailable, url: https://api.primerelay.online/v1/responses, request id: 28411477-1c9d-42cd-8d6f-86d449084565)';
const render = (msgs) => renderToStaticMarkup(React.createElement(MessageList, { msgs, onRetryTurn: () => {} }));

const checks = [];
const check = (name, fn) => { fn(); checks.push(name); };

/* ---------- AC-CR102-01：进行中=无色块一行摘要，不出现错误卡 ---------- */
check('AC-01 retrying 渲染为 chat-retry-line（details），不渲染错误卡/粉块', () => {
  const html = render([mkMsg({ id: 'r1', role: 'system', kind: 'retrying', content: '上游暂时不可用（502）', retryAttempt: 1, retryMax: 5, retryDetail: RAW })]);
  assert.match(html, /chat-retry-line/);
  assert.match(html, /<details/);
  assert.doesNotMatch(html, /chat-card error/);
});
check('AC-01 摘要含「正在重试 1/5 · 原因」，计数加粗', () => {
  const html = render([mkMsg({ id: 'r1', role: 'system', kind: 'retrying', content: '上游暂时不可用（502）', retryAttempt: 1, retryMax: 5, retryDetail: RAW })]);
  assert.match(html, /正在重试/);
  assert.match(html, /chat-retry-count[^>]*>1\/5</);
  assert.match(html, /上游暂时不可用（502）/);
});

/* ---------- AC-CR102-02：完整原始错误在折叠详情区，等宽可复制 ---------- */
check('AC-02 原始错误全文置于 details 内 pre（默认折叠），并提供复制按钮', () => {
  const html = render([mkMsg({ id: 'r1', role: 'system', kind: 'retrying', content: '上游暂时不可用（502）', retryAttempt: 1, retryMax: 5, retryDetail: RAW })]);
  assert.match(html, new RegExp(`<pre>${RAW.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</pre>`));
  assert.match(html, /复制错误详情/);
  assert.match(html, /chat-retry-detail/);
});
check('AC-02 计数字段缺失时不渲染计数片段', () => {
  const html = render([mkMsg({ id: 'r2', role: 'system', kind: 'retrying', content: '连接中断', retryDetail: 'conn reset' })]);
  assert.doesNotMatch(html, /chat-retry-count/);
  assert.match(html, /正在重试 · 连接中断|正在重试/);
});

/* ---------- AC-CR102-04：恢复留痕 ---------- */
check('AC-04 recovered 渲染 ✓ 与恢复文案，不再显示「正在重试」', () => {
  const html = render([mkMsg({ id: 'r3', role: 'system', kind: 'recovered', content: '上游暂时不可用（502）', retryAttempt: 2, retryMax: 5, retryDetail: RAW })]);
  assert.match(html, /chat-retry-line/);
  assert.match(html, /✓/);
  assert.match(html, /已自动重试 2 次后/);
  assert.match(html, /恢复/);
  assert.doesNotMatch(html, /正在重试/);
  assert.match(html, /chat-retry-glyph ok/);
});

/* ---------- AC-CR102-03：终态错误卡不变（仍带重试入口） ---------- */
check('AC-03 终态 error 仍渲染现行错误卡与「重试」按钮', () => {
  const html = render([mkMsg({ id: 'e1', role: 'error', content: 'CLI 执行超时', isError: true })], );
  assert.match(html, /chat-card error/);
  assert.match(html, /重试/);
});

/* ---------- 防回归：普通 system 行不受影响 ---------- */
check('普通 system 消息仍走 chat-sysline，不进入 retry-line 分支', () => {
  const html = render([mkMsg({ id: 's1', role: 'system', content: '待处理：shell。' })]);
  assert.match(html, /chat-sysline/);
  assert.doesNotMatch(html, /chat-retry-line/);
});

console.log(`CR-102 定向回归：${checks.length}/${checks.length} 通过`);
for (const c of checks) console.log(' -', c);
