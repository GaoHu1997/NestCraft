/**
 * CR-090：文件树操作的纯函数工具（不依赖 React / Tauri）。
 * 路径统一为相对项目根、以 `/` 分隔；`ROOT` 表示项目根的空相对路径。
 */
export const ROOT = "";

/** 拼接相对路径：根目录下直接返回名称，否则 `父/名`。 */
export const joinRel = (parent: string, name: string) => parent === ROOT ? name : `${parent}/${name}`;

/** 拆分主名与扩展名：仅最后一个点不在开头时才视为扩展名（如 `a.b.tsx` → base `a.b`）。 */
export function splitExtension(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? { base: name.slice(0, dot), ext: name.slice(dot) } : { base: name, ext: "" };
}

/**
 * 名称基础校验（前端先行，后端兜底）：空名、首尾空格、非法字符、`.`/`..`。
 * 返回中文错误文案，合法返回空串；同级重名由调用方结合已有项另行判断。
 */
export function invalidNameReason(name: string): string {
  if (!name.trim()) return "名称不能为空";
  if (name !== name.trim()) return "名称首尾不能包含空格";
  if (/[\\/:*?"<>|]/.test(name)) return "名称不能包含 \\ / : * ? \" < > |";
  if (name === "." || name === "..") return "名称不能为 . 或 ..";
  return "";
}
