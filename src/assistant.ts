import { reactive } from "vue";
import { createLuckyNumbers, type GameOpening } from "./lucky.ts";
import type { ScoringMode } from "./scoring";
import type { GameResult } from "./grouping";

type Page = "status" | "result" | "history" | "settings";
export interface MatchSummary {
  kills?: number | null;
  deaths?: number | null;
  assists?: number | null;
  endTimestamp?: number | null;
  win?: boolean | null;
  gameId: number;
  gameMode: string;
  queueId?: number | null;
  isCustomGame?: boolean | null;
  gameDuration: number;
  timestamp: number;
  championId: number;
}
export interface LobbyParticipants {
  isCustomGame: boolean;
  members: { puuid: string; summonerName: string; isMe: boolean }[];
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
export function createAssistant(invoke: Invoke, showResult: () => Promise<void>, clock = defaultClock, isWindowActive: () => Promise<boolean> = async () => true, luckyNumbers = createLuckyNumbers(), _initialScoringMode: ScoringMode = "lucky-number") {
  const state = reactive({
    page: "status" as Page,
    cameFrom: "status" as Page,
    connStatus: "disconnected" as "connected" | "disconnected",
    summonerName: "",
    gamePhase: "",
    currentIsCustomGame: null as boolean | null,
    lobbyParticipants: null as LobbyParticipants | null,
    lobbyError: "",
    lockedParticipantPuuids: null as string[] | null,
    connectionError: "",
    errorMsg: "",
    loading: false,
    historyLoading: false,
    connecting: false,
    gameResult: null as GameResult | null,
    matchList: [] as MatchSummary[],
    luckyDraws: luckyNumbers.snapshot(),
    gameRules: luckyNumbers.rulesSnapshot(),
    rulesLocked: false,
    activeScoringMode: null as ScoringMode | null,
    ruleSettingError: "",
    currentGameId: null as number | null,
    luckyError: "",
    scoringMode: "lucky-number" as ScoringMode,
    configuredLuckyNumber: luckyNumbers.configured(),
    luckySettingError: "",
    customPayerCount: luckyNumbers.customPayerCount(),
    payoutSettingError: "",
  });
  let timer: unknown;
  let running = false;
  let disposed = false;
  let navigation = 0;
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

  function setCustomPayerCount(count: number | null) {
    if (disposed) return false;
    if (state.rulesLocked) {
      state.payoutSettingError = "本局红包人数已锁定，对局结束后可修改。";
      return false;
    }
    try {
      luckyNumbers.setCustomPayerCount(count);
      state.customPayerCount = luckyNumbers.customPayerCount();
      state.payoutSettingError = "";
      return true;
    } catch (error) {
      state.payoutSettingError = `红包人数未保存：${String(error)}`;
      return false;
    }
  }

  function setCustomPayerCountInput(value: string) {
    if (!/^[1-9]$/.test(value)) {
      state.payoutSettingError = "只允许输入 1～9 的单个整数。";
      return false;
    }
    return setCustomPayerCount(Number(value));
  }

  function selectScoringRule(mode: ScoringMode) {
    if (disposed) return;
    if (state.rulesLocked) {
      state.ruleSettingError = "本局红包规则已锁定，对局结束后可修改。";
      return;
    }
    if (mode !== "lucky-number") {
      state.ruleSettingError = "伤害尾数规则已停用，新对局仅支持幸运数字。";
      return;
    }
    state.scoringMode = mode;
    state.ruleSettingError = "";
  }

  function syncRules() {
    state.gameRules = luckyNumbers.rulesSnapshot();
    state.luckyDraws = luckyNumbers.snapshot();
    state.configuredLuckyNumber = luckyNumbers.configured();
    state.customPayerCount = state.rulesLocked && opening ? opening.customPayerCount ?? null : luckyNumbers.customPayerCount();
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
      // 房间阶段刷新名单；选英雄期间接口消失时沿用同一轮已确认的房间名单。
      if (pregamePhases.includes(phase)) {
        if (phase === "None") {
          state.lobbyParticipants = null;
          state.lobbyError = "进入房间后自动读取参与者";
        } else {
          try {
            const lobby = await invoke<LobbyParticipants>("get_lobby_participants");
            if (disposed) return;
            if (!lobby || typeof lobby.isCustomGame !== "boolean" || !Array.isArray(lobby.members)
              || !lobby.members.some(m => m.isMe) || lobby.members.some(m => typeof m.puuid !== "string" || !m.puuid)) throw Error("房间成员尚未就绪");
            state.lobbyParticipants = { ...lobby, members: lobby.members.filter((m,i,all) => all.findIndex(n=>n.puuid===m.puuid)===i) };
            state.lobbyError = "";
          } catch {
            if (disposed) return;
            if (phase === "Lobby" || !state.lobbyParticipants) {
              state.lobbyParticipants = null;
              state.lobbyError = "房间或好友名单暂不可用，正在重试";
            }
          }
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
            customPayerCount: isOpening ? state.customPayerCount : null,
            participantPuuids: isOpening && state.lobbyParticipants ? state.lobbyParticipants.members.map(m => m.puuid) : null,
          };
        }
        state.lockedParticipantPuuids = opening.participantPuuids ?? null;
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
            opening = { ...opening, gameId: active.gameId, customPayerCount: rule.customPayerCount ?? null };
            syncRules();
            state.lockedParticipantPuuids = rule.participantPuuids ?? null;
            state.activeScoringMode = rule.mode;
            // 旧局可恢复已锁定规则，新局始终使用幸运数字。
            state.scoringMode = "lucky-number";
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
          state.lockedParticipantPuuids = null;
          if (endingPhases.includes(phase)) state.lobbyParticipants = null;
          state.activeScoringMode = null;
          state.ruleSettingError = "";
          state.luckySettingError = "";
          state.payoutSettingError = "";
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
        state.lobbyParticipants = null;
        state.lobbyError = "客户端已断开";
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
    const id = ++navigation;
    state.loading = true;
    state.errorMsg = "";
    try {
      const result = gameId === undefined
        ? await invoke<GameResult>("get_last_game_result")
        : await invoke<GameResult>("get_game_result", { gameId });
      if (!isCurrent(id)) return;
      if (!result || (gameId !== undefined && result.gameId !== gameId)) throw new Error("返回的战绩编号不一致");
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
    setLuckyNumber,
    setLuckyNumberInput,
    setCustomPayerCount,
    setCustomPayerCountInput,
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
