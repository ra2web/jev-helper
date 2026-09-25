import assert from 'node:assert/strict';
import { collectState,candidateGroups,maintainBattle } from '../src/player/werhd-jev-player.mjs';
import { infantryProfile,weaponEffectiveness,chooseBuildingSite,chooseRallySite,trafficClearance } from '../src/player/werhd-jev-strategy.mjs';

// Match-observed weapon values, with arbitrary names: no unit-name policy table.
const gun=(damage,range,rof,verses,aa=false)=>({damage,range,rof,verses,aa,ag:true});
const catalog={
  BASIC:{cost:180,speed:10.24,armor:'none',deployer:true,weapon:gun(15,4,20,[1,.8,.7,.5,.25,.25]),secondary:gun(15,5,15,[1,1,.7,.6,.4,.4])},
  SPECIALIST:{cost:550,speed:7.68,armor:'plate',deployer:true,weapon:gun(10,5,20,[1,1,.7,.6,.4,.4]),secondary:gun(60,7,70,[.1,.1,.1,.6,1,1.2],true)},
  SCOUT:{cost:200,speed:20.48,armor:'none',weapon:gun(30,1.5,30,[1,1,1,0,0,0])},
  TANK:{cost:750,armor:'heavy',category:'AFV',weapon:gun(65,5,50,[.2,.2,.2,1,1,1])},
  YARD:{yard:true},REF:{refinery:true},FACTORY:{factory:'UnitType'},BARRACKS:{factory:'InfantryType'},
  POWER:{power:200,cost:800},MINER:{harvester:true,cost:1400},LAB:{cost:2000},
};
for(const [name,r]of Object.entries(catalog))r.label=name;
const unit=(id,name,type,x=30,y=30)=>({id,name,type,tile:{rx:x,ry:y},isIdle:true,hitPoints:100,maxHitPoints:100,
  primaryWeapon:catalog[name]?.weapon,canDeploy:!!catalog[name]?.deployer,isDeployed:false});
let own=[unit(1,'YARD',2),unit(2,'REF',2,35,30),unit(3,'FACTORY',2,30,38),unit(4,'BARRACKS',2,22,30),
  unit(5,'POWER',2,25,23),unit(6,'MINER',7,43,30),unit(7,'MINER',7,45,30),unit(8,'MINER',7,47,30)];
let enemies=[],tick=1000;
const calls=[];
const api={ObjectType:{Building:2,Infantry:3,Vehicle:7,Aircraft:1},QueueType:{Structures:0,Armory:1,Infantry:2,Vehicles:3,Aircrafts:4,Ships:5},
  ArmorType:{0:'None',1:'Flak',2:'Plate',3:'Light',4:'Medium',5:'Heavy',None:0,Heavy:5},LandType:{Clear:0,Water:7,Tiberium:9},
  units:r=>r==='self'?own:enemies,me:()=>({credits:5000,power:{total:200,drain:80}}),tick:()=>tick,time:()=>tick/15,
  production:{queues:()=>Array.from({length:6},(_,type)=>({type,size:0,maxSize:99,items:[]})),
    // A normal base with a vehicle factory: tanks are the army and infantry is support.
    available:q=>q===2||q===undefined?['BASIC','SPECIALIST','SCOUT'].map(name=>({name,type:3})):q===3?[{name:'TANK',type:7}]:[]},
  map:{size:()=>({width:60,height:60}),visible:()=>true,tile:(x,y)=>x>=0&&y>=0&&x<60&&y<60?{rx:x,ry:y,landType:0}:undefined},
  canPlace:()=>true,inRange:()=>true,move:(...a)=>calls.push(['move',...a]),gather:(...a)=>calls.push(['gather',...a]),attack:(...a)=>calls.push(['attack',...a]),
};
assert.equal(infantryProfile(catalog.BASIC,api).role,'antiInfantry');
assert.equal(infantryProfile(catalog.SPECIALIST,api).role,'antiArmor');
const p=infantryProfile(catalog.SPECIALIST,api);
assert.ok(p.normalInfantry>p.deployedInfantry*3,'deployed anti-armor missiles are weaker against infantry');
assert.ok(weaponEffectiveness(catalog.SPECIALIST.secondary,[{type:3}],catalog,api)<weaponEffectiveness(catalog.BASIC.secondary,[{type:3}],catalog,api),'no-enemy fallback must apply infantry armor');
let memory={},snap=collectState(api,catalog),groups=candidateGroups(api,catalog,snap,memory);
assert.equal(snap.state.infantryRoles.preferredScout,'SCOUT');
assert.ok(groups.infantry.actions.produce_SCOUT,'short-range cheap scouts must survive the combat range filter');
assert.match(groups.infantry.instructions,/SCOUT FIRST/);
own.push(unit(10,'SCOUT',3,20,20),unit(11,'SPECIALIST',3,32,24),unit(12,'SPECIALIST',3,33,24));
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,memory);
assert.equal(memory.scoutId,10,'pick the fast cheap unit, not the first infantry');
assert.ok(!groups.infantry.actions.produce_SPECIALIST,'two anti-armor supports suffice without a new air threat');
assert.ok(groups.infantry.actions.produce_BASIC,'missing anti-infantry role must remain available');
own.find(u=>u.id===11).isDeployed=true;
enemies=[unit(100,'BASIC',3,35,24)];
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,memory);
assert.ok(groups.deployment.actions.undeploy_mobile.ids.includes(11),'switch to the stronger normal weapon against nearby infantry');
assert.ok(!groups.deployment.actions.deploy_combat?.ids.includes(12));
enemies=[unit(100,'TANK',7,36,24)];
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,memory);
assert.ok(groups.deployment.actions.deploy_combat.ids.includes(12),'deploy against armor when the missile is stronger');
assert.ok(!groups.deployment.actions.undeploy_mobile?.ids.includes(11));
enemies=[];
const site=chooseBuildingSite(api,catalog,'LAB',own,{});
assert.ok(site,'spacing must still leave legal building choices');
assert.ok(trafficClearance({rx:site.x,ry:site.y},own.filter(u=>u.type===2),own,catalog));
assert.ok(!trafficClearance({rx:42,ry:30},own.filter(u=>u.type===2),own,catalog),'keep the visible miner-refinery corridor free');
const rally=chooseRallySite(api,catalog,own,own[0]);
assert.ok(rally);
assert.ok(trafficClearance({rx:rally.x,ry:rally.y},own.filter(u=>u.type===2),own,catalog));
own.push(unit(20,'TANK',7,34,31),unit(21,'TANK',7,43,31));
memory={lastMaintenance:-1000,lastMicroReport:-1000,orders:new Map(),repairing:new Set(),specialOrders:new Map()};
maintainBattle(api,catalog,memory,()=>{});
assert.ok(calls.some(c=>c[0]==='move'&&c[1].includes(20)),'idle tank must clear the refinery without moving miners');
assert.ok(!calls.some(c=>c[0]==='move'&&c[1].some(id=>[6,7,8].includes(id))));
assert.ok(!calls.some(c=>c[0]==='move'&&c[1].includes(21)),'a distant force must not be pulled home merely for standing near a projected miner route');
calls.length=0;tick+=200;enemies=[unit(101,'TANK',7,35,31)];
maintainBattle(api,catalog,memory,()=>{});
assert.ok(!calls.some(c=>c[0]==='move'&&c[1].includes(20)),'do not abandon combat to clear traffic');
console.log('Player-side roles/traffic: scout eligibility, mixed infantry, armor-aware posture, building spacing, mining corridor and idle tank clearance passed');

catalog.AA={cost:1000,power:-50,isBaseDefense:true,weapon:gun(30,10,20,[1,1,1,1,1,1],true)};
catalog.PILL={cost:500,isBaseDefense:true,weapon:gun(15,5,20,[1,1,1,.3,.3,.3])};
catalog.ESCORT={cost:600,category:'AFV',weapon:gun(25,6,25,[1,1,1,1,1,1],true)};
catalog.FLIER={category:'AirPower',armor:'none',weapon:gun(10,6,20,[1,1,1,1,1,1])};
own.push(...Array.from({length:8},(_,i)=>unit(30+i,'PILL',2,18+i,18)),...Array.from({length:7},(_,i)=>unit(50+i,'TANK',7,20+i,40)));
enemies=[{...unit(101,'FLIER',3,38,30),zone:1},unit(102,'LAB',2,58,58)];
const available=api.production.available;
api.production.available=q=>q===1?['PILL','AA'].map(name=>({name,type:2})):q===3?['TANK','ESCORT'].map(name=>({name,type:7})):available(q);
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,{});
assert.ok(groups.defenses.actions.produce_AA,'eight obsolete guns must not block the first anti-air counter');
assert.ok(!groups.defenses.actions.produce_PILL,'distant ground buildings must not contaminate the local air threat');
assert.equal(snap.state.mobileAntiAirCount,0,'base-deployed infantry are not mobile escorts');
assert.ok(groups.vehicles.actions.produce_ESCORT);
assert.ok(!groups.vehicles.actions.produce_TANK,'fill the missing mobile air cover before more tanks');
assert.ok(!groups.tactics.actions.assault_102,'do not count base AA as protection for an outgoing army');
own.push(unit(60,'ESCORT',7,27,40),unit(61,'ESCORT',7,28,40));
enemies[0].tile={rx:55,ry:55};
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,{});
assert.ok(groups.tactics.actions.assault_102.ids.includes(11),'support infantry must accompany the armor attack');
assert.ok(groups.tactics.actions.assault_102.ids.includes(60),'mobile anti-air must belong to the outgoing army');
console.log('Combined arms: local defensive targets, obsolete gun replacement, mobile AA accounting and infantry escorts passed');

// A non-deployer's ground primary and air secondary are simultaneously usable.
// This models public Soviet flak rules without a country or unit-name exception.
catalog.ESCORT.weapon=gun(25,5,25,[1,1,1,.6,.4,.4]);
catalog.ESCORT.secondary={...gun(35,10,25,[1,1,1,1,1,1],true),ag:false};
own=own.filter(u=>u.name!=='ESCORT');
enemies[0].tile={rx:38,ry:30};
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,{});
assert.ok(groups.vehicles.actions.produce_ESCORT,'secondary AA must qualify the production counter');
assert.ok(!groups.vehicles.actions.produce_TANK);
own.push({...unit(60,'ESCORT',7,30,30),secondaryWeapon:catalog.ESCORT.secondary});
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,{});
assert.equal(snap.state.mobileAntiAirCount,1,'dual-purpose escort is real mobile AA');
assert.equal(snap.state.antiAirCount,2,'one deployed AA infantry plus one dual-weapon escort');
memory={lastMaintenance:tick,lastMicroReport:-1000,orders:new Map(),repairing:new Set(),specialOrders:new Map(),
  mission:{mode:'defend',ids:[60],targetId:101,x:38,y:30}};
calls.length=0;
maintainBattle(api,catalog,memory,()=>{});
assert.ok(calls.some(c=>c[0]==='attack'&&c[1].includes(60)&&c[2]===101),'secondary AA must directly engage the threatening aircraft');
own.push({...unit(61,'ESCORT',7,29,30),secondaryWeapon:catalog.ESCORT.secondary});
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,{});
assert.equal(snap.state.mobileAntiAirCount,2);
assert.ok(!groups.vehicles.actions.produce_ESCORT,'fulfilled air cover must release the queue for armor');
assert.ok(groups.vehicles.actions.produce_TANK);
console.log('Dual-purpose weapons: secondary AA production, live escort counts, aircraft interception and bounded escort mix passed');

// Public China heavy-tank rules include secondary AA, but its primary role remains armor combat.
catalog.HEAVY={cost:1900,category:'AFV',label:'Heavy tank',weapon:gun(65,6.75,50,[.25,.25,.25,.75,1,1]),
  secondary:{...gun(50,8,80,[1,.9,.8,.7,.65,.45],true),ag:false}};
const priorVehicleOffers=api.production.available;
api.production.available=q=>q===3?[...priorVehicleOffers(q),{name:'HEAVY',type:7}]:priorVehicleOffers(q);
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,{});
assert.equal(snap.state.mobileAntiAirCount,2);
assert.ok(!groups.vehicles.actions.produce_ESCORT,'fulfilled dedicated air cover must still limit specialist escorts');
assert.ok(groups.vehicles.actions.produce_HEAVY,'a ground-focused armored unit must remain available despite its secondary AA and fulfilled escort quota');
console.log('Armored ground role: secondary AA does not incorrectly cap an effective mainline tank');

// Wall choices must survive the complete candidate pipeline, including shared-wallet filtering.
catalog.WALL={wall:true,cost:100,label:'Screening wall'};
enemies=[];
const offerBeforeWalls=api.production.available;
api.production.available=q=>q===1?[...offerBeforeWalls(q),{name:'WALL',type:2}]:offerBeforeWalls(q);
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,{});
// 0.6.0: without a base threat the defense question is no longer asked at all (a small model answered
// "wait" every time), so peacetime walls are not offered; wall sites still keep factory access.
assert.equal(groups.defenses,undefined,'no defense question in peacetime');
const wallSite=chooseBuildingSite(api,catalog,'WALL',own,{});
assert.ok(wallSite,'a wall still has a legal site');
assert.ok(trafficClearance({rx:wallSite.x,ry:wallSite.y},own.filter(u=>u.type===2),own,catalog),
  'a wall site must preserve refinery and factory access');
console.log('Wall sites: no peacetime defense question; legal placement keeps traffic access');
