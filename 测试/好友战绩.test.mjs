import test from 'node:test';
import assert from 'node:assert/strict';
import {createAssistant} from '../src/assistant.ts';
import {createLuckyNumbers} from '../src/lucky.ts';
import {groupPlayers,displayMatchTeams} from '../src/grouping.ts';
import {evaluateDamageTails,evaluateLuckyNumbers} from '../src/scoring.ts';

const friends=[{puuid:'friend-a',displayName:'好友甲'},{puuid:'friend-b',displayName:'好友乙'}];
const result=(gameId=101,puuid='friend-a')=>({gameId,historyOwnerPuuid:puuid,isCustomGame:false,gameMode:'ARAM',players:[
  ...[76,68,77].map((damage,i)=>({summonerName:['甲','乙','丙'][i],damage,teamId:200,isMe:false,isFriend:true,isHistoryOwner:i===0})),
  {summonerName:'路人',damage:0,teamId:200,isFriend:false,isMe:false},
  {summonerName:'对方好友',damage:0,teamId:100,isFriend:true,isMe:false},
]});
const deferred=()=>{let resolve;let reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}};
function setup(overrides={},rule='damage-tail'){
 const entries=new Map(); const storage={getItem:k=>entries.get(k)??null,setItem:(k,v)=>entries.set(k,v)};
 const store=createLuckyNumbers(storage);const calls=[];
 const handlers={check_connection:()=> '自己',get_gameflow_phase:()=> 'Lobby',get_friends:()=>friends,
  get_match_list:()=>[{gameId:10}],get_friend_match_list:()=>[{gameId:101}],
  get_game_result:({gameId})=>({...result(gameId),historyOwnerPuuid:null}),
  get_friend_game_result:({gameId,puuid})=>result(gameId,puuid),...overrides};
 const app=createAssistant(async(command,args)=>{calls.push({command,args});return handlers[command]?.(args)},async()=>{},
  {setTimeout:()=>0,clearTimeout:()=>{}},async()=>true,store,rule);
 return{app,store,handlers,calls,storage};
}
async function openFriend(ctx,puuid='friend-a'){
 await ctx.app.loadHistory();await ctx.app.selectHistoryOwner(puuid);await ctx.app.viewGame(101);
}

test('历史可选择好友、读取指定好友战绩，返回保留选择，再切回自己',async()=>{
 const ctx=setup();await openFriend(ctx);
 assert.equal(ctx.app.state.resultOwner.puuid,'friend-a');
 assert.deepEqual(ctx.calls.find(c=>c.command==='get_friend_game_result').args,{gameId:101,puuid:'friend-a'});
 ctx.app.goBack();assert.equal(ctx.app.state.page,'history');assert.equal(ctx.app.state.historyOwner.puuid,'friend-a');
 assert.equal(ctx.app.state.matchList[0].gameId,101);
 await ctx.app.selectHistoryOwner('');assert.equal(ctx.app.state.historyOwner,null);assert.equal(ctx.app.state.matchList[0].gameId,10);
 await ctx.app.viewGame(10);assert.equal(ctx.app.state.resultOwner,null);ctx.app.stop();
});

test('快速切换好友，迟到的上一位好友列表不能覆盖新选择',async()=>{
 const pending=deferred(); const ctx=setup({get_friend_match_list:({puuid})=>puuid==='friend-a'?pending.promise:[{gameId:202}]});
 await ctx.app.loadHistory();const first=ctx.app.selectHistoryOwner('friend-a');await ctx.app.selectHistoryOwner('friend-b');
 pending.resolve([{gameId:101}]);await first;
 assert.equal(ctx.app.state.historyOwner.puuid,'friend-b');assert.equal(ctx.app.state.matchList[0].gameId,202);ctx.app.stop();
});

test('详情读取中切换好友，不展示迟到的旧好友详情',async()=>{
 const pending=deferred();const ctx=setup({get_friend_game_result:()=>pending.promise});
 await ctx.app.loadHistory();await ctx.app.selectHistoryOwner('friend-a');const detail=ctx.app.viewGame(101);
 await ctx.app.selectHistoryOwner('friend-b');pending.resolve(result());await detail;
 assert.equal(ctx.app.state.page,'history');assert.equal(ctx.app.state.historyOwner.puuid,'friend-b');assert.equal(ctx.app.state.gameResult,null);ctx.app.stop();
});

test('好友接口失败可重试，不阻断自己的战绩',async()=>{
 const ctx=setup({get_friends:()=>{throw Error('好友读取失败')}});await ctx.app.loadHistory();
 assert.equal(ctx.app.state.matchList[0].gameId,10);assert.match(ctx.app.state.friendsError,/好友读取失败/);
 ctx.handlers.get_friends=()=>friends;await ctx.app.loadFriends();assert.equal(ctx.app.state.friendsError,'');
 assert.equal(ctx.app.state.friends.length,2);ctx.app.stop();
});

test('好友战绩无权限、空记录分别呈现，失败不会保留上一位列表',async()=>{
 const ctx=setup({get_friend_match_list:()=>{throw Error('403')}});await ctx.app.loadHistory();await ctx.app.selectHistoryOwner('friend-a');
 assert.deepEqual(ctx.app.state.matchList,[]);assert.match(ctx.app.state.errorMsg,/403/);
 ctx.handlers.get_friend_match_list=()=>[];await ctx.app.loadHistory();assert.equal(ctx.app.state.errorMsg,'');assert.deepEqual(ctx.app.state.matchList,[]);ctx.app.stop();
});

test('详情返回错误好友或错误编号时拒绝显示',async()=>{
 for(const wrong of [result(102),result(101,'friend-b')]){
  const ctx=setup({get_friend_game_result:()=>wrong});await openFriend(ctx);
  assert.equal(ctx.app.state.page,'history');assert.equal(ctx.app.state.gameResult,null);assert.match(ctx.app.state.errorMsg,/不一致|不属于/);ctx.app.stop();
 }
});

test('手动试算默认当前规则，查看双方战绩但只计算所选好友与同队好友',async()=>{
 const ctx=setup();await openFriend(ctx);assert.equal(ctx.app.state.trial,null);ctx.app.startTrial();
 assert.equal(ctx.app.state.trial.mode,'damage-tail');
 const people=groupPlayers(ctx.app.state.gameResult).flatMap(g=>g.players);
 assert.equal(displayMatchTeams(ctx.app.state.gameResult).flatMap(g=>g.players).length,5);
 assert.deepEqual(people.map(p=>p.summonerName),['甲','乙','丙']);
 assert.deepEqual(evaluateDamageTails(people).lowestPlayers.map(p=>p.summonerName),['甲']);
 ctx.app.setTrialRule('lucky-number');assert.equal(ctx.app.setTrialNumberInput('7'),true);
 assert.deepEqual(evaluateLuckyNumbers(people,ctx.app.state.trial.number).lowestPlayers.map(p=>p.summonerName),['乙']);ctx.app.stop();
});

test('试算数字0有效，空值不是0，非法输入不替换上一个合法值',async()=>{
 const ctx=setup({},'lucky-number');await openFriend(ctx);ctx.app.startTrial();
 assert.equal(ctx.app.state.trial.number,null);assert.equal(ctx.app.setTrialNumberInput('0'),true);assert.equal(ctx.app.state.trial.number,0);
 for(const value of ['10','-1','07','1.5','a','７']){assert.equal(ctx.app.setTrialNumberInput(value),false);assert.equal(ctx.app.state.trial.number,0)}
 assert.equal(ctx.app.setTrialNumberInput(''),true);assert.equal(ctx.app.state.trial.number,null);ctx.app.stop();
});

test('试算不修改全局规则、赛前配置或真实开局记录，离开详情清空试算',async()=>{
 const ctx=setup();ctx.store.setConfiguredNumber(7);ctx.store.confirm(101);ctx.store.setConfiguredNumber(3);
 const saved=ctx.storage.getItem('luckyState');await openFriend(ctx);ctx.app.startTrial();ctx.app.setTrialRule('lucky-number');ctx.app.setTrialNumberInput('9');
 assert.equal(ctx.app.state.scoringMode,'damage-tail');assert.equal(ctx.storage.getItem('luckyState'),saved);
 ctx.app.goBack();assert.equal(ctx.app.state.trial,null);await ctx.app.viewGame(101);ctx.app.startTrial();assert.equal(ctx.app.state.trial.number,null);ctx.app.stop();
});

test('本人正在游戏中仍可独立试算好友历史，不解锁实际对局',async()=>{
 const ctx=setup({get_gameflow_phase:()=> 'GameStart',get_active_game:()=>({gameId:999,phase:'GameStart'})});
 await ctx.app.start();const saved=ctx.storage.getItem('luckyState');await openFriend(ctx);
 ctx.app.startTrial();ctx.app.setTrialRule('lucky-number');ctx.app.setTrialNumberInput('7');
 assert.equal(ctx.app.state.rulesLocked,true);assert.equal(ctx.app.state.gameRules['999'].mode,'damage-tail');
 assert.equal(ctx.storage.getItem('luckyState'),saved);ctx.app.stop();
});

test('自定义十人试算双方全员参与，最后两人发红包',async()=>{
 const custom={...result(),isCustomGame:true,players:Array.from({length:10},(_,i)=>({summonerName:String(i),damage:i,teamId:i<5?100:200,isHistoryOwner:i===5,isFriend:i===5,isMe:false}))};
 const ctx=setup({get_friend_game_result:()=>custom});await openFriend(ctx);ctx.app.startTrial();
 const people=groupPlayers(ctx.app.state.gameResult).flatMap(g=>g.players);
 assert.equal(people.length,10);assert.deepEqual(evaluateDamageTails(people).lowestPlayers.map(p=>p.summonerName),['0','1']);ctx.app.stop();
});

test('未知对局类型不启动试算，少于两人不指定红包对象',async()=>{
 const ctx=setup({get_friend_game_result:()=>({...result(),isCustomGame:null})});await openFriend(ctx);ctx.app.startTrial();
 assert.equal(ctx.app.state.trial,null);assert.match(ctx.app.state.trialError,/无法识别/);
 assert.equal(evaluateDamageTails([result().players[0]]).status,'insufficient');ctx.app.stop();
});

test('卸载后迟到的好友列表不再修改页面状态',async()=>{
 const pending=deferred();const ctx=setup({get_friends:()=>pending.promise});
 const loading=ctx.app.loadFriends();ctx.app.stop();pending.resolve(friends);await loading;assert.deepEqual(ctx.app.state.friends,[]);
});
