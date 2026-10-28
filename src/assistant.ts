import { reactive } from "vue";
import { createLuckyNumbers } from "./lucky.ts";
import type { ScoringMode } from "./scoring";
import type { GameResult } from "./grouping";

type Page = "status" | "result" | "history" | "settings";
export interface MatchSummary {
  gameId: number;
  gameMode: string;
  gameDuration: number;
  timestamp: number;
  championId: number;
}
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
interface Clock {
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}
const defaultClock: Clock = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const newGamePhases = ["ChampSelect", "ReadyCheck", "Matchmaking", "GameStart", "InProgress"];

// 连接轮询独立于页面导航；每次请求完成后才安排下一次轮询。
export function createAssistant(invoke: Invoke, showResult: () => Promise<void>, clock = defaultClock, isWindowActive: () => Promise<boolean> = async () => true, luckyNumbers = createLuckyNumbers(), initialScoringMode: ScoringMode = "damage-tail") {
  const state = reactive({
    page: "status" as Page,
    cameFrom: "status" as Page,
    connStatus: "disconnected" as "connected" | "disconnected",
    summonerName: "",
    gamePhase: "",
    connectionError: "",
    errorMsg: "",
    loading: false,
    historyLoading: false,
    connecting: false,
    gameResult: null as GameResult | null,
    matchList: [] as MatchSummary[],
    luckyDraws: luckyNumbers.snapshot(),
    currentGameId: null as number | null,
    luckyError: "",
    scoringMode: initialScoringMode,
    pendingLuckyDraw: luckyNumbers.pending(),
  });
  let timer: unknown;
  let running = false;
  let disposed = false;
  let navigation = 0;
  let automaticResult = false;
  let lastAutomaticGame: number | null = null;
  let endHandled = false;
  let pendingSeenBeforeStart = false;
  let lastPregameAt = 0;

  function navigate(page: Page) {
    navigation++;
    state.page = page;
    state.loading = false;
    state.historyLoading = false;
    state.errorMsg = "";
    automaticResult = false;
  }
  const isCurrent = (id: number) => !disposed && id === navigation;

  function selectScoringRule(mode: ScoringMode) {
    if (disposed) return;
    state.scoringMode = mode;
    state.luckyError = "";
    if (mode !== "lucky-number") return;
    // 已结束的结果和正在进行的对局只恢复既有记录，不抽新数。
    const gameId = state.page === "result" ? state.gameResult?.gameId : state.currentGameId;
    if (gameId && luckyNumbers.get(gameId)) {
      state.luckyDraws[String(gameId)] = luckyNumbers.get(gameId)!;
      return;
    }
    if (state.page === "result" || ["GameStart", "InProgress", "Reconnect", "WaitingForStats", "PreEndOfGame", "EndOfGame"].includes(state.gamePhase)) {
      state.luckyError = "本局未在游戏开始前选择幸运数字规则，不补抽；请在下一局开始前选择。";
      return;
    }
    // 设置只保存规则；已经处于确认/选英雄阶段时才为本局准备数字。
    if (!["ReadyCheck", "ChampSelect"].includes(state.gamePhase)) return;
    try {
      state.pendingLuckyDraw = luckyNumbers.select();
      pendingSeenBeforeStart = state.connStatus === "connected";
    } catch (error) {
      state.luckyError = `幸运数字暂不可用：${String(error)}`;
    }
  }

  async function poll() {
    if (disposed || running) return;
    clock.clearTimeout(timer);
    running = true;
    try {
      if (state.connStatus === "disconnected") {
        state.connecting = true;
        const name = await invoke<string>("check_connection");
        if (disposed) return;
        state.summonerName = name;
        state.connStatus = "connected";
        state.connectionError = "";
      }
      const phase = await invoke<string>("get_gameflow_phase");
      if (disposed) return;
      state.gamePhase = phase;
      if (phase !== "EndOfGame") endHandled = false;
      if (["None", "Lobby", "ChampSelect", "ReadyCheck", "Matchmaking"].includes(phase)) lastPregameAt = Date.now();
      // 未进入游戏的确认被取消时作废数字，重新弹出确认后重新抽取。
      if (["None", "Lobby", "Matchmaking"].includes(phase) && state.pendingLuckyDraw) {
        try { luckyNumbers.discardPending(); state.pendingLuckyDraw = null; pendingSeenBeforeStart = false; }
        catch (error) { state.luckyError = `幸运数字记录更新失败：${String(error)}`; }
      }
      // 优先在确认对局时抽取；未捕获到确认阶段时保留选英雄阶段的兜底。
      if (["ReadyCheck", "ChampSelect"].includes(phase) && state.scoringMode === "lucky-number" && !state.pendingLuckyDraw) {
        try {
          state.pendingLuckyDraw = luckyNumbers.select();
          state.luckyError = "";
          await showResult().catch(() => {});
          if (disposed) return;
        }
        catch (error) { state.luckyError = `幸运数字暂不可用：${String(error)}`; }
      }
      if (state.scoringMode === "lucky-number" && state.pendingLuckyDraw
        && ["None", "Lobby", "ChampSelect", "ReadyCheck", "Matchmaking"].includes(phase)) pendingSeenBeforeStart = true;
      if (["GameStart", "InProgress", "Reconnect"].includes(phase)) {
        try {
          const active = await invoke<{ gameId: number; phase: string } | null>("get_active_game");
          if (disposed) return;
          if (active && ["GameStart", "InProgress", "Reconnect"].includes(active.phase)
            && Number.isSafeInteger(active.gameId) && active.gameId > 0) {
            state.currentGameId = active.gameId;
            let draw = luckyNumbers.get(active.gameId);
            if (!draw && state.scoringMode === "lucky-number") {
              // 跳过选英雄状态时，在确认开局后补上本局抽签；不在游戏中途补抽。
              const isOpening = active.phase === "GameStart" || (lastPregameAt > 0 && Date.now() - lastPregameAt <= 15000);
              if (!state.pendingLuckyDraw && isOpening) state.pendingLuckyDraw = luckyNumbers.select();
              if (state.pendingLuckyDraw && (pendingSeenBeforeStart || isOpening)) draw = luckyNumbers.bind(active.gameId);
            }
            if (draw) state.luckyDraws[String(active.gameId)] = draw;
            state.pendingLuckyDraw = luckyNumbers.pending();
            state.luckyError = state.scoringMode === "lucky-number" && !draw
              ? "未记录本局游戏开始前公开的幸运数字，不能补抽。" : "";
            pendingSeenBeforeStart = false;
          } else {
            state.currentGameId = null;
            state.luckyError = state.scoringMode === "lucky-number" ? "正在等待本局对局编号。" : "";
          }
        } catch (error) {
          if (!disposed) {
            state.currentGameId = null;
            state.luckyError = state.scoringMode === "lucky-number" ? `幸运数字暂不可用：${String(error)}` : "";
          }
        }
      } else {
        state.currentGameId = null;
        if (!["ReadyCheck", "ChampSelect"].includes(phase) || state.scoringMode !== "lucky-number" || state.pendingLuckyDraw) state.luckyError = "";
        if (["EndOfGame", "WaitingForStats"].includes(phase)) {
          pendingSeenBeforeStart = false;
          lastPregameAt = 0;
          // 已结束的对局未能绑定时，作废其待用数字，下一局重新抽取。
          if (state.pendingLuckyDraw) {
            try { luckyNumbers.discardPending(); state.pendingLuckyDraw = null; }
            catch (error) { state.luckyError = `幸运数字记录更新失败：${String(error)}`; }
          }
        }
      }
      if (disposed) return;
      // 手动查看的历史结果一直保留，只有自动结算页会随新对局收起。
      if (automaticResult && newGamePhases.includes(phase)) goHome();
      if (phase === "EndOfGame" && !endHandled && !state.loading && !state.historyLoading) {
        // 前台保留用户正在阅读的页面；托盘/最小化时仍可显示下一局结算。
        if (state.page !== "status" && await isWindowActive()) return;
        if (disposed) return;
        const id = navigation;
        state.loading = true;
        try {
          const result = await invoke<GameResult>("get_last_game_result");
          if (isCurrent(id) && result.gameId !== lastAutomaticGame) {
            endHandled = true;
            lastAutomaticGame = result.gameId;
            navigate("result");
            state.cameFrom = "status";
            state.gameResult = result;
            automaticResult = true;
            await showResult().catch(() => {});
          }
        } catch (error) {
          if (isCurrent(id)) state.errorMsg = `结算数据暂未就绪，将自动重试。${String(error)}`;
        } finally {
          if (isCurrent(id)) state.loading = false;
        }
      }
    } catch (error) {
      if (!disposed) {
        state.connStatus = "disconnected";
        state.gamePhase = "";
        state.currentGameId = null;
        state.luckyError = "";
        state.connectionError = String(error);
      }
    } finally {
      running = false;
      state.connecting = false;
      if (!disposed) timer = clock.setTimeout(() => { void poll(); }, state.connStatus === "connected" ? 3000 : 5000);
    }
  }

  async function viewResult(gameId?: number) {
    if (state.loading || state.historyLoading) return;
    const source = state.page;
    const id = ++navigation;
    state.loading = true;
    state.errorMsg = "";
    try {
      const result = gameId === undefined
        ? await invoke<GameResult>("get_last_game_result")
        : await invoke<GameResult>("get_game_result", { gameId });
      if (!isCurrent(id)) return;
      navigate("result");
      state.gameResult = result;
      state.cameFrom = source;
    } catch (error) {
      if (isCurrent(id)) state.errorMsg = `读取对局失败，请稍后重试。${String(error)}`;
    } finally {
      if (isCurrent(id)) state.loading = false;
    }
  }

  async function loadHistory() {
    navigate("history");
    const id = navigation;
    state.historyLoading = true;
    state.matchList = [];
    try {
      const matches = await invoke<MatchSummary[]>("get_match_list");
      if (isCurrent(id)) state.matchList = matches;
    } catch (error) {
      if (isCurrent(id)) state.errorMsg = `历史记录暂时不可用，请确认客户端已连接。${String(error)}`;
    } finally {
      if (isCurrent(id)) state.historyLoading = false;
    }
  }
  function goHome() {
    navigate("status");
    state.gameResult = null;
  }
  function goBack() {
    if (state.page === "result" && state.cameFrom === "history") navigate("history");
    else goHome();
  }
  return {
    state,
    start: poll,
    retryConnection: poll,
    selectScoringRule,
    viewLastGame: () => viewResult(),
    viewGame: (gameId: number) => viewResult(gameId),
    loadHistory,
    goBack,
    goHome,
    openSettings: () => navigate("settings"),
    stop() {
      disposed = true;
      navigation++;
      clock.clearTimeout(timer);
    },
  };
}
