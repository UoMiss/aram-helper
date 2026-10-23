import { reactive } from "vue";
import type { GameResult } from "./rules";

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
export function createAssistant(invoke: Invoke, showResult: () => Promise<void>, clock = defaultClock, isWindowActive: () => Promise<boolean> = async () => true) {
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
  });
  let timer: unknown;
  let running = false;
  let disposed = false;
  let navigation = 0;
  let automaticResult = false;
  let lastAutomaticGame: number | null = null;
  let endHandled = false;

  function navigate(page: Page) {
    navigation++;
    state.page = page;
    state.loading = false;
    state.historyLoading = false;
    state.errorMsg = "";
    automaticResult = false;
  }
  const isCurrent = (id: number) => !disposed && id === navigation;

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
      if (phase === "ChampSelect") await invoke("capture_champ_select").catch(() => {});
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
          const result = await invoke<GameResult>("get_damage_ranking");
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
        ? await invoke<GameResult>("get_damage_ranking")
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
