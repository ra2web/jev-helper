// Shared world for the commander tests: a mock of the public player API around a scene modelled on
// the 0.6.0 match. Not a test file itself (no .test suffix).
import { collectState, objectiveState } from '../src/player/werhd-jev-player.mjs';
import { buildBrief } from '../src/player/werhd-jev-commander.mjs';

// Modelled on the 0.6.0 match: a road with a pillbox on each side, Patriot sites, the Pentagon as the
// objective, a broken bridge with its repair hut, and empty civilian houses next to the pillboxes.
export const w = (damage, range, v, extra = {}) => ({ damage, range, rof: 20, versus: v, verses: v, aa: false, ag: true, ...extra });
export const soft = { 0: 1, 1: .9, 2: .8, 3: .5, 4: .3, 5: .25, 6: .5, 7: .25, 8: .2 };
export const catalog = {
  NACNST: { yard: true, label: 'Soviet Construction Yard', cost: 3000, armor: 'heavy' }, NAHAND: { factory: 'InfantryType', label: 'Soviet Barracks', cost: 500, armor: 'wood' },
  NAPOWR: { power: 150, label: 'Tesla Reactor', cost: 600 }, NAREFN: { refinery: true, label: 'Soviet Ore Refinery', cost: 2000 }, HARV: { harvester: true, label: 'War Miner', cost: 1400, armor: 'heavy' },
  E2: { occupier: true, label: 'Conscript', cost: 100, speed: 4, armor: 'none', category: 'Soldier', weapon: w(15, 4, soft) },
  ADOG: { label: 'Attack Dog', cost: 200, speed: 9, armor: 'none', category: 'Soldier', weapon: w(100, 1.5, { 0: 1, 1: 1, 2: 1, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 }) },
  HTNK: { label: 'Rhino Tank', cost: 900, speed: 5, armor: 'heavy', category: 'AFV', weapon: w(90, 6, { 0: .3, 1: .5, 2: .7, 3: 1, 4: 1, 5: 1, 6: 1, 7: .8, 8: .6 }) },
  SENGINEER: { engineer: true, label: 'Soviet Engineer', cost: 500, armor: 'none', category: 'Soldier' },
  NALASR: { isBaseDefense: true, label: 'Sentry Gun', cost: 500, weapon: w(15, 5, soft) },
  E1: { label: 'GI', armor: 'none', category: 'Soldier', weapon: w(15, 5, soft) },
  GAPILL: { isBaseDefense: true, label: 'Pill Box', armor: 'concrete', cost: 500, weapon: w(40, 5.5, { 0: 1.2, 1: 1, 2: .8, 3: .4, 4: .3, 5: .2, 6: .5, 7: .2, 8: .1 }) },
  NASAM: { isBaseDefense: true, label: 'Patriot Missile', armor: 'concrete', cost: 1000, weapon: w(50, 12, { 0: 0, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1 }, { aa: true, ag: false }) },
  GAPILE: { factory: 'InfantryType', label: 'Allied Barracks', armor: 'wood', cost: 500 }, GACNST: { yard: true, label: 'Allied Construction Yard', armor: 'heavy', cost: 3000 },
  CAPENT: { label: 'Pentagon', armor: 'concrete' }, CAOILD: { label: 'Oil Derrick', armor: 'wood' }, CAFLAG: { label: 'Flag' },
  CATEXS: { label: 'Civilian Building', canBeOccupied: true, maxNumberOccupants: 5 }, CABHUT: { bridgeRepairHut: true, label: 'Bridge Repair Hut' },
};
export const HP = { E2: 125, E1: 125, ADOG: 100, HTNK: 400, GAPILL: 400, NASAM: 900, CAPENT: 4000, CATEXS: 600, CABHUT: 200, NACNST: 1000, SENGINEER: 75 };
export const T = { Building: 2, Infantry: 3, Vehicle: 7, Aircraft: 1 };
export const u = (id, name, type, x, y, extra = {}) => ({ id, name, type, tile: { rx: x, ry: y }, hitPoints: HP[name] ?? 100, maxHitPoints: HP[name] ?? 100, isIdle: true, canDeploy: false, isDeployed: false,
  primaryWeapon: catalog[name].weapon ? { maxRange: catalog[name].weapon.range } : undefined, ...extra });
export const house = (id, x, y, count = 0) => u(id, 'CATEXS', T.Building, x, y, { garrison: { count, capacity: 5, canOccupy: true, unitIds: [] } });
export const infantry = (from, n, x, y, name = 'E2') => Array.from({ length: n }, (_, i) => u(from + i, name, T.Infantry, x + (i % 6), y + Math.floor(i / 6)));

export function world({ own, enemies = [], neutral = [], credits = 13000, tick = 12000, offers, queues = [], visible = () => true } = {}) {
  const calls = [];
  offers ??= [{ name: 'E2', type: 3, queue: 2 }, { name: 'SENGINEER', type: 3, queue: 2 }, { name: 'ADOG', type: 3, queue: 2 }, { name: 'NALASR', type: 2, queue: 1 }, { name: 'NAPOWR', type: 2, queue: 0 }];
  const self = own ?? [];
  const api = {
    ObjectType: T, QueueType: { Structures: 0, Armory: 1, Infantry: 2, Vehicles: 3, Aircrafts: 4, Ships: 5 },
    ArmorType: { None: 0, Flak: 1, Plate: 2, Light: 3, Medium: 4, Heavy: 5, Wood: 6, Steel: 7, Concrete: 8, 0: 'None', 1: 'Flak', 2: 'Plate', 3: 'Light', 4: 'Medium', 5: 'Heavy', 6: 'Wood', 7: 'Steel', 8: 'Concrete' },
    ZoneType: { Air: 1, Water: 2 }, LandType: { Clear: 0 }, OrderType: { Move: 1, Attack: 2, Capture: 7, Occupy: 8, Repair: 9, DeploySelected: 10, Stop: 11 },
    units: (r) => r === 'self' ? self : r === 'enemy' ? enemies : r === 'allied' ? [] : [...enemies, ...neutral],
    unit: (id) => [...self, ...enemies, ...neutral].find((x) => x.id === id),
    me: () => ({ credits, power: { total: 300, drain: 120 }, combatant: true, defeated: false, isObserver: false }), tick: () => tick, time: () => tick / 15, players: () => [],
    map: { size: () => ({ width: 155, height: 155 }), visible: (x, y) => visible(x, y), tile: (x, y) => ({ rx: x, ry: y, landType: 0 }) }, canPlace: () => true,
    production: { queues: () => Array.from({ length: 6 }, (_, type) => ({ type, size: queues.filter((q) => q.type === type).length, maxSize: 5, items: queues.filter((q) => q.type === type), status: 0 })),
      available: (q) => q === undefined ? offers : offers.filter((o) => o.queue === q) },
    weaponVs: () => undefined, inRange: () => false,
    attack: (...a) => { calls.push(['attack', ...a]); for (const x of self) if (a[0].includes(x.id)) x.isIdle = false; },
    attackMove: (...a) => { calls.push(['attackMove', ...a]); for (const x of self) if (a[0].includes(x.id)) x.isIdle = false; },
    move: (...a) => { calls.push(['move', ...a]); for (const x of self) if (a[0].includes(x.id)) x.isIdle = false; },
    order: (ids, o) => { calls.push(['order', ids, o]); return true; }, deploy: () => true, produce: (...a) => calls.push(['produce', ...a]), gather() {}, repair() {}, place() {},
    onTick: (h) => { api._tick = h; }, offTick() {},
  };
  const memory = { frontiers: new Map(), enemyBuildings: new Map(), orders: new Map(), postureOrders: new Map(), specialOrders: new Map(), specialTargets: new Map(), plannedSites: new Map(), observedSpecial: new Map(), repairing: new Set(), lastMaintenance: tick, lastMicroReport: -1000 };
  return { api, memory, calls, self, enemies, neutral, setTick: (t) => { tick = t; }, setCredits: (c) => { credits = c; } };
}
export const home = () => [u(1, 'NACNST', T.Building, 100, 120), u(2, 'NAHAND', T.Building, 104, 118), u(3, 'NAPOWR', T.Building, 96, 122)];
export const road = () => [u(1655, 'GAPILL', T.Building, 59, 46), u(1656, 'GAPILL', T.Building, 68, 46), u(1647, 'NASAM', T.Building, 54, 45), u(1600, 'GAPILE', T.Building, 66, 40), u(1593, 'GACNST', T.Building, 60, 30),
  ...infantry(1770, 3, 64, 44, 'E1')];
export const civilians = () => [u(990, 'CAPENT', T.Building, 56, 26), house(1638, 55, 49), house(1664, 71, 48), house(1633, 98, 114), u(1607, 'CABHUT', T.Building, 92, 87), u(1700, 'CAOILD', T.Building, 80, 70), u(1701, 'CAFLAG', T.Building, 57, 27)];
export function brief(x, objective = '摧毁五角大楼') {
  x.memory.objective = objective;
  const snap = collectState(x.api, catalog);
  objectiveState(x.api, catalog, x.memory, snap.raw.base, snap.state);
  return buildBrief(x.api, catalog, snap, x.memory);
}
export const scene = (extra = {}) => world({ own: [...home(), ...infantry(10, 18, 60, 52), ...infantry(40, 4, 97, 116), u(60, 'SENGINEER', T.Infantry, 101, 117)], enemies: road(), neutral: civilians(), ...extra });

