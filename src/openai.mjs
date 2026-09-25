// OpenAI-compatible chat models answering the same choice questions Jev answers. The model gets
// the battlefield state plus every decision group with its legal option keys, and replies through
// a forced function call (or a bare JSON object). Replies are mapped back to Jev's answer shape,
// so validation, execution and logging stay the same for every provider.
export const OPENAI_MODES = /* @__PURE__ */ Object.freeze(['tools', 'json']);
export const TOOL_NAME = 'submit_choices';
const STATE_LIMIT = 48000; // characters of state JSON per request; keeps token use bounded

const SYSTEM = [
  'You command one player in WannaFire, a browser remake of Command & Conquer: Red Alert 2.',
  'Each turn you receive the battlefield state visible to that player and several decision groups.',
  'Every group lists its only legal options as "key": "what it does". For each group choose exactly one option key.',
  'Follow each group\'s instructions. Choose "wait" only when no other option is useful or affordable right now.',
  'Answer every group. Keep each reason to one short sentence.',
].join(' ');

// Scalars first, long arrays and objects after; when still too large, arrays are shortened.
export function compactState(state, limit = STATE_LIMIT) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  const short = {}, long = {};
  for (const [k, v] of Object.entries(state)) (v && typeof v === 'object' ? long : short)[k] = v;
  let out = { ...short, ...long };
  for (const n of [24, 8, 2]) {
    if (JSON.stringify(out).length <= limit) return out;
    out = JSON.parse(JSON.stringify(out, (k, v) => Array.isArray(v) && v.length > n ? [...v.slice(0, n), `…${v.length - n} more`] : v));
  }
  return out;
}

export function choiceSchema(questions) {
  const properties = {};
  for (const [id, q] of Object.entries(questions)) {
    properties[id] = {
      type: 'object',
      properties: {
        choice: { type: 'string', enum: Object.keys(q.criteria) },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'How sure you are, 0 to 1.' },
        reason: { type: 'string', description: 'One short sentence.' },
      },
      required: ['choice'],
    };
  }
  return { type: 'object', properties, required: Object.keys(questions) };
}

// toolChoice: 'forced' names the function; 'auto' is for services that refuse a forced call
// (DeepSeek thinking models, for example), where the prompt asks for the call instead.
export function buildChatRequest({ model, mode = 'tools', state, questions, toolChoice = 'forced' }) {
  const decisions = Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, { instructions: q.instructions, options: q.criteria }]));
  const user = JSON.stringify({ state: compactState(state), decisions });
  if (mode === 'json') {
    const shape = Object.fromEntries(Object.keys(questions).map(id => [id, { choice: '<option key>', confidence: 0.8, reason: '<short>' }]));
    return {
      model,
      messages: [
        { role: 'system', content: `${SYSTEM} Reply with only one JSON object shaped like ${JSON.stringify(shape)}, no other text.` },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    };
  }
  return {
    model,
    messages: [{ role: 'system', content: toolChoice === 'auto' ? `${SYSTEM} Always answer by calling ${TOOL_NAME}.` : SYSTEM }, { role: 'user', content: user }],
    tools: [{ type: 'function', function: { name: TOOL_NAME, description: 'Submit one option key for every decision group.', parameters: choiceSchema(questions) } }],
    tool_choice: toolChoice === 'auto' ? 'auto' : { type: 'function', function: { name: TOOL_NAME } },
  };
}

// The first JSON object in a text reply, tolerating code fences and surrounding prose.
function parseObject(text) {
  if (text && typeof text === 'object') return text;
  const s = String(text ?? '').replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}
const textOf = content => Array.isArray(content) ? content.map(p => typeof p === 'string' ? p : p?.text ?? '').join('') : content;

// Returns {answers, model, usage}. A group with a missing or unknown choice falls back to its
// "wait" option and is flagged; only when no group has a usable choice is the reply rejected.
export function parseChatResponse(body, questions, name = 'OpenAI') {
  const message = body?.choices?.[0]?.message ?? {};
  const call = message.tool_calls?.find(c => c?.function?.name === TOOL_NAME) ?? message.tool_calls?.[0];
  const raw = call?.function?.arguments ?? message.function_call?.arguments ?? textOf(message.content);
  let data = parseObject(raw);
  if (!data) throw new Error(`${name} 返回的内容无法解析。`);
  const ids = Object.keys(questions);
  if (!ids.some(id => id in data)) data = [data.answers, data.choices, data.decisions].find(x => x && typeof x === 'object' && ids.some(id => id in x)) ?? data;
  const answers = {};
  let valid = 0;
  for (const [id, q] of Object.entries(questions)) {
    const a = data[id], choice = typeof a === 'string' ? a : a?.choice;
    const confidence = Number(a?.confidence);
    const reason = typeof a?.reason === 'string' ? a.reason.slice(0, 200) : '';
    if (typeof choice === 'string' && Object.hasOwn(q.criteria, choice)) {
      valid++;
      answers[id] = { type: 'choice', choice, confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0, probabilities: {}, ...(reason ? { reason } : {}) };
    } else if (Object.hasOwn(q.criteria, 'wait')) {
      answers[id] = { type: 'choice', choice: 'wait', confidence: 0, probabilities: {}, fallback: true };
    } else throw new Error(`${name} 返回了未提供的候选，已拒绝执行。`);
  }
  if (!valid) throw new Error(`${name} 返回了未提供的候选，已拒绝执行。`);
  const u = body?.usage ?? {};
  return {
    answers,
    model: typeof body?.model === 'string' ? body.model.slice(0, 160) : '',
    usage: { input_tokens: Number(u.prompt_tokens ?? u.input_tokens) || 0, output_tokens: Number(u.completion_tokens ?? u.output_tokens) || 0 },
  };
}

// GET /models → sorted ids. Accepts {data:[{id}]} (OpenAI), {models:[…]} and plain arrays.
export function modelIds(body) {
  const list = Array.isArray(body) ? body : body?.data ?? body?.models ?? [];
  const ids = list.map(m => typeof m === 'string' ? m : m?.id ?? m?.name).filter(id => typeof id === 'string' && /^[\w.\/:@+-]{1,160}$/.test(id));
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b)).slice(0, 500);
}

// A 400 saying the service will not accept a forced function call.
export const refusesForcedTool = (status, detail) => status === 400 && /tool_choice/i.test(detail);

// The service's own error text, when it sends one, for a clearer failure message.
export function serviceError(raw) {
  try { const e = JSON.parse(raw)?.error; return String(typeof e === 'string' ? e : e?.message ?? '').replace(/\s+/g, ' ').slice(0, 160); } catch { return ''; }
}

// ---- Commander mode: the model plans from the brief instead of picking among prepared options ----
export const COMMAND_TOOL = 'issue_orders';
export const SQUAD_ACTIONS = /* @__PURE__ */ Object.freeze(['attack', 'attack_move', 'move', 'hold', 'garrison', 'defend_base', 'retreat', 'scout']);
export const ENGINEER_ACTIONS = /* @__PURE__ */ Object.freeze(['capture', 'repair_bridge']);
const COMMANDER = [
  'You are the field commander of one player in WannaFire, a browser remake of Command & Conquer: Red Alert 2.',
  'Each turn you get a brief: unit cards (what every unit type can do: ground range, anti-air range, estimated damage per second against infantry / armor / buildings / aircraft, tags such as can_garrison, anti_air_only, engineer),',
  'your squads (composition, position, health, current intent, who is shooting them and whether that enemy outranges them), enemy groups and buildings (range, anti-air-only, houses within reach of each defense),',
  'bridges, production options, the mission objective, and how your last orders turned out.',
  'Fields: hpPct is percent of maximum health; hp "a/b" is current/maximum health points; cards.maxHp is a unit type\'s full health; dps is estimated damage per second of ONE unit against that target class,',
  'so time to destroy ≈ target hp / (dps × number of attackers).',
  'Basic rules: move walks without fighting, attack_move fights anything met on the way, attack goes for one target (a building, or one enemy unit: each enemy group lists up to three unit ids; to fight a whole group, attack_move to its position). Infantry tagged can_garrison may enter an empty garrisonable house (garrison, target = house id):',
  'inside they are protected by the building and fire from cover, so a house within reach of an enemy defense is how infantry take that defense without being cut down in the open.',
  'Engineers are unarmed; capture consumes the engineer and takes the building intact; repair_bridge sends one into a bridge repair hut to restore a destroyed bridge.',
  'Decide the plan. Reason from the cards: a unit with a shorter range than an enemy defense takes fire it cannot answer until it closes in; garrisoned infantry fire from cover;',
  'anti_air_only defenses cannot hurt ground units and only matter for aircraft; units with near-zero damage against a target class should not be sent at it;',
  'concentrate force instead of sending small groups one by one; protect the base and the economy; pursue the mission objective when one is given.',
  'A capture objective (objective.target.mode = capture) is won by an engineer entering it: never attack it (a destroyed target fails the mission); clear the defenses around it, train engineers and send them with capture.',
  'Only use ids, squad names, unit codes and coordinates that appear in the brief. Squads you do not mention keep their current intent.',
  'Answer by calling issue_orders. Keep every reason to one short sentence and the note to one or two sentences.',
].join(' ');

export function commanderSchema(legal = {}) {
  const ids = (list) => (list?.length ? { type: 'integer', enum: list } : { type: 'integer' });
  return {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'The overall plan in one or two sentences.' },
      squads: { type: 'array', items: { type: 'object', properties: {
        squad: legal.squads?.length ? { type: 'string', enum: legal.squads } : { type: 'string' },
        action: { type: 'string', enum: [...SQUAD_ACTIONS] },
        target: { type: 'integer', description: 'attack: enemy id; garrison: house id.' },
        x: { type: 'integer' }, y: { type: 'integer' },
        reason: { type: 'string' },
      }, required: ['squad', 'action'] } },
      production: { type: 'array', items: { type: 'object', properties: {
        item: legal.produce?.length ? { type: 'string', enum: legal.produce } : { type: 'string' },
        count: { type: 'integer', minimum: 1, maximum: 5 }, reason: { type: 'string' },
      }, required: ['item'] } },
      engineers: { type: 'array', items: { type: 'object', properties: {
        action: { type: 'string', enum: [...ENGINEER_ACTIONS] }, target: ids([...(legal.captures ?? []), ...(legal.huts ?? [])]), reason: { type: 'string' },
      }, required: ['action', 'target'] } },
    },
    required: ['note', 'squads'],
  };
}

// A bare JSON object with the same fields as the issue_orders arguments, for services without
// function calling (call style "json") and as the one retry after a prose answer.
const COMMAND_SHAPE = { note: '<one or two sentences>', squads: [{ squad: '<squad id>', action: '<action>', target: 0, x: 0, y: 0, reason: '<short>' }],
  production: [{ item: '<unit code>', count: 1, reason: '<short>' }], engineers: [{ action: 'capture', target: 0, reason: '<short>' }] };
export function buildCommanderRequest({ model, brief, toolChoice = 'forced', mode = 'tools' }) {
  const { legal, ...shown } = brief;
  if (mode === 'json') return {
    model,
    messages: [
      { role: 'system', content: `${COMMANDER.replace('Answer by calling issue_orders.', '')} Reply with only one JSON object shaped like ${JSON.stringify(COMMAND_SHAPE)}, no other text. Squad actions: ${SQUAD_ACTIONS.join(', ')}; engineer actions: ${ENGINEER_ACTIONS.join(', ')}. target is used by attack / garrison / engineers, x and y by attack_move / move / hold / scout; leave out what an action does not use.` },
      { role: 'user', content: JSON.stringify(shown) },
    ],
    response_format: { type: 'json_object' },
  };
  return {
    model,
    messages: [
      { role: 'system', content: toolChoice === 'auto' ? `${COMMANDER} Always answer by calling ${COMMAND_TOOL}.` : COMMANDER },
      { role: 'user', content: JSON.stringify(shown) },
    ],
    tools: [{ type: 'function', function: { name: COMMAND_TOOL, description: 'Give orders to squads, production and engineers for the next period.', parameters: commanderSchema(legal) } }],
    tool_choice: toolChoice === 'auto' ? 'auto' : { type: 'function', function: { name: COMMAND_TOOL } },
  };
}

// Every order is checked against what the brief offered. Invalid orders are returned with a reason
// (and shown to the model next turn); the valid ones stand.
export function parseCommanderResponse(body, legal = {}, name = 'OpenAI') {
  const message = body?.choices?.[0]?.message ?? {};
  const call = message.tool_calls?.find((c) => c?.function?.name === COMMAND_TOOL) ?? message.tool_calls?.[0];
  let data = parseObject(call?.function?.arguments ?? message.function_call?.arguments ?? textOf(message.content));
  if (!data || typeof data !== 'object') throw new Error(`${name} 返回的内容无法解析。`);
  // Some models wrap the arguments: {"issue_orders": {...}} or {"orders": {...}}.
  if (!['note', 'squads', 'production', 'engineers'].some((k) => k in data)) data = [data[COMMAND_TOOL], data.orders, data.arguments].find((x) => x && typeof x === 'object') ?? data;
  if (!['note', 'squads', 'production', 'engineers'].some((k) => k in data)) throw new Error(`${name} 返回的内容无法解析。`);
  const has = (list, v) => Array.isArray(list) && list.includes(v);
  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : undefined);
  const reason = (o) => (typeof o?.reason === 'string' ? o.reason.slice(0, 200) : '');
  const rejected = [], squads = [], production = [], engineers = [], seen = new Set();
  // Coordinates must lie on the map the brief described (legal.mapSize); without it any integer passes.
  const size = legal.mapSize, onMap = (x, y) => !size || x >= 0 && y >= 0 && x < size.width && y < size.height;
  for (const o of Array.isArray(data.squads) ? data.squads.slice(0, 20) : []) {
    const squad = String(o?.squad ?? '').slice(0, 40), action = String(o?.action ?? '').slice(0, 40), target = num(o?.target), x = num(o?.x), y = num(o?.y);
    const bad = !has(legal.squads, squad) ? 'unknown squad' : seen.has(squad) ? 'duplicate squad' : !SQUAD_ACTIONS.includes(action) ? 'unknown action'
      : action === 'attack' && !has(legal.attackTargets, target) ? 'unknown attack target'
      : action === 'garrison' && !has(legal.houses, target) ? 'unknown house'
      : ['attack_move', 'move', 'hold', 'scout'].includes(action) && (x === undefined || y === undefined) ? 'missing coordinates'
      : ['attack_move', 'move', 'hold', 'scout'].includes(action) && !onMap(x, y) ? 'coordinates outside the map' : '';
    if (bad) { rejected.push({ kind: 'squad', squad, action, target, reason: bad }); continue; }
    seen.add(squad);
    squads.push({ squad, action, ...(target !== undefined && ['attack', 'garrison'].includes(action) ? { target } : {}), ...(x !== undefined && y !== undefined && !['attack', 'garrison', 'defend_base', 'retreat'].includes(action) ? { x, y } : {}), reason: reason(o) });
  }
  for (const o of Array.isArray(data.production) ? data.production.slice(0, 6) : []) {
    const item = String(o?.item ?? '').slice(0, 40), count = Math.min(5, Math.max(1, num(o?.count) ?? 1));
    if (!has(legal.produce, item)) { rejected.push({ kind: 'production', item, reason: 'not producible now' }); continue; }
    production.push({ item, count, reason: reason(o) });
  }
  for (const o of Array.isArray(data.engineers) ? data.engineers.slice(0, 4) : []) {
    const action = String(o?.action ?? '').slice(0, 40), target = num(o?.target);
    const bad = !ENGINEER_ACTIONS.includes(action) ? 'unknown action' : action === 'capture' && !has(legal.captures, target) ? 'not capturable'
      : action === 'repair_bridge' && !has(legal.huts, target) ? 'unknown bridge hut' : '';
    if (bad) { rejected.push({ kind: 'engineer', action, target, reason: bad }); continue; }
    engineers.push({ action, target, reason: reason(o) });
  }
  const u = body?.usage ?? {};
  return {
    orders: { note: typeof data.note === 'string' ? data.note.slice(0, 400) : '', squads, production, engineers },
    rejected, model: typeof body?.model === 'string' ? body.model.slice(0, 160) : '',
    usage: { input_tokens: Number(u.prompt_tokens ?? u.input_tokens) || 0, output_tokens: Number(u.completion_tokens ?? u.output_tokens) || 0 },
  };
}
