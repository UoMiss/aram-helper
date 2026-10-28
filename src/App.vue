<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick, toRefs } from "vue";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createAssistant } from "./assistant";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import html2canvas from "html2canvas-pro";
import { groupPlayers } from "./grouping";
import { damageTail, evaluateDamageTails, evaluateLuckyNumbers, DAMAGE_TAIL_DESCRIPTION, LUCKY_NUMBER_DESCRIPTION } from "./scoring";

import type { BattleMode, Player } from "./grouping";

const assistant = createAssistant(invoke, async () => {
  const window = getCurrentWindow();
  await window.show();
  await window.unminimize();
}, undefined, async () => {
  const window = getCurrentWindow();
  return await window.isVisible() && !await window.isMinimized();
}, undefined, localStorage.getItem("scoringMode") === "lucky-number" ? "lucky-number" : "damage-tail");
const { page, connStatus, summonerName, gamePhase, errorMsg, connectionError,
  loading, historyLoading, connecting, gameResult, matchList, luckyDraws, currentGameId, luckyError, scoringMode, pendingLuckyDraw } = toRefs(assistant.state);
const { viewLastGame, loadHistory, viewGame, goBack, openSettings, retryConnection, selectScoringRule } = assistant;
const appVersion = ref("");

// 分组决定参与者；两种模式共用伤害尾数比较规则。
const battleMode = ref<BattleMode>(localStorage.getItem("battleMode") === "custom" ? "custom" : "solo");
watch(battleMode, (value) => localStorage.setItem("battleMode", value));
const groupingLabel = computed(() => battleMode.value === "solo" ? "匹配模式" : "自定义模式");
const playerGroups = computed(() => gameResult.value
  ? groupPlayers(gameResult.value, battleMode.value)
  : []);
const canShowGroups = computed(() => playerGroups.value.length >= 2);
const activeLuckyDraw = computed(() => {
  if (scoringMode.value !== "lucky-number") return null;
  if (currentGameId.value !== null) return luckyDraws.value[String(currentGameId.value)] ?? null;
  return page.value === "status" ? pendingLuckyDraw.value : null;
});
const resultLuckyDraw = computed(() => gameResult.value ? luckyDraws.value[String(gameResult.value.gameId)] ?? null : null);
const luckyResult = computed(() => evaluateLuckyNumbers(playerGroups.value.flatMap((group) => group.players), resultLuckyDraw.value?.number ?? null));
watch(scoringMode, (mode) => localStorage.setItem("scoringMode", mode));
const scoringRules = [
  { id: "damage-tail" as const, name: "伤害尾数", summary: ["尾数越大排名越前，末位发红包。", "同分依次比较十位、百位等数值。"], description: DAMAGE_TAIL_DESCRIPTION },
  { id: "lucky-number" as const, name: "幸运数字", summary: ["确认对局时抽取，距离越近越靠前。", "同分逐位比较距离，末位发红包。"], description: LUCKY_NUMBER_DESCRIPTION },
];
const currentRule = computed(() => scoringRules.find((rule) => rule.id === scoringMode.value)!);
const scoreDescription = computed(() => currentRule.value.description);
const scoringResult = computed(() => scoringMode.value === "lucky-number"
  ? luckyResult.value
  : evaluateDamageTails(playerGroups.value.flatMap((group) => group.players)));
const resultMessage = computed(() => {
  const result = scoringResult.value;
  const names = result.lowestPlayers.map((player) => player.summonerName).join("、");
  if (result.status === "ready") return `发红包：${names}`;
  if (result.status === "tie") return scoringMode.value === "lucky-number"
    ? `末位并列：${names}。伤害各位与幸运数字的距离均相同，需手动确定。`
    : `完全并列：${names}。完整伤害相同，需手动确定。`;
  if (result.status === "missing") return "本局没有赛前公开的幸运数字，无法按此规则排名，不在结算后补抽。";
  if (result.status === "invalid") return "伤害数据不完整，暂不判定，请重新读取对局。";
  return "参与人数不足，暂不判定。";
});

const lowestNames = computed(() => scoringResult.value.lowestPlayers.map((player) => player.summonerName).join("、"));
const displayedGroups = computed(() => {
  if (scoringMode.value !== "lucky-number" || !luckyResult.value.ranking.length) return playerGroups.value;
  const ranks = new Map(luckyResult.value.ranking.map((entry) => [entry.player, entry.rank]));
  const groups = playerGroups.value.map((group) => ({ ...group,
    players: [...group.players].sort((a, b) => ranks.get(a)! - ranks.get(b)!),
  }));
  return battleMode.value === "solo" ? groups.sort((a, b) => ranks.get(a.players[0])! - ranks.get(b.players[0])!) : groups;
});
function playerRank(player: Player) {
  return luckyResult.value.ranking.find((entry) => entry.player === player)?.rank;
}

// ────── 自动更新状态（先声明，computeTargetHeight 会用） ──────
type UpdateState = "idle" | "available" | "downloading" | "ready" | "failed";
const updateState = ref<UpdateState>("idle");
const updateInfo = ref<{ version: string; notes?: string } | null>(null);
const updateProgress = ref(0);

// ────── 响应式窗口高度 ──────
const appRoot = ref<HTMLElement>();

function computeTargetHeight(): number {
  const updateHeight = updateState.value !== "idle" ? 48 : 0;
  const luckyHeight = scoringMode.value === "lucky-number" && (activeLuckyDraw.value || luckyError.value) ? 58 : 0;
  if (page.value === "status") return 420 + updateHeight + luckyHeight;
  if (page.value === "history") return 580 + updateHeight;
  if (page.value === "settings") return 540 + updateHeight + luckyHeight;
  if (page.value === "result" && gameResult.value) {
    let h = 36 + 62 + 56 + updateHeight;
    if (canShowGroups.value) {
      h += scoringResult.value.status === "ready" ? 110 : 60;
      if (scoringMode.value === "lucky-number" && resultLuckyDraw.value) h += 42;
      for (const group of playerGroups.value) h += 84 + group.players.length * 24;
      h += 120;
    } else h += 100;
    return Math.max(380, Math.min(820, h));
  }
  return 480;
}

async function resizeToContent() {
  await nextTick();
  try {
    await invoke("resize_window", { height: computeTargetHeight() });
  } catch {}
}

watch([page, playerGroups, battleMode, updateState, scoringMode, activeLuckyDraw, luckyError], () => {
  resizeToContent();
});

// ────── 工具 ──────

function fmt(n: number) { return Math.round(n).toLocaleString(); }
function fmtDur(s: number) { return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`; }
function fmtTime(ts: number) {
  const d = new Date(ts), now = new Date();
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  if (days === 0) return `今天 ${hh}:${mm}`;
  if (days === 1) return `昨天 ${hh}:${mm}`;
  if (days < 7) return `${days}天前`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function phaseText(p: string) {
  return ({ None:"大厅", Lobby:"房间中", Matchmaking:"匹配中", ReadyCheck:"确认中",
    ChampSelect:"选英雄中", GameStart:"正在进入游戏", InProgress:"游戏中", WaitingForStats:"结算中", EndOfGame:"对局结束" } as Record<string,string>)[p] || p;
}
function modeName(m: string) {
  return ({ ARAM:"大乱斗", KIWI:"大乱斗", CLASSIC:"匹配/排位", URF:"无限火力", CHERRY:"斗魂竞技场" } as Record<string,string>)[m] || m;
}

// ────── 结果分享图（截图到剪贴板） ──────
const shareStatus = ref("");
const sharing = ref(false);
const resultArea = ref<HTMLElement>();
let shareTimer: ReturnType<typeof setTimeout> | undefined;
let updateTimer: ReturnType<typeof setTimeout> | undefined;

async function shareAsImage() {
  if (!resultArea.value || sharing.value) return;
  sharing.value = true;
  shareStatus.value = "";
  clearTimeout(shareTimer);
  try {
    const canvas = await html2canvas(resultArea.value, {
      backgroundColor: "#0A0E1A", scale: 2, logging: false,
    });
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("生成图片失败")), "image/png"
    ));
    try {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      shareStatus.value = "图片已复制，可粘贴到聊天";
    } catch {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `红包局结算-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      shareStatus.value = "已发起图片下载，请查看下载目录";
    }
  } catch {
    shareStatus.value = "图片生成失败，请重试";
  } finally {
    sharing.value = false;
    shareTimer = setTimeout(() => { shareStatus.value = ""; }, 4000);
  }
}

// ────── 自动更新 ──────
async function checkForUpdate(silent = true) {
  try {
    const u = await check();
    if (u) {
      updateInfo.value = { version: u.version, notes: u.body };
      updateState.value = "available";
    } else if (!silent) {
      updateState.value = "idle";
    }
  } catch (e) {
    console.warn("update check failed:", e);
  }
}

async function downloadAndInstallUpdate() {
  try {
    updateState.value = "downloading";
    let downloaded = 0;
    let contentLength = 0;
    const u = await check();
    if (!u) {
      updateState.value = "idle";
      return;
    }
    await u.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          contentLength = event.data.contentLength ?? 0;
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          updateProgress.value = contentLength ? Math.round((downloaded / contentLength) * 100) : 0;
          break;
        case "Finished":
          updateState.value = "ready";
          break;
      }
    });
    // 自动重启
    await relaunch();
  } catch (e) {
    console.warn("update install failed:", e);
    updateState.value = "failed";
  }
}

function dismissUpdate() {
  updateState.value = "idle";
}

onMounted(() => {
  void assistant.start();
  getVersion().then((version) => { appVersion.value = version; }).catch(() => {});
  // 启动后 3 秒检查更新（避开开屏轮询争抢）
  updateTimer = setTimeout(() => checkForUpdate(true), 3000);
});
onUnmounted(() => {
  assistant.stop();
  clearTimeout(updateTimer);
  clearTimeout(shareTimer);
});
</script>

<template>
  <div class="app" ref="appRoot">
    <!-- 更新提示 -->
    <div v-if="updateState !== 'idle'" class="update-banner">
      <template v-if="updateState === 'available'">
        <span class="update-text">发现新版本 v{{ updateInfo?.version }}</span>
        <div class="update-actions">
          <button class="btn-update-skip" @click="dismissUpdate">稍后</button>
          <button class="btn-update-go" @click="downloadAndInstallUpdate">立即更新</button>
        </div>
      </template>
      <template v-else-if="updateState === 'downloading'">
        <span class="update-text">下载中 {{ updateProgress }}%</span>
        <div class="update-progress"><div class="update-progress-bar" :style="{ width: updateProgress + '%' }"></div></div>
      </template>
      <template v-else-if="updateState === 'ready'">
        <span class="update-text">下载完成，正在重启...</span>
      </template>
      <template v-else-if="updateState === 'failed'">
        <span class="update-text">更新失败</span>
        <button class="btn-update-skip" @click="dismissUpdate">关闭</button>
      </template>
    </div>

    <!-- ====== 状态页 ====== -->
    <template v-if="page === 'status'">
      <div v-if="connStatus === 'disconnected'" class="center-page">
        <div class="brand-logo">
          <svg viewBox="0 0 64 64" width="56" height="56">
            <defs>
              <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#A78BFA"/>
                <stop offset="100%" stop-color="#7C3AED"/>
              </linearGradient>
            </defs>
            <circle cx="32" cy="32" r="28" fill="none" stroke="url(#g1)" stroke-width="2" opacity="0.4"/>
            <rect x="18" y="22" width="28" height="24" rx="3" fill="#F59E0B"/>
            <rect x="18" y="22" width="28" height="7" rx="3" fill="#EA580C"/>
            <circle cx="32" cy="36" r="5" fill="#FBBF24"/>
          </svg>
        </div>
        <p class="title">LOL 红包局助手</p>
        <p class="sub">等待连接英雄联盟</p>
        <p class="connection-guide">打开并登录客户端后会自动连接。<br />匹配模式比较自己和同队好友，自定义模式展示双方玩家。</p>
        <div class="dots"><i /><i /><i /></div>
        <div class="row" style="margin-top:16px">
          <button class="btn-s" @click="retryConnection" :disabled="connecting">{{ connecting ? "连接中…" : "重新连接" }}</button>
          <button class="btn-s" @click="openSettings">设置</button>
        </div>
        <p class="connection-guide">仍未连接？尝试以管理员身份重新打开助手。</p>
        <details v-if="connectionError" class="connection-details"><summary>连接详情 · 每 5 秒自动重试</summary><p>{{ connectionError }}</p></details>
      </div>

      <div v-else class="center-page">
        <div class="status-ring">
          <svg viewBox="0 0 64 64" width="48" height="48">
            <circle cx="32" cy="32" r="28" fill="none" stroke="#7C3AED" stroke-width="2" opacity="0.3"/>
            <path d="M32 14 L32 30 L44 30 L28 50 L28 34 L16 34 Z" fill="#A78BFA"/>
          </svg>
        </div>
        <p class="title">已连接</p>
        <p class="name">{{ summonerName }}</p>
        <p class="sub">{{ gamePhase ? phaseText(gamePhase) : "等待对局结束" }}</p>
        <p class="rule-tag">{{ groupingLabel }} · {{ currentRule.name }}</p>
        <p v-if="activeLuckyDraw" class="approx-tip">幸运数字 <strong>{{ activeLuckyDraw.number }}</strong> · 已公开</p>
        <p v-if="luckyError" class="err">{{ luckyError }}</p>
        <p class="connection-guide">{{ gamePhase === "WaitingForStats" ? "正在等待客户端生成结算数据…" : "对局结束自动结算，可以关闭窗口收进托盘。" }}</p>
        <div class="dots"><i /><i /><i /></div>
        <div class="row" style="margin-top:20px">
          <button class="btn-s" @click="viewLastGame" :disabled="loading">
            {{ loading ? "加载中" : "上一局" }}
          </button>
          <button class="btn-s" @click="loadHistory">历史对局</button>
          <button class="btn-s" @click="openSettings">设置</button>
        </div>
        <p v-if="errorMsg" class="err">{{ errorMsg }}</p>
      </div>
    </template>

    <!-- ====== 结果页 ====== -->
    <template v-else-if="page === 'result' && gameResult">
      <div class="page scrollable">
        <div class="nav">
          <button class="btn-back" @click="goBack">返回</button>
          <span class="nav-title">{{ currentRule.name }}</span>
          <span class="nav-meta">{{ modeName(gameResult.gameMode) }} {{ fmtDur(gameResult.gameDuration) }}</span>
        </div>

        <div v-if="!canShowGroups" class="center-page" style="padding:24px 0">
          <p class="sub">{{ battleMode === "solo" ? "自己和同队好友不足 2 人，无法比较" : "缺少双方阵营数据，请重新读取对局" }}</p>
        </div>

        <template v-else>
          <div class="mode-toggle" aria-label="分组模式">
            <button class="mode-btn" :class="{ active: battleMode === 'solo' }" @click="battleMode = 'solo'">匹配模式</button>
            <button class="mode-btn" :class="{ active: battleMode === 'custom' }" @click="battleMode = 'custom'">自定义模式</button>
          </div>

          <!-- 截图区域 -->
          <div ref="resultArea" class="share-area">
            <p v-if="scoringMode === 'lucky-number' && resultLuckyDraw" class="approx-tip">幸运数字 <strong>{{ resultLuckyDraw.number }}</strong> · 赛前已公开</p>
            <div v-if="scoringResult.status === 'ready'" class="loser-box">
              <div class="loser-name">{{ lowestNames }}</div>
              <div class="loser-slogan">就是你了，发红包吧！</div>
            </div>
            <p v-else class="approx-tip" role="status">{{ resultMessage }}</p>

            <div
              v-for="(team, i) in displayedGroups"
              :key="i"
              class="team"
              :class="{ lose: battleMode === 'solo' && team.players.some(p => scoringResult.lowestPlayers.includes(p)) }"
            >
              <div class="team-top">
                <span class="team-name" :title="team.name">{{ team.name }}</span>
                <span class="team-pts">{{ team.players.length === 1 ? `${damageTail(team.players[0].damage) ?? "—"} 尾数` : `${team.players.length} 人` }}</span>
              </div>
              <div class="p-row p-head"><span class="p-name">玩家</span><span class="p-dmg">伤害</span><span class="p-tkn">承伤</span><span class="p-kda">K / D / A</span></div>
              <div v-for="p in team.players" :key="p.summonerName" class="p-row" :class="{ 'lowest-player': scoringResult.lowestPlayers.includes(p) }">
                <span class="p-name" :title="p.summonerName"><b v-if="scoringMode === 'lucky-number' && playerRank(p)" class="rank-tag">#{{ playerRank(p) }}</b>{{ p.summonerName }}<b v-if="p.isMe" class="me-tag">我</b></span>
                <span class="p-dmg">{{ fmt(p.damage) }}</span>
                <span class="p-tkn">{{ fmt(p.damageTaken) }}</span>
                <span class="p-kda">{{ p.kills }}/{{ p.deaths }}/{{ p.assists }}</span>
              </div>
            </div>

            <p class="score-note">{{ scoreDescription }}</p>
            <!-- 水印（截图时也带上） -->
            <div class="share-watermark">
              <span>{{ currentRule.name }}</span>
              <span class="dot">·</span>
              <span>daguagua.top</span>
            </div>
          </div>

          <!-- 分享按钮（不在截图区域内） -->
          <button class="btn-share" @click="shareAsImage" :disabled="sharing">
            <span v-if="shareStatus" role="status">{{ shareStatus }}</span>
            <span v-else-if="sharing">生成中...</span>
            <span v-else>📸 复制截图到剪贴板</span>
          </button>
        </template>
      </div>
    </template>

    <!-- ====== 历史页 ====== -->
    <template v-else-if="page === 'history'">
      <div class="page scrollable">
        <div class="nav">
          <button class="btn-back" @click="goBack">返回</button>
          <span class="nav-title">历史对局</span>
        </div>

        <p v-if="historyLoading" class="sub" style="text-align:center;padding:24px">加载中...</p>

        <div v-else-if="errorMsg" class="empty-state" role="alert"><p>{{ errorMsg }}</p><button class="btn-s" @click="loadHistory">重新加载</button></div>
        <div v-else-if="!matchList.length" class="empty-state"><p>还没有可显示的对局</p><p class="sub">完成一局游戏后，再来查看最近 20 局。</p><button class="btn-s" @click="loadHistory">刷新记录</button></div>
        <div v-else class="h-list" :aria-busy="loading">
          <p class="list-note" role="status">{{ loading ? "正在读取对局详情…" : "最近 20 局 · 点击查看结算" }}</p>
          <button v-for="m in matchList" :key="m.gameId" class="h-item" @click="viewGame(m.gameId)" :disabled="loading">
            <span class="h-mode">{{ modeName(m.gameMode) }}</span>
            <span class="h-dur">{{ fmtDur(m.gameDuration) }}</span>
            <span class="h-time">{{ fmtTime(m.timestamp) }}</span>
            <span class="h-arrow">›</span>
          </button>
        </div>
      </div>
    </template>

    <!-- ====== 设置页 ====== -->
    <template v-else-if="page === 'settings'">
      <div class="page scrollable">
        <div class="nav">
          <button class="btn-back" @click="goBack">返回</button>
          <span class="nav-title">设置</span>
        </div>

        <p class="section-label">分组模式</p>
        <div class="mode-toggle">
          <button class="mode-btn" :class="{ active: battleMode === 'solo' }" @click="battleMode = 'solo'">匹配模式</button>
          <button class="mode-btn" :class="{ active: battleMode === 'custom' }" @click="battleMode = 'custom'">自定义模式</button>
        </div>

        <p class="section-label" style="margin-top:16px">算分规则</p>
        <div class="rule-list">
          <label
            v-for="r in scoringRules"
            :key="r.id"
            class="rule-item"
            :class="{ selected: scoringMode === r.id }"
          >
            <input type="radio" name="scoring-rule" :value="r.id" :checked="scoringMode === r.id" @click="selectScoringRule(r.id)" />
            <div class="rule-body">
              <div class="rule-name">{{ r.name }}</div>
              <div class="rule-desc"><span v-for="line in r.summary" :key="line">{{ line }}</span></div>
            </div>
          </label>
        </div>

        <p v-if="scoringMode === 'lucky-number' && (activeLuckyDraw || pendingLuckyDraw)" class="approx-tip">幸运数字 <strong>{{ (activeLuckyDraw || pendingLuckyDraw)?.number }}</strong> · 已公开，本局固定</p>
        <p v-if="luckyError" class="err">{{ luckyError }}</p>
        <p class="section-label" style="margin-top:16px">关于</p>
        <div class="about-box">
          <p class="about-line">LOL 红包局助手 <span v-if="appVersion">v{{ appVersion }}</span></p>
          <p class="about-line muted">对局结束自动显示结果，算分规则在设置中配置</p>
          <p class="about-line muted">关闭窗口后继续运行；托盘右键可退出。</p>
          <p class="about-line muted">下载新版：daguagua.top</p>
        </div>
      </div>
    </template>
  </div>
</template>

<style>

* { margin:0; padding:0; box-sizing:border-box; }

:root {
  --bg:            #0A0E1A;
  --bg-gradient:   radial-gradient(ellipse at top right, rgba(124,58,237,0.12) 0%, transparent 50%),
                   radial-gradient(ellipse at bottom left, rgba(245,158,11,0.06) 0%, transparent 50%);
  --surface:       #151B2E;
  --surface-2:     #1E2540;
  --border:        #2A3451;
  --border-light:  #3A4563;

  --text:          #F1F5F9;
  --text-2:        #CBD5E1;
  --muted:         #94A3B8;

  --primary:       #7C3AED;
  --primary-hi:    #A78BFA;
  --primary-glow:  rgba(124, 58, 237, 0.35);
  --gold:          #F59E0B;
  --gold-hi:       #FBBF24;
  --danger:        #EF4444;
  --danger-glow:   rgba(239, 68, 68, 0.25);

  --font-display:  'Segoe UI', sans-serif;
  --font-body:     'Segoe UI Variable', 'Segoe UI', -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
}

html, body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-body);
  font-size: 13px;
  user-select: none;
  -webkit-font-smoothing: antialiased;
}

* { scrollbar-width: thin; scrollbar-color: var(--border-light) transparent; }
*::-webkit-scrollbar { width: 5px; height: 5px; }
*::-webkit-scrollbar-thumb { background: var(--border-light); border-radius: 4px; }
button:focus-visible, summary:focus-visible { outline: 2px solid var(--primary-hi); outline-offset: 3px; }

body::before {
  content: '';
  position: fixed;
  inset: 0;
  background: var(--bg-gradient);
  pointer-events: none;
  z-index: 0;
}

.app {
  position: relative;
  height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 16px;
  overflow: hidden;
  z-index: 1;
}

/* ────── 更新提示条 ────── */
.update-banner {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  margin-bottom: 8px;
  background: linear-gradient(135deg, rgba(124, 58, 237, 0.18), rgba(124, 58, 237, 0.06));
  border: 1px solid rgba(167, 139, 250, 0.4);
  border-radius: 8px;
  font-size: 12px;
}
.update-text { flex: 1; color: var(--primary-hi); font-weight: 500; }
.update-actions { display: flex; gap: 6px; }
.btn-update-go, .btn-update-skip {
  padding: 4px 10px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
}
.btn-update-go {
  background: var(--primary);
  color: #fff;
  border-color: var(--primary);
}
.btn-update-go:active { background: #6028c9; }
.btn-update-skip {
  background: transparent;
  color: var(--text-2);
  border-color: var(--border);
}
.btn-update-skip:hover { color: var(--text); }
.update-progress {
  width: 80px;
  height: 4px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 2px;
  overflow: hidden;
}
.update-progress-bar {
  height: 100%;
  background: var(--primary-hi);
  transition: width 0.2s;
}

/* ────── 截图分享 ────── */
.share-area {
  background: var(--bg);
  padding: 2px 0;
}
.share-watermark {
  margin-top: 12px;
  text-align: center;
  font-size: 10px;
  color: var(--muted);
  letter-spacing: 0.5px;
  display: flex;
  justify-content: center;
  gap: 6px;
  opacity: 0.7;
}
.share-watermark .dot { color: var(--primary); }

.btn-share {
  margin-top: 10px;
  padding: 10px;
  border: 1px solid var(--border-light);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.3px;
  cursor: pointer;
  transition: all 0.15s ease;
  width: 100%;
}
.btn-share:hover:not(:disabled) {
  border-color: var(--primary);
  background: var(--surface-2);
}
.btn-share:disabled { opacity: 0.6; cursor: not-allowed; }
.btn-share:active:not(:disabled) { transform: translateY(1px); }

/* ────── 居中页面 ────── */
.center-page {
  min-height: 0; overflow-y: auto;
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center; text-align: center;
}

.brand-logo, .status-ring {
  margin-bottom: 16px;
  filter: drop-shadow(0 0 20px var(--primary-glow));
}
.status-ring { animation: breathe 2.4s ease-in-out infinite; }
@keyframes breathe {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.85; transform: scale(1.05); }
}

.title {
  font-family: var(--font-display);
  font-size: 22px; font-weight: 700; letter-spacing: 0.5px;
  margin-bottom: 8px;
}

.name {
  font-family: var(--font-display);
  color: var(--primary-hi);
  font-size: 16px; font-weight: 600; margin-bottom: 6px;
  letter-spacing: 0.3px;
  text-shadow: 0 0 12px var(--primary-glow);
}

.sub { color: var(--muted); font-size: 13px; }

.rule-tag {
  margin-top: 8px;
  color: var(--gold);
  font-size: 11px;
  padding: 3px 10px;
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.25);
  border-radius: 12px;
}

.err {
  color: var(--danger); font-size: 11px; margin-top: 10px;
  max-width: 320px; word-break: break-all;
  padding: 6px 10px; background: rgba(239, 68, 68, 0.08);
  border-radius: 6px; border: 1px solid rgba(239, 68, 68, 0.2);
}

.dots { display: flex; gap: 5px; margin-top: 18px; }
.dots i {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--primary);
  animation: dot 1.4s ease-in-out infinite;
  display: block;
  box-shadow: 0 0 8px var(--primary-glow);
}
.dots i:nth-child(2) { animation-delay: .2s; }
.dots i:nth-child(3) { animation-delay: .4s; }
@keyframes dot {
  0%,80%,100% { opacity: .3; transform: scale(.8); }
  40% { opacity: 1; transform: scale(1.2); }
}

.row { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }

.btn-s {
  padding: 8px 18px;
  border: 1px solid var(--border-light);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-2);
  font-family: var(--font-display);
  font-size: 12px; font-weight: 600; letter-spacing: 0.5px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.btn-s:hover:not(:disabled) {
  border-color: var(--primary); color: var(--text); background: var(--surface-2);
}
.btn-s:disabled { opacity: .4; cursor: not-allowed; }
.btn-s:active:not(:disabled) { transform: translateY(1px); }

/* ────── 页面容器 ────── */
.page { min-height: 0; flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.page.scrollable { overflow-y: auto; }

/* ────── 导航 ────── */
.nav {
  display: flex; align-items: center; gap: 10px;
  margin-bottom: 14px; padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}

.btn-back {
  padding: 5px 12px;
  border: 1px solid var(--border-light);
  border-radius: 5px;
  background: transparent;
  color: var(--text-2);
  font-family: var(--font-display);
  font-size: 11px; font-weight: 600; letter-spacing: 0.5px;
  cursor: pointer; transition: all 0.15s ease;
  flex-shrink: 0;
}
.btn-back:hover { border-color: var(--primary); color: var(--text); }

.nav-title {
  font-family: var(--font-display);
  font-size: 15px; font-weight: 700; letter-spacing: 0.5px;
}

.nav-meta {
  color: var(--muted); font-size: 11px;
  margin-left: auto; font-variant-numeric: tabular-nums;
}

/* ────── 分组模式切换 ────── */
.mode-toggle {
  display: flex;
  gap: 0;
  margin-bottom: 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 3px;
}
.mode-btn {
  flex: 1;
  padding: 7px 0;
  border: none;
  background: transparent;
  color: var(--muted);
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.5px;
  cursor: pointer;
  border-radius: 5px;
  transition: all 0.2s ease;
}
.mode-btn:hover:not(.active) { color: var(--text-2); }
.mode-btn.active {
  background: var(--primary);
  color: #fff;
  box-shadow: 0 2px 8px var(--primary-glow);
}

.approx-tip {
  font-size: 11px; color: var(--gold);
  margin-bottom: 10px; padding: 6px 10px;
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.2);
  border-radius: 6px;
}

/* ────── 输家高亮 ────── */
.loser-box {
  padding: 14px 14px 12px;
  margin-bottom: 12px;
  background: linear-gradient(135deg, rgba(239,68,68,0.14) 0%, rgba(239,68,68,0.04) 100%);
  border-radius: 10px;
  border: 1px solid rgba(239, 68, 68, 0.35);
  box-shadow: 0 0 20px var(--danger-glow);
  position: relative;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.loser-box::before {
  content: '';
  position: absolute;
  top: 0; left: 12px; right: 12px; height: 2px;
  background: linear-gradient(90deg, transparent, var(--danger), transparent);
}
.loser-name {
  font-family: var(--font-display);
  color: var(--danger);
  font-weight: 700;
  font-size: 17px;
  letter-spacing: 0.3px;
  line-height: 1.35;
  word-break: break-word;
}
.loser-slogan {
  font-size: 13px;
  color: #FCA5A5;
  font-weight: 500;
  letter-spacing: 0.3px;
  line-height: 1.3;
}

/* ────── 队伍卡片 ────── */
.team {
  background: var(--surface);
  border-radius: 8px; padding: 11px 13px; margin-bottom: 6px;
  border: 1px solid var(--border);
  transition: all 0.2s ease;
}
.team:hover { border-color: var(--border-light); }
.team.lose {
  border-color: rgba(239, 68, 68, 0.5);
  background: linear-gradient(135deg, rgba(239,68,68,0.05), var(--surface));
}

.team-top {
  display: flex; align-items: center;
  margin-bottom: 6px; padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}
.team-name {
  font-family: var(--font-display);
  font-weight: 600; font-size: 13px; flex: 1; min-width: 0; overflow-wrap: anywhere; margin-right: 8px; letter-spacing: 0.3px;
}
.team-pts {
  flex-shrink: 0;
  font-family: var(--font-display);
  color: var(--primary-hi); font-weight: 700; font-size: 14px;
  font-variant-numeric: tabular-nums; letter-spacing: 0.5px;
}
.team.lose .team-pts { color: var(--danger); }

.p-row {
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; padding: 3px 0;
}
.p-name {
  flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--text-2);
}
.p-dmg { color: var(--text); width: 52px; text-align: right; font-variant-numeric: tabular-nums; font-weight: 500; }
.p-tkn { color: var(--gold); width: 52px; text-align: right; font-variant-numeric: tabular-nums; }
.p-kda { color: var(--muted); width: 50px; text-align: right; font-variant-numeric: tabular-nums; }

/* ────── 历史列表 ────── */
.h-list { flex: 1; overflow-y: auto; }

.h-item {
  width: 100%; text-align: left; font-family: inherit;
  display: flex; align-items: center; gap: 10px;
  padding: 11px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 7px;
  margin-bottom: 5px;
  cursor: pointer; font-size: 12px;
  transition: all 0.15s ease;
}
.h-item:hover {
  border-color: var(--primary); background: var(--surface-2);
  transform: translateX(2px);
}
.h-mode { font-family: var(--font-display); font-weight: 600; flex: 1; color: var(--text); letter-spacing: 0.3px; }
.h-dur { color: var(--muted); font-variant-numeric: tabular-nums; }
.h-time { color: var(--muted); width: 62px; text-align: right; font-variant-numeric: tabular-nums; }
.h-arrow { color: var(--primary); font-size: 18px; font-weight: 600; }

/* ────── 设置页 ────── */
.section-label {
  font-family: var(--font-display);
  font-size: 11px; color: var(--muted);
  letter-spacing: 1px; text-transform: uppercase;
  margin-bottom: 8px;
}

.rule-list { display: flex; flex-direction: column; gap: 6px; }

.rule-item {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.rule-item:hover { border-color: var(--border-light); }
.rule-item.selected {
  border-color: var(--primary);
  background: linear-gradient(135deg, rgba(124,58,237,0.08), var(--surface));
  box-shadow: 0 0 12px var(--primary-glow);
}
.rule-item input[type="radio"] {
  margin-top: 2px;
  accent-color: var(--primary);
  cursor: pointer;
}
.rule-body { flex: 1; }
.rule-name {
  font-family: var(--font-display);
  font-size: 13px; font-weight: 600;
  color: var(--text); margin-bottom: 3px;
  letter-spacing: 0.3px;
}
.rule-desc { font-size: 11px; color: var(--muted); line-height: 1.5; }
.rule-desc span { display: block; }

.about-box {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px; padding: 10px 12px;
}
.about-line { font-size: 12px; padding: 2px 0; color: var(--text-2); }
.about-line.muted { color: var(--muted); }

.connection-guide { color: var(--muted); font-size: 12px; line-height: 1.7; margin-top: 12px; }
.connection-details { color: var(--muted); font-size: 11px; margin-top: 12px; max-width: 100%; text-align: left; }
.connection-details summary { cursor: pointer; }
.connection-details p { overflow-wrap: anywhere; margin-top: 6px; }
.empty-state { display: grid; gap: 16px; justify-items: center; padding: 30px 12px; color: var(--text-2); line-height: 1.7; overflow-wrap: anywhere; text-align: center; }
.list-note { font-size: 11px; color: var(--muted); margin-bottom: 12px; }
.h-item:disabled { opacity: .5; cursor: wait; }
.p-head span { color: var(--muted); font-weight: 400; font-size: 10px; }
.me-tag { color: var(--primary-hi); font-size: 9px; margin-left: 4px; }
.score-note { color: var(--muted); font-size: 10px; line-height: 1.6; margin-top: 12px; }
.page.scrollable > * { flex-shrink: 0; }
.page.scrollable .h-list { flex-shrink: 1; min-height: 0; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
.rank-tag { color: var(--primary-hi); font-size: 9px; margin-right: 5px; }
.p-row.lowest-player .p-name { color: #FCA5A5; }
</style>
