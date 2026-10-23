// ────── 平台检测 + 非 Windows 体验优化 ──────
(function detectPlatform() {
  const ua = navigator.userAgent;
  const isMobile = /Mobile|Android|iP(hone|od|ad)/i.test(ua);
  const isWindows = /Windows/i.test(ua);
  const isMac = /Macintosh|Mac OS X/i.test(ua) && !isMobile;
  const isLinux = /Linux/i.test(ua) && !/Android/i.test(ua);

  const note = document.getElementById("platform-note");
  const banner = document.getElementById("mobile-banner");

  if (isMobile) {
    // 移动端：顶部横幅 + Hero 加醒目提示
    if (banner) banner.style.display = "block";
    document.body.classList.add("is-mobile");
    if (note) {
      note.style.display = "inline-block";
      note.textContent = "💻 本软件仅支持 Windows 电脑，请用电脑访问本站下载";
    }

    // 复制链接按钮
    const copyBtn = document.getElementById("copy-link-btn");
    if (copyBtn) {
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText("https://daguagua.top");
          copyBtn.textContent = "已复制 ✓";
          setTimeout(() => (copyBtn.textContent = "复制链接"), 2000);
        } catch {
          copyBtn.textContent = "复制失败";
        }
      });
    }
  } else if (isMac || isLinux) {
    // Mac/Linux：在 Hero meta 下方加一行平台说明
    if (note) {
      note.style.display = "inline-block";
      const os = isMac ? "Mac" : "Linux";
      note.textContent = `⚠ 检测到你使用 ${os}，本软件目前仅支持 Windows 10 / 11`;
    }
  }
})();

// ────── 事件追踪（钩子） ──────
function trackEvent(name, props = {}) {
  try {
    // Microsoft Clarity 自定义事件
    if (typeof window.clarity === "function") {
      window.clarity("event", name);
      // 额外上报属性作为标签（Clarity 支持）
      for (const [k, v] of Object.entries(props)) {
        if (v != null && v !== "") {
          window.clarity("set", k, String(v));
        }
      }
    }
    // 预留通用钩子
    if (typeof window.__track === "function") {
      window.__track(name, props);
    }
    if (window.location.hostname === "localhost") {
      console.log("[track]", name, props);
    }
  } catch (e) {}
}

function bindTracking() {
  // 下载按钮点击
  document.querySelectorAll("[data-track='download']").forEach((el) => {
    el.addEventListener("click", () => {
      trackEvent("download_click", {
        source: el.dataset.source || "unknown",
        url: el.getAttribute("href") || "",
      });
    });
  });

  // 导航/其他链接点击
  document.querySelectorAll("[data-track='nav']").forEach((el) => {
    el.addEventListener("click", () => {
      trackEvent("nav_click", { target: el.dataset.source || el.textContent?.trim() });
    });
  });

  // FAQ 展开
  document.querySelectorAll(".faq-item").forEach((el) => {
    el.addEventListener("toggle", () => {
      if (el.open) {
        trackEvent("faq_open", {
          question: el.querySelector("summary span")?.textContent?.trim(),
        });
      }
    });
  });

  // 页面浏览
  trackEvent("page_view", { path: window.location.pathname });
}

document.addEventListener("DOMContentLoaded", bindTracking);

// ────── 滚动触发动画（Intersection Observer） ──────
(() => {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("visible");
          io.unobserve(e.target);
        }
      }
    },
    { threshold: 0.15, rootMargin: "0px 0px -8% 0px" }
  );

  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
})();

// ────── 从官网同域读取版本；安装包始终通过原生链接下载 ──────
(async function loadLatestRelease() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch("./release.json", { signal: controller.signal, cache: "no-cache" });
    if (!res.ok) throw new Error(`版本清单返回 ${res.status}`);
    const data = await res.json();
    if (!/^\d+\.\d+\.\d+$/.test(data.version || "") || !Number.isSafeInteger(data.size) || data.size <= 0 || !/^[a-f0-9]{64}$/.test(data.sha256 || "")) {
      throw new Error("版本清单格式无效");
    }
    const url = new URL(data.url, window.location.href);
    const expectedPath = new URL(`./downloads/${data.version}/aram-helper_${data.version}_x64-setup.exe`, window.location.href).pathname;
    if (url.origin !== window.location.origin || url.pathname !== expectedPath || url.search || url.hash) {
      throw new Error("下载地址与版本不一致");
    }
    document.querySelectorAll("[data-track='download']").forEach((btn) => btn.setAttribute("href", url.href));
    const label = document.getElementById("version-label");
    if (label) label.textContent = `最新版 v${data.version}`;
    const size = document.getElementById("download-size");
    if (size) size.textContent = `${(data.size / 1024 / 1024).toFixed(1)} MB`;
    const checksum = document.getElementById("checksum-link");
    if (checksum) checksum.setAttribute("href", new URL("SHA256SUMS.txt", url).href);
    const backup = new URL(data.backupUrl);
    if (backup.origin === "https://github.com" && backup.pathname.startsWith(`/paidaxn/aram-helper/releases/download/v${data.version}/`)) {
      document.getElementById("backup-download")?.setAttribute("href", backup.href);
    }
  } catch (error) {
    // HTML 已内置可用下载地址，清单异常时继续使用该版本。
    console.warn("版本清单暂不可用：", error);
  } finally {
    clearTimeout(timeout);
  }
})();
