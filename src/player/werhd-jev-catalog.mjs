/** Player-side interpretation of effective, public match rules. */
export function refreshCatalog(api, catalog) {
  if (!api.rules) return catalog;
  const items = [...api.production.available(), ...api.units('self'), ...api.units('hostile')];
  const pending = [...items];
  const seen = new Set();
  for (let i = 0; i < pending.length; i++) {
    const { name, type } = pending[i];
    if (seen.has(`${type}:${name}`)) continue;
    seen.add(`${type}:${name}`);
    const rule = api.rules(name, type);
    if (!rule) continue;
    const weapon = (w) => w ? { ...w, verses: Object.assign([], w.versus) } : { damage: 0, range: 0, aa: false, ag: false, verses: [] };
    catalog[name] = {
      ...rule,
      factory: api.FactoryType[rule.factory] === 'None' ? undefined : api.FactoryType[rule.factory],
      buildCategory: api.BuildCat[rule.buildCat],
      armor: api.ArmorType[rule.armor].toLowerCase(),
      yard: rule.constructionYard,
      weapon: weapon(rule.primary), secondary: weapon(rule.secondary),
      aircraft: type === api.ObjectType.Aircraft,
    };
    if (rule.deploysInto) pending.push({ name: rule.deploysInto, type: api.ObjectType.Building });
    if (rule.undeploysInto) pending.push({ name: rule.undeploysInto, type: api.ObjectType.Vehicle });
    if (rule.freeUnit) pending.push({ name: rule.freeUnit, type: api.ObjectType.Vehicle });
  }
  return catalog;
}

// Map decorations are owned by a house and look like buildings, but they have no function:
// flags, lamp posts, pipes, fences, signs. They are never worth attacking or capturing, and an
// army sent at one across a broken bridge stays stuck for the rest of the match.
const DECORATION = /\b(flag|light ?post|lamp|pipes?|fence|sign|statue|tree|barrels?|crates?|billboard|mailbox|hydrant|bench|traffic|telephone|phone booth|debris|rubble|monument|fountain)\b/i;
const functional = (r) => !!r && (r.power > 0 || r.refinery || r.factory || r.constructionYard || r.yard || r.isBaseDefense || r.weapon?.damage > 0 || r.canBeOccupied || r.bridgeRepairHut);
export const isDecoration = (rule, name = rule?.name) => !functional(rule) && DECORATION.test(`${rule?.label ?? ''} ${name ?? ''}`);
// Buildings an engineer can actually take: the standard technology buildings plus anything with a
// working function. Decorations and plain civilian props are left out.
const TECH_NAMES = /^CA(OILD|HOSP|MACH|AIRP|POWR|OUTP|SLAB|ARMY|TECH)/i;
const TECH_LABEL = /\b(tech|oil derrick|derrick|hospital|machine shop|airport|outpost|secret lab|laboratory|power plant|reactor)\b/i;
export const isCapturable = (rule, name = rule?.name) => !isDecoration(rule, name) && (TECH_NAMES.test(name ?? '') || TECH_LABEL.test(rule?.label ?? '') || rule?.power > 0 || !!rule?.refinery || !!rule?.factory || !!rule?.constructionYard);
