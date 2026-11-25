/**
 * 准备本地中文语义检索模型（CR-089 / FEAT-009，仅本机，不入库、不进 git）。
 *
 * 用途：为本地知识库提供真实的中文语义检索。需要两类资源：
 *   1) BAAI/bge-small-zh-v1.5 的 ONNX 量化模型 + 配套 tokenizer/config（来源 Xenova/bge-small-zh-v1.5，MIT）；
 *   2) onnxruntime 运行时库（ort 以 load-dynamic 方式在运行时加载）。
 *
 * 用法：
 *   node scripts/prepare-semantic-model.mjs [--dest <目录>]
 *     默认 <repo>/src-tauri/semantic/model（便携版请用 --dest <exe 所在目录>/semantic/model）
 *     也可运行后设置环境变量 NESTCRAFT_EMBED_MODEL 指向该目录。
 *
 * 行为：下载 → 校验 SHA-256 → 落盘。已存在且校验通过则跳过。
 * 换版本必须重新核对官方散列。
 *
 * 说明：
 *  - 模型走 hf-mirror.com 镜像（HF 直连在本环境不可达/404）。
 *    model_quantized.onnx 为 uint8 动态量化 ONNX（推理时即 int8 权重），体积约 24MB。
 *  - onnxruntime.dll 从 Microsoft 官方 NuGet 包 Microsoft.ML.OnnxRuntime 1.31.0 提取
 *    （ort rc.15 要求运行时 >= 1.31.x，实测 1.23 会报版本不兼容）。
 *  - 池化采用 CLS + L2 归一化，max_len 512（与 src-tauri/src/commands/kb_semantic.rs 一致）。
 */
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// ===== 资源清单（来源 / 精确字节数 / SHA-256，均为本机实测核对值） =====
const HF_BASE = 'https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main';
const RESOURCES = [
  {
    name: 'model_quantized.onnx',
    url: `${HF_BASE}/onnx/model_quantized.onnx`,
    sha256: '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc',
    size: 24010842,
  },
  {
    name: 'tokenizer.json',
    url: `${HF_BASE}/tokenizer.json`,
    sha256: '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26',
    size: 439125,
  },
  {
    name: 'config.json',
    url: `${HF_BASE}/config.json`,
    sha256: 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f',
    size: 716,
  },
];

// onnxruntime 运行时（Windows x64，>= 1.31.x）。来源：Microsoft 官方 NuGet 包中的
// runtimes/win-x64/native/onnxruntime.dll。
const ORT_NUPKG = {
  version: '1.31.0',
  url: 'https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/1.31.0/microsoft.ml.onnxruntime.1.31.0.nupkg',
  nupkgSha256: '7e35fdb4f5adb62f01e60798e2e5ed05108f5fbbe1cca03fbcc37903cf7c5e3b',
  entry: 'runtimes/win-x64/native/onnxruntime.dll',
  dllName: 'onnxruntime.dll',
  dllSha256: '0c42dc4e278f0968fdf9ebf1b1e54a74c657a9942e70803e453c91993451cf4c',
  dllSize: 17253176,
};

const arg = process.argv.indexOf('--dest');
const dest = path.resolve(
  arg > 0 ? process.argv[arg + 1] : path.join('src-tauri', 'semantic', 'model'),
);
const cache = path.resolve('docs/tmp/cr089-semantic-cache');
mkdirSync(dest, { recursive: true });
mkdirSync(cache, { recursive: true });

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function download(url, to) {
  console.log('下载 ' + url);
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`下载失败 ${response.status}: ${url}`);
  await pipeline(response.body, createWriteStream(to));
}

for (const res of RESOURCES) {
  const target = path.join(dest, res.name);
  if (existsSync(target) && sha256(target) === res.sha256) {
    console.log('已存在且校验通过：' + target);
    continue;
  }
  const tmp = path.join(cache, res.name);
  if (!existsSync(tmp) || sha256(tmp) !== res.sha256) {
    await download(res.url, tmp);
  }
  const actual = sha256(tmp);
  if (actual !== res.sha256) {
    throw new Error(`校验失败 ${res.name}：${actual} != ${res.sha256}`);
  }
  // 复制到目标（保持缓存以便重试）。
  const { copyFileSync } = await import('node:fs');
  copyFileSync(tmp, target);
  console.log(`完成 ${res.name}（${res.size} B）`);
}

// onnxruntime 运行时库（仅 Windows 需要；其他平台请自备对应 libonnxruntime）。
if (process.platform === 'win32') {
  const dll = path.join(dest, ORT_NUPKG.dllName);
  if (existsSync(dll) && sha256(dll) === ORT_NUPKG.dllSha256) {
    console.log('已存在且校验通过：' + dll);
  } else {
    const nupkg = path.join(cache, `microsoft.ml.onnxruntime.${ORT_NUPKG.version}.nupkg`);
    if (!existsSync(nupkg) || sha256(nupkg) !== ORT_NUPKG.nupkgSha256) {
      await download(ORT_NUPKG.url, nupkg);
    }
    const nupkgHash = sha256(nupkg);
    if (nupkgHash !== ORT_NUPKG.nupkgSha256) {
      throw new Error(`nupkg 校验失败：${nupkgHash} != ${ORT_NUPKG.nupkgSha256}`);
    }
    // .nupkg 是 zip：用 PowerShell 的 ZipFile 提取指定条目（避免额外依赖）。
    extractFromZip(nupkg, ORT_NUPKG.entry, dll);
    const dllHash = sha256(dll);
    if (dllHash !== ORT_NUPKG.dllSha256) {
      throw new Error(`onnxruntime.dll 校验失败：${dllHash} != ${ORT_NUPKG.dllSha256}`);
    }
    console.log(`完成 ${ORT_NUPKG.dllName}（${ORT_NUPKG.dllSize} B）`);
  }
} else {
  console.log('非 Windows：请自备 onnxruntime 运行时库（libonnxruntime.so / .dylib），并设置 ORT_DYLIB_PATH。');
}

function extractFromZip(zipPath, entry, outPath) {
  const ps = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem;',
    `$z=[System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}');`,
    `$e=$z.Entries | Where-Object { $_.FullName -eq '${entry}' };`,
    `if(-not $e){ $z.Dispose(); throw 'nupkg 内未找到 ${entry}' };`,
    `[System.IO.Compression.ZipFileExtensions]::ExtractToFile($e,'${outPath.replace(/'/g, "''")}',$true);`,
    `$z.Dispose();`,
  ].join(' ');
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
}

console.log('');
console.log('全部资源就绪：' + dest);
console.log('开发运行请设置环境变量：NESTCRAFT_EMBED_MODEL=' + dest);
console.log('（Windows 下 kb_semantic::ensure_model() 会自动把同目录 onnxruntime.dll 设入 ORT_DYLIB_PATH，无需手动设。）');
