import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "@/api";
import type { ImageGenConfig } from "@/api";
import { Field, useToast } from "@/components/ui";
import { errMsg } from "./shared";
import { SettingsDialog, SettingsIcon, SettingsSwitch } from "./SettingsDialog";
import "./cr085-models.css";

/**
 * CR-059 G4：生图配置（多模型有序、失败自动顺延、作为 generate_image 工具提供给 AI）。
 * 端点与密钥复用所选模型所属供应商的配置，不单独填写。
 */
export function SettingsImageGen({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [config, setConfig] = useState<ImageGenConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const dragRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setConfig(await api.imageGenGet()); }
    catch (e) { setError(errMsg(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const patch = (next: Partial<ImageGenConfig>) => setConfig(prev => prev ? { ...prev, ...next } : prev);
  const moveTo = (from: number, to: number) => {
    if (!config || from === to) return;
    const order = [...config.order];
    const [item] = order.splice(from, 1);
    order.splice(to, 0, item);
    patch({ order });
  };
  const save = async () => {
    if (!config || lock.current) return;
    lock.current = true; setBusy(true);
    try {
      await api.imageGenSave(config);
      onSaved(); onClose();
    } catch (e) { toast(errMsg(e), "err"); }
    finally { lock.current = false; setBusy(false); }
  };

  const candidateOf = (key: string) => config?.candidates.find(c => c.key === key);
  const unused = config ? config.candidates.filter(c => !config.order.includes(c.key)) : [];

  return <SettingsDialog
    title="生图配置"
    busy={busy}
    width={620}
    onClose={onClose}
    footer={<><button className="btn" disabled={busy} onClick={onClose}>取消</button><button className="btn primary" disabled={busy || loading || !!error} onClick={save}>{busy ? "保存中…" : "保存"}</button></>}
  >
    {loading && <p className="set-caption">读取生图配置…</p>}
    {error && <div className="set-note" role="alert">生图配置读取失败：{error}<button className="btn sm" onClick={load}>重试</button></div>}
    {config && <>
      <div className="row"><b>生图</b><span className="spacer" /><span className="set-caption">{config.enabled ? "已开启 · 工具已注册" : "已关闭 · 工具注销"}</span><SettingsSwitch checked={config.enabled} label="生图总开关" disabled={busy} onChange={enabled => patch({ enabled })} /></div>

      <div className="set-imagegen-section"><b>生图模型（按顺序尝试，第一个失败自动用下一个）</b>
        <div className="set-imagegen-list">
          {config.order.map((key, index) => {
            const candidate = candidateOf(key);
            return <div key={key} className="set-imagegen-row" draggable
              onDragStart={() => { dragRef.current = index; }}
              onDragOver={e => e.preventDefault()}
              onDrop={() => { if (dragRef.current != null) moveTo(dragRef.current, index); dragRef.current = null; }}>
              <span className="set-drag" title="拖动排序"><SettingsIcon name="drag" /></span>
              <span className="set-imagegen-rank">{index + 1}</span>
              <span className="set-imagegen-main">
                <b>{candidate ? `${candidate.providerName} · ${candidate.displayName}` : key}</b>
                <span className="mono set-caption">{key}</span>
              </span>
              {candidate && !candidate.supported
                ? <span className="tag warn" title="Anthropic 端点不提供 images 接口，运行时会跳过">端点不支持</span>
                : index === 0 ? <span className="tag good">首选</span> : <span className="tag">备选 {index}</span>}
              <button className="set-icon-btn" aria-label={`移出生图列表 ${key}`} disabled={busy || config.order.length <= 1}
                title={config.order.length <= 1 ? "至少保留一个生图模型" : "移出"}
                onClick={() => patch({ order: config.order.filter(k => k !== key) })}><SettingsIcon name="close" /></button>
            </div>;
          })}
          {!config.order.length && <p className="set-caption set-pad">还没有生图模型；从下方候选添加，或先在供应商模型中把模态标为「生图」。</p>}
        </div>
        {config.unavailable.length > 0 && <p className="set-caption warn-text">以下模型已不可用（供应商或模型被删除），保存时会被忽略：{config.unavailable.join("、")}</p>}
        {unused.length > 0 && <div className="set-imagegen-candidates"><span className="set-caption">候选（模态已标生图）：</span>
          {unused.map(c => <button key={c.key} className="set-chip" disabled={busy} title={c.supported ? c.modelId : "Anthropic 端点不提供 images 接口"} onClick={() => patch({ order: [...config.order, c.key] })}>{c.providerName} · {c.displayName}</button>)}
        </div>}
      </div>

      <div className="set-imagegen-section"><b>默认参数</b>
        <div className="set-form-grid four">
          <Field label="尺寸"><select className="select" value={config.defaults.size} onChange={e => patch({ defaults: { ...config.defaults, size: e.target.value } })}>{["1024x1024", "2048x2048", "4096x4096"].map(s => <option key={s}>{s}</option>)}</select></Field>
          <Field label="质量"><select className="select" value={config.defaults.quality} onChange={e => patch({ defaults: { ...config.defaults, quality: e.target.value } })}>{["low", "medium", "high", "auto"].map(q => <option key={q}>{q}</option>)}</select></Field>
          <Field label="数量 n"><select className="select" value={config.defaults.n} onChange={e => patch({ defaults: { ...config.defaults, n: Number(e.target.value) } })}>{[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}</select></Field>
          <Field label="超时"><select className="select" value={config.defaults.timeoutMin} onChange={e => patch({ defaults: { ...config.defaults, timeoutMin: Number(e.target.value) } })}>{[5, 10, 15, 30, 60].map(t => <option key={t} value={t}>{t} 分钟</option>)}</select></Field>
        </div>
      </div>

      <div className="set-imagegen-section"><b>输出目录</b>
        <input className="input mono" value={config.outputDir} aria-label="输出目录" onChange={e => patch({ outputDir: e.target.value })} />
      </div>

    </>}
  </SettingsDialog>;
}
