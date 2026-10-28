import test from 'node:test';
import assert from 'node:assert/strict';
import { createLuckyNumbers, randomLuckyNumber } from '../src/lucky.ts';
import { createAssistant } from '../src/assistant.ts';

function memoryStorage() {
  const entries = new Map();
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
}
function setup(phase = 'ChampSelect', gameId = 101, storage = memoryStorage()) {
  let draws = 0;
  const store = createLuckyNumbers(storage, () => { draws++; return 7; });
  const handlers = {
    check_connection: () => '测试', get_gameflow_phase: () => phase,
    get_active_game: () => ({ gameId, phase }),
    get_last_game_result: () => ({ gameId, players: [] }),
  };
  const app = createAssistant(async (command) => handlers[command]?.(), async () => {},
    { setTimeout: () => 0, clearTimeout: () => {} }, async () => true, store);
  return { app, store, handlers, storage, get draws() { return draws; },
    phase: (next) => { phase = next; }, id: (next) => { gameId = next; }, tick: () => app.retryConnection() };
}

test('随机数覆盖 0～9，舍弃会造成取模偏差的取值', () => {
  assert.deepEqual(Array.from({ length: 10 }, (_, n) => randomLuckyNumber(() => n)), [0,1,2,3,4,5,6,7,8,9]);
  const samples = [4294967295, 4294967290, 17];
  assert.equal(randomLuckyNumber(() => samples.shift()), 7);
});
test('启动进入状态页并使用默认规则，进入游戏不触发抽签', async () => {
  const ctx = setup(); await ctx.app.start();
  assert.equal(ctx.app.state.page, 'status');
  assert.equal(ctx.app.state.scoringMode, 'damage-tail');
  ctx.phase('GameStart'); await ctx.tick();
  ctx.phase('InProgress'); await ctx.tick();
  assert.equal(ctx.draws, 0);
  assert.deepEqual(ctx.app.state.luckyDraws, {});
  ctx.app.stop();
});
test('设置规则不抽签，确认对局才抽并公开，开局只绑定', async () => {
  const ctx = setup('Lobby'); await ctx.app.start();
  ctx.app.selectScoringRule('damage-tail'); assert.equal(ctx.draws, 0);
  ctx.app.selectScoringRule('lucky-number');assert.equal(ctx.draws,0);
  ctx.phase('ReadyCheck');await ctx.tick();
  assert.equal(ctx.draws, 1); assert.equal(ctx.app.state.pendingLuckyDraw.number, 7);
  ctx.phase('InProgress'); await ctx.tick();
  assert.equal(ctx.draws, 1); assert.equal(ctx.app.state.luckyDraws['101'].number, 7);
  assert.equal(ctx.app.state.pendingLuckyDraw, null);
  await ctx.tick(); assert.equal(ctx.draws, 1);
  ctx.app.stop();
});
test('赛前切换规则再选幸运数字复用同一个待用数字，重启仍保留', async () => {
  const ctx = setup('Lobby'); await ctx.app.start();
  ctx.app.selectScoringRule('lucky-number');ctx.phase('ReadyCheck');await ctx.tick();
  const first = ctx.app.state.pendingLuckyDraw;
  ctx.app.selectScoringRule('damage-tail'); ctx.app.selectScoringRule('lucky-number');
  assert.equal(ctx.draws, 1); assert.deepEqual(ctx.app.state.pendingLuckyDraw, first);
  ctx.app.stop();
  const next = setup('ReadyCheck', 101, ctx.storage); await next.app.start();
  assert.equal(next.app.state.scoringMode, 'damage-tail');
  next.app.selectScoringRule('lucky-number'); assert.equal(next.draws, 0);
  assert.deepEqual(next.app.state.pendingLuckyDraw, first); next.app.stop();
});
test('同一局切换规则不重抽，下一局自动重新抽签', async () => {
  const ctx = setup('Lobby'); await ctx.app.start();ctx.app.selectScoringRule('lucky-number');
  ctx.phase('ReadyCheck');await ctx.tick();
  ctx.phase('GameStart'); await ctx.tick();
  ctx.app.selectScoringRule('damage-tail');ctx.app.selectScoringRule('lucky-number'); assert.equal(ctx.draws, 1);
  ctx.phase('EndOfGame');await ctx.tick();
  ctx.phase('Lobby');await ctx.tick();
  ctx.id(102);ctx.phase('ChampSelect');await ctx.tick(); assert.equal(ctx.draws, 2);
  ctx.app.selectScoringRule('lucky-number'); assert.equal(ctx.draws, 2);
  ctx.phase('InProgress');await ctx.tick(); assert.equal(ctx.app.state.luckyDraws['102'].number, 7);
  ctx.app.stop();
});
test('游戏中途或结算后选幸运数字不补抽；历史不消耗待用数字', async () => {
  const ctx = setup('InProgress'); await ctx.app.start();ctx.app.selectScoringRule('lucky-number');
  assert.equal(ctx.draws, 0);assert.match(ctx.app.state.luckyError, /不补抽/);
  ctx.phase('EndOfGame');await ctx.tick();ctx.app.selectScoringRule('lucky-number');assert.equal(ctx.draws, 0);
  ctx.app.stop();
});
test('绑定时不产生随机数；每局记录保留，保存失败不公开', () => {
  const storage = memoryStorage(); let count = 0;
  const store = createLuckyNumbers(storage, () => { count++; return 7; });
  assert.equal(store.bind(101), null); assert.equal(count, 0);
  store.select();store.bind(101);store.select();
  assert.equal(store.bind(101).number, 7);assert.equal(count, 2);
  assert.equal(store.bind(102).number, 7);assert.equal(count, 2);
  assert.equal(createLuckyNumbers(storage).get(101).number, 7);
  const broken = createLuckyNumbers({getItem:()=>null,setItem:()=>{throw Error('保存失败');}},()=>7);
  assert.throws(()=>broken.select(),/保存失败/);assert.equal(broken.pending(),null);
  assert.throws(()=>store.bind(0));
});
test('离线选择只配置规则，连接后在确认对局阶段抽签', async () => {
  const ctx = setup('InProgress');ctx.app.selectScoringRule('lucky-number');assert.equal(ctx.draws,0);
  await ctx.app.start();assert.equal(ctx.app.state.luckyDraws['101'],undefined);
  ctx.phase('EndOfGame');await ctx.tick();ctx.phase('Lobby');await ctx.tick();
  ctx.id(102);ctx.phase('ReadyCheck');await ctx.tick();assert.equal(ctx.draws,1);
  ctx.phase('InProgress');await ctx.tick();
  assert.equal(ctx.app.state.luckyDraws['102'].number,7);assert.equal(ctx.draws,1);ctx.app.stop();
});
test('已公开数字可延迟绑定，接口失败期间及恢复后不会重新抽签', async () => {
  const ctx=setup('Lobby');await ctx.app.start();ctx.app.selectScoringRule('lucky-number');
  ctx.phase('ReadyCheck');await ctx.tick();
  ctx.phase('GameStart');ctx.handlers.get_active_game=()=>{throw Error('暂不可用');};await ctx.tick();
  ctx.phase('InProgress');ctx.handlers.get_active_game=()=>({gameId:101,phase:'InProgress'});await ctx.tick();
  assert.equal(ctx.draws,1);assert.equal(ctx.app.state.luckyDraws['101'].number,7);ctx.app.stop();
});
test('兼容旧版按局保存的抽签记录，恢复不重抽', () => {
  const storage=memoryStorage();storage.setItem('luckyDraws',JSON.stringify({'101':{gameId:101,number:8,announcedAt:1}}));
  const store=createLuckyNumbers(storage,()=>{throw Error('不应抽签');});
  assert.equal(store.get(101).number,8);assert.equal(store.bind(101).number,8);
});

test('恢复设置中的幸运数字规则不会在启动时抽签', async () => {
  let count = 0;
  const store = createLuckyNumbers(memoryStorage(), () => { count++; return 7; });
  const app = createAssistant(async command => command === 'check_connection' ? '测试' : 'Lobby', async () => {},
    {setTimeout:()=>0,clearTimeout:()=>{}}, async()=>true, store, 'lucky-number');
  await app.start();
  assert.equal(app.state.page,'status');assert.equal(app.state.scoringMode,'lucky-number');
  assert.equal(count,0);app.stop();
});

test('连续两局独立抽签，保留两局各自数字，不需要重新选择规则', async () => {
  const storage=memoryStorage();let phase='Lobby',gameId=101,count=0;
  const store=createLuckyNumbers(storage,()=>[7,3][count++]);
  const app=createAssistant(async command=> {
    if(command==='check_connection')return '测试';
    if(command==='get_gameflow_phase')return phase;
    if(command==='get_active_game')return {gameId,phase};
    if(command==='get_last_game_result')return {gameId,players:[]};
  },async()=>{},{setTimeout:()=>0,clearTimeout:()=>{}},async()=>true,store,'lucky-number');
  await app.start();assert.equal(count,0);
  phase='ChampSelect';await app.retryConnection();phase='InProgress';await app.retryConnection();
  assert.equal(app.state.luckyDraws['101'].number,7);
  phase='EndOfGame';await app.retryConnection();phase='Lobby';await app.retryConnection();
  gameId=102;phase='ChampSelect';await app.retryConnection();phase='InProgress';await app.retryConnection();
  assert.equal(count,2);assert.equal(app.state.luckyDraws['101'].number,7);assert.equal(app.state.luckyDraws['102'].number,3);
  await app.retryConnection();assert.equal(count,2);app.stop();
});
test('跳过选英雄阶段时确认 GameStart 后抽签，重启当前局不重复抽', async()=>{
  const ctx=setup('GameStart');ctx.app.state.scoringMode='lucky-number';await ctx.app.start();
  assert.equal(ctx.draws,1);ctx.app.stop();
  const again=setup('GameStart',101,ctx.storage);again.app.state.scoringMode='lucky-number';await again.app.start();
  assert.equal(again.draws,0);assert.equal(again.app.state.luckyDraws['101'].number,7);again.app.stop();
});
test('未预抽且开局接口长期失败，不在游戏中途重新抽签',async()=>{
  const ctx=setup('Lobby');ctx.app.state.scoringMode='lucky-number';await ctx.app.start();
  ctx.phase('GameStart');ctx.handlers.get_active_game=()=>{throw Error('暂不可用');};await ctx.tick();
  const now=Date.now;Date.now=()=>now()+30*60*1000;
  try {ctx.phase('InProgress');ctx.handlers.get_active_game=()=>({gameId:101,phase:'InProgress'});await ctx.tick();assert.equal(ctx.draws,0);}
  finally {Date.now=now;ctx.app.stop();}
});

test('本局未能绑定的数字在结束时作废，下一局重新抽取',async()=>{
  const ctx=setup('Lobby');await ctx.app.start();ctx.app.selectScoringRule('lucky-number');
  ctx.phase('ReadyCheck');await ctx.tick();
  ctx.phase('GameStart');ctx.handlers.get_active_game=()=>{throw Error('读取失败');};await ctx.tick();
  ctx.phase('EndOfGame');await ctx.tick();assert.equal(ctx.app.state.pendingLuckyDraw,null);
  ctx.phase('ChampSelect');await ctx.tick();assert.equal(ctx.draws,2);ctx.app.stop();
});

test('确认对局阶段只抽一次，进入选英雄和游戏保持不变',async()=>{
  const ctx=setup('Lobby');await ctx.app.start();ctx.app.selectScoringRule('lucky-number');assert.equal(ctx.draws,0);
  ctx.phase('Matchmaking');await ctx.tick();assert.equal(ctx.draws,0);
  ctx.phase('ReadyCheck');await ctx.tick();assert.equal(ctx.draws,1);
  await ctx.tick();assert.equal(ctx.draws,1);
  ctx.phase('ChampSelect');await ctx.tick();assert.equal(ctx.draws,1);
  ctx.phase('InProgress');await ctx.tick();assert.equal(ctx.draws,1);
  assert.equal(ctx.app.state.luckyDraws['101'].number,7);ctx.app.stop();
});
test('确认被取消时作废数字，下一次确认重新抽取',async()=>{
  const ctx=setup('Lobby');await ctx.app.start();ctx.app.selectScoringRule('lucky-number');
  ctx.phase('ReadyCheck');await ctx.tick();assert.equal(ctx.draws,1);
  ctx.phase('Matchmaking');await ctx.tick();assert.equal(ctx.app.state.pendingLuckyDraw,null);
  ctx.phase('ReadyCheck');await ctx.tick();assert.equal(ctx.draws,2);ctx.app.stop();
});
