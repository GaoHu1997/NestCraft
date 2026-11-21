# LLD-CR055-v3：执行授权与快照语义增量

- 日期2026-11-21；用户15:35明确“执行吧，进行开发”；随后通过选择题确认“保持可搜，显示索引快照版本”及GB单文件“先分块阅读、搜索和导入导出”。[PRD](../PRD/CR-055-大规模编码与知识库性能.md)是当前范围。
- v2方案与评审保留历史；v2的整库rebuild_pending暂停检索路线**不采用**。本增量由perf-architecture独立只读评审：b/c子协议通过；a产品语义认可，N01/N02实现与验收约束必须落实，不能沿用v2通过结论代替。
- 开发身份：`NestCraft-workspace-D-github-AI_Delelovelop`是仓库开发记录，不伪造真实业务数据库project ID。三个独立上下文分别FEAT007/008/009；主代理只协调/登记/验证。真实运行时ID由既有项目/知识授权接口提供。

## 1. 持续可搜与版本含义

当前P0沿原表的小事务更新可先保留；人类搜索在同一短SQLite只读事务内读epoch、库元信息、FTS、chunk并物化有界结果，事务释放后复检启用/权限。标`humanOnly`、`indexEpoch`和`freshness=unknown`。这只证明单次请求MVCC快照，**不是持久不可变历史库代**；后续按旧引用读取时epoch变更须拒绝/重新选择，不能把旧epoch标签贴到新结果。

完整后台库代索引仍须依v2 membership规则构建/发布，前台继续查旧代，明确快照时间/版本/覆盖；BM25统计可基于该快照的文件集合，而非声称实时源集合。跨请求旧代租约只有真实保留其FTS、member、chunk与读取引用后才可启用；不得一边原地删除旧chunk一边宣称旧代可读。原件/当前源修订与快照修订分离；大变化不暂停人类全文搜索，不以旧快照冒最新。

## 2. AI正文不可提前消费（N02）

搜索snippet也是正文。人类搜索结果不得直接注入模型，AI的search/read均须在实际输出前核验选中原件完整hash与选中快照sourceHash匹配；不存在/外改/无法证明时拒该正文，不回落旧快照。引用使用服务端opaque hitRef或不可篡改的`libraryId + epoch/generation + fileId + parseGeneration + sourceHash + range`绑定，不仅靠noteId。

核验在受保护句柄下进行，保持到响应交接；校验期间不持DB全局锁，最终复检grant/启用/epoch。metadata-only仅能显示无正文候选，不标正文已验证。源校验耗时计入S-AI，不纳入纯DB300ms。P0原“原件删除后AI继续读派生chunk”的历史测试不适用于本次新选择，需新用例明确源缺失拒正文，历史结果不改写。

## 3. 附加只读原件窗口（子协议b通过）

首期窗口`offsetSpace=source-byte`，坐标为原件字节半开区间，不假称canonical UTF8或CodeMirror UTF16；不提供随机行定位，相关AC保持未完成。UTF8/带BOM UTF16LE/BE均严查scalar/代理对边界，坏序列不替换；offset0的区间包含BOM但text去BOM，CRLF不归一化。`nextOffset=实际sourceEndByte`，真实EOF才eof；越EOF/非法边界拒绝。

单次原件预算≤64KiB，最终JSON≤256KiB，转义放大时缩小完整字符窗口，不截半字符或假EOF。docId/revision绑定OS受保护读句柄、scope、窗口实例、源身份；TTL60s、最多32个doc，过期/关闭释放。每页不完整hash整文件；此revision代表受保护读取身份，不代表AI源完整hash verified。用户已明确GB首期只读，普通/百万行完整编辑能力不变。

## 4. scope兼容（子协议c通过）

代码项目沿rootUri兼容既有API时，根后端canonicalize并核受检身份/reparse边界；知识沿libraryId授权。owner window由Tauri注入，不信前端owner参数；任务/游标/docId绑定窗口实例与根/库。label重用须清旧句柄或含实例nonce；根改变、禁库、关窗使旧租约失效。scope绑定不替代路径/权限校验，原件路径不通过这些命令开放给模型。

## 5. 设计准入与验证范围

固定[原型入口](../UI/仿真原型UI.html)支持显式场景参数；默认仍原工作台。编码UI-CR055-FEAT007-v1、知识UI-CR055-FEAT009-v1.1及hash由各UI说明记录，资源索引已登记。主代理实际读设计源码/说明、查看浅色/窄屏截图并用隔离Chrome核验三入口路由3/3、0异常。软件必须另做同条件对照，设计测试不是软件通过。

本机i7-12700、20逻辑核、约32GiB、Windows10内核26300、Node24.8.0，原始源码21份快照与机器证据见[实现基线](../Test/cr055-implementation-baseline.json)。不是16GiB验收机器，不伪报相同基准。正式文件范围、接口注册owner与实际检查由各执行记录/最终报告记录；发布、推送、真实数据迁移均未执行。
