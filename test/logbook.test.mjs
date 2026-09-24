import test from 'node:test';
import assert from 'node:assert/strict';
import {decisionEntry,eventEntry,appendEntries,logStats,stateSummary,LOG_MAX_ENTRIES,LOG_MAX_CHARS} from '../src/logbook.mjs';

const state={tick:5400,gameSeconds:360,self:{credits:8450,power:{total:500,drain:375}},uncommittedCredits:6650,committedCredits:1800,ownArmyCount:18,mobileTankCount:8,antiAirCount:4,harvesters:3,averageArmyHealth:.86,visibleEnemyCount:9,nearbyEnemyCount:3,baseUnderAttack:true,queues:[{type:0,items:[{name:'GATECH',quantity:1}]}],inventory:{MTNK:{count:8,name:'灰熊坦克'}},army:Array.from({length:24},(_,i)=>({id:i,tile:{rx:i,ry:i}})),visibleEnemies:[{id:1,tile:{rx:1,ry:1}}],strategy:{investment:{category:'construction',name:'GATECH'}}};
const questions={construction:{type:'choice',instructions:'x'.repeat(1000),criteria:{wait:'Wait only if unnecessary.',produce_GAPOWR:'y'.repeat(500)}},tactics:{type:'choice',instructions:'Keep a mission',criteria:{wait:'Wait',attack_enemy_base:'Attack'}}};
const answers={construction:{type:'choice',choice:'wait',confidence:.39,probabilities:{wait:.72,produce_GAPOWR:.28}},tactics:{type:'choice',choice:'attack_enemy_base',confidence:.99,probabilities:{attack_enemy_base:1,wait:0}}};

test('decision entries keep the question, the answer and a numeric state summary, never unit lists or secrets',()=>{
  const e=decisionEntry({at:1,tick:5400,provider:'local',model:'laya-multilingual-mlx',latencyMs:181,usage:{input_tokens:900},state:{...state,apiKey:'leak'},questions,answers});
  assert.equal(e.kind,'decision');assert.equal(e.state.credits,8450);assert.equal(e.state.army,18);assert.equal(e.state.baseUnderAttack,true);assert.deepEqual(e.state.inventory,{MTNK:8});
  assert.equal(e.groups.construction.choice,'wait');assert.equal(e.groups.construction.optionCount,2);assert.equal(e.groups.construction.instructions.length,400);assert.equal(e.groups.construction.options.produce_GAPOWR.length,240);
  assert.equal(e.groups.tactics.probabilities.attack_enemy_base,1);
  const json=JSON.stringify(e);assert.doesNotMatch(json,/leak|"tile"|rx/);assert.ok(json.length<3000);
  assert.equal(stateSummary({}).credits,null);assert.deepEqual(stateSummary({}).queues,[]);
});
test('player events are reduced to typed records and observations are dropped',()=>{
  const a=eventEntry({kind:'action',tick:10,question:'vehicles',choice:'produce_MTNK',accepted:true,action:{type:'produce',name:'MTNK',cost:700},confidence:.8,latencyMs:150,ageTicks:2},5);
  assert.deepEqual(a,{at:5,kind:'action',tick:10,question:'vehicles',choice:'produce_MTNK',accepted:true,reason:'',actionType:'produce',actionName:'MTNK',cost:700,confidence:.8,latencyMs:150,ageTicks:2});
  assert.equal(eventEntry({kind:'action',choice:'wait',accepted:false,reason:'wait',action:{type:'wait'}},1).reason,'wait');
  assert.equal(eventEntry({kind:'observation',state:{}},1),null);assert.equal(eventEntry({kind:'stop',reason:'battle_ended'},1).reason,'battle_ended');
  assert.equal(eventEntry({kind:'error',message:'m'.repeat(500)},1).message.length,240);assert.equal(eventEntry({kind:'place',name:'GAPOWR',purpose:'base_development'},1).text,'base_development');
});
test('the log is bounded by entry count and by serialized size',()=>{
  const many=appendEntries([],Array.from({length:LOG_MAX_ENTRIES+50},(_,i)=>({at:i,kind:'action'})));
  assert.equal(many.length,LOG_MAX_ENTRIES);assert.equal(many[0].at,50);
  const big=appendEntries([],Array.from({length:400},(_,i)=>({at:i,kind:'decision',pad:'x'.repeat(20000)})));
  assert.ok(JSON.stringify(big).length<=LOG_MAX_CHARS);assert.ok(big.length<400);assert.equal(big.at(-1).at,399);
});
test('statistics count decisions, wait rates per group, accepted and skipped actions and failures',()=>{
  const entries=[
    {at:1,kind:'session',event:'start'},{at:1,kind:'start',tick:1},
    decisionEntry({at:2,tick:1,provider:'local',model:'laya',latencyMs:100,usage:{},state,questions,answers}),
    decisionEntry({at:3,tick:2,provider:'local',model:'laya',latencyMs:300,usage:{},state,questions,answers:{...answers,construction:{...answers.construction,choice:'produce_GAPOWR'}}}),
    {at:4,kind:'action',question:'construction',choice:'produce_GAPOWR',accepted:true,actionType:'produce',actionName:'GAPOWR'},
    {at:5,kind:'action',question:'tactics',choice:'attack_enemy_base',accepted:false,reason:'enemy_no_longer_visible',actionType:'attack'},
    {at:6,kind:'action',question:'vehicles',choice:'wait',accepted:false,reason:'wait',actionType:'wait'},
    {at:7,kind:'failure',error:'timeout'},{at:8,kind:'stale'},{at:9,kind:'outcome',result:'victory'},
  ];
  const s=logStats(entries);
  assert.equal(s.entries,entries.length);assert.equal(s.sessions,1);assert.equal(s.decisions,2);assert.equal(s.failures,1);assert.equal(s.stale,1);assert.equal(s.latency.avg,200);assert.equal(s.latency.max,300);
  assert.equal(s.groups.construction.asked,2);assert.equal(s.groups.construction.waits,1);assert.equal(s.groups.construction.waitRate,50);assert.equal(s.groups.construction.avgOptions,2);assert.equal(s.groups.tactics.waitRate,0);
  assert.deepEqual(s.actions,{total:3,accepted:1,skipped:1,waits:1,byType:{produce:1},skippedReasons:{enemy_no_longer_visible:1},acceptedProduce:{GAPOWR:1}});
  assert.deepEqual(s.outcomes,{victory:1});assert.deepEqual(s.providers,{local:2});
  assert.equal(logStats([]).decisions,0);assert.equal(logStats([null,{}]).entries,2);
});
