import test from 'node:test';
import assert from 'node:assert/strict';
import { attachJevPlayer, collectState, candidateGroups, executeCandidate, forceReadiness, acceptMission, missionGate, respondToThreats, maintainBattle,
  MISSION_LOCK_TICKS, THREAT_REPLY_TICKS, DEFENSE_RUSH_SQUAD, THREAT_UNITS_PER_PASS, THREAT_CANDIDATES, THREAT_REPORT_TICKS, FALL_BACK_TICKS, MAX_ASSAULTS, MAX_ASSAULTS_WITH_OBJECTIVE, ENGAGE_RADIUS } from '../src/player/werhd-jev-player.mjs';
import { objectiveKeywords, parseObjective, matchesObjective, trackObjective } from '../src/player/werhd-jev-objective.mjs';

// From two 0.5.9 reports (local Laya model): the player set "摧毁五角大楼" as the match objective, but
// the Pentagon never appeared among the options (three Patriot sites took the defense slots), the
// army marched back and forth between targets and ended up rallying at home 53 times, and infantry
// stood still while a pillbox out of their reach shot them.
const weapon = (range, damage, { aa = false, ag = true, verses = [1, 1, 1, 1, 1, 1, 1] } = {}) => ({ range, damage, rof: 40, aa, ag, verses });
const catalog = {
  YARD:{yard:true,label:'Construction Yard'}, BARRACKS:{factory:'InfantryType',label:'Barracks',cost:500}, FACTORY:{factory:'UnitType',label:'War Factory'},
  GI:{category:'Soldier',cost:200,speed:8,armor:'none',weapon:weapon(4,15,{verses:[1,1,1,1,1,0,0.5]}),label:'Conscript'},
  EGI:{category:'Soldier',armor:'none',weapon:weapon(4,15),label:'GI'},
  SNIPE:{category:'Soldier',armor:'none',weapon:weapon(6,15),label:'Sniper'},
  TANK:{category:'AFV',cost:700,armor:'heavy',weapon:weapon(6,60),label:'Rhino Tank'},
  PENTAGON:{label:'Pentagon',armor:'concrete'}, POWER:{power:200,label:'Power Plant',armor:'concrete'},
  EBARR:{factory:'InfantryType',label:'Allied Barracks',armor:'concrete'}, EREF:{refinery:true,label:'Ore Refinery',armor:'concrete'},
  PATRIOT:{isBaseDefense:true,label:'Patriot Missile',armor:'concrete',weapon:weapon(8,50,{aa:true,ag:false})},
  PILL:{isBaseDefense:true,label:'Pill Box',armor:'concrete',weapon:weapon(5.5,40)},
  SENTRY:{isBaseDefense:true,label:'Sentry Gun',cost:500,weapon:weapon(5,20)},
};
const unit = (id, name, type, x, y, extra = {}) => ({ id, name, type, tile:{rx:x,ry:y}, hitPoints:100, maxHitPoints:100, isIdle:true, primaryWeapon:catalog[name].weapon, canDeploy:false, isDeployed:false, ...extra });
function world({ own, enemies = [], neutral = [], credits = 25000, tick = 3000, offers = {2:[{name:'GI',type:3}]}, queues = [], visible = () => true }) {
  const calls = [];
  const api = {
    ObjectType:{Building:2,Vehicle:7,Infantry:3,Aircraft:1}, QueueType:{Structures:0,Armory:1,Infantry:2,Vehicles:3,Aircrafts:4,Ships:5},
    OrderType:{Move:1,Attack:2,Capture:7,Occupy:8,Repair:9,DeploySelected:10,Stop:11}, LandType:{Clear:0}, ZoneType:{Air:1,Water:2},
    ArmorType:{0:'None',3:'Light',5:'Heavy',6:'Concrete',None:0,Light:3,Heavy:5,Concrete:6},
    units:r=>r==='self'?own:r==='enemy'?enemies:r==='allied'?[]:[...enemies,...neutral], unit:id=>[...own,...enemies,...neutral].find(u=>u.id===id),
    me:()=>({credits,power:{total:500,drain:100},combatant:true,defeated:false,isObserver:false}), tick:()=>tick, time:()=>tick/15, players:()=>[],
    map:{size:()=>({width:100,height:100}),visible:(x,y)=>visible(x,y),tile:(x,y)=>({rx:x,ry:y,landType:0})}, canPlace:()=>true,
    production:{queues:()=>Array.from({length:6},(_,type)=>({type,size:queues.filter(q=>q.type===type).length,maxSize:99,items:queues.filter(q=>q.type===type)})),
      available:q=>q===undefined?Object.values(offers).flat():(offers[q]??[])},
    weaponVs:()=>undefined, inRange:()=>false, // Like the game: a unit given an order is no longer idle.
    attack:(...a)=>{calls.push(['attack',...a]);for(const u of own)if(a[0].includes(u.id))u.isIdle=false;}, move:(...a)=>calls.push(['move',...a]), attackMove:(...a)=>{calls.push(['attackMove',...a]);for(const u of own)if(a[0].includes(u.id))u.isIdle=false;}, deploy:()=>true,
    order:(ids,o)=>{calls.push(['order',ids,o]);return true;}, produce:(...a)=>calls.push(['produce',...a]), gather(){}, repair(){},
    onTick:h=>{api._tick=h;}, offTick(){},
  };
  const memory = { frontiers:new Map(), enemyBuildings:new Map(), orders:new Map(), postureOrders:new Map(), specialOrders:new Map(), specialTargets:new Map(), plannedSites:new Map(), observedSpecial:new Map(), repairing:new Set(), lastMaintenance:tick, lastMicroReport:-1000 };
  return { api, memory, calls, setTick:t=>{tick=t;}, own, enemies };
}
const home = () => [unit(1,'YARD',2,10,10), unit(2,'BARRACKS',2,12,10)];
const squad = (n, x = 40, y = 40, name = 'GI') => Array.from({length:n}, (_, i) => unit(10 + i, name, name === 'TANK' ? 7 : 3, x + (i % 4), y + Math.floor(i / 4)));
const enemyBase = () => [unit(801,'EBARR',2,62,60), unit(802,'EREF',2,64,60), unit(803,'POWER',2,60,60),
  unit(910,'PATRIOT',2,50,44), unit(911,'PATRIOT',2,52,44), unit(912,'PATRIOT',2,54,44), unit(920,'PILL',2,59,47), unit(990,'PENTAGON',2,58,45)];
const choices = (g) => Object.keys(g.criteria).filter(k => k !== 'wait');

test('"摧毁五角大楼" becomes the first tactics option; Patriot sites are not assault targets, the pillbox is', () => {
  const w = world({ own:[...home(), ...squad(12)], enemies:enemyBase() });
  w.memory.objective = '摧毁五角大楼';
  const snap = collectState(w.api, catalog), groups = candidateGroups(w.api, catalog, snap, w.memory);
  const t = groups.tactics, keys = choices(t);
  assert.equal(keys[0], 'objective_990', 'the objective is listed first');
  assert.equal(t.actions.objective_990.auto, 2);
  assert.equal(t.actions.objective_990.targetId, 990); assert.equal(t.actions.objective_990.objective, true);
  assert.equal(t.criteria.objective_990, 'OBJECTIVE: destroy Pentagon #990 at (58,45) with 11 units.', 'short enough for a 48-token option');
  assert.match(t.instructions, /^MISSION OBJECTIVE: 摧毁五角大楼 Target: Pentagon #990 at \(58,45\)\. Force READY/);
  assert.ok(t.actions.assault_920, 'the pillbox shoots ground troops and is offered');
  for (const id of [910, 911, 912]) assert.ok(!t.actions[`assault_${id}`], `Patriot #${id} only shoots aircraft`);
  assert.ok(!t.actions.assault_990, 'the objective is not duplicated as an assault');
  const assaults = keys.filter(k => k.startsWith('assault_'));
  assert.ok(assaults.length <= MAX_ASSAULTS); assert.deepEqual(assaults, ['assault_801', 'assault_802', 'assault_803', 'assault_920'], 'factory, refinery, power, then the defense');
  assert.deepEqual({ id:snap.state.objectiveTarget.id, label:snap.state.objectiveTarget.label, visible:snap.state.objectiveTarget.visible }, { id:990, label:'Pentagon', visible:true });
});

test('the objective is offered whatever the force size, and a threatened base is defended first', () => {
  const few = world({ own:[...home(), ...squad(3)], enemies:enemyBase() });
  few.memory.objective = '摧毁五角大楼';
  let groups = candidateGroups(few.api, catalog, collectState(few.api, catalog), few.memory);
  assert.ok(groups.tactics.actions.objective_990, 'two free soldiers still get the objective option');
  assert.ok(!choices(groups.tactics).some(k => k.startsWith('assault_')), 'but no ordinary assault');
  const raided = world({ own:[...home(), ...squad(12)], enemies:[...enemyBase(), unit(700,'TANK',7,14,14)] });
  raided.memory.objective = '摧毁五角大楼';
  groups = candidateGroups(raided.api, catalog, collectState(raided.api, catalog), raided.memory);
  assert.deepEqual(choices(groups.tactics).slice(0, 2), ['defend_base', 'objective_990']);
  assert.equal(groups.tactics.actions.objective_990.auto, undefined, 'not automatic while the base is under attack');
});

test('an English objective matches too; the target is remembered in the fog and dropped once destroyed', () => {
  let fog = false;
  const enemies = enemyBase();
  const w = world({ own:[...home(), ...squad(12)], enemies, visible:(x,y)=>!(fog && x===58 && y===45) });
  w.memory.objective = 'destroy the Pentagon';
  let groups = candidateGroups(w.api, catalog, collectState(w.api, catalog), w.memory);
  assert.ok(groups.tactics.actions.objective_990);
  // Out of sight: the remembered position is used.
  enemies.splice(enemies.findIndex(e => e.id === 990), 1); fog = true;
  const snap = collectState(w.api, catalog);
  groups = candidateGroups(w.api, catalog, snap, w.memory);
  assert.equal(groups.tactics.criteria.objective_990, 'OBJECTIVE: destroy Pentagon #990 last seen at (58,45) with 11 units.');
  assert.equal(snap.state.objectiveTarget.visible, false);
  const execution = executeCandidate(w.api, groups.tactics.actions.objective_990, catalog);
  assert.equal(execution.accepted, true);
  assert.deepEqual(w.calls.at(-1).slice(0, 1).concat(w.calls.at(-1).slice(2)), ['attackMove', 58, 45], 'attack-move to the remembered position');
  // Its tile is in sight again and it is gone: destroyed, the option disappears.
  fog = false;
  const after = collectState(w.api, catalog);
  groups = candidateGroups(w.api, catalog, after, w.memory);
  assert.ok(!choices(groups.tactics).some(k => k.startsWith('objective_')));
  assert.equal(after.state.objectiveTarget.done, true);
  assert.match(groups.tactics.instructions, /Target Pentagon destroyed/);
});

test('protect / capture objectives never become attack orders; an unseen objective keeps scouting going', () => {
  assert.deepEqual(objectiveKeywords('保护五角大楼'), []);
  assert.deepEqual(objectiveKeywords('capture the Pentagon'), []);
  assert.deepEqual(objectiveKeywords('摧毁五角大楼'), ['pentagon', 'wash pent']);
  const guard = world({ own:[...home(), ...squad(12)], enemies:enemyBase() });
  guard.memory.objective = '保护五角大楼';
  assert.equal(trackObjective(guard.api, catalog, guard.memory), undefined);
  // Enemy buildings are known and the force is ready, but the Pentagon has never been seen.
  const search = world({ own:[...home(), ...squad(12)], enemies:[unit(803,'POWER',2,60,60)], visible:(x)=>x<70 });
  search.memory.objective = '摧毁五角大楼';
  const snap = collectState(search.api, catalog), groups = candidateGroups(search.api, catalog, snap, search.memory);
  assert.equal(snap.state.forceReadiness.ready, true);
  assert.equal(snap.state.objectiveTarget.found, false); assert.deepEqual(snap.state.objectiveTarget.keywords, ['pentagon', 'wash pent']);
  assert.ok(Array.isArray(snap.state.objectiveTarget.seen), 'visible building names are listed for diagnosis');
  assert.match(groups.scouting.instructions, /^SEARCHING FOR THE OBJECTIVE \(pentagon \/ wash pent\)/);
  assert.ok(choices(groups.scouting).length && choices(groups.scouting).every(k => /^Find the objective: /.test(groups.scouting.criteria[k])));
});

test('a sentry gun in the defense queue does not count as vehicle production', () => {
  const w = world({ own:[...home(), ...squad(8)], offers:{2:[{name:'GI',type:3}]}, queues:[{type:1,name:'SENTRY',quantity:1,creditsEach:500,creditsSpent:0}] });
  const snap = collectState(w.api, catalog);
  let r = forceReadiness(w.api, catalog, snap.state, snap.raw.army, [], w.memory);
  assert.equal(r.canBuildVehicles, false); assert.equal(r.ready, true, 'eight soldiers are the army');
  const tank = world({ own:[...home(), ...squad(8)], offers:{}, queues:[{type:3,name:'TANK',quantity:1,creditsEach:700,creditsSpent:0}] });
  const s2 = collectState(tank.api, catalog);
  r = forceReadiness(tank.api, catalog, s2.state, s2.raw.army, [], tank.memory);
  assert.equal(r.canBuildVehicles, true, 'a tank being built still counts');
});

test('after a failed attack the higher threshold drives automatic training', () => {
  const w = world({ own:[...home(), ...squad(8, 14, 14)] });
  w.memory.escalation = { level:1, changedAt:2900, reason:'test' };
  const snap = collectState(w.api, catalog), groups = candidateGroups(w.api, catalog, snap, w.memory);
  assert.equal(snap.state.forceReadiness.threshold, 12); assert.equal(snap.state.forceReadiness.ready, false);
  assert.equal(groups.infantry.actions.produce_GI.auto, 2, '8 of 12 with 25,000 credits: training is not optional');
  // 0.7.1: with 25,000 credits unspent training is forced even at the normal threshold, so the calm
  // case is checked with ordinary money.
  const calm = world({ own:[...home(), ...squad(8, 14, 14)], credits:3500 });
  const g2 = candidateGroups(calm.api, catalog, collectState(calm.api, catalog), calm.memory);
  assert.equal(g2.infantry.actions.produce_GI?.auto, undefined, 'at the normal threshold of 8 nothing is forced');
});

test('once ready, the force stays ready around the threshold and only drops below 75%', () => {
  const w = world({ own:home(), offers:{3:[{name:'TANK',type:7}]} });
  const state = { queues:[], airThreatCount:0, mobileAntiAirCount:0 };
  const at = (n) => { const tanks = squad(n, 30, 30, 'TANK'); return forceReadiness(w.api, catalog, state, tanks, tanks, w.memory); };
  assert.equal(at(7).ready, false);
  assert.equal(at(8).ready, true);
  for (const n of [7, 9, 7, 8, 6]) assert.equal(at(n).ready, true, `${n} tanks stay ready`);
  assert.match(at(7).reason, /still above 75% of the threshold/);
  assert.equal(at(5).ready, false, 'below 6 of 8 the force regroups');
  assert.equal(at(7).ready, false, 'and must reach the full threshold again');
  assert.equal(at(8).ready, true);
  w.memory.escalation = { level:1, changedAt:2900 };
  assert.equal(at(9).ready, false, 'a failed attack raises the bar and clears the latch');
});

test('mission clock and lock: same target keeps its clock; another attack is refused for a while', () => {
  let tick = 1000, enemies = [unit(801,'EBARR',2,62,60), unit(802,'EREF',2,64,60)];
  const api = { tick:()=>tick, units:r=>r==='self'?[]:enemies, map:{visible:()=>true} };
  const memory = {};
  const A = { type:'mission', mode:'attack', ids:[10,11], targetId:801, x:62, y:60 };
  const B = { ...A, targetId:802, x:64, y:60 };
  acceptMission(memory, A, { ids:[10,11] }, tick);
  tick = 1500; acceptMission(memory, A, { ids:[10] }, tick);
  assert.equal(memory.mission.since, 1000, 're-issuing the same target keeps the stall clock');
  assert.equal(memory.mission.issuedAt, 1500);
  tick = 1036;
  memory.missionLock.tick = 1000;
  assert.equal(missionGate(api, memory, B)?.reason, 'mission_locked');
  assert.equal(missionGate(api, memory, { ...B, mode:'rally', targetId:undefined, x:20, y:20 })?.reason, 'mission_locked', 'no turning back home either');
  assert.equal(missionGate(api, memory, A), undefined, 'the same target is fine');
  assert.equal(missionGate(api, memory, { ...B, mode:'defend' }), undefined, 'base defense breaks the lock');
  assert.equal(missionGate(api, memory, { ...B, objective:true }), undefined, 'the player objective breaks the lock');
  assert.equal(missionGate(api, memory, { ...B, mode:'retreat' }), undefined, 'retreat is always allowed');
  tick = 1000 + MISSION_LOCK_TICKS; assert.equal(missionGate(api, memory, B), undefined, 'the lock expires');
  tick = 1100; enemies = enemies.filter(e => e.id !== 801); assert.equal(missionGate(api, memory, B), undefined, 'a destroyed target releases the lock');
  tick = 1600; acceptMission(memory, B, { ids:[10] }, tick);
  assert.equal(memory.mission.since, 1600, 'a new target restarts the clock'); assert.equal(memory.missionLock.targetId, 802);
});

test('in the decision loop, alternating attack targets only executes the first one; the objective runs after two waits', async () => {
  const w = world({ own:[...home(), ...squad(12)], enemies:[unit(801,'EBARR',2,62,60), unit(802,'EREF',2,64,60)], offers:{} });
  const script = ['assault_801', 'assault_802', 'assault_801', 'assault_802'];
  let turn = 0;
  const player = await attachJevPlayer(w.api, { catalog, intervalMs:1e9, wakeIntervalMs:0, disableMicro:true, maxDecisions:50,
    requestDecision:async body => ({ answers:Object.fromEntries(Object.keys(body.groups).map(id => [id, { choice:id === 'tactics' ? script[turn] ?? 'wait' : 'wait', confidence:1 }])) }) });
  try {
    await new Promise(r => setTimeout(r, 5));
    for (turn = 1; turn < script.length; turn++) { w.setTick(3000 + turn * 36); w.api._tick({}); await new Promise(r => setTimeout(r, 5)); }
    const attacks = w.calls.filter(c => c[0] === 'attack');
    assert.deepEqual(attacks.map(c => c[2]), [801], 'the column is not turned round');
    const tactics = player.status.events.filter(e => e.kind === 'action' && e.question === 'tactics');
    assert.deepEqual(tactics.map(e => e.reason ?? 'executed'), ['executed', 'mission_locked', 'mission_continues', 'mission_locked']);
    assert.match(player.memory.recent.tactics.map(r => r.reason).join(','), /mission_locked/, 'the model sees why');
  } finally { player.stop('manual'); }
  // With an objective on offer, two turns of "wait" (or of going home to gather) execute it anyway.
  const o = world({ own:[...home(), ...squad(12)], enemies:enemyBase(), offers:{} });
  const p2 = await attachJevPlayer(o.api, { catalog, objective:'摧毁五角大楼', intervalMs:1e9, wakeIntervalMs:0, disableMicro:true, maxDecisions:50,
    requestDecision:async body => ({ answers:Object.fromEntries(Object.keys(body.groups).map(id => [id, { choice:'wait', confidence:1 }])) }) });
  try {
    await new Promise(r => setTimeout(r, 5));
    o.setTick(3036); o.api._tick({}); await new Promise(r => setTimeout(r, 5));
    const auto = p2.status.events.filter(e => e.kind === 'action' && e.auto && e.question === 'tactics');
    assert.equal(auto.length, 1); assert.equal(auto[0].choice, 'objective_990'); assert.equal(auto[0].reason, 'auto_tactics');
    assert.ok(o.calls.some(c => c[0] === 'attack' && c[2] === 990), 'the army is sent at the Pentagon');
    assert.equal(p2.memory.mission.targetId, 990);
  } finally { p2.stop('manual'); }
});

test('a unit shot from beyond its reach closes in with its neighbours, or falls back when it cannot hurt the shooter', () => {
  // Two conscripts (range 4) under a pillbox (range 5.5): charging only feeds it (0.6.0 match), so
  // they step out of reach and the pillbox is marked for a siege from cover.
  const pill = unit(920,'PILL',2,55,50);
  const conscript = unit(30,'GI',3,50,50,{isIdle:false}), buddy = unit(31,'GI',3,47,50,{isIdle:false});
  const w = world({ own:[...home(), conscript, buddy], enemies:[pill, unit(700,'EGI',3,46,53)] });
  w.memory.orders = new Map([[30, { tick:2990, targetId:700 }]]);
  const events = [];
  respondToThreats(w.api, catalog, w.memory, e => events.push(e), [conscript, buddy], w.enemies);
  assert.deepEqual(w.calls.map(c => c[0]), ['move'], 'no charge at the pillbox with two soldiers');
  assert.ok(w.memory.siegeWanted.has(920), 'the pillbox is marked for a siege');
  assert.match(events[0].description, /^射程外受击：#30 避开 Pill Box #920，后撤到/);
  w.setTick(3000 + THREAT_REPLY_TICKS - 1);
  respondToThreats(w.api, catalog, w.memory, e => events.push(e), [conscript, buddy], w.enemies);
  assert.equal(w.calls.length, 1, 'no new order during the cooldown');
  // A crowd of eight or more rushes it and wins by numbers.
  const crowd = Array.from({ length:DEFENSE_RUSH_SQUAD }, (_, i) => unit(60 + i,'GI',3,50,48 + i * 0.5,{isIdle:false}));
  const c = world({ own:[...home(), ...crowd], enemies:[unit(920,'PILL',2,55,50)] });
  respondToThreats(c.api, catalog, c.memory, e => events.push(e), crowd, c.enemies);
  assert.equal(c.calls[0][0], 'attack'); assert.equal(c.calls[0][2], 920); assert.ok(c.calls[0][1].length >= DEFENSE_RUSH_SQUAD);
  // A conscript cannot hurt a tank: it steps out of the tank's range instead.
  const lone = unit(40,'GI',3,20,30), tank = unit(701,'TANK',7,25,30);
  const t = world({ own:[...home(), lone], enemies:[tank] });
  respondToThreats(t.api, catalog, t.memory, e => events.push(e), [lone], [tank]);
  assert.deepEqual(t.calls, [['move', [40], 16, 30]], 'back to 9 tiles from a range-6 tank');
  assert.match(events.at(-1).description, /#40 避开 Rhino Tank #701，后撤到 \(16,30\)/);
  // Wired into the regular micro loop: an enemy soldier that outranges ours is still fought.
  const m = world({ own:[...home(), unit(30,'GI',3,50,50,{isIdle:false})], enemies:[unit(700,'SNIPE',3,55,50)] });
  const micro = [];
  maintainBattle(m.api, catalog, m.memory, e => micro.push(e));
  assert.ok(m.calls.some(c => c[0] === 'attack' && c[2] === 700)); assert.ok(micro.some(e => e.reply === 'close_in'));
});

test('engage_visible only offers enemies near the troops and says where they are', () => {
  const far = world({ own:[...home(), ...squad(12)], enemies:[unit(700,'EGI',3,62,40)] });
  let groups = candidateGroups(far.api, catalog, collectState(far.api, catalog), far.memory);
  assert.ok(!groups.tactics.actions.engage_visible, `more than ${ENGAGE_RADIUS} tiles away`);
  const near = world({ own:[...home(), ...squad(12)], enemies:[unit(700,'EGI',3,50,40)] });
  groups = candidateGroups(near.api, catalog, collectState(near.api, catalog), near.memory);
  assert.equal(groups.tactics.actions.engage_visible.targetId, 700);
  assert.match(groups.tactics.criteria.engage_visible, /^Engage GI #700 at \(50,40\), 8 tiles from our 11 troops/);
});

test('the defense question is asked only while the base is threatened', () => {
  const calm = world({ own:[...home(), ...squad(4, 14, 14)], offers:{1:[{name:'SENTRY',type:2}],2:[{name:'GI',type:3}]} });
  let groups = candidateGroups(calm.api, catalog, collectState(calm.api, catalog), calm.memory);
  assert.equal(groups.defenses, undefined);
  const raided = world({ own:[...home(), ...squad(4, 14, 14)], enemies:[unit(700,'TANK',7,18,18)], offers:{1:[{name:'SENTRY',type:2}],2:[{name:'GI',type:3}]} });
  groups = candidateGroups(raided.api, catalog, collectState(raided.api, catalog), raided.memory);
  assert.ok(groups.defenses, 'under attack the question is back');
});

// Review of 0.6.0 (same day): the objective option itself became a way of feeding units in, anti-air
// sites left nothing to attack at the end, and a few loose ends around the lock, parsing and speed.
const decide = async (w, options, pick, turns) => {
  const p = await attachJevPlayer(w.api, { catalog, intervalMs:1e9, wakeIntervalMs:0, disableMicro:true, maxDecisions:50, ...options,
    requestDecision:async body => ({ answers:Object.fromEntries(Object.keys(body.groups).map(id => [id, { choice:id === 'tactics' ? pick(p) : 'wait', confidence:1 }])) }) });
  await new Promise(r => setTimeout(r, 5));
  for (let t = 1; t < turns; t++) { w.setTick(3000 + t * 36); w.api._tick({}); await new Promise(r => setTimeout(r, 5)); }
  p.stop('manual');
  return p;
};

test('the objective is automatic only for a ready force; rallying is not a decline; a running objective is not re-sent', async () => {
  // Three soldiers with a barracks: listed, never automatic.
  const few = world({ own:[...home(), ...squad(3, 14, 14)], enemies:enemyBase() });
  few.memory.objective = '摧毁五角大楼';
  const g = candidateGroups(few.api, catalog, collectState(few.api, catalog), few.memory);
  assert.ok(g.tactics.actions.objective_990); assert.equal(g.tactics.actions.objective_990.auto, undefined);
  let w = world({ own:[...home(), ...squad(3, 14, 14)], enemies:enemyBase() });
  await decide(w, { objective:'摧毁五角大楼' }, () => 'wait', 6);
  assert.ok(!w.calls.some(c => c[0] === 'attack'), 'three soldiers are not sent at the Pentagon');
  // End of the second report: escalation 2, 8 of 16 soldiers, the model keeps choosing to gather.
  w = world({ own:[...home(), ...squad(8, 14, 14)], enemies:enemyBase() });
  const p = await decide(w, { objective:'摧毁五角大楼' }, (pl) => { pl.memory.escalation = { level:2, changedAt:2900, reason:'test' }; return 'assemble_force'; }, 6);
  assert.ok(!w.calls.some(c => c[0] === 'attack'), 'gathering is respected, nobody is fed in');
  assert.ok(!p.status.events.some(e => e.reason === 'mission_locked'), 'and the gather order is never locked out');
  // A ready force already attacking the objective: the fallback does not re-send it every two turns.
  w = world({ own:[...home(), ...squad(12)], enemies:enemyBase(), offers:{} });
  const q = await decide(w, { objective:'摧毁五角大楼' }, () => 'wait', 10);
  assert.equal(w.calls.filter(c => c[0] === 'attack' && c[2] === 990).length, 1);
  assert.equal(q.status.events.filter(e => e.auto).length, 1);
  assert.equal(q.memory.missionLock.tick, 3036, 'the lock is not renewed by repeats');
});

test('"already attacking" needs 75% of the threshold, so a handful of survivors cannot bypass it', () => {
  const w = world({ own:home() });
  const state = { queues:[], airThreatCount:0, mobileAntiAirCount:0 };
  const at = (n) => { const army = squad(n); return forceReadiness(w.api, catalog, state, army, [], w.memory); };
  w.memory.mission = { mode:'attack', targetId:990, ids:[10] };
  assert.equal(at(5).ready, false, '5 of 8 soldiers still "attacking" are not a committed force');
  w.memory.readinessLatch = undefined;
  assert.equal(at(6).ready, true); assert.equal(at(6).reason, 'an attack is already committed');
});

test('when only anti-air sites are left they are still listed, last', () => {
  const w = world({ own:[...home(), ...squad(12)], enemies:[unit(910,'PATRIOT',2,50,44), unit(911,'PATRIOT',2,52,44)] });
  let g = candidateGroups(w.api, catalog, collectState(w.api, catalog), w.memory);
  assert.deepEqual(choices(g.tactics).filter(k => k.startsWith('assault_')), ['assault_910', 'assault_911']);
  const mixed = world({ own:[...home(), ...squad(12)], enemies:[unit(910,'PATRIOT',2,50,44), unit(803,'POWER',2,60,60), unit(920,'PILL',2,59,47)] });
  g = candidateGroups(mixed.api, catalog, collectState(mixed.api, catalog), mixed.memory);
  assert.deepEqual(choices(g.tactics).filter(k => k.startsWith('assault_')), ['assault_803', 'assault_910', 'assault_920'], 'anti-air after the other buildings, no defense slot');
});

test('abandoning a failed attack also clears its lock; pillboxes guarding the objective are not locked out', () => {
  const w = world({ own:[...home(), ...squad(12)], enemies:enemyBase(), tick:10000 });
  acceptMission(w.memory, { type:'mission', mode:'attack', ids:[10], targetId:801, x:62, y:60 }, { ids:[10] }, 9990);
  w.memory.combatSamples = [{ tick:8600, lost:0, killed:0 }];
  w.memory.ledger = { seenOwn:new Map(), seenEnemy:new Map(), seeded:true, ownBuilt:0, ownUnitsLost:6, ownBuildingsLost:0, enemyUnitsDestroyed:1, enemyBuildingsDestroyed:0 };
  const g = candidateGroups(w.api, catalog, collectState(w.api, catalog), w.memory);
  assert.equal(w.memory.escalation.level, 1); assert.equal(w.memory.mission, undefined);
  assert.equal(w.memory.missionLock, undefined, 'the lock goes with the abandoned mission');
  assert.equal(missionGate(w.api, w.memory, g.tactics.actions.assemble_force), undefined, 'regrouping is accepted at once');
  // Attacking the objective: the pillbox 2 tiles from the Pentagon may be cleared, a far one may not.
  const o = world({ own:[...home(), ...squad(12)], enemies:[...enemyBase(), unit(930,'PILL',2,30,60)] });
  o.memory.objective = '摧毁五角大楼';
  const og = candidateGroups(o.api, catalog, collectState(o.api, catalog), o.memory);
  acceptMission(o.memory, og.tactics.actions.objective_990, { ids:[10] }, 3000);
  assert.equal(og.tactics.actions.assault_920.clearsObjective, true);
  assert.equal(missionGate(o.api, o.memory, og.tactics.actions.assault_920), undefined);
  assert.equal(og.tactics.actions.assault_930?.clearsObjective, undefined);
  assert.equal(missionGate(o.api, o.memory, { type:'mission', mode:'attack', ids:[10], targetId:930, x:30, y:60 })?.reason, 'mission_locked');
});

test('objective parsing: clauses, protected names, whole words, capture', () => {
  assert.deepEqual(parseObjective('摧毁五角大楼，保护白宫').words, ['pentagon', 'wash pent']);
  assert.deepEqual(parseObjective('destroy the Pentagon and protect the White House').guarded, ['white house']);
  assert.deepEqual(parseObjective('摧毁五角大楼和白宫').words, ['pentagon', 'wash pent', 'white house'], 'a clause without a verb inherits it');
  assert.equal(matchesObjective('摧毁五角大楼，保护白宫', ['pentagon'], { label:'White House' }, 'CAWHITE'), false);
  assert.equal(matchesObjective('destroy the Pentagon', ['pentagon'], { label:'Pent' }, 'X'), false, 'no partial words');
  assert.equal(matchesObjective('destroy everything', [], { label:'Thing' }, 'X'), false);
  assert.ok(matchesObjective('destroy the Pentagon', ['pentagon'], { label:'Pentagon Building' }, 'CAPENT'));
  // The White House is much nearer, but it is to be protected.
  catalog.WHITE = { label:'White House', armor:'concrete' };
  const w = world({ own:[...home(), ...squad(12)], enemies:enemyBase(), neutral:[unit(996,'WHITE',2,20,20)] });
  w.memory.objective = '摧毁五角大楼，保护白宫';
  assert.equal(trackObjective(w.api, catalog, w.memory, { rx:10, ry:10 }).id, 990);
  // Taken by our engineer: captured, not destroyed, and no longer offered.
  const enemies = enemyBase(), own = [...home(), ...squad(12)];
  const c = world({ own, enemies });
  c.memory.objective = '摧毁五角大楼';
  candidateGroups(c.api, catalog, collectState(c.api, catalog), c.memory);
  own.push(...enemies.splice(enemies.findIndex(e => e.id === 990), 1));
  const snap = collectState(c.api, catalog), g = candidateGroups(c.api, catalog, snap, c.memory);
  assert.equal(snap.state.objectiveTarget.captured, true);
  assert.ok(!g.tactics.actions.objective_990); assert.match(g.tactics.instructions, /Target Pentagon captured/);
});

test('with an objective the assault list is shorter and the wait option is one line', () => {
  const extra = [unit(804,'POWER',2,66,62), unit(805,'POWER',2,68,62), unit(806,'EREF',2,70,62), unit(921,'PILL',2,57,49), unit(922,'PILL',2,55,49)];
  const w = world({ own:[...home(), ...squad(12)], enemies:[...enemyBase(), ...extra] });
  w.memory.objective = '摧毁五角大楼';
  const g = candidateGroups(w.api, catalog, collectState(w.api, catalog), w.memory);
  const assaults = choices(g.tactics).filter(k => k.startsWith('assault_'));
  assert.equal(assaults.length, MAX_ASSAULTS_WITH_OBJECTIVE);
  assert.deepEqual(assaults.filter(k => ['assault_920', 'assault_921', 'assault_922'].includes(k)), ['assault_920', 'assault_921'],
    'two defense slots, filled by distance from the Pentagon (#920 hugs it) rather than from our troops (#922 is nearest to them)');
  assert.ok(g.tactics.criteria.wait.length < 60);
  const plain = world({ own:[...home(), ...squad(12)], enemies:[...enemyBase(), ...extra] });
  const pg = candidateGroups(plain.api, catalog, collectState(plain.api, catalog), plain.memory);
  assert.equal(choices(pg.tactics).filter(k => k.startsWith('assault_')).length, MAX_ASSAULTS);
});

test('threat replies: bounded work in a big battle, one report per pass, no walking back into fire', () => {
  // 150 against 150, interleaved at close range.
  const own = Array.from({ length:150 }, (_, i) => unit(100 + i, 'GI', 3, 20 + (i % 15) * 2, 20 + Math.floor(i / 15) * 2, { isIdle:false }));
  const enemies = Array.from({ length:150 }, (_, i) => unit(5000 + i, i % 3 ? 'EGI' : 'PILL', i % 3 ? 3 : 2, 21 + (i % 15) * 2, 21 + Math.floor(i / 15) * 2));
  const w = world({ own:[...home(), ...own], enemies });
  let queries = 0; w.api.weaponVs = () => { queries++; return undefined; };
  const events = [];
  respondToThreats(w.api, catalog, w.memory, e => events.push(e), own, enemies);
  assert.ok(queries <= THREAT_UNITS_PER_PASS * THREAT_CANDIDATES * 3, `${queries} range queries in one pass`);
  assert.equal(events.length, 1, 'all replies of a pass are one report');
  assert.ok(events[0].replies >= 2); assert.match(events[0].description, /^射程外受击：.*；/);
  const cursor = w.memory.threatCursor;
  assert.ok(cursor >= THREAT_UNITS_PER_PASS, 'at most a batch of units is examined per pass');
  w.setTick(3000 + THREAT_REPLY_TICKS);
  respondToThreats(w.api, catalog, w.memory, e => events.push(e), own, enemies);
  assert.equal(events.length, 1, `no second report within ${THREAT_REPORT_TICKS} ticks`);
  assert.notEqual(w.memory.threatCursor, cursor, 'the next pass continues with the following units');
  // A conscript that fell back from a tank is not sent straight back by its attack mission.
  const lone = unit(40,'GI',3,20,30), tank = unit(701,'TANK',7,25,30);
  const t = world({ own:[...home(), lone], enemies:[tank] });
  t.memory.mission = { mode:'attack', ids:[40], targetId:701, x:25, y:30, since:3000 };
  maintainBattle(t.api, catalog, t.memory, () => {});
  assert.deepEqual(t.calls.map(c => c[0]), ['move']);
  Object.assign(lone, { tile:{ rx:16, ry:30 }, isIdle:true });
  t.calls.length = 0; t.setTick(3100); maintainBattle(t.api, catalog, t.memory, () => {});
  assert.ok(!t.calls.some(c => c[1].includes(40) && c[0] !== 'move'), 'not re-sent at the tank');
  t.calls.length = 0; t.setTick(3000 + FALL_BACK_TICKS + 1); lone.tile = { rx:10, ry:30 };
  maintainBattle(t.api, catalog, t.memory, () => {});
  assert.ok(t.calls.some(c => c[1].includes(40)), 'the mission resumes later');
});

test('objective clauses: "并 / 同时 / 但 / 不要 / but do not" protect what follows; "和" still lists two targets', () => {
  for (const text of ['摧毁五角大楼并保护白宫', '摧毁五角大楼同时保护白宫', '摧毁五角大楼但不要打白宫', '摧毁五角大楼但是别碰白宫', 'destroy the Pentagon but do not attack the White House']) {
    const parsed = parseObjective(text);
    assert.deepEqual(parsed.words, ['pentagon', 'wash pent'], text); assert.deepEqual(parsed.guarded, ['white house'], text);
    assert.equal(matchesObjective(text, parsed.words, { label:'White House' }, 'CAWHITE'), false, text);
  }
  assert.deepEqual(parseObjective('摧毁五角大楼和白宫').words, ['pentagon', 'wash pent', 'white house']);
  assert.deepEqual(parseObjective('destroy the Pentagon and the White House').words, ['pentagon', 'wash pent', 'white house']);
  // Near the base, the White House would otherwise be picked first.
  catalog.WHITE ??= { label:'White House', armor:'concrete' };
  const w = world({ own:[...home(), ...squad(12)], enemies:enemyBase(), neutral:[unit(996,'WHITE',2,20,20)] });
  w.memory.objective = '摧毁五角大楼但不要打白宫';
  assert.equal(trackObjective(w.api, catalog, w.memory, { rx:10, ry:10 }).id, 990);
});

test('repeating the current attack reaches only new or idle units; soldiers already fighting keep their target', async () => {
  const army = squad(12);
  const w = world({ own:[...home(), ...army], enemies:[unit(801,'EBARR',2,62,60)], offers:{} });
  const player = await attachJevPlayer(w.api, { catalog, intervalMs:1e9, wakeIntervalMs:0, disableMicro:true, maxDecisions:50,
    requestDecision:async body => ({ answers:Object.fromEntries(Object.keys(body.groups).map(id => [id, { choice:id === 'tactics' ? 'assault_801' : 'wait', confidence:1 }])) }) });
  try {
    await new Promise(r => setTimeout(r, 5));
    const first = w.calls.filter(c => c[0] === 'attack');
    assert.equal(first.length, 1); const ordered = first[0][1];
    assert.ok(ordered.length >= 10, 'the army (minus its scout) is sent');
    // A fresh conscript joins, one soldier has gone idle, the rest are busy answering fire.
    const idle = army.find(u => ordered.includes(u.id));
    w.own.push(unit(99,'GI',3,50,50)); idle.isIdle = true;
    w.setTick(3200); w.api._tick({}); await new Promise(r => setTimeout(r, 5));
    const second = w.calls.filter(c => c[0] === 'attack').at(-1);
    assert.deepEqual([...second[1]].sort((a,b)=>a-b), [idle.id, 99].sort((a,b)=>a-b), 'only the idle soldier and the newcomer are ordered');
    assert.equal(player.memory.mission.ids.length, ordered.length + 1, 'the mission still counts the whole army');
    // Nobody new and nobody idle: nothing is re-sent, however long ago the last order was.
    w.setTick(3250); w.api._tick({}); await new Promise(r => setTimeout(r, 5));
    w.setTick(4000); w.api._tick({}); await new Promise(r => setTimeout(r, 5));
    assert.equal(w.calls.filter(c => c[0] === 'attack').length, 2);
  } finally { player.stop('manual'); }
});

test('an unmatched objective records the names of the buildings in view, and the decision log keeps them', async () => {
  const { stateSummary } = await import('../src/logbook.mjs');
  const w = world({ own:[...home(), ...squad(12)], enemies:[unit(801,'EBARR',2,62,60)], offers:{} });
  w.memory.objective = 'destroy the Kremlin';
  const snapshot = collectState(w.api, catalog); candidateGroups(w.api, catalog, snapshot, w.memory);
  assert.equal(snapshot.state.objectiveTarget.found, false);
  assert.ok(snapshot.state.objectiveTarget.seen.includes('Allied Barracks/EBARR'));
  assert.deepEqual(stateSummary(snapshot.state).objective, { found:false, seen:['Allied Barracks/EBARR'] });
});

// 0.7.0 report (Laya, "摧毁五角大厦"): on the Washington map the Pentagon is four buildings labelled
// "RA2 Wash Pent A" to "D" (CAWA2A-D). None matched "pentagon", the objective was never found, and
// only the two pieces hit in passing fell.
test('the Pentagon built from four "Wash Pent" pieces is found, and every piece is taken down in turn', () => {
  const pieces = { CAWA2A:'RA2 Wash Pent A', CAWA2B:'RA2 Wash Pent B', CAWA2C:'RA2 Wash Pent C', CAWA2D:'RA2 Wash Pent D' };
  for (const [name, label] of Object.entries(pieces)) catalog[name] = { label, armor:'concrete' };
  catalog.CAWASH07 = { label:'RA2 Wash Building 7', armor:'wood' };
  for (const text of ['摧毁五角大厦', '摧毁五角大楼', 'Destroy the Pentagon']) {
    const words = objectiveKeywords(text);
    for (const [name, label] of Object.entries(pieces)) assert.equal(matchesObjective(text, words, { label }, name), 'name', `${text} -> ${label}`);
    assert.equal(matchesObjective(text, words, catalog.CAWASH07, 'CAWASH07'), false, 'an ordinary Washington building is not the target');
  }
  assert.equal(matchesObjective('摧毁五角大楼，保护白宫', objectiveKeywords('摧毁五角大楼，保护白宫'), { label:'RA2 Wash Pent A' }, 'CAWA2A'), 'name');
  const neutral = [unit(1701,'CAWA2A',2,60,40), unit(1702,'CAWA2B',2,63,40), unit(1703,'CAWA2C',2,60,43), unit(1704,'CAWA2D',2,63,43), unit(1705,'CAWASH07',2,30,30)];
  const w = world({ own:[...home(), ...squad(12)], neutral });
  w.memory.objective = '摧毁五角大厦';
  const destroyed = [];
  for (let round = 0; round < 4; round++) {
    const groups = candidateGroups(w.api, catalog, collectState(w.api, catalog), w.memory);
    const key = choices(groups.tactics).find(k => k.startsWith('objective_'));
    assert.ok(key, `round ${round}: the objective is offered`);
    const id = Number(key.slice('objective_'.length));
    assert.ok([1701, 1702, 1703, 1704].includes(id) && !destroyed.includes(id), `round ${round}: a remaining piece (${id})`);
    destroyed.push(id);
    neutral.splice(neutral.findIndex(u => u.id === id), 1);
  }
  const after = collectState(w.api, catalog);
  candidateGroups(w.api, catalog, after, w.memory);
  assert.equal(w.memory.objectiveTarget.done, true, 'all four pieces gone: the objective is complete');
  assert.deepEqual([...w.memory.objectiveDone].sort(), [1701, 1702, 1703, 1704]);
});

// 0.7.1 report (Pentagon mission, conscripts only): the foot cap of 16 held the army at about 20
// conscripts for ten minutes against a concrete target while credits climbed past 9,000.
test('an infantry-only army keeps training while money piles up, and stays capped when money is short', async () => {
  const { RICH_INFANTRY_CAP } = await import('../src/player/werhd-jev-player.mjs');
  const rich = world({ own:[...home(), ...squad(20)], enemies:enemyBase(), credits:9000 });
  let g = candidateGroups(rich.api, catalog, collectState(rich.api, catalog), rich.memory);
  assert.ok(g.infantry?.actions.produce_GI, '20 conscripts and 9,000 credits: more are offered');
  assert.equal(g.infantry.actions.produce_GI.auto, 2, 'and trained automatically');
  const mid = world({ own:[...home(), ...squad(20)], enemies:enemyBase(), credits:3500 });
  g = candidateGroups(mid.api, catalog, collectState(mid.api, catalog), mid.memory);
  assert.ok(g.infantry?.actions.produce_GI, '3,500 credits: offered'); assert.equal(g.infantry.actions.produce_GI.auto, undefined, 'but left to the model');
  const poor = world({ own:[...home(), ...squad(20)], enemies:enemyBase(), credits:1500 });
  g = candidateGroups(poor.api, catalog, collectState(poor.api, catalog), poor.memory);
  assert.ok(!g.infantry?.actions?.produce_GI, '1,500 credits: the old cap of 16 still applies');
  const full = world({ own:[...home(), ...squad(RICH_INFANTRY_CAP)], enemies:enemyBase(), credits:20000 });
  g = candidateGroups(full.api, catalog, collectState(full.api, catalog), full.memory);
  assert.ok(!g.infantry?.actions?.produce_GI, `at ${RICH_INFANTRY_CAP} the cap holds even when rich`);
});
