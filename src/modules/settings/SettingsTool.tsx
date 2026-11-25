import { Icon } from '@/components/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '@/api';
import type { McpServer, ToolEntry } from '@/api';
import { useToast } from '@/components/ui';
import { errMsg } from './shared';
import { SettingsSwitch } from './SettingsDialog';
import { builtinToolCategory } from './capabilityHelpers';
import './cr085-abilities.css';
const RISK_LABEL:Record<string,string>={low:'低',medium:'中',high:'高'};
interface TreeTool {key:string;name:string;risk:string;desc:string;entry?:ToolEntry}
interface Group {id:string;name:string;builtin:boolean;tools:TreeTool[]}
export function SettingsTool(){
 const toast=useToast(),lock=useRef(false);
 const [list,setList]=useState<ToolEntry[]>([]),[servers,setServers]=useState<McpServer[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[pending,setPending]=useState<string|null>(null),[builtinOn,setBuiltinOn]=useState(true),[open,setOpen]=useState<Set<string>>(new Set());
 const refresh=useCallback(async()=>{setLoading(true);setError('');try{const [tools,mcp,value]=await Promise.all([api.toolList(),api.mcpList(),api.getSetting('aiTools.enabled')]);setList(tools);setServers(mcp);setBuiltinOn(value!=='0');}catch(e){setError(errMsg(e));}finally{setLoading(false);}},[]);useEffect(()=>{void refresh();},[refresh]);
 const notify=()=>window.dispatchEvent(new CustomEvent('app:settings-changed',{detail:{keys:['tools']}}));
 const toggle=async(t:ToolEntry,on:boolean)=>{if(lock.current)return;lock.current=true;setPending(t.name);try{await api.toolSetEnabled(t.name,on);setList(p=>p.map(x=>x.name===t.name?{...x,enabled:on}:x));notify();}catch(e){toast(errMsg(e),'err');}finally{lock.current=false;setPending(null);}};
 const toggleAll=async(on:boolean)=>{if(lock.current)return;lock.current=true;setPending('all');try{await api.setSetting('aiTools.enabled',on?'1':'0');setBuiltinOn(on);notify();}catch(e){toast(errMsg(e),'err');}finally{lock.current=false;setPending(null);}};
 const groups:Group[]=['basic','search','requirements','knowledge','servers'].map(id=>({id:'builtin:'+id,name:{basic:'基础',search:'搜索',requirements:'项目与需求',knowledge:'知识库',servers:'服务器'}[id]||id,builtin:true,tools:list.filter(t=>builtinToolCategory(t.name).id===id).map(t=>({key:t.name,name:t.name,risk:t.risk,desc:t.description||'',entry:t}))}));
 groups.push(...servers.map(s=>({id:'mcp:'+s.id,name:s.name,builtin:false,tools:s.tools.map(t=>({key:s.id+':'+t.name,name:t.name,risk:'medium',desc:t.description||''}))})));
 return <><div className="set-toolbar set-builtin-switch"><b>AI 工作台工具</b><SettingsSwitch checked={builtinOn} disabled={pending!==null} label="启用 AI 工作台工具" onChange={v=>void toggleAll(v)}/></div>{loading&&<p className="set-caption">加载工具中…</p>}{error&&<p className="set-err" role="alert">{error}<button className="btn sm" onClick={()=>void refresh()}>重试</button></p>}<div className="card tool-tree cr085-tools">{groups.map(g=><section className="tree-group" key={g.id}><button className="tree-root" aria-expanded={open.has(g.id)} onClick={()=>setOpen(p=>{const n=new Set(p);if(n.has(g.id))n.delete(g.id);else n.add(g.id);return n;})}><Icon name={open.has(g.id)?'chevronDown':'chevronRight'} size={14}/><Icon name={g.builtin?'workflow':'box'} size={16}/><b>{g.name}</b><span className="tag">{g.builtin?'内置':'MCP'}</span><span className="set-caption">{g.tools.length} 个工具</span></button>{open.has(g.id)&&<div className="tree-children">{g.tools.map(t=><div className="tree-tool" key={t.key}><span className="mono tree-name">{t.name}</span><span className={`risk ${t.risk==='high'?'bad':t.risk==='medium'?'warn':''}`}>{RISK_LABEL[t.risk]||t.risk}</span><span className="muted tree-desc">{t.desc}</span>{t.entry&&<SettingsSwitch checked={t.entry.enabled} disabled={pending!==null} label={`启用工具 ${t.name}`} onChange={v=>void toggle(t.entry!,v)}/>}</div>)}{!g.tools.length&&<div className="tree-empty">尚未发现工具{!g.builtin&&<button className="link-btn" onClick={()=>window.dispatchEvent(new CustomEvent('settings:open-tab',{detail:{tab:'mcp'}}))}>验证连接</button>}</div>}</div>}</section>)}</div></>;
}
