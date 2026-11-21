import { build } from "esbuild";
// In-memory transform only: no application build or generated bundle files.
const result = await build({ entryPoints: ["scripts/cr055-editor-save-logic.ts"], bundle: true, write: false, platform: "node", format: "esm", packages: "external", plugins: [{ name: "save-transport-only", setup(build) {
  build.onResolve({ filter: /^@\/api\/editor-performance$/ }, () => ({ path: "save-api", namespace: "save-test" }));
  build.onLoad({ filter: /.*/, namespace: "save-test" }, () => ({ contents: "export const saveBegin=()=>{throw Error('unmocked API')}; export const saveAppend=saveBegin,saveSeal=saveBegin,saveCommit=saveBegin,saveStatus=saveBegin,saveAbort=saveBegin,releaseSave=saveBegin;" }));
} }] });
// Keep relative package resolution rooted in this workspace when importing a data URL.
let code = result.outputFiles[0].text;
for (const pkg of ["@codemirror/state", "@codemirror/commands"]) code = code.replaceAll(`from "${pkg}"`, `from "${import.meta.resolve(pkg)}"`);
await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
