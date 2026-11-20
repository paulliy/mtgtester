/**
 * Card traits for the heuristic bot, derived from the engine's card IR (ADR 0039).
 *
 * The bot cannot import `@mtg/engine`, and it should not read Oracle text: the IR already says
 * what a card does as typed effect ops. This module walks a `CardDefinition`, classifies each op
 * it finds into a coarse role (removal, draw, ramp, ...) and each target slot into hostile or
 * friendly, and hands the bot a lookup by card name. Classification is by op-name pattern, so a
 * new op lands in a sensible bucket without a code change here; an op no pattern knows is simply
 * role-less, which costs the bot information, never legality.
 *
 * Hidden information: the lookup is keyed by name and the bot only ever asks about names its
 * `PlayerView` shows, so building it from every deck in the game reveals nothing.
 */

import type { CardDefinition } from '@mtg/engine';
import type {
  CardKnowledge,
  CardRole,
  CardTraits,
  StatBoost,
  TargetPolarity,
  WipeSelector,
} from '@mtg/bot';

interface OpRecord {
  op: string;
  raw: Record<string, unknown>;
}

const ROLE_PATTERNS: ReadonlyArray<[CardRole, RegExp]> = [
  ['counter', /^counter/],
  [
    'wipe',
    /^(destroyEach|exileEach(?!OpponentGraveyard)|damageEach$|returnToHandEach|overloadBounceAll|sacrificeEachPlayer|sacrificeOneCreatureEachPlayer|livingDeath)/,
  ],
  ['draw', /draw|^connive|^lookAtTopNCastOneFree/i],
  ['ramp', /^(addMana|additionalLandPlays|searchBasics|createTreasure)/],
  ['tokens', /^(createToken|populate|amass|recruit)/],
  ['pump', /^(pump|doubleP|bolster|grantAbility|grantKeyword(?!.*Protection))/],
  [
    'protection',
    /^(grantProtection|grantChosenColorProtection|regenerate|phaseOut|controllerHexproof|controllerProtection|inkshield)/,
  ],
  [
    'recursion',
    /^(graveyardTo|reanimate|returnOneFromYourGraveyard|returnCardFromGraveyard|returnSelfFromGraveyard|unearth|returnDiedSource)/,
  ],
  [
    'burn',
    /^(eachOpponentLosesLife|eachOpponentDamage|damageEachOtherOpponent|damageEachPlayer|halfLifeDrain|loseHalfLifeTarget|loseLifeTarget|drainOpponents)/,
  ],
  ['lifegain', /gainLife/i],
  ['discard', /^(discardTarget|discardEachPlayer|discardChosenPlayers|revealHandAndDiscard)/],
  ['extraTurn', /^(takeExtraTurn|extraCombatPhase)/],
];

const HOSTILE_OPS =
  /^(destroy|exile|removeTarget|dealDamage|tapTarget|returnToHand|gainControl|counter|sacrificeTarget|loseLifeTarget|loseHalfLifeTarget|discardTarget|millTarget|goad|forceAttack|giveTargetPoison|chaosWarp|removeCounters|halfLifeDrain|swapCreatureControl|setMustBlock|cantBlock)/;
const FRIENDLY_OPS =
  /^(pump|grantKeyword|grantProtection|grantChosenColor|grantAbility|grantHaste|putCounters|untap|regenerate|gainLife|drawTarget|attach|blink|phaseOut|cantBeBlocked|doubleP|controllerHexproof|bolster)/;

/** Keywords whose grant protects rather than pumps. */
const PROTECTIVE_KEYWORDS = /^(hexproof|indestructible|shroud|protection)/i;

/** Every effect op in an IR subtree, with the effect object it came from. */
function collectOps(node: unknown, out: OpRecord[] = []): OpRecord[] {
  if (Array.isArray(node)) {
    for (const item of node) collectOps(item, out);
    return out;
  }
  if (typeof node !== 'object' || node === null) return out;
  const record = node as Record<string, unknown>;
  if (typeof record['op'] === 'string') out.push({ op: record['op'], raw: record });
  for (const value of Object.values(record)) {
    if (typeof value === 'object' && value !== null) collectOps(value, out);
  }
  return out;
}

/** Whether a stat modifier is negative: a negative number, or a `negate` expression. */
function isNegative(value: unknown): boolean {
  if (typeof value === 'number') return value < 0;
  return (
    typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'negate'
  );
}

/** A "pump" whose toughness change is negative (Grasp of Darkness's -4/-4) shrinks or kills. */
function isShrink(record: OpRecord): boolean {
  return /^pump/.test(record.op) && isNegative(record.raw['toughness']);
}

function opPolarity(record: OpRecord): TargetPolarity {
  if (record.op === 'putCounters' && String(record.raw['counter'] ?? '').startsWith('-')) {
    return 'hostile';
  }
  if (isShrink(record)) return 'hostile';
  if (HOSTILE_OPS.test(record.op)) return 'hostile';
  if (FRIENDLY_OPS.test(record.op)) return 'friendly';
  return 'neutral';
}

interface AbilityLike {
  targets?: Array<{ kind?: string; controller?: string }>;
  effects?: unknown;
  modes?: unknown;
}

/** Polarity per target slot: the slot's controller restriction first, then the ops aimed at it. */
function targetPolarities(ability: AbilityLike | null | undefined): TargetPolarity[] {
  const specs = ability?.targets ?? [];
  const polarity: TargetPolarity[] = specs.map((spec) =>
    spec.controller === 'opponent' ? 'hostile' : spec.controller === 'you' ? 'friendly' : 'neutral',
  );
  const ops = collectOps([ability?.effects, ability?.modes]);
  for (const record of ops) {
    const slots: Array<[unknown, TargetPolarity]> = [];
    if (record.op === 'fight') {
      slots.push([record.raw['first'], 'friendly'], [record.raw['second'], 'hostile']);
    } else {
      slots.push([record.raw['target'], opPolarity(record)]);
    }
    for (const [slot, value] of slots) {
      if (typeof slot !== 'number' || slot < 0 || slot >= polarity.length) continue;
      if (polarity[slot] === 'neutral') polarity[slot] = value;
    }
  }
  return polarity;
}

/** A constant amount (`3` or `{kind:'const', n: 3}`), or null for anything computed. */
function constantAmount(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value !== null) {
    const v = value as { kind?: unknown; n?: unknown };
    if (v.kind === 'const' && typeof v.n === 'number') return v.n;
  }
  return null;
}

/** Fixed damage per target slot: the sum of the constant `dealDamage` ops aimed at it. */
function targetDamage(ability: AbilityLike | null | undefined): (number | null)[] {
  const damage: (number | null)[] = (ability?.targets ?? []).map(() => null);
  for (const record of collectOps([ability?.effects, ability?.modes])) {
    if (record.op !== 'dealDamage') continue;
    const slot = record.raw['target'];
    if (typeof slot !== 'number' || slot < 0 || slot >= damage.length) continue;
    const amount = constantAmount(record.raw['amount']);
    // A computed amount makes the slot's total unknown.
    damage[slot] = amount === null ? null : (damage[slot] ?? 0) + amount;
  }
  return damage;
}

/** A constant, non-negative boost from a pump op's `power` and `toughness`, or null. */
function constantBoost(record: OpRecord): StatBoost | null {
  const power = constantAmount(record.raw['power'] ?? 0);
  const toughness = constantAmount(record.raw['toughness'] ?? 0);
  if (power === null || toughness === null || power < 0 || toughness < 0) return null;
  if (power === 0 && toughness === 0) return null;
  return { power, toughness };
}

function addBoost(a: StatBoost | null, b: StatBoost): StatBoost {
  return a === null ? b : { power: a.power + b.power, toughness: a.toughness + b.toughness };
}

/** Constant boost per target slot from the `pump*` ops aimed at it (Giant Growth's +3/+3). */
function targetPump(ability: AbilityLike | null | undefined): (StatBoost | null)[] {
  const pump: (StatBoost | null)[] = (ability?.targets ?? []).map(() => null);
  for (const record of collectOps([ability?.effects, ability?.modes])) {
    if (!/^pump/.test(record.op) || /Each/.test(record.op)) continue;
    const slot = record.raw['target'];
    if (typeof slot !== 'number' || slot < 0 || slot >= pump.length) continue;
    const boost = constantBoost(record);
    if (boost !== null) pump[slot] = addBoost(pump[slot] ?? null, boost);
  }
  return pump;
}

/** A selector that means exactly "this permanent". */
function isSelf(selector: unknown): boolean {
  return (
    typeof selector === 'object' &&
    selector !== null &&
    (selector as { kind?: unknown }).kind === 'self'
  );
}

/** "Creatures you control": allOf(controller you, type Creature), in either order. */
function isOwnCreatures(selector: unknown): boolean {
  if (typeof selector !== 'object' || selector === null) return false;
  const s = selector as { kind?: unknown; of?: unknown };
  if (s.kind !== 'allOf' || !Array.isArray(s.of) || s.of.length !== 2) return false;
  const leaves = s.of as Array<{ kind?: unknown; who?: unknown; value?: unknown }>;
  return (
    leaves.some((l) => l.kind === 'controller' && l.who === 'you') &&
    leaves.some((l) => l.kind === 'type' && l.value === 'Creature')
  );
}

/** The constant boost an ability's effects give its own source (firebreathing), or null. */
function selfPump(ability: AbilityLike | null | undefined): StatBoost | null {
  let boost: StatBoost | null = null;
  for (const record of collectOps([ability?.effects, ability?.modes])) {
    if (record.op !== 'pumpEachUntilEot' || !isSelf(record.raw['selector'])) continue;
    const b = constantBoost(record);
    if (b === null) return null;
    boost = addBoost(boost, b);
  }
  return boost;
}

/** A constant team pump with the keywords it grants (Overrun), or undefined. */
function massPump(ability: AbilityLike | null | undefined): CardTraits['massPump'] {
  let boost: StatBoost | null = null;
  const keywords: string[] = [];
  for (const record of collectOps([ability?.effects, ability?.modes])) {
    if (!isOwnCreatures(record.raw['selector'])) continue;
    if (record.op === 'pumpEachUntilEot') {
      const b = constantBoost(record);
      if (b === null) return undefined;
      boost = addBoost(boost, b);
    } else if (
      record.op === 'grantKeywordEachUntilEot' &&
      typeof record.raw['keyword'] === 'string'
    ) {
      keywords.push(record.raw['keyword']);
    }
  }
  return boost === null ? undefined : { ...boost, keywords };
}

/** What one plain `{T}` of the card's best fixed mana ability makes. */
function manaUnits(def: CardDefinition): string[][] | undefined {
  let best: string[][] | undefined;
  for (const ability of def.manaAbilities) {
    const spec = ability as {
      units?: string[][];
      costs?: unknown[];
      dynamic?: unknown;
      condition?: unknown;
      restriction?: unknown;
    };
    if (spec.dynamic !== undefined || spec.condition !== undefined) continue;
    if (spec.restriction !== undefined || (spec.costs !== undefined && spec.costs.length > 0))
      continue;
    const units = spec.units ?? [];
    if (units.length > 0 && (best === undefined || units.length > best.length))
      best = units.map((unit) => [...unit]);
  }
  return best;
}

/**
 * Ops that are bookkeeping or card selection, not effects worth a role: shuffling after a search,
 * looking at or ordering the library (Brainstorm's put-back), attaching equipment, crewing,
 * transforming. A card made
 * only of these and role ops is classified (ADR 0044's "nothing notable"), not unknown.
 */
const NEUTRAL_OPS =
  /^(shuffle|scry|surveil|lookAtTopN$|putFromHandOnLibraryTop|attachSelfTo|crewVehicle|transformSelf)/;

/** Ops that wrap a whole ability or token definition: their inner ops are not the card's. */
const OPAQUE_WRAPPERS = /^(createToken|grantAbility|createEmblem|createAttachedToken)/;

/** Whether one effect op is accounted for by a role, a slot polarity, or the neutral list. */
function recognisedOp(op: string): boolean {
  if (ROLE_PATTERNS.some(([, pattern]) => pattern.test(op))) return true;
  if (HOSTILE_OPS.test(op) || FRIENDLY_OPS.test(op) || NEUTRAL_OPS.test(op)) return true;
  return (
    op === 'searchLibrary' || op === 'searchLibraryGroup' || /^pumpEach|^grantKeywordEach/.test(op)
  );
}

/**
 * Whether some leaf effect op in the tree is one the classifier cannot account for. A wrapper op
 * (a conditional, a modal choice, a payment) is looked through; a token or granted ability is
 * opaque, since its inner ops describe the token, not what the card does.
 */
function hasUnrecognisedOp(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasUnrecognisedOp);
  if (typeof node !== 'object' || node === null) return false;
  const record = node as Record<string, unknown>;
  if (typeof record['op'] === 'string') {
    const op = record['op'];
    if (OPAQUE_WRAPPERS.test(op)) return false;
    const children = Object.entries(record).filter(([key]) => key !== 'op');
    const nested = children.some(([, value]) => containsOp(value));
    if (!nested) return !recognisedOp(op);
    return children.some(([, value]) => hasUnrecognisedOp(value));
  }
  return Object.values(record).some(hasUnrecognisedOp);
}

function containsOp(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(containsOp);
  if (typeof node !== 'object' || node === null) return false;
  const record = node as Record<string, unknown>;
  return typeof record['op'] === 'string' || Object.values(record).some(containsOp);
}

/**
 * Whether a hostile op aimed at a permanent slot destroys or exiles it for good: `destroy*` and
 * `exile*` ops, and the `removeTarget*` family when its action is destroy or exile (Path to
 * Exile). Exiling a library, a graveyard or a card is not removal, and an exile that returns the
 * object (a blink) is not either; an exile that lasts while the source stays (Banishing Light)
 * is.
 */
function destroysOrExiles(ability: AbilityLike | null | undefined): boolean {
  const specs = ability?.targets ?? [];
  return collectOps([ability?.effects, ability?.modes]).some((record) => {
    const removeAction = record.raw['action'];
    const permanent = /^removeTarget/.test(record.op)
      ? removeAction === 'exile' || removeAction === 'destroy'
      : /^(destroy|exile)/.test(record.op) &&
        !/^exile(Top|Library|Card|Each|All|Graveyard|TargetPlayerGraveyard|FromHand)/.test(
          record.op,
        ) &&
        !/Return/.test(record.op);
    if (!permanent) return false;
    const slot = record.raw['target'] ?? record.raw['targetSlot'];
    const kind = typeof slot === 'number' ? (specs[slot]?.kind ?? '') : '';
    return kind !== 'player' && kind !== 'spell' && kind !== 'stackObject';
  });
}

const WIPE_OP = ROLE_PATTERNS.find(([role]) => role === 'wipe')![1];

/**
 * What the card's sweepers hit: their selectors joined with `anyOf`, plus a damage sweeper's
 * constant amount. A sweep with no selector (a sacrifice-each, Living Death) leaves the selector
 * undefined, so the bot assumes every creature is lost.
 */
function wipeShape(nodes: unknown[]): { selector?: WipeSelector; damage?: number } {
  const wipes = collectOps(nodes).filter((r) => WIPE_OP.test(r.op));
  if (wipes.length === 0) return {};
  const selectors: WipeSelector[] = [];
  for (const record of wipes) {
    const selector = record.raw['selector'];
    if (typeof selector !== 'object' || selector === null) return {};
    // "each creature target player controls" narrows further than the selector says.
    if (record.raw['controlledBy'] !== undefined) return {};
    selectors.push(selector as WipeSelector);
  }
  const damageOps = wipes.filter((r) => r.op === 'damageEach');
  const amounts = damageOps.map((r) => constantAmount(r.raw['amount']));
  const damage =
    damageOps.length === wipes.length && amounts.every((a) => a !== null)
      ? Math.min(...(amounts as number[]))
      : undefined;
  return {
    selector: selectors.length === 1 ? selectors[0]! : { kind: 'anyOf', of: selectors },
    ...(damage !== undefined ? { damage } : {}),
  };
}

/** Damage the spell ability deals to each player: a constant, 'X' for the spell's X, or absent. */
function damagesEachPlayer(def: CardDefinition): number | 'X' | undefined {
  const ops = collectOps([def.spellAbility]).filter((r) => r.op === 'damageEachPlayer');
  let total: number | 'X' | undefined;
  for (const record of ops) {
    const amount = record.raw['amount'];
    const constant = constantAmount(amount);
    const isX =
      typeof amount === 'object' &&
      amount !== null &&
      (amount as { kind?: unknown }).kind === 'xValue';
    // Only a lone op has a shape the veto can read; several ops, or any other amount, stay absent.
    if (ops.length !== 1) return undefined;
    if (constant !== null) total = constant;
    else if (isX) total = 'X';
    else return undefined;
  }
  return total;
}

function rolesOf(nodes: unknown[], ability?: AbilityLike | null): CardRole[] {
  const roles = new Set<CardRole>();
  const ops = collectOps(nodes);
  for (const record of ops) {
    if (
      /^grantKeyword/.test(record.op) &&
      PROTECTIVE_KEYWORDS.test(String(record.raw['keyword']))
    ) {
      roles.add('protection');
      continue;
    }
    // A shrink is removal (via the hostile slot below), not a pump.
    if (isShrink(record)) continue;
    for (const [role, pattern] of ROLE_PATTERNS) {
      if (pattern.test(record.op)) roles.add(role);
    }
    if (record.op === 'searchLibrary' || record.op === 'searchLibraryGroup') {
      roles.add(JSON.stringify(record.raw).includes('Land') ? 'ramp' : 'tutor');
    }
  }
  // A hostile op aimed at a permanent slot is spot removal; at a player slot it is burn/discard.
  const specs = ability?.targets ?? [];
  const polarity = targetPolarities(ability);
  polarity.forEach((p, i) => {
    if (p !== 'hostile') return;
    const kind = specs[i]?.kind ?? '';
    if (kind === 'player') return;
    if (kind === 'spell' || kind === 'stackObject') return;
    roles.add('removal');
  });
  return [...roles];
}

/** The first triggered ability that takes targets, which is how an ETB removal creature works. */
function firstTargetedTrigger(def: CardDefinition): AbilityLike | null {
  return (def.triggers.find((t) => t.targets.length > 0) as AbilityLike | undefined) ?? null;
}

export function cardTraits(def: CardDefinition): CardTraits {
  const manaValue = manaValueOf(def);
  const isPermanentSpell = def.spellAbility === null;
  const main: AbilityLike | null = isPermanentSpell
    ? firstTargetedTrigger(def)
    : (def.spellAbility as AbilityLike);
  const roles = new Set<CardRole>(
    rolesOf([def.spellAbility, def.triggers, def.staticEffects], main),
  );
  if (!def.types.includes('Land') && def.manaAbilities.length > 0) roles.add('ramp');
  const abilities = def.activatedAbilities.map((a) => a.ability as AbilityLike);
  const wipe = roles.has('wipe') ? wipeShape([def.spellAbility, def.triggers]) : {};
  const eachPlayer = isPermanentSpell ? undefined : damagesEachPlayer(def);
  const team = isPermanentSpell ? undefined : massPump(def.spellAbility as AbilityLike);
  const unclassified =
    def.modeled === false ||
    hasUnrecognisedOp([def.spellAbility, def.triggers, def.staticEffects, abilities]);
  const mana = manaUnits(def);
  return {
    manaValue,
    types: def.types,
    roles: [...roles],
    abilityRoles: abilities.map((a) => rolesOf([a.effects, a.modes], a)),
    spellTargets: targetPolarities(main),
    abilityTargets: abilities.map((a) => targetPolarities(a)),
    abilitySorcery: def.activatedAbilities.map((a) => a.timing === 'sorcery'),
    spellDamage: targetDamage(main),
    abilityDamage: abilities.map((a) => targetDamage(a)),
    ...(wipe.selector !== undefined ? { wipeSelector: wipe.selector } : {}),
    ...(wipe.damage !== undefined ? { wipeDamage: wipe.damage } : {}),
    ...(eachPlayer !== undefined ? { damagesEachPlayer: eachPlayer } : {}),
    spellPump: targetPump(main),
    abilitySelfPump: abilities.map((a) => selfPump(a)),
    ...(team !== undefined ? { massPump: team } : {}),
    ...(mana !== undefined ? { manaUnits: mana } : {}),
    ...(roles.has('removal') && destroysOrExiles(main) ? { hardRemoval: true } : {}),
    ...(unclassified ? { unclassified: true } : {}),
    power: def.power,
    toughness: def.toughness,
  };
}

/** Mana value of the printed cost (CR 202.3): X counts as 0, hybrid and Phyrexian pips as 1. */
function manaValueOf(def: CardDefinition): number {
  const cost = def.manaCost;
  if (cost === null) return 0;
  const colored = Object.values(cost.colored).reduce((sum, n) => sum + n, 0);
  return (
    cost.generic +
    colored +
    cost.colorless +
    (cost.hybrid?.length ?? 0) +
    (cost.phyrexian?.length ?? 0)
  );
}

/** A name lookup over a game's card definitions (the engine's `defs` map). */
export function buildCardKnowledge(defs: Iterable<CardDefinition>): CardKnowledge {
  const byName = new Map<string, CardTraits>();
  for (const def of defs) {
    const key = def.name.toLowerCase();
    if (byName.has(key)) continue;
    try {
      byName.set(key, cardTraits(def));
    } catch {
      // A malformed definition costs the bot one card's knowledge, never the game.
    }
    // Split and modal cards are shown by face name as well.
    const traits = byName.get(key);
    if (traits === undefined) continue;
    for (const face of def.name.split(' // ')) {
      if (!byName.has(face.toLowerCase())) byName.set(face.toLowerCase(), traits);
    }
  }
  return (name) => byName.get(name.toLowerCase());
}
