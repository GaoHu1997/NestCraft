import { invoke } from "./index";

/**
 * CR-090：编码区文件操作命令封装。
 * 参数统一 camelCase；`relPath` / `fromRel` / `toRel` 为相对项目根、用 `/` 分隔的路径。
 * 后端语义：新建文件为原子 create_new，重名返回「已存在同名文件」；删除只允许文件或空目录，
 * 非空目录返回「目录非空」，前端须自行提示且不级联删除。
 */
export const createFile = (rootUri: string, relPath: string) => invoke<void>("fs_create_file", { rootUri, relPath });
export const createDir = (rootUri: string, relPath: string) => invoke<void>("fs_create_dir", { rootUri, relPath });
export const renamePath = (rootUri: string, fromRel: string, toRel: string) => invoke<void>("fs_rename", { rootUri, fromRel, toRel });
export const deletePath = (rootUri: string, relPath: string) => invoke<void>("fs_delete_path", { rootUri, relPath });
export const pathExists = (rootUri: string, relPath: string) => invoke<boolean>("fs_path_exists", { rootUri, relPath });
