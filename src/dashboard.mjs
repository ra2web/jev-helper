// Full-page history: every match this browser recorded, its metadata, curves and decisions.
// The popup keeps configuration and live control; everything historical lives here.
import {t,errorText,messages} from './i18n.mjs';
import {drawChart} from './charts.mjs';
import {logStats} from './logbook.mjs';
const $=id=>document.getElementById(id);
const rpc=async message=>{const r=await chrome.runtime.sendMessage(message);if(!r?.ok)throw new Error(r?.error||'插件后台未响应。');return r.value;};
let language=localStorage.dashboardLanguage||'zh-CN',matches=[],selected,detail,detailLog=[];
const tr=(key,vars)=>t(language,key,vars);
const format=n=>typeof n==='number'&&Number.isFinite(n)?Math.round(n).toLocaleString(language):'—';
const fmtDuration=ms=>{const s=Math.max(0,Math.round((ms??0)/1000)),h=Math.floor(s/3600),m=Math.floor(s%3600/60),sec=s%60;return h?`${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`:`${m}:${String(sec).padStart(2,'0')}`;};
const when=at=>new Date(at).toLocaleString(language,{hour12:false});
const tokensOf=m=>(m.totalTokens??((m.inputTokens??0)+(m.outputTokens??0)));
const kindText=m=>tr(`kind_${m.providerKind??(m.provider==='local'?'local':'cloud')}`);
const outcomeText=m=>tr(messages[`matchOutcome_${m.outcome}`]?`matchOutcome_${m.outcome}`:'matchOutcome_');
let noticeTimer;
function notice(text,success=false){const el=$('notice');el.textContent=success?text:errorText(language,text);el.classList.toggle('success',success);el.hidden=!text;clearTimeout(noticeTimer);if(success)noticeTimer=setTimeout(()=>{el.hidden=true;},4000);}
function downloadJson(name,data){const blob=new Blob([JSON.stringify(data,null,1)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
const stamp=at=>new Date(at).toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15);
function translate(){
 document.documentElement.lang=language;document.title=tr('dashboardTitle');
 for(const e of document.querySelectorAll('[data-i18n]'))e.textContent=tr(e.dataset.i18n);
 $('lang-en').setAttribute('aria-pressed',language==='en');$('lang-zh').setAttribute('aria-pressed',language!=='en');
 renderSummary();renderList();if(detail)renderDetail();
}
function renderSummary(){
 const box=$('summary');box.replaceChildren();if(!matches.length)return;
 const wins=matches.filter(m=>m.outcome==='victory').length,losses=matches.filter(m=>m.outcome==='defeat').length;
 const total=matches.reduce((n,m)=>n+(m.decisions??0),0),time=matches.reduce((n,m)=>n+(m.durationMs??0),0),tokens=matches.reduce((n,m)=>n+tokensOf(m),0);
 for(const text of [tr('summaryMatches',{n:matches.length}),tr('summaryWins',{w:wins,l:losses,u:matches.length-wins-losses}),tr('summaryDecisions',{n:format(total)}),tr('summaryTokens',{n:format(tokens)}),tr('summaryTime',{t:fmtDuration(time)})]){const span=document.createElement('span');span.textContent=text;box.append(span);}
}
function renderList(){
 const rows=$('match-rows');rows.replaceChildren();$('matches-count').textContent=matches.length?String(matches.length):'';$('matches-empty').hidden=matches.length>0;
 for(const m of matches){
  const tr_=document.createElement('tr');tr_.setAttribute('aria-selected',String(m.id===selected));tr_.tabIndex=0;
  const cells=[when(m.startedAt),m.label||m.meta?.pageTitle||'—',`${kindText(m)} · ${m.providerName||'Jev'}${m.model?' · '+m.model:''}`,outcomeText(m),fmtDuration(m.durationMs),format(m.decisions),format(tokensOf(m)),format(m.credits?.end),format(m.armyMax),m.ledger?`${format((m.ledger.ownUnitsLost??0)+(m.ledger.ownBuildingsLost??0))} / ${format((m.ledger.enemyUnitsDestroyed??0)+(m.ledger.enemyBuildingsDestroyed??0))}`:'—'];
  cells.forEach((text,i)=>{const td=document.createElement('td');td.textContent=text;if(i>=4)td.className='num';tr_.append(td);});
  const open=()=>select(m.id);tr_.addEventListener('click',open);tr_.addEventListener('keydown',e=>{if(e.key==='Enter')open();});rows.append(tr_);
 }
}
function renderDetail(){
 const m=detail;$('detail').hidden=!m;if(!m)return;
 $('detail-title').textContent=`${when(m.startedAt)}${m.label?' · '+m.label:''}`;$('detail-outcome').textContent=outcomeText(m);
 for(const [id,value] of [['mark-victory','victory'],['mark-defeat','defeat']])$(id).setAttribute('aria-pressed',String(m.outcome===value&&m.outcomeMarked===true));
 const meta=$('meta');meta.replaceChildren();const line=(box,text)=>{const p=document.createElement('p');p.textContent=text;box.append(p);};
 if(m.meta){
  line(meta,`${tr('metaPage')}：${m.meta.pageTitle||'—'}`);if(m.meta.url)line(meta,m.meta.url);
  if(m.meta.map)line(meta,`${tr('metaMap')}：${m.meta.map.width} × ${m.meta.map.height}`);
  if(m.meta.startTick!=null)line(meta,`${tr('metaStart')}：${format(m.meta.startTick)} / ${format(m.meta.startTime)}`);
  const players=m.meta.players??[];if(players.length){line(meta,`${tr('metaPlayers')}（${m.meta.playerCount??players.length}）：`);const ul=document.createElement('ul');for(const p of players){const li=document.createElement('li');li.textContent=`${p.name}${p.country?' · '+p.country:''} · ${p.isAi?tr('metaAi'):tr('metaHuman')} · ${p.name===m.meta.me?.name?'我 / me':p.allied?tr('metaAlly'):tr('metaEnemy')}${p.defeated?' · ✗':''}`;ul.append(li);}meta.append(ul);}
 } else line(meta,tr('metaNone'));
 if(m.objective)line(meta,tr('matchObjective',{objective:m.objective}));
 $('label').value=m.label||'';$('notes').value=m.notes||'';
 $('m-duration').textContent=fmtDuration(m.durationMs);$('m-decisions').textContent=format(m.decisions);$('m-credits').textContent=format(m.credits?.end);$('m-army').textContent=format(m.armyMax);
 const facts=$('facts');facts.replaceChildren();
 line(facts,tr('matchModelInfo',{kind:kindText(m),provider:m.providerName||'Jev',model:m.model||m.configuredModel||'—',mode:m.callMode?` · ${tr(m.callMode==='json'?'callMode_json':'callMode_tools')}`:''}));
 line(facts,tr('matchStrategy',{mode:tr(m.strategyMode==='commander'?'strategy_commander':'strategy_choices')}));
 if(m.endpoint)line(facts,tr('matchEndpoint',{endpoint:m.endpoint}));
 line(facts,tr('matchTokens',{input:format(m.inputTokens??0),output:format(m.outputTokens??0),total:format(tokensOf(m)),avg:m.decisions?format(tokensOf(m)/m.decisions):'—'}));
 line(facts,tr('matchFacts',{provider:m.providerName||'Jev',model:m.model||'—',requests:m.requests,failures:m.failures,avg:m.latencyAvg??'—',game:m.gameSeconds!=null?fmtDuration(m.gameSeconds*1000):'—'}));
 line(facts,tr('matchActions',{accepted:m.acceptedActions,waits:m.waits,army:format(m.armyMax),start:format(m.credits?.start),end:format(m.credits?.end),max:format(m.credits?.max)}));
 const produced=Object.entries(m.produced??{}).map(([k,v])=>`${k}×${v}`).join('，');line(facts,produced?tr('logProduce',{list:produced}):tr('logNoProduce'));
 if(m.ledger)line(facts,`${tr('ownUnitsLost')} ${format(m.ledger.ownUnitsLost)} · ${tr('ownBuildingsLost')} ${format(m.ledger.ownBuildingsLost)} · ${tr('enemyUnitsKilled')} ${format(m.ledger.enemyUnitsDestroyed)} · ${tr('enemyBuildingsKilled')} ${format(m.ledger.enemyBuildingsDestroyed)}`);
 line(facts,tr('matchReason',{reason:messages[m.reason]?tr(m.reason):m.reason||'—'}));if(m.reportFile)line(facts,tr('matchReport',{file:m.reportFile}));
 const h=m.history??[];
 drawChart($('c-economy'),h,[{key:'credits',label:'creditsLegend',color:'#d9b76f'},{key:'freeCredits',label:'freeLegend',color:'#91cbb1'}],language,tr('economyChart'));
 drawChart($('c-decisions'),h,[{key:'decisions',label:'decisionLegend',color:'#d9b76f'}],language,tr('decisionChart'));
 drawChart($('c-force'),h,[{key:'ownUnits',label:'ownUnitsLegend',color:'#91cbb1'},{key:'ownBuildings',label:'ownBuildingsLegend',color:'#d9b76f'},{key:'enemyUnits',label:'enemyUnitsLegend',color:'#ed9383'}],language,tr('forceChart'));
 drawChart($('c-loss'),h,[{key:'ownBuilt',label:'builtLegend',color:'#d9b76f'},{key:'ownLost',label:'lostLegend',color:'#ed9383'},{key:'enemyDestroyed',label:'destroyedLegend',color:'#91cbb1'}],language,tr('lossChart'));
 const groups=$('group-rows');groups.replaceChildren();
 for(const [id,g] of Object.entries(m.groups??{})){const row=document.createElement('tr');row.style.cursor='default';for(const text of [id,format(g.asked),`${g.waitRate}%`,g.top||'—']){const td=document.createElement('td');td.textContent=text;row.append(td);}groups.append(row);}
 renderLog();
}
const KEY_KINDS=new Set(['session','start','stop','outcome','failure','error','place','meta']);
// One commander order in a line: what was ordered and, on the page's entry, whether it was carried out.
const orderText=o=>`${o.kind==='production'?`${o.item}×${o.count??1}`:o.kind==='engineer'?`${o.action} #${o.target}`:`${o.squad} ${o.action}${o.target!=null?' #'+o.target:''}${o.x!=null?` (${o.x},${o.y})`:''}`}${o.accepted===true?' ✓':o.accepted===false?` ✗ ${o.reason??''}`:''}${o.auto?' auto':''}${o.why?`「${o.why}」`:''}`;
const rejectedText=list=>(list??[]).length?`✗ ${list.map(r=>`${r.squad??r.item??r.action??r.kind} ${r.reason??''}`).join('; ')}`:'';
const commandText=e=>[e.note,[...(e.orders??[]),...(e.auto??[])].map(orderText).join('; '),rejectedText(e.rejected)].filter(Boolean).join(' ｜ ');
function renderLog(){
 const tl=$('timeline');tl.replaceChildren();
 for(const e of detailLog.filter(e=>KEY_KINDS.has(e.kind)||(e.kind==='command'&&e.executed)||(e.kind==='action'&&(e.auto||e.reason==='auto_explore'))).slice(0,200)){
  const li=document.createElement('li'),b=document.createElement('b'),span=document.createElement('span');b.textContent=e.tick!=null?`#${format(e.tick)}`:new Date(e.at).toLocaleTimeString(language,{hour12:false});
  span.textContent=e.kind==='command'?`${tr('event_command')} · ${commandText(e)}`:e.kind==='session'?`${e.event} · ${e.provider??''} ${e.model??''} ${e.reason??''}`.trim():e.kind==='action'?`auto ${e.choice}`:e.kind==='failure'?`${tr('failures',{n:1})} · ${e.error??''}`:e.kind==='outcome'?`${tr('event_outcome')} · ${e.result}`:e.kind==='stop'?`${tr('event_stop')} · ${messages[e.reason]?tr(e.reason):e.reason??''}`:e.kind==='meta'?`meta · ${e.pageTitle??''}`:e.kind==='place'?`${tr('event_place')} · ${e.name??''}`:`${e.kind} · ${e.message??e.text??e.policy??''}`;
  li.append(b,span);tl.append(li);
 }
 const rows=$('decision-rows');rows.replaceChildren();const decisions=detailLog.filter(e=>e.kind==='decision'||(e.kind==='command'&&!e.executed));const LIMIT=300;
 $('decisions-hint').textContent=tr('decisionsHint',{n:Math.min(LIMIT,decisions.length)});
 for(const d of decisions.slice(0,LIMIT)){const row=document.createElement('tr');row.style.cursor='default';const choices=d.kind==='command'?`${tr('event_command')} · ${[d.note,(d.orders??[]).map(o=>`${orderText(o)}${o.reason?`「${o.reason}」`:''}`).join('  '),rejectedText(d.rejected)].filter(Boolean).join(' ｜ ')}`:Object.entries(d.groups??{}).map(([id,g])=>`${id}=${g.choice}${g.fallback?'*':''}${g.confidence!=null?` (${Math.round(g.confidence*100)}%)`:''}${g.reason?`「${g.reason}」`:''}`).join('  ');for(const [text,cls] of [[format(d.tick),'num'],[choices,''],[d.latencyMs!=null?`${format(d.latencyMs)} ms`:'—','num']]){const td=document.createElement('td');td.textContent=text;td.className=cls;if(!cls)td.style.whiteSpace='normal';row.append(td);}rows.append(row);}
}
async function select(id){
 selected=id;renderList();
 try{detail=await rpc({type:'MATCH_GET',id});detailLog=(await rpc({type:'MATCH_LOG_GET',id})).entries;renderDetail();$('detail').scrollIntoView({behavior:'smooth',block:'start'});}
 catch(e){notice(e.message);}
}
async function refresh(){
 try{matches=(await rpc({type:'MATCHES_LIST'})).matches;if(selected&&!matches.some(m=>m.id===selected)){selected=undefined;detail=undefined;detailLog=[];}renderSummary();renderList();if(!detail)$('detail').hidden=true;}
 catch(e){notice(e.message);}
 try{const data=await rpc({type:'LOG_STATS'});renderLogStats(data);}catch(e){notice(e.message);}
}
function renderLogStats(data){
 const box=$('log-stats');box.replaceChildren();const s=data?.stats;$('log-size').textContent=data?.chars?tr('logSize',{kb:Math.round(data.chars/1024)}):'';
 const line=text=>{const p=document.createElement('p');p.textContent=text;box.append(p);};
 if(!s||!s.entries){line(tr('logEmpty'));$('log-export').disabled=true;$('log-clear').disabled=true;return;}
 $('log-export').disabled=false;$('log-clear').disabled=false;
 line(tr('logSummary',{entries:s.entries,sessions:s.sessions,decisions:s.decisions,failures:s.failures,avg:s.latency.avg??'—'}));
 const reasons=Object.entries(s.actions.skippedReasons).slice(0,3).map(([k,v])=>`${k} ${v}`).join('，');
 line(tr('logActions',{accepted:s.actions.accepted,waits:s.actions.waits,skipped:s.actions.skipped,reasons:reasons?`（${reasons}）`:''}));
 if(s.commands?.count)line(tr('logCommands',{count:s.commands.count,avg:s.commands.latencyAvg??'—',rejected:s.commands.rejected,executed:s.commands.executed,notExecuted:s.commands.notExecuted,auto:s.commands.autoDefense}));
 for(const [id,g] of Object.entries(s.groups))line(tr('logGroupLine',{id,asked:g.asked,rate:g.waitRate,options:g.avgOptions,confidence:g.avgConfidence}));
}
for(const [id,lang] of [['lang-zh','zh-CN'],['lang-en','en']])$(id).addEventListener('click',()=>{language=lang;localStorage.dashboardLanguage=lang;translate();});
$('save-meta').addEventListener('click',async()=>{if(!detail)return;try{detail=await rpc({type:'MATCH_UPDATE',id:detail.id,label:$('label').value,notes:$('notes').value});matches=matches.map(x=>x.id===detail.id?{...x,label:detail.label,notes:detail.notes}:x);renderList();renderDetail();notice(tr('metaSaved'),true);}catch(e){notice(e.message);}});
for(const [id,outcome] of [['mark-victory','victory'],['mark-defeat','defeat'],['mark-clear','']])$(id).addEventListener('click',async()=>{if(!detail)return;try{detail=await rpc({type:'MATCH_UPDATE',id:detail.id,outcome});matches=matches.map(x=>x.id===detail.id?{...x,outcome:detail.outcome,outcomeMarked:detail.outcomeMarked}:x);renderSummary();renderList();renderDetail();notice(tr('matchMarked',{outcome:outcomeText(detail)}),true);}catch(e){notice(e.message);}});
$('export-match').addEventListener('click',()=>{if(!detail)return;downloadJson(`jev-match-${stamp(detail.startedAt)}.json`,{exportedAt:new Date().toISOString(),match:detail,stats:logStats(detailLog),entries:detailLog});notice(tr('matchExported',{file:`jev-match-${stamp(detail.startedAt)}.json`}),true);});
$('delete-match').addEventListener('click',async()=>{if(!detail||!confirm(tr('confirmDelete')))return;try{await rpc({type:'MATCH_DELETE',id:detail.id});detail=undefined;detailLog=[];selected=undefined;notice(tr('matchDeleted'),true);await refresh();}catch(e){notice(e.message);}});
$('export-all').addEventListener('click',async()=>{
 $('export-all').disabled=true;
 try{const full=[];for(const m of matches){const record=await rpc({type:'MATCH_GET',id:m.id});const {entries}=await rpc({type:'MATCH_LOG_GET',id:m.id});full.push({match:record,entries});}
  downloadJson(`jev-history-${stamp(Date.now())}.json`,{exportedAt:new Date().toISOString(),matches:full});notice(tr('allExported',{n:full.length}),true);}
 catch(e){notice(e.message);}finally{$('export-all').disabled=false;}
});
$('clear-all').addEventListener('click',async()=>{if(!matches.length||!confirm(tr('confirmClearAll')))return;try{await rpc({type:'MATCHES_CLEAR'});detail=undefined;detailLog=[];selected=undefined;await refresh();}catch(e){notice(e.message);}});
$('log-export').addEventListener('click',async()=>{try{const data=await rpc({type:'LOG_EXPORT'});const file=`jev-log-${stamp(Date.now())}.json`;downloadJson(file,data);notice(tr('logExported',{file}),true);}catch(e){notice(e.message);}});
$('log-clear').addEventListener('click',async()=>{try{await rpc({type:'LOG_CLEAR'});notice(tr('logCleared'),true);await refresh();}catch(e){notice(e.message);}});
translate();await refresh();
