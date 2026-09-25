// Compact, bounded telemetry derived only from the public player observation.
export const HISTORY_LIMIT = 300;
export const SAMPLE_MS = 2000;
const number = n => typeof n === 'number' && Number.isFinite(n) ? n : null;
const count = n => Math.max(0, number(n) ?? 0);
const short = s => typeof s === 'string' ? s.slice(0,80) : '';
const point = p => number(p?.x) !== null && number(p?.y) !== null ? {x:p.x,y:p.y} : null;
export function summarize(state = {}, at = Date.now()) {
  const strategy=state.strategy ?? {}, power=state.self?.power ?? {};
  return {
    at, tick:number(state.tick), gameSeconds:number(state.gameSeconds),
    credits:number(state.self?.credits), freeCredits:number(state.uncommittedCredits),
    committedCredits:number(state.committedCredits),
    army:count(state.ownArmyCount), harvesters:count(state.harvesters), antiAir:count(state.antiAirCount),
    health:state.ownArmyCount>0 ? number(state.averageArmyHealth) : null,
    visibleEnemies:count(state.visibleEnemyCount), nearbyEnemies:count(state.nearbyEnemyCount),
    power:{total:number(power.total),drain:number(power.drain)},
    threat:strategy.critical?'critical':strategy.suppressed?'suppressed':state.baseUnderAttack?'pressure':'clear',
    rangeThreats:(strategy.rangeThreats??[]).slice(0,12).map(t=>({name:short(t.name),range:number(t.range)})),
    enemyMix:{infantry:count(strategy.enemyMix?.infantry),vehicles:count(strategy.enemyMix?.vehicles),air:count(strategy.enemyMix?.air)},
    queues:(state.queues??[]).slice(0,8).map(q=>({type:short(String(q.type)),items:(q.items??[]).slice(0,6).map(i=>({name:short(i.name),quantity:count(i.quantity),progress:number(i.progress),status:short(i.status)}))})),
    inventory:Object.entries(state.inventory??{}).slice(0,48).map(([kind,u])=>({kind:short(kind),label:short(u.name),count:count(u.count)})),
    base:point(state.base),
    ledger:state.ledger?{ownUnits:count(state.ledger.ownUnits),ownBuildings:count(state.ledger.ownBuildings),enemyUnits:count(state.ledger.enemyUnits),enemyBuildings:count(state.ledger.enemyBuildings),ownBuilt:count(state.ledger.ownBuilt),ownUnitsLost:count(state.ledger.ownUnitsLost),ownBuildingsLost:count(state.ledger.ownBuildingsLost),enemyUnitsDestroyed:count(state.ledger.enemyUnitsDestroyed),enemyBuildingsDestroyed:count(state.ledger.enemyBuildingsDestroyed)}:null,
    // collectState already truncates these visible-only lists. They are a schematic, not a full map.
    ownPoints:(state.army??[]).slice(0,24).map(u=>point(u.tile)).filter(Boolean),
    enemyPoints:(state.visibleEnemies??[]).slice(0,24).map(u=>point(u.tile)).filter(Boolean),
  };
}
export function recordObservation(session, snapshot, at = Date.now()) {
  const observation={...snapshot,at};
  const last=session.history?.at(-1);
  const reset=last && observation.gameSeconds!==null && last.gameSeconds!==null && observation.gameSeconds<last.gameSeconds;
  let history=reset?[]:[...(session.history??[])],sampleMs=reset?SAMPLE_MS:(session.sampleMs??SAMPLE_MS);
  const l=observation.ledger??session.observation?.ledger??null;
  const sample={at,gameSeconds:observation.gameSeconds,credits:observation.credits,freeCredits:observation.freeCredits,decisions:session.decisions??0,...(l?{ownUnits:l.ownUnits,ownBuildings:l.ownBuildings,enemyUnits:l.enemyUnits,enemyBuildings:l.enemyBuildings,ownBuilt:l.ownBuilt,ownLost:l.ownUnitsLost+l.ownBuildingsLost,enemyDestroyed:l.enemyUnitsDestroyed+l.enemyBuildingsDestroyed}:{})};
  if(!last || reset || at-last.at>=sampleMs)history.push(sample);
  // Repeated popup polls and player events must not advance the sampling clock or erase the first point.
  // A long match keeps its whole shape: when the buffer is full, every other point is dropped and the
  // sampling interval doubles, so the curve always spans the match instead of only its last minutes.
  while(history.length>HISTORY_LIMIT){history=history.filter((_,i)=>i%2===0||i===history.length-1);sampleMs*=2;}
  return {...session,observation,history,sampleMs,lastTick:observation.tick,credits:observation.credits,army:observation.army};
}
