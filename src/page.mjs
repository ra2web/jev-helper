import {attachJevPlayer} from './player/werhd-jev-player.mjs';
import {CHANNEL} from './shared.mjs';
import {createObserver} from './observer.mjs';

const VERSION='0.4.4';
if(window.__werhdJevExtension?.version!==VERSION){
  window.__werhdJevExtension?.dispose?.();
  let player,token='',api;
  const pending=new Map();
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
    const timer=setTimeout(()=>{finish();reject(new Error('扩展后台响应超时，请检查插件状态。'));},15000);
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
      token=options.token;api=window.werhd;
      player=await attachJevPlayer(api,{maxDecisions:options.maxDecisions,autoCamera:options.autoCamera,objective:options.objective,requestDecision,onEvent:event=>{
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
