import test from 'node:test';
import assert from 'node:assert/strict';
import { attachJevPlayer, maintainBattle, updateLedger, collectState, candidateGroups } from '../src/player/werhd-jev-player.mjs';
const require_player = () => ({ updateLedger });
const u = (id, name, type, x, y) => ({ id, name, type, tile: { rx: x, ry: y }, isIdle: true, hitPoints: 100, maxHitPoints: 100, primaryWeapon: {} });

// Fake game with a tick callback, as the public API provides. Timers are effectively disabled so
// only the tick wake-up can drive decisions, as happens in a hidden tab.
function game() {
  let tick = 100, handler;
  const calls = [];
  const self = { credits: 1000, defeated: false, isObserver: false, combatant: true, power: { total: 300, drain: 50 } };
  const own = [{ id: 1, name: 'YARD', type: 2, tile: { rx: 10, ry: 10 }, hitPoints: 100, maxHitPoints: 100 }, { id: 2, name: 'TANK', type: 7, tile: { rx: 12, ry: 12 }, primaryWeapon: { damage: 50, range: 5 }, isIdle: true, hitPoints: 100, maxHitPoints: 100, isDeployed: false }];
  // One visible enemy building and nothing producible: the tactics group always offers an assault.
  const enemies = [{ id: 900, name: 'PENTAGON', type: 2, tile: { rx: 20, ry: 20 }, hitPoints: 1000, maxHitPoints: 1000 }];
  const api = {
    ObjectType: { Building: 2, Infantry: 3, Vehicle: 7, Aircraft: 1 }, QueueType: { Structures: 0, Armory: 1, Infantry: 2, Vehicles: 3, Aircrafts: 4, Ships: 5 }, LandType: { Clear: 0 },
    me: () => self, units: r => r === 'enemy' ? enemies : r === 'self' ? own : [], tick: () => tick, time: () => tick / 15, players: () => [],
    production: { available: () => [], queues: () => Array.from({ length: 6 }, (_, type) => ({ type, size: 0, maxSize: 99, items: [] })) },
    map: { tile: (x, y) => ({ rx: x, ry: y, landType: 0 }), visible: () => true, size: () => ({ width: 30, height: 30 }) }, canPlace: () => true,
    weaponVs: () => undefined, inRange: () => false,
    onTick: h => { handler = h; calls.push(['onTick']); }, offTick: () => calls.push(['offTick']),
    produce: (...a) => calls.push(['produce', ...a]), attack: (...a) => calls.push(['attack', ...a]), move: (...a) => calls.push(['move', ...a]), attackMove: (...a) => calls.push(['attackMove', ...a]), deploy: () => true, gather() {}, repair() {},
  };
  return { api, calls, own, advance: n => { tick += n; }, fire: () => handler?.({ tick, time: tick / 15 }), hasHandler: () => !!handler };
}
const catalog = () => ({ TANK: { cost: 700, category: 'AFV', weapon: { damage: 50, range: 5, verses: [1,1,1,1,1,1] }, label: 'TANK' }, YARD: { yard: true, label: 'YARD' }, PENTAGON: { label: 'Pentagon' } });
const settle = () => new Promise(r => setTimeout(r, 5));

test('game ticks wake the decision loop when page timers are throttled, and stop releases the callback', async () => {
  const g = game();
  const requests = [];
  const player = await attachJevPlayer(g.api, {
    catalog: catalog(), intervalMs: 1e9, wakeIntervalMs: 0, disableMicro: true, maxDecisions: 50,
    requestDecision: async body => { requests.push(body); return { answers: Object.fromEntries(Object.keys(body.groups).map(id => [id, { type: 'choice', choice: 'wait', confidence: 1 }])) }; },
  });
  try {
    assert.equal(g.hasHandler(), true, 'the player registers the tick callback');
    await settle();
    assert.equal(requests.length, 1, 'the initial timer-driven decision asks about the visible enemy');
    assert.ok(requests[0].groups.tactics, 'the tactics group is part of the question');
    g.advance(20); g.fire(); await settle();
    assert.equal(requests.length, 2, 'a tick wakes one decision even without timers');
    g.fire(); g.fire(); await settle();
    assert.equal(requests.length, 2, 'the same tick never triggers a second question');
    g.advance(20); g.fire(); await settle();
    assert.equal(requests.length, 3);
    assert.equal(player.status.events.find(e => e.kind === 'start').tickDriven, true);
    assert.equal(player.status.failures, 0);
  } finally { player.stop('manual'); }
  assert.ok(g.calls.some(c => c[0] === 'offTick'), 'stopping unregisters the tick callback');
  g.advance(20); g.fire(); await settle();
  assert.equal(requests.length, 3, 'no decisions after stop');
});

test('without a tick callback the player still starts and reports timer-only operation', async () => {
  const g = game();
  delete g.api.onTick; delete g.api.offTick;
  const player = await attachJevPlayer(g.api, { catalog: catalog(), disableMicro: true, intervalMs: 1e9, requestDecision: async () => ({ answers: {} }) });
  try { assert.equal(player.status.events.find(e => e.kind === 'start').tickDriven, false); } finally { player.stop('manual'); }
});

test('ships engage enemies in range on their own, even under a strike order, and never join corridor clearing', () => {
  const weapon = { range: 8, damage: 100, rof: 40, ag: true, aa: false, verses: [1,1,1,1,1,1] };
  const catalog = { YARD:{yard:true,label:'YARD'}, REFINERY:{refinery:true,label:'REFINERY'}, SUB:{naval:true,cost:1000,weapon,label:'SUB'}, ENEMY_SHIP:{naval:true,weapon,label:'ENEMY_SHIP'}, TANK:{category:'AFV',cost:700,weapon:{...weapon,range:5},label:'TANK'} };
  const calls = [];
  const unit = (id, name, type, x, y, extra = {}) => ({ id, name, type, tile:{rx:x,ry:y}, isIdle:true, hitPoints:100, maxHitPoints:100, primaryWeapon:catalog[name].weapon, isDeployed:false, ...extra });
  const own = [unit(1,'YARD',2,10,10), unit(2,'REFINERY',2,14,10), unit(3,'SUB',7,40,40), unit(4,'TANK',7,15,11)];
  const enemies = [unit(100,'ENEMY_SHIP',7,44,42)];
  const find = id => [...own, ...enemies].find(u => u.id === id);
  const api = {
    ObjectType:{Building:2,Vehicle:7,Infantry:3}, QueueType:{Structures:0,Armory:1,Infantry:2,Vehicles:3,Aircrafts:4,Ships:5},
    units:r=>r==='self'?own:enemies, me:()=>({credits:5000}), tick:()=>3000,
    map:{size:()=>({width:80,height:80}),visible:()=>true,tile:(x,y)=>({rx:x,ry:y,landType:0})}, canPlace:()=>true,
    weaponVs:(a,b)=>{const u=find(a),t=find(b),w=catalog[u.name].weapon;const d=Math.hypot(u.tile.rx-t.tile.rx,u.tile.ry-t.tile.ry);return {distance:d,minRange:0,maxRange:w.range,inRange:d<=w.range};},
    inRange:(a,b)=>api.weaponVs(a,b).inRange,
    attack:(...a)=>calls.push(['attack',...a]), move:(...a)=>calls.push(['move',...a]), attackMove:(...a)=>calls.push(['attackMove',...a]), gather(){}, repair(){}, deploy(){return true;},
  };
  const memory = { orders:new Map(), postureOrders:new Map(), specialOrders:new Map([[3,{tick:2900,kind:'naval_attack'}]]), repairing:new Set(), lastMaintenance:-1000, lastMicroReport:-1000 };
  maintainBattle(api, catalog, memory, () => {});
  assert.ok(calls.some(c => c[0]==='attack' && c[1].includes(3) && c[2]===100), 'the submarine fires back at the ship in range despite a recent strike order');
  assert.ok(!calls.some(c => c[0]==='move' && c[1].includes(3)), 'ships are not moved out of factory corridors');
  assert.ok(!calls.some(c => c[0]==='attack' && c[1].includes(4)), 'a land unit out of range is not ordered to attack the ship');
});

test('the ledger counts own losses exactly and enemy kills only inside our vision; observations carry it', () => {
  const { updateLedger } = require_player();
  let own = [u(1,'YARD',2,5,5), u(2,'TANK',7,6,6)], enemies = [u(100,'TANK',7,20,20), u(101,'PENTAGON',2,40,40)];
  let tick = 100;
  const api = { ObjectType:{Building:2,Vehicle:7,Infantry:3}, tick:()=>tick, units:r=>r==='self'?own:enemies, map:{visible:(x,y)=>x<30} };
  const memory = {};
  let l = updateLedger(api, {}, memory);
  assert.deepEqual(l, { ownUnits:1, ownBuildings:1, enemyUnits:1, enemyBuildings:1, ownBuilt:0, ownUnitsLost:0, ownBuildingsLost:0, enemyUnitsDestroyed:0, enemyBuildingsDestroyed:0 }, 'the first observation seeds without counting');
  own = [...own, u(3,'TANK',7,7,7)]; enemies = [enemies[1]]; tick += 60;
  l = updateLedger(api, {}, memory);
  assert.equal(l.ownBuilt, 1); assert.equal(l.enemyUnitsDestroyed, 1, 'a tank that vanished from a visible tile counts as destroyed');
  own = [own[0], own[2]]; enemies = []; tick += 60;
  l = updateLedger(api, {}, memory);
  assert.equal(l.ownUnitsLost, 1); assert.equal(l.enemyBuildingsDestroyed, 0, 'a building last seen in fog is not claimed');
  tick += 4000; l = updateLedger(api, {}, memory);
  assert.equal(l.enemyBuildingsDestroyed, 0); assert.equal(memory.ledger.seenEnemy.size, 0, 'stale fog sightings are forgotten silently');
});

test('after three declined scouting questions with nothing in sight the army explores on its own', async () => {
  const g = game();
  g.api.units = r => r === 'self' ? g.own : [];
  g.api.map.visible = (x) => x < 15;
  const requests = [];
  const player = await attachJevPlayer(g.api, {
    catalog: catalog(), intervalMs: 1e9, wakeIntervalMs: 0, disableMicro: true, maxDecisions: 50,
    requestDecision: async body => { requests.push(body); return { answers: Object.fromEntries(Object.keys(body.groups).map(id => [id, { type: 'choice', choice: 'wait', confidence: 1 }])) }; },
  });
  try {
    await settle();
    assert.ok(requests[0].groups.scouting, 'scouting is offered with nothing in sight');
    g.advance(20); g.fire(); await settle(); g.advance(20); g.fire(); await settle();
    const auto = player.status.events.filter(e => e.kind === 'action' && e.auto);
    assert.equal(auto.length, 1, 'the third decline triggers one automatic exploration');
    assert.equal(auto[0].reason, 'auto_explore'); assert.equal(auto[0].accepted, true); assert.equal(auto[0].action.mode, 'explore');
    assert.ok(g.calls.some(c => c[0] === 'attackMove' || c[0] === 'move'), 'the scout actually moves');
    assert.equal(player.memory.mission?.mode, 'explore');
  } finally { player.stop('manual'); }
});

test('ships that can reach a base attacker join the defend mission', () => {
  const weapon = { range: 8, damage: 100, rof: 40, ag: true, aa: false, verses: [1,1,1,1,1,1] };
  const catalog = { YARD:{yard:true,label:'YARD'}, SUB:{naval:true,cost:1000,weapon,label:'SUB'}, ENEMY_SHIP:{naval:true,weapon,label:'ENEMY_SHIP'}, TANK:{category:'AFV',cost:700,weapon:{...weapon,range:5},label:'TANK'} };
  const unit = (id, name, type, x, y) => ({ id, name, type, tile:{rx:x,ry:y}, isIdle:true, hitPoints:100, maxHitPoints:100, primaryWeapon:catalog[name].weapon, isDeployed:false });
  const own = [unit(1,'YARD',2,10,10), unit(3,'SUB',7,18,14), unit(4,'TANK',7,12,11)];
  const enemies = [unit(100,'ENEMY_SHIP',7,16,12)];
  const find = id => [...own, ...enemies].find(u => u.id === id);
  const api = {
    ObjectType:{Building:2,Vehicle:7,Infantry:3,Aircraft:1}, QueueType:{Structures:0,Armory:1,Infantry:2,Vehicles:3,Aircrafts:4,Ships:5}, LandType:{Clear:0},
    units:r=>r==='self'?own:enemies, me:()=>({credits:5000,power:{total:300,drain:50}}), tick:()=>3000, time:()=>200,
    map:{size:()=>({width:80,height:80}),visible:()=>true,tile:(x,y)=>({rx:x,ry:y,landType:0})}, canPlace:()=>true,
    production:{queues:()=>Array.from({length:6},(_,type)=>({type,size:0,maxSize:99,items:[]})),available:()=>[]},
    weaponVs:(a,b)=>{const u=find(a),t=find(b),w=catalog[u.name].weapon;const d=Math.hypot(u.tile.rx-t.tile.rx,u.tile.ry-t.tile.ry);return {distance:d,minRange:0,maxRange:w.range,inRange:d<=w.range};},
    inRange:(a,b)=>api.weaponVs(a,b).inRange, attack(){}, move(){}, attackMove(){}, deploy(){return true;},
  };
  const memory = { frontiers:new Map(), enemyBuildings:new Map(), orders:new Map(), postureOrders:new Map(), specialOrders:new Map(), specialTargets:new Map(), plannedSites:new Map(), observedSpecial:new Map(), repairing:new Set(), lastMaintenance:3000, lastMicroReport:-1000 };
  const snap = collectState(api, catalog); const groups = candidateGroups(api, catalog, snap, memory);
  const defend = groups.tactics.actions.defend_base;
  assert.ok(defend, 'a ship near the base is a base threat');
  assert.ok(defend.ids.includes(3), 'the submarine is part of the defence');
  assert.ok(defend.ids.includes(4), 'the tank still is');
});
