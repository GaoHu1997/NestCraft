import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EditorState, Text } from "@codemirror/state";
import { history, undo, undoDepth } from "@codemirror/commands";
import { DocumentSaveSession, SaveUnresolvedError, TextBuilder, digestFrozenSave, frozenSaveChunks, type SaveTransport } from "../src/modules/editor/document-session";
import { DirtyTracker, SaveQueue } from "../src/modules/editor/performance-model";
import { lineEndings, preserveLineEndings } from "../src/modules/editor/line-endings";
import type { SaveStatus } from "../src/api/editor-performance";

const cases: string[] = [];
async function test(name: string, run: () => void | Promise<void>) { await run(); cases.push(name); }
const defer = async () => {};
const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const originalBytes = (text: string, encoding: string) => {
  if (encoding.startsWith("utf-8")) return Buffer.concat([encoding === "utf-8-bom" ? Buffer.from([239, 187, 191]) : Buffer.alloc(0), Buffer.from(text, "utf8")]);
  const bytes = Buffer.from(text, "utf16le"); if (encoding === "utf-16be") bytes.swap16();
  return Buffer.concat([Buffer.from(encoding === "utf-16be" ? [254, 255] : [255, 254]), bytes]);
};
function frozen(text: string) { const b = new TextBuilder(); b.append(text, true); return { doc: b.doc, endings: b.endingMap }; }

for (const encoding of ["utf-8", "utf-8-bom", "utf-16le", "utf-16be"]) {
  for (const text of ["", "ASCII", "汉字😀\r\nB\rC\nD\r\n", "x".repeat(8191) + "😀\r\n尾\r" + "\n\r".repeat(9000)]) {
    await test(`${encoding} bytes/SHA match original encoding, mixed endings (${text.length} units)`, async () => {
      const content = frozen(text), expected = originalBytes(text, encoding);
      // Prevent accidental full-document serialization in production paths.
      const doc = new Proxy(content.doc, { get(target, key) { if (key === "toString") return () => { throw Error("whole-document toString prohibited"); }; const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; } });
      const input = { ...content, doc };
      const digest = await digestFrozenSave(input, encoding, defer);
      assert.equal(digest.totalBytes, String(expected.length)); assert.equal(digest.submittedHash, hash(expected));
      const chunks = [...frozenSaveChunks(input, encoding)];
      assert.equal(chunks.map(c => c.text).join(""), text);
      assert.equal(chunks.length, digest.expectedChunks);
      for (const c of chunks) { assert.ok(Buffer.byteLength(c.text, "utf8") <= 65536); assert.ok(c.bytes.length <= 65536); assert.ok(!/[\uD800-\uDBFF]$/.test(c.text)); }
      const payload = Buffer.concat(chunks.map(c => Buffer.from(c.bytes)));
      const bomLength = encoding === "utf-8-bom" ? 3 : encoding.startsWith("utf-16") ? 2 : 0;
      assert.deepEqual(payload, expected.subarray(bomLength));
    });
  }
}
await test("invalid Unicode, unsupported encoding and corrupt ending maps reject before IPC", async () => {
  for (const text of ["\ud800", "\udc00", "x".repeat(8191) + "\ud800X"]) for (const encoding of ["utf-8", "utf-16le"]) await assert.rejects(digestFrozenSave(frozen(text), encoding, defer), /INVALID_UNICODE/);
  await assert.rejects(digestFrozenSave(frozen("a\nb"), "utf-8", defer).then(() => digestFrozenSave({ doc: Text.of(["a", "b"]), endings: Text.empty }, "utf-8", defer)), /LINE_ENDING_MAP_INVALID/);
  await assert.rejects(digestFrozenSave({ doc: Text.of(["a", "b"]), endings: Text.of(["X", ""]) }, "utf-8", defer), /LINE_ENDING_MAP_INVALID/);
  await assert.rejects(digestFrozenSave(frozen("a"), "latin1", defer), /ENCODING_REQUIRED/);
});
await test("digest yields bounded work before begin", async () => {
  let yields = 0; const digest = await digestFrozenSave(frozen("x".repeat(8192 * 25)), "utf-8", async () => { yields++; });
  assert.equal(digest.expectedChunks, 25); assert.equal(yields, 6);
});

class Backend {
  calls: string[] = []; row!: SaveStatus; bytes: Buffer[] = []; targetHash = ""; total = ""; chunks = 0;
  commitMode: "ok" | "lostCommitted" | "unknown" | "failed" | "committing" | "badRevision" | "badHash" | "badBytes" = "ok";
  loseAppend = false; loseSeal = false; loseBegin = false; statusUnavailable = false; abortUnavailable = false; releaseUnavailable = false;
  wrongRequest = false; nextSeqTooLarge = false; gate?: Promise<void>;
  setPhase(phase: string) { this.row = { ...this.row, phase, needsRecovery: phase === "needs_recovery" }; }
  committed() { this.row = { ...this.row, phase: "committed", needsRecovery: false, committedRevision: this.row.submittedRevision, sourceHash: this.targetHash, sourceBytes: this.total }; }
  transport: SaveTransport = {
    saveBegin: async (_root, _path, requestId, submittedRevision, _expected, encoding, total, targetHash) => {
      this.calls.push("begin:" + requestId); this.targetHash = targetHash; this.total = total;
      this.bytes = [originalBytes("", encoding)]; this.row = { requestId, submittedRevision, phase: "staging", writtenBytes: String(this.bytes[0].length), nextSeq: 0, sourceHash: null, sourceBytes: null, committedRevision: null, cancelTooLate: false, needsRecovery: false, error: null };
      if (this.loseBegin) { this.loseBegin = false; throw Error("transport lost begin"); } return { ...this.row };
    },
    saveAppend: async (_root, id, seq, text) => {
      this.calls.push(`append:${id}:${seq}`); assert.equal(seq, this.row.nextSeq);
      // Runtime tests use UTF-8 here; encoding matrix above independently covers UTF-16 bytes.
      const bytes = Buffer.from(text); this.bytes.push(bytes); this.row = { ...this.row, nextSeq: seq + 1, writtenBytes: String(Number(this.row.writtenBytes) + bytes.length) };
      if (this.loseAppend) { this.loseAppend = false; throw Error("transport lost append"); } return { ...this.row };
    },
    saveSeal: async (_root, id, count) => { this.calls.push("seal:" + id); this.chunks = count; assert.equal(count, this.row.nextSeq); assert.equal(hash(Buffer.concat(this.bytes)), this.targetHash); assert.equal(String(Buffer.concat(this.bytes).length), this.total); this.setPhase("sealed"); if (this.loseSeal) { this.loseSeal = false; throw Error("transport lost seal"); } return { ...this.row }; },
    saveCommit: async (_root, id) => {
      this.calls.push("commit:" + id); if (this.gate) await this.gate;
      if (this.commitMode === "unknown") { this.setPhase("needs_recovery"); return { ...this.row }; }
      if (this.commitMode === "committing") { this.setPhase("durability"); this.row.cancelTooLate = true; return { ...this.row }; }
      if (this.commitMode === "failed") { this.setPhase("failed"); this.row.error = "BASELINE_CHANGED"; return { ...this.row }; }
      this.committed();
      if (this.commitMode === "lostCommitted") throw Error("transport lost commit");
      if (this.commitMode === "badRevision") this.row.committedRevision = "another-revision";
      if (this.commitMode === "badHash") this.row.sourceHash = "sha256:" + "0".repeat(64);
      if (this.commitMode === "badBytes") this.row.sourceBytes = "1";
      return { ...this.row };
    },
    saveStatus: async (_root, id) => { this.calls.push("status:" + id); if (this.statusUnavailable) throw Error("offline"); return { ...this.row, ...(this.wrongRequest ? { requestId: "wrong" } : {}), ...(this.nextSeqTooLarge ? { nextSeq: 999999 } : {}) }; },
    saveAbort: async (_root, id) => { this.calls.push("abort:" + id); if (this.abortUnavailable) throw Error("offline"); assert.ok(["failed", "cancelled"].includes(this.row.phase)); return { ...this.row }; },
    releaseSave: async (_root, id) => { this.calls.push("release:" + id); if (this.releaseUnavailable) throw Error("offline"); },
  };
}
function setup(backend = new Backend()) {
  let ids = 0;
  const session = new DocumentSaveSession<ReturnType<typeof frozen>>(s => s, backend.transport, () => `id-${++ids}`, defer);
  const snapshot = frozen("original 😀\r\nsecond\rthird\n");
  const baseline = { hash: "sha256:" + "a".repeat(64), encoding: "utf-8" };
  return { backend, session, snapshot, baseline, ids: () => ids };
}
await test("v2 happy path begins with final SHA/bytes, seals, commits and releases", async () => {
  const { session, backend, snapshot, baseline } = setup(); const result = await session.save("root", "file", snapshot, baseline);
  assert.equal(result.snapshot, snapshot); assert.equal(result.sourceHash, hash(originalBytes("original 😀\r\nsecond\rthird\n", "utf-8")));
  assert.equal(session.unresolved, false); assert.deepEqual(backend.calls.map(c => c.split(":")[0]), ["begin", "append", "seal", "commit", "release"]);
});
await test("lost committed response is recovered by status; never aborts or rewrites", async () => {
  const { session, backend, snapshot, baseline } = setup(); backend.commitMode = "lostCommitted";
  const result = await session.save("root", "file", snapshot, baseline); assert.equal(result.snapshot, snapshot); assert.equal(session.unresolved, false);
  assert.deepEqual(backend.calls.map(c => c.split(":")[0]), ["begin", "append", "seal", "commit", "status", "release"]);
});
for (const mode of ["unknown", "committing", "badRevision", "badHash", "badBytes"] as const) await test(`${mode} cannot acknowledge a checkpoint, preserves ID and queries status before retry`, async () => {
  const { session, backend, snapshot, baseline, ids } = setup(); backend.commitMode = mode;
  await assert.rejects(session.save("root", "file", snapshot, baseline), SaveUnresolvedError);
  assert.equal(session.unresolved, true); const id = session.requestId; const at = backend.calls.length;
  const newer = frozen("new content"); backend.committed();
  const result = await session.save("root", "file", newer, baseline);
  assert.equal(backend.calls[at], "status:" + id); assert.equal(result.snapshot, snapshot); assert.equal(ids(), 2);
  assert.ok(!backend.calls.some(c => c.startsWith("abort"))); assert.equal(backend.calls.filter(c => c.startsWith("begin")).length, 1);
});
await test("offline status remains unresolved and repeated retry has no mutation/new ID", async () => {
  const { session, backend, snapshot, baseline, ids } = setup(); backend.statusUnavailable = true; backend.commitMode = "unknown";
  await assert.rejects(session.save("root", "file", snapshot, baseline), SaveUnresolvedError);
  const at = backend.calls.length;
  await assert.rejects(session.save("root", "file", snapshot, baseline), SaveUnresolvedError);
  assert.ok(backend.calls.slice(at).every(c => c.startsWith("status:"))); assert.equal(ids(), 2); assert.ok(session.unresolved);
});
for (const loss of ["loseBegin", "loseAppend", "loseSeal"] as const) await test(`${loss} resumes the same frozen payload only after status`, async () => {
  const { session, backend, baseline, ids } = setup(); const snapshot = frozen("x".repeat(8192 * 3) + "😀\r\nend"); backend[loss] = true;
  await assert.rejects(session.save("root", "file", snapshot, baseline), SaveUnresolvedError);
  const at = backend.calls.length; const id = session.requestId;
  const result = await session.save("root", "file", frozen("newer"), baseline);
  assert.equal(result.snapshot, snapshot); assert.equal(backend.calls[at], "status:" + id); assert.equal(ids(), 2);
  assert.equal(backend.calls.filter(c => c.startsWith("begin")).length, 1);
  assert.equal(backend.calls.filter(c => c.startsWith("append")).length, 4);
});
await test("definite failure aborts safely and does not acknowledge checkpoint", async () => {
  const { session, backend, snapshot, baseline } = setup(); backend.commitMode = "failed";
  await assert.rejects(session.save("root", "file", snapshot, baseline), /BASELINE_CHANGED/); assert.equal(session.unresolved, false);
  assert.deepEqual(backend.calls.slice(-3).map(c => c.split(":")[0]), ["status", "abort", "release"]);
});
await test("failed abort retains ID until status and safe cancellation are confirmed", async () => {
  const { session, backend, snapshot, baseline, ids } = setup(); backend.commitMode = "failed"; backend.abortUnavailable = true;
  await assert.rejects(session.save("root", "file", snapshot, baseline), SaveUnresolvedError); assert.ok(session.unresolved);
  backend.abortUnavailable = false; await assert.rejects(session.save("root", "file", snapshot, baseline), /BASELINE_CHANGED/); assert.equal(ids(), 2); assert.equal(session.unresolved, false);
});
await test("release failure does not undo an explicitly proven commit", async () => {
  const { session, backend, snapshot, baseline } = setup(); backend.releaseUnavailable = true;
  assert.equal((await session.save("root", "file", snapshot, baseline)).snapshot, snapshot); assert.equal(session.unresolved, false);
});
await test("wrong status identity and impossible sequence are fail closed", async () => {
  for (const field of ["wrongRequest", "nextSeqTooLarge"] as const) {
    const { session, backend, snapshot, baseline } = setup(); backend.commitMode = "unknown"; backend[field] = true;
    await assert.rejects(session.save("root", "file", snapshot, baseline), SaveUnresolvedError); assert.ok(session.unresolved); assert.ok(!backend.calls.some(c => c.startsWith("abort:")));
  }
});
await test("definite begin baseline rejection permits a later new request but never aborts nonexistent intent", async () => {
  const { backend, snapshot, baseline } = setup(); let ids = 0;
  backend.transport.saveBegin = async () => { backend.calls.push("begin"); throw "BASELINE_CHANGED"; };
  backend.transport.saveStatus = async () => { backend.calls.push("status"); throw "SAVE_NOT_FOUND"; };
  const session = new DocumentSaveSession(s => s as ReturnType<typeof frozen>, backend.transport, () => `id-${++ids}`, defer);
  await assert.rejects(session.save("root", "file", snapshot, baseline), e => e === "BASELINE_CHANGED"); assert.equal(session.unresolved, false); assert.deepEqual(backend.calls, ["begin", "status"]);
});
await test("edits/undo remain live during commit; only old submitted state advances baseline", async () => {
  const b = new TextBuilder(); b.append("a\r\nb", true);
  let state = EditorState.create({ doc: b.doc, extensions: [history(), preserveLineEndings(b.endingMap, b.lineEnding)] });
  const tracker = new DirtyTracker(state.doc, () => {}); state = state.update({ changes: { from: 0, insert: "old " } }).state; tracker.update(state.doc); const submitted = state;
  const backend = new Backend(); let finish!: () => void; backend.gate = new Promise(resolve => { finish = resolve; });
  let ids = 0; const session = new DocumentSaveSession<EditorState>(s => ({ doc: s.doc, endings: s.field(lineEndings) }), backend.transport, () => `id-${++ids}`, defer);
  const queue = new SaveQueue<EditorState>(async input => { const result = await session.save("root", "file", input, { hash: "baseline", encoding: "utf-8" }); tracker.savedSnapshot(result.snapshot.doc); }, () => {});
  const saving = queue.request(submitted);
  // Await bounded microtasks until the controlled commit gate is reached; no timers or backend polling.
  for (let i = 0; i < 20 && !backend.calls.some(c => c.startsWith("commit:")); i++) await Promise.resolve();
  assert.ok(backend.calls.some(c => c.startsWith("commit:")));
  state = state.update({ changes: { from: state.doc.length, insert: " newer" } }).state; tracker.update(state.doc);
  const newer = state, depth = undoDepth(newer); finish(); await saving;
  assert.equal(state, newer); assert.equal(undoDepth(state), depth); assert.equal(tracker.saved, submitted.doc); assert.equal(tracker.dirty, true);
  assert.ok(undo({ state, dispatch: tr => { state = tr.state; } })); assert.equal(state.field(lineEndings).toString(), "C\n"); tracker.dispose();
});
console.log(JSON.stringify({ kind: "CR055 FEAT007 v2 save targeted logic (mock transport, not backend recovery)", passed: cases.length, cases }, null, 2));
