import { reactive } from "vue";
import { createLuckyNumbers, type GameOpening } from "./lucky.ts";
import type { ScoringMode } from "./scoring";
import { detectBattleMode, type GameResult } from "./grouping.ts";

export interface FriendSummary { puuid: string; displayName: string; }
export interface ManualTrial { mode: ScoringMode; number: number | null; }

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
const activePhases = ["GameStart", "InProgress", "Reconnect"];
const endingPhases = ["WaitingForStats", "PreEndOfGame", "EndOfGame"];
const pregamePhases = ["None", "Lobby", "ChampSelect", "ReadyCheck", "Matchmaking"];
const newGamePhases = ["ChampSelect", "ReadyCheck", "Matchmaking", "GameStart", "InProgress"];

// 连接轮询独立于页面导航；每次请求完成后才安排下一次轮询。
export function createAssistant(invoke: Invoke, showResult: () => Promise<void>, clock = defaultClock, isWindowActive: () => Promise<boolean> = async () => true, luckyNumbers = createLuckyNumbers(), initialScoringMode: ScoringMode = "damage-tail") {
  const state = reactive({
    page: "status" as Page,
    cameFrom: "status" as Page,
    connStatus: "disconnected" as "connected" | "disconnected",
    summonerName: "",
    gamePhase: "",
    currentIsCustomGame: null as boolean | null,
    connectionError: "",
    errorMsg: "",
    loading: false,
    historyLoading: false,
    connecting: false,
    gameResult: null as GameResult | null,
    matchList: [] as MatchSummary[],
    friends: [] as FriendSummary[],
    friendsLoading: false,
    friendsError: "",
    historyOwner: null as FriendSummary | null,
    resultOwner: null as FriendSummary | null,
    trial: null as ManualTrial | null,
    trialError: "",
    luckyDraws: luckyNumbers.snapshot(),
    gameRules: luckyNumbers.rulesSnapshot(),
    rulesLocked: false,
    activeScoringMode: null as ScoringMode | null,
    ruleSettingError: "",
    currentGameId: null as number | null,
    luckyError: "",
    scoringMode: initialScoringMode,
    configuredLuckyNumber: luckyNumbers.configured(),
    luckySettingError: "",
  });
  let timer: unknown;
  let running = false;
  let disposed = false;
  let navigation = 0;
  let friendsRequest = 0;
  let automaticResult = false;
  let lastAutomaticGame: number | null = null;
  let endHandled = false;
  let opening: GameOpening | null = luckyNumbers.opening();
  let pendingResultId: number | null = null;
  let settlementPending = false;
  let lastPregameAt = 0;

  function navigate(page: Page) {
    navigation++;
    state.page = page;
    state.loading = false;
    state.historyLoading = false;
    state.errorMsg = "";
    automaticResult = false;
    state.trial = null;
    state.trialError = "";
  }
  const isCurrent = (id: number) => !disposed && id === navigation;

  function setLuckyNumber(number: number | null) {
    if (disposed) return false;
    if (state.rulesLocked) {
      state.luckySettingError = "本局已开始或已锁定，请在对局结束后重新设置。";
      return false;
    }
    try {
      luckyNumbers.setConfiguredNumber(number);
      state.configuredLuckyNumber = luckyNumbers.configured();
      state.luckySettingError = "";
      return true;
    } catch (error) {
      state.luckySettingError = `设置未保存：${String(error)}`;
      return false;
    }
  }

  function setLuckyNumberInput(value: string) {
    if (value !== "" && !/^[0-9]$/.test(value)) {
      state.luckySettingError = "只允许输入 0～9 的单个整数。";
      return false;
    }
    return setLuckyNumber(value === "" ? null : Number(value));
  }

  function selectScoringRule(mode: ScoringMode) {
    if (disposed) return;
    if (state.rulesLocked) {
      state.ruleSettingError = "本局红包规则已锁定，对局结束后可修改。";
      return;
    }
    state.scoringMode = mode;
    state.ruleSettingError = "";
  }

  function syncRules() {
    state.gameRules = luckyNumbers.rulesSnapshot();
    state.luckyDraws = luckyNumbers.snapshot();
    state.configuredLuckyNumber = luckyNumbers.configured();
  }

  type Session = { gameId: number; phase: string };
  const validSession = (session: Session | null, phases: string[]): session is Session =>
    !!session && phases.includes(session.phase) && Number.isSafeInteger(session.gameId) && session.gameId > 0;

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
      if (pregamePhases.includes(phase)) {
        lastPregameAt = Date.now();
        // 战绩延迟到返回大厅后仍可重试；开始新的匹配流程才放弃旧的待结算。
        if (!settlementPending || !["None", "Lobby"].includes(phase)) {
          pendingResultId = null;
          settlementPending = false;
        }
      }
      if (activePhases.includes(phase)) {
        // 在第一个异步会话查询之前冻结设置；后续重试只使用这个快照。
        state.rulesLocked = true;
        if (!opening) {
          const isOpening = phase === "GameStart" || (lastPregameAt > 0 && Date.now() - lastPregameAt <= 15000);
          opening = {
            mode: isOpening ? state.scoringMode : null,
            number: isOpening && state.scoringMode === "lucky-number" ? state.configuredLuckyNumber : null,
            startedAt: Date.now(), gameId: null,
          };
        }
        state.activeScoringMode = opening.mode;
        try {
          luckyNumbers.stageOpening(opening);
          syncRules();
          const active = await invoke<Session | null>("get_active_game");
          if (disposed) return;
          if (validSession(active, activePhases)) {
            state.currentGameId = active.gameId;
            pendingResultId = active.gameId;
            settlementPending = false;
            const age = Date.now() - opening.startedAt;
            if (opening.gameId === null && age >= 0 && age <= 15000) opening = { ...opening, gameId: active.gameId };
            const rule = luckyNumbers.lockGame(active.gameId, opening);
            opening = { ...opening, gameId: active.gameId };
            syncRules();
            state.activeScoringMode = rule.mode;
            if (rule.mode) state.scoringMode = rule.mode;
            state.luckyError = rule.mode === null ? "未记录本局开局规则，不能补设；本局仅展示战绩。"
              : rule.mode === "lucky-number" && rule.number === null
                ? "本局开局时未填写幸运数字，不能补设。" : "";
          } else {
            state.luckyError = "正在等待本局对局编号。";
          }
        } catch (error) {
          if (!disposed) state.luckyError = `本局规则暂不可用：${String(error)}`;
        }
      } else if (endingPhases.includes(phase) || pregamePhases.includes(phase)) {
        if (endingPhases.includes(phase)) {
          // 重启或错过开局时，只从仍处于结算阶段的会话恢复编号。
          // 接口暂时失败时保留本次运行实际观察到的编号，不从历史列表猜测。
          try {
            const session = await invoke<Session | null>("get_active_game");
            if (disposed) return;
            if (pendingResultId === null && validSession(session, endingPhases)) pendingResultId = session.gameId;
          } catch { /* 已观察到的本局编号可继续使用。 */ }
        }
        if (phase === "EndOfGame" && pendingResultId !== null && pendingResultId !== lastAutomaticGame) settlementPending = true;
        state.currentGameId = null;
        state.luckyError = "";
        try {
          luckyNumbers.finishGame(opening !== null);
          opening = null;
          syncRules();
          state.rulesLocked = false;
          state.activeScoringMode = null;
          state.ruleSettingError = "";
          state.luckySettingError = "";
        } catch (error) { state.luckyError = `本局记录更新失败：${String(error)}`; }
      }
      if (disposed) return;
      // 类型查询失败不影响连接、数字锁定和结算，下一次轮询继续尝试。
      let currentType: boolean | null = null;
      if (phase !== "None") {
        try {
          const value = await invoke<boolean | null>("get_current_game_type");
          if (typeof value === "boolean") currentType = value;
        } catch {}
      }
      if (disposed) return;
      state.currentIsCustomGame = currentType;
      // 手动查看的历史结果一直保留，只有自动结算页会随新对局收起。
      if (automaticResult && newGamePhases.includes(phase)) goHome();
      if ((phase === "EndOfGame" || (settlementPending && ["None", "Lobby"].includes(phase)))
        && !endHandled && !state.loading && !state.historyLoading) {
        // 前台保留用户正在阅读的页面；托盘/最小化时仍可显示下一局结算。
        if (state.page !== "status" && await isWindowActive()) return;
        if (disposed) return;
        const id = navigation;
        state.loading = true;
        try {
          const gameId = pendingResultId;
          if (gameId === null) throw new Error("无法确认本局编号，可手动查看历史对局。");
          if (gameId === lastAutomaticGame) { endHandled = true; return; }
          const result = await invoke<GameResult>("get_game_result", { gameId });
          if (!result || result.gameId !== gameId) throw new Error("返回的战绩不是本局，继续等待。");
          if (isCurrent(id)) {
            endHandled = true;
            settlementPending = false;
            lastAutomaticGame = result.gameId;
            navigate("result");
            state.cameFrom = "status";
            state.gameResult = result;
            state.resultOwner = null;
            automaticResult = true;
            await showResult().catch(() => {});
          }
        } catch (error) {
          if (isCurrent(id)) state.errorMsg = `等待本局结算数据，将自动重试。${String(error)}`;
        } finally {
          if (isCurrent(id)) state.loading = false;
        }
      }
    } catch (error) {
      if (!disposed) {
        state.connStatus = "disconnected";
        state.gamePhase = "";
        state.currentIsCustomGame = null;
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
    const source = state.page === "result" ? state.cameFrom : state.page;
    const owner = gameId === undefined ? null : (state.page === "result" ? state.resultOwner : state.historyOwner);
    const id = ++navigation;
    state.loading = true;
    state.errorMsg = "";
    try {
      const result = gameId === undefined
        ? await invoke<GameResult>("get_last_game_result")
        : owner ? await invoke<GameResult>("get_friend_game_result", { gameId, puuid: owner.puuid })
          : await invoke<GameResult>("get_game_result", { gameId });
      if (!isCurrent(id)) return;
      if (!result || (gameId !== undefined && result.gameId !== gameId)) throw new Error("返回的战绩编号不一致");
      if (owner && result.historyOwnerPuuid !== owner.puuid) throw new Error("返回的战绩不属于所选好友");
      navigate("result");
      state.resultOwner = owner;
      state.gameResult = result;
      state.cameFrom = source;
    } catch (error) {
      if (isCurrent(id)) state.errorMsg = `读取对局失败，请稍后重试。${String(error)}`;
    } finally {
      if (isCurrent(id)) state.loading = false;
    }
  }

  async function loadFriends() {
    const id = ++friendsRequest;
    state.friendsLoading = true;
    state.friendsError = "";
    try {
      const friends = await invoke<FriendSummary[]>("get_friends");
      if (!Array.isArray(friends) || friends.some(friend => !friend?.puuid || typeof friend.displayName !== "string")) {
        throw new Error("好友列表数据不完整");
      }
      if (!disposed && id === friendsRequest) state.friends = friends;
    } catch (error) {
      if (!disposed && id === friendsRequest) state.friendsError = `好友列表暂时不可用：${String(error)}`;
    } finally {
      if (!disposed && id === friendsRequest) state.friendsLoading = false;
    }
  }

  async function loadHistory() {
    navigate("history");
    const id = navigation;
    const owner = state.historyOwner;
    state.historyLoading = true;
    state.matchList = [];
    if (!state.friends.length && !state.friendsLoading) void loadFriends();
    try {
      const matches = owner
        ? await invoke<MatchSummary[]>("get_friend_match_list", { puuid: owner.puuid })
        : await invoke<MatchSummary[]>("get_match_list");
      if (!Array.isArray(matches)) throw new Error("战绩列表数据不完整");
      if (isCurrent(id)) state.matchList = matches;
    } catch (error) {
      if (isCurrent(id)) state.errorMsg = `历史记录暂时不可用，请确认客户端已连接。${String(error)}`;
    } finally {
      if (isCurrent(id)) state.historyLoading = false;
    }
  }

  async function selectHistoryOwner(puuid: string) {
    const friend = puuid ? state.friends.find(friend => friend.puuid === puuid) : null;
    if (puuid && !friend) { state.friendsError = "请刷新好友列表后重新选择。"; return; }
    state.historyOwner = friend ? { ...friend } : null;
    await loadHistory();
  }

  function startTrial() {
    if (state.page !== "result" || !state.resultOwner || !state.gameResult) return;
    if (!detectBattleMode(state.gameResult)) { state.trialError = "无法识别对局类型，暂不能试算。"; return; }
    // 试算只读取当前偏好，不写入开局规则或待配置幸运数字。
    state.trial = { mode: state.scoringMode, number: null };
    state.trialError = "";
  }
  function setTrialRule(mode: ScoringMode) {
    if (state.trial && (mode === "damage-tail" || mode === "lucky-number")) {
      state.trial.mode = mode;
      state.trialError = "";
    }
  }
  function setTrialNumberInput(value: string) {
    if (!state.trial) return false;
    if (value !== "" && !/^[0-9]$/.test(value)) {
      state.trialError = "只允许输入 0～9 的单个整数。";
      return false;
    }
    state.trial.number = value === "" ? null : Number(value);
    state.trialError = "";
    return true;
  }
  function stopTrial() { state.trial = null; state.trialError = ""; }
  function goHome() {
    navigate("status");
    state.gameResult = null;
    state.resultOwner = null;
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
    setLuckyNumber,
    setLuckyNumberInput,
    viewLastGame: () => viewResult(),
    viewGame: (gameId: number) => viewResult(gameId),
    loadHistory,
    loadFriends,
    selectHistoryOwner,
    startTrial,
    setTrialRule,
    setTrialNumberInput,
    stopTrial,
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
