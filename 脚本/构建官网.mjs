import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const website = resolve(dirname(fileURLToPath(import.meta.url)), "../website");
const release = JSON.parse(await readFile(resolve(website, "release.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(release.version) || !Number.isSafeInteger(release.size) || release.size <= 0 || release.size > 25 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(release.sha256)) throw new Error("版本清单无效");
const name = `aram-helper_${release.version}_x64-setup.exe`;
if (release.url !== `./downloads/${release.version}/${name}`) throw new Error("文件路径与版本不一致");
const backup = new URL(release.backupUrl);
if (backup.origin !== "https://github.com" || !backup.pathname.startsWith(`/paidaxn/aram-helper/releases/download/v${release.version}/`)) throw new Error("备用下载地址无效");
const folder = resolve(website, "downloads", release.version);
const destination = resolve(folder, name);
let bytes;
try { bytes = await readFile(destination); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (!bytes) {
  const response = await fetch(backup, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > release.size) throw new Error("安装包大小超过清单值");
    chunks.push(chunk);
  }
  bytes = Buffer.concat(chunks);
}
if (bytes.length !== release.size || createHash("sha256").update(bytes).digest("hex") !== release.sha256) throw new Error("安装包大小或 SHA-256 校验失败，停止部署");
await mkdir(folder, { recursive: true });
await writeFile(destination, bytes);
await writeFile(resolve(folder, "SHA256SUMS.txt"), `${release.sha256}  ${name}\n`);
const latest = JSON.parse(await readFile(resolve(website, "latest.json"), "utf8"));
if (latest.version === release.version && latest.platforms?.["windows-x86_64"]?.signature) {
  await writeFile(resolve(folder, `${name}.sig`), latest.platforms["windows-x86_64"].signature + "\n");
}
console.log(`官网下载文件已就绪：v${release.version}，${bytes.length} 字节，SHA-256 一致。`);
