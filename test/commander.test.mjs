import test from 'node:test';
import assert from 'node:assert/strict';
import { attachJevPlayer, collectState, applyOrders, maintainCommand, refreshPlanReport, orderSquad, refreshSquads, executeProduction, executeEngineer, objectiveState,
  COMMAND_INTERVAL_TICKS, AUTO_DEFENSE_TICKS, INTENT_REFRESH_TICKS } from '../src/player/werhd-jev-player.mjs';
import { buildBrief, formSquads, unitCard } from '../src/player/werhd-jev-commander.mjs';
import { commanderSchema, buildCommanderRequest, parseCommanderResponse, COMMAND_TOOL } from '../src/openai.mjs';
import { createBackground } from '../src/background-core.mjs';
import { DEFAULTS, validateSettings, publicSettings, activeProvider, prepareBrief } from '../src/shared.mjs';
import { eventEntry, commandEntry, logStats } from '../src/logbook.mjs';

import { catalog, T, u, house, infantry, world, home, road, civilians, brief, scene } from './commander-world.mjs';

// ---- Brief ----
test('brief: unit cards say what each type can do; squads keep their ids between turns', () => {
  const x = scene(), b = brief(x);
  const card = (id) => b.cards.find((c) => c.id === id);
  assert.ok(card('E2').tags.includes('can_garrison')); assert.equal(card('E2').range, 4); assert.equal(card('E2').maxHp, 125);
  assert.deepEqual(Object.keys(card('E2').dps), ['infantry', 'armor', 'building', 'air']);
  assert.ok(card('E2').dps.infantry > card('E2').dps.building, 'rifles are for infantry');
  assert.ok(card('NASAM').tags.includes('anti_air_only')); assert.equal(card('NASAM').range, 0); assert.equal(card('NASAM').airRange, 12);
  assert.equal(card('GAPILL').kind, 'defense'); assert.equal(card('GAPILL').range, 5.5);
  assert.ok(card('SENGINEER').tags.includes('engineer') && card('SENGINEER').tags.includes('unarmed'));
  assert.deepEqual(unitCard('CATEXS', T.Building, catalog, x.api).tags, ['garrisonable(5)']);
  // Two squads: the 18 conscripts at the front, the 4 at home. Ids survive a move of a few tiles.
  const ids = b.squads.map((q) => [q.id, q.n]);
  assert.deepEqual(ids, [['S1', 18], ['S2', 4]]);
  for (const s of x.self) if (s.id >= 10 && s.id < 28) s.tile = { rx: s.tile.rx + 3, ry: s.tile.ry - 2 };
  x.self.push(...infantry(80, 3, 130, 140));
  const again = brief(x);
  assert.deepEqual(again.squads.map((q) => [q.id, q.n]), [['S1', 18], ['S2', 4], ['S3', 3]], 'old ids kept, the new group gets a new one');
  assert.equal(again.squads[0].hpPct, 100, 'hpPct is percent of maximum health');
});

test('brief: legal ids, houses next to enemy defenses, hp as current/maximum, only useful neutral buildings', () => {
  const x = scene(), b = brief(x);
  assert.deepEqual(b.legal.squads, ['S1', 'S2']);
  for (const id of [1655, 1656, 1647, 1593, 1770, 990]) assert.ok(b.legal.attackTargets.includes(id), `#${id} may be attacked`);
  assert.deepEqual(b.legal.houses.sort(), [1633, 1638, 1664]); assert.deepEqual(b.legal.huts, [1607]);
  assert.ok(b.legal.captures.includes(1700), 'the oil derrick can be captured'); assert.deepEqual(b.legal.produce, ['E2', 'SENGINEER', 'ADOG', 'NALASR', 'NAPOWR']);
  const pill = b.enemyBuildings.find((e) => e.id === 1655);
  assert.equal(pill.hp, '400/400'); assert.equal(pill.range, 5.5); assert.equal(pill.houses[0].house, 1638); assert.equal(pill.houses[0].room, 5);
  assert.equal(b.enemyBuildings.find((e) => e.id === 1647).antiAirOnly, true, 'the Patriot is marked anti-air only');
  const neutral = b.enemyBuildings.filter((e) => e.owner === 'neutral').map((e) => e.id).sort((a, c) => a - c);
  assert.deepEqual(neutral, [990, 1700], 'only the objective and the capturable derrick; no houses, hut or flag');
  assert.equal(b.objective.target.id, 990);
});

// ---- Request and validation ----
test('commander schema enums come from the legal lists; invalid orders are refused with a reason, valid ones stand', () => {
  const legal = { squads: ['S1', 'S2'], attackTargets: [1655], houses: [1638], huts: [1607], captures: [1700], produce: ['E2'] };
  const schema = commanderSchema(legal);
  assert.deepEqual(schema.properties.squads.items.properties.squad.enum, ['S1', 'S2']);
  assert.deepEqual(schema.properties.production.items.properties.item.enum, ['E2']);
  assert.deepEqual(schema.properties.engineers.items.properties.target.enum, [1700, 1607]);
  const reply = (args) => ({ model: 'gpt-x', choices: [{ message: { tool_calls: [{ function: { name: COMMAND_TOOL, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 3000, completion_tokens: 200 } });
  const r = parseCommanderResponse(reply({ note: 'Take the pillbox from cover.', squads: [
    { squad: 'S1', action: 'garrison', target: 1638, reason: 'cover' }, { squad: 'S9', action: 'move', x: 1, y: 1 }, { squad: 'S2', action: 'attack', target: 4242 },
    { squad: 'S2', action: 'garrison', target: 1664 }, { squad: 'S2', action: 'move' }, { squad: 'S2', action: 'attack_move', x: 60, y: 50 }],
    production: [{ item: 'E2', count: 9 }, { item: 'HTNK', count: 1 }], engineers: [{ action: 'capture', target: 1655 }, { action: 'repair_bridge', target: 1607 }] }), legal);
  assert.deepEqual(r.orders.squads, [{ squad: 'S1', action: 'garrison', target: 1638, reason: 'cover' }, { squad: 'S2', action: 'attack_move', x: 60, y: 50, reason: '' }]);
  assert.deepEqual(r.rejected.map((o) => o.reason), ['unknown squad', 'unknown attack target', 'unknown house', 'missing coordinates', 'not producible now', 'not capturable']);
  assert.deepEqual(r.orders.production, [{ item: 'E2', count: 5, reason: '' }], 'count capped at 5');
  assert.deepEqual(r.orders.engineers, [{ action: 'repair_bridge', target: 1607, reason: '' }]);
  assert.equal(r.usage.input_tokens, 3000);
  // A JSON reply (call style "json", or the retry after prose) has the same fields; wrappers are tolerated.
  const json = buildCommanderRequest({ model: 'm', brief: { tick: 1, legal }, mode: 'json' });
  assert.equal(json.response_format.type, 'json_object'); assert.equal(json.tools, undefined); assert.match(json.messages[0].content, /Reply with only one JSON object/);
  assert.doesNotMatch(json.messages[1].content, /legal/, 'the legal lists are for validation, not shown twice');
  const wrapped = parseCommanderResponse({ choices: [{ message: { content: '```json\n{"issue_orders":{"note":"n","squads":[{"squad":"S1","action":"retreat"}]}}\n```' } }] }, legal);
  assert.deepEqual(wrapped.orders.squads, [{ squad: 'S1', action: 'retreat', reason: '' }]);
  assert.throws(() => parseCommanderResponse({ choices: [{ message: { content: 'I would garrison the house.' } }] }, legal), /无法解析/);
  assert.throws(() => prepareBrief({ mode: 'commander', brief: [] }), /指挥请求/);
  assert.throws(() => prepareBrief({ mode: 'commander', brief: { pad: 'x'.repeat(200001) } }), /指挥请求/);
});

// ---- Background ----
const extension = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' };
const sender = { id: 'test-extension', frameId: 0, documentId: 'document-1', url: 'https://staging.wangerhuoda.com/', tab: { id: 7 } };
const openaiSettings = { provider: 'openai', openaiBase: 'https://relay.example.com/v1', openaiKey: 'sk-test-only', openaiModel: 'gpt-test', apiKey: 'jev-secret', strategyMode: 'commander' };
function mockChrome(settings) {
  const data = { local: { settings: { ...DEFAULTS, ...settings } }, session: {} }, scripts = [];
  const area = (name) => ({ setAccessLevel: async () => {}, get: async (key) => structuredClone(key === null ? data[name] : { [key]: data[name][key] }), set: async (values) => Object.assign(data[name], structuredClone(values)), remove: async (key) => { for (const k of Array.isArray(key) ? key : [key]) delete data[name][k]; } });
  const c = { storage: { local: area('local'), session: area('session') }, runtime: { id: 'test-extension', getURL: (p) => 'chrome-extension://test-extension/' + p, onMessage: { addListener: () => {} } }, permissions: { contains: async () => true },
    tabs: { get: async () => ({ id: 7, url: sender.url, title: '王二火大' }), query: async () => [], sendMessage: async () => ({ ok: true }), onUpdated: { addListener: () => {} }, onRemoved: { addListener: () => {} } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} }, downloads: { download: async () => 1 },
    scripting: { executeScript: async (x) => { scripts.push(x); return [{ documentId: sender.documentId, result: x.args?.[0] === 'start' ? { running: true } : x.args?.[0] === 'stop' ? { running: false } : { available: true, running: !!data.session['session:7']?.running } }]; } } };
  return { c, data, scripts };
}
const commandBody = (tick = 12000) => ({ mode: 'commander', brief: { tick, squads: [{ id: 'S1', n: 18 }], legal: { squads: ['S1'], houses: [1638], attackTargets: [1655], produce: ['E2'], huts: [], captures: [] } } });
const orderReply = (args, extra = {}) => new Response(JSON.stringify({ model: 'gpt-test-2', choices: [{ message: { tool_calls: [{ function: { name: COMMAND_TOOL, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 4000, completion_tokens: 150 }, ...extra }));

test('background: a commander turn goes to the chat endpoint with a 90 s budget and is logged without the key', async () => {
  const mock = mockChrome(openaiSettings), calls = [];
  let busyFor;
  const app = createBackground(mock.c, { fetchImpl: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), auth: options.headers.Authorization });
    busyFor = mock.data.session['session:7'].busyUntil - Date.now();
    return orderReply({ note: 'Siege the pillbox.', squads: [{ squad: 'S1', action: 'garrison', target: 1638, reason: 'cover' }, { squad: 'S7', action: 'retreat' }], production: [{ item: 'E2', count: 5 }] });
  } });
  await app.ready; await app.handle({ type: 'START', tabId: 7 }, extension);
  const start = mock.scripts.find((x) => x.args?.[0] === 'start').args[1];
  assert.equal(start.commander, true); assert.equal(start.requestTimeoutMs, 95000, 'the page waits a little longer than the 90 s request');
  const s = await app.getSession(7);
  assert.equal(s.strategyMode, 'commander');
  const result = await app.handle({ type: 'DECIDE', token: s.token, body: commandBody() }, sender);
  assert.equal(calls[0].url, 'https://relay.example.com/v1/chat/completions'); assert.equal(calls[0].auth, 'Bearer sk-test-only');
  assert.equal(calls[0].body.tools[0].function.name, COMMAND_TOOL); assert.deepEqual(calls[0].body.tools[0].function.parameters.properties.squads.items.properties.squad.enum, ['S1']);
  assert.ok(busyFor > 90000 && busyFor <= 94000, `busy for the 90 s budget (${busyFor})`);
  assert.deepEqual(result.orders.squads.map((o) => o.squad), ['S1']); assert.deepEqual(result.rejected.map((o) => o.reason), ['unknown squad']);
  assert.ok(Number.isFinite(result.latencyMs));
  const after = await app.getSession(7);
  assert.equal(after.decisions, 1); assert.equal(after.inputTokens, 4000); assert.equal(after.outputTokens, 150); assert.equal(after.lastTick, 12000);
  const { entries, stats } = await app.handle({ type: 'LOG_EXPORT' }, extension);
  const entry = entries.find((e) => e.kind === 'command');
  assert.equal(entry.tick, 12000); assert.equal(entry.model, 'gpt-test-2'); assert.equal(entry.inputTokens, 4000); assert.equal(entry.note, 'Siege the pillbox.');
  assert.ok(entry.briefChars > 20); assert.deepEqual(entry.orders.map((o) => `${o.kind}:${o.squad ?? o.item}`), ['squad:S1', 'production:E2']); assert.equal(entry.rejected[0].reason, 'unknown squad');
  assert.equal(stats.commands.count, 1); assert.equal(stats.commands.rejected, 1); assert.ok(stats.commands.latencyAvg !== null);
  // The page reports what it carried out; the popup's recent activity shows it.
  await app.handle({ type: 'EVENT', token: s.token, event: { kind: 'command', tick: 12400, sourceTick: 12000, note: 'Siege the pillbox.', choice: 'S1 garrison #1638 ✓; E2×5 ✓',
    description: '指挥：S1 garrison #1638 ✓; E2×5 ✓ — Siege the pillbox.', results: [{ kind: 'squad', squad: 'S1', action: 'garrison', target: 1638, accepted: true }, { kind: 'production', item: 'E2', count: 5, accepted: true }], rejected: [] } }, sender);
  const status = await app.handle({ type: 'GET_STATUS', tabId: 7 }, extension);
  assert.match(status.events[0].text, /^指挥：S1 garrison #1638/); assert.equal(status.events[0].kind, 'command'); assert.equal(status.acceptedActions, 2);
  await app.handle({ type: 'STOP', tabId: 7 }, extension);
  const [m] = (await app.handle({ type: 'MATCHES_LIST' }, extension)).matches;
  assert.equal(m.strategyMode, 'commander'); assert.equal(m.inputTokens, 4000);
  assert.doesNotMatch(JSON.stringify([entries, m]), /sk-test-only|jev-secret/);
});

test('background: forced tool_choice refused → auto; prose → one JSON retry shaped like issue_orders', async () => {
  const mock = mockChrome({ ...openaiSettings, openaiModel: 'deepseek-flash' }), sent = [];
  let prose = true;
  const app = createBackground(mock.c, { fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); sent.push(body.response_format ? 'json' : typeof body.tool_choice === 'object' ? 'forced' : 'auto');
    if (typeof body.tool_choice === 'object') return new Response(JSON.stringify({ error: { message: 'deepseek-reasoner does not support this tool_choice' } }), { status: 400 });
    if (!body.response_format && prose) return new Response(JSON.stringify({ choices: [{ message: { content: 'S1 should garrison the house.' } }] }));
    if (body.response_format) return new Response(JSON.stringify({ choices: [{ message: { content: '{"note":"cover","squads":[{"squad":"S1","action":"garrison","target":1638}]}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    return orderReply({ note: 'n', squads: [{ squad: 'S1', action: 'defend_base' }] });
  } });
  await app.ready; await app.handle({ type: 'START', tabId: 7 }, extension);
  const s = await app.getSession(7);
  const first = await app.handle({ type: 'DECIDE', token: s.token, body: commandBody() }, sender);
  assert.deepEqual(sent, ['forced', 'auto', 'json']); assert.equal(first.orders.squads[0].action, 'garrison');
  prose = false; await new Promise((r) => setTimeout(r, 5));
  const second = await app.handle({ type: 'DECIDE', token: s.token, body: commandBody(12200) }, sender);
  assert.deepEqual(sent.slice(3), ['auto'], 'the refusal is remembered'); assert.equal(second.orders.squads[0].action, 'defend_base');
  assert.equal((await app.getSession(7)).failures, 0);
});

test('background: commander requests need the OpenAI source; the setting is saved, shown and stops a running session when changed', async () => {
  const jev = mockChrome({ apiKey: 'k', strategyMode: 'commander' });
  const jevApp = createBackground(jev.c, { fetchImpl: async () => { throw new Error('must not be called'); } });
  await jevApp.ready; await jevApp.handle({ type: 'START', tabId: 7 }, extension);
  const jevStart = jev.scripts.find((x) => x.args?.[0] === 'start').args[1];
  assert.equal(jevStart.commander, undefined, 'Jev always answers choice questions');
  const js = await jevApp.getSession(7);
  await assert.rejects(jevApp.handle({ type: 'DECIDE', token: js.token, body: commandBody() }, sender), /OpenAI 兼容/);
  assert.equal(activeProvider({ provider: 'local', strategyMode: 'commander' }).strategy, 'choices');
  assert.equal(validateSettings({ ...DEFAULTS, strategyMode: 'bogus' }).strategyMode, 'choices');
  assert.equal(publicSettings({ ...DEFAULTS, strategyMode: 'commander' }).strategyMode, 'commander');
  const mock = mockChrome({ ...openaiSettings, strategyMode: 'choices' });
  const app = createBackground(mock.c, { fetchImpl: async () => orderReply({ note: '', squads: [] }) });
  await app.ready; await app.handle({ type: 'START', tabId: 7 }, extension);
  assert.equal(mock.scripts.find((x) => x.args?.[0] === 'start').args[1].commander, undefined);
  await app.handle({ type: 'SAVE_SETTINGS', settings: { maxDecisions: 99 } }, extension);
  assert.equal((await app.getSession(7)).running, true, 'an unrelated change keeps it running');
  const saved = await app.handle({ type: 'SAVE_SETTINGS', settings: { strategyMode: 'commander' } }, extension);
  assert.equal(saved.strategyMode, 'commander'); assert.equal(mock.data.local.settings.strategyMode, 'commander');
  const stopped = await app.getSession(7);
  assert.equal(stopped.running, false); assert.equal(stopped.reason, 'settings_changed');
});

// ---- Logbook ----
test('log: command events keep the note and every order bounded; stats count turns, latency and refused orders', () => {
  const long = 'x'.repeat(900);
  const e = eventEntry({ kind: 'command', tick: 5, sourceTick: 3, note: long, results: Array.from({ length: 30 }, (_, i) => ({ kind: 'squad', squad: `S${i}`, action: 'move', x: 1, y: 2, accepted: false, reason: long })),
    rejected: [{ kind: 'squad', squad: 'S9', reason: 'unknown squad' }], auto: [], apiKey: 'nope' }, 1);
  assert.equal(e.executed, true); assert.equal(e.note.length, 400); assert.equal(e.orders.length, 20); assert.equal(e.orders[0].reason.length, 200); assert.equal(e.rejected[0].reason, 'unknown squad');
  assert.doesNotMatch(JSON.stringify(e), /nope/);
  const model = commandEntry({ at: 2, tick: 3, provider: 'openai', model: 'm', latencyMs: 30000, usage: { input_tokens: 10, output_tokens: 2 }, briefChars: 9000, orders: { note: 'n', squads: [{ squad: 'S1', action: 'hold', x: 1, y: 1 }] }, rejected: [{ reason: 'a' }, { reason: 'b' }] });
  const stats = logStats([model, { ...model, latencyMs: 50000, rejected: [] }, e]);
  assert.deepEqual({ ...stats.commands }, { count: 2, latencyAvg: 40000, rejected: 2, executed: 0, notExecuted: 20, autoDefense: 0 });
  assert.equal(stats.latency.avg, 40000); assert.equal(stats.usage.inputTokens, 20);
});

// ---- Player ----
const tickAll = async (x, t) => { x.setTick(t); x.api._tick?.({}); await new Promise((r) => setTimeout(r, 2)); };
async function commanderPlayer(x, reply, extra = {}) {
  const requests = [];
  let release;
  const player = await attachJevPlayer(x.api, { catalog, commander: true, intervalMs: 1e9, wakeIntervalMs: 0, microIntervalMs: 0, maxDecisions: 50, autoCamera: false, objective: '摧毁五角大楼', ...extra,
    requestDecision: async (body) => { requests.push(body); if (extra.hold) await new Promise((r) => { release = r; }); return typeof reply === 'function' ? reply(body, requests.length) : reply; } });
  return { player, requests, release: () => release?.() };
}

test('player: the first turn is immediate, then every 180 ticks, never while a request is out, sooner when the base is attacked', async () => {
  const x = scene();
  const { player, requests, release } = await commanderPlayer(x, { orders: { note: '', squads: [], production: [], engineers: [] }, rejected: [], latencyMs: 10 }, { hold: true });
  try {
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(requests.length, 1); assert.equal(requests[0].mode, 'commander'); assert.equal(requests[0].brief.trigger, 'first');
    assert.deepEqual(requests[0].brief.legal.squads, ['S1', 'S2']);
    await tickAll(x, 12000 + COMMAND_INTERVAL_TICKS + 50);
    assert.equal(requests.length, 1, 'no second request while the first is out');
    release(); await new Promise((r) => setTimeout(r, 5));
    await tickAll(x, 12000 + COMMAND_INTERVAL_TICKS + 60);
    assert.equal(requests.length, 2, 'overdue: asked right after the reply'); assert.equal(requests[1].brief.trigger, 'interval');
    release(); await new Promise((r) => setTimeout(r, 5));
    await tickAll(x, 12000 + COMMAND_INTERVAL_TICKS + 120);
    assert.equal(requests.length, 2, 'not before another 180 ticks');
    // An enemy tank rolls up to the yard: the next turn does not wait for the interval.
    x.enemies.push(u(900, 'HTNK', T.Vehicle, 103, 121));
    await tickAll(x, 12000 + COMMAND_INTERVAL_TICKS + 120 + INTENT_REFRESH_TICKS);
    await tickAll(x, 12000 + COMMAND_INTERVAL_TICKS + 121 + INTENT_REFRESH_TICKS);
    assert.equal(requests.length, 3); assert.equal(requests[2].brief.trigger, 'base_attacked');
    release(); await new Promise((r) => setTimeout(r, 5));
    assert.equal(player.status.decisions, 3); assert.equal(player.memory.command.lastTick, 12000 + COMMAND_INTERVAL_TICKS + 120 + INTENT_REFRESH_TICKS, 'asked on the pass that saw the attack');
    assert.ok(player.status.events.filter((e) => e.kind === 'command').length >= 3);
  } finally { player.stop('manual'); release(); }
});

test('player: losses of more than half a squad and a destroyed attack target bring the next turn forward', () => {
  const x = scene(), emit = () => {};
  brief(x);
  x.memory.command = { lastTick: 12000, squadsAtTurn: new Map(x.memory.squads), sawEnemyBase: true, sawObjective: true };
  applyOrders(x.api, catalog, x.memory, emit, { orders: { squads: [{ squad: 'S1', action: 'attack', target: 1770 }] } }, 12000);
  x.setTick(12050);
  // Four of S2 inside a house are not losses.
  const inside = x.self.filter((s) => s.id >= 40 && s.id < 44).map((s) => s.id);
  for (let i = x.self.length - 1; i >= 0; i--) if (inside.includes(x.self[i].id)) x.self.splice(i, 1);
  x.neutral.find((n) => n.id === 1633).garrison = { count: 4, capacity: 5, canOccupy: true, unitIds: inside };
  maintainCommand(x.api, catalog, x.memory, emit, true);
  assert.equal(x.memory.command.urgent, undefined, 'entering a house is not a loss');
  x.self.splice(x.self.findIndex((s) => s.id === 10), 10);
  x.setTick(12060); maintainCommand(x.api, catalog, x.memory, emit, true);
  assert.equal(x.memory.command.urgent, 'squad_losses');
  x.memory.command.urgent = undefined;
  x.enemies.splice(x.enemies.findIndex((e) => e.id === 1770), 1);
  x.setTick(12100); maintainCommand(x.api, catalog, x.memory, emit, true);
  assert.equal(x.memory.command.urgent, 'target_destroyed'); assert.ok(x.memory.intents.get('S1').targetGone);
});

test('player: garrison sends only as many infantry as the house holds, as a siege; the rest stop instead of charging', () => {
  const x = scene(); brief(x);
  const results = applyOrders(x.api, catalog, x.memory, () => {}, { orders: { note: 'cover', squads: [{ squad: 'S1', action: 'garrison', target: 1638, reason: 'take the pillbox from cover' }] }, rejected: [] }, 12000);
  assert.equal(results[0].accepted, true); assert.equal(results[0].units, 18); assert.equal(results[0].ordered, 5);
  const occupy = x.calls.filter((c) => c[0] === 'order' && c[2].type === x.api.OrderType.Occupy);
  assert.equal(occupy.length, 1); assert.equal(occupy[0][1].length, 5, 'capacity 5'); assert.deepEqual(occupy[0][2].target, { objectId: 1638 });
  const nearest = [...x.self].filter((s) => s.id >= 10 && s.id < 28).sort((a, b) => Math.hypot(a.tile.rx - 55, a.tile.ry - 49) - Math.hypot(b.tile.rx - 55, b.tile.ry - 49)).slice(0, 5).map((s) => s.id);
  assert.deepEqual([...occupy[0][1]].sort(), nearest.sort(), 'the closest ones go');
  const stop = x.calls.find((c) => c[0] === 'order' && c[2].type === x.api.OrderType.Stop);
  assert.equal(stop[1].length, 13, 'the other thirteen stay put');
  assert.ok(!x.calls.some((c) => c[0] === 'attack' || c[0] === 'attackMove'), 'nobody charges the pillbox');
  assert.deepEqual(x.memory.garrisons.get(1638), { purpose: 'siege', defenseId: 1655, since: 12000 }, 'released automatically once the pillbox is gone');
  // Maintenance does not send more while the crew is on its way, and never re-stops the rest.
  x.setTick(12100); maintainCommand(x.api, catalog, x.memory, () => {}, true);
  assert.equal(x.calls.filter((c) => c[0] === 'order').length, 2);
  // A house far from any defense is a forward strongpoint.
  const y = scene(); brief(y);
  applyOrders(y.api, catalog, y.memory, () => {}, { orders: { squads: [{ squad: 'S2', action: 'garrison', target: 1633 }] } }, 12000);
  assert.equal(y.memory.garrisons.get(1633).purpose, 'forward');
  const full = scene({ neutral: [house(1638, 55, 49, 5)] }); brief(full);
  const r = applyOrders(full.api, catalog, full.memory, () => {}, { orders: { squads: [{ squad: 'S1', action: 'garrison', target: 1638 }] } }, 12000);
  assert.deepEqual([r[0].accepted, r[0].reason], [false, 'house_full']);
});

test('player: attack on a target out of sight goes to where it was last seen; the same intent again only reaches new or idle members', () => {
  const x = scene({ visible: (px, py) => !(px === 60 && py === 30) });
  x.memory.enemyBuildings.set(1593, { id: 1593, name: 'GACNST', x: 60, y: 30, tick: 11000 });
  x.enemies.splice(x.enemies.findIndex((e) => e.id === 1593), 1);
  brief(x);
  applyOrders(x.api, catalog, x.memory, () => {}, { orders: { squads: [{ squad: 'S1', action: 'attack', target: 1593 }] } }, 12000);
  const moves = x.calls.filter((c) => c[0] === 'attackMove');
  assert.equal(moves.length, 1); assert.deepEqual(moves[0].slice(2), [60, 30]); assert.equal(moves[0][1].length, 18);
  // Visible target: direct attack. Units busy fighting are left alone when the order is repeated.
  const y = scene(); brief(y);
  applyOrders(y.api, catalog, y.memory, () => {}, { orders: { squads: [{ squad: 'S1', action: 'attack', target: 1655 }] } }, 12000);
  assert.equal(y.calls.filter((c) => c[0] === 'attack' && c[2] === 1655)[0][1].length, 18);
  y.calls.length = 0;
  y.self.find((s) => s.id === 12).isIdle = true;
  y.self.push(u(30, 'E2', T.Infantry, 61, 55));
  y.setTick(12100);
  const again = applyOrders(y.api, catalog, y.memory, () => {}, { orders: { squads: [{ squad: 'S1', action: 'attack', target: 1655 }] } }, 12100);
  assert.equal(again[0].continues, true);
  assert.deepEqual(y.calls.filter((c) => c[0] === 'attack').flatMap((c) => c[1]).sort(), [12, 30], 'only the idle one and the newcomer');
  assert.equal(y.memory.intents.get('S1').since, 12000, 'the intent keeps its clock');
});

test('player: move, hold, scout, retreat and defend_base', () => {
  const x = scene(); brief(x);
  applyOrders(x.api, catalog, x.memory, () => {}, { orders: { squads: [{ squad: 'S1', action: 'hold', x: 62, y: 60 }, { squad: 'S2', action: 'scout', x: 20, y: 20 }] } }, 12000);
  assert.equal(x.calls.find((c) => c[0] === 'move' && c[2] === 62)[1].length, 18);
  assert.deepEqual(x.calls.find((c) => c[0] === 'move' && c[2] === 20)[1].length, 1, 'one scout');
  // Arrived and idle: hold means no further orders.
  for (const s of x.self) if (s.id >= 10 && s.id < 28) { s.tile = { rx: 62, ry: 60 }; s.isIdle = true; }
  x.calls.length = 0; x.setTick(12100); maintainCommand(x.api, catalog, x.memory, () => {}, true);
  assert.ok(!x.calls.some((c) => c[0] === 'move' && c[2] === 62));
  assert.ok(x.memory.focusSkip.has(x.memory.intents.get('S2').scoutId), 'the scout does not stop to fight on the way');
  const y = scene({ enemies: [...road(), u(900, 'HTNK', T.Vehicle, 103, 121)] }); brief(y);
  applyOrders(y.api, catalog, y.memory, () => {}, { orders: { squads: [{ squad: 'S2', action: 'defend_base' }, { squad: 'S1', action: 'retreat' }] } }, 12000);
  assert.deepEqual(y.calls.find((c) => c[0] === 'attack')[2], 900, 'defenders go for the raider');
  assert.ok(y.calls.some((c) => c[0] === 'move' && c[1].length === 18), 'the front squad walks home');
  assert.ok(y.memory.instinctSkip.has(10), 'a retreating squad is not turned round by the reflexes');
  // Defenders keep their reflexes against raiders, but never rush a fixed defense: they only step back from it.
  assert.ok(!y.memory.instinctSkip.has(40) && y.memory.noRush.has(40));
});

test('player: base under attack for 450 ticks with no defend_base order → the nearest squad defends it, and the report says so', () => {
  const x = scene(); brief(x);
  const events = [];
  x.memory.command = { lastTick: 12000, sawEnemyBase: true, sawObjective: true };
  applyOrders(x.api, catalog, x.memory, () => {}, { orders: { squads: [{ squad: 'S1', action: 'attack', target: 1655 }] } }, 12000);
  x.enemies.push(u(900, 'HTNK', T.Vehicle, 103, 121));
  x.setTick(12050); maintainCommand(x.api, catalog, x.memory, (e) => events.push(e), true);
  assert.equal(x.memory.command.urgent, 'base_attacked'); assert.equal(x.memory.intents.has('S2'), false);
  x.setTick(12050 + AUTO_DEFENSE_TICKS - 1); maintainCommand(x.api, catalog, x.memory, (e) => events.push(e), true);
  assert.equal(x.memory.intents.has('S2'), false, 'the model still has time');
  x.setTick(12050 + AUTO_DEFENSE_TICKS); maintainCommand(x.api, catalog, x.memory, (e) => events.push(e), true);
  const intent = x.memory.intents.get('S2');
  assert.equal(intent.action, 'defend_base'); assert.equal(intent.auto, true);
  assert.equal(x.memory.intents.get('S1').action, 'attack', 'the far squad keeps its attack');
  assert.match(x.memory.lastPlanReport.auto[0].result, /自动回防/);
  const note = events.find((e) => e.kind === 'command');
  assert.equal(note.auto[0].squad, 'S2'); assert.ok(x.calls.some((c) => c[0] === 'attack' && c[2] === 900));
  x.setTick(12050 + AUTO_DEFENSE_TICKS + 100); maintainCommand(x.api, catalog, x.memory, (e) => events.push(e), true);
  assert.equal(events.filter((e) => e.kind === 'command').length, 1, 'once per attack');
  assert.match(brief(x).squads.find((q) => q.id === 'S2').intent, /^defend_base \(automatic\)/, 'the model sees it was automatic');
  // A reply to a brief sent before the automatic defense keeps the note for the next brief.
  applyOrders(x.api, catalog, x.memory, () => {}, { orders: { squads: [] } }, 12040);
  assert.equal(x.memory.lastPlanReport.auto[0].squad, 'S2');
  applyOrders(x.api, catalog, x.memory, () => {}, { orders: { squads: [] } }, 12600);
  assert.equal(x.memory.lastPlanReport.auto, undefined, 'already shown once it predates the brief');
});

test('player: production and engineers run with clear reasons when they cannot', () => {
  const x = scene(); brief(x);
  assert.deepEqual(executeProduction(x.api, catalog, x.memory, { item: 'E2', count: 5 }), { accepted: true, count: 5 });
  assert.deepEqual(x.calls.at(-1), ['produce', 'E2', 5]);
  const build = executeProduction(x.api, catalog, x.memory, { item: 'NALASR', count: 1 });
  assert.equal(build.accepted, true); assert.ok(x.memory.plannedSites.has('NALASR'), 'placed by the extension when ready');
  assert.deepEqual(executeProduction(x.api, catalog, x.memory, { item: 'HTNK' }), { accepted: false, reason: 'not_producible' });
  x.setCredits(250);
  assert.deepEqual(executeProduction(x.api, catalog, x.memory, { item: 'E2', count: 5 }), { accepted: true, count: 2, reason: 'credits_limited' });
  x.setCredits(50);
  assert.deepEqual(executeProduction(x.api, catalog, x.memory, { item: 'E2', count: 1 }), { accepted: false, reason: 'insufficient_credits' });
  const busy = scene({ queues: [{ type: 0, name: 'NAPOWR' }], credits: 5000 }); brief(busy);
  assert.deepEqual(executeProduction(busy.api, catalog, busy.memory, { item: 'NAPOWR' }), { accepted: false, reason: 'queue_busy' });
  const full = scene({ queues: Array.from({ length: 5 }, () => ({ type: 2, name: 'E2' })) }); brief(full);
  assert.deepEqual(executeProduction(full.api, catalog, full.memory, { item: 'E2', count: 2 }), { accepted: false, reason: 'queue_full' });
  const repair = executeEngineer(x.api, catalog, x.memory, { action: 'repair_bridge', target: 1607 });
  assert.deepEqual(repair, { accepted: true, engineer: 60 });
  assert.deepEqual(x.calls.at(-1), ['order', [60], { type: x.api.OrderType.Repair, target: { objectId: 1607 } }]);
  assert.deepEqual(executeEngineer(x.api, catalog, x.memory, { action: 'capture', target: 1700 }), { accepted: false, reason: 'no_idle_engineer' }, 'the only engineer is busy');
  assert.deepEqual(executeEngineer(x.api, catalog, x.memory, { action: 'capture', target: 4242 }), { accepted: false, reason: 'target_no_longer_visible' });
  const cap = scene(); brief(cap);
  assert.equal(executeEngineer(cap.api, catalog, cap.memory, { action: 'capture', target: 1700 }).accepted, true);
  assert.equal(cap.memory.specialTasks[0].action.kind, 'capture', 'followed up like any capture');
});

test('player: the last plan report shows results, refused orders, units left, the target now, and losses / kills since', () => {
  const x = scene(); brief(x);
  x.memory.ledger = { ownUnitsLost: 10, ownBuildingsLost: 0, enemyUnitsDestroyed: 20, enemyBuildingsDestroyed: 1 };
  applyOrders(x.api, catalog, x.memory, () => {}, { orders: { note: 'Push.', squads: [{ squad: 'S1', action: 'attack', target: 1655 }, { squad: 'S5', action: 'retreat' }], production: [{ item: 'HTNK', count: 1 }] },
    rejected: [{ kind: 'squad', squad: 'S9', action: 'move', reason: 'unknown squad' }] }, 12000);
  const r0 = x.memory.lastPlanReport;
  assert.equal(r0.note, 'Push.');
  assert.deepEqual(r0.orders.map((o) => o.result), ['accepted', 'not executed: squad_gone', 'not executed: not_producible']);
  assert.equal(r0.rejected[0].reason, 'unknown squad');
  x.self.splice(x.self.findIndex((s) => s.id === 10), 4);
  x.enemies.find((e) => e.id === 1655).hitPoints = 120;
  x.memory.ledger = { ownUnitsLost: 14, ownBuildingsLost: 0, enemyUnitsDestroyed: 22, enemyBuildingsDestroyed: 1 };
  x.setTick(12200); maintainCommand(x.api, catalog, x.memory, () => {}, true);
  const r = refreshPlanReport(x.api, x.memory);
  assert.equal(r.orders[0].unitsAtOrder, 18); assert.equal(r.orders[0].nowUnits, 14); assert.equal(r.orders[0].targetNow, '120/400');
  assert.deepEqual(r.sinceThen, { lost: 4, killed: 2 });
  const b = brief(x);
  assert.equal(b.lastPlan.orders[0].targetNow, '120/400', 'the model reads it in the next brief');
  x.enemies.splice(x.enemies.findIndex((e) => e.id === 1655), 1);
  x.setTick(12300); maintainCommand(x.api, catalog, x.memory, () => {}, true);
  assert.equal(refreshPlanReport(x.api, x.memory).orders[0].targetNow, 'destroyed or gone');
});

test('player: a squad that disappears loses its intent; a part split off carries it on', () => {
  const x = scene(); brief(x);
  applyOrders(x.api, catalog, x.memory, () => {}, { orders: { squads: [{ squad: 'S2', action: 'hold', x: 97, y: 110 }, { squad: 'S1', action: 'attack_move', x: 60, y: 40 }] } }, 12000);
  for (let i = x.self.length - 1; i >= 0; i--) if (x.self[i].id >= 40 && x.self[i].id < 44) x.self.splice(i, 1);
  // Six of S1 wander far off: they form their own squad and keep S1's intent.
  for (const s of x.self) if (s.id >= 22 && s.id < 28) s.tile = { rx: s.tile.rx + 40, ry: s.tile.ry + 40 };
  const squads = refreshSquads(x.api, catalog, x.memory);
  assert.equal(x.memory.intents.has('S2'), false, 'S2 is gone and so is its intent');
  assert.deepEqual(squads.map((q) => [q.id, q.members.length]), [['S1', 12], ['S3', 6]]);
  assert.equal(x.memory.intents.get('S3').action, 'attack_move'); assert.equal(x.memory.intents.get('S3').splitFrom, 'S1');
  assert.equal(orderSquad(x.api, catalog, x.memory, squads[1], x.memory.intents.get('S3')).accepted, true);
});

test('player: formSquads ids are stable even when the biggest group changes', () => {
  const memory = {};
  const a = infantry(1, 5, 10, 10), b = infantry(20, 3, 50, 50);
  assert.deepEqual(formSquads([...a, ...b], memory).map((q) => q.id), ['S1', 'S2']);
  const more = [...b, ...infantry(30, 6, 52, 50)];
  const next = formSquads([...a, ...more], memory);
  assert.deepEqual(next.map((q) => [q.id, q.members.length]), [['S2', 9], ['S1', 5]]);
});
