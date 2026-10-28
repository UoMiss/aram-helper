// 对局原始数据与分组；评分规则独立接入。

export interface Player {
  puuid?: string;
  summonerName: string;
  championId: number;
  win?: boolean | null;
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
  queueId?: number | null;
  isCustomGame?: boolean | null;
  gameDuration: number;
  timestamp: number;
  players: Player[];
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
export function groupPlayers(game: GameResult, participantPuuids?: string[] | null): PlayerGroup[] {
  if (participantPuuids === null) return [];
  const selected = participantPuuids === undefined ? null : new Set(participantPuuids);
  const included = (p: Player) => !selected || (!!p.puuid && selected.has(p.puuid));
  const mode = detectBattleMode(game);
  if (!mode || game.players.some((p) => p.teamId == null)) return [];
  if (mode === "solo") {
    const me = game.players.find((p) => p.isMe);
    if (!me) return [];
    return game.players
      .filter((p) => included(p) && (selected !== null || p.isMe || p.isFriend) &&
        p.teamId === me.teamId)
      .map((p) => ({ name: p.summonerName, players: [p] }));
  }
  if (game.players.some((p) => !p.teamId)) return [];
  const ids = [...new Set(game.players.map((p) => p.teamId!))].sort((a, b) => a - b);
  if (ids.length !== 2) return [];
  return ids.map((id, index) => ({
    name: id === 100 ? "蓝色方" : id === 200 ? "红色方" : `队伍 ${index + 1}`,
    players: game.players.filter((p) => p.teamId === id && included(p)),
  }));
}
