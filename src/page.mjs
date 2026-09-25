import {attachJevPlayer} from './player/werhd-jev-player.mjs';
import {CHANNEL} from './shared.mjs';
import {createObserver} from './observer.mjs';

const VERSION='0.7.5';
if(window.__werhdJevExtension?.version!==VERSION){
  window.__werhdJevExtension?.dispose?.();
  let player,token='',api;
  const pending=new Map();
  // Chat models may think for tens of seconds; the background says how long to wait per provider.
  let requestTimeoutMs=15000;
  const post = data => window.postMessage({channel:CHANNEL,direction:'to-extension',token,...data},location.origin);
  const receive = e => {
    const m=e.data;
    if(e.source!==window || e.origin!==location.origin || m?.channel!==CHANNEL || m.direction!=='to-page' || m.token!==token)return;
    const request=pending.get(m.id);if(!request)return;
    request.finish();m.ok?request.resolve(m.value):request.reject(new Error(m.error||'模型请求失败。'));
  };
  window.addEventListener('message',receive);
  const requestDecision=(body,{signal})=>new Promise((resolve,reject)=>{
    if(signal.aborted)return reject(new DOMException('Stopped','AbortError'));
    const id=crypto.randomUUID();
    const cancel=()=>{finish();reject(new DOMException('Stopped','AbortError'));};
    const timer=setTimeout(()=>{finish();reject(new Error('扩展后台响应超时，请检查插件状态。'));},requestTimeoutMs);
    const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);pending.delete(id);};
    pending.set(id,{resolve,reject,finish});signal.addEventListener('abort',cancel,{once:true});post({type:'DECIDE',id,body});
  });
  function availability() {
    try{
      const a=window.werhd;if(!a)return {available:false,error:'请先进入一场正在运行的对局。'};
      const me=a.me();a.tick();
      if(!me?.combatant || me.isObserver || me.defeated)return {available:false,error:'当前是观察者、已战败或尚未进入对局，无法托管。'};
      if(typeof a.rules!=='function' || typeof a.order!=='function')return {available:false,error:'此游戏版本缺少所需玩家 API，请使用已支持的在线版本。'};
      return {available:true};
    }catch{return {available:false,error:'对局已经结束或尚未开始。'};}
  }
  function stop(reason='manual') {player?.stop(reason);return {running:false,reason};}
  window.__werhdJevExtension={
    version:VERSION,
    observe:createObserver(()=>window.werhd),
    status:()=>({...availability(),running:!!player?.status.running,decisions:player?.status.decisions??0,failures:player?.status.failures??0}),
    start:async options=>{
      const state=availability();if(!state.available)return {...state,running:false};
      if(player?.status.running && token===options.token)return {running:true};
      player?.stop('session_replaced');
      // Stop an older manually attached client to avoid two controllers commanding one player.
      window.werhdJev?.stop?.('extension_takeover');
      token=options.token;api=window.werhd;requestTimeoutMs=Number.isInteger(options.requestTimeoutMs)?options.requestTimeoutMs:15000;
      // Match metadata the public API can give: players, map size, clock, plus the page's own title and URL.
      // There is no map or mission name in the API, so the page title is the closest handle.
      const meta=(()=>{try{
        const players=(api.players?.()??[]).slice(0,16).map(p=>({name:String(p.name??'').slice(0,40),country:p.country?String(p.country).slice(0,24):undefined,allied:!!p.allied,isAi:!!p.isAi,combatant:!!p.combatant,isObserver:!!p.isObserver,defeated:!!p.defeated}));
        const me=api.me();
        return {pageTitle:String(document.title).slice(0,120),url:(location.origin+location.pathname+location.hash).slice(0,300),me:{name:String(me?.name??'').slice(0,40),country:me?.country?String(me.country).slice(0,24):undefined},players,playerCount:players.filter(p=>p.combatant&&!p.isObserver).length,opponents:players.filter(p=>!p.allied&&p.combatant&&!p.isObserver).length,map:api.map?.size?.(),startTick:api.tick(),startTime:api.time()};
      }catch{return null;}})();
      if(meta)post({type:'EVENT',event:{kind:'meta',...meta}});
      player=await attachJevPlayer(api,{maxDecisions:options.maxDecisions,autoCamera:options.autoCamera,objective:options.objective,commander:options.commander===true,...(Number.isInteger(options.maxStaleTicks)?{maxStaleTicks:options.maxStaleTicks}:{}),requestDecision,onEvent:event=>{
        post({type:'EVENT',event});
      }});
      return {running:true};
    },
    stop,
    dispose:()=>{stop('extension_updated');window.removeEventListener('message',receive);},
  };
  // Public API identity changes between matches: never carry control into a new battle.
  const lifecycle=setInterval(()=>{if(player?.status.running && window.werhd!==api)stop('battle_changed');},1000);
  const dispose=window.__werhdJevExtension.dispose;
  window.__werhdJevExtension.dispose=()=>{clearInterval(lifecycle);dispose();};
  window.addEventListener('pagehide',()=>stop('page_left'),{once:true});
}
