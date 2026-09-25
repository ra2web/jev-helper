// Commander mode, step 1: what the model is shown. The extension describes the rules (what every
// unit type can do, read from the match rules) and the situation (who is where, who outranges whom,
// what the last plan achieved); the model decides the plan. See docs/commander-design.md.
import { activeWeapons, weaponEffectiveness, canFireAt } from './werhd-jev-strategy.mjs';
import { isDecoration, isCapturable } from './werhd-jev-catalog.mjs';
import { isGuardedByObjective } from './werhd-jev-objective.mjs';

const distance = (a, b) => Math.hypot(a.rx - b.rx, a.ry - b.ry);
const r1 = (n) => Math.round(n * 10) / 10;
export const SQUAD_RADIUS = 8, ENEMY_GROUP_RADIUS = 8, SIEGE_REACH = 8, BRIEF_ENEMY_BUILDINGS = 40, BRIEF_ENEMY_GROUPS = 12;

// Damage per second estimates against the four target classes the model reasons about.
function versus(rule, api) {
  const probe = { infantry: { type: api.ObjectType.Infantry, armor: api.ArmorType?.None ?? 0 }, armor: { type: api.ObjectType.Vehicle, armor: api.ArmorType?.Heavy ?? 5 },
    building: { type: api.ObjectType.Building, armor: api.ArmorType?.Concrete ?? 8 }, air: { type: api.ObjectType.Aircraft, zone: api.ZoneType?.Air ?? 1, armor: api.ArmorType?.Light ?? 3 } };
  const weapons = [rule?.weapon, rule?.secondary].filter((w) => (w?.damage ?? 0) > 0);
  return Object.fromEntries(Object.entries(probe).map(([k, t]) => [k, Math.round(Math.max(0, ...weapons.map((w) => weaponEffectiveness(w, [t], {}, api))))]));
}
const kindOf = (rule, type, api) => type === api.ObjectType.Building ? (rule?.isBaseDefense || (rule?.weapon?.damage ?? 0) > 0 ? 'defense' : 'building')
  : type === api.ObjectType.Infantry ? 'infantry' : type === api.ObjectType.Aircraft || rule?.aircraft ? 'aircraft' : rule?.naval ? 'ship' : 'vehicle';

// One line per unit type seen this match or producible now.
export function unitCard(name, type, catalog, api, maxHp) {
  const r = catalog[name] ?? {};
  const weapons = [r.weapon, r.secondary].filter((w) => (w?.damage ?? 0) > 0);
  const groundRange = Math.max(0, ...weapons.filter((w) => w.ag !== false).map((w) => w.range ?? 0));
  const airRange = Math.max(0, ...weapons.filter((w) => w.aa).map((w) => w.range ?? 0));
  const tags = [
    r.occupier && 'can_garrison', r.canBeOccupied && `garrisonable(${r.maxNumberOccupants ?? '?'})`, r.engineer && 'engineer', r.harvester && 'miner',
    r.deployer && 'deployable', weapons.length && !groundRange && 'anti_air_only', r.bridgeRepairHut && 'bridge_repair_hut', r.yard && 'construction_yard',
    r.factory && `factory:${r.factory}`, r.refinery && 'refinery', r.power > 0 && `power+${r.power}`, r.power < 0 && `power${r.power}`,
    isDecoration(r, name) && 'decoration', !r.weapon && !r.secondary && type !== api.ObjectType.Building && 'unarmed',
  ].filter(Boolean);
  return { id: name, name: r.label ?? name, kind: kindOf(r, type, api), ...(maxHp ? { maxHp } : {}), cost: r.cost ?? 0, speed: r.speed ?? 0, armor: r.armor ?? '', range: r1(groundRange), airRange: r1(airRange), dps: versus(r, api), tags };
}

// What forms squads: armed mobile units, not miners or engineers (engineers are listed apart).
export const squadUnits = (units, catalog, api) => units.filter((u) => u.type !== api.ObjectType.Building && !catalog[u.name]?.harvester && !catalog[u.name]?.engineer && u.primaryWeapon);

// Units close together that share a task form a squad. Ids stay stable between turns: a new squad
// inherits the id of the old squad it shares the most units with. Units whose squads have different
// intents never merge, even when they pass close by (a column walking through the home guard kept
// the guard's intent and was pulled back); units without an intent (new recruits) join the nearest
// squad within reach.
// "The same intent" is one rule everywhere: same action and target, points within 5 tiles. The executor
// treats such a repeat as a continuation, so squads under it must be allowed to merge too.
export const sameIntent = (a, o) => !!a && !!o && a.action === o.action && a.target === o.target &&
  (o.x === undefined || a.x !== undefined && Math.hypot(a.x - o.x, a.y - o.y) < 5);
export function formSquads(units, memory, radius = SQUAD_RADIUS) {
  const previous = memory.squads ?? new Map(), prevOf = new Map();
  for (const [sid, ids] of previous) for (const id of ids) prevOf.set(id, sid);
  const kinds = [];
  const keyOf = (u) => {
    const i = memory.intents?.get(prevOf.get(u.id));
    if (!i) return '';
    let k = kinds.findIndex((o) => sameIntent(o, i) && sameIntent(i, o));
    if (k < 0) k = kinds.push(i) - 1;
    return `k${k}`;
  };
  const byKey = new Map();
  for (const u of units) { const k = keyOf(u); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(u); }
  const squads = [];
  for (const [k, list] of byKey) if (k) squads.push(...clusters(list, radius));
  const leftover = [];
  for (const u of byKey.get('') ?? []) {
    let best, bestD = Infinity;
    for (const members of squads) for (const m of members) { const d = distance(m.tile, u.tile); if (d <= radius && d < bestD) { best = members; bestD = d; } }
    if (best) best.push(u); else leftover.push(u);
  }
  squads.push(...clusters(leftover, radius));
  const taken = new Set(), next = new Map();
  let counter = memory.squadCounter ?? 0;
  const result = squads.sort((a, b) => b.length - a.length).map((members) => {
    const ids = new Set(members.map((u) => u.id));
    let best, overlap = 0;
    for (const [sid, old] of previous) {
      if (taken.has(sid)) continue;
      const shared = old.filter((id) => ids.has(id)).length;
      if (shared > overlap) { best = sid; overlap = shared; }
    }
    const id = best ?? `S${++counter}`;
    taken.add(id); next.set(id, [...ids]);
    return { id, members };
  });
  memory.squads = next; memory.squadCounter = counter;
  return result;
}

function clusters(units, radius) {
  const left = [...units], out = [];
  while (left.length) {
    const members = [left.shift()];
    for (let i = 0; i < members.length; i++)
      for (let j = left.length - 1; j >= 0; j--)
        if (distance(left[j].tile, members[i].tile) <= radius) members.push(...left.splice(j, 1));
    out.push(members);
  }
  return out;
}
const centerOf = (members) => ({ rx: Math.round(members.reduce((n, u) => n + u.tile.rx, 0) / members.length), ry: Math.round(members.reduce((n, u) => n + u.tile.ry, 0) / members.length) });
const countBy = (members, catalog) => Object.entries(members.reduce((m, u) => (m[u.name] = (m[u.name] ?? 0) + 1, m), {})).map(([k, n]) => `${k}×${n}`).join(' ');
const hpOf = (members) => members.length ? Math.round(100 * members.reduce((n, u) => n + (u.hitPoints ?? 0) / (u.maxHitPoints || 1), 0) / members.length) : 0;
const groundReach = (u, catalog) => Math.max(0, ...activeWeapons(u, catalog).filter((w) => (w.damage ?? 0) > 0 && w.ag !== false).map((w) => w.range ?? 0));

// Everything the model needs to plan, and the only ids it may name.
export function buildBrief(api, catalog, snapshot, memory) {
  const tick = api.tick(), s = snapshot.state, { units, enemies, buildings, base } = snapshot.raw;
  const hostile = api.units('hostile') ?? [];
  const B = api.ObjectType.Building, Air = api.ZoneType?.Air ?? 1;
  const mobile = units.filter((u) => u.type !== B && !catalog[u.name]?.harvester && (u.primaryWeapon || catalog[u.name]?.engineer));
  const combat = squadUnits(units, catalog, api);
  const squads = formSquads(combat, memory);
  const enemyUnits = enemies.filter((e) => e.type !== B);
  const enemyIds = new Set(enemies.map((e) => e.id)), objectiveId = s.objectiveTarget?.id;
  // Enemy-owned structures, plus neutral ones only when they matter: capturable or the objective.
  // Civilian houses are listed separately, as cover next to enemy defenses.
  const enemyBuildings = hostile.filter((e) => e.type === B && !isDecoration(catalog[e.name], e.name) &&
    (enemyIds.has(e.id) || e.id === objectiveId || isCapturable(catalog[e.name], e.name)));
  const hostileArmed = [...enemyUnits, ...enemyBuildings.filter((b) => enemyIds.has(b.id))].filter((e) => e.zone !== Air && groundReach(e, catalog) > 0);
  // Which squads are under fire from something they cannot answer.
  const pressure = (members) => {
    const out = new Map();
    for (const u of members) {
      const reachU = groundReach(u, catalog);
      for (const e of hostileArmed) {
        const d = distance(e.tile, u.tile), reach = groundReach(e, catalog);
        if (d > reach + 1) continue;
        const outranged = reach > reachU && !canFireAt(api, catalog, u, e);
        const key = e.id, prev = out.get(key);
        if (!prev || d < prev.d) out.set(key, { id: e.id, name: e.name, d: r1(d), range: r1(reach), outranges: outranged });
      }
    }
    return [...out.values()].sort((a, b) => a.d - b.d).slice(0, 4);
  };
  const intentOf = (sid) => memory.intents?.get(sid);
  const squadView = squads.map(({ id, members }) => {
    const c = centerOf(members), intent = intentOf(id);
    return { id, units: countBy(members, catalog), n: members.length, at: [c.rx, c.ry], hpPct: hpOf(members),
      idle: members.filter((u) => u.isIdle).length, intent: intent ? `${intent.action}${intent.target !== undefined ? ' ' + intent.target : ''}${intent.x !== undefined ? ` (${intent.x},${intent.y})` : ''}${intent.auto ? ' (automatic)' : ''}${intent.targetGone ? ' (target destroyed)' : ''}` : 'none',
      underFire: pressure(members) };
  });
  const enemyGroups = clusters(enemyUnits.filter((e) => e.zone !== Air), ENEMY_GROUP_RADIUS).map((members) => {
    const c = centerOf(members);
    const nearest = squads.map((q) => ({ q: q.id, d: distance(centerOf(q.members), c) })).sort((a, b) => a.d - b.d)[0];
    // Up to three ids the model can name in an attack: the one closest to our nearest squad, then the toughest.
    const from = nearest ? centerOf(squads.find((q) => q.id === nearest.q).members) : c;
    const byNear = [...members].sort((a, b) => distance(a.tile, from) - distance(b.tile, from));
    const ids = [...new Set([byNear[0], ...[...members].sort((a, b) => (b.maxHitPoints ?? 0) - (a.maxHitPoints ?? 0) || distance(a.tile, from) - distance(b.tile, from))].map((e) => e.id))].slice(0, 3);
    return { units: countBy(members, catalog), n: members.length, at: [c.rx, c.ry], hpPct: hpOf(members), ids, nearestSquad: nearest ? `${nearest.q} ${Math.round(nearest.d)}` : '' };
  }).sort((a, b) => b.n - a.n).slice(0, BRIEF_ENEMY_GROUPS);
  const air = enemyUnits.filter((e) => e.zone === Air);
  const houses = hostile.filter((u) => u.garrison?.canOccupy && u.garrison.count < u.garrison.capacity);
  const baseAt = base?.tile ?? { rx: 0, ry: 0 };
  const buildingView = enemyBuildings.map((b) => {
    const r = catalog[b.name] ?? {}, reach = groundReach(b, catalog), airOnly = (r.weapon?.damage ?? 0) > 0 && !reach;
    const cover = reach ? houses.filter((h) => distance(h.tile, b.tile) <= SIEGE_REACH).sort((a, c) => distance(a.tile, b.tile) - distance(c.tile, b.tile)).slice(0, 2)
      .map((h) => ({ house: h.id, d: r1(distance(h.tile, b.tile)), room: h.garrison.capacity - h.garrison.count })) : [];
    return { id: b.id, type: b.name, owner: enemyIds.has(b.id) ? 'enemy' : 'neutral', at: [b.tile.rx, b.tile.ry], hp: `${Math.round(b.hitPoints ?? 0)}/${Math.round(b.maxHitPoints ?? 0)}`,
      ...(reach ? { range: r1(reach) } : {}), ...(airOnly ? { antiAirOnly: true } : {}), ...(cover.length ? { houses: cover } : {}),
      ...(isCapturable(r, b.name) ? { capturable: true } : {}), dist: Math.round(distance(b.tile, baseAt)) };
  }).sort((a, b) => Number(b.owner === 'enemy') - Number(a.owner === 'enemy') || a.dist - b.dist).slice(0, BRIEF_ENEMY_BUILDINGS);
  const remembered = [...(memory.enemyBuildings?.values() ?? [])].filter((k) => !enemyBuildings.some((b) => b.id === k.id))
    .map((k) => ({ id: k.id, type: k.name, at: [k.x, k.y], lastSeenTick: k.tick })).slice(0, 20);
  // Bridges and huts, capture targets, garrisonable houses near us.
  const bridges = memory.infrastructure?.bridges ?? [];
  const damagedBridges = bridges.filter((b) => Number.isFinite(b.hitPoints) && b.maxHitPoints > 0 && b.hitPoints < b.maxHitPoints).map((b) => [b.x, b.y]).slice(0, 8);
  const huts = hostile.filter((u) => catalog[u.name]?.bridgeRepairHut).map((h) => ({ id: h.id, at: [h.tile.rx, h.tile.ry] })).slice(0, 6);
  const engineers = mobile.filter((u) => catalog[u.name]?.engineer).map((u) => ({ id: u.id, at: [u.tile.rx, u.tile.ry], idle: u.isIdle }));
  const ownBuildings = buildings.map((b) => ({ id: b.id, type: b.name, at: [b.tile.rx, b.tile.ry], hpPct: Math.round(100 * (b.hitPoints ?? 0) / (b.maxHitPoints || 1)), ...(b.garrison?.count ? { garrison: b.garrison.count } : {}) }));
  // What can be produced now.
  const queues = api.production.queues();
  const producible = api.production.available().map((i) => ({ id: i.name, cost: catalog[i.name]?.cost ?? 0, queue: i.queue ?? i.type }))
    .filter((i, k, all) => all.findIndex((o) => o.id === i.id) === k);
  // Unit cards: everything seen or producible this match.
  const seen = memory.cardNames ??= new Map();
  const maxHp = memory.cardHp ??= new Map();
  for (const u of [...units, ...enemies, ...enemyBuildings]) { if (!seen.has(u.name)) seen.set(u.name, u.type); if (u.maxHitPoints) maxHp.set(u.name, Math.round(u.maxHitPoints)); }
  for (const i of api.production.available()) if (!seen.has(i.name)) seen.set(i.name, i.type ?? catalog[i.name]?.type ?? api.ObjectType.Building);
  const cards = [...seen].filter(([name]) => catalog[name]).map(([name, type]) => unitCard(name, type, catalog, api, maxHp.get(name)));
  const objective = memory.objective ? { text: memory.objective, target: s.objectiveTarget ?? null } : null;
  const legal = {
    squads: squadView.map((q) => q.id),
    // Buildings the objective says to protect or capture can never be attacked; a capture objective
    // is always a legal engineer target, defended or not.
    attackTargets: [...enemyUnits.map((e) => e.id), ...enemyBuildings.filter((b) => !isGuardedByObjective(memory.objective, catalog[b.name], b.name)).map((b) => b.id),
      ...remembered.filter((k) => !isGuardedByObjective(memory.objective, catalog[k.type], k.type)).map((k) => k.id)],
    houses: houses.map((h) => h.id), huts: huts.map((h) => h.id),
    captures: enemyBuildings.filter((b) => isCapturable(catalog[b.name], b.name) || b.id === objectiveId && s.objectiveTarget?.mode === 'capture').map((b) => b.id),
    produce: producible.map((p) => p.id),
    mapSize: api.map.size?.() ?? null,
  };
  return {
    tick, gameSeconds: s.gameSeconds, credits: s.self?.credits ?? 0, power: s.self?.power ?? null,
    base: base ? { at: [base.tile.rx, base.tile.ry], underAttack: !!s.baseUnderAttack } : null,
    objective, squads: squadView, engineers, ownBuildings, production: { queues: queues.map((q) => ({ type: q.type, items: q.items.map((i) => `${i.name}×${i.quantity}`) })), producible },
    enemyGroups, enemyAircraft: air.length, enemyBuildings: buildingView, rememberedBuildings: remembered,
    map: { size: api.map.size?.() ?? null, damagedBridges, bridgeHuts: huts, knownLosses: memory.ledger ? { lost: memory.ledger.ownUnitsLost, killed: memory.ledger.enemyUnitsDestroyed, buildingsKilled: memory.ledger.enemyBuildingsDestroyed } : null },
    lastPlan: memory.lastPlanReport ?? null,
    cards, legal,
  };
}
