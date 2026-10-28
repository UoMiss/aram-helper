// 只影响展示；红包参与者仍由 isCustomGame 与好友关系决定。
export interface ModeInfo {
  gameMode: string;
  queueId?: number | null;
  isCustomGame?: boolean | null;
}

export function gameModeName(game: ModeInfo): string {
  if (game.queueId === 2400) return "海克斯大乱斗";
  if (game.queueId === 450) return "大乱斗";
  return ({ ARAM: "大乱斗", KIWI: "海克斯大乱斗", CLASSIC: "经典模式", URF: "无限火力", CHERRY: "斗魂竞技场" } as Record<string, string>)[game.gameMode]
    ?? (game.gameMode || "未知玩法");
}

export function gameTypeName(game: ModeInfo): string {
  if (game.isCustomGame === true) return "自定义";
  if (game.isCustomGame !== false) return "类型未知";
  if (game.queueId === 420) return "单/双排";
  if (game.queueId === 440) return "灵活排位";
  return "匹配";
}

export function gameLabel(game: ModeInfo): string {
  return `${gameTypeName(game)} / ${gameModeName(game)}`;
}
