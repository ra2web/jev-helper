import test from 'node:test';
import assert from 'node:assert/strict';
import { collectState, candidateGroups, forceReadiness, FORCE_STALL_TICKS } from '../src/player/werhd-jev-player.mjs';
import { ATTACK_FORCE_SIZE } from '../src/player/werhd-jev-strategy.mjs';

// Campaign-style situations: readiness must follow what the base can actually produce.
const weapon = (range, damage = 100, aa = false) => ({ range, damage, rof: 40, ag: true, aa, verses: [1,1,1,1,1,1] });
const catalog = {
  YARD:{yard:true}, BARRACKS:{factory:'InfantryType'}, FACTORY:{factory:'UnitType'},
  TANK:{category:'AFV',cost:700,weapon:weapon(5,65)}, ESCORT:{category:'AFV',cost:600,weapon:weapon(6,25,true)},
  GI:{category:'Soldier',cost:200,speed:8,weapon:weapon(4,15)}, FLIER:{category:'AirPower',weapon:weapon(6,20)},
  PENTAGON:{label:'Pentagon'}, TOWER:{isBaseDefense:true,weapon:weapon(8)},
};
for (const [name, rule] of Object.entries(catalog)) rule.label ??= name;
const unit = (id, name, type, x, y, extra = {}) => ({ id, name, type, tile:{rx:x,ry:y}, isIdle:true, hitPoints:100, maxHitPoints:100, primaryWeapon:catalog[name].weapon, canDeploy:false, isDeployed:false, ...extra });
function world({ own, enemies, offers, tick = 3000, queues = [] }) {
  const api = {
    ObjectType:{Building:2,Vehicle:7,Infantry:3,Aircraft:1}, QueueType:{Structures:0,Armory:1,Infantry:2,Vehicles:3,Aircrafts:4,Ships:5}, LandType:{Clear:0},
    units:r=>r==='self'?own:enemies, me:()=>({credits:175500,power:{total:500,drain:100}}), tick:()=>tick, time:()=>tick/15,
    map:{size:()=>({width:80,height:80}),visible:(x,y)=>x<50,tile:(x,y)=>({rx:x,ry:y,landType:0})}, canPlace:()=>true,
    production:{queues:()=>Array.from({length:6},(_,type)=>({type,size:queues.filter(q=>q.type===type).length,maxSize:99,items:queues.filter(q=>q.type===type)})),
      available:q=>q===undefined?Object.values(offers).flat():(offers[q]??[])},
    weaponVs:()=>undefined, inRange:()=>false, attack(){}, move(){}, attackMove(){}, deploy(){return true;},
  };
  const memory = { frontiers:new Map(), enemyBuildings:new Map(), orders:new Map(), postureOrders:new Map(), specialOrders:new Map(), specialTargets:new Map(), plannedSites:new Map(), observedSpecial:new Map(), repairing:new Set(), lastMaintenance:tick, lastMicroReport:-1000 };
  return { api, memory };
}
const base = [unit(1,'YARD',2,20,20)];
const pentagon = unit(900,'PENTAGON',2,45,45);

test('with a vehicle factory the classic armored threshold and anti-air escort rule still apply',()=>{
  const own=[...base,unit(2,'FACTORY',2,22,22),...Array.from({length:7},(_,i)=>unit(10+i,'TANK',7,25+i,25))];
  const { api, memory } = world({ own, enemies:[pentagon,{...unit(901,'FLIER',1,40,40),zone:1}], offers:{3:[{name:'TANK',type:7},{name:'ESCORT',type:7}]} });
  const snap=collectState(api,catalog);const groups=candidateGroups(api,catalog,snap,memory);
  assert.equal(snap.state.forceReadiness.ready,false);assert.equal(snap.state.forceReadiness.canBuildVehicles,true);assert.match(snap.state.forceReadiness.reason,/7\/8|anti-air/);
  assert.ok(!groups.tactics.actions.assault_900,'seven tanks without escorts do not assault while escorts are producible');
  assert.ok(groups.tactics.actions.assemble_force,'the force keeps rallying');
  assert.ok(groups.scouting,'the map keeps being revealed while the force is not ready');
  own.push(unit(30,'TANK',7,33,25),unit(31,'ESCORT',7,34,25),unit(32,'ESCORT',7,35,25));
  const again=candidateGroups(api,catalog,collectState(api,catalog),memory);
  assert.ok(again.tactics.actions.assault_900,'eight vehicles plus escorts assault the visible objective');
});

test('without vehicle production, armed infantry count toward the force and the assault is offered',()=>{
  const own=[...base,unit(2,'BARRACKS',2,22,22),...Array.from({length:ATTACK_FORCE_SIZE},(_,i)=>unit(10+i,'GI',3,25+i,25))];
  const { api, memory } = world({ own, enemies:[pentagon], offers:{2:[{name:'GI',type:3}]} });
  const snap=collectState(api,catalog);const groups=candidateGroups(api,catalog,snap,memory);
  const r=snap.state.forceReadiness;
  assert.equal(r.canBuildVehicles,false);assert.equal(r.combatUnits,ATTACK_FORCE_SIZE);assert.equal(r.ready,true);assert.match(r.reason,/vehicles cannot be produced/);
  assert.ok(groups.tactics.actions.assault_900,'infantry-only campaign forces assault the visible objective');
  const ids=groups.tactics.actions.assault_900.ids;assert.equal(ids.length,ATTACK_FORCE_SIZE-1,'one designated scout stays out of the assault');assert.ok(!ids.includes(memory.scoutId));
  assert.match(groups.tactics.instructions,/READY/);
  const few=world({ own:[...base,unit(2,'BARRACKS',2,22,22),unit(10,'GI',3,25,25)], enemies:[pentagon], offers:{2:[{name:'GI',type:3}]} });
  const g=candidateGroups(few.api,catalog,collectState(few.api,catalog),few.memory);
  assert.ok(!g.tactics.actions.assault_900,'with a barracks, one soldier still trains toward the threshold');
  assert.ok(g.scouting,'meanwhile the single unit may scout');
});

test('with no production at all, whatever exists attacks immediately; a stalled force attacks too',()=>{
  const bare=world({ own:[...base,unit(10,'GI',3,25,25),unit(11,'GI',3,26,25)], enemies:[pentagon], offers:{} });
  const snap=collectState(bare.api,catalog);const groups=candidateGroups(bare.api,catalog,snap,bare.memory);
  assert.equal(snap.state.forceReadiness.ready,true);assert.equal(snap.state.forceReadiness.threshold,1);assert.match(snap.state.forceReadiness.reason,/nothing can be produced/);
  assert.ok(groups.tactics.actions.assault_900);
  const stalled=world({ own:[...base,unit(2,'FACTORY',2,22,22),unit(10,'TANK',7,25,25),unit(11,'TANK',7,26,25)], enemies:[pentagon], offers:{3:[{name:'TANK',type:7}]}, tick:10000 });
  stalled.memory.forceProgress={count:2,tick:10000-FORCE_STALL_TICKS};
  const s2=collectState(stalled.api,catalog);const g2=candidateGroups(stalled.api,catalog,s2,stalled.memory);
  assert.equal(s2.state.forceReadiness.ready,true);assert.match(s2.state.forceReadiness.reason,/has not grown/);assert.ok(g2.tactics.actions.assault_900);
  const growing=world({ own:[...base,unit(2,'FACTORY',2,22,22),unit(10,'TANK',7,25,25),unit(11,'TANK',7,26,25),unit(12,'TANK',7,27,25)], enemies:[pentagon], offers:{3:[{name:'TANK',type:7}]}, tick:10000 });
  growing.memory.forceProgress={count:2,tick:10000-FORCE_STALL_TICKS};
  const s3=collectState(growing.api,catalog);candidateGroups(growing.api,catalog,s3,growing.memory);
  assert.equal(s3.state.forceReadiness.ready,false,'a force that just grew resets the stall clock');assert.equal(growing.memory.forceProgress.count,3);
});

test('a seen enemy building no longer ends scouting, and the mission objective reaches the model',()=>{
  const own=[...base,unit(2,'FACTORY',2,22,22),unit(10,'TANK',7,25,25),unit(11,'GI',3,26,25)];
  const { api, memory } = world({ own, enemies:[unit(902,'TOWER',2,48,20)], offers:{3:[{name:'TANK',type:7}],2:[{name:'GI',type:3}]} });
  memory.objective='Destroy the Pentagon in the north-east corner of the map';
  const snap=collectState(api,catalog);const groups=candidateGroups(api,catalog,snap,memory);
  assert.equal(memory.enemyBuildings.size,1);assert.equal(snap.state.forceReadiness.ready,false);
  assert.ok(groups.scouting&&Object.values(groups.scouting.actions).some(a=>a.mode==='explore'),'scouting continues although an enemy tower was seen');
  assert.match(groups.scouting.criteria.wait,/keep revealing/);
  assert.match(groups.tactics.instructions,/^MISSION OBJECTIVE: Destroy the Pentagon/);
  assert.match(snap.state.objective,/Mission objective: Destroy the Pentagon/);
  assert.equal(snap.state.forceGoal.ready,false);assert.equal(snap.state.forceGoal.attackThreshold,ATTACK_FORCE_SIZE);
  const r=forceReadiness(api,catalog,snap.state,snap.raw.army,[own[2]],memory);assert.equal(r.groundVehicles,1);assert.equal(r.combatUnits,2);
});
