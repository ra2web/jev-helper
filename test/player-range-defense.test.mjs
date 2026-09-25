import assert from 'node:assert/strict';
import { collectState, candidateGroups, executeCandidate, maintainBattle, combatTargetScore } from '../src/player/werhd-jev-player.mjs';
import { canFireAt, baseThreats } from '../src/player/werhd-jev-strategy.mjs';

const weapon = (range, damage = 100) => ({ range, damage, rof: 40, ag: true, aa: false, verses: [1,1,1,1,1,1] });
const catalog = {
  YARD:{yard:true}, POWER:{power:300}, REFINERY:{refinery:true}, FACTORY:{factory:'UnitType'}, MINER:{harvester:true},
  SHORT_TOWER:{isBaseDefense:true,cost:1500,weapon:weapon(8)},
  LONG_TOWER:{isBaseDefense:true,cost:1800,weapon:weapon(12)},
  BASIC:{category:'AFV',cost:750,weapon:weapon(5,65)},
  MOBILE_COUNTER:{category:'AFV',cost:1200,weapon:weapon(10,120)},
  SIEGE:{armor:'light',weapon:weapon(10)},
  FOOT:{cost:200,speed:10,deployer:true,weapon:weapon(4,15),secondary:weapon(6,20)},
};
for(const [name,rule] of Object.entries(catalog))rule.label=name;
const unit=(id,name,type,x,y)=>({id,name,type,tile:{rx:x,ry:y},isIdle:true,hitPoints:100,maxHitPoints:100,
  primaryWeapon:catalog[name].weapon,canDeploy:!!catalog[name].deployer,isDeployed:false});
let own=[unit(1,'YARD',2,30,30),unit(2,'POWER',2,20,23),unit(3,'REFINERY',2,30,40),unit(4,'FACTORY',2,22,30),
  ...[5,6,7].map(id=>({...unit(id,'MINER',7,32,45),isIdle:false})),unit(8,'SHORT_TOWER',2,30,32),unit(9,'BASIC',7,30,30)];
let enemies=[unit(100,'SIEGE',7,40,30)],tick=2000,boost=false;
const calls=[],events=[];
let defenses=['SHORT_TOWER'];
const find=id=>[...own,...enemies].find(u=>u.id===id);
const api={ObjectType:{Building:2,Vehicle:7,Infantry:3,Aircraft:1},QueueType:{Structures:0,Armory:1,Infantry:2,Vehicles:3,Aircrafts:4,Ships:5},
  ArmorType:{0:'None',3:'Light',5:'Heavy'},LandType:{Clear:0},
  units:r=>r==='self'?own:enemies,me:()=>({credits:900,power:{total:300,drain:50}}),tick:()=>tick,time:()=>tick/15,
  map:{size:()=>({width:80,height:80}),visible:()=>true,tile:(x,y)=>({rx:x,ry:y,landType:0})},
  canPlace:(_n,x,y)=>x>=20&&x<=39&&y>=20&&y<=42,
  production:{queues:()=>Array.from({length:6},(_,type)=>({type,size:0,maxSize:99,items:[]})),
    available:q=>q===undefined?[...defenses.map(name=>({name,type:2})),...['BASIC','MOBILE_COUNTER'].map(name=>({name,type:7}))]:
      (q===1?defenses:q===3?['BASIC','MOBILE_COUNTER']:[]).map(name=>({name,type:q===1?2:7}))},
  weaponVs:(a,b)=>{const u=find(a),t=find(b),r=catalog[u.name];const w=u.isDeployed?r.secondary:r.weapon;
    if(!w)return undefined;const d=Math.hypot(u.tile.rx-t.tile.rx,u.tile.ry-t.tile.ry),range=w.range+(boost&&u.name==='SHORT_TOWER'?3:0);
    return {distance:d,minRange:0,maxRange:range,inRange:d<=range};},
  inRange:(a,b)=>api.weaponVs(a,b)?.inRange??false,
  attack:(...a)=>calls.push(['attack',...a]),move:(...a)=>calls.push(['move',...a]),
  attackMove:(...a)=>calls.push(['attackMove',...a]),deploy:(...a)=>{calls.push(['deploy',...a]);return true;},
};
const memory=()=>({pressure:{since:0,lastThreatTick:1900},orders:new Map(),postureOrders:new Map(),specialOrders:new Map(),
  repairing:new Set(),lastMaintenance:tick,lastMicroReport:-1000});
let m=memory(),snap=collectState(api,catalog),groups=candidateGroups(api,catalog,snap,m);
assert.ok(snap.state.strategy.suppressed);
assert.equal(snap.state.strategy.rangeThreats[0].id,100,'range + 5 must not count as actual coverage');
assert.ok(!groups.defenses.actions.produce_SHORT_TOWER,'do not sell a short-range tower as a siege counter');
assert.equal(snap.state.strategy.investment.name,'MOBILE_COUNTER');
assert.ok(groups.vehicles.actions.produce_MOBILE_COUNTER,'start the effective counter without waiting for full price');
assert.ok(!groups.vehicles.actions.produce_BASIC,'reserve the counter budget instead of repeatedly buying the cheap tank');
assert.equal(snap.state.decisionReadiness.vehicles.priority,'counter_range');
assert.equal(snap.state.decisionReadiness.vehicles.waitingSupported,false);
const defend=groups.tactics.actions.defend_base;
assert.equal(defend.targetId,100);
assert.deepEqual([defend.x,defend.y],[40,30],'defend must target the attacker, not an intermediate rally point');
assert.equal(executeCandidate(api,defend,catalog).accepted,true);
assert.ok(calls.some(c=>c[0]==='attack'&&c[1].includes(9)&&c[2]===100));
assert.ok(!calls.some(c=>c[0]==='attackMove'));

enemies.push(unit(101,'BASIC',7,37,31));
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,m);
assert.ok(!groups.defenses.actions.produce_SHORT_TOWER,'a short-range escort must not make the tower a valid answer to the uncovered siege weapon');
assert.equal(snap.state.strategy.investment.name,'MOBILE_COUNTER');
enemies.pop();

defenses.push('LONG_TOWER');
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,m);
const site=groups.defenses.actions.produce_LONG_TOWER?.placement;
assert.ok(site,'a legal tower with enough range remains a valid option');
assert.ok(Math.hypot(site.x-40,site.y-30)<=12,'the actual proposed site must cover the attacker');
boost=true;
assert.ok(canFireAt(api,catalog,own.find(u=>u.id===8),enemies[0]),'use the public per-target elevation/range query for existing weapons');
snap=collectState(api,catalog);candidateGroups(api,catalog,snap,m);
assert.equal(snap.state.strategy.rangeThreats.length,0);
boost=false;

// A defending squad must close range, including after a target moves beyond the original mission point.
calls.length=0;m=memory();m.mission={...defend,ids:[9]};
enemies[0].tile={rx:43,ry:30};
maintainBattle(api,catalog,m,e=>events.push(e));
assert.ok(calls.some(c=>c[0]==='attack'&&c[2]===100));
assert.ok(events.some(e=>e.targetId===100&&e.inRange===false),'log actual closing-range orders');
enemies[0].tile={rx:78,ry:78};tick+=200;calls.length=0;
maintainBattle(api,catalog,m,e=>events.push(e));
assert.ok(calls.some(c=>c[0]==='move'&&c[1].includes(9)),'stop chasing when the enemy no longer threatens the base');
assert.ok(!calls.some(c=>c[0]==='attack'));
assert.equal(executeCandidate(api,defend,catalog).reason,'base_threat_changed');

// Deployed defenders need a confirmed undeploy before they can intercept a distant attacker.
enemies[0].tile={rx:40,ry:30};own.push({...unit(10,'FOOT',3,30,30),isDeployed:true});
calls.length=0;
const movement=executeCandidate(api,{...defend,ids:[10]},catalog);
assert.deepEqual(movement.undeployIds,[10]);
assert.ok(calls.some(c=>c[0]==='deploy'));
assert.ok(!calls.some(c=>c[0]==='attack'));
m=memory();m.mission={...defend,ids:[10]};m.postureOrders.set(10,tick);
maintainBattle(api,catalog,m,()=>{});
assert.equal(calls.filter(c=>c[0]==='deploy').length,1,'do not toggle posture again during the transition');
own.find(u=>u.id===10).isDeployed=false;tick+=30;calls.length=0;
maintainBattle(api,catalog,m,()=>{});
assert.ok(calls.some(c=>c[0]==='attack'&&c[1].includes(10)));

// Long-range weapons must not disappear behind fixed 10/18/22-tile cutoffs.
catalog.SIEGE.weapon.range=25;enemies[0].tile={rx:55,ry:30};
snap=collectState(api,catalog);candidateGroups(api,catalog,snap,m);
assert.equal(snap.state.baseUnderAttack,true);
catalog.MOBILE_COUNTER.weapon.range=14;own.push(unit(11,'MOBILE_COUNTER',7,42,30));
calls.length=0;m=memory();
maintainBattle(api,catalog,m,()=>{});
assert.ok(calls.some(c=>c[0]==='attack'&&c[1].includes(11)),'valid fire beyond ten tiles must be considered');
console.log('Range defense: real coverage, standoff budget, direct interception, undeploy, moving targets and pursuit limits passed');

// Occupying a distant civilian building must not move the economic base perimeter there.
const forwardBuilding={...unit(120,'YARD',2,70,70),garrison:{count:1,capacity:10,unitIds:[10]}};
const distantEnemy=unit(121,'BASIC',7,68,70);
enemies.push(distantEnemy);
assert.deepEqual(baseThreats(api,catalog,[own[0],forwardBuilding],[distantEnemy]),[],
  'a forward garrison skirmish must not indefinitely suppress the whole home economy');
distantEnemy.tile={rx:40,ry:30};
assert.equal(baseThreats(api,catalog,[own[0],forwardBuilding],[distantEnemy]).length,1,
  'the same unit approaching the actual base still triggers interception');
console.log('Base perimeter: forward garrisons do not replace core infrastructure');

// Battle 25: the first armed enemy was a building on an inaccessible lowland tile.
// Engaging mobile units must retain an object target; idle retries must not aim at occupied cells.
const remoteBuilding=unit(130,'SHORT_TOWER',2,70,70),remoteTank=unit(131,'BASIC',7,65,70);
// 0.6.0: engage_visible only offers enemies within 15 tiles of the troops, so the column stands nearby.
own=[own[0],...Array.from({length:8},(_,i)=>unit(200+i,'BASIC',7,55+i,62))];
enemies=[remoteBuilding,remoteTank];
m=memory();snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,m);
assert.equal(groups.tactics.actions.engage_visible.targetId,131,'engage mobile enemy, not first armed building');
assert.equal(groups.tactics.actions.assault_130.targetId,130,'buildings remain explicit assault choices');
calls.length=0;m.mission={...groups.tactics.actions.assault_130,ids:[200]};
maintainBattle(api,catalog,m,()=>{});
assert.ok(calls.some(c=>c[0]==='attack'&&c[1].includes(200)&&c[2]===130),
  'idle assault must retry the visible building object to let normal attack pathing choose range');
assert.ok(!calls.some(c=>c[0]==='attackMove'&&c[1].includes(200)),'do not downgrade a known object to its blocked cell');
console.log('Object missions: mobile engagement targets and object-preserving assault retries passed');

// Battle 40: an early infantry ID must not draw the entire tank force away from armor.
catalog.ANTI_ARMOR={category:'AFV',cost:800,weapon:{...weapon(10,80),verses:[0.1,0.1,0.1,1,1,1]}};
catalog.ANTI_FOOT={category:'Soldier',cost:200,weapon:{...weapon(10,40),verses:[1,1,1,0.1,0.1,0.1]}};
catalog.ENEMY_FOOT={armor:'none',weapon:weapon(5,20)};
catalog.ENEMY_TANK={armor:'heavy',weapon:weapon(5,60)};
const soft={...unit(301,'ENEMY_FOOT',3,65,70),armor:0,hitPoints:125};
const armor={...unit(302,'ENEMY_TANK',7,66,70),armor:5,hitPoints:300};
own=[unit(1,'YARD',2,30,30),...Array.from({length:8},(_,i)=>unit(400+i,'ANTI_ARMOR',7,55+i,64))];
enemies=[soft,armor];m=memory();snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,m);
assert.equal(groups.tactics.actions.engage_visible.targetId,armor.id,'aggregate weapon matchups select the armored threat, not the first enemy');
own[1].tile={rx:62,ry:70};own.push(unit(410,'ANTI_FOOT',3,62,70));
m.mission={mode:'attack',ids:[400,410],targetId:soft.id,x:65,y:70};calls.length=0;
maintainBattle(api,catalog,m,()=>{});
assert.ok(calls.some(c=>c[0]==='attack'&&c[1].includes(400)&&c[2]===armor.id),'a weak matchup cannot be rescued by the mission-target bonus');
assert.ok(calls.some(c=>c[0]==='attack'&&c[1].includes(410)&&c[2]===soft.id),'anti-infantry support still attacks infantry');
catalog.POSTURE={deployer:true,weapon:catalog.ANTI_FOOT.weapon,secondary:catalog.ANTI_ARMOR.weapon};
const posture=unit(420,'POSTURE',3,62,70);
assert.ok(combatTargetScore(api,catalog,posture,soft)>combatTargetScore(api,catalog,posture,armor));
posture.isDeployed=true;
assert.ok(combatTargetScore(api,catalog,posture,armor)>combatTargetScore(api,catalog,posture,soft),'target ranking uses only the deployed weapon');
catalog.AA={weapon:{...weapon(10,30),aa:true,ag:false}};
const escort=unit(430,'AA',7,62,70),flyer={...soft,id:303,zone:1};
assert.equal(combatTargetScore(api,catalog,escort,soft),0,'AA-only weapons cannot target ground');
assert.ok(combatTargetScore(api,catalog,escort,flyer)>0);
console.log('Combat targets: armor matchups, support roles, deployment and air/ground eligibility passed');
