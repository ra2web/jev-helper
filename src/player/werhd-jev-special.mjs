import { isAirSupport } from './werhd-jev-strategy.mjs';
import { isCapturable } from './werhd-jev-catalog.mjs';
export const ATTACK_STUCK_TICKS = 2700, CAPTURE_RESENDS = 3, SIEGE_RANGE = 8, BASE_GARRISON_SPARE = 8;
// Leaving a building once its job is done: no armed enemy within RELEASE_RADIUS for this long.
export const ENTRY_RESENDS = 3;
export const RELEASE_RADIUS = 10, RELEASE_TICKS = { siege: 150, forward: 900, base: 2700 }, REENTER_COOLDOWN = 1800;
// All tactical choices and spatial searches live in the ordinary player script.
const distance = (a, b) => Math.hypot(a.rx - b.rx, a.ry - b.ry);
// A unit still on a special task (an engineer trailing the column for a capture) is never idle.
const idle = (unit, memory, tick) => unit.isIdle && tick - (memory.specialOrders?.get(unit.id)?.tick ?? -10000) > 450 && !memory.specialTasks?.some((t) => t.action.ids?.includes(unit.id));
const friendlyOnBridge = (api, tile) => [...api.units('self'), ...api.units('allied')]
  .some(u => u.onBridge && distance(u.tile, { rx: tile.x, ry: tile.y }) < 7);

// Revealed bridges, shore near the base and sea frontiers, refreshed at most once per 120 simulation ticks.
export function refreshInfrastructure(api, memory, base) {
  const tick = api.tick();
  if (!memory.infrastructure || tick - memory.infrastructure.tick >= 120) {
    const bridges = new Map();
    const water = [], seaFrontiers = [];
    const { width, height } = api.map.size();
    for (let x = 0; x < width; x++) for (let y = 0; y < height; y++) {
      const tile = api.map.tile(x, y);
      if (tile?.bridge) bridges.set(tile.bridge.id, { ...tile.bridge, x, y });
      if (tile?.landType === (api.LandType?.Water ?? 7)) {
        if (base && distance(base.tile, tile) < 24) water.push({ x, y });
        if (x % 3 === 0 && y % 3 === 0 && [[5,0],[-5,0],[0,5],[0,-5]].some(([dx,dy]) =>
          x+dx >= 0 && y+dy >= 0 && x+dx < width && y+dy < height && !api.map.visible(x+dx,y+dy))) seaFrontiers.push({ x, y });
      }
    }
    memory.infrastructure = { tick, bridges: [...bridges.values()], water, seaFrontiers };
  }
  return memory.infrastructure;
}

export function specialGroups(api, catalog, snapshot, memory, groups) {
  const { units, enemies, buildings, base } = snapshot.raw;
  if (!api.order || !api.QueueType || !base) return;
  const tick = api.tick();
  memory.specialOrders ??= new Map();
  const hostile = api.units('hostile');
  const civilians = hostile.filter((u) => u.garrison || catalog[u.name]?.bridgeRepairHut);
  const own = new Map(units.map((u) => [u.id, u]));
  const available = api.production.available();
  const freeQueue = (type) => {
    const queue = api.production.queues().find((q) => q.type === type);
    return queue && !queue.size && (queue.maxSize ?? 1) > 0;
  };
  const afford = (r, reserve = 500) => r && snapshot.state.self.credits >= r.cost + reserve;
  const infantry = units.filter((u) => u.type === api.ObjectType.Infantry && !catalog[u.name]?.engineer);
  const group = (id, instructions) => {
    groups[id] ??= { instructions, criteria: { wait: 'Keep existing orders when no offered action has a clear tactical benefit.' }, actions: { wait: { type: 'wait' } } };
    return (key, text, action) => {
      groups[id].criteria[key] = text;
      groups[id].actions[key] = action;
    };
  };
  const addProduction = (add, item, purpose, placement, extra = {}) => {
    const r = catalog[item.name];
    add(`produce_${item.name}`, `${purpose}: ${r.label}, cost ${r.cost}.`, {
      type: 'produce', name: item.name, queue: item.queue, cost: r.cost, minCredits: r.cost,
      placement, ...extra,
    });
  };
  const { bridges, water } = refreshInfrastructure(api, memory, base);
  snapshot.state.infrastructure = {
    visibleGarrisons: civilians.filter((u) => u.garrison).slice(0, 8).map((u) => ({ id: u.id, tile: u.tile, ...u.garrison })),
    visibleBridgePieces: bridges.length, shoreNearBase: !!water.length,
    aircraft: units.filter((u) => catalog[u.name]?.aircraft).map((u) => ({ id: u.id, ammo: u.ammo, idle: u.isIdle })),
    transports: units.filter((u) => u.transport).map((u) => ({ id: u.id, ...u.transport })),
  };
  const posture = group('deployment', 'Choose a useful deployment posture. Static weapon forms may protect a threatened choke, but must unfold back into mobile units when the battle moves away.');
  for (const u of units.filter((u) => u.canDeploy && idle(u, memory, tick))) {
    const r = catalog[u.name];
    if (!r || r.yard) continue;
    const deployedRule = catalog[r.deploysInto];
    if (r.deploysInto && deployedRule && !deployedRule.yard && deployedRule.weapon?.damage > 0 && snapshot.state.baseUnderAttack && enemies.some(e => distance(e.tile,u.tile) < (deployedRule.weapon.range || 6)))
      posture(`morph_${u.id}`, `Deploy ${r.label} #${u.id} into ${deployedRule.label} to hold the threatened approach; it will lose mobility.`,
        { type: 'special', kind: 'deploy_morph', ids: [u.id], order: { type: api.OrderType.DeploySelected } });
    if (r.tickTank && r.undeploysInto && !enemies.some(e => distance(e.tile,u.tile) < (r.weapon?.range || 6)))
      posture(`mobilize_${u.id}`, `Pack up ${r.label} #${u.id} into ${r.undeploysInto} to join the mobile force; no visible enemy is in its firing range.`,
        { type: 'special', kind: 'undeploy_morph', ids: [u.id], order: { type: api.OrderType.DeploySelected } });
  }
  const garrison = group('garrison', 'Use empty civilian buildings as strongpoints. SIEGE options put infantry into a building within reach of an enemy defense (pillbox, tower) so it is destroyed from cover; clear each defense on its own side of the road instead of pushing past it. Base strongpoints only matter when the base is threatened. Occupants leave automatically once the job is done and no armed enemy is near, so entering does not lose them for the rest of the match. Preserve at least two mobile infantry. Evacuate a severely damaged occupied building before its occupants are lost. Do not repeatedly interrupt infantry already moving to enter.');
  const occupiers = infantry.filter((u) => catalog[u.name]?.occupier && idle(u, memory, tick) && u.id !== memory.scoutId);
  // Base strongpoints tie infantry down at home; offer them only under threat or with plenty to spare.
  // Only a real threat: with automatic training there are nearly always eight idle infantry, and a
  // spare-infantry rule kept a home house in an enter / leave loop (0.6.0 match: 65 orders, 497 retries).
  const baseGarrisonWanted = !!snapshot.state.baseUnderAttack;
  // Siege from cover: for each visible enemy defense, the empty civilian building closest to it that
  // is within reach. Every defense gets its own option, so both sides of a road can be taken.
  const assessment = snapshot.state.combatAssessment;
  // Also when the army has been unable to reach attack strength for a long time: taking a defense from
  // cover is then the only progress the infantry can make.
  const readiness = snapshot.state.forceReadiness;
  const deadlocked = !!readiness && !readiness.ready && (readiness.stalledTicks ?? 0) >= ATTACK_STUCK_TICKS;
  const attacksFailing = (assessment?.level ?? 0) >= 1 || !!assessment?.staleAttack || deadlocked;
  const recentlyLeft = (id) => tick - (memory.evacuatedAt?.get(id) ?? -Infinity) < REENTER_COOLDOWN;
  const houses = [...civilians, ...buildings].filter((u) => u.garrison?.canOccupy && !u.garrison.count && !own.has(u.id) && !recentlyLeft(u.id));
  const center = occupiers.length ? { rx: occupiers.reduce((n, u) => n + u.tile.rx, 0) / occupiers.length, ry: occupiers.reduce((n, u) => n + u.tile.ry, 0) / occupiers.length } : base.tile;
  // Only defenses that can hit ground troops: an anti-air site does not block the road.
  const groundWeapon = (r) => (r?.weapon?.damage ?? 0) > 0 && r.weapon.ag !== false;
  const enemyDefenses = enemies.filter((e) => e.type === api.ObjectType.Building && groundWeapon(catalog[e.name]))
    .sort((a, b) => distance(a.tile, center) - distance(b.tile, center)).slice(0, 4);
  const sieged = new Set();
  // A pillbox our infantry just had to back away from: take it from cover now.
  const wantedSiege = (id) => tick - (memory.siegeWanted?.get(id) ?? -Infinity) < 1800;
  for (const defense of [...enemyDefenses].sort((a, b) => Number(wantedSiege(b.id)) - Number(wantedSiege(a.id)))) {
    const range = catalog[defense.name]?.weapon?.range ?? 0;
    const house = houses.filter((h) => !sieged.has(h.id) && distance(h.tile, defense.tile) <= SIEGE_RANGE)
      .sort((a, b) => distance(a.tile, defense.tile) - distance(b.tile, defense.tile))[0];
    if (!house) continue;
    const crew = [...occupiers].sort((a, b) => distance(a.tile, house.tile) - distance(b.tile, house.tile))
      .slice(0, Math.min(house.garrison.capacity, 5, Math.max(0, infantry.length - 2)));
    if (crew.length < 2) continue;
    sieged.add(house.id);
    const label = catalog[defense.name]?.label ?? defense.name;
    const urgent = attacksFailing || wantedSiege(defense.id);
    garrison(`siege_${house.id}`, `${urgent ? 'PRIORITY ' : ''}SIEGE ${label} #${defense.id} at (${defense.tile.rx},${defense.tile.ry}): garrison ${crew.length} infantry into building #${house.id} at (${house.tile.rx},${house.tile.ry}), ${Math.round(distance(house.tile, defense.tile))} tiles from it (its weapon range ${range}). Garrisoned infantry fire from cover and outlast the defense${urgent ? `; ${wantedSiege(defense.id) ? 'it is outranging our infantry right now' : deadlocked ? 'the army has not been able to attack for a long time' : 'attacks in the open are failing'}` : ''}.`,
      { type: 'special', kind: 'garrison', ids: crew.map((u) => u.id), targetId: house.id,
        order: { type: api.OrderType.Occupy, target: { objectId: house.id } }, auto: urgent ? (wantedSiege(defense.id) ? 1 : 2) : undefined, purpose: 'siege', defenseId: defense.id });
  }
  for (const building of [...civilians, ...buildings].filter((u) => u.garrison).slice(0, 10)) {
    if (own.has(building.id)) {
      if (building.garrison.count && building.hitPoints / building.maxHitPoints < 0.45)
        garrison(`evacuate_${building.id}`, `Evacuate ${building.garrison.count} infantry from badly damaged building #${building.id}.`,
          { type: 'special', kind: 'evacuate_garrison', ids: [building.id], order: { type: api.OrderType.DeploySelected } });
    } else if (building.garrison.canOccupy && !building.garrison.count && !sieged.has(building.id) && !recentlyLeft(building.id) && ((baseGarrisonWanted && distance(base.tile, building.tile) < 28) || (memory.forwardPoint && distance(memory.forwardPoint, building.tile) <= 14 && distance(base.tile, building.tile) >= 28))) {
      const forward = !(distance(base.tile, building.tile) < 28);
      const candidates = infantry.filter((u) => catalog[u.name]?.occupier && idle(u, memory, tick) && u.id !== memory.scoutId)
        .sort((a, b) => distance(a.tile, building.tile) - distance(b.tile, building.tile))
        .slice(0, Math.min(3, building.garrison.capacity, Math.max(0, infantry.length - 2)));
      if (candidates.length)
        garrison(`occupy_${building.id}`, `Garrison ${candidates.length} infantry in civilian building #${building.id} at (${building.tile.rx},${building.tile.ry}); ${forward ? 'forward strongpoint next to the attack target: fire from cover instead of trading units in the open' : 'protect base approaches'}.`,
          { type: 'special', kind: 'garrison', ids: candidates.map((u) => u.id), targetId: building.id,
            order: { type: api.OrderType.Occupy, target: { objectId: building.id } }, purpose: forward ? 'forward' : 'base' });
    }
  }
  const transport = group('transport', 'Use spare infantry to crew empty transports or IFVs when it improves the current mission. Keep anti-air escorts free when enemy aircraft are present. Unload near combat on safe land; never unload infantry into water.');
  for (const vehicle of units.filter((u) => u.transport && idle(u, memory, tick))) {
    const r = catalog[vehicle.name];
    if (!r) continue;
    if (vehicle.transport.occupied < vehicle.transport.capacity && !(r?.gunner && snapshot.state.airThreatCount) && distance(vehicle.tile, base.tile) < 14) {
      const passenger = infantry.find((u) => idle(u, memory, tick) && u.id !== memory.scoutId && distance(u.tile, vehicle.tile) < 8
        && (catalog[u.name]?.size ?? 1) <= r.sizeLimit && (catalog[u.name]?.size ?? 1) <= vehicle.transport.capacity);
      if (passenger)
        transport(`load_${vehicle.id}`, `Load infantry #${passenger.id} into ${r.label} #${vehicle.id}${r.gunner ? ' to use its infantry weapon mode' : ' for protected transport'}.`,
          { type: 'special', kind: 'load', ids: [passenger.id], targetId: vehicle.id,
            order: { type: api.OrderType.EnterTransport, target: { objectId: vehicle.id } } });
    }
    if (vehicle.transport.occupied && (!r?.gunner || snapshot.state.airThreatCount > 0) && vehicle.zone !== (api.ZoneType?.Water ?? 2) && enemies.some((e) => distance(e.tile, vehicle.tile) < 14))
      transport(`unload_${vehicle.id}`, `Unload transport #${vehicle.id} on land near the battle.`,
        { type: 'special', kind: 'unload', ids: [vehicle.id], order: { type: api.OrderType.DeploySelected } });
  }
  for (const vehicle of units.filter(u => u.transport?.occupied && !catalog[u.name]?.gunner && idle(u, memory, tick))) {
    const destination = enemies.find(e => e.type === api.ObjectType.Building && distance(e.tile, vehicle.tile) >= 12)
      ?? [...(memory.enemyBuildings?.values() ?? [])].find(e => distance(e.tile ?? {rx:e.x,ry:e.y},vehicle.tile) >= 12);
    const tile = destination?.tile ?? (destination && { rx: destination.x, ry: destination.y });
    if (tile && api.map.tile(tile.rx, tile.ry))
      transport(`ferry_${vehicle.id}`, `Transport ${vehicle.transport.occupied} occupied slots toward the known enemy shore (${tile.rx},${tile.ry}); unload after reaching safe land.`,
        { type: 'special', kind: 'transport_move', ids: [vehicle.id], order: { type: api.OrderType.Move, target: { x: tile.rx, y: tile.ry } } });
  }
  if (water.length > 20 && infantry.length >= 4 && !units.some(u => u.transport?.capacity > 1) && snapshot.state.self.credits > 3000) {
    const carrier = available.find(item => catalog[item.name]?.passengers > 1 && !catalog[item.name]?.gunner && afford(catalog[item.name], 1500));
    if (carrier) {
      const queue = api.production.available(api.QueueType.Ships).some(item => item.name === carrier.name) ? api.QueueType.Ships : api.QueueType.Vehicles;
      if (freeQueue(queue)) addProduction(group(queue === api.QueueType.Ships ? 'navy' : 'vehicles', 'Choose a useful vehicle for combined arms.'), { ...carrier, queue }, 'Build one transport for a landing force');
    }
  }
  const engineering = group('engineering', `Engineer tasks. Capture neutral technology structures and undefended enemy structures: a captured building changes hands intact and is often a mission objective${memory.objective ? ` (mission objective: ${memory.objective})` : ''}. Repair a bridge to restore mobility. Demolish a bridge only to delay a visible enemy attack, with no friendly troops on it and a viable alternative position. Preserve engineers after unsuccessful orders.`);
  // Repair huts near the base or near any of our units: a broken bridge on the advance route matters too.
  const huts = civilians.filter((u) => catalog[u.name]?.bridgeRepairHut && (distance(base.tile, u.tile) < 40 || units.some((o) => distance(o.tile, u.tile) < 25)));
  const engineers = units.filter((u) => catalog[u.name]?.engineer);
  // Is the army stuck? The same attack target re-ordered for a long time without being destroyed is
  // the usual sign of a land route cut by a destroyed bridge. Re-issuing the order keeps the clock.
  const mission = memory.mission;
  memory.attackSince ??= new Map();
  if (mission?.mode === 'attack' && mission.targetId !== undefined && !memory.attackSince.has(mission.targetId)) memory.attackSince.set(mission.targetId, tick);
  const stuckFor = mission?.mode === 'attack' && mission.targetId !== undefined ? tick - (memory.attackSince.get(mission.targetId) ?? tick) : 0;
  const stuckName = enemies.find((e) => e.id === mission?.targetId)?.name ?? memory.enemyBuildings?.get(mission?.targetId)?.name;
  const stuckTarget = stuckFor > ATTACK_STUCK_TICKS || snapshot.state.combatAssessment?.staleAttack ? `${catalog[stuckName]?.label ?? stuckName ?? 'the target'} #${mission?.targetId}` : '';
  const damagedBridges = bridges.filter((b) => Number.isFinite(b.hitPoints) && b.maxHitPoints > 0 && b.hitPoints < b.maxHitPoints).length;
  const bridgeUrgent = !!stuckTarget || damagedBridges > 0;
  const bridgeWhy = [stuckTarget && `our attack on ${stuckTarget} has made no progress for ${Math.max(stuckFor, ATTACK_STUCK_TICKS)} ticks, most likely because a destroyed bridge cuts the land route`, damagedBridges && `${damagedBridges} damaged bridge piece${damagedBridges > 1 ? 's are' : ' is'} visible`].filter(Boolean).join('; ');
  // Bridge repair comes first: it reopens the route the whole army needs. It is offered only with a
  // reason (a stuck attack or visible damage): "no known damage yet" sent engineers on empty trips.
  for (const hut of bridgeUrgent ? huts.slice(0, 3) : []) {
    const engineer = engineers.filter((u) => idle(u, memory, tick)).sort((a, b) => distance(a.tile, hut.tile) - distance(b.tile, hut.tile))[0];
    if (engineer && tick - (memory.specialTargets?.get(`repair_${hut.id}`) ?? -10000) > 1200)
      engineering(`repair_${hut.id}`, `PRIORITY BRIDGE REPAIR (${bridgeWhy}): send engineer #${engineer.id} into bridge repair hut #${hut.id} at (${hut.tile.rx},${hut.tile.ry}), ${Math.round(distance(engineer.tile, hut.tile))} tiles away. A repaired bridge reopens the land route; if the bridge is intact the order is simply rejected and nothing is lost.`,
        { type: 'special', kind: 'repair_bridge', ids: [engineer.id], targetId: hut.id,
          order: { type: api.OrderType.Repair, target: { objectId: hut.id } }, auto: 2 });
  }
  // Capture targets: neutral structures first (technology buildings, outposts), then enemy economic or
  // production buildings with no armed enemy within nine tiles. Walls, defenses, huts and garrisonable
  // civilian houses are never capture targets.
  const enemyIds = new Set(enemies.map((u) => u.id));
  const armedNear = (tile) => enemies.some((e) => (e.primaryWeapon || catalog[e.name]?.weapon?.damage > 0) && distance(e.tile, tile) <= 9);
  const captureTargets = hostile
    .filter((u) => u.type === api.ObjectType.Building && !own.has(u.id) && !u.garrison && !catalog[u.name]?.wall && !catalog[u.name]?.isBaseDefense && !catalog[u.name]?.bridgeRepairHut && !(catalog[u.name]?.weapon?.damage > 0) && !memory.uncapturable?.has(u.id))
    .map((u) => ({ unit: u, neutral: !enemyIds.has(u.id), defended: armedNear(u.tile), dist: Math.min(...[base, ...engineers].map((o) => distance(o.tile, u.tile))) }))
    // Neutral targets must be real technology buildings; lamp posts and pipes owned by a civilian
    // house cannot be captured and only trap the engineer in a retry loop.
    .filter((c) => c.neutral ? isCapturable(catalog[c.unit.name], c.unit.name) : (!c.defended && (catalog[c.unit.name]?.refinery || catalog[c.unit.name]?.factory || catalog[c.unit.name]?.yard || catalog[c.unit.name]?.power > 0 || (catalog[c.unit.name]?.techLevel ?? 0) >= 2)))
    .sort((a, b) => Number(b.neutral) - Number(a.neutral) || Number(a.defended) - Number(b.defended) || a.dist - b.dist)
    .slice(0, 4);
  // The player's capture objective ("使用工程师占领盟军战略实验室") comes first even when defended:
  // the mission needs it, and waiting does not make it safer.
  const wanted = memory.objectiveTarget?.mode === 'capture' && !memory.objectiveTarget.done ? hostile.find((u) => u.id === memory.objectiveTarget.id) : undefined;
  if (wanted) {
    const at = captureTargets.findIndex((c) => c.unit.id === wanted.id);
    if (at >= 0) captureTargets.splice(at, 1);
    captureTargets.unshift({ unit: wanted, neutral: !enemyIds.has(wanted.id), defended: armedNear(wanted.tile), objective: true, dist: Math.min(...[base, ...engineers].map((o) => distance(o.tile, wanted.tile))) });
    captureTargets.length = Math.min(captureTargets.length, 4);
  }
  memory.captureTargets = captureTargets.map((c) => c.unit.id);
  for (const c of captureTargets) {
    const engineer = engineers.filter((u) => idle(u, memory, tick)).sort((a, b) => distance(a.tile, c.unit.tile) - distance(b.tile, c.unit.tile))[0];
    if (!engineer || tick - (memory.specialTargets?.get(`repair_${c.unit.id}`) ?? -10000) <= 600) continue;
    engineering(`capture_${c.unit.id}`, `${c.objective ? 'MISSION OBJECTIVE CAPTURE' : c.neutral ? 'CAPTURE (neutral)' : 'CAPTURE (enemy, undefended)'}: ${c.objective && c.defended ? `engineer #${engineer.id} follows behind our attacking column and enters when the column reaches` : `send engineer #${engineer.id} into`} ${catalog[c.unit.name]?.label ?? c.unit.name} #${c.unit.id} at (${c.unit.tile.rx},${c.unit.tile.ry}), ${Math.round(distance(engineer.tile, c.unit.tile))} tiles away${c.defended ? '; armed enemies nearby, risky' : ''}. The engineer is consumed; the building becomes ours.`,
      { type: 'special', kind: 'capture', ids: [engineer.id], targetId: c.unit.id, order: { type: api.OrderType.Capture, target: { objectId: c.unit.id } },
        // A defended objective: the engineer follows the army instead of walking in alone (0.7.3 sent
        // about fifteen engineers 117 tiles through the defenses one by one; none arrived).
        ...(c.objective && c.defended ? { escort: true } : {}), auto: c.objective ? 1 : c.neutral && !c.defended ? 2 : c.defended ? undefined : 3 });
  }
  // A defended capture objective can cost an engineer on the way in: keep two ready for it.
  const engineersWanted = Math.min(2, captureTargets.length) + (wanted && armedNear(wanted.tile) ? 1 : 0) + (huts.length && bridgeUrgent ? 1 : 0);
  const objectiveEngineer = wanted && engineers.length < engineersWanted;
  if (engineersWanted > engineers.length && freeQueue(api.QueueType.Infantry) && (snapshot.state.self.credits > 1800 || objectiveEngineer)) {
    const engineer = available.find((u) => catalog[u.name]?.engineer && afford(catalog[u.name], objectiveEngineer ? 0 : 1200));
    const first = captureTargets[0];
    if (engineer) addProduction(group('infantry', ''), { ...engineer, queue: api.QueueType.Infantry },
      huts.length && bridgeUrgent ? `PRIORITY: train an engineer to repair the bridge (${bridgeWhy})` : objectiveEngineer ? `MISSION OBJECTIVE: train an engineer to capture ${catalog[wanted.name]?.label ?? wanted.name} #${wanted.id}` : first ? `OBJECTIVE: train an engineer to capture ${catalog[first.unit.name]?.label ?? first.unit.name} #${first.unit.id}${captureTargets.length > 1 ? ` and ${captureTargets.length - 1} more capturable structure${captureTargets.length > 2 ? 's' : ''}` : ''}` : 'Train one engineer for visible bridge repair',
      undefined, { auto: objectiveEngineer ? 1 : (first || bridgeUrgent) && snapshot.state.self.credits >= catalog[engineer.name].cost + 1500 ? 3 : bridgeUrgent ? 3 : undefined });
  }
  for (const bridge of bridges.slice(0, 12)) {
    const tile = { rx: bridge.x, ry: bridge.y };
    if (friendlyOnBridge(api, bridge) || memory.specialTasks?.some(t => t.bridge?.id === bridge.id)) continue;
    if (!enemies.some((e) => e.onBridge && distance(e.tile, tile) < 4 && distance(e.tile, base.tile) < 22)) continue;
    const weapons = snapshot.raw.army.filter((u) => !u.onBridge && !u.isDeployed && distance(u.tile, tile) < 9
      && tick >= (memory.bridgeRetryAfter?.get(`${bridge.id}:${u.name}`) ?? 0)
      && tick - (memory.specialOrders?.get(u.id)?.tick ?? -10000) > 450).slice(0, 3);
    if (weapons.length)
      engineering(`demolish_${bridge.id}`, `Destroy bridge piece (${bridge.x},${bridge.y}) beneath visible attackers approaching our base; no friendly units are on the nearby bridge. Consider whether the loss of this route would trap our army.`,
        { type: 'special', kind: 'demolish_bridge', ids: weapons.map((u) => u.id),
          order: { type: api.OrderType.ForceAttack, target: { x: bridge.x, y: bridge.y, onBridge: true } } });
  }
  const sell = group('salvage', 'Sell a doomed building to recover resources before it is destroyed. Protect essential power, the only refinery, and the only construction yard. Waiting is correct when selling would harm survival.');
  for (const b of buildings) {
    const r = catalog[b.name];
    if (!r || r.unsellable || r.yard || r.refinery || r.power > 0 || b.garrison?.count) continue;
    if (b.hitPoints / b.maxHitPoints < 0.18 && enemies.some((e) => distance(e.tile, b.tile) < 8))
      sell(`sell_${b.id}`, `Salvage critically damaged ${r.label} #${b.id} under immediate enemy pressure.`, { type: 'sell', objectId: b.id });
  }
  const defenses = group('defenses', 'Build limited base defenses at threatened approaches after the economy is running. Walls block movement but must leave exits open. Use anti-air defenses against visible aircraft. Preserve funds for tanks.');
  if (snapshot.state.harvesters >= 2 && freeQueue(api.QueueType.Armory)) {
    const existing = buildings.filter((u) => catalog[u.name]?.isBaseDefense || catalog[u.name]?.wall);
    for (const item of api.production.available(api.QueueType.Armory)) {
      const r = catalog[item.name];
      if (!r || !afford(r, 1000) || existing.filter((u) => u.name === item.name).length >= (r.wall ? 4 : 2)) continue;
      if (r.isBaseDefense || r.wall)
        addProduction(defenses, { ...item, queue: api.QueueType.Armory }, r.wall ? 'Build a wall segment to screen a vulnerable approach, leaving a passage' : 'Build a defensive strongpoint');
    }
  }
  // Technology is proposed in the existing construction category, keeping one queue owner.
  if (snapshot.state.economy?.factories && snapshot.state.harvesters >= 3 && freeQueue(api.QueueType.Structures)) {
    for (const item of api.production.available(api.QueueType.Structures)) {
      const r = catalog[item.name];
      if (!r || !afford(r, 1500) || buildings.some((u) => u.name === item.name)) continue;
      if (isAirSupport(r))
        addProduction(group('construction', ''), { ...item, queue: api.QueueType.Structures }, 'Build aircraft support to enable air strikes');
      if (r.naval && r.factory === 'NavalUnitType' && water.length) {
        const placement = water.find((p) => api.canPlace(item.name, p.x, p.y));
        if (placement) addProduction(group('construction', ''), { ...item, queue: api.QueueType.Structures }, 'Build a naval yard on the revealed shore', placement);
      }
    }
  }
  for (const [name, queue, select] of [
    ['aircraft', api.QueueType.Aircrafts, (r) => r.aircraft],
    ['navy', api.QueueType.Ships, (r) => r.naval],
  ]) {
    const add = group(name, name === 'aircraft' ? 'Build and use an air wing to strike visible vulnerable targets. Consider ammunition and anti-air threats; do not send empty aircraft into combat.' : 'Build a naval force when the coast is accessible. Attack visible enemy ships or reachable shore targets; explore water to find naval threats.');
    const force = units.filter((u) => select(catalog[u.name] ?? {}) && u.type !== api.ObjectType.Building);
    if (force.length < 4 && freeQueue(queue)) for (const item of api.production.available(queue)) {
      const r = catalog[item.name];
      if (r && r.weapon?.damage > 0 && afford(r, 800)) addProduction(add, { ...item, queue }, `Expand ${name}`);
    }
    const ready = force.filter((u) => idle(u, memory, tick) && (u.ammo === undefined || u.ammo !== 0));
    if (name === 'aircraft' && ready.length && !enemies.length && !memory.enemyBuildings?.size) {
      const p=memory.points?.[0];
      if (p && api.map.tile(p.x,p.y)) add('air_scout',`Scout the revealed frontier (${p.x},${p.y}) with one ready aircraft to locate the enemy base; ground scouts have not found it.`,
        {type:'special',kind:'air_scout',ids:[ready[0].id],order:{type:api.OrderType.Move,target:{x:p.x,y:p.y}}});
    }
    if (name === 'navy' && ready.length && !enemies.some((u) => u.zone === (api.ZoneType?.Water ?? 2))) {
      const points = memory.infrastructure.seaFrontiers ?? [];
      const p = [...points].sort((a, b) => distance(base.tile, {rx:b.x,ry:b.y}) - distance(base.tile, {rx:a.x,ry:a.y}))[0];
      if (p) add('sea_scout', `Explore revealed water frontier (${p.x},${p.y}) with ${ready.length} ships.`,
        { type: 'special', kind: 'naval_scout', ids: ready.map((u) => u.id), order: { type: api.OrderType.Move, target: p } });
    }
    for (const target of enemies.slice(0, 8)) {
      const ids = ready.filter((u) => api.weaponVs ? !!api.weaponVs(u.id, target.id, 'current') : target.zone === 1 ? catalog[u.name]?.weapon?.aa : catalog[u.name]?.weapon?.ag !== false).map((u) => u.id);
      if (ids.length) add(`strike_${target.id}`, `Attack visible ${target.name} #${target.id} using ${ids.length} ${name} units. Target HP ${target.hitPoints}/${target.maxHitPoints}.`,
        { type: 'special', kind: name === 'aircraft' ? 'air_strike' : 'naval_attack', ids, targetId: target.id,
          order: { type: api.OrderType.Attack, target: { objectId: target.id } } });
    }
  }
}

export function executeSpecial(api, action) {
  if (action.type === 'sell') {
    const building = api.units('self').find((u) => u.id === action.objectId);
    if (!building || building.type !== api.ObjectType.Building) return { accepted: false, reason: 'building_gone' };
    api.sell(action.objectId);
    return { accepted: true };
  }
  if (action.type !== 'special') return undefined;
  if (action.kind === 'demolish_bridge') {
    const tile = action.order.target;
    const bridge = api.map.tile(tile.x, tile.y)?.bridge;
    if (!bridge || !Number.isFinite(bridge.hitPoints)) return { accepted: false, reason: 'bridge_not_observable' };
    if (friendlyOnBridge(api, tile)) return { accepted: false, reason: 'friendly_on_bridge' };
    return { accepted: api.order(action.ids, action.order), ids: action.ids,
      bridge: { ...bridge, x: tile.x, y: tile.y },
      attackerNames: api.units('self').filter(u => action.ids.includes(u.id)).map(u => u.name) };
  }
  if (action.targetId !== undefined && !api.unit(action.targetId)) return { accepted: false, reason: 'target_no_longer_visible' };
  if (action.kind === 'capture' && api.units('self').some((u) => u.id === action.targetId)) return { accepted: false, reason: 'already_owned' };
  // Escorted capture: nothing is sent yet; maintenance walks the engineer behind the column.
  if (action.kind === 'capture' && action.escort) return { accepted: true, ids: action.ids, escort: true };
  if (action.kind === 'garrison') {
    const target = api.unit(action.targetId);
    if (!target?.garrison?.canOccupy || target.garrison.count >= target.garrison.capacity)
      return { accepted: false, reason: 'garrison_changed' };
  }
  if (action.kind === 'load') {
    const target = api.unit(action.targetId);
    if (!api.units('self').some(u => u.id === action.targetId) || !target?.transport || target.transport.occupied >= target.transport.capacity)
      return { accepted: false, reason: 'transport_changed' };
    // Entry needs both participants: a previous squad order may already be moving the carrier.
    if (!api.order([action.targetId], { type: api.OrderType.Stop }))
      return { accepted: false, reason: 'transport_stop_rejected' };
  }
  if (['garrison', 'load', 'repair_bridge', 'capture'].includes(action.kind)) {
    const deployed = api.units('self').filter((u) => action.ids.includes(u.id) && u.isDeployed).map((u) => u.id);
    if (deployed.length) return { accepted: api.deploy(deployed), ids: action.ids, phase: 'preparing' };
  }
  return { accepted: api.order(action.ids, action.order), ids: action.ids };
}

export function rememberSpecial(memory, action, execution, tick) {
  memory.specialTasks ??= [];
  memory.specialOrders ??= new Map();
  if (action.kind === 'demolish_bridge' && execution.accepted && execution.bridge) {
    memory.specialTasks.push({ action, bridge: execution.bridge, attackerNames: execution.attackerNames,
      started: tick, lastProgress: tick, hitPoints: execution.bridge.hitPoints });
    for (const id of action.ids) memory.specialOrders.set(id, { tick, kind: action.kind });
  }
  if (action.ids?.length && action.kind === 'capture' && execution.accepted) {
    memory.specialTasks.push({ action, started: tick, submitted: tick, ...(action.escort ? { escort: true, moved: -10000 } : {}) });
    for (const id of action.ids) memory.specialOrders.set(id, { tick, kind: action.kind });
  }
  if (action.kind === 'garrison' && execution.accepted) {
    memory.garrisons ??= new Map();
    memory.garrisons.set(action.targetId, { purpose: action.purpose ?? 'base', defenseId: action.defenseId, since: tick });
  }
  if (action.ids?.length && ['garrison', 'load'].includes(action.kind)) {
    memory.specialTasks.push({ action, phase: execution.phase ?? 'entering', started: tick, submitted: tick });
    for (const id of [...action.ids, ...(action.kind === 'load' ? [action.targetId] : [])])
      memory.specialOrders.set(id, { tick, kind: action.kind });
  }
}

// A multi-step player task; the engine still receives only ordinary independent commands.
// Escorted capture: the engineer trails the column by this many tiles and goes in when the column's
// centre is this close to the target, or when no armed enemy is left this close to it.
export const ESCORT_TRAIL_TILES = 4, ESCORT_ARRIVE_TILES = 8, ESCORT_MOVE_TICKS = 60;
function maintainEscort(api, memory, task, own, tick, emit, catalog, done) {
  const { action } = task, engineer = own.get(action.ids[0]), target = api.unit(action.targetId);
  if (own.has(action.targetId)) return done('completed');
  if (!engineer) return done('engineer_lost');
  if (!target) return done('target_lost');
  memory.specialOrders.set(engineer.id, { tick, kind: 'capture' });
  const armed = (api.units('enemy') ?? []).some((e) => e.id !== target.id && (e.primaryWeapon || catalog?.[e.name]?.weapon?.damage > 0) && distance(e.tile, target.tile) <= ESCORT_ARRIVE_TILES);
  const column = (memory.mission?.ids ?? []).map((id) => own.get(id)).filter(Boolean);
  const center = column.length ? { rx: column.reduce((n, u) => n + u.tile.rx, 0) / column.length, ry: column.reduce((n, u) => n + u.tile.ry, 0) / column.length } : undefined;
  if (!armed || center && distance(center, target.tile) <= ESCORT_ARRIVE_TILES) {
    const execution = executeSpecial(api, { ...action, escort: false });
    if (!execution.accepted) return done('rejected');
    Object.assign(task, { escort: false, started: tick, submitted: tick });
    emit({ kind: 'micro', tick, description: `capture: ${armed ? '部队已到目标旁' : '目标附近已无守军'}，工程师 #${engineer.id} 进入 #${action.targetId}`, targetId: action.targetId, ids: [engineer.id] });
    return true;
  }
  // Behind the column, on the side facing the engineer; without a column the engineer stays put.
  if (center && tick - task.moved >= ESCORT_MOVE_TICKS) {
    const d = distance(engineer.tile, center) || 1;
    if (d > ESCORT_TRAIL_TILES + 2) {
      const x = Math.round(center.rx + (engineer.tile.rx - center.rx) / d * ESCORT_TRAIL_TILES), y = Math.round(center.ry + (engineer.tile.ry - center.ry) / d * ESCORT_TRAIL_TILES);
      api.move([engineer.id], x, y);
    }
    task.moved = tick;
  }
  return true;
}

export function maintainSpecial(api, memory, emit, catalog) {
  releaseGarrisons(api, memory, emit);
  if (!memory.specialTasks?.length) return;
  const own = new Map(api.units('self').map((u) => [u.id, u]));
  const tick = api.tick();
  memory.specialTasks = memory.specialTasks.filter((task) => {
    const { action } = task;
    if (action.kind === 'demolish_bridge') return maintainDemolition(api, memory, task, own, tick, emit);
    if (action.kind === 'capture') {
      const engineer = own.get(action.ids[0]), target = api.unit(action.targetId);
      const done = (result) => { for (const id of action.ids) memory.specialOrders.delete(id); emit({ kind: result === 'completed' ? 'observed' : 'task', tick, task: 'capture', description: `capture ${result}: #${action.targetId}`, result, targetId: action.targetId }); return false; };
      if (task.escort) return maintainEscort(api, memory, task, own, tick, emit, catalog, done);
      if (own.has(action.targetId)) return done('completed');
      if (!engineer) return target ? done('engineer_lost') : done('incomplete');
      if (!target && tick - task.started > 600) return done('target_lost');
      // An engineer that goes idle next to its target again and again is being refused: stop and never offer it again.
      const giveUp = (result) => { (memory.uncapturable ??= new Set()).add(action.targetId); return done(result); };
      if (tick - task.started > 2400) return giveUp('timeout');
      if (target && engineer.isIdle && tick - task.submitted >= 150 && (task.resends ?? 0) >= CAPTURE_RESENDS) return giveUp('uncapturable');
      memory.specialOrders.set(engineer.id, { tick, kind: 'capture' });
      if (target && engineer.isIdle && tick - task.submitted >= 150) {
        const execution = executeSpecial(api, action);
        if (!execution.accepted) return done('rejected');
        task.submitted = tick; task.resends = (task.resends ?? 0) + 1;
        emit({ kind: 'micro', tick, description: `capture: 工程师 #${engineer.id} 重新前往 #${action.targetId}`, targetId: action.targetId, ids: [engineer.id] });
      }
      return true;
    }
    const target = api.unit(action.targetId);
    const contained = action.kind === 'garrison' ? target?.garrison?.unitIds : target?.transport?.unitIds;
    const entered = action.ids.filter((id) => contained?.includes(id));
    const remaining = action.ids.filter((id) => !entered.includes(id) && own.has(id));
    const finish = (result) => {
      for (const id of [...action.ids, ...(action.kind === 'load' ? [action.targetId] : [])]) memory.specialOrders.delete(id);
      emit({ kind: result === 'completed' ? 'observed' : 'task', tick, task: action.kind,
        description: `${action.kind} ${result}: ${entered.length}/${action.ids.length}`,
        result, targetId: action.targetId, enteredIds: entered });
      return false;
    };
    if (entered.length === action.ids.length) return finish('completed');
    if (!target || !remaining.length || tick - task.started > 1200) return finish('incomplete');
    for (const id of remaining) memory.specialOrders.set(id, { tick, kind: action.kind });
    if (action.kind === 'load') {
      if (!own.has(target.id) || !target.transport || target.transport.occupied >= target.transport.capacity)
        return finish('incomplete');
      // Release a carrier taking damage so ordinary defense can react immediately.
      if (task.carrierHealth !== undefined && target.hitPoints < task.carrierHealth) return finish('interrupted');
      task.carrierHealth = target.hitPoints;
      memory.specialOrders.set(target.id, { tick, kind: action.kind });
    }
    if (task.phase === 'preparing') {
      if (remaining.some((id) => own.get(id).isDeployed) || tick - task.submitted < 20) return true;
      const execution = executeSpecial(api, { ...action, ids: remaining });
      if (!execution.accepted) return finish('rejected');
      task.phase = 'entering'; task.submitted = tick;
      emit({ kind: 'micro', tick, description: `${action.kind}: 姿态确认后进入目标`, targetId: action.targetId, ids: remaining });
    } else if (tick - task.submitted >= 120 && remaining.some(id => own.get(id).isIdle)) {
      // Crew that keeps standing outside after three re-sends cannot get in: stop trying.
      if ((task.resends ?? 0) >= ENTRY_RESENDS) return finish('refused');
      task.resends = (task.resends ?? 0) + 1;
      const idleIds = remaining.filter(id => own.get(id).isIdle);
      const execution = executeSpecial(api, { ...action, ids: idleIds });
      if (!execution.accepted) return finish('rejected');
      task.phase = execution.phase ?? 'entering'; task.submitted = tick;
      emit({ kind: 'micro', tick, description: `${action.kind}: 空闲乘员重新进入目标`, targetId: action.targetId, ids: idleIds });
    }
    return true;
  });
}

function maintainDemolition(api, memory, task, own, tick, emit) {
  const { action, bridge } = task;
  const ids = action.ids.filter(id => own.has(id));
  const tile = api.map.tile(bridge.x, bridge.y);
  const current = tile?.bridge;
  const finish = result => {
    if (ids.length) api.order(ids, { type: api.OrderType.Stop });
    for (const id of action.ids) memory.specialOrders.delete(id);
    if (result === 'no_damage_progress') {
      memory.bridgeRetryAfter ??= new Map();
      for (const name of task.attackerNames) memory.bridgeRetryAfter.set(`${bridge.id}:${name}`, tick + 900);
    }
    emit({ kind: result === 'completed' ? 'observed' : 'task', tick, task: action.kind,
      description: `demolish_bridge ${result}`, result, bridgeId: bridge.id, x: bridge.x, y: bridge.y,
      initialHitPoints: bridge.hitPoints, lastHitPoints: current?.hitPoints ?? task.hitPoints });
    return false;
  };
  if (!tile) return finish('lost_visibility');
  if (!current) return finish('completed');
  if (current.id !== bridge.id) return finish('bridge_changed');
  if (!ids.length) return finish('units_lost');
  if (friendlyOnBridge(api, bridge)) return finish('friendly_on_bridge');
  if (current.hitPoints < task.hitPoints) {
    task.hitPoints = current.hitPoints;
    task.lastProgress = tick;
  }
  // AG/armor damage alone does not prove bridge damage (e.g. a non-wall-damaging warhead).
  // Observe the public health result and release the force if this attempt makes no progress.
  if (tick - task.lastProgress >= 300) return finish('no_damage_progress');
  if (tick - task.started >= 1800) return finish('time_limit');
  for (const id of ids) memory.specialOrders.set(id, { tick, kind: action.kind });
  return true;
}

// Infantry sent into a building comes back out once the job is done, so it rejoins the army instead
// of sitting there for the rest of the match. Never while an armed enemy is close: stepping out
// under fire is how units get wasted. A building that was just left is not offered again for a while.
export function releaseGarrisons(api, memory, emit) {
  if (!memory.garrisons?.size) return;
  const tick = api.tick();
  const own = new Map(api.units('self').map((u) => [u.id, u]));
  const armed = api.units('enemy').filter((e) => e.primaryWeapon || e.secondaryWeapon);
  for (const [id, g] of memory.garrisons) {
    const building = own.get(id);
    if (!building?.garrison?.count) { memory.garrisons.delete(id); continue; }
    const threatened = armed.some((e) => distance(e.tile, building.tile) <= RELEASE_RADIUS);
    const targetAlive = g.purpose === 'siege' && g.defenseId !== undefined && api.unit(g.defenseId) && !own.has(g.defenseId);
    if (threatened || targetAlive) { g.clearSince = undefined; continue; }
    g.clearSince ??= tick;
    if (tick - g.clearSince < (RELEASE_TICKS[g.purpose] ?? RELEASE_TICKS.base)) continue;
    const execution = executeSpecial(api, { type: 'special', kind: 'evacuate_garrison', ids: [id], order: { type: api.OrderType.DeploySelected } });
    if (!execution?.accepted) continue;
    memory.garrisons.delete(id);
    (memory.evacuatedAt ??= new Map()).set(id, tick);
    emit({ kind: 'micro', tick, description: `撤出建筑 #${id}（${g.purpose === 'siege' ? '目标已清除' : '附近已无敌人'}），${building.garrison.count} 名步兵归队`, targetId: id, reason: `release_${g.purpose}` });
  }
}
