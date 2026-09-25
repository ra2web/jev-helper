import {DEFAULTS,validateSettings,originPattern,hotkeyFromEvent,fieldErrors,errorField,plaintextPublic,normalizeHost,PROVIDER_FIELDS} from './shared.mjs';
import {importSettings} from './import-settings.mjs';
import {t,errorText,messages,officialWebsiteUrl} from './i18n.mjs';
import {drawChart,drawPositions} from './charts.mjs';
const $=id=>document.getElementById(id);
let tabId,config={...DEFAULTS,hasKey:false},lastStatus,dirty=false,refreshing=false,activePanel='battlefield',noticeState;
const tr=(key,vars)=>t(config.language,key,vars);
const providerName=()=>config.providerName||'Jev';
let testState={state:'idle'},models=[];
// Inline field errors (Material style): red outline plus a message under the input.
const FIELD_IDS={apiKey:'api-key',apiBase:'api-base',model:'model',localKey:'local-key',localBase:'local-base',localModel:'local-model',openaiKey:'openai-key',openaiBase:'openai-base',openaiModel:'openai-model',hotkey:'hotkey',maxDecisions:'budget',objective:'objective'};
const PROVIDER_IDS=['jev','local','openai'],KEY_FLAGS={jev:'hasKey',local:'hasLocalKey',openai:'hasOpenaiKey'};
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
 if(/授权|访问权限/.test(message)&&config.permitted===false){renderPermission();$('authorize').focus();notice(message);return true;}
 notice(message);return false;
}
// Settings are saved before the browser is asked for site access, so a dismissed prompt never
// costs the user what they typed. The banner offers the grant again with one click.
function renderPermission(){const banner=$('permission-banner');const need=config.permitted===false;banner.hidden=!need;if(need)$('permission-text').textContent=tr('permissionNeeded',{origin:config.origin});}
async function authorize(){
 $('authorize').disabled=true;
 try{const granted=await chrome.permissions.request({origins:[config.origin]});config=await rpc({type:'GET_SETTINGS'});renderPermission();if(granted&&config.permitted)notify('authorized',true,{origin:config.origin});await refresh();}
 catch(e){notice(e.message);}finally{$('authorize').disabled=false;}
}
// Explicitly allowed external hosts: shown as chips, added with one click (which also requests access).
function renderAllowedHosts(){
 const ul=$('allowed-hosts');ul.replaceChildren();
 for(const host of config.allowedHosts??[]){const li=document.createElement('li'),text=document.createElement('span'),btn=document.createElement('button');text.textContent=host;btn.type='button';btn.textContent='×';btn.title=tr('removeHost');btn.setAttribute('aria-label',`${tr('removeHost')} ${host}`);
  btn.addEventListener('click',async()=>{try{config={...config,...await rpc({type:'DISALLOW_HOST',host})};renderAllowedHosts();notify('hostRemoved',true,{host});}catch(e){notice(e.message);}});li.append(text,btn);ul.append(li);}
 $('allow-host').placeholder=tr('allowHostPlaceholder');
}
async function allowHost(){
 const input=$('allow-host'),slot=$('err-allow-host');slot.hidden=true;input.classList.remove('invalid');
 let host;try{host=normalizeHost(input.value);}catch(e){slot.textContent=errorText(config.language,e.message);slot.hidden=false;input.classList.add('invalid');input.focus();return;}
 $('allow-host-add').disabled=true;
 try{
  try{await chrome.permissions.request({origins:[`*://${host}/*`]});}catch{}
  config={...config,...await rpc({type:'ALLOW_HOST',host})};input.value='';renderAllowedHosts();notify('hostAllowed',true,{host});
  clearFieldError('localBase');clearFieldError('apiBase');clearFieldError('openaiBase');
 }catch(e){notice(e.message);}finally{$('allow-host-add').disabled=false;}
}
// Plain HTTP to a public address is allowed but flagged under the field; private networks stay quiet.
function renderPlaintextWarnings(){for(const id of ['api-base','local-base','openai-base']){const warn=$(`warn-${id}`),show=plaintextPublic($(id).value);warn.hidden=!show;if(show)warn.textContent=tr('plaintextWarning');}}
function openSettingsPanel(){for(const other of document.querySelectorAll('[data-panel]')){const on=other.dataset.panel==='settings';other.setAttribute('aria-pressed',on);$(`panel-${other.dataset.panel}`).hidden=!on;}activePanel='settings';}
// The connection probe reports on its own button: testing → ok / fail. Any edit resets it.
function showTest(state,key,vars){testState={state,key,vars};const btn=$('test-connection');btn.dataset.state=state;btn.disabled=state==='testing';$('test-label').textContent=tr(key??'test',vars);}
const selectedProvider=()=>document.querySelector('[data-provider][aria-checked="true"]')?.dataset.provider??'jev';
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
 renderPermission();
 if(lastStatus)displayStatus(lastStatus);
}
function keyPlaceholder(){$('api-key').placeholder=tr('keyEmpty');$('local-key').placeholder=tr('localKeyEmpty');$('openai-key').placeholder=tr('openaiKeyEmpty');$('clear-key').hidden=!config[KEY_FLAGS[selectedProvider()]];renderModels($('openai-model').value);}
// Only the selected source's fields are shown; both sets stay saved.
function showProvider(provider){
 for(const btn of document.querySelectorAll('[data-provider]'))btn.setAttribute('aria-checked',btn.dataset.provider===provider);
 for(const id of PROVIDER_IDS){$(`fields-${id}`).hidden=id!==provider;$(`advanced-${id}`).hidden=id!==provider;}
 $('provider-hint').textContent=tr({local:'providerLocalHint',openai:'providerOpenaiHint'}[provider]??'providerJevHint');
 $('clear-key').hidden=!config[KEY_FLAGS[provider]];
}
// The OpenAI model is picked from the service's own list; the saved choice stays selectable even before a reload.
function renderModels(selected){
 const select=$('openai-model'),ids=[...new Set([...models,...(selected?[selected]:[])])];
 const option=(value,text)=>{const o=document.createElement('option');o.value=value;o.textContent=text;return o;};
 select.replaceChildren(...(ids.length?ids.map(id=>option(id,id)):[option('',tr('modelPlaceholder'))]));
 select.value=selected&&ids.includes(selected)?selected:ids[0]??'';
}
async function fetchModels(){
 const base=$('openai-base').value.trim(),apiKey=$('openai-key').value.trim(),btn=$('fetch-models');
 clearFieldError('openaiBase');clearFieldError('openaiModel');
 const errors=fieldErrors({provider:'openai',openaiBase:base,openaiKey:apiKey,openaiModel:'',allowedHosts:config.allowedHosts,hotkey:config.hotkey,maxDecisions:1});
 if(errors.openaiBase){showFieldErrors({openaiBase:errors.openaiBase});return;}
 btn.disabled=true;btn.textContent=tr('modelsLoading');
 try{
  // Access to that address is asked for here, inside the click, so the list can load before saving.
  try{await chrome.permissions.request({origins:[originPattern(base)]});}catch{}
  const result=await rpc({type:'LIST_MODELS',base,apiKey});
  const before=$('openai-model').value;models=result.models;renderModels(before||config.openaiModel);
  if($('openai-model').value!==config.openaiModel||base!==config.openaiBase){dirty=true;if(testState.state!=='idle')showTest('idle');if(lastStatus)displayStatus(lastStatus);}
  $('models-hint').textContent=tr('modelsLoaded',{n:result.models.length});
 }catch(e){const field=errorField(e.message,'openai');if(/授权|访问权限/.test(e.message))notice(e.message);else{fieldError(field||'openaiModel',e.message);$(FIELD_IDS[field||'openaiModel']).focus();}}
 finally{btn.disabled=false;btn.textContent=tr('fetchModels');}
}
function displayConfig(){
 $('api-base').value=config.apiBase;$('model').value=config.model;$('local-base').value=config.localBase;$('local-model').value=config.localModel;
 $('openai-base').value=config.openaiBase??DEFAULTS.openaiBase;$('openai-key').value=config.openaiKey??'';$('openai-mode').value=config.openaiMode==='json'?'json':'tools';$('strategy-mode').value=config.strategyMode==='commander'?'commander':'choices';models=config.openaiModels??[];renderModels(config.openaiModel);
 // Stored keys are shown masked; the eye button reveals them on demand.
 $('api-key').value=config.apiKey??'';$('local-key').value=config.localKey??'';$('objective').value=config.objective??'';showProvider(config.provider);renderPlaintextWarnings();renderAllowedHosts();$('hotkey').value=config.hotkey;$('budget').value=config.maxDecisions;$('auto-camera').checked=config.autoCamera;$('show-overlay').checked=config.showOverlay;$('auto-report').checked=config.autoReport!==false;keyPlaceholder();
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
 if(e.kind==='command')return `${name} · ${e.choice||''}`;
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
 if(lastStatus)displayStatus(lastStatus);
});
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
 if(selectedProvider()==='openai'&&!$('openai-model').value){showFieldErrors({openaiModel:'请先获取模型列表并选择模型。'});return;}
 notice('');showTest('testing','testing',{name:providerName()});
 try{const result=await rpc({type:'TEST_CONNECTION'});showTest('ok','testOk',{name:result.providerName||providerName(),ms:result.latencyMs,model:result.model?` · ${result.model}`:''});}
 catch(e){showTest('idle');if(!reportError(e.message))showTest('fail','testFail',{error:errorText(config.language,e.message)});}
});
$('show-overlay').addEventListener('change',async()=>{
 const input=$('show-overlay');input.disabled=true;
 try{const result=await rpc({type:'SET_OVERLAY',showOverlay:input.checked});config.showOverlay=result.showOverlay;notify(config.showOverlay?'overlayEnabled':'overlayDisabled',true);}
 catch(e){input.checked=config.showOverlay;notice(e.message);}finally{input.disabled=false;}
});
$('auto-report').addEventListener('change',async()=>{
 const input=$('auto-report');input.disabled=true;
 try{const result=await rpc({type:'SET_AUTO_REPORT',autoReport:input.checked});config.autoReport=result.autoReport;notify(config.autoReport?'autoReportOn':'autoReportOff',true);}
 catch(e){input.checked=config.autoReport!==false;notice(e.message);}finally{input.disabled=false;}
});
$('settings').addEventListener('input',e=>{if(e.target.id==='api-base'||e.target.id==='local-base')renderPlaintextWarnings();if(e.target.id==='show-overlay'||e.target.id==='auto-report')return;dirty=true;if(testState.state!=='idle')showTest('idle');const field=Object.keys(FIELD_IDS).find(f=>FIELD_IDS[f]===e.target.id);if(field)clearFieldError(field);if(lastStatus)displayStatus(lastStatus);});
for(const eye of document.querySelectorAll('[data-reveal]'))eye.addEventListener('click',()=>{const input=$(eye.dataset.reveal),show=input.type==='password';input.type=show?'text':'password';eye.setAttribute('aria-pressed',String(show));eye.title=tr(show?'hideKey':'showKey');eye.setAttribute('aria-label',eye.title);input.focus();});
$('hotkey').addEventListener('keydown',e=>{if(e.key==='Tab')return;e.preventDefault();const value=hotkeyFromEvent(e);if(value){$('hotkey').value=value;dirty=true;clearFieldError('hotkey');if(testState.state!=='idle')showTest('idle');$('start').disabled=true;notify('hotkeyChanged',true);}});
$('settings').addEventListener('submit',async e=>{
 e.preventDefault();
 try{
  const input={language:config.language,provider:selectedProvider(),apiKey:$('api-key').value.trim(),apiBase:$('api-base').value.trim(),model:$('model').value.trim(),localKey:$('local-key').value.trim(),localBase:$('local-base').value.trim(),localModel:$('local-model').value.trim(),openaiKey:$('openai-key').value.trim(),openaiBase:$('openai-base').value.trim(),openaiModel:$('openai-model').value,openaiMode:$('openai-mode').value,strategyMode:$('strategy-mode').value,openaiModels:models,hotkey:$('hotkey').value,autoCamera:$('auto-camera').checked,showOverlay:$('show-overlay').checked,maxDecisions:$('budget').value.trim()===''?NaN:Number($('budget').value),objective:$('objective').value};
  input.allowedHosts=config.allowedHosts??[];
  clearFieldErrors();if(showFieldErrors(fieldErrors(input,{requireKey:true}))){if(['localBase','apiBase','openaiBase'].some(f=>fieldMessages[f]?.includes('允许')))$('allowed-hosts-box').open=true;return;}
  validateSettings(input);
  config=await rpc({type:'SAVE_SETTINGS',settings:input});dirty=false;displayConfig();
  if(!config.permitted){
   let granted=false;try{granted=await chrome.permissions.request({origins:[config.origin]});}catch{}
   config=await rpc({type:'GET_SETTINGS'});
   if(!granted||!config.permitted){renderPermission();notify('savedUnauthorized',false,{origin:config.origin});await refresh();return;}
  }
  renderPermission();notify('saved',true);await refresh();
 }catch(error){reportError(error.message);}
});
$('authorize').addEventListener('click',authorize);
$('fetch-models').addEventListener('click',fetchModels);
$('allow-host-add').addEventListener('click',allowHost);$('allow-host').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();allowHost();}});$('allow-host').addEventListener('input',()=>{$('err-allow-host').hidden=true;$('allow-host').classList.remove('invalid');});
$('open-dashboard').addEventListener('click',()=>chrome.tabs.create({url:chrome.runtime.getURL('dashboard.html')}));
$('clear-key').addEventListener('click',async()=>{try{const provider=selectedProvider(),field=PROVIDER_FIELDS[provider].key;await rpc({type:'CLEAR_KEY',provider});config[KEY_FLAGS[provider]]=false;config[field]='';$(FIELD_IDS[field]).value='';keyPlaceholder();notify('keyCleared',true);await refresh();}catch(e){notice(e.message);}});
for(const [id,type]of [['start','START'],['stop','STOP']])$(id).addEventListener('click',async()=>{
 $(id).disabled=true;notice('');try{await rpc({type,tabId});await refresh();}catch(e){if(reportError(e.message))openSettingsPanel();$(id).disabled=false;}
});
try{config=await rpc({type:'GET_SETTINGS'});translate();displayConfig();const [tab]=await chrome.tabs.query({active:true,currentWindow:true});tabId=tab?.id;await refresh();}catch(e){notice(e.message);$('status').textContent=tr('connectionFailed');}
const timer=setInterval(()=>refresh().catch(e=>{if(lastStatus)displayStatus({...lastStatus,liveObservation:false});notice(e.message);}),1500);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
