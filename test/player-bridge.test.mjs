import test from 'node:test';
import assert from 'node:assert/strict';
import { specialGroups, executeSpecial, rememberSpecial, maintainSpecial, ATTACK_STUCK_TICKS, CAPTURE_RESENDS } from '../src/player/werhd-jev-special.mjs';
import { collectState, candidateGroups } from '../src/player/werhd-jev-player.mjs';
import { isDecoration, isCapturable } from '../src/player/werhd-jev-catalog.mjs';

// From three real matches (0.5.5 reports, Jev / Laya / DeepSeek): the army kept attacking an enemy
// flag across a destroyed bridge, engineers looped on "capturing" lamp posts and pipes, and the
// bridge repair option was never chosen. These tests pin the fixes.
const catalog = {
  YARD:{yard:true,label:'YARD'}, BARRACKS:{factory:'InfantryType',label:'BARRACKS',cost:500}, ENG:{engineer:true,cost:500,label:'Soviet Engineer'},
  E2:{occupier:true,cost:100,weapon:{damage:15,range:4},label:'Conscript'},
  HUT:{bridgeRepairHut:true,label:'Bridge Repair Hut'}, FLAG:{label:'RA2 US Flag Left'}, LAMP:{label:'Invisible Yellow Light Post'}, PIPES:{label:'RA2 Stack O Pipes'},
  CAOILD:{label:'Tech Oil Derrick'}, EPOWER:{power:200,label:'Power Plant',cost:800}, PENTAGON:{label:'Pentagon',cost:0},
};
const unit = (id,name,type,x,y,extra={}) => ({ id,name,type,tile:{rx:x,ry:y},hitPoints:100,maxHitPoints:100,isIdle:true,primaryWeapon:catalog[name].weapon,...extra });
function world({ own, enemies = [], neutral = [], credits = 5000, tick = 3000, bridges = [], offers = {2:[{name:'ENG',type:3},{name:'E2',type:3}]} }) {
  const calls = [];
  const all = () => [...own, ...enemies, ...neutral];
  const api = {
    ObjectType:{Building:2,Vehicle:7,Infantry:3,Aircraft:1}, QueueType:{Structures:0,Armory:1,Infantry:2,Vehicles:3,Aircrafts:4,Ships:5}, OrderType:{Move:1,Attack:2,Capture:7,Occupy:8,Repair:9,DeploySelected:10,Stop:11}, LandType:{Clear:0}, ZoneType:{Air:1,Water:2},
    units:r=>r==='self'?own:r==='enemy'?enemies:r==='allied'?[]:[...enemies,...neutral], unit:id=>all().find(u=>u.id===id),
    me:()=>({credits,power:{total:500,drain:100},combatant:true,defeated:false,isObserver:false}), tick:()=>tick, time:()=>tick/15, players:()=>[],
    map:{size:()=>({width:80,height:80}),visible:()=>true,tile:(x,y)=>{const b=bridges.find(b=>b.x===x&&b.y===y);return {rx:x,ry:y,landType:0,...(b?{bridge:b.bridge}:{})};}}, canPlace:()=>true,
    production:{queues:()=>Array.from({length:6},(_,type)=>({type,size:0,maxSize:99,items:[]})),available:q=>q===undefined?Object.values(offers).flat():(offers[q]??[])},
    weaponVs:()=>undefined, inRange:()=>false, attack:(...a)=>calls.push(['attack',...a]), move:(...a)=>calls.push(['move',...a]), attackMove:(...a)=>calls.push(['attackMove',...a]), deploy:()=>true,
    order:(ids,o)=>{calls.push(['order',ids,o]);return true;}, produce:(...a)=>calls.push(['produce',...a]), gather(){}, repair(){},
    onTick(){}, offTick(){},
  };
  const memory = { frontiers:new Map(), enemyBuildings:new Map(), orders:new Map(), postureOrders:new Map(), specialOrders:new Map(), specialTargets:new Map(), plannedSites:new Map(), observedSpecial:new Map(), repairing:new Set(), lastMaintenance:tick, lastMicroReport:-1000 };
  return { api, memory, calls, setTick:t=>{tick=t;} };
}
const snapshotOf = (api) => collectState(api, catalog);

test('decorations are neither attacked nor captured; real tech buildings and objectives still are', () => {
  assert.equal(isDecoration(catalog.FLAG, 'CAUSFGL'), true);
  assert.equal(isDecoration(catalog.LAMP, 'INYELWLAMP'), true);
  assert.equal(isDecoration(catalog.PIPES, 'CAMISC05'), true);
  assert.equal(isDecoration(catalog.EPOWER, 'GAPOWR'), false);
  assert.equal(isDecoration(catalog.PENTAGON, 'CAPENT'), false, 'a campaign objective without cost is still a target');
  assert.equal(isCapturable(catalog.CAOILD, 'CAOILD'), true);
  assert.equal(isCapturable(catalog.PIPES, 'CAMISC05'), false);
  assert.equal(isCapturable({label:'House'}, 'CAHSE01'), false, 'plain civilian props are not engineer targets');
});

test('the engineer is not offered lamp posts or pipes; a real derrick next to them is', () => {
  const own=[unit(1,'YARD',2,10,10), unit(2,'BARRACKS',2,12,10), unit(20,'ENG',3,14,12)];
  const neutral=[unit(100,'LAMP',2,30,30), unit(101,'PIPES',2,31,30), unit(102,'CAOILD',2,34,30)];
  const w=world({ own, neutral });
  const groups={}; specialGroups(w.api, catalog, snapshotOf(w.api), w.memory, groups);
  const e=groups.engineering;
  assert.ok(e.actions.capture_102, 'the oil derrick is offered');
  assert.ok(!e.actions.capture_100 && !e.actions.capture_101, 'decorations are not');
  assert.deepEqual(w.memory.captureTargets, [102]);
});

test('an enemy flag is not an assault target and is not remembered as an enemy building', () => {
  const own=[unit(1,'YARD',2,10,10), ...Array.from({length:10},(_,i)=>unit(30+i,'E2',3,12+i,12))];
  const enemies=[unit(500,'FLAG',2,56,33), unit(501,'EPOWER',2,60,40)];
  const w=world({ own, enemies });
  const snapshot=snapshotOf(w.api);
  const groups=candidateGroups(w.api, catalog, snapshot, w.memory);
  const keys=Object.keys(groups.tactics?.criteria ?? {});
  assert.ok(!keys.includes('assault_500'), 'no assault on the flag');
  assert.ok(!w.memory.enemyBuildings.has(500)); assert.ok(w.memory.enemyBuildings.has(501));
});

test('an attack stuck for a long time makes bridge repair a priority with an automatic fallback, listed before captures', () => {
  const own=[unit(1,'YARD',2,10,10), unit(2,'BARRACKS',2,12,10), unit(20,'ENG',3,14,12)];
  const neutral=[{...unit(300,'HUT',2,20,20)}, unit(102,'CAOILD',2,34,30)];
  const enemies=[unit(501,'EPOWER',2,60,40)];
  const w=world({ own, neutral, enemies });
  w.memory.mission={type:'mission',mode:'attack',targetId:501,ids:[30],since:3000};
  // First look: the attack just started and no damage is visible, so no repair is offered (0.6.0:
  // "no known damage yet" sent engineers on empty trips).
  let groups={}; specialGroups(w.api, catalog, snapshotOf(w.api), w.memory, groups);
  assert.ok(!groups.engineering.actions.repair_300, 'no bridge repair without a reason');
  assert.ok(groups.engineering.actions.capture_102, 'captures are still offered');
  // Re-issuing the same target does not reset the stuck clock.
  w.memory.mission={...w.memory.mission,since:3000+ATTACK_STUCK_TICKS};
  w.setTick(3001+ATTACK_STUCK_TICKS);
  groups={}; specialGroups(w.api, catalog, snapshotOf(w.api), w.memory, groups);
  const e=groups.engineering;
  assert.match(e.criteria.repair_300, /^PRIORITY BRIDGE REPAIR \(our attack on Power Plant #501 has made no progress/);
  assert.match(e.criteria.repair_300, /destroyed bridge cuts the land route/);
  assert.equal(e.actions.repair_300.auto, 2);
  assert.equal(e.actions.repair_300.order.type, 9);
  const keys=Object.keys(e.criteria).filter(k=>k!=='wait');
  assert.ok(keys.indexOf('repair_300') < keys.indexOf('capture_102'), 'repair is listed before capture');
});

test('visible bridge damage alone is enough to make repair a priority', () => {
  const own=[unit(1,'YARD',2,10,10), unit(20,'ENG',3,14,12)];
  const bridges=[{x:40,y:40,bridge:{id:9,elevation:1,isLow:false,hitPoints:0,maxHitPoints:500}}, {x:41,y:40,bridge:{id:10,elevation:1,isLow:false,hitPoints:500,maxHitPoints:500}}];
  const w=world({ own, neutral:[unit(300,'HUT',2,20,20)], bridges });
  const groups={}; specialGroups(w.api, catalog, snapshotOf(w.api), w.memory, groups);
  assert.match(groups.engineering.criteria.repair_300, /PRIORITY BRIDGE REPAIR \(1 damaged bridge piece is visible\)/);
  assert.equal(groups.engineering.actions.repair_300.auto, 2);
});

test('with a stuck attack and no engineer, training one for the bridge is a priority with a fallback', () => {
  const own=[unit(1,'YARD',2,10,10), unit(2,'BARRACKS',2,12,10), unit(21,'E2',3,13,12)];
  const w=world({ own, neutral:[unit(300,'HUT',2,20,20)], enemies:[unit(501,'EPOWER',2,60,40)], credits:2500 });
  w.memory.mission={type:'mission',mode:'attack',targetId:501,ids:[21],since:0};
  w.memory.attackSince=new Map([[501,0]]);
  const groups={}; specialGroups(w.api, catalog, snapshotOf(w.api), w.memory, groups);
  assert.match(groups.infantry.criteria.produce_ENG, /^PRIORITY: train an engineer to repair the bridge/);
  assert.equal(groups.infantry.actions.produce_ENG.auto, 3);
});

test('an engineer refused by its capture target is recalled after a few tries and the target is never offered again', () => {
  const eng=unit(20,'ENG',3,14,12), target=unit(100,'CAOILD',2,30,30);
  const own=[unit(1,'YARD',2,10,10), eng];
  const w=world({ own, neutral:[target] });
  const action={ type:'special', kind:'capture', ids:[20], targetId:100, order:{ type:7, target:{ objectId:100 } } };
  rememberSpecial(w.memory, action, executeSpecial(w.api, action), 3000);
  const events=[];
  for (let i = 1; i <= CAPTURE_RESENDS + 1; i++) { w.setTick(3000 + i * 160); maintainSpecial(w.api, w.memory, e => events.push(e)); }
  assert.equal(w.memory.specialTasks.length, 0);
  assert.equal(events.at(-1).result, 'uncapturable');
  assert.ok(w.memory.uncapturable.has(100));
  const groups={}; specialGroups(w.api, catalog, snapshotOf(w.api), w.memory, groups);
  assert.ok(!groups.engineering?.actions?.capture_100, 'not offered again');
});
