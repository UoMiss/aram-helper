import type { ScoringMode } from "./scoring";

export interface GameOpening {
  mode: ScoringMode | null;
  number: number | null;
  startedAt: number;
  gameId: number | null;
}
export interface GameRule {
  gameId: number;
  mode: ScoringMode | null;
  number: number | null;
  lockedAt: number;
}

export interface LuckyAnnouncement {
  number: number;
  announcedAt: number;
}
export interface LuckyDraw extends LuckyAnnouncement {
  gameId: number;
}
interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const storageKey = "luckyState";
const validAnnouncement = (value: unknown): value is LuckyAnnouncement => {
  const item = value as LuckyAnnouncement | null;
  return !!item && Number.isInteger(item.number) && item.number >= 0 && item.number <= 9
    && Number.isFinite(item.announcedAt);
};

export function createLuckyNumbers(storage: Storage | undefined = globalThis.localStorage) {
  let draws: Record<string, LuckyDraw> = {};
  let configured: number | null = null;
  let rules: Record<string, GameRule> = {};
  let opening: GameOpening | null = null;
  const validMode = (mode: unknown) => mode === null || mode === "damage-tail" || mode === "lucky-number";
  const validNumber = (number: unknown) => number === null || (typeof number === "number" && Number.isInteger(number) && number >= 0 && number <= 9);
  function load() {
    try {
      const saved = JSON.parse(storage?.getItem(storageKey) ?? "null");
      const records = saved?.draws ?? JSON.parse(storage?.getItem("luckyDraws") ?? "{}");
      draws = {};
      if (records && typeof records === "object") {
        for (const [key, value] of Object.entries(records)) {
          const draw = value as LuckyDraw;
          if (validAnnouncement(draw) && Number.isSafeInteger(draw.gameId) && draw.gameId > 0 && key === String(draw.gameId)) draws[key] = draw;
        }
      }
      // 旧版手动待用数字恢复为可编辑配置；已结算记录保持不变。
      const manualPending = [2, 3].includes(saved?.version) && validAnnouncement(saved?.pending) ? saved.pending.number : null;
      const setting = [3, 4, 5].includes(saved?.version) ? saved.configured ?? manualPending : manualPending;
      configured = typeof setting === "number" && Number.isInteger(setting) && setting >= 0 && setting <= 9 ? setting : null;
      rules = {};
      // 旧版已确认数字按幸运规则迁移；没有记录的旧局不猜测规则。
      for (const draw of Object.values(draws)) rules[String(draw.gameId)] = {
        gameId: draw.gameId, mode: "lucky-number", number: draw.number, lockedAt: draw.announcedAt,
      };
      if (saved?.version === 5 && saved.rules && typeof saved.rules === "object") {
        for (const [key, value] of Object.entries(saved.rules)) {
          const rule = value as GameRule | null;
          if (rule && Number.isSafeInteger(rule.gameId) && rule.gameId > 0 && key === String(rule.gameId)
            && validMode(rule.mode) && validNumber(rule.number) && Number.isFinite(rule.lockedAt)
            && (rule.mode === "lucky-number" || rule.number === null)) rules[key] = rule;
        }
      }
      const pending = saved?.version === 5 ? saved.opening as GameOpening | null : null;
      opening = pending && validMode(pending.mode) && validNumber(pending.number) && Number.isFinite(pending.startedAt)
        && (pending.gameId === null || (Number.isSafeInteger(pending.gameId) && pending.gameId > 0))
        ? pending : null;
    } catch { /* 无法读取时保留本会话已公开的记录。 */ }
  }
  function save(nextDraws: Record<string, LuckyDraw>, nextConfigured: number | null, nextRules = rules, nextOpening = opening) {
    if (!storage) throw new Error("无法保存幸运数字");
    storage.setItem(storageKey, JSON.stringify({ version: 5, draws: nextDraws, configured: nextConfigured, rules: nextRules, opening: nextOpening }));
    draws = nextDraws;
    configured = nextConfigured;
    rules = nextRules;
    opening = nextOpening;
  }
  load();
  return {
    snapshot: () => ({ ...draws }),
    rulesSnapshot: () => ({ ...rules }),
    opening: () => opening ? { ...opening } : null,
    stageOpening(value: GameOpening) {
      if (configured === null && opening && opening.gameId === value.gameId && opening.mode === value.mode
        && opening.number === value.number && opening.startedAt === value.startedAt) return;
      save(draws, null, rules, { ...value });
    },
    lockGame(gameId: number, value: GameOpening): GameRule {
      if (!Number.isSafeInteger(gameId) || gameId <= 0) throw new Error("无法确定本局对局编号");
      const existing = rules[String(gameId)];
      if (existing) return existing;
      // 无编号的开局快照只允许在短暂恢复窗口内绑定，不能沿用旧局配置。
      const age = Date.now() - value.startedAt;
      const sameGame = value.gameId === gameId || (value.gameId === null && age >= 0 && age <= 15000);
      const rule: GameRule = {
        gameId, mode: sameGame ? value.mode : null,
        number: sameGame && value.mode === "lucky-number" ? value.number : null,
        lockedAt: value.startedAt,
      };
      const nextDraws = { ...draws };
      if (rule.mode === "lucky-number" && rule.number !== null) nextDraws[String(gameId)] = {
        gameId, number: rule.number, announcedAt: rule.lockedAt,
      };
      save(nextDraws, configured, { ...rules, [String(gameId)]: rule }, { ...value, gameId });
      return rule;
    },
    finishGame(hadOpening = false) {
      if (opening || hadOpening) save(draws, null, rules, null);
    },
    configured: () => configured,
    setConfiguredNumber(number: number | null) {
      if (number !== null && (!Number.isInteger(number) || number < 0 || number > 9)) throw new Error("只允许输入 0～9 的整数");
      load();
      if (!storage) throw new Error("无法保存幸运数字");
      save(draws, number);
    },
    get: (gameId: number): LuckyDraw | null => draws[String(gameId)] ?? null,
    clearConfiguration() {
      load();
      if (configured !== null) save(draws, null);
    },
    // 进入游戏时将数字与对局编号一起保存，并消耗本次配置。
    confirm(gameId: number) {
      if (!Number.isSafeInteger(gameId) || gameId <= 0) throw new Error("无法确定本局对局编号");
      load();
      if (draws[String(gameId)]) return draws[String(gameId)];
      if (configured === null) throw new Error("本局未填写幸运数字，请在下一局进入游戏前填写");
      const draw = { number: configured, announcedAt: Date.now(), gameId };
      save({ ...draws, [String(gameId)]: draw }, null);
      return draw;
    },
  };
}
