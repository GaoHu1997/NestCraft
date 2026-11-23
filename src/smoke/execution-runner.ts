/**
 * IPC 冒烟（聚焦）：只跑 FEAT-019 执行账本与 FEAT-004 双向同步。
 *
 * 背景：历史全量套件（runner.ts）含外部动作与已知环境性卡点，
 * 不能用来证明本批新增命令。本入口在同一个真实 Tauri 运行时里
 * 只执行本批范围，报告单独落盘为 smoke-report-execution.md。
 *
 * 触发条件（与全量套件同样要求双重授权）：
 *   进程环境 TAURI_SMOKE=1 且 SMOKE_EXEC_SUITE=1
 */
import * as api from "@/api";
import { runExecutionSuite } from "./execution-suite";

const results: { section: string; name: string; ok: boolean; detail: string }[] = [];

async function t(section: string, name: string, fn: () => Promise<string>): Promise<void> {
  await api.invoke("smoke_progress", { label: "START " + section + " / " + name }).catch(() => {});
  try {
    const detail = await fn();
    results.push({ section, name, ok: true, detail });
  } catch (e) {
    results.push({ section, name, ok: false, detail: String(e).slice(0, 400) });
  }
}

function render(): string {
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  const lines: string[] = [];
  lines.push("# IPC 冒烟报告（执行账本 + 双向同步）");
  lines.push("");
  lines.push(`- 时间：${new Date().toLocaleString("zh-CN")}`);
  lines.push(`- 结果：**${pass} 通过 / ${fail} 失败 / 共 ${results.length}**`);
  lines.push("");
  const sections = [...new Set(results.map((r) => r.section))];
  for (const section of sections) {
    lines.push(`## ${section}`);
    lines.push("");
    lines.push("| # | 用例 | 结果 | 说明 |");
    lines.push("| --- | --- | --- | --- |");
    results
      .filter((r) => r.section === section)
      .forEach((r, i) => {
        const detail = r.detail.replace(/\|/g, "\\|").replace(/\n/g, " ");
        lines.push(`| ${i + 1} | ${r.name} | ${r.ok ? "PASS" : "**FAIL**"} | ${detail} |`);
      });
    lines.push("");
  }
  return lines.join("\n");
}

export async function runExecutionSmoke(): Promise<void> {
  let projectId = "";
  let projectDir = "";

  await t("夹具", "建临时项目", async () => {
    const dirs = await api.invoke<{ projectDir: string }>("smoke_prepare_fixtures");
    projectDir = dirs.projectDir;
    const p = await api.createProject("执行同步冒烟项目", "code", projectDir);
    projectId = p.id;
    return `${projectId} @ ${projectDir}`;
  });

  if (projectId) {
    await runExecutionSuite(projectId, projectDir, t);
  }

  const md = render();
  try {
    await api.invoke("smoke_report_write_execution", { content: md });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("报告落盘失败", e);
  }
}
