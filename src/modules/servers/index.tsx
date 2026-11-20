import "./servers.css";
import { HostList } from "./HostList";
import { Workbench as WorkbenchImpl } from "./Workbench";

/** 服务器管理模块（CR-007 列表卡片 / CR-014 工作台三栏） */

/** 服务器列表页（全局导航内容区） */
export function Home() {
  return <HostList />;
}

/** 服务器工作台（左文件树 / 中终端 / 右监控与运维） */
export function Workbench(props: { hostId: string; visible?: boolean }) {
  return <WorkbenchImpl key={props.hostId} hostId={props.hostId} visible={props.visible} />;
}
