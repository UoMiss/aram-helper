import { readFile, writeFile, mkdir, copyFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [, , installer, signatureFile, version, publishedAt, backupUrl] = process.argv;
if (!installer || !signatureFile || !/^\d+\.\d+\.\d+$/.test(version || "") || !publishedAt || !backupUrl) {
  throw new Error("用法：node 脚本/准备官网下载.mjs 安装包 签名 版本 ISO发布时间 GitHub备用下载URL");
}
if (!Number.isFinite(Date.parse(publishedAt))) throw new Error("发布时间无效");
const backup = new URL(backupUrl);
if (backup.origin !== "https://github.com" || !backup.pathname.startsWith(`/paidaxn/aram-helper/releases/download/v${version}/`)) {
  throw new Error("备用地址必须是本项目的 GitHub Release 文件");
}
const size = (await stat(installer)).size;
if (!size || size > 25 * 1024 * 1024) throw new Error("安装包为空或超过 EdgeOne 单文件限制");
const bytes = await readFile(installer);
if (bytes.subarray(0, 2).toString() !== "MZ") throw new Error("文件不是 Windows 可执行安装包");
const signature = signatureFile === "-" ? null : (await readFile(signatureFile, "utf8")).trim();
if (signature !== null && (!signature || signature.length > 4096)) throw new Error("签名文件无效");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const name = `aram-helper_${version}_x64-setup.exe`;
const relativeUrl = `./downloads/${version}/${name}`;
const folder = resolve(root, "website/downloads", version);
await mkdir(folder, { recursive: true });
// 版本化文件发布后保持不变，避免缓存命中不同内容。
try {
  const existing = await readFile(resolve(folder, name));
  if (createHash("sha256").update(existing).digest("hex") !== sha256) throw new Error("同版本已有不同安装包，请使用新版本号");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await copyFile(installer, resolve(folder, name));
if (signature) await writeFile(resolve(folder, `${name}.sig`), signature + "\n");
await writeFile(resolve(folder, "SHA256SUMS.txt"), `${sha256}  ${name}\n`);
const release = { version, publishedAt, size, sha256, url: relativeUrl, backupUrl: backup.href };
const latest = {
  version, notes: `LOL 红包局助手 v${version}`, pub_date: publishedAt,
  platforms: { "windows-x86_64": { signature, url: new URL(relativeUrl, "https://daguagua.top/").href } },
};
await writeFile(resolve(root, "website/release.json"), JSON.stringify(release, null, 2) + "\n");
// 缺少原私钥时只提供手动安装包，保留上一个有效自动更新清单。
if (signature) await writeFile(resolve(root, "website/latest.json"), JSON.stringify(latest, null, 2) + "\n");
const htmlPath = resolve(root, "website/index.html");
let html = await readFile(htmlPath, "utf8");
html = html.replace(/href="[^"]*"([^>]*data-track="download")/g, `href="${relativeUrl}"$1`);
html = html.replace(/(<span id="version-label">)[^<]+/, `$1最新版 v${version}`);
html = html.replace(/(<span id="download-size">)[^<]+/, `$1${(size / 1024 / 1024).toFixed(1)} MB`);
html = html.replace(/href="[^"]*"( id="checksum-link")/, `href="./downloads/${version}/SHA256SUMS.txt"$1`);
html = html.replace(/href="[^"]*"( id="backup-download")/, `href="${backup.href}"$1`);
await writeFile(htmlPath, html);
console.log(JSON.stringify({ version, size, sha256, download: relativeUrl, automaticUpdate: Boolean(signature) }));
