// Persistent, bounded decision log kept in chrome.storage.local for later analysis.
// Records what the model was asked, what it chose, and what the executor did with it.
// Never stores credentials, session tokens or the raw battlefield state.
export const LOG_KEY = 'log';
export const LOG_MAX_ENTRIES = 2000;
export const LOG_MAX_CHARS = 4_000_000; // JSON size guard: storage.local is limited to ~10 MB
const short = (value, n) => typeof value === 'string' ? value.slice(0, n) : value == null ? '' : String(value).slice(0, n);
const number = n => typeof n === 'number' && Number.isFinite(n) ? n : null;

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
    };
  }
  return { at, kind: 'decision', tick: number(tick), provider: short(provider, 12), model: short(model, 60), latencyMs: number(latencyMs), inputTokens: number(usage?.input_tokens), state: stateSummary(state), groups };
}

export function eventEntry(e, at) {
  const kind = short(e?.kind, 24);
  const base = { at, kind, tick: number(e?.tick) };
  if (kind === 'action') return { ...base, question: short(e.question, 40), choice: short(e.choice, 60), accepted: e.accepted === true, reason: short(e.reason, 40), actionType: short(e.action?.type, 24), actionName: short(e.action?.name ?? e.action?.mode, 40), cost: number(e.action?.cost), confidence: number(e.confidence), latencyMs: number(e.latencyMs), ageTicks: number(e.ageTicks) };
  if (kind === 'stale') return { ...base, currentTick: number(e.currentTick), latencyMs: number(e.latencyMs) };
  if (kind === 'start') return { ...base, maxDecisions: number(e.maxDecisions), policy: short(e.policy, 40) };
  if (kind === 'stop') return { ...base, reason: short(e.reason, 40) };
  if (kind === 'outcome') return { ...base, result: short(e.result, 24) };
  if (kind === 'error') return { ...base, message: short(e.message, 240) };
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
  const s = { entries: entries.length, from: null, to: null, sessions: 0, decisions: 0, failures: 0, stale: 0, latency: { avg: null, max: null }, providers: {}, models: {},
    groups: {}, actions: { total: 0, accepted: 0, skipped: 0, waits: 0, byType: {}, skippedReasons: {}, acceptedProduce: {} }, outcomes: {}, errors: 0 };
  let latencySum = 0, latencyCount = 0;
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
      if (e.latencyMs !== null) { latencySum += e.latencyMs; latencyCount++; s.latency.max = Math.max(s.latency.max ?? 0, e.latencyMs); }
      for (const [id, g] of Object.entries(e.groups ?? {})) {
        const stat = s.groups[id] ??= { asked: 0, waits: 0, avgOptions: 0, avgConfidence: 0, choices: {} };
        stat.asked++; stat.avgOptions += g.optionCount ?? 0; stat.avgConfidence += g.confidence ?? 0;
        if (g.choice === 'wait') stat.waits++; inc(stat.choices, g.choice || '?');
      }
    } else if (e.kind === 'action') {
      s.actions.total++;
      if (e.accepted) { s.actions.accepted++; inc(s.actions.byType, e.actionType || '?'); if (e.actionType === 'produce') inc(s.actions.acceptedProduce, e.actionName || '?'); }
      else if (e.reason === 'wait') s.actions.waits++;
      else { s.actions.skipped++; inc(s.actions.skippedReasons, e.reason || '?'); }
    }
  }
  if (latencyCount) s.latency.avg = Math.round(latencySum / latencyCount);
  for (const stat of Object.values(s.groups)) { stat.avgOptions = Math.round(stat.avgOptions / stat.asked * 10) / 10; stat.avgConfidence = Math.round(stat.avgConfidence / stat.asked * 100) / 100; stat.waitRate = Math.round(stat.waits / stat.asked * 100); stat.choices = top(stat.choices); }
  s.actions.skippedReasons = top(s.actions.skippedReasons); s.actions.acceptedProduce = top(s.actions.acceptedProduce, 12);
  return s;
}
