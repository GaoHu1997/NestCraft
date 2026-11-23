import { CliLogo, Icon } from "@/components/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "@/api";
import type { McpServer, ToolEntry } from "@/api";
import { useToast } from "@/components/ui";
import { errMsg } from "./shared";
import { SettingsSwitch } from "./SettingsDialog";

/**
 * CR-059 F6/F7：能力 · Tools 树形列表。
 *
 * - 根节点＝提供方：NestCraft 内置（18 项经 workbench MCP 真实注入）／各已配置 MCP 服务器／各 CLI 原生工具集；
 * - 展开显示该来源的 tool 行（名称 mono＋风险 tag＋说明＋开关）；
 * - MCP 来源未发现工具时显示「尚未发现工具，去测试连接」；CLI 原生工具为只读；
 * - 移除「今日调用」列（接口没有调用计数）。
 */

const RISK_CLASS: Record<string, string> = { low: "", medium: "warn", high: "bad" };
const RISK_LABEL: Record<string, string> = { low: "低", medium: "中", high: "高" };
const CLI_NATIVE: { id: string; name: string; note: string; tools: { name: string; risk: string; desc: string }[] }[] = [
  {
    id: "claude", name: "Claude Code", note: "由 CLI 自身管理，此处不可开关",
    tools: [
      { name: "Read / Edit / Write", risk: "中", desc: "原生文件读写；受 CLI 权限模式约束" },
      { name: "Bash", risk: "高", desc: "原生命令执行；受 CLI 权限模式约束" },
      { name: "Glob / Grep", risk: "低", desc: "原生文件检索" },
      { name: "WebFetch / WebSearch", risk: "中", desc: "原生网络访问" },
    ],
  },
  {
    id: "codex", name: "Codex", note: "由 CLI 自身管理，此处不可开关",
    tools: [
      { name: "shell", risk: "高", desc: "原生沙箱命令执行" },
      { name: "apply_patch", risk: "中", desc: "原生补丁应用" },
      { name: "read_file", risk: "低", desc: "原生文件读取" },
    ],
  },
  {
    id: "grok", name: "Grok CLI", note: "由 CLI 自身管理，此处不可开关",
    tools: [
      { name: "内置工具集", risk: "中", desc: "由 Grok CLI 自行发现与管理" },
    ],
  },
];

interface TreeGroup {
  id: string;
  name: string;
  kind: "builtin" | "mcp" | "cli";
  note: string;
  tools: { key: string; name: string; risk: string; desc: string; enabled?: boolean; pending?: boolean }[];
}

export function SettingsTool() {
  const toast = useToast();
  const [list, setList] = useState<ToolEntry[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  // CR-059：内置工作台工具（MCP 服务器 workbench）的全局总闸；缺省启用。
  const [builtinOn, setBuiltinOn] = useState(true);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(["nestcraft"]));
  const lock = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [tools, mcpServers, enableValue] = await Promise.all([
        api.toolList(),
        api.mcpList().catch(() => [] as McpServer[]),
        api.getSetting("aiTools.enabled").catch(() => null),
      ]);
      setList(tools);
      setServers(mcpServers);
      setBuiltinOn(enableValue == null ? true : enableValue !== "0");
    } catch (e) { setError(errMsg(e)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const toggle = async (tool: ToolEntry, enabled: boolean) => {
    if (lock.current) return;
    lock.current = true; setPending(tool.name);
    try {
      await api.toolSetEnabled(tool.name, enabled);
      setList(previous => previous.map(entry => entry.name === tool.name ? { ...entry, enabled } : entry));
      window.dispatchEvent(new CustomEvent("app:settings-changed", { detail: { keys: ["tools"] } }));
    } catch (e) { toast(errMsg(e), "err"); } finally { lock.current = false; setPending(null); }
  };
  const toggleBuiltin = async (enabled: boolean) => {
    if (lock.current) return;
    lock.current = true;
    try {
      await api.setSetting("aiTools.enabled", enabled ? "1" : "0");
      setBuiltinOn(enabled);
      window.dispatchEvent(new CustomEvent("app:settings-changed", { detail: { keys: ["tools"] } }));
    } catch (e) { toast(errMsg(e), "err"); } finally { lock.current = false; }
  };

  const toggleGroup = (id: string) => setOpenGroups(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const groups: TreeGroup[] = [
    {
      id: "nestcraft",
      name: "NestCraft 内置",
      kind: "builtin",
      note: "经 workbench MCP 注入会话，开关真实生效",
      tools: list.map(tool => ({
        key: tool.name,
        name: tool.name,
        risk: RISK_LABEL[tool.risk] ?? tool.risk,
        desc: tool.description || "暂无说明",
        enabled: tool.enabled,
      })),
    },
    ...servers.map(server => ({
      id: `mcp:${server.id}`,
      name: server.name,
      kind: "mcp" as const,
      note: server.tools.length ? `${server.tools.length} 个已发现工具` : "尚未发现工具，去测试连接",
      tools: server.tools.map(tool => ({
        key: `mcp:${server.id}:${tool.name}`,
        name: tool.name,
        risk: "中",
        desc: tool.description || "暂无说明",
        // MCP 工具由 CLI 连接服务器后可用，本页只呈现来源与发现结果（无独立开关）。
        enabled: undefined,
      })),
    })),
    ...CLI_NATIVE.map(cli => ({
      id: `cli:${cli.id}`,
      name: cli.name,
      kind: "cli" as const,
      note: cli.note,
      tools: cli.tools.map(tool => ({ key: `cli:${cli.id}:${tool.name}`, ...tool })),
    })),
  ];

  return <>
    <p className="set-caption set-toolbar">
      按提供方分组：哪个工具、哪个服务提供的 tool。内置工具经 workbench MCP 注入会话，开关真实生效；
      不等于原生 CLI 安全门禁已生效。
    </p>
    <div className="set-toolbar set-builtin-switch">
      <div>
        <div className="set-builtin-title">启用 AI 工作台工具（内置 MCP 服务器 workbench）</div>
        <div className="set-caption">关闭后 AI 侧栏不再获得创建项目／需求文档／知识库／服务器等操作能力；下方各工具仍可单独停用。</div>
      </div>
      <SettingsSwitch checked={builtinOn} disabled={pending != null} label="启用 AI 工作台工具" onChange={v => toggleBuiltin(v)} />
    </div>
    {loading && <p className="set-caption">加载工具中…</p>}
    {error && <div className="set-note" role="alert">工具读取失败：{error}<button className="btn sm" onClick={refresh}>重试</button></div>}
    <div className="card tool-tree">{groups.map(group => {
      const open = openGroups.has(group.id);
      const kindTag = group.kind === "builtin"
        ? <span className="tag good">已注入</span>
        : group.kind === "mcp" ? <span className="tag">MCP</span> : <span className="tag">CLI 原生</span>;
      return <div className={`tree-group ${open ? "open" : ""}`} key={group.id}>
        <button className="tree-root" aria-expanded={open} onClick={() => toggleGroup(group.id)}>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
          {group.kind === "cli"
            ? <CliLogo id={group.id.replace("cli:", "")} size={18} />
            : <Icon name={group.kind === "mcp" ? "box" : "workflow"} size={16} />}
          <b>{group.name}</b>
          {kindTag}
          <span className="set-caption">{group.tools.length} 个工具</span>
          <span className="spacer" />
          <span className="set-caption tree-note">{group.note}</span>
        </button>
        {open && <div className="tree-children">
          {group.tools.length ? group.tools.map(tool => <div className="tree-tool" key={tool.key}>
            <span className="mono tree-name">{tool.name}</span>
            <span className={`risk ${RISK_CLASS[tool.risk] ?? ""}`}>{tool.risk}</span>
            <span className="muted tree-desc">{tool.desc}</span>
            {group.kind === "cli"
              ? <span className="tag">只读</span>
              : tool.enabled === undefined
                ? <span className="tag">由 CLI 连接</span>
                : <SettingsSwitch checked={tool.enabled} disabled={pending != null}
                  label={`启用工具 ${tool.name}`}
                  onChange={value => {
                    const entry = list.find(item => item.name === tool.name);
                    if (entry) void toggle(entry, value);
                  }} />}
          </div>) : <div className="tree-empty">
            {group.kind === "mcp" ? "尚未发现工具（在 MCP 列表行测试连接后发现工具）" : "暂无工具"}
          </div>}
        </div>}
      </div>;
    })}</div>
    <p className="set-caption" style={{ marginTop: 10 }}>
      AI 必须可以使用工具：内置 18 项（原有 6 项 fs.read／knowledge.*／ssh-exec 与 workbench 12 项）
      统一经 workbench MCP 通道注入；ssh-exec 保持连接＋授权＋逐次审批门禁。MCP 工具由 CLI 连接对应服务器后可用；
      CLI 原生工具由 CLI 自身管理。
    </p>
  </>;
}
