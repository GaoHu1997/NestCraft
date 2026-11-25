# DB-CR085-FEAT014：供应商模式与排序增量

- 关联CR-085／FEAT-014／STORY-076 CR085-04、05、06、09、12、13；授权与文件边界见正式执行包。
- 在改schema前登记：provider增加 `apiMode TEXT NOT NULL DEFAULT ''`（Chat/Responses/Anthropic）与 `sortOrder INTEGER NOT NULL DEFAULT 0`；model沿用既有sortOrder。迁移幂等，历史anthropic回填Anthropic、openai回填Chat（旧数据无法区分两模式，不伪造历史选择）。供应商排序一次按createdAt/id回填；其后独立重排事务不覆盖表单草稿。
- provider.protocol继续保持openai/anthropic，兼容所有既有CLI路由、探测、模型候选；apiMode仅在供应商编辑与持久回显中区分Chat/Responses，两者同OpenAI端点。
- 创建与编辑身份分开：draft.id仅更新已有身份；createId仅创建时使用，留空生成；id/createId不可同时指定，创建重名拒绝，不做upsert，不存在id拒绝更新。
- 端点省略空URL、非空启用（忽略旧前端enabled=false），后端校验两种wire与去重，保留已保存密钥引用。
- provider_key_reveal(providerId,keyId)只在用户主动编辑/复制时调用，查询provider/key归属后读secretRef；错误不含明文，provider_list保持仅掩码。掩码对短值也只保首尾，中间遮罩；不新增秘密列表字段。
- provider_reorder(ids)核对完整唯一供应商集合，单事务写sortOrder；provider_models_reorder(providerId,ids)核对该供应商完整唯一模型行ID集合，单事务保存。失败不部分写入，前端还原顺序；模型未保存草稿排序在下次供应商保存提交，不额外落未完成模型。
- 自动解析增加可空text/vision/imageGen与modalitySource，仅使用上游明确布尔值/模态数组；未知null，不按名称推断。手动选择在当前编辑草稿保护，失败不覆盖；不新增模型schema。
- 兼容与恢复：纯加列无需破坏式迁移。旧软件忽略新列、仍可读取；若回退旧软件，模式只剩粗wire显示，新排序不保证采用。升级前正常备份用户data；不删除旧列、不改secret文件布局。迁移验证使用内存库重复迁移与旧值回填，不读取真实库。
