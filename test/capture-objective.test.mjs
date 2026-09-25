import test from 'node:test';
import assert from 'node:assert/strict';
import { collectState, candidateGroups, executeCandidate, maintainBattle, RICH_SPEND, CAPTURE_PUSH_UNITS, CAPTURE_STAGE_TILES } from '../src/player/werhd-jev-player.mjs';
import { rememberSpecial, maintainSpecial, ESCORT_ARRIVE_TILES } from '../src/player/werhd-jev-special.mjs';
import { parseObjective, matchesCapture, isGuardedByObjective } from '../src/player/werhd-jev-objective.mjs';
import { catalog, T, u, infantry, world, home, brief } from './commander-world.mjs';

// 0.7.2 report (Laya, "使用工程师占领盟军战略实验室", defeat): "占领" was read as "protect", so the
// objective was never found although the Allied Battle Lab stood in view all game; no engineer was
// sent for it; it was even offered as an assault target, and the mission was lost when it fell.
// Meanwhile the model answered "wait" to a Rhino tank 251 times and credits rose to 14,000.
catalog.GATECH = { label: 'Allied Battle Lab', armor: 'wood', cost: 2000, techLevel: 3 };
catalog.NAWEAP = { factory: 'UnitType', label: 'Soviet War Factory', armor: 'heavy', cost: 2000 };
const TEXT = '使用工程师占领盟军战略实验室';
const lab = () => u(1470, 'GATECH', T.Building, 101, 27);
const labBase = () => [lab(), u(1434, 'GACNST', T.Building, 107, 18), u(1467, 'GAPILL', T.Building, 99, 30)];
const engineer = (id = 60, x = 101, y = 117) => u(id, 'SENGINEER', T.Infantry, x, y);
const tanks = (from, n) => Array.from({ length: n }, (_, i) => u(from + i, 'HTNK', T.Vehicle, 95 + i, 60));
const groupsOf = (x, objective = TEXT) => { x.memory.objective = objective; const snap = collectState(x.api, catalog); return { snap, groups: candidateGroups(x.api, catalog, snap, x.memory) }; };

test('"占领 / capture" names a building to take, not one to protect or destroy', () => {
  for (const text of [TEXT, 'Capture the Allied Battle Lab with an engineer', '夺取战略实验室']) {
    const p = parseObjective(text);
    assert.deepEqual(p.words, [], `${text}: nothing to destroy`);
    assert.ok(p.capture.includes('battle lab'), `${text}: the battle lab is a capture target`);
    assert.equal(matchesCapture(text, catalog.GATECH, 'GATECH'), 'name');
    assert.ok(isGuardedByObjective(text, catalog.GATECH, 'GATECH'), 'and it is never attacked');
    assert.ok(!isGuardedByObjective(text, catalog.GACNST, 'GACNST'), 'the yard next to it still is');
  }
  const mixed = parseObjective('摧毁建造厂，占领实验室，保护兵营');
  assert.deepEqual(mixed.words, ['construction yard']);
  assert.deepEqual(mixed.capture, ['battle lab', 'laboratory']);
  assert.ok(mixed.guarded.includes('barracks') && mixed.guarded.includes('battle lab'));
});

test('the Battle Lab is the capture objective: never an assault, engineers go for it first even defended', () => {
  const x = world({ own: [...home(), ...tanks(10, 8), engineer()], enemies: labBase(), credits: 4000 });
  const { snap, groups } = groupsOf(x);
  assert.deepEqual({ id: snap.state.objectiveTarget.id, mode: snap.state.objectiveTarget.mode }, { id: 1470, mode: 'capture' });
  const tactics = Object.keys(groups.tactics.criteria);
  assert.ok(!tactics.includes('assault_1470'), 'the lab is never an assault option');
  assert.equal(groups.tactics.actions.objective_1470?.targetId, undefined, 'the objective option pushes beside it, never at it');
  assert.ok(Object.values(groups.tactics.actions).every((a) => a?.targetId !== 1470), 'no tactics option targets the lab');
  assert.ok(tactics.includes('assault_1467'), 'the pillbox guarding it is');
  assert.ok(tactics.indexOf('assault_1467') < tactics.indexOf('assault_1434'), 'and comes before the yard');
  assert.match(groups.tactics.instructions, /CAPTURE target: Allied Battle Lab #1470 .*never attack it/);
  const capture = groups.engineering?.actions.capture_1470;
  assert.ok(capture, 'the engineer is offered the lab although a pillbox stands next to it');
  assert.equal(Object.keys(groups.engineering.criteria).filter((k) => k !== 'wait')[0], 'capture_1470', 'first');
  assert.match(groups.engineering.criteria.capture_1470, /^MISSION OBJECTIVE CAPTURE/);
  assert.equal(capture.escort, true, 'defended: the engineer follows the column instead of walking in alone');
  assert.equal(capture.auto, 1);
  x.enemies.splice(x.enemies.findIndex((e) => e.id === 1467), 1);
  const calm = groupsOf(x).groups;
  assert.equal(calm.engineering.actions.capture_1470.auto, 1, 'undefended: automatic after one decline');
  assert.equal(calm.engineering.actions.capture_1470.escort, undefined, 'and sent straight in');
});

test('with no engineer, one is trained for the objective even when money is short', () => {
  const x = world({ own: [...home(), ...tanks(10, 8)], enemies: labBase(), credits: 900 });
  const { groups } = groupsOf(x);
  const train = groups.infantry?.actions.produce_SENGINEER;
  assert.ok(train, 'an engineer is offered with 900 credits');
  assert.equal(train.auto, 1);
  assert.match(groups.infantry.criteria.produce_SENGINEER, /^MISSION OBJECTIVE: train an engineer to capture Allied Battle Lab #1470/);
});

test('the capture objective ends as captured when the lab becomes ours, or as lost when it is destroyed', () => {
  const taken = world({ own: [...home(), ...tanks(10, 8), engineer()], enemies: labBase() });
  groupsOf(taken);
  const ours = taken.enemies.splice(0, 1)[0]; taken.self.push(ours);
  let s = groupsOf(taken).snap.state;
  assert.equal(taken.memory.objectiveTarget.captured, true); assert.equal(taken.memory.objectiveTarget.lost, undefined);
  const lost = world({ own: [...home(), ...tanks(10, 8), engineer()], enemies: labBase() });
  groupsOf(lost);
  lost.enemies.splice(0, 1);
  const { snap, groups } = groupsOf(lost);
  assert.equal(snap.state.objectiveTarget.lost, true);
  assert.match(groups.tactics.instructions, /Allied Battle Lab was destroyed; the capture failed/);
});

test('buildings the objective says to protect are not assault targets either', () => {
  const x = world({ own: [...home(), ...tanks(10, 8)], enemies: [u(1434, 'GACNST', T.Building, 107, 18), u(1600, 'GAPILE', T.Building, 100, 20)] });
  const { groups } = groupsOf(x, '摧毁建造厂，保护兵营');
  const keys = Object.keys(groups.tactics.criteria);
  assert.ok(keys.includes('objective_1434'));
  assert.ok(!keys.includes('assault_1600'), 'the barracks we were told to protect is not attacked');
});

test('commander mode: the lab is a legal capture and never a legal attack target', () => {
  const x = world({ own: [...home(), ...tanks(10, 8), engineer()], enemies: labBase() });
  const b = brief(x, TEXT);
  assert.equal(b.objective.target.mode, 'capture');
  assert.ok(b.legal.captures.includes(1470), 'the engineer may capture it although it is defended');
  assert.ok(!b.legal.attackTargets.includes(1470), 'no squad may attack it');
  assert.ok(b.legal.attackTargets.includes(1467) && b.legal.attackTargets.includes(1434));
});

test('money piling up while the model waits: a combat unit is trained anyway; not below the threshold', () => {
  const offers = [{ name: 'HTNK', type: 7, queue: 3 }, { name: 'HARV', type: 7, queue: 3 }, { name: 'E2', type: 3, queue: 2 }, { name: 'SENGINEER', type: 3, queue: 2 }];
  const own = () => [...home(), u(4, 'NAWEAP', T.Building, 108, 122), u(5, 'NAREFN', T.Building, 92, 118), u(6, 'HARV', T.Vehicle, 90, 110), u(7, 'HARV', T.Vehicle, 91, 110), ...tanks(10, 6)];
  const rich = world({ own: own(), enemies: [u(1434, 'GACNST', T.Building, 107, 18)], credits: 14000, offers });
  let { groups } = groupsOf(rich, '');
  const produce = Object.entries(groups.vehicles?.actions ?? {}).find(([k]) => k !== 'wait');
  assert.ok(produce, 'a vehicle is offered');
  assert.equal(catalog[produce[1].name].harvester, undefined, 'a combat vehicle, not a miner');
  assert.equal(produce[1].auto, 2, '14,000 credits: automatic after two declines');
  const modest = world({ own: own(), enemies: [u(1434, 'GACNST', T.Building, 107, 18)], credits: RICH_SPEND - 1000, offers });
  ({ groups } = groupsOf(modest, ''));
  for (const [k, a] of Object.entries(groups.vehicles?.actions ?? {})) if (k !== 'wait') assert.equal(a.auto, undefined, `${k}: left to the model below ${RICH_SPEND}`);
});

// 0.7.3 report (same mission, defeat again): the lab was recognized and about fifteen engineers were
// sent for it, each alone, 117 tiles through the defenses; none arrived. The army sat at home
// "assembling" (4 of 12) and the lab fell at 32:30 as in the previous game: the mission is on a clock.
test('capture mission: with six units the column pushes beside the lab instead of assembling', () => {
  const x = world({ own: [...home(), ...tanks(10, CAPTURE_PUSH_UNITS), engineer()], enemies: labBase(), credits: 2000 });
  const { snap, groups } = groupsOf(x);
  assert.equal(snap.state.forceReadiness.ready, false, 'short of the attack threshold');
  const push = groups.tactics.actions.objective_1470;
  assert.ok(push, 'the push is offered');
  assert.equal(push.auto, 2);
  assert.equal(push.targetId, undefined, 'the lab itself is never the target');
  assert.ok(Math.abs(Math.hypot(push.x - 101, push.y - 27) - CAPTURE_STAGE_TILES) < 1.5, 'the point is beside the lab');
  assert.ok(push.y > 27, 'on the side our column comes from');
  assert.ok(!groups.tactics.actions.assemble_force, 'no more gathering at home');
  const run = executeCandidate(x.api, push, catalog);
  assert.equal(run.accepted, true);
  assert.deepEqual(x.calls.at(-1).slice(0, 1), ['attackMove']);
  assert.ok(!x.calls.some((c) => c[0] === 'attack' && c[2] === 1470));
  const few = world({ own: [...home(), ...tanks(10, CAPTURE_PUSH_UNITS - 2), engineer()], enemies: labBase(), credits: 2000 });
  assert.equal(groupsOf(few).groups.tactics.actions.objective_1470?.auto, undefined, 'four units: offered but not automatic');
});

test('escorted capture: the engineer trails the column and goes in when the column arrives', () => {
  const eng = engineer(60, 100, 100);
  const x = world({ own: [...home(), ...tanks(10, 6), eng], enemies: labBase(), credits: 2000 });
  const { groups } = groupsOf(x);
  const action = groups.engineering.actions.capture_1470;
  const run = executeCandidate(x.api, action, catalog);
  assert.equal(run.accepted, true);
  assert.ok(!x.calls.some((c) => c[0] === 'order' && c[2]?.type === 7), 'no capture order yet');
  rememberSpecial(x.memory, action, run, 12000);
  // The column is on its way, 30 tiles out: the engineer walks behind it.
  const column = x.self.filter((a) => a.name === 'HTNK');
  column.forEach((t, i) => { t.tile = { rx: 98 + i, ry: 60 }; });
  x.memory.mission = { mode: 'attack', ids: column.map((t) => t.id), x: 101, y: 31, since: 12000 };
  const events = [];
  x.setTick(12100); maintainSpecial(x.api, x.memory, (e) => events.push(e), catalog);
  const moved = x.calls.filter((c) => c[0] === 'move' && c[1].includes(60)).at(-1);
  assert.ok(moved, 'the engineer is moved');
  assert.ok(moved[3] > 60 && moved[3] < 70, `behind the column (y=${moved[3]})`);
  assert.ok(!x.calls.some((c) => c[0] === 'order' && c[2]?.type === 7));
  // The column reaches the lab: the engineer is sent in.
  column.forEach((t, i) => { t.tile = { rx: 99 + i, ry: 27 + ESCORT_ARRIVE_TILES - 2 }; });
  x.setTick(12200); maintainSpecial(x.api, x.memory, (e) => events.push(e), catalog);
  const captureOrder = x.calls.find((c) => c[0] === 'order' && c[2]?.type === 7);
  assert.deepEqual(captureOrder?.slice(1), [[60], { type: 7, target: { objectId: 1470 } }]);
  assert.match(events.at(-1).description, /部队已到目标旁/);
  assert.equal(x.memory.specialTasks[0].escort, false, 'now an ordinary capture task');
});

test('escorted capture: once the defenders are gone the engineer goes in without waiting for the column', () => {
  const x = world({ own: [...home(), ...tanks(10, 6), engineer(60, 100, 100)], enemies: labBase(), credits: 2000 });
  const action = groupsOf(x).groups.engineering.actions.capture_1470;
  rememberSpecial(x.memory, action, executeCandidate(x.api, action, catalog), 12000);
  x.enemies.splice(x.enemies.findIndex((e) => e.id === 1467), 1);
  x.setTick(12100); maintainSpecial(x.api, x.memory, () => {}, catalog);
  assert.ok(x.calls.some((c) => c[0] === 'order' && c[2]?.type === 7 && c[2].target.objectId === 1470));
});

test('focus fire never picks the capture target, even for a tank parked next to it', () => {
  const tank = u(10, 'HTNK', T.Vehicle, 101, 29);
  const x = world({ own: [...home(), tank], enemies: [lab(), u(1434, 'GACNST', T.Building, 103, 28)] });
  groupsOf(x);
  maintainBattle(x.api, catalog, x.memory, () => {});
  assert.ok(!x.calls.some((c) => c[0] === 'attack' && c[2] === 1470), 'the lab is spared');
  assert.ok(x.calls.some((c) => c[0] === 'attack' && c[2] === 1434), 'the yard beside it is still fair game');
});

// 0.7.4 report: the lab was captured, left our building list 6 s later and the game declared a
// defeat 5 s after that; the log could not tell whether it was destroyed or handed to another house.
test('after a capture the objective is still followed, and the report says what happened to it', async () => {
  const { stateSummary, eventEntry } = await import('../src/logbook.mjs');
  const x = world({ own: [...home(), ...tanks(10, 6), engineer()], enemies: labBase() });
  groupsOf(x);
  const taken = x.enemies.splice(0, 1)[0]; taken.hitPoints = 60; taken.maxHitPoints = 100; x.self.push(taken);
  let s = groupsOf(x).snap.state;
  assert.equal(s.objectiveTarget.captured, true); assert.equal(s.objectiveTarget.hp, 60);
  // Handed to another house: visible again among the non-friendly buildings.
  x.self.splice(x.self.indexOf(taken), 1); x.enemies.push(taken); x.setTick(12100);
  s = groupsOf(x).snap.state;
  assert.deepEqual(s.objectiveTarget.afterCapture, { tick: 12100, how: 'changed_hands', lastHp: 60 });
  assert.deepEqual(stateSummary(s).objective.afterCapture, { tick: 12100, how: 'changed_hands', lastHp: 60 });
  const out = eventEntry({ kind: 'outcome', tick: 12150, result: 'defeat', players: [{ name: 'Player 1', allied: true, defeated: true }],
    objective: { id: 1470, label: 'Allied Battle Lab', done: true, captured: true, hp: 60, afterCapture: { tick: 12100, how: 'changed_hands', lastHp: 60 } }, ownBuildings: 3 }, 1);
  assert.equal(out.objective.afterCapture.how, 'changed_hands'); assert.equal(out.players[0].defeated, true); assert.equal(out.ownBuildings, 3);
  // Destroyed while ours: gone from a visible tile.
  const y = world({ own: [...home(), ...tanks(10, 6), engineer()], enemies: labBase() });
  groupsOf(y); const l = y.enemies.splice(0, 1)[0]; y.self.push(l); groupsOf(y);
  y.self.splice(y.self.indexOf(l), 1); y.setTick(12200);
  assert.equal(groupsOf(y).snap.state.objectiveTarget.afterCapture.how, 'gone');
});
