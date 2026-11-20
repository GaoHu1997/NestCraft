/** UI-CR043-v1 锁定稿同源合成夹具。旧资料正文逐字继承，外部标记其来源，不冒充真实访谈。 */
import { cloneOfficeContent, markLoaded, selectFile, st } from "./office-model";
import type { DocBlock, OfficeContent } from "./office-model";
export type SampleKind = "research" | "brand" | "generic";

const HISTORY: Record<"research" | "brand", { name: string; text: string }[]> = {
  research: [
    { name: "竞品对比-预约产品.md", text: `# 预约类产品对比

## 样本
4 款公开可访问的预约工具，观察日期 2026-11-17。

## 观察
1. 时段卡片同时显示剩余与下次开放，减少无效点击。
2. 满额后仍保留活动信息与替代时段。
3. 取消入口在结果页与站内信中重复出现。
4. 并发失败提示可重试，不暴露内部错误。

## 边界
仅公开页面观察，未注册、未采集用户数据；样本量小，结论不外推为行业结论。` },
    { name: "访谈纪要-组织者.md", text: `# 访谈纪要 · 组织者（匿名）

## 场景
社区活动每周 2 场，每场 20 个名额，使用表格手工登记。

## 原话摘录
- 「满了我还要一个个回，最怕重复报名。」
- 「取消的人如果不说，我就不知道名额空出来了。」

## 结论
- 需要自动满额拒绝与名额回补。
- 组织者需要一眼看到剩余名额。

## 脱敏
姓名、联系方式与具体社区已移除；纪要仅用于内部研究。` },
    { name: "研究结论-v2.md", text: `# 研究结论 v2

## 可落地
1. 时段卡片展示「剩余 / 下次开放」。
2. 满额拒绝与取消回补必须原子化。
3. 取消入口在两处重复出现。

## 未验证
- 真实并发下的超卖概率。
- 通知到达率与延迟。

## 建议
先实现主流程与幂等，再评估通知通道。` },
  ],
  brand: [
    { name: "品牌定稿说明.md", text: `# 品牌定稿说明

## 名称
中文「栖造」，英文「NestCraft」。

## 图形
青绿色帆船，浅色底使用深青描边，深色底使用浅青填充。

## 使用
最小尺寸 24px；不拉伸、不叠加渐变；单色场景使用纯色版本。` },
    { name: "官网信息架构.md", text: `# 官网信息架构

1. 首页：一句话定位 + 主操作
2. 能力：任务闭环、知识授权、服务器运维
3. 文档：快速开始、概念、参考
4. 定价与试用

首屏必须能直接到达文档与试用入口；不使用轮播。` },
  ],
};
const RESEARCH_REPORT = "# 社区活动预约调研报告\n\n2026 年 11 月 · 面向产品评审组\n\n## 一、研究目标\n比较人工登记与自助预约的使用路径，优先解决名额不透明、取消不回补和重复报名的问题。本报告使用同项目活动台账，所有人物和数据均为合成业务情景。\n\n## 二、样本与发现\n选取读书分享、手作体验、摄影入门、公益讲座四场活动，每场容量 20 人，总容量 80 人。共报名 64 人，取消 8 人，当前有效预约 56 人，剩余 24 个名额，利用率 70%。\n\n## 三、关键建议\n1. 时段卡片同时显示剩余名额与下次开放时间。\n2. 取消后回补名额，重复点击返回原预约而不是新增记录。\n3. 组织者看活动汇总，参与者看自己的预约与取消入口。\n\n## 四、验证安排\n第一轮用两场活动验证预约与取消路径；第二轮检查组织者的批量处理时间。台账数值是演示基线，不作为真实用户研究结论。\n\n## 五、交付清单\n活动预约台账.xlsx：数据与计算；组织者访谈纪要.md：需求背景；预约方案评审.pptx：面向评审的五页汇报。";
const BRAND_PLAN = "# 栖造品牌发布方案\n\n2026 年 11 月 · 面向品牌评审组\n\n## 一、品牌定位\n以项目为中心组织文档、任务与 AI 协作，让工作过程看得见、内容留得住。中文名称栖造，英文 NestCraft，图形为青绿色帆船。\n\n## 二、视觉使用规范\n工作界面沿用白底、浅灰分隔与蓝色主操作；帆船仅用于品牌识别，不将品牌色铺满功能页面。徽标最小 24px，保留安全留白，不拉伸。\n\n## 三、发布物料\n首页主视觉 2 份、功能截图 6 份、快速开始图解 4 份，共 12 份。已复核分别为 2、4、2，共 8 份，剩余 4 份，台账与汇报使用同一口径。\n\n## 四、发布顺序\n先发布快速开始与基础能力介绍，再发布协作演示。每个材料都回链到对应的产品场景，不使用未经核实的效果数字。\n\n## 五、待评审\n确认首页一句话定位、截图用词与物料交付时间。本方案内容及数量为合成评审夹具，不代表实际发布状态。";
const RESEARCH_XLSX: DocBlock[] = [
  { t: "h", level: 2, text: "活动汇总" },
  { t: "table", head: ["活动", "容量", "报名", "取消", "有效预约", "剩余"], rows: [["读书分享", "20", "18", "2", "16", "4"], ["手作体验", "20", "16", "1", "15", "5"], ["摄影入门", "20", "14", "3", "11", "9"], ["公益讲座", "20", "16", "2", "14", "6"], ["合计", "=SUM(B2:B5)", "=SUM(C2:C5)", "=SUM(D2:D5)", "=SUM(E2:E5)", "=SUM(F2:F5)"]] },
  { t: "h", level: 2, text: "验证计划" },
  { t: "table", head: ["事项", "负责人", "完成标准"], rows: [["取消回补", "林澈（虚构）", "同一活动名额及时恢复"], ["资料复核", "陈雨（虚构）", "报告与台账数字一致"]] },
];
const BRAND_XLSX: DocBlock[] = [
  { t: "h", level: 2, text: "物料汇总" },
  { t: "table", head: ["物料", "计划数量", "已复核", "待复核"], rows: [["首页主视觉", "2", "2", "0"], ["功能截图", "6", "4", "2"], ["快速开始", "4", "2", "2"], ["合计", "=SUM(B2:B4)", "=SUM(C2:C4)", "=SUM(D2:D4)"]] },
  { t: "h", level: 2, text: "发布计划" },
  { t: "table", head: ["批次", "内容", "状态"], rows: [["第一批", "品牌与快速开始", "待评审"], ["第二批", "办公协作演示", "待补截图"]] },
];
const slides = (pages: [string, string][]): DocBlock[] => [{ t: "slides", pages: pages.map(([title, body]) => ({ title, bullets: body.split("\n") })) }];
const RESEARCH_PPT = slides([
  ["让预约更清楚，让名额不浪费", "社区活动预约方案评审\n2026 年 11 月 · 产品评审组"],
  ["四场活动，一份同源台账", "容量 80 · 报名 64 · 取消 8\n有效预约 56 · 剩余 24 · 利用率 70%\n来源：活动预约台账.xlsx / 活动汇总"],
  ["三个高频问题", "不知道还有多少名额；取消后仍显示满额；重复点击造成重复登记。\n来源：组织者访谈纪要（合成情景）"],
  ["先做好预约与取消", "卡片展示剩余；取消立即回补；重复提交返回原记录。\n第一轮以两场活动演示验证交互。"],
  ["本次请确认", "确认优先场景与汇报口径。\n资料与统计均为合成仿真，不是实际业务成效。"],
]);
const BRAND_PPT = slides([
  ["栖造 · NestCraft", "把项目、文档与 AI 放在同一工作区\n品牌发布评审"],
  ["一致，而不是另一套风格", "白底、细分隔线、蓝色主操作。\n帆船用于品牌识别，功能布局保持一致。"],
  ["12 份物料，8 份已复核", "主视觉 2/2 · 功能截图 4/6 · 快速开始 2/4\n剩余 4 份，来源：发布物料台账.xlsx"],
  ["先文档，后演示", "第一批品牌与快速开始；第二批办公协作演示。\n所有数量均为合成评审夹具。"],
]);
const pdf = (pages: string[]): DocBlock[] => [{ t: "pdf", pages: pages.map(text => { const [title, ...body] = text.split("\n"); return { title, text: body.join("\n").trimStart() }; }) }];
const RESEARCH_PDF = pdf(["研究范围与方法\n\n目标：活动预约的资料整理与评审。采用四场活动的合成台账，不采集个人信息。\n容量 80，报名 64，取消 8，有效预约 56，剩余 24。", "资料使用说明\n\n项目正文、台账与演示文稿使用同一口径。未进行真实访谈、外部调研或实际效果测量。所有结论需另行实测验证。"]);
const BRAND_PDF = pdf(["品牌视觉检查清单\n\n名称：栖造 / NestCraft。帆船不拉伸、最小24px、页面主操作保持蓝色。", "发布物料复核\n\n计划12份，已复核8份，待复核4份。所有数量为合成演示，交付以实际导出文件为准。"]);
const RESEARCH_MD = "# 本周研究进展\n\n## 已整理\n四场活动台账已汇总；报告和汇报中的有效预约均为56，剩余24。\n\n## 待确认\n先验证取消回补还是通知送达？建议先确认预约主流程。\n\n## 下一步\n陈雨（虚构）负责核对资料，林澈（虚构）整理评审问题。";
const BRAND_MD = "# 发布周会纪要\n\n## 本周结论\n12份物料已有8份完成复核。功能截图和快速开始各剩2份。\n\n## 待处理\n补齐办公文件树与统一AI侧栏截图，不发布与设计不一致的素材。\n\n## 责任\n陈雨（虚构）整理品牌文案，林澈（虚构）复核交互截图。";

/** 显式载入或受信预置身份调用；有任何目录/文件/草稿则拒绝覆盖。 */
export function loadSample(projectId: string, kind: SampleKind): boolean {
  const s = st(projectId);
  if (s.loaded || s.files.length || s.folders.length) return false;
  const folder = (name: string, parentId: string | null = null) => {
    const id = `OFD-${projectId}-${s.seq++}`; s.folders.push({ id, projectId, parentId, name }); return id;
  };
  const source = folder("01 源资料"), notes = folder("会议与访谈", source), data = folder("02 数据分析"), results = folder("03 交付成果"), archive = folder("历史资料", source);
  s.collapsed = [archive];
  const add = (folderId: string | null, name: string, content: OfficeContent, readonly = true, versions = 0, provenance = "CR-043 合成业务情景 · 非真实访谈、统计或发布结果") => {
    const id = `OFF-${projectId}-${s.seq++}`, updated = new Date("2026-11-19T16:30:00+08:00").getTime();
    s.files.push({ id, projectId, folderId, name, readonly, content: cloneOfficeContent(content), draft: null, versions, updated, provenance,
      history: versions ? [{ number: versions, content: cloneOfficeContent(content), savedAt: updated }] : [] });
    return id;
  };
  if (kind === "generic") {
    // 不从新项目名称/ID编造业务口径；只在明确载入动作后建立空白练习文档。
    add(null, "项目纪要.md", "# 项目纪要（合成仿真）\n\n用于练习文档阅读与编辑。未读取真实资料，没有真实统计。", false);
  } else {
    for (const old of HISTORY[kind]) add(archive, old.name, old.text, true, 0, "保留的 CR-036 原型正文 · 原文未改；不构成实测或真实访谈证据");
    const research = kind === "research";
    add(source, research ? "社区活动预约调研报告.docx" : "栖造品牌发布方案.docx", research ? RESEARCH_REPORT : BRAND_PLAN);
    add(data, research ? "活动预约台账.xlsx" : "发布物料台账.xlsx", research ? RESEARCH_XLSX : BRAND_XLSX);
    add(results, research ? "预约方案评审.pptx" : "品牌发布评审.pptx", research ? RESEARCH_PPT : BRAND_PPT, false, 1);
    add(source, research ? "研究资料摘要.pdf" : "品牌视觉检查单.pdf", research ? RESEARCH_PDF : BRAND_PDF);
    add(notes, research ? "本周研究进展.md" : "发布周会纪要.md", research ? RESEARCH_MD : BRAND_MD);
  }
  markLoaded(projectId);
  selectFile(projectId, s.files.find(f => f.name.endsWith(".docx"))?.id ?? s.files[0]?.id ?? null);
  return true;
}

/** 只选显式样例模板，不能作为自动载入身份依据。 */
export function sampleKindFor(projectName: string): SampleKind {
  if (projectName === "市场研究资料") return "research";
  if (projectName === "品牌与官网") return "brand";
  return "generic";
}
export { createFile, createFolder } from "./office-model";
