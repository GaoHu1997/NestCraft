/**
 * 办公演示只能由隔离测试显式载入；普通新建/历史会话不得调用本入口。
 * 真实工具步骤、子代理与后台记录不被合成研发夹具覆盖。
 */
import { seedDemo } from "@/modules/chat/sessionRuntime";

export function seedOfficeSessionDemo(sessionId: string): void {
  seedDemo(sessionId);
}
