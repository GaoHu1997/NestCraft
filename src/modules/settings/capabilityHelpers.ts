import type { McpServer, SkillEntry } from '@/api';
import { invoke } from '@/api';

export type ManagedSkill = SkillEntry & { displayName?: string };
export interface ManagedSkillDraft { name: string; description: string; content: string; originalName?: string; displayName?: string; fullContent?: boolean }
export const managedSkillList = async (): Promise<ManagedSkill[]> => {
  const entries = await invoke<SkillEntry[]>('skill_list');
  return Promise.all(entries.map(async entry => ({ ...entry, displayName: await invoke<string|null>('get_setting',{key:`skill.displayName.${entry.name}`}).catch(()=>null) || entry.name })));
};
export const saveManagedSkill = (draft: ManagedSkillDraft) => invoke<void>('skill_save', { draft });

/** Each line is one argv entry; JSON strings encode empty strings, whitespace edges and literal newlines. */
export function formatArgs(args: string[]): string {
  return args.map(value => !value || /^\s|\s$|[\r\n]/.test(value) || value.startsWith('"') ? JSON.stringify(value) : value).join('\n');
}
export function parseArgs(text: string): string[] {
  return text.split(/\r?\n/).filter(line => line.trim() !== '').map((line, index) => {
    if (!line.startsWith('"')) return line;
    try { const value: unknown = JSON.parse(line); if (typeof value === 'string') return value; } catch { /* Literal unmatched quote remains a literal argv value. */ }
    throw new Error(`参数第 ${index + 1} 行的 JSON 字符串无效`);
  });
}
export function formatEnv(env: Record<string, string>): string {
  return Object.entries(env).map(([key, value]) => `${key}=${/[\r\n]/.test(value) || value.startsWith('"') ? JSON.stringify(value) : value}`).join('\n');
}
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = Object.create(null);
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const at = line.indexOf('='), key = line.slice(0, at).trim();
    if (at < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`环境变量第 ${index + 1} 行需为 KEY=value`);
    const raw = line.slice(at + 1);
    if (raw.startsWith('"')) { try { const value: unknown = JSON.parse(raw); if (typeof value === 'string') { env[key] = value; return; } } catch { /* Error below, keep form untouched. */ } throw new Error(`环境变量第 ${index + 1} 行的 JSON 字符串无效`); }
    env[key] = raw;
  });
  return env;
}
export interface McpForm {
  id?: string; name: string; transport: 'stdio' | 'http'; commandLine: string; argsText: string; envText: string; url: string; enabled: boolean;
  authMode: 'oauth' | 'bearer' | 'none'; authToken: string; allowInsecureLocalTls: boolean;
}
export const emptyMcpForm = (): McpForm => ({ name:'',transport:'stdio',commandLine:'',argsText:'',envText:'',url:'',enabled:true,authMode:'oauth',authToken:'',allowInsecureLocalTls:false });
export function formFromConfig(value: Record<string, unknown>, fallbackName: string): McpForm {
  const args = value.args ?? [], env = value.env ?? {}, command = value.command, url = value.url;
  if (command != null && typeof command !== 'string') throw new Error('command 必须是字符串');
  if (url != null && typeof url !== 'string') throw new Error('url 必须是字符串');
  if (!Array.isArray(args) || args.some(x => typeof x !== 'string')) throw new Error('args 必须为字符串数组');
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some(x => typeof x !== 'string')) throw new Error('env 必须是字符串值对象');
  const wire = value.transport ?? value.type ?? (url ? 'http' : 'stdio');
  if (!['stdio','http','streamable-http','streamable_http'].includes(String(wire))) throw new Error('仅支持 STDIO 或 HTTP');
  const transport = wire === 'stdio' ? 'stdio' : 'http';
  return { ...emptyMcpForm(), name: typeof value.name === 'string' ? value.name : fallbackName, transport,
    commandLine: typeof command === 'string' ? command : '', argsText:formatArgs(args as string[]),envText:formatEnv(env as Record<string,string>),
    url: typeof url === 'string' ? url : '', enabled:value.enabled !== false && value.disabled !== true,
    authMode:value.authMode === 'bearer' || value.authMode === 'none' ? value.authMode : 'oauth',
    authToken:typeof value.authToken === 'string' ? value.authToken : '',allowInsecureLocalTls:value.allowInsecureLocalTls === true };
}
export function formFromMcp(server: McpServer): McpForm {
  return { ...formFromConfig(server as unknown as Record<string,unknown>, server.name),id:server.id,authToken:'' };
}
export function parseMcpJson(text: string): Record<string,McpForm> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('JSON 格式错误，请检查括号、引号与逗号'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须为 JSON 对象');
  const root=value as Record<string,unknown>, forms:Record<string,McpForm>=Object.create(null);
  if ('command' in root || 'url' in root) { const name=typeof root.name === 'string' ? root.name : 'imported-server';forms[name]=formFromConfig(root,name); }
  else { const entries=root.mcpServers ?? root.mcp_servers ?? root.servers;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('缺少 mcpServers 或单个服务器配置');
    for (const [name, config] of Object.entries(entries)) { if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${name}：配置必须为对象`); try { forms[name]=formFromConfig(config as Record<string,unknown>,name); } catch(e) { throw new Error(`${name}：${e instanceof Error ? e.message : '配置无效'}`); } }
  }
  if (!Object.keys(forms).length || Object.keys(forms).length > 100) throw new Error('一次可导入 1–100 个服务器');
  return forms;
}
export function builtinToolCategory(name: string): { id:string; name:string } {
  if (/^(fs\.(grep|glob)|web\.(search|fetch))/.test(name)) return {id:'search',name:'搜索'};
  if (/^(knowledge\.|workbench\.(list_kbs|create_kb|set_kb_grant))/.test(name)) return {id:'knowledge',name:'知识库'};
  if (/ssh|server/.test(name)) return {id:'servers',name:'服务器'};
  if (/project|requirement|dispatch_work/.test(name)) return {id:'requirements',name:'项目与需求'};
  return {id:'basic',name:'基础'};
}
