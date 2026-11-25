# LLD-CR077：知识库文档操作

- 关联：[CR-077](../PRD/CR-077-知识库文档操作.md)、[UI-CR077](../UI/文档/UI-CR077-知识库文档操作.md)
- 状态：已实现，待验收。未改索引发布、AI 网关和工具注册。

## 边界

文档写入仍走既有本人文件命令。导入的 Markdown 复用原有保存后的索引发布，不新增索引结构。图片只落盘，不进入正文索引命令。回收文件放在应用数据目录 `kb-recycle/<库标识>/<项标识>/`，不留在库根，因此目录扫描不会把它当成正文。

## 命令

| 命令 | 行为 |
| --- | --- |
| `kb_import_docs` | 一次选择一个文件。`.md` 写成 Markdown；`.zip` 解出 Markdown 和同级图片。其它后缀拒绝，文案为「暂时不支持{后缀}格式文件的导入」。 |
| `kb_upload_files` | 上传附件。不按扩展名拒绝，Word、PPT、PDF、图片及其它普通文件都复制进目录。单文件沿用既有 25MiB 内联上限，更大的走既有大文件传输。 |
| `kb_copy_doc` | 在目标目录生成「副本」，不覆盖同名文件。 |
| `kb_recycle_doc` / `kb_recycle_list` / `kb_recycle_restore` / `kb_recycle_purge` | 移出库、列出、恢复到原相对路径、彻底删除。原位置已有同名项时不覆盖。 |
| `kb_write_media` | 富文本编辑器图片或视频写入文档同级目录，单文件沿用 25MiB 原件上限。 |

ZIP 按本地文件头读取。UTF-8 标志位按 UTF-8 解码，否则按 GBK。拒绝加密包、未知压缩方式和目录穿越。

## 验证

`cargo test --lib knowledge_doc_ops_match_folder_markdown_and_richtext` 通过，覆盖复制、回收恢复、MD 导入、非 MD 拒绝，以及 ZIP 内 Markdown、子目录图片和 txt 拒绝。`npx tsc --noEmit` 通过。未在真实窗口核对视觉。
