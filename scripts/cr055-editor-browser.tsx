import React from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { EditorView } from "@codemirror/view";
import { EditorState, Text } from "@codemirror/state";
import { CodeArea } from "../src/modules/editor";
import { ToastProvider } from "../src/components/ui";
import { installScrollbarReveal } from "../src/components/scrollbar";
import { DirtyTracker } from "../src/modules/editor/performance-model";
import "../src/theme/tokens.css";
import "../src/theme/base.css";
import "../src/theme/workbench.css";
import "../src/theme/tab-overflow.css";

const count = Number(new URLSearchParams(location.search).get("lines") ?? 1000);
const row = "export const item = 1234567890;\n";
let source = row.repeat(Math.max(0, count - 1)) + row.trimEnd();
const docs = new Map<string, string>();
const saves = new Map<string, { parts: string[]; path: string }>();
let saveCount = 0, failSave = false, searchCancelled = false, activeWrites = 0, maxWrites = 0;
let directoryVersion = 1, declaredSize: number | null = null;
let controls: { root: (value: string) => void; mount: (value: boolean) => void };
const calls: Record<string, number> = {};
mockIPC(async (cmd, args: any) => {
  calls[cmd] = (calls[cmd] ?? 0) + 1;
  if (cmd === "get_setting") return null;
  if (cmd === "fs_perf_dir_page") {
    if (args.relPath) return { items: Array.from({length:10}, (_,i) => ({name:`child-${directoryVersion}-${i}.ts`,path:`${args.relPath}/child-${directoryVersion}-${i}.ts`,isDir:false,size:100})), nextCursor:null,directoryRevision:String(directoryVersion),complete:true };
    const start = args.cursor ? Number(args.cursor) : 0;
    const items = Array.from({ length: Math.min(200, 10000 - start) }, (_, n) => ({ name: start + n === 0 ? "million.ts" : start + n === 1 ? "src" : `module-${String(start + n).padStart(5, "0")}.ts`, path: start + n === 0 ? "D:/fixture/million.ts" : start + n === 1 ? "D:/fixture/src" : `D:/fixture/module-${start + n}.ts`, isDir: start + n === 1, size: source.length }));
    return { items, nextCursor: start + items.length < 10000 ? String(start + items.length) : null, directoryRevision: "synthetic-1", complete: start + items.length === 10000 };
  }
  if (cmd === "fs_perf_open_document") { const id = crypto.randomUUID(); docs.set(id, source); return { docId: id, revision: "protected-mock", sizeBytes: String(declaredSize ?? source.length), encoding: "utf-8", initialCursor: "0" }; }
  if (cmd === "fs_perf_read_window") { const body = docs.get(args.docId)!; const start = Number(args.cursor), end = Math.min(body.length, start + 65536), eof = end === body.length; return { text: body.slice(start, end), nextCursor: eof ? null : String(end), eof, sourceStartByte: String(start), sourceEndByte: String(end), canonicalStartByte: String(start), canonicalEndByte: String(end), sourceHash: eof ? "sha256:mock" : null }; }
  if (cmd === "fs_perf_close_document") { docs.delete(args.docId); return; }
  if (cmd === "fs_perf_save_begin") { if (failSave) throw new Error("SOURCE_CONFLICT: 合成外部版本冲突"); const id = crypto.randomUUID(); saves.set(id, { parts: [], path: args.path }); maxWrites = Math.max(maxWrites, ++activeWrites); return id; }
  if (cmd === "fs_perf_save_append") { const s = saves.get(args.saveId)!; s.parts.push(args.text); if (args.seq % 64 === 0) await new Promise(r => setTimeout(r, 0)); return; }
  if (cmd === "fs_perf_save_commit") { const s = saves.get(args.saveId)!; source = s.parts.join(""); saves.delete(args.saveId); saveCount++; activeWrites--; return { sourceHash: "sha256:mock", sourceBytes: String(source.length) }; }
  if (cmd === "fs_perf_save_abort") { if (saves.delete(args.saveId)) activeWrites--; return; }
  if (cmd === "fs_perf_search_start") { searchCancelled = false; return; }
  if (cmd === "fs_perf_cancel") { searchCancelled = true; return true; }
  if (cmd === "fs_perf_search_poll") { await new Promise(r => setTimeout(r, 40)); return { batches: args.ackSeq === null ? [{ seq: 0, hits: [{ path: "D:/fixture/million.ts", lineNo: 3, lineText: "export const item = 1234567890;" }] }] : [], status: searchCancelled ? "cancelled" : "running", error: null, files: 100, bytes: 65536, skipped: 0, limited: false }; }
  throw new Error(`Unexpected mock IPC: ${cmd}`);
});
installScrollbarReveal();
function Host() { const [root, setRoot] = React.useState("D:/fixture"), [mounted, setMounted] = React.useState(true); controls = {root:setRoot,mount:setMounted}; return <ToastProvider>{mounted && <CodeArea rootUri={root} projectId="cr055-isolated" />}</ToastProvider>; }
createRoot(document.getElementById("root")!).render(<Host />);
const getView = () => EditorView.findFromDOM(document.querySelector(".cm-content") as HTMLElement)!;
const stats = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return { count: values.length, p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)], p99: sorted[Math.floor(sorted.length * .99)], max: sorted.at(-1) }; };
(window as any).editorHarness = {
  root: (value: string) => controls.root(value), mount: (value: boolean) => controls.mount(value), directoryVersion: (value: number) => {directoryVersion=value;}, declaredSize: (value: number | null) => {declaredSize=value;},
  calls, view: getView, counts: () => ({ saveCount, activeWrites, maxWrites, searchCancelled, leases: docs.size }),
  failSave: (fail: boolean) => { failSave = fail; },
  async frames(iterations = 1000) {
    const view = getView(), latency: number[] = [], handlers: number[] = [];
    view.dispatch({ selection: { anchor: Math.floor(view.state.doc.length / 2) }, scrollIntoView: true });
    for (let i = 0; i < iterations; i++) {
      await new Promise<void>(r => requestAnimationFrame(() => r()));
      const start = performance.now();
      view.dispatch({ changes: { from: view.state.selection.main.head, insert: "x" }, selection: { anchor: view.state.selection.main.head + 1 }, userEvent: "input.type" });
      handlers.push(performance.now() - start);
      await new Promise<void>(r => requestAnimationFrame(() => r()));
      latency.push(performance.now() - start);
    }
    return { lines: view.state.doc.lines, chars: view.state.doc.length, dispatch: stats(handlers), nextRafProxy: stats(latency), note: "Actual CodeArea/CodeMirror component with isolated IPC; RAF is a next-frame proxy, not compositor presentation proof." };
  },
  micro(iterations = 200) {
    const baseline = getView().state.doc;
    const result: Record<string, any> = {};
    for (const mode of ["old-full-string", "new-dirty-tracker"]) {
      let state = EditorState.create({ doc: baseline }); const saved = baseline.toString();
      const tracker = new DirtyTracker(baseline, () => {}); const values: number[] = [];
      for (let i = 0; i < iterations; i++) { state = state.update({ changes: { from: 1, to: 2, insert: i % 2 ? "a" : "b" } }).state; const start = performance.now(); if (mode === "old-full-string") { const dirty = state.doc.toString() !== saved; if (!dirty && i > iterations) throw Error("unreachable"); } else tracker.update(state.doc); values.push(performance.now() - start); }
      tracker.dispose(); result[mode] = stats(values);
    }
    return { kind: "dirty-listener microbenchmark only", iterations, chars: baseline.length, lines: baseline.lines, result };
  }
};
