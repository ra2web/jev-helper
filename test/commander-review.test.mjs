import test from 'node:test';
import assert from 'node:assert/strict';
import { attachJevPlayer, applyOrders, maintainCommand, maintainBattle, refreshSquads, refreshPlanReport,
  AUTO_DEFENSE_TICKS, URGENT_MIN_TICKS, STALE_COMMAND_TICKS, STALE_COMMAND_MS, ATTACK_GRACE_TICKS, AUTO_LOCK_TICKS, PLAN_REPORT_CHARS } from '../src/player/werhd-jev-player.mjs';
import { buildCommanderRequest, parseCommanderResponse, COMMAND_TOOL } from '../src/openai.mjs';
import { catalog, T, u, infantry, world, home, road, civilians, brief, scene } from './commander-world.mjs';

// Review of 0.7.0 (8a3d9d4): each test replays one of the reproduction scripts c1–c7.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (args) => ({ choices: [{ message: { tool_calls: [{ function: { name: COMMAND_TOOL, arguments: JSON.stringify(args) } }] } }] });
const squadOf = (x, unitId) => [...x.memory.squads].find(([, ids]) => ids.includes(unitId))[0];

test('P0-1: squads with different intents never merge; a new recruit without one joins the nearest squad (c2)', () => {
  const guard = infantry(10, 8, 100, 112), column = infantry(40, 5, 100, 130);
  const x = world({ own: [...home(), ...guard, ...column], enemies: road(), neutral: civilians() });
  refreshSquads(x.api, catalog, x.memory);
  const H = squadOf(x, 10), R = squadOf(x, 40);
  applyOrders(x.api, catalog, x.memory, () => {}, { orders: { squads: [{ squad: H, action: 'hold', x: 100, y: 112 }, { squad: R, action: 'attack_move', x: 60, y: 50 }] } }, 12000);
  // The column walks north straight through the home guard.
  for (let step = 1; step <= 6; step++) {
    x.setTick(12000 + step * 45);
    for (const r of column) { r.tile = { rx: 100 + (r.id % 3), ry: 130 - step * 4 }; r.isIdle = false; }
    x.calls.length = 0;
    maintainCommand(x.api, catalog, x.memory, () => {}, true);
    assert.ok(!x.calls.some((c) => c[0] === 'move' && c[1].some((id) => id >= 40)), `step ${step}: the column is not pulled back to the guard point`);
    assert.ok(!x.calls.some((c) => c[0] === 'attackMove' && c[1].some((id) => id < 20)), `step ${step}: the guard is not dragged to the front`);
    assert.equal(x.memory.intents.get(squadOf(x, 40)).action, 'attack_move');
    assert.equal(x.memory.intents.get(squadOf(x, 10)).action, 'hold');
  }
  assert.notEqual(squadOf(x, 10), squadOf(x, 40));
  // A fresh recruit next to the guard has no intent yet: it joins the guard and is sent to its point.
  const recruit = u(90, 'E2', T.Infantry, 104, 115);
  x.self.push(recruit); x.calls.length = 0; x.setTick(12400);
  maintainCommand(x.api, catalog, x.memory, () => {}, true);
  assert.equal(squadOf(x, 90), squadOf(x, 10));
  assert.ok(x.calls.some((c) => c[0] === 'move' && c[1].includes(90) && c[2] === 100 && c[3] === 112));
});

test('P1-1: the members left outside a garrison never rush the pillbox in later micro passes, they only step back (c4)', () => {
  const x = scene();
  for (const s of x.self) if (s.name === 'E2' && s.tile.ry < 80) s.tile.ry -= 2;
  const F = refreshSquads(x.api, catalog, x.memory).find((q) => q.members[0].tile.ry < 80).id;
  applyOrders(x.api, catalog, x.memory, () => {}, { orders: { squads: [{ squad: F, action: 'garrison', target: 1638 }] } }, 12000);
  const crew = x.calls.find((c) => c[0] === 'order' && c[2].type === x.api.OrderType.Occupy)[1];
  const rest = x.memory.squads.get(F).filter((id) => !crew.includes(id));
  assert.equal(rest.length, 13);
  let backs = 0;
  for (let t = 12015; t <= 12600; t += 15) {
    x.setTick(t); x.calls.length = 0;
    for (const s of x.self) if (s.name === 'E2') s.isIdle = true;
    maintainCommand(x.api, catalog, x.memory, () => {});
    maintainBattle(x.api, catalog, x.memory, () => {});
    for (const c of x.calls) {
      if (c[0] === 'attack' || c[0] === 'attackMove') assert.ok(!c[1].some((id) => rest.includes(id)) || ![1655, 1656].includes(c[2]), `tick ${t}: ${c[0]} ${c[2]} by the waiting members`);
      if (c[0] === 'move' && c[1].every((id) => rest.includes(id))) backs++;
    }
  }
  assert.ok(backs > 0, 'the ones under fire step out of range instead');
});

test('P1-2: coordinates off the map are refused; an intent that throws in the micro loop is dropped without stopping autopilot', async () => {
  const x = scene(), b = brief(x);
  assert.deepEqual(b.legal.mapSize, { width: 155, height: 155 });
  const r = parseCommanderResponse(call({ note: '', squads: [{ squad: 'S1', action: 'move', x: -50, y: 99999 }, { squad: 'S2', action: 'hold', x: 154, y: 0 }] }), b.legal);
  assert.deepEqual(r.rejected.map((o) => o.reason), ['coordinates outside the map']);
  assert.deepEqual(r.orders.squads.map((o) => o.squad), ['S2']);
  // A game call that throws while an intent is being kept.
  const y = scene(), events = [];
  let broken = false;
  const move = y.api.move;
  y.api.move = (...a) => { if (broken) throw new Error('boom'); return move(...a); };
  const p = await attachJevPlayer(y.api, { catalog, commander: true, intervalMs: 1e9, wakeIntervalMs: 0, microIntervalMs: 0, maxDecisions: 50, autoCamera: false, onEvent: (e) => events.push(e),
    requestDecision: async () => ({ orders: { note: '', squads: [{ squad: 'S1', action: 'move', x: 90, y: 90 }] }, rejected: [], latencyMs: 1 }) });
  try {
    await sleep(5);
    broken = true;
    for (const s of y.self) s.isIdle = true;
    for (let t = 12050; t <= 12200; t += 50) { y.setTick(t); y.api._tick({}); await sleep(2); }
    assert.equal(p.status.running, true, 'autopilot keeps running');
    assert.ok(events.some((e) => e.kind === 'error' && /S1/.test(e.message) && /丢弃/.test(e.message)));
    assert.equal(p.memory.intents.has('S1'), false, 'the failing intent is dropped');
  } finally { p.stop('manual'); }
});

test('P1-3: refused orders are cut short, and the plan report stays bounded so the next brief is accepted', () => {
  const x = scene(), b = brief(x);
  const huge = 'Z'.repeat(100000);
  const r = parseCommanderResponse(call({ note: 'n', squads: [{ squad: huge, action: huge, target: 1 }], production: [{ item: huge }], engineers: [{ action: huge, target: 1 }] }), b.legal);
  for (const o of r.rejected) for (const k of ['squad', 'action', 'item']) if (o[k] !== undefined) assert.ok(o[k].length <= 40, `${o.kind}.${k}`);
  // Even an unbounded list handed to the executor directly keeps the report small.
  const flood = Array.from({ length: 300 }, (_, i) => ({ kind: 'squad', squad: huge, action: huge, [huge.slice(0, 50)]: huge, reason: `r${i}` }));
  applyOrders(x.api, catalog, x.memory, () => {}, { orders: { note: huge, squads: [] }, rejected: flood }, 12000);
  assert.ok(JSON.stringify(x.memory.lastPlanReport).length <= PLAN_REPORT_CHARS);
  const next = brief(x), { legal, ...shown } = next;
  assert.ok(JSON.stringify(next).length < 200000 && JSON.stringify(shown.lastPlan).length <= PLAN_REPORT_CHARS);
});

test('P2-1: urgent turns keep a minimum gap, except a fresh attack on the base (c5)', async () => {
  const foes = Array.from({ length: 40 }, (_, i) => u(5000 + i, 'E1', T.Infantry, 60 + (i % 8), 40 + Math.floor(i / 8)));
  const x = world({ own: [...home(), ...infantry(10, 20, 60, 50)], enemies: foes });
  const asked = [];
  const p = await attachJevPlayer(x.api, { catalog, commander: true, intervalMs: 1, wakeIntervalMs: 0, microIntervalMs: 0, maxDecisions: 500, autoCamera: false,
    requestDecision: async (body) => { const b = body.brief; asked.push([b.tick, b.trigger]); return { orders: { note: '', squads: b.legal.squads.map((s) => ({ squad: s, action: 'attack', target: x.enemies[0]?.id })) }, rejected: [], latencyMs: 1 }; } });
  try {
    await sleep(5);
    let t = 12000;
    for (let s = 0; s < 60; s++) { t += 15; x.setTick(t); if (s % 3 === 2) x.enemies.shift(); x.api._tick({}); await sleep(3); }
    const minute = asked.filter(([tick]) => tick < 12900);
    assert.ok(minute.length <= 1 + Math.ceil(900 / URGENT_MIN_TICKS), `${minute.length} requests in a game minute`);
    for (let i = 1; i < asked.length; i++) assert.ok(asked[i][0] - asked[i - 1][0] >= URGENT_MIN_TICKS, 'gap kept');
    // A raid on the base is asked about at once, even right after a turn.
    const last = asked.at(-1)[0];
    x.enemies.push(u(900, 'HTNK', T.Vehicle, 103, 121));
    t = last + 45; x.setTick(t); x.api._tick({}); await sleep(3);
    t += 1; x.setTick(t); x.api._tick({}); await sleep(3);
    assert.deepEqual(asked.at(-1)[1], 'base_attacked'); assert.ok(asked.at(-1)[0] - last < URGENT_MIN_TICKS);
  } finally { p.stop('manual'); }
});

test('P2-2: a raider going in and out still counts as one attack; the automatic defense is kept while it lasts (c7)', () => {
  const raider = u(5000, 'E1', T.Infantry, 103, 112), enemies = road();
  const x = world({ own: [...home(), ...infantry(10, 8, 100, 105), ...infantry(40, 10, 60, 52)], enemies, neutral: civilians() });
  maintainCommand(x.api, catalog, x.memory, () => {}, true);
  const H = squadOf(x, 10), F = squadOf(x, 40);
  applyOrders(x.api, catalog, x.memory, () => {}, { orders: { squads: [{ squad: H, action: 'attack_move', x: 70, y: 60 }, { squad: F, action: 'hold', x: 60, y: 52 }] } }, 12000);
  const autos = [], rejectedTurns = [];
  let t = 12000;
  for (let s = 1; s <= 200; s++) {
    t += 15; x.setTick(t);
    // In for 150 ticks, out for 150 ticks: never 450 in a row.
    const inBase = t >= 12150 && t < 13800 && Math.floor((t - 12150) / 150) % 2 === 0;
    const i = enemies.indexOf(raider); if (inBase && i < 0) enemies.push(raider); if (!inBase && i >= 0) enemies.splice(i, 1);
    maintainCommand(x.api, catalog, x.memory, (e) => { if (e.kind === 'command') autos.push(t); });
    if (s % 12 === 0) {
      const [r] = applyOrders(x.api, catalog, x.memory, () => {}, { orders: { squads: [{ squad: H, action: 'attack_move', x: 70, y: 60 }] } }, t);
      if (r.reason === 'auto_defense_active') rejectedTurns.push(t);
    }
  }
  assert.equal(autos.length, 1, 'one automatic defense for the whole raid');
  assert.ok(autos[0] >= 12150 + AUTO_DEFENSE_TICKS && autos[0] < 12150 + AUTO_DEFENSE_TICKS + 150, `counted from the start of the raid (${autos[0]})`);
  assert.ok(rejectedTurns.length >= 2, 'the model cannot pull the defenders away while the raid goes on');
  // After the raider has been gone for the grace period, the model's order applies again.
  assert.equal(x.memory.intents.get(H).action, 'attack_move');
  assert.ok(t - 13800 > ATTACK_GRACE_TICKS);
  // The report says the defense is going on.
  const y = world({ own: [...home(), ...infantry(10, 8, 100, 105)], enemies: [u(5000, 'E1', T.Infantry, 103, 112)], neutral: civilians() });
  maintainCommand(y.api, catalog, y.memory, () => {}, true);
  applyOrders(y.api, catalog, y.memory, () => {}, { orders: { squads: [] } }, 12000);
  y.setTick(12000 + AUTO_DEFENSE_TICKS); maintainCommand(y.api, catalog, y.memory, () => {}, true);
  assert.match(refreshPlanReport(y.api, y.memory).autoDefense, /自动回防中/);
});

test('P2-3: a reply to a situation too old moves no squads but still produces', () => {
  const x = scene(); brief(x);
  x.setTick(12000 + STALE_COMMAND_TICKS + 1);
  const results = applyOrders(x.api, catalog, x.memory, () => {}, { orders: { squads: [{ squad: 'S1', action: 'move', x: 90, y: 90 }], production: [{ item: 'E2', count: 2 }] } }, 12000);
  assert.deepEqual(results.map((r) => [r.kind, r.accepted, r.reason ?? '']), [['squad', false, 'stale_reply'], ['production', true, '']]);
  assert.ok(!x.calls.some((c) => c[0] === 'move'));
  assert.match(x.memory.lastPlanReport.stale, /回答过期.*小队意图未执行/);
  assert.equal(x.memory.intents.has('S1'), false);
});

test('P2-4: a holding unit drawn more than 4 tiles off its point walks back once idle', () => {
  const x = scene(); brief(x);
  applyOrders(x.api, catalog, x.memory, () => {}, { orders: { squads: [{ squad: 'S1', action: 'hold', x: 62, y: 60 }] } }, 12000);
  for (const s of x.self) if (s.id >= 10 && s.id < 28) { s.tile = { rx: 62, ry: 60 }; s.isIdle = true; }
  x.setTick(12100); maintainCommand(x.api, catalog, x.memory, () => {}, true);
  x.calls.length = 0;
  const chaser = x.self.find((s) => s.id === 11), nudged = x.self.find((s) => s.id === 12);
  chaser.tile = { rx: 70, ry: 60 }; nudged.tile = { rx: 64, ry: 61 };
  x.setTick(12200); maintainCommand(x.api, catalog, x.memory, () => {}, true);
  assert.deepEqual(x.calls.filter((c) => c[0] === 'move').map((c) => c[1]), [[11]], 'only the one 8 tiles away; 2 tiles is still at its post');
  chaser.isIdle = false; chaser.tile = { rx: 75, ry: 60 }; x.calls.length = 0;
  x.setTick(12300); maintainCommand(x.api, catalog, x.memory, () => {}, true);
  assert.equal(x.calls.filter((c) => c[0] === 'move').length, 0, 'not while it is still busy');
});

test('P2-5: enemy groups name up to three unit ids the model can attack, and the prompt says how to fight a group', () => {
  const x = scene({ enemies: [...road(), ...infantry(5100, 6, 70, 60, 'E1'), u(5200, 'HTNK', T.Vehicle, 73, 61)] });
  const b = brief(x);
  const group = b.enemyGroups.find((g) => g.n === 7);
  assert.equal(group.ids.length, 3);
  assert.ok(group.ids.includes(5200), 'the toughest one is named');
  for (const id of group.ids) assert.ok(b.legal.attackTargets.includes(id));
  const r = parseCommanderResponse(call({ note: '', squads: [{ squad: 'S1', action: 'attack', target: group.ids[0] }] }), b.legal);
  assert.equal(r.orders.squads.length, 1);
  assert.match(buildCommanderRequest({ model: 'm', brief: b }).messages[0].content, /each enemy group lists up to three unit ids; to fight a whole group, attack_move to its position/);
});

// ---- Second review (5f984bb): d1, d3b / d3c, d5b ----
test('P1-A: an enemy pillbox near the base is not an endless attack; the automatic defense lock ends after 600 ticks (d1)', () => {
  // Case A: only a pillbox 14 tiles from our buildings. It is an enemy building for the model, not a raid.
  const a = world({ own: [...home(), ...infantry(10, 8, 100, 100), ...infantry(40, 10, 60, 52)], enemies: [...road(), u(5000, 'GAPILL', T.Building, 96, 108)], neutral: civilians() });
  maintainCommand(a.api, catalog, a.memory, () => {}, true);
  const HA = squadOf(a, 10), autosA = [];
  for (let t = 12015; t <= 14000; t += 15) {
    a.setTick(t); maintainCommand(a.api, catalog, a.memory, (e) => { if (e.kind === 'command') autosA.push(t); });
    if (t % 180 === 0) assert.equal(applyOrders(a.api, catalog, a.memory, () => {}, { orders: { squads: [{ squad: HA, action: 'attack_move', x: 70, y: 60 }] } }, t)[0].accepted, true);
  }
  assert.equal(a.memory.command.baseAttacked, false); assert.deepEqual(autosA, [], 'no automatic defense against a building');
  assert.ok(brief(a).enemyBuildings.some((b) => b.id === 5000), 'the model sees it as an enemy building');
  // Case B: a tank parked next to the base for the whole game.
  const b = world({ own: [...home(), ...infantry(10, 8, 100, 100), ...infantry(40, 10, 60, 52)], enemies: [...road(), u(5001, 'HTNK', T.Vehicle, 103, 110), u(5002, 'GAPILL', T.Building, 96, 108)], neutral: civilians() });
  maintainCommand(b.api, catalog, b.memory, () => {}, true);
  const HB = squadOf(b, 10), results = [];
  let autoAt;
  for (let t = 12015; t <= 18000; t += 15) {
    b.setTick(t); b.calls.length = 0;
    maintainCommand(b.api, catalog, b.memory, (e) => { if (e.kind === 'command') autoAt ??= t; });
    for (const c of b.calls) if (c[0] === 'attack') assert.notEqual(c[2], 5002, 'defenders are never sent at the pillbox');
    if (t % 180 === 0) results.push([t, applyOrders(b.api, catalog, b.memory, () => {}, { orders: { squads: [{ squad: HB, action: 'attack_move', x: 70, y: 60 }] } }, t)[0]]);
    if (autoAt && t === autoAt + 45) assert.match(refreshPlanReport(b.api, b.memory).autoDefense, /defend_base now, or wait until the lock ends at tick \d+/);
  }
  assert.ok(autoAt >= 12000 + AUTO_DEFENSE_TICKS);
  const refused = results.filter(([, r]) => r.reason === 'auto_defense_active').map(([t]) => t);
  assert.ok(refused.length > 0 && refused.every((t) => t < autoAt + AUTO_LOCK_TICKS), `refused only while locked: ${refused}`);
  assert.ok(results.some(([t, r]) => t >= autoAt + AUTO_LOCK_TICKS && r.accepted), 'after the lock the model commands again');
  // The report of the turn when the lock ran out says so (it is kept until the next reply replaces it).
  const c = world({ own: [...home(), ...infantry(10, 8, 100, 100)], enemies: [u(5001, 'HTNK', T.Vehicle, 103, 110)], neutral: civilians() });
  maintainCommand(c.api, catalog, c.memory, () => {}, true);
  applyOrders(c.api, catalog, c.memory, () => {}, { orders: { squads: [] } }, 12000);
  c.setTick(12000 + AUTO_DEFENSE_TICKS); maintainCommand(c.api, catalog, c.memory, () => {}, true);
  c.setTick(12000 + AUTO_DEFENSE_TICKS + AUTO_LOCK_TICKS); maintainCommand(c.api, catalog, c.memory, () => {}, true);
  assert.match(c.memory.lastPlanReport.auto.at(-1).result, /锁定到期.*交还模型/);
  assert.equal(refreshPlanReport(c.api, c.memory).autoDefense, undefined);
});

test('P1-B: a second attack first seen during a command turn still gets its automatic defense (d3c)', async () => {
  const enemies = road(), raider = u(5000, 'HTNK', T.Vehicle, 103, 110);
  const x = world({ own: [...home(), ...infantry(10, 8, 100, 100), ...infantry(40, 10, 60, 52)], enemies, neutral: civilians() });
  const autos = [];
  // The model never defends: it keeps every squad on hold where it stands.
  const p = await attachJevPlayer(x.api, { catalog, commander: true, intervalMs: 1, wakeIntervalMs: 0, microIntervalMs: 0, maxDecisions: 500, autoCamera: false,
    onEvent: (e) => { if (e.kind === 'command' && e.auto?.length) autos.push(e.tick); },
    requestDecision: async (body) => ({ orders: { note: '', squads: body.brief.squads.map((q) => ({ squad: q.id, action: 'hold', x: q.at[0], y: q.at[1] })) }, rejected: [], latencyMs: 1 }) });
  try {
    await sleep(5);
    let t = 12000;
    const run = async (n, on) => { for (let k = 0; k < n; k++) { t += 45; x.setTick(t); const i = enemies.indexOf(raider); if (on && i < 0) enemies.push(raider); if (!on && i >= 0) enemies.splice(i, 1); x.api._tick({}); await sleep(2); } };
    await run(12, true);
    await run(10, false);
    await run(14, true);
    assert.equal(autos.length, 2, `one automatic defense per attack: ${autos}`);
  } finally { p.stop('manual'); }
});

test('P2-A: repeats of the same order a few tiles apart keep one squad, and the point follows the latest order (d5b)', () => {
  const x = world({ own: [...home(), ...infantry(10, 10, 60, 52)], enemies: [], neutral: civilians() });
  let t = 12000, nid = 100;
  for (let turn = 0; turn < 20; turn++) {
    x.self.push(...infantry(nid, 3, 104, 116)); nid += 3;
    const sq = refreshSquads(x.api, catalog, x.memory);
    applyOrders(x.api, catalog, x.memory, () => {}, { orders: { squads: sq.map((q) => ({ squad: q.id, action: 'attack_move', x: 60 + (turn % 5), y: 48 + (turn % 4) })) } }, t);
    for (const q of refreshSquads(x.api, catalog, x.memory)) { const i = x.memory.intents.get(q.id); if (i?.x !== undefined) for (const m of q.members) { m.tile = { rx: i.x + (m.id % 5) * 0.5, ry: i.y + ((m.id >> 2) % 3) * 0.5 }; m.isIdle = true; } }
    for (let k = 0; k < 4; k++) { t += 45; x.setTick(t); maintainCommand(x.api, catalog, x.memory, () => {}, true); }
  }
  const b = brief(x, '');
  assert.ok(b.squads.length <= 2, `${b.squads.length} squads at the same front`);
  const i = x.memory.intents.get('S1');
  assert.deepEqual([i.x, i.y], [60 + (19 % 5), 48 + (19 % 4)], 'the point is the one last ordered');
});

test('P2-B: staleness needs both many ticks and a long real wait, so a sped-up game keeps its replies', () => {
  const order = { orders: { squads: [{ squad: 'S1', action: 'move', x: 90, y: 90 }] } };
  const fast = scene(); brief(fast); fast.setTick(12000 + STALE_COMMAND_TICKS * 3);
  assert.equal(applyOrders(fast.api, catalog, fast.memory, () => {}, order, 12000, { elapsedMs: 40000 })[0].accepted, true, 'a 40 s reply in a fast game still moves the squad');
  const slow = scene(); brief(slow); slow.setTick(12000 + STALE_COMMAND_TICKS + 1);
  const [r] = applyOrders(slow.api, catalog, slow.memory, () => {}, order, 12000, { elapsedMs: STALE_COMMAND_MS + 1 });
  assert.equal(r.reason, 'stale_reply'); assert.match(slow.memory.lastPlanReport.stale, /拍、60 秒/);
});
