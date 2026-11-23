import { Icon } from "@/components/icons";
import { useEffect, useState } from "react";
import type * as api from "@/api";
import type { ModelCandidate } from "@/api";
import { EFFORT_LEVELS } from "./shared";

/**
 * CR-059 D3：CLI 任务模型路由（单行折叠）。
 *
 * 规则（CR-059 §4.4，UI-CR059-v6 SC-059-07）：
 * - 整块只有一个折叠行：行首为「兜底模型」「模型1…模型5」切换标签，未达上限时末尾有「＋新增」，
 *   行尾为 `N/5`（0 个时「仅兜底」）与折叠箭头；默认收起并选中兜底；
 * - 点行/箭头展开其下方唯一详情区；点标签切换详情并保证展开；同一时刻只渲染当前标签；
 * - 模型标签悬浮（或键盘聚焦）时右侧出现 ×，点击即删除；兜底标签永不出现 ×；
 * - 模型标签＝模型下拉（协议兼容过滤）＋思考等级＋13 类任务 chips＋删除；兜底＝模型下拉＋思考等级＋说明；
 * - 槽位为变长数组 0～5，顺序即路由优先级；兜底实时跟随主 agent（本组件不写死主 agent 选择）。
 */

export const TASK_TYPES = [
  "仓库探索", "代码定位", "资料检索", "方案核验", "影响分析", "功能开发", "缺陷修复",
  "测试验证", "代码审查", "数据处理", "模块重构", "方案设计", "文档整理",
] as const;

export const MAX_SLOTS = 5;

export interface RouteSlot {
  model: string;
  effort: string;
  types: string[];
}

export interface RouteFallback {
  model: string;
  effort: string;
}

export interface RouteConfig {
  slots: RouteSlot[];
  fallback: RouteFallback;
}

export const emptyRoute = (): RouteConfig => ({ slots: [], fallback: { model: "", effort: "" } });

/** 读取旧偏好：丢弃空槽；超过 5 项保留前 5 项（CR-059 §4.4 配置结构变更）。 */
export function parseRoute(raw: unknown): { route: RouteConfig; trimmed: boolean } {
  const value = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
  const slotSource = Array.isArray(value.slots) ? value.slots : [];
  const slots: RouteSlot[] = [];
  for (const item of slotSource) {
    if (!item || typeof item !== "object") continue;
    const slot = item as Record<string, unknown>;
    const model = typeof slot.model === "string" ? slot.model.trim() : "";
    const effort = typeof slot.effort === "string" ? slot.effort.trim() : "";
    const types = Array.isArray(slot.types) ? slot.types.filter((t): t is string => typeof t === "string") : [];
    // 旧数据里的空槽（模型空、无任务类型、无档位）直接丢弃，不占位。
    if (!model && !types.length && !effort) continue;
    slots.push({ model, effort, types });
    if (slots.length >= MAX_SLOTS) break;
  }
  const fallbackRaw = (value.fallback && typeof value.fallback === "object" && !Array.isArray(value.fallback))
    ? value.fallback as Record<string, unknown> : {};
  return {
    route: {
      slots,
      fallback: {
        model: typeof fallbackRaw.model === "string" ? fallbackRaw.model.trim() : "",
        effort: typeof fallbackRaw.effort === "string" ? fallbackRaw.effort.trim() : "",
      },
    },
    trimmed: slotSource.length > slots.length,
  };
}

const modelValue = (m: ModelCandidate) => `${m.providerId}/${m.modelId}`;

function ModelSelect(props: {
  value: string; models: ModelCandidate[]; label: string; placeholder: string;
  disabled: boolean; onChange: (value: string) => void;
}) {
  const stale = !!props.value && !props.models.some(m => modelValue(m) === props.value);
  return <select className="select" aria-label={props.label} value={props.value} disabled={props.disabled}
    onChange={event => props.onChange(event.target.value)}>
    <option value="">{props.placeholder}</option>
    {stale && <option value={props.value}>已保存模型不可用</option>}
    {props.models.map(m => <option key={modelValue(m)} value={modelValue(m)}>{m.providerName} · {m.displayName}</option>)}
  </select>;
}

function EffortSelect(props: { label: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const known = (EFFORT_LEVELS as readonly string[]).includes(props.value);
  return <select className="select" aria-label={props.label} value={props.value} disabled={props.disabled}
    onChange={event => props.onChange(event.target.value)}>
    <option value="">沿用会话</option>
    {props.value && !known && <option value={props.value}>已保存档位不可用</option>}
    {EFFORT_LEVELS.map(level => <option key={level} value={level}>{level}</option>)}
  </select>;
}

export function CliRoute(props: {
  cliId: string;
  cliName: string;
  route: RouteConfig;
  models: ModelCandidate[];
  disabled: boolean;
  onChange: (next: RouteConfig) => void;
}) {
  const { route, models, disabled } = props;
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string>("fallback");
  const atLimit = route.slots.length >= MAX_SLOTS;
  const slotIndex = selected === "fallback" ? -1 : Number(selected);
  const slot = slotIndex >= 0 ? route.slots[slotIndex] ?? null : null;

  // 删除后选中归位：原位置，越界取末位；无槽只能停在兜底。
  useEffect(() => {
    if (selected === "fallback") return;
    const index = Number(selected);
    if (!Number.isFinite(index) || index >= route.slots.length) {
      setSelected(route.slots.length ? String(route.slots.length - 1) : "fallback");
    }
  }, [route.slots.length, selected]);

  const updateSlot = (index: number, patch: Partial<RouteSlot>) =>
    props.onChange({ ...route, slots: route.slots.map((item, i) => i === index ? { ...item, ...patch } : item) });
  const removeSlot = (index: number) => {
    if (disabled) return;
    const slots = route.slots.filter((_, i) => i !== index);
    props.onChange({ ...route, slots });
    setSelected(slots.length ? String(Math.min(index, slots.length - 1)) : "fallback");
  };
  const addSlot = () => {
    if (atLimit || disabled) return;
    const slots = [...route.slots, { model: "", effort: "", types: [] }];
    props.onChange({ ...route, slots });
    setSelected(String(slots.length - 1));
    setOpen(true);
  };

  const renderTab = (key: string, label: string, removable: boolean) => <span key={key} className="route-tab-wrap">
    <button type="button" role="tab" aria-selected={selected === key}
      className={`route-tab ${selected === key ? "on" : ""} ${removable ? "removable" : ""}`}
      disabled={disabled}
      onClick={() => { setSelected(key); setOpen(true); }}>{label}</button>
    {removable && <button type="button" className="route-x"
      tabIndex={-1} title={`删除${label}`} aria-label={`删除${label}`} disabled={disabled}
      onClick={event => { event.stopPropagation(); removeSlot(Number(key)); }}>
      <Icon name="close" size={11} />
    </button>}
  </span>;

  return <div className={`route-card ${open ? "open" : ""}`}>
    <div className="route-bar">
      <div className="route-tabs" role="tablist" aria-label={`${props.cliName} 任务模型路由`}>
        {renderTab("fallback", "兜底模型", false)}
        {route.slots.map((_, index) => renderTab(String(index), `模型${index + 1}`, true))}
        {!atLimit && <button type="button" className="route-add" disabled={disabled}
          title="新增模型槽（最多 5 个）" aria-label="新增模型槽" onClick={addSlot}>
          <Icon name="plus" size={12} />新增
        </button>}
      </div>
      <span className="spacer" />
      <span className="route-sum">{route.slots.length ? `${route.slots.length}/${MAX_SLOTS}` : "仅兜底"}</span>
      <button type="button" className="route-toggle" aria-expanded={open} disabled={disabled}
        aria-label={open ? "收起模型配置" : "展开模型配置"} onClick={() => setOpen(value => !value)}>
        <Icon name={open ? "chevronUp" : "chevronDown"} size={14} />
      </button>
    </div>
    {open && <div className="route-detail">
      {selected === "fallback" ? <>
        <div className="two-col">
          <div><label>兜底模型</label>
            <ModelSelect value={route.fallback.model} models={models} label="兜底模型" placeholder="跟随主 agent"
              disabled={disabled}
              onChange={model => props.onChange({ ...route, fallback: { ...route.fallback, model } })} /></div>
          <div><label>思考等级</label>
            <EffortSelect label="兜底思考等级" value={route.fallback.effort} disabled={disabled}
              onChange={effort => props.onChange({ ...route, fallback: { ...route.fallback, effort } })} /></div>
        </div>
        <p className="route-note">任一模型槽不可用时使用；默认与主 agent 当前选择一致（实时跟随）。兜底模型不可删除。</p>
      </> : slot ? <>
        <div className="two-col">
          <div><label>模型</label>
            <ModelSelect value={slot.model} models={models} label="模型槽模型" placeholder="未选择" disabled={disabled}
              onChange={model => updateSlot(slotIndex, { model })} /></div>
          <div><label>思考等级</label>
            <EffortSelect label="模型槽思考等级" value={slot.effort} disabled={disabled}
              onChange={effort => updateSlot(slotIndex, { effort })} /></div>
        </div>
        <div><label>执行任务类型</label>
          <div className="chips">{TASK_TYPES.map(type => <button key={type} type="button" disabled={disabled}
            className={`chip ${slot.types.includes(type) ? "on" : ""}`}
            aria-pressed={slot.types.includes(type)}
            onClick={() => updateSlot(slotIndex, {
              types: slot.types.includes(type) ? slot.types.filter(t => t !== type) : [...slot.types, type],
            })}>{type}</button>)}</div>
        </div>
        <div className="route-detail-f">
          <button type="button" className="link-btn danger" disabled={disabled}
            onClick={() => removeSlot(slotIndex)}>
            <Icon name="trash" size={13} />删除此模型槽
          </button>
        </div>
      </> : <p className="caption">该模型槽已删除。</p>}
    </div>}
  </div>;
}

/** CLI 权限挡位（CR-059 D4）：文案与 AI 侧栏一致；auto/full 在原生通道核验前禁用。 */
export const PERMISSION_OPTIONS: { id: string; name: string; enabled: boolean; reason?: string }[] = [
  { id: "default", name: "默认模式", enabled: true },
  { id: "plan", name: "规划模式", enabled: true },
  { id: "agent", name: "代理模式", enabled: true },
  { id: "auto", name: "自动审核", enabled: false, reason: "原生审查通道未核验" },
  { id: "full", name: "完全访问", enabled: false, reason: "隔离与托管策略未核验" },
];

export function PermissionSelect(props: { cliId: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const known = PERMISSION_OPTIONS.some(option => option.id === props.value);
  return <select className="select" aria-label={`${props.cliId} 权限模式`} value={props.value} disabled={props.disabled}
    onChange={event => props.onChange(event.target.value)}>
    {!known && props.value && <option value={props.value}>{props.value}</option>}
    {PERMISSION_OPTIONS.map(option => <option key={option.id} value={option.id} disabled={!option.enabled}>
      {option.name}{option.enabled ? "" : `（${option.reason}）`}
    </option>)}
  </select>;
}

/** 首帧缓存 + 后台并发刷新（CR-059 D5）时单 CLI 的检测状态。 */
export interface CliDetection { state: api.SdkState; checking: boolean; error: string }
