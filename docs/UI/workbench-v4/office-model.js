/* CR-038 v1 · 办公项目纯内存设计模型。无网络、无磁盘、无 Office 引擎、无计时器。 */
(function (root) {
  "use strict";
  const clone = value => JSON.parse(JSON.stringify(value));
  const formats = ["md", "docx", "xlsx", "pptx", "pdf", "unsupported"];
  const scenarios = ["normal", "import-failed", "save-failed", "version-conflict", "model-unavailable", "no-permission", "scanned-pdf"];
  const fail = (code, message) => ({ ok: false, code, message });
  const good = data => Object.assign({ ok: true }, data || {});
  const stamp = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const paragraphs = text => String(text || "").split(/\n\s*\n/).filter(Boolean);
  function contentFor(type, text) {
    if (type === "xlsx") return { sheets: [{ name: "工作表1", cells: String(text || "项目\t数量\t说明\n样例\t1\t待核实").split("\n").map(r => r.split("\t")) }] };
    if (type === "pptx") return { slides: String(text || "新演示\n请编辑本页正文").split(/\n---\n/).map(part => { const rows = part.split("\n"); return { title: rows.shift() || "未命名页", body: rows.join("\n") }; }) };
    if (type === "pdf") return { pages: String(text || "PDF 只读样例").split(/\n---\n/) };
    return String(text || "");
  }
  function fixtures(pid) {
    const research = pid === "PRJ-1018";
    const title = research ? "社区活动预约调研报告" : "栖造品牌发布方案";
    const body = research
      ? "# 社区活动预约调研报告\n\n2026 年 11 月 · 面向产品评审组\n\n## 一、研究目标\n比较人工登记与自助预约的使用路径，优先解决名额不透明、取消不回补和重复报名的问题。本报告使用同项目活动台账，所有人物和数据均为合成业务情景。\n\n## 二、样本与发现\n选取读书分享、手作体验、摄影入门、公益讲座四场活动，每场容量 20 人，总容量 80 人。共报名 64 人，取消 8 人，当前有效预约 56 人，剩余 24 个名额，利用率 70%。\n\n## 三、关键建议\n1. 时段卡片同时显示剩余名额与下次开放时间。\n2. 取消后回补名额，重复点击返回原预约而不是新增记录。\n3. 组织者看活动汇总，参与者看自己的预约与取消入口。\n\n## 四、验证安排\n第一轮用两场活动验证预约与取消路径；第二轮检查组织者的批量处理时间。台账数值是演示基线，不作为真实用户研究结论。\n\n## 五、交付清单\n活动预约台账.xlsx：数据与计算；组织者访谈纪要.md：需求背景；预约方案评审.pptx：面向评审的五页汇报。"
      : "# 栖造品牌发布方案\n\n2026 年 11 月 · 面向品牌评审组\n\n## 一、品牌定位\n以项目为中心组织文档、任务与 AI 协作，让工作过程看得见、内容留得住。中文名称栖造，英文 NestCraft，图形为青绿色帆船。\n\n## 二、视觉使用规范\n工作界面沿用白底、浅灰分隔与蓝色主操作；帆船仅用于品牌识别，不将品牌色铺满功能页面。徽标最小 24px，保留安全留白，不拉伸。\n\n## 三、发布物料\n首页主视觉 2 份、功能截图 6 份、快速开始图解 4 份，共 12 份。已复核分别为 2、4、2，共 8 份，剩余 4 份，台账与汇报使用同一口径。\n\n## 四、发布顺序\n先发布快速开始与基础能力介绍，再发布协作演示。每个材料都回链到对应的产品场景，不使用未经核实的效果数字。\n\n## 五、待评审\n确认首页一句话定位、截图用词与物料交付时间。本方案内容及数量为合成评审夹具，不代表实际发布状态。";
    return [
      { name: title + ".docx", type: "docx", group: "source", content: body },
      { name: research ? "活动预约台账.xlsx" : "发布物料台账.xlsx", type: "xlsx", group: "data", content: { sheets: research ? [
        { name: "活动汇总", cells: [["活动", "容量", "报名", "取消", "有效预约", "剩余"], ["读书分享", "20", "18", "2", "16", "4"], ["手作体验", "20", "16", "1", "15", "5"], ["摄影入门", "20", "14", "3", "11", "9"], ["公益讲座", "20", "16", "2", "14", "6"], ["合计", "=SUM(B2:B5)", "=SUM(C2:C5)", "=SUM(D2:D5)", "=SUM(E2:E5)", "=SUM(F2:F5)"]] },
        { name: "验证计划", cells: [["事项", "负责人", "完成标准"], ["取消回补", "林澈（虚构）", "同一活动名额及时恢复"], ["资料复核", "陈雨（虚构）", "报告与台账数字一致"]] }
      ] : [
        { name: "物料汇总", cells: [["物料", "计划数量", "已复核", "待复核"], ["首页主视觉", "2", "2", "0"], ["功能截图", "6", "4", "2"], ["快速开始", "4", "2", "2"], ["合计", "=SUM(B2:B4)", "=SUM(C2:C4)", "=SUM(D2:D4)"]] },
        { name: "发布计划", cells: [["批次", "内容", "状态"], ["第一批", "品牌与快速开始", "待评审"], ["第二批", "办公协作演示", "待补截图"]] }
      ] } },
      { name: research ? "预约方案评审.pptx" : "品牌发布评审.pptx", type: "pptx", group: "results", source: false, savedSample: true, content: { slides: research ? [
        { title: "让预约更清楚，让名额不浪费", body: "社区活动预约方案评审\n2026 年 11 月 · 产品评审组" },
        { title: "四场活动，一份同源台账", body: "容量 80 · 报名 64 · 取消 8\n有效预约 56 · 剩余 24 · 利用率 70%\n来源：活动预约台账.xlsx / 活动汇总" },
        { title: "三个高频问题", body: "不知道还有多少名额；取消后仍显示满额；重复点击造成重复登记。\n来源：组织者访谈纪要（合成情景）" },
        { title: "先做好预约与取消", body: "卡片展示剩余；取消立即回补；重复提交返回原记录。\n第一轮以两场活动演示验证交互。" },
        { title: "本次请确认", body: "确认优先场景与汇报口径。\n资料与统计均为合成仿真，不是实际业务成效。" }
      ] : [
        { title: "栖造 · NestCraft", body: "把项目、文档与 AI 放在同一工作区\n品牌发布评审" },
        { title: "一致，而不是另一套风格", body: "白底、细分隔线、蓝色主操作。\n帆船用于品牌识别，功能布局保持一致。" },
        { title: "12 份物料，8 份已复核", body: "主视觉 2/2 · 功能截图 4/6 · 快速开始 2/4\n剩余 4 份，来源：发布物料台账.xlsx" },
        { title: "先文档，后演示", body: "第一批品牌与快速开始；第二批办公协作演示。\n所有数量均为合成评审夹具。" }
      ] } },
      { name: research ? "研究资料摘要.pdf" : "品牌视觉检查单.pdf", type: "pdf", group: "source", content: { pages: research ? ["研究范围与方法\n\n目标：活动预约的资料整理与评审。采用四场活动的合成台账，不采集个人信息。\n容量 80，报名 64，取消 8，有效预约 56，剩余 24。", "资料使用说明\n\n项目正文、台账与演示文稿使用同一口径。未进行真实访谈、外部调研或实际效果测量。所有结论需另行实测验证。"] : ["品牌视觉检查清单\n\n名称：栖造 / NestCraft。帆船不拉伸、最小24px、页面主操作保持蓝色。", "发布物料复核\n\n计划12份，已复核8份，待复核4份。所有数量为合成演示，交付以实际导出文件为准。"] } },
      { name: research ? "本周研究进展.md" : "发布周会纪要.md", type: "md", group: "notes", content: research ? "# 本周研究进展\n\n## 已整理\n四场活动台账已汇总；报告和汇报中的有效预约均为56，剩余24。\n\n## 待确认\n先验证取消回补还是通知送达？建议先确认预约主流程。\n\n## 下一步\n陈雨（虚构）负责核对资料，林澈（虚构）整理评审问题。" : "# 发布周会纪要\n\n## 本周结论\n12份物料已有8份完成复核。功能截图和快速开始各剩2份。\n\n## 待处理\n补齐办公文件树与统一AI侧栏截图，不发布与设计不一致的素材。\n\n## 责任\n陈雨（虚构）整理品牌文案，林澈（虚构）复核交互截图。" }
    ];
  }
  function create(projects, originalOffice) {
    const states = new Map();
    let serial = 0;
    const uid = prefix => prefix + (++serial);
    function makeDoc(pid, input) {
      return { id: uid("OF-"), projectId: pid, name: input.name, type: input.type || "md", source: input.source !== false, folderId: input.folderId || null,
        provenance: input.provenance || "CR-038 合成夹具 · 非真实文件解析", content: clone(input.content == null ? "" : input.content), draft: null,
        revision: 1, editRevision: 0, draftBase: 1, saveState: "saved", saveToken: null, error: "", versions: [], citations: [], updated: input.updated || "初始夹具" };
    }
    function ensureProject(pid) {
      if (!states.has(pid)) states.set(pid, { id: pid, files: [], folders: [], selectedFolderId: null, selectedId: null, location: null, scenario: "normal", run: null, proposal: null, history: [], generation: 0, loaded: false });
      return states.get(pid);
    }
    function sampleFolders(pid) {
      const s = ensureProject(pid);
      const add = (name, parentId = null) => {
        let folder = s.folders.find(f => f.name === name && f.parentId === parentId);
        if (!folder) { folder = { id: uid("DIR-"), projectId: pid, parentId, name }; s.folders.push(folder); }
        return folder.id;
      };
      const source = add("01 源资料"), notes = add("会议与访谈", source), data = add("02 数据分析"), results = add("03 交付成果"), archive = add("历史资料", source);
      return { source, notes, data, results, archive };
    }
    const parentOf = (pid, id) => ensureProject(pid).folders.find(f => f.id === id);
    const parentValid = (pid, id) => id === null || Boolean(parentOf(pid, id));
    function folderPath(pid, id) {
      const parts = []; const seen = new Set();
      while (id) { if (seen.has(id)) return "无效目录"; seen.add(id); const f = parentOf(pid, id); if (!f) return "无效目录"; parts.unshift(f.name); id = f.parentId; }
      return parts.join("/");
    }
    function occupied(pid, parentId, name) {
      const s = ensureProject(pid), key = name.trim().normalize("NFC").toLowerCase();
      return s.folders.some(f => f.parentId === parentId && f.name.normalize("NFC").toLowerCase() === key) || s.files.some(f => (f.folderId || null) === parentId && f.name.normalize("NFC").toLowerCase() === key);
    }
    function createFolder(pid, name, parentId) {
      const s = ensureProject(pid); parentId = parentId === undefined ? s.selectedFolderId : parentId;
      name = String(name || "").trim().normalize("NFC");
      if (!validName(name)) return fail("NAME", "请输入有效文件夹名称，不含路径、保留名或末尾点号。");
      if (!parentValid(pid, parentId)) return fail("PARENT", "父文件夹不存在或不属于当前项目。");
      if (occupied(pid, parentId, name)) return fail("DUPLICATE", "当前目录已有同名文件或文件夹，请换一个名称。");
      const folder = { id: uid("DIR-"), projectId: pid, parentId, name }; s.folders.push(folder); s.selectedFolderId = folder.id;
      return good({ folderId: folder.id });
    }
    function selectFolder(pid, id) {
      if (!parentValid(pid, id)) return fail("PARENT", "无法选择其他项目或不存在的目录。");
      ensureProject(pid).selectedFolderId = id; return good();
    }
    function addFixture(pid, input, dirs) {
      const f = makeDoc(pid, { ...input, folderId: dirs[input.group] || dirs.source, provenance: "CR-043 合成业务情景 · 非真实访谈、统计或发布结果" });
      if (input.savedSample) { f.versions.push({ id: uid("V-"), number: 1, content: clone(f.content), savedAt: "2026-11-19 16:30（仿真）", citations: [], check: "样例已保存 · 未导出" }); f.updated = "11-19 16:30（仿真）"; }
      ensureProject(pid).files.push(f); return f;
    }
    (projects || []).filter(p => p.kind === "work").forEach(p => {
      const state = ensureProject(p.id);
      const seeds = (originalOffice && originalOffice[p.id]) || [];
      const dirs = seeds.length || ["PRJ-1018", "PRJ-1009"].includes(p.id) ? sampleFolders(p.id) : null;
      seeds.forEach(d => state.files.push(makeDoc(p.id, { name: d.name, type: "md", content: d.body, updated: d.updated, folderId: dirs.archive,
        provenance: "保留的 CR-036 原型正文 · 原文未改；不构成实测或真实访谈证据" })));
      if (["PRJ-1018", "PRJ-1009"].includes(p.id)) { fixtures(p.id).forEach(d => addFixture(p.id, d, dirs)); state.loaded = true; }
      state.selectedId = state.files.find(f => f.type === "docx")?.id || state.files[0]?.id || null;
      state.selectedFolderId = state.files.find(f => f.id === state.selectedId)?.folderId || null;
    });
    const get = (pid, fid) => ensureProject(pid).files.find(f => f.id === fid);
    const current = f => f.draft == null ? f.content : f.draft;
    const dirty = f => f.draft != null;
    const fingerprint = f => f.revision + ":" + f.editRevision;
    const validName = name => Boolean(name && name.trim() && name.length <= 100 && !/[\\/:*?"<>|\x00-\x1f]/.test(name) && !/[. ]$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) && ![".", ".."].includes(name));
    function suggestName(pid, name, suffix, folderId) {
      if (folderId === undefined) folderId = ensureProject(pid).selectedFolderId;
      const s = ensureProject(pid), at = name.lastIndexOf("."), base = at > 0 ? name.slice(0, at) : name, ext = at > 0 ? name.slice(at) : "";
      let n = 1, next = base + (suffix || "-副本") + ext;
      while (occupied(pid, folderId, next)) next = base + (suffix || "-副本") + "-" + (++n) + ext;
      return next;
    }
    function createDocument(pid, input) {
      const s = ensureProject(pid), type = String(input.type || "md").toLowerCase();
      let name = String(input.name || "").trim().normalize("NFC");
      const folderId = input.folderId === undefined ? s.selectedFolderId : input.folderId;
      if (!parentValid(pid, folderId)) return fail("PARENT", "目标目录不存在或不属于当前项目。");
      if (!validName(name)) return fail("NAME", "填写有效文件名，不含路径或特殊字符（最长 100 字）。");
      if (!formats.includes(type)) return fail("FORMAT", "该格式不受支持；请选择“未支持格式”保留并查看原因。");
      if (!name.includes(".") && type !== "unsupported") name += "." + type;
      if (type !== "unsupported" && !name.toLowerCase().endsWith("." + type)) return fail("EXTENSION", "文件名后缀与选择的格式不一致，请改名。");
      if (occupied(pid, folderId, name)) return Object.assign(fail("DUPLICATE", "当前目录同名条目已存在，拒绝覆盖。建议：" + suggestName(pid, name, undefined, folderId)), { suggestion: suggestName(pid, name, undefined, folderId) });
      const doc = makeDoc(pid, { name, type, folderId, content: typeof input.content === "object" ? input.content : contentFor(type, input.content), source: input.source === true,
        provenance: input.source ? "用户填写的导入仿真 · 未读取真实目录或文件" : "手工新建的会话草稿 · 刷新丢失" });
      if (!doc.source) { doc.draft = clone(doc.content); doc.editRevision++; doc.saveState = "dirty"; }
      s.files.push(doc); s.selectedId = doc.id; s.location = null;
      return good({ fileId: doc.id });
    }
    function importDocument(pid, input) {
      if (ensureProject(pid).scenario === "import-failed") return fail("IMPORT", "导入仿真失败：格式检查未通过。表单内容已保留；可切换正常状态后重试。");
      return createDocument(pid, Object.assign({}, input, { source: true }));
    }
    function select(pid, fid, location) {
      const s = ensureProject(pid);
      if (!get(pid, fid)) return fail("FILE", "当前项目没有这个文件。");
      s.selectedId = fid; s.selectedFolderId = get(pid, fid).folderId || null; s.location = location ? clone(location) : null; return good();
    }
    function loadSamples(pid) {
      const s = ensureProject(pid);
      if (s.loaded) return fail("LOADED", "已载入样例，不会覆盖当前文件或草稿。");
      const dirs = sampleFolders(pid); fixtures(pid).forEach(d => { if (!s.files.some(f => f.name === d.name)) addFixture(pid, d, dirs); });
      s.loaded = true; s.selectedId ||= s.files[0]?.id; return good();
    }
    function copyDocument(pid, fid, name) {
      const f = get(pid, fid);
      if (!f) return fail("FILE", "找不到文件。");
      if (["pdf", "unsupported"].includes(f.type)) return fail("READ_ONLY", "该格式仅供只读预览，不能在本设计稿编辑。");
      if (ensureProject(pid).scenario === "no-permission" && f.source) return fail("PERMISSION", "源资料无读取权限，无法创建副本。");
      const result = createDocument(pid, { name: name || suggestName(pid, f.name, undefined, f.folderId), type: f.type, folderId: f.folderId, content: clone(current(f)) });
      if (result.ok) get(pid, result.fileId).citations = [{ fileId: f.id, name: f.name, location: { kind: "document" }, revision: f.revision }];
      return result;
    }
    function edit(pid, fid, content) {
      const f = get(pid, fid);
      if (!f) return fail("FILE", "找不到文件。");
      if (f.source || ["pdf", "unsupported"].includes(f.type)) return fail("READ_ONLY", "原件只读，请先创建编辑副本。");
      if (JSON.stringify(current(f)) === JSON.stringify(content)) return good({ unchanged: true });
      f.draft = f.versions.length && JSON.stringify(f.content) === JSON.stringify(content) ? null : clone(content);
      f.editRevision++; f.draftBase = f.draftBase || f.revision; f.saveState = f.draft == null ? "saved" : "dirty"; f.saveToken = null; f.error = "";
      return good();
    }
    function beginSave(pid, fid) {
      const s = ensureProject(pid), f = get(pid, fid);
      if (!f || !dirty(f)) return fail("NO_DRAFT", "当前文件没有待保存草稿。");
      if (s.proposal?.targetId === fid && s.proposal.items.some(i => i.decision === "pending")) return fail("REVIEW", "保存前请接受或拒绝此文件其余候选建议；已接受内容仍保留在草稿。");
      f.saveState = "saving"; f.error = ""; f.saveToken = { id: uid("SAVE-"), editRevision: f.editRevision, revision: f.revision };
      return good({ token: f.saveToken.id });
    }
    function finishSave(pid, fid, token) {
      const s = ensureProject(pid), f = get(pid, fid);
      if (!f || !f.saveToken || token !== f.saveToken.id || f.saveToken.editRevision !== f.editRevision) return fail("STALE", "保存请求已失效；较新的编辑未被覆盖。");
      f.saveToken = null;
      if (s.scenario === "save-failed" || s.scenario === "version-conflict" || f.draftBase !== f.revision) {
        const conflict = s.scenario === "version-conflict" || f.draftBase !== f.revision;
        f.saveState = conflict ? "conflict" : "failed"; f.error = conflict ? "版本冲突：原保存基线已变化。草稿保留，可另存副本或切换正常状态后重试。" : "保存失败（仿真）：写入被拒绝。草稿保留，切换正常状态后重试。";
        return fail(conflict ? "CONFLICT" : "SAVE", f.error);
      }
      f.content = clone(f.draft); f.draft = null; f.revision++; f.draftBase = f.revision; f.saveState = "saved"; f.updated = stamp();
      f.versions.push({ id: uid("V-"), number: f.versions.length + 1, content: clone(f.content), savedAt: f.updated, citations: clone(f.citations), check: "待人工核对" });
      return good({ version: f.versions.length });
    }
    function save(pid, fid) { const f = get(pid, fid); if (f && !dirty(f)) return good({ unchanged: true, version: f.versions.length }); const r = beginSave(pid, fid); return r.ok ? finishSave(pid, fid, r.token) : r; }
    function discardFileDraft(pid, fid) {
      const s = ensureProject(pid), f = get(pid, fid);
      if (!f) return fail("FILE", "找不到文件。");
      if (f.source) return good();
      f.draft = null; f.editRevision++; f.saveToken = null; f.saveState = "saved"; f.error = "";
      if (!f.versions.length) s.files = s.files.filter(x => x.id !== fid);
      if (s.proposal?.targetId === fid) s.proposal.invalidated = true;
      if (!s.files.some(x => x.id === s.selectedId)) s.selectedId = s.files[0]?.id || null;
      return good();
    }
    function discardDrafts(pid) {
      const s = ensureProject(pid);
      s.files.forEach(f => { if (dirty(f)) { f.draft = null; f.editRevision++; f.saveToken = null; f.saveState = "saved"; f.error = ""; } });
      s.files = s.files.filter(f => f.source || f.versions.length);
      if (!s.files.some(f => f.id === s.selectedId)) s.selectedId = s.files[0]?.id || null;
      if (s.proposal) s.proposal.invalidated = true;
      stopRun(pid); return good();
    }
    function restoreVersion(pid, fid, versionId) {
      const f = get(pid, fid), v = f?.versions.find(x => x.id === versionId);
      if (!v) return fail("VERSION", "找不到该历史版本。");
      f.draft = clone(v.content); f.editRevision++; f.draftBase = f.revision; f.citations = clone(v.citations); f.saveState = "dirty"; f.saveToken = null; f.error = "";
      return good({ restoredFrom: versionId, draftOnly: true });
    }
    function readReference(pid, ref) {
      const s = ensureProject(pid), f = get(pid, ref.fileId);
      if (!f) return fail("SCOPE", "来源不属于当前项目，已拒绝跨项目读取。");
      if (s.scenario === "no-permission" && f.source) return fail("PERMISSION", "来源无权限：“" + f.name + "”。未读取正文。");
      if ((ref.revision != null && ref.revision !== f.revision) || (ref.fingerprint && ref.fingerprint !== fingerprint(f))) return fail("SOURCE_CHANGED", "来源版本已变化，无法将当前内容冒充旧引用。请重新读取并生成引用。");
      if (f.type === "unsupported") return fail("FORMAT", "来源格式未支持或已损坏，未假装读取成功。");
      if (s.scenario === "scanned-pdf" && f.type === "pdf") return fail("OCR", "扫描 PDF 无可提取文本；本轮未接 OCR，不能解读。");
      const data = current(f), loc = ref.location || { kind: "document" };
      let text, resolved = clone(loc);
      const validIndex = (n, length) => Number.isInteger(n) && n >= 0 && n < length;
      const badLocation = () => fail("LOCATION", "引用位置已失效或超出范围，请重新选择具体段落／页／单元格。");
      if (f.type === "pptx" || f.type === "pdf") {
        const pages = f.type === "pptx" ? data.slides : data.pages, index = loc.kind === "document" ? 0 : loc.index;
        if (!["document", "page"].includes(loc.kind) || !validIndex(index, pages.length)) return badLocation();
        const pageText = x => f.type === "pptx" ? x.title + "\n" + x.body : x;
        text = loc.kind === "document" ? pages.map(pageText).join("\n\n") : pageText(pages[index]); resolved = { kind: "page", index };
      }
      else if (f.type === "xlsx") {
        const sheet = loc.kind === "document" ? 0 : loc.sheet, row = loc.kind === "document" ? 0 : loc.row, col = loc.kind === "document" ? 0 : loc.col;
        if (!["document", "cell"].includes(loc.kind) || !validIndex(sheet, data.sheets.length)) return badLocation();
        const cells = data.sheets[sheet].cells;
        if (!validIndex(row, cells.length) || !validIndex(col, Math.max(3, ...cells.map(r => r.length)))) return badLocation();
        text = loc.kind === "cell" ? cells[row][col] || "" : cells.map(r => r.join(" / ")).join("\n"); resolved = { kind: "cell", sheet, row, col };
      }
      else {
        const parts = paragraphs(data), index = loc.kind === "document" ? 0 : loc.index;
        if (!["document", "paragraph"].includes(loc.kind) || (loc.kind !== "document" && !validIndex(index, parts.length))) return badLocation();
        text = loc.kind === "paragraph" ? parts[index] : String(data); resolved = { kind: "paragraph", index };
      }
      return good({ fileId: f.id, name: f.name, revision: f.revision, fingerprint: fingerprint(f), location: resolved, text: String(text || ""), requestedLocation: loc });
    }
    function startRun(pid, input) {
      const s = ensureProject(pid);
      if (s.run?.status === "running") return fail("BUSY", "先停止当前执行，再开启新请求。");
      if (s.proposal?.items.some(i => i.decision === "pending") && !s.proposal.invalidated) return fail("REVIEW", "请先处理或放弃当前候选修改，避免丢失审阅决定。");
      if (!input.purpose?.trim() || !input.audience?.trim()) return fail("FORM", "请填写用途与受众。");
      if (!input.refs?.length) return fail("SOURCES", "至少选择一份当前项目资料；无来源时不能生成事实结论。");
      if ((input.model || "cloud") === "cloud" && input.consent !== true) return fail("CONSENT", "请明确勾选同意将列出的资料范围发送给云模型（此处仅仿真）。");
      if (!["read", "word", "ppt", "polish", "sheet"].includes(input.action)) return fail("ACTION", "不支持该操作。");
      if (["word", "ppt"].includes(input.action) && !input.title?.trim()) return fail("TITLE", "请填写成果标题。");
      if (input.refs.some(r => !get(pid, r.fileId))) return fail("SCOPE", "来源不属于当前项目，已拒绝。");
      const refs = input.refs.map(r => ({ fileId: r.fileId, location: clone(r.location || { kind: "document" }), fingerprint: fingerprint(get(pid, r.fileId)) }));
      const run = { id: uid("OR-"), projectId: pid, generation: ++s.generation, status: "running", step: 0, input: clone(input), refs, sources: [], error: "", log: ["请求已冻结；等待读取。此为有界仿真，不访问模型。"] };
      s.run = run; s.proposal = null; s.history.push({ id: run.id, purpose: input.purpose, action: input.action, status: "running" });
      return good({ requestId: run.id, generation: run.generation });
    }
    function runFail(s, message) { s.run.status = "failed"; s.run.error = message; s.run.log.push(message); const h = s.history.find(x => x.id === s.run.id); if (h) h.status = "failed"; return fail("RUN", message); }
    function advanceRun(pid, requestId) {
      const s = ensureProject(pid), r = s.run;
      if (!r || r.id !== requestId || r.status !== "running" || r.generation !== s.generation) return fail("STALE", "迟到、取消或旧代次结果已丢弃。");
      if (s.scenario === "model-unavailable") return runFail(s, "模型不可用（仿真）。阅读与手工编辑不受影响；可打开设置或恢复正常状态后重试。");
      if (r.refs.some(ref => !get(pid, ref.fileId) || fingerprint(get(pid, ref.fileId)) !== ref.fingerprint)) return runFail(s, "源资料或草稿版本已变化，请按新来源重新生成。");
      if (r.step === 0) {
        const sources = r.refs.map(ref => readReference(pid, ref));
        const denied = sources.find(x => !x.ok); if (denied) return runFail(s, denied.message);
        r.sources = sources; r.step = 1; r.log.push("已读取 " + sources.length + " 份当前项目指定来源；未读取其他项目。"); return good({ step: 1 });
      }
      if (r.step === 1) { r.step = 2; r.log.push("已形成候选内容；等待来源与写入基线检查。"); return good({ step: 2 }); }
      const unreadable = r.refs.map(ref => readReference(pid, ref)).find(x => !x.ok);
      if (unreadable) return runFail(s, unreadable.message);
      r.status = "completed"; r.step = 3; r.log.push("仿真检查结束；不是用户验收，尚未写文件。");
      const h = s.history.find(x => x.id === r.id); if (h) h.status = "completed";
      const citations = r.sources.map(src => ({ fileId: src.fileId, name: src.name, revision: src.revision, fingerprint: src.fingerprint, location: src.location }));
      if (["read", "sheet"].includes(r.input.action)) {
        r.result = { summary: "根据所选资料，建议先核对来源与适用边界，再整理可审阅的结论。以下仅为确定性演示，不代表真实模型分析。", excerpts: r.sources.map(src => ({ text: src.text.slice(0, 220), citation: { fileId: src.fileId, name: src.name, revision: src.revision, fingerprint: src.fingerprint, location: src.location } })), caveat: "推断／待补资料：真实效果与数据准确性未验证。", citations };
      } else {
        const target = r.input.action === "polish" ? get(pid, r.input.targetId) : null;
        const usable = target && !target.source && ["md", "docx"].includes(target.type) ? target : null;
        const type = r.input.action === "ppt" ? "pptx" : usable?.type || "docx";
        const count = type === "pptx" ? Math.max(2, Math.min(8, Number(r.input.pages) || 3)) : 2;
        const rawName = (r.input.title || "资料润色") + "." + type;
        const name = suggestName(pid, rawName, "-候选");
        const base = usable ? paragraphs(current(usable)) : [];
        const items = Array.from({ length: count }, (_, i) => ({ id: "item-" + (i + 1), index: i, decision: "pending", before: base[i] || "", after: type === "pptx"
          ? { title: [r.input.title, "来源与主要发现", "建议与待验证问题"][i] || "行动计划 " + (i + 1), body: i === 0 ? "用途：" + r.input.purpose + "\n受众：" + r.input.audience + "\n合成草稿 · 待人工核对" : "参考“" + r.sources[i % r.sources.length].name + "”：\n" + r.sources[i % r.sources.length].text.slice(0, 160) + "\n待验证：示例不代表真实结论。" }
          : (i === 0 ? "# " + (r.input.title || "资料摘要") + "\n\n面向" + r.input.audience + "，用于" + r.input.purpose + "。" : "## 来源与边界\n" + r.sources.map(x => "参考“" + x.name + "”：" + x.text.slice(0, 100)).join("\n") + "\n\n待核对：以上为合成候选内容，不代表真实实测。") }));
        s.proposal = { id: uid("OP-"), requestId: r.id, projectId: pid, type, name, targetId: usable?.id || null, targetFingerprint: usable ? fingerprint(usable) : null,
          sourceFingerprints: r.refs.map(x => ({ fileId: x.fileId, fingerprint: x.fingerprint })), baseContent: usable ? clone(current(usable)) : null, baseBlocks: base, items, citations, invalidated: false, createdFile: false, audit: [] };
      }
      return good({ completed: true, proposalId: s.proposal?.id || null });
    }
    function stopRun(pid) {
      const s = ensureProject(pid); s.generation++;
      if (s.run?.status === "running") { s.run.status = "stopped"; s.run.log.push("用户已停止；所有旧代次结果将丢弃。"); const h = s.history.find(x => x.id === s.run.id); if (h) h.status = "stopped"; }
      return good();
    }
    function retryRun(pid) {
      const s = ensureProject(pid); if (!s.run || !["failed", "stopped"].includes(s.run.status)) return fail("RETRY", "没有可重试的失败或停止请求。");
      const input = clone(s.run.input); if (input.model === "cloud" || !input.model) input.consent = false;
      return good({ input, requiresConfirmation: (input.model || "cloud") === "cloud" });
    }
    function proposalFresh(pid, p) {
      if (!p || p.invalidated) return false;
      if (p.sourceFingerprints.some(x => { const f = get(pid, x.fileId); const expected = x.fileId === p.targetId ? p.targetFingerprint : x.fingerprint; return !f || fingerprint(f) !== expected; })) return false;
      return !p.targetId || fingerprint(get(pid, p.targetId) || {}) === p.targetFingerprint;
    }
    function decide(pid, proposalId, itemId, decision) {
      const s = ensureProject(pid), p = s.proposal;
      if (!p || p.id !== proposalId) return fail("PROPOSAL", "旧提案已失效。");
      const item = p.items.find(x => x.id === itemId);
      if (!item || item.decision !== "pending" || !["accepted", "rejected"].includes(decision)) return fail("DECISION", "该项已处理或决定无效。");
      if (decision === "rejected") { item.decision = decision; p.audit.push({ itemId, decision }); return good(); }
      if (!proposalFresh(pid, p)) return fail("STALE_PROPOSAL", "人工编辑或来源已变化：旧建议不能写入。请重新比较或重新生成。");
      if (s.scenario === "no-permission" || s.scenario === "version-conflict") return fail("CONFLICT", "当前权限或版本冲突阻止写入；候选与草稿保留。");
      const denied = p.citations.map(c => readReference(pid, { fileId: c.fileId, location: c.location })).find(x => !x.ok);
      if (denied) return denied;
      if (!p.targetId) {
        const r = createDocument(pid, { name: p.name, type: p.type, content: p.type === "pptx" ? { slides: [] } : "" });
        if (!r.ok) return r;
        p.targetId = r.fileId; p.createdFile = true;
      }
      const f = get(pid, p.targetId);
      item.decision = decision;
      let content;
      if (p.createdFile) {
        const accepted = p.items.filter(x => x.decision === "accepted");
        content = p.type === "pptx" ? { slides: accepted.map(x => clone(x.after)) } : accepted.map(x => x.after).join("\n\n");
      } else if (p.type === "pptx") { content = clone(p.baseContent); p.items.filter(x => x.decision === "accepted").forEach(x => { content.slides[x.index] = clone(x.after); }); }
      else { const blocks = p.baseBlocks.slice(); p.items.filter(x => x.decision === "accepted").forEach(x => { blocks[x.index] = x.after; }); content = blocks.join("\n\n"); }
      edit(pid, f.id, content); f.citations = clone(p.citations); p.targetFingerprint = fingerprint(f); p.audit.push({ itemId, decision });
      s.selectedId = f.id; s.location = null;
      return good({ fileId: f.id, draftOnly: true });
    }
    function rejectRemaining(pid) { const s = ensureProject(pid), p = s.proposal; if (!p) return fail("PROPOSAL", "没有提案。"); p.items.filter(i => i.decision === "pending").forEach(i => { i.decision = "rejected"; p.audit.push({ itemId: i.id, decision: "rejected" }); }); return good(); }
    function recompare(pid) {
      const s = ensureProject(pid), p = s.proposal;
      if (!p) return fail("PROPOSAL", "没有提案。");
      const denied = p.sourceFingerprints.map(x => readReference(pid, { fileId: x.fileId })).find(x => !x.ok);
      if (denied) return denied;
      if (p.sourceFingerprints.some(x => x.fileId !== p.targetId && fingerprint(get(pid, x.fileId) || {}) !== x.fingerprint)) return fail("SOURCE_CHANGED", "源资料已变化，必须重新生成，不可仅更新比较基线。");
      const target = p.targetId && get(pid, p.targetId);
      if (!target) return fail("NO_TARGET", "没有可比较的编辑文件，请重新生成。");
      const old = clone(p), blocks = target.type === "pptx" ? current(target).slides : paragraphs(current(target));
      p.id = uid("OP-"); p.targetFingerprint = fingerprint(target); p.invalidated = false; p.createdFile = false; p.baseContent = clone(current(target)); p.baseBlocks = target.type === "pptx" ? [] : blocks.slice();
      p.items = old.items.filter(i => i.decision === "pending").map((i, n) => ({ ...i, index: i.index, before: blocks[i.index] || "", id: "item-r" + (n + 1) }));
      p.audit.push({ decision: "recompared", previousId: old.id }); return good({ proposalId: p.id });
    }
    function exportCheck(pid, fid, input) {
      const s = ensureProject(pid), f = get(pid, fid);
      if (!f) return fail("FILE", "找不到成果文件。");
      const options = input || {}, latest = f.versions[f.versions.length - 1];
      const checks = [{ label: "保存版本", ok: Boolean(latest), detail: latest ? "已保存 v" + latest.number : "尚未保存为成果" },
        { label: "草稿", ok: !dirty(f) || options.useSaved === true, detail: dirty(f) ? (options.useSaved ? "明确导出已保存版本，不含未保存编辑" : "存在未保存草稿，请先保存或明确选择已保存版本") : "无未保存编辑" },
        { label: "待审阅修改", ok: options.useSaved === true || !s.proposal?.items.some(i => i.decision === "pending"), detail: s.proposal?.items.some(i => i.decision === "pending") ? (options.useSaved ? "仅检查不可变已保存版本，不包含未审阅候选" : "还有建议未接受／拒绝") : "无待处理建议" },
        { label: "来源权限", ok: s.scenario !== "no-permission", detail: s.scenario === "no-permission" ? "源资料权限被拒绝" : "当前项目来源检查通过（仿真）" },
        { label: "保真风险", ok: false, detail: "未接入原生格式引擎，复杂排版／公式／动画保真未验证" },
        { label: "导出引擎", ok: false, detail: "未接入导出引擎；仅演示状态检查，真实下载禁用" }];
      return good({ fileId: fid, name: options.name || f.name, suggestion: suggestName(pid, options.name || f.name, "-导出"), format: options.format || f.type,
        location: options.location || "演示导出目录（不读取磁盘）", version: latest?.number || null, checks, canDownload: false });
    }
    function cellValue(cells, row, col, trail) {
      const raw = String(cells[row]?.[col] ?? ""); if (!raw.startsWith("=")) return raw;
      const key = row + ":" + col, seen = (trail || []).concat(key); if ((trail || []).includes(key)) return "#循环引用";
      const m = /^=SUM\(([A-Z])(\d+):([A-Z])(\d+)\)$/i.exec(raw); if (!m) return "#未支持公式";
      const c1 = m[1].toUpperCase().charCodeAt(0) - 65, c2 = m[3].toUpperCase().charCodeAt(0) - 65, r1 = Number(m[2]) - 1, r2 = Number(m[4]) - 1;
      if (r1 < 0 || r2 >= cells.length || c1 < 0 || c2 > 25 || r1 > r2 || c1 > c2) return "#范围错误";
      let total = 0; for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) { const value = cellValue(cells, r, c, seen); if (String(value).startsWith("#")) return value; total += Number(value) || 0; }
      return String(total);
    }
    return { ensureProject: pid => { ensureProject(pid); return good(); }, getProject: pid => clone(ensureProject(pid)), getFile: (pid, fid) => { const f = get(pid, fid); return f ? clone(f) : null; },
      current: f => clone(current(f)), createFolder, selectFolder, folderPath, filePath: (pid, fid) => { const f = get(pid, fid); return f ? [folderPath(pid, f.folderId), f.name].filter(Boolean).join("/") : ""; }, paragraphs, formats: formats.slice(), scenarios: scenarios.slice(), contentFor, suggestName, select, createDocument, importDocument, copyDocument, loadSamples,
      captureConversation: pid => { const s = ensureProject(pid); return clone({ run: s.run, proposal: s.proposal, history: s.history, generation: s.generation }); },
      restoreConversation: (pid, snapshot) => { const s = ensureProject(pid), c = snapshot || {}; Object.assign(s, clone({ run: c.run || null, proposal: c.proposal || null, history: c.history || [], generation: c.generation || 0 })); return good(); },
      edit, beginSave, finishSave, save, dirtyFiles: pid => ensureProject(pid).files.filter(dirty).map(f => f.id), discardDrafts, discardFileDraft, restoreVersion,
      readReference, startRun, advanceRun, stopRun, retryRun, decide, rejectRemaining, recompare,
      isProposalFresh: pid => proposalFresh(pid, ensureProject(pid).proposal), exportCheck, cellValue,
      setScenario: (pid, value) => { if (!scenarios.includes(value)) return fail("SCENARIO", "未知演示状态。"); ensureProject(pid).scenario = value; return good(); } };
  }
  root.OfficeModel = Object.freeze({ create, formats: formats.slice(), scenarios: scenarios.slice() });
})(typeof window === "undefined" ? globalThis : window);
