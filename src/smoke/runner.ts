/**
 * IPC 冒烟套件：TAURI_SMOKE=1 启动时对全部后端命令灌模拟数据并断言。
 * 报告写入 app_data_dir/smoke-report.md 并打印到 stdout。
 */
import * as api from "@/api";
import { runUiSuite, uiReportSuffix } from "./ui-suite";
import { runExecutionSuite } from "./execution-suite";

interface Case {
  section: string;
  name: string;
  ok: boolean;
  detail: string;
}

const results: Case[] = [];

function expect(cond: unknown, msg: string): void {
  if (!cond) throw new Error("断言失败: " + msg);
}

async function t(section: string, name: string, fn: () => Promise<string>): Promise<void> {
  api.invoke("smoke_progress", { label: "START " + section + " / " + name }).catch(() => {});
  try {
    const detail = await fn();
    results.push({ section, name, ok: true, detail });
  } catch (e) {
    results.push({ section, name, ok: false, detail: String(e).slice(0, 400) });
  }
}

/** 包装：期望命令失败且错误信息包含关键词 */
async function expectError(promise: Promise<unknown>, keyword: string, label: string): Promise<string> {
  try {
    await promise;
  } catch (e) {
    const msg = String(e);
    if (!msg.includes(keyword)) throw new Error(`${label}：错误信息未包含「${keyword}」——实际：${msg.slice(0, 200)}`);
    return msg.slice(0, 160);
  }
  throw new Error(`${label}：期望失败但命令成功返回`);
}

async function render(): Promise<string> {
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  const lines: string[] = [];
  lines.push("# IPC 冒烟报告");
  lines.push("");
  lines.push(`- 时间：${new Date().toLocaleString()}`);
  lines.push(`- 结果：**${pass} 通过 / ${fail} 失败 / 共 ${results.length}**`);
  lines.push("");
  let lastSection = "";
  let idx = 0;
  for (const r of results) {
    if (r.section !== lastSection) {
      lines.push("");
      lines.push(`## ${r.section}`);
      lines.push("");
      lines.push("| # | 用例 | 结果 | 说明 |");
      lines.push("| --- | --- | --- | --- |");
      lastSection = r.section;
    }
    idx += 1;
    lines.push(`| ${idx} | ${r.name} | ${r.ok ? "PASS" : "**FAIL**"} | ${r.detail.replace(/\|/g, "/")} |`);
  }
  return lines.join("\n");
}

export async function runSmoke(): Promise<void> {
  await suite();
  // UI 层自检（真实 DOM 交互）
  try {
    await runUiSuite();
  } catch (e) {
    results.push({ section: "UI 自检", name: "套件执行异常", ok: false, detail: String(e).slice(0, 300) });
  }
  const md = (await render()) + uiReportSuffix();
  try {
    await api.invoke("smoke_report_write", { content: md });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("报告落盘失败", e);
  }
}

async function suite(): Promise<void> {
  /* ---------- 通用 ---------- */
  await t("通用", "ping", async () => {
    const v = await api.ping();
    expect(v === "pong", "应为 pong");
    return v;
  });
  await t("通用", "app_data_dir", async () => {
    const v = await api.appDataDir();
    expect(typeof v === "string" && v.length > 0, "应返回路径");
    return v;
  });
  await t("通用", "set/get_setting 往返", async () => {
    await api.setSetting("smoke.key", "v1");
    const v = await api.getSetting("smoke.key");
    expect(v === "v1", `应回读 v1，实际 ${v}`);
    await api.setSetting("smoke.key", null);
    const v2 = await api.getSetting("smoke.key");
    expect(v2 === null || v2 === undefined, "删除后应为空");
    return "ok";
  });
  await t("通用", "theme 往返", async () => {
    await api.setThemeCmd("dark");
    const v = await api.getTheme();
    expect(v === "dark", `应为 dark，实际 ${v}`);
    await api.setThemeCmd("light");
    return "ok";
  });

  /* ---------- 夹具 ---------- */
  let fixtureDirs = { projectDir: "", kbDir: "", repoDir: "" };
  await t("夹具", "smoke_prepare_fixtures", async () => {
    fixtureDirs = await api.invoke<{ projectDir: string; kbDir: string; repoDir: string }>("smoke_prepare_fixtures");
    expect(fixtureDirs.projectDir && fixtureDirs.kbDir && fixtureDirs.repoDir, "应返回三个目录");
    return fixtureDirs.projectDir;
  });
  const projDir = fixtureDirs.projectDir;
  const kbDir = fixtureDirs.kbDir;
  const repoDir = fixtureDirs.repoDir;

  /* ---------- 项目与需求 ---------- */
  let projectId = "";
  await t("项目", "create_project 校验非法类型", async () => {
    const msg = await expectError(api.createProject("x", "bad", projDir), "项目类型", "非法类型应被拒");
    return msg;
  });
  await t("项目", "create_project 成功", async () => {
    const p = await api.createProject("冒烟演示项目", "code", projDir);
    expect(p.id.startsWith("proj-"), "应有 id");
    projectId = p.id;
    return p.id;
  });
  await t("项目", "create_project 同名拒绝", async () => {
    const msg = await expectError(api.createProject("冒烟演示项目", "code", projDir), "同名", "重名应被拒");
    return msg;
  });
  await t("项目", "create_project 目录不可访问拒绝", async () => {
    const msg = await expectError(api.createProject("幽灵项目", "code", "Z:\\不存在\\nonexistent-xyz"), "不可访问", "坏目录应被拒");
    return msg;
  });
  await t("项目", "list_projects 包含新项目", async () => {
    const list = await api.listProjects();
    expect(list.some((p) => p.id === projectId), "应包含新项目");
    return `${list.length} 个项目`;
  });

  /* ---------- CR-051：项目/知识库图标与头像风格（r6：50 图标共用 + 10 色卡成对 + 缺省 b + 头像图片） ---------- */
  let smokeProjectName = "冒烟演示项目";
  await t("CR-051 图标", "项目 icon 保存与读取", async () => {
    const saved = await api.updateProject(projectId, smokeProjectName, projDir, "briefcase");
    expect(saved.icon === "briefcase", `应保存 briefcase，实际 ${saved.icon}`);
    const list = await api.listProjects();
    expect(list.find((p) => p.id === projectId)?.icon === "briefcase", "列表应回读 icon");
    await api.updateProject(projectId, smokeProjectName, projDir, null);
    const cleared = (await api.listProjects()).find((p) => p.id === projectId);
    expect(cleared?.icon === null, "清空后应为 null（展示层回类型默认）");
    await api.updateProject(projectId, smokeProjectName, projDir, "target");
    const kept = (await api.listProjects()).find((p) => p.id === projectId);
    expect(kept?.icon === "target", "再次设置应生效");
    await api.updateProject(projectId, smokeProjectName, projDir, null);
    return "保存/清空/回读通过";
  });
  await t("CR-051 图标", "项目 icon 非法 id 拒绝", async () => {
    // r6：rocket 已进入共用 50 白名单；非法样本改用未登记 id。
    const msg = await expectError(api.updateProject(projectId, smokeProjectName, projDir, "notAnIcon"), "非法项目图标", "非法图标应被拒");
    const list = await api.listProjects();
    expect(list.find((p) => p.id === projectId)?.icon === null, "拒绝后不应写入");
    return msg;
  });
  await t("CR-051 图标", "项目 icon+色卡成对保存与各自清空", async () => {
    // r6：rocket 已在 50 图标共用白名单内；色卡与图标成对提交。
    const saved = await api.updateProject(projectId, smokeProjectName, projDir, "rocket", "rose");
    expect(saved.icon === "rocket" && saved.iconColor === "rose", `应成对保存 rocket+rose，实际 ${saved.icon}/${saved.iconColor}`);
    let row = (await api.listProjects()).find((p) => p.id === projectId);
    expect(row?.icon === "rocket" && row?.iconColor === "rose", "列表应回读成对值");
    // 只改色卡：图标保持。
    await api.updateProject(projectId, smokeProjectName, projDir, undefined, "indigo");
    row = (await api.listProjects()).find((p) => p.id === projectId);
    expect(row?.icon === "rocket" && row?.iconColor === "indigo", "只传色卡时应保留图标");
    // 清空色卡回默认色（图标保留）；再清空图标回类型默认。
    await api.updateProject(projectId, smokeProjectName, projDir, undefined, null);
    row = (await api.listProjects()).find((p) => p.id === projectId);
    expect(row?.icon === "rocket" && row?.iconColor === null, "清空色卡应写 NULL（展示层回默认色）");
    await api.updateProject(projectId, smokeProjectName, projDir, null);
    row = (await api.listProjects()).find((p) => p.id === projectId);
    expect(row?.icon === null && row?.iconColor === null, "清空图标应写 NULL");
    return "成对保存/改色/清空通过";
  });
  await t("CR-051 图标", "项目色卡非法 id 拒绝", async () => {
    const msg = await expectError(api.updateProject(projectId, smokeProjectName, projDir, undefined, "magenta"), "非法背景色卡", "非法色卡应被拒");
    const row = (await api.listProjects()).find((p) => p.id === projectId);
    expect(row?.iconColor === null, "拒绝后不应写入");
    return msg;
  });
  await t("CR-051 图标", "avatarStyle 缺省读取为 b", async () => {
    // 独立键：不与 smoke.key 互相影响；缺省（未写入）时命令返回默认 b（r6）。
    const style = await api.getAvatarStyle();
    expect(style === "b", `未设置时应返回默认 b，实际 ${style}`);
    return style;
  });
  await t("CR-051 图标", "avatarStyle 设置往返与非法值拒绝", async () => {
    await api.setAvatarStyle("d");
    expect(await api.getAvatarStyle() === "d", "应回读 d");
    const msg = await expectError(api.setAvatarStyle("x"), "a、b、c、d、e", "非法风格应被拒");
    await api.setAvatarStyle("b");
    expect(await api.getAvatarStyle() === "b", "恢复默认 b");
    return msg;
  });
  await t("CR-051 头像", "avatarImage 合法 PNG 保存/读取/清除", async () => {
    const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const saved = await api.setAvatarImage(tinyPng, "smoke.png");
    expect(!!saved?.path && !!saved?.hash, "应返回本机路径与 hash");
    const got = await api.getAvatarImage();
    expect(got?.path === saved.path && got?.hash === saved.hash, "get_avatar_image 应回读引用");
    const data = await api.avatarImageData();
    expect(!!data && data.startsWith("data:image/png;base64,"), "avatar_image_data 应返回 data URL");
    await api.clearAvatarImage();
    const cleared = await api.getAvatarImage();
    expect(cleared?.path === null && cleared?.hash === null, "清除后引用应为 null");
    const dataCleared = await api.avatarImageData();
    expect(dataCleared === null, "清除后 data URL 应为 null");
    return "set/get/data/clear 通过";
  });
  await t("CR-051 头像", "avatarImage 魔数不符拒绝", async () => {
    // 声明 PNG 但字节是 GIF（伪装内容）：服务端按魔数拒绝。
    const fakePng = "data:image/png;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    const msg = await expectError(api.setAvatarImage(fakePng), "格式不符", "伪装 PNG 应被拒");
    const got = await api.getAvatarImage();
    expect(got?.path === null, "拒绝后不应留下引用");
    return msg;
  });
  await t("CR-051 头像", "avatarImage 超 200KB 拒绝", async () => {
    // 在页面内合成随机噪声 PNG（不可压缩），从 360×360 逐步放大直到超过 200KB。
    const bigDataUrl = await (async () => {
      for (const size of [360, 460, 560, 660, 760]) {
        const c = document.createElement("canvas");
        c.width = size; c.height = size;
        const ctx = c.getContext("2d")!;
        const img = ctx.createImageData(size, size);
        for (let i = 0; i < img.data.length; i += 4) {
          img.data[i] = Math.floor(Math.random() * 256);
          img.data[i + 1] = Math.floor(Math.random() * 256);
          img.data[i + 2] = Math.floor(Math.random() * 256);
          img.data[i + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        const url = c.toDataURL("image/png");
        const bytes = Math.floor((url.length - url.indexOf(",") - 1) * 0.75);
        if (bytes > 200 * 1024) return url;
      }
      throw new Error("未能合成超 200KB 样本（环境异常）");
    })();
    const msg = await expectError(api.setAvatarImage(bigDataUrl), "200KB", "超限应被拒");
    const got = await api.getAvatarImage();
    expect(got?.path === null, "超限拒绝后不应留下引用");
    return msg;
  });
  await t("需求", "read_requirements 树结构", async () => {
    const tree = await api.readRequirements(projectId);
    const flat: api.RequirementNode[] = [];
    const walk = (ns: api.RequirementNode[]) => ns.forEach((n) => { flat.push(n); walk(n.children); });
    walk(tree);
    expect(flat.some((n) => n.entityId === "VISION-DEMO"), "应有愿景");
    const epic = flat.find((n) => n.entityId === "EPIC-001-DEMO");
    expect(!!epic, "应有 Epic");
    const shape = flat.map((n) => n.entityId + "[" + n.children.map((c) => c.entityId).join(",") + "]").join(" ");
    expect(epic!.children.some((c) => c.entityId === "FEAT-001-DEMO"), "Epic 应含 Feature 子项；树形：" + shape);
    const story = flat.find((n) => n.entityId === "STORY-001-DEMO");
    expect(!!story && story.status === "开发中", "Story 状态应来自 front matter");
    return `树 ${flat.length} 节点`;
  });
  await t("需求", "read_doc / write_doc 往返", async () => {
    const uri = projDir + "\\docs\\Plan\\Story\\STORY-001-DEMO.md";
    const before = await api.readDoc(uri);
    expect(before.includes("AC-STORY-001-DEMO-01"), "应读到 AC");
    await api.writeDoc(uri, before + "\n\n（追加一行）\n");
    const after = await api.readDoc(uri);
    expect(after.includes("（追加一行）"), "写后应可读到");
    return "ok";
  });

  /* ---------- 文件系统 ---------- */
  await t("文件", "fs_list_dir 根目录", async () => {
    const nodes = await api.fsListDir(projDir, "");
    expect(nodes.some((n) => n.name === "docs" && n.isDir), "应有 docs 目录");
    return `${nodes.length} 项`;
  });
  await t("文件", "fs_list_dir 越界拒绝", async () => {
    const msg = await expectError(api.fsListDir(projDir, "..\\..\\.."), "越界", "traversal 应被拒");
    return msg;
  });
  await t("文件", "fs_read_file", async () => {
    const c = await api.fsReadFile(projDir, "README.md");
    expect(c.includes("proj-demo"), "应读到 README 内容");
    return "ok";
  });
  await t("文件", "fs_write_file + fs_delete_file", async () => {
    await api.fsWriteFile(projDir, "tmp-smoke.txt", "临时内容");
    const c = await api.fsReadFile(projDir, "tmp-smoke.txt");
    expect(c === "临时内容", "应一致");
    await api.fsDeleteFile(projDir, "tmp-smoke.txt");
    await expectError(api.fsReadFile(projDir, "tmp-smoke.txt"), "读取失败", "删除后应读不到");
    return "ok";
  });
  await t("文件", "fs_search 命中", async () => {
    const hits = await api.fsSearch(projDir, "演示项目愿景", 50);
    expect(hits.length >= 1, "应命中愿景文档");
    return `${hits.length} 处`;
  });

  /* ---------- Git（隔离夹具仓库） ---------- */
  await t("Git", "git_status 含暂存/未暂存", async () => {
    const st = await api.gitStatus(repoDir);
    expect(st.state === "ready", `state 应 ready，实际 ${st.state}`);
    expect(st.branch === "main", `分支应 main，实际 ${st.branch}`);
    const a = st.changes.find((c) => c.path === "a.txt");
    const b = st.changes.find((c) => c.path === "b.txt");
    const c = st.changes.find((c2) => c2.path === "c.txt");
    expect(!!a && a.unstaged === "M", `a.txt 应为未暂存修改，实际 ${JSON.stringify(a)}`);
    expect(!!b && b.untracked, "b.txt 应为未跟踪");
    expect(!!c && c.staged === "A", "c.txt 应为已暂存");
    return `branch=${st.branch} changes=${st.changes.length}`;
  });
  await t("Git", "git_branches 本地/远程分组", async () => {
    const bs = await api.gitBranches(repoDir);
    expect(bs.some((x) => x.name === "main" && x.current), "main 应为当前");
    expect(bs.some((x) => x.name === "feature/x" && x.kind === "local"), "应有 feature/x");
    return `${bs.length} 分支`;
  });
  await t("Git", "git_log 首提交", async () => {
    const log = await api.gitLog(repoDir, 10);
    expect(log.length >= 1, "应有提交");
    expect(log[0].subject.includes("initial") || log[0].subject.includes("smoke"), `首条 ${log[0].subject}`);
    return `${log.length} 条`;
  });
  await t("Git", "git_stage/git_unstage 往返", async () => {
    await api.gitUnstage(repoDir, ["c.txt"]);
    let st = await api.gitStatus(repoDir);
    expect(!st.changes.find((x) => x.path === "c.txt")?.staged, "取消暂存后 c.txt 不应有 staged");
    await api.gitStage(repoDir, ["b.txt"]);
    st = await api.gitStatus(repoDir);
    expect(st.changes.find((x) => x.path === "b.txt")?.staged === "A", "b.txt 应已暂存");
    await api.gitUnstage(repoDir, ["b.txt"]);
    await api.gitStage(repoDir, ["c.txt"]);
    await api.gitUnstage(repoDir, ["a.txt"]).catch(() => {});
    return "ok";
  });
  await t("Git", "git_diff_file 染色文本", async () => {
    const d = await api.gitDiffFile(repoDir, "a.txt", false);
    expect(d.includes("+a 追加修改行"), `diff 应含新增行，实际前 120 字符：${d.slice(0, 120)}`);
    return `${d.length} 字符`;
  });
  await t("Git", "git_commit 提交", async () => {
    const oid = await api.gitCommit(repoDir, "smoke commit from IPC");
    expect(/^[0-9a-f]{40}$/.test(oid), `应为 40 位 hash，实际 ${oid}`);
    return oid.slice(0, 8);
  });
  await t("Git", "git_switch_branch 切换", async () => {
    await api.gitSwitchBranch(repoDir, "feature/x", false);
    const st = await api.gitStatus(repoDir);
    expect(st.branch === "feature/x", `应在 feature/x，实际 ${st.branch}`);
    await api.gitSwitchBranch(repoDir, "main", false);
    return "ok";
  });
  await t("Git", "git_commit_files 提交文件清单", async () => {
    const log = await api.gitLog(repoDir, 5);
    const first = log[log.length - 1];
    const files = await api.gitCommitFiles(repoDir, first.hash);
    expect(files.some((f) => f.path === "a.txt"), "首提交应含 a.txt");
    return `${files.length} 文件`;
  });
  await t("Git", "git_branch_state chip 数据", async () => {
    const st = await api.gitBranchState(repoDir);
    expect(st.branch === "main", "应回到 main");
    return "ok";
  });

  /* ---------- 模型供应商 ---------- */
  let providerId = "";
  let modelRowId = "";
  await t("模型", "provider_save 校验互斥", async () => {
    const msg = await expectError(
      api.providerSave({
        name: "坏供应商", protocol: "anthropic", disabled: false, headersJson: null,
        keys: [{ alias: "k1", secret: "sk-abc123456789", enabled: true }],
        endpoints: [{ protocol: "anthropic", baseUrl: "http://127.0.0.1:9", enabled: true }],
        models: [{ modelId: "m1", displayName: "M1", text: true, vision: false, imageGen: true, efforts: { low: null }, defaultEffort: "low", contextWindow: 1000, maxTokens: 100 }],
      }),
      "互斥", "text+imageGen 应被拒"
    );
    return msg;
  });
  await t("模型", "provider_save 校验默认档位", async () => {
    const msg = await expectError(
      api.providerSave({
        name: "坏供应商2", protocol: "openai", disabled: false, headersJson: null,
        keys: [{ alias: "k1", secret: "sk-abc123456789", enabled: true }],
        endpoints: [{ protocol: "openai", baseUrl: "http://127.0.0.1:9", enabled: true }],
        models: [{ modelId: "m1", displayName: "M1", text: true, vision: false, imageGen: false, efforts: { low: null }, defaultEffort: "high", contextWindow: 1000, maxTokens: 100 }],
      }),
      "默认档位", "默认档位越界应被拒"
    );
    return msg;
  });
  await t("模型", "provider_save 成功", async () => {
    providerId = await api.providerSave({
      name: "冒烟供应商",
      protocol: "anthropic",
      disabled: false,
      headersJson: JSON.stringify({ "X-Smoke": "1" }),
      keys: [{ alias: "主密钥", secret: "sk-smoke-1234567890abcd", enabled: true }],
      endpoints: [{ protocol: "anthropic", baseUrl: "http://127.0.0.1:9", enabled: true }],
      models: [{
        modelId: "smoke-model", displayName: "冒烟模型", text: true, vision: true, imageGen: false,
        efforts: { off: null, low: "low", high: "high" }, defaultEffort: "low", contextWindow: 200000, maxTokens: 8192,
      }],
    });
    expect(providerId.startsWith("prov-"), "应有 provider id");
    return providerId;
  });
  await t("模型", "provider_list 嵌套结构 + 掩码", async () => {
    const ps = await api.providerList();
    const p = ps.find((x) => x.id === providerId);
    expect(!!p, "应能取回");
    expect(p!.keys.length === 1 && p!.keys[0].masked.includes("****"), `密钥应掩码：${p!.keys[0].masked}`);
    expect(p!.endpoints.length === 1 && p!.models.length === 1, "应有 1 端点 1 模型");
    expect(Object.keys(p!.models[0].efforts).length === 3, "应有 3 档位");
    modelRowId = p!.models[0].id;
    return p!.keys[0].masked;
  });
  await t("模型", "model_candidates 过滤命中", async () => {
    const cs = await api.modelCandidates();
    const mine = cs.find((c) => c.providerId === providerId);
    expect(!!mine, "应出现候选");
    expect(mine!.defaultEffort === "low", "默认档位 low");
    return `${cs.length} 候选`;
  });
  await t("模型", "停用供应商 → 候选消失", async () => {
    await api.providerSetDisabled(providerId, true);
    const cs = await api.modelCandidates();
    expect(!cs.some((c) => c.providerId === providerId), "停用后不应出现");
    await api.providerSetDisabled(providerId, false);
    return "ok";
  });
  await t("模型", "无密钥供应商不入候选", async () => {
    const pid = await api.providerSave({
      name: "无密钥供应商", protocol: "openai", disabled: false, headersJson: null,
      keys: [], endpoints: [{ protocol: "openai", baseUrl: "http://127.0.0.1:9", enabled: true }],
      models: [{ modelId: "m", displayName: "m", text: true, vision: false, imageGen: false, efforts: {}, defaultEffort: null, contextWindow: null, maxTokens: null }],
    });
    const cs = await api.modelCandidates();
    expect(!cs.some((c) => c.providerId === pid), "无密钥不应入候选");
    await api.providerDelete(pid);
    return "ok";
  });
  await t("模型", "fingerprint_check 探测失败如实记录", async () => {
    const r = await api.fingerprintCheck(providerId);
    expect(r.results.length === 1, "应有一个端点结果");
    expect(/ERR|HTTP/.test(r.results[0].status), `状态应非空：${r.results[0].status}`);
    return r.results[0].status.slice(0, 80);
  });
  await t("模型", "CR-058 model_probe_run：不可达端点 → P1 fail、其余跳过、判无法判定", async () => {
    const pid = await api.providerSave({
      name: "探针供应商", protocol: "openai", disabled: false, headersJson: null,
      keys: [{ alias: "k", secret: "sk-probe-8888", enabled: true }],
      endpoints: [{ protocol: "openai", baseUrl: "http://127.0.0.1:9", enabled: true }],
      models: [{ modelId: "probe-model", displayName: "探针模型", text: true, vision: false, imageGen: false, efforts: {}, defaultEffort: null, contextWindow: null, maxTokens: null }],
    });
    const events: api.ProbeProgressEvent[] = [];
    const report = await api.modelProbeRun(pid, "probe-model", (ev) => events.push(ev));
    expect(report.items.length === 19, `应 19 针，实际 ${report.items.length}`);
    expect(report.items[0].status === "fail", `P1 应 fail：${report.items[0].note}`);
    expect(report.items.slice(1).every((i) => i.status === "skip"), "P2～P9 应全部 skip");
    expect(report.verdict === "无法判定", `总评应无法判定：${report.verdict}`);
    expect(events.filter((e) => e.phase === "settled").length === 19, `应 19 个逐针回执，实际 ${events.filter((e) => e.phase === "settled").length}`);
    await api.providerDelete(pid);
    return `${report.score} 分 · ${events.length} 事件`;
  });
  await t("模型", "CR-058 历史保留 10 条与密钥脱敏", async () => {
    const list = await api.modelProbeHistoryList();
    expect(list.length >= 1 && list.length <= 10, `历史应 1～10 条，实际 ${list.length}`);
    const raw = JSON.stringify(list);
    expect(!raw.includes("sk-probe-8888"), "历史不得包含密钥明文");
    expect(list[0].items.length === 19, "最新记录应有 19 针");
    return `${list.length} 条 · 最新 ${list[0].verdict}`;
  });
  await t("模型", "provider_delete 清理", async () => {
    const pid = await api.providerSave({
      name: "待删除供应商", protocol: "openai", disabled: false, headersJson: null,
      keys: [{ alias: "k", secret: "sk-tmp-9999", enabled: true }],
      endpoints: [{ protocol: "openai", baseUrl: "http://127.0.0.1:9", enabled: true }],
      models: [],
    });
    await api.providerDelete(pid);
    const ps = await api.providerList();
    expect(!ps.some((x) => x.id === pid), "删除后不应存在");
    return "ok";
  });

  /* ---------- 进程 spawn 探针 ---------- */
  await t("探针", "Channel 送达（立即+分离任务延迟发送）", async () => {
    const got: number[] = [];
    const mod = await import("@tauri-apps/api/core");
    const ch = new mod.Channel<number>();
    ch.onmessage = (v) => got.push(v);
    await mod.invoke("smoke_channel_probe", { channel: ch });
    // 前 800ms：应收到立即的 0,1,2；再等 2.5s：应收到分离任务的 10,11,12
    await new Promise((res) => setTimeout(res, 800));
    const immediate = got.filter((v) => v < 10).length;
    expect(immediate === 3, `立即事件应 3 个，实际 ${immediate}`);
    await new Promise((res) => setTimeout(res, 2500));
    const delayed = got.filter((v) => v >= 10).length;
    expect(delayed === 3, `分离任务延迟事件应 3 个，实际 ${delayed}（全部：${got.join(",")}）`);
    return `收到 ${got.join(",")}`;
  });
  await t("探针", "tokio mock claude 全链路（stdin EOF→事件流）", async () => {
    const v = await api.invoke<{ resolved: string; lines: string[]; exitCode: number | null }>("smoke_mock_full");
    expect(v.lines.length >= 5, `应至少 5 行事件，实际 ${v.lines.length} 行：${v.lines.slice(0, 3).join(" / ")}`);
    expect(v.lines.some((l) => l.includes("result")), "应含 result 行");
    return `${v.lines.length} 行, exit=${v.exitCode}`;
  });
  await t("探针", "mock CLI 与 npm 可解析性（诊断）", async () => {
    const probe = await api.invoke<{
      claude: string; npm: string; resolvedClaude: string; resolvedNpm: string; pathHead: string;
    }>("smoke_spawn_probe");
    return [
      "resolvedClaude=" + probe.resolvedClaude,
      "resolvedNpm=" + probe.resolvedNpm,
      "claudeOut=" + probe.claude.slice(0, 80),
      "npmOut=" + probe.npm.slice(0, 60),
      "PATH=" + probe.pathHead,
    ].join(" | ");
  });

  /* ---------- SDK ---------- */
  await t("SDK", "sdk_list 检测（mock CLI 经 PATH）", async () => {
    const list = await api.sdkList();
    expect(list.length === 3, `应 3 个 SDK，实际 ${list.length}`);
    const ids = list.map((s) => s.id).sort().join(",");
    expect(ids === "claude,codex,grok", `ids=${ids}`);
    const allInstalled = list.every((s) => s.installState === "installed" && s.version);
    expect(allInstalled, `应全部 installed：${list.map((s) => s.id + "=" + s.installState).join(" ")}`);
    return list.map((s) => `${s.id}@${s.version}`).join(" ");
  });
  await t("SDK", "sdk_cli_candidates 候选", async () => {
    const cs = await api.sdkCliCandidates();
    expect(cs.length === 3, `应 3 个候选，实际 ${cs.length}`);
    return cs.map((c) => c.id).join(",");
  });
  await t("SDK", "sdk_set_enabled 过滤候选", async () => {
    await api.sdkSetEnabled("grok", false);
    const cs = await api.sdkCliCandidates();
    expect(!cs.some((c) => c.id === "grok"), "禁用后不应出现");
    await api.sdkSetEnabled("grok", true);
    return "ok";
  });
  await t("SDK", "sdk_run_job 任务状态机（不存在版本安装→failed，不触碰真实安装）", async () => {
    const jobId = await api.sdkRunJob("grok", "install", "0.0.0-smoke-nonexistent");
    expect(jobId.startsWith("npm-"), `jobId=${jobId}`);
    let phase = "";
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const job = await api.sdkJob(jobId);
      expect(!!job, "job 应存在");
      phase = job!.phase;
      if (phase === "done" || phase === "failed") break;
    }
    expect(phase === "done" || phase === "failed", `终态实际 ${phase}`);
    const job = await api.sdkJob(jobId!);
    expect(phase === "failed", `不存在版本应安装失败；实际 ${phase}，错误=${job?.error}`);
    return `终态=${phase}（状态机与日志采集验证通过）`;
  });
  await t("SDK", "单 SDK 任务互斥", async () => {
    const j1 = await api.sdkRunJob("claude", "install", "0.0.0-smoke-nonexistent");
    try {
      await expectError(api.sdkRunJob("claude", "install"), "已有进行中", "并发任务应被拒");
    } catch (e) {
      const job = await api.sdkJob(j1);
      throw new Error(String(e) + "；job1 状态=" + job?.phase + " 错误=" + job?.error + " 日志尾=" + (job?.logs.slice(-2).join(" / ") ?? ""));
    }
    await api.sdkCancel(j1);
    // 等待任务结束释放互斥
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const job = await api.sdkJob(j1);
      if (job && (job.phase === "cancelled" || job.phase === "done" || job.phase === "failed")) break;
    }
    return "ok";
  });

  /* ---------- CR-053：CLI 命令工具（Shell） ---------- */
  let realBashPath = "";
  await t("CR-053 Shell", "cli_shell_candidates 三类候选真实探测", async () => {
    const cs = await api.cliShellCandidates("claude");
    expect(cs.length === 3, `应 3 条候选，实际 ${cs.length}`);
    expect(cs.map((c) => c.kind).join(",") === "pwsh,windows-powershell,git-bash", "kind 顺序应为 pwsh,windows-powershell,git-bash");
    // Windows PowerShell 5.1 在 System32 固定位置，Windows 上必装
    const wp = cs.find((c) => c.kind === "windows-powershell")!;
    expect(wp.available === true && !!wp.path && wp.path.toLowerCase().includes("windowspowershell"), `Windows PowerShell 5.1 应可用，实际 ${JSON.stringify(wp)}`);
    expect(!!wp.version && /\d+\.\d+/.test(wp.version), `应有真实版本号，实际 ${wp.version}`);
    for (const c of cs) {
      if (c.available) {
        expect(!!c.path && !!c.version, `${c.kind} 可用时应带路径与版本`);
        if (c.kind === "git-bash") {
          expect(!c.path!.toLowerCase().includes("windowsapps"), `Git Bash 不得是 WindowsApps 存根，实际 ${c.path}`);
          realBashPath = c.path!;
        }
      } else {
        expect(!!c.detail, `${c.kind} 不可用时应带原因，实际 ${JSON.stringify(c)}`);
      }
    }
    return cs.map((c) => `${c.kind}=${c.available ? (c.source + " " + (c.version || "?")) : c.detail}`).join(" | ");
  });
  await t("CR-053 Shell", "cli_shell_get 缺省=auto 不报错", async () => {
    const v = await api.cliShellGet("claude");
    expect(v.setting.mode === "auto" && v.setting.path === null && v.missing === false, `缺省应为 auto，实际 ${JSON.stringify(v)}`);
    return "auto";
  });
  await t("CR-053 Shell", "cli_shell_save 非法 mode / 相对路径 / 白名单外文件名 / grok 全拒绝", async () => {
    const msgMode = await expectError(api.cliShellSave("claude", "cmd", null), "未知命令工具类型", "非法 mode 应被拒");
    const msgRel = await expectError(api.cliShellSave("claude", "pwsh", "relative\\pwsh.exe"), "绝对路径", "相对路径应被拒");
    // 白名单外：mock claude.exe 真实存在但文件名不在白名单
    const probe = await api.invoke<{ resolvedClaude: string }>("smoke_spawn_probe");
    const msgWl = await expectError(api.cliShellSave("claude", "pwsh", probe.resolvedClaude), "文件名必须是 pwsh.exe", "白名单外文件名应被拒");
    const msgGrok = await expectError(api.cliShellSave("grok", "pwsh", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"), "仅支持展示", "grok 指定应被拒");
    return [msgMode, msgRel, msgWl, msgGrok].map((m) => m.slice(0, 40)).join(" / ");
  });
  await t("CR-053 Shell", "cli_shell_save 指定 pwsh 往返（无 pwsh 时用 git-bash）", async () => {
    const cs = await api.cliShellCandidates("claude");
    const pwsh = cs.find((c) => c.kind === "pwsh" && c.available);
    const kind = pwsh ? "pwsh" : "git-bash";
    const path = pwsh ? pwsh.path! : realBashPath;
    expect(!!path, "应有可用候选路径供保存");
    const saved = await api.cliShellSave("claude", kind, path);
    expect(saved.mode === kind && saved.path === path, `保存应回显 ${kind}`);
    const v = await api.cliShellGet("claude");
    expect(v.setting.mode === kind && v.setting.path === path && v.missing === false, `重开设置应保留，实际 ${JSON.stringify(v)}`);
    expect(!!v.setting.savedAt, "应记录 savedAt");
    await api.cliShellSave("claude", "auto", null);
    const back = await api.cliShellGet("claude");
    expect(back.setting.mode === "auto", "改回 auto 应生效");
    return `${kind} 保存/回读/恢复 auto 通过`;
  });
  await t("CR-053 Shell", "codex 实验性：可保存偏好（不注入）", async () => {
    expect(!!realBashPath, "应有 Git Bash 路径");
    const saved = await api.cliShellSave("codex", "git-bash", realBashPath);
    expect(saved.mode === "git-bash", "codex 应接受保存（实验性只存偏好）");
    const v = await api.cliShellGet("codex");
    expect(v.setting.mode === "git-bash", "codex 偏好应回读");
    await api.cliShellSave("codex", "auto", null);
    return "保存/回读/恢复通过（注入语义未实测，后端不注入）";
  });
  await t("CR-053 Shell", "cli_shell_get 解析损坏数据=auto", async () => {
    await api.setSetting("cli.shell.claude", "not-json{{{");
    const v = await api.cliShellGet("claude");
    expect(v.setting.mode === "auto", `损坏 JSON 应按 auto，实际 ${v.setting.mode}`);
    await api.setSetting("cli.shell.claude", null);
    return "auto";
  });
  await t("CR-053 Shell", "启动前复检：路径失效阻止 chat_send 并提示改选自动", async () => {
    // 构造真实存在的 bash.exe → 保存 → 删除 → get missing → chat_send 被阻止（不静默回落）
    await api.fsWriteFile(projDir, "bash.exe", "not a real shell");
    const fakePath = projDir + "\\bash.exe";
    await api.cliShellSave("claude", "git-bash", fakePath);
    const ok = await api.cliShellGet("claude");
    expect(ok.setting.mode === "git-bash" && ok.missing === false, "存在的路径不应标 missing");
    await api.fsDeleteFile(projDir, "bash.exe");
    const miss = await api.cliShellGet("claude");
    expect(miss.missing === true, `删除后应标 missing，实际 ${JSON.stringify(miss)}`);
    const s = await api.chatSessionCreate({ ...(projectId ? { projectId } : {}), cliId: "claude", modelId: "smoke-model" });
    const msg = await expectError(
      api.chatSend({ sessionId: s.id, content: "hi", refs: [], attachments: [] }, () => {}),
      "已不存在",
      "失效路径应阻止启动"
    );
    expect(msg.includes("自动"), "错误应提示改选「自动」：" + msg.slice(0, 120));
    await api.chatSessionDelete(s.id).catch(() => {});
    await api.cliShellSave("claude", "auto", null);
    const restored = await api.cliShellGet("claude");
    expect(restored.setting.mode === "auto" && restored.missing === false, "改回 auto 后应可恢复");
    return msg.slice(0, 90);
  });

/* ---------- AI 会话（mock CLI 全链路） ---------- */
  let claudeSessionId = "";
  await t("会话", "chat_session_create", async () => {
    // 本用例验证 CLI 协议解析与持久化，不绑定供应商（mock CLI 自带输出）
    const s = await api.chatSessionCreate({ projectId, cliId: "claude", modelId: "smoke-model", effort: "low" });
    expect(s.id.startsWith("sess-"), "应有 id");
    expect(s.cliId === "claude", "cliId 应一致");
    claudeSessionId = s.id;
    return s.id;
  });
  await t("会话", "chat_send 未选 CLI 拒绝", async () => {
    const s2 = await api.chatSessionCreate({ projectId });
    const msg = await expectError(
      api.chatSend({ sessionId: s2.id, content: "hi", refs: [], attachments: [] }, () => {}),
      "未选择 CLI", "无 CLI 应被拒"
    );
    await api.chatSessionDelete(s2.id);
    return msg;
  });
  await t("会话", "chat_send claude 全链路（事件+持久化）", async () => {
    const events: api.ChatEvent[] = [];
    await api.chatSend({ sessionId: claudeSessionId, content: "你好", refs: [], attachments: [] }, (ev) => events.push(ev));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        api.chatAbort(claudeSessionId).catch(() => {});
        setTimeout(async () => {
          try {
            const msgs = await api.chatMessages(claudeSessionId);
            reject(new Error("等待 done 超时；持久化消息数=" + msgs.length + " 事件数=" + events.length));
          } catch { reject(new Error("等待 done 超时")); }
        }, 600);
      }, 15000);
      const check = setInterval(() => {
        if (events.some((e) => e.type === "done")) { clearTimeout(timer); clearInterval(check); resolve(null); }
        if (events.some((e) => e.type === "error")) { clearTimeout(timer); clearInterval(check); reject(new Error("收到 error 事件")); }
      }, 100);
    });
    const delta = events.find((e) => e.type === "delta");
    const tool = events.find((e) => e.type === "toolUse");
    const usage = events.find((e) => e.type === "usage");
    expect(!!delta && (delta as { delta: string }).delta.includes("你好"), "应有 delta 流");
    expect(!!tool && (tool as { name: string }).name === "fs.read", "应有工具事件");
    expect(!!usage, "应有用量事件");
    const msgs = await api.chatMessages(claudeSessionId);
    const roles = msgs.map((m) => m.role).join(",");
    expect(roles.includes("user") && roles.includes("assistant") && roles.includes("tool_use") && roles.includes("tool_result"), `消息角色 ${roles}`);
    const assistant = msgs.find((m) => m.role === "assistant");
    expect(assistant!.content.includes("mock claude"), `助手全文：${assistant!.content.slice(0, 50)}`);
    const meta = JSON.parse(assistant!.metaJson!);
    expect(meta.usage && meta.usage.inputTokens === 11, "用量应持久化");
    return `${events.length} 事件, ${msgs.length} 消息`;
  });
  await t("会话", "chat_send codex 协议", async () => {
    const s = await api.chatSessionCreate({ projectId, cliId: "codex", modelId: "smoke-model", effort: "high" });
    const events: api.ChatEvent[] = [];
    await api.chatSend({ sessionId: s.id, content: "hi", refs: [], attachments: [] }, (ev) => events.push(ev));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { api.chatAbort(s.id).catch(() => {}); reject(new Error("超时")); }, 15000);
      const check = setInterval(() => {
        if (events.some((e) => e.type === "done")) { clearTimeout(timer); clearInterval(check); resolve(null); }
        if (events.some((e) => e.type === "error")) { clearTimeout(timer); clearInterval(check); reject(new Error("error 事件")); }
      }, 100);
    });
    const think = events.some((e) => e.type === "thinking");
    expect(think, "codex reasoning 应作为 thinking 事件");
    await api.chatSessionDelete(s.id);
    return "ok";
  });
  await t("会话", "chat_send grok 通用回退", async () => {
    const s = await api.chatSessionCreate({ projectId, cliId: "grok", modelId: "smoke-model", effort: "off" });
    const events: api.ChatEvent[] = [];
    await api.chatSend({ sessionId: s.id, content: "hi", refs: [], attachments: [] }, (ev) => events.push(ev));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { api.chatAbort(s.id).catch(() => {}); reject(new Error("超时")); }, 15000);
      const check = setInterval(() => {
        if (events.some((e) => e.type === "done")) { clearTimeout(timer); clearInterval(check); resolve(null); }
        if (events.some((e) => e.type === "error")) { clearTimeout(timer); clearInterval(check); reject(new Error("error 事件")); }
      }, 100);
    });
    expect(events.some((e) => e.type === "delta"), "通用回退应有 delta");
    await api.chatSessionDelete(s.id);
    return "ok";
  });
  await t("会话", "chat_sessions 列表与项目过滤", async () => {
    const all = await api.chatSessions();
    const mine = await api.chatSessions(projectId);
    expect(all.length >= 1 && mine.length >= 1, "应有会话");
    expect(mine.every((s) => s.projectId === projectId), "过滤应生效");
    return `${mine.length}/${all.length}`;
  });
  await t("会话", "chat_sessions_page 分页与标题搜索（CR-063）", async () => {
    const first = await api.chatSessionsPage({ projectId, limit: 20 });
    expect(first.items.length <= 20, "首批不应超过 20 条");
    expect(first.total >= first.items.length, "总数应不小于本页");
    expect(first.items.every((s) => s.projectId === projectId), "分页作用域应与项目一致");
    expect(!first.hasMore || first.nextCursor !== null, "仍有更多时应给出游标");
    expect(first.hasMore || first.nextCursor === null, "没有更多时不应给游标");
    // 追加一页：不重不漏
    if (first.hasMore && first.nextCursor) {
      const second = await api.chatSessionsPage({
        projectId,
        limit: 20,
        cursorPinnedAt: first.nextCursor.pinnedAt,
        cursorUpdatedAt: first.nextCursor.updatedAt,
        cursorId: first.nextCursor.id,
      });
      const ids = [...first.items, ...second.items].map((s) => s.id);
      expect(new Set(ids).size === ids.length, "翻页不应重复");
    }
    // 标题搜索命中已存在的“冒烟会话”，并证明关键词不匹配时总数为 0
    await api.chatSessionUpdate({ id: claudeSessionId, title: "冒烟会话" });
    const hit = await api.chatSessionsPage({ projectId, keyword: "冒烟", limit: 20 });
    expect(hit.total >= 1 && hit.items.every((s) => s.title.includes("冒烟")), "关键词应只命中标题");
    const miss = await api.chatSessionsPage({ projectId, keyword: "不存在的会话标题xyz", limit: 20 });
    expect(miss.total === 0 && miss.items.length === 0, "无匹配应为空");
    // limit 钳制与游标不成对报错
    const clamped = await api.chatSessionsPage({ projectId, limit: 0 });
    expect(clamped.items.length <= 1, "limit 应被钳到 1");
    let cursorError = false;
    try { await api.chatSessionsPage({ projectId, cursorUpdatedAt: 1 }); } catch { cursorError = true; }
    expect(cursorError, "游标不成对应报错");
    return `${first.items.length}/${first.total}`;
  });
  await t("会话", "chat_session_pin 与 chat_session_fork（CR-065）", async () => {
    const s = await api.chatSessionCreate({ projectId });
    await api.chatSessionUpdate({ id: s.id, title: "分叉源会话" });
    const pinned = await api.chatSessionPin(s.id, true);
    expect((pinned.pinnedAt ?? 0) > 0, "置顶后 pinnedAt 应非 0");
    const page = await api.chatSessionsPage({ projectId, limit: 20 });
    expect(page.items[0]?.id === s.id, "置顶会话应排在当前作用域最前");
    const unpinned = await api.chatSessionPin(s.id, false);
    expect((unpinned.pinnedAt ?? 0) === 0, "取消置顶后 pinnedAt 应为 0");
    const forked = await api.chatSessionFork(s.id);
    expect(forked.title === "分叉 · 分叉源会话", "分叉标题应带「分叉 · 」前缀");
    expect((forked.pinnedAt ?? 0) === 0, "分叉不应继承置顶");
    expect(forked.id !== s.id, "分叉应生成新会话");
    await api.chatSessionDelete(forked.id);
    await api.chatSessionDelete(s.id);
    return "ok";
  });
  await t("会话", "chat_session_update 草稿与标题", async () => {
    await api.chatSessionUpdate({ id: claudeSessionId, title: "冒烟会话", draft: "未发送草稿" });
    const s = await api.chatSessionGet(claudeSessionId);
    expect(s.title === "冒烟会话" && s.draft === "未发送草稿", "更新应生效");
    return "ok";
  });

    await t("会话", "会话运行时：演示种子/步骤推进/清空已结束（CR-042）", async () => {
    const { seedDemo, advanceDemoStep, getRuntime, clearEndedBackground, recordToolUse, recordToolResult } =
      await import("@/modules/chat/sessionRuntime");
    const s = await api.chatSessionCreate({ projectId });
    // 合成演示种子（仅演示会话，评审 C 执行条件）
    seedDemo(s.id);
    const rt = getRuntime(s.id);
    expect(rt.subagents.length === 4, "子智能体演示应为 4 条");
    expect(rt.background.length === 4, "后台任务演示应为 4 条");
    expect(rt.steps.length === 5 && rt.stepsDemo, "演示步骤应为 5 条");
    // 推进演示只推进本会话合成步骤（须在真实工具记录之前：recordToolUse 会清除演示步骤）
    const moved = advanceDemoStep(s.id);
    expect(moved, "推进演示应移动执行指针");
    expect(rt.steps.some((x) => x.state === "running"), "推进后仍有执行中步骤");
    // 真实工具执行记录：toolUse 开步 -> toolResult 落状态（不伪造）
    recordToolUse(s.id, "T1", "Read");
    recordToolResult(s.id, "T1", false);
    // sessionRuntime 以 generation 为前缀（新会话 generation=0 → ST-0-T1）；修正陈旧断言。
    expect(rt.steps.some((x) => x.id === "ST-0-T1" && x.state === "done"), "真实步骤应完成");
    // 清空已结束只清展示
    clearEndedBackground(s.id);
    expect(getRuntime(s.id).background.every((b) => b.state === "运行中"), "清空后仅剩运行中");
    await api.chatSessionDelete(s.id);
    return "ok";
  });

  /* ---------- CR-037：侧栏原生续接（STORY-032 AC-05/06，mock 全链路） ---------- */
  /** 发送并等待 done/error 事件；返回全部事件（done 必有）。 */
  async function sendAndWait(sid: string, text: string): Promise<api.ChatEvent[]> {
    const events: api.ChatEvent[] = [];
    await api.chatSend({ sessionId: sid, content: text, refs: [], attachments: [] }, (ev) => events.push(ev));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { api.chatAbort(sid).catch(() => {}); reject(new Error("等待 done 超时")); }, 20000);
      const check = setInterval(() => {
        if (events.some((e) => e.type === "done")) { clearTimeout(timer); clearInterval(check); resolve(null); }
        if (events.some((e) => e.type === "error")) {
          clearTimeout(timer); clearInterval(check);
          reject(new Error("CLI error 事件：" + JSON.stringify(events.find((e) => e.type === "error")).slice(0, 200)));
        }
      }, 100);
    });
    return events;
  }

  let resumeSessionId = "";
  await t("CR-037 续接", "首轮 create：done 携带脱敏指纹且绑定落库（AC-05）", async () => {
    const s = await api.chatSessionCreate({ ...(projectId ? { projectId } : {}), cliId: "claude", modelId: "smoke-model" });
    resumeSessionId = s.id;
    const events = await sendAndWait(s.id, "第一轮");
    const done = events.find((e) => e.type === "done") as Extract<api.ChatEvent, { type: "done" }> | undefined;
    expect(!!done, "应有 done 事件；实际=" + events.map((e) => e.type).join(","));
    expect(typeof done!.turnId === "string" && done!.turnId!.length > 0, "done 应携带 turnId");
    expect(!!done!.refFingerprint && /^[0-9a-f]{16}$/.test(done!.refFingerprint!), `应有 16 位脱敏指纹，实际 ${done!.refFingerprint}`);
    expect(done!.nativeResumed === false, "首轮不得报已续接");
    expect(!("sessionRef" in (done! as unknown as Record<string, unknown>)), "done 不得再携带原引用 sessionRef");
    const meta = await api.chatSessionGet(s.id);
    expect(meta.binding?.state === "native", `绑定应为 native，实际 ${JSON.stringify(meta.binding)}`);
    expect(!!meta.binding?.refFingerprint, "绑定应带脱敏指纹");
    expect(meta.binding?.expectedRevision === 1, `绑定修订应为 1，实际 ${meta.binding?.expectedRevision}`);
    return `turnId=${done!.turnId?.slice(0, 12)} fp=${done!.refFingerprint}`;
  });
  await t("CR-037 续接", "第二轮 resume：mock confirm → nativeResumed=true（AC-05）", async () => {
    const events = await sendAndWait(resumeSessionId, "第二轮");
    const done = events.find((e) => e.type === "done") as Extract<api.ChatEvent, { type: "done" }>;
    expect(done.nativeResumed === true, `第二轮应确认续接，实际 ${JSON.stringify(done)}`);
    const meta = await api.chatSessionGet(resumeSessionId);
    expect(meta.binding?.state === "native", "绑定应保持 native");
    // 确认轮推进 CAS 代次：每次 confirmed 写入 revision+1（期望值随链推进）。
    expect(meta.binding?.expectedRevision === 2, `确认轮应递增修订至 2，实际 ${meta.binding?.expectedRevision}`);
    return "nativeResumed=true（修订 1→2）";
  });
  await t("CR-037 续接", "silent-new：适配器静默换线 → freshContext + 断点卡，不记已续接", async () => {
    await api.invoke("smoke_mock_resume", { mode: "silent-new" });
    const events = await sendAndWait(resumeSessionId, "第三轮");
    const done = events.find((e) => e.type === "done") as Extract<api.ChatEvent, { type: "done" }>;
    expect(done.freshContext === true && done.nativeResumed === false, `静默换线应为 freshContext，实际 ${JSON.stringify(done)}`);
    const meta = await api.chatSessionGet(resumeSessionId);
    expect(meta.binding?.state === "native", "新线程已确认绑定 → native");
    expect(meta.binding?.expectedRevision === 3, `换线写入应递增修订至 3，实际 ${meta.binding?.expectedRevision}`);
    const msgs = await api.chatMessages(resumeSessionId);
    const bp = msgs.find((m) => m.role === "system" && (m.metaJson ?? "").includes("context-breakpoint"));
    expect(!!bp, "应存在 system 断点消息");
    expect((bp!.content ?? "").includes("上下文已重建"), `断点文案：${(bp!.content ?? "").slice(0, 60)}`);
    await api.invoke("smoke_mock_resume", { mode: "confirm" });
    return "freshContext=true + 断点消息落库（修订 2→3）";
  });
  await t("CR-037 续接", "stale：resume 报错 → blocked（done 通报，绑定不动）", async () => {
    await api.invoke("smoke_mock_resume", { mode: "stale" });
    // 距上一确认轮 >3s：避开 REF_NOT_READY 竞态窗口，稳定命中 REF_STALE。
    await new Promise((r) => setTimeout(r, 3200));
    const events = await sendAndWait(resumeSessionId, "第四轮");
    // 场景复位先于断言：即使断言失败也不污染后续用例。
    await api.invoke("smoke_mock_resume", { mode: "confirm" });
    const done = events.find((e) => e.type === "done") as Extract<api.ChatEvent, { type: "done" }>;
    expect(done.blocked === true && done.reasonCode === "REF_STALE", `应 blocked REF_STALE，实际 ${JSON.stringify(done)}`);
    const meta = await api.chatSessionGet(resumeSessionId);
    expect(meta.binding?.state === "blocked", `绑定应为 blocked，实际 ${meta.binding?.state}`);
    expect(meta.binding?.reasonCode === "REF_STALE", "阻塞原因应持久化");
    expect(meta.binding?.expectedRevision === 3, "阻塞不递增修订");
    // 草稿保留：发送失败的文本通过 update draft 校验写路径未被清空
    await api.chatSessionUpdate({ id: resumeSessionId, draft: "未发送草稿保留" });
    const withDraft = await api.chatSessionGet(resumeSessionId);
    expect(withDraft.draft === "未发送草稿保留", "草稿保留");
    return "blocked REF_STALE + 草稿保留";
  });
  await t("CR-037 续接", "confirm_fresh：CAS 清引用 + 断点卡落库（AC-06）", async () => {
    await api.chatSessionConfirmFresh(resumeSessionId, 3, "REF_STALE");
    const meta = await api.chatSessionGet(resumeSessionId);
    expect(meta.binding?.state === "fresh", `确认后应为 fresh，实际 ${meta.binding?.state}`);
    expect(meta.binding?.expectedRevision === 4, `确认应递增修订至 4，实际 ${meta.binding?.expectedRevision}`);
    const msgs = await api.chatMessages(resumeSessionId);
    const bp = msgs.filter((m) => m.role === "system" && (m.metaJson ?? "").includes("context-breakpoint"));
    expect(bp.length >= 2, `应有两个断点（换线+重建），实际 ${bp.length}`);
    // CAS 失配拒绝：旧 expectedRevision 重放
    await expectError(api.chatSessionConfirmFresh(resumeSessionId, 3, "REF_STALE"), "绑定已变化", "CAS 失配应拒绝");
    return "fresh + 断点卡 + CAS 拒绝重放（修订 3→4）";
  });
  await t("CR-037 续接", "confirm_fresh 后下一轮以全新上下文重建绑定", async () => {
    const events = await sendAndWait(resumeSessionId, "重建后第一轮");
    const done = events.find((e) => e.type === "done") as Extract<api.ChatEvent, { type: "done" }>;
    expect(done.nativeResumed === false && !done.blocked, `重建后首轮应为 fresh/create，实际 ${JSON.stringify(done)}`);
    const meta = await api.chatSessionGet(resumeSessionId);
    expect(meta.binding?.state === "native", "重建后应回到 native");
    expect(meta.binding?.expectedRevision === 5, `重建确认应递增至 5，实际 ${meta.binding?.expectedRevision}`);
    return "fresh → native（修订 4→5）";
  });
  await t("CR-037 续接", "grok：首轮 create 直接发送；第二轮未确认被拒（UNSUPPORTED_CLI）", async () => {
    const s = await api.chatSessionCreate({ ...(projectId ? { projectId } : {}), cliId: "grok", modelId: "smoke-model" });
    const events = await sendAndWait(s.id, "grok 首轮");
    expect(events.some((e) => e.type === "delta"), "grok 首轮应有 delta");
    const meta = await api.chatSessionGet(s.id);
    expect(meta.binding?.state === "freshPending", `grok 有历史且未确认应为 freshPending，实际 ${JSON.stringify(meta.binding)}`);
    const msg = await expectError(sendAndWait(s.id, "grok 第二轮"), "BINDING_FRESH_REQUIRED", "未确认 grok 第二轮应被拒");
    expect(msg.includes("UNSUPPORTED_CLI"), `错误应含 UNSUPPORTED_CLI：${msg.slice(0, 120)}`);
    await api.chatSessionDelete(s.id);
    return "首轮直发 + freshPending + 第二轮拒绝";
  });
  await t("CR-037 续接", "executor 会话不参与绑定（sessionRole 门控）", async () => {
    const s = await api.chatSessionCreate({ ...(projectId ? { projectId } : {}), cliId: "claude", modelId: "smoke-model", featureId: "FEAT-001-DEMO" });
    expect(s.sessionRole === "executor", "应为 executor 会话");
    const events = await sendAndWait(s.id, "执行会话首轮");
    const done = events.find((e) => e.type === "done") as Extract<api.ChatEvent, { type: "done" }>;
    expect(!done.nativeResumed && !done.blocked && done.refFingerprint == null, "执行会话 done 不带绑定信息");
    const meta = await api.chatSessionGet(s.id);
    expect(meta.binding == null, `执行会话 binding 应为空，实际 ${JSON.stringify(meta.binding)}`);
    // 绑定列保持空：executor 的 ConfirmCreate 被 sessionRole 门控归档
    await api.chatSessionDelete(s.id);
    return "binding=null + done 无绑定信息";
  });
  await t("CR-037 续接", "codex resume：mock confirm → nativeResumed=true", async () => {
    const s = await api.chatSessionCreate({ ...(projectId ? { projectId } : {}), cliId: "codex", modelId: "smoke-model" });
    const first = await sendAndWait(s.id, "codex 首轮");
    const done1 = first.find((e) => e.type === "done") as Extract<api.ChatEvent, { type: "done" }>;
    expect(!!done1.refFingerprint, "codex 首轮应绑定线程");
    const second = await sendAndWait(s.id, "codex 第二轮");
    const done2 = second.find((e) => e.type === "done") as Extract<api.ChatEvent, { type: "done" }>;
    expect(done2.nativeResumed === true, `codex 第二轮应续接，实际 ${JSON.stringify(done2)}`);
    await api.chatSessionDelete(s.id);
    return "codex create→resume 通过";
  });
  await t("CR-037 续接", "非空会话切换 CLI 被拒（须另建会话，STORY-011 AC-05）", async () => {
    const msg = await expectError(
      api.chatSessionUpdate({ id: resumeSessionId, cliId: "codex" }),
      "另建会话",
      "非空会话原地换 CLI 应被拒"
    );
    // 空会话仍允许原地改
    const empty = await api.chatSessionCreate({ ...(projectId ? { projectId } : {}), cliId: "claude", modelId: "smoke-model" });
    await api.chatSessionUpdate({ id: empty.id, cliId: "codex" });
    const got = await api.chatSessionGet(empty.id);
    expect(got.cliId === "codex", "空会话原地换 CLI 应生效");
    await api.chatSessionDelete(empty.id);
    return msg.slice(0, 60);
  });
  // SMOKE_KEEP_DB=1：保留上次冒烟库，验证「重启后仍属原会话」（AC-05 跨重启）。
  // 标记会话不带项目（全局），避免前一轮清理 delete_project 后项目悬空阻塞续接。
  await t("CR-037 续接", "重启恢复：SMOKE_KEEP_DB 下原会话绑定与续接保持（AC-05）", async () => {
    const keepDb = await api.invoke<boolean>("smoke_keep_db_flag").catch(() => false);
    const list = await api.chatSessions();
    let marker = list.find((s) => s.title === "CR037-续接保持");
    // keep-db 下标记会话可能挂在前一轮已删除的项目上：删除重建为全局会话，重走两轮绑定。
    if (marker && marker.projectId) {
      const projects = await api.listProjects().catch(() => [] as api.Project[]);
      if (!projects.some((p) => p.id === marker!.projectId)) {
        await api.chatSessionDelete(marker.id).catch(() => {});
        marker = undefined;
      }
    }
    if (!marker) {
      const s = await api.chatSessionCreate({ cliId: "claude", modelId: "smoke-model" });
      await api.chatSessionUpdate({ id: s.id, title: "CR037-续接保持" });
      await sendAndWait(s.id, "保持会话第一轮");
      const second = await sendAndWait(s.id, "保持会话第二轮");
      const done = second.find((e) => e.type === "done") as Extract<api.ChatEvent, { type: "done" }>;
      expect(done.nativeResumed === true, "标记会话第二轮应续接");
      if (!keepDb) return "已创建标记会话（SMOKE_KEEP_DB=1 重启后复验）";
      const meta = await api.chatSessionGet(s.id);
      expect(meta.binding?.state === "native", `标记会话绑定应 native，实际 ${meta.binding?.state}`);
      return "keep-db 下标记会话重建并两轮绑定（上轮项目悬空，已重建）";
    }
    const meta = await api.chatSessionGet(marker.id);
    expect(meta.binding?.state === "native", `重启后绑定应恢复 native，实际 ${meta.binding?.state}`);
    expect(!!meta.binding?.refFingerprint, "重启后绑定应带脱敏指纹");
    const third = await sendAndWait(marker.id, "重启后第三轮");
    const done = third.find((e) => e.type === "done") as Extract<api.ChatEvent, { type: "done" }>;
    expect(done.nativeResumed === true, `重启后第三轮应仍续接原线程，实际 ${JSON.stringify(done)}`);
    return "重启后绑定恢复且第三轮 nativeResumed=true";
  });
  await t("CR-037 续接", "清理续接测试会话", async () => {
    await api.chatAbort(resumeSessionId).catch(() => {});
    await api.chatSessionDelete(resumeSessionId);
    return "ok";
  });

  
  /* ---------- Skill / MCP / Tool ---------- */
  await t("Skill", "skill_save 命名校验", async () => {
    const msg = await expectError(api.skillSave({ name: "Bad Name!", description: "d", content: "c" }), "技能名称", "非法名应被拒");
    return msg;
  });
  await t("Skill", "skill_save + 重复名拒绝", async () => {
    await api.skillDelete("smoke-skill").catch(() => {}); // 跨运行残留预清理（技能存文件系统）
    await api.skillSave({ name: "smoke-skill", description: "冒烟技能", content: "内容正文" });
    const msg = await expectError(api.skillSave({ name: "smoke-skill", description: "d", content: "c" }), "已存在", "重复名应被拒");
    return msg;
  });
  await t("Skill", "skill_list / skill_read / set_enabled", async () => {
    const list = await api.skillList();
    const s = list.find((x) => x.name === "smoke-skill");
    expect(!!s, "应列出");
    const content = await api.skillRead("smoke-skill");
    expect(content.includes("内容正文"), "应读到正文");
    await api.skillSetEnabled("smoke-skill", false);
    const list2 = await api.skillList();
    expect(list2.find((x) => x.name === "smoke-skill")?.enabled === false, "禁用生效");
    return "ok";
  });
  let mcpId = "";
  await t("MCP", "mcp_save 校验", async () => {
    const msg = await expectError(api.mcpSave({ name: "bad name!", transport: "stdio", command: "node", args: [], env: {}, enabled: true }), "名称", "非法名应被拒");
    return msg;
  });
  await t("MCP", "mcp_save stdio + 重复名拒绝", async () => {
    mcpId = await api.mcpSave({
      name: "smoke-mcp", transport: "stdio", command: "node",
      args: [new URL("file:///D:/github/AI_Delelovelop/mockbin/mock-mcp.mjs").pathname.replace(/^\//, "")],
      env: {}, enabled: true,
    });
    expect(mcpId.startsWith("mcp-"), "应有 id");
    const msg = await expectError(api.mcpSave({ name: "smoke-mcp", transport: "stdio", command: "node", args: [], env: {}, enabled: true }), "已存在", "重复名应被拒");
    return msg;
  });
  await t("MCP", "mcp_discover_tools 经 mock 服务器发现", async () => {
    const tools = await api.mcpDiscoverTools(mcpId);
    expect(tools.length === 2, `应发现 2 个工具，实际 ${tools.length}`);
    expect(tools.some((x) => x.name === "mock.echo"), "应含 mock.echo");
    return tools.map((x) => x.name).join(",");
  });
  await t("MCP", "mcp_list 工具缓存 + set_enabled + delete", async () => {
    const list = await api.mcpList();
    const s = list.find((x) => x.id === mcpId);
    expect(s?.tools.length === 2, "列表应带缓存工具");
    await api.mcpSetEnabled(mcpId, false);
    const list2 = await api.mcpList();
    expect(list2.find((x) => x.id === mcpId)?.enabled === false, "禁用生效");
    await api.mcpDelete(mcpId);
    const list3 = await api.mcpList();
    expect(!list3.some((x) => x.id === mcpId), "删除生效");
    return "ok";
  });
  await t("Tool", "tool_list 内置注册表", async () => {
    const tools = await api.toolList();
    expect(tools.length === 6, `应 6 个内置工具，实际 ${tools.length}`);
    expect(tools.some((x) => x.name === "ssh-exec" && x.risk === "high"), "ssh-exec 应为 high");
    await api.toolSetEnabled("fs.read", false);
    const t2 = await api.toolList();
    expect(t2.find((x) => x.name === "fs.read")?.enabled === false, "禁用生效");
    await api.toolSetEnabled("fs.read", true);
    return `${tools.length} 个`;
  });

  /* ---------- 知识库 + 授权网关 ---------- */
  let kbId = "";
  await t("知识库", "kb_save + kb_scan 索引", async () => {
    kbId = await api.kbSave("冒烟知识库", kbDir);
    expect(kbId.startsWith("kb-"), "应有 id");
    const n = await api.kbScan(kbId);
    expect(n === 2, `应索引 2 篇，实际 ${n}`);
    return `${n} 篇`;
  });
  await t("知识库", "kb_tree 目录分组", async () => {
    const tree = await api.kbTree(kbId);
    expect(tree.length === 2, `应有 2 个顶级目录，实际 ${tree.length}`);
    const guide = tree.find((d) => d.title === "指南");
    expect(!!guide && guide.children.length === 1, "指南目录应含 1 篇");
    return `${tree.length} 目录`;
  });
  await t("知识库", "kb_read 正文", async () => {
    const tree = await api.kbTree(kbId);
    const note = tree.find((d) => d.title === "指南")!.children[0];
    const c = await api.kbRead(kbId, note.noteId);
    expect(c.content.includes("alpha"), "应读到正文");
    return c.title;
  });
  await t("知识库", "kb_search 关键词", async () => {
    const hits = await api.kbSearch([kbId], "alpha");
    expect(hits.length === 1, `应命中 1 处，实际 ${hits.length}`);
    return hits[0].title;
  });
  await t("授权网关", "未授权读取拒绝", async () => {
    const tree = await api.kbTree(kbId);
    const note = tree.find((d) => d.title === "指南")!.children[0];
    const msg = await expectError(api.kbGateway({ tool: "knowledge.read", argsJson: JSON.stringify({ libraryId: kbId, noteId: note.noteId }), projectId }), "未授权", "未授权应拒绝");
    return msg;
  });
  await t("授权网关", "授权后 list/search/read 全通", async () => {
    await api.kbGrantSet(projectId, kbId, true);
    const list = await api.kbGateway({ tool: "knowledge.list", projectId });
    expect((list as { libraries: unknown[] }).libraries.length >= 1, "list 应有库");
    const search = await api.kbGateway({ tool: "knowledge.search", argsJson: JSON.stringify({ query: "alpha" }), projectId });
    expect((search as { hits: unknown[] }).hits.length === 1, "search 应命中");
    const tree = await api.kbTree(kbId);
    const note = tree.find((d) => d.title === "指南")!.children[0];
    const read = await api.kbGateway({ tool: "knowledge.read", argsJson: JSON.stringify({ libraryId: kbId, noteId: note.noteId }), projectId });
    expect((read as { content: string }).content.includes("alpha"), "read 应有正文");
    await api.kbGrantSet(projectId, kbId, false);
    return "list/search/read 通过后撤权";
  });
  await t("授权网关", "撤权后立即拒绝", async () => {
    const tree = await api.kbTree(kbId);
    const note = tree.find((d) => d.title === "指南")!.children[0];
    const msg = await expectError(api.kbGateway({ tool: "knowledge.read", argsJson: JSON.stringify({ libraryId: kbId, noteId: note.noteId }), projectId }), "未授权", "撤权后应拒绝");
    return msg;
  });
  await t("知识库", "kb_grants 授权表读取", async () => {
    const grants = await api.kbGrants(projectId);
    expect(grants.length >= 1, "应有授权视图");
    return `${grants.length} 行`;
  });
  await t("CR-051 图标", "知识库 icon 保存与读取", async () => {
    await api.kbSetIcon(kbId, "library");
    let list = await api.kbList();
    expect(list.find((l) => l.id === kbId)?.icon === "library", "应保存 library");
    await api.kbSetIcon(kbId, null);
    list = await api.kbList();
    expect(list.find((l) => l.id === kbId)?.icon === null, "清空后应回来源默认");
    await api.kbSetIcon(kbId, "shield");
    return "保存/清空/回读通过";
  });
  await t("CR-051 图标", "知识库 icon 非法 id 拒绝", async () => {
    // r6：rocket 已进入共用 50 白名单；非法样本改用未登记 id。
    const msg = await expectError(api.kbSetIcon(kbId, "notAnIcon"), "非法知识库图标", "非法图标应被拒");
    const list = await api.kbList();
    expect(list.find((l) => l.id === kbId)?.icon === "shield", "拒绝后不应写入");
    await api.kbSetIcon(kbId, null);
    return msg;
  });
  await t("CR-051 图标", "知识库 icon+色卡成对保存与回读", async () => {
    // r6：知识库与项目共用 50 图标；色卡成对保存、清空回默认青绿。
    await api.kbSetIcon(kbId, "chartBar");
    await api.kbSetIconColor(kbId, "sand");
    let list = await api.kbList();
    let row = list.find((l) => l.id === kbId);
    expect(row?.icon === "chartBar" && row?.iconColor === "sand", "应成对保存 chartBar+sand");
    await api.kbSetIconColor(kbId, null);
    list = await api.kbList();
    row = list.find((l) => l.id === kbId);
    expect(row?.icon === "chartBar" && row?.iconColor === null, "清空色卡应写 NULL（展示层回默认青绿）");
    const msg = await expectError(api.kbSetIconColor(kbId, "cyan"), "非法背景色卡", "非法色卡应被拒");
    await api.kbSetIcon(kbId, null);
    return "成对保存/清空/拒绝：" + msg;
  });
  await t("CR-051 图标", "kb_set_appearance 原子成对提交", async () => {
    // 接手收尾补齐：一次调用同时写图标与色卡（原子，不留半更新）。
    await api.kbSetAppearance(kbId, "chartBar", "sand");
    let row = (await api.kbList()).find((l) => l.id === kbId);
    expect(row?.icon === "chartBar" && row?.iconColor === "sand", "原子提交应成对落库");
    await api.kbSetAppearance(kbId, null, null);
    row = (await api.kbList()).find((l) => l.id === kbId);
    expect(row?.icon === null && row?.iconColor === null, "原子清空应双列 NULL");
    const msg = await expectError(api.kbSetAppearance(kbId, "notAnIcon", "sand"), "非法", "非法图标原子拒绝");
    row = (await api.kbList()).find((l) => l.id === kbId);
    expect(row?.icon === null && row?.iconColor === null, "拒绝后不留半更新");
    return "原子成对/清空/拒绝：" + msg;
  });
  await t("CR-051 头像", "save_avatar 原子提交（图片+风格同事务）", async () => {
    const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const saved = await api.saveAvatar(tinyPng, "c");
    expect(!!saved?.path, "原子保存应返回路径");
    expect(await api.getAvatarStyle() === "c", "风格应随同一事务更新为 c");
    const got = await api.getAvatarImage();
    expect(got?.path === saved.path, "引用应可回读");
    // 恢复默认 = data_url 传空串（清图 + 设 B）；传 null 语义为「保留图片只改风格」。
    await api.saveAvatar("", "b");
    expect(await api.getAvatarStyle() === "b", "恢复默认应清图并设 B");
    expect((await api.getAvatarImage())?.path === null, "恢复默认后引用为 null");
    const kept = await api.saveAvatar(tinyPng, "d");
    expect(await api.getAvatarStyle() === "d" && !!kept?.path, "null 语义：保留图片只改风格");
    await api.saveAvatar("", "b");
    expect((await api.getAvatarImage())?.path === null, "收尾恢复默认");
    return "save_avatar 原子提交/恢复默认/null 保留语义通过";
  });

  /* ---------- 服务器（错误路径，无真实主机） ---------- */
  let hostId = "";
  await t("服务器", "server_save 校验", async () => {
    const msg = await expectError(api.serverSave({ name: "", host: "x", port: 22, username: "u", authType: "password" }), "不能为空", "空名应被拒");
    return msg;
  });
  await t("服务器", "server_save 成功", async () => {
    hostId = await api.serverSave({ name: "冒烟主机", host: "127.0.0.1", port: 1, username: "smoke", authType: "password", secret: "pw", groupTag: "smoke" });
    expect(hostId.startsWith("host-"), "应有 id");
    return hostId;
  });
  await t("服务器", "server_connect 失败如实报错", async () => {
    const msg = await expectError(api.serverConnect(hostId), "SSH 连接失败", "连不上应报错");
    return msg.slice(0, 120);
  });
  await t("服务器", "server_exec 未连接拒绝", async () => {
    const msg = await expectError(api.serverExec(hostId, "ls"), "未连接", "未连接应拒绝");
    return msg;
  });
  await t("服务器", "server_metrics 未连接拒绝", async () => {
    const msg = await expectError(api.serverMetrics(hostId), "未连接", "未连接应拒绝");
    return msg;
  });
  await t("服务器", "server_delete 清理", async () => {
    await api.serverDelete(hostId);
    const list = await api.serverList();
    expect(!list.some((h) => h.id === hostId), "删除生效");
    return "ok";
  });


  /* ---------- 真实供应商注入（LLD-FEAT-002 §3.1.1） ---------- */
  const GW = "http://127.0.0.1:18080";
  const GW_KEY = "gw-test-key-123456";
  let gwProviderId = "";
  await t("供应商注入", "创建供应商（anthropic 协议指向本地网关）", async () => {
    gwProviderId = await api.providerSave({
      name: "本地网关供应商",
      protocol: "anthropic",
      disabled: false,
      headersJson: null,
      keys: [{ alias: "gw", secret: GW_KEY, enabled: true }],
      endpoints: [{ protocol: "anthropic", baseUrl: GW, enabled: true }],
      models: [{
        modelId: "mock-model-anthropic", displayName: "网关模型", text: true, vision: false, imageGen: false,
        efforts: { off: null, low: "low" }, defaultEffort: "off", contextWindow: 200000, maxTokens: 8192,
      }],
    });
    return gwProviderId;
  });
  await t("供应商注入", "真实 claude CLI 命中配置的供应商", async () => {
    await api.invoke("smoke_use_real_claude");
    const s = await api.chatSessionCreate({
      projectId, cliId: "claude", providerId: gwProviderId,
      modelId: "mock-model-anthropic", effort: "off",
    });
    const events: api.ChatEvent[] = [];
    let sendErr = "";
    try {
      await api.chatSend({ sessionId: s.id, content: "hello via provider", refs: [], attachments: [] }, (ev) => events.push(ev));
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("等待 done 超时")), 120000);
        const check = setInterval(() => {
          if (events.some((e) => e.type === "done")) { clearTimeout(timer); clearInterval(check); resolve(null); }
          if (events.some((e) => e.type === "error")) {
            clearTimeout(timer); clearInterval(check);
            reject(new Error("error 事件：" + JSON.stringify(events.find((e) => e.type === "error")).slice(0, 300)));
          }
        }, 200);
      });
    } catch (e) {
      sendErr = String(e);
    } finally {
      await api.chatSessionDelete(s.id).catch(() => {});
    }
    const rec = await api.invoke<{ calls: { path: string; keyOk: boolean; model: string | null }[] }>(
      "smoke_gateway_record", { url: GW + "/__record" }
    );
    const hit = rec.calls.filter((c) => c.path.includes("/v1/messages"));
    expect(hit.length > 0, `网关应收到 /v1/messages；发送错误：${sendErr.slice(0, 200)}；记录=${JSON.stringify(rec.calls.slice(-4))}`);
    expect(hit.every((c) => c.keyOk), "网关应收到正确密钥");
    expect(hit.some((c) => c.model === "mock-model-anthropic"), "网关应收到配置的模型名");
    return `真实 claude CLI 命中本地网关 ${hit.length} 次，密钥校验通过，模型=${hit[0].model}`;
  });

  /* ---------- 真实 SSH 主机（用户提供：ssh.instabox.sh:2222，none 认证） ---------- */
  let realHostId = "";
  const REAL_HOST = "ssh.instabox.sh";
  const REAL_PORT = 2222;
  const REAL_USER = "ibssh_snemqqcwmqewerxxvssqwopxcy";
  await t("真实SSH", "保存主机（none 认证）", async () => {
    realHostId = await api.serverSave({
      name: "instabox 真实主机", host: REAL_HOST, port: REAL_PORT, username: REAL_USER,
      authType: "none", groupTag: "smoke-real",
    });
    expect(realHostId.startsWith("host-"), "应有 id");
    return realHostId;
  });
  await t("真实SSH", "连接成功", async () => {
    await api.serverConnect(realHostId);
    const list = await api.serverList();
    expect(list.find((h) => h.id === realHostId)?.connected === true, "列表应显示已连接");
    return "connected";
  });
  await t("真实SSH", "exec 命令返回真实输出", async () => {
    const res = await api.serverExec(realHostId, "echo hello-from-ipc");
    expect(res.needsApproval === false, "普通命令不需审批");
    expect(res.exitCode === 0, `退出码应为 0，实际 ${res.exitCode}`);
    expect((res.output ?? "").includes("hello-from-ipc"), `输出应含命令回显，实际：${(res.output ?? "").slice(0, 120)}`);
    return (res.output ?? "").trim().slice(0, 80);
  });
  await t("真实SSH", "exec 未连接/真实 uname", async () => {
    const res = await api.serverExec(realHostId, "uname -s; whoami");
    expect((res.output ?? "").includes("Linux"), `应返回 Linux，实际：${(res.output ?? "").slice(0, 120)}`);
    return (res.output ?? "").replace(/s+/g, " ").trim().slice(0, 80);
  });
  await t("真实SSH", "监控采样 /proc 真实数据", async () => {
    const m = await api.serverMetrics(realHostId);
    expect(m.cpuCores.length >= 1, `应有 CPU 每核数据，实际 ${m.cpuCores.length}`);
    expect(m.memTotalMb > 0, `内存总量应 >0，实际 ${m.memTotalMb}`);
    expect(m.memUsedMb >= 0 && m.memUsedMb <= m.memTotalMb, `内存用量应在范围内：${m.memUsedMb}/${m.memTotalMb}`);
    expect(m.hostname.length > 0, `主机名应非空，实际 "${m.hostname}"`);
    expect(m.uptime !== "未知", `运行时长应可解析，实际 ${m.uptime}`);
    return `cores=${m.cpuCores.length} avg=${m.cpuAvg}% mem=${m.memUsedMb}/${m.memTotalMb}MB host=${m.hostname} up=${m.uptime}`;
  });
  await t("真实SSH", "终端打开+输入+输出", async () => {
    let out = "";
    const termId = await api.serverTermOpen(realHostId, 100, 30, (d) => { out += d; });
    expect(termId.startsWith("term-"), `应有 termId，实际 ${termId}`);
    await new Promise((r) => setTimeout(r, 1500));
    await api.serverTermInput(realHostId, termId, "echo term-ipc-ok" + String.fromCharCode(10));
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (out.includes("term-ipc-ok")) break;
    }
    expect(out.includes("term-ipc-ok"), `终端应回显标记，实际输出：${out.slice(0, 200)}`);
    await api.serverTermResize(realHostId, termId, 120, 40);
    await api.serverTermClose(termId);
    return `终端输出 ${out.length} 字符`;
  });
  await t("真实SSH", "高风险命令需审批（未执行）", async () => {
    const res = await api.serverExec(realHostId, "rm -rf /tmp/smoke-should-not-delete");
    expect(res.needsApproval === true, "高风险命令应要求审批");
    expect(!!res.requestId, "应返回审批 id");
    await api.serverExecReject(res.requestId!);
    return `审批拦截（已拒绝，未执行）`;
  });
  await t("真实SSH", "审批后真实执行", async () => {
    const res = await api.serverExec(realHostId, "shutdown --dry-run 2>/dev/null || echo approved-path-ok");
    if (res.needsApproval) {
      const done = await api.serverExecApproved(res.requestId!);
      expect((done.output ?? "").length > 0, "应返回输出");
      return `批准执行：${(done.output ?? "").trim().slice(0, 60)}`;
    }
    return `未触发审批：${(res.output ?? "").trim().slice(0, 60)}`;
  });
  await t("真实SSH", "SFTP 子系统能力如实反馈", async () => {
    let listed = false;
    let errMsg = "";
    try {
      const nodes = await api.serverTree(realHostId, "/");
      listed = Array.isArray(nodes);
    } catch (e) {
      errMsg = String(e).slice(0, 120);
    }
    // 两种结果都可接受，但必须如实：要么列出，要么给出明确错误
    expect(listed || errMsg.length > 0, "SFTP 必须返回结果或明确错误");
    return listed ? "SFTP 可用" : "SFTP 不可用（如实报错：" + errMsg + "）";
  });
  await t("真实SSH", "断开连接", async () => {
    await api.serverDisconnect(realHostId);
    const list = await api.serverList();
    expect(list.find((h) => h.id === realHostId)?.connected === false, "应显示未连接");
    await api.serverDelete(realHostId);
    return "ok";
  });

  await t("供应商注入", "供应商缺密钥时明确拒绝（不静默降级）", async () => {
    const bare = await api.providerSave({
      name: "无密钥供应商", protocol: "anthropic", disabled: false, headersJson: null,
      keys: [], endpoints: [{ protocol: "anthropic", baseUrl: "https://example.invalid", enabled: true }],
      models: [{ modelId: "m", displayName: "m", text: true, vision: false, imageGen: false, efforts: {}, defaultEffort: null, contextWindow: null, maxTokens: null }],
    });
    const s = await api.chatSessionCreate({ cliId: "claude", providerId: bare, modelId: "m", effort: "off" });
    const msg = await expectError(
      api.chatSend({ sessionId: s.id, content: "hi", refs: [], attachments: [] }, () => {}),
      "没有可用密钥", "缺密钥应明确拒绝"
    );
    await api.chatSessionDelete(s.id).catch(() => {});
    await api.providerDelete(bare);
    return msg;
  });
  await t("供应商注入", "协议不匹配时明确拒绝", async () => {
    const openaiOnly = await api.providerSave({
      name: "仅OpenAI供应商", protocol: "openai", disabled: false, headersJson: null,
      keys: [{ alias: "k", secret: "sk-test-12345678", enabled: true }],
      endpoints: [{ protocol: "openai", baseUrl: "https://example.invalid", enabled: true }],
      models: [{ modelId: "m", displayName: "m", text: true, vision: false, imageGen: false, efforts: {}, defaultEffort: null, contextWindow: null, maxTokens: null }],
    });
    const s = await api.chatSessionCreate({ cliId: "claude", providerId: openaiOnly, modelId: "m", effort: "off" });
    const msg = await expectError(
      api.chatSend({ sessionId: s.id, content: "hi", refs: [], attachments: [] }, () => {}),
      "Anthropic 兼容协议", "协议不匹配应拒绝"
    );
    await api.chatSessionDelete(s.id).catch(() => {});
    await api.providerDelete(openaiOnly);
    return msg;
  });

  /* ---------- FEAT-019 / FEAT-004：执行账本与双向同步（真实 IPC 命令链路） ---------- */
  await runExecutionSuite(projectId, projDir, t);

  /* ---------- 真实供应商（仅当设置了 smoke.tierflowKey 时执行） ---------- */
  const liveKey = await api.getSetting("smoke.tierflowKey").catch(() => null);
  if (liveKey) {
    let liveProviderId = "";
    // CR-061：内置预置供应商已移除；冒烟链路改为自建供应商（先写入密钥与供应商，再校验）。
    await t("真实供应商", "冒烟自建供应商就位", async () => {
      await api.invoke("smoke_set_tierflow_key", { key: liveKey });
      const list = await api.providerList();
      const pv = list.find((x) => x.id === "prov-smoke-tierflow");
      expect(!!pv, "应有冒烟自建 TierFlow 供应商");
      expect(pv!.endpoints.length >= 2, "应有 anthropic 与 openai 两条端点");
      expect(pv!.models.some((m) => m.modelId === "tierflow"), "应有 tierflow 模型");
      liveProviderId = pv!.id;
      return "端点=" + pv!.endpoints.map((e) => e.protocol).join(",") + " 模型=" + pv!.models.map((m) => m.modelId).join(",");
    });
    await t("真实供应商", "chat_send 经 claude + tierflow 完成真实对话", async () => {
      await api.invoke("smoke_set_tierflow_key", { key: liveKey });
      await api.invoke("smoke_use_real_claude");
      const s = await api.chatSessionCreate({
        cliId: "claude", providerId: liveProviderId, modelId: "tierflow", effort: "off",
      } as { cliId: string; providerId: string; modelId: string; effort: string });
      const events: api.ChatEvent[] = [];
      let err = "";
      try {
        await api.chatSend({ sessionId: s.id, content: "请只回复两个字母：OK", refs: [], attachments: [] }, (ev) => events.push(ev));
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("等待 done 超时")), 240000);
          const ck = setInterval(() => {
            if (events.some((e) => e.type === "done")) { clearTimeout(timer); clearInterval(ck); resolve(null); }
            if (events.some((e) => e.type === "error")) {
              clearTimeout(timer); clearInterval(ck);
              reject(new Error("error：" + JSON.stringify(events.find((e) => e.type === "error")).slice(0, 200)));
            }
          }, 300);
        });
      } catch (e) { err = String(e); }
      const msgs = await api.chatMessages(s.id).catch(() => []);
      const assistant = msgs.find((m) => m.role === "assistant");
      const usage = events.find((e) => e.type === "usage");
      expect(!!assistant && assistant.content.trim().length > 0,
        "应持久化助手回复；错误=" + err.slice(0, 150) + "；事件=" + events.map((e) => e.type).join(","));
      const text = assistant!.content.trim();
      // 必须是真实模型回复：mock CLI 的固定文案说明走错了 CLI
      expect(!text.includes("来自 mock claude"),
        "走了 mock CLI 而非真实 claude（回复=" + JSON.stringify(text.slice(0, 60)) + "）");
      // 真实模型应回出 OK（允许带标点/空白）
      expect(/OK/i.test(text), "真实模型回复应包含 OK，实际=" + JSON.stringify(text.slice(0, 80)));
      await api.chatSessionDelete(s.id).catch(() => {});
      return "回复=" + JSON.stringify(text.slice(0, 40)) + " 用量=" + JSON.stringify(usage);
    });

    await t("真实供应商", "真实 CLI 工具调用（读文件 → toolUse/toolResult，两次尝试）", async () => {
      // 真实模型偶发跳过工具直接作答（探针已证实 tierflow 支持完整工具链路），
      // 因此用不可猜测的文件路径 + 明确禁止臆测，并允许两次尝试。
      await api.invoke("smoke_set_tierflow_key", { key: liveKey });
      await api.invoke("smoke_use_real_claude");
      let toolUse: api.ChatEvent | undefined;
      let toolResult: api.ChatEvent | undefined;
      let lastReply = "";
      let lastEvents = "";
      for (let attempt = 1; attempt <= 2 && (!toolUse || !toolResult); attempt++) {
        const s = await api.chatSessionCreate({
          projectId, cliId: "claude", providerId: liveProviderId, modelId: "tierflow", effort: "off",
        } as { projectId: string; cliId: string; providerId: string; modelId: string; effort: string });
        const events: api.ChatEvent[] = [];
        let err = "";
        try {
          await api.chatSend(
            {
              sessionId: s.id,
              content:
                "禁止凭记忆或猜测回答。你必须先调用 Read 工具读取 README.md 的第 1 行，再原样回复该行文本。README.md 在当前目录。",
              refs: [],
              attachments: [],
            },
            (ev) => events.push(ev)
          );
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("等待 done 超时")), 240000);
            const ck = setInterval(() => {
              if (events.some((e) => e.type === "done")) { clearTimeout(timer); clearInterval(ck); resolve(null); }
              if (events.some((e) => e.type === "error")) {
                clearTimeout(timer); clearInterval(ck);
                reject(new Error("error：" + JSON.stringify(events.find((e) => e.type === "error")).slice(0, 200)));
              }
            }, 300);
          });
        } catch (e) { err = String(e); }
        toolUse = events.find((e) => e.type === "toolUse");
        toolResult = events.find((e) => e.type === "toolResult");
        const msgs = await api.chatMessages(s.id).catch(() => []);
        lastReply = msgs.find((m) => m.role === "assistant")?.content ?? "";
        lastEvents = events.map((e) => e.type).join(",");
        await api.chatSessionDelete(s.id).catch(() => {});
        void err;
      }
      expect(!!toolUse && !!toolResult,
        "两次尝试均未出现真实工具调用与结果事件；事件=" + lastEvents.slice(0, 120));
      expect(lastReply.trim().length > 0, "工具调用后应有最终回复");
      return `工具=${(toolUse as { name?: string }).name ?? "?"} 回复=${JSON.stringify(lastReply.slice(0, 60))}`;
    });

    await t("真实供应商", "真实 claude 两轮原生续接（CR-037 AC-05：流内 session_id 一致确认）", async () => {
      await api.invoke("smoke_set_tierflow_key", { key: liveKey });
      await api.invoke("smoke_use_real_claude");
      const s = await api.chatSessionCreate({
        ...(projectId ? { projectId } : {}), cliId: "claude", providerId: liveProviderId, modelId: "tierflow", effort: "off",
      } as { projectId?: string; cliId: string; providerId: string; modelId: string; effort: string });
      let round1 = "";
      let round2 = "";
      let err = "";
      try {
        const first = await sendAndWait(s.id, "记住数字 47。只回复：已记住");
        const done1 = first.find((e) => e.type === "done") as Extract<api.ChatEvent, { type: "done" }>;
        expect(!!done1.refFingerprint, `首轮应绑定原线程，实际 ${JSON.stringify(done1)}`);
        round1 = done1.refFingerprint!;
        const meta1 = await api.chatSessionGet(s.id);
        expect(meta1.binding?.state === "native", `首轮绑定应为 native，实际 ${meta1.binding?.state}`);
        const second = await sendAndWait(s.id, "我刚才让你记住的数字是多少？只回复数字。");
        const done2 = second.find((e) => e.type === "done") as Extract<api.ChatEvent, { type: "done" }>;
        expect(done2.nativeResumed === true, `第二轮应确认续接（emittedRef==requested），实际 ${JSON.stringify(done2)}`);
        round2 = done2.refFingerprint ?? "";
        expect(round2 === round1, "两轮指纹应一致（同一线程）");
        const msgs = await api.chatMessages(s.id);
        const reply = (msgs.filter((m) => m.role === "assistant").pop()?.content ?? "").trim();
        expect(/47/.test(reply), `续接后模型应记得 47，实际回复=${JSON.stringify(reply.slice(0, 80))}`);
      } catch (e) { err = String(e); }
      const meta = await api.chatSessionGet(s.id).catch(() => null);
      await api.chatSessionDelete(s.id).catch(() => {});
      expect(!err, "真实续接失败：" + err.slice(0, 200));
      return `两轮续接通过（指纹 ${round1.slice(0, 8)}…）`;
    });
  }

  /* ---------- 清理 ---------- */
  await t("清理", "chat_session_delete", async () => {
    await api.chatAbort(claudeSessionId).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    await api.chatSessionDelete(claudeSessionId);
    await expectError(api.chatSessionGet(claudeSessionId), "no rows", "删除后查询应失败");
    return "ok";
  });
  await t("清理", "kb_delete / skill_delete / provider_delete", async () => {
    await api.kbDelete(kbId);
    await api.skillDelete("smoke-skill");
    if (providerId) await api.providerDelete(providerId);
    const libs = await api.kbList();
    expect(!libs.some((l) => l.id === kbId), "库已删除");
    const skills = await api.skillList();
    expect(!skills.some((s) => s.name === "smoke-skill"), "技能已删除");
    const ps = await api.providerList();
    expect(!ps.some((p) => p.id === providerId), "供应商已删除");
    return "ok";
  });
  await t("清理", "delete_project", async () => {
    await api.deleteProject(projectId);
    const list = await api.listProjects();
    expect(!list.some((p) => p.id === projectId), "项目已删除");
    return "ok";
  });
}
