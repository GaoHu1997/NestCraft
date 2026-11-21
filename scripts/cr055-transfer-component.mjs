import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
await build({
  entryPoints: ['scripts/cr055-transfer-render.tsx'],
  outfile: 'docs/tmp/transfer-render.bundle.mjs',
  bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', packages: 'external',
  tsconfig: 'tsconfig.json', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' },
});
const { renders } = await import(pathToFileURL('docs/tmp/transfer-render.bundle.mjs').href);
const checks = [], has = (name, ...needles) => { for (const needle of needles) assert.ok(renders[name].includes(needle), `${name} 缺少「${needle}」`); checks.push(`${name}: ${needles.join(' / ')}`); };
const missing = (name, ...needles) => { for (const needle of needles) assert.ok(!renders[name].includes(needle), `${name} 不应出现「${needle}」`); checks.push(`${name} 不含: ${needles.join(' / ')}`); };

has('copyingMulti', '第 2 / 3 个文件 · 已完成 1 / 3', '当前文件已处理 1,234,567,890 / 4,294,967,296 字节', 'aria-valuenow="42"', '复制中');
has('completedPendingIndex', '已完成 · 索引待建立', '已导入 3 个原件', '共 6,442,450,944 字节', '原件已导入，全文索引待建立', '刷新当前目录', 'SHA-256');
missing('completedPendingIndex', '索引已完成', '可全文检索');
has('completedExport', '完整原件已写出', '不是当前阅读窗口片段', '复制校验值', '5,368,709,120');
has('partialFailure', '部分失败', '已完成 2 / 3', 'c.zip', '同名文件已存在', '部分成功不回滚', '重试失败项');
has('expired', '结果已过期', 'TRANSFER_NOT_FOUND', '重新发起', '不把旧快照当成进行中或成功');
missing('expired', '取消…');
has('cancelled', '已取消', '未完成的文件未写入目标目录', '重新开始');
has('picking', '等待选择原件', '取消…', '此阶段可取消');
has('cancelRequested', '已请求取消');
missing('cancelRequested', '确认取消');
has('cancelConfirm', '取消导入？', '不会留下半成品', '确认取消', '继续');
has('busyDisabled', 'disabled');
assert.equal(renders.scopeIsolation, '', '无任务时不渲染面板');
checks.push('scopeIsolation: 空作用域渲染为 null（切文件不显示旧任务）');
const result = { kind: 'production React component renderToStaticMarkup (no Tauri IPC, no visual design pass)', count: checks.length, checks };
fs.writeFileSync('docs/Test/cr055-transfer-component.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
