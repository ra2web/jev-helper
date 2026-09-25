import test from 'node:test';
import assert from 'node:assert/strict';
import { collectState, candidateGroups, economyPlan } from '../src/player/werhd-jev-player.mjs';

// Economy targets must follow income, idle miners and the credit trend, not a fixed "3 miners".
const weapon = (range, damage = 100) => ({ range, damage, rof: 40, ag: true, aa: false, verses: [1,1,1,1,1,1] });
const catalog = {
  YARD:{yard:true,cost:3000}, POWER:{power:300,cost:800}, REFINERY:{refinery:true,cost:2000}, BARRACKS:{factory:'InfantryType',cost:500}, FACTORY:{factory:'UnitType',cost:2000},
  HARV:{harvester:true,cost:1400}, TANK:{category:'AFV',cost:700,weapon:weapon(5,65)}, GI:{category:'Soldier',cost:200,weapon:weapon(4,15)},
};
for (const [name, rule] of Object.entries(catalog)) rule.label = name;
const unit = (id, name, type, x, y, extra = {}) => ({ id, name, type, tile:{rx:x,ry:y}, isIdle:true, hitPoints:100, maxHitPoints:100, primaryWeapon:catalog[name].weapon, isDeployed:false, ...extra });
function world({ own, credits, tick = 5000, ore = true, offers }) {
  const api = {
    ObjectType:{Building:2,Vehicle:7,Infantry:3,Aircraft:1}, QueueType:{Structures:0,Armory:1,Infantry:2,Vehicles:3,Aircrafts:4,Ships:5}, LandType:{Clear:0,Tiberium:9},
    units:r=>r==='self'?own:[], me:()=>({credits,power:{total:500,drain:100}}), tick:()=>tick, time:()=>tick/15,
    map:{size:()=>({width:60,height:60}),visible:()=>true,tile:(x,y)=>({rx:x,ry:y,landType:ore&&x>40?9:0})}, canPlace:()=>true,
    production:{queues:()=>Array.from({length:6},(_,type)=>({type,size:0,maxSize:99,items:[]})),available:q=>q===undefined?Object.values(offers).flat():(offers[q]??[])},
    weaponVs:()=>undefined, inRange:()=>false, attack(){}, move(){}, attackMove(){}, deploy(){return true;}, order(){return true;}, OrderType:{Move:1,Attack:2},
  };
  const memory = { frontiers:new Map(), enemyBuildings:new Map(), orders:new Map(), postureOrders:new Map(), specialOrders:new Map(), specialTargets:new Map(), plannedSites:new Map(), observedSpecial:new Map(), repairing:new Set(), lastMaintenance:tick, lastMicroReport:-1000 };
  return { api, memory };
}
const base = [unit(1,'YARD',2,10,10), unit(2,'POWER',2,12,10), unit(3,'REFINERY',2,14,12), unit(4,'BARRACKS',2,10,14), unit(5,'FACTORY',2,14,16)];
const offers = { 0:[{name:'REFINERY',type:2},{name:'POWER',type:2},{name:'FACTORY',type:2}], 3:[{name:'HARV',type:7},{name:'TANK',type:7}], 2:[{name:'GI',type:3}] };

test('with credits piling up, one miner is enough: no more miners or refineries are requested', () => {
  const own=[...base, {...unit(6,'HARV',7,30,12),isIdle:false}, unit(7,'TANK',7,16,16)];
  const { api, memory } = world({ own, credits:50000, offers });
  memory.economySamples=[{tick:3500,credits:40000,spent:0}];
  const snap=collectState(api,catalog);const groups=candidateGroups(api,catalog,snap,memory);
  const e=snap.state.economy;
  assert.equal(e.surplus,true);assert.equal(e.targetMiners,1);assert.equal(e.targetRefineries,1);assert.match(e.reason,/money is not the bottleneck/);assert.equal(e.incomeRate,Math.round(10000/1500*1000));
  assert.ok(!groups.vehicles?.actions?.produce_HARV,'no ECONOMY miner offer');
  assert.ok(!groups.construction?.actions?.produce_REFINERY,'no second refinery');
  assert.ok(groups.vehicles?.actions?.produce_TANK,'combat production is not blocked by the old two-miner rule');
  assert.match(groups.construction.instructions,/1 refinery and 1 miner/);assert.match(groups.vehicles.instructions,/1 now/);
});

test('with credits draining, mining expands toward what the refineries can feed', () => {
  const own=[...base, {...unit(6,'HARV',7,30,12),isIdle:false}];
  const { api, memory } = world({ own, credits:900, offers });
  memory.economySamples=[{tick:3500,credits:2500,spent:0}];
  const snap=collectState(api,catalog);const groups=candidateGroups(api,catalog,snap,memory);
  const e=snap.state.economy;
  assert.equal(e.starving,true);assert.equal(e.targetMiners,2);assert.match(e.reason,/falling: expand mining/);
  assert.ok(groups.vehicles?.actions?.produce_HARV,'a miner is offered as the economy step');
  assert.match(groups.vehicles.criteria.produce_HARV,/ECONOMY/);
});

test('idle miners without reachable ore stop the miner target where it is', () => {
  const own=[...base, unit(6,'HARV',7,30,12), unit(7,'HARV',7,31,12)];
  const { api, memory } = world({ own, credits:900, ore:false, offers });
  memory.economySamples=[{tick:3500,credits:2500,spent:0}];
  const snap=collectState(api,catalog);candidateGroups(api,catalog,snap,memory);
  const e=snap.state.economy;
  assert.equal(e.idleMiners,2);assert.equal(e.targetMiners,2);assert.match(e.reason,/idle without reachable ore/);
});

test('income counts what was spent, and the first refinery still comes before any miner', () => {
  const { api, memory } = world({ own:[...base], credits:2000, tick:6000, offers });
  memory.economySamples=[{tick:4500,credits:3000,spent:0}];memory.spentCredits=4000;
  const snap=collectState(api,catalog);
  const p=economyPlan(api,catalog,snap.state,memory,snap.raw.units);
  assert.equal(p.incomeRate,2000,'3000 spent plus -1000 credit change over 1500 ticks is 2000 per 1000 ticks');
  const bare=world({ own:[unit(1,'YARD',2,10,10),unit(2,'POWER',2,12,10)], credits:3000, offers });
  const s2=collectState(bare.api,catalog);const g2=candidateGroups(bare.api,catalog,s2,bare.memory);
  assert.equal(s2.state.economy.targetMiners,0);assert.equal(s2.state.economy.targetRefineries,1);assert.ok(g2.construction.actions.produce_REFINERY);
});
