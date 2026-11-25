import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, useToast } from "@/components/ui";
import { serverSave, serverTestConnection, type ServerHost } from "@/api";

/**
 * 主机新建/编辑弹窗（CR-075）。
 *
 * - 按内容高度呈现，底栏贴着内容；只有视口不足时正文滚动（UI-CR049-v1 按需滚动条）。
 * - 字段顺序：名称 → 主机地址/端口 → 用户名/分组 → 认证方式 → 凭据。
 * - 底栏左侧"测试连接"：用当前输入（编辑态未改凭据时用已保存凭据）验证，不先保存、不改连接状态。
 * - 不写说明性段落：只保留字段标签、必要占位、字段级校验与测试结果。
 */

type AuthType = "password" | "key" | "none";

interface FieldErrors {
  name?: string;
  host?: string;
  port?: string;
  username?: string;
  password?: string;
  keyPath?: string;
}

type TestState = { phase: "testing" } | { phase: "ok"; os: string } | { phase: "fail"; message: string } | null;

export interface HostFormProps {
  /** 编辑时传入既有主机；新建时不传 */
  initial?: ServerHost | null;
  onClose: () => void;
  onSaved: (host: { os?: string }) => void;
}

export function HostForm({ initial, onClose, onSaved }: HostFormProps) {
  const toast = useToast();
  const editing = !!initial;

  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(String(initial?.port ?? 22));
  const [username, setUsername] = useState(initial?.username ?? "");
  const [authType, setAuthType] = useState<AuthType>(initial?.authType ?? "password");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [groupTag, setGroupTag] = useState(initial?.groupTag ?? "");

  const [errors, setErrors] = useState<FieldErrors>({});
  const [test, setTest] = useState<TestState>(null);
  const [saving, setSaving] = useState(false);

  const alive = useRef(true);
  const busyRef = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** 地址可能写成 user@host；统一拆成主机与用户名。 */
  const parseAddress = (raw: string, user: string) => {
    const at = raw.indexOf("@");
    return {
      host: (at >= 0 ? raw.slice(at + 1) : raw).trim(),
      username: (at >= 0 ? raw.slice(0, at) : user).trim(),
    };
  };

  const parsed = parseAddress(host, username);

  /**
   * 编辑态且认证方式未变、地址/端口/用户名都没改时，凭据留空表示沿用已保存值。
   * 改了目标就必须重新填写，避免把已保存凭据发往新主机。
   */
  const keepsStoredSecret =
    !!editing &&
    !!initial &&
    initial.authType === authType &&
    parsed.host === String(initial.host ?? "").trim() &&
    parsed.username === String(initial.username ?? "").trim() &&
    Number(port) === initial.port;

  /** 地址、端口、用户名、认证方式变化后，上次测试结果不再成立。 */
  const invalidateTest = useCallback(() => {
    setTest((current) => (current && current.phase === "testing" ? current : null));
  }, []);

  const validate = (forTest: boolean): FieldErrors => {
    const next: FieldErrors = {};
    if (!forTest && !name.trim()) next.name = "请填写名称";
    if (!host.trim()) next.host = "请填写主机地址";
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) next.port = "端口需为 1–65535";
    if (!username.trim()) next.username = "请填写用户名";
    if (authType === "password" && !keepsStoredSecret && !password) next.password = "请填写密码";
    if (authType === "key" && !keepsStoredSecret && !keyPath.trim()) next.keyPath = "请填写私钥路径";
    return next;
  };

  const collectDraft = () => {
    return {
      host: parsed.host,
      username: parsed.username,
      port: Number(port),
      authType,
      ...(authType === "password" && password ? { secret: password } : {}),
      ...(authType === "key" && passphrase ? { secret: passphrase } : {}),
      ...(authType === "key" && keyPath.trim() ? { keyPath: keyPath.trim() } : {}),
      ...(editing && initial ? { id: initial.id } : {}),
    };
  };

  const runTest = async () => {
    if (busyRef.current) return;
    const nextErrors = validate(true);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setTest(null);
      return;
    }
    busyRef.current = true;
    setTest({ phase: "testing" });
    try {
      const result = await serverTestConnection(collectDraft());
      if (!alive.current) return;
      setTest({ phase: "ok", os: result.os });
    } catch (e) {
      if (!alive.current) return;
      setTest({ phase: "fail", message: errText(e) });
    } finally {
      busyRef.current = false;
    }
  };

  const submit = async () => {
    if (busyRef.current || saving) return;
    const nextErrors = validate(false);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    busyRef.current = true;
    setSaving(true);
    const testedOs = test?.phase === "ok" ? test.os : undefined;
    try {
      const draft = collectDraft();
      await serverSave({
        ...draft,
        name: name.trim(),
        groupTag: groupTag.trim(),
        ...(testedOs ? { os: testedOs } : {}),
      });
      if (!alive.current) return;
      onSaved({ os: testedOs });
      onClose();
    } catch (e) {
      if (!alive.current) return;
      setErrors({ name: errText(e) });
      toast(errText(e), "err");
    } finally {
      busyRef.current = false;
      if (alive.current) setSaving(false);
    }
  };

  const testing = test?.phase === "testing";
  const locked = saving || testing;

  const err = (key: keyof FieldErrors) => (errors[key] ? <span className="srv-field-err" role="alert">{errors[key]}</span> : null);
  const inputClass = (key: keyof FieldErrors) => `input${errors[key] ? " invalid" : ""}`;

  const testResult = (() => {
    if (!test) return null;
    if (test.phase === "testing") return <span className="srv-test-result"><span className="srv-spin" aria-hidden />正在连接</span>;
    if (test.phase === "ok") return <span className="srv-test-result ok">连接成功 · {test.os}</span>;
    return <span className="srv-test-result fail">{test.message.startsWith("连接") ? test.message : `连接失败：${test.message}`}</span>;
  })();

  return (
    <div className="srv-dialog">
      <Modal
        title={editing ? "编辑主机" : "新建主机"}
        onClose={() => {
          if (!saving) onClose();
        }}
        width={520}
        footer={
          <div className="srv-form-foot">
            <div className="srv-test">
              <button className="btn" type="button" onClick={() => void runTest()} disabled={locked}>
                {testing ? (<><span className="srv-spin" aria-hidden />测试中…</>) : "测试连接"}
              </button>
              {testResult}
            </div>
            <div className="srv-form-acts">
              <button className="btn" onClick={onClose} disabled={saving}>
                取消
              </button>
              <button className="btn primary" onClick={() => void submit()} disabled={locked}>
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        }
      >
        <div className="srv-form">
          <div className="srv-field">
            <label className="srv-label" htmlFor="srv-name">名称</label>
            <input
              id="srv-name"
              className={inputClass("name")}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (errors.name) setErrors((prev) => ({ ...prev, name: undefined }));
              }}
              placeholder="如 生产-web-01"
              autoFocus
            />
            {err("name")}
          </div>

          <div className="srv-row host">
            <div className="srv-field">
              <label className="srv-label" htmlFor="srv-host">主机地址</label>
              <input
                id="srv-host"
                className={`${inputClass("host")} mono`}
                value={host}
                onChange={(e) => {
                  setHost(e.target.value);
                  if (errors.host) setErrors((prev) => ({ ...prev, host: undefined }));
                  invalidateTest();
                }}
                placeholder="192.0.2.10 或 example.com"
              />
              {err("host")}
            </div>
            <div className="srv-field">
              <label className="srv-label" htmlFor="srv-port">端口</label>
              <input
                id="srv-port"
                className={inputClass("port")}
                value={port}
                onChange={(e) => {
                  setPort(e.target.value);
                  if (errors.port) setErrors((prev) => ({ ...prev, port: undefined }));
                  invalidateTest();
                }}
                inputMode="numeric"
              />
              {err("port")}
            </div>
          </div>

          <div className="srv-row">
            <div className="srv-field">
              <label className="srv-label" htmlFor="srv-username">用户名</label>
              <input
                id="srv-username"
                className={inputClass("username")}
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  if (errors.username) setErrors((prev) => ({ ...prev, username: undefined }));
                  invalidateTest();
                }}
                placeholder="root"
              />
              {err("username")}
            </div>
            <div className="srv-field">
              <label className="srv-label" htmlFor="srv-group">分组（可选）</label>
              <input
                id="srv-group"
                className="input"
                value={groupTag}
                onChange={(e) => setGroupTag(e.target.value)}
                placeholder="如 生产环境"
              />
            </div>
          </div>

          <div className="srv-field">
            <span className="srv-label" id="srv-auth-label">认证方式</span>
            <div className="srv-seg" role="group" aria-labelledby="srv-auth-label">
              {(["password", "key", "none"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={authType === value}
                  disabled={saving}
                  onClick={() => {
                    setAuthType(value);
                    setErrors({});
                    setPassword("");
                    setKeyPath("");
                    setPassphrase("");
                    setTest(null);
                  }}
                >
                  {value === "password" ? "密码" : value === "key" ? "私钥" : "免认证"}
                </button>
              ))}
            </div>
          </div>

          {authType === "password" && (
            <div className="srv-field">
              <label className="srv-label" htmlFor="srv-password">密码</label>
              <input
                id="srv-password"
                className={inputClass("password")}
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (errors.password) setErrors((prev) => ({ ...prev, password: undefined }));
                  setTest(null);
                }}
                placeholder={keepsStoredSecret ? "已保存，留空不修改" : "登录密码"}
                autoComplete="new-password"
              />
              {err("password")}
            </div>
          )}

          {authType === "key" && (
            <>
              <div className="srv-field">
                <label className="srv-label" htmlFor="srv-keypath">私钥路径</label>
                <input
                  id="srv-keypath"
                  className={`${inputClass("keyPath")} mono`}
                  value={keyPath}
                  onChange={(e) => {
                    setKeyPath(e.target.value);
                    if (errors.keyPath) setErrors((prev) => ({ ...prev, keyPath: undefined }));
                    setTest(null);
                  }}
                  placeholder={keepsStoredSecret ? "已保存，留空不修改" : "~/.ssh/id_ed25519"}
                />
                {err("keyPath")}
              </div>
              <div className="srv-field">
                <label className="srv-label" htmlFor="srv-passphrase">私钥口令（可选）</label>
                <input
                  id="srv-passphrase"
                  className="input"
                  type="password"
                  value={passphrase}
                  onChange={(e) => {
                    setPassphrase(e.target.value);
                    setTest(null);
                  }}
                  placeholder="可留空"
                  autoComplete="new-password"
                />
              </div>
            </>
          )}
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