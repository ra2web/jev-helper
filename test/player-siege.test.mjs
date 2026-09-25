import test from 'node:test';
import assert from 'node:assert/strict';
import { specialGroups, rememberSpecial, releaseGarrisons, maintainSpecial, SIEGE_RANGE, RELEASE_TICKS, REENTER_COOLDOWN, ENTRY_RESENDS } from '../src/player/werhd-jev-special.mjs';
import { collectState, candidateGroups, historyHints, rememberChoice, MIN_ATTACK_UNITS } from '../src/player/werhd-jev-player.mjs';

// From four real matches (0.5.6): a road with a pillbox on each side; infantry only ever entered
// houses at home, one pillbox was attacked over and over, survivors were fed in one at a time, and
// the "recent answers" hint never fired because a few enemies died each time.
const catalog = {
  YARD:{yard:true,label:'YARD'}, BARRACKS:{factory:'InfantryType',label:'BARRACKS',cost:500},
  E2:{occupier:true,cost:100,weapon:{damage:15,range:4},label:'Conscript'},
  PILL:{isBaseDefense:true,weapon:{damage:40,range:5},label:'Pill Box',cost:500}, HOUSE:{label:'House'}, EPOWER:{power:200,label:'Power Plant',cost:800},
  PATRIOT:{isBaseDefense:true,weapon:{damage:50,range:12,aa:true,ag:false},label:'Patriot Missile',cost:1000}, TANK:{cost:900,category:'AFV',weapon:{damage:60,range:5},label:'Rhino'},
};
const unit = (id,name,type,x,y,extra={}) => ({ id,name,type,tile:{rx:x,ry:y},hitPoints:100,maxHitPoints:100,isIdle:true,primaryWeapon:catalog[name].weapon,...extra });
const house = (id,x,y) => unit(id,'HOUSE',2,x,y,{garrison:{count:0,capacity:5,canOccupy:true}});
function world({ own, enemies = [], neutral = [], credits = 5000, tick = 5000, offers = {2:[{name:'E2',type:3}]} }) {
  const all = () => [...own, ...enemies, ...neutral];
  const api = {
    ObjectType:{Building:2,Vehicle:7,Infantry:3,Aircraft:1}, QueueType:{Structures:0,Armory:1,Infantry:2,Vehicles:3,Aircrafts:4,Ships:5}, OrderType:{Move:1,Attack:2,Capture:7,Occupy:8,Repair:9,DeploySelected:10,Stop:11}, LandType:{Clear:0}, ZoneType:{Air:1,Water:2},
    units:r=>r==='self'?own:r==='enemy'?enemies:r==='allied'?[]:[...enemies,...neutral], unit:id=>all().find(u=>u.id===id),
    me:()=>({credits,power:{total:500,drain:100},combatant:true,defeated:false,isObserver:false}), tick:()=>tick, time:()=>tick/15, players:()=>[],
    map:{size:()=>({width:120,height:120}),visible:()=>true,tile:(x,y)=>({rx:x,ry:y,landType:0})}, canPlace:()=>true,
    production:{queues:()=>Array.from({length:6},(_,type)=>({type,size:0,maxSize:99,items:[]})),available:q=>q===undefined?Object.values(offers).flat():(offers[q]??[])},
    weaponVs:()=>undefined, inRange:()=>false, attack(){}, move(){}, attackMove(){}, deploy:()=>true, order:()=>true, produce(){}, gather(){}, repair(){}, onTick(){}, offTick(){},
  };
  const memory = { frontiers:new Map(), enemyBuildings:new Map(), orders:new Map(), postureOrders:new Map(), specialOrders:new Map(), specialTargets:new Map(), plannedSites:new Map(), observedSpecial:new Map(), repairing:new Set(), lastMaintenance:tick, lastMicroReport:-1000 };
  return { api, memory };
}
const squad = (n, x = 60, y = 60) => Array.from({length:n}, (_, i) => unit(30 + i, 'E2', 3, x + (i % 4), y + Math.floor(i / 4)));
const road = () => ({ enemies:[unit(500,'PILL',2,70,50), unit(501,'PILL',2,80,50), unit(502,'EPOWER',2,90,20)], neutral:[house(600,70,56), house(601,80,56), house(602,12,12)] });

test('each pillbox on the road gets its own siege option from a building within reach', () => {
  const own=[unit(1,'YARD',2,10,10), unit(2,'BARRACKS',2,12,10), ...squad(6)];
  const { enemies, neutral } = road();
  const w=world({ own, enemies, neutral });
  const groups={}; specialGroups(w.api, catalog, collectState(w.api, catalog), w.memory, groups);
  const g=groups.garrison;
  assert.ok(g.actions.siege_600 && g.actions.siege_601, 'one siege option per pillbox, both sides of the road');
  assert.match(g.criteria.siege_600, /^SIEGE Pill Box #500 at \(70,50\): garrison 4 infantry into building #600 at \(70,56\), 6 tiles from it \(its weapon range 5\)/);
  assert.equal(g.actions.siege_600.order.type, 8); assert.equal(g.actions.siege_600.auto, undefined);
  assert.ok(6 <= SIEGE_RANGE);
  assert.ok(!g.actions.occupy_602, 'no home strongpoint without a threat and with only six infantry');
});

test('when attacks are failing, siege becomes a priority with an automatic fallback', () => {
  const own=[unit(1,'YARD',2,10,10), ...squad(6)];
  const w=world({ own, ...road() });
  const snapshot=collectState(w.api, catalog); snapshot.state.combatAssessment={level:1,staleAttack:false};
  const groups={}; specialGroups(w.api, catalog, snapshot, w.memory, groups);
  assert.match(groups.garrison.criteria.siege_600, /^PRIORITY SIEGE .*attacks in the open are failing/);
  assert.equal(groups.garrison.actions.siege_600.auto, 2);
});

test('home strongpoints are offered only while the base is under attack', () => {
  // 0.6.1: plenty of idle infantry is no reason on its own (automatic training keeps it high, and a
  // home house ended in an enter / leave loop).
  const plenty=world({ own:[unit(1,'YARD',2,10,10), ...squad(9, 14, 14)], neutral:[house(602,12,12)] });
  let groups={}; specialGroups(plenty.api, catalog, collectState(plenty.api, catalog), plenty.memory, groups);
  assert.ok(!groups.garrison?.actions?.occupy_602);
  const threatened=world({ own:[unit(1,'YARD',2,10,10), ...squad(4, 14, 14)], neutral:[house(602,12,12)] });
  const snapshot=collectState(threatened.api, catalog); snapshot.state.baseUnderAttack=true;
  groups={}; specialGroups(threatened.api, catalog, snapshot, threatened.memory, groups);
  assert.ok(groups.garrison.actions.occupy_602);
});

test('assault options list the headline targets plus every nearby defense, and a handful of units does not attack', () => {
  const own=[unit(1,'YARD',2,10,10), unit(2,'BARRACKS',2,12,10), ...squad(10)];
  const w=world({ own, enemies:[unit(502,'EPOWER',2,90,20), unit(503,'EPOWER',2,95,20), unit(500,'PILL',2,70,50), unit(501,'PILL',2,80,50)] });
  w.memory.forceProgress={count:10,tick:0};
  const snapshot=collectState(w.api, catalog); const groups=candidateGroups(w.api, catalog, snapshot, w.memory);
  assert.equal(snapshot.state.forceReadiness.ready, true);
  for (const id of [500, 501, 502, 503]) assert.ok(groups.tactics.actions[`assault_${id}`], `assault_${id}`);
  const few=world({ own:[unit(1,'YARD',2,10,10), unit(2,'BARRACKS',2,12,10), ...squad(MIN_ATTACK_UNITS - 1)], enemies:[unit(500,'PILL',2,70,50)] });
  few.memory.forceProgress={count:MIN_ATTACK_UNITS - 1,tick:0};
  const s2=collectState(few.api, catalog); const g2=candidateGroups(few.api, catalog, s2, few.memory);
  assert.equal(s2.state.forceReadiness.ready, false); assert.ok(!g2.tactics.actions.assault_500);
});

test('a repeated choice that loses more than it kills is marked stale even when it kills a few', () => {
  const memory={ ledger:{ownUnitsLost:0,ownBuildingsLost:0,enemyUnitsDestroyed:0,enemyBuildingsDestroyed:0} };
  for (let i = 0; i < 4; i++) { rememberChoice(memory, 'tactics', 'assault_1593', {accepted:true}, i * 100); memory.ledger.ownUnitsLost += 3; memory.ledger.enemyUnitsDestroyed += 1; }
  const groups={ tactics:{ instructions:'Choose.', criteria:{wait:'Wait', assault_1593:'Assault the yard', engage_visible:'Engage'}, actions:{wait:{}, assault_1593:{}, engage_visible:{}} } };
  const out=historyHints(groups, memory, {}, {level:0});
  assert.equal(out.tactics.stale, true); assert.equal(out.tactics.lostSince, 12); assert.equal(out.tactics.killedSince, 4);
  assert.match(groups.tactics.criteria.assault_1593, /^STALE ×4/);
  assert.match(groups.tactics.instructions, /we lost 12 and destroyed 4/);
});

test('after six losing repeats the choice is removed for a turn, whatever the model does with hints', () => {
  const memory={ ledger:{ownUnitsLost:0,ownBuildingsLost:0,enemyUnitsDestroyed:0,enemyBuildingsDestroyed:0} };
  for (let i = 0; i < 6; i++) { rememberChoice(memory, 'tactics', 'engage_visible', {accepted:true}, i * 100); memory.ledger.ownUnitsLost += 2; }
  const groups={ tactics:{ instructions:'Choose.', criteria:{wait:'Wait', assault_1593:'Assault', engage_visible:'Engage'}, actions:{wait:{}, assault_1593:{}, engage_visible:{}} } };
  const out=historyHints(groups, memory, {}, {level:0});
  assert.equal(out.tactics.removed, true); assert.ok(!groups.tactics.actions.engage_visible); assert.ok(groups.tactics.actions.assault_1593);
  const defend={ tactics:{ instructions:'Choose.', criteria:{wait:'Wait', defend_base:'Defend', engage_visible:'Engage'}, actions:{wait:{}, defend_base:{}, engage_visible:{}} } };
  const m2={ ledger:{ownUnitsLost:0,ownBuildingsLost:0,enemyUnitsDestroyed:0,enemyBuildingsDestroyed:0} };
  for (let i = 0; i < 6; i++) { rememberChoice(m2, 'tactics', 'defend_base', {accepted:true}, i * 100); m2.ledger.ownUnitsLost += 2; }
  historyHints(defend, m2, {}, {level:3}); assert.ok(defend.tactics.actions.defend_base, 'defending the base is never removed');
});

// Leaving buildings once the job is done: a small hand-driven world where time and units can change.
function exitWorld() {
  const state = { tick: 5000, own: [], enemies: [], orders: [] };
  const api = { ObjectType:{Building:2,Infantry:3}, OrderType:{Occupy:8,DeploySelected:10},
    tick:()=>state.tick, units:r=>r==='self'?state.own:r==='enemy'?state.enemies:[], unit:id=>[...state.own,...state.enemies].find(u=>u.id===id),
    order:(ids,o)=>{state.orders.push([ids,o]);return true;} };
  return { api, state, memory:{}, events:[], emit(e){ this.events.push(e); } };
}
const heldHouse = (id, x, y, count = 3) => ({ id, name:'HOUSE', type:2, tile:{rx:x,ry:y}, hitPoints:100, maxHitPoints:100, garrison:{count,capacity:5,canOccupy:false,unitIds:[1,2,3].slice(0,count)} });

test('a siege building is left once its pillbox is gone and nothing armed is close, and not before', () => {
  const w=exitWorld(), emit=w.emit.bind(w);
  const pill={id:500,name:'PILL',type:2,tile:{rx:70,ry:50},primaryWeapon:{maxRange:5}};
  w.state.enemies=[pill]; w.state.own=[heldHouse(600,70,56)];
  rememberSpecial(w.memory, {type:'special',kind:'garrison',ids:[30,31,32],targetId:600,purpose:'siege',defenseId:500}, {accepted:true}, 5000);
  assert.equal(w.memory.garrisons.get(600).purpose, 'siege');
  w.state.tick=6000; releaseGarrisons(w.api, w.memory, emit); assert.equal(w.state.orders.length, 0, 'pillbox still standing');
  w.state.enemies=[{id:700,name:'GI',type:3,tile:{rx:74,ry:58},primaryWeapon:{maxRange:4}}]; // pillbox destroyed, a rifleman nearby
  w.state.tick=6400; releaseGarrisons(w.api, w.memory, emit); assert.equal(w.state.orders.length, 0, 'never step out next to an armed enemy');
  w.state.enemies=[];
  w.state.tick=6500; releaseGarrisons(w.api, w.memory, emit); assert.equal(w.state.orders.length, 0, 'clear only just now');
  w.state.tick=6500+RELEASE_TICKS.siege; releaseGarrisons(w.api, w.memory, emit);
  assert.deepEqual(w.state.orders, [[[600],{type:10}]]);
  assert.ok(!w.memory.garrisons.has(600)); assert.equal(w.memory.evacuatedAt.get(600), 6500+RELEASE_TICKS.siege);
  assert.match(w.events.at(-1).description, /撤出建筑 #600（目标已清除），3 名步兵归队/);
});

test('forward and home strongpoints are left after longer quiet periods; an emptied building is forgotten', () => {
  const w=exitWorld(), emit=w.emit.bind(w);
  w.state.own=[heldHouse(601,80,56), heldHouse(602,12,12)];
  rememberSpecial(w.memory, {type:'special',kind:'garrison',ids:[30],targetId:601,purpose:'forward'}, {accepted:true}, 5000);
  rememberSpecial(w.memory, {type:'special',kind:'garrison',ids:[31],targetId:602,purpose:'base'}, {accepted:true}, 5000);
  releaseGarrisons(w.api, w.memory, emit);
  w.state.tick=5000+RELEASE_TICKS.forward; releaseGarrisons(w.api, w.memory, emit);
  assert.deepEqual(w.state.orders.map(o=>o[0][0]), [601], 'forward first');
  w.state.tick=5000+RELEASE_TICKS.base; releaseGarrisons(w.api, w.memory, emit);
  assert.deepEqual(w.state.orders.map(o=>o[0][0]), [601, 602]);
  rememberSpecial(w.memory, {type:'special',kind:'garrison',ids:[32],targetId:603,purpose:'base'}, {accepted:true}, w.state.tick);
  releaseGarrisons(w.api, w.memory, emit); assert.ok(!w.memory.garrisons.has(603), 'not ours or empty: forgotten');
});

test('a building just left is not offered again until the cooldown passes', () => {
  const own=[unit(1,'YARD',2,10,10), ...squad(6)];
  const w=world({ own, ...road() });
  w.memory.evacuatedAt=new Map([[600, 5000]]);
  let groups={}; specialGroups(w.api, catalog, collectState(w.api, catalog), w.memory, groups);
  assert.ok(!groups.garrison.actions.siege_600, 'cooling down'); assert.ok(groups.garrison.actions.siege_601);
  assert.equal(groups.garrison.actions.siege_601.purpose, 'siege'); assert.equal(groups.garrison.actions.siege_601.defenseId, 501);
  const later=world({ own, ...road(), tick:5000+REENTER_COOLDOWN });
  later.memory.evacuatedAt=new Map([[600, 5000]]);
  groups={}; specialGroups(later.api, catalog, collectState(later.api, catalog), later.memory, groups);
  assert.ok(groups.garrison.actions.siege_600);
});

test('an anti-air site is not a siege target; a long deadlock makes siege automatic', () => {
  const own=[unit(1,'YARD',2,10,10), ...squad(6)];
  const w=world({ own, enemies:[unit(510,'PATRIOT',2,70,50), unit(500,'PILL',2,80,50)], neutral:[house(600,70,56), house(601,80,56)] });
  const snapshot=collectState(w.api, catalog); snapshot.state.forceReadiness={ready:false,stalledTicks:3000};
  const groups={}; specialGroups(w.api, catalog, snapshot, w.memory, groups);
  assert.ok(!groups.garrison.actions.siege_600, 'the Patriot next to house 600 only shoots aircraft');
  assert.ok(groups.garrison.actions.siege_601);
  assert.equal(groups.garrison.actions.siege_601.auto, 2);
  assert.match(groups.garrison.criteria.siege_601, /the army has not been able to attack for a long time/);
});

test('without vehicle production, infantry is the army: no support caps, and piled-up money trains it automatically', () => {
  // The 0.5.8 deadlock: four conscripts, a barracks, 57,000 credits, no war factory, and no training offered for 65 minutes.
  const own=[unit(1,'YARD',2,10,10), unit(2,'BARRACKS',2,12,10), ...squad(4, 14, 14)];
  const w=world({ own, credits:57000 });
  const snapshot=collectState(w.api, catalog); const groups=candidateGroups(w.api, catalog, snapshot, w.memory);
  assert.equal(snapshot.state.infantryRoles.infantryArmy, true);
  assert.ok(groups.infantry.actions.produce_E2, 'conscripts are still offered past three of a role');
  assert.equal(groups.infantry.actions.produce_E2.auto, 2);
  // With a vehicle factory, infantry stays a capped support role and nothing is automatic.
  const tanks=world({ own:[unit(1,'YARD',2,10,10), unit(2,'BARRACKS',2,12,10), ...squad(4, 14, 14)], credits:57000, offers:{2:[{name:'E2',type:3}],3:[{name:'TANK',type:7}]} });
  const s2=collectState(tanks.api, catalog); const g2=candidateGroups(tanks.api, catalog, s2, tanks.memory);
  assert.equal(s2.state.infantryRoles.infantryArmy, false);
  assert.ok(!g2.infantry?.actions?.produce_E2, 'three anti-infantry supports already in a tank army');
});

test('a pillbox our infantry just backed away from gets its siege first, as a priority that runs after one wait', () => {
  const own=[unit(1,'YARD',2,10,10), ...squad(6)];
  const w=world({ own, ...road() });
  w.memory.siegeWanted=new Map([[501, 4990]]);
  const groups={}; specialGroups(w.api, catalog, collectState(w.api, catalog), w.memory, groups);
  const g=groups.garrison, keys=Object.keys(g.criteria).filter(k=>k.startsWith('siege_'));
  assert.equal(keys[0], 'siege_601', 'the pillbox that outranged us comes first');
  assert.match(g.criteria.siege_601, /^PRIORITY SIEGE Pill Box #501 .*it is outranging our infantry right now/);
  assert.equal(g.actions.siege_601.auto, 1);
  assert.equal(g.actions.siege_600.auto, undefined, 'the other pillbox is not urgent');
});

test('infantry that cannot get into a building stops trying after a few re-sends', () => {
  const soldiers=[unit(30,'E2',3,20,20), unit(31,'E2',3,21,20)];
  const target=house(600,24,20);
  const w=world({ own:[unit(1,'YARD',2,10,10), ...soldiers], neutral:[target] });
  const events=[];
  rememberSpecial(w.memory, {type:'special',kind:'garrison',ids:[30,31],targetId:600,order:{type:8,target:{objectId:600}},purpose:'base'}, {accepted:true}, 5000);
  let t=5000;
  for (let i=0;i<=ENTRY_RESENDS+1;i++) { t+=130; w.api.tick=()=>t; maintainSpecial(w.api, w.memory, e=>events.push(e)); }
  assert.equal(w.memory.specialTasks.length, 0);
  assert.equal(events.at(-1).result, 'refused');
  assert.equal(events.filter(e=>/重新进入/.test(e.description ?? '')).length, ENTRY_RESENDS);
});
