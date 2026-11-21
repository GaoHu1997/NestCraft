/**
 * CR-055 / FEAT-009 复审修复的模型级回归（R02/R03/R05/R08）。
 * 只验证纯模型与工作区账本，不读取真实文件系统、不挂载真实 DOM、不代表视觉或进程内存。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';

const checks = [];
const bundle = async (entry, extra = {}) => {
  const built = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', ...extra });
  return import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
};
const pm = await bundle('src/modules/knowledge/performanceModel.ts');
const ws = await bundle('src/modules/knowledge/knowledgeWorkspace.ts', { alias: { '@/components/ui': './scripts/cr055-workspace-stub.mjs' } });

// ---------------------------------------------------------------- R02 留存分账
assert.equal(pm.draftRetentionBytes('ab', 'cde'), 512 + 2 * 5);
assert.equal(pm.domRetentionBytes(3, 40, 1000), 3 * 512 + 40 * 96 + 1000 * 2);
assert.equal(pm.retentionTotal({ cleanBytes: 100, draftBytes: 200, domBytes: 300, budgetBytes: 1000 }), 600);

const planCleanFirst = pm.planRetentionAdmission({ cleanBytes: 900, draftBytes: 300, domBytes: 0, budgetBytes: 1000, incomingBytes: 100, evictableCleanBytes: 900, evictableDraftBytes: 100 });
assert.deepEqual(
  { admit: planCleanFirst.admit, evictClean: planCleanFirst.evictCleanBytes, evictDraft: planCleanFirst.evictDraftBytes, total: planCleanFirst.totalBytes, target: planCleanFirst.cleanTargetBytes },
  { admit: true, evictClean: 200, evictDraft: 100, total: 1000, target: 700 },
);
const planCleanEnough = pm.planRetentionAdmission({ cleanBytes: 600, draftBytes: 100, domBytes: 0, budgetBytes: 1000, incomingBytes: 100, evictableCleanBytes: 600, evictableDraftBytes: 100 });
assert.equal(planCleanEnough.evictCleanBytes, 0);
assert.equal(planCleanEnough.evictDraftBytes, 0);
assert.equal(planCleanEnough.admit, true);
const planDraftSecond = pm.planRetentionAdmission({ cleanBytes: 600, draftBytes: 300, domBytes: 100, budgetBytes: 1000, incomingBytes: 100, evictableCleanBytes: 0, evictableDraftBytes: 100 });
assert.equal(planDraftSecond.evictCleanBytes, 0);
assert.equal(planDraftSecond.evictDraftBytes, 100);
assert.equal(planDraftSecond.admit, true);
const planRefuse = pm.planRetentionAdmission({ cleanBytes: 600, draftBytes: 300, domBytes: 100, budgetBytes: 1000, incomingBytes: 500, evictableCleanBytes: 0, evictableDraftBytes: 0 });
assert.equal(planRefuse.admit, false);
assert.equal(planRefuse.pressure, true);
checks.push('R02 分账：清洁/草稿/DOM 三类按同一预算计算，公式与总占用可复算');
checks.push('R02 准入顺序：先驱逐清洁正文，再回收已保存且无修改的草稿，最后拒绝并给压力反馈');

// ---------------------------------------------------------------- R02 工作区集成
ws.configureKnowledgeCacheBudget(5000);
const session = ws.knowledgeSession('cr055-r02-lib');
const info = (id, text) => ({ noteId: id, title: id, relativeUri: `${id}.md`, sizeBytes: text.length, kind: 'markdown', mime: 'text/markdown', previewSupported: true, editable: true, hash: 'h1' });
const file = (id, text) => ({ info: info(id, text), text });
const makeDraft = over => ({ key: over.key, editorKey: over.key, noteId: over.noteId ?? null, parent: '', title: over.title ?? 't', body: over.body ?? '', baseTitle: over.baseTitle ?? over.title ?? 't', baseBody: over.baseBody ?? over.body ?? '', expectedHash: null, mode: 'read', saving: false, error: '', conflict: false, ...over });
const unsaved = makeDraft({ key: 'local-draft:1', title: 't', body: 'x'.repeat(600) });
const savedClean = makeDraft({ key: 'n2', noteId: 'n2', title: 'n', body: 'y'.repeat(100), baseTitle: 'n', baseBody: 'y'.repeat(100) });
session.drafts.set(unsaved.key, unsaved);
session.drafts.set(savedClean.key, savedClean);
assert.equal(ws.cacheKnowledgeFile(session, 'n1', file('n1', 'a'.repeat(300))), true);
assert.equal(ws.cacheKnowledgeFile(session, 'n3', file('n3', 'b'.repeat(300))), true);
let stats = ws.knowledgeCacheStats(session);
assert.equal(stats.draftBytes, pm.draftRetentionBytes('t', 'x'.repeat(600)) + pm.draftRetentionBytes('n', 'y'.repeat(100)));
assert.equal(stats.totalBytes, stats.cleanBytes + stats.draftBytes + stats.domBytes);
checks.push('R02 账本：knowledgeCacheStats 同时暴露 cleanBytes/draftBytes/domBytes/totalBytes/budgetBytes');

// 首次准入：清洁正文足够，不回收已保存草稿
assert.equal(ws.canAdmitKnowledgeFile(session, 'n4', 500), true);
assert.equal(session.drafts.has('n2'), true);
checks.push('R02 准入：清洁正文可回收时优先驱逐清洁文件，已保存草稿暂不回收');

// 清洁正文被约束（当前文件受保护）后，回收已保存且无修改的草稿，但保留未保存草稿
session.visible = true; session.current = 'n3';
assert.equal(ws.canAdmitKnowledgeFile(session, 'n5', 1000), true);
assert.equal(session.drafts.has('n2'), false);
assert.equal(session.drafts.has('local-draft:1'), true);
checks.push('R02 淘汰：清洁不足时回收已保存且清洁的草稿，未保存草稿不被驱逐');

// 只剩未保存草稿时拒绝新载入并给压力反馈
assert.equal(ws.canAdmitKnowledgeFile(session, 'n6', 5000), false);
assert.equal(session.cachePressure, true);
assert.match(session.notice, /预算/);
assert.equal(session.drafts.has('local-draft:1'), true);
checks.push('R02 拒绝：预算不足时不驱逐未保存草稿，返回压力反馈且不伪造载入成功');

// DOM 估算进入同一账本，卸载后释放
ws.recordKnowledgeDocumentRetention(session, 'n7', { blocks: 2, nodes: 20, htmlChars: 1000 });
assert.equal(ws.knowledgeCacheStats(session).domBytes, 2 * 512 + 20 * 96 + 1000 * 2);
assert.equal(session.cachePressure, true);
ws.recordKnowledgeDocumentRetention(session, 'n7', null);
assert.equal(ws.knowledgeCacheStats(session).domBytes, 0);
checks.push('R02 DOM：已加载文档的保守 DOM 估算计入总账本，卸载后释放');
ws.configureKnowledgeCacheBudget(128 * 1024 * 1024);

// ---------------------------------------------------------------- R03 目录与正文
const known = new Map();
const node = (id, uri) => ({ noteId: id, relativeUri: uri, title: id, isDir: false, children: [] });
known.set('a1', { ...node('a1', 'A/a1.md'), parentUri: 'A' });
known.set('a2', { ...node('a2', 'A/a2.md'), parentUri: 'A' });
known.set('b1', { ...node('b1', 'B/b1.md'), parentUri: 'B' });
known.set('deep', { ...node('deep', 'X/deep.md'), external: true });
let removed = pm.reconcileKnownEntries(known, { parentUri: 'A', entries: [node('a1', 'A/a1.md')], complete: true }, { keep: new Set(), reachable: new Set(['a1']), rootComplete: false });
assert.deepEqual(removed.sort(), ['a2', 'b1']);
assert.equal(known.has('a1'), true);
assert.equal(known.has('deep'), true);
removed = pm.reconcileKnownEntries(known, { parentUri: '', entries: [], complete: true }, { keep: new Set(), reachable: new Set(['a1']), rootComplete: true });
assert.deepEqual(removed, ['deep']);
checks.push('R03 目录：刷新按可达实体清理已删除子树，外部深链节点只在根完整刷新且不存在时清理');

const kept = new Map([['keep', { ...node('keep', 'A/keep.md'), parentUri: 'A' }]]);
pm.reconcileKnownEntries(kept, { parentUri: 'A', entries: [], complete: true }, { keep: new Set(['keep']), reachable: new Set(), rootComplete: true });
assert.equal(kept.has('keep'), true);
checks.push('R03 目录：当前选中/草稿对应节点不被清理，供界面提示“文件已不存在”');

const base = { noteId: 'n1', title: 't', baseTitle: 't', body: 'b', baseBody: 'b', sourceRevision: 'r1' };
assert.equal(pm.sourceRevisionDecision(undefined, 'r1'), 'reload');
assert.equal(pm.sourceRevisionDecision({ ...base }, 'r1'), 'none');
assert.equal(pm.sourceRevisionDecision({ ...base }, 'r2'), 'drop-clean-draft');
assert.equal(pm.sourceRevisionDecision({ ...base, body: 'changed' }, 'r2'), 'warn-dirty');
assert.equal(pm.sourceRevisionDecision({ ...base, sourceRevision: null }, 'r2'), 'none');
assert.equal(pm.sourceRevisionDecision({ ...base, noteId: null }, 'r2'), 'none');
assert.equal(pm.sourceRevisionDecision({ ...base }, undefined), 'none');
checks.push('R03 正文：sourceRevision 变化时清洁正文重读、清洁草稿释放、dirty 草稿保留并提示');

// 新建嵌套目录：父项不在当前页时按路径逐级定位并刷新父页，而不是刷新新建的空目录。
const nested = new pm.DirectoryModel();
const dir = (id, uri) => ({ id, noteId: id, title: id, relativeUri: uri, isDir: true, sizeBytes: '0', sourceRevision: 's', hasChildren: true });
const pageOf = items => ({ items, directoryRevision: 'd1', nextCursor: null, complete: true, scanState: 'ready', taskId: null, error: null });
let req = nested.begin('');
nested.accept('', req, pageOf([dir('A', 'A')]), false);
req = nested.begin('A');
nested.accept('A', req, pageOf([dir('B', 'A/B')]), false);
assert.deepEqual(pm.directoryPathSegments('A\\B/C/'), ['A', 'B', 'C']);
assert.equal(pm.findDirectoryId(nested.entries.values(), 'a\\b'), 'B');
assert.equal(pm.findDirectoryId(nested.entries.values(), 'A'), 'A');
assert.equal(pm.findDirectoryId(nested.entries.values(), 'A/B/C'), null);
checks.push('R03 新建目录：父项不在当前页时按路径逐级解析，刷新父目录而非新建的空目录');

// ---------------------------------------------------------------- R05 稳定焦点
const row = (key, kind = 'entry') => ({ key, kind });
assert.deepEqual(pm.resolveTreeLead([row('a'), row('b'), row('c')], 'b', 1), { index: 1, key: 'b' });
assert.deepEqual(pm.resolveTreeLead([row('b'), row('c')], 'b', 1), { index: 0, key: 'b' });
assert.deepEqual(pm.resolveTreeLead([row('a'), row('c')], 'b', 1), { index: 1, key: 'c' });
assert.deepEqual(pm.resolveTreeLead([row('c'), row('a')], 'b', 1), { index: 1, key: 'a' });
assert.deepEqual(pm.resolveTreeLead([row('a'), row('more:'), row('more2', 'more')], 'more:', 1), { index: 1, key: 'more:' });
assert.deepEqual(pm.resolveTreeLead([row('a'), row('more', 'more')], 'missing', 1), { index: 1, key: 'more' });
assert.deepEqual(pm.resolveTreeLead([row('a', 'status'), row('b', 'status')], 'a', 0), null);
assert.deepEqual(pm.resolveTreeLead([row('a')], 'gone', 5), { index: 0, key: 'a' });
checks.push('R05 焦点：删除前项/当前项、重排、翻页与全状态行时按稳定 key 映射到最近可聚焦行');

// ---------------------------------------------------------------- R08 TOC
assert.equal(pm.clampTocLead(120, 50), 50);
assert.equal(pm.clampTocLead(10, 50), 9);
assert.equal(pm.clampTocLead(0, 50), -1);
assert.equal(pm.clampTocLead(10, -3), 0);
assert.equal(pm.clampTocLead(10, 3.7), 3);
assert.equal(pm.tocMoveTarget(120, 50, 1), 51);
assert.equal(pm.tocMoveTarget(10, 50, 1), 9);
assert.equal(pm.tocMoveTarget(120, 119, 1), 119);
assert.equal(pm.tocMoveTarget(0, 0, 1), -1);
const farWindow = pm.visibleRange(500, pm.tocScrollTarget(500, 499, 420, 28), 420, 28, 5);
assert.ok(farWindow.start <= 499 && 499 < farWindow.end);
const nearWindow = pm.visibleRange(500, pm.tocScrollTarget(500, 0, 420, 28), 420, 28, 5);
assert.ok(nearWindow.start <= 0 && 0 < nearWindow.end);
checks.push('R08 目录：长→短收缩后 lead/选中项限幅；键盘移到未挂载标题先滚动使其进入虚拟窗口');

// ---------------------------------------------------------------- R09 v1.4 提示动作
// 复审发现的四处设计/软件不一致：reload-original 按钮缺失、selection-gone 无刷新入口、
// budget 文案两套、data-design-version 仍为 v1.3。这里按模型 + 组件接线两层断言。
const readerSource = fs.readFileSync('src/modules/knowledge/Reader.tsx', 'utf8');
const noticeCss = fs.readFileSync('src/modules/knowledge/knowledge-cr045.css', 'utf8');

// R09-1 external-change：dirty 草稿保留，提示条提供「放弃草稿并重新读取」，必须二次确认后才释放。
const dirtyDraft = { noteId: 'n1', title: 't', baseTitle: 't', body: 'edited', baseBody: 'b', sourceRevision: 'r1' };
const externalChange = pm.externalChangeNotice(dirtyDraft, 'r2');
assert.equal(externalChange.kind, 'external-change');
assert.equal(externalChange.text, '原件已在外部变化，当前未保存草稿保留；保存时会提示版本冲突。');
assert.deepEqual(externalChange.action, { id: 'reload-original', label: '放弃草稿并重新读取', confirm: true });
assert.equal(pm.externalChangeNotice({ ...dirtyDraft, body: 'b' }, 'r2'), null);
assert.equal(pm.externalChangeNotice({ ...dirtyDraft, sourceRevision: 'r2' }, 'r2'), null);
assert.equal(pm.externalChangeNotice(dirtyDraft, undefined), null);
assert.equal(pm.draftReleaseConfirmed({ title: 't', body: 'edited' }, dirtyDraft), true);
assert.equal(pm.draftReleaseConfirmed({ title: 't', body: 'edited' }, { ...dirtyDraft, body: 'edited 期间又输入' }), false);
assert.equal(pm.draftReleaseConfirmed({ title: 't', body: 'edited' }, { ...dirtyDraft, title: 't2' }), false);
assert.match(readerSource, /noticeAction && <button[^>]*id=\{noticeAction\.id\}[^>]*data-action=\{noticeAction\.id\}/);
assert.match(readerSource, /if \(noticeAction\.confirm\) setConfirm\("reload-original"\)/);
assert.match(readerSource, /const reloadOriginal = async/);
assert.match(readerSource, /draftReleaseConfirmed\(snapshot, target\)/);
assert.match(readerSource, /session\.drafts\.delete\(snapshot\.key\)/);
checks.push('R09-1 v1.4 external-change：dirty 草稿不被静默替换，提示条渲染「放弃草稿并重新读取」动作且需二次确认，确认期间有输入则保留草稿');

// R09-2 selection-gone：只提示 + 刷新目录入口，复用 PagedKnowledgeTree 的 refresh 句柄，不跳转、不清草稿。
const selectionGone = pm.selectionGoneNotice();
assert.equal(selectionGone.text, '所选文件已不存在；不会跳到其它文件或清除草稿。');
assert.deepEqual(selectionGone.action, { id: 'refresh-directory', label: '刷新目录', confirm: false });
assert.match(readerSource, /setSelectionGone\(true\); setNoteError\(selectionGoneNotice\(\)\.text\)/);
assert.match(readerSource, /id="refresh-directory" data-action="refresh-directory" onClick=\{\(\) => void refreshDirectory\(\)\}/);
assert.match(readerSource, /const refreshDirectory = async[\s\S]{0,400}await loadTree\(\)/);
assert.match(readerSource, /directoryHandle\.current\?\.refresh\(session\.selectedFolder\)/);
assert.ok(!/setNoteLoading\(false\); setNoteError\("所选文件已不存在/.test(readerSource));
checks.push('R09-2 v1.4 selection-gone：提示区动作换成「刷新目录」，复用既有 loadTree→refreshTree 句柄，不跳到其它文件也不清除草稿');

// R09-3 budget：常驻压力横幅与准入拒绝共用一条 v1.4 文案，不再有两套说法。
const budgetText = '阅读缓存已达预算；清洁正文和已保存且无修改的草稿可回收，未保存草稿保留。请先关闭不需要的清洁文档后重试。';
assert.equal(ws.CACHE_PRESSURE_NOTICE, budgetText);
assert.equal(readerSource.split('CACHE_PRESSURE_NOTICE').length - 1 >= 2, true);
assert.ok(!readerSource.includes('清洁正文可回收'));
assert.ok(!readerSource.includes(budgetText), '提示文案只允许来自 CACHE_PRESSURE_NOTICE 常量，不在组件内再写一遍');
assert.match(readerSource, /session\.cachePressure && <div className="kw-notice kw-notice-pressure" role="status"><span>\{CACHE_PRESSURE_NOTICE\}<\/span>/);
checks.push('R09-3 v1.4 budget：压力横幅与准入拒绝文案统一为设计定稿一句（单常量来源，旧文案已消除）');

// R09-4 设计版本声明与 UI-SCROLL-001（提示条不截断、不占正文宽度）。
assert.match(readerSource, /data-design-version="UI-CR055-FEAT009-v1\.4"/);
assert.ok(!readerSource.includes('data-design-version="UI-CR055-FEAT009-v1.3"'));
assert.match(noticeCss, /\.kw-notice \{[^}]*flex-wrap: wrap/);
assert.ok(!/\.kw-notice[^{]*\{[^}]*overflow: hidden/.test(noticeCss));
checks.push('R09-4 v1.4 版本与滚动：data-design-version=UI-CR055-FEAT009-v1.4，提示条只换行不截断（无 overflow:hidden，不改变正文宽度）');

const result = { checks, count: checks.length, limitations: ['未测量真实 DOM/像素/进程内存，DOM 为保守估算', '未做真实鼠标+键盘动态回归与真实文件系统端到端', '未验证完整应用视觉', 'v1.4 提示动作只做模型与组件接线断言，未在真实 WebView 挂载 Reader 组件'] };
fs.writeFileSync('docs/Test/cr055-reader-regression.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));