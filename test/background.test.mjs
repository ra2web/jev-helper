import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackground} from '../src/background-core.mjs';
import {DEFAULTS} from '../src/shared.mjs';

const extension={id:'test-extension',url:'chrome-extension://test-extension/popup.html'};
const sender={id:'test-extension',frameId:0,documentId:'document-1',url:'https://staging.wangerhuoda.com/',tab:{id:7}};
const body={state:{tick:100},groups:{tactics:{instructions:'Choose',criteria:{wait:'Wait',attack:'Attack'}}}};
function mockChrome(shared){
  const data=shared??{local:{settings:{...DEFAULTS,apiKey:'test-only-secret'}},session:{}};
  const messages=[],scripts=[],listeners={};
  const area=name=>({setAccessLevel:async x=>{listeners[name+'Access']=x;},get:async key=>structuredClone(key===null?data[name]:{[key]:data[name][key]}),set:async values=>Object.assign(data[name],structuredClone(values)),remove:async key=>{for(const k of Array.isArray(key)?key:[key])delete data[name][k];}});
  const c={storage:{local:area('local'),session:area('session')},runtime:{id:'test-extension',getURL:p=>'chrome-extension://test-extension/'+p,onMessage:{addListener:fn=>{listeners.message=fn;}}},permissions:{contains:async()=>true},tabs:{get:async()=>({id:7,url:sender.url,title:'王二火大'}),query:async()=>[{id:7,url:sender.url}],sendMessage:async(id,m)=>{messages.push(m);return {ok:true};},onUpdated:{addListener:fn=>{listeners.updated=fn;}},onRemoved:{addListener:fn=>{listeners.removed=fn;}}},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}},scripting:{executeScript:async x=>{scripts.push(x);return [{documentId:sender.documentId,result:x.args?.[0]==='start'?{running:true}:x.args?.[0]==='stop'?{running:false}:{available:true,running:!!data.session['session:7']?.running}}];}}};
  return {c,data,messages,scripts,listeners};
}
const answer=()=>new Response(JSON.stringify({answers:{tactics:{type:'choice',choice:'attack',confidence:.8}},model:'jev-test',usage:{input_tokens:40,output_tokens:8}}));
async function setup(fetchImpl,shared){const mock=mockChrome(shared);const app=createBackground(mock.c,{fetchImpl,uuid:()=>crypto.randomUUID()});await app.ready;await app.handle({type:'START',tabId:7},extension);const s=await app.getSession(7);return {...mock,app,s,request:{type:'DECIDE',token:s.token,body}};}

test('settings and key operations reject content scripts; only the popup sees the key, never injection or status',async()=>{
  const x=await setup(async()=>answer());
  assert.equal(x.listeners.localAccess.accessLevel,'TRUSTED_CONTEXTS');
  for(const type of ['GET_SETTINGS','SAVE_SETTINGS','CLEAR_KEY','START'])await assert.rejects(x.app.handle({type,tabId:7},sender));
  const settings=await x.app.handle({type:'GET_SETTINGS'},extension);assert.equal(settings.hasKey,true);assert.equal(settings.apiKey,'test-only-secret');assert.equal(settings.localKey,'');
  const status=await x.app.handle({type:'GET_STATUS',tabId:7},extension);assert.equal(status.token,undefined);
  assert.doesNotMatch(JSON.stringify([x.messages,x.scripts]),/test-only-secret/);
});
test('background pins configured endpoint and authenticates tab, origin, frame, document and session',async()=>{
  let request;const x=await setup(async(url,options)=>{request={url,options};return answer();});
  for(const other of [{...sender,documentId:'old-document'},{...sender,frameId:1},{...sender,url:'https://evil.test/'},{...sender,tab:{id:8}}])await assert.rejects(x.app.handle(x.request,other));
  await assert.rejects(x.app.handle({...x.request,token:'wrong'},sender));
  const result=await x.app.handle({...x.request,url:'https://evil.test',body:{...body,url:'https://evil.test'}},sender);
  assert.equal(request.url,'https://api.typesafe.ai/v1/systemone');assert.equal(request.options.headers.Authorization,'Bearer test-only-secret');
  assert.equal(x.scripts.find(s=>s.args?.[0]==='start').args[1].objective,'','no objective by default');
  assert.equal(request.options.redirect,'error');assert.equal(result.answers.tactics.choice,'attack');
  assert.equal(JSON.parse(request.options.body).questions.tactics.type,'choice');
});
test('simultaneous requests are refused and stop rejects a late response',async()=>{
  let release,signal;const x=await setup(async(_url,options)=>{signal=options.signal;return new Promise(resolve=>{release=()=>resolve(answer());});});
  const first=x.app.handle(x.request,sender);while(!release)await new Promise(r=>setTimeout(r,0));
  await assert.rejects(x.app.handle(x.request,sender),/尚未完成/);
  await x.app.handle({type:'STOP',tabId:7},extension);assert.equal(signal.aborted,true);release();
  await assert.rejects(first,/已停止/);assert.equal((await x.app.getSession(7)).decisions,0);
});
test('a 402 stops immediately with a useful error and prevents further upstream requests',async()=>{
  let count=0;const x=await setup(async()=>{count++;return new Response('',{status:402});});
  await assert.rejects(x.app.handle(x.request,sender),/HTTP 402/);
  const s=await x.app.getSession(7);assert.equal(s.running,false);assert.equal(s.reason,'http_402');assert.equal(s.failures,1);
  await assert.rejects(x.app.handle(x.request,sender));assert.equal(count,1);
});
test('session budget survives worker restart and observations cannot overwrite counters',async()=>{
  const x=await setup(async()=>answer());x.data.session['session:7'].maxDecisions=1;
  await Promise.all([x.app.handle(x.request,sender),x.app.handle({type:'EVENT',token:x.s.token,event:{kind:'observation',tick:101,credits:200}},sender)]);
  assert.equal((await x.app.getSession(7)).requests,1);assert.equal((await x.app.getSession(7)).credits,200);
  const next=mockChrome(x.data),restarted=createBackground(next.c,{fetchImpl:async()=>{throw Error('must not run');}});
  await assert.rejects(restarted.handle(x.request,sender),/上限/);
  assert.equal((await restarted.getSession(7)).running,false);
  assert.equal((await restarted.getSession(7)).reason,'decision_budget');
});
test('saving another API origin requires a new key; changing credentials stops the old session',async()=>{
  const x=await setup(async()=>answer());
  await assert.rejects(x.app.handle({type:'SAVE_SETTINGS',settings:{apiBase:'https://custom.example/v1'}},extension),/重新输入/);
  // The form resends the displayed (old) key: that is not a key for the new host either.
  await assert.rejects(x.app.handle({type:'SAVE_SETTINGS',settings:{apiBase:'https://custom.example/v1',apiKey:'test-only-secret'}},extension),/重新输入/);
  assert.equal((await x.app.getSession(7)).running,true);
  const saved=await x.app.handle({type:'SAVE_SETTINGS',settings:{apiBase:'https://custom.example/v1',apiKey:'custom-test-key'}},extension);
  assert.equal((await x.app.getSession(7)).running,false);assert.equal(x.data.local.settings.apiKey,'custom-test-key');assert.equal(saved.apiKey,'custom-test-key');
  // What the form sends is what is stored: an omitted field keeps the key, an empty string clears it.
  await x.app.handle({type:'SAVE_SETTINGS',settings:{maxDecisions:5}},extension);assert.equal(x.data.local.settings.apiKey,'custom-test-key');
  await x.app.handle({type:'SAVE_SETTINGS',settings:{localKey:'  lan-token '}},extension);assert.equal(x.data.local.settings.localKey,'lan-token');
  await x.app.handle({type:'SAVE_SETTINGS',settings:{localKey:''}},extension);assert.equal(x.data.local.settings.localKey,'');assert.equal(x.data.local.settings.apiKey,'custom-test-key');
});
test('invalid candidates never reach the executor; navigation revokes the session',async()=>{
  const x=await setup(async()=>new Response(JSON.stringify({answers:{tactics:{type:'choice',choice:'not-supplied'}}})));
  await assert.rejects(x.app.handle(x.request,sender),/未提供/);
  assert.equal((await x.app.getSession(7)).decisions,0);
  x.listeners.updated(7,{status:'loading'});await new Promise(r=>setTimeout(r,0));
  await assert.rejects(x.app.handle(x.request,sender),/失效/);
});
test('connection probe is trusted-only, bounded, and does not create a game session',async()=>{
  const x=mockChrome();let calls=0,body;
  const app=createBackground(x.c,{fetchImpl:async(url,options)=>{calls++;body=JSON.parse(options.body);assert.equal(url,'https://api.typesafe.ai/v1/systemone');return new Response(JSON.stringify({answers:{connection:{type:'choice',choice:'ok'}}}));}});
  await assert.rejects(app.handle({type:'TEST_CONNECTION'},sender));assert.equal(calls,0);
  const result=await app.handle({type:'TEST_CONNECTION'},extension);
  assert.ok(result.latencyMs>=0);assert.equal(calls,1);assert.equal(body.state.purpose,'extension_connection_check');
  assert.deepEqual(Object.keys(body.questions.connection.criteria),['ok']);assert.equal(await app.getSession(7),undefined);
  const failure=createBackground(x.c,{fetchImpl:async()=>new Response('do-not-echo-upstream-body',{status:402})});
  await assert.rejects(failure.handle({type:'TEST_CONNECTION'},extension),/HTTP 402/);
});

test('popup monitoring is read-only and bounded, persists across worker restart, and detects a new battle',async()=>{
 const x=mockChrome();let upstream=0,battleId='battle-A',available=true;
 const snapshot={at:0,tick:100,gameSeconds:10,credits:5000,freeCredits:4000};
 const original=x.c.scripting.executeScript;
 x.c.scripting.executeScript=async args=>args.args?.[0]==='observe'?[{documentId:sender.documentId,result:{available,battleId,snapshot}}]:original(args);
 const app=createBackground(x.c,{fetchImpl:async()=>{upstream++;throw Error('monitor must not fetch');}});
 await assert.rejects(app.handle({type:'GET_STATUS',tabId:7},sender));
 let status=await app.handle({type:'GET_STATUS',tabId:7},extension);
 assert.equal(status.running,false);assert.equal(status.liveObservation,true);assert.equal(status.observation.credits,5000);assert.equal(status.history.length,1);assert.equal(upstream,0);
 const restarted=createBackground(x.c,{fetchImpl:async()=>assert.fail('monitor fetched')});
 status=await restarted.handle({type:'GET_STATUS',tabId:7},extension);assert.equal(status.history.length,1);
 available=false;status=await app.handle({type:'GET_STATUS',tabId:7},extension);assert.equal(status.liveObservation,false);assert.equal(status.observation.credits,5000);
 available=true;battleId='battle-B';snapshot.gameSeconds=0;status=await app.handle({type:'GET_STATUS',tabId:7},extension);assert.equal(status.history.length,1);assert.equal(status.decisions,0);
 assert.ok(!x.scripts.some(s=>s.args?.[0]==='start'));assert.equal(upstream,0);
});
test('language changes preserve a running session and credentials and are trusted-only',async()=>{
 const x=await setup(async()=>answer());
 await assert.rejects(x.app.handle({type:'SET_LANGUAGE',language:'en'},sender));
 const result=await x.app.handle({type:'SET_LANGUAGE',language:'en'},extension);
 assert.deepEqual(result,{language:'en'});assert.equal(x.data.local.settings.apiKey,'test-only-secret');assert.equal((await x.app.getSession(7)).running,true);
 assert.equal(x.messages.at(-1).language,'en');assert.doesNotMatch(JSON.stringify(result),/test-only-secret/);
});

test('overlay status is read-only, document-scoped and never exposes credentials or raw events',async()=>{
 const x=await setup(async()=>assert.fail('overlay must not request the model'));
 x.data.session['session:7']={...x.data.session['session:7'],credits:4200,events:[{text:'private payload'}]};
 const count=x.scripts.length;
 const status=await x.app.handle({type:'OVERLAY_STATUS',tabId:999},sender);
 assert.equal(status.running,true);assert.equal(status.credits,4200);assert.equal(status.showOverlay,true);
 assert.doesNotMatch(JSON.stringify(status),/test-only-secret|token|documentId|origin|events|private payload|apiBase|model/);
 assert.ok(x.scripts.slice(count).every(s=>s.args?.[0]==='status'));
 for(const other of [{...sender,frameId:1},{...sender,id:'other-extension'},{...sender,url:'https://evil.test/'},extension])await assert.rejects(x.app.handle({type:'OVERLAY_STATUS'},other));
 for(const other of [{...sender,documentId:'old-document'},{...sender,tab:{id:8}},{...sender,url:'https://ra2web.github.io/'}])assert.equal((await x.app.handle({type:'OVERLAY_STATUS'},other)).running,false);
 await x.app.handle({type:'HOTKEY_TOGGLE'},sender);assert.equal(x.messages.at(-1).type,'OVERLAY_CHANGED');assert.equal(x.messages.at(-1).running,false);
 assert.equal((await x.app.handle({type:'OVERLAY_STATUS'},sender)).running,false);
 await x.app.handle({type:'HOTKEY_TOGGLE'},sender);assert.equal(x.messages.at(-1).running,true);
});

test('display preference applies immediately, persists, and never stops or starts control',async()=>{
 const x=await setup(async()=>answer());const original=await x.app.getSession(7);
 await assert.rejects(x.app.handle({type:'SET_OVERLAY',showOverlay:false},sender));
 await x.app.handle({type:'SET_OVERLAY',showOverlay:false},extension);
 assert.equal(x.messages.at(-1).showOverlay,false);assert.deepEqual(await x.app.getSession(7),original);
 assert.equal((await x.app.handle({type:'OVERLAY_STATUS'},sender)).running,false);
 const restarted=createBackground(x.c,{fetchImpl:async()=>assert.fail('must not fetch')});
 assert.equal((await restarted.handle({type:'GET_SETTINGS'},extension)).showOverlay,false);
 await restarted.handle({type:'SET_OVERLAY',showOverlay:true},extension);assert.equal((await restarted.getSession(7)).running,true);
 assert.equal((await restarted.handle({type:'OVERLAY_STATUS'},sender)).running,true);
 await restarted.handle({type:'EVENT',token:original.token,event:{kind:'stop',reason:'battle_ended'}},sender);
 assert.equal(x.messages.at(-1).running,false);
 await restarted.handle({type:'SET_OVERLAY',showOverlay:true},extension);assert.equal((await restarted.getSession(7)).running,false);
 assert.equal((await restarted.handle({type:'OVERLAY_STATUS'},sender)).running,false);
});

test('local source: no key required, no Authorization header, local endpoint, and switching sources stops autopilot',async()=>{
  let request;const local={local:{settings:{...DEFAULTS,provider:'local',apiKey:'',localKey:''}},session:{}};
  const x=await setup(async(url,options)=>{request={url,options};return new Response(JSON.stringify({answers:{tactics:{type:'choice',choice:'wait',probabilities:{wait:.7,attack:.3}}},model:'laya-multilingual-mlx',usage:{input_tokens:900,output_tokens:0}}));},local);
  assert.equal(x.s.provider,'local');assert.equal(x.s.providerName,'Laya');
  const result=await x.app.handle(x.request,sender);
  assert.equal(request.url,'http://127.0.0.1:8742/v1/systemone');assert.equal(request.options.headers.Authorization,undefined);assert.equal(request.options.redirect,'error');
  assert.equal(JSON.parse(request.options.body).model,'laya');assert.equal(result.answers.tactics.choice,'wait');
  const s=await x.app.getSession(7);assert.equal(s.decisions,1);assert.equal(s.model,'laya-multilingual-mlx');assert.equal(s.inputTokens,900);
  const status=await x.app.handle({type:'GET_STATUS',tabId:7},extension);assert.equal(status.providerName,'Laya');assert.equal(status.model,'laya-multilingual-mlx');
  const overlay=await x.app.handle({type:'OVERLAY_STATUS'},sender);assert.equal(overlay.providerName,'Laya');assert.doesNotMatch(JSON.stringify(overlay),/8742|apiBase|localBase/);
  // The optional local token is sent when configured, and clearing it never touches the Jev key.
  await x.app.handle({type:'SAVE_SETTINGS',settings:{provider:'local',localKey:'local-token',apiKey:'jev-secret'}},extension);
  assert.equal((await x.app.getSession(7)).running,false);assert.equal((await x.app.getSession(7)).reason,'settings_changed');
  await x.app.handle({type:'START',tabId:7},extension);const token=(await x.app.getSession(7)).token;
  await x.app.handle({...x.request,token},sender);assert.equal(request.options.headers.Authorization,'Bearer local-token');
  await x.app.handle({type:'CLEAR_KEY',provider:'local'},extension);assert.equal(x.data.local.settings.localKey,'');assert.equal(x.data.local.settings.apiKey,'jev-secret');
  await x.app.handle({type:'START',tabId:7},extension);assert.equal((await x.app.getSession(7)).running,true);
  await x.app.handle({type:'SAVE_SETTINGS',settings:{provider:'jev'}},extension);
  assert.equal((await x.app.getSession(7)).running,false);
  const settings=await x.app.handle({type:'GET_SETTINGS'},extension);assert.equal(settings.provider,'jev');assert.equal(settings.localBase,'http://127.0.0.1:8742/v1');assert.equal(settings.apiKey,'jev-secret');assert.equal(settings.localKey,'');assert.doesNotMatch(JSON.stringify(settings),/local-token/);
});
test('the Jev source still requires a key and the connection probe follows the selected source',async()=>{
  const x=mockChrome({local:{settings:{...DEFAULTS,apiKey:''}},session:{}});
  const urls=[];const app=createBackground(x.c,{fetchImpl:async(url,options)=>{urls.push([url,options.headers.Authorization]);return new Response(JSON.stringify({answers:{connection:{type:'choice',choice:'ok'}},model:'laya-multilingual-mlx'}));}});
  await assert.rejects(app.handle({type:'START',tabId:7},extension),/JEV 密钥/);
  await assert.rejects(app.handle({type:'TEST_CONNECTION'},extension),/JEV 密钥/);assert.equal(urls.length,0);
  await app.handle({type:'SAVE_SETTINGS',settings:{provider:'local'}},extension);
  const probe=await app.handle({type:'TEST_CONNECTION'},extension);
  assert.deepEqual(urls,[['http://127.0.0.1:8742/v1/systemone',undefined]]);assert.equal(probe.providerName,'Laya');assert.equal(probe.model,'laya-multilingual-mlx');
  const down=createBackground(x.c,{fetchImpl:async()=>{throw new TypeError('Failed to fetch');}});
  await assert.rejects(down.handle({type:'TEST_CONNECTION'},extension),/Error: Laya 连接失败/);
  await app.handle({type:'START',tabId:7},extension);const s=await app.getSession(7);
  const failing=createBackground(x.c,{fetchImpl:async()=>new Response('',{status:503})});
  await assert.rejects(failing.handle({type:'DECIDE',token:s.token,body},sender),/Error: Laya 请求失败（HTTP 503）/);
  assert.equal((await failing.getSession(7)).running,true);assert.equal((await failing.getSession(7)).failures,1);
});

test('decision log records questions, answers, actions and failures; export is trusted-only and carries no secrets',async()=>{
  let fail=false;const x=await setup(async()=>fail?new Response('',{status:503}):answer());
  await x.app.handle(x.request,sender);
  await x.app.handle({type:'EVENT',token:x.s.token,event:{kind:'action',tick:101,question:'tactics',choice:'attack',accepted:true,action:{type:'attack',ids:[1]},confidence:.8}},sender);
  await x.app.handle({type:'EVENT',token:x.s.token,event:{kind:'observation',tick:102,credits:900,state:{self:{credits:900}}}},sender);
  fail=true;await assert.rejects(x.app.handle(x.request,sender));
  await assert.rejects(x.app.handle({type:'LOG_EXPORT'},sender));await assert.rejects(x.app.handle({type:'LOG_STATS'},sender));await assert.rejects(x.app.handle({type:'LOG_CLEAR'},sender));
  const out=await x.app.handle({type:'LOG_EXPORT'},extension);
  const kinds=out.entries.map(e=>e.kind);assert.deepEqual(kinds,['session','decision','action','failure']);
  assert.equal(out.entries[1].groups.tactics.choice,'attack');assert.equal(out.entries[1].groups.tactics.options.attack,'Attack');assert.equal(out.entries[1].state.tick,100);assert.equal(out.entries[1].provider,'jev');
  assert.equal(out.entries[3].status,503);assert.equal(out.stats.decisions,1);assert.equal(out.stats.failures,1);assert.equal(out.stats.actions.accepted,1);
  assert.doesNotMatch(JSON.stringify(out),/test-only-secret|token|documentId/);
  assert.equal(x.data.local.log.length,4);
  const stats=await x.app.handle({type:'LOG_STATS'},extension);assert.equal(stats.stats.entries,4);assert.ok(stats.chars>0);
  const restarted=createBackground(x.c,{fetchImpl:async()=>answer()});
  assert.equal((await restarted.handle({type:'LOG_STATS'},extension)).stats.entries,4);
  await restarted.handle({type:'LOG_CLEAR'},extension);assert.equal((await restarted.handle({type:'LOG_STATS'},extension)).stats.entries,0);assert.equal(x.data.local.log,undefined);
});

test('the mission objective is saved, echoed to the popup and handed to the player on start',async()=>{
  const x=mockChrome();const app=createBackground(x.c,{fetchImpl:async()=>answer()});
  const saved=await app.handle({type:'SAVE_SETTINGS',settings:{objective:'  Destroy the   Pentagon\n in the north-east  '}},extension);
  assert.equal(saved.objective,'Destroy the Pentagon in the north-east');
  await assert.rejects(app.handle({type:'SAVE_SETTINGS',settings:{objective:'x'.repeat(301)}},extension),/300/);
  await app.handle({type:'START',tabId:7},extension);
  assert.equal(x.scripts.find(s=>s.args?.[0]==='start').args[1].objective,'Destroy the Pentagon in the north-east');
  assert.equal((await app.handle({type:'OVERLAY_STATUS'},sender)).objective,undefined,'content scripts do not receive settings text');
});

test('a finished autopilot session becomes one match record with duration, counters, credit curve and statistics',async()=>{
  const x=await setup(async()=>answer());
  await x.app.handle(x.request,sender);
  await x.app.handle({type:'EVENT',token:x.s.token,event:{kind:'observation',tick:101,credits:5000,state:{self:{credits:5000},ownArmyCount:6,gameSeconds:10,uncommittedCredits:4000}}},sender);
  await x.app.handle({type:'EVENT',token:x.s.token,event:{kind:'action',tick:102,question:'tactics',choice:'attack',accepted:true,action:{type:'attack'}}},sender);
  await x.app.handle({type:'EVENT',token:x.s.token,event:{kind:'outcome',result:'victory',tick:103}},sender);
  await x.app.handle({type:'EVENT',token:x.s.token,event:{kind:'stop',reason:'victory'}},sender);
  for(const type of ['MATCHES_LIST','MATCH_GET','MATCHES_CLEAR'])await assert.rejects(x.app.handle({type},sender));
  const {matches}=await x.app.handle({type:'MATCHES_LIST'},extension);
  assert.equal(matches.length,1);const m=matches[0];
  assert.equal(m.decisions,1);assert.equal(m.requests,1);assert.equal(m.outcome,'victory');assert.equal(m.reason,'victory');assert.equal(m.providerName,'Jev');assert.equal(m.acceptedActions,1);assert.equal(m.armyMax,6);
  assert.equal(m.credits.end,5000);assert.equal(m.samples,1);assert.equal(m.history,undefined);assert.ok(m.durationMs>=0);assert.equal(m.groups.tactics.asked,1);assert.equal(m.produced.attack,undefined);
  const full=await x.app.handle({type:'MATCH_GET',id:m.id},extension);assert.equal(full.history.length,1);assert.equal(full.history[0].credits,5000);
  assert.doesNotMatch(JSON.stringify(full),/test-only-secret|token|documentId/);
  // Stopping again (manual, hotkey, page reload) never duplicates the record.
  await x.app.handle({type:'STOP',tabId:7},extension);
  assert.equal((await x.app.handle({type:'MATCHES_LIST'},extension)).matches.length,1);
  // A second session produces a second, newest-first record; monitoring without autopilot produces none.
  await x.app.handle({type:'START',tabId:7},extension);await x.app.handle({type:'STOP',tabId:7},extension);
  const list=await x.app.handle({type:'MATCHES_LIST'},extension);assert.equal(list.matches.length,2);assert.ok(list.matches[0].startedAt>=list.matches[1].startedAt);assert.equal(list.matches[0].reason,'manual');
  await assert.rejects(x.app.handle({type:'MATCH_GET',id:'nope'},extension));
  await x.app.handle({type:'MATCHES_CLEAR'},extension);assert.equal((await x.app.handle({type:'MATCHES_LIST'},extension)).matches.length,0);
});

test('a match that ended undefeated is labelled ended, and the popup can mark victory or defeat',async()=>{
  const x=await setup(async()=>answer());
  await x.app.handle({type:'EVENT',token:x.s.token,event:{kind:'observation',tick:101,credits:5000,state:{self:{credits:5000},ownArmyCount:6,gameSeconds:10},ledger:{ownUnits:6,ownBuildings:4,enemyUnits:2,enemyBuildings:1,ownBuilt:3,ownUnitsLost:1,ownBuildingsLost:0,enemyUnitsDestroyed:5,enemyBuildingsDestroyed:2}}},sender);
  await x.app.handle({type:'EVENT',token:x.s.token,event:{kind:'stop',reason:'battle_ended'}},sender);
  const {matches}=await x.app.handle({type:'MATCHES_LIST'},extension);
  assert.equal(matches[0].outcome,'ended');assert.equal(matches[0].ledger.enemyUnitsDestroyed,5);
  const full=await x.app.handle({type:'MATCH_GET',id:matches[0].id},extension);
  assert.equal(full.history[0].ownUnits,6);assert.equal(full.history[0].ownLost,1);assert.equal(full.history[0].enemyDestroyed,7);
  await assert.rejects(x.app.handle({type:'MATCH_SET_OUTCOME',id:matches[0].id,outcome:'victory'},sender));
  await assert.rejects(x.app.handle({type:'MATCH_SET_OUTCOME',id:matches[0].id,outcome:'draw'},extension));
  const marked=await x.app.handle({type:'MATCH_SET_OUTCOME',id:matches[0].id,outcome:'victory'},extension);
  assert.equal(marked.outcome,'victory');assert.equal(marked.outcomeMarked,true);
  assert.equal((await x.app.handle({type:'MATCHES_LIST'},extension)).matches[0].outcome,'victory');
  const cleared=await x.app.handle({type:'MATCH_SET_OUTCOME',id:matches[0].id,outcome:''},extension);assert.equal(cleared.outcomeMarked,false);
});

test('settings save without site access; starting and testing then ask for authorization instead of re-entry',async()=>{
  const x=mockChrome({local:{settings:{...DEFAULTS}},session:{}});
  let granted=false;x.c.permissions.contains=async()=>granted;
  const app=createBackground(x.c,{fetchImpl:async()=>answer()});
  const saved=await app.handle({type:'SAVE_SETTINGS',settings:{provider:'local',localBase:'http://10.0.25.215:8742/v1',localKey:'lan-token'}},extension);
  assert.equal(saved.permitted,false);assert.equal(saved.origin,'http://10.0.25.215/*');assert.equal(x.data.local.settings.localKey,'lan-token','the typed token is stored even before access is granted');
  await assert.rejects(app.handle({type:'START',tabId:7},extension),/授权访问/);
  await assert.rejects(app.handle({type:'TEST_CONNECTION'},extension),/授权访问/);
  granted=true;
  const view=await app.handle({type:'GET_SETTINGS'},extension);assert.equal(view.permitted,true);assert.equal(view.localKey,'lan-token');
  await app.handle({type:'START',tabId:7},extension);assert.equal((await app.getSession(7)).running,true);
});

test('a finished match saves a battle report to Downloads/jev-reports unless disabled; the overlay shows both sides\' losses',async()=>{
  const downloads=[];const shared={local:{settings:{...DEFAULTS,apiKey:'test-only-secret'}},session:{}};
  const x=await setup(async()=>answer(),shared);x.c.downloads={download:async o=>{downloads.push(o);return 1;}};
  await x.app.handle(x.request,sender);
  await x.app.handle({type:'EVENT',token:x.s.token,event:{kind:'observation',tick:101,credits:5000,state:{self:{credits:5000},ownArmyCount:6,gameSeconds:10},ledger:{ownUnits:6,ownBuildings:4,enemyUnits:2,enemyBuildings:1,ownBuilt:3,ownUnitsLost:2,ownBuildingsLost:1,enemyUnitsDestroyed:9,enemyBuildingsDestroyed:3}}},sender);
  const overlay=await x.app.handle({type:'OVERLAY_STATUS'},sender);
  assert.deepEqual(overlay.losses,{ownUnits:2,ownBuildings:1,enemyUnits:9,enemyBuildings:3});
  await x.app.handle({type:'STOP',tabId:7},extension);
  assert.equal(downloads.length,1);assert.match(downloads[0].filename,/^jev-reports\/jev-report-\d{8}-\d{6}\.json$/);assert.equal(downloads[0].saveAs,false);
  const body=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(downloads[0].url.split(',')[1]),ch=>ch.charCodeAt(0))));
  assert.equal(body.match.decisions,1);assert.ok(body.entries.some(e=>e.kind==='decision'));assert.equal(body.stats.decisions,1);assert.doesNotMatch(JSON.stringify(body),/test-only-secret/);
  const {matches}=await x.app.handle({type:'MATCHES_LIST'},extension);assert.equal(matches[0].reportFile,downloads[0].filename);
  await assert.rejects(x.app.handle({type:'SET_AUTO_REPORT',autoReport:false},sender));
  assert.deepEqual(await x.app.handle({type:'SET_AUTO_REPORT',autoReport:false},extension),{autoReport:false});
  await x.app.handle({type:'START',tabId:7},extension);await x.app.handle({type:'STOP',tabId:7},extension);
  assert.equal(downloads.length,1,'no report when disabled');assert.equal((await x.app.handle({type:'GET_SETTINGS'},extension)).autoReport,false);
});

test('match metadata from the page is kept, each match stores its own log, and records can be labelled, deleted or cleared',async()=>{
  const x=await setup(async()=>answer());
  await x.app.handle({type:'EVENT',token:x.s.token,event:{kind:'meta',pageTitle:'王二火大 · 战役 3',url:'https://ra2web.github.io/#c3',me:{name:'Me',country:'America'},players:[{name:'Me',allied:true,combatant:true},{name:'AI',isAi:true,combatant:true}],playerCount:2,opponents:1,map:{width:120,height:100},startTick:1600,startTime:100,apiKey:'leak'}},sender);
  await x.app.handle(x.request,sender);
  await x.app.handle({type:'STOP',tabId:7},extension);
  const {matches}=await x.app.handle({type:'MATCHES_LIST'},extension);const m=matches[0];
  assert.equal(m.meta.pageTitle,'王二火大 · 战役 3');assert.equal(m.meta.players.length,2);assert.equal(m.meta.map.width,120);assert.equal(m.meta.opponents,1);assert.equal(m.meta.apiKey,undefined);
  assert.equal(m.logEntries>=2,true);
  const log=await x.app.handle({type:'MATCH_LOG_GET',id:m.id},extension);
  assert.deepEqual(log.entries.map(e=>e.kind),['session','meta','decision','session']);assert.equal(log.entries[1].pageTitle,'王二火大 · 战役 3');
  assert.ok(x.data.local[`matchlog:${m.id}`],'the per-match log is stored under its own key');
  await assert.rejects(x.app.handle({type:'MATCH_LOG_GET',id:m.id},sender));await assert.rejects(x.app.handle({type:'MATCH_UPDATE',id:m.id,label:'x'},sender));await assert.rejects(x.app.handle({type:'MATCH_DELETE',id:m.id},sender));
  const updated=await x.app.handle({type:'MATCH_UPDATE',id:m.id,label:'  第三关   首胜 ','notes':'note','outcome':'victory'},extension);
  assert.equal(updated.label,'第三关 首胜');assert.equal(updated.notes,'note');assert.equal(updated.outcome,'victory');assert.equal(updated.outcomeMarked,true);
  assert.equal((await x.app.handle({type:'MATCHES_LIST'},extension)).matches[0].label,'第三关 首胜');
  await assert.rejects(x.app.handle({type:'MATCH_UPDATE',id:'nope',label:'x'},extension));
  await x.app.handle({type:'START',tabId:7},extension);await x.app.handle({type:'STOP',tabId:7},extension);
  const two=(await x.app.handle({type:'MATCHES_LIST'},extension)).matches;assert.equal(two.length,2);
  await x.app.handle({type:'MATCH_DELETE',id:m.id},extension);
  const one=(await x.app.handle({type:'MATCHES_LIST'},extension)).matches;assert.equal(one.length,1);assert.notEqual(one[0].id,m.id);assert.equal(x.data.local[`matchlog:${m.id}`],undefined,'deleting a match removes its log');
  await assert.rejects(x.app.handle({type:'MATCH_DELETE',id:m.id},extension));
  await x.app.handle({type:'MATCHES_CLEAR'},extension);
  assert.equal((await x.app.handle({type:'MATCHES_LIST'},extension)).matches.length,0);assert.ok(!Object.keys(x.data.local).some(k=>k.startsWith('matchlog:')),'clearing removes every match log');
});
test('the history keeps at most 100 matches and drops the oldest logs with their records',async()=>{
  const old=Array.from({length:100},(_,i)=>({id:`old-${i}`,startedAt:i,endedAt:i+1,durationMs:1,decisions:0}));
  const shared={local:{settings:{...DEFAULTS,apiKey:'test-only-secret'},matches:old,...Object.fromEntries(old.map(m=>[`matchlog:${m.id}`,[{kind:'session'}]]))},session:{}};
  const x=await setup(async()=>answer(),shared);
  await x.app.handle({type:'STOP',tabId:7},extension);
  const list=await x.app.handle({type:'MATCHES_LIST'},extension);
  assert.equal(list.matches.length,100);assert.equal(list.matches.at(-1).id,'old-1','the oldest record was dropped');
  assert.equal(x.data.local['matchlog:old-0'],undefined,'its log went with it');assert.ok(x.data.local['matchlog:old-1']);
});

test('external hosts are allowed by hand: until then a public plaintext address is refused, afterwards it is used',async()=>{
  const x=mockChrome({local:{settings:{...DEFAULTS}},session:{}});
  const app=createBackground(x.c,{fetchImpl:async()=>answer()});
  await assert.rejects(app.handle({type:'SAVE_SETTINGS',settings:{provider:'local',localBase:'http://vps.example:8742/v1'}},extension),/允许的外部地址/);
  await assert.rejects(app.handle({type:'ALLOW_HOST',host:'vps.example'},sender));
  const allowed=await app.handle({type:'ALLOW_HOST',host:' HTTP://VPS.example:8742/v1 '},extension);assert.deepEqual(allowed.allowedHosts,['vps.example']);
  const saved=await app.handle({type:'SAVE_SETTINGS',settings:{provider:'local',localBase:'http://vps.example:8742/v1'}},extension);assert.deepEqual(saved.allowedHosts,['vps.example']);
  await app.handle({type:'START',tabId:7},extension);assert.equal((await app.getSession(7)).running,true);
  await app.handle({type:'DISALLOW_HOST',host:'vps.example'},extension);
  const s=await app.getSession(7);await assert.rejects(app.handle({type:'DECIDE',token:s.token,body},sender),/允许的外部地址/,'a removed host stops being used at once');
  assert.deepEqual((await app.handle({type:'GET_SETTINGS'},extension)).allowedHosts,[]);
});

test('the data panel, opened in a tab, is trusted like the popup; game pages and other extensions are not',async()=>{
  const x=await setup(async()=>answer());
  await x.app.handle({type:'STOP',tabId:7},extension);
  const panel={id:'test-extension',frameId:0,url:'chrome-extension://test-extension/dashboard.html',tab:{id:9}};
  const {matches}=await x.app.handle({type:'MATCHES_LIST'},panel);assert.equal(matches.length,1,'the panel sees the recorded match');
  assert.ok((await x.app.handle({type:'GET_SETTINGS'},panel)).hasKey);
  for(const bad of [{...panel,url:'https://staging.wangerhuoda.com/'},{...panel,id:'other-extension'},{...panel,frameId:1},{...panel,url:'https://evil.test/chrome-extension://test-extension/'}])await assert.rejects(x.app.handle({type:'MATCHES_LIST'},bad));
});
