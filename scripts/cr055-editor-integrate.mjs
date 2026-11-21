import fs from 'node:fs';
const file='src/modules/editor/index.tsx';let s=fs.readFileSync(file,'utf8');
function change(a,b){if(!s.includes(a))throw Error('missing '+a.slice(0,100));s=s.replace(a,b)}
function section(a,b,value){const i=s.indexOf(a),j=s.indexOf(b,i);if(i<0||j<0)throw Error('section missing');s=s.slice(0,i)+value+s.slice(j)}
change('Compartment, EditorState, Prec, StateEffect, StateField','Compartment, EditorState, Prec, StateEffect, StateField, Text');
change('import "./CodeArea.css";','import { DirtyTracker, SaveQueue } from "./performance-model";\nimport { loadDocument, saveDocument } from "./document-session";\nimport { WindowPreview } from "./WindowPreview";\nimport "./CodeArea.css";');
change('saved: string; // 已保存内容（脏标记基准）','saved: Text; // Immutable checkpoint; typing never creates a full string.\n  tracker: DirtyTracker | null;\n  queue: SaveQueue<Text> | null;\n  autoSaveTimer?: number;\n  saving: boolean;\n  saveError: string | null;\n  hash: string;\n  encoding: string;\n  lineEnding: string;\n  mixedLineEndings: boolean;\n  preview: boolean;\n  windowOnly: boolean;\n  sizeBytes: number;');
change('function MarkdownReading({ tab, source }','function emptyTab(path: string): Tab {\n  return { path, saved: Text.empty, dirty: false, binary: false, state: null, scroll: 0, scrollLeft: 0, readScroll: 0, mode: "editing", tracker: null, queue: null, saving: false, saveError: null, hash: "", encoding: "utf-8", lineEnding: "\\n", mixedLineEndings: false, preview: false, windowOnly: false, sizeBytes: 0 };\n}\n\nfunction MarkdownReading({ tab, source }');
change('const [closeTarget, setCloseTarget] = useState<string | null>(null);','const [closeTarget, setCloseTarget] = useState<string | null>(null);\n  const [openingStatus, setOpeningStatus] = useState<string | null>(null);');
section('  const saveActive = useCallback(async () => {','  // Reading has no focused CodeMirror;',`  const saveTab = useCallback((tab: Tab, retry = false) => {
    window.clearTimeout(tab.autoSaveTimer);
    if (!tab.dirty || !tab.state || !tab.queue || (tab.saveError && !retry)) return;
    if (retry) tab.saveError = null;
    void tab.queue.request(tab.state.doc).catch(e => {
      tab.saveError = errMsg(e); if (tabsRef.current.includes(tab)) rerender();
    });
  }, [rerender]);
  const saveActive = useCallback(async () => {
    const tab = tabsRef.current.find(t => t.path === activeRef.current);
    if (!tab || tab.binary || tab.windowOnly) return;
    if (viewRef.current) tab.state = viewRef.current.state;
    saveTab(tab, true);
  }, [saveTab]);

`);
section('      tab.state = u.state;\n      const dirty =','    },\n    [rerender]',`      tab.state = u.state;
      tab.tracker?.update(u.state.doc);
      window.clearTimeout(tab.autoSaveTimer);
      if (tab.dirty && !tab.saveError) tab.autoSaveTimer = window.setTimeout(() => saveTab(tab), 1000);
`);
change('    [rerender]\n  );','    [rerender, saveTab]\n  );');
change('EditorView.updateListener.of(onUpdate),','EditorView.updateListener.of(onUpdate),\n      EditorView.domEventHandlers({ blur: () => { const tab = tabsRef.current.find(t => t.path === activeRef.current); if (tab) saveTab(tab); return false; } }),');
change('[saveActive, onUpdate, langComp, themeComp, fontComp]','[saveActive, saveTab, onUpdate, langComp, themeComp, fontComp]');
change('    tabsRef.current = [];','    for (const tab of tabsRef.current) { window.clearTimeout(tab.autoSaveTimer); tab.tracker?.dispose(); tab.queue?.dispose(); }\n    tabsRef.current = [];\n    setOpeningStatus(null);');
change('          curTab.state = view.state;','          curTab.state = view.state;\n          saveTab(curTab);');
change('[extensions, applyCompartments, rerender]\n  );','[extensions, applyCompartments, rerender, saveTab]\n  );');
section('    if (isBinaryPath(path)) {\n      tabsRef.current =','  const changeMode =',`    if (isBinaryPath(path)) {
      const tab = emptyTab(path); tab.binary = true; tabsRef.current.push(tab); activate(path); return;
    }
    let pending = openingRef.current.get(path);
    if (!pending) {
      setOpeningStatus("正在准备 " + baseName(path) + "…");
      pending = loadDocument(root, path, () => rootUriRef.current === root && !!viewRef.current, (bytes, total) => {
        if (fileRequestRef.current === seq) setOpeningStatus("正在准备 " + baseName(path) + " · " + Math.round(bytes / 1024) + " / " + Math.round(total / 1024) + " KiB");
      }).then(loaded => {
        if (rootUriRef.current !== root || !viewRef.current || tabsRef.current.some(t => t.path === path)) return;
        const tab = emptyTab(path);
        if ("windowOnly" in loaded) { tab.windowOnly = true; tab.preview = true; }
        else {
          tab.saved = loaded.doc; tab.hash = loaded.hash; tab.encoding = loaded.encoding; tab.lineEnding = loaded.lineEnding; tab.mixedLineEndings = loaded.mixedLineEndings; tab.sizeBytes = loaded.sizeBytes;
          tab.state = EditorState.create({ doc: loaded.doc, extensions });
          tab.mode = isMarkdownPath(path) ? "reading" : "editing";
          tab.tracker = new DirtyTracker(loaded.doc, dirty => { tab.dirty = dirty; if (!dirty) window.clearTimeout(tab.autoSaveTimer); if (tabsRef.current.includes(tab)) rerender(); });
          tab.queue = new SaveQueue(async snapshot => {
            tab.saving = true; tab.saveError = null; if (tabsRef.current.includes(tab)) rerender();
            try { const result = await saveDocument(root, path, snapshot, tab); tab.hash = result.sourceHash; }
            finally { tab.saving = false; if (tabsRef.current.includes(tab)) rerender(); }
          }, snapshot => { tab.saved = snapshot; tab.tracker?.savedSnapshot(snapshot); if (tabsRef.current.includes(tab)) rerender(); });
        }
        tabsRef.current.push(tab); rerender();
      }).finally(() => { if (openingRef.current.get(path) === pending) openingRef.current.delete(path); if (fileRequestRef.current === seq) setOpeningStatus(null); });
      openingRef.current.set(path, pending);
    }
    try { await pending; if (rootUriRef.current === root && fileRequestRef.current === seq && tabsRef.current.some(t => t.path === path)) activate(path); }
    catch (e) { if (rootUriRef.current === root && errMsg(e) !== "OPEN_CANCELLED") toast(errMsg(e), "err"); }
  }, [activate, toast, rerender, extensions]);

`);
change('      const rest = tabsRef.current.filter(t => t.path !== path);','      const removed = tabsRef.current[idx];\n      if (removed.saving || removed.queue?.busy) { toast("文件仍在保存，请等待结果；草稿已保留", "warn"); return; }\n      window.clearTimeout(removed.autoSaveTimer); removed.tracker?.dispose(); removed.queue?.dispose();\n      const rest = tabsRef.current.filter(t => t.path !== path);');
change('    [activate, rerender]\n  );','    [activate, rerender, toast]\n  );');
change('const canEdit = activeTab != null && !activeTab.binary;','const canEdit = activeTab != null && !activeTab.binary && !activeTab.windowOnly;\n  const showWindow = !!activeTab?.preview && !activeTab.binary;');
change('const showReading = isMarkdown && activeTab?.mode === "reading";','const showReading = isMarkdown && activeTab?.mode === "reading" && !showWindow;');
change('const showEditor = canEdit && !showReading;','const showEditor = canEdit && !showReading && !showWindow;');
change('activeTab?.saved ?? ""','activeTab?.saved.toString() ?? ""');
change('data-ui-version="UI-CR045-v1"','data-ui-version="UI-CR055-FEAT007-v1"');
change('{activeTab?.dirty && <span className="small muted">未保存</span>}\n          <button className="btn sm" disabled={!canEdit} onClick={() => void saveActive()}>保存</button>','{activeTab && !activeTab.binary && <span className="small muted" role="status">{activeTab.windowOnly ? "大文件窗口" : activeTab.saving ? "保存中…" : activeTab.saveError ? "保存失败 · 内容已保留" : activeTab.dirty ? "未保存" : "已保存"}</span>}\n          {activeTab?.saveError && <button className="btn sm" onClick={() => void saveActive()}>重试</button>}\n          {canEdit && !showWindow && <button className="btn sm" onClick={() => { if (activeTab) { activeTab.preview = true; rerender(); } }}>窗口预览</button>}');
change('disabled={!activeTab?.dirty} onClick','disabled={!activeTab?.dirty || activeTab.saving} onClick');
change('        <div className="cda-stage">','        {openingStatus && <div className="cda-perf-notice" role="status">{openingStatus} · 当前文档仍可编辑</div>}\n        {activeTab?.saveError && <div className="cda-perf-notice error" role="alert">{activeTab.saveError} · 当前草稿已保留。</div>}\n        <div className="cda-stage">');
change('          {showReading && activeTab && <MarkdownReading','          {showWindow && activeTab && <WindowPreview rootUri={rootUri} path={activeTab.path} buffer={activeTab.state?.doc} onClose={() => { if (activeTab.windowOnly) removeTab(activeTab.path); else { activeTab.preview = false; rerender(); } }} />}\n          {showReading && activeTab && <MarkdownReading');
change('从左侧文件树选择一个文件开始编辑，Ctrl+S 保存','从左侧文件树选择文件，修改后自动保存；Ctrl+S 立即保存');
change('if (tab) { tab.state = EditorState.create({ doc: tab.saved, extensions }); tab.dirty = false;','if (tab && !tab.saving) { window.clearTimeout(tab.autoSaveTimer); tab.state = EditorState.create({ doc: tab.saved, extensions }); tab.tracker?.update(tab.saved); tab.saveError = null; tab.dirty = false;');
fs.writeFileSync(file,s);
console.log('Editor integration applied');
