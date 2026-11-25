import { useCallback, useEffect, useState } from "react";
import { serverList, serverDelete, serverDisconnect, type ServerHost } from "@/api";
import { Icon } from "@/components/icons";
import { useToast, Empty, Confirm } from "@/components/ui";
import { useApp } from "@/store/app";
import { HostForm, errText } from "./HostForm";
import { hostAddress, lastSeenText, osLabel, osLogoSrc, pctText } from "./hostVisual";

/**
 * 服务器列表（CR-075）：主机对象卡片 + 最近采样。
 *
 * 不提供连接/断开按钮：列表只表达主机是什么、最近采样到什么；
 * 连接由进入工作台自动发起、关闭工作台页签自动断开，失败在工作台里重试。
 * 图标由连接后检测到的系统决定（官方标识，不可配置）。
 */

export function HostList() {
  const toast = useToast();
  const { openObject } = useApp();

  const [hosts, setHosts] = useState<ServerHost[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ServerHost | null>(null);
  const [delTarget, setDelTarget] = useState<ServerHost | null>(null);

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

  const confirmDelete = async () => {
    const h = delTarget;
    if (!h) return;
    setDelTarget(null);
    try {
      // 关闭页签会自动断开；这里兜底工作台仍打开的情况，避免"先断开再删除"的提示。
      try {
        await serverDisconnect(h.id);
      } catch {
        /* 未连接或断开失败都不阻断删除 */
      }
      await serverDelete(h.id);
      toast(`已删除 ${h.name}`);
      await reload();
    } catch (e) {
      toast(`删除失败：${errText(e)}`, "err");
    }
  };

  const openForm = (host: ServerHost | null) => {
    setEditing(host);
    setFormOpen(true);
  };

  const openHost = (h: ServerHost) => openObject({ page: "server", hostId: h.id });

  return (
    <div className="srv-page">
      <div className="srv-head">
        <h2>服务器管理</h2>
        <div className="srv-head-acts">
          {hosts && hosts.length > 0 && <span className="srv-count">{hosts.length} 台</span>}
          <button className="btn primary" onClick={() => openForm(null)}>
            <Icon name="plus" size={14} />
            添加主机
          </button>
        </div>
      </div>

      {hosts === null && !loadErr && (
        <div className="srv-cards" aria-busy="true" aria-label="主机列表加载中">
          {[0, 1, 2].map((index) => (
            <div className="srv-skel" key={index} />
          ))}
        </div>
      )}

      {loadErr && (
        <Empty
          title="服务器列表读取失败"
          desc={loadErr}
          action={
            <button className="btn" onClick={() => void reload()}>
              重试
            </button>
          }
        />
      )}

      {hosts !== null && hosts.length === 0 && !loadErr && (
        <Empty
          title="还没有服务器"
          action={
            <button className="btn primary" onClick={() => openForm(null)}>
              <Icon name="plus" size={14} />
              添加主机
            </button>
          }
        />
      )}

      {hosts !== null && hosts.length > 0 && (
        <div className="srv-cards">
          {hosts.map((h) => {
            const logo = osLogoSrc(h.os);
            const address = hostAddress(h);
            return (
              <article
                className="srv-card"
                key={h.id}
                role="button"
                tabIndex={0}
                aria-label={`进入 ${h.name} 工作台`}
                onClick={() => openHost(h)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openHost(h);
                  }
                }}
              >
                <div className="srv-card-top">
                  <span className={`srv-os${logo ? "" : " unknown"}`} title={osLabel(h.os)}>
                    {logo ? <img src={logo} alt={`${osLabel(h.os)} 标识`} /> : <Icon name="server" size={18} />}
                  </span>
                  <div className="srv-card-id">
                    <div className="srv-card-name">
                      <b>{h.name}</b>
                      {h.groupTag && <span className="tag">{h.groupTag}</span>}
                    </div>
                    <div className="srv-card-addr mono">{address}</div>
                  </div>
                  <div className="srv-card-acts">
                    <button
                      className="icon-btn"
                      title="编辑"
                      aria-label={`编辑 ${h.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        openForm(h);
                      }}
                    >
                      <Icon name="pen" size={14} />
                    </button>
                    <button
                      className="icon-btn"
                      title="删除"
                      aria-label={`删除 ${h.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setDelTarget(h);
                      }}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </div>

                <div className="srv-card-stats" aria-label="主机指标">
                  <div>
                    <span>CPU</span>
                    <b>{pctText(h.cpuPct)}</b>
                  </div>
                  <div>
                    <span>内存</span>
                    <b>{pctText(h.memPct)}</b>
                  </div>
                  <div>
                    <span>磁盘</span>
                    <b>{pctText(h.diskPct)}</b>
                  </div>
                </div>

                <div className="srv-card-foot">
                  <span>{h.os || "系统未知"}</span>
                  <span>{lastSeenText(h.lastSeenAt)}</span>
                </div>
              </article>
            );
          })}
        </div>
      )}

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
        <div className="srv-dialog srv-confirm">
          <Confirm
            title="删除主机"
            message={`确定删除主机「${delTarget.name}」吗？删除后凭据与配置不可恢复。`}
            danger
            onOk={() => void confirmDelete()}
            onCancel={() => setDelTarget(null)}
          />
        </div>
      )}
    </div>
  );
}