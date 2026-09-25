// Persistent, bounded decision log kept in chrome.storage.local for later analysis.
// Records what the model was asked, what it chose, and what the executor did with it.
// Never stores credentials, session tokens or the raw battlefield state.
export const LOG_KEY = 'log';
export const LOG_MAX_ENTRIES = 2000;
export const LOG_MAX_CHARS = 4_000_000; // JSON size guard: storage.local is limited to ~10 MB
const short = (value, n) => typeof value === 'string' ? value.slice(0, n) : value == null ? '' : String(value).slice(0, n);
const number = n => typeof n === 'number' && Number.isFinite(n) ? n : null;

const afterCapture = (a) => a ? { afterCapture: { tick: number(a.tick), how: short(a.how, 16), lastHp: number(a.lastHp) } } : {};
// Compact snapshot of the state that was sent with a decision: numbers and flags only.
export function stateSummary(state = {}) {
  return {
    tick: number(state.tick), gameSeconds: number(state.gameSeconds),
    credits: number(state.self?.credits), freeCredits: number(state.uncommittedCredits), committedCredits: number(state.committedCredits),
    power: { total: number(state.self?.power?.total), drain: number(state.self?.power?.drain) },
    army: number(state.ownArmyCount), tanks: number(state.mobileTankCount), antiAir: number(state.antiAirCount), harvesters: number(state.harvesters),
    health: number(state.averageArmyHealth), visibleEnemies: number(state.visibleEnemyCount), nearbyEnemies: number(state.nearbyEnemyCount),
    baseUnderAttack: state.baseUnderAttack === true,
    queues: (state.queues ?? []).slice(0, 8).map(q => ({ type: short(q.type, 12), items: (q.items ?? []).slice(0, 6).map(i => `${short(i.name, 20)}×${number(i.quantity) ?? 1}`) })),
    inventory: Object.fromEntries(Object.entries(state.inventory ?? {}).slice(0, 48).map(([k, u]) => [short(k, 20), number(u?.count) ?? 0])),
    investment: state.strategy?.investment ? { category: short(state.strategy.investment.category, 24), name: short(state.strategy.investment.name, 24) } : null,
    ready: state.forceReadiness ? state.forceReadiness.ready === true : null, readyReason: short(state.forceReadiness?.reason, 160),
    ...(state.objectiveTarget ? { objective: state.objectiveTarget.found === false
      ? { found: false, seen: (state.objectiveTarget.seen ?? []).slice(0, 30).map((n) => short(n, 60)) }
      : { found: true, id: number(state.objectiveTarget.id), label: short(state.objectiveTarget.label, 60), name: short(state.objectiveTarget.name, 40), done: !!state.objectiveTarget.done,
        ...(state.objectiveTarget.mode ? { mode: short(state.objectiveTarget.mode, 12) } : {}), ...(state.objectiveTarget.captured ? { captured: true } : {}), ...(state.objectiveTarget.lost ? { lost: true } : {}),
        ...(number(state.objectiveTarget.hp) !== null ? { hp: state.objectiveTarget.hp } : {}), ...(afterCapture(state.objectiveTarget.afterCapture)) } } : {}),
    escalation: number(state.combatAssessment?.level), recentLost: number(state.combatAssessment?.recentLost), recentKilled: number(state.combatAssessment?.recentKilled),
    hints: Object.fromEntries(Object.entries(state.recentChoices ?? {}).filter(([, h]) => h.stale || h.removed).map(([id, h]) => [short(id, 24), { streak: number(h.streak), lostSince: number(h.lostSince), killedSince: number(h.killedSince), removed: h.removed === true }])),
  };
}

export function decisionEntry({ at, tick, provider, model, latencyMs, usage, state, questions, answers }) {
  const groups = {};
  for (const [id, q] of Object.entries(questions ?? {})) {
    const a = answers?.[id];
    groups[id] = {
      instructions: short(q.instructions, 400),
      options: Object.fromEntries(Object.entries(q.criteria ?? {}).slice(0, 64).map(([k, v]) => [short(k, 60), short(v, 240)])),
      optionCount: Object.keys(q.criteria ?? {}).length,
      choice: short(a?.choice, 60), confidence: number(a?.confidence),
      probabilities: Object.fromEntries(Object.entries(a?.probabilities ?? {}).sort(([, x], [, y]) => y - x).slice(0, 8).map(([k, v]) => [short(k, 60), Math.round(v * 1000) / 1000])),
      ...(a?.reason ? { reason: short(a.reason, 200) } : {}), ...(a?.fallback ? { fallback: true } : {}),
    };
  }
  return { at, kind: 'decision', tick: number(tick), provider: short(provider, 12), model: short(model, 60), latencyMs: number(latencyMs), inputTokens: number(usage?.input_tokens), outputTokens: number(usage?.output_tokens), state: stateSummary(state), groups };
}

// Commander mode. One order as the log keeps it; both the model's orders (background) and the
// page's execution results (event) use this shape, bounded so a long plan cannot flood storage.
const orderLine = (o) => {
  const out = { kind: short(o?.kind, 12) };
  for (const k of ['squad', 'action', 'item']) if (o?.[k] != null && o[k] !== '') out[k] = short(o[k], 40);
  for (const k of ['target', 'x', 'y', 'count', 'units', 'ordered']) if (number(o?.[k]) !== null) out[k] = o[k];
  if (typeof o?.accepted === 'boolean') out.accepted = o.accepted;
  if (o?.auto) out.auto = true;
  if (o?.reason) out.reason = short(o.reason, 200);
  if (o?.result) out.result = short(o.result, 200);
  if (o?.why) out.why = short(o.why, 200);
  return out;
};
const orderLines = (list) => (Array.isArray(list) ? list : []).slice(0, 20).map(orderLine);
export function commandEntry({ at, tick, provider, model, latencyMs, usage, briefChars, orders, rejected }) {
  return { at, kind: 'command', tick: number(tick), provider: short(provider, 12), model: short(model, 60), latencyMs: number(latencyMs), inputTokens: number(usage?.input_tokens), outputTokens: number(usage?.output_tokens),
    briefChars: number(briefChars), note: short(orders?.note, 400),
    orders: orderLines([...(orders?.squads ?? []).map((o) => ({ kind: 'squad', ...o })), ...(orders?.production ?? []).map((o) => ({ kind: 'production', ...o })), ...(orders?.engineers ?? []).map((o) => ({ kind: 'engineer', ...o }))]),
    rejected: orderLines(rejected) };
}

export function eventEntry(e, at) {
  const kind = short(e?.kind, 24);
  const base = { at, kind, tick: number(e?.tick) };
  if (kind === 'action') return { ...base, question: short(e.question, 40), choice: short(e.choice, 60), accepted: e.accepted === true, reason: short(e.reason, 40), actionType: short(e.action?.type, 24), actionName: short(e.action?.name ?? e.action?.mode, 40), cost: number(e.action?.cost), confidence: number(e.confidence), latencyMs: number(e.latencyMs), ageTicks: number(e.ageTicks) };
  // The page's side of a commander turn: what was executed and why not. `executed` tells it apart
  // from the background's entry for the same turn.
  if (kind === 'command') return { ...base, executed: true, sourceTick: number(e.sourceTick), note: short(e.note, 400), orders: orderLines(e.results), rejected: orderLines(e.rejected), auto: orderLines(e.auto) };
  if (kind === 'stale') return { ...base, currentTick: number(e.currentTick), latencyMs: number(e.latencyMs) };
  if (kind === 'start') return { ...base, maxDecisions: number(e.maxDecisions), policy: short(e.policy, 40) };
  if (kind === 'stop') return { ...base, reason: short(e.reason, 40) };
  if (kind === 'outcome') return { ...base, result: short(e.result, 24),
    ...(Array.isArray(e.players) ? { players: e.players.slice(0, 16).map((p) => ({ name: short(p?.name, 30), allied: !!p?.allied, defeated: !!p?.defeated })) } : {}),
    ...(e.objective ? { objective: { id: number(e.objective.id), label: short(e.objective.label, 60), done: !!e.objective.done, captured: !!e.objective.captured, lost: !!e.objective.lost, hp: number(e.objective.hp), ...afterCapture(e.objective.afterCapture) } } : {}),
    ...(number(e.ownBuildings) !== null ? { ownBuildings: e.ownBuildings } : {}) };
  if (kind === 'error') return { ...base, message: short(e.message, 240) };
  if (kind === 'meta') return { ...base, pageTitle: short(e.pageTitle, 120), playerCount: number(e.playerCount), opponents: number(e.opponents), map: e.map && number(e.map.width) !== null ? { width: e.map.width, height: e.map.height } : null, startTick: number(e.startTick) };
  if (['place', 'micro', 'observed', 'camera'].includes(kind)) return { ...base, name: short(e.name, 40), text: short(e.description ?? e.purpose ?? e.message, 160) };
  return null; // observations are sampled by telemetry already; everything else is noise
}

export function appendEntries(entries, additions) {
  let next = [...(entries ?? []), ...additions].slice(-LOG_MAX_ENTRIES);
  let size = JSON.stringify(next).length;
  while (next.length > 1 && size > LOG_MAX_CHARS) { const dropped = next.splice(0, Math.max(1, Math.ceil(next.length * 0.1))); size -= JSON.stringify(dropped).length - 2; }
  return next;
}

const inc = (map, key, by = 1) => { map[key] = (map[key] ?? 0) + by; };
const top = (map, n = 8) => Object.fromEntries(Object.entries(map).sort(([, a], [, b]) => b - a).slice(0, n));

// Aggregate view for the popup and the export file.
export function logStats(entries = []) {
  const s = { entries: entries.length, from: null, to: null, sessions: 0, decisions: 0, failures: 0, stale: 0, latency: { avg: null, max: null }, usage: { inputTokens: 0, outputTokens: 0 }, fallbacks: 0, providers: {}, models: {},
    groups: {}, actions: { total: 0, accepted: 0, skipped: 0, waits: 0, byType: {}, skippedReasons: {}, acceptedProduce: {} }, outcomes: {}, errors: 0,
    commands: { count: 0, latencyAvg: null, rejected: 0, executed: 0, notExecuted: 0, autoDefense: 0 } };
  let latencySum = 0, latencyCount = 0, commandLatency = 0, commandTimed = 0;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    s.from ??= e.at; s.to = e.at;
    if (e.kind === 'session' && e.event === 'start') s.sessions++;
    else if (e.kind === 'failure') s.failures++;
    else if (e.kind === 'stale') s.stale++;
    else if (e.kind === 'error') s.errors++;
    else if (e.kind === 'outcome') inc(s.outcomes, e.result || 'unknown');
    else if (e.kind === 'decision') {
      s.decisions++; if (e.provider) inc(s.providers, e.provider); if (e.model) inc(s.models, e.model);
      s.usage.inputTokens += e.inputTokens ?? 0; s.usage.outputTokens += e.outputTokens ?? 0;
      if (e.latencyMs !== null) { latencySum += e.latencyMs; latencyCount++; s.latency.max = Math.max(s.latency.max ?? 0, e.latencyMs); }
      for (const [id, g] of Object.entries(e.groups ?? {})) {
        const stat = s.groups[id] ??= { asked: 0, waits: 0, avgOptions: 0, avgConfidence: 0, choices: {} };
        stat.asked++; stat.avgOptions += g.optionCount ?? 0; stat.avgConfidence += g.confidence ?? 0;
        if (g.choice === 'wait') stat.waits++; inc(stat.choices, g.choice || '?'); if (g.fallback) s.fallbacks++;
      }
    } else if (e.kind === 'command' && e.executed) {
      for (const o of e.orders ?? []) o.accepted ? s.commands.executed++ : s.commands.notExecuted++;
      s.commands.autoDefense += (e.auto ?? []).length;
    } else if (e.kind === 'command') {
      // A commander turn is one model request: it counts toward latency and tokens like a decision.
      s.commands.count++; s.commands.rejected += (e.rejected ?? []).length;
      if (e.provider) inc(s.providers, e.provider); if (e.model) inc(s.models, e.model);
      s.usage.inputTokens += e.inputTokens ?? 0; s.usage.outputTokens += e.outputTokens ?? 0;
      if (e.latencyMs !== null && e.latencyMs !== undefined) { latencySum += e.latencyMs; latencyCount++; commandLatency += e.latencyMs; commandTimed++; s.latency.max = Math.max(s.latency.max ?? 0, e.latencyMs); }
    } else if (e.kind === 'action') {
      s.actions.total++;
      if (e.accepted) { s.actions.accepted++; inc(s.actions.byType, e.actionType || '?'); if (e.actionType === 'produce') inc(s.actions.acceptedProduce, e.actionName || '?'); }
      else if (e.reason === 'wait') s.actions.waits++;
      else { s.actions.skipped++; inc(s.actions.skippedReasons, e.reason || '?'); }
    }
  }
  if (latencyCount) s.latency.avg = Math.round(latencySum / latencyCount);
  if (commandTimed) s.commands.latencyAvg = Math.round(commandLatency / commandTimed);
  for (const stat of Object.values(s.groups)) { stat.avgOptions = Math.round(stat.avgOptions / stat.asked * 10) / 10; stat.avgConfidence = Math.round(stat.avgConfidence / stat.asked * 100) / 100; stat.waitRate = Math.round(stat.waits / stat.asked * 100); stat.choices = top(stat.choices); }
  s.actions.skippedReasons = top(s.actions.skippedReasons); s.actions.acceptedProduce = top(s.actions.acceptedProduce, 12);
  return s;
}
