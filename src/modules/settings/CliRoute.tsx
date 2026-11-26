import { Icon } from "@/components/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import type * as api from "@/api";
import type { ModelCandidate } from "@/api";
import { EFFORT_ORDER } from "./modelCapacity";
import { permissionOptions as cliPermissionOptions } from "./cliCapabilities";

/**
 * CR-059 D3：CLI 任务模型路由（单行折叠）。
 *
 * 规则（CR-059 §4.4，UI-CR059-v6 SC-059-07；CR-068 C01 增补折叠切换）：
 * - 整块只有一个折叠行：行首为「兜底模型」「模型1…模型5」切换标签，未达上限时末尾有「＋新增」，
 *   行尾为 `N/5`（0 个时「仅兜底」）与折叠箭头；默认收起并选中兜底；
 * - 点行/箭头展开其下方唯一详情区；点已选中标签＝收起/展开切换，点其它标签＝切换详情并保证展开；
 *   同一时刻只渲染当前标签；
 * - 折叠只改可见性：已选标签、未保存草稿（route 由调用方持有）与折叠前焦点都不丢失；
 * - 模型标签悬浮（或键盘聚焦）时右侧出现 ×，点击即删除；兜底标签永不出现 ×；
 * - 模型标签＝模型下拉（协议兼容过滤）＋思考等级＋13 类任务 chips＋删除；兜底＝模型下拉＋思考等级＋说明；
 * - 模型候选只读调用方传入的 `models`（已按 CLI 协议与模型模态过滤）；已保存值不在候选中时
 *   显示「已保存模型不可用」并保留原值，不静默清空；
 * - 槽位为变长数组 0～5，顺序即路由优先级；兜底实时跟随主 agent（本组件不写死主 agent 选择）。
 *   本组件只落配置结构与界面，不消费路由，更不代表调度已生效。
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

/**
 * CR-068 C02：候选只来自调用方过滤后的 `models`（协议＋模态），本组件不再另立来源；
 * 已保存值不在候选中时补一条「已保存模型不可用」并保留该值，绝不静默清空或回落到其它模型。
 */
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

function EffortSelect(props: {
  label: string; value: string; disabled: boolean; options: string[];
  /** 无选项时展示的原因（未选模型／模型未配置档位／跟随主 agent）。 */
  emptyHint?: string;
  onChange: (value: string) => void;
}) {
  const known = props.options.includes(props.value);
  const unavailable = !props.options.length;
  return <select className="select" aria-label={props.label} value={props.value}
    disabled={props.disabled || unavailable}
    title={unavailable ? props.emptyHint : undefined}
    onChange={event => props.onChange(event.target.value)}>
    <option value="" disabled={unavailable}>{unavailable ? (props.emptyHint || "所选模型未配置思考档位") : "沿用会话"}</option>
    {props.value && !known && !unavailable && <option value={props.value}>已保存档位不可用</option>}
    {props.options.map(level => <option key={level} value={level}>{level}</option>)}
  </select>;
}

/**
 * 取所选模型真实配置的思考档位：键序按七档阶梯，未知自定义档位稳定排后。
 * `null` 值表示该档有效但不下发参数，仍然是可选档位。
 */
export function effortOptionsOf(models: ModelCandidate[], value: string): string[] {
  const target = models.find(item => modelValue(item) === value);
  if (!target) return [];
  const efforts = target.efforts ?? {};
  const rank = (key: string) => {
    const index = (EFFORT_ORDER as readonly string[]).indexOf(key);
    return index < 0 ? EFFORT_ORDER.length : index;
  };
  return Object.keys(efforts)
    .filter(key => key.length > 0 && (efforts[key] === null || (typeof efforts[key] === "string" && !!efforts[key]?.trim())))
    .sort((a, b) => rank(a) - rank(b));
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
  const detailRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
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

  const focusTab = useCallback((key: string) => { tabRefs.current.get(key)?.focus(); }, []);

  // 兜底：详情区卸载若把焦点交给 body（部分浏览器点击按钮不聚焦），折回当前标签，不让折叠丢焦点。
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) {
      const active = document.activeElement;
      if (!active || active === document.body) focusTab(selected);
    }
    wasOpen.current = open;
  }, [open, selected, focusTab]);

  /** 折叠前若焦点在详情区，先移回当前标签，避免详情卸载后焦点掉到 body。 */
  const collapse = () => {
    const active = document.activeElement as HTMLElement | null;
    if (detailRef.current && active && detailRef.current.contains(active)) focusTab(selected);
    setOpen(false);
  };

  /** CR-068 C01：点已选中标签＝收起/展开切换；切到其它标签＝切换详情并保证展开。 */
  const selectTab = (key: string) => {
    if (selected === key) {
      if (open) collapse(); else setOpen(true);
      return;
    }
    setSelected(key);
    setOpen(true);
  };

  const updateSlot = (index: number, patch: Partial<RouteSlot>) =>
    props.onChange({ ...route, slots: route.slots.map((item, i) => i === index ? { ...item, ...patch } : item) });
  const removeSlot = (index: number) => {
    if (disabled) return;
    const slots = route.slots.filter((_, i) => i !== index);
    const next = slots.length ? String(Math.min(index, slots.length - 1)) : "fallback";
    // 触发删除的 × / 详情按钮会随重排卸载：先把焦点交给新的选中标签，不把焦点丢到 body。
    const active = document.activeElement as HTMLElement | null;
    if (active && (active.closest(".route-x") || detailRef.current?.contains(active))) focusTab(next);
    props.onChange({ ...route, slots });
    setSelected(next);
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
      ref={node => { if (node) tabRefs.current.set(key, node); else tabRefs.current.delete(key); }}
      className={`route-tab ${selected === key ? "on" : ""} ${removable ? "removable" : ""}`}
      disabled={disabled}
      onClick={() => selectTab(key)}>{label}</button>
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
        aria-label={open ? "收起模型配置" : "展开模型配置"} onClick={() => (open ? collapse() : setOpen(true))}>
        <Icon name={open ? "chevronUp" : "chevronDown"} size={14} />
      </button>
    </div>
    {open && <div className="route-detail" ref={detailRef}>
      {selected === "fallback" ? <>
        <div className="two-col">
          <div><label>兜底模型</label>
            <ModelSelect value={route.fallback.model} models={models} label="兜底模型" placeholder="跟随主 agent"
              disabled={disabled}
              onChange={model => {
                // 跟随主 agent（空值）时思考档位由主 agent 决定；指定模型后只保留该模型支持的档位。
                const options = model ? effortOptionsOf(models, model) : [];
                const effort = options.includes(route.fallback.effort) ? route.fallback.effort : "";
                props.onChange({ ...route, fallback: { ...route.fallback, model, effort } });
              }} /></div>
          <div><label>思考等级</label>
            <EffortSelect label="兜底思考等级" value={route.fallback.effort} disabled={disabled}
              options={effortOptionsOf(models, route.fallback.model)}
              emptyHint={route.fallback.model ? "所选模型未配置思考档位" : "跟随主 agent"}
              onChange={effort => props.onChange({ ...route, fallback: { ...route.fallback, effort } })} /></div>
        </div>
        <p className="route-note">任一模型槽不可用时使用；默认与主 agent 当前选择一致，思考档位同样跟随。</p>
      </> : slot ? <>
        <div className="two-col">
          <div><label>模型</label>
            <ModelSelect value={slot.model} models={models} label="模型槽模型" placeholder="未选择" disabled={disabled}
              onChange={model => {
                const options = model ? effortOptionsOf(models, model) : [];
                const effort = options.includes(slot.effort) ? slot.effort : "";
                updateSlot(slotIndex, { model, effort });
              }} /></div>
          <div><label>思考等级</label>
            <EffortSelect label="模型槽思考等级" value={slot.effort} disabled={disabled}
              options={effortOptionsOf(models, slot.model)}
              emptyHint={slot.model ? "所选模型未配置思考档位" : "先选择模型"}
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

/** CLI 权限挡位（CR-099）：按各 CLI 自身能力提供，与 AI 侧栏同源（cliCapabilities）。
 *  不可用的档位**不出现**，而不是留一个灰项——灰项既不可选又无解释。
 *  档位与 Rust 侧 `validate_permission` 白名单、`spawn_cli` 参数映射保持一致。 */
export const PERMISSION_OPTIONS = cliPermissionOptions("claude");

export function PermissionSelect(props: { cliId: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const options = cliPermissionOptions(props.cliId);
  const usable = options.filter(option => option.enabled);
  const known = usable.some(option => option.id === props.value);
  const current = usable.find(option => option.id === props.value);
  return <>
    <select className="select" aria-label={`${props.cliId} 权限模式`} value={props.value} disabled={props.disabled}
      onChange={event => props.onChange(event.target.value)}>
      {!known && props.value && <option value={props.value}>{props.value}（原权限已失效）</option>}
      {usable.map(option => <option key={option.id} value={option.id}>{option.name}{option.risk ? "（高风险）" : ""}</option>)}
    </select>
    {current && <p className="set-caption cr099-perm-desc">{current.desc}</p>}
  </>;
}

/** 首帧缓存 + 后台并发刷新（CR-059 D5）时单 CLI 的检测状态。 */
export interface CliDetection { state: api.SdkState; checking: boolean; error: string }
