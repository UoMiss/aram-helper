import test from 'node:test';
import assert from 'node:assert/strict';
import { damageTail } from '../src/scoring.ts';

test('完整伤害直接取个位，覆盖 0 到 9', () => {
  assert.deepEqual(Array.from({ length: 10 }, (_, i) => damageTail(12340 + i)), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});
test('只比较尾数，不受伤害总量大小影响', () => {
  assert.ok(damageTail(10009) > damageTail(99990));
  assert.equal(damageTail(19), damageTail(98769));
  assert.equal(damageTail(0), 0);
});
test('不将无效或不精确伤害取整后当作有效分数', () => {
  for (const damage of [NaN, Infinity, -1, 123.9, Number.MAX_SAFE_INTEGER + 1, undefined, null]) {
    assert.equal(damageTail(damage), null);
  }
});

const { compareDamageTails, evaluateDamageTails } = await import('../src/scoring.ts');
const { groupPlayers } = await import('../src/grouping.ts');

test('个位相同时比较十位，再比较百位，较小者为最低', () => {
  assert.ok(compareDamageTails(12340, 12350) < 0);
  assert.ok(compareDamageTails(12340, 12440) < 0);
  assert.ok(compareDamageTails(92340, 82340) > 0);
  assert.ok(compareDamageTails(10009, 99990) > 0);
});
test('位数不同视缺失高位为零，完整伤害相同才完全并列', () => {
  assert.ok(compareDamageTails(12, 112) < 0);
  assert.ok(compareDamageTails(0, 10000) < 0);
  assert.equal(compareDamageTails(12340, 12340), 0);
  assert.ok(compareDamageTails(Number.MAX_SAFE_INTEGER, 1) > 0);
  assert.throws(() => compareDamageTails(1.5, 2), RangeError);
});
test('最低尾数并列时继续比较，不按照列表顺序决定', () => {
  const a = { damage: 12350 }, b = { damage: 12340 }, c = { damage: 12349 };
  for (const players of [[a, b, c], [c, b, a]]) {
    const result = evaluateDamageTails(players);
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.lowestPlayers, [b]);
  }
});
test('完全相同的最低伤害只提示并列，不擅自挑选付款人', () => {
  const players = [{ damage: 340 }, { damage: 340 }, { damage: 349 }];
  assert.equal(evaluateDamageTails(players).status, 'tie');
  assert.deepEqual(evaluateDamageTails(players).lowestPlayers, players.slice(0, 2));
});
test('人数不足或任一参与者伤害无效时不判定', () => {
  assert.equal(evaluateDamageTails([{ damage: 0 }]).status, 'insufficient');
  assert.deepEqual(evaluateDamageTails([{ damage: NaN }, { damage: 0 }]), { status: 'invalid', lowestPlayers: [] });
});
test('自定义统一比较双方玩家，匹配排除路人及对方好友', () => {
  const game = { players: [
    { summonerName: '我', damage: 12346, teamId: 100, isMe: true },
    { summonerName: '同队好友', damage: 12345, teamId: 100, isFriend: true },
    { summonerName: '路人', damage: 12340, teamId: 100 },
    { summonerName: '对方好友', damage: 12341, teamId: 200, isFriend: true },
  ] };
  const evaluate = mode => evaluateDamageTails(groupPlayers(game, mode).flatMap(g => g.players));
  assert.equal(evaluate('solo').lowestPlayers[0].summonerName, '同队好友');
  assert.equal(evaluate('custom').lowestPlayers[0].summonerName, '路人');
});

const { evaluateLuckyNumbers } = await import('../src/scoring.ts');

test('幸运数字按逐位距离排名，各位距离相同的 6 和 8 并列', () => {
  const players = [7, 6, 8, 4, 1].map(tail => ({ damage: 12340 + tail }));
  const result = evaluateLuckyNumbers(players, 7);
  assert.deepEqual(result.ranking.map(e => e.tail), [7, 6, 8, 4, 1]);
  assert.deepEqual(result.ranking.map(e => e.distance), [0, 1, 1, 3, 6]);
  assert.deepEqual(result.ranking.map(e => e.rank), [1, 2, 2, 4, 5]);
  assert.equal(result.lowestPlayers[0], players[4]);
});
test('幸运数字不环绕：0 和 9 的距离是 9', () => {
  assert.deepEqual(evaluateLuckyNumbers([{ damage: 0 }, { damage: 9 }], 9).ranking.map(e => e.distance), [0, 9]);
});
test('个位等距时比较十位，尾数 6 可以排在 8 前', () => {
  const players = [{ damage: 12348 }, { damage: 12376 }];
  const result = evaluateLuckyNumbers(players, 7);
  assert.deepEqual(result.ranking.map(e => e.player.damage), [12376, 12348]);
  assert.equal(result.status, 'ready');
});
test('个位和十位等距时比较百位，并继续到更高位', () => {
  const result = evaluateLuckyNumbers([{ damage: 12588 }, { damage: 12766 }], 7);
  assert.deepEqual(result.ranking.map(e => e.player.damage), [12766, 12588]);
  const higher = evaluateLuckyNumbers([{ damage: 1788 }, { damage: 2766 }], 7);
  assert.deepEqual(higher.ranking.map(e => e.player.damage), [2766, 1788]);
});
test('完整伤害不同但每位距离均相同也并列，不按数值大小破同分', () => {
  const result = evaluateLuckyNumbers([{ damage: 366 }, { damage: 388 }], 7);
  assert.deepEqual(result.ranking.map(e => e.rank), [1, 1]);
  assert.equal(result.status, 'tie');
  assert.equal(result.lowestPlayers.length, 2);
});
test('位数不同时缺失高位按 0，与相同幸运数字比较', () => {
  const result = evaluateLuckyNumbers([{ damage: 6 }, { damage: 76 }], 7);
  assert.deepEqual(result.ranking.map(e => e.player.damage), [76, 6]);
});
test('没有开局数字、数字无效或伤害不精确时不能评定', () => {
  const players = [{ damage: 7 }, { damage: 8 }];
  for (const number of [null, -1, 10, 1.5, NaN]) assert.equal(evaluateLuckyNumbers(players, number).status, 'missing');
  assert.equal(evaluateLuckyNumbers([{ damage: 7 }, { damage: 1.2 }], 7).status, 'invalid');
  assert.equal(evaluateLuckyNumbers([], 7).status, 'insufficient');
});
