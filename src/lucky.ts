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

export function randomLuckyNumber(random = () => crypto.getRandomValues(new Uint32Array(1))[0]): number {
  let value: number;
  do { value = random(); } while (value >= 4294967290);
  return value % 10;
}

export function createLuckyNumbers(storage: Storage | undefined = globalThis.localStorage, random = randomLuckyNumber) {
  let draws: Record<string, LuckyDraw> = {};
  let pending: LuckyAnnouncement | null = null;
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
      pending = validAnnouncement(saved?.pending) ? saved.pending : null;
    } catch { /* 无法读取时保留本会话已公开的记录。 */ }
  }
  function save(nextDraws: Record<string, LuckyDraw>, nextPending: LuckyAnnouncement | null) {
    if (!storage) throw new Error("无法保存幸运数字");
    storage.setItem(storageKey, JSON.stringify({ draws: nextDraws, pending: nextPending }));
    draws = nextDraws;
    pending = nextPending;
  }
  load();
  return {
    snapshot: () => ({ ...draws }),
    pending: () => pending,
    get: (gameId: number): LuckyDraw | null => draws[String(gameId)] ?? null,
    // 确认对局时准备数字；同一局切换和重启沿用记录。
    select() {
      load();
      if (pending) return pending;
      const number = random();
      if (!Number.isInteger(number) || number < 0 || number > 9) throw new Error("幸运数字生成失败");
      const announcement = { number, announcedAt: Date.now() };
      save(draws, announcement);
      return announcement;
    },
    discardPending() {
      load();
      if (pending) save(draws, null);
    },
    // 开局只绑定已经公开的数字，不产生随机数。
    bind(gameId: number) {
      if (!Number.isSafeInteger(gameId) || gameId <= 0) throw new Error("无法确定本局对局编号");
      load();
      if (draws[String(gameId)]) return draws[String(gameId)];
      if (!pending) return null;
      const draw = { ...pending, gameId };
      save({ ...draws, [String(gameId)]: draw }, null);
      return draw;
    },
  };
}
