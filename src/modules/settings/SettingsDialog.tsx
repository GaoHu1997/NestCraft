import { Icon } from "@/components/icons";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

export function SettingsDialog({ title, children, footer, onClose, width = 580, busy = false }: {
  title: string; subtitle?: string; children: ReactNode; footer?: ReactNode; onClose: () => void; width?: number; busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  return <dialog ref={ref} className="set-sub-dialog" style={{ width }} onCancel={(e) => { e.preventDefault(); e.stopPropagation(); if (!busy) onClose(); }} onMouseDown={(e) => {
    e.stopPropagation();
    if (busy || e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) onClose();
  }} aria-label={title}>
    <div className="set-dialog-head"><div><h2>{title}</h2></div><button className="set-icon-btn" aria-label={`关闭${title}`} disabled={busy} onClick={onClose}><SettingsIcon name="close" /></button></div>
    <div className="set-dialog-body">{children}</div>
    {footer && <div className="set-dialog-foot" role="group" aria-label={`${title}操作`}>{footer}</div>}
  </dialog>;
}

export function SettingsConfirm({ title, message, onOk, onCancel, busy = false }: {
  title: string; message: string; onOk: () => void; onCancel: () => void; busy?: boolean;
}) {
  return <SettingsDialog title={title} width={460} onClose={onCancel} busy={busy} footer={<><button className="btn" disabled={busy} onClick={onCancel}>取消</button><button className="btn danger" disabled={busy} onClick={onOk}>{busy ? "处理中…" : "确认"}</button></>}><p>{message}</p></SettingsDialog>;
}

export function SettingsIcon({ name }: { name: string }) {
  return <Icon name={name} className="set-icon" aria-hidden="true" />;
}

export function SettingsSwitch({ checked, onChange, label, disabled = false, title }: {
  checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean; title?: string;
}) {
  return <button className="switch" type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} title={title} onClick={() => onChange(!checked)} />;
}
