import type { BattleMode } from "./grouping";

// 伤害尾数只读取精确对英雄伤害的个位数，不受界面格式化影响。
export function damageTail(damage: number): number | null {
  if (!Number.isSafeInteger(damage) || damage < 0) return null;
  return damage % 10;
}

export const DAMAGE_TAIL_DESCRIPTION = "伤害尾数：取精确对英雄伤害的个位数，9 最大、0 最小；相同则依次比较十位、百位及更高位。";

export function payerCount(participantCount: number, mode: BattleMode | null, customCount?: number | null): number {
  if (!Number.isInteger(participantCount)) return 0;
  if (mode === "solo") return participantCount < 2 || participantCount > 5 ? 0 : participantCount < 4 ? 1 : 2;
  if (mode !== "custom" || participantCount < 5 || participantCount > 10) return 0;
  if (customCount !== null && customCount !== undefined) {
    return Number.isInteger(customCount) && customCount >= 1 && customCount < participantCount ? customCount : 0;
  }
  return Math.ceil(participantCount / 2);
}

// 从低位向高位逐位比较；高位不足时视为 0。
export function compareDamageTails(a: number, b: number): number {
  if (damageTail(a) === null || damageTail(b) === null) {
    throw new RangeError("伤害必须是精确的非负整数");
  }
  while (a > 0 || b > 0) {
    const difference = a % 10 - b % 10;
    if (difference !== 0) return difference;
    a = Math.floor(a / 10);
    b = Math.floor(b / 10);
  }
  return 0;
}

export interface PlayerRank<T> {
  player: T;
  rank: number;
}

export interface DamageTailResult<T> {
  status: "ready" | "tie" | "insufficient" | "invalid";
  lowestPlayers: T[];
  tiedPlayers?: T[];
  ranking?: PlayerRank<T>[];
}

// compare 小于 0 表示排名更靠前；并列只在跨越红包名额边界时需要手动决定。
function selectPayers<T>(players: T[], compare: (a: T, b: T) => number, count: number): DamageTailResult<T> {
  const sorted = [...players].sort(compare);
  const cutoff = sorted[sorted.length - count];
  const lowestPlayers = players.filter(player => compare(player, cutoff) >= 0);
  const tied = lowestPlayers.length > count;
  let rank = 1;
  const ranking = sorted.map((player, index) => {
    if (index > 0 && compare(player, sorted[index - 1]) !== 0) rank = index + 1;
    return { player, rank };
  });
  return {
    status: tied ? "tie" : "ready",
    lowestPlayers,
    tiedPlayers: tied ? players.filter(player => compare(player, cutoff) === 0) : [],
    ranking,
  };
}

// 传入当前模式的全部参与者；阵营不参与评分。
export function evaluateDamageTails<T extends { damage: number }>(players: T[], mode: BattleMode | null, customCount?: number | null): DamageTailResult<T> {
  const count = payerCount(players.length, mode, customCount);
  if (count === 0) return { status: "insufficient", lowestPlayers: [] };
  if (players.some((player) => damageTail(player.damage) === null)) {
    return { status: "invalid", lowestPlayers: [] };
  }
  return selectPayers(players, (a, b) => -compareDamageTails(a.damage, b.damage), count);
}

// 0～9 首尾相连，沿两个方向取更短距离（范围 0～5）。
export function circularDigitDistance(digit: number, lucky: number): number {
  const difference = Math.abs(digit - lucky);
  return Math.min(difference, 10 - difference);
}

export type ScoringMode = "damage-tail" | "lucky-number";
export const LUCKY_NUMBER_DESCRIPTION = "幸运数字：由用户在连接成功首页填写 0～9，进入游戏时确认锁定，每局结束后需重新填写；0～9 首尾相连（0 与 9 相邻），伤害个位与幸运数字的环形距离越小，排名越靠前。个位距离相同则继续比较十位、百位及更高位与幸运数字的距离；每位均按环形距离，越接近越靠前，高位不足按 0，所有位距离都相同则并列。";
export interface LuckyRank<T> {
  player: T;
  rank: number;
  tail: number;
  distance: number;
}
export function evaluateLuckyNumbers<T extends { damage: number }>(players: T[], lucky: number | null, mode: BattleMode | null, customCount?: number | null): {
  status: DamageTailResult<T>["status"] | "missing";
  lowestPlayers: T[];
  tiedPlayers?: T[];
  ranking: LuckyRank<T>[];
} {
  const count = payerCount(players.length, mode, customCount);
  if (count === 0) return { status: "insufficient", lowestPlayers: [], ranking: [] };
  if (lucky === null || !Number.isInteger(lucky) || lucky < 0 || lucky > 9) {
    return { status: "missing", lowestPlayers: [], ranking: [] };
  }
  if (players.some((p) => damageTail(p.damage) === null)) return { status: "invalid", lowestPlayers: [], ranking: [] };
  const compare = (a: T, b: T) => {
    let left = a.damage, right = b.damage;
    while (left > 0 || right > 0) {
      const difference = circularDigitDistance(left % 10, lucky) - circularDigitDistance(right % 10, lucky);
      if (difference !== 0) return difference;
      left = Math.floor(left / 10);
      right = Math.floor(right / 10);
    }
    return 0;
  };
  const result = selectPayers(players, compare, count);
  const ranking = result.ranking!.map(({ player, rank }) => ({
    player, rank, tail: player.damage % 10, distance: circularDigitDistance(player.damage % 10, lucky),
  }));
  return { ...result, ranking };
}
