import test from 'node:test';
import assert from 'node:assert/strict';
import { specialGroups, executeSpecial, rememberSpecial, maintainSpecial } from '../src/player/werhd-jev-special.mjs';
import { attachJevPlayer, collectState, candidateGroups, historyHints, rememberChoice } from '../src/player/werhd-jev-player.mjs';

// Engineers: capture candidates, objective-driven training, task follow-up, and the automatic fallback.
const catalog = {
  YARD:{yard:true,label:'YARD'}, BARRACKS:{factory:'InfantryType',label:'BARRACKS',cost:500}, ENG:{engineer:true,cost:500,label:'Engineer'}, GI:{occupier:true,cost:200,weapon:{damage:15,range:4},label:'GI'},
  TECH:{techLevel:2,label:'Tech Outpost'}, EREF:{refinery:true,label:'Enemy Refinery'}, HOUSE:{label:'House'}, DEF:{isBaseDefense:true,weapon:{damage:50,range:8},label:'Pillbox'}, ETANK:{weapon:{damage:60,range:5},label:'Enemy Tank'},
};
const unit = (id,name,type,x,y,extra={}) => ({ id,name,type,tile:{rx:x,ry:y},hitPoints:100,maxHitPoints:100,isIdle:true,primaryWeapon:catalog[name].weapon,...extra });
function world({ own, enemies, neutral = [], credits = 5000, tick = 3000, offers = {2:[{name:'ENG',type:3},{name:'GI',type:3}]} }) {
  const calls = [];
  const all = () => [...own, ...enemies, ...neutral];
  const api = {
    ObjectType:{Building:2,Vehicle:7,Infantry:3,Aircraft:1}, QueueType:{Structures:0,Armory:1,Infantry:2,Vehicles:3,Aircrafts:4,Ships:5}, OrderType:{Move:1,Attack:2,Capture:7,Occupy:8,Repair:9,DeploySelected:10,Stop:11}, LandType:{Clear:0}, ZoneType:{Air:1,Water:2},
    units:r=>r==='self'?own:r==='enemy'?enemies:r==='allied'?[]:[...enemies,...neutral], unit:id=>all().find(u=>u.id===id),
    me:()=>({credits,power:{total:500,drain:100},combatant:true,defeated:false,isObserver:false}), tick:()=>tick, time:()=>tick/15, players:()=>[],
    map:{size:()=>({width:80,height:80}),visible:()=>true,tile:(x,y)=>({rx:x,ry:y,landType:0})}, canPlace:()=>true,
    production:{queues:()=>Array.from({length:6},(_,type)=>({type,size:0,maxSize:99,items:[]})),available:q=>q===undefined?Object.values(offers).flat():(offers[q]??[])},
    weaponVs:()=>undefined, inRange:()=>false, attack:(...a)=>calls.push(['attack',...a]), move:(...a)=>calls.push(['move',...a]), attackMove:(...a)=>calls.push(['attackMove',...a]), deploy:()=>true,
    order:(ids,o)=>{calls.push(['order',ids,o]);return true;}, produce:(...a)=>calls.push(['produce',...a]), gather(){}, repair(){},
    onTick:h=>{api._tick=h;}, offTick(){},
  };
  const memory = { frontiers:new Map(), enemyBuildings:new Map(), orders:new Map(), postureOrders:new Map(), specialOrders:new Map(), specialTargets:new Map(), plannedSites:new Map(), observedSpecial:new Map(), repairing:new Set(), lastMaintenance:tick, lastMicroReport:-1000 };
  return { api, memory, calls, setTick:t=>{tick=t;} };
}
const snapshotOf = (api) => collectState(api, catalog);

test('capture candidates: neutral tech first, undefended enemy economy next, defended and garrisonable buildings never', () => {
  const own=[unit(1,'YARD',2,10,10), unit(2,'BARRACKS',2,12,10), unit(20,'ENG',3,14,12), unit(21,'GI',3,13,12)];
  const tech=unit(100,'TECH',2,30,30), house={...unit(101,'HOUSE',2,32,30),garrison:{count:0,capacity:5,canOccupy:true}};
  const eref=unit(200,'EREF',2,50,50), guarded=unit(201,'EREF',2,60,60), pill=unit(202,'DEF',2,64,60), tank=unit(203,'ETANK',7,62,58);
  const { api, memory } = world({ own, enemies:[eref,guarded,pill,tank], neutral:[tech,house] });
  const groups={}; specialGroups(api, catalog, snapshotOf(api), memory, groups);
  const e=groups.engineering; assert.ok(e,'an engineering group is offered');
  assert.ok(e.actions.capture_100,'the neutral tech outpost is a capture target');assert.equal(e.actions.capture_100.auto,2);assert.match(e.criteria.capture_100,/CAPTURE \(neutral\)/);assert.equal(e.actions.capture_100.order.type,7);assert.deepEqual(e.actions.capture_100.ids,[20]);
  assert.ok(e.actions.capture_200,'an undefended enemy refinery is a capture target');assert.equal(e.actions.capture_200.auto,3);
  assert.ok(!e.actions.capture_201,'a refinery under a pillbox and a tank is not offered');
  assert.ok(!e.actions.capture_101,'garrisonable houses are for garrisons, not engineers');assert.ok(!e.actions.capture_202,'defenses are not captured');
  assert.deepEqual(memory.captureTargets,[100,200]);
  assert.match(e.instructions,/Capture neutral technology structures/);
});

test('with capture targets and no engineer, training one becomes an objective and can run automatically when affordable', () => {
  const own=[unit(1,'YARD',2,10,10), unit(2,'BARRACKS',2,12,10), unit(21,'GI',3,13,12), unit(22,'GI',3,13,13), unit(23,'GI',3,13,14)];
  const { api, memory } = world({ own, enemies:[], neutral:[unit(100,'TECH',2,30,30)], credits:9000 });
  const groups={}; specialGroups(api, catalog, snapshotOf(api), memory, groups);
  assert.ok(!groups.engineering?.actions?.capture_100,'no engineer, no capture order yet');
  const train=groups.infantry?.actions?.produce_ENG; assert.ok(train,'an engineer is offered for training');
  assert.match(groups.infantry.criteria.produce_ENG,/OBJECTIVE: train an engineer to capture Tech Outpost #100/);assert.equal(train.auto,3);
  const poor=world({ own, enemies:[], neutral:[unit(100,'TECH',2,30,30)], credits:1900 });
  const g2={}; specialGroups(poor.api, catalog, snapshotOf(poor.api), poor.memory, g2);
  assert.ok(g2.infantry?.actions?.produce_ENG);assert.equal(g2.infantry.actions.produce_ENG.auto,undefined,'with little money the model decides');
});

test('a capture order is issued, followed up while the engineer is idle, and finishes when the building changes hands', () => {
  const eng=unit(20,'ENG',3,14,12), tech=unit(100,'TECH',2,30,30);
  const own=[unit(1,'YARD',2,10,10), eng];
  const w=world({ own, enemies:[], neutral:[tech] });
  const action={ type:'special', kind:'capture', ids:[20], targetId:100, order:{ type:7, target:{ objectId:100 } } };
  const execution=executeSpecial(w.api, action);
  assert.equal(execution.accepted,true);assert.deepEqual(w.calls.at(-1),['order',[20],{type:7,target:{objectId:100}}]);
  rememberSpecial(w.memory, action, execution, 3000);
  assert.equal(w.memory.specialTasks.length,1);assert.equal(w.memory.specialOrders.get(20).kind,'capture');
  const events=[];
  w.setTick(3100); maintainSpecial(w.api, w.memory, e=>events.push(e));
  assert.equal(w.calls.filter(c=>c[0]==='order').length,1,'no re-issue within 150 ticks');
  w.setTick(3200); maintainSpecial(w.api, w.memory, e=>events.push(e));
  assert.equal(w.calls.filter(c=>c[0]==='order').length,2,'an idle engineer is sent again');
  own.push({...tech}); // the building is ours now
  w.setTick(3300); maintainSpecial(w.api, w.memory, e=>events.push(e));
  assert.equal(w.memory.specialTasks.length,0);assert.equal(events.at(-1).result,'completed');assert.equal(w.memory.specialOrders.has(20),false);
  assert.equal(executeSpecial(w.api, action).reason,'already_owned');
});

test('after two declined capture questions the neutral structure is captured automatically', async () => {
  const own=[unit(1,'YARD',2,10,10), unit(2,'BARRACKS',2,12,10), unit(20,'ENG',3,14,12), unit(21,'GI',3,13,12)];
  const w=world({ own, enemies:[], neutral:[unit(100,'TECH',2,30,30)], offers:{} });
  const answers=[];
  const player=await attachJevPlayer(w.api,{ catalog, intervalMs:1e9, wakeIntervalMs:0, disableMicro:true, maxDecisions:50,
    requestDecision:async body=>{answers.push(Object.keys(body.groups));return { answers:Object.fromEntries(Object.keys(body.groups).map(id=>[id,{type:'choice',choice:'wait',confidence:1}])) };} });
  try{
    await new Promise(r=>setTimeout(r,5));
    assert.ok(answers[0].includes('engineering'),'the capture question is asked');
    w.setTick(3020); w.api._tick({tick:3020}); await new Promise(r=>setTimeout(r,5));
    const auto=player.status.events.filter(e=>e.kind==='action'&&e.auto);
    assert.equal(auto.length,1,'the second decline triggers the automatic capture');assert.equal(auto[0].reason,'auto_engineering');assert.equal(auto[0].action.kind,'capture');
    assert.ok(w.calls.some(c=>c[0]==='order'&&c[2].type===7),'the capture order reached the game');
    assert.equal(player.memory.specialOrders.get(20)?.kind,'capture');
  } finally { player.stop('manual'); }
});

test('recent answers are shown back when they produced nothing, and a stale option is demoted or removed', () => {
  const memory={ ledger:{ownUnitsLost:6,ownBuildingsLost:0,enemyUnitsDestroyed:1,enemyBuildingsDestroyed:0}, recent:{}, escalation:{level:1} };
  const groups={ tactics:{instructions:'Choose.',criteria:{wait:'Wait.',engage_visible:'Engage.',assault_9:'Assault.',defend_base:'Defend.'},actions:{wait:{type:'wait'},engage_visible:{type:'mission'},assault_9:{type:'mission'},defend_base:{type:'mission'}}}, vehicles:{instructions:'Build.',criteria:{wait:'Wait.',produce_TANK:'Tank.'},actions:{wait:{type:'wait'},produce_TANK:{type:'produce'}}} };
  memory.ledger.ownUnitsLost=0; // history recorded before the losses
  for(let i=0;i<5;i++)rememberChoice(memory,'tactics','engage_visible',{accepted:true},1000+i*60);
  rememberChoice(memory,'vehicles','produce_TANK',{accepted:true},1000);rememberChoice(memory,'vehicles','wait',{accepted:false,reason:'wait'},1060);
  memory.ledger.ownUnitsLost=6;
  const state={};
  const hints=historyHints(groups,memory,state,{level:1});
  assert.equal(hints.tactics.streak,5);assert.equal(hints.tactics.lostSince,6);assert.equal(hints.tactics.killedSince,0);assert.equal(hints.tactics.stale,true);
  assert.match(groups.tactics.instructions,/RECENT ANSWERS HERE: engage_visible, engage_visible/);assert.match(groups.tactics.instructions,/since then we lost 6 and destroyed 0/);
  assert.match(groups.tactics.criteria.engage_visible,/^STALE ×5/);assert.ok(groups.tactics.actions.engage_visible,'at escalation 1 the option stays, marked');
  assert.equal(hints.vehicles.stale,false);assert.match(groups.vehicles.instructions,/RECENT ANSWERS HERE/,'at escalation ≥1 every group shows its history');
  assert.deepEqual(state.recentChoices.tactics,hints.tactics);
  const again=historyHints(groups,memory,state,{level:2});
  assert.equal(again.tactics.removed,true);assert.ok(!groups.tactics.actions.engage_visible&&!groups.tactics.criteria.engage_visible,'at escalation 2 the stale option is withdrawn for this round');
  assert.ok(groups.tactics.actions.assault_9&&groups.tactics.actions.wait,'other options and wait remain');
  for(let i=0;i<5;i++)rememberChoice(memory,'tactics','defend_base',{accepted:true},2000+i*60);
  historyHints(groups,memory,state,{level:3});assert.ok(groups.tactics.actions.defend_base,'base defence is never withdrawn');
  const quiet={ledger:memory.ledger,recent:{tactics:[{choice:'assault_9',tick:1,accepted:true,reason:'',lost:6,killed:1}]}};
  const g3={tactics:{instructions:'Choose.',criteria:{wait:'',assault_9:''},actions:{wait:{},assault_9:{}}}};
  historyHints(g3,quiet,{},{level:0});assert.doesNotMatch(g3.tactics.instructions,/RECENT/,'nothing is added while things go fine');
});
