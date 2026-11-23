import { useEffect, useRef, useState } from "react";
import { Modal, Field, useToast } from "@/components/ui";
import { serverSave, type ServerHost } from "@/api";

/** 主机新建/编辑弹框（CR-007/CR-014：密码 / 密钥分段认证） */

export interface HostFormProps {
  /** 编辑时传入既有主机；新建时不传 */
  initial?: ServerHost | null;
  onClose: () => void;
  onSaved: () => void;
}

type AuthType = "password" | "key" | "none";

export function HostForm({ initial, onClose, onSaved }: HostFormProps) {
  const toast = useToast();
  const editing = !!initial;

  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(String(initial?.port ?? 22));
  const [username, setUsername] = useState(initial?.username ?? "");
  const [authType, setAuthType] = useState<AuthType>(initial?.authType ?? "password");
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [groupTag, setGroupTag] = useState(initial?.groupTag ?? "");
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const errRef = useRef<HTMLDivElement | null>(null);

  // 表单正文超高时由模态框原生滚动（UI-CR049-v1，不改宽度/不加遮罩）；
  // 校验或保存错误可能落在滚动区之外，这里只把错误滚动到可见位置，不改变输入与草稿。
  useEffect(() => {
    if (formErr) errRef.current?.scrollIntoView({ block: "nearest" });
  }, [formErr]);

  const validate = (): string | null => {
    if (!name.trim()) return "请填写主机名称";
    if (!host.trim()) return "请填写主机地址";
    if (!username.trim()) return "请填写用户名";
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return "端口需为 1-65535 的整数";
    const sameAuth = editing && initial.authType === authType;
    if (authType === "password" && !sameAuth && !password) return "请填写登录密码";
    if (authType === "key" && !sameAuth && !keyPath.trim()) return "请填写私钥路径";
    return null;
  };

  const submit = async () => {
    if (busy.current) return;
    const err = validate();
    setFormErr(err);
    if (err) return;
    busy.current = true;
    setSaving(true);
    try {
      // 编辑时留空凭据字段则不下发，交由后端沿用原值
      await serverSave({
        ...(initial ? { id: initial.id } : {}),
        name: name.trim(),
        host: host.trim(),
        port: Number(port),
        username: username.trim(),
        authType,
        ...(authType === "password" && password ? { secret: password } : {}),
        ...(authType === "key" && passphrase ? { secret: passphrase } : {}),
        ...(authType === "key" && keyPath.trim() ? { keyPath: keyPath.trim() } : {}),
        groupTag: groupTag.trim(),
      });
      onSaved();
      onClose();
    } catch (e) {
      setFormErr(errText(e));
      toast(errText(e), "err");
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="srv-dialog">
      {/* 弹窗按内容高度（不传 heightRatio）：正文超过窗口上限时由 .modal-body 原生滚动，
          取消/保存固定在同屏 footer，不随正文滚出，也不留大片下半空白（UI-CR068 §1.5）。 */}
      <Modal
        title={editing ? "编辑主机" : "新建主机"}
        onClose={() => { if (!saving) onClose(); }}
        width={460}
        footer={
          <>
            <button className="btn" onClick={onClose} disabled={saving}>
              取消
            </button>
            <button className="btn primary" onClick={submit} disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </button>
          </>
        }
      >
        <div className="host-form">
          <fieldset disabled={saving} className="host-fields">
            <div className="grid2">
              <Field label="名称">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如 生产-web-01" autoFocus />
              </Field>
              <Field label="端口">
                <input className="input" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
              </Field>
            </div>
            <div className="grid2">
              <Field label="主机">
                <input className="input mono" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.10 或 example.com" />
              </Field>
              <Field label="用户名">
                <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" />
              </Field>
            </div>
            <Field label="认证方式">
              <div className="segment" role="group" aria-label="认证方式">
                <button type="button" aria-pressed={authType === "password"} onClick={() => setAuthType("password")}>
                  密码
                </button>
                <button type="button" aria-pressed={authType === "key"} onClick={() => setAuthType("key")}>
                  密钥
                </button>
                <button type="button" aria-pressed={authType === "none"} onClick={() => setAuthType("none")}>
                  免认证
                </button>
              </div>
            </Field>
            <div className="auth-fields">
              {authType === "none" ? (
                <Field label="免认证（无凭据）" hint="服务器接受 none 认证时使用；不保存任何密钥或密码">
                  <div className="small muted">该主机将以无凭据方式连接。</div>
                </Field>
              ) : authType === "password" ? (
                <Field label="密码" hint={editing && initial.authType === "password" ? "留空沿用已保存密码，不读取或回传原凭据。" : undefined}>
                  <input
                    className="input"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="登录密码"
                    autoComplete="new-password"
                  />
                </Field>
              ) : (
                <>
                  <Field label="私钥路径" hint={editing && initial.authType === "key" ? "留空沿用已保存私钥路径，不读取或回传原凭据。" : "本机私钥文件的完整路径，不是远端服务器路径"}>
                    <input className="input mono" value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="~/.ssh/id_rsa" />
                  </Field>
                  <Field label="私钥口令（可选）" hint={editing ? "编辑时留空表示不修改口令" : undefined}>
                    <input
                      className="input"
                      type="password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      placeholder="无口令可留空"
                      autoComplete="new-password"
                    />
                  </Field>
                </>
              )}
            </div>
            <Field label="分组标签（可选）">
              <input className="input" value={groupTag} onChange={(e) => setGroupTag(e.target.value)} placeholder="如 生产环境" />
            </Field>
          </fieldset>
          {formErr && <div className="field-err" role="alert" ref={errRef}>{formErr}</div>}
        </div>
      </Modal>
    </div>
  );
}

/** 提取后端/异常的可读错误文案 */
export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error && e.message) return e.message;
  try {
    const s = String((e as { message?: unknown })?.message ?? e);
    return s || "操作失败";
  } catch {
    return "操作失败";
  }
}
