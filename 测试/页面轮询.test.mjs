import test from "node:test";
import assert from "node:assert/strict";
import { createAssistant } from "../src/assistant.ts";

const game = (gameId = 1) => ({ gameId, gameMode: "ARAM", gameDuration: 1200, timestamp: Date.now(), players: [] });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(setImmediate);
function setup(overrides = {}, isWindowActive = async () => true) {
  const jobs = new Map(); let next = 0; let shown = 0;
  const calls = [];
  const handlers = { check_connection: () => "测试玩家", get_gameflow_phase: () => "Lobby", get_last_game_result: () => game(), get_match_list: () => [], get_game_result: () => game(), ...overrides };
  const app = createAssistant(async (command, args) => { calls.push(command); return handlers[command]?.(args); }, async () => { shown++; }, {
    setTimeout(fn) { const id = ++next; jobs.set(id, fn); return id; },
    clearTimeout(id) { jobs.delete(id); },
  }, isWindowActive);
  return { app, handlers, calls, jobs, get shown() { return shown; }, async tick() {
    assert.equal(jobs.size, 1, "始终只有一个待运行轮询");
    const [id, fn] = jobs.entries().next().value; jobs.delete(id); fn(); await flush();
  }};
}

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
  assert.equal(ctx.calls.filter(c => c === "get_last_game_result").length, 1);
  ctx.handlers.get_gameflow_phase = () => "ChampSelect"; await ctx.tick();
  ctx.handlers.get_last_game_result = () => game(2); ctx.handlers.get_gameflow_phase = () => "EndOfGame"; await ctx.tick();
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
  const pending = deferred(); const ctx = setup({ get_gameflow_phase: () => "EndOfGame", get_last_game_result: () => pending.promise });
  const request = ctx.app.start(); await flush(); ctx.app.openSettings(); pending.resolve(game()); await request;
  assert.equal(ctx.app.state.page, "settings"); assert.equal(ctx.shown, 0); assert.equal(ctx.app.state.loading, false); ctx.app.stop();
});

test("新一局结束但接口暂时返回上一局时，继续等待新结果", async () => {
  const ctx = setup({ get_gameflow_phase: () => "EndOfGame" }); await ctx.app.start();
  ctx.handlers.get_gameflow_phase = () => "ChampSelect"; await ctx.tick();
  ctx.handlers.get_gameflow_phase = () => "EndOfGame"; await ctx.tick();
  assert.equal(ctx.shown, 1); assert.equal(ctx.app.state.page, "status");
  ctx.handlers.get_last_game_result = () => game(2); await ctx.tick();
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
