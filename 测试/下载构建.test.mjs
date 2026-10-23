import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "aram-download-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "脚本")); await mkdir(join(root, "website"));
  for (const name of ["准备官网下载.mjs", "构建官网.mjs"]) await copyFile(new URL(`../脚本/${name}`, import.meta.url), join(root, "脚本", name));
  await copyFile(new URL("../website/index.html", import.meta.url), join(root, "website/index.html"));
  await copyFile(new URL("../website/latest.json", import.meta.url), join(root, "website/latest.json"));
  const installer = join(root, "test.exe");
  const bytes = Buffer.from("MZ-test-fixture"); await writeFile(installer, bytes);
  return { root, installer, bytes };
}
const run = (root, name, args = []) => execFileSync(process.execPath, [join(root, "脚本", name), ...args], { cwd: root, timeout: 5000, stdio: "pipe" });

test("手动安装包生成完整目录和两个按钮，保留原自动更新清单", async (t) => {
  const { root, installer, bytes } = await fixture(t);
  const originalLatest = await readFile(join(root, "website/latest.json"), "utf8");
  run(root, "准备官网下载.mjs", [installer, "-", "0.1.1", "2026-10-23T14:00:00Z", "https://github.com/paidaxn/aram-helper/releases/download/v0.1.1/setup.exe"]);
  const release = JSON.parse(await readFile(join(root, "website/release.json"), "utf8"));
  assert.equal(release.sha256, createHash("sha256").update(bytes).digest("hex"));
  const html = await readFile(join(root, "website/index.html"), "utf8");
  assert.equal((html.match(/href=".\/downloads\/0.1.1\/aram-helper_0.1.1_x64-setup.exe"/g) || []).length, 2);
  assert.match(html, /href="https:\/\/github.com\/paidaxn\/aram-helper\/releases\/download\/v0.1.1\/setup.exe" id="backup-download"/);
  assert.equal(await readFile(join(root, "website/latest.json"), "utf8"), originalLatest);
  run(root, "构建官网.mjs");
  assert.deepEqual(await readFile(join(root, "website/downloads/0.1.1/aram-helper_0.1.1_x64-setup.exe")), bytes);
});

test("损坏安装包阻止官网构建，已发布版本拒绝被其他内容覆盖", async (t) => {
  const { root, installer } = await fixture(t);
  const args = [installer, "-", "0.1.1", "2026-10-23T14:00:00Z", "https://github.com/paidaxn/aram-helper/releases/download/v0.1.1/setup.exe"];
  run(root, "准备官网下载.mjs", args);
  await writeFile(join(root, "website/downloads/0.1.1/aram-helper_0.1.1_x64-setup.exe"), "MZ-damaged");
  assert.throws(() => run(root, "构建官网.mjs"), /SHA-256/);
  assert.throws(() => run(root, "准备官网下载.mjs", args), /同版本已有不同安装包/);
});
