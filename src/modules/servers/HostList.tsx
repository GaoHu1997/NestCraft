import { useCallback, useEffect, useState } from "react";
import { serverList, serverConnect, serverDisconnect, serverDelete, type ServerHost } from "@/api";
import { useToast, Empty, Confirm } from "@/components/ui";
import { useApp } from "@/store/app";
import { HostForm, errText } from "./HostForm";

/** 服务器列表页（CR-007/CR-014 AC-02：单列横向卡片，在全局导航内原地切换） */

export function HostList() {
  const toast = useToast();
  const { openObject } = useApp();

  const [hosts, setHosts] = useState<ServerHost[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ServerHost | null>(null);
  const [delTarget, setDelTarget] = useState<ServerHost | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await serverList();
      setHosts(list);
      setLoadErr(null);
    } catch (e) {
      setLoadErr(errText(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggleConnect = async (h: ServerHost) => {
    if (busyId) return;
    setBusyId(h.id);
    try {
      if (h.connected) {
        await serverDisconnect(h.id);
        toast(`已断开 ${h.name}`);
      } else {
        await serverConnect(h.id);
        toast(`已连接 ${h.name}`);
      }
      await reload();
    } catch (e) {
      // 连接失败不改授权语义：toast 说明原因，保留重试入口
      toast(`${h.connected ? "断开" : "连接"}失败：${errText(e)}`, "err");
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    const h = delTarget;
    if (!h) return;
    setDelTarget(null);
    try {
      await serverDelete(h.id);
      toast(`已删除 ${h.name}`);
      await reload();
    } catch (e) {
      toast(`删除失败：${errText(e)}`, "err");
    }
  };

  return (
    <div className="srv-page">
      <div className="srv-head">
        <div>
          <h2>服务器管理</h2>
          <div className="srv-sub">连接、终端与巡检在同一工作台；高风险命令逐次审批。</div>
        </div>
        <button
          className="btn primary"
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          新建主机
        </button>
      </div>

      {hosts === null && !loadErr && <div className="mon-loading">加载中…</div>}
      {loadErr && (
        <Empty title="主机列表读取失败" desc={loadErr} action={<button className="btn" onClick={() => void reload()}>重试</button>} />
      )}
      {hosts !== null && hosts.length === 0 && (
        <Empty
          title="还没有主机"
          desc="添加一台 SSH 主机后可在此连接并进入工作台"
          action={
            <button
              className="btn primary"
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              新建主机
            </button>
          }
        />
      )}

      <div className="srv-grid">
      {!loadErr && hosts?.map((h) => (
        <div className={`host-card ${h.connected ? "" : "offline"}`} key={h.id}>
          <div className="host-main">
            <div className="host-name-row">
              <button className="host-open" onClick={() => openObject({ page: "server", hostId: h.id })}>{h.name}</button>
              <span className={h.connected ? "tag good" : "tag"}>{h.connected ? "已连接" : "未连接"}</span>
            </div>
            <div className="host-addr-row"><span className="mono">{h.host}:{h.port}</span><span>用户 {h.username}</span></div>
          </div>
          <div className="srv-stats" aria-label="主机指标未知，列表接口未提供">
            {["CPU", "内存", "磁盘"].map((label) => <div key={label}><b>未知</b><span>{label}</span></div>)}
          </div>
          <div className="host-info"><span>{h.groupTag || "未分组"} · {h.authType === "key" ? "密钥" : h.authType === "none" ? "免认证" : "密码"}</span><span>系统未知</span></div>
          <div className="host-actions">
            <button className="btn sm" disabled={busyId !== null} onClick={() => void toggleConnect(h)}>
              {busyId === h.id ? (h.connected ? "断开中…" : "连接中…") : h.connected ? "断开" : "连接"}
            </button>
            <button className="btn sm" onClick={() => openObject({ page: "server", hostId: h.id })}>
              进入工作台
            </button>
            <button
              className="btn ghost sm"
              onClick={() => {
                setEditing(h);
                setFormOpen(true);
              }}
            >
              编辑
            </button>
            <button className="btn danger sm" onClick={() => setDelTarget(h)}>
              删除
            </button>
          </div>
        </div>
      ))}
      </div>
      <div className="srv-page-foot"><span>列表接口未提供资源指标，不自动采样远端主机。</span><span>{hosts ? `${hosts.length} 台 · ${hosts.filter((h) => h.connected).length} 已连接` : "统计未知"}</span></div>

      {formOpen && (
        <HostForm
          initial={editing}
          onClose={() => setFormOpen(false)}
          onSaved={() => {
            toast(editing ? "主机已更新" : "主机已创建");
            void reload();
          }}
        />
      )}

      {delTarget && (
        <div className="srv-dialog srv-confirm"><Confirm
          title="删除主机"
          message={`确定删除主机「${delTarget.name}」（${delTarget.host}:${delTarget.port}）吗？\n删除后该主机的凭据与配置不可恢复。`}
          danger
          onOk={() => void confirmDelete()}
          onCancel={() => setDelTarget(null)}
        /></div>
      )}
    </div>
  );
}
