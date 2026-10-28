import test from 'node:test';
import assert from 'node:assert/strict';
import { createLuckyNumbers } from '../src/lucky.ts';
import { createAssistant } from '../src/assistant.ts';

function memoryStorage() {
  const entries = new Map();
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
}
function setup(phase = 'Lobby', gameId = 101, storage = memoryStorage(), rule = 'lucky-number') {
  const store = createLuckyNumbers(storage);
  const handlers = {
    check_connection: () => '测试', get_gameflow_phase: () => phase,
    get_active_game: () => ({ gameId, phase }),
    get_last_game_result: () => ({ gameId, players: [] }),
  };
  const app = createAssistant(async command => handlers[command]?.(), async () => {},
    { setTimeout: () => 0, clearTimeout: () => {} }, async () => true, store, rule);
  return { app, store, handlers, storage,
    phase: next => { phase = next; }, id: next => { gameId = next; }, tick: () => app.retryConnection() };
}

test('未设置数字时不自动填入，进入游戏也不会创建记录', async () => {
  const ctx = setup(); await ctx.app.start();
  assert.equal(ctx.app.state.page, 'status'); assert.equal(ctx.app.state.configuredLuckyNumber, null);
  ctx.phase('ReadyCheck'); await ctx.tick(); assert.deepEqual(ctx.store.snapshot(), {});
  ctx.phase('GameStart'); await ctx.tick(); assert.match(ctx.app.state.luckyError, /未填写/);
  assert.deepEqual(ctx.store.snapshot(), {}); ctx.app.stop();
});

test('0～9边界、无效数字校验和清空不当作零', () => {
  const ctx = setup();
  for (let n = 0; n <= 9; n++) {
    assert.equal(ctx.app.setLuckyNumberInput(String(n)), true);
    assert.equal(ctx.app.state.configuredLuckyNumber, n);
  }
  for (const input of ['-1', '10', '1.5', '07', '1e0', '+7', ' 7', 'a', '７']) {
    assert.equal(ctx.app.setLuckyNumberInput(input), false);
    assert.equal(ctx.app.state.configuredLuckyNumber, 9);
  }
  for (const n of [-1, 10, 1.5, NaN, Infinity, '', '7']) assert.throws(() => ctx.store.setConfiguredNumber(n));
  assert.equal(ctx.app.setLuckyNumberInput(''), true);
  assert.equal(ctx.app.state.configuredLuckyNumber, null);
  assert.equal(createLuckyNumbers(ctx.storage).configured(), null); ctx.app.stop();
});

test('确认对局和选英雄仍可修改，只有进入游戏时确认最后填写的数字', async () => {
  const ctx = setup(); ctx.app.setLuckyNumber(7); await ctx.app.start();
  for (const phase of ['Matchmaking', 'ReadyCheck', 'ChampSelect']) {
    ctx.phase(phase); await ctx.tick(); ctx.app.selectScoringRule('lucky-number');
    assert.deepEqual(ctx.store.snapshot(), {}); assert.equal(ctx.app.state.configuredLuckyNumber, 7);
  }
  assert.equal(ctx.app.setLuckyNumber(0), true);
  ctx.phase('GameStart'); await ctx.tick();
  assert.equal(ctx.store.get(101).number, 0); assert.equal(ctx.app.state.configuredLuckyNumber, null);
  assert.equal(ctx.app.setLuckyNumber(9), false);
  const first = ctx.store.get(101);
  await ctx.tick(); ctx.phase('InProgress'); await ctx.tick(); assert.deepEqual(ctx.store.get(101), first);
  ctx.app.stop();
});

test('取消确认不消耗数字，重新匹配仍可修改', async () => {
  const ctx = setup(); ctx.app.setLuckyNumber(7); ctx.phase('ReadyCheck'); await ctx.app.start();
  ctx.phase('Matchmaking'); await ctx.tick();
  assert.equal(ctx.app.state.configuredLuckyNumber, 7); assert.equal(ctx.app.setLuckyNumber(3), true);
  ctx.phase('ChampSelect'); await ctx.tick(); ctx.phase('InProgress'); await ctx.tick();
  assert.equal(ctx.store.get(101).number, 3); ctx.app.stop();
});

test('确认后切换规则不改变本局数字，结束后下一局必须重填', async () => {
  const ctx = setup(); ctx.app.setLuckyNumber(7); ctx.phase('GameStart'); await ctx.app.start();
  ctx.app.selectScoringRule('damage-tail'); ctx.app.selectScoringRule('lucky-number');
  assert.equal(ctx.store.get(101).number, 7);
  ctx.phase('EndOfGame'); await ctx.tick(); assert.equal(ctx.app.state.configuredLuckyNumber, null);
  ctx.phase('Lobby'); await ctx.tick(); ctx.id(102); ctx.phase('GameStart'); await ctx.tick();
  assert.equal(ctx.store.get(102), null); assert.match(ctx.app.state.luckyError, /未填写/); ctx.app.stop();
});

test('结算后重填不被重复结束轮询清除，两局各自保存', async () => {
  const ctx = setup(); ctx.app.setLuckyNumber(7); ctx.phase('GameStart'); await ctx.app.start();
  ctx.phase('WaitingForStats'); await ctx.tick(); assert.equal(ctx.app.setLuckyNumber(3), true);
  ctx.phase('EndOfGame'); await ctx.tick(); await ctx.tick(); assert.equal(ctx.app.state.configuredLuckyNumber, 3);
  ctx.id(102); ctx.phase('ReadyCheck'); await ctx.tick(); ctx.phase('GameStart'); await ctx.tick();
  assert.equal(ctx.store.get(101).number, 7); assert.equal(ctx.store.get(102).number, 3); ctx.app.stop();
});

test('重启赛前恢复可编辑配置，游戏中恢复已确认值，错过结束阶段也不沿用到下一局', async () => {
  const ctx = setup(); ctx.app.setLuckyNumber(7); ctx.phase('ReadyCheck'); await ctx.app.start(); ctx.app.stop();
  const next = setup('ChampSelect', 101, ctx.storage); await next.app.start();
  assert.equal(next.app.state.configuredLuckyNumber, 7); assert.equal(next.app.setLuckyNumber(3), true);
  next.phase('GameStart'); await next.tick(); next.app.stop();
  const active = setup('InProgress', 101, ctx.storage); await active.app.start();
  assert.equal(active.app.state.luckyDraws['101'].number, 3); active.app.stop();
  const newGame = setup('GameStart', 102, ctx.storage); await newGame.app.start();
  assert.equal(newGame.store.get(102), null); assert.equal(newGame.app.state.configuredLuckyNumber, null); newGame.app.stop();
});

test('游戏中途启动和查看历史不使用预设补确认', async () => {
  const ctx = setup('InProgress'); ctx.app.setLuckyNumber(7); await ctx.app.start();
  assert.equal(ctx.store.get(101), null); assert.match(ctx.app.state.luckyError, /不能补设/);
  ctx.app.selectScoringRule('lucky-number'); assert.equal(ctx.store.get(101), null);
  ctx.phase('EndOfGame'); await ctx.tick();
  assert.equal(ctx.app.state.configuredLuckyNumber, null);
  ctx.app.setLuckyNumber(3); await ctx.app.viewLastGame(); ctx.app.selectScoringRule('lucky-number');
  assert.equal(ctx.store.get(101), null); assert.equal(ctx.app.state.configuredLuckyNumber, 3); ctx.app.stop();
});

test('保存对局与消耗配置为同一次写入，失败时不发布记录', () => {
  const storage = memoryStorage(); const store = createLuckyNumbers(storage);
  store.setConfiguredNumber(7); const first = store.confirm(101);
  assert.equal(store.configured(), null); assert.equal(first.number, 7);
  store.setConfiguredNumber(3); assert.deepEqual(store.confirm(101), first);
  assert.equal(store.configured(), 3); assert.equal(store.confirm(102).number, 3);
  assert.throws(() => store.confirm(0)); assert.throws(() => store.confirm(103), /未填写/);
  const broken = createLuckyNumbers({getItem: () => JSON.stringify({version: 4, configured: 7}), setItem: () => { throw Error('保存失败'); }});
  assert.throws(() => broken.confirm(101), /保存失败/); assert.equal(broken.get(101), null); assert.equal(broken.configured(), 7);
});

test('设置保存失败显示错误，保留原设置', () => {
  const ctx = setup('Lobby', 101, {getItem: () => null, setItem: () => { throw Error('磁盘错误'); }});
  ctx.app.setLuckyNumber(7); assert.match(ctx.app.state.luckySettingError, /设置未保存/);
  assert.equal(ctx.app.state.configuredLuckyNumber, null); ctx.app.stop();
});

test('旧版手动待用数字变为可编辑设置，旧随机值和长期预设不沿用', () => {
  const storage = memoryStorage(); const record = {gameId: 101, number: 8, announcedAt: 1};
  storage.setItem('luckyState', JSON.stringify({version: 3, draws: {'101': record}, configured: null, pending: {number: 5, announcedAt: 2}}));
  const store = createLuckyNumbers(storage); assert.equal(store.get(101).number, 8);
  assert.equal(store.configured(), 5); store.setConfiguredNumber(7); assert.equal(store.confirm(102).number, 7);
  const old = memoryStorage(); old.setItem('configuredLuckyNumber', '7');
  old.setItem('luckyState', JSON.stringify({draws: {'101': record}, pending: {number: 5, announcedAt: 2}}));
  assert.equal(createLuckyNumbers(old).configured(), null);
  const legacy = memoryStorage(); legacy.setItem('luckyDraws', JSON.stringify({'101': record}));
  assert.equal(createLuckyNumbers(legacy).get(101).number, 8);
});

test('开局编号短暂失败，恢复后在进入游戏的窗口内确认', async () => {
  const ctx = setup(); ctx.app.setLuckyNumber(7); await ctx.app.start();
  ctx.phase('GameStart'); ctx.handlers.get_active_game = () => { throw Error('暂不可用'); }; await ctx.tick();
  assert.equal(ctx.store.get(101), null); assert.equal(ctx.app.setLuckyNumber(3), false);
  ctx.phase('InProgress'); ctx.handlers.get_active_game = () => ({gameId: 101, phase: 'InProgress'}); await ctx.tick();
  assert.equal(ctx.store.get(101).number, 7); ctx.app.stop();
});

test('开局接口长期失败不在游戏中途补确认，结束后清空未使用值', async () => {
  const ctx = setup(); ctx.app.setLuckyNumber(7); await ctx.app.start();
  ctx.phase('GameStart'); ctx.handlers.get_active_game = () => { throw Error('暂不可用'); }; await ctx.tick();
  const now = Date.now; Date.now = () => now() + 30 * 60 * 1000;
  try {
    ctx.phase('InProgress'); ctx.handlers.get_active_game = () => ({gameId: 101, phase: 'InProgress'}); await ctx.tick();
    assert.equal(ctx.store.get(101), null);
    ctx.phase('EndOfGame'); await ctx.tick(); assert.equal(ctx.app.state.configuredLuckyNumber, null);
  } finally { Date.now = now; ctx.app.stop(); }
});

test('未捕获结算阶段而直接返回房间，也清空本局未使用配置', async () => {
  const ctx = setup(); ctx.app.setLuckyNumber(7); await ctx.app.start();
  ctx.phase('GameStart'); ctx.handlers.get_active_game = () => null; await ctx.tick();
  ctx.phase('Lobby'); await ctx.tick(); assert.equal(ctx.app.state.configuredLuckyNumber, null);
  ctx.app.setLuckyNumber(3); await ctx.tick(); assert.equal(ctx.app.state.configuredLuckyNumber, 3); ctx.app.stop();
});

test('旧默认伤害尾数自动迁移到幸运数字并锁定本局数字', async () => {
  const ctx = setup('ReadyCheck', 101, memoryStorage(), 'damage-tail'); ctx.app.setLuckyNumber(7); await ctx.app.start();
  ctx.phase('GameStart'); await ctx.tick(); assert.equal(ctx.store.get(101).number, 7);
  assert.equal(ctx.store.rulesSnapshot()['101'].mode, 'lucky-number');
  ctx.phase('EndOfGame'); await ctx.tick(); assert.equal(ctx.app.state.configuredLuckyNumber, null); ctx.app.stop();
});

test('会话快照已到结算时不根据过期的阶段创建记录', async () => {
  const ctx = setup('GameStart'); ctx.app.setLuckyNumber(7);
  ctx.handlers.get_active_game = () => ({gameId: 101, phase: 'EndOfGame'}); await ctx.app.start();
  assert.equal(ctx.store.get(101), null); ctx.app.stop();
});

test('旧设置启动后使用幸运规则，游戏中不能修改已确认数字', async () => {
  const ctx = setup('GameStart', 101, memoryStorage(), 'damage-tail'); ctx.app.setLuckyNumber(7);
  await ctx.app.start(); ctx.app.selectScoringRule('lucky-number'); await ctx.tick();
  assert.equal(ctx.app.state.scoringMode, 'lucky-number');
  assert.match(ctx.app.state.ruleSettingError, /已锁定/);
  assert.equal(ctx.store.rulesSnapshot()['101'].mode, 'lucky-number');
  assert.equal(ctx.store.get(101).number, 7); ctx.app.stop();
});

test('首次会话请求未完成前已锁定，不能利用异步间隙改规则或数字', async () => {
  const ctx = setup('GameStart'); ctx.app.setLuckyNumber(7);
  let resolve; ctx.handlers.get_active_game = () => new Promise(done => { resolve = done; });
  const request = ctx.app.start(); await new Promise(setImmediate);
  assert.equal(ctx.app.state.rulesLocked, true);
  ctx.app.selectScoringRule('damage-tail'); assert.equal(ctx.app.setLuckyNumber(3), false);
  resolve({gameId: 101, phase: 'GameStart'}); await request;
  assert.equal(ctx.store.rulesSnapshot()['101'].mode, 'lucky-number');
  assert.equal(ctx.store.get(101).number, 7); ctx.app.stop();
});

test('开局未填数字也保存本局规则，重试不会补设', async () => {
  const ctx = setup('GameStart'); await ctx.app.start();
  assert.equal(ctx.store.rulesSnapshot()['101'].mode, 'lucky-number');
  assert.equal(ctx.store.rulesSnapshot()['101'].number, null);
  assert.equal(ctx.app.setLuckyNumber(7), false); await ctx.tick();
  assert.equal(ctx.store.get(101), null); assert.match(ctx.app.state.luckyError, /未填写/); ctx.app.stop();
});

test('确认成功后锁定规则，结束解锁，历史快照不随下一局设置改变', async () => {
  const ctx = setup('GameStart'); ctx.app.setLuckyNumber(7); await ctx.app.start();
  const first = {...ctx.store.rulesSnapshot()['101']};
  ctx.app.selectScoringRule('damage-tail'); assert.equal(ctx.app.state.scoringMode, 'lucky-number');
  ctx.phase('EndOfGame'); await ctx.tick(); assert.equal(ctx.app.state.rulesLocked, false);
  ctx.app.selectScoringRule('damage-tail'); assert.equal(ctx.app.state.scoringMode, 'lucky-number');
  assert.deepEqual(ctx.app.state.gameRules['101'], first);
  ctx.phase('Lobby'); await ctx.tick(); ctx.id(102); ctx.phase('GameStart'); await ctx.tick();
  assert.equal(ctx.app.state.gameRules['102'].mode, 'lucky-number');
  assert.equal(ctx.app.state.gameRules['102'].number, null);
  assert.deepEqual(ctx.app.state.gameRules['101'], first); ctx.app.stop();
});

test('重启恢复本局规则和数字，不依赖当前全局默认规则', async () => {
  const ctx = setup('GameStart'); ctx.app.setLuckyNumber(7); await ctx.app.start(); ctx.app.stop();
  const next = setup('InProgress', 101, ctx.storage, 'damage-tail'); await next.app.start();
  assert.equal(next.app.state.scoringMode, 'lucky-number'); assert.equal(next.app.state.rulesLocked, true);
  assert.equal(next.app.state.gameRules['101'].number, 7);
  next.app.selectScoringRule('damage-tail'); assert.equal(next.app.state.scoringMode, 'lucky-number'); next.app.stop();
});

test('编号暂不可用时持久化开局快照，重启后仍使用原数字', async () => {
  const ctx = setup('GameStart'); ctx.app.setLuckyNumber(7);
  ctx.handlers.get_active_game = () => null; await ctx.app.start();
  assert.equal(ctx.app.state.configuredLuckyNumber, null); ctx.app.stop();
  const next = setup('InProgress', 101, ctx.storage, 'damage-tail'); await next.app.start();
  assert.equal(next.store.get(101).number, 7); assert.equal(next.app.state.scoringMode, 'lucky-number'); next.app.stop();
});

test('未绑定的旧开局快照过期后不套用到另一局，赛前重启会清理', async () => {
  const ctx = setup('GameStart'); ctx.app.setLuckyNumber(7);
  ctx.handlers.get_active_game = () => null; await ctx.app.start(); ctx.app.stop();
  const now = Date.now; Date.now = () => now() + 30000;
  try {
    const next = setup('GameStart', 102, ctx.storage); await next.app.start();
    assert.equal(next.store.get(102), null); assert.equal(next.app.state.gameRules['102'].mode, null); next.app.stop();
  } finally { Date.now = now; }
  const lobby = setup('Lobby', 102, ctx.storage); await lobby.app.start();
  assert.equal(lobby.store.opening(), null); assert.equal(lobby.app.state.configuredLuckyNumber, null); lobby.app.stop();
});

test('没有本局开局记录的中途启动只展示战绩，不使用当前设置推断规则', async () => {
  const ctx = setup('InProgress'); ctx.app.setLuckyNumber(7); await ctx.app.start();
  assert.equal(ctx.app.state.gameRules['101'].mode, null);
  assert.equal(ctx.store.get(101), null); assert.equal(ctx.app.state.rulesLocked, true); ctx.app.stop();
});

test('保存开局快照失败后只重试原快照，不读取后来改变的待配置数字', async () => {
  const base = memoryStorage(); let broken = false;
  const storage = {getItem: base.getItem, setItem: (key, value) => { if (broken) throw Error('磁盘错误'); base.setItem(key, value); }};
  const ctx = setup('GameStart', 101, storage); ctx.app.setLuckyNumber(7); broken = true;
  await ctx.app.start(); assert.equal(ctx.app.state.rulesLocked, true); assert.equal(ctx.store.get(101), null);
  assert.match(ctx.app.state.luckyError, /磁盘错误/); broken = false;
  ctx.store.setConfiguredNumber(3); await ctx.tick();
  assert.equal(ctx.store.get(101).number, 7); ctx.app.stop();
});

test('旧数字记录迁移规则，无记录旧局保持未知', () => {
  const storage = memoryStorage(); storage.setItem('luckyState', JSON.stringify({version: 4, configured: null,
    draws: {'101': {gameId: 101, number: 0, announcedAt: 1}}}));
  const store = createLuckyNumbers(storage);
  assert.equal(store.rulesSnapshot()['101'].mode, 'lucky-number');
  assert.equal(store.rulesSnapshot()['101'].number, 0); assert.equal(store.rulesSnapshot()['102'], undefined);
});

test('已经取得编号但保存失败，恢复后仍保存开局原快照', async () => {
  const base = memoryStorage(); let failLock = true;
  const storage = {getItem: base.getItem, setItem: (key, value) => {
    if (failLock && JSON.parse(value).rules?.['101']) throw Error('记录保存失败');
    base.setItem(key, value);
  }};
  const ctx = setup('GameStart', 101, storage); ctx.app.setLuckyNumber(7); await ctx.app.start();
  assert.equal(ctx.store.get(101), null); assert.match(ctx.app.state.luckyError, /记录保存失败/);
  const now = Date.now; Date.now = () => now() + 30000;
  try {
    failLock = false; ctx.phase('InProgress'); await ctx.tick();
    assert.equal(ctx.store.get(101).number, 7); assert.equal(ctx.app.state.gameRules['101'].mode, 'lucky-number');
  } finally {Date.now = now; ctx.app.stop();}
});

test('自定义红包人数接受自动或1～9整数，非法输入保留旧设置', () => {
  const ctx = setup();
  assert.equal(ctx.app.state.customPayerCount, null);
  for (let count = 1; count <= 9; count++) {
    assert.equal(ctx.app.setCustomPayerCountInput(String(count)), true);
    assert.equal(ctx.app.state.customPayerCount, count);
    assert.equal(createLuckyNumbers(ctx.storage).customPayerCount(), count);
  }
  for (const value of ['', '0', '10', '-1', '1.5', '03', '+3', ' 3', '３', 'x']) {
    assert.equal(ctx.app.setCustomPayerCountInput(value), false);
    assert.equal(ctx.app.state.customPayerCount, 9);
  }
  for (const value of [0, 10, -1, 1.5, NaN, Infinity, undefined, '3']) {
    assert.throws(() => ctx.store.setCustomPayerCount(value));
  }
  assert.equal(ctx.app.setCustomPayerCount(null), true);
  assert.equal(ctx.app.state.customPayerCount, null);
  assert.equal(createLuckyNumbers(ctx.storage).customPayerCount(), null);
  assert.equal(JSON.parse(ctx.storage.getItem('luckyState')).version, 6);
  ctx.app.stop();
});

test('红包人数保存失败显示错误且不改变持久化值及界面值', () => {
  const base = memoryStorage(); let broken = false;
  const storage = {getItem: base.getItem, setItem: (key, value) => { if (broken) throw Error('写入失败'); base.setItem(key, value); }};
  const ctx = setup('Lobby', 101, storage);
  assert.equal(ctx.app.setCustomPayerCount(3), true);
  const saved = storage.getItem('luckyState'); broken = true;
  assert.equal(ctx.app.setCustomPayerCount(4), false);
  assert.equal(ctx.app.state.customPayerCount, 3); assert.equal(ctx.store.customPayerCount(), 3);
  assert.equal(storage.getItem('luckyState'), saved); assert.match(ctx.app.state.payoutSettingError, /未保存.*写入失败/);
  ctx.app.stop();
});

test('红包人数在首次会话请求前冻结，开局锁定后禁止修改，结束不消耗长期设置', async () => {
  const ctx = setup('GameStart'); ctx.app.setCustomPayerCount(3); ctx.app.setLuckyNumber(7);
  let resolve; ctx.handlers.get_active_game = () => new Promise(done => {resolve = done;});
  const pending = ctx.app.start(); await new Promise(setImmediate);
  assert.equal(ctx.app.setCustomPayerCountInput('4'), false);
  assert.equal(ctx.app.setCustomPayerCount(null), false); assert.match(ctx.app.state.payoutSettingError, /已锁定/);
  resolve({gameId: 101, phase: 'GameStart'}); await pending;
  assert.equal(ctx.app.state.gameRules['101'].customPayerCount, 3);
  ctx.handlers.get_active_game = () => ({gameId: 101, phase: 'EndOfGame'});
  ctx.phase('EndOfGame'); await ctx.tick();
  assert.equal(ctx.app.state.customPayerCount, 3); assert.equal(ctx.store.customPayerCount(), 3);
  assert.equal(ctx.app.state.configuredLuckyNumber, null); assert.equal(ctx.app.state.payoutSettingError, '');
  ctx.app.stop();
});

test('对局结束改红包人数不改历史快照，下一局使用新值', async () => {
  const ctx = setup('Lobby', 101, memoryStorage(), 'damage-tail'); ctx.app.setCustomPayerCount(2); await ctx.app.start();
  ctx.phase('GameStart'); await ctx.tick(); const first = {...ctx.app.state.gameRules['101']};
  ctx.phase('EndOfGame'); await ctx.tick(); ctx.app.setCustomPayerCount(4);
  assert.deepEqual(ctx.app.state.gameRules['101'], first); assert.equal(first.customPayerCount, 2);
  ctx.phase('Lobby'); await ctx.tick(); ctx.id(102); ctx.phase('GameStart'); await ctx.tick();
  assert.equal(ctx.app.state.gameRules['102'].customPayerCount, 4);
  assert.equal(ctx.app.state.gameRules['101'].customPayerCount, 2); ctx.app.stop();
});

test('游戏中重启恢复当局红包人数，独立长期偏好留待下一局', async () => {
  const ctx = setup('GameStart'); ctx.app.setCustomPayerCount(2); ctx.app.setLuckyNumber(7); await ctx.app.start(); ctx.app.stop();
  // 模拟另一实例改动长期偏好；不能影响既有对局锁定记录。
  createLuckyNumbers(ctx.storage).setCustomPayerCount(4);
  const next = setup('InProgress', 101, ctx.storage); await next.app.start();
  assert.equal(next.app.state.rulesLocked, true); assert.equal(next.app.state.customPayerCount, 2);
  assert.equal(next.app.state.gameRules['101'].customPayerCount, 2); assert.equal(next.store.customPayerCount(), 4);
  next.phase('EndOfGame'); await next.tick(); assert.equal(next.app.state.customPayerCount, 4);
  assert.equal(next.app.state.gameRules['101'].customPayerCount, 2); next.app.stop();
});

test('编号短暂失败并重启时仍绑定原红包人数，不能使用新偏好', async () => {
  const ctx = setup('GameStart'); ctx.app.setCustomPayerCount(3); ctx.app.setLuckyNumber(7);
  ctx.handlers.get_active_game = () => null; await ctx.app.start(); ctx.app.stop();
  createLuckyNumbers(ctx.storage).setCustomPayerCount(5);
  const next = setup('InProgress', 101, ctx.storage); await next.app.start();
  assert.equal(next.app.state.gameRules['101'].customPayerCount, 3); assert.equal(next.app.state.customPayerCount, 3);
  assert.equal(next.store.customPayerCount(), 5); next.app.stop();
});

test('暂存写入失败后重试仍使用原红包人数快照', async () => {
  const base = memoryStorage(); let broken = false;
  const storage = {getItem: base.getItem, setItem: (key, value) => {if (broken) throw Error('磁盘错误'); base.setItem(key, value);}};
  const ctx = setup('GameStart', 101, storage); ctx.app.setCustomPayerCount(2); ctx.app.setLuckyNumber(7);
  broken = true; await ctx.app.start(); assert.equal(ctx.app.state.gameRules['101'], undefined);
  broken = false; ctx.store.setCustomPayerCount(4); await ctx.tick();
  assert.equal(ctx.app.state.gameRules['101'].customPayerCount, 2);
  assert.equal(ctx.app.state.customPayerCount, 2); assert.equal(ctx.store.customPayerCount(), 4); ctx.app.stop();
});

test('幸运数字所有写入与结束清理均保留长期红包人数设置', () => {
  const storage = memoryStorage(); const store = createLuckyNumbers(storage);
  store.setCustomPayerCount(4);
  const remains = () => assert.equal(createLuckyNumbers(storage).customPayerCount(), 4);
  store.setConfiguredNumber(7); remains(); store.confirm(101); remains();
  store.setConfiguredNumber(3); store.clearConfiguration(); remains();
  const opening = {mode: 'damage-tail', number: null, startedAt: Date.now(), gameId: 102, customPayerCount: 4};
  store.stageOpening(opening); remains(); store.lockGame(102, opening); remains(); store.finishGame(); remains();
  store.setConfiguredNumber(null); remains();
});

test('版本2～5记录和未绑定开局快照迁移为自动红包人数，不带入新设置', () => {
  for (const version of [2, 3, 4, 5]) {
    const storage = memoryStorage(); storage.setItem('luckyState', JSON.stringify({version, configured: 7, customPayerCount: 4,
      draws: {'101': {gameId: 101, number: 7, announcedAt: 1}},
      rules: {'101': {gameId: 101, mode: 'lucky-number', number: 7, lockedAt: 1, customPayerCount: 4}},
      opening: {gameId: 101, mode: 'lucky-number', number: 7, startedAt: 1, customPayerCount: 4},
    }));
    const store = createLuckyNumbers(storage);
    assert.equal(store.customPayerCount(), null); assert.equal(store.rulesSnapshot()['101'].customPayerCount, null);
    if (version === 5) assert.equal(store.opening().customPayerCount, null);
  }
});

test('中途启动缺少规则记录时不把当前指定人数套入本局', async () => {
  const ctx = setup('InProgress'); ctx.app.setCustomPayerCount(4); await ctx.app.start();
  assert.equal(ctx.app.state.gameRules['101'].mode, null);
  assert.equal(ctx.app.state.gameRules['101'].customPayerCount, null);
  assert.equal(ctx.store.customPayerCount(), 4); ctx.app.stop();
});

test('新对局禁止选择伤害尾数，旧局历史规则保留', async () => {
  const storage = memoryStorage();
  const store = createLuckyNumbers(storage);
  store.stageOpening({mode:'damage-tail',number:null,startedAt:Date.now(),gameId:101,customPayerCount:null});
  store.lockGame(101,store.opening());
  store.finishGame(true);
  const ctx = setup('Lobby',102,storage,'damage-tail');
  await ctx.app.start();
  ctx.app.selectScoringRule('damage-tail');
  assert.equal(ctx.app.state.scoringMode,'lucky-number');
  assert.match(ctx.app.state.ruleSettingError,/已停用/);
  assert.equal(ctx.app.state.gameRules['101'].mode,'damage-tail');
  ctx.app.setLuckyNumber(5);ctx.phase('GameStart');await ctx.tick();
  assert.equal(ctx.app.state.gameRules['102'].mode,'lucky-number');
  assert.equal(ctx.store.get(102).number,5);
  ctx.app.stop();
});

test('参与名单随本局规则持久化，重启后不按当前好友重新筛选',async()=>{
 const ctx=setup();ctx.handlers.get_lobby_participants=()=>({isCustomGame:true,members:[{puuid:'me',isMe:true},{puuid:'friend',isMe:false}]});
 await ctx.app.start();ctx.app.setLuckyNumber(5);ctx.phase('GameStart');await ctx.tick();ctx.app.stop();
 const next=setup('InProgress',101,ctx.storage);await next.app.start();
 assert.deepEqual(next.app.state.gameRules['101'].participantPuuids,['me','friend']);
 assert.deepEqual(next.app.state.lockedParticipantPuuids,['me','friend']);next.app.stop();
});
