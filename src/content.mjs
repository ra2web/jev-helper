import {t,errorText} from './i18n.mjs';
import {CHANNEL, DEFAULTS, hotkeyFromEvent} from './shared.mjs';
import {createOverlayMonitor,createOverlayView} from './overlay.mjs';

if (!globalThis.__werhdJevContent) {
  globalThis.__werhdJevContent = true;
  let token='',hotkey=DEFAULTS.hotkey,language=DEFAULTS.language,providerName='Jev';
  const rpc = async message => {
    const response=await chrome.runtime.sendMessage(message);
    if(!response?.ok)throw new Error(response?.error||'扩展后台未响应，请重新加载插件后刷新游戏页面。');
    return response.value;
  };
  const overlay=createOverlayMonitor({rpc,createView:createOverlayView});
  const configure=c=>{hotkey=c.hotkey??hotkey;language=c.language??language;providerName=c.providerName??providerName;overlay.configure({hotkey,language,providerName,showOverlay:c.showOverlay??DEFAULTS.showOverlay});};
  rpc({type:'PUBLIC_CONFIG'}).then(configure).catch(()=>{});
  document.addEventListener('visibilitychange',()=>overlay.setActive(document.visibilityState!=='hidden'));
  window.addEventListener('pagehide',()=>overlay.setActive(false));
  window.addEventListener('pageshow',()=>overlay.setActive(document.visibilityState!=='hidden'));
  chrome.runtime.onMessage.addListener((m,_sender,respond)=>{
    if(m.type==='BIND_SESSION'){token=m.token;respond({ok:true});}
    if(m.type==='CONFIG_CHANGED'){configure(m);respond({ok:true});}
    if(m.type==='OVERLAY_CHANGED'){overlay.changed(m.running===true);respond({ok:true});}
  });
  window.addEventListener('message',async event=>{
    const m=event.data;
    if(event.source!==window || event.origin!==location.origin || m?.channel!==CHANNEL || m.direction!=='to-extension' || !token || m.token!==token)return;
    if(!['DECIDE','EVENT'].includes(m.type))return;
    try {
      const value=await rpc({type:m.type,token,body:m.body,event:m.event});
      if(m.type==='EVENT' && m.event?.kind==='stop' && m.token===token)overlay.changed(false);
      if(m.id)window.postMessage({channel:CHANNEL,direction:'to-page',token,id:m.id,ok:true,value},location.origin);
    } catch(e) {
      if(m.id)window.postMessage({channel:CHANNEL,direction:'to-page',token,id:m.id,ok:false,error:e.message},location.origin);
    }
  });
  const toast = text => {
    let host=document.getElementById('werhd-jev-toast');
    if(!host){host=document.createElement('div');host.id='werhd-jev-toast';document.documentElement.append(host);}
    // No model response or external HTML is inserted into the page.
    host.textContent=text;host.style.cssText='position:fixed;z-index:2147483647;top:20px;left:50%;transform:translateX(-50%);padding:12px 20px;border:1px solid #bc9a57;background:#131d27;color:#fff5da;border-radius:9px;font:14px system-ui;pointer-events:none';
    setTimeout(()=>host.remove(),4500);
  };
  window.addEventListener('keydown',event=>{
    const target=event.composedPath()[0];
    if(!event.isTrusted || event.repeat || event.isComposing || target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName))return;
    if(hotkeyFromEvent(event)!==hotkey)return;
    event.preventDefault();event.stopImmediatePropagation();
    rpc({type:'HOTKEY_TOGGLE'}).then(s=>{overlay.changed(s.running);toast(t(language,s.running?'toastOn':'toastOff',{name:providerName}));},e=>toast(errorText(language,e.message)));
  },true);
}
