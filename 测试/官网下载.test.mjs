import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../website/app.js", import.meta.url), "utf8");
const manifest = {
  version: "0.1.1", size: 3252841, sha256: "a".repeat(64),
  url: "./downloads/0.1.1/aram-helper_0.1.1_x64-setup.exe",
  backupUrl: "https://github.com/paidaxn/aram-helper/releases/download/v0.1.1/aram-helper_0.1.1_x64-setup.exe",
};
async function load(fetcher) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { textContent: "原文", style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
    return elements.get(id);
  };
  const buttons = [element("hero"), element("footer")];
  buttons.forEach((b) => b.attrs.href = "./downloads/0.1.0/aram-helper_0.1.0_x64-setup.exe");
  const requests = [];
  vm.runInNewContext(source, {
    navigator: { userAgent: "Windows" }, URL, AbortController,
    window: { location: { href: "https://daguagua.top/", origin: "https://daguagua.top", hostname: "daguagua.top" } },
    document: {
      getElementById: element, addEventListener() {},
      querySelectorAll: (query) => query === "[data-track='download']" ? buttons : [],
    },
    IntersectionObserver: class { observe() {} },
    fetch: async (url, options) => { requests.push({ url, options }); return fetcher(); },
    setTimeout: () => 1, clearTimeout() {}, console: { warn() {} },
  });
  await new Promise(setImmediate);
  return { elements, buttons, requests };
}

test("同域清单同时更新两个下载按钮、版本、大小及校验地址", async () => {
  const state = await load(() => ({ ok: true, json: async () => manifest }));
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].url, "./release.json");
  assert.equal(state.requests[0].options.cache, "no-cache");
  assert.ok(state.requests[0].options.signal);
  for (const b of state.buttons) assert.equal(b.attrs.href, new URL(manifest.url, "https://daguagua.top/").href);
  assert.equal(state.elements.get("version-label").textContent, "最新版 v0.1.1");
  assert.equal(state.elements.get("download-size").textContent, "3.1 MB");
  assert.equal(state.elements.get("checksum-link").attrs.href, "https://daguagua.top/downloads/0.1.1/SHA256SUMS.txt");
});
for (const [name, fetcher] of [
  ["断网", () => { throw new Error("offline"); }],
  ["清单 404", () => ({ ok: false, status: 404 })],
  ["无效 JSON", () => ({ ok: true, json: async () => { throw new Error("invalid JSON"); } })],
  ["跨域文件", () => ({ ok: true, json: async () => ({ ...manifest, url: "https://other.example/setup.exe" }) })],
  ["版本与文件不匹配", () => ({ ok: true, json: async () => ({ ...manifest, url: "./downloads/0.1.0/aram-helper_0.1.0_x64-setup.exe" }) })],
  ["无效大小", () => ({ ok: true, json: async () => ({ ...manifest, size: -1 }) })],
]) {
  test(`${name}时保留 HTML 的可用下载入口`, async () => {
    const state = await load(fetcher);
    for (const b of state.buttons) assert.equal(b.attrs.href, "./downloads/0.1.0/aram-helper_0.1.0_x64-setup.exe");
    assert.equal(state.requests.length, 1);
  });
}
