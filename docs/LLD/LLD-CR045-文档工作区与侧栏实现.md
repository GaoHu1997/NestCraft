# LLD-CR045：文档工作区与侧栏实现

- 关联：[CR-045](../PRD/CR-045-文档工作区与可调侧栏.md)及各Story本次AC；[UI-CR045](../UI/文档/UI-CR045-文档工作区与可调栏.md)是唯一视觉基准，当前制作中不可编码。
- 当前事实：React18/TS/Vite6/Tauri2；CodeMirror6；marked/DOMPurify；SQLite。仅项目AI已有鼠标拖宽，其他内容栏固定；需求详情为模态，正式无导图；编码MD只有源码；知识接口只索引MD，无创建/上传/保存。工作区main大量既有未提交工作保护，不提交推送。

## 1. 方案与模块分工

1. 需求阅读独立组件：真实RequirementNode递归flatten，projectId＋kind＋id内部Tab，实体源路径通过fsReadFile(rootUri,path)受限读取。愿景默认，预览读完整全集，异步请求代次/身份/卸载保护；逐项error/retry。正文安全renderMarkdown，TOC由最终HTML唯一id提取且限定当前容器。导图纯派生布局，无新依赖；模型缺接口明确状态，不造模型或关系。原编辑/状态/删除/派发预检功能保留。
2. MD阅读从当前EditorState生成，每file mode/readScroll独立；编辑器保活，切换不重读、不清undo；行定位切编辑。异步render不能覆盖新file，CtrlS既有真实保存与脏Tab确认保留。
3. 三配置控件独立button ref，浮层fixed/portal或不裁剪的受控容器，使用button rect＋浮层rect计算left/top/maxHeight；6pxgap，8pxviewportmargin，优先上方，有限空间翻转/内部滚动。ResizeObserver、scroll/resize与栏宽变化刷新；outside识别overlay所属，不吞原目标。菜单调用显式button ref，焦点恢复按真实trigger。权限协议与模型能力不改。
4. 共用usePaneWidth/ResizeHandle：显式scope＋pane；preferred保存用户值，effective按容器和中区限幅。pointer capture/primarybutton/RAF/pointercancel/lostcapture/隐藏及卸载清理，键盘10px、Shift20px、Home/End、双击默认。模块独占本模块文件，共用组件/API/App由主代理集成；不在各模块复制windowmousemove。

## 2. 知识用户文件操作契约（拟议，未实现）

所有调用按libraryId从DB查已启用库根，不接受任意目标绝对路径；单文件名验证、父相对路径组件校验、canonicalize根及父并检查symlink/reparse不越界。用户本次明确要求库内文件管理，但项目AI grant不授予写，网关仍只读。

- kb_create_folder({id,parentRelativeUri,name}) → NoteNode；create_dir仅新建，冲突拒绝，无级联覆盖。
- kb_create_markdown({id,parentRelativeUri,name,content}) → NoteContent＋hash；编辑草稿不先创建空文档；create_new写UTF8，成功才索引，索引失败报告文件已保存/待重建，不反写旧正文。
- kb_save_markdown({id,noteId,expectedHash,content}) → NoteContent；核对真实文件格式与基线hash，并发受mutex串行/唯一tempfile，保存失败保旧文件；不借用无hash的通用fs_write或read_doc。
- kb_upload_files({id,parentRelativeUri}) → 每原件成功/失败；后端本机文件选择，无任意前端sourcePath。复制字节、create_new、单件容量上限25MiB、批次最多20、无覆盖，失败清本次残件不删除已有；不解压ZIP、不执行文件/宏/脚本。取消不写文件。
- kb_file_info/kb_read_file({id,noteId})：返回元信息/受限文本或允许格式的base64及mime；文本1MiB、图片/PDF25MiB；未知/主动格式只元信息、下载。kb_export_file本机Save As，经受检源+目标确认，不自动外发。
- kb_tree真实FS枚举包括空目录及二进制，只受管根内有限深度/数量；沿用MD note索引同路径id兼容，不把hash路径方案称作已经实现CR-028移动稳定身份。scan事务更新、拒越界/不可读，不把失败当空正文；禁用库read/search/gateway即时拒绝。
- MD/Markdown可用户编辑、文本可安全读、图片允许受检mime、PDF能力按环境；Office仅原件/元信息/导出。AI文本索引仍仅已支持格式；正文抽取/FTS5/解析版本与稳定原件表属于CR-030另项，不以此计划假称实现。

## 3. 数据、权限与兼容

复用[DB-FEAT-001](../DB/DB-FEAT-001-知识授权与工作台数据设计.md)库/索引/grant和文件权威；本轮不迁移表，不存原件BLOB。文件hash由实际字节生成；正文保存与索引失败分开说明；原件身份/修订/解析状态完整持久化另循[DB-FEAT-008](../DB/DB-FEAT-008-知识原件切片与全文索引.md)，不提前宣称其AC通过。宽度/阅读Tab仅内存偏好，不改变应用identifier、数据目录或真实凭据。

禁止外联Markdown图片自动泄露知识正文路径、主动SVG/HTML/PDF脚本执行、通过下载暴露无权文件；环境内嵌PDF不可隔离主动内容时只元信息/本机导出，不硬嵌iframe。下载和上传均明确本机操作，不调用外部解析服务。

## 4. 实施与验证

先三审→可视原型（独占设计文件）→实际展示/状态检查→登记hash→软件（独占模块）。并行设计和对应软件不得无基线同步修改。主代理负责共享API/renderer/resize/App和集成。

软件验证：tsc、npm build、cargo test --offline --lib；新增临时隔离目录测试非法名/穿越/symlink/禁用/同名/基线冲突/深树/空目录/字节保持/取消；白名单mock新增命令不回落真实IPC。GUI逐入口/草稿/多Tab/三浮层/拖宽/窄区，成对设计软件证据。同一套测试不跑旧SSH/真实模型段，不读取生产appdata。记录失败与未执行。

回退仅撤本次已核变更，不reset/clean用户工作。无发布/安装包/生产数据迁移。技术通过仍待用户验收，视觉未判读明确未验证。
