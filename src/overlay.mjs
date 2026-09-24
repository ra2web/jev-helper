import {DEFAULTS} from './shared.mjs';
import {t} from './i18n.mjs';

// State notifications handle start/stop immediately. Poll only while visible and
// running, to update metrics and recover if the page controller disconnects.
export function createOverlayMonitor({rpc,createView,schedule=setTimeout,cancel=clearTimeout}) {
  let config={...DEFAULTS},status={running:false},view,timer,revision=0,active=true,disposed=false;
  function invalidate(){revision++;cancel(timer);timer=undefined;}
  function hide(){view?.destroy();view=undefined;}
  function render(){
    if(disposed || !active || !config.showOverlay || !status.running){hide();return;}
    view??=createView();view.render(status,config);
  }
  async function refresh(){
    invalidate();
    if(disposed || !active || !config.showOverlay){hide();return;}
    const ticket=revision;
    try{
      const next=await rpc({type:'OVERLAY_STATUS'});
      if(ticket!==revision || disposed)return;
      status=next;
      config={...config,hotkey:next.hotkey??config.hotkey,language:next.language??config.language,providerName:next.providerName??config.providerName,showOverlay:next.showOverlay??config.showOverlay};
      render();
      if(view)timer=schedule(refresh,1500);
    }catch{
      if(ticket===revision){status={running:false};hide();}
    }
  }
  return {
    configure(next){invalidate();config={...config,...next};if(view)render();return refresh();},
    changed(running){invalidate();if(!running){status={running:false};hide();}else return refresh();},
    setActive(value){invalidate();active=value;if(active)return refresh();hide();},
    refresh,
    dispose(){disposed=true;invalidate();hide();},
  };
}

export function clampPosition(position,width,height,viewportWidth,viewportHeight){
  const edge=8;
  return {x:Math.max(edge,Math.min(position.x,Math.max(edge,viewportWidth-width-edge))),y:Math.max(edge,Math.min(position.y,Math.max(edge,viewportHeight-height-edge)))};
}

// Kept only for this page lifetime; restarting autopilot preserves placement.
let placement={x:16,y:84},collapsed=false;
export function createOverlayView(){
  const host=document.createElement('div');host.id='werhd-jev-overlay';
  host.style.cssText='all:initial!important;position:fixed!important;z-index:2147483646!important;display:block!important;';
  const root=host.attachShadow({mode:'closed'});
  root.innerHTML=`<style>
    :host{color-scheme:dark}*{box-sizing:border-box}
    section{width:min(282px,calc(100vw - 16px));border:1px solid #bba26366;border-radius:12px;background:rgba(11,22,29,.78);color:#eaf0f0;box-shadow:0 8px 26px #0005;backdrop-filter:blur(10px);font:12px/1.5 system-ui,-apple-system,sans-serif;overflow:hidden}
    section:hover,section:focus-within{background:rgba(11,22,29,.93)}
    header{display:flex;align-items:center;padding:10px 10px 8px;gap:8px}
    .drag{flex:1;min-width:0;cursor:grab;touch-action:none;user-select:none;border-radius:5px;outline-offset:3px}
    .drag:active{cursor:grabbing}.brand{color:#d9b76f;font-size:10px;letter-spacing:1px}
    .status{font-size:14px;font-weight:650;display:flex;align-items:center;gap:7px}.dot{width:6px;height:6px;border-radius:50%;background:#91cbb1;flex:none}
    button{border:1px solid #8b9c9f50;border-radius:6px;background:transparent;color:#eaf0f0;font:18px/1 system-ui;cursor:pointer;min-width:28px;height:28px}button:hover{background:#ffffff15}
    :focus-visible{outline:2px solid #d9b76f}
    .details{padding:0 12px 10px}.metrics{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;border-top:1px solid #84999b33;padding-top:9px}
    .metrics b{font-size:18px;line-height:1.3;font-variant-numeric:tabular-nums;font-weight:600;display:block;white-space:nowrap}.metrics span{color:#aab8ba;font-size:10px}
    .foot{display:flex;justify-content:space-between;gap:8px;margin-top:9px;font-size:10px;color:#aab8ba}.shortcut{color:#d9b76f}.warning{color:#edba81;margin:7px 0 0;font-size:11px}
    [hidden]{display:none!important}
  </style><section aria-label="Jev"><header><div class="drag" tabindex="0" role="group"><div class="brand"></div><div class="status"><i class="dot"></i><span class="status-text"></span></div></div><button type="button"></button></header><div class="details"><div class="metrics"><div><b id="decisions"></b><span id="decisions-label"></span></div><div><b id="credits"></b><span id="credits-label"></span></div><div><b id="latency"></b><span id="latency-label"></span></div></div><div class="foot"><span class="tick"></span><span class="shortcut"></span></div><p class="warning" hidden></p></div></section>`;
  const $=selector=>root.querySelector(selector),handle=$('.drag'),button=$('button');
  let config,lastStatus,drag;
  function layout(){
    const box=host.getBoundingClientRect();placement=clampPosition(placement,box.width,box.height,window.innerWidth,window.innerHeight);
    host.style.setProperty('left',`${placement.x}px`,'important');host.style.setProperty('top',`${placement.y}px`,'important');
  }
  function attach(){(document.fullscreenElement??document.documentElement).append(host);layout();}
  function render(status,next){
    config=next;lastStatus=status;const name=config.providerName||'Jev',tr=key=>t(config.language,key,{name});
    const format=n=>Number.isFinite(n)?Math.round(n).toLocaleString(config.language):'—';
    host.lang=config.language;$('section').setAttribute('aria-label',tr('title'));
    $('.brand').textContent=`${name.toUpperCase()} · ${tr('officialWebsite')}`;$('.status-text').textContent=tr('running');
    handle.title=tr('overlayDrag');handle.setAttribute('aria-label',`${tr('running')} · ${tr('overlayDrag')}`);
    button.textContent=collapsed?'+':'−';button.title=tr(collapsed?'overlayExpand':'overlayCollapse');button.setAttribute('aria-label',button.title);button.setAttribute('aria-expanded',String(!collapsed));
    $('.details').hidden=collapsed;
    for(const key of ['decisions','credits','latency'])$(`#${key}-label`).textContent=tr(key);
    $('#decisions').textContent=format(status.decisions??0);$('#credits').textContent=format(status.credits);$('#latency').textContent=Number.isFinite(status.latencyMs)?`${format(status.latencyMs)}ms`:'—';
    $('.tick').textContent=status.lastTick!=null?`TICK ${format(status.lastTick)}`:name.toUpperCase();
    $('.shortcut').textContent=`${config.hotkey} · ${tr('stop')}`;
    $('.warning').hidden=!status.failures;$('.warning').textContent=t(config.language,'failures',{n:status.failures});
    layout();
  }
  button.addEventListener('click',()=>{collapsed=!collapsed;render(lastStatus,config);});
  handle.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();drag={id:e.pointerId,startX:e.clientX,startY:e.clientY,...placement};handle.setPointerCapture(e.pointerId);});
  handle.addEventListener('pointermove',e=>{if(!drag || drag.id!==e.pointerId)return;placement={x:drag.x+(e.clientX-drag.startX),y:drag.y+(e.clientY-drag.startY)};layout();});
  const endDrag=()=>{drag=undefined;};handle.addEventListener('pointerup',endDrag);handle.addEventListener('lostpointercapture',endDrag);window.addEventListener('blur',endDrag);
  handle.addEventListener('keydown',e=>{const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];if(!delta)return;e.preventDefault();placement={x:placement.x+delta[0]*16,y:placement.y+delta[1]*16};layout();});
  // Panel interactions must not become game clicks, scrolls or movement keys.
  for(const type of ['pointerdown','pointerup','pointermove','mousedown','mouseup','click','dblclick','contextmenu','keydown','keyup','wheel'])host.addEventListener(type,e=>e.stopPropagation());
  window.addEventListener('resize',layout);document.addEventListener('fullscreenchange',attach);attach();
  return {render,destroy(){host.remove();window.removeEventListener('resize',layout);window.removeEventListener('blur',endDrag);document.removeEventListener('fullscreenchange',attach);}};
}
