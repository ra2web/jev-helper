import {t} from './i18n.mjs';
const NS='http://www.w3.org/2000/svg';
function el(tag,attrs={},text){const n=document.createElementNS(NS,tag);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,v);if(text!==undefined)n.textContent=text;return n;}
const valid=n=>typeof n==='number'&&Number.isFinite(n);
export function chartGeometry(samples,keys){
 const data=samples.filter(p=>valid(p.at));
 const values=data.flatMap(p=>keys.map(k=>p[k]).filter(valid));
 const min=Math.min(0,...values),max=Math.max(1,...values),span=max-min;
 const from=data[0]?.at??0,to=Math.max(from+2000,data.at(-1)?.at??0);
 const gaps=data.slice(1).map((p,i)=>p.at-data[i].at).filter(g=>g>0).sort((a,b)=>a-b),median=gaps[Math.floor(gaps.length/2)]??0;
 // A break in the line means the data really stopped (a pause), not that the sampling interval grew.
 return {data,min,max,gapLimit:Math.max(10000,median*4),x:p=>38+(p.at-from)/(to-from)*290,y:v=>92-(v-min)/span*76};
}
const format=(n,lang)=>valid(n)?Math.round(n).toLocaleString(lang):'—';
const time=(n,lang)=>new Date(n).toLocaleTimeString(lang,{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
export function drawChart(root,samples,series,language,title){
 root.replaceChildren();const g=chartGeometry(samples,series.map(s=>s.key));
 const svg=el('svg',{viewBox:'0 0 340 118',role:'img','aria-label':title});
 for(const [v,label] of [[g.max,format(g.max,language)],[g.min,format(g.min,language)]]){
  svg.append(el('line',{x1:38,x2:328,y1:g.y(v),y2:g.y(v),class:'grid-line'}),el('text',{x:31,y:g.y(v)+3,'text-anchor':'end',class:'axis'},label));
 }
 if(!g.data.length){svg.append(el('text',{x:184,y:60,'text-anchor':'middle',class:'axis'},t(language,'chartEmpty')));root.append(svg);return;}
 for(const s of series){
  let d='',previous;
  for(const p of g.data){if(!valid(p[s.key])){previous=null;continue;}d+=`${previous&&p.at-previous.at<=g.gapLimit?'L':'M'}${g.x(p).toFixed(2)},${g.y(p[s.key]).toFixed(2)} `;previous=p;}
  svg.append(el('path',{d,stroke:s.color,'stroke-width':2,fill:'none','stroke-linejoin':'round'}));
  const last=g.data.findLast(p=>valid(p[s.key]));if(last)svg.append(el('circle',{cx:g.x(last),cy:g.y(last[s.key]),r:3,fill:s.color}));
 }
 const first=g.data[0],last=g.data.at(-1);
 svg.append(el('text',{x:38,y:111,class:'axis'},time(first.at,language)),el('text',{x:328,y:111,'text-anchor':'end',class:'axis'},time(last.at,language)));
 const cursor=el('line',{x1:38,x2:38,y1:12,y2:94,class:'chart-cursor',visibility:'hidden'});svg.append(cursor);
 const detail=document.createElement('div');detail.className='chart-detail';detail.setAttribute('aria-live','polite');
 let selected=g.data.length-1;
 const show=i=>{selected=Math.max(0,Math.min(g.data.length-1,i));const p=g.data[selected];cursor.setAttribute('x1',g.x(p));cursor.setAttribute('x2',g.x(p));cursor.setAttribute('visibility','visible');detail.textContent=`${time(p.at,language)} · `+series.map(s=>`${t(language,s.label)} ${format(p[s.key],language)}`).join(' / ');};
 svg.addEventListener('pointermove',e=>{const r=svg.getBoundingClientRect(),x=(e.clientX-r.left)/r.width*340;let i=0;g.data.forEach((p,j)=>{if(Math.abs(g.x(p)-x)<Math.abs(g.x(g.data[i])-x))i=j;});show(i);});
 root.tabIndex=0;root.setAttribute('aria-label',title);root.onkeydown=e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();show(selected+(e.key==='ArrowLeft'?-1:1));}};
 show(selected);root.append(svg,detail);
}
export function drawPositions(root,o,language){
 const svg=el('svg',{viewBox:'0 0 340 112',role:'img','aria-label':t(language,'tactical')});
 const points=[...(o.ownPoints??[]),...(o.enemyPoints??[]),...(o.base?[o.base]:[])];
 if(points.length){
  const xs=points.map(p=>p.x),ys=points.map(p=>p.y),minX=Math.min(...xs),minY=Math.min(...ys);
  const scale=Math.min(304/Math.max(12,Math.max(...xs)-minX),80/Math.max(12,Math.max(...ys)-minY));
  const x=p=>170+(p.x-(Math.min(...xs)+Math.max(...xs))/2)*scale,y=p=>56+(p.y-(Math.min(...ys)+Math.max(...ys))/2)*scale;
  for(let i=18;i<340;i+=38)svg.append(el('line',{x1:i,x2:i,y1:8,y2:104,class:'map-grid'}));
  for(let i=18;i<112;i+=24)svg.append(el('line',{x1:12,x2:328,y1:i,y2:i,class:'map-grid'}));
  for(const [list,color]of [[o.ownPoints??[],'#91cbb1'],[o.enemyPoints??[],'#ed9383']])for(const p of list)svg.append(el('circle',{cx:x(p),cy:y(p),r:3.3,fill:color}));
  if(o.base)svg.append(el('rect',{x:x(o.base)-4,y:y(o.base)-4,width:8,height:8,fill:'#d9b76f',transform:`rotate(45 ${x(o.base)} ${y(o.base)})`}));
 }
 root.replaceChildren(svg);
}
