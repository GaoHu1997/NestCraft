import ts from 'typescript';
const config=ts.readConfigFile('tsconfig.json',ts.sys.readFile);if(config.error)throw Error(ts.flattenDiagnosticMessageText(config.error.messageText,'\n'));
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,'.');
const roots=['src/vite-env.d.ts','src/modules/editor/index.tsx','src/modules/editor/FileTree.tsx','src/modules/editor/WindowPreview.tsx','src/modules/editor/performance-model.ts','src/modules/editor/document-session.ts','src/api/editor-performance.ts'];
const program=ts.createProgram(roots,parsed.options);const errors=ts.getPreEmitDiagnostics(program);
for(const d of errors){const pos=d.file&&d.start!=null?d.file.getLineAndCharacterOfPosition(d.start):null;console.log(`${d.file?.fileName??''}:${pos?pos.line+1:''} ${ts.flattenDiagnosticMessageText(d.messageText,'\n')}`)}
console.log(JSON.stringify({roots:roots.length,diagnostics:errors.length,kind:'targeted TypeScript no-emit check'}));process.exitCode=errors.length?1:0;
