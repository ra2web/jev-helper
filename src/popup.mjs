import {DEFAULTS,validateSettings,originPattern,hotkeyFromEvent,fieldErrors,errorField} from './shared.mjs';
import {importSettings} from './import-settings.mjs';
import {t,errorText,messages,officialWebsiteUrl} from './i18n.mjs';
import {drawChart,drawPositions} from './charts.mjs';
const $=id=>document.getElementById(id);
let tabId,config={...DEFAULTS,hasKey:false},lastStatus,dirty=false,refreshing=false,activePanel='battlefield',noticeState;
const tr=(key,vars)=>t(config.language,key,vars);
const providerName=()=>config.providerName||'Jev';
let testState={state:'idle'};
// Inline field errors (Material style): red outline plus a message under the input.
const FIELD_IDS={apiKey:'api-key',apiBase:'api-base',model:'model',localKey:'local-key',localBase:'local-base',localModel:'local-model',hotkey:'hotkey',maxDecisions:'budget',objective:'objective'};
const fieldMessages={};
function fieldError(field,message){
 const id=FIELD_IDS[field];if(!id)return false;const input=$(id),slot=$(`err-${id}`);
 fieldMessages[field]=message;slot.textContent=errorText(config.language,message);slot.hidden=false;
 input.classList.add('invalid');input.setAttribute('aria-invalid','true');input.setAttribute('aria-errormessage',slot.id);
 if(input.closest('details'))input.closest('details').open=true;
 return true;
}
function clearFieldError(field){
 const id=FIELD_IDS[field];if(!id)return;delete fieldMessages[field];const input=$(id),slot=$(`err-${id}`);
 slot.hidden=true;slot.textContent='';input.classList.remove('invalid');input.removeAttribute('aria-invalid');input.removeAttribute('aria-errormessage');
}
const clearFieldErrors=()=>{for(const field of Object.keys(FIELD_IDS))clearFieldError(field);};
function showFieldErrors(errors){
 let first;for(const field of Object.keys(FIELD_IDS)){if(field in errors&&fieldError(field,errors[field]))first??=FIELD_IDS[field];}
 if(first)$(first).focus();return !!first;
}
// A background error that belongs to a field is shown there; anything else goes to the notice.
function reportError(message){
 const field=errorField(message,selectedProvider());
 if(field&&fieldError(field,message)){$(FIELD_IDS[field]).focus();return true;}
 notice(message);return false;
}
let logStatsCache,matchList=[],matchSelected,matchDetail;
const fmtDuration=ms=>{const s=Math.max(0,Math.round(ms/1000)),h=Math.floor(s/3600),m=Math.floor(s%3600/60),sec=s%60;return h?`${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`:`${m}:${String(sec).padStart(2,'0')}`;};
const outcomeText=m=>tr(messages[`matchOutcome_${m.outcome}`]?`matchOutcome_${m.outcome}`:'matchOutcome_');
function renderMatchList(){
 const ul=$('match-list');ul.replaceChildren();$('matches-count').textContent=matchList.length?String(matchList.length):'';$('matches-empty').hidden=matchList.length>0;
 for(const m of matchList){const li=document.createElement('li'),btn=document.createElement('button');btn.type='button';btn.setAttribute('aria-pressed',String(m.id===matchSelected));
  const row=document.createElement('span');row.className='row';const when=document.createElement('span');when.textContent=new Date(m.startedAt).toLocaleString(config.language,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});const outcome=document.createElement('span');outcome.textContent=outcomeText(m);row.append(when,outcome);
  const sub=document.createElement('span');sub.className='sub';sub.textContent=`${fmtDuration(m.durationMs)} · ${m.providerName||'Jev'} · ${tr('decisions')} ${format(m.decisions)} · ${tr('matchCreditsEnd')} ${format(m.credits?.end)}`;
  btn.append(row,sub);btn.addEventListener('click',()=>selectMatch(m.id));li.append(btn);ul.append(li);}
}
function renderMatchDetail(m){
 matchDetail=m;$('match-detail').hidden=!m;if(!m)return;
 $('match-title').textContent=new Date(m.startedAt).toLocaleString(config.language,{hour12:false});$('match-outcome').textContent=outcomeText(m);
 $('match-duration').textContent=fmtDuration(m.durationMs);$('match-decisions').textContent=format(m.decisions);$('match-credits').textContent=format(m.credits?.end);
 const box=$('match-facts');box.replaceChildren();const line=text=>{const p=document.createElement('p');p.textContent=text;box.append(p);};
 line(tr('matchFacts',{provider:m.providerName||'Jev',model:m.model||'—',requests:m.requests,failures:m.failures,avg:m.latencyAvg??'—',game:m.gameSeconds!=null?fmtDuration(m.gameSeconds*1000):'—'}));
 line(tr('matchActions',{accepted:m.acceptedActions,waits:m.waits,army:format(m.armyMax),start:format(m.credits?.start),end:format(m.credits?.end),max:format(m.credits?.max)}));
 const produced=Object.entries(m.produced??{}).map(([k,v])=>`${k}×${v}`).join('，');line(produced?tr('logProduce',{list:produced}):tr('logNoProduce'));
 const groups=Object.entries(m.groups??{}).map(([id,g])=>`${id} ${g.waitRate}%`).join('，');if(groups)line(tr('matchGroups',{list:groups}));
 if(m.objective)line(tr('matchObjective',{objective:m.objective}));
 line(tr('matchReason',{reason:messages[m.reason]?tr(m.reason):m.reason||'—'}));
 drawChart($('match-economy'),m.history??[],[{key:'credits',label:'creditsLegend',color:'#d9b76f'},{key:'freeCredits',label:'freeLegend',color:'#91cbb1'}],config.language,tr('economyChart'));
 drawChart($('match-decision-chart'),m.history??[],[{key:'decisions',label:'decisionLegend',color:'#d9b76f'}],config.language,tr('decisionChart'));
 drawChart($('match-force'),m.history??[],[{key:'ownUnits',label:'ownUnitsLegend',color:'#91cbb1'},{key:'ownBuildings',label:'ownBuildingsLegend',color:'#d9b76f'},{key:'enemyUnits',label:'enemyUnitsLegend',color:'#ed9383'}],config.language,tr('forceChart'));
 drawChart($('match-loss'),m.history??[],[{key:'ownBuilt',label:'builtLegend',color:'#d9b76f'},{key:'ownLost',label:'lostLegend',color:'#ed9383'},{key:'enemyDestroyed',label:'destroyedLegend',color:'#91cbb1'}],config.language,tr('lossChart'));
 for(const [id,value] of [['mark-victory','victory'],['mark-defeat','defeat']])$(id).setAttribute('aria-pressed',String(m.outcome===value&&m.outcomeMarked===true));
}
for(const [id,outcome] of [['mark-victory','victory'],['mark-defeat','defeat'],['mark-clear','']])$(id).addEventListener('click',async()=>{
 if(!matchDetail)return;try{const m=await rpc({type:'MATCH_SET_OUTCOME',id:matchDetail.id,outcome});matchList=matchList.map(x=>x.id===m.id?{...x,outcome:m.outcome,outcomeMarked:m.outcomeMarked}:x);renderMatchList();renderMatchDetail(m);notify('matchMarked',true,{outcome:outcomeText(m)});}catch(e){notice(e.message);}
});
async function selectMatch(id){matchSelected=id;renderMatchList();try{renderMatchDetail(await rpc({type:'MATCH_GET',id}));}catch(e){notice(e.message);}}
async function refreshMatches(){
 try{const {matches}=await rpc({type:'MATCHES_LIST'});matchList=matches;if(!matchList.some(m=>m.id===matchSelected))matchSelected=matchList[0]?.id;renderMatchList();
  if(matchSelected)renderMatchDetail(await rpc({type:'MATCH_GET',id:matchSelected}));else renderMatchDetail(undefined);}
 catch(e){notice(e.message);}
}
function renderLogStats(data){
 logStatsCache=data;const box=$('log-stats');box.replaceChildren();
 const s=data?.stats;$('log-size').textContent=data?.chars?tr('logSize',{kb:Math.round(data.chars/1024)}):'';
 if(!s||!s.entries){const p=document.createElement('p');p.textContent=tr('logEmpty');box.append(p);$('log-export').disabled=true;$('log-clear').disabled=true;return;}
 $('log-export').disabled=false;$('log-clear').disabled=false;
 const line=text=>{const p=document.createElement('p');p.textContent=text;box.append(p);};
 line(tr('logSummary',{entries:s.entries,sessions:s.sessions,decisions:s.decisions,failures:s.failures,avg:s.latency.avg??'—'}));
 const reasons=Object.entries(s.actions.skippedReasons).slice(0,3).map(([k,v])=>`${k} ${v}`).join('，');
 line(tr('logActions',{accepted:s.actions.accepted,waits:s.actions.waits,skipped:s.actions.skipped,reasons:reasons?`（${reasons}）`:''}));
 const produce=Object.entries(s.actions.acceptedProduce).map(([k,v])=>`${k}×${v}`).join('，');
 line(produce?tr('logProduce',{list:produce}):tr('logNoProduce'));
 const groups=Object.entries(s.groups);
 if(groups.length){line(tr('logGroups'));const ul=document.createElement('ul');for(const [id,g] of groups){const li=document.createElement('li');li.textContent=tr('logGroupLine',{id,asked:g.asked,rate:g.waitRate,options:g.avgOptions,confidence:g.avgConfidence});ul.append(li);}box.append(ul);}
}
async function refreshLog(){try{renderLogStats(await rpc({type:'LOG_STATS'}));}catch(e){notice(e.message);}}
function downloadJson(name,data){
 const blob=new Blob([JSON.stringify(data,null,1)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
 a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
}
function openSettingsPanel(){for(const other of document.querySelectorAll('[data-panel]')){const on=other.dataset.panel==='settings';other.setAttribute('aria-pressed',on);$(`panel-${other.dataset.panel}`).hidden=!on;}activePanel='settings';}
// The connection probe reports on its own button: testing → ok / fail. Any edit resets it.
function showTest(state,key,vars){testState={state,key,vars};const btn=$('test-connection');btn.dataset.state=state;btn.disabled=state==='testing';$('test-label').textContent=tr(key??'test',vars);}
const selectedProvider=()=>$('provider-local').getAttribute('aria-checked')==='true'?'local':'jev';
const rpc=async message=>{const r=await chrome.runtime.sendMessage(message);if(!r?.ok)throw new Error(r?.error||'插件后台未响应。');return r.value;};
const format=n=>typeof n==='number'&&Number.isFinite(n)?Math.round(n).toLocaleString(config.language):'—';
function notice(text,success=false,key,vars){noticeState={text,success,key,vars};$('notice').textContent=key?tr(key,vars):errorText(config.language,text);$('notice').classList.toggle('success',success);$('notice').hidden=!text&&!key;}
const notify=(key,success=false,vars)=>notice('',success,key,vars);
function translate(){
 document.documentElement.lang=config.language;document.title=tr('title');
 for(const e of document.querySelectorAll('[data-i18n]'))e.textContent=tr(e.dataset.i18n);
 $('lang-en').setAttribute('aria-pressed',config.language==='en');$('lang-zh').setAttribute('aria-pressed',config.language!=='en');
 $('official-site').href=officialWebsiteUrl(config.language);$('official-site').title=tr('officialWebsiteHint');
 $('help-link').href=`help.html?lang=${config.language}`;
 keyPlaceholder();showProvider(selectedProvider());
 for(const eye of document.querySelectorAll('[data-reveal]')){const on=eye.getAttribute('aria-pressed')==='true';eye.title=tr(on?'hideKey':'showKey');eye.setAttribute('aria-label',eye.title);}
 if(testState.state!=='idle')showTest(testState.state,testState.key,testState.vars);
 if(noticeState)notice(noticeState.text,noticeState.success,noticeState.key,noticeState.vars);
 for(const [field,message] of Object.entries(fieldMessages))fieldError(field,message);
 if(logStatsCache)renderLogStats(logStatsCache);
 if(activePanel==='matches'){renderMatchList();if(matchDetail)renderMatchDetail(matchDetail);}
 if(lastStatus)displayStatus(lastStatus);
}
function keyPlaceholder(){$('api-key').placeholder=tr('keyEmpty');$('local-key').placeholder=tr('localKeyEmpty');$('clear-key').hidden=!(selectedProvider()==='local'?config.hasLocalKey:config.hasKey);}
// Only the selected source's fields are shown; both sets stay saved.
function showProvider(provider){
 for(const btn of document.querySelectorAll('[data-provider]'))btn.setAttribute('aria-checked',btn.dataset.provider===provider);
 for(const id of ['jev','local']){$(`fields-${id}`).hidden=id!==provider;$(`advanced-${id}`).hidden=id!==provider;}
 $('provider-hint').textContent=tr(provider==='local'?'providerLocalHint':'providerJevHint');
 $('clear-key').hidden=!(provider==='local'?config.hasLocalKey:config.hasKey);
}
function displayConfig(){
 $('api-base').value=config.apiBase;$('model').value=config.model;$('local-base').value=config.localBase;$('local-model').value=config.localModel;
 // Stored keys are shown masked; the eye button reveals them on demand.
 $('api-key').value=config.apiKey??'';$('local-key').value=config.localKey??'';$('objective').value=config.objective??'';showProvider(config.provider);$('hotkey').value=config.hotkey;$('budget').value=config.maxDecisions;$('auto-camera').checked=config.autoCamera;$('show-overlay').checked=config.showOverlay;keyPlaceholder();
}
function renderAwareness(s){
 const o=s.observation;$('awareness').hidden=!o;$('no-battle').hidden=!!o;
 const live=s.liveObservation&&o&&Date.now()-o.at<6000;
 $('freshness').textContent=o?tr(live?'live':'stale'):'';$('freshness').classList.toggle('live',!!live);
 if(!o)return;
 $('threat').className=`threat ${o.threat}`;$('threat-title').textContent=tr(o.threat);$('threat-detail').textContent=tr(o.threat==='clear'?'clearDetail':'pressureDetail');
 $('range-warning').hidden=!o.rangeThreats.length;$('range-warning').textContent=tr('rangeWarning',{n:o.rangeThreats.length});
 for(const [id,value] of [['army',o.army],['enemies',o.visibleEnemies],['nearby',o.nearbyEnemies],['miners',o.harvesters],['anti-air',o.antiAir]])$(id).textContent=format(value);
 $('health').textContent=o.health===null?'—':`${Math.round(o.health*100)}%`;
 const known=o.power.total!==null&&o.power.drain!==null,low=known&&o.power.total<o.power.drain;
 $('power').textContent=`${format(o.power.total)} / ${format(o.power.drain)}`;$('power-state').textContent=known?tr(low?'lowPower':'powerOK'):'—';$('power-state').classList.toggle('low',low);
 drawPositions($('position-map'),o,config.language);
 const items=o.queues.flatMap(q=>q.items);
 const label=kind=>config.language==='en'?kind:o.inventory.find(u=>u.kind===kind)?.label||kind;
 $('queues').replaceChildren(...items.map(i=>{const li=document.createElement('li'),name=document.createElement('span'),progress=document.createElement('progress'),value=document.createElement('span');name.textContent=`${label(i.name)} × ${i.quantity}`;progress.max=1;progress.value=Math.max(0,Math.min(1,i.progress??0));progress.setAttribute('aria-label',name.textContent);value.textContent=i.progress===null?'—':`${Math.round(progress.value*100)}%`;li.append(name,progress,value);return li;}));
 if(!items.length){const li=document.createElement('li');li.textContent=tr('queueEmpty');$('queues').append(li);}
 $('inventory').replaceChildren(...o.inventory.map(u=>{const tag=document.createElement('span');tag.textContent=`${label(u.kind)} × ${u.count}`;return tag;}));
}
function renderCharts(s){
 drawChart($('decision-chart'),s.history??[],[{key:'decisions',label:'decisionLegend',color:'#d9b76f'}],config.language,tr('decisionChart'));
 drawChart($('economy-chart'),s.history??[],[{key:'credits',label:'creditsLegend',color:'#d9b76f'},{key:'freeCredits',label:'freeLegend',color:'#91cbb1'}],config.language,tr('economyChart'));
 $('accepted').textContent=tr('accepted',{n:s.acceptedActions??0});$('waits').textContent=tr('waits',{n:s.waits??0});
 drawChart($('force-chart'),s.history??[],[{key:'ownUnits',label:'ownUnitsLegend',color:'#91cbb1'},{key:'ownBuildings',label:'ownBuildingsLegend',color:'#d9b76f'},{key:'enemyUnits',label:'enemyUnitsLegend',color:'#ed9383'}],config.language,tr('forceChart'));
 drawChart($('loss-chart'),s.history??[],[{key:'ownBuilt',label:'builtLegend',color:'#d9b76f'},{key:'ownLost',label:'lostLegend',color:'#ed9383'},{key:'enemyDestroyed',label:'destroyedLegend',color:'#91cbb1'}],config.language,tr('lossChart'));
}
function eventText(e){
 if(config.language!=='en')return e.text;
 const key=`event_${e.kind}`,name=tr(messages[key]?key:'event_other');
 if(e.kind==='action')return `${name} · ${e.choice||e.actionType||''} · ${tr(e.reason==='wait'?'waitLabel':e.accepted?'acceptedLabel':'skippedLabel')}`;
 if(e.kind==='stop'&&messages[e.reason])return `${name} · ${tr(e.reason)}`;
 return `${name}${e.choice?' · '+e.choice:''}`;
}
function displayStatus(s){
 lastStatus=s;$('status').textContent=tr(s.running?'running':s.error||s.reason?'stopped':s.supported?'ready':'switchGame',{name:s.providerName||providerName()});$('dot').classList.toggle('on',s.running);
 $('game').textContent=config.language==='en'?tr(s.supported?'game':'switchGame'):s.title||tr('switchGame');$('tick').textContent=s.lastTick!=null?`TICK ${s.lastTick}`:'';
 $('decisions').textContent=format(s.decisions??0);$('credits').textContent=format(s.credits);$('latency').textContent=s.latencyMs!=null?`${format(s.latencyMs)}ms`:'—';
 $('mission').textContent=s.running?(config.language==='en'?tr('thinking'):s.mission||tr('thinking')):tr(messages[s.reason]?s.reason:'idleMission',{name:providerName()});
 $('start').disabled=!s.supported||s.running||dirty;$('stop').disabled=!s.running;$('failures').textContent=s.failures?tr('failures',{n:s.failures}):'';
 $('events').replaceChildren(...(s.events??[]).slice(0,8).map(e=>{const li=document.createElement('li');li.textContent=`${new Date(e.at).toLocaleTimeString(config.language,{hour12:false})} · ${eventText(e)}`;return li;}));
 if(!s.events?.length){const li=document.createElement('li');li.textContent=tr('noEvents');$('events').append(li);}
 if(activePanel==='battlefield')renderAwareness(s);if(activePanel==='trends')renderCharts(s);
 if(s.error)notice(s.error);
}
async function refresh(){if(tabId===undefined||refreshing)return;refreshing=true;try{displayStatus(await rpc({type:'GET_STATUS',tabId}));}finally{refreshing=false;}}
for(const btn of document.querySelectorAll('[data-panel]'))btn.addEventListener('click',()=>{
 activePanel=btn.dataset.panel;
 for(const other of document.querySelectorAll('[data-panel]')){const on=other===btn;other.setAttribute('aria-pressed',on);$(`panel-${other.dataset.panel}`).hidden=!on;}
 if(activePanel==='settings')refreshLog();
 if(activePanel==='matches')refreshMatches();
 if(lastStatus)displayStatus(lastStatus);
});
$('log-export').addEventListener('click',async()=>{
 $('log-export').disabled=true;
 try{const data=await rpc({type:'LOG_EXPORT'});const stamp=new Date().toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15);const file=`jev-log-${stamp}.json`;downloadJson(file,data);notify('logExported',true,{file});}
 catch(e){notice(e.message);}finally{$('log-export').disabled=false;}
});
$('match-export').addEventListener('click',()=>{if(!matchDetail)return;const stamp=new Date(matchDetail.startedAt).toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15);const file=`jev-match-${stamp}.json`;downloadJson(file,matchDetail);notify('matchExported',true,{file});});
$('matches-clear').addEventListener('click',async()=>{try{await rpc({type:'MATCHES_CLEAR'});matchSelected=undefined;notify('matchesCleared',true);await refreshMatches();}catch(e){notice(e.message);}});
$('log-clear').addEventListener('click',async()=>{try{await rpc({type:'LOG_CLEAR'});notify('logCleared',true);await refreshLog();}catch(e){notice(e.message);}});
for(const [id,language]of [['lang-zh','zh-CN'],['lang-en','en']])$(id).addEventListener('click',async()=>{
 try{await rpc({type:'SET_LANGUAGE',language});config.language=language;translate();}catch(e){notice(e.message);}
});
for(const btn of document.querySelectorAll('[data-provider]'))btn.addEventListener('click',()=>{if(selectedProvider()===btn.dataset.provider)return;showProvider(btn.dataset.provider);dirty=true;clearFieldErrors();if(testState.state!=='idle')showTest('idle');if(lastStatus)displayStatus(lastStatus);});
$('import-config').addEventListener('click',()=>$('config-file').click());
$('config-file').addEventListener('change',async()=>{
 try{
  const file=$('config-file').files[0];if(!file)return;if(file.size>65536)throw new Error('配置文件过大，请仅保留 Jev 配置。');
  const imported=importSettings(await file.text());validateSettings({...config,...imported});$('api-key').value=imported.apiKey;
  if(imported.apiBase)$('api-base').value=imported.apiBase;if(imported.model)$('model').value=imported.model;
  dirty=true;$('start').disabled=true;notify('imported',true);
 }catch(e){notice(e.message);}finally{$('config-file').value='';}
});
$('test-connection').addEventListener('click',async()=>{
 if(dirty){showTest('fail','saveFirst');return;}
 if(selectedProvider()==='jev'&&!$('api-key').value.trim()){showFieldErrors({apiKey:'请输入 JEV 密钥。'});return;}
 notice('');showTest('testing','testing',{name:providerName()});
 try{const result=await rpc({type:'TEST_CONNECTION'});showTest('ok','testOk',{name:result.providerName||providerName(),ms:result.latencyMs,model:result.model?` · ${result.model}`:''});}
 catch(e){showTest('idle');if(!reportError(e.message))showTest('fail','testFail',{error:errorText(config.language,e.message)});}
});
$('show-overlay').addEventListener('change',async()=>{
 const input=$('show-overlay');input.disabled=true;
 try{const result=await rpc({type:'SET_OVERLAY',showOverlay:input.checked});config.showOverlay=result.showOverlay;notify(config.showOverlay?'overlayEnabled':'overlayDisabled',true);}
 catch(e){input.checked=config.showOverlay;notice(e.message);}finally{input.disabled=false;}
});
$('settings').addEventListener('input',e=>{if(e.target.id==='show-overlay')return;dirty=true;if(testState.state!=='idle')showTest('idle');const field=Object.keys(FIELD_IDS).find(f=>FIELD_IDS[f]===e.target.id);if(field)clearFieldError(field);if(lastStatus)displayStatus(lastStatus);});
for(const eye of document.querySelectorAll('[data-reveal]'))eye.addEventListener('click',()=>{const input=$(eye.dataset.reveal),show=input.type==='password';input.type=show?'text':'password';eye.setAttribute('aria-pressed',String(show));eye.title=tr(show?'hideKey':'showKey');eye.setAttribute('aria-label',eye.title);input.focus();});
$('hotkey').addEventListener('keydown',e=>{if(e.key==='Tab')return;e.preventDefault();const value=hotkeyFromEvent(e);if(value){$('hotkey').value=value;dirty=true;clearFieldError('hotkey');if(testState.state!=='idle')showTest('idle');$('start').disabled=true;notify('hotkeyChanged',true);}});
$('settings').addEventListener('submit',async e=>{
 e.preventDefault();
 try{
  const input={language:config.language,provider:selectedProvider(),apiKey:$('api-key').value.trim(),apiBase:$('api-base').value.trim(),model:$('model').value.trim(),localKey:$('local-key').value.trim(),localBase:$('local-base').value.trim(),localModel:$('local-model').value.trim(),hotkey:$('hotkey').value,autoCamera:$('auto-camera').checked,showOverlay:$('show-overlay').checked,maxDecisions:$('budget').value.trim()===''?NaN:Number($('budget').value),objective:$('objective').value};
  clearFieldErrors();if(showFieldErrors(fieldErrors(input,{requireKey:true})))return;
  validateSettings(input);
  if(!await chrome.permissions.request({origins:[originPattern(input.provider==='local'?input.localBase:input.apiBase)]}))throw new Error('未获得 API 访问授权，设置未保存。');
  config=await rpc({type:'SAVE_SETTINGS',settings:input});dirty=false;displayConfig();notify('saved',true);await refresh();
 }catch(error){reportError(error.message);}
});
$('clear-key').addEventListener('click',async()=>{try{const provider=selectedProvider();await rpc({type:'CLEAR_KEY',provider});if(provider==='local'){config.hasLocalKey=false;config.localKey='';$('local-key').value='';}else{config.hasKey=false;config.apiKey='';$('api-key').value='';}keyPlaceholder();notify('keyCleared',true);await refresh();}catch(e){notice(e.message);}});
for(const [id,type]of [['start','START'],['stop','STOP']])$(id).addEventListener('click',async()=>{
 $(id).disabled=true;notice('');try{await rpc({type,tabId});await refresh();}catch(e){if(reportError(e.message))openSettingsPanel();$(id).disabled=false;}
});
try{config=await rpc({type:'GET_SETTINGS'});translate();displayConfig();const [tab]=await chrome.tabs.query({active:true,currentWindow:true});tabId=tab?.id;await refresh();await refreshLog();}catch(e){notice(e.message);$('status').textContent=tr('connectionFailed');}
const timer=setInterval(()=>refresh().catch(e=>{if(lastStatus)displayStatus({...lastStatus,liveObservation:false});notice(e.message);}),1500);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
