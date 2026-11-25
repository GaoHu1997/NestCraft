// FEAT-012：合成权威边界夹具；不访问真实上游/IPC，不执行全项目构建。
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const [foldSource, barSource, panelSource] = await Promise.all([
  readFile('src/modules/chat/sessionStats.ts', 'utf8'),
  readFile('src/modules/chat/StatsBar.tsx', 'utf8'),
  readFile('src/modules/chat/ChatPanel.tsx', 'utf8'),
]);
function compile(source, fileName) {
  const result = ts.transpileModule(source, {fileName, reportDiagnostics: true,
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX}});
  assert.deepEqual((result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error)
    .map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);
  return result.outputText;
}
const foldExports = {};
vm.runInNewContext(compile(foldSource, 'sessionStats.ts'), {exports: foldExports});
const {projectSessionStats, SESSION_STATS_SCHEMA} = foldExports;
const sid = 'session-1';
const options = {sessionId: sid};
const closed = (turnId = 'turn-1', stepId = 'step-1', outcome = 'completed') =>
  ({type: 'step/end', sessionId: sid, turnId, stepId, outcome});
const batch = (closedSteps, extra = {}) => ({sessionId: sid, metaJson: JSON.stringify({sessionStats:
  {schema: SESSION_STATS_SCHEMA, source: 'dsh', sessionId: sid, closedSteps, ...extra}})});
const project = rows => projectSessionStats(rows, options);
const unknown = rows => {const p = project(rows); assert.equal(p.rounds, null); assert.equal(p.steps, null); assert.equal(p.scope, 'unknown');};
const counts = (rows, rounds, steps) => {const p = project(rows); assert.equal(p.rounds, rounds); assert.equal(p.steps, steps);};
const checks = [];
const check = (name, fn) => {fn(); checks.push({name, pass: true});};

check('纯投影严格TypeScript检查', () => {
  const program = ts.createProgram(['src/modules/chat/sessionStats.ts'], {
    noEmit: true, strict: true, types: [], skipLibCheck: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  });
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);
});
for (const outcome of ['completed', 'failed', 'cancelled', 'max_tokens'])
  check(`${outcome}闭合终态均计一步一轮`, () => counts([closed('turn-1', 'step-1', outcome)], 1, 1));
check('同轮多步骤只计一轮', () => counts(['completed', 'failed', 'cancelled', 'max_tokens'].map((o, i) => closed('turn-1', `step-${i}`, o)), 1, 4));
check('轮次只包含至少一条closed step的turn', () => counts([closed(), closed('turn-2'), {...closed('empty'), type: 'turn/end'}, {...closed('open'), type: 'step/start'}, {type: 'rejected', turnId: 'rejected'}], 2, 2));
check('重复闭合事件与重放终态不重复计量', () => counts([closed(), closed(), {...closed(), outcome: 'failed'}], 1, 1));
check('同一stepId在不同turn中独立，组合身份无拼接碰撞', () => counts([closed('a:b', 'c'), closed('a', 'b:c'), closed('turn-2', 'step-1'), closed()], 4, 4));
check('直接事件与元信息重放共用去重', () => counts([closed(), batch([closed(), closed('turn-2')])], 2, 2));
check('合法版本和来源的metaJson闭合元信息可投影', () => counts([batch([{type: 'step/end', turnId: 't', stepId: 's', outcome: 'cancelled'}])], 1, 1));
check('旧会话无marker以及空输入保持未知', () => {unknown([]); unknown([{role: 'user'}, {role: 'assistant'}, {role: 'error'}]);});
check('工具、计划、usage和整CLI done均不是内部step', () => unknown([{type: 'toolUse'}, {type: 'toolResult'}, {type: 'usage'}, {type: 'planUpdate', items: [1, 2]}, {type: 'done', turnId: 't'}]));
check('不读取消息正文猜步骤', () => {const row = {role: 'assistant', get content() {throw new Error('禁止读取正文');}}; unknown([row]);});
check('open和未知outcome忽略，不把零猜成已知', () => unknown([{...closed(), type: 'step/start'}, {...closed(), outcome: 'open'}, {...closed(), outcome: 'unknown'}, {...closed(), outcome: 'done'}]));
check('非法标识与非终态不污染有效计数', () => {
  for (const value of [undefined, null, '', ' ', 1, NaN, {}, []]) {
    unknown([{...closed(), turnId: value}]); unknown([{...closed(), stepId: value}]);
  }
  counts([{...closed(), outcome: 'unknown'}, {...closed(), stepId: null}, closed('valid')], 1, 1);
});
check('非法JSON、schema、来源和容器均不采信', () => {
  for (const metaJson of ['{', 'null', '[]', '1', JSON.stringify({sessionStats: {rounds: 999, steps: 999}})]) unknown([{metaJson}]);
  for (const extra of [{schema: 'v0'}, {source: 'cli'}, {source: null}, {closedSteps: null}, {closedSteps: {}}, {closedSteps: 4}]) unknown([batch([], extra)]);
  unknown([null, 1, 'step/end', []]);
});
check('聚合snapshot数字不替代权威边界', () => unknown([batch(undefined, {rounds: 10, steps: 17, scope: 'session', complete: true})]));
check('显式空closedSteps标记保留可信零', () => counts([batch([])], 0, 0));
check('只有非法或open元信息不产生可信零', () => {unknown([batch([null, {type: 'step/start'}])]); unknown([batch([{...closed(), outcome: 'open'}])]);});
check('会话身份严格隔离，包括嵌套冲突', () => {
  unknown([{...closed(), sessionId: 'other'}]); unknown([{...closed(), sessionId: null}]);
  unknown([batch([], {sessionId: 'other'})]); unknown([{...batch([]), sessionId: 'other'}]);
  unknown([batch([{...closed(), sessionId: 'other'}])]);
  counts([closed(), {...closed('turn-2'), sessionId: 'other'}], 1, 1);
});
check('未提供会话上下文时不接受匿名边界', () => {
  assert.equal(projectSessionStats([{...closed(), sessionId: undefined}]).steps, null);
  counts([{...closed(), sessionId: undefined}], 1, 1);
});
check('分页窗口不误报会话全量', () => {
  assert.equal(project([closed()]).scope, 'window');
  for (const complete of [undefined, false]) assert.equal(projectSessionStats([closed()], {...options, scope: 'session', complete}).scope, 'window');
  assert.match(project([closed()]).source, /仅已载入窗口/);
});
check('完整原始边界集合需要明确complete才能标全量', () => {
  const p = projectSessionStats([closed(), closed('turn-2')], {...options, scope: 'session', complete: true});
  assert.equal(p.scope, 'session'); assert.equal(p.rounds, 2); assert.match(p.source, /完整会话覆盖/);
  for (const rows of [[{...closed(), scope: 'window'}], [closed(), {...closed('bad'), stepId: null}]])
    assert.equal(projectSessionStats(rows, {...options, scope: 'session', complete: true}).scope, 'window');
});
check('元信息窗口或伪全量声明不能升级覆盖范围', () => {
  for (const scope of ['window', 'session']) {
    const p = projectSessionStats([batch([closed()], {scope, complete: true})], {...options, scope: 'session', complete: true});
    assert.equal(p.scope, 'window');
  }
});
check('冻结输入不修改数据且重复投影稳定', () => {
  const rows = Object.freeze([Object.freeze(closed()), Object.freeze(batch([closed()]))]);
  assert.equal(JSON.stringify(project(rows)), JSON.stringify(project(rows)));
});

// 执行真实statsData的useMemo回调，验证限定接入，而非复制统计公式。
const ast = ts.createSourceFile('ChatPanel.tsx', panelSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'statsData'
    && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(callback && ts.isArrowFunction(callback));
function panelStats(msgs) {
  const exports = {};
  vm.runInNewContext(compile(`exports.data = (${callback.getText(ast)})();`, 'statsData.ts'),
    {exports, msgs, cur: {id: sid}, models: [], curRt: null, statsSnapshot: null, projectSessionStats});
  return exports.data;
}
check('ChatPanel旧用户消息不再冒充DSH turns', () => {
  const data = panelStats([{role: 'user'}, {role: 'user'}, {role: 'assistant'}]);
  assert.equal(data.rounds, null); assert.equal(data.steps, null); assert.equal(data.msgs, 3); assert.match(data.statsSource, /未上报权威闭合步骤边界/);
});
check('ChatPanel统计表达式从明确metadata取得轮步和窗口来源', () => {
  const data = panelStats([batch([closed(), closed('turn-2')])]);
  assert.equal(data.rounds, 2); assert.equal(data.steps, 2); assert.match(data.statsSource, /仅已载入窗口/);
});

let activeOverlay = 'session';
const barExports = {};
vm.runInNewContext(compile(barSource, 'StatsBar.tsx'), {exports: barExports, require: id => {
  if (id === './stats-bar.css') return {};
  if (id === './overlay') return {useChatOverlay: () => ({activeOverlay, toggle() {}})};
  if (id === './sessionRuntime') return {formatDur: ms => `${ms}ms`};
  return require(id);
}});
const html = data => renderToStaticMarkup(React.createElement(barExports.StatsBar, {data}));
check('未知轮步展示为横线并说明未上报', () => {
  const text = html(panelStats([{role: 'user'}]));
  assert.ok(text.includes('— 轮 — 步')); assert.match(text, /未上报权威闭合步骤边界/); assert.doesNotMatch(text, /NaN|Infinity/);
});
check('可信零轮步保留且窗口归因可见', () => {
  const text = html(panelStats([batch([])]));
  assert.ok(text.includes('0 轮 0 步')); assert.match(text, /仅已载入窗口，非全会话累计/); assert.ok(!text.includes('is-empty'));
});
check('三统计入口和工具耗时估算标识保持', () => {
  const text = html({...panelStats([closed()]), modelMs: 20, toolMs: 10});
  assert.equal((text.match(/data-chat-overlay-trigger=/g) ?? []).length, 3);
  assert.match(text, /10ms（估算）/); assert.match(text, /权威生成计时未上报/); assert.match(text, /工具耗时为事件差/);
});
console.log(JSON.stringify({scope: 'NestCraft/FEAT-012/DSH', checkedAt: new Date().toISOString(),
  status: 'passed', count: checks.length, checks,
  limitations: ['合成权威事件与SSR，不是DSH真实上游桥接', '当前UiMessage未保留metaJson；真实轮步应保持未知', '全项目构建、浏览器视觉及700ms动态滚动由协调者集成验证']}, null, 2));
