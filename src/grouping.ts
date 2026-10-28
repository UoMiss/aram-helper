// 对局原始数据与分组；评分规则独立接入。

export interface Player {
  summonerName: string;
  championId: number;
  teamId?: number | null;
  damage: number;
  damageTaken: number;
  goldEarned: number;
  kills: number;
  deaths: number;
  assists: number;
  isFriend: boolean;
  isMe: boolean;
}

export interface GameResult {
  gameId: number;
  gameMode: string;
  gameDuration: number;
  timestamp: number;
  players: Player[];
}

export type BattleMode = "solo" | "custom";

export interface PlayerGroup {
  name: string;
  players: Player[];
}

// 分组独立于评分；旧缓存缺少阵营时只支持个人战。
export function groupPlayers(game: GameResult, mode: BattleMode): PlayerGroup[] {
  if (mode === "solo") {
    const me = game.players.find((p) => p.isMe);
    if (!me) return [];
    return game.players
      .filter((p) => (p.isMe || p.isFriend) &&
        (me.teamId == null || p.teamId === me.teamId))
      .map((p) => ({ name: p.summonerName, players: [p] }));
  }
  if (game.players.some((p) => !p.teamId)) return [];
  const ids = [...new Set(game.players.map((p) => p.teamId!))].sort((a, b) => a - b);
  if (ids.length !== 2) return [];
  return ids.map((id, index) => ({
    name: id === 100 ? "蓝色方" : id === 200 ? "红色方" : `队伍 ${index + 1}`,
    players: game.players.filter((p) => p.teamId === id),
  }));
}

