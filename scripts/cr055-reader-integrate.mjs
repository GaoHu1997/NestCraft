import fs from 'node:fs';
const file='src/modules/knowledge/Reader.tsx';let s=fs.readFileSync(file,'utf8');
function swap(a,b){if(s.split(a).length!==2)throw Error('Expected unique source: '+a.slice(0,100));s=s.replace(a,b)}
swap('import * as api from "@/api";',`import * as api from "@/api";
import * as performanceApi from '@/api/knowledge-performance';
import type { KnowledgeEntry, KnowledgeSearchResult } from '@/api/knowledge-performance';
import { PagedKnowledgeTree, type KnowledgeTreeHandle } from './PagedKnowledgeTree';
import { MarkdownContent } from './MarkdownContent';`);
swap('acceptSavedMarkdown, checkFileIdentity,','cacheKnowledgeFile, getKnowledgeFile, trimKnowledgeCache, knowledgeCacheStats, acceptSavedMarkdown, checkFileIdentity,');
swap('const [html, setHtml] = useState<string | null>(null);',`const [toc, setToc] = useState<TocEntry[]>([]);
  const updateToc = useCallback((entries: TocEntry[]) => setToc(entries), []);
  const directoryHandle = useRef<KnowledgeTreeHandle>(null);
  const knownEntries = useRef(new Map<string, NoteNode>());
  const [coverage, setCoverage] = useState<KnowledgeSearchResult | null>(null);
  const [searching, setSearching] = useState(false);`);
swap('const data = current ? session.files.get(draft?.noteId ?? current) : undefined;','const data = current ? getKnowledgeFile(session, draft?.noteId ?? current) : undefined;');
swap('const selected = current ? findNode(tree ?? [], draft?.noteId ?? current) : null;','const selected = current ? knownEntries.current.get(draft?.noteId ?? current) ?? null : null;');
swap('session.files.set(node.noteId, result); refresh();','cacheKnowledgeFile(session, node.noteId, result); refresh();');
swap('session.files.set(result.noteId, { info: savedInfo, text: result.content });','cacheKnowledgeFile(session, result.noteId, { info: savedInfo, text: result.content });');
swap('session.files.set(draft.noteId, result);','cacheKnowledgeFile(session, draft.noteId, result);');
const loadStart=s.indexOf('  const loadTree = useCallback(async () => {'),loadEnd=s.indexOf('\n  // Identity dependencies',loadStart);if(loadStart<0||loadEnd<0)throw Error('missing load section');
s=s.slice(0,loadStart)+`  const acceptEntries = useCallback((entries: KnowledgeEntry[]) => {
    for (const entry of entries) knownEntries.current.set(entry.noteId, { noteId: entry.noteId, title: entry.title, relativeUri: entry.relativeUri, isDir: entry.isDir, children: [] });
    setTree([...knownEntries.current.values()]); setTreeError(null);
    if (!session.current) session.current = initialNoteId || entries.find(entry => !entry.isDir)?.noteId || null;
    refresh();
  }, [initialNoteId, session, refresh]);
  const loadTree = useCallback(async () => {
    await directoryHandle.current?.refresh(session.selectedFolder);
  }, [session]);
  useEffect(() => {
    session.visible = visible; trimKnowledgeCache();
    if (!visible) { requestSeq.current += 1; setNoteLoading(false); setFolderMenu(null); setConfirm(null); return; }
    let alive = true;
    api.kbList().then(libraries => { if (alive && mounted.current && visibleRef.current) setLibrary(libraries.find(item => item.id === libId) ?? null); }).catch(error => { if (alive && mounted.current && visibleRef.current) { session.notice = '知识库元信息加载失败：' + errorText(error); refresh(); } });
    // Deep links need not enumerate the whole library. The backend resolves this file directly.
    const target = session.current || initialNoteId;
    if (target && !knownEntries.current.has(target) && !session.drafts.has(target)) {
      api.kbFileInfo(libId, target).then(metadata => {
        if (!alive || !mounted.current) return;
        knownEntries.current.set(target, { noteId: metadata.noteId, title: metadata.title, relativeUri: metadata.relativeUri, isDir: false, children: [] });
        session.current = metadata.noteId; setTree([...knownEntries.current.values()]); refresh();
      }).catch(error => { if (alive && mounted.current) setNoteError('文件定位失败：' + errorText(error)); });
    }
    return () => { alive = false; session.visible = false; trimKnowledgeCache(); treeSeq.current += 1; requestSeq.current += 1; };
  }, [libId, visible, initialNoteId, refresh, session]);
`+s.slice(loadEnd);
const mdStart=s.indexOf('  useEffect(() => {\n    let alive = true;\n    setHtml(null);'),mdEnd=s.indexOf('\n  useEffect(() => {\n    if (folderMenu',mdStart);if(mdStart<0||mdEnd<0)throw Error('missing render/search section');
s=s.slice(0,mdStart)+`  useEffect(() => {
    let alive = true, started = false;
    const requestId = crypto.randomUUID();
    setHits(null); setCoverage(null); setSearchError(null); setSearching(false);
    if (!query.trim() || !visible) return;
    setSearching(true);
    const timer = window.setTimeout(() => {
      started = true;
      performanceApi.searchIndexed(libId, query.trim(), requestId).then(result => {
        if (!alive) return;
        setCoverage(result); setHits(result.hits.filter(hit => hit.libraryId === libId));
      }).catch(error => { if (alive) setSearchError(errorText(error)); }).finally(() => { if (alive) setSearching(false); });
    }, 300);
    return () => { alive = false; window.clearTimeout(timer); if (started) void performanceApi.cancelSearch(libId, requestId).catch(() => {}); };
  }, [libId, query, visible]);
`+s.slice(mdEnd);
swap('session.current = key;','session.current = key; trimKnowledgeCache();');
swap('requestSeq.current += 1; setNoteError(null); setNoteLoading(false);','requestSeq.current += 1; setNoteError(null); setNoteLoading(!session.drafts.has(key));');
const tocLine=s.split('\n').find(l=>l.startsWith('  const toc = useMemo<TocEntry[]>'));if(!tocLine)throw Error('missing toc');s=s.replace(tocLine,'');
const treeStart=s.indexOf('  const renderTree = '),treeEnd=s.indexOf('  let imageSource:',treeStart);if(treeStart<0||treeEnd<0)throw Error('missing recursive tree');s=s.slice(0,treeStart)+s.slice(treeEnd);
swap('md ? <article className="kb-content kw-markdown" dangerouslySetInnerHTML={{ __html: html ?? "" }} />','md ? <MarkdownContent key={current ?? "empty"} documentKey={current ?? "empty"} source={body ?? ""} onToc={updateToc} />');
swap('data-design-version="UI-CR045-v1"','data-design-version="UI-CR055-FEAT009-v1.1"');
const asideLine=s.split('\n').find(l=>l.startsWith('    <aside {...treePane.paneProps}'));if(!asideLine)throw Error('missing sidebar');
s=s.replace(asideLine,`    <aside {...treePane.paneProps} ref={treeRef} className={\`kb-side kw-tree \${treePane.paneProps.className}\`} data-pane="kb-tree" id={\`kb-tree-\${libId}\`}>
      <div className="kb-side-top"><b className="row"><Icon name="book" size={14} />{library?.name ?? '知识库'}</b><div className="muted small">本机原件 · 按目录加载</div><PaneClose pane={treePane} label="知识文件树" className="icon-btn"><Icon name="x" size={14} /></PaneClose></div>
      <div className="kw-create-actions"><button className="btn sm" disabled={uploading || ownerDisabled} onClick={() => void upload()}><Icon name="upload" size={14} />{uploading ? '选择 / 上传中…' : '上传'}</button><button className="btn sm primary" disabled={ownerDisabled} onClick={() => newMarkdown('')}><Icon name="filePlus" size={14} />新建 MD</button><button className="btn sm" disabled={ownerDisabled} aria-label="在库根目录新建文件夹" onClick={() => createFolder('')}><Icon name="folderPlus" size={14} /></button></div>
      <div className="kb-search"><input className="input" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索已索引文件或正文" aria-label="搜索已索引文件或正文" /></div>
      <div className="kb-side-body kb-docs kp-docs">
        {session.folderInput && folderEditor(session.folderInput.parent, 0)}
        {query.trim() ? <>
          <div className="kw-search-summary"><span>索引检索</span><button onClick={() => setQuery('')}>清除</button></div>
          {searching && <div className="kp-reading-state" role="status">正在查询已发布索引…</div>}
          {searchError && <div className="kp-reading-state error" role="alert">{searchError}</div>}
          {coverage && <div className="kp-coverage" role="status">{coverage.coverage.state === 'not_indexed' ? '当前尚无可查询的正文索引；目录盘点不等于全文索引。' : \`索引快照 v\${coverage.indexEpoch} · 原件待核验\${coverage.coverage.incomplete ? ' · 结果覆盖不完整' : ''}\${coverage.coverage.metadataOnlyCount ? ' · 含仅元信息命中' : ''}。已变化源核验前不发送给 AI。\`}</div>}
          {!searching && coverage?.coverage.state === 'ready' && hits?.length === 0 && <div className="kw-empty">当前索引范围内无匹配结果</div>}
          {hits?.map(hit => <button className="kb-search-hit" key={hit.libraryId + ':' + hit.noteId} onClick={() => { knownEntries.current.set(hit.noteId, { noteId: hit.noteId, title: hit.title, relativeUri: hit.relativeUri, isDir: false, children: [] }); select(hit.noteId); }}><b>{hit.title}</b><small>{hit.relativeUri}</small><span>{hit.snippet}</span></button>)}
        </> : <PagedKnowledgeTree ref={directoryHandle} libraryId={libId} visible={visible} model={session.directory} selected={current} disabled={ownerDisabled} onEntries={acceptEntries}
          onOpen={entry => select(entry.noteId)} onFolder={entry => { session.selectedFolder = entry.relativeUri; refresh(); }} onCreateFolder={createFolder} onCreateDocument={newMarkdown} />}
      </div>
    </aside>`);
swap('正文不自动加载外链图片或本地资源；Office / PDF 仅元信息与原件导出。AI 全格式解析 / FTS5 未接入。','正文不自动加载外链图片或本地资源。目录盘点与正文索引分别处理；Office / PDF 解析能力按实际后端反馈。');
fs.writeFileSync(file,s);console.log('Reader integrated with exact-match protections');
