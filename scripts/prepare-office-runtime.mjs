/**
 * 准备 Office 转换运行时（仅本机，不入库）。
 * 用途：知识库 Word／PPT／Excel 只读预览需要一个受管的本机转换器。
 * 用法：node scripts/prepare-office-runtime.mjs [--dest <目录>]
 *   默认 <repo>/src-tauri/office（便携版请用 --dest <exe 所在目录>/office）
 * 行为：下载官方固定版本 MSI → 校验 SHA-256 → 行政解包（msiexec /a，不安装、不改文件关联）。
 * 版本 26.2.7 / sha256 480fecf7… 为本次核对值；换版本必须重新核对官方散列。
 */
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const VERSION = '26.2.7';
const SHA256 = '480fecf759fc6393bd614fbf43753eb95a8198fc1a065d41b727e3b664cd1e59';
const URL = `https://mirrors.nju.edu.cn/tdf/libreoffice/stable/${VERSION}/win/x86_64/LibreOffice_${VERSION}_Win_x86-64.msi`;
if (process.platform !== 'win32') { console.error('该脚本仅面向 Windows 便携构建'); process.exit(1); }
const arg = process.argv.indexOf('--dest');
const dest = path.resolve(arg > 0 ? process.argv[arg + 1] : path.join('src-tauri', 'office'));
const cache = path.resolve('docs/tmp/cr084-office');
mkdirSync(cache, { recursive: true });
const msi = path.join(cache, `LibreOffice_${VERSION}_Win_x86-64.msi`);
const target = path.join(dest, 'LibreOffice');
if (existsSync(path.join(target, 'program', 'soffice.exe'))) { console.log('已存在：' + path.join(target, 'program', 'soffice.exe')); process.exit(0); }
if (!existsSync(msi)) {
  console.log('下载 ' + URL);
  const response = await fetch(URL);
  if (!response.ok || !response.body) throw new Error('下载失败 ' + response.status);
  await pipeline(response.body, createWriteStream(msi));
}
const actual = createHash('sha256').update(readFileSync(msi)).digest('hex');
if (actual !== SHA256) throw new Error(`校验失败：${actual} != ${SHA256}`);
mkdirSync(dest, { recursive: true });
console.log('解包到 ' + target);
const result = spawnSync('msiexec.exe', ['/a', msi, '/qn', `TARGETDIR=${target}`, '/L*v', path.join(cache, 'extract.log')], { stdio: 'inherit' });
if (result.status !== 0) throw new Error('解包失败，退出码 ' + result.status);
const soffice = path.join(target, 'program', 'soffice.exe');
if (!existsSync(soffice)) throw new Error('解包后未找到 soffice.exe');
console.log('完成：' + soffice);
console.log('开发运行可设置环境变量 NESTCRAFT_SOFFICE=' + soffice);
