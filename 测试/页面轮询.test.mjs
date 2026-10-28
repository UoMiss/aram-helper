import test from "node:test";
import assert from "node:assert/strict";
import { createAssistant } from "../src/assistant.ts";
import { createLuckyNumbers } from "../src/lucky.ts";
import { detectBattleMode } from "../src/grouping.ts";

const game = (gameId = 1) => ({ gameId, gameMode: "ARAM", gameDuration: 1200, timestamp: Date.now(), players: [] });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(setImmediate);
function setup(overrides = {}, isWindowActive = async () => true) {
  const jobs = new Map(); let next = 0; let shown = 0;
  const calls = [];
  const entries = new Map();
  const store = createLuckyNumbers({ getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) });
  const handlers = { check_connection: () => "测试玩家", get_gameflow_phase: () => "Lobby", get_last_game_result: () => game(), get_match_list: () => [], get_game_result: ({ gameId }) => game(gameId), get_active_game: () => ({ gameId: 1, phase: handlers.get_gameflow_phase() }), ...overrides };
  const app = createAssistant(async (command, args) => { calls.push(command); return handlers[command]?.(args); }, async () => { shown++; }, {
    setTimeout(fn) { const id = ++next; jobs.set(id, fn); return id; },
    clearTimeout(id) { jobs.delete(id); },
  }, isWindowActive, store);
  return { app, handlers, calls, jobs, get shown() { return shown; }, async tick() {
    assert.equal(jobs.size, 1, "始终只有一个待运行轮询");
    const [id, fn] = jobs.entries().next().value; jobs.delete(id); fn(); await flush();
  }};
}

test("当前对局从匹配切换到自定义后更新类型，回到大厅清空", async () => {
  const ctx = setup({ get_current_game_type: () => false });
  await ctx.app.start();
  assert.equal(ctx.app.state.currentIsCustomGame, false);
  ctx.handlers.get_current_game_type = () => true;
  await ctx.tick();
  assert.equal(ctx.app.state.currentIsCustomGame, true);
  ctx.handlers.get_gameflow_phase = () => "None";
  await ctx.tick();
  assert.equal(ctx.app.state.currentIsCustomGame, null);
  ctx.app.stop();
});

test("类型查询失败不沿用上一局类型，也不阻断自动结算", async () => {
  const ctx = setup({ get_current_game_type: () => true });
  await ctx.app.start();
  ctx.handlers.get_current_game_type = () => { throw Error("类型暂不可用"); };
  ctx.handlers.get_gameflow_phase = () => "EndOfGame";
  ctx.handlers.get_game_result = () => ({ ...game(), isCustomGame: false });
  await ctx.tick();
  assert.equal(ctx.app.state.currentIsCustomGame, null);
  assert.equal(ctx.app.state.connStatus, "connected");
  assert.equal(ctx.app.state.page, "result");
  assert.equal(detectBattleMode(ctx.app.state.gameResult), "solo");
  ctx.app.stop();
});

test("当前自定义房间不影响历史匹配结算，重读后仍可返回历史列表", async () => {
  const ctx = setup({ get_current_game_type: () => true,
    get_game_result: () => ({ ...game(9), isCustomGame: false }) });
  await ctx.app.start();
  await ctx.app.loadHistory();
  await ctx.app.viewGame(9);
  await ctx.tick();
  assert.equal(ctx.app.state.currentIsCustomGame, true);
  assert.equal(detectBattleMode(ctx.app.state.gameResult), "solo");
  await ctx.app.viewGame(9);
  ctx.app.goBack();
  assert.equal(ctx.app.state.page, "history");
  ctx.app.stop();
});

test("上一局读取失败后显示错误，后台仍然轮询", async () => {
  const ctx = setup({ get_last_game_result: () => { throw new Error("数据尚未准备好"); } });
  await ctx.app.start(); await ctx.app.viewLastGame();
  assert.match(ctx.app.state.errorMsg, /读取对局失败/);
  assert.equal(ctx.app.state.loading, false);
  await ctx.tick();
  assert.equal(ctx.calls.filter(c => c === "get_gameflow_phase").length, 2);
  ctx.app.stop();
});

test("反复返回和立即重连不会创建多个轮询", async () => {
  const ctx = setup(); await ctx.app.start();
  for (let i = 0; i < 5; i++) { ctx.app.openSettings(); ctx.app.goHome(); }
  await Promise.all([ctx.app.retryConnection(), ctx.app.retryConnection(), ctx.app.retryConnection()]);
  assert.equal(ctx.jobs.size, 1);
  await ctx.tick(); ctx.app.stop(); assert.equal(ctx.jobs.size, 0);
});

test("手动历史结果在游戏中不会自动关闭，并可回到历史列表", async () => {
  const ctx = setup({ get_gameflow_phase: () => "InProgress", get_match_list: () => [{ gameId: 2 }], get_game_result: () => game(2) });
  await ctx.app.start(); await ctx.app.loadHistory(); await ctx.app.viewGame(2); await ctx.tick();
  assert.equal(ctx.app.state.page, "result"); assert.equal(ctx.app.state.gameResult.gameId, 2); assert.equal(ctx.shown, 0);
  ctx.app.goBack(); assert.equal(ctx.app.state.page, "history"); assert.equal(ctx.app.state.matchList.length, 1);
  ctx.app.stop();
});

test("离开页面后，迟到的历史详情不会覆盖新页面", async () => {
  const pending = deferred(); const ctx = setup({ get_game_result: () => pending.promise });
  await ctx.app.loadHistory(); const request = ctx.app.viewGame(2); ctx.app.goHome(); pending.resolve(game(2)); await request;
  assert.equal(ctx.app.state.page, "status"); assert.equal(ctx.app.state.gameResult, null); assert.equal(ctx.app.state.loading, false);
  ctx.app.stop();
});

test("自动结算只显示一次；下一局开始自动收起；等待统计时不读取旧局", async () => {
  const ctx = setup({ get_gameflow_phase: () => "WaitingForStats" }); await ctx.app.start();
  assert.equal(ctx.calls.includes("get_last_game_result"), false);
  ctx.handlers.get_gameflow_phase = () => "EndOfGame"; await ctx.tick();
  assert.equal(ctx.app.state.page, "result"); assert.equal(ctx.shown, 1);
  ctx.app.goHome(); await ctx.tick(); assert.equal(ctx.shown, 1);
  assert.equal(ctx.calls.filter(c => c === "get_game_result").length, 1);
  assert.equal(ctx.calls.includes("get_last_game_result"), false);
  ctx.handlers.get_gameflow_phase = () => "ChampSelect"; await ctx.tick();
  ctx.handlers.get_active_game = () => ({ gameId: 2, phase: "EndOfGame" }); ctx.handlers.get_gameflow_phase = () => "EndOfGame"; await ctx.tick();
  assert.equal(ctx.shown, 2);
  ctx.handlers.get_gameflow_phase = () => "InProgress"; await ctx.tick(); assert.equal(ctx.app.state.page, "status");
  ctx.app.stop();
});

test("历史加载失败可重试，空记录正常完成加载", async () => {
  const ctx = setup({ get_match_list: () => { throw new Error("连接失败"); } }); await ctx.app.loadHistory();
  assert.match(ctx.app.state.errorMsg, /历史记录暂时不可用/); assert.equal(ctx.app.state.historyLoading, false);
  ctx.handlers.get_match_list = () => []; await ctx.app.loadHistory();
  assert.equal(ctx.app.state.errorMsg, ""); assert.equal(ctx.app.state.matchList.length, 0); ctx.app.stop();
});

test("断线后自动重连，保留用户正在查看的页面", async () => {
  const ctx = setup(); await ctx.app.start(); ctx.app.openSettings();
  ctx.handlers.get_gameflow_phase = () => { throw new Error("客户端退出"); }; await ctx.tick();
  assert.equal(ctx.app.state.connStatus, "disconnected");
  ctx.handlers.get_gameflow_phase = () => "Lobby"; await ctx.tick();
  assert.equal(ctx.app.state.connStatus, "connected"); assert.equal(ctx.app.state.page, "settings");
  assert.equal(ctx.app.state.connectionError, ""); ctx.app.stop();
});

test("卸载时正在进行的请求不会再启动轮询或更新页面", async () => {
  const pending = deferred(); const ctx = setup({ check_connection: () => pending.promise });
  const request = ctx.app.start(); ctx.app.stop(); pending.resolve("测试玩家"); await request;
  assert.equal(ctx.jobs.size, 0); assert.equal(ctx.app.state.connStatus, "disconnected");
});

test("自动结算请求期间进入设置，迟到的结果不会跳转或弹窗", async () => {
  const pending = deferred(); const ctx = setup({ get_gameflow_phase: () => "EndOfGame", get_game_result: () => pending.promise });
  const request = ctx.app.start(); await flush(); ctx.app.openSettings(); pending.resolve(game()); await request;
  assert.equal(ctx.app.state.page, "settings"); assert.equal(ctx.shown, 0); assert.equal(ctx.app.state.loading, false); ctx.app.stop();
});

test("新一局结束但接口暂时返回上一局时，继续等待新结果", async () => {
  const ctx = setup({ get_gameflow_phase: () => "EndOfGame" }); await ctx.app.start();
  ctx.handlers.get_gameflow_phase = () => "ChampSelect"; await ctx.tick();
  ctx.handlers.get_active_game = () => ({ gameId: 2, phase: ctx.handlers.get_gameflow_phase() });
  ctx.handlers.get_game_result = () => game(1);
  ctx.handlers.get_gameflow_phase = () => "EndOfGame"; await ctx.tick();
  assert.equal(ctx.shown, 1); assert.equal(ctx.app.state.page, "status");
  assert.match(ctx.app.state.errorMsg, /不是本局/);
  ctx.handlers.get_game_result = () => game(2); await ctx.tick();
  assert.equal(ctx.shown, 2); assert.equal(ctx.app.state.gameResult.gameId, 2); ctx.app.stop();
});

test("历史页收进托盘后，下一局结算仍会显示；前台阅读时保持页面", async () => {
  let active = true;
  const ctx = setup({}, async () => active); await ctx.app.start(); await ctx.app.loadHistory();
  ctx.handlers.get_gameflow_phase = () => "EndOfGame"; await ctx.tick();
  assert.equal(ctx.app.state.page, "history"); assert.equal(ctx.shown, 0);
  active = false; await ctx.tick();
  assert.equal(ctx.app.state.page, "result"); assert.equal(ctx.shown, 1); ctx.app.stop();
});

test("首次自动结算也绑定实际对局，拒绝上一局直到本局数据就绪", async () => {
  const ctx = setup({ get_gameflow_phase: () => "GameStart",
    get_active_game: () => ({ gameId: 101, phase: ctx.handlers.get_gameflow_phase() }),
    get_game_result: ({ gameId }) => { assert.equal(gameId, 101); return game(100); } });
  await ctx.app.start();
  ctx.handlers.get_gameflow_phase = () => "EndOfGame"; await ctx.tick();
  assert.equal(ctx.shown, 0); assert.equal(ctx.app.state.gameResult, null);
  assert.equal(ctx.app.state.loading, false); assert.match(ctx.app.state.errorMsg, /不是本局/);
  ctx.handlers.get_game_result = ({ gameId }) => { assert.equal(gameId, 101); return game(101); };
  await ctx.tick(); assert.equal(ctx.shown, 1); assert.equal(ctx.app.state.gameResult.gameId, 101);
  assert.equal(ctx.calls.includes("get_last_game_result"), false); ctx.app.stop();
});

test("结算时启动且会话无编号，不自动使用最近战绩；仍可手动查看", async () => {
  const ctx = setup({ get_gameflow_phase: () => "EndOfGame", get_active_game: () => null });
  await ctx.app.start(); await ctx.tick();
  assert.equal(ctx.shown, 0); assert.equal(ctx.calls.includes("get_game_result"), false);
  assert.match(ctx.app.state.errorMsg, /无法确认本局编号/);
  await ctx.app.viewLastGame(); assert.equal(ctx.app.state.page, "result"); ctx.app.stop();
});

test("结算时重启可以从结算会话恢复编号，详情未生成则重试", async () => {
  const ctx = setup({ get_gameflow_phase: () => "EndOfGame",
    get_active_game: () => ({ gameId: 33, phase: "EndOfGame" }),
    get_game_result: () => { throw Error("404"); } });
  await ctx.app.start(); assert.equal(ctx.shown, 0); assert.match(ctx.app.state.errorMsg, /等待本局/);
  ctx.handlers.get_game_result = ({ gameId }) => { assert.equal(gameId, 33); return game(33); };
  await ctx.tick(); assert.equal(ctx.shown, 1); assert.equal(ctx.app.state.gameResult.gameId, 33); ctx.app.stop();
});

test("短暂断线和结算会话读取失败不丢失已观察到的本局编号", async () => {
  const ctx = setup({ get_gameflow_phase: () => "GameStart",
    get_active_game: () => ({ gameId: 44, phase: "GameStart" }) });
  await ctx.app.start(); ctx.handlers.get_gameflow_phase = () => { throw Error("断线"); }; await ctx.tick();
  assert.equal(ctx.app.state.rulesLocked, true);
  ctx.app.selectScoringRule("damage-tail"); assert.equal(ctx.app.state.scoringMode, "lucky-number");
  ctx.handlers.get_gameflow_phase = () => "EndOfGame";
  ctx.handlers.get_active_game = () => { throw Error("会话暂不可用"); };
  await ctx.tick(); assert.equal(ctx.app.state.gameResult.gameId, 44); assert.equal(ctx.shown, 1); ctx.app.stop();
});

test("已返回赛前后不会把旧编号用于缺失会话的新局", async () => {
  const ctx = setup({ get_gameflow_phase: () => "GameStart" }); await ctx.app.start();
  ctx.handlers.get_gameflow_phase = () => "Lobby"; await ctx.tick();
  ctx.handlers.get_gameflow_phase = () => "EndOfGame"; ctx.handlers.get_active_game = () => null;
  await ctx.tick(); assert.equal(ctx.shown, 0); assert.match(ctx.app.state.errorMsg, /无法确认本局编号/); ctx.app.stop();
});

test("手动历史详情也拒绝错误编号", async () => {
  const ctx = setup({ get_game_result: () => game(1) });
  await ctx.app.viewGame(2); assert.equal(ctx.app.state.gameResult, null);
  assert.match(ctx.app.state.errorMsg, /编号不一致/); ctx.app.stop();
});

test("本局战绩延迟到返回大厅后继续按同一编号重试", async () => {
  const ctx = setup({ get_gameflow_phase: () => "EndOfGame",
    get_active_game: () => ({ gameId: 55, phase: "EndOfGame" }),
    get_game_result: () => { throw Error("未生成"); } });
  await ctx.app.start(); ctx.handlers.get_gameflow_phase = () => "Lobby";
  ctx.handlers.get_active_game = () => null;
  ctx.handlers.get_game_result = ({ gameId }) => { assert.equal(gameId, 55); return game(55); };
  await ctx.tick(); assert.equal(ctx.shown, 1); assert.equal(ctx.app.state.gameResult.gameId, 55);
  await ctx.tick(); assert.equal(ctx.shown, 1); ctx.app.stop();
});

test("结算会话返回旧编号也不能覆盖游戏中已确认的编号", async () => {
  const ctx = setup({ get_gameflow_phase: () => "GameStart",
    get_active_game: () => ({ gameId: 101, phase: "GameStart" }),
    get_game_result: ({ gameId }) => { assert.equal(gameId, 101); return game(101); } });
  await ctx.app.start(); ctx.handlers.get_gameflow_phase = () => "EndOfGame";
  ctx.handlers.get_active_game = () => ({ gameId: 100, phase: "EndOfGame" });
  await ctx.tick(); assert.equal(ctx.app.state.gameResult.gameId, 101); ctx.app.stop();
});

const room = (ids=['me','friend'],custom=false) => ({isCustomGame:custom,members:ids.map(puuid=>({puuid,summonerName:puuid,isMe:puuid==='me'}))});
test('房间人数自动更新、去重，开局名单锁定后不被房间变化影响',async()=>{
 const ctx=setup({get_lobby_participants:()=>room(['me','friend','friend'])});
 await ctx.app.start();assert.equal(ctx.app.state.lobbyParticipants.members.length,2);
 ctx.handlers.get_lobby_participants=()=>room(['me','friend','new']);await ctx.tick();
 assert.equal(ctx.app.state.lobbyParticipants.members.length,3);
 ctx.app.setLuckyNumber(5);ctx.handlers.get_gameflow_phase=()=> 'GameStart';await ctx.tick();
 assert.deepEqual(ctx.app.state.gameRules['1'].participantPuuids,['me','friend','new']);
 ctx.handlers.get_lobby_participants=()=>room(['me']);await ctx.tick();
 assert.deepEqual(ctx.app.state.lockedParticipantPuuids,['me','friend','new']);ctx.app.stop();
});
test('房间或好友接口失败清空人数，不能沿用上一房间名单',async()=>{
 const ctx=setup({get_lobby_participants:()=>room()});await ctx.app.start();
 ctx.handlers.get_lobby_participants=()=>{throw Error('好友不可用')};await ctx.tick();
 assert.equal(ctx.app.state.lobbyParticipants,null);assert.match(ctx.app.state.lobbyError,/暂不可用/);
 ctx.handlers.get_gameflow_phase=()=> 'GameStart';await ctx.tick();
 assert.equal(ctx.app.state.gameRules['1'].participantPuuids,null);ctx.app.stop();
});
test('选英雄接口消失可沿用同轮名单，返回大厅则重新读取',async()=>{
 const ctx=setup({get_lobby_participants:()=>room()});await ctx.app.start();
 ctx.handlers.get_gameflow_phase=()=> 'ChampSelect';ctx.handlers.get_lobby_participants=()=>{throw Error('no lobby')};await ctx.tick();
 assert.equal(ctx.app.state.lobbyParticipants.members.length,2);
 ctx.handlers.get_gameflow_phase=()=> 'Lobby';await ctx.tick();assert.equal(ctx.app.state.lobbyParticipants,null);ctx.app.stop();
});
test('观战或缺少成员身份不能成为有效名单',async()=>{
 for(const members of [[{puuid:'a',isMe:false}],[{puuid:'',isMe:true}]]){
  const ctx=setup({get_lobby_participants:()=>({isCustomGame:true,members})});await ctx.app.start();assert.equal(ctx.app.state.lobbyParticipants,null);ctx.app.stop();
 }
});
