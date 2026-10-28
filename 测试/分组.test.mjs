import test from 'node:test';
import assert from 'node:assert/strict';
import { groupPlayers } from '../src/grouping.ts';

const player = (name, teamId, extra = {}) => ({ summonerName: name, teamId, isFriend: false, isMe: false, ...extra });
const game = { players: [
  player('自己', 100, { isMe: true }),
  player('同队好友', 100, { isFriend: true }),
  player('同队路人', 100),
  player('对方好友', 200, { isFriend: true }),
  player('对方玩家', 200),
] };

test('匹配模式只包含自己和同队好友，排除同队路人和对方好友', () => {
  assert.deepEqual(groupPlayers(game, 'solo').map(g => g.name), ['自己', '同队好友']);
});
test('五人好友匹配模式始终每人一组，不依赖额外分组信息', () => {
  const groups = groupPlayers({ players: Array.from({ length: 5 }, (_, i) => player(`${i}`, 100, { isMe: i === 0, isFriend: true })) }, 'solo');
  assert.equal(groups.length, 5);
  assert.ok(groups.every(g => g.players.length === 1));
});
test('自定义按阵营分组，双方非好友也全部参与，支持人数不等', () => {
  const groups = groupPlayers(game, 'custom');
  assert.deepEqual(groups.map(g => g.name), ['蓝色方', '红色方']);
  assert.deepEqual(groups.map(g => g.players.length), [3, 2]);
  assert.equal(groups.flatMap(g => g.players).length, 5);
});
test('旧版己方历史仍能分匹配模式，缺少阵营时不推测自定义分队', () => {
  const legacy = { players: game.players.slice(0, 3).map(({ teamId, ...p }) => p) };
  assert.equal(groupPlayers(legacy, 'solo').length, 2);
  assert.deepEqual(groupPlayers(legacy, 'custom'), []);
  const nullable = { players: legacy.players.map(p => ({ ...p, teamId: null })) };
  assert.equal(groupPlayers(nullable, 'solo').length, 2);
  assert.deepEqual(groupPlayers(nullable, 'custom'), []);
});
test('缺少对方或部分阵营缺失时，不展示不完整的自定义分组', () => {
  assert.deepEqual(groupPlayers({ players: game.players.slice(0, 3) }, 'custom'), []);
  assert.deepEqual(groupPlayers({ players: [...game.players, player('缺失阵营', undefined)] }, 'custom'), []);
});
test('匹配模式缺少本人身份时不误将双方好友列入比较', () => {
  assert.deepEqual(groupPlayers({ players: game.players.slice(1) }, 'solo'), []);
});
