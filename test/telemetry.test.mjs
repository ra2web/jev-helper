import test from 'node:test';
import assert from 'node:assert/strict';
import {summarize,recordObservation,HISTORY_LIMIT} from '../src/telemetry.mjs';
import {createObserver} from '../src/observer.mjs';
import {chartGeometry} from '../src/charts.mjs';
import {messages,t,errorText} from '../src/i18n.mjs';
import {validateSettings,publicSettings} from '../src/shared.mjs';
import fs from 'node:fs/promises';

test('telemetry preserves zeros, unknown values, visible counts and bounded position samples',()=>{
 const state={self:{credits:0,power:{total:0,drain:100}},ownArmyCount:0,visibleEnemyCount:40,visibleEnemies:Array.from({length:40},(_,i)=>({tile:{x:i,y:i}})),strategy:{critical:true,rangeThreats:[{name:'SREF',range:10}]},uncommittedCredits:0};
 const o=summarize(state,100);assert.equal(o.credits,0);assert.equal(o.freeCredits,0);assert.equal(o.health,null);assert.equal(o.gameSeconds,null);assert.equal(o.threat,'critical');assert.equal(o.enemyPoints.length,24);assert.equal(o.visibleEnemies,40);assert.equal(o.power.total,0);
 assert.equal(summarize({self:{credits:NaN}}).credits,null);
});
test('sampling survives frequent reads, caps history, resets on clock rollback and does not alter decisions',()=>{
 let s={decisions:7};
 for(let i=0;i<1400;i++)s=recordObservation(s,summarize({tick:i,gameSeconds:i/15,self:{credits:1000-i}},i*1000),i*1000);
 assert.equal(s.decisions,7);assert.ok(s.history.length<=HISTORY_LIMIT&&s.history.length>HISTORY_LIMIT/2,'bounded but not starved');assert.ok(s.history.every((p,i)=>i===0||p.at-s.history[i-1].at>=2000));
 assert.equal(s.history[0].at,0,'the first sample survives thinning');assert.ok(1399000-s.history.at(-1).at<s.sampleMs,'the newest sample is at most one interval old');assert.ok(s.sampleMs>=8000,'the interval grew as the buffer filled');
 assert.equal(s.observation.credits,-399);assert.equal(s.history.at(-1).decisions,7);
 s=recordObservation(s,summarize({gameSeconds:0,self:{credits:10000}}),2000000);assert.equal(s.history.length,1);assert.equal(s.credits,10000);
});
test('readonly observer works without attaching a player, calls no actions and detects new matches',()=>{
 let tick=100,api,id=0;
 const make=()=>({me:()=>({combatant:true,credits:1200,power:{total:200,drain:50}}),tick:()=>tick,time:()=>tick/15,units:()=>[],ObjectType:{Building:2},production:{queues:()=>[],available:()=>[]},order:()=>assert.fail('observer issued an order'),deploy:()=>assert.fail('observer deployed')});
 api=make();const observe=createObserver(()=>api,()=>`battle-${++id}`);
 const a=observe();assert.equal(a.available,true);assert.equal(a.snapshot.credits,1200);assert.equal(a.snapshot.threat,'clear');assert.equal(observe().battleId,a.battleId);
 tick=1;assert.notEqual(observe().battleId,a.battleId);const b=observe();api=make();assert.notEqual(observe().battleId,b.battleId);
 api.me=()=>({combatant:true,isObserver:true});assert.equal(observe().available,false);
 api=undefined;assert.deepEqual(observe(),{available:false});
});
test('chart coordinates handle empty, constant-zero, negative values and missing data',()=>{
 const empty=chartGeometry([],['credits']);assert.equal(empty.max,1);
 const g=chartGeometry([{at:100,credits:0},{at:2100,credits:-100},{at:4100,credits:null},{at:NaN,credits:50}],['credits']);
 assert.equal(g.data.length,3);assert.equal(g.min,-100);assert.ok(Number.isFinite(g.y(0)));assert.equal(g.x(g.data[0]),38);assert.equal(g.x(g.data.at(-1)),328);
 assert.equal(g.gapLimit,10000);assert.equal(chartGeometry(Array.from({length:10},(_,i)=>({at:i*30000,credits:i})),['credits']).gapLimit,120000,'thinned long matches still draw as a line');
});
test('all popup/help text keys have both languages; English brand and settings persist without leaking the key',async()=>{
 for(const [key,pair]of Object.entries(messages)){assert.equal(pair.length,2,key);assert.ok(pair.every(v=>typeof v==='string'&&v.length),key);assert.doesNotMatch(pair[1],/[\u3400-\u9fff]/,key);}
 for(const file of ['public/popup.html','public/help.html','public/dashboard.html'])for(const match of (await fs.readFile(file,'utf8')).matchAll(/data-i18n="([^"]+)"/g))assert.ok(messages[match[1]],match[1]);
 assert.match(t('en','brand'),/WannaFire/);assert.equal(t('en','rangeWarning',{n:2}),'Threats beyond base defensive coverage: 2.');
 const settings=validateSettings({language:'en',apiKey:'test-secret'});assert.equal(publicSettings(settings).language,'en');assert.equal(publicSettings(settings).apiKey,undefined);
 assert.match(errorText('en','Jev 返回 HTTP 402，请检查账户额度或计费状态。'),/billing/);
});
