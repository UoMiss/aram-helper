// 对局原始数据与分组；评分规则独立接入。

export interface Player {
  participantId?: number;
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
  isHistoryOwner?: boolean;
}

export interface GameResult {
  gameId: number;
  gameMode: string;
  isCustomGame?: boolean | null;
  gameDuration: number;
  timestamp: number;
  players: Player[];
  historyOwnerPuuid?: string | null;
}

export type BattleMode = "solo" | "custom";

export interface PlayerGroup {
  name: string;
  players: Player[];
}

export function detectBattleMode(game: Pick<GameResult, "isCustomGame">): BattleMode | null {
  if (game.isCustomGame === true) return "custom";
  if (game.isCustomGame === false) return "solo";
  return null;
}

// 只按本局的真实类型分组，类型或阵营缺失时不猜测参与者。
export function groupPlayers(game: GameResult): PlayerGroup[] {
  const mode = detectBattleMode(game);
  if (!mode || game.players.some((p) => p.teamId == null)) return [];
  if (mode === "solo") {
    const me = game.players.find((p) => game.historyOwnerPuuid ? p.isHistoryOwner : p.isMe);
    if (!me) return [];
    return game.players
      .filter((p) => (p === me || p.isMe || p.isFriend) &&
        p.teamId === me.teamId)
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


// 好友战绩展示双方全员；参与红包试算的范围仍由 groupPlayers 单独计算。
export function displayMatchTeams(game: GameResult): PlayerGroup[] {
  const ids = [...new Set(game.players.map(p => p.teamId ?? null))].sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
  return ids.map(id => ({
    name: id === 100 ? "蓝色方" : id === 200 ? "红色方" : id === null ? "未知阵营" : `队伍 ${id}`,
    players: game.players.filter(p => (p.teamId ?? null) === id),
  }));
}
