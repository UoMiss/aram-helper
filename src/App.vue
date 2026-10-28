<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick, toRefs } from "vue";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createAssistant, type MatchSummary } from "./assistant";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import html2canvas from "html2canvas-pro";
import { groupPlayers, detectBattleMode } from "./grouping";
import { circularDigitDistance, damageTail, evaluateDamageTails, evaluateLuckyNumbers, payerCount } from "./scoring";

import { gameLabel } from "./gameMode";
import champions from "./champions.json";

import type { Player } from "./grouping";

const championCatalog: Record<string, { name: string; title: string }> = champions;
const failedPortraits = ref<Record<number, boolean>>({});
function championName(player: Pick<Player, "championId">) {
  return championCatalog[String(player.championId)]?.name ?? `英雄 ${player.championId || "未知"}`;
}
function championPortrait(player: Pick<Player, "championId">) {
  return championCatalog[String(player.championId)] && !failedPortraits.value[player.championId]
    ? `/champions/${player.championId}.png` : null;
}


const assistant = createAssistant(invoke, async () => {
  const window = getCurrentWindow();
  await window.show();
  await window.unminimize();
}, undefined, async () => {
  const window = getCurrentWindow();
  return await window.isVisible() && !await window.isMinimized();
}, undefined);
const { page, connStatus, summonerName, gamePhase, currentIsCustomGame, errorMsg, connectionError,
  loading, historyLoading, connecting, gameResult, matchList, luckyDraws, gameRules, rulesLocked, activeScoringMode, ruleSettingError, currentGameId, luckyError, scoringMode, configuredLuckyNumber, luckySettingError, customPayerCount, payoutSettingError } = toRefs(assistant.state);
const { viewLastGame, loadHistory, viewGame, goBack, openSettings, retryConnection, setLuckyNumberInput, setCustomPayerCount, setCustomPayerCountInput } = assistant;
const appVersion = ref("");

// 结果始终使用这场对局的类型，不受当前房间和旧的手动设置影响。
const battleMode = computed(() => gameResult.value ? detectBattleMode(gameResult.value) : null);
const groupingLabel = computed(() => {
  const mode = page.value === "result" ? battleMode.value : detectBattleMode({ isCustomGame: currentIsCustomGame.value });
  return mode === "custom" ? "自定义模式" : mode === "solo" ? "匹配模式" : "自动识别对局类型";
});
const resultParticipantPuuids = computed(() => gameResult.value ? gameRules.value[String(gameResult.value.gameId)]?.participantPuuids : undefined);
const playerGroups = computed(() => gameResult.value
  ? groupPlayers(gameResult.value, resultParticipantPuuids.value)
  : []);
const missingParticipantIdentity = computed(() => Array.isArray(resultParticipantPuuids.value) && !!gameResult.value?.players.some(p => !p.puuid));
const canShowGroups = computed(() => !missingParticipantIdentity.value && playerGroups.value.length >= 2);
const participants = computed(() => playerGroups.value.flatMap(group => group.players));
const resultCustomPayerCount = computed(() => gameResult.value ? gameRules.value[String(gameResult.value.gameId)]?.customPayerCount ?? null : null);
const paymentCount = computed(() => payerCount(participants.value.length, battleMode.value, resultCustomPayerCount.value));
const participationMessage = computed(() => {
  const count = participants.value.length;
  if (battleMode.value === "solo") return count < 2 ? "匹配模式少于 2 人，不参与红包结算。" : "匹配模式仅支持 2～5 人参与结算。";
  if (battleMode.value === "custom") {
    if (count < 5) return "自定义模式少于 5 人，不参与红包结算。";
    if (count > 10) return "自定义模式仅支持 5～10 人参与结算。";
    return `本局 ${count} 人，指定最后 ${resultCustomPayerCount.value} 人不适用；红包人数必须少于参赛人数。`;
  }
  return "暂无法识别本局类型，不能结算。";
});
const groupingError = computed(() => missingParticipantIdentity.value ? "参赛者身份数据不完整，请重新读取对局。" : resultParticipantPuuids.value === null ? "未记录本局开局参与名单，无法结算红包。请在下一局选英雄前连接助手。" : !battleMode.value
  ? "暂无法识别本局类型，请重新读取对局。"
  : gameResult.value?.players.some((p) => p.teamId == null)
    ? "缺少阵营数据，请重新读取对局。"
    : battleMode.value === "solo" ? "匹配模式少于 2 人，不参与红包结算。" : "缺少双方阵营数据，请重新读取对局。");
const activeLuckyDraw = computed(() => {
  if (scoringMode.value !== "lucky-number") return null;
  if (currentGameId.value !== null) return luckyDraws.value[String(currentGameId.value)] ?? null;
  return null;
});
const luckyInputLocked = rulesLocked;
const luckyInputValue = computed(() => (currentGameId.value ? luckyDraws.value[String(currentGameId.value)]?.number : null)
  ?? configuredLuckyNumber.value ?? "");
function updateCustomPayerInput(event: Event) {
  const input = event.target as HTMLInputElement;
  if (!setCustomPayerCountInput(input.value)) input.value = String(customPayerCount.value ?? "");
}
function updateLuckyInput(event: Event) {
  const input = event.target as HTMLInputElement;
  if (!setLuckyNumberInput(input.value)) input.value = String(luckyInputValue.value);
}
const resultLuckyDraw = computed(() => gameResult.value ? luckyDraws.value[String(gameResult.value.gameId)] ?? null : null);
const luckyResult = computed(() => evaluateLuckyNumbers(participants.value, resultLuckyDraw.value?.number ?? null, battleMode.value, resultCustomPayerCount.value));
watch(scoringMode, (mode) => localStorage.setItem("scoringMode", mode), { immediate: true });
const resultScoringMode = computed(() => gameResult.value ? gameRules.value[String(gameResult.value.gameId)]?.mode ?? null : null);
const displayedScoringMode = computed(() => page.value === "result" ? resultScoringMode.value
  : rulesLocked.value ? activeScoringMode.value : scoringMode.value);
const currentRule = computed(() => ({ name: displayedScoringMode.value === "lucky-number" ? "幸运数字"
  : displayedScoringMode.value === "damage-tail" ? "旧版伤害尾数" : "规则未记录" }));
const scoringResult = computed(() => resultScoringMode.value === null
  ? { status: "missing-rule" as const, lowestPlayers: [] as Player[], tiedPlayers: [] as Player[] }
  : resultScoringMode.value === "lucky-number" ? luckyResult.value : evaluateDamageTails(participants.value, battleMode.value, resultCustomPayerCount.value));
const confirmedPayers = computed(() => scoringResult.value.lowestPlayers.filter(player => !scoringResult.value.tiedPlayers?.includes(player)));
const resultMessage = computed(() => {
  const result = scoringResult.value;
  if (paymentCount.value === 0) return participationMessage.value;
  const names = result.lowestPlayers.map((player) => player.summonerName).join("、");
  if (result.status === "ready") return `发红包：${names}`;
  if (result.status === "tie") {
    const confirmed = confirmedPayers.value.map(player => player.summonerName).join("、");
    const tied = result.tiedPlayers?.map(player => player.summonerName).join("、");
    return `${confirmed ? `已确定发红包：${confirmed}。` : ""}红包分界名次并列：${tied}，需手动选出 ${paymentCount.value - confirmedPayers.value.length} 人。`;
  }
  if (result.status === "missing-rule") return "未记录本局开局规则，仅展示战绩，不使用当前设置重新判定红包。";
  if (result.status === "missing") return "本局没有进入游戏时确认的幸运数字，无法按此规则排名，不在结算后补设。";
  if (result.status === "invalid") return "伤害数据不完整，暂不判定，请重新读取对局。";
  return participationMessage.value;
});

const resultRanking = computed(() => "ranking" in scoringResult.value ? scoringResult.value.ranking ?? [] : []);
const displayedGroups = computed(() => {
  if (!resultRanking.value.length) return playerGroups.value;
  const ranks = new Map(resultRanking.value.map((entry) => [entry.player, entry.rank]));
  const groups = playerGroups.value.map((group) => ({ ...group,
    players: [...group.players].sort((a, b) => ranks.get(a)! - ranks.get(b)!),
  }));
  return battleMode.value === "solo" ? groups.sort((a, b) => ranks.get(a.players[0])! - ranks.get(b.players[0])!) : groups;
});
function playerRank(player: Player) {
  return resultRanking.value.find((entry) => entry.player === player)?.rank;
}

function statWidth(player: Player, field: "damage" | "damageTaken") {
  const value = player[field];
  const max = Math.max(0, ...participants.value.map(p => Number.isFinite(p[field]) ? p[field] : 0));
  return Number.isFinite(value) && max > 0 ? `${Math.max(0, Math.min(100, value / max * 100))}%` : "0%";
}
function luckyDistance(player: Player) {
  const tail = damageTail(player.damage);
  return tail !== null && resultLuckyDraw.value ? circularDigitDistance(tail, resultLuckyDraw.value.number) : "—";
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
  const luckyHeight = scoringMode.value === "lucky-number" ? 80 : 0;
  if (page.value === "status") return 420 + updateHeight + luckyHeight + (scoringMode.value === "lucky-number" && luckySettingError.value ? 38 : 0);
  if (page.value === "history") return 580 + updateHeight;
  if (page.value === "settings") return 550 + updateHeight + (rulesLocked.value || ruleSettingError.value ? 40 : 0) + (payoutSettingError.value ? 38 : 0);
  if (page.value === "result" && gameResult.value) {
    let h = 36 + 62 + 56 + updateHeight;
    if (canShowGroups.value) {
      h += scoringResult.value.status === "ready" ? 110 : 60;
      if (resultScoringMode.value === "lucky-number" && resultLuckyDraw.value) h += 64;
      for (const group of playerGroups.value) h += (battleMode.value === "custom" ? 50 : 8) + group.players.length * 132;
      h += 60;
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

watch([page, playerGroups, battleMode, updateState, scoringMode, gameRules, rulesLocked, ruleSettingError, customPayerCount, payoutSettingError, activeLuckyDraw, luckyError, luckySettingError], () => {
  resizeToContent();
});

// ────── 工具 ──────

function fmt(n: number) { return Math.round(n).toLocaleString(); }
function fmtDur(s: number) { return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`; }
function fmtKda(match: MatchSummary) {
  return [match.kills, match.deaths, match.assists]
    .map(value => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : "—").join(" / ");
}
function historyEndTime(match: MatchSummary): number | null {
  if (typeof match.endTimestamp === "number" && Number.isFinite(match.endTimestamp) && match.endTimestamp > 0) return match.endTimestamp;
  return Number.isFinite(match.timestamp) && match.timestamp > 0 && Number.isFinite(match.gameDuration) && match.gameDuration > 0
    ? match.timestamp + match.gameDuration * 1000 : null;
}
function fmtTime(ts: number | null) {
  if (ts === null) return "结束时间未知";
  const d = new Date(ts), now = new Date();
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  const hh = d.getHours().toString().padStart(2, "0"), mm = d.getMinutes().toString().padStart(2, "0");
  if (days === 0) return `今天 ${hh}:${mm}`;
  if (days === 1) return `昨天 ${hh}:${mm}`;
  const date = `${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  return `${d.getFullYear() === now.getFullYear() ? "" : d.getFullYear()+"-"}${date} ${hh}:${mm}`;
}

function phaseText(p: string) {
  return ({ None:"大厅", Lobby:"房间中", Matchmaking:"匹配中", ReadyCheck:"确认中",
    ChampSelect:"选英雄中", GameStart:"正在进入游戏", InProgress:"游戏中", Reconnect:"重新连接中", WaitingForStats:"结算中", PreEndOfGame:"结算中", EndOfGame:"对局结束" } as Record<string,string>)[p] || p;
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
        <p class="connection-guide">打开并登录客户端后会自动连接。<br />请在选英雄前启动助手，以记录准确分队。</p>
        <div class="dots"><i /><i /><i /></div>
        <div class="row" style="margin-top:16px">
          <button class="btn-s" @click="retryConnection" :disabled="connecting">{{ connecting ? "连接中…" : "重新连接" }}</button>
          <button class="btn-s" @click="openSettings">设置</button>
        </div>
        <p class="connection-guide">仍未连接？尝试以管理员身份重新打开助手。</p>
        <details v-if="connectionError" class="connection-details"><summary>连接详情 · 每 5 秒自动重试</summary><p>{{ connectionError }}</p></details>
      </div>

      <div v-else class="center-page connected-page">
        <div class="status-ring">
          <svg viewBox="0 0 64 64" width="48" height="48">
            <circle cx="32" cy="32" r="28" fill="none" stroke="#7C3AED" stroke-width="2" opacity="0.3"/>
            <path d="M32 14 L32 30 L44 30 L28 50 L28 34 L16 34 Z" fill="#A78BFA"/>
          </svg>
        </div>
        <p class="title">已连接</p>
        <div class="summoner-line">
          <p class="name" :title="summonerName">{{ summonerName }}</p>
          <span class="phase-badge"><i />{{ gamePhase ? phaseText(gamePhase) : "等待对局" }}</span>
        </div>
        <div class="mode-summary"><span>{{ groupingLabel }}</span><span class="meta-dot">·</span><span>{{ currentRule.name }}</span></div>

        <div v-if="scoringMode === 'lucky-number'" class="lucky-status" :class="{ confirmed: !!activeLuckyDraw, missing: !activeLuckyDraw && configuredLuckyNumber === null }" aria-live="polite">
          <div class="lucky-status-copy">
            <span class="lucky-status-title">本局幸运数字</span>
            <strong class="lucky-status-state">{{ activeLuckyDraw ? "已确认" : luckyError ? "暂未确认" : configuredLuckyNumber === null ? "待填写" : "待确认" }}</strong>
            <span class="lucky-status-hint">{{ activeLuckyDraw ? "本局已锁定" : configuredLuckyNumber === null ? luckyInputLocked ? "本局未填写数字" : "在右侧填写 0～9" : "进入游戏时自动确认" }}</span>
          </div>
          <form v-if="!luckyInputLocked" class="lucky-status-form" @submit.prevent>
            <input id="lucky-number" class="lucky-status-input" type="text" inputmode="numeric" pattern="[0-9]"
              autocomplete="off" aria-label="本局幸运数字" :value="luckyInputValue"
              :aria-describedby="luckySettingError ? 'lucky-number-error' : undefined" :aria-invalid="!!luckySettingError" @input="updateLuckyInput" />
          </form>
          <span v-else class="lucky-status-number">{{ activeLuckyDraw?.number ?? "—" }}</span>
        </div>
        <p v-if="scoringMode === 'lucky-number' && luckySettingError" id="lucky-number-error" class="err" role="alert">{{ luckySettingError }}</p>
        <p v-if="luckyError" class="err" role="alert">{{ luckyError }}</p>
        <p class="connection-guide">{{ gamePhase === "WaitingForStats" ? "正在等待客户端生成结算数据…" : "对局结束自动结算，关闭窗口可收进托盘。" }}</p>
        <div class="status-actions">
          <button class="btn-s" @click="viewLastGame" :disabled="loading">{{ loading ? "加载中…" : "上一局" }}</button>
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
          <div class="result-heading">
            <span class="nav-title">{{ currentRule.name }}</span>
            <span class="result-mode">{{ gameLabel(gameResult) }}</span>
          </div>
          <span class="nav-meta result-duration">{{ fmtDur(gameResult.gameDuration) }}</span>
        </div>

        <div v-if="!canShowGroups" class="center-page" style="padding:24px 0">
          <p class="sub">{{ groupingError }}</p>
          <button class="btn-s" style="margin-top:12px" @click="viewGame(gameResult.gameId)" :disabled="loading">{{ loading ? "读取中…" : "重新读取" }}</button>
          <p v-if="errorMsg" class="err">{{ errorMsg }}</p>
        </div>

        <template v-else>
          <!-- 截图区域 -->
          <div ref="resultArea" class="share-area">
            <p v-if="resultScoringMode && paymentCount > 0" class="payout-note">本局 {{ participants.length }} 人参与 · 最后 {{ paymentCount }} 名发红包</p>
            <p v-if="resultScoringMode && paymentCount === 0" class="payout-note">本局 {{ participants.length }} 人 · 不参与红包结算</p>
            <p v-if="battleMode === 'custom' && paymentCount > 0 && resultCustomPayerCount !== null" class="list-note">红包人数：开局指定 {{ resultCustomPayerCount }} 人</p>
            <p v-if="battleMode === 'custom' && resultRanking.length" class="list-note">本局参与者统一排名，阵营仅用于展示。</p>
            <div v-if="resultScoringMode === 'lucky-number' && resultLuckyDraw" class="result-lucky">
              <div class="result-lucky-value">
                <span class="result-lucky-label">幸运数字</span>
                <strong class="result-lucky-number">{{ resultLuckyDraw.number }}</strong>
              </div>
              <span class="result-lucky-lock">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="3.5" y="7" width="9" height="7" rx="2" stroke="currentColor"/><path d="M5.5 7V4.5a2.5 2.5 0 0 1 5 0V7" stroke="currentColor"/></svg>
                本局已锁定
              </span>
            </div>
            <div v-if="scoringResult.status === 'ready'" class="loser-box">
              <div class="payout-heading"><span>本局发红包</span><span class="payout-count">{{ confirmedPayers.length }} 人</span></div>
              <div class="loser-name"><span v-for="p in confirmedPayers" :key="p.summonerName" class="payout-person">{{ p.summonerName }}<b v-if="p.isMe" class="me-tag">我</b></span></div>
            </div>
            <p v-else class="approx-tip" role="status">{{ resultMessage }}</p>

            <section v-for="(team, i) in displayedGroups" :key="i" class="team"
              :class="{ 'solo-team': battleMode === 'solo', 'red-team': team.players[0]?.teamId === 200 }">
              <div v-if="battleMode === 'custom'" class="team-top">
                <span class="team-name">{{ team.name }}</span>
                <span class="team-count">{{ team.players.length }} 人</span>
              </div>
              <div v-for="p in team.players" :key="p.summonerName" class="settlement-player" :class="{ 'payer-player': confirmedPayers.includes(p), 'self-player': p.isMe }">
                <div class="player-hero">
                  <img v-if="championPortrait(p)" class="champion-portrait" :src="championPortrait(p)!" :alt="championName(p)" @error="failedPortraits[p.championId] = true" />
                  <span v-else class="champion-portrait portrait-fallback" aria-hidden="true">?</span>
                  <span class="champion-name" :title="championName(p)">{{ championName(p) }}</span>
                  <span class="player-kda" title="击杀 / 死亡 / 助攻">{{ p.kills }}/{{ p.deaths }}/{{ p.assists }}</span>
                </div>
                <div class="player-detail">
                  <div class="player-heading">
                    <span class="player-summoner" :title="p.summonerName">{{ p.summonerName }}<b v-if="p.isMe" class="me-tag">我</b></span>
                    <b v-if="playerRank(p)" class="player-rank" :class="{ first: playerRank(p) === 1 }" :title="`红包排名第 ${playerRank(p)} 名`">#{{ playerRank(p) }}</b>
                  </div>
                  <div class="player-metrics">
                    <div class="player-stat">
                      <span class="stat-label">输出伤害</span>
                      <span class="stat-track" title="长度相对于本局参与者中的最高输出伤害"><i :style="{ width: statWidth(p, 'damage') }"></i><strong>{{ fmt(p.damage) }}</strong></span>
                    </div>
                    <div class="player-stat">
                      <span class="stat-label">承受伤害</span>
                      <span class="stat-track taken" title="长度相对于本局参与者中的最高承受伤害"><i :style="{ width: statWidth(p, 'damageTaken') }"></i><strong>{{ fmt(p.damageTaken) }}</strong></span>
                    </div>
                  </div>
                  <div class="player-rule-line">
                    <span>伤害尾数 <b>{{ damageTail(p.damage) ?? "—" }}</b><template v-if="resultScoringMode === 'lucky-number' && resultLuckyDraw"><span class="rule-separator">·</span>距离 <b>{{ luckyDistance(p) }}</b></template></span>
                    <span v-if="confirmedPayers.includes(p)" class="payer-tag">发红包</span>
                    <span v-else-if="scoringResult.tiedPlayers?.includes(p)" class="tie-tag">并列待定</span>
                  </div>
                </div>
              </div>
            </section>


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
            <img v-if="championPortrait(m)" class="history-portrait" :src="championPortrait(m)!" :alt="championName(m)" :title="championName(m)" @error="failedPortraits[m.championId] = true" />
            <span v-else class="history-portrait portrait-fallback" aria-label="英雄头像暂不可用">?</span>
            <span class="h-info">
              <span class="outcome-tag" :class="{ won: m.win === true, lost: m.win === false }">{{ m.win === true ? "胜利" : m.win === false ? "失败" : "胜负未知" }}</span>
              <span class="h-mode" :title="gameLabel(m)">{{ gameLabel(m) }}</span>
            </span>
            <span class="h-meta">
              <span class="h-kda" aria-label="K/D/A" title="击杀 / 死亡 / 助攻">{{ fmtKda(m) }}</span>
              <span class="h-time" :title="m.endTimestamp ? '对局结束时间' : '结束时间：根据开始时间与时长推算'">{{ fmtTime(historyEndTime(m)) }}</span>
            </span>
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

        <p class="section-label">红包规则</p>
        <div class="rule-list">
          <div class="rule-item selected">
            <div class="rule-body">
              <div class="rule-name">幸运数字</div>
              <div class="rule-desc"><span>环形距离越近越靠前，同分逐位比。</span></div>
            </div>
          </div>
        </div>

        <p v-if="rulesLocked || ruleSettingError" class="approx-tip" role="status">{{ ruleSettingError || "本局红包规则已锁定，对局结束后可修改。" }}</p>

        <p class="section-label" style="margin-top:16px">自定义红包人数</p>
        <div class="payout-settings">
          <label><input type="radio" name="custom-payout" :checked="customPayerCount === null" :disabled="rulesLocked" @click="setCustomPayerCount(null)" />按人数自动</label>
          <p class="payout-help">5～6 人末 3 名 · 7～8 人末 4 名 · 9～10 人末 5 名</p>
          <label><input type="radio" name="custom-payout" :checked="customPayerCount !== null" :disabled="rulesLocked" @click="setCustomPayerCount(customPayerCount ?? 3)" />指定最后
            <input class="payout-number" type="text" inputmode="numeric" pattern="[1-9]" aria-label="自定义发红包人数" :aria-invalid="!!payoutSettingError"
              :value="customPayerCount ?? ''" :disabled="rulesLocked || customPayerCount === null" placeholder="1～9" @input="updateCustomPayerInput" />人
          </label>
          <p class="payout-help">至少 5 人参赛；指定人数须少于参赛人数。</p>
          <p v-if="payoutSettingError" class="err" role="alert">{{ payoutSettingError }}</p>
        </div>

        <p class="section-label" style="margin-top:16px">关于</p>
        <div class="about-box">
          <p class="about-line">LOL 红包局助手 <span v-if="appVersion">v{{ appVersion }}</span></p>
          <p class="about-line muted">对局结束自动显示结果，红包规则在设置中配置</p>
          <p class="about-line muted">关闭窗口后继续运行；托盘右键可退出。</p>
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
  background: transparent;
  padding: 2px 0;
}
.payout-note { margin: 10px 0; color: var(--muted); font-size: 11px; text-align: center; }


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

.connected-page { padding: 18px 8px; }
.connected-page > * { flex-shrink: 0; }
.connected-page .status-ring { margin-bottom: 12px; }
.connected-page .title { font-size: 21px; margin-bottom: 10px; }
.summoner-line { display: flex; align-items: center; justify-content: center; gap: 10px; max-width: 100%; }
.summoner-line .name { font-size: 14px; margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.phase-badge { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; padding: 3px 7px; border-radius: 5px; color: var(--text-2); background: var(--surface); font-size: 10px; }
.phase-badge i { width: 5px; height: 5px; border-radius: 50%; background: #34d399; }
.mode-summary { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 12px; color: var(--muted); font-size: 11px; }
.meta-dot { color: var(--border-light); }
.lucky-status { width: 100%; max-width: 320px; display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 20px; padding: 14px 20px; text-align: left; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
.lucky-status-copy { display: flex; flex-direction: column; gap: 5px; }
.lucky-status-title { font-size: 11px; color: var(--muted); }
.lucky-status-state { font-size: 15px; color: var(--text); font-weight: 600; }
.lucky-status-hint { font-size: 10px; color: var(--muted); }
.lucky-status-number { font-family: var(--font-display); font-size: 48px; font-weight: 700; line-height: 1; color: var(--primary-hi); font-variant-numeric: tabular-nums; }
.lucky-status-form { flex: 0 0 82px; }
.lucky-status-input {
  width: 82px; height: 66px; padding: 4px; border: 1px solid var(--border-light); border-radius: 10px;
  background: var(--surface-2); color: var(--primary-hi); text-align: center;
  font: 700 38px/1 var(--font-display); font-variant-numeric: tabular-nums;
}
.lucky-status-input::placeholder { color: var(--muted); font-size: 20px; font-weight: 400; }
.lucky-status-input:focus { outline: 2px solid var(--primary); outline-offset: 2px; }
.lucky-status-input[aria-invalid="true"] { border-color: var(--danger); }
.lucky-status.confirmed { border-color: rgba(245,158,11,0.35); background: linear-gradient(110deg, rgba(245,158,11,0.07), var(--surface)); }
.lucky-status.confirmed .lucky-status-state, .lucky-status.confirmed .lucky-status-number { color: var(--gold); }
.lucky-status.missing .lucky-status-number { color: var(--muted); }
.connected-page .connection-guide { max-width: 320px; margin-top: 16px; font-size: 10px; }
.status-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; width: 100%; max-width: 320px; margin-top: 20px; }
.status-actions .btn-s { min-width: 0; padding: 9px 4px; }

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

.result-heading { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.result-mode { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
.result-duration { flex-shrink: 0; white-space: nowrap; }

.nav-meta {
  color: var(--muted); font-size: 11px;
  margin-left: auto; font-variant-numeric: tabular-nums;
}

.rule-choice { display: flex; align-items: flex-start; gap: 10px; flex: 1; min-width: 0; cursor: pointer; }

.result-lucky { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; padding: 10px 14px; border: 1px solid rgba(245,158,11,.24); border-radius: 9px; background: linear-gradient(110deg, rgba(245,158,11,.09), var(--surface)); }
.result-lucky-value { display: flex; align-items: center; gap: 12px; }
.result-lucky-label { color: var(--text-2); font-size: 12px; }
.result-lucky-number { min-width: 36px; text-align: center; padding: 5px 0; border-radius: 8px; background: rgba(245,158,11,.08); color: var(--gold-hi); font-family: var(--font-display); font-size: 30px; line-height: 1; font-variant-numeric: tabular-nums; }
.result-lucky-lock { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; color: var(--muted); font-size: 10px; white-space: nowrap; }

.approx-tip {
  font-size: 11px; color: var(--gold);
  margin-bottom: 10px; padding: 6px 10px;
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.2);
  border-radius: 6px;
}

/* ────── 红包名单 ────── */
.loser-box { margin-bottom: 16px; padding: 14px; border: 1px solid rgba(248,113,113,.25); border-radius: 12px; background: linear-gradient(120deg,rgba(239,68,68,.09),rgba(239,68,68,.025)); }
.payout-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; color: #fda4a4; font-size: 11px; font-weight: 600; }
.payout-count { color: var(--muted); font-size: 10px; font-weight: 400; }
.loser-name { display: flex; flex-wrap: wrap; gap: 6px; }
.payout-person { max-width: 100%; padding: 5px 8px; border: 1px solid rgba(248,113,113,.12); border-radius: 6px; background: rgba(248,113,113,.055); color: #fecaca; font-size: 12px; font-weight: 600; overflow-wrap: anywhere; line-height: 1.5; }

/* ────── 结算分队与玩家 ────── */
.team { --team-accent: #53c7e1; margin-bottom: 14px; background: linear-gradient(145deg, #171f33, #12192b); border: 1px solid rgba(148,163,184,.19); border-radius: 12px; overflow: hidden; }
.team.red-team { --team-accent: #ed8b89; }
.team.solo-team { margin-bottom: 10px; }
.team-top { display: flex; justify-content: space-between; align-items: center; padding: 10px 13px; border-bottom: 1px solid var(--border); border-left: 3px solid var(--team-accent); background: rgba(148,163,184,.04); }
.team-name { color: var(--team-accent); font-size: 13px; font-weight: 700; }
.team-count { color: var(--muted); font-size: 11px; }
.settlement-player { display: flex; gap: 13px; padding: 15px 12px; border-bottom: 1px solid var(--border); }
.settlement-player:last-child { border-bottom: 0; }
.settlement-player.payer-player { background: linear-gradient(100deg, rgba(239,68,68,.065), transparent); }
.settlement-player.self-player { box-shadow: inset 2px 0 0 rgba(167,139,250,.6); }
.player-hero { display: flex; flex-direction: column; align-items: center; gap: 4px; width: 65px; flex-shrink: 0; }
.champion-portrait { width: 48px; height: 48px; border-radius: 10px; border: 1px solid var(--border-light); object-fit: cover; }
.portrait-fallback { display: grid; place-items: center; background: var(--surface); color: var(--muted); }
.champion-name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: var(--muted); }
.player-kda { padding: 2px 4px; border-radius: 4px; background: rgba(148,163,184,.06); color: var(--text-2); font-size: 10px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.player-detail { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: space-between; gap: 10px; }
.player-heading { display: flex; align-items: center; justify-content: space-between; gap: 7px; }
.player-summoner { min-width: 0; overflow-wrap: anywhere; color: var(--text); font-size: 12px; font-weight: 600; }
.player-rank { display: inline-flex; align-items: center; justify-content: center; min-width: 30px; height: 24px; padding: 0 6px; border-radius: 7px; background: rgba(167,139,250,.08); border: 1px solid rgba(167,139,250,.1); color: #c4b5fd; font-size: 12px; flex-shrink: 0; font-variant-numeric: tabular-nums; }
.player-rank.first { color: #fcd882; background: rgba(245,158,11,.09); border-color: rgba(245,158,11,.18); }
.player-metrics { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; }
.player-stat { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.stat-label { color: var(--muted); font-size: 10px; }
.stat-track { position: relative; display: block; border-radius: 4px; overflow: hidden; background: rgba(148,163,184,.045); padding: 4px 6px 7px; }
.stat-track i { position: absolute; bottom: 0; left: 0; height: 3px; border-radius: 0 2px 2px 0; background: linear-gradient(90deg,#266b86,#53c7e1); }
.stat-track.taken i { background: linear-gradient(90deg,#615291,#b6a1ea); }
.stat-track strong { position: relative; color: var(--text); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.player-rule-line { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 5px; color: var(--muted); font-size: 10px; }
.player-rule-line b { color: var(--gold); font-size: 13px; font-variant-numeric: tabular-nums; }
.rule-separator { margin: 0 6px; }
.payer-tag, .tie-tag { padding: 2px 6px; border-radius: 4px; font-size: 9px; }
.payer-tag { color: #fecaca; border: 1px solid rgba(248,113,113,.15); background: rgba(239,68,68,.1); }
.tie-tag { color: var(--gold); background: rgba(245,158,11,.1); }
.outcome-tag { color: var(--muted); }
@media(max-width:360px) { .settlement-player { gap: 8px; padding: 12px 8px; } .player-hero { width: 56px; } }

/* ────── 历史列表 ────── */
.h-list { flex: 1; overflow-y: auto; }

.h-item {
  width: 100%; text-align: left; font-family: inherit;
  display: flex; align-items: center; gap: 11px;
  padding: 15px 0; background: transparent;
  border: 0; border-bottom: 1px solid var(--border); border-radius: 0;
  cursor: pointer; font-size: 12px; transition: background .15s ease;
}
.h-item:hover { background: var(--surface); }
.h-item:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
.history-portrait { width: 44px; height: 44px; flex-shrink: 0; object-fit: cover; border: 1px solid var(--border-light); border-radius: 9px; }
.h-info { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; flex: 1; min-width: 0; }
.h-info .outcome-tag { padding: 0; background: none; font-size: 15px; font-weight: 700; line-height: 1.3; }
.h-info .outcome-tag.won { color: #22c6d5; }
.h-info .outcome-tag.lost { color: #f87171; }
.h-mode { width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--muted); }
.h-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex-shrink: 0; font-variant-numeric: tabular-nums; }
.h-kda { white-space: nowrap; color: var(--text-2); font-size: 13px; }
.h-time { white-space: nowrap; color: var(--muted); font-size: 10px; }
.h-arrow { color: var(--muted); font-size: 21px; flex-shrink: 0; }
@media(max-width:360px) { .h-item { gap: 7px; } .history-portrait { width: 36px; height: 36px; } }

/* ────── 设置页 ────── */
.section-label {
  font-family: var(--font-display);
  font-size: 11px; color: var(--muted);
  letter-spacing: 1px; text-transform: uppercase;
  margin-bottom: 8px;
}

.rule-list { display: flex; flex-direction: column; gap: 6px; }

.rule-item {
  flex-wrap: wrap;
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
.page.scrollable > * { flex-shrink: 0; }
.page.scrollable .h-list { flex-shrink: 1; min-height: 0; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
.payout-settings { border: 1px solid var(--border); background: var(--surface); border-radius: 10px; padding: 12px 14px; }
.payout-settings label { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.payout-settings input[type="radio"] { accent-color: var(--primary-hi); }
.payout-help { font-size: 10px; color: var(--muted); margin: 8px 0 12px; line-height: 1.5; }
.payout-help:last-child { margin-bottom: 0; }
.payout-number { width: 48px; padding: 5px; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 5px; text-align: center; }
.payout-number:disabled { opacity: .5; }
.rank-tag { color: var(--primary-hi); font-size: 9px; margin-right: 5px; }
.p-row.lowest-player .p-name { color: #FCA5A5; }
button:focus-visible { outline: 2px solid var(--primary-hi); outline-offset: 3px; }
.page.scrollable, .h-list { scrollbar-width: thin; scrollbar-color: #3a4563 transparent; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
</style>
