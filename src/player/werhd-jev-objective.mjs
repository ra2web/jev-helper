// The player's own match objective ("摧毁五角大楼", "destroy the Pentagon") turned into a concrete
// target: small local models cannot connect a Chinese sentence to a building labelled "Pentagon",
// so the match is done here and offered to the model as a ready-made option.
const distance = (a, b) => Math.hypot(a.rx - b.rx, a.ry - b.ry);

// Chinese names -> English keywords found in rule labels (lower case, whole-word match). A landmark
// can be built from several pieces with their own labels: on the Washington map the Pentagon is
// four buildings, "RA2 Wash Pent A" to "D" (CAWA2A-D), and none of them is labelled "Pentagon".
export const OBJECTIVE_NAMES = [
  [/五角大楼|五角大厦/, ['pentagon', 'wash pent']],
  [/白宫/, ['white house']],
  [/自由女神/, ['statue of liberty', 'liberty']],
  [/克里姆林/, ['kremlin']],
  [/埃菲尔|艾菲尔/, ['eiffel']],
  [/华盛顿纪念碑/, ['washington monument']],
  [/国会大厦/, ['capitol']],
  [/雷达|空指部|空军指挥部/, ['radar', 'air force command']],
  [/发电厂|电厂|核电站|反应炉|磁能反应/, ['power plant', 'reactor']],
  [/兵营/, ['barracks']],
  [/战车工厂|坦克工厂|重工|工厂/, ['war factory', 'factory']],
  [/建造厂|主基地|基地车/, ['construction yard']],
  [/矿场|精炼厂|矿厂/, ['refinery']],
  [/核弹|核弹发射井|导弹发射井/, ['nuclear missile', 'missile silo', 'nuke']],
  [/天气控制/, ['weather control', 'weather']],
  [/超时空传送|时空传送/, ['chronosphere']],
  [/铁幕/, ['iron curtain']],
  [/作战实验室|实验室/, ['battle lab', 'laboratory']],
  [/心灵信标|心灵控制|心灵控制器/, ['psychic']],
  [/船厂|造船厂/, ['shipyard', 'naval yard']],
  [/碉堡/, ['pill box', 'pillbox', 'bunker']],
  [/光棱塔/, ['prism tower']],
  [/磁暴线圈/, ['tesla coil']],
  [/爱国者/, ['patriot']],
  [/油井|钻油/, ['oil derrick', 'derrick']],
  [/医院/, ['hospital']],
  [/机场/, ['airport', 'airfield']],
];
const PROTECT = /保护|守护|守住|保卫|护送|营救|救出|protect|defend|guard|escort|rescue|save/i;
// "使用工程师占领盟军战略实验室": a building to take with an engineer. It must never be attacked (a
// destroyed capture target fails the mission), and engineers are sent for it.
const CAPTURE = /占领|夺取|俘获|攻占|拿下|capture|seize|take over|take control/i;
const DESTROY = /摧毁|消灭|击毁|炸毁|拆除|破坏|打掉|推平|摧垮|destroy|eliminate|kill|demolish|raze|take out|wipe out/i;

// Objectives are read clause by clause: "摧毁五角大楼，保护白宫" names one target and one building
// that must never be attacked. A clause without a verb inherits the previous one ("摧毁A和B").
const CLAUSE = /[，,。.;；！!？?、\n]|和|与|以及|然后|再|并且|并|同时|但是|但|\band\b|\bthen\b|\bbut\b|\bwhile\b/i;
// "不要打白宫" / "do not attack the White House": a negated clause protects what it names.
const NEGATE = /不要|别|不许|不能|不得|勿|do not|don't|dont|never|avoid|spare/i;
const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// English names match whole words only ("Pent" is not "Pentagon", "destroy everything" is not "Thing").
const wordIn = (hay, word) => new RegExp(`(^|[^a-z0-9])${escape(word)}([^a-z0-9]|$)`).test(hay);
export function parseObjective(text) {
  const destroy = [], protect = [], capture = [];
  let intent = 'destroy';
  for (const clause of String(text ?? '').split(CLAUSE).map(c => c?.trim()).filter(Boolean)) {
    if (NEGATE.test(clause) || PROTECT.test(clause) && !DESTROY.test(clause)) intent = 'protect';
    else if (CAPTURE.test(clause)) intent = 'capture';
    else if (DESTROY.test(clause)) intent = 'destroy';
    (intent === 'destroy' ? destroy : intent === 'capture' ? capture : protect).push(clause.toLowerCase());
  }
  const namesIn = (clauses) => {
    const out = new Set();
    for (const c of clauses) for (const [pattern, words] of OBJECTIVE_NAMES) {
      // Naming a building in either language brings in every label it is known by ("Pentagon" also
      // finds the "Wash Pent" pieces).
      if (pattern.test(c) || words.some(w => w.length >= 4 && wordIn(c, w))) words.forEach(w => out.add(w));
    }
    return out;
  };
  const kept = namesIn(protect);
  const taken = [...namesIn(capture)].filter(w => !kept.has(w));
  // Capture targets are guarded too: nothing may destroy them.
  const guarded = new Set([...kept, ...taken]);
  return { words: [...namesIn(destroy)].filter(w => !guarded.has(w)), capture: taken, destroyText: destroy.join(' | '), protectText: protect.join(' | '), captureText: capture.join(' | '), guarded: [...guarded] };
}
export const objectiveKeywords = (text) => parseObjective(text).words;
export const captureKeywords = (text) => parseObjective(text).capture;
const hayOf = (rule, name) => `${String(rule?.label ?? '').toLowerCase()} ${String(name ?? '').toLowerCase()}`;
// A building the objective says to capture (matched by the same names as destroy targets).
export function matchesCapture(text, rule, name) {
  const hay = hayOf(rule, name);
  return parseObjective(text).capture.some(w => wordIn(hay, w)) ? 'name' : false;
}
// A building the objective says to protect or capture: never an attack target.
export function isGuardedByObjective(text, rule, name) {
  if (!text) return false;
  const { guarded, protectText, captureText } = parseObjective(text);
  const hay = hayOf(rule, name), label = String(rule?.label ?? '').toLowerCase();
  return guarded.some(w => wordIn(hay, w)) || (label.length >= 4 && (wordIn(protectText, label) || wordIn(captureText, label)));
}

export function matchesObjective(text, keywords, rule, name) {
  const { destroyText, protectText, guarded } = parseObjective(text);
  if (!destroyText) return false;
  const label = String(rule?.label ?? '').toLowerCase(), code = String(name ?? '').toLowerCase();
  const hay = `${label} ${code}`;
  // A building the objective says to protect is never a target, even if another clause also fits it.
  if (guarded.some(w => wordIn(hay, w)) || (label.length >= 4 && wordIn(protectText, label))) return false;
  if (keywords.some(k => wordIn(hay, k))) return 'name';
  // The objective names the building by its label ("destroy the Pentagon"); a weaker match.
  return label.length >= 4 && wordIn(destroyText, label) ? 'label' : false;
}

// Keeps memory.objectiveTarget up to date: the matched building (id, name, label, position, last
// seen tick) survives the fog; once its tile is visible and the building is gone it is marked done.
export function trackObjective(api, catalog, memory, from) {
  const text = memory.objective;
  if (!text) return undefined;
  if (memory.objectiveKeys?.text !== text) { memory.objectiveKeys = { text, words: objectiveKeywords(text), capture: captureKeywords(text) }; memory.objectiveTarget = undefined; memory.objectiveDone = new Set(); }
  // Destroy targets take precedence; an objective that only names buildings to capture is a capture mission.
  const mode = memory.objectiveKeys.words.length ? 'destroy' : memory.objectiveKeys.capture?.length ? 'capture' : undefined;
  if (!mode) return memory.objectiveTarget;
  memory.objectiveDone ??= new Set();
  const tick = api.tick(), B = api.ObjectType.Building;
  let hostile = []; try { hostile = api.units('hostile') ?? []; } catch { hostile = []; }
  let target = memory.objectiveTarget;
  const hpOf = (u) => u?.maxHitPoints ? Math.round(u.hitPoints / u.maxHitPoints * 100) : undefined;
  // After a capture the building is still followed: a captured objective that changes hands again or
  // disappears is what a report needs to explain a defeat right after the capture (0.7.4: the Battle
  // Lab was captured, left our building list 6 s later, and the game declared a defeat 5 s after).
  if (target?.captured) {
    const mine = (api.units('self') ?? []).find(u => u.id === target.id), theirs = hostile.find(u => u.id === target.id);
    if (mine) { target.hp = hpOf(mine); delete target.afterCapture; }
    else if (!target.afterCapture) target.afterCapture = { tick, how: theirs ? 'changed_hands' : api.map.visible(target.x, target.y) ? 'gone' : 'out_of_sight', lastHp: target.hp };
  }
  if (target && !target.done) {
    const seen = hostile.find(u => u.id === target.id);
    // Taken by our engineer: no longer something to attack, and not a kill either.
    const ours = !seen && (api.units('self') ?? []).find(u => u.id === target.id);
    if (seen) Object.assign(target, { x: seen.tile.rx, y: seen.tile.ry, lastSeen: tick, visible: true, hp: hpOf(seen) });
    else if (ours) { Object.assign(target, { done: true, captured: true, capturedTick: tick, visible: true, hp: hpOf(ours) }); memory.objectiveDone.add(target.id); }
    // A capture target that vanished was destroyed: the capture failed.
    else if (api.map.visible(target.x, target.y)) { Object.assign(target, { done: true, destroyedTick: tick, visible: false, ...(target.mode === 'capture' ? { lost: true } : {}) }); memory.objectiveDone.add(target.id); }
    else target.visible = false;
  }
  if (!target || target.done) {
    const words = memory.objectiveKeys.words;
    // After one piece of a multi-piece landmark falls, the next one is the piece beside it.
    const origin = target?.done ? { rx: target.x, ry: target.y } : from ?? hostile[0]?.tile;
    const matches = mode === 'capture' ? (u) => matchesCapture(text, catalog[u.name], u.name) : (u) => matchesObjective(text, words, catalog[u.name], u.name);
    const match = hostile.map(u => ({ u, how: u.type === B && !memory.objectiveDone.has(u.id) && matches(u) }))
      .filter(m => m.how).sort((a, b) => (a.how === 'name' ? 0 : 1) - (b.how === 'name' ? 0 : 1) || (origin ? distance(a.u.tile, origin) - distance(b.u.tile, origin) : 0))[0]?.u;
    if (match) target = memory.objectiveTarget = { id: match.id, name: match.name, label: catalog[match.name]?.label ?? match.name, mode,
      x: match.tile.rx, y: match.tile.ry, firstSeen: tick, lastSeen: tick, visible: true };
  }
  return memory.objectiveTarget;
}
