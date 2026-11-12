/**
 * Board arithmetic for ADR 0043's bot fixes: what is already on the stack, which attackers can
 * kill this seat, how much damage an attack gets through a defender's blockers, and which casting
 * order spends the most mana. Everything is computed from the seat's `PlayerView` and the card
 * traits it is given; hidden cards are never estimated.
 *
 * These are estimates for ranking the engine's menu, not rules claims: legality stays with the
 * engine (rules-engine constraints).
 */
import type { CardView, PermanentView, PlayerId, PlayerView } from '@mtg/shared';
import type { CardKnowledge, StatBoost } from './card-knowledge';

function keywordsOf(p: PermanentView): Set<string> {
  return new Set((p.keywords ?? []).map((k) => k.toLowerCase()));
}

function isCreature(p: PermanentView): boolean {
  return p.power !== undefined && p.power !== null;
}

/** Damage this seat's own spells on the stack will deal, by target id (a player or an object). */
export function pendingOwnDamage(
  view: PlayerView,
  knowledge: CardKnowledge | undefined,
): Map<string, number> {
  const pending = new Map<string, number>();
  if (knowledge === undefined) return pending;
  for (const item of view.stack) {
    if (item.controller !== view.seat) continue;
    const damage = knowledge(item.description)?.spellDamage;
    // A modal spell's unchosen slots are left out of `targets`, so slots line up only when the
    // counts agree; otherwise the amounts are unknown and nothing is counted.
    if (damage === undefined || damage.length !== item.targets.length) continue;
    item.targets.forEach((target, i) => {
      const amount = damage[i];
      if (amount !== null && amount !== undefined)
        pending.set(target, (pending.get(target) ?? 0) + amount);
    });
  }
  return pending;
}

/** Combat damage each creature attacking `seat` would deal to it as blocks stand now. */
export function incomingDamage(view: PlayerView, seat: PlayerId = view.seat): Map<string, number> {
  const byId = new Map(view.battlefield.map((p) => [p.id, p]));
  const incoming = new Map<string, number>();
  for (const attacker of view.battlefield) {
    if (attacker.attacking !== seat || attacker.attackingPlaneswalker !== undefined) continue;
    const power = Math.max(0, attacker.power ?? 0);
    const blockers = (attacker.blockedBy ?? []).map((id) => byId.get(id));
    let damage = power;
    if ((attacker.blockedBy ?? []).length > 0) {
      // A blocked creature stays blocked when its blockers leave (CR 509.1h); only trample gets
      // damage past them, and past dead or removed blockers in full.
      const toughness = blockers.reduce((sum, b) => sum + Math.max(0, b?.toughness ?? 0), 0);
      damage = keywordsOf(attacker).has('trample') ? Math.max(0, power - toughness) : 0;
    }
    if (damage > 0) incoming.set(attacker.id, damage);
  }
  return incoming;
}

/** An attacker or blocker reduced to what decides damage through a block. */
export interface CombatBody {
  id: string;
  power: number;
  toughness: number;
  flying: boolean;
  reach: boolean;
  trample: boolean;
  menace: boolean;
}

export function combatBody(p: PermanentView, boost?: StatBoost, keywords: readonly string[] = []) {
  const k = keywordsOf(p);
  for (const keyword of keywords) k.add(keyword.toLowerCase());
  return {
    id: p.id,
    power: Math.max(0, (p.power ?? 0) + (boost?.power ?? 0)),
    toughness: Math.max(0, (p.toughness ?? 0) + (boost?.toughness ?? 0)),
    flying: k.has('flying'),
    reach: k.has('reach'),
    trample: k.has('trample'),
    menace: k.has('menace'),
  } satisfies CombatBody;
}

function canBlock(blocker: CombatBody, attacker: CombatBody): boolean {
  return !attacker.flying || blocker.flying || blocker.reach;
}

/**
 * Damage an attack gets past the defender's blockers, assuming the defender blocks the biggest
 * attackers first, each with its toughest able blocker (two for menace). Deathtouch, first strike
 * and tricks are not modelled: this is a count for ranking, not a combat simulation.
 */
export function damageThrough(
  attackers: readonly CombatBody[],
  blockers: readonly CombatBody[],
): number {
  const free = [...blockers].sort((a, b) => b.toughness - a.toughness);
  let total = 0;
  for (const attacker of [...attackers].sort((a, b) => b.power - a.power)) {
    const able = free.filter((b) => canBlock(b, attacker));
    const needed = attacker.menace ? 2 : 1;
    if (able.length < needed) {
      total += attacker.power;
      continue;
    }
    const used = able.slice(0, needed);
    for (const b of used) free.splice(free.indexOf(b), 1);
    const absorbed = used.reduce((sum, b) => sum + b.toughness, 0);
    if (attacker.trample) total += Math.max(0, attacker.power - absorbed);
  }
  return total;
}

/** A seat's creatures that could block now: untapped creatures. */
export function untappedCreatures(view: PlayerView, seat: PlayerId): PermanentView[] {
  return view.battlefield.filter((p) => p.controller === seat && !p.tapped && isCreature(p));
}

/** This seat's creatures that could attack this turn: untapped, not summoning sick or hasty. */
export function readyAttackers(view: PlayerView, exclude: ReadonlySet<string> = new Set()) {
  return view.battlefield.filter((p) => {
    if (p.controller !== view.seat || p.tapped || !isCreature(p) || exclude.has(p.id)) return false;
    const k = keywordsOf(p);
    if (k.has('defender')) return false;
    return !p.status.includes('summoningSick') || k.has('haste');
  });
}

// --- Mana model and casting order ------------------------------------------------------------

/** One mana a source can make: the symbols it may be. */
type ManaUnit = readonly string[];

interface ParsedCost {
  generic: number;
  /** Coloured or colourless (`C`) pips, one entry per pip. */
  pips: string[];
}

/** Parse a displayed cost such as `{2}{G}{G}`; X counts as 0, hybrid as its first half. */
export function parseCost(cost: string | undefined): ParsedCost | null {
  if (cost === undefined) return null;
  const parsed: ParsedCost = { generic: 0, pips: [] };
  for (const match of cost.matchAll(/\{([^}]+)\}/g)) {
    const symbol = match[1]!.toUpperCase();
    if (/^\d+$/.test(symbol)) parsed.generic += Number(symbol);
    else if (symbol === 'X' || symbol === 'Y') continue;
    else if (/^[WUBRGC]$/.test(symbol)) parsed.pips.push(symbol);
    else if (/^[WUBRG]\/P$/.test(symbol)) parsed.pips.push(symbol[0]!);
    else if (/^2\/[WUBRG]$/.test(symbol)) parsed.generic += 2;
    else if (/^[WUBRG]\/[WUBRG]$/.test(symbol)) parsed.pips.push(symbol[0]!);
    else return null;
  }
  return parsed;
}

/** The view's untapped mana as units: single-symbol sources at their count, others once. */
export function manaUnitsOf(view: PlayerView): ManaUnit[] {
  const units: ManaUnit[] = [];
  for (const source of view.manaSources) {
    if (source.symbols.length <= 1) {
      for (let i = 0; i < source.count; i++) units.push(source.symbols);
    } else units.push(source.symbols);
  }
  return units;
}

/** Pay `cost` from `pool`, returning what is left, or null when it cannot be paid. */
export function pay(pool: readonly ManaUnit[], cost: ParsedCost): ManaUnit[] | null {
  const left = [...pool];
  const take = (pick: (unit: ManaUnit) => boolean, prefer: (u: ManaUnit) => number): boolean => {
    let best = -1;
    for (let i = 0; i < left.length; i++)
      if (pick(left[i]!) && (best === -1 || prefer(left[i]!) < prefer(left[best]!))) best = i;
    if (best === -1) return false;
    left.splice(best, 1);
    return true;
  };
  // Coloured pips from the source with the fewest alternatives, so a dual land is kept for later.
  for (const pip of cost.pips)
    if (
      !take(
        (u) => u.includes(pip),
        (u) => u.length,
      )
    )
      return null;
  // Generic from colourless first, then from the most plentiful colour.
  const plenty = (u: ManaUnit): number => {
    if (u.length === 1 && u[0] === 'C') return -1000;
    return -Math.max(...u.map((s) => left.filter((v) => v.includes(s)).length)) + u.length;
  };
  for (let i = 0; i < cost.generic; i++) if (!take(() => true, plenty)) return null;
  return left;
}

export interface CastCandidate {
  /** The menu action id when castable now; undefined for a hand card that is not yet. */
  actionId?: number;
  name: string;
  cost: ParsedCost;
  manaValue: number;
  /** Mana the spell makes this turn once it resolves (a rock, not a summoning-sick dork). */
  produces: ManaUnit[];
}

/** At most this many spells in an order: 4! = 24 orders (ADR 0043). */
export const MAX_ORDERED_SPELLS = 4;

/**
 * Every order of the candidates (at most `MAX_ORDERED_SPELLS`), each cast when it can be paid and
 * skipped when not. Returns the best total mana value cast and the menu actions that begin an
 * order reaching it. Draws and searches are unknown outcomes and not simulated.
 */
export function bestCastingOrder(
  pool: readonly ManaUnit[],
  candidates: readonly CastCandidate[],
): { best: number; firstActions: Set<number>; firstValues: Map<number, number> } {
  const firstValues = new Map<number, number>();
  let best = 0;
  const spells = candidates.slice(0, MAX_ORDERED_SPELLS);
  const walk = (
    left: readonly ManaUnit[],
    remaining: CastCandidate[],
    spent: number,
    first?: number,
  ) => {
    let castAny = false;
    for (let i = 0; i < remaining.length; i++) {
      const spell = remaining[i]!;
      const after = pay(left, spell.cost);
      if (after === null) continue;
      castAny = true;
      const rest = remaining.filter((_, j) => j !== i);
      const starter = first ?? spell.actionId;
      walk([...after, ...spell.produces], rest, spent + spell.manaValue, starter);
    }
    if (!castAny && first !== undefined) {
      firstValues.set(first, Math.max(firstValues.get(first) ?? 0, spent));
      best = Math.max(best, spent);
    }
  };
  walk(pool, spells, 0);
  const firstActions = new Set(
    [...firstValues.entries()].filter(([, value]) => value === best).map(([id]) => id),
  );
  return { best, firstActions, firstValues };
}

/** Mana a resolved spell makes this turn: a noncreature source's units, else none. */
export function producedThisTurn(card: Pick<CardView, 'name'>, knowledge: CardKnowledge) {
  const traits = knowledge(card.name);
  if (traits === undefined || traits.types.includes('Creature') || traits.types.includes('Land'))
    return [];
  return [...(traits.manaUnits ?? [])];
}
