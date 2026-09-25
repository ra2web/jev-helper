import { specialGroups, executeSpecial, rememberSpecial, maintainSpecial, refreshInfrastructure, SIEGE_RANGE } from "./werhd-jev-special.mjs";
import { buildBrief, formSquads, squadUnits, sameIntent } from "./werhd-jev-commander.mjs";
import { assessStrategy, investmentGroups, chooseBuildingSite, chooseRallySite, weaponEffectiveness, effectiveness, infantryProfile, scoutScore, currentWeapon as combatWeapon, activeWeapons, canFireAt, baseThreats, ATTACK_FORCE_SIZE, ATTACK_AA_ESCORTS, vehicleOptions } from "./werhd-jev-strategy.mjs";
import { updateCamera } from "./werhd-jev-camera.mjs";
import { refreshCatalog, isDecoration } from "./werhd-jev-catalog.mjs";
import { trackObjective, isGuardedByObjective } from "./werhd-jev-objective.mjs";
// Ordinary page-side player: every observation and command uses window.werhd.
// Bundled into the browser extension; transport and credentials live outside the game page.

const distance = (a, b) => Math.hypot(a.rx - b.rx, a.ry - b.ry);
const round = (value) => Math.round(value * 100) / 100;

// Score the weapon actually active in this posture, not a generic target-type bonus.
// Mission preference is deliberately small so it cannot erase armor/air matchups.
export function combatTargetScore(api, catalog, unit, target, missionTargetId) {
  const power = Math.max(0, ...activeWeapons(unit, catalog)
    .map(w => weaponEffectiveness(w, [target], catalog, api)));
  if (!power) return 0;
  const armed = activeWeapons(target, catalog).some(w => w.damage > 0);
  const air = target.zone === (api.ZoneType?.Air ?? 1);
  return power / Math.sqrt(Math.max(1, target.hitPoints ?? 100)) *
    (armed ? 1.5 : 1) * (air ? 2 : 1) *
    (target.id === missionTargetId ? 1.1 : 1) /
    (1 + distance(unit.tile, target.tile) / 20);
}

export function collectState(api, catalog) {
  refreshCatalog(api, catalog);
  const units = api.units("self");
  const enemies = api.units("enemy");
  const inventory = {};
  for (const unit of units) {
    const rule = catalog[unit.name] ?? {};
    inventory[unit.name] ??= {
      name: rule.label ?? unit.name,
      count: 0,
      role: roleOf(rule),
    };
    inventory[unit.name].count++;
  }
  const buildings = units.filter((u) => u.type === api.ObjectType.Building);
  const army = units.filter(
    (u) =>
      u.type !== api.ObjectType.Building &&
      u.primaryWeapon &&
      !catalog[u.name]?.harvester &&
      !catalog[u.name]?.engineer &&
      !catalog[catalog[u.name]?.deploysInto]?.yard,
  );
  const base =
    buildings.find((u) => catalog[u.name]?.yard) ?? buildings[0] ?? units[0];
  const nearby = enemies.filter(
    (enemy) => base && distance(base.tile, enemy.tile) < 22,
  );
  const unitSummary = (u) => ({
    id: u.id,
    name: catalog[u.name]?.label ?? u.name,
    kind: u.name,
    hp: u.hitPoints,
    hpFraction: round((u.hitPoints ?? 0) / (u.maxHitPoints || 1)),
    tile: { x: u.tile.rx, y: u.tile.ry },
    idle: u.isIdle,
    canDeploy: u.canDeploy,
    isDeployed: u.isDeployed,
    zone: u.zone,
  });
  const queues = api.production.queues();
  const committedCredits = queues.reduce(
    (sum, q) =>
      sum +
      q.items.reduce(
        (subtotal, item) =>
          subtotal +
          Math.max(0, item.creditsEach * item.quantity - item.creditsSpent),
        0,
      ),
    0,
  );
  return {
    raw: { units, enemies, buildings, army, base },
    state: {
      tick: api.tick(),
      gameSeconds: round(api.time()),
      self: api.me(),
      inventory,
      base: base ? { x: base.tile.rx, y: base.tile.ry } : null,
      ownArmyCount: army.length,
      deployedCombatCount: army.filter((u) => u.isDeployed).length,
      antiAirCount: army.filter((u) => activeWeapons(u, catalog).some(w=>w.aa)).length,
      harvesters: units.filter((u) => catalog[u.name]?.harvester).length,
      baseUnderAttack: baseThreats(api, catalog, buildings, enemies).length > 0,
      visibleEnemyCount: enemies.length,
      visibleEnemies: enemies.slice(0, 24).map(unitSummary),
      army: army.slice(0, 24).map(unitSummary),
      queues,
      committedCredits,
      uncommittedCredits: Math.max(0, stateCredits(api) - committedCredits),
      mobileTankCount: army.filter((u) => catalog[u.name]?.category === "AFV")
        .length,
      averageArmyHealth: army.length
        ? round(
            army.reduce(
              (n, u) => n + (u.hitPoints ?? 0) / (u.maxHitPoints || 1),
              0,
            ) / army.length,
          )
        : 1,
      nearbyEnemyCount: nearby.length,
    },
  };
}

function stateCredits(api) {
  return api.me().credits;
}

function roleOf(rule) {
  if (rule.yard) return "construction yard";
  if (rule.refinery) return "ore refinery; supplies a free miner";
  if (rule.harvester) return "ore miner";
  if (rule.power > 0) return "power producer";
  if (rule.factory) return `factory: ${rule.factory}`;
  return rule.category ?? "support or technology";
}

// Infantry-only armies: above this much money the foot cap rises, and above the second amount
// training is automatic until the cap.
export const RICH_INFANTRY_CREDITS = 3000, RICH_INFANTRY_CAP = 40, RICH_INFANTRY_SPEND = 5000;
// Any army: above RICH_SPEND credits and below RICH_ARMY_CAP units, a declined combat unit is trained anyway.
export const RICH_SPEND = 5000, RICH_ARMY_CAP = 40;
// Capture objectives: the column pushes with this many units, to a point this far short of the target.
export const CAPTURE_PUSH_UNITS = 6, CAPTURE_STAGE_TILES = 4;
// Recent answers per decision group, with the loss / kill totals at the time, so a repeated choice
// that produced nothing can be shown back to the model and demoted.
export const RECENT_LIMIT = 8, STALE_REPEATS = 4, STALE_REMOVE = 6;
export function rememberChoice(memory, group, choice, execution, tick, auto = false) {
  const recent = (memory.recent ??= {})[group] ??= [];
  const l = memory.ledger;
  recent.push({ choice, tick, auto, accepted: execution?.accepted === true, reason: execution?.reason ?? "", lost: (l?.ownUnitsLost ?? 0) + (l?.ownBuildingsLost ?? 0), killed: (l?.enemyUnitsDestroyed ?? 0) + (l?.enemyBuildingsDestroyed ?? 0) });
  if (recent.length > RECENT_LIMIT) recent.splice(0, recent.length - RECENT_LIMIT);
}
export function historyHints(groups, memory, state, assessment) {
  const l = memory.ledger, lostNow = (l?.ownUnitsLost ?? 0) + (l?.ownBuildingsLost ?? 0), killedNow = (l?.enemyUnitsDestroyed ?? 0) + (l?.enemyBuildingsDestroyed ?? 0);
  const level = assessment?.level ?? 0, out = {};
  for (const [id, g] of Object.entries(groups)) {
    const recent = memory.recent?.[id]; if (!recent?.length) continue;
    let streak = 0, first = recent.at(-1);
    for (let i = recent.length - 1; i >= 0 && recent[i].choice === recent.at(-1).choice; i--) { streak++; first = recent[i]; }
    const choice = recent.at(-1).choice, lostSince = lostNow - first.lost, killedSince = killedNow - first.killed;
    // No progress: nothing destroyed, or more lost than destroyed (feeding units in one at a time
    // still kills a few enemies, which used to hide the pattern).
    const stale = choice !== "wait" && streak >= STALE_REPEATS && (killedSince === 0 || lostSince > killedSince) && g.actions[choice];
    const summary = recent.slice(-6).map(r => `${r.choice}${r.auto ? "*" : ""}${r.accepted ? "" : r.reason === "wait" ? "" : "(" + (r.reason || "skipped") + ")"}`).join(", ");
    out[id] = { recent: summary, streak, lostSince, killedSince, stale: !!stale };
    if (!(level >= 1 || stale)) continue;
    g.instructions += ` RECENT ANSWERS HERE: ${summary}. The last ${streak} answer${streak === 1 ? "" : "s"} ${streak === 1 ? "was" : "were"} "${choice}"; since then we lost ${lostSince} and destroyed ${killedSince}. Repeating an answer that produced nothing is unlikely to work: prefer a different option unless the situation has changed.`;
    if (stale) {
      const others = Object.keys(g.actions).filter(k => k !== "wait" && k !== choice);
      // Small local models ignore the STALE text, so a long losing streak is taken off the menu for a turn.
      // Defending the base and the player's own objective are never taken off the menu.
      if ((level >= 2 || streak >= STALE_REMOVE) && others.length && choice !== "defend_base" && !choice.startsWith("objective_")) { delete g.actions[choice]; delete g.criteria[choice]; out[id].removed = true; }
      else if (g.criteria[choice]) g.criteria[choice] = `STALE ×${streak} (chosen ${streak} times, no progress): ${g.criteria[choice]}`;
    }
  }
  state.recentChoices = out;
  return out;
}

// Economy targets follow the actual situation instead of "three miners, two refineries":
// income measured over the last window (credits gained plus credits spent), whether credits are
// piling up or draining, and whether miners already sit idle without reachable ore.
export const ECONOMY_WINDOW_TICKS = 1800;
export function economyPlan(api, catalog, state, memory, units) {
  const tick = api.tick();
  const miners = units.filter(u => catalog[u.name]?.harvester);
  const refineries = units.filter(u => catalog[u.name]?.refinery).length;
  const credits = state.self?.credits ?? 0, spent = memory.spentCredits ?? 0;
  const samples = memory.economySamples ??= [];
  if (!samples.length || tick - samples.at(-1).tick >= 60) samples.push({ tick, credits, spent });
  while (samples.length > 1 && tick - samples[0].tick > ECONOMY_WINDOW_TICKS) samples.shift();
  const first = samples[0], span = tick - first.tick;
  const income = (credits - first.credits) + (spent - first.spent);
  const incomeRate = span >= 300 ? Math.round(income / span * 1000) : null;
  const trend = credits - first.credits;
  const idleMiners = miners.filter(u => u.isIdle && !findVisibleOre(api, u.tile)).length;
  const surplus = credits >= 4000 && trend >= 0;
  const starving = credits < 1500 && trend <= 0;
  let targetMiners, reason;
  if (!refineries) { targetMiners = 0; reason = "no refinery yet: a refinery comes before any miner"; }
  else if (idleMiners) { targetMiners = miners.length; reason = `${idleMiners} of ${miners.length} miners idle without reachable ore; another miner would be wasted`; }
  else if (surplus) { targetMiners = Math.max(1, miners.length); reason = `credits ${credits} and ${trend > 0 ? "rising" : "steady"} (${income >= 0 ? "+" : ""}${income} earned in the last window): money is not the bottleneck, keep ${targetMiners} miner${targetMiners === 1 ? "" : "s"}`; }
  else if (starving) { targetMiners = Math.min(3, Math.max(2, refineries * 2)); reason = `credits ${credits} and falling: expand mining toward ${targetMiners} miners`; }
  else { targetMiners = Math.min(3, Math.max(1, miners.length, refineries * 2)); reason = `income roughly covers spending (credits ${credits}, ${trend >= 0 ? "+" : ""}${trend} over the window): ${targetMiners} miner${targetMiners === 1 ? "" : "s"} for ${refineries} refiner${refineries === 1 ? "y" : "ies"}`; }
  const targetRefineries = !refineries ? 1 : starving && miners.length >= 2 && !idleMiners ? 2 : refineries;
  return { targetMiners, targetRefineries, incomeRate, trend, surplus, starving, idleMiners, reason };
}

// How the fighting is going, and what else could be brought to bear. Losses and kills come from
// the ledger; a stalled assault or a losing exchange raises the escalation level, which in turn
// raises the force needed before the next assault and points the model at every other arm.
export const COMBAT_WINDOW_TICKS = 1800, STALE_ATTACK_TICKS = 2700, ESCALATION_MAX = 3;
export function combatAssessment(api, catalog, state, memory, { army = [], units = [], enemies = [] } = {}) {
  const tick = api.tick(), ledger = memory.ledger, B = api.ObjectType.Building;
  const samples = memory.combatSamples ??= [];
  const lost = (ledger?.ownUnitsLost ?? 0) + (ledger?.ownBuildingsLost ?? 0), killed = (ledger?.enemyUnitsDestroyed ?? 0) + (ledger?.enemyBuildingsDestroyed ?? 0);
  if (!samples.length || tick - samples.at(-1).tick >= 60) samples.push({ tick, lost, killed });
  while (samples.length > 1 && tick - samples[0].tick > COMBAT_WINDOW_TICKS) samples.shift();
  const recentLost = lost - samples[0].lost, recentKilled = killed - samples[0].killed;
  const mission = memory.mission;
  const targetAlive = mission?.mode === "attack" && mission.targetId !== undefined && (enemies.some(e => e.id === mission.targetId) || memory.enemyBuildings?.has(mission.targetId));
  const staleAttack = !!mission && mission.mode === "attack" && tick - mission.since > STALE_ATTACK_TICKS && targetAlive;
  const tradingBadly = recentLost >= 4 && recentKilled * 2 <= recentLost;
  const tradingWell = recentKilled >= 3 && recentKilled >= recentLost * 2;
  const esc = memory.escalation ??= { level: 0, changedAt: -Infinity, reason: "" };
  if ((tradingBadly || staleAttack) && tick - esc.changedAt >= COMBAT_WINDOW_TICKS && esc.level < ESCALATION_MAX) {
    esc.level++; esc.changedAt = tick;
    esc.reason = tradingBadly ? `lost ${recentLost} for ${recentKilled} kills in the last ${COMBAT_WINDOW_TICKS} ticks` : `the assault on #${mission.targetId} made no progress for ${tick - mission.since} ticks`;
    // The abandoned attack must not keep refusing the regroup through its mission lock.
    if (mission?.mode === "attack") { memory.abandonedAttack = { targetId: mission.targetId, tick }; memory.mission = undefined; memory.missionLock = undefined; }
  } else if (esc.level > 0 && tick - esc.changedAt >= COMBAT_WINDOW_TICKS && (tradingWell || tick - esc.changedAt >= COMBAT_WINDOW_TICKS * 3)) {
    esc.level--; esc.changedAt = tick; esc.reason = tradingWell ? "recent exchanges are favourable" : "a quiet period";
  }
  const aircraft = units.filter(u => u.type !== B && catalog[u.name]?.aircraft && (u.ammo === undefined || u.ammo > 0)).length;
  const naval = units.filter(u => u.type !== B && catalog[u.name]?.naval && u.primaryWeapon).length;
  const engineers = units.filter(u => catalog[u.name]?.engineer).length;
  const idleGround = army.filter(u => u.isIdle && !catalog[u.name]?.naval && !catalog[u.name]?.aircraft).length;
  let hostile = []; try { hostile = api.units("hostile") ?? []; } catch { hostile = []; }
  const forward = memory.forwardPoint;
  const forwardGarrisons = forward ? hostile.filter(u => u.garrison?.canOccupy && !u.garrison.count && distance(u.tile, forward) <= 14).length : 0;
  const offers = queue => { try { return api.production.available(queue) ?? []; } catch { return []; } };
  const assets = { aircraft, naval, engineers, idleGround, forwardGarrisons,
    aircraftProducible: offers(api.QueueType?.Aircrafts ?? 4).length > 0, navalProducible: offers(api.QueueType?.Ships ?? 5).length > 0, defensesProducible: offers(api.QueueType?.Armory ?? 1).length > 0 };
  return { level: esc.level, reason: esc.reason, recentLost, recentKilled, tradingBadly, tradingWell, staleAttack, assets };
}
export function escalationAdvice(a) {
  if (!a || !a.level) return "";
  const arms = [];
  if (a.assets.aircraft) arms.push(`${a.assets.aircraft} armed aircraft`); else if (a.assets.aircraftProducible) arms.push("an air wing can be built");
  if (a.assets.naval) arms.push(`${a.assets.naval} warships`); else if (a.assets.navalProducible) arms.push("ships can be built");
  if (a.assets.forwardGarrisons) arms.push(`${a.assets.forwardGarrisons} empty civilian buildings near the target to garrison as forward strongpoints`);
  if (a.assets.engineers) arms.push(`${a.assets.engineers} engineers (capture or repair)`);
  if (a.assets.defensesProducible) arms.push("forward defensive structures");
  // Kept to one short sentence: a small model only reads the first ~256 tokens of a question.
  return `ATTACKS ARE FAILING (escalation ${a.level}): regroup, strike together, combine arms; also available: ${arms.length ? arms.join("; ") : "nothing yet"}.`;
}

// Attack readiness follows what this base can actually field, not a fixed table of units.
// - vehicles producible: the classic armored force (ATTACK_FORCE_SIZE) with anti-air escorts when needed
// - vehicles not producible: every armed ground unit counts toward the same threshold
// - nothing producible at all: attack with whatever exists
// - force stopped growing for a long time (no factory, no money, unit cap): attack with what exists
export const FORCE_STALL_TICKS = 2700, MIN_ATTACK_UNITS = 4, READY_HOLD = 0.75;
export const attackThreshold = (canBuildAnything, level = 0) => canBuildAnything ? Math.min(20, Math.round(ATTACK_FORCE_SIZE * (1 + 0.5 * level))) : 1;
// Nothing to do: after this many turns of all-wait answers with no action, ask less often (saves tokens).
export const QUIET_TURNS = 5, QUIET_INTERVAL_MS = 3000;
export function forceReadiness(api, catalog, state, army, tanks, memory) {
  const tick = api.tick();
  const vehicleType = api.QueueType?.Vehicles ?? 3, infantryType = api.QueueType?.Infantry ?? 2;
  const offers = queue => { try { return api.production.available(queue) ?? []; } catch { return []; } };
  const armed = name => (catalog[name]?.weapon?.damage ?? 0) > 0 && !catalog[name]?.harvester && !catalog[name]?.naval && catalog[name]?.category !== "AirPower";
  const vehicleOffers = offers(vehicleType).filter(i => armed(i.name));
  const infantryOffers = offers(infantryType).filter(i => armed(i.name) && !catalog[i.name]?.engineer);
  // Only what the vehicle and infantry queues hold counts: a sentry gun in the defense queue is armed
  // too, and used to make an infantry-only base wait for "0/12 ground combat vehicles" forever.
  const queuedIn = type => (state.queues ?? []).filter(q => q.type === type).flatMap(q => q.items ?? []).map(i => i.name);
  const queuedVehicles = queuedIn(vehicleType).filter(n => catalog[n] && armed(n) && !catalog[n].engineer);
  const canBuildVehicles = vehicleOffers.length > 0 || queuedVehicles.length > 0;
  const canBuildAnything = canBuildVehicles || infantryOffers.length > 0 || queuedIn(infantryType).some(n => armed(n) && !catalog[n]?.engineer);
  const aaProducible = vehicleOffers.some(i => activeWeapons({ name: i.name }, catalog).some(w => w.aa)) || queuedVehicles.some(n => activeWeapons({ name: n }, catalog).some(w => w.aa));
  const combatUnits = army.filter(u => u.type !== api.ObjectType.Building && !catalog[u.name]?.harvester && (u.primaryWeapon || (catalog[u.name]?.weapon?.damage ?? 0) > 0) && catalog[u.name]?.category !== "AirPower").length;
  const progress = memory.forceProgress;
  if (!progress || combatUnits > progress.count) memory.forceProgress = { count: combatUnits, tick };
  const stalledTicks = memory.forceProgress ? tick - memory.forceProgress.tick : 0;
  const stalled = combatUnits > 0 && stalledTicks >= FORCE_STALL_TICKS;
  const aaNeeded = (state.airThreatCount ?? 0) > 0 && (state.mobileAntiAirCount ?? 0) < ATTACK_AA_ESCORTS;
  const aaSatisfied = !aaNeeded || !aaProducible;
  const level = memory.escalation?.level ?? 0, escalatedAt = memory.escalation?.changedAt ?? -Infinity;
  const threshold = attackThreshold(canBuildAnything, level);
  const fielded = canBuildVehicles ? tanks.length : combatUnits;
  // "Already attacking" only counts while the force is still near strength (the same 75% line as the
  // readiness hysteresis): a handful of survivors of an attack must not bypass the threshold forever.
  const committedAttack = memory.mission?.mode === "attack" && fielded >= Math.max(MIN_ATTACK_UNITS, Math.ceil(threshold * READY_HOLD));
  // Hysteresis: once ready, the force stays ready until it falls below 75% of the threshold, so a
  // single loss or reinforcement near the line does not flip attack / rally every few seconds.
  const latch = memory.readinessLatch;
  const holding = !!latch?.ready && level <= latch.level && canBuildAnything && fielded >= Math.ceil(threshold * READY_HOLD);
  const escalationNote = level ? ` (escalation ${level}: attacks were failing, so ${threshold} are required)` : "";
  let ready = false, reason;
  if (committedAttack) { ready = true; reason = "an attack is already committed"; }
  // A stalled force still attacks, but never as a trickle of one or two survivors while production works.
  else if (stalled && combatUnits >= MIN_ATTACK_UNITS && (level === 0 || tick - escalatedAt >= COMBAT_WINDOW_TICKS)) { ready = true; reason = `the force has not grown for ${stalledTicks} ticks; attack with the ${combatUnits} units that exist`; }
  else if (canBuildVehicles) {
    ready = tanks.length >= threshold && aaSatisfied;
    reason = ready ? `${tanks.length} ground combat vehicles fielded${escalationNote}` : !aaSatisfied ? `air threats observed and only ${state.mobileAntiAirCount}/${ATTACK_AA_ESCORTS} mobile anti-air escorts` : `${tanks.length}/${threshold} ground combat vehicles; vehicles are producible${escalationNote}`;
    if (!ready && holding && aaSatisfied) { ready = true; reason = `${tanks.length}/${threshold} ground combat vehicles, still above ${Math.round(READY_HOLD * 100)}% of the threshold${escalationNote}`; }
  } else if (canBuildAnything) {
    ready = combatUnits >= threshold && aaSatisfied;
    reason = ready ? `${combatUnits} armed units fielded; vehicles cannot be produced here${escalationNote}` : `${combatUnits}/${threshold} armed units; vehicles cannot be produced, infantry count toward the force${escalationNote}`;
    if (!ready && holding && aaSatisfied) { ready = true; reason = `${combatUnits}/${threshold} armed units, still above ${Math.round(READY_HOLD * 100)}% of the threshold${escalationNote}`; }
  } else {
    ready = combatUnits > 0;
    reason = ready ? `nothing can be produced; attack with the ${combatUnits} units that exist` : "no armed units and no production available";
  }
  memory.readinessLatch = { ready, level };
  return { ready, reason, threshold, combatUnits, groundVehicles: tanks.length, canBuildVehicles, canBuildAnything, aaProducible, aaNeeded, stalledTicks, escalation: level };
}

// Both sides' unit and building counts, plus cumulative built / lost / destroyed, observed from the
// public view: own losses are exact; enemy kills are counted only when a previously seen object is
// gone from a tile we can still see, so anything that slipped away in fog is not claimed.
export function updateLedger(api, catalog, memory) {
  const tick = api.tick(), B = api.ObjectType.Building;
  const ledger = memory.ledger ??= { seenOwn: new Map(), seenEnemy: new Map(), seeded: false, ownBuilt: 0, ownUnitsLost: 0, ownBuildingsLost: 0, enemyUnitsDestroyed: 0, enemyBuildingsDestroyed: 0 };
  const own = api.units("self"), enemies = api.units("enemy");
  const ownIds = new Set();
  for (const u of own) { ownIds.add(u.id); if (!ledger.seenOwn.has(u.id)) { ledger.seenOwn.set(u.id, { building: u.type === B }); if (ledger.seeded) ledger.ownBuilt++; } }
  for (const [id, info] of ledger.seenOwn) if (!ownIds.has(id)) { ledger.seenOwn.delete(id); if (info.building) ledger.ownBuildingsLost++; else ledger.ownUnitsLost++; }
  const enemyIds = new Set();
  for (const e of enemies) { enemyIds.add(e.id); ledger.seenEnemy.set(e.id, { building: e.type === B, x: e.tile?.rx, y: e.tile?.ry, tick }); }
  for (const [id, info] of ledger.seenEnemy) if (!enemyIds.has(id)) {
    if (info.x !== undefined && api.map.visible(info.x, info.y)) { ledger.seenEnemy.delete(id); if (info.building) ledger.enemyBuildingsDestroyed++; else ledger.enemyUnitsDestroyed++; }
    else if (tick - info.tick > 3000) ledger.seenEnemy.delete(id);
  }
  ledger.seeded = true;
  return { ownUnits: own.filter(u => u.type !== B).length, ownBuildings: own.filter(u => u.type === B).length, enemyUnits: enemies.filter(u => u.type !== B).length, enemyBuildings: enemies.filter(u => u.type === B).length,
    ownBuilt: ledger.ownBuilt, ownUnitsLost: ledger.ownUnitsLost, ownBuildingsLost: ledger.ownBuildingsLost, enemyUnitsDestroyed: ledger.enemyUnitsDestroyed, enemyBuildingsDestroyed: ledger.enemyBuildingsDestroyed };
}

export function frontierPoints(api, base, memory) {
  const size = api.map.size();
  const points = [];
  const now = api.tick();
  for (let x = 2; x < size.width; x += 3)
    for (let y = 2; y < size.height; y += 3) {
      const tile = api.map.tile(x, y);
      if (!tile || [2, 7].includes(tile.landType)) continue;
      if (
        [...memory.frontiers.entries()].some(([key, t]) => {
          const [vx, vy] = key.split(",").map(Number);
          return now - t < 1800 && Math.hypot(x - vx, y - vy) < 7;
        })
      )
        continue;
      let fog = 0;
      for (const [dx, dy] of [
        [7, 0],
        [-7, 0],
        [0, 7],
        [0, -7],
        [5, 5],
        [-5, -5],
        [5, -5],
        [-5, 5],
      ]) {
        if (
          x + dx >= 0 &&
          y + dy >= 0 &&
          x + dx < size.width &&
          y + dy < size.height &&
          !api.map.visible(x + dx, y + dy)
        )
          fog++;
      }
      if (!fog) continue;
      const vx = size.width / 2 - (base?.tile.rx ?? size.width / 2),
        vy = size.height / 2 - (base?.tile.ry ?? size.height / 2),
        norm = Math.hypot(vx, vy) || 1;
      const forward = base
        ? ((x - base.tile.rx) * vx + (y - base.tile.ry) * vy) / norm
        : 0;
      const lateral = base
        ? Math.abs((x - base.tile.rx) * vy - (y - base.tile.ry) * vx) / norm
        : 0;
      points.push({
        x,
        y,
        fog,
        score: fog * 3 + forward * 0.8 - lateral * 0.3,
      });
    }
  points.sort((a, b) => b.score - a.score);
  const distinct = [];
  for (const p of points)
    if (distinct.every((q) => Math.hypot(p.x - q.x, p.y - q.y) > 10)) {
      distinct.push(p);
      if (distinct.length === 3) break;
    }
  return distinct;
}

// Assault options per question (a small model sees ~256 tokens of options), how far from the troops
// a mobile enemy may be to be offered for engagement, and how long a rally point stays put.
export const MAX_ASSAULTS = 6, MAX_ASSAULTS_WITH_OBJECTIVE = 4, ENGAGE_RADIUS = 15, RALLY_HOLD_TICKS = 1800, OBJECTIVE_GUARD_RADIUS = 10;
// The rally point used to be re-scored every turn, including how many of our units stood nearby,
// so it wandered and the gather order was re-sent over and over. It now stays for a while.
export function stableRallySite(api, catalog, own, base, memory) {
  const tick = api.tick(), kept = memory.rally;
  const blocked = (p) => own.some((b) => b.type === api.ObjectType.Building && Math.hypot(b.tile.rx - p.x, b.tile.ry - p.y) < 5);
  if (kept && base && kept.baseId === base.id && tick - kept.tick < RALLY_HOLD_TICKS && !blocked(kept)) return kept;
  const site = chooseRallySite(api, catalog, own, base);
  memory.rally = site && base ? { x: site.x, y: site.y, tick, baseId: base.id } : undefined;
  return memory.rally;
}

// Enemy structures seen so far, kept through the fog; a remembered position observed empty is
// removed instead of being attacked as a ruin again and again.
export function rememberEnemyBuildings(api, catalog, memory, enemies) {
  memory.enemyBuildings ??= new Map();
  for (const enemy of enemies)
    if (enemy.type === api.ObjectType.Building && !isDecoration(catalog[enemy.name], enemy.name))
      memory.enemyBuildings.set(enemy.id, { id: enemy.id, name: enemy.name, x: enemy.tile.rx, y: enemy.tile.ry, tick: api.tick() });
  for (const [id, known] of memory.enemyBuildings)
    if (api.map.visible(known.x, known.y) && !enemies.some((e) => e.id === id))
      memory.enemyBuildings.delete(id);
  return memory.enemyBuildings;
}
// The player's own objective, matched to a real building (remembered through the fog), written to
// state.objectiveTarget for the model.
export function objectiveState(api, catalog, memory, base, state) {
  const objective = trackObjective(api, catalog, memory, base?.tile);
  state.objectiveTarget = objective ? { id: objective.id, name: objective.name, label: objective.label, x: objective.x, y: objective.y, lastSeenTick: objective.lastSeen, visible: !!objective.visible, done: !!objective.done, captured: !!objective.captured,
    ...(Number.isFinite(objective.hp) ? { hp: objective.hp } : {}), ...(objective.afterCapture ? { afterCapture: objective.afterCapture } : {}),
    ...(objective.mode === "capture" ? { mode: "capture", ...(objective.lost ? { lost: true } : {}) } : {}) }
    : memory.objective ? { found: false, keywords: [...(memory.objectiveKeys?.words ?? []), ...(memory.objectiveKeys?.capture ?? [])],
      // What the visible buildings are actually called, so an unmatched objective can be fixed from a report.
      seen: [...new Set((api.units("hostile") ?? []).filter((u) => u.type === api.ObjectType.Building).map((u) => `${catalog[u.name]?.label ?? u.name}/${u.name}`))].slice(0, 30) } : null;
  return objective;
}

export function candidateGroups(api, catalog, snapshot, memory) {
  const { units, buildings, army: allArmy, enemies, base } = snapshot.raw,
    state = snapshot.state;
  const army = allArmy.filter((u) => !catalog[u.name]?.naval && !catalog[u.name]?.aircraft && api.tick() - (memory.specialOrders?.get(u.id)?.tick ?? -10000) > 450);
  memory.frontiers ??= new Map();
  memory.enemyBuildings ??= new Map();
  const groups = {};
  function group(id, instructions) {
    const g = {
      instructions,
      criteria: {
        wait: "No useful action is needed in this category, or insufficient funds. Keep the current mission. Do not wait when a supplied urgent action is affordable.",
      },
      actions: { wait: { type: "wait" } },
    };
    groups[id] = g;
    return (key, label, action) => {
      g.criteria[key] = label;
      g.actions[key] = action;
    };
  }
  const owned = (test) =>
    units.filter((u) => test(catalog[u.name] ?? {})).length;
  const refineries = owned((r) => r.refinery),
    miners = state.harvesters;
  const barracks = owned((r) => r.factory === "InfantryType"),
    factories = owned((r) => r.factory === "UnitType" && !r.naval);
  const powerMargin =
    (state.self.power?.total ?? 0) - (state.self.power?.drain ?? 0);
  const plan = economyPlan(api, catalog, state, memory, units);
  state.economy = {
    refineries,
    miners,
    ...plan,
    barracks,
    factories,
    powerMargin,
  };
  assessStrategy(api, catalog, snapshot, memory);
  state.airThreatCount = enemies.filter((u) => u.zone === 1).length;
  state.antiAirCount = army.filter((u) => activeWeapons(u, catalog).some(w=>w.aa)).length;
  state.mobileAntiAirCount = army.filter(u=>u.type===api.ObjectType.Vehicle&&!catalog[u.name]?.naval&&catalog[u.name]?.category!=='AirPower'&&activeWeapons(u,catalog).some(w=>w.aa)).length;
  state.mission = memory.mission?.label ?? "待命";
  state.activeMission = memory.mission
    ? {
        mode: memory.mission.mode,
        x: memory.mission.x,
        y: memory.mission.y,
        ageTicks: api.tick() - memory.mission.since,
      }
    : null;
  const build = group(
    "construction",
    `Choose the needed base investment. Establish power, refinery, barracks, vehicle factory. Economy targets follow the actual situation, not a fixed count: currently ${state.economy.targetRefineries} refiner${state.economy.targetRefineries === 1 ? "y" : "ies"} and ${state.economy.targetMiners} miner${state.economy.targetMiners === 1 ? "" : "s"} (${state.economy.reason}). Do not add refineries or miners beyond that while credits accumulate unused. Restore lost essential infrastructure immediately.` + " Keep at least 50 spare power. Unlock technology and counter-weapons before duplicating the vehicle factory; a second factory is useful only with surplus income. Only proposed buildings currently contribute to these needs.",
  );
  const mcv = units.find((u) => catalog[catalog[u.name]?.deploysInto]?.yard);
  if (mcv)
    build(
      "deploy_base",
      "URGENT: deploy the construction vehicle so the base can start.",
      { type: "deploy", ids: [mcv.id] },
    );
  const queueOf = (type) => state.queues.find((q) => q.type === type);
  const constructionType = api.QueueType?.Structures ?? 0;
  if (!queueOf(constructionType)?.size)
    for (const item of api.production.available(constructionType)) {
      const r = catalog[item.name];
      if (!r || r.naval) continue;
      let need = false;
      if (powerMargin < 50 || !buildings.length) need = r.power > 0;
      else if (!refineries) need = r.refinery;
      else if (!barracks) need = r.factory === "InfantryType";
      else if (!factories) need = r.factory === "UnitType";
      else if (refineries < state.economy.targetRefineries) need = r.refinery;
      else if (state.economy.surplus && factories < 2 && (queueOf(api.QueueType?.Vehicles ?? 3)?.size ?? 0) > 0)
        need = r.factory === "UnitType";
      if (need && state.self.credits >= Math.min(500, r.cost))
        build(
          `produce_${item.name}`,
          `Build ${r.label}; cost ${r.cost}; ${roleOf(r)}. Needed now by our development plan.`,
          {
            type: "produce",
            name: item.name,
            queue: constructionType,
            cost: r.cost,
            minCredits: Math.min(500, r.cost),
          },
        );
    }
  groups.construction.criteria.wait =
    "The construction queue is already occupied, or credits are below the cost of every offered building. Neither infrastructure recovery nor production expansion is affordable.";
  const vehicleType = api.QueueType?.Vehicles ?? 3;
  const train = group(
    "vehicles",
    `Choose what the vehicle factory should produce next. The miner target follows the economy, not a fixed number: ${state.economy.targetMiners} now (${state.economy.reason}). Below the target, buy a miner unless the base is under attack and needs a tank; at or above it, do not buy miners. Produce effective counters while preserving the strategy investment budget.` + " Maintain 2 mobile anti-air escorts after 4 tanks, even before spotting aircraft. Use mobileAntiAirCount: deployed infantry guarding the base are not mobile escorts. URGENT: when airThreatCount is positive and mobileAntiAirCount is below 3, build mobile anti-air first; tanks cannot hit flying enemies. A completed queue should be refilled while affordable. Saving for the selected defensive or technology investment is intentional.",
  );
  if (!queueOf(vehicleType)?.size && factories)
    for (const item of vehicleOptions(api,catalog,state)) {
      const r = catalog[item.name], { economic, antiAir } = item;
      if (state.self.credits < Math.min(250, r.cost)) continue;
      train(
        `produce_${item.name}`,
        `${economic ? "ECONOMY" : antiAir ? "ANTI-AIR" : "ARMY"}: produce ${r.label}; cost ${r.cost}; currently owned ${state.inventory[item.name]?.count ?? 0}; weapons ${[r.weapon,r.secondary].filter(w=>w?.damage>0).map(w=>`damage ${w.damage}, range ${w.range}, air ${!!w.aa}, ground ${w.ag!==false}`).join("; ")}. ${economic ? "Needed to reach 3 miners." : "Reinforce the tank army."}`,
        {
          type: "produce",
          name: item.name,
          queue: vehicleType,
          cost: r.cost,
          minCredits: Math.min(250, r.cost),
        },
      );
    }
  groups.vehicles.criteria.wait =
    "Vehicle production is already busy or credits are below all offered vehicle costs. If idle and affordable, strengthen the armored force or add its missing anti-air escort.";
  const infantryType = api.QueueType?.Infantry ?? 2;
  const footCount = army.filter(
    (u) => u.type === api.ObjectType.Infantry,
  ).length;
  const infantryOffers=api.production.available(infantryType).filter(i=>catalog[i.name]&&!catalog[i.name].engineer);
  const preferredScout=[...infantryOffers].filter(i=>catalog[i.name].weapon?.damage>0)
    .sort((a,b)=>scoutScore(catalog[b.name])-scoutScore(catalog[a.name]))[0];
  const scoutUnits=army.filter(u=>u.type===api.ObjectType.Infantry).sort((a,b)=>scoutScore(catalog[b.name])-scoutScore(catalog[a.name]));
  const bestScout=scoutUnits[0];
  if(bestScout)memory.scoutId=bestScout.id;
  const needsScout=(!memory.enemyBuildings.size||memory.lastReady===false)&&!state.baseUnderAttack&&preferredScout&&
    !scoutUnits.some(u=>u.name===preferredScout.name)&&!state.queues.some(q=>q.items.some(i=>i.name===preferredScout.name));
  const roles={antiInfantry:0,antiArmor:0};
  for(const u of scoutUnits)if(u.id!==memory.scoutId&&catalog[u.name]?.weapon?.range>=3)roles[infantryProfile(catalog[u.name],api).role]++;
  // Without a vehicle factory (or anything it can build), infantry is the whole army: the support
  // caps (six infantry, three of each role) would freeze the force below the attack threshold forever.
  const vehicleArmy=api.production.available(api.QueueType?.Vehicles ?? 3).some(i=>(catalog[i.name]?.weapon?.damage??0)>0&&!catalog[i.name]?.harvester&&!catalog[i.name]?.naval);
  const infantryArmy=!vehicleArmy;
  // With money piling up the infantry army keeps growing: 0.7.1 (Pentagon mission, conscripts only)
  // held 20 conscripts against a concrete target for ten minutes with 9,000 credits unspent.
  const richFoot=infantryArmy&&state.self.credits>=RICH_INFANTRY_CREDITS;
  const footCap=infantryArmy?(richFoot?RICH_INFANTRY_CAP:Math.min(20,ATTACK_FORCE_SIZE*2)):6, roleCap=infantryArmy?footCap:3;
  const combatFoot=scoutUnits.filter(u=>(catalog[u.name]?.weapon?.damage??0)>0&&!catalog[u.name]?.engineer).length;
  // Money piling up while the army is short: the model saying "wait" is no longer a real choice.
  // "Short" is measured against the current attack threshold (12 or 16 after failed attacks), which
  // is only known further down, so the combat training options are collected and marked there.
  const combatTraining=[];
  state.infantryRoles={...roles,targetAntiInfantry:roleCap,targetAntiArmor:infantryArmy?footCap:state.airThreatCount>0?3:2,infantryArmy,preferredScout:preferredScout?.name,needsScout:!!needsScout};
  const foot = group(
    "infantry",
    "Choose infantry by role and cost effectiveness: maintain anti-infantry firepower plus limited anti-armor/anti-air support, not six copies of one specialist. Read the armor-adjusted normal/deployed scores; higher tech and raw damage do not imply better anti-infantry performance. Before the enemy base is found, train one affordable fast scout identified by speed and cost (often a dog); keep it mobile. Preserve funds for miners and tanks.",
  );
  if (
    !queueOf(infantryType)?.size &&
    barracks &&
    (footCount < footCap || needsScout) &&
    (footCount < 1 || state.self.credits > 1000 || needsScout && state.self.credits >= catalog[preferredScout.name].cost)
  )
    for (const item of infantryOffers) {
      const r = catalog[item.name];
      const isScout=needsScout&&item.name===preferredScout.name;
      const profile=infantryProfile(r,api);
      if (
        !r ||
        r.engineer ||
        r.cost > 1500 ||
        r.weapon?.damage <= 0 ||
        (!isScout && (r.weapon?.range < 3 || roles[profile.role] >= (profile.role==='antiInfantry'?roleCap:state.infantryRoles.targetAntiArmor))) ||
        r.cost > state.self.credits
      )
        continue;
      const trainAction={
          type: "produce",
          name: item.name,
          queue: infantryType,
          cost: r.cost,
          minCredits: r.cost,
        };
      if(!isScout)combatTraining.push(trainAction);
      foot(
        `produce_${item.name}`,
        `${isScout?'SCOUT FIRST: one fast expendable scout to locate the enemy base':'COMBAT ROLE: '+profile.role}. Produce ${r.label}, cost ${r.cost}; speed ${r.speed??0}; current role counts ${JSON.stringify(roles)}. Armor-adjusted anti-infantry score normal ${round(profile.normalInfantry)}, deployed ${round(profile.deployedInfantry)}; best anti-armor ${round(profile.antiArmor)}. Anti-infantry score per 100 credits ${round(profile.antiInfantry/r.cost*100)}. Deployment can reduce damage against infantry.`,
        trainAction,
      );
    }
  if(needsScout) {
    groups.infantry.instructions+=` SCOUT FIRST: prefer ${preferredScout.name} before adding another slow combat specialist while the enemy base is unknown.`;
  }
  const posture = group(
    "deployment",
    "Choose deployment posture using armor-adjusted damage against nearby visible targets. Deployment is not always stronger: anti-armor missiles can perform worse against infantry than the mobile weapon. Prefer the better stance for the actual target; reserve deployed anti-armor/AA units for those threats. Keep the scout mobile. Undeploy to follow a mission when no useful target is in range. Never toggle a unit already in the desired state.",
  );
  const deployable = army.filter(
    (u) =>
      u.canDeploy &&
      typeof u.isDeployed === "boolean" &&
      catalog[u.name]?.deployer,
  );
  const scoutId =
    memory.scoutId ?? army.find((u) => u.type === api.ObjectType.Infantry)?.id;
  const holdingBase = (u) =>
    u.id !== scoutId &&
    u.isIdle &&
    base &&
    distance(u.tile, base.tile) < 20 &&
    !memory.mission?.ids.includes(u.id);
  const needsMovement = (u) =>
    memory.mission?.ids.includes(u.id) &&
    Math.hypot(u.tile.rx - memory.mission.x, u.tile.ry - memory.mission.y) > 4;
  const nearbyTargets=u=>enemies.filter(e=>distance(u.tile,e.tile)<=Math.max(catalog[u.name]?.weapon?.range??0,catalog[u.name]?.secondary?.range??0));
  const stanceScores=u=>{const targets=nearbyTargets(u),r=catalog[u.name];
    const score=w=>{if(!targets.length)return weaponEffectiveness(w,[],catalog,api);const reachable=targets.filter(e=>distance(u.tile,e.tile)<=(w?.range??0)&&distance(u.tile,e.tile)>=(w?.minRange??0));return reachable.length?weaponEffectiveness(w,reachable,catalog,api):0;};
    return {targets,normal:score(r.weapon),deployed:score(r.secondary)};};
  state.deployment = deployable.map((u) => {
    const r = catalog[u.name];
    return {
      id: u.id,
      kind: u.name,
      deployed: u.isDeployed,
      holdingBase: !!holdingBase(u),
      needsMovement: !!needsMovement(u),
      normal: r.weapon,
      deployedWeapon: r.secondary,
      matchup:{normal:round(stanceScores(u).normal),deployed:round(stanceScores(u).deployed)},
      nearestEnemy: enemies.length
        ? round(Math.min(...enemies.map((e) => distance(u.tile, e.tile))))
        : null,
    };
  });
  const toDeploy = deployable.filter(
    (u) =>
      !u.isDeployed &&
      (u.id !== scoutId || nearbyTargets(u).length && !memory.mission?.ids.includes(u.id)) &&
      (!nearbyTargets(u).length || stanceScores(u).deployed >= stanceScores(u).normal) &&
      (holdingBase(u) ||
        enemies.some(
          (e) =>
            (e.zone !== 1 || catalog[u.name]?.secondary?.aa) &&
            distance(u.tile, e.tile) <=
              (catalog[u.name]?.secondary?.range ?? 0),
        )),
  );
  const toUndeploy = deployable.filter(
    (u) =>
      u.isDeployed &&
      ((needsMovement(u) && !enemies.some((e) => api.inRange(u.id, e.id, "current"))) ||
        nearbyTargets(u).some(e=>distance(u.tile,e.tile)<=(catalog[u.name]?.weapon?.range??0)) && stanceScores(u).normal>stanceScores(u).deployed*1.25),
  );
  if (toDeploy.length)
    posture(
      "deploy_combat",
      `Deploy ${toDeploy.length} units now: they are holding base defense or an enemy is within deployed range; deployment improves sustained damage/range. The scout is excluded from idle base deployment. See per-unit weapon comparison in state.deployment.`,
      { type: "set_deployed", deployed: true, ids: toDeploy.map((u) => u.id) },
    );
  if (toUndeploy.length)
    posture(
      "undeploy_mobile",
      `Undeploy ${toUndeploy.length} units: the normal weapon is stronger against nearby target armor, or the movement mission needs mobility without an in-range target. See per-unit matchup scores.`,
      {
        type: "set_deployed",
        deployed: false,
        ids: toUndeploy.map((u) => u.id),
      },
    );
  groups.deployment.criteria.wait =
    "Preserve current deployment if there is no useful posture change; avoid leaving an engaged GI undeployed when its deployed weapon is more effective.";
  rememberEnemyBuildings(api, catalog, memory, enemies);
  state.knownEnemyBuildings = [...memory.enemyBuildings.values()].map(({name,x,y,tick})=>({name,x,y,lastSeenTick:tick}));
  const tanks = army.filter((u) => u.type === api.ObjectType.Vehicle&&!catalog[u.name]?.naval&&catalog[u.name]?.category!=='AirPower');
  const support = army.filter(u=>u.type===api.ObjectType.Infantry&&u.id!==memory.scoutId&&
    api.tick()-(memory.specialOrders?.get(u.id)?.tick??-10000)>450);
  const active = [...tanks,...support];
  // Where the fight is: the visible enemy structure or the last known one, for forward assets.
  const forwardTarget = enemies.find(e => e.type === api.ObjectType.Building) ?? [...memory.enemyBuildings.values()][0];
  memory.forwardPoint = forwardTarget ? { rx: forwardTarget.tile?.rx ?? forwardTarget.x, ry: forwardTarget.tile?.ry ?? forwardTarget.y } : undefined;
  const assessment = combatAssessment(api, catalog, state, memory, { army, units, enemies });
  state.combatAssessment = assessment;
  const readiness = forceReadiness(api, catalog, state, army, tanks, memory);
  state.forceReadiness = readiness;
  memory.lastReady = readiness.ready;
  if (infantryArmy && state.self.credits >= 3000 && (combatFoot < readiness.threshold || state.self.credits >= RICH_INFANTRY_SPEND && combatFoot < footCap)) for (const a of combatTraining) a.auto = 2;
  // Ready on paper but only a handful of units free to move: gather first instead of feeding them in.
  const tooFew = readiness.canBuildAnything && active.length < MIN_ATTACK_UNITS;
  const ready = readiness.ready && !tooFew;
  if (tooFew && readiness.ready) state.forceReadiness = { ...readiness, ready: false, reason: `only ${active.length} units are free to attack; gather at least ${MIN_ATTACK_UNITS} before striking` };
  const rallySite = stableRallySite(api, catalog, units, base, memory);
  // The player's own objective, matched to a real building (remembered through the fog).
  const objective = objectiveState(api, catalog, memory, base, state);
  const objectiveTarget = objective && !objective.done ? objective : undefined;
  // Small local models read only the start of a question: objective and readiness go first, the
  // escalation note is one short sentence at the end.
  const where = (t) => `(${t.x},${t.y})`;
  const captureMission = objective?.mode === "capture";
  const objectiveNote = memory.objective ? `MISSION OBJECTIVE: ${memory.objective} ${objectiveTarget ? captureMission ? `CAPTURE target: ${objectiveTarget.label} #${objectiveTarget.id} at ${where(objectiveTarget)}; never attack it, clear the defenses around it for the engineer. ` : `Target: ${objectiveTarget.label} #${objectiveTarget.id} at ${where(objectiveTarget)}. ` : objective?.captured ? `Target ${objective.label} captured. ` : objective?.lost ? `Target ${objective.label} was destroyed; the capture failed. ` : objective?.done ? `Target ${objective.label} destroyed. ` : "Target not found yet. "}` : "";
  const readyNote = state.forceReadiness.ready
    ? `Force READY (${state.forceReadiness.reason}): choose a supplied attack now.`
    : `Force not ready (${state.forceReadiness.reason}); ${readiness.threshold} combat units needed, ${readiness.combatUnits} exist.`;
  const tactics = group(
    "tactics",
    `${objectiveNote}${readyNote} Choose the combat mission to win by destroying the enemy base; protect the base from nearby attackers first. Keep a useful active attack; do not oscillate between attack and retreat. When the enemy base is unknown, advance through a supplied frontier. Combat orders cost zero credits.${assessment.level ? " " + escalationAdvice(assessment) : ""}`,
  );
  groups.tactics.criteria.wait = "Keep the current mission; nothing supplied is better.";
  state.combat = {
    tanks: tanks.length,
    army: army.length,
    enemyVisible: enemies.length,
    health: state.averageArmyHealth,
    baseThreat: state.baseUnderAttack,
  };
  const threatening = baseThreats(api, catalog, buildings, enemies).sort((a,b) =>
    Number(buildings.some(u=>canFireAt(api,catalog,b,u))) - Number(buildings.some(u=>canFireAt(api,catalog,a,u))) ||
    (combatWeapon(b,catalog).range??0)-(combatWeapon(a,catalog).range??0));
  if (active.length) {
    const ids = active.map((u) => u.id);
    // The objective is offered whatever the force size: the player asked for it. It comes first,
    // except that a threatened base is defended first. It is automatic only when the force is ready
    // (or the stall rule applies): otherwise it would feed small groups in one after another.
    // A capture target is taken by an engineer, never attacked: the army pushes to a point beside it
    // and clears its defenders while the engineer follows (special groups). Capture missions can be
    // on a clock (0.7.3: the Battle Lab fell at 32:30 both times), so the push does not wait for the
    // full attack threshold, only for CAPTURE_PUSH_UNITS.
    const pushReady = captureMission && (ready || ids.length >= CAPTURE_PUSH_UNITS);
    const offerCapturePush = () => {
      const c = { rx: active.reduce((n, u) => n + u.tile.rx, 0) / active.length, ry: active.reduce((n, u) => n + u.tile.ry, 0) / active.length };
      const d = Math.hypot(c.rx - objectiveTarget.x, c.ry - objectiveTarget.y) || 1, back = Math.min(CAPTURE_STAGE_TILES, d);
      const x = Math.round(objectiveTarget.x + (c.rx - objectiveTarget.x) / d * back), y = Math.round(objectiveTarget.y + (c.ry - objectiveTarget.y) / d * back);
      tactics(`objective_${objectiveTarget.id}`,
        `OBJECTIVE PUSH: attack-move ${ids.length} units to (${x},${y}) beside ${objectiveTarget.label} #${objectiveTarget.id}, clearing its defenders so the engineer following the column can capture it. The target itself is never attacked.`,
        { type: "mission", mode: "attack", label: `掩护占领 ${objectiveTarget.label}`, ids, x, y, objective: true, capturePush: objectiveTarget.id,
          ...(threatening.length || !pushReady ? {} : { auto: 2 }) });
    };
    const offerObjective = () => objectiveTarget && (captureMission ? offerCapturePush() : tactics(
      `objective_${objectiveTarget.id}`,
      `OBJECTIVE: destroy ${objectiveTarget.label} #${objectiveTarget.id} ${objectiveTarget.visible ? "at" : "last seen at"} ${where(objectiveTarget)} with ${ids.length} units.`,
      {
        type: "mission",
        mode: "attack",
        label: `本局目标 ${objectiveTarget.label}`,
        ids,
        targetId: objectiveTarget.id,
        x: objectiveTarget.x,
        y: objectiveTarget.y,
        objective: true,
        ...(threatening.length || !ready ? {} : { auto: 2 }),
      },
    ));
    if (!threatening.length) offerObjective();
    // With a capture objective and enough units to push, gathering more only runs the clock down.
    if (!ready && !pushReady && !threatening.length && rallySite && memory.enemyBuildings.size)
      tactics(
        "assemble_force",
        `Gather ${ids.length} troops near our base and accumulate ${readiness.threshold} combat units including 2 anti-air escorts if air threats exist. Do not feed reinforcements into the enemy base one at a time.`,
        {
          type: "mission",
          mode: "rally",
          label: "集结装甲编队",
          ids,
          x: rallySite.x,
          y: rallySite.y,
        },
      );
    const navalDefenders = units.filter(u => u.type !== api.ObjectType.Building && catalog[u.name]?.naval && u.primaryWeapon &&
      threatening.length && (api.weaponVs ? !!api.weaponVs(u.id, threatening[0].id) : true)).map(u => u.id);
    if (threatening.length)
      tactics(
        "defend_base",
        `URGENT: intercept ${threatening.length} visible base threats. Priority target #${threatening[0].id}, range ${combatWeapon(threatening[0],catalog).range}. Attack the hostile units directly; remaining at a rally point outside weapon range does not defend the base. Use compatible mobile counters, undeploy when movement is required, and stop chasing after targets leave the base area.`,
        {
          type: "mission",
          mode: "defend",
          label: "保卫基地",
          ids: [...ids, ...navalDefenders],
          targetId: threatening[0].id,
          x: threatening[0].tile.rx,
          y: threatening[0].tile.ry,
        },
      );
    if (threatening.length) offerObjective();
    const center = { rx: active.reduce((n, u) => n + u.tile.rx, 0) / active.length, ry: active.reduce((n, u) => n + u.tile.ry, 0) / active.length };
    const gap = (u) => Math.hypot(u.tile.rx - center.rx, u.tile.ry - center.ry);
    // Flags, lamp posts and other decorations owned by the enemy house are not targets; the
    // objective has its own option above.
    const structures = enemies.filter((e) => e.type === api.ObjectType.Building && !isDecoration(catalog[e.name], e.name));
    // Buildings the objective says to protect or capture are never assault targets: 0.7.2 offered the
    // Battle Lab it was told to capture as an assault, and the mission was lost when it fell.
    const candidates = structures.filter((e) => e.id !== objectiveTarget?.id && !catalog[e.name]?.wall && !isGuardedByObjective(memory.objective, catalog[e.name], e.name));
    const hitsGround = (e) => activeWeapons(e, catalog).some((w) => (w.damage ?? 0) > 0 && w.ag !== false);
    const antiAirOnly = (e) => !hitsGround(e) && activeWeapons(e, catalog).some((w) => (w.damage ?? 0) > 0 && w.aa);
    // Every nearby defense that can shoot at ground troops gets its own option: a road lined with
    // pillboxes on both sides needs both sides cleared. Anti-air sites never shoot back at the column.
    // With an objective the list is shorter, so the readiness note and the objective stay within what
    // a small model reads. Defenses guarding the objective come first among the defenses.
    const cap = objectiveTarget ? MAX_ASSAULTS_WITH_OBJECTIVE : MAX_ASSAULTS;
    const guardsObjective = (e) => !!objectiveTarget && Math.hypot(e.tile.rx - objectiveTarget.x, e.tile.ry - objectiveTarget.y) <= OBJECTIVE_GUARD_RADIUS;
    // Defenses guarding the objective go first, the one hugging it before the others; the rest by
    // distance from our troops.
    const fromObjective = (e) => Math.hypot(e.tile.rx - objectiveTarget.x, e.tile.ry - objectiveTarget.y);
    const defenses = candidates.filter(hitsGround).sort((a, b) => Number(guardsObjective(b)) - Number(guardsObjective(a)) ||
      (guardsObjective(a) && guardsObjective(b) ? fromObjective(a) - fromObjective(b) : gap(a) - gap(b))).slice(0, cap === MAX_ASSAULTS ? 3 : 2);
    // Anti-air sites do not take a defense slot but stay at the end of the list: when nothing else is
    // left they are what remains to destroy.
    const rank = (e) => { const r = catalog[e.name] ?? {}; return antiAirOnly(e) ? 5 : r.yard ? 0 : r.factory ? 1 : r.refinery ? 2 : r.power > 0 ? 3 : 4; };
    const others = candidates.filter((e) => !hitsGround(e)).sort((a, b) => rank(a) - rank(b) || gap(a) - gap(b));
    const offered = [...others.slice(0, Math.max(cap === MAX_ASSAULTS ? 3 : 2, cap - defenses.length)), ...defenses];
    // A capture mission is won by the engineer reaching the target: the defenses around it come first.
    if (captureMission) offered.sort((a, b) => Number(guardsObjective(b) && hitsGround(b)) - Number(guardsObjective(a) && hitsGround(a)));
    if (ready && !threatening.length)
      for (const enemy of offered)
        tactics(
          `assault_${enemy.id}`,
          `Assault visible enemy ${catalog[enemy.name]?.label ?? enemy.name} at (${enemy.tile.rx},${enemy.tile.ry}) with ${ids.length} units.`,
          {
            type: "mission",
            mode: "attack",
            label: `进攻 ${enemy.name}`,
            ids,
            targetId: enemy.id,
            x: enemy.tile.rx,
            y: enemy.tile.ry,
            // Clearing a pillbox in front of the objective is part of the objective attack.
            ...(guardsObjective(enemy) && hitsGround(enemy) ? { clearsObjective: true } : {}),
          },
        );
    if (!structures.length && ready && !threatening.length && memory.enemyBuildings.size && !objectiveTarget) {
      const known = [...memory.enemyBuildings.values()][0];
      tactics(
        "assault_known_base",
        `Attack-move to enemy building last seen at tick ${known.tick}; current hidden state unknown.`,
        {
          type: "mission",
          mode: "attack",
          label: "推进已侦察敌军基地",
          ids,
          x: known.x,
          y: known.y,
        },
      );
    }
    // Only enemies near the troops: chasing a unit seen across the map drags the column around.
    const mobileEnemy = enemies.filter(e=>e.primaryWeapon && e.type!==api.ObjectType.Building && e.zone!==(api.ZoneType?.Air??1) && gap(e) <= ENGAGE_RADIUS)
      .map(e=>({enemy:e,score:active.reduce((sum,u)=>sum+combatTargetScore(api,catalog,u,e),0)}))
      .filter(e=>e.score>0).sort((a,b)=>b.score-a.score)[0]?.enemy;
    if (ready && mobileEnemy && !threatening.length) {
      const e = mobileEnemy;
      tactics(
        "engage_visible",
        `Engage ${catalog[e.name]?.label ?? e.name} #${e.id} at (${e.tile.rx},${e.tile.ry}), ${Math.round(gap(e))} tiles from our ${ids.length} troops; health ${(state.averageArmyHealth * 100).toFixed(0)}%.`,
        {
          type: "mission",
          mode: "attack",
          label: "迎击可见敌军",
          ids,
          targetId: e.id,
          x: e.tile.rx,
          y: e.tile.ry,
        },
      );
    }
    if (state.averageArmyHealth < 0.35 && !state.baseUnderAttack && rallySite)
      tactics(
        "regroup",
        `Health is low; fall back to base and rebuild force.`,
        {
          type: "mission",
          mode: "retreat",
          label: "撤回整补",
          ids,
          x: rallySite.x,
          y: rallySite.y,
        },
      );
  }
  // A scout sent out while the army attacks is tracked apart from the army's mission.
  const oldMission = memory.mission?.mode === "explore" ? memory.mission : memory.scoutMission;
  const explorers =
    oldMission?.mode === "explore"
      ? army.filter((u) => oldMission.ids.includes(u.id))
      : [];
  const travelling =
    explorers.length &&
    explorers.every(
      (u) => Math.hypot(u.tile.rx - oldMission.x, u.tile.ry - oldMission.y) > 4,
    ) &&
    api.tick() - oldMission.since < 450;
  // Keep revealing the map while no attack is possible: an enemy building seen once must not end scouting.
  // The objective has never been seen: keep looking for it even while the army can attack.
  const objectiveUnseen = !!memory.objectiveKeys?.words?.length && !memory.objectiveTarget;
  const shouldExplore =
    (!memory.enemyBuildings.size || !readiness.ready || objectiveUnseen) && !travelling && !state.baseUnderAttack;
  const scoutChoice = group(
    "scouting",
    "Choose a frontier to reveal the unknown enemy base. Use one expendable infantry early; do not wait for tanks to scout. If an idle scout is available and the enemy base is unknown, scouting now is useful. An existing travelling scout is handled separately.",
  );
  if (shouldExplore && army.length) {
    const scout =
      army.find((u) => u.id === memory.scoutId) ??
      bestScout ??
      army[0];
    memory.scoutId = scout.id;
    if (!memory.points || api.tick() - (memory.pointsAt ?? -10000) > 120) {
      memory.points = frontierPoints(api, base, memory);
      memory.pointsAt = api.tick();
    }
    const mobilize = readiness.ready && !memory.enemyBuildings.size;
    if (objectiveUnseen) groups.scouting.instructions = `SEARCHING FOR THE OBJECTIVE (${memory.objectiveKeys.words.join(" / ")}): it has not been seen yet; scouting is how to find it. ` + groups.scouting.instructions;
    groups.scouting.criteria.wait =
      memory.enemyBuildings.size
        ? "Wait only if a scout is already moving. The force is not ready to attack, so one expendable unit should keep revealing the map for objectives and enemy positions."
        : "Wait only if a scout is already moving or the enemy base has already been discovered. With idle troops and an unknown enemy base, choose one of the frontiers.";
    for (const p of memory.points.slice(0, 2))
      scoutChoice(
        `explore_${p.x}_${p.y}`,
        `${objectiveUnseen ? "Find the objective: " : ""}${mobilize ? "Advance " + tanks.length + " tanks" : "Scout with one expendable unit"} to known frontier (${p.x},${p.y}), ${p.fog} unexplored adjacent samples. Reveal the enemy base, attack any opposition.`,
        {
          type: "mission",
          mode: "explore",
          label: mobilize ? "装甲推进侦察" : "前沿侦察",
          ids: mobilize ? tanks.map((u) => u.id) : [scout.id],
          x: p.x,
          y: p.y,
          auto: enemies.length === 0 && !memory.enemyBuildings.size ? 3 : undefined,
        },
      );
  }
  specialGroups(api, catalog, snapshot, memory, groups);
  investmentGroups(api, catalog, snapshot, memory, groups);
  if (assessment.level) {
    const note = ` ESCALATION ${assessment.level}: ground assaults are failing (${assessment.reason}). Bring this arm to bear on the same target now instead of leaving it idle.`;
    for (const id of ["aircraft", "navy", "garrison", "engineering", "transport"]) if (groups[id]) groups[id].instructions += note;
  }
  // Money piling up while the model keeps answering "wait": 0.7.2 (Battle Lab mission) was offered a
  // Rhino tank 251 times, credits rose to 14,000 and the army shrank from 19 to 6. Above this much
  // money the first combat unit on offer is trained automatically after two declines.
  if (state.self.credits >= RICH_SPEND && allArmy.length < RICH_ARMY_CAP) for (const id of ["vehicles", "infantry"]) {
    const entry = Object.entries(groups[id]?.actions ?? {}).find(([k, a]) => k !== "wait" && a?.type === "produce" && !catalog[a.name]?.harvester && !catalog[a.name]?.engineer && (catalog[a.name]?.weapon?.damage ?? 0) > 0);
    if (entry && !Number.isFinite(entry[1].auto)) entry[1].auto = 2;
  }
  historyHints(groups, memory, state, assessment);
  return groups;
}

// Mission bookkeeping. The clock of an attack (mission.since, used to detect a stalled assault) only
// restarts when the target changes: re-issuing the same attack every turn used to reset it forever.
export const MISSION_LOCK_TICKS = 450;
const sameTarget = (a, b) => !!a && !!b && (a.targetId !== undefined || b.targetId !== undefined
  ? a.targetId === b.targetId : Math.hypot(a.x - b.x, a.y - b.y) < 5);
export function acceptMission(memory, action, execution, tick) {
  const old = memory.mission, ids = execution?.ids ?? action.ids;
  // A lone scout sent out while the army fights does not replace the army's mission.
  if (action.mode === "explore" && old && old.mode !== "explore" && ids.every((id) => !old.ids?.includes(id))) {
    memory.scoutMission = { ...action, ids, since: tick };
    return memory.mission;
  }
  const keep = old && old.mode === action.mode && sameTarget(old, action);
  // A repeat that only reached new or idle units keeps the units already on the mission.
  const all = keep && action.merge ? [...new Set([...action.merge, ...ids])] : ids;
  const { merge, ...rest } = action;
  memory.mission = { ...rest, ids: all, since: keep ? old.since : tick, issuedAt: tick };
  // Re-issuing the same target never extends the lock.
  if (action.mode === "attack" && !sameTarget(memory.missionLock, action))
    memory.missionLock = { targetId: action.targetId, x: action.x, y: action.y, tick, objective: !!action.objective };
  return memory.mission;
}
// Mission lock: the model used to switch attack targets every ~36 ticks and the whole column turned
// round each time. For a while after an attack is accepted, another attack, engagement or rally is
// refused, unless the target is gone, the base needs defending, or it is the player's objective.
export function missionGate(api, memory, action) {
  const lock = memory.missionLock, tick = api.tick();
  if (action?.type !== "mission" || !lock || tick - lock.tick >= MISSION_LOCK_TICKS) return undefined;
  if (!["attack", "rally"].includes(action.mode) || action.objective || action.clearsObjective || sameTarget(lock, action)) return undefined;
  let hostile = []; try { hostile = api.units("hostile") ?? []; } catch { hostile = []; }
  const alive = lock.targetId === undefined ? true
    : [...api.units("enemy"), ...hostile].some((u) => u.id === lock.targetId) || !api.map.visible(lock.x, lock.y);
  if (!alive) { memory.missionLock = undefined; return undefined; }
  return { accepted: false, reason: "mission_locked", lockedTargetId: lock.targetId, lockAgeTicks: tick - lock.tick };
}

export function executeCandidate(api, action, catalog) {
  if (!action || action.type === "wait")
    return { accepted: false, reason: "wait" };
  if (api.me().defeated || api.me().isObserver)
    return { accepted: false, reason: "not_commandable" };
  if (action.ids) {
    const owned = new Set(api.units("self").map((u) => u.id));
    action = { ...action, ids: action.ids.filter((id) => owned.has(id)) };
    if (!action.ids.length) return { accepted: false, reason: "unit_gone" };
  }
  const special = executeSpecial(api, action);
  if (special) return special;
  if (action.type === "set_deployed") {
    const current = api.units("self");
    const eligible = action.ids.filter((id) => {
      const u = current.find((u) => u.id === id);
      return (
        u?.canDeploy &&
        typeof u.isDeployed === "boolean" &&
        u.isDeployed !== action.deployed
      );
    });
    if (!eligible.length)
      return { accepted: false, reason: "deployment_state_changed" };
    return {
      accepted: api.deploy(eligible),
      ids: eligible,
      deployed: action.deployed,
    };
  }
  if (action.type === "cancel") {
    if (!api.production.queues().find(q => q.type === action.queue)?.items.some(i => i.name === action.name)) return { accepted: false, reason: "queue_changed" };
    api.cancel(action.name);
    return { accepted: true };
  }
  if (action.type === "produce") {
    if (api.production.queues().find((q) => q.type === action.queue)?.size > 0)
      return { accepted: false, reason: "queue_changed" };
    if (
      !api.production
        .available(action.queue)
        .some((u) => u.name === action.name) ||
      api.me().credits < (action.minCredits ?? action.cost)
    )
      return { accepted: false, reason: "production_changed" };
    api.produce(action.name);
    return { accepted: true };
  }
  if (action.type === "mission") {
    if (action.mode === "defend") {
      const own = api.units('self');
      const threats = baseThreats(api, catalog, own.filter(u=>u.type===api.ObjectType.Building), api.units('enemy'));
      threats.sort((a,b)=>Number(b.id===action.targetId)-Number(a.id===action.targetId));
      if (!threats.length) return { accepted: false, reason: 'base_threat_changed' };
      const ids = [], undeployIds = [];
      for (const id of action.ids) {
        const u = own.find(u=>u.id===id);
        const compatible = threats.filter(e=>effectiveness(catalog[u.name],[e],catalog,api)>0);
        const target = compatible.find(e=>canFireAt(api,catalog,u,e)) ?? compatible[0];
        if (!target) continue;
        ids.push(id);
        if (u.isDeployed && !threats.some(e=>canFireAt(api,catalog,u,e))) undeployIds.push(id);
        else api.attack([id],target.id);
      }
      if (undeployIds.length) api.deploy(undeployIds);
      return { accepted: ids.length > 0, ids, undeployIds, reason: ids.length ? undefined : 'no_compatible_defender' };
    }
    if (action.mode !== "retreat") {
      const own = api.units("self"),
        enemies = api.units("enemy");
      action = {
        ...action,
        ids: action.ids.filter((id) => {
          const u = own.find((u) => u.id === id);
          return !u?.isDeployed || !enemies.some((e) => api.inRange(id, e.id, "current"));
        }),
      };
      if (!action.ids.length)
        return { accepted: false, reason: "deployed_holding" };
    }
    // The objective may be a neutral building (a campaign landmark): attack-move ignores those.
    const hostileHas = (id) => { try { return (api.units("hostile") ?? []).some((u) => u.id === id); } catch { return false; } };
    if (
      action.targetId &&
      (api.units("enemy").some((u) => u.id === action.targetId) || action.objective && hostileHas(action.targetId))
    )
      api.attack(action.ids, action.targetId);
    else
      api[action.mode === "retreat" ? "move" : "attackMove"](
        action.ids,
        action.x,
        action.y,
      );
    return { accepted: true, ids: action.ids };
  }
  if (action.type === "deploy") return { accepted: api.deploy(action.ids) };
  if (action.type === "attack") {
    if (!api.units("enemy").some((u) => u.id === action.targetId))
      return { accepted: false, reason: "enemy_no_longer_visible" };
    api.attack(action.ids, action.targetId);
    return { accepted: true };
  }
  if (["move", "scout", "attackMove"].includes(action.type)) {
    if (!api.map.tile(action.x, action.y))
      return { accepted: false, reason: "destination_no_longer_visible" };
    api[action.type === "attackMove" ? "attackMove" : "move"](
      action.ids,
      action.x,
      action.y,
    );
    return { accepted: true };
  }
  return { accepted: false, reason: "unknown_action" };
}

function placeReadyBuilding(api, catalog, memory, emit) {
  if (api.tick() - memory.lastPlaceTick < 20) return;
  const queue = api.production
    .queues()
    .find(
      (q) =>
        [api.QueueType.Structures, api.QueueType.Armory].includes(q.type) &&
        q.status === 3 &&
        q.items.length,
    );
  if (!queue) return;
  const name = queue.items[0].name;
  const planned = memory.plannedSites?.get(name);
  if (planned && api.canPlace(name, planned.x, planned.y)) {
    api.place(name, planned.x, planned.y);
    memory.plannedSites.delete(name);
    memory.lastPlaceTick = api.tick();
    memory.lastPlaced = { ...planned, tick: api.tick() };
    emit({ kind: "place", tick: api.tick(), name, ...planned });
    return;
  }
  const site = chooseBuildingSite(api, catalog, name, api.units("self"), memory, 500);
  if (site) {
    api.place(name, site.x, site.y);
    memory.lastPlaceTick = api.tick();
    memory.lastPlaced = { ...site, tick: api.tick() };
    emit({ kind: "place", tick: api.tick(), name, ...site, purpose: catalog[name]?.isBaseDefense ? "counter_fire" : "base_development" });
  }
}

// Search and ranking are player strategy. The engine only observes tiles and orders a target.
export function findVisibleOre(api, origin) {
  const { width, height } = api.map.size();
  for (let radius = 0; radius < Math.max(width, height); radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (const dy of radius ? [-radius, radius] : [0]) {
        const tile = api.map.tile(origin.rx + dx, origin.ry + dy);
        if (tile?.landType === (api.LandType?.Tiberium ?? 9)) return tile;
      }
    }
    for (let dy = -radius + 1; dy < radius; dy++) {
      for (const dx of [-radius, radius]) {
        const tile = api.map.tile(origin.rx + dx, origin.ry + dy);
        if (tile?.landType === (api.LandType?.Tiberium ?? 9)) return tile;
      }
    }
  }
  return undefined;
}

// Units shot from beyond their own reach used to stand and take it (a conscript, range 4, next to a
// pillbox, range 5.5, kept firing at something else). Each one now either closes in on the shooter,
// with nearby comrades, when it can hurt it, or steps out of its range when it cannot.
export const THREAT_REPLY_TICKS = 60, THREAT_SQUAD_RADIUS = 6, THREAT_UNITS_PER_PASS = 32, THREAT_CANDIDATES = 6,
  THREAT_REPORT_TICKS = 150, FALL_BACK_TICKS = 450, DEFENSE_RUSH_SQUAD = 8, SIEGE_WANTED_TICKS = 1800;
export function respondToThreats(api, catalog, memory, emit, mobile, enemies, skip = new Set()) {
  const tick = api.tick(), Air = api.ZoneType?.Air ?? 1;
  memory.threatReplies ??= new Map(); memory.lastHealth ??= new Map(); memory.orders ??= new Map(); memory.fallBack ??= new Map();
  const hurts = (a, t) => activeWeapons(a, catalog).some((w) => weaponEffectiveness(w, [t], catalog, api) > 0);
  const cooling = (u) => tick - (memory.threatReplies.get(u.id) ?? -Infinity) < THREAT_REPLY_TICKS;
  // Per enemy, once: its ground reach. Anything farther than that (+2 tiles) from a unit is skipped
  // by plain distance before any weapon or range query (this runs every 150 ms).
  const ground = [];
  for (const e of enemies) {
    if (e.zone === Air) continue;
    const reach = Math.max(0, ...activeWeapons(e, catalog).filter((w) => (w.damage ?? 0) > 0 && w.ag !== false).map((w) => w.range ?? 0));
    if (reach > 0) ground.push({ e, reach });
  }
  const ownReach = (u) => Math.max(0, ...activeWeapons(u, catalog).filter((w) => (w.damage ?? 0) > 0).map((w) => w.range ?? 0));
  const handled = new Set(), replies = [];
  const order = mobile.length ? (memory.threatCursor ?? 0) % mobile.length : 0;
  let examined = 0;
  for (let i = 0; i < mobile.length; i++) {
    const u = mobile[(order + i) % mobile.length];
    const before = memory.lastHealth.get(u.id);
    memory.lastHealth.set(u.id, u.hitPoints ?? 0);
    if (handled.has(u.id) || skip.has(u.id) || u.isDeployed || u.zone === Air || cooling(u) || examined >= THREAT_UNITS_PER_PASS) continue;
    const near = ground.map((g) => ({ ...g, d: distance(g.e.tile, u.tile) })).filter((g) => g.d <= g.reach + 2);
    if (!near.length) continue;
    examined++;
    memory.threatCursor = (order + i + 1) % mobile.length;
    const closest = near.sort((a, b) => a.d - b.d).slice(0, THREAT_CANDIDATES);
    const reachU = ownReach(u);
    const outranged = closest.filter((g) => g.d > reachU && hurts(g.e, u) && canFireAt(api, catalog, g.e, u) && !canFireAt(api, catalog, u, g.e));
    // Losing health with nothing in our own range: whoever could reach us is the likely shooter.
    const hurt = !outranged.length && before !== undefined && (u.hitPoints ?? 0) < before &&
      !closest.some((g) => g.d <= reachU + 1 && canFireAt(api, catalog, u, g.e));
    const shooter = (outranged.length ? outranged : hurt ? closest.filter((g) => g.d <= g.reach + 1.5 && hurts(g.e, u)) : [])[0];
    if (!shooter) continue;
    const e = shooter.e;
    const squad = hurts(u, e) ? [u, ...mobile.filter((o) => o !== u && !handled.has(o.id) && !skip.has(o.id) && !o.isDeployed && !cooling(o) &&
      distance(o.tile, u.tile) <= THREAT_SQUAD_RADIUS && distance(o.tile, e.tile) > ownReach(o) && hurts(o, e))] : [];
    // A few soldiers charging a pillbox that outranges them only feed it (0.6.0 match). A fixed
    // defense is rushed only by a crowd; otherwise step out of reach and ask for a siege from cover.
    const fixedDefense = e.type === api.ObjectType.Building;
    if (fixedDefense && squad.length) (memory.siegeWanted ??= new Map()).set(e.id, tick);
    // Commander mode: the part of a squad left outside while its comrades enter a house to take this
    // defense from cover never rushes it, whatever its size; it only steps out of reach.
    const noRush = (o) => fixedDefense && !!memory.noRush?.has(o.id);
    if (noRush(u)) squad.length = 0;
    else if (fixedDefense) for (let k = squad.length - 1; k > 0; k--) if (noRush(squad[k])) squad.splice(k, 1);
    if (squad.length && (!fixedDefense || squad.length >= DEFENSE_RUSH_SQUAD)) {
      const ids = squad.map((o) => o.id);
      api.attack(ids, e.id);
      for (const id of ids) { handled.add(id); memory.threatReplies.set(id, tick); memory.orders.set(id, { tick, targetId: e.id, threatReply: true }); }
      replies.push({ ids, targetId: e.id, name: catalog[e.name]?.label ?? e.name, reply: "close_in" });
    } else {
      const dx = u.tile.rx - e.tile.rx, dy = u.tile.ry - e.tile.ry, len = Math.hypot(dx, dy) || 1;
      const size = api.map.size?.() ?? { width: Infinity, height: Infinity }, back = shooter.reach + 3;
      const x = Math.round(Math.max(0, Math.min(size.width - 1, e.tile.rx + dx / len * back)));
      const y = Math.round(Math.max(0, Math.min(size.height - 1, e.tile.ry + dy / len * back)));
      api.move([u.id], x, y);
      handled.add(u.id); memory.threatReplies.set(u.id, tick); memory.orders.set(u.id, { tick, threatReply: true });
      // The mission loop must not walk it straight back into the same fire for a while.
      memory.fallBack.set(u.id, { tick, x: e.tile.rx, y: e.tile.ry, reach: shooter.reach });
      replies.push({ ids: [u.id], targetId: e.id, name: catalog[e.name]?.label ?? e.name, reply: "fall_back", target: { x, y } });
    }
  }
  // One report per pass at most, and not more than once every THREAT_REPORT_TICKS, so the battle log
  // keeps its other entries.
  if (replies.length && tick - (memory.lastThreatReport ?? -Infinity) >= THREAT_REPORT_TICKS) {
    memory.lastThreatReport = tick;
    const text = (r) => r.reply === "close_in" ? `${r.ids.length} 个单位抵近还击 ${r.name} #${r.targetId}` : `#${r.ids[0]} 避开 ${r.name} #${r.targetId}，后撤到 (${r.target.x},${r.target.y})`;
    emit({ kind: "micro", tick, description: `射程外受击：${replies.slice(0, 3).map(text).join("；")}${replies.length > 3 ? `；另 ${replies.length - 3} 起` : ""}`,
      replies: replies.length, ids: replies.flatMap((r) => r.ids), reply: replies[0].reply, targetId: replies[0].targetId });
  }
  const living = new Set(mobile.map((u) => u.id));
  for (const id of memory.lastHealth.keys()) if (!living.has(id)) memory.lastHealth.delete(id);
  for (const [id, t] of memory.threatReplies) if (!living.has(id) || tick - t > THREAT_REPLY_TICKS * 10) memory.threatReplies.delete(id);
  for (const [id, f] of memory.fallBack) if (!living.has(id) || tick - f.tick > FALL_BACK_TICKS) memory.fallBack.delete(id);
  for (const [id, t] of memory.siegeWanted ?? []) if (tick - t > SIEGE_WANTED_TICKS) memory.siegeWanted.delete(id);
  return handled;
}

export function maintainBattle(api, catalog, memory, emit) {
  maintainSpecial(api, memory, emit, catalog);
  const tick = api.tick(),
    own = api.units("self"),
    enemies = api.units("enemy");
  const mobile = own.filter(
    (u) =>
      u.type !== api.ObjectType.Building &&
      !catalog[u.name]?.harvester &&
      !catalog[u.name]?.engineer && !catalog[u.name]?.naval && !catalog[u.name]?.aircraft &&
      api.tick() - (memory.specialOrders?.get(u.id)?.tick ?? -10000) > 450 &&
      u.primaryWeapon,
  );
  // Ships defend themselves like ground units: any enemy in range is engaged, even during a
  // model-issued strike or scouting order. They never join land missions or corridor clearing.
  const naval = own.filter(
    (u) => u.type !== api.ObjectType.Building && catalog[u.name]?.naval && !catalog[u.name]?.harvester && u.primaryWeapon,
  );
  const living = new Set(own.map((u) => u.id));
  const mission = memory.mission;
  const defending = mission?.mode === 'defend';
  const defenseThreats = defending ? baseThreats(api, catalog, own.filter(u=>u.type===api.ObjectType.Building), enemies) : [];
  memory.deploymentStates ??= new Map();
  for (const u of mobile)
    if (typeof u.isDeployed === "boolean") {
      const before = memory.deploymentStates.get(u.id);
      if (before !== undefined && before !== u.isDeployed)
        emit({
          kind: "observed",
          tick,
          description: `${u.name} #${u.id} ${u.isDeployed ? "已展开" : "已收起"}`,
          id: u.id,
          isDeployed: u.isDeployed,
        });
      memory.deploymentStates.set(u.id, u.isDeployed);
    }
  for (const id of memory.deploymentStates.keys())
    if (!living.has(id)) memory.deploymentStates.delete(id);
  memory.observedSpecial ??= new Map();
  for (const unit of own) {
    const observed = { deployed: unit.isDeployed, ammo: unit.ammo,
      passengers: unit.transport?.unitIds, garrison: unit.garrison?.unitIds };
    const previous = memory.observedSpecial.get(unit.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(observed))
      emit({ kind: "observed", tick, id: unit.id, description: `${unit.name} #${unit.id} 载员 / 驻扎 / 弹药 / 姿态变化`, before: previous, after: observed });
    memory.observedSpecial.set(unit.id, observed);
  }
  if (tick - memory.lastMaintenance >= 60) {
    memory.lastMaintenance = tick;
    const buildings=own.filter(u=>u.type===api.ObjectType.Building);
    const base=buildings.find(u=>catalog[u.name]?.yard)??buildings[0];
    const exits=buildings.filter(b=>catalog[b.name]?.refinery||catalog[b.name]?.factory==='UnitType');
    const clearing=mobile.filter(u=>u.type===api.ObjectType.Vehicle&&!catalog[u.name]?.naval&&u.isIdle&&!u.isDeployed&&
      !(defending && defenseThreats.length && mission.ids.includes(u.id))&&
      !enemies.some(e=>distance(e.tile,u.tile)<10)&&exits.some(b=>distance(u.tile,b.tile)<6)&&
      tick-(memory.orders.get(u.id)?.tick??-10000)>150);
    if(clearing.length) {
      const site=stableRallySite(api,catalog,own,base,memory);
      if(site) {
        api.move(clearing.map(u=>u.id),site.x,site.y);
        for(const u of clearing)memory.orders.set(u.id,{tick});
        emit({kind:'micro',tick,description:`让 ${clearing.length} 辆闲置战车离开矿场 / 工厂通道`,ids:clearing.map(u=>u.id),target:{x:site.x,y:site.y}});
      }
    }
    const idleMiners = own.filter(
      (u) => catalog[u.name]?.harvester && u.isIdle,
    );
    for (const miner of idleMiners) {
      const ore = findVisibleOre(api, miner.tile);
      if (!ore) continue;
      api.gather([miner.id], ore.rx, ore.ry);
      emit({ kind: "micro", tick, description: `恢复矿车 #${miner.id} 采矿`,
        target: { x: ore.rx, y: ore.ry } });
    }
    for (const building of own.filter(
      (u) => u.type === api.ObjectType.Building,
    )) {
      if (building.hitPoints >= building.maxHitPoints)
        memory.repairing.delete(building.id);
      if (
        building.hitPoints / building.maxHitPoints < 0.8 &&
        !memory.repairing.has(building.id) &&
        api.me().credits > 200
      ) {
        api.repair(building.id);
        memory.repairing.add(building.id);
        emit({ kind: "micro", tick, description: `维修 ${building.name}` });
      }
    }
  }
  // Defenders have their own targeting; a unit falling back to regroup is not turned round.
  // Commander mode: squads told to retreat or defend the base are not turned round by the instinct layer.
  respondToThreats(api, catalog, memory, emit, mobile, enemies, new Set([...(defending || mission?.mode === 'retreat' ? mission.ids : []), ...(memory.instinctSkip ?? [])]));
  // Mechanics: focus on a reachable in-range enemy, without replacing the model's macro mission.
  // Never on a building the objective says to capture or protect: a column parked beside the Battle
  // Lab would otherwise shoot the very building its engineer is walking into.
  const spared = new Set(enemies.filter((e) => e.type === api.ObjectType.Building && (e.id === memory.objectiveTarget?.id && memory.objectiveTarget?.mode === "capture" || isGuardedByObjective(memory.objective, catalog[e.name], e.name))).map((e) => e.id));
  let issued = 0;
  for (const u of [...mobile, ...naval]) {
    if (tick - (memory.postureOrders?.get(u.id) ?? -1000) < 20) continue;
    // Commander mode: a squad on the way under "move" or "retreat" does not stop to trade shots.
    if (memory.focusSkip?.has(u.id)) continue;
    const last = memory.orders.get(u.id);
    if (last && tick - last.tick < 18) continue;
    if (defending && mission.ids.includes(u.id)) {
      const targets = defenseThreats.filter(e=>effectiveness(catalog[u.name],[e],catalog,api)>0)
        .sort((a,b)=>Number(b.id===mission.targetId)-Number(a.id===mission.targetId) ||
          (combatWeapon(b,catalog).range??0)-(combatWeapon(a,catalog).range??0));
      const target = targets.find(e=>canFireAt(api,catalog,u,e)) ?? targets[0];
      if (target) {
        if (u.isDeployed && !canFireAt(api,catalog,u,target)) {
          if (tick-(memory.postureOrders?.get(u.id)??-1000)>150) {
            api.deploy([u.id]);
            memory.postureOrders ??= new Map();
            memory.postureOrders.set(u.id,tick);
            emit({kind:'micro',tick,description:`收起 #${u.id} 以接敌，目标 #${target.id}`,ids:[u.id],targetId:target.id});
          }
        } else if (last?.defenseTargetId!==target.id || u.isIdle || tick-last.tick>150) {
          api.attack([u.id],target.id);
          memory.orders.set(u.id,{tick,targetId:target.id,defenseTargetId:target.id});
          emit({kind:'micro',tick,description:`基地接敌 #${u.id} → #${target.id}`,ids:[u.id],targetId:target.id,inRange:canFireAt(api,catalog,u,target)});
        }
      } else if (last?.defenseTargetId) {
        const base=own.find(b=>catalog[b.name]?.yard)??own.find(b=>b.type===api.ObjectType.Building);
        const site=stableRallySite(api,catalog,own,base,memory);
        if(site)api.move([u.id],site.x,site.y);
        memory.orders.set(u.id,{tick});
      }
      continue;
    }
    const current = enemies.find((e) => e.id === last?.targetId);
    const canHit = (e) => e.zone !== 1 || activeWeapons(u, catalog).some(w=>w.aa);
    const options = enemies.filter(
      (e) =>
        canHit(e) && canFireAt(api, catalog, u, e) && !spared.has(e.id),
    );
    options.sort((a,b) => combatTargetScore(api,catalog,u,b,mission?.targetId) -
      combatTargetScore(api,catalog,u,a,mission?.targetId));
    if (current && options[0]?.id === current.id && !u.isIdle) continue;
    if (options.length) {
      api.attack([u.id], options[0].id);
      memory.orders.set(u.id, { targetId: options[0].id, tick });
      issued++;
    } else if (catalog[u.name]?.naval && u.isIdle && (!last || tick - last.tick > 90)) {
      // Idle ships close on nearby enemies they can hurt instead of waiting to be shot at.
      const near = enemies.filter(e => canHit(e) && !spared.has(e.id) && distance(e.tile, u.tile) <= 12 && effectiveness(catalog[u.name], [e], catalog, api) > 0)
        .sort((a, b) => distance(a.tile, u.tile) - distance(b.tile, u.tile))[0];
      if (near) { api.attack([u.id], near.id); memory.orders.set(u.id, { targetId: near.id, tick }); issued++; }
    } else if (
      !u.isDeployed &&
      mission?.ids.includes(u.id) &&
      u.isIdle &&
      (!last || tick - last.tick > 90)
    ) {
      // A unit that just fell back from a shooter it cannot hurt is not sent back into its range.
      const fled = memory.fallBack?.get(u.id);
      if (fled && tick - fled.tick < FALL_BACK_TICKS) continue;
      if (Math.hypot(u.tile.rx - mission.x, u.tile.ry - mission.y) > 3) {
        const target = mission.mode === 'attack' && (enemies.find(e=>e.id===mission.targetId) ??
          (mission.objective ? (api.units('hostile') ?? []).find(e=>e.id===mission.targetId) : undefined));
        if (target && effectiveness(catalog[u.name],[target],catalog,api)>0) {
          api.attack([u.id],target.id);
          memory.orders.set(u.id,{tick,targetId:target.id});
        } else {
          api[mission.mode === "retreat" ? "move" : "attackMove"]([u.id],mission.x,mission.y);
          memory.orders.set(u.id,{tick});
        }
        issued++;
      }
    }
  }
  for (const id of memory.orders.keys())
    if (!living.has(id)) memory.orders.delete(id);
  if (issued && tick - memory.lastMicroReport > 60) {
    memory.lastMicroReport = tick;
    emit({
      kind: "micro",
      tick,
      description: `集火 / 补发 ${issued} 条单位指令`,
    });
  }
}

// ---- Commander mode (docs/commander-design.md) ----
// The model gives each squad an intent; between its turns the intents are kept up here without asking
// it again: only new or idle members get orders, so units already fighting are not pulled away.
// Timing: a turn every COMMAND_INTERVAL_TICKS (about 12 game seconds), sooner when something happens.
export const COMMAND_INTERVAL_TICKS = 180, AUTO_DEFENSE_TICKS = 450, INTENT_REFRESH_TICKS = 45, ARRIVED = 3, GARRISON_RETRY_TICKS = 450, GARRISON_TRIES = 3;
// URGENT_MIN_TICKS: an urgent turn (other than a fresh attack on the base) still waits this long after
// the last one: a target dying every 45 ticks used to cause 20 requests a game minute.
// ATTACK_GRACE_TICKS: a raider stepping in and out of the base area is one attack, not many.
// STALE_COMMAND_TICKS: a reply to a situation older than this moves no squads (production still runs).
// HOLD_DRIFT: a holding unit pulled further than this from its point walks back once idle.
// AUTO_LOCK_TICKS: the automatic defense keeps its squad from the model at most this long.
// A reply counts as stale only when it is both STALE_COMMAND_TICKS and STALE_COMMAND_MS old: a sped-up
// game runs many ticks per second, and a normal 40 s reply must not be discarded there.
export const URGENT_MIN_TICKS = 90, ATTACK_GRACE_TICKS = 300, STALE_COMMAND_TICKS = 900, STALE_COMMAND_MS = 60000, AUTO_LOCK_TICKS = 600, HOLD_DRIFT = 4, PLAN_REPORT_CHARS = 8000;
// Units threatening the base. An enemy defense building standing near it is not an attack that ends:
// it is listed among the enemy buildings for the model, and defenders only step out of its reach.
const baseRaiders = (api, catalog, buildings, enemies) => baseThreats(api, catalog, buildings, enemies).filter((e) => e.type !== api.ObjectType.Building);
const cut = (v, n = 40) => (typeof v === "string" ? v.slice(0, n) : v);
const centerOf = (members) => ({ rx: members.reduce((n, u) => n + u.tile.rx, 0) / members.length, ry: members.reduce((n, u) => n + u.tile.ry, 0) / members.length });
const newIntent = (o, tick, extra = {}) => ({ action: o.action, target: o.target, x: o.x, y: o.y, reason: o.reason ?? "", since: tick, members: new Set(), arrived: new Set(), ...extra });
const ledgerTotals = (memory) => { const l = memory.ledger; return { lost: (l?.ownUnitsLost ?? 0) + (l?.ownBuildingsLost ?? 0), killed: (l?.enemyUnitsDestroyed ?? 0) + (l?.enemyBuildingsDestroyed ?? 0) }; };
const visibleTarget = (api, id) => { let all = []; try { all = [...api.units("enemy"), ...(api.units("hostile") ?? [])]; } catch { all = api.units("enemy"); } return all.find((u) => u.id === id); };

// Squads are re-formed on every pass (ids stay stable by shared members). A part split off a squad
// with an intent carries that intent on; intents of squads that no longer exist are dropped.
export function refreshSquads(api, catalog, memory) {
  const before = new Map(memory.squads ?? []), intents = memory.intents ??= new Map();
  const squads = formSquads(squadUnits(api.units("self"), catalog, api), memory);
  for (const q of squads) {
    if (intents.has(q.id)) continue;
    const counts = new Map();
    for (const u of q.members) for (const [sid, ids] of before) if (intents.has(sid) && ids.includes(u.id)) counts.set(sid, (counts.get(sid) ?? 0) + 1);
    const [from, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
    if (from && n * 2 >= q.members.length) { const { members, arrived, ...rest } = intents.get(from); intents.set(q.id, { ...rest, members: new Set(members), arrived: new Set(arrived), splitFrom: from }); }
  }
  const live = new Set(squads.map((q) => q.id));
  for (const sid of intents.keys()) if (!live.has(sid)) intents.delete(sid);
  return squads;
}

// One pass of one intent. `first` is the turn the model gave it: then every free member is ordered;
// afterwards only members that are new to it or idle.
export function orderSquad(api, catalog, memory, squad, intent, first = false) {
  const tick = api.tick(), cmd = memory.command ??= {};
  memory.orders ??= new Map(); memory.specialOrders ??= new Map();
  const special = (u) => tick - (memory.specialOrders.get(u.id)?.tick ?? -10000) <= 450;
  const fled = (u) => tick - (memory.fallBack?.get(u.id)?.tick ?? -Infinity) < FALL_BACK_TICKS;
  const free = squad.members.filter((u) => !special(u));
  const fresh = free.filter((u) => first || !intent.members.has(u.id) || u.isIdle);
  const far = (u, x, y, r = ARRIVED) => Math.hypot(u.tile.rx - x, u.tile.ry - y) > r;
  const ids = (list) => list.map((u) => u.id);
  const mark = (list, extra = {}) => { for (const u of list) { intent.members.add(u.id); memory.orders.set(u.id, { tick, intent: intent.action, ...extra }); } };
  const done = (accepted, reason, extra = {}) => ({ accepted, ...(reason ? { reason } : {}), ...extra });
  if (!free.length) return done(false, "squad_busy");
  switch (intent.action) {
    case "attack": {
      const target = visibleTarget(api, intent.target);
      if (target) {
        intent.lastSeen = { x: target.tile.rx, y: target.tile.ry };
        const list = fresh.filter((u) => !fled(u) || first);
        const able = list.filter((u) => effectiveness(catalog[u.name], [target], catalog, api) > 0), escort = list.filter((u) => !able.includes(u));
        if (able.length) api.attack(ids(able), target.id);
        // Units that cannot hurt it (anti-air, for example) come along instead of standing idle.
        if (escort.length) api.attackMove(ids(escort), target.tile.rx, target.tile.ry);
        mark(list, { targetId: target.id });
        return done(true, "", { units: list.length });
      }
      const known = memory.enemyBuildings?.get(intent.target) ?? intent.lastSeen;
      if (!known || api.map.visible(known.x, known.y)) {
        // Its position is in sight and it is not there: destroyed (or gone). The model is asked again.
        if (!intent.targetGone) { intent.targetGone = tick; cmd.urgent ??= "target_destroyed"; }
        return done(false, "target_destroyed");
      }
      const list = fresh.filter((u) => (!fled(u) || first) && far(u, known.x, known.y));
      if (list.length) api.attackMove(ids(list), known.x, known.y);
      mark(list);
      return done(true, "", { units: list.length, remembered: true });
    }
    case "attack_move": case "move": {
      const list = fresh.filter((u) => (!fled(u) || first) && far(u, intent.x, intent.y));
      if (list.length) api[intent.action === "move" ? "move" : "attackMove"](ids(list), intent.x, intent.y);
      mark(list);
      return done(true, "", { units: list.length });
    }
    case "hold": {
      // Walk to the point; once there, no more orders: they hold and fight whatever comes.
      for (const u of free) if (!far(u, intent.x, intent.y)) intent.arrived.add(u.id);
      // Arrived units get no more orders, unless they were drawn away (chasing, pushed) and stand idle.
      const list = fresh.filter((u) => (!intent.arrived.has(u.id) || u.isIdle && far(u, intent.x, intent.y, HOLD_DRIFT)) && far(u, intent.x, intent.y) && (!fled(u) || first));
      if (list.length) api.move(ids(list), intent.x, intent.y);
      mark(list);
      return done(true, "", { units: list.length });
    }
    case "retreat": {
      const own = api.units("self"), buildings = own.filter((u) => u.type === api.ObjectType.Building);
      const site = stableRallySite(api, catalog, own, buildings.find((u) => catalog[u.name]?.yard) ?? buildings[0], memory);
      if (!site) return done(false, "no_rally_point");
      const list = fresh.filter((u) => far(u, site.x, site.y, 4));
      if (list.length) api.move(ids(list), site.x, site.y);
      mark(list);
      return done(true, "", { units: list.length, x: site.x, y: site.y });
    }
    case "scout": {
      let scout = free.find((u) => u.id === intent.scoutId);
      if (!scout) { scout = [...free].sort((a, b) => (catalog[b.name]?.speed ?? 0) - (catalog[a.name]?.speed ?? 0))[0]; intent.scoutId = scout.id; }
      if ((first || scout.isIdle || !intent.members.has(scout.id)) && far(scout, intent.x, intent.y)) { api.move([scout.id], intent.x, intent.y); mark([scout]); }
      return done(true, "", { units: 1, scoutId: scout.id });
    }
    case "defend_base": {
      const own = api.units("self"), buildings = own.filter((u) => u.type === api.ObjectType.Building);
      const threats = baseRaiders(api, catalog, buildings, api.units("enemy"));
      if (threats.length) {
        // Each defender takes a raider it can hurt, one in range first, else the closest.
        const sent = [];
        for (const u of fresh) {
          const able = threats.filter((e) => effectiveness(catalog[u.name], [e], catalog, api) > 0).sort((a, b) => distance(a.tile, u.tile) - distance(b.tile, u.tile));
          const target = able.find((e) => canFireAt(api, catalog, u, e)) ?? able[0];
          if (!target) continue;
          api.attack([u.id], target.id); sent.push(u);
        }
        mark(sent, { defense: true });
        return done(sent.length > 0 || !fresh.length, sent.length || !fresh.length ? "" : "no_compatible_defender", { units: sent.length });
      }
      const site = stableRallySite(api, catalog, own, buildings.find((u) => catalog[u.name]?.yard) ?? buildings[0], memory);
      const list = site ? fresh.filter((u) => far(u, site.x, site.y, 5)) : [];
      if (list.length) api.move(ids(list), site.x, site.y);
      mark(list);
      return done(true, "", { units: list.length, idle: true });
    }
    case "garrison": return garrisonSquad(api, catalog, memory, squad, intent, free, first);
  }
  return done(false, "unknown_action");
}

// Infantry that can enter, closest to the house first, no more than it has room for. The rest of the
// squad stays where it is: it must not charge the defense the house is meant to take.
function garrisonSquad(api, catalog, memory, squad, intent, free, first) {
  const tick = api.tick(), house = api.unit?.(intent.target);
  if (!house?.garrison?.canOccupy) return { accepted: false, reason: "house_gone" };
  const pending = (memory.specialTasks ?? []).filter((t) => t.action?.kind === "garrison" && t.action.targetId === house.id).reduce((n, t) => n + t.action.ids.filter((id) => !house.garrison.unitIds?.includes(id)).length, 0);
  const room = house.garrison.capacity - house.garrison.count - pending;
  const retry = first || (!pending && (intent.tries ?? 0) < GARRISON_TRIES && tick - (intent.triedAt ?? -Infinity) >= GARRISON_RETRY_TICKS);
  const crew = room > 0 && retry ? free.filter((u) => u.type === api.ObjectType.Infantry && catalog[u.name]?.occupier)
    .sort((a, b) => distance(a.tile, house.tile) - distance(b.tile, house.tile)).slice(0, room) : [];
  if (first && api.OrderType?.Stop !== undefined) {
    const stay = free.filter((u) => !crew.includes(u));
    if (stay.length) api.order(stay.map((u) => u.id), { type: api.OrderType.Stop });
  }
  if (room <= 0) return pending ? { accepted: true, units: 0, entering: true } : { accepted: false, reason: "house_full" };
  if (!retry) return { accepted: pending > 0, units: 0 };
  if (!crew.length) return { accepted: false, reason: "no_infantry_can_garrison" };
  // Next to an enemy defense it is a siege: the crew leaves once that defense is gone.
  const defense = api.units("enemy").filter((e) => e.type === api.ObjectType.Building && activeWeapons(e, catalog).some((w) => (w.damage ?? 0) > 0 && w.ag !== false) && distance(e.tile, house.tile) <= SIEGE_RANGE)
    .sort((a, b) => distance(a.tile, house.tile) - distance(b.tile, house.tile))[0];
  const action = { type: "special", kind: "garrison", ids: crew.map((u) => u.id), targetId: house.id, order: { type: api.OrderType.Occupy, target: { objectId: house.id } },
    purpose: defense ? "siege" : "forward", ...(defense ? { defenseId: defense.id } : {}) };
  intent.tries = (intent.tries ?? 0) + 1; intent.triedAt = tick;
  const execution = executeSpecial(api, action);
  if (!execution?.accepted) return { accepted: false, reason: execution?.reason ?? "garrison_rejected" };
  rememberSpecial(memory, action, execution, tick);
  for (const id of action.ids) { memory.specialOrders.set(id, { tick, kind: "garrison" }); intent.members.add(id); }
  return { accepted: true, units: crew.length, purpose: action.purpose };
}

// Which production queue offers this item.
function queueOffering(api, name) {
  for (const q of Object.values(api.QueueType ?? {}).filter(Number.isInteger)) {
    let offers = []; try { offers = api.production.available(q) ?? []; } catch { offers = []; }
    if (offers.some((i) => i.name === name)) return q;
  }
  return undefined;
}
export function executeProduction(api, catalog, memory, order) {
  const queueType = queueOffering(api, order.item), r = catalog[order.item] ?? {}, cost = r.cost ?? 0, credits = api.me().credits ?? 0;
  if (queueType === undefined) return { accepted: false, reason: "not_producible" };
  const queue = api.production.queues().find((q) => q.type === queueType);
  const structure = [api.QueueType.Structures, api.QueueType.Armory].includes(queueType);
  if (structure) {
    if (queue?.size > 0) return { accepted: false, reason: "queue_busy" };
    if (credits < cost) return { accepted: false, reason: "insufficient_credits" };
    // Where it goes is decided here, as for every other building; placement happens when it is ready.
    const site = api.canPlace ? chooseBuildingSite(api, catalog, order.item, api.units("self"), memory, 500) : undefined;
    if (api.canPlace && !site) return { accepted: false, reason: "no_building_site" };
    api.produce(order.item);
    if (site) (memory.plannedSites ??= new Map()).set(order.item, site);
    memory.spentCredits = (memory.spentCredits ?? 0) + cost;
    return { accepted: true, count: 1, ...(site ? { x: site.x, y: site.y } : {}) };
  }
  if (queue && Number.isFinite(queue.maxSize) && queue.size >= queue.maxSize) return { accepted: false, reason: "queue_full" };
  const affordable = cost > 0 ? Math.min(order.count ?? 1, Math.floor(credits / cost)) : order.count ?? 1;
  if (affordable < 1) return { accepted: false, reason: "insufficient_credits" };
  const count = Number.isFinite(queue?.maxSize) ? Math.min(affordable, queue.maxSize - queue.size) : affordable;
  api.produce(order.item, count);
  memory.spentCredits = (memory.spentCredits ?? 0) + cost * count;
  return { accepted: true, count, ...(count < (order.count ?? 1) ? { reason: count < affordable ? "queue_limited" : "credits_limited" } : {}) };
}

export function executeEngineer(api, catalog, memory, order) {
  const tick = api.tick(), target = api.unit?.(order.target);
  if (!target) return { accepted: false, reason: "target_no_longer_visible" };
  memory.specialOrders ??= new Map();
  const engineer = api.units("self").filter((u) => catalog[u.name]?.engineer && u.isIdle && tick - (memory.specialOrders.get(u.id)?.tick ?? -10000) > 450)
    .sort((a, b) => distance(a.tile, target.tile) - distance(b.tile, target.tile))[0];
  if (!engineer) return { accepted: false, reason: "no_idle_engineer" };
  const capture = order.action === "capture";
  const action = { type: "special", kind: capture ? "capture" : "repair_bridge", ids: [engineer.id], targetId: target.id, order: { type: capture ? api.OrderType.Capture : api.OrderType.Repair, target: { objectId: target.id } } };
  const execution = executeSpecial(api, action);
  if (!execution?.accepted) return { accepted: false, reason: execution?.reason ?? "rejected" };
  rememberSpecial(memory, action, execution, tick);
  memory.specialOrders.set(engineer.id, { tick, kind: action.kind });
  (memory.specialTargets ??= new Map()).set(`repair_${target.id}`, tick);
  return { accepted: true, engineer: engineer.id };
}

// Which units the instinct layer leaves alone this pass (see maintainBattle).
function instinctSets(memory, squads) {
  const skip = new Set(), focus = new Set(), noRush = new Set();
  for (const q of squads) {
    const intent = memory.intents.get(q.id);
    if (!intent) continue;
    // Defenders and the part of a garrison squad left outside never rush a fixed defense; they step back.
    if (["garrison", "defend_base"].includes(intent.action)) for (const u of q.members) noRush.add(u.id);
    if (intent.action === "retreat") for (const u of q.members) skip.add(u.id);
    if (["retreat", "move"].includes(intent.action) || intent.action === "scout")
      for (const u of q.members) if ((intent.action !== "scout" || u.id === intent.scoutId) && (intent.x === undefined || Math.hypot(u.tile.rx - intent.x, u.tile.ry - intent.y) > ARRIVED)) focus.add(u.id);
  }
  memory.instinctSkip = skip; memory.focusSkip = focus; memory.noRush = noRush;
}

// Between model turns: re-form squads, keep every intent going, watch for what should bring the next
// turn forward, and defend the base if the model has not done so in time.
export function maintainCommand(api, catalog, memory, emit, force = false) {
  const tick = api.tick(), cmd = memory.command ??= {};
  if (!force && tick - (cmd.maintainedAt ?? -Infinity) < INTENT_REFRESH_TICKS) return;
  cmd.maintainedAt = tick;
  const own = api.units("self"), enemies = api.units("enemy"), buildings = own.filter((u) => u.type === api.ObjectType.Building);
  const base = buildings.find((u) => catalog[u.name]?.yard) ?? buildings[0];
  rememberEnemyBuildings(api, catalog, memory, enemies);
  trackObjective(api, catalog, memory, base?.tile);
  const squads = refreshSquads(api, catalog, memory), intents = memory.intents;
  const urgent = (why) => { cmd.urgent ??= why; };
  // An attack lasts from the first threat until none has been seen for ATTACK_GRACE_TICKS, so the
  // automatic defense counts time since the attack began, not only an unbroken stretch.
  const threatened = baseRaiders(api, catalog, buildings, enemies).length > 0;
  if (threatened) cmd.lastThreatTick = tick;
  const attacked = threatened || cmd.attackSince !== undefined && tick - (cmd.lastThreatTick ?? -Infinity) < ATTACK_GRACE_TICKS;
  if (attacked && !cmd.baseAttacked) { urgent("base_attacked"); cmd.attackSince = tick; cmd.autoDefended = false; }
  if (!attacked) { cmd.attackSince = undefined; for (const i of intents.values()) if (i.auto) i.locked = false; }
  cmd.baseAttacked = attacked;
  // The lock has a hard limit: after it the model decides again, and the report says so.
  for (const [sid, i] of intents) if (i.auto && i.locked && tick >= i.lockedUntil) {
    i.locked = false;
    ((memory.lastPlanReport ??= { tick, orders: [] }).auto ??= []).push({ kind: "squad", squad: sid, action: "defend_base", auto: true, accepted: true, tick,
      result: `自动回防锁定到期（${AUTO_LOCK_TICKS} 拍），${sid} 交还模型指挥 (automatic defense lock expired: orders for ${sid} apply again)` });
  }
  if (memory.enemyBuildings?.size && !cmd.sawEnemyBase) { cmd.sawEnemyBase = true; urgent("enemy_base_found"); }
  if (memory.objectiveTarget && !memory.objectiveTarget.done && !cmd.sawObjective) { cmd.sawObjective = true; urgent("objective_found"); }
  // More than half of a squad's members at the last turn are dead. Infantry inside a house or a
  // transport is not in the unit list but is not lost either.
  let hostile = []; try { hostile = api.units("hostile") ?? []; } catch { hostile = []; }
  const alive = new Set([...own.map((u) => u.id), ...[...own, ...hostile].flatMap((u) => [...(u.garrison?.unitIds ?? []), ...(u.transport?.unitIds ?? [])])]);
  for (const [sid, ids] of cmd.squadsAtTurn ?? []) {
    if (ids.length < 2 || cmd.lossReported?.has(sid)) continue;
    if (ids.filter((id) => !alive.has(id)).length * 2 > ids.length) { (cmd.lossReported ??= new Set()).add(sid); urgent("squad_losses"); }
  }
  if (attacked && squads.length && !cmd.autoDefended && tick - cmd.attackSince >= AUTO_DEFENSE_TICKS && ![...intents.values()].some((i) => i.action === "defend_base")) {
    const q = [...squads].sort((a, b) => distance(centerOf(a.members), base.tile) - distance(centerOf(b.members), base.tile))[0];
    // Locked for as long as the attack lasts: an order for this squad from a turn that ignores the
    // attack is not carried out until the base is clear (see applyOrders).
    intents.set(q.id, newIntent({ action: "defend_base", reason: "automatic: base under attack with no defend_base order" }, tick, { auto: true, locked: true, lockedUntil: tick + AUTO_LOCK_TICKS }));
    cmd.autoDefended = true;
    const note = { kind: "squad", squad: q.id, action: "defend_base", auto: true, accepted: true, tick, result: `自动回防：基地受攻击 ${tick - cmd.attackSince} 拍，模型未安排回防 (automatic defend_base)` };
    ((memory.lastPlanReport ??= { tick, orders: [] }).auto ??= []).push(note);
    emit({ kind: "command", tick, auto: [note], results: [], rejected: [], note: "", description: `自动回防：${q.id}（${q.members.length} 个单位）回防基地`, choice: `auto ${q.id} defend_base` });
  }
  for (const q of squads) {
    const intent = intents.get(q.id);
    if (intent && !intent.targetGone) guarded(api, memory, emit, q.id, () => orderSquad(api, catalog, memory, q, intent, false));
  }
  instinctSets(memory, squads);
}
// An intent that throws while being carried out is dropped with an error event; autopilot goes on.
function guarded(api, memory, emit, sid, run) {
  try { return run(); }
  catch (e) {
    memory.intents?.delete(sid);
    emit({ kind: "error", tick: api.tick(), message: `指挥意图 ${sid} 执行出错，已丢弃：${String(e?.message ?? e).slice(0, 160)}` });
    return { accepted: false, reason: "execution_error" };
  }
}

// Turns what happened since the last turn into the brief's "lastPlan": units left per squad, the
// attack targets' health, our losses and kills since then.
export function refreshPlanReport(api, memory) {
  const r = memory.lastPlanReport;
  if (!r) return r;
  const alive = new Set(api.units("self").map((u) => u.id)), now = ledgerTotals(memory);
  for (const o of r.orders ?? []) {
    if (o.kind !== "squad") continue;
    o.nowUnits = (memory.squads?.get(o.squad) ?? []).filter((id) => alive.has(id)).length;
    if (o.action === "attack") {
      const t = visibleTarget(api, o.target);
      o.targetNow = t ? `${Math.round(t.hitPoints ?? 0)}/${Math.round(t.maxHitPoints ?? 0)}` : memory.enemyBuildings?.has(o.target) ? "not visible" : "destroyed or gone";
    }
  }
  if (r.ledger) r.sinceThen = { lost: now.lost - r.ledger.lost, killed: now.killed - r.ledger.killed };
  const holding = [...(memory.intents ?? [])].filter(([, i]) => i.auto && i.locked).map(([sid]) => sid);
  const until = Math.max(...holding.map((sid) => memory.intents.get(sid).lockedUntil ?? 0));
  if (holding.length) r.autoDefense = `${holding.join(", ")}: 基地仍受攻击，自动回防中 (base still under attack, automatic defense in progress. To command these squads, give them defend_base now, or wait until the lock ends at tick ${until} or the base is clear; other orders for them are refused until then)`;
  else delete r.autoDefense;
  return r;
}

// The model's orders, carried out: squad intents, production, engineers. Returns one result per order.
// elapsedMs: real time since the brief was taken; without it only the tick count decides staleness.
export function applyOrders(api, catalog, memory, emit, reply, sourceTick, { elapsedMs } = {}) {
  const tick = api.tick(), orders = reply?.orders ?? {}, intents = memory.intents ??= new Map(), cmd = memory.command ??= {};
  rememberEnemyBuildings(api, catalog, memory, api.units("enemy"));
  const squads = refreshSquads(api, catalog, memory), byId = new Map(squads.map((q) => [q.id, q]));
  const results = [], stale = Number.isFinite(sourceTick) && tick - sourceTick > STALE_COMMAND_TICKS && !(elapsedMs <= STALE_COMMAND_MS);
  // units: the squad's size at the order; ordered: how many were actually sent this time.
  const line = (o, r) => { const { reason, units, ...rest } = r; results.push({ ...o, ...rest, ...(units !== undefined ? { ordered: units } : {}), accepted: !!r.accepted, ...(reason ? { reason } : {}) }); };
  for (const o of orders.squads ?? []) {
    const base = { kind: "squad", squad: o.squad, action: o.action, ...(o.target !== undefined ? { target: o.target } : {}), ...(o.x !== undefined ? { x: o.x, y: o.y } : {}), ...(o.reason ? { why: o.reason } : {}) };
    const q = byId.get(o.squad);
    if (!q) { line(base, { accepted: false, reason: "squad_gone" }); continue; }
    // Squads may have moved a long way since that brief: their orders wait for a fresh turn.
    if (stale) { line({ ...base, units: q.members.length }, { accepted: false, reason: "stale_reply" }); continue; }
    const old = intents.get(q.id);
    if (old?.auto && old.locked && tick < (old.lockedUntil ?? Infinity) && o.action !== "defend_base") { line({ ...base, units: q.members.length }, { accepted: false, reason: "auto_defense_active" }); continue; }
    // The same intent again keeps its members and clock: only new or idle members are ordered.
    const keep = sameIntent(old, o) && !old.targetGone;
    // A repeat within 5 tiles continues the intent at the new point, so the squad key follows it.
    const intent = keep ? Object.assign(old, { reason: o.reason ?? old.reason, auto: false, locked: false, ...(o.x !== undefined ? { x: o.x, y: o.y } : {}) }) : newIntent(o, tick);
    intents.set(q.id, intent);
    const r = guarded(api, memory, emit, q.id, () => orderSquad(api, catalog, memory, q, intent, !keep));
    line({ ...base, units: q.members.length }, keep ? { ...r, continues: true } : r);
  }
  const why = (o) => (o.reason ? { why: o.reason } : {});
  const safe = (run) => { try { return run(); } catch (e) { emit({ kind: "error", tick, message: `指挥命令执行出错：${String(e?.message ?? e).slice(0, 160)}` }); return { accepted: false, reason: "execution_error" }; } };
  for (const o of orders.production ?? []) line({ kind: "production", item: o.item, count: o.count, ...why(o) }, safe(() => executeProduction(api, catalog, memory, o)));
  for (const o of orders.engineers ?? []) line({ kind: "engineer", action: o.action, target: o.target, ...why(o) }, safe(() => executeEngineer(api, catalog, memory, o)));
  instinctSets(memory, squads);
  cmd.maintainedAt = tick;
  const brief = (o) => ({ kind: o.kind, ...(o.squad ? { squad: o.squad } : {}), ...(o.action ? { action: o.action } : {}), ...(o.item ? { item: o.item, count: o.count } : {}),
    ...(o.target !== undefined ? { target: o.target } : {}), ...(o.x !== undefined ? { x: o.x, y: o.y } : {}), ...(o.units !== undefined && o.kind === "squad" ? { unitsAtOrder: o.units } : {}),
    result: o.accepted ? (o.continues ? "accepted (continuing)" : "accepted") : `not executed: ${o.reason}` });
  // An automatic defense taken while this reply was on its way has not been shown to the model yet.
  const unseen = (memory.lastPlanReport?.auto ?? []).filter((a) => a.tick > sourceTick);
  // Every field the model can fill is cut short here too: an unbounded report would grow the next brief
  // past the size limit, the request would be refused and the report never replaced.
  const rejected = (reply?.rejected ?? []).slice(0, 10).map((r) => Object.fromEntries(Object.entries(r ?? {}).slice(0, 8).map(([k, v]) => [cut(k, 20), typeof v === "number" ? v : cut(String(v))])));
  const report = { tick, sourceTick, note: String(orders.note ?? "").slice(0, 400), orders: results.slice(0, 20).map(brief), rejected,
    ...(stale ? { stale: `回答过期（局面已过去 ${tick - sourceTick} 拍${Number.isFinite(elapsedMs) ? `、${Math.round(elapsedMs / 1000)} 秒` : ""}），小队意图未执行 (reply too old: squad orders not executed)` } : {}),
    ...(unseen.length ? { auto: unseen.slice(0, 5) } : {}), ledger: ledgerTotals(memory) };
  if (JSON.stringify(report).length > PLAN_REPORT_CHARS) { report.rejected = report.rejected.map(({ kind, reason }) => ({ kind, reason })); report.orders = report.orders.slice(0, 10); }
  if (JSON.stringify(report).length > PLAN_REPORT_CHARS) { report.note = report.note.slice(0, 100); report.rejected = [{ reason: `${rejected.length} orders refused` }]; }
  memory.lastPlanReport = report;
  return results;
}

export async function attachJevPlayer(api, options = {}) {
  if (!api) throw new Error("Enter a battle before attaching Jev.");
  const requestDecision = options.requestDecision;
  if (typeof requestDecision !== "function") throw new Error("A decision transport is required.");
  const catalog = options.catalog ?? {};
  if (!options.catalog && !api.rules) throw new Error("This player requires werhd.rules() from the current player API.");
  refreshCatalog(api, catalog);
  const maxDecisions = options.maxDecisions ?? 600,
    maxStaleTicks = options.maxStaleTicks ?? 180;
  // Commander mode: the model plans from a brief (OpenAI-compatible sources only; the background decides).
  const commander = options.commander === true;
  const memory = {
    autoCamera: options.autoCamera !== false,
    objective: typeof options.objective === "string" ? options.objective.trim().slice(0, 300) : "",
    frontiers: new Map(),
    enemyBuildings: new Map(),
    lastPlaceTick: -1000,
    lastMaintenance: -1000,
    lastMicroReport: -1000,
    repairing: new Set(),
    orders: new Map(),
    postureOrders: new Map(),
    specialOrders: new Map(), specialTargets: new Map(), plannedSites: new Map(),
    observedSpecial: new Map(),
    mission: undefined,
  };
  const status = {
    running: true,
    busy: false,
    decisions: 0,
    accepted: 0,
    rejected: 0,
    failures: 0,
    last: undefined,
    observations: [],
    events: [],
  };
  const controller = new AbortController();
  let decisionTimer,
    microTimer,
    lastTick = -1,
    lastObservationTick = -1,
    progressTick = -1,
    progressAt = performance.now();
  const emit = (event) => {
    status.events.push(event);
    if (status.events.length > 400) status.events.shift();
    options.onEvent?.(event);
    if (options.debug && event.kind !== "observation") console.info("[werhd-jev]", event);
  };
  let lastMicroAt = -Infinity, lastDecideAt = -Infinity;
  // Bookkeeping shared by model-chosen and automatic actions once the executor accepted them.
  const afterAccepted = (action, execution) => {
    status.accepted++;
    if (action.type === "produce" && action.placement) memory.plannedSites.set(action.name, action.placement);
    if (action.type === "produce") memory.spentCredits = (memory.spentCredits ?? 0) + (action.cost ?? 0);
    if (action.type === "special") {
      rememberSpecial(memory, action, execution, api.tick());
      for (const unitId of execution.ids ?? []) memory.specialOrders.set(unitId, { tick: api.tick(), kind: action.kind });
      if (action.targetId !== undefined) memory.specialTargets.set(`repair_${action.targetId}`, api.tick());
    }
    if (action.type === "set_deployed") for (const unitId of execution.ids ?? []) memory.postureOrders.set(unitId, api.tick());
    for (const unitId of execution.undeployIds ?? []) memory.postureOrders.set(unitId, api.tick());
    if (action.type === "mission") {
      acceptMission(memory, action, execution, api.tick());
      memory.frontiers.set(`${action.x},${action.y}`, api.tick());
      memory.points = undefined;
    }
  };
  const stop = (reason = "manual") => {
    if (!status.running) return;
    status.running = false;
    clearTimeout(decisionTimer);
    clearTimeout(microTimer);
    if (typeof api.offTick === "function") { try { api.offTick(); } catch {} }
    controller.abort();
    emit({
      kind: "stop",
      reason,
      decisions: status.decisions,
      accepted: status.accepted,
    });
  };
  const micro = () => {
    if (!status.running) return;
    lastMicroAt = performance.now();
    try {
      if (api.tick() !== progressTick) {
        progressTick = api.tick();
        progressAt = performance.now();
      } else if (performance.now() - progressAt > 30000) {
        stop("simulation_not_advancing");
        return;
      }
      const me = api.me();
      if (me.defeated || me.isObserver) {
        // What the game looked like at the end, so a defeat right after an objective can be explained.
        let players = [];
        try { players = (api.players?.() ?? []).map((p) => ({ name: String(p.name ?? "").slice(0, 30), allied: !!p.allied, defeated: !!p.defeated })); } catch {}
        const t = memory.objectiveTarget;
        emit({
          kind: "outcome",
          result: me.defeated ? "defeat" : "observer",
          tick: api.tick(),
          players,
          ...(t ? { objective: { id: t.id, label: t.label, done: !!t.done, captured: !!t.captured, lost: !!t.lost, hp: t.hp, afterCapture: t.afterCapture } } : {}),
          ownBuildings: api.units("self").filter((u) => u.type === api.ObjectType.Building).length,
        });
        stop("defeated_or_observer");
        return;
      }
      const opponents =
        api
          .players?.()
          .filter((p) => !p.allied && p.combatant && !p.isObserver) ?? [];
      if (opponents.length && opponents.every((p) => p.defeated)) {
        emit({ kind: "outcome", result: "victory", tick: api.tick() });
        stop("victory");
        return;
      }
      // Keeping intents is best effort: a failure there is reported and never stops the autopilot.
      if (commander) try { maintainCommand(api, catalog, memory, emit); } catch (e) {
        if (/outside a running battle/.test(e.message)) throw e;
        emit({ kind: "error", tick: api.tick(), message: `指挥维持出错：${String(e?.message ?? e).slice(0, 200)}` });
      }
      maintainBattle(api, catalog, memory, emit);
      placeReadyBuilding(api, catalog, memory, emit);
      updateCamera(api, catalog, memory, emit);
      if (api.tick() - lastObservationTick >= 60) {
        const snap = collectState(api, catalog),
          o = {
            kind: "observation",
            tick: api.tick(),
            credits: snap.state.self.credits,
            power: snap.state.self.power,
            inventory: snap.state.inventory,
            visibleEnemies: snap.state.visibleEnemies,
            queues: snap.state.queues,
            state: { ...snap.state, strategy: memory.strategy },
            mission: memory.mission?.label,
            ledger: updateLedger(api, catalog, memory),
          };
        status.observations.push(o);
        if (status.observations.length > 180) status.observations.shift();
        emit(o);
        lastObservationTick = api.tick();
      }
    } catch (e) {
      if (/outside a running battle/.test(e.message)) stop("battle_ended");
      else {
        emit({ kind: "error", message: e.message });
        stop("executor_error");
      }
    }
    if (status.running) microTimer = setTimeout(micro, 150);
  };
  const decide = async () => {
    if (!status.running) return;
    lastDecideAt = performance.now();
    try {
      const tick = api.tick();
      if (tick === lastTick) return;
      lastTick = tick;
      if (status.decisions >= maxDecisions) {
        stop("decision_budget");
        return;
      }
      const snap = collectState(api, catalog),
        groups = candidateGroups(api, catalog, snap, memory);
      const requestGroups = Object.fromEntries(
        Object.entries(groups)
          .filter(([, g]) => Object.keys(g.criteria).length > 1)
          .sort(([a], [b]) => {
            const priority = id => ["construction", "defenses", "tactics", "salvage"].includes(id) ? -1000000 : (memory.questionTicks?.get(id) ?? -100000);
            return priority(a) - priority(b);
          })
          .slice(0, 8)
          .map(([id, g]) => [
            id,
            { instructions: g.instructions, criteria: g.criteria },
          ]),
      );
      if (!Object.keys(requestGroups).length) return;
      memory.questionTicks ??= new Map();
      for (const id of Object.keys(requestGroups)) memory.questionTicks.set(id, tick);
      status.busy = true;
      const started = performance.now();
      const acceptedBefore = status.accepted;
      const result = await requestDecision({ state: snap.state, groups: requestGroups }, { signal: controller.signal });
      status.decisions++;
      status.last = { tick, ...result };
      if (!status.running) return;
      const ageTicks = api.tick() - tick;
      if (ageTicks > maxStaleTicks) {
        status.rejected++;
        emit({
          kind: "stale",
          tick,
          currentTick: api.tick(),
          latencyMs: result.latencyMs,
        });
        return;
      }
      for (const [id, answer] of Object.entries(result.answers).sort(
        ([a], [b]) => { const rank = id => id === "deployment" ? 9 : id === (snap.state.strategy?.investment?.category ?? (snap.state.strategy?.investment?.queue === api.QueueType.Armory ? "defenses" : "construction")) ? -1 : 0; return rank(a) - rank(b); },
      )) {
        let action = groups[id]?.actions[answer.choice];
        if (action?.ids) action = { ...action, ids: action.ids.filter(
          (unitId) => api.tick() - (memory.specialOrders.get(unitId)?.tick ?? -10000) > 450) };
        const locked = missionGate(api, memory, action);
        if (locked) {
          status.rejected++;
          rememberChoice(memory, id, answer.choice, locked, api.tick());
          emit({ kind: "action", tick: api.tick(), sourceTick: tick, question: id, choice: answer.choice, confidence: answer.confidence, action, ...locked });
          continue;
        }
        if (action?.type === "mission") {
          const old = memory.mission;
          const sameMission = old && old.mode === action.mode && old.targetId === action.targetId && Math.hypot(old.x - action.x, old.y - action.y) < 5;
          // Repeating the current mission only reaches units that are new to it or standing idle.
          // Everyone else may be answering fire; re-ordering the whole army every turn pulled them
          // off the enemies shooting at them (0.6.0 match: 92 lost in three minutes).
          let nothingNew = false;
          if (sameMission && action.mode !== "defend") {
            const selfNow = new Map(api.units("self").map((u) => [u.id, u]));
            const fresh = action.ids.filter((uid) => !old.ids.includes(uid) || selfNow.get(uid)?.isIdle);
            if (!fresh.length) nothingNew = true;
            else if (fresh.length < action.ids.length) action = { ...action, ids: fresh, merge: old.ids };
          }
          if (nothingNew || (sameMission && action.ids.every(id=>old.ids.includes(id)) && api.tick() - (old.issuedAt ?? old.since) < 180)) {
            emit({
              kind: "action",
              tick: api.tick(),
              question: id,
              choice: answer.choice,
              accepted: false,
              reason: "mission_continues",
              confidence: answer.confidence,
            });
            continue;
          }
        }
        const execStarted = performance.now(),
          execution = executeCandidate(api, action, catalog);
        if (execution.accepted) afterAccepted(action, execution);
        else if (execution.reason !== "wait") status.rejected++;
        rememberChoice(memory, id, answer.choice, execution, api.tick());
        emit({
          kind: "action",
          tick: api.tick(),
          sourceTick: tick,
          ageTicks,
          question: id,
          choice: answer.choice,
          confidence: answer.confidence,
          latencyMs: result.latencyMs,
          roundTripMs: Math.round(performance.now() - started),
          executionMs: performance.now() - execStarted,
          action,
          ...execution,
        });
      }
      // Mechanical fallback for objective-critical options marked `auto: N` (explore when nothing is
      // in sight, capture with an engineer, train the engineer for it): after the model declined that
      // group N times in a row, the first such option is executed anyway and logged as automatic.
      memory.autoDeclines ??= {};
      for (const [id, g] of Object.entries(groups)) {
        const answer = result.answers[id];
        const autos = Object.entries(g.actions).filter(([k, a]) => k !== "wait" && a && Number.isFinite(a.auto)).sort((a, b) => a[1].auto - b[1].auto);
        if (!answer || !autos.length) { if (!autos.length) delete memory.autoDeclines[id]; continue; }
        const [choice, action] = autos[0];
        memory.autoDeclines[id] = answer.choice === "wait" ? (memory.autoDeclines[id] ?? 0) + 1 : 0;
        if (memory.autoDeclines[id] < action.auto) continue;
        // Already doing exactly this: the fallback does not re-send the column (or renew its lock).
        const running = memory.mission;
        if (action.type === "mission" && running && running.mode === action.mode && sameTarget(running, action)) { memory.autoDeclines[id] = 0; continue; }
        const execution = missionGate(api, memory, action) ?? executeCandidate(api, action, catalog);
        memory.autoDeclines[id] = 0;
        if (execution.accepted) afterAccepted(action, execution);
        rememberChoice(memory, id, choice, execution, api.tick(), true);
        emit({ kind: "action", tick: api.tick(), sourceTick: tick, question: id, choice, auto: true, action, ...execution, reason: execution.accepted ? (id === "scouting" ? "auto_explore" : `auto_${id}`) : execution.reason });
      }
      const allWait = Object.values(result.answers).every(a => a.choice === "wait");
      const quiet = allWait && status.accepted === acceptedBefore && !snap.state.baseUnderAttack;
      memory.quietTurns = quiet ? (memory.quietTurns ?? 0) + 1 : 0;
    } catch (e) {
      if (/outside a running battle/.test(e.message)) {
        stop("battle_ended");
        return;
      }
      if (status.running) {
        status.failures++;
        emit({ kind: "error", message: e.message });
      }
      if (status.failures >= 5) stop("repeated_errors");
    } finally {
      status.busy = false;
      if (status.running)
        decisionTimer = setTimeout(decide, decideInterval());
    }
  };
  // Commander turn: the first at once, then every COMMAND_INTERVAL_TICKS or sooner when maintainCommand
  // flagged something urgent; never while a request is out (status.busy keeps runDue away).
  const command = async () => {
    if (!status.running) return;
    lastDecideAt = performance.now();
    try {
      const tick = api.tick(), cmd = memory.command ??= {};
      const since = tick - (cmd.lastTick ?? -Infinity);
      const urgentNow = cmd.urgent && (cmd.urgent === "base_attacked" || since >= URGENT_MIN_TICKS) ? cmd.urgent : undefined;
      const why = cmd.lastTick === undefined ? "first" : urgentNow ?? (since >= COMMAND_INTERVAL_TICKS ? "interval" : "");
      if (!why) return;
      if (status.decisions >= maxDecisions) { stop("decision_budget"); return; }
      const snap = collectState(api, catalog);
      rememberEnemyBuildings(api, catalog, memory, snap.raw.enemies);
      if (snap.raw.base) refreshInfrastructure(api, memory, snap.raw.base);
      objectiveState(api, catalog, memory, snap.raw.base, snap.state);
      refreshPlanReport(api, memory);
      const brief = { ...buildBrief(api, catalog, snap, memory), trigger: why };
      cmd.lastTick = tick; cmd.urgent = undefined;
      // Seen before this turn: only something new brings the next turn forward.
      cmd.sawEnemyBase ||= memory.enemyBuildings.size > 0; cmd.sawObjective ||= !!(memory.objectiveTarget && !memory.objectiveTarget.done);
      cmd.squadsAtTurn = new Map(memory.squads ?? []); cmd.lossReported = new Set();
      status.busy = true;
      const started = performance.now();
      const result = await requestDecision({ mode: "commander", brief }, { signal: controller.signal });
      status.decisions++;
      status.last = { tick, ...result };
      if (!status.running) return;
      // Carrying the reply out is not a failed request: an error here is reported, not counted toward stopping.
      let results = [];
      try { results = applyOrders(api, catalog, memory, emit, result, tick, { elapsedMs: performance.now() - started }); }
      catch (e) { if (/outside a running battle/.test(e.message)) throw e; emit({ kind: "error", tick: api.tick(), message: `指挥命令执行出错：${String(e?.message ?? e).slice(0, 200)}` }); }
      status.accepted += results.filter((r) => r.accepted).length;
      status.rejected += results.filter((r) => !r.accepted).length + (result.rejected?.length ?? 0);
      const text = (r) => `${r.kind === "production" ? `${r.item}×${r.count ?? 1}` : r.kind === "engineer" ? `${r.action} #${r.target}` : `${r.squad} ${r.action}${r.target !== undefined ? " #" + r.target : ""}${r.x !== undefined ? ` (${r.x},${r.y})` : ""}`} ${r.accepted ? "✓" : "✗ " + r.reason}`;
      const summary = [...results.map(text), ...(result.rejected ?? []).map((r) => `${cut(String(r.squad ?? r.item ?? r.action ?? r.kind))} ✗ ${r.reason}`)].join("; ").slice(0, 600);
      emit({ kind: "command", tick: api.tick(), sourceTick: tick, trigger: why, latencyMs: result.latencyMs, roundTripMs: Math.round(performance.now() - started), note: result.orders?.note ?? "",
        results, rejected: result.rejected ?? [], auto: [], choice: summary.slice(0, 80), description: `指挥：${summary || "无新命令"}${result.orders?.note ? " — " + result.orders.note : ""}` });
    } catch (e) {
      if (/outside a running battle/.test(e.message)) { stop("battle_ended"); return; }
      if (status.running) { status.failures++; emit({ kind: "error", message: e.message }); }
      if (status.failures >= 5) stop("repeated_errors");
    } finally {
      status.busy = false;
      if (status.running) decisionTimer = setTimeout(loop, decideInterval());
    }
  };
  const loop = commander ? command : decide;
  // Page timers are throttled to once a minute in a hidden tab while the simulation keeps running.
  // The game's own tick callback is not, so every tick wakes the loops when a timer is overdue.
  // The callback itself stays trivial (the game disables handlers that exceed ~8 ms).
  const microEvery = options.microIntervalMs ?? 150;
  const decideInterval = () => (memory.quietTurns ?? 0) >= QUIET_TURNS ? Math.max(QUIET_INTERVAL_MS, options.intervalMs ?? 600) : options.intervalMs ?? 600;
  let wakePending = false, tickDriven = false;
  const runDue = () => {
    wakePending = false;
    if (!status.running) return;
    const now = performance.now();
    if (!options.disableMicro && now - lastMicroAt >= microEvery) { clearTimeout(microTimer); micro(); }
    if (!status.busy && now - lastDecideAt >= (options.wakeIntervalMs ?? decideInterval())) { clearTimeout(decisionTimer); loop(); }
  };
  if (typeof api.onTick === "function" && !options.disableTickWake) {
    try {
      api.onTick(() => { if (!wakePending) { wakePending = true; Promise.resolve().then(runDue); } });
      tickDriven = true;
    } catch { tickDriven = false; }
  }
  emit({ kind: "start", tick: api.tick(), maxDecisions, policy: commander ? "commander-v1" : "v8.8.15-tactics-wait", tickDriven });
  if (!options.disableMicro) microTimer = setTimeout(micro, 0);
  decisionTimer = setTimeout(loop, 0);
  return { status, stop, catalog, memory, setAutoCamera: (enabled) => { memory.autoCamera = !!enabled; } };
}
