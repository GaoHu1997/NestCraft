# LLD-CR074-FEAT012：平台权威步骤边界桥接

- projectId=NestCraft、唯一featureId=FEAT-012；授权源：用户明确“没改需要修改”及“参考dsh的统计规则”。本包只补本Feature真实统计来源，不改模型/工具权限、上下文策略、消息视觉、布局、其他Feature。
- 现行源：[CR074](../PRD/CR-074-AI会话双布局统一与交互校正.md)、[UI-CR074-v1](../UI/文档/UI-CR074-AI会话双布局统一.md)、[闭合计数契约和缺口](../Test/REPORT-CR074-DSH统计.md)。口径已确定：每个进入的模型生成步骤恰一次闭合，completed/failed/cancelled/max_tokens均计；至少1个闭合步骤的不同turn计轮，预检/拒绝/未进入步骤不计。不根据tools/messages/rootCLI done推断。

## 编码前方案与边界

1. 平台直接模型通道能看到真实每次生成调用边界。以持久user消息ID为turnId、同轮递增模型step编号为stepId；在真实调用前建立步骤，在返回/失败/取消时finally语义闭合一次。预检未进入模型调用不造闭合，工具回合后的每次再次生成是独立step。
2. 流式捕获记录首非空delta、assembled结束和真实usage。计数至少有权威closed事件；耗时/TPS不能将整CLI根调用估算称DSH精确。统计token weighted归因与当前窗口保持原规则。
3. 使用本轮已存在user消息metaJson.sessionStats持久化统计批次，不新增可见system/assistant占位，不改变正文。已存meta字段合并而非覆盖，持久化与平台transcript同一成功事务；失败/取消仍记录已进入闭合步骤，重复写入相同turn/step不重复计数。零闭合marker必须来自真实本包边界而非空message。
4. 对整会话计数，查询当前会话所有持久统计记录或保留全量消息统计元信息；历史分页/上下文压缩不能改变统计。旧无边界轮次和CLI未上报内部step保留未知并说明覆盖，不把已知子集叫完整总量。新纯平台、全部已记录轮次可给精确轮步；混旧/CLI仅已记录部分明确部分。
5. 前端fromChatMessage透传仅统计元信息，不将无关meta整体复制/外传；统计实时或生成后重载及历史重开可读，失败/停止路径也刷新计数，原正文/error卡/附件/引用/目标与队列行为保护。若采用独立统计API而非消息透传，版本/来源/会话身份/完整性严格校验，调用与反序响应防护。
6. CLI适配器没有权威内部边界时保持未知，不强行按assistant消息/result/工具或rootdone填值；此为协议限制，需明确未映射通道。

## 独占允许文件

- `src-tauri/src/commands/platform_agent.rs`：只步骤观测闭合、捕获计时/usage，不改请求/工具业务策略；`platform_context_runtime.rs`仅本轮user meta统计合并持久化；`chat.rs`仅StreamOutcome统计可选字段/必要统计查询，不改CLI执行和消息正文。
- 如需独立统计查询，可新`chat_stats.rs`统计只读模块、`lib.rs`仅注册该命令、`src/api/index.ts`仅统计类型/函数。
- `src/modules/chat/MessageList.tsx`仅统计元信息映射字段（或使用独立API则不改）；`ChatPanel.tsx`仅在statsData投影轮/步，不触碰F021controller/CR076消息/附件/引用/目标/队列业务；`sessionStats.ts`/`StatsBar.tsx`仅来源/范围/已确认计数消费。
- 本包新增隔离前后端测试、`REPORT-CR074-平台统计桥接.md`。未知第三方writer新变动须复读精准edit，禁止重置HEAD、全文件重写或覆盖其他工作；主代理集成验证与共享导航，子包不修改共享UI稿。

## 数据设计与权限

- **复用现有message.metaJson**，结构追加版本化sessionStats={schema,rule,source,sessionId,turnId,closedSteps}，closedSteps仅id/终态/非敏感计量时间/usage；无凭证、正文、工具参数。索引和表不变，不迁移或改生产数据。
- 更新仅限已接纳平台turn的user消息ID与会话ID二者匹配；通过现有锁/事务避免写入其他会话，合并未知meta字段。只读查询验证会话存在及既有作用域，不开放模型写stats能力。
- 文件授权仅本包计量观测与透传，不授权调用真实付费模型/私密数据库。后端测使用内存SQLite/本地HTTP-SSE（不收费上游/私人库），已有运行通道安全规则保持。

## 义务和验证

- UI-SCROLL-001：读[UI-CR049](../UI/文档/UI-CR049-滚动条按需显示.md)和[CR049](../PRD/CR-049-滚动条仅在滚动时显示.md)，统计详情等溢出原生scroll仅实际滚动显示、最后700ms隐藏、嵌套与编辑保持，不改宽不禁scroll。不新增视觉页面；UI统计已知/未知/partial仍按SC07406先验设计，不调整设计风格。
- 必验：平台1轮2模型step+工具交换、完成/失败/取消/max、预检不计、重复持久化去重、会话隔离、无正文失败仍保存统计、保留原meta、历史重开/压缩不丢累计、前端真实载入计数、生成后/失败刷新/反序不污染；原31投影/30格式/16集成回归；cargo定向测试/tsc/build主代理复验。
- 不能只放闭合purefold却无生产者/消费者便说缺口解决；必须指明平台实际调用→闭合→持久→UI的接通路径和真实隔离证据。
