import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { transformSync } from 'esbuild';

const sourcePath = 'src/modules/chat/messagePresentation.ts';
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' });
const p = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);
let passed = 0;
const check = (title, fn) => { fn(); passed++; console.log(`PASS ${title}`); };
const tool = (name, id, input = null, opts = {}) => ({ part: opts.part ?? 'both', pair: { name, toolId: id, inputJson: input, useMsg: opts.orphan ? null : { streaming: opts.streaming }, result: opts.pending ? null : { content: 'original output', isError: opts.error ?? false }, resultMsg: opts.pending ? null : { exitCode: opts.exitCode ?? 0 } } });
check('known identities, namespaces and unknown fallback', () => {
  for (const name of ['Read', 'grep', 'glob', 'search', 'web_fetch', 'mcp__fs__read_file']) assert.equal(p.classifyTool(name), 'explore');
  for (const name of ['Bash', 'shell', 'command_execution', 'functions.exec_command', 'pwsh']) assert.equal(p.classifyTool(name), 'run');
  for (const name of ['Write', 'Edit', 'ApplyPatch', 'apply_patch']) assert.equal(p.classifyTool(name), 'change');
  for (const name of ['unknown', 'custom_search_products', 'readiness', null]) assert.equal(p.classifyTool(name), null);
});
check('completed mixed group and change icon priority', () => {
  const summary = p.summarizeTools([tool('Read', 'r'), tool('Bash', 'b'), tool('Edit', 'e', '{"file_path":"src/a.ts"}')]);
  assert.equal(summary.text, '已查阅 1 项，已执行 1 命令，已修改 1 文件'); assert.equal(summary.category, 'change'); assert.equal(summary.failed, false);
});
check('distinct tool ids and result-only group do not reexecute', () => {
  const call = tool('Bash', 'a', null, { part: 'call' }); const result = { ...call, part: 'result' };
  assert.equal(p.summarizeTools([call, result, call]).text, '已执行 1 命令');
  assert.equal(p.summarizeTools([result, tool('Read', 'b', null, { part: 'result' })]).text, '已返回 2 项结果');
});
check('mixed failure is visible and does not claim successful change', () => {
  const summary = p.summarizeTools([tool('Edit', 'e', '{"path":"a.ts"}', { exitCode: 3 }), tool('Bash', 'b')]);
  assert.equal(summary.failed, true); assert.match(summary.text, /有失败/); assert.doesNotMatch(summary.text, /已修改|已执行/);
});
check('unknown tools never gain semantic counts', () => {
  assert.equal(p.summarizeTools([tool('custom_search_products', 'u')]).text, '工具记录 1 项');
});
check('input-only explicit changed paths and lexical deduplication', () => {
  assert.equal(p.normalizeMessagePath('src\\a\\..\\b.ts'), 'src/b.ts');
  const items = [tool('Edit','e','{"file_path":"src/./a.ts"}'), tool('Write','w','{"path":"src/x/../a.ts"}'), tool('Edit','n','{"description":"edit file b.ts"}')];
  assert.equal(p.summarizeTools(items).text, '已修改 1 文件，修改操作 1 项');
  assert.deepEqual(p.changedInputPaths(JSON.stringify({patch:'*** Update File: src/a.ts\n*** Add File: src/b.ts\n'})), ['src/a.ts','src/b.ts']);
  assert.deepEqual(p.changedInputPaths('{"output":"src/not-an-input.ts","cwd":"src"}'), []);
});
check('all JSON primitive, nested and invalid inputs preserved', () => {
  for (const raw of ['false','0','null','[]','[false,0,null,{"nested":[1,2]}]','{"nested":{"ok":false,"count":0,"other":null}}']) assert.deepEqual(JSON.parse(p.presentToolInput(raw).inputText), JSON.parse(raw));
  const original = '{"command":"printf raw\\ncommand","cwd":"D:/workspace","timeout":0,"env":{"X":false},"array":[0,null]}';
  const input = p.presentToolInput(original); assert.equal(input.command, 'printf raw\ncommand');
  assert.deepEqual(JSON.parse(input.parametersText), {cwd:'D:/workspace',timeout:0,env:{X:false},array:[0,null]});
  assert.equal(p.presentToolInput('{invalidJSON').inputText, '{invalidJSON');
});
check('history duration is timestamp span with missing and invalid fallback', () => {
  assert.equal(p.workDurationMs(1000, 3286000), 3285000); assert.equal(p.formatMessageDuration(3285000), '54 分 45 秒');
  assert.equal(p.workDurationMs(undefined, Date.now()), null); assert.equal(p.workDurationMs(500, 100), null); assert.equal(p.workDurationMs(NaN, 100), null);
  assert.equal(p.formatMessageDuration(48000), '48 秒'); assert.equal(p.formatMessageDuration(0), '0 秒');
});
check('agent type and lifecycle are source-only with unknown fallback', () => {
  assert.deepEqual(p.presentAgent('Explore waiting'), {type:'Explore',status:'等待中'});
  assert.deepEqual(p.presentAgent('claude'), {type:'子智能体',status:'状态未知'});
  assert.deepEqual(p.presentAgent('Explore completed'), {type:'Explore',status:'已完成'});
  assert.deepEqual(p.presentAgent('running completed'), {type:'子智能体',status:'状态未知'});
});
const messagePath = 'src/modules/chat/MessageList.tsx';
const current = fs.readFileSync(messagePath, 'utf8').replace(/\r\n/g, '\n');
const baseline = execFileSync('git', ['show', `HEAD:${messagePath}`], {encoding:'utf8'}).replace(/\r\n/g, '\n');
const slice = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
check('protected pairing, turns and transport model match baseline', () => {
  for (const [start,end] of [['function parseJson<T>','/* ---------- 图片路径解析 ---------- */'],['function buildBlocks(','function briefOf('],['function buildTurns(','function toolKey(']]) {
    const currentEnd = end === 'function briefOf(' ? 'function ToolSummaryIcon(' : end;
    assert.equal(slice(current,start,currentEnd),slice(baseline,start,end));
  }
});
check('protected markdown, images, user refs and locate behavior match baseline', () => {
  const protectedMarkdown = current.replace(/    \/\/ 表格保留原生横向滚动[\s\S]*?wrapper.appendChild\(table\);\n    }\n/, '');
  assert.equal(slice(protectedMarkdown,'function resolveImgSrc(','/* ---------- 工具块'), slice(baseline,'function resolveImgSrc(','/* ---------- 工具块'));
  assert.equal(slice(current,'  if (m.role === "user") {','  if (m.role === "assistant") {'), slice(baseline,'  if (m.role === "user") {','  if (m.role === "assistant") {'));
  assert.equal(current.slice(current.indexOf('function RefChip(')), baseline.slice(baseline.indexOf('function RefChip(')));
});
check('presentation native details and removed fabricated metadata', () => {
  assert.doesNotMatch(current, /General Purpose|chat-think-size|条工具记录/);
  assert.match(current, /className="chat-toolblock/); assert.match(current, /className="chat-tool-detail"/);
  assert.match(current, /onOpenAgent\?\.\(m.producerId!/);
  const assistant = slice(current,'  if (m.role === "assistant") {','  if (m.role === "subagent") {');
  assert.doesNotMatch(assistant, /chat-msg-time/);
});
check('tsx and helper transpile with zero warnings', () => {
  for (const file of [messagePath,sourcePath]) assert.equal(transformSync(fs.readFileSync(file,'utf8'), {loader:file.endsWith('tsx')?'tsx':'ts',target:'es2022'}).warnings.length,0);
});
console.log(`${passed} focused presentation checks passed. Browser, native UI and visual acceptance are not covered.`);
