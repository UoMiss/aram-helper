import test from 'node:test';
import assert from 'node:assert/strict';
import { groupPlayers, detectBattleMode } from '../src/grouping.ts';

const player = (name, teamId, extra = {}) => ({ summonerName: name, teamId, isFriend: false, isMe: false, ...extra });
const game = { isCustomGame: false, players: [
  player('自己', 100, { isMe: true }),
  player('同队好友', 100, { isFriend: true }),
  player('同队路人', 100),
  player('对方好友', 200, { isFriend: true }),
  player('对方玩家', 200),
] };

test('匹配模式只包含自己和同队好友，排除同队路人和对方好友', () => {
  assert.deepEqual(groupPlayers(game).map(g => g.name), ['自己', '同队好友']);
});
test('五人好友匹配模式始终每人一组，不依赖额外分组信息', () => {
  const groups = groupPlayers({ isCustomGame: false, players: Array.from({ length: 5 }, (_, i) => player(`${i}`, 100, { isMe: i === 0, isFriend: true })) });
  assert.equal(groups.length, 5);
  assert.ok(groups.every(g => g.players.length === 1));
});
test('自定义按阵营分组，双方非好友也全部参与，支持人数不等', () => {
  const groups = groupPlayers({ ...game, isCustomGame: true });
  assert.deepEqual(groups.map(g => g.name), ['蓝色方', '红色方']);
  assert.deepEqual(groups.map(g => g.players.length), [3, 2]);
  assert.equal(groups.flatMap(g => g.players).length, 5);
});
test('缺少对局类型的旧缓存不猜测分组，重新读取类型后才参与比较', () => {
  const legacy = { players: game.players };
  assert.equal(detectBattleMode(legacy), null);
  assert.deepEqual(groupPlayers(legacy), []);
  assert.equal(groupPlayers({ ...legacy, isCustomGame: false }).length, 2);
  assert.equal(groupPlayers({ ...legacy, isCustomGame: true }).flatMap(g => g.players).length, 5);
});
test('未知类型、空值和错误字段不默认算作匹配', () => {
  for (const value of [undefined, null, 'false', 0]) {
    assert.equal(detectBattleMode({ isCustomGame: value }), null);
    assert.deepEqual(groupPlayers({ ...game, isCustomGame: value }), []);
  }
});
test('匹配和自定义均拒绝缺少阵营的数据', () => {
  for (const isCustomGame of [false, true]) {
    assert.deepEqual(groupPlayers({ isCustomGame, players: game.players.map(({ teamId, ...p }) => p) }), []);
  }
});
test('缺少对方或部分阵营缺失时，不展示不完整的自定义分组', () => {
  assert.deepEqual(groupPlayers({ isCustomGame: true, players: game.players.slice(0, 3) }), []);
  assert.deepEqual(groupPlayers({ isCustomGame: true, players: [...game.players, player('缺失阵营', undefined)] }), []);
});
test('匹配模式缺少本人身份时不误将双方好友列入比较', () => {
  assert.deepEqual(groupPlayers({ isCustomGame: false, players: game.players.slice(1) }), []);
});

test('好友匹配以查看对象的队伍为准，本人未参赛也可筛选我的同队好友', () => {
  const result = {isCustomGame:false,historyOwnerPuuid:'friend-a',players:[
    player('查看对象',200,{isHistoryOwner:true,isFriend:true}),
    player('我的同队好友',200,{isFriend:true}), player('同队路人',200),
    player('另一边好友',100,{isFriend:true}), player('另一边路人',100),
  ]};
  assert.deepEqual(groupPlayers(result).map(g=>g.name),['查看对象','我的同队好友']);
});

test('好友匹配里本人同队计入，本人在对面不计入', () => {
  const result={isCustomGame:false,historyOwnerPuuid:'friend-a',players:[
    player('查看对象',200,{isHistoryOwner:true}),player('自己',200,{isMe:true}),
    player('好友',200,{isFriend:true}),player('路人',200),player('对面',100),
  ]};
  assert.deepEqual(groupPlayers(result).map(g=>g.name),['查看对象','自己','好友']);
  result.players[1].teamId=100;
  assert.deepEqual(groupPlayers(result).map(g=>g.name),['查看对象','好友']);
});

test('好友详情缺少查看对象身份时不误用自己所在队伍', () => {
  assert.deepEqual(groupPlayers({...game,historyOwnerPuuid:'friend-a'}),[]);
});

test('好友自定义仍包含双方所有人，不受好友关系和本人是否参赛限制', () => {
  const result={isCustomGame:true,historyOwnerPuuid:'friend-a',players:Array.from({length:10},(_,i)=>
    player(String(i),i<5?100:200,{isHistoryOwner:i===5,isFriend:i===5}))};
  assert.equal(groupPlayers(result).flatMap(g=>g.players).length,10);
});
