import test from 'node:test';
import assert from 'node:assert/strict';
import { damageTail, circularDigitDistance } from '../src/scoring.ts';

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
    const result = evaluateDamageTails(players, 'solo');
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.lowestPlayers, [b]);
  }
});
test('完全相同的最低伤害只提示并列，不擅自挑选付款人', () => {
  const players = [{ damage: 340 }, { damage: 340 }, { damage: 349 }];
  assert.equal(evaluateDamageTails(players, 'solo').status, 'tie');
  assert.deepEqual(evaluateDamageTails(players, 'solo').lowestPlayers, players.slice(0, 2));
});
test('人数不足或任一参与者伤害无效时不判定', () => {
  assert.equal(evaluateDamageTails([{ damage: 0 }], 'solo').status, 'insufficient');
  assert.deepEqual(evaluateDamageTails([{ damage: NaN }, { damage: 0 }], 'solo'), { status: 'invalid', lowestPlayers: [] });
});
test('自定义统一比较双方玩家，匹配排除路人及对方好友', () => {
  const game = { players: [
    { summonerName: '我', damage: 12346, teamId: 100, isMe: true },
    { summonerName: '同队好友', damage: 12345, teamId: 100, isFriend: true },
    { summonerName: '路人', damage: 12340, teamId: 100 },
    { summonerName: '对方好友', damage: 12341, teamId: 200, isFriend: true },
    { summonerName: '对方玩家甲', damage: 12348, teamId: 200 },
    { summonerName: '对方玩家乙', damage: 12349, teamId: 200 },
  ] };
  const evaluate = mode => evaluateDamageTails(groupPlayers({ ...game, isCustomGame: mode === "custom" }).flatMap(g => g.players), mode);
  assert.equal(evaluate('solo').lowestPlayers[0].summonerName, '同队好友');
  assert.deepEqual(new Set(evaluate('custom').lowestPlayers.map(p => p.summonerName)), new Set(['同队好友', '路人', '对方好友']));
});

const { evaluateLuckyNumbers } = await import('../src/scoring.ts');

test('幸运数字按逐位距离排名，各位距离相同的 6 和 8 并列', () => {
  const players = [7, 6, 8, 4, 1].map(tail => ({ damage: 12340 + tail }));
  const result = evaluateLuckyNumbers(players, 7, 'solo');
  assert.deepEqual(result.ranking.map(e => e.tail), [7, 6, 8, 4, 1]);
  assert.deepEqual(result.ranking.map(e => e.distance), [0, 1, 1, 3, 4]);
  assert.deepEqual(result.ranking.map(e => e.rank), [1, 2, 2, 4, 5]);
  assert.deepEqual(result.lowestPlayers, players.slice(3));
});
test('幸运数字环绕：0 和 9 的距离是 1', () => {
  assert.deepEqual(evaluateLuckyNumbers([{ damage: 0 }, { damage: 9 }], 9, 'solo').ranking.map(e => e.distance), [0, 1]);
});
test('个位等距时比较十位，尾数 6 可以排在 8 前', () => {
  const players = [{ damage: 12348 }, { damage: 12376 }];
  const result = evaluateLuckyNumbers(players, 7, 'solo');
  assert.deepEqual(result.ranking.map(e => e.player.damage), [12376, 12348]);
  assert.equal(result.status, 'ready');
});
test('个位和十位等距时比较百位，并继续到更高位', () => {
  const result = evaluateLuckyNumbers([{ damage: 12588 }, { damage: 12766 }], 7, 'solo');
  assert.deepEqual(result.ranking.map(e => e.player.damage), [12766, 12588]);
  const higher = evaluateLuckyNumbers([{ damage: 1788 }, { damage: 2766 }], 7, 'solo');
  assert.deepEqual(higher.ranking.map(e => e.player.damage), [1788, 2766]);
});
test('完整伤害不同但每位距离均相同也并列，不按数值大小破同分', () => {
  const result = evaluateLuckyNumbers([{ damage: 366 }, { damage: 388 }], 7, 'solo');
  assert.deepEqual(result.ranking.map(e => e.rank), [1, 1]);
  assert.equal(result.status, 'tie');
  assert.equal(result.lowestPlayers.length, 2);
});
test('位数不同时缺失高位按 0，与相同幸运数字比较', () => {
  const result = evaluateLuckyNumbers([{ damage: 6 }, { damage: 76 }], 7, 'solo');
  assert.deepEqual(result.ranking.map(e => e.player.damage), [76, 6]);
});
test('没有开局数字、数字无效或伤害不精确时不能评定', () => {
  const players = [{ damage: 7 }, { damage: 8 }];
  for (const number of [null, -1, 10, 1.5, NaN]) assert.equal(evaluateLuckyNumbers(players, number, 'solo').status, 'missing');
  assert.equal(evaluateLuckyNumbers([{ damage: 7 }, { damage: 1.2 }], 7, 'solo').status, 'invalid');
  assert.equal(evaluateLuckyNumbers([], 7, 'solo').status, 'insufficient');
});

const { payerCount } = await import('../src/scoring.ts');

test('匹配仅2～5人结算，2～3人末1名、4～5人末2名', () => {
  for (const n of [0, 1, 6, 7, 8, 9, 10, 11]) assert.equal(payerCount(n, 'solo'), 0);
  for (const n of [2, 3]) assert.equal(payerCount(n, 'solo'), 1);
  for (const n of [4, 5]) assert.equal(payerCount(n, 'solo'), 2);
});

test('自定义5～6人末3名、7～8人末4名、9～10人末5名，其余人数不结算', () => {
  for (const n of [0, 1, 2, 3, 4, 11]) assert.equal(payerCount(n, 'custom'), 0);
  for (const [n, count] of [[5, 3], [6, 3], [7, 4], [8, 4], [9, 5], [10, 5]]) assert.equal(payerCount(n, 'custom'), count);
});

test('手动名额仅对有效自定义人数生效，必须是小于参赛人数的正整数', () => {
  for (const n of [5, 6, 7, 8, 9, 10]) {
    assert.equal(payerCount(n, 'custom', null), Math.ceil(n / 2));
    assert.equal(payerCount(n, 'custom', undefined), Math.ceil(n / 2));
    for (const count of [1, n - 1]) assert.equal(payerCount(n, 'custom', count), count);
    for (const count of [-1, 0, n, n + 1, 1.5, NaN, Infinity, '3', false]) assert.equal(payerCount(n, 'custom', count), 0);
  }
  assert.equal(payerCount(4, 'custom', 1), 0);
  assert.equal(payerCount(11, 'custom', 1), 0);
  for (const count of [1, 4, 0, -1, 1.5, NaN, '3']) assert.equal(payerCount(5, 'solo', count), 2);
});

test('人数或模式无效时不套用匹配默认名额', () => {
  for (const mode of [null, undefined, 'unknown', true]) {
    assert.equal(payerCount(4, mode), 0);
    assert.equal(evaluateDamageTails([{damage: 0}, {damage: 9}], mode).status, 'insufficient');
    assert.equal(evaluateLuckyNumbers([{damage: 0}, {damage: 9}], 7, mode).status, 'insufficient');
  }
  for (const n of [-1, 2.5, NaN, Infinity]) {
    assert.equal(payerCount(n, 'solo'), 0);
    assert.equal(payerCount(n, 'custom'), 0);
  }
});

for (const [name, evaluate] of [
  ['伤害尾数', (players, mode, customCount) => evaluateDamageTails(players, mode, customCount)],
  ['幸运数字', (players, mode, customCount) => evaluateLuckyNumbers(players, 9, mode, customCount)],
]) {
  // 两套规则均按从差到好构造样例；幸运9使用两位伤害避免环形对称造成意外并列。
  const fixture = value => name === '幸运数字' ? [44,34,24,14,4,43,33,23,13,3,2][value] : value;
  test(`${name}：匹配2～5人、自定义5～10人均选出正确红包名额，包含本人`, () => {
    for (const [mode, n, count] of [['solo', 2, 1], ['solo', 3, 1], ['solo', 4, 2], ['solo', 5, 2], ['custom', 5, 3], ['custom', 6, 3], ['custom', 7, 4], ['custom', 8, 4], ['custom', 9, 5], ['custom', 10, 5]]) {
      const players = Array.from({length: n}, (_, i) => ({damage: fixture(i), isMe: i === 0}));
      for (const input of [players, [...players].reverse()]) {
        const result = evaluate(input, mode);
        assert.equal(result.status, 'ready');
        assert.deepEqual(new Set(result.lowestPlayers), new Set(players.slice(0, count)));
        assert.deepEqual(result.ranking.map(entry => entry.player.damage), players.map(p => p.damage).reverse());
        assert.deepEqual(result.ranking.map(entry => entry.rank), Array.from({length:n}, (_, i) => i + 1));
      }
    }
  });
  test(`${name}：匹配末两名恰好并列时两人均发红包，不误判成无法确定`, () => {
    const players = [0, 0, 8, 9].map(damage => ({damage:fixture(damage)}));
    const result = evaluate(players, 'solo');
    assert.equal(result.status, 'ready'); assert.deepEqual(result.lowestPlayers, players.slice(0, 2));
  });
  test(`${name}：匹配倒数第二名并列时保留已确定末位，只对剩余名额提示并列`, () => {
    const players = [0, 1, 1, 9].map(damage => ({damage:fixture(damage)}));
    const result = evaluate(players, 'solo');
    assert.equal(result.status, 'tie'); assert.deepEqual(result.lowestPlayers, players.slice(0, 3));
    assert.deepEqual(result.tiedPlayers, players.slice(1, 3));
  });
  test(`${name}：匹配三人并列末位不能任选其中两人，前列并列不影响红包`, () => {
    const players = [0, 0, 0, 9, 9].map(damage => ({damage:fixture(damage)}));
    const result = evaluate(players, 'solo');
    assert.equal(result.status, 'tie'); assert.deepEqual(result.tiedPlayers, players.slice(0, 3));
    assert.equal(evaluate([0, 1, 9, 9].map(damage => ({damage:fixture(damage)})), 'solo').status, 'ready');
  });
  test(`${name}：自定义3/4/5名额边界并列，保留已确定付款人`, () => {
    for (const damages of [[0, 1, 2, 2, 8, 9], [0, 1, 2, 3, 3, 7, 8, 9], [0, 1, 2, 3, 4, 4, 6, 7, 8, 9]]) {
      const players = damages.map(damage => ({damage:fixture(damage)}));
      const count = players.length / 2;
      const result = evaluate(players, 'custom');
      assert.equal(result.status, 'tie');
      assert.deepEqual(result.lowestPlayers, players.slice(0, count + 1));
      assert.deepEqual(result.tiedPlayers, players.slice(count - 1, count + 1));
      assert.deepEqual(result.lowestPlayers.filter(p => !result.tiedPlayers.includes(p)), players.slice(0, count - 1));
    }
  });
  test(`${name}：自定义恰好并列占满3/4/5个名额时全部确定，无需额外选人`, () => {
    for (const [n, count] of [[5, 3], [6, 3], [7, 4], [8, 4], [9, 5], [10, 5]]) {
      const players = Array.from({length:n}, (_, i) => ({damage:fixture(i < count ? 0 : i)}));
      const result = evaluate(players, 'custom');
      assert.equal(result.status, 'ready');
      assert.deepEqual(result.lowestPlayers, players.slice(0, count));
      assert.deepEqual(result.tiedPlayers, []);
    }
  });
  test(`${name}：自定义双方合并排名，末位可全部来自同一阵营`, () => {
    for (const n of [5, 6, 7, 8, 9, 10]) {
      const players = Array.from({length:n}, (_, i) => ({summonerName:String(i),damage:fixture(i),teamId:i < n / 2 ? 100 : 200,isMe:i === 0,isFriend:false}));
      const included = groupPlayers({isCustomGame:true,players}).flatMap(g => g.players);
      const result = evaluate(included, 'custom');
      const count = Math.ceil(n / 2);
      assert.equal(result.lowestPlayers.length, count);
      assert.ok(result.lowestPlayers.every(p => p.teamId === 100));
      assert.deepEqual(result.ranking.map(entry => entry.player), [...players].reverse());
    }
  });
  test(`${name}：手动指定自定义红包人数覆盖默认值但仍对所有人排序`, () => {
    const players = Array.from({length:8}, (_, i) => ({damage:fixture(i)}));
    for (const count of [1, 2, 4, 7]) {
      for (const input of [players, [...players].reverse()]) {
        const result = evaluate(input, 'custom', count);
        assert.equal(result.status, 'ready');
        assert.deepEqual(new Set(result.lowestPlayers), new Set(players.slice(0, count)));
        assert.deepEqual(result.ranking.map(entry => entry.player), [...players].reverse());
      }
    }
  });
  test(`${name}：手动名额跨越并列边界时不擅自挑人`, () => {
    const players = [0, 1, 2, 2, 8, 9].map(damage => ({damage:fixture(damage)}));
    const result = evaluate(players, 'custom', 3);
    assert.equal(result.status, 'tie');
    assert.deepEqual(result.lowestPlayers, players.slice(0, 4));
    assert.deepEqual(result.tiedPlayers, players.slice(2, 4));
    assert.deepEqual(result.lowestPlayers.filter(p => !result.tiedPlayers.includes(p)), players.slice(0, 2));
    assert.equal(evaluate(players, 'custom', 4).status, 'ready');
  });
  test(`${name}：未指定名额使用自动值，非法指定或人数不足不结算`, () => {
    const players = Array.from({length:8}, (_, i) => ({damage:fixture(i)}));
    for (const count of [undefined, null]) {
      assert.equal(evaluate(players, 'custom', count).lowestPlayers.length, 4);
    }
    for (const count of [-1, 0, 8, 9, 1.5, NaN, Infinity, '3', false]) {
      const result = evaluate(players, 'custom', count);
      assert.equal(result.status, 'insufficient');
      assert.deepEqual(result.lowestPlayers, []);
      assert.equal(result.ranking?.length ?? 0, 0);
    }
    for (const n of [0, 1, 2, 3, 4, 11]) {
      const result = evaluate(Array.from({length:n}, (_, i) => ({damage:fixture(i)})), 'custom', 1);
      assert.equal(result.status, 'insufficient');
      assert.deepEqual(result.lowestPlayers, []);
    }
  });
  test(`${name}：匹配始终忽略自定义手动名额`, () => {
    const players = [0, 1, 2, 3, 4].map(damage => ({damage:fixture(damage)}));
    for (const count of [undefined, null, 1, 3, 5, 0, -1, 1.5, NaN, '3']) {
      const result = evaluate(players, 'solo', count);
      assert.equal(result.status, 'ready');
      assert.deepEqual(result.lowestPlayers, players.slice(0, 2));
    }
  });
  test(`${name}：不符合人数条件时不产生排名或付款人`, () => {
    for (const [mode, n] of [['solo', 0], ['solo', 1], ['solo', 6], ['custom', 2], ['custom', 4], ['custom', 11]]) {
      const result = evaluate(Array.from({length:n}, (_, i) => ({damage:fixture(i)})), mode);
      assert.equal(result.status, 'insufficient');
      assert.deepEqual(result.lowestPlayers, []);
      assert.equal(result.ranking?.length ?? 0, 0);
    }
  });
}

test('尾数相同继续按高位排总名次，完全同分使用并列名次', () => {
  const players = [12340, 12350, 12350, 12349].map(damage => ({damage}));
  const result = evaluateDamageTails(players, 'solo');
  assert.deepEqual(result.ranking.map(entry => entry.player.damage), [12349, 12350, 12350, 12340]);
  assert.deepEqual(result.ranking.map(entry => entry.rank), [1, 2, 2, 4]);
});

test('匹配按自己加同队好友的人数计算，自定义按双方所有玩家计算', () => {
  const players = Array.from({length: 10}, (_, i) => ({
    summonerName: String(i), damage: i, teamId: i < 5 ? 100 : 200,
    isMe: i === 0, isFriend: [1, 2, 8].includes(i),
  }));
  for (const isCustomGame of [false, true]) {
    const mode = isCustomGame ? 'custom' : 'solo';
    const included = groupPlayers({isCustomGame, players}).flatMap(g => g.players);
    assert.equal(included.length, isCustomGame ? 10 : 3);
    assert.equal(evaluateDamageTails(included, mode).lowestPlayers.length, isCustomGame ? 5 : 1);
    assert.equal(evaluateLuckyNumbers(included, 9, mode).lowestPlayers.length, isCustomGame ? 5 : 1);
  }
});

test('环形距离覆盖全部100种数字组合，范围0～5且对称', () => {
  for(let a=0;a<10;a++) for(let b=0;b<10;b++) {
    const steps=Array.from({length:6},(_,d)=>d).find(d=>(a+d)%10===b||(a-d+10)%10===b);
    assert.equal(circularDigitDistance(a,b),steps);
    assert.equal(circularDigitDistance(a,b),circularDigitDistance(b,a));
  }
});
test('跨零同距继续按十位和百位的环形距离破同分', () => {
  assert.deepEqual(evaluateLuckyNumbers([{damage:81},{damage:99}],0,'solo').ranking.map(e=>e.player.damage),[99,81]);
  assert.deepEqual(evaluateLuckyNumbers([{damage:811},{damage:999}],0,'solo').ranking.map(e=>e.player.damage),[999,811]);
  const tie=evaluateLuckyNumbers([{damage:111},{damage:999}],0,'solo');
  assert.equal(tie.status,'tie');
  assert.deepEqual(tie.ranking.map(e=>e.rank),[1,1]);
});
test('幸运数字9时尾数0优于尾数5，红包名单按环形距离确定', () => {
  const result=evaluateLuckyNumbers([{damage:0},{damage:5},{damage:9}],9,'solo');
  assert.deepEqual(result.ranking.map(e=>e.tail),[9,0,5]);
  assert.equal(result.lowestPlayers[0].damage,5);
});
