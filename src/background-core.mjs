import {DEFAULTS, supportedGame, apiEndpoint, originPattern, validateSettings, publicSettings, privateSettings, prepareQuestions, prepareBrief, validateAnswer, httpError, activeProvider, authHeaders, hostAllowed, normalizeHost, sanitizeAllowedHosts, providerEndpoint, serviceUrl, PROVIDER_FIELDS} from './shared.mjs';
import {buildChatRequest, parseChatResponse, buildCommanderRequest, parseCommanderResponse, modelIds, serviceError, refusesForcedTool} from './openai.mjs';
import {summarize,recordObservation} from './telemetry.mjs';
import {LOG_KEY,appendEntries,decisionEntry,commandEntry,eventEntry,logStats} from './logbook.mjs';

export function createBackground(c, {fetchImpl = fetch, now = Date.now, uuid = () => crypto.randomUUID()} = {}) {
  const inflight = new Map(), controlLocks = new Map(), stateLocks = new Map();
  let probing=false;
  const ready = Promise.all([
    c.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}),
    c.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}),
  ]);
  const key = tabId => `session:${tabId}`;
  // Chat models answer in seconds rather than milliseconds (reasoning models 10–25 s), so they get
  // a longer budget; the page is told to wait a little longer than the background does.
  // A commander turn reads a brief of several thousand tokens and plans the whole army: 30–50 s is normal.
  const COMMAND_TIMEOUT=90000;
  const timeoutFor = (provider,commander=false) => commander?COMMAND_TIMEOUT:provider.id==='openai'?30000:8000;
  // One decision request to whichever provider is selected, returned in Jev's answer shape.
  // Services (by endpoint and model) that refused a forced function call; they get tool_choice "auto" from then on.
  const autoToolChoice=new Set();
  async function callModel(provider,{state,questions,brief},signal){
    const openai=provider.id==='openai',endpoint=providerEndpoint(provider),route=`${endpoint} ${provider.model}`;
    const send=body=>fetchImpl(endpoint,{method:'POST',headers:authHeaders(provider),body:JSON.stringify(body),signal,redirect:'error',credentials:'omit',referrerPolicy:'no-referrer'});
    // Commander turns go through the same transport, refusal and retry handling as choice questions.
    const build=(toolChoice,mode=provider.mode)=>brief?buildCommanderRequest({model:provider.model,brief,toolChoice,mode}):buildChatRequest({model:provider.model,mode,state,questions,toolChoice});
    const parse=body=>brief?parseCommanderResponse(body,brief.legal,provider.name):parseChatResponse(body,questions,provider.name);
    const chat=toolChoice=>build(toolChoice);
    let response=await send(openai?chat(autoToolChoice.has(route)?'auto':'forced'):{model:provider.model,state,questions});
    let raw=await response.text();
    if(openai && provider.mode!=='json' && !autoToolChoice.has(route) && refusesForcedTool(response.status,serviceError(raw))){
      autoToolChoice.add(route);response=await send(chat('auto'));raw=await response.text();
    }
    if(!response.ok){const detail=openai?serviceError(raw):'';const error=new Error(httpError(response.status,provider.name)+(detail?` ${detail}`:''));error.status=response.status;throw error;}
    if(raw.length>(openai?512000:256000))throw new Error(`${provider.name} 响应过大，已拒绝处理。`);
    let parsed;try{parsed=JSON.parse(raw);}catch{throw new Error(`${provider.name} 返回的内容无法解析。`);}
    if(!openai)return validateAnswer(parsed,questions,provider.name);
    try{return parse(parsed);}
    catch(e){
      // Without a forced function call some models now and then answer in prose. One retry asking for
      // a bare JSON object; a second failure counts as a normal failed request.
      if(provider.mode==='json' || !/无法解析/.test(e.message))throw e;
      const retry=await send(build('forced','json'));
      const text=await retry.text();
      if(!retry.ok){const detail=serviceError(text);const error=new Error(httpError(retry.status,provider.name)+(detail?` ${detail}`:''));error.status=retry.status;throw error;}
      let again;try{again=JSON.parse(text);}catch{throw e;}
      return parse(again);
    }
  }
  const needsModel = provider => provider.id==='openai' && !provider.model;
  // Decision log: buffered in memory, flushed in batches so frequent events do not rewrite storage each time.
  let pending=[],flushTimer;
  async function flushLog(){
    clearTimeout(flushTimer);flushTimer=undefined;
    if(!pending.length)return;
    const batch=pending;pending=[];
    await serial(stateLocks,'log',async()=>{const current=(await c.storage.local.get(LOG_KEY))[LOG_KEY];await c.storage.local.set({[LOG_KEY]:appendEntries(Array.isArray(current)?current:[],batch)});}).catch(()=>{});
  }
  function logAppend(entry){
    if(!entry)return;pending.push(entry);
    if(pending.length>=25)flushLog();else flushTimer??=setTimeout(flushLog,1500);
  }
  const readLog=async()=>{await flushLog();const current=(await c.storage.local.get(LOG_KEY))[LOG_KEY];return Array.isArray(current)?current:[];};
  // Match records: one summary per finished autopilot session, kept for the popup's results panel.
  const MATCHES_MAX=100;
  const logKey=id=>`matchlog:${id}`;
  const sanitizeMeta=e=>({pageTitle:String(e.pageTitle??'').slice(0,120),url:String(e.url??'').slice(0,300),me:e.me?{name:String(e.me.name??'').slice(0,40),country:e.me.country?String(e.me.country).slice(0,24):undefined}:null,
    players:(Array.isArray(e.players)?e.players:[]).slice(0,16).map(p=>({name:String(p?.name??'').slice(0,40),country:p?.country?String(p.country).slice(0,24):undefined,allied:!!p?.allied,isAi:!!p?.isAi,combatant:!!p?.combatant,isObserver:!!p?.isObserver,defeated:!!p?.defeated})),
    playerCount:Number.isFinite(e.playerCount)?e.playerCount:null,opponents:Number.isFinite(e.opponents)?e.opponents:null,map:e.map&&Number.isFinite(e.map.width)?{width:e.map.width,height:e.map.height}:null,startTick:Number.isFinite(e.startTick)?e.startTick:null,startTime:Number.isFinite(e.startTime)?e.startTime:null});
  const readMatches=async()=>{const list=(await c.storage.local.get('matches')).matches;return Array.isArray(list)?list:[];};
  // Text → base64 data URL for chrome.downloads; service workers have no object URLs.
  const dataUrl=text=>{const bytes=new TextEncoder().encode(text);let bin='';for(let i=0;i<bytes.length;i+=0x8000)bin+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return 'data:application/json;base64,'+btoa(bin);};
  const stamp=at=>{const d=new Date(at),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;};
  // Automatic battle report: the match record plus every log entry of that session, saved under
  // Downloads/jev-reports without a prompt. Failures never affect the record itself.
  async function saveReport(record,entries,settings){
    if(settings.autoReport===false || !c.downloads?.download)return '';
    const file=`jev-reports/jev-report-${stamp(record.startedAt)}.json`;
    const bundle={version:c.runtime.getManifest?.()?.version??'',exportedAt:new Date(now()).toISOString(),settings:publicSettings(settings),match:record,stats:logStats(entries),entries};
    try{await c.downloads.download({url:dataUrl(JSON.stringify(bundle,null,1)),filename:file,conflictAction:'uniquify',saveAs:false});return file;}
    catch{return '';}
  }
  async function finishMatch(tabId,reason){
    const s=await getSession(tabId);
    if(!s || s.matchRecorded || !s.startedAt)return;
    const at=now(),entries=await readLog(),window=entries.filter(e=>e.at>=s.startedAt && e.at<=at),stats=logStats(window);
    const history=(s.history??[]).map(({at,gameSeconds,credits,freeCredits,decisions,ownUnits,ownBuildings,enemyUnits,enemyBuildings,ownBuilt,ownLost,enemyDestroyed})=>({at,gameSeconds,credits,freeCredits,decisions,ownUnits,ownBuildings,enemyUnits,enemyBuildings,ownBuilt,ownLost,enemyDestroyed}));
    const ledger=s.observation?.ledger??null;
    const credits=history.map(p=>p.credits).filter(Number.isFinite),seconds=history.map(p=>p.gameSeconds).filter(Number.isFinite);
    const settings=await getSettings();
    const record={id:`${s.startedAt}-${tabId}-${String(s.token??'').slice(0,8)}`,startedAt:s.startedAt,endedAt:at,durationMs:at-s.startedAt,gameSeconds:seconds.length?Math.max(0,seconds.at(-1)-seconds[0]):null,
      firstTick:s.firstTick??null,lastTick:s.lastTick??null,provider:s.provider??'jev',providerName:s.providerName??'Jev',strategyMode:s.strategyMode??'choices',providerKind:s.providerKind??(s.provider==='local'?'local':'cloud'),model:s.model??'',configuredModel:s.configuredModel??'',endpoint:s.endpoint??'',callMode:s.callMode??'',objective:settings.objective??'',reason:String(reason??'').slice(0,40),outcome:s.outcome||(reason==='battle_ended'?'ended':''),ledger,
      decisions:s.decisions??0,requests:s.requests??0,failures:s.failures??0,acceptedActions:s.acceptedActions??0,waits:s.waits??0,inputTokens:s.inputTokens??0,outputTokens:s.outputTokens??0,totalTokens:(s.inputTokens??0)+(s.outputTokens??0),latencyAvg:stats.latency.avg,latencyMax:stats.latency.max,
      credits:{start:credits[0]??null,end:credits.at(-1)??null,max:credits.length?Math.max(...credits):null,min:credits.length?Math.min(...credits):null},armyMax:s.armyMax??null,
      produced:stats.actions.acceptedProduce,actionsByType:stats.actions.byType,skippedReasons:stats.actions.skippedReasons,
      groups:Object.fromEntries(Object.entries(stats.groups).map(([id,g])=>[id,{asked:g.asked,waitRate:g.waitRate,top:Object.keys(g.choices)[0]??''}])),history};
    record.meta=s.meta??null;record.label='';record.notes='';record.logEntries=window.length;
    record.reportFile=await saveReport(record,window,settings);
    await serial(stateLocks,'matches',async()=>{
      const list=await readMatches(),next=[...list.filter(m=>m.id!==record.id),record],dropped=next.slice(0,Math.max(0,next.length-MATCHES_MAX));
      await c.storage.local.set({matches:next.slice(-MATCHES_MAX),[logKey(record.id)]:window});
      if(dropped.length)await c.storage.local.remove(dropped.map(m=>logKey(m.id)));
    }).catch(()=>{});
    await patch(tabId,current=>current?.startedAt===s.startedAt?{...current,matchRecorded:true,reportFile:record.reportFile}:current);
  }
  const getSession = async tabId => (await c.storage.session.get(key(tabId)))[key(tabId)];
  const getSettings = async () => ({...DEFAULTS,...(await c.storage.local.get('settings')).settings});
  // Whether the browser has granted access to the selected model service. Settings save without it;
  // starting or testing needs it, and the popup offers a one-click authorization.
  const permission = async config => {const origin=originPattern(activeProvider(config).apiBase);return {origin,permitted:await c.permissions.contains({origins:[origin]})};};
  const settingsView = async config => ({...privateSettings(config),...await permission(config)});
  const contentConfig = s => ({hotkey:s.hotkey,language:s.language,showOverlay:s.showOverlay,providerName:activeProvider(s).name});
  const notifyOverlay = async s => {
    if(s?.documentId)await c.tabs.sendMessage(s.tabId,{type:'OVERLAY_CHANGED',running:s.running},{documentId:s.documentId}).catch(()=>{});
  };
  const broadcastConfig = async settings => {
    for(const tab of await c.tabs.query({}))if(supportedGame(tab.url))await c.tabs.sendMessage(tab.id,{type:'CONFIG_CHANGED',...contentConfig(settings)}).catch(()=>{});
  };
  function serial(map, id, task) {
    const next = (map.get(id) ?? Promise.resolve()).catch(()=>{}).then(task);
    map.set(id,next); next.finally(()=>{if(map.get(id)===next)map.delete(id);}).catch(()=>{});
    return next;
  }
  async function patch(tabId, mutate) {
    return serial(stateLocks,tabId,async()=>{const next=mutate(await getSession(tabId));if(next)await c.storage.session.set({[key(tabId)]:next});else await c.storage.session.remove(key(tabId));return next;});
  }
  const badge = async (tabId,text,color='#d1a653') => {
    await Promise.all([c.action.setBadgeText({tabId,text}),c.action.setBadgeBackgroundColor({tabId,color})]).catch(()=>{});
  };
  const pageCall = async (tabId, method, value, documentId) => {
    const [r] = await c.scripting.executeScript({
      target:{tabId,...(documentId?{documentIds:[documentId]}:{frameIds:[0]})},world:'MAIN',
      func: async (method,value) => {
        const p=window.__werhdJevExtension;
        if(!p || typeof p[method]!=='function')return {running:false,available:false,missing:true};
        return p[method](value);
      },args:[method,value],
    });
    return r?.result;
  };
  async function stop(tabId, reason='manual') {
    inflight.get(tabId)?.abort();
    const s=await patch(tabId,s=>s?{...s,running:false,busyUntil:0,reason,updatedAt:now()}:undefined);
    if(s)logAppend({at:now(),kind:'session',event:'stop',tabId,reason,decisions:s.decisions,failures:s.failures});
    await flushLog();
    await finishMatch(tabId,reason);
    await notifyOverlay(s);
    if(s)await pageCall(tabId,'stop',reason,s.documentId).catch(()=>{});
    await badge(tabId,'');
    return {running:false,reason};
  }
  // The extension's own pages: the popup (no tab) and the data panel (opened in a tab). Content
  // scripts carry the game page's URL and never pass; the URL check is what matters, not the tab.
  function trustExtension(sender) {
    return sender.id === c.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(c.runtime.getURL('')) && (sender.frameId ?? 0) === 0;
  }
  async function authorize(sender, token) {
    if(sender.id!==c.runtime.id || sender.frameId!==0 || !sender.tab || !supportedGame(sender.url))throw new Error('不接受此页面的请求。');
    const s=await getSession(sender.tab.id);
    if(!s?.running || s.token!==token || s.documentId!==sender.documentId || s.origin!==new URL(sender.url).origin)throw new Error('托管会话已失效。');
    return s;
  }
  async function start(tabId) {
    const tab=await c.tabs.get(tabId);
    if(!supportedGame(tab.url))throw new Error('请先切换到王二火大的游戏标签页。');
    const config=validateSettings(await getSettings()),provider=activeProvider(config);
    if(provider.requiresKey && !provider.apiKey)throw new Error(provider.id==='openai'?'请先填写并保存 API 密钥。':'请先填写并保存 JEV 密钥。');
    if(needsModel(provider))throw new Error('请先获取模型列表并选择模型。');
    if(!await c.permissions.contains({origins:[originPattern(provider.apiBase)]}))throw new Error('尚未授权访问模型服务地址，请在插件中点击「授权访问」。');
    const old=await getSession(tabId);
    if(old?.running) {
      const live=await pageCall(tabId,'status',null,old.documentId).catch(()=>null);
      if(live?.running)return live;
      await stop(tabId,'stale_session');
    }
    const [injection]=await c.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',files:['content.js']});
    const documentId=injection.documentId;
    await c.scripting.executeScript({target:{tabId,documentIds:[documentId]},world:'MAIN',files:['page.js']});
    const status=await pageCall(tabId,'status',null,documentId);
    if(!status?.available)throw new Error(status?.error || '请先进入一场正在运行的对局，再开启托管。');
    const session={tabId,token:uuid(),documentId,origin:new URL(tab.url).origin,provider:provider.id,providerName:provider.name,providerKind:provider.kind,endpoint:providerEndpoint(provider),configuredModel:provider.model,model:provider.model,callMode:provider.mode??'',strategyMode:provider.strategy??'choices',running:true,startedAt:now(),updatedAt:now(),requests:0,decisions:0,failures:0,inputTokens:0,outputTokens:0,busyUntil:0,events:[],reason:'',error:'',maxDecisions:config.maxDecisions};
    await patch(tabId,()=>session);
    try {
      await c.tabs.sendMessage(tabId,{type:'BIND_SESSION',token:session.token},{documentId});
      const commander=provider.strategy==='commander';
      const result=await pageCall(tabId,'start',{token:session.token,maxDecisions:config.maxDecisions,autoCamera:config.autoCamera,objective:config.objective,...(provider.id==='openai'?{maxStaleTicks:900,requestTimeoutMs:timeoutFor(provider,commander)+5000}:{}),...(commander?{commander:true}:{})},documentId);
      if(!result?.running)throw new Error(result?.error || '托管未能启动。');
      await badge(tabId,'ON');
      logAppend({at:now(),kind:'session',event:'start',tabId,provider:provider.id,providerKind:provider.kind,model:provider.model,endpoint:session.endpoint,callMode:session.callMode,strategyMode:session.strategyMode,maxDecisions:config.maxDecisions});
      await notifyOverlay(await getSession(tabId));
      return result;
    } catch(e) { await stop(tabId,'start_failed');throw e; }
  }
  async function decide(message,sender) {
    const tabId=sender.tab?.id;
    const commander=message.body?.mode==='commander';
    const brief=commander?prepareBrief(message.body):undefined,questions=commander?undefined:prepareQuestions(message.body);
    const auth=await authorize(sender,message.token);
    const config=await getSettings(),provider=activeProvider(config);
    if(commander && provider.id!=='openai')throw new Error('指挥模式只支持「OpenAI 兼容」来源。');
    const tick=commander?brief.tick:message.body.state.tick;
    // URL and credentials are read exclusively from trusted extension settings.
    const endpoint=providerEndpoint(provider);
    if(!hostAllowed(provider.apiBase,config.allowedHosts))throw new Error('公网明文地址需要先加入「允许的外部地址」。');
    if(!await c.permissions.contains({origins:[originPattern(endpoint)]}))throw new Error('API 访问权限已被撤销，请重新保存设置。');
    try { await patch(tabId,s=>{
      if(!s?.running || s.token!==auth.token)throw new Error('托管会话已停止。');
      if(s.busyUntil>now() || inflight.has(tabId))throw new Error('上一条决策尚未完成。');
      if(s.requests>=s.maxDecisions)throw Object.assign(new Error('已达到本局决策上限，托管已停止。'),{code:'DECISION_BUDGET'});
      return {...s,requests:s.requests+1,busyUntil:now()+timeoutFor(provider,commander)+4000};
    }); } catch(e) {
      if(e.code==='DECISION_BUDGET')await stop(tabId,'decision_budget');
      throw e;
    }
    const abort=new AbortController();inflight.set(tabId,abort);
    const timeout=setTimeout(()=>abort.abort(),timeoutFor(provider,commander)),started=now();
    try {
      const result={...await callModel(provider,commander?{brief}:{state:message.body.state,questions},abort.signal),latencyMs:now()-started};
      await authorize(sender,message.token);
      await patch(tabId,s=>s?.token===auth.token?{...s,decisions:s.decisions+1,inputTokens:s.inputTokens+result.usage.input_tokens,outputTokens:s.outputTokens+result.usage.output_tokens,latencyMs:result.latencyMs,lastTick:tick,firstTick:s.firstTick??tick,
        lastChoices:commander?{}:Object.fromEntries(Object.entries(result.answers).map(([id,a])=>[id,a.choice])),model:result.model||s.model||provider.model,error:'',updatedAt:now()}:s);
      if(commander){
        const {legal,...shown}=brief;
        logAppend(commandEntry({at:now(),tick,provider:provider.id,model:result.model||provider.model,latencyMs:result.latencyMs,usage:result.usage,briefChars:JSON.stringify(shown).length,orders:result.orders,rejected:result.rejected}));
      }
      else logAppend(decisionEntry({at:now(),tick,provider:provider.id,model:result.model||provider.model,latencyMs:result.latencyMs,usage:result.usage,state:message.body.state,questions,answers:result.answers}));
      return result;
    } catch(e) {
      const current=await getSession(tabId);
      if(current?.running && current.token===auth.token){
        const error=e.name==='AbortError'?`${provider.name} 请求超时，请检查网络或 API 服务。`:e.status?e.message:e.message?.startsWith(provider.name)?e.message:'模型请求未完成，请检查 API 地址、网络或响应格式。';
        await patch(tabId,s=>s?.token===auth.token?{...s,failures:s.failures+1,error,updatedAt:now()}:s);
        logAppend({at:now(),kind:'failure',tick:Number.isFinite(tick)?tick:null,...(commander?{mode:'commander'}:{}),provider:provider.id,status:e.status??null,error:String(error).slice(0,240)});
        if([401,402,403].includes(e.status))await stop(tabId,`http_${e.status}`);
        await badge(tabId,'!', '#bd5656');
        throw new Error(error);
      }
      throw new Error('托管已停止，本次回答不再执行。');
    } finally {
      clearTimeout(timeout);if(inflight.get(tabId)===abort)inflight.delete(tabId);
      await patch(tabId,s=>s?.token===auth.token?{...s,busyUntil:0}:s);
    }
  }
  async function event(message,sender) {
    await authorize(sender,message.token);
    const e=message.event,tabId=sender.tab.id;
    if(!e || JSON.stringify(e).length>256000)throw new Error('事件无效。');
    logAppend(eventEntry(e,now()));
    await patch(tabId,s=>{
      if(!s || s.token!==message.token)return s;
      let next={...s,updatedAt:now()};
      if(e.kind==='observation'){
        next=recordObservation(next,summarize({...e.state,tick:e.tick,self:{...e.state?.self,credits:e.credits},ledger:e.ledger},now()),now());
        next.mission=e.mission;next.armyMax=Math.max(s.armyMax??0,next.army??0);
      }
      else {
        next.events=[{at:now(),kind:String(e.kind).slice(0,40),actionType:String(e.action?.type??'').slice(0,40),choice:String(e.choice??e.action?.name??'').slice(0,80),accepted:e.accepted===true,reason:String(e.reason??'').slice(0,80),text:String(e.message??e.description??e.action?.label??e.action?.name??e.choice??e.reason??e.kind).slice(0,240)},...s.events].slice(0,20);
        // A commander turn carries several orders; each one carried out counts as an accepted action.
        if(e.kind==='command')next.acceptedActions=(s.acceptedActions??0)+(Array.isArray(e.results)?e.results.filter(r=>r?.accepted===true).length:0);
        if(e.kind==='action'){
          if(e.accepted)next.acceptedActions=(s.acceptedActions??0)+1;
          if(e.reason==='wait')next.waits=(s.waits??0)+1;
        }
      }
      if(e.kind==='stop'){next.running=false;next.reason=e.reason;next.busyUntil=0;}
      if(e.kind==='outcome')next.outcome=String(e.result??'').slice(0,24);
      if(e.kind==='meta')next.meta=sanitizeMeta(e);
      if(e.kind==='error')next.error=String(e.message).slice(0,240);
      return next;
    });
    if(e.kind==='stop'){inflight.get(tabId)?.abort();await flushLog();await finishMatch(tabId,e.reason);await notifyOverlay(await getSession(tabId));await badge(tabId,'');}
    return {ok:true};
  }
  async function handle(message,sender) {
    await ready;
    if(!message || typeof message.type!=='string')throw new Error('消息无效。');
    if(message.type==='PUBLIC_CONFIG')return contentConfig(await getSettings());
    if(message.type==='OVERLAY_STATUS'){
      if(sender.id!==c.runtime.id || !sender.tab || sender.frameId!==0 || !supportedGame(sender.url))throw new Error('不支持此游戏页面。');
      const config=contentConfig(await getSettings()),s=await getSession(sender.tab.id);
      // Content scripts can read only their own active document's display fields.
      // No credentials, session tokens, event payloads or game injection in this path.
      if(!config.showOverlay || !s?.running || s.documentId!==sender.documentId || s.origin!==new URL(sender.url).origin)return {...config,running:false};
      const live=await pageCall(sender.tab.id,'status',null,s.documentId).catch(()=>null);
      const current=await getSession(sender.tab.id);
      if(!live?.running || !live.available || !current?.running || current.token!==s.token)return {...config,running:false};
      const l=current.observation?.ledger;
      return {...config,running:true,decisions:current.decisions??0,credits:current.credits,latencyMs:current.latencyMs,lastTick:current.lastTick,failures:current.failures??0,losses:l?{ownUnits:l.ownUnitsLost,ownBuildings:l.ownBuildingsLost,enemyUnits:l.enemyUnitsDestroyed,enemyBuildings:l.enemyBuildingsDestroyed}:null};
    }
    if(message.type==='DECIDE')return decide(message,sender);
    if(message.type==='EVENT')return event(message,sender);
    if(message.type==='HOTKEY_TOGGLE'){
      if(sender.id!==c.runtime.id || sender.frameId!==0 || !supportedGame(sender.url))throw new Error('不支持此游戏页面。');
      return serial(controlLocks,sender.tab.id,async()=> (await getSession(sender.tab.id))?.running?stop(sender.tab.id):start(sender.tab.id));
    }
    if(!trustExtension(sender))throw new Error('此操作只允许在插件窗口中执行。');
    if(message.type==='GET_SETTINGS')return settingsView(await getSettings());
    if(message.type==='LOG_STATS'){const entries=await readLog();return {stats:logStats(entries),chars:JSON.stringify(entries).length};}
    if(message.type==='LOG_EXPORT'){
      const entries=await readLog();
      // Settings go out without credentials; entries never contained any.
      return {exportedAt:new Date(now()).toISOString(),version:c.runtime.getManifest?.()?.version??'',settings:publicSettings(await getSettings()),stats:logStats(entries),entries};
    }
    if(message.type==='LOG_CLEAR'){pending=[];clearTimeout(flushTimer);flushTimer=undefined;await c.storage.local.remove(LOG_KEY);return {entries:0};}
    if(message.type==='MATCHES_LIST'){const list=await readMatches();return {matches:list.map(({history,...m})=>({...m,samples:history?.length??0})).reverse()};}
    if(message.type==='MATCH_GET'){const m=(await readMatches()).find(m=>m.id===message.id);if(!m)throw new Error('未找到该场战绩。');return m;}
    if(message.type==='MATCHES_CLEAR'){const list=await readMatches();await c.storage.local.remove(['matches',...list.map(m=>logKey(m.id))]);return {matches:0};}
    if(message.type==='MATCH_LOG_GET'){const entries=(await c.storage.local.get(logKey(message.id)))[logKey(message.id)];return {id:message.id,entries:Array.isArray(entries)?entries:[]};}
    if(message.type==='MATCH_UPDATE'){
      let updated;await serial(stateLocks,'matches',async()=>{const list=await readMatches();updated=list.find(m=>m.id===message.id);if(!updated)return;
        if(typeof message.label==='string')updated.label=message.label.replace(/\s+/g,' ').trim().slice(0,80);
        if(typeof message.notes==='string')updated.notes=message.notes.trim().slice(0,2000);
        if(['victory','defeat',''].includes(message.outcome)){updated.outcome=message.outcome;updated.outcomeMarked=!!message.outcome;}
        await c.storage.local.set({matches:list});});
      if(!updated)throw new Error('未找到该场战绩。');return updated;
    }
    if(message.type==='MATCH_DELETE'){
      let found=false;await serial(stateLocks,'matches',async()=>{const list=await readMatches();found=list.some(m=>m.id===message.id);await c.storage.local.set({matches:list.filter(m=>m.id!==message.id)});await c.storage.local.remove(logKey(message.id));});
      if(!found)throw new Error('未找到该场战绩。');return {deleted:message.id};
    }
    if(message.type==='MATCH_SET_OUTCOME'){
      const outcome=['victory','defeat',''].includes(message.outcome)?message.outcome:undefined;if(outcome===undefined)throw new Error('无效的对局结果。');
      let updated;await serial(stateLocks,'matches',async()=>{const list=await readMatches();updated=list.find(m=>m.id===message.id);if(!updated)return;updated.outcome=outcome;updated.outcomeMarked=!!outcome;await c.storage.local.set({matches:list});});
      if(!updated)throw new Error('未找到该场战绩。');return updated;
    }
    if(message.type==='ALLOW_HOST' || message.type==='DISALLOW_HOST'){
      const host=normalizeHost(message.host),settings=await getSettings(),current=sanitizeAllowedHosts(settings.allowedHosts);
      settings.allowedHosts=message.type==='ALLOW_HOST'?sanitizeAllowedHosts([...current,host]):current.filter(h=>h!==host);
      if(message.type==='ALLOW_HOST' && !settings.allowedHosts.includes(host))throw new Error('允许列表已满（最多 32 条）。');
      await c.storage.local.set({settings});
      return {allowedHosts:settings.allowedHosts};
    }
    if(message.type==='SET_LANGUAGE' || message.type==='SET_OVERLAY' || message.type==='SET_AUTO_REPORT'){
      const settings=await getSettings();
      if(message.type==='SET_LANGUAGE')settings.language=message.language==='en'?'en':'zh-CN';
      else if(message.type==='SET_OVERLAY')settings.showOverlay=message.showOverlay===true;
      else settings.autoReport=message.autoReport!==false;
      await c.storage.local.set({settings});
      await broadcastConfig(settings);
      return message.type==='SET_LANGUAGE'?{language:settings.language}:message.type==='SET_OVERLAY'?{showOverlay:settings.showOverlay}:{autoReport:settings.autoReport};
    }
    if(message.type==='TEST_CONNECTION'){
      if(probing)throw new Error('连接测试正在进行，请稍候。');
      probing=true;
      let name='Jev',timer;const abort=new AbortController(),started=now();
      try{
        const config=validateSettings(await getSettings()),provider=activeProvider(config);
        name=provider.name;timer=setTimeout(()=>abort.abort(),timeoutFor(provider));
        if(provider.requiresKey && !provider.apiKey)throw new Error(provider.id==='openai'?'请先填写并保存 API 密钥。':'请先填写并保存 JEV 密钥。');
        if(needsModel(provider))throw new Error('请先获取模型列表并选择模型。');
        if(!await c.permissions.contains({origins:[originPattern(provider.apiBase)]}))throw new Error('尚未授权访问模型服务地址，请在插件中点击「授权访问」。');
        const questions={connection:{type:'choice',instructions:'Connection check only. Select ok. No game actions will be executed.',criteria:{ok:'Connection accepted'}}};
        const result=await callModel(provider,{state:{purpose:'extension_connection_check'},questions},abort.signal);
        return {latencyMs:now()-started,provider:provider.id,providerName:name,model:result.model,usage:result.usage};
      }catch(e){throw new Error(e.name==='AbortError'?`${name} 连接测试超时。`:new RegExp(`^(${name}|请先|尚未)`).test(e.message)?e.message:`${name} 连接失败，请检查地址、网络或响应格式。`);}
      finally{probing=false;clearTimeout(timer);}
    }
    if(message.type==='LIST_MODELS'){
      // The popup may pass the base and key it is showing, so the list can be loaded before saving.
      const settings=await getSettings();
      const base=String(message.base??settings.openaiBase??DEFAULTS.openaiBase).trim(),apiKey=String(message.apiKey??settings.openaiKey??'').trim();
      const url=serviceUrl(base,'/models'),savedBase=String(settings.openaiBase??DEFAULTS.openaiBase).trim();
      // The stored key never goes to a different service than the one it was saved for.
      if(settings.openaiKey && apiKey===settings.openaiKey && new URL(url).origin!==new URL(serviceUrl(savedBase,'/models')).origin)throw new Error('更换 API 服务时，请重新输入该服务的密钥。');
      if(!hostAllowed(base,settings.allowedHosts))throw new Error('公网明文地址需要先加入「允许的外部地址」。');
      if(!await c.permissions.contains({origins:[originPattern(base)]}))throw new Error('尚未授权访问模型服务地址，请在插件中点击「授权访问」。');
      const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),10000);
      try{
        const response=await fetchImpl(url,{method:'GET',headers:authHeaders({apiKey}),signal:abort.signal,redirect:'error',credentials:'omit',referrerPolicy:'no-referrer'});
        const raw=await response.text();
        if(!response.ok){const detail=serviceError(raw);throw Object.assign(new Error(httpError(response.status,'OpenAI')+(detail?` ${detail}`:'')),{status:response.status});}
        let models;try{models=modelIds(JSON.parse(raw));}catch{models=[];}
        if(!models.length)throw new Error('模型列表为空，请确认该服务支持 /models 接口。');
        // Remember the list for this base so the dropdown is filled next time the popup opens.
        const current=await getSettings();
        if(String(current.openaiBase??DEFAULTS.openaiBase).trim()===base)await c.storage.local.set({settings:{...current,openaiModels:models}});
        return {models,base};
      }catch(e){throw new Error(e.name==='AbortError'?'获取模型列表超时。':e.status||/^模型列表/.test(e.message)?e.message:'获取模型列表失败，请检查地址、密钥和网络。');}
      finally{clearTimeout(timer);}
    }
    if(message.type==='SAVE_SETTINGS'){
      const prior=await getSettings(),input=message.settings??{};
      // The form shows the stored keys, so what it sends is what gets saved; a message without
      // a key field keeps the stored one. A new Jev host must come with a key typed for it.
      const keep=field=>typeof input[field]==='string'?input[field].trim():prior[field];
      const apiKey=keep('apiKey'),localKey=keep('localKey'),openaiKey=keep('openaiKey');
      const origin=value=>new URL(apiEndpoint(value)).origin;
      if(input.apiBase && origin(input.apiBase)!==origin(prior.apiBase) && (!apiKey || apiKey===prior.apiKey))throw new Error('更换 API 服务时，请重新输入该服务的密钥。');
      if(input.openaiBase && prior.openaiKey && origin(input.openaiBase)!==origin(prior.openaiBase??DEFAULTS.openaiBase) && openaiKey===prior.openaiKey)throw new Error('更换 API 服务时，请重新输入该服务的密钥。');
      // The remembered model list belongs to the base it came from; the popup sends the list it loaded.
      const openaiModels=Array.isArray(input.openaiModels)?input.openaiModels:input.openaiBase && input.openaiBase.trim()!==String(prior.openaiBase??DEFAULTS.openaiBase).trim()?[]:prior.openaiModels;
      const config=validateSettings({...input,apiKey,localKey,openaiKey,openaiModels},prior);
      const before=activeProvider(prior),after=activeProvider(config);
      if(before.id!==after.id || after.apiKey!==before.apiKey || after.apiBase!==before.apiBase || after.model!==before.model || after.mode!==before.mode || after.strategy!==before.strategy){for(const s of Object.values(await c.storage.session.get(null)))if(s?.running)await stop(s.tabId,'settings_changed');}
      await c.storage.local.set({settings:config});
      await broadcastConfig(config);
      return settingsView(config);
    }
    if(message.type==='CLEAR_KEY'){
      const field=PROVIDER_FIELDS[message.provider]?.key??'apiKey';
      for(const s of Object.values(await c.storage.session.get(null)))if(s?.running)await stop(s.tabId,'key_removed');
      await c.storage.local.set({settings:{...await getSettings(),[field]:''}});return {localKey:{hasLocalKey:false},openaiKey:{hasOpenaiKey:false}}[field]??{hasKey:false};
    }
    const tabId=message.tabId;
    if(!Number.isInteger(tabId))throw new Error('未找到当前游戏标签页。');
    if(message.type==='GET_STATUS'){
      const tab=await c.tabs.get(tabId),s=await getSession(tabId);
      let live;
      if(s?.running){live=await pageCall(tabId,'status',null,s.documentId).catch(()=>null);if(!live?.running)await stop(tabId,'page_disconnected');}
      let observed;
      if(supportedGame(tab.url)){
        observed=await pageCall(tabId,'observe',null,s?.documentId).catch(()=>null);
        if(observed?.missing){
          await c.scripting.executeScript({target:{tabId,frameIds:[0]},world:'MAIN',files:['page.js']});
          observed=await pageCall(tabId,'observe',null).catch(()=>null);
        }
        if(observed?.available && observed.snapshot){
          await patch(tabId,current=>{
            const changed=current?.battleId && current.battleId!==observed.battleId;
            const base=changed||!current?{tabId,running:false,decisions:0,events:[]}:current;
            return {...recordObservation(base,observed.snapshot,now()),battleId:observed.battleId};
          });
        }
      }
      const current=await getSession(tabId);
      if(!current)return {running:false,supported:supportedGame(tab.url),title:tab.title,liveObservation:false};
      const {token,documentId,origin,...safe}=current;
      return {...safe,supported:supportedGame(tab.url),title:tab.title,liveObservation:!!observed?.available};
    }
    if(message.type==='START')return serial(controlLocks,tabId,()=>start(tabId));
    if(message.type==='STOP')return serial(controlLocks,tabId,()=>stop(tabId));
    throw new Error('未知插件操作。');
  }
  c.runtime.onMessage.addListener((message,sender,respond)=>{handle(message,sender).then(value=>respond({ok:true,value}),e=>respond({ok:false,error:e.message}));return true;});
  c.tabs.onRemoved.addListener(tabId=>{inflight.get(tabId)?.abort();patch(tabId,()=>undefined).catch(()=>{});});
  c.tabs.onUpdated.addListener((tabId,change)=>{if(change.status==='loading'){inflight.get(tabId)?.abort();patch(tabId,()=>undefined).catch(()=>{});badge(tabId,'');}});
  return {handle,ready,getSession};
}
