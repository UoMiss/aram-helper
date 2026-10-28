// 伤害尾数只读取精确对英雄伤害的个位数，不受界面格式化影响。
export function damageTail(damage: number): number | null {
  if (!Number.isSafeInteger(damage) || damage < 0) return null;
  return damage % 10;
}

export const DAMAGE_TAIL_DESCRIPTION = "伤害尾数：取精确对英雄伤害的个位数，9 最大、0 最小；相同则依次比较十位、百位及更高位，较小者发红包。";

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

export interface DamageTailResult<T> {
  status: "ready" | "tie" | "insufficient" | "invalid";
  lowestPlayers: T[];
}

// 传入当前模式的全部参与者；阵营不参与评分。
export function evaluateDamageTails<T extends { damage: number }>(players: T[]): DamageTailResult<T> {
  if (players.length < 2) return { status: "insufficient", lowestPlayers: [] };
  if (players.some((player) => damageTail(player.damage) === null)) {
    return { status: "invalid", lowestPlayers: [] };
  }
  let lowestPlayers = [players[0]];
  for (const player of players.slice(1)) {
    const comparison = compareDamageTails(player.damage, lowestPlayers[0].damage);
    if (comparison < 0) lowestPlayers = [player];
    else if (comparison === 0) lowestPlayers.push(player);
  }
  return { status: lowestPlayers.length === 1 ? "ready" : "tie", lowestPlayers };
}

export type ScoringMode = "damage-tail" | "lucky-number";
export const LUCKY_NUMBER_DESCRIPTION = "幸运数字：启用后每局确认对局时公开抽取 0～9，本局固定；伤害个位与幸运数字的绝对差越小，排名越靠前。个位距离相同则继续比较十位、百位及更高位与幸运数字的距离；每位都是越接近越靠前，高位不足按 0，所有位距离都相同则并列。";
export interface LuckyRank<T> {
  player: T;
  rank: number;
  tail: number;
  distance: number;
}
export function evaluateLuckyNumbers<T extends { damage: number }>(players: T[], lucky: number | null): {
  status: DamageTailResult<T>["status"] | "missing";
  lowestPlayers: T[];
  ranking: LuckyRank<T>[];
} {
  if (players.length < 2) return { status: "insufficient", lowestPlayers: [], ranking: [] };
  if (lucky === null || !Number.isInteger(lucky) || lucky < 0 || lucky > 9) {
    return { status: "missing", lowestPlayers: [], ranking: [] };
  }
  if (players.some((p) => damageTail(p.damage) === null)) return { status: "invalid", lowestPlayers: [], ranking: [] };
  const compare = (a: T, b: T) => {
    let left = a.damage, right = b.damage;
    while (left > 0 || right > 0) {
      const difference = Math.abs(left % 10 - lucky) - Math.abs(right % 10 - lucky);
      if (difference !== 0) return difference;
      left = Math.floor(left / 10);
      right = Math.floor(right / 10);
    }
    return 0;
  };
  const sorted = [...players].sort(compare);
  let rank = 1;
  const ranking = sorted.map((player, index) => {
    if (index > 0 && compare(player, sorted[index - 1]) !== 0) rank = index + 1;
    return { player, rank, tail: player.damage % 10, distance: Math.abs(player.damage % 10 - lucky) };
  });
  const last = sorted[sorted.length - 1];
  const lowestPlayers = sorted.filter((player) => compare(player, last) === 0);
  return { status: lowestPlayers.length === 1 ? "ready" : "tie", lowestPlayers, ranking };
}
