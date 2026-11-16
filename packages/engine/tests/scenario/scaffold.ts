/**
 * Promotion scaffolds (hill-climb S4): scenario drafts generated from a card's interpreted IR, so
 * an agent promoting a card reviews scenarios instead of writing them.
 *
 * For each ability the generator understands, it arranges a position, plays the ability through
 * the production engine (cast or activate, the stack, resolution), and writes expectations that it
 * derives from the IR alone: "draw 2" expects exactly the top two cards in hand, "destroy target
 * creature" expects the target in its owner's graveyard. It then runs every draft through the real
 * scenario runner and keeps only the ones that pass. A draft that fails is reported with its
 * failure, never written.
 *
 * What a passing draft proves: the engine does what the IR says through the normal cast or
 * activation path. What it does not prove: that the IR says what the Oracle text says. That is the
 * review the agent still owes, which is why each draft's `expectedOutcome` is written in plain
 * English from the IR, to be read against the Oracle line it names in `clauses`.
 *
 * Expectations never come from watching the engine. The engine run only chooses the script (which
 * action and which target were offered) and then confirms the draft.
 */
import type { OracleCard } from '@mtg/shared';
import type { Ability, ActivatedAbility, Effect, TargetSpec } from '../../src/cards/ability';
import type { CardDefinition } from '../../src/cards/definition';
import { interpretCard } from '../../src/cards/interpret';
import type { Value } from '../../src/cards/value';
import type { ParsedManaCost } from '../../src/mana/cost';
import {
  buildCardScenario,
  parseCardScenarioFile,
  scenarioPattern,
  type CardResolver,
  type CardScenario,
  type CardScenarioFile,
  type PlacedSpec,
  type ScenarioExpectation,
  type ScenarioStep,
  type SeatSpec,
  type SupportCardSpec,
} from '../../src/testing/card-scenario';
import { runScenario, scenarioFailures } from './runner';

/** Bumped when the generator's output changes shape, so a reviewer knows which drafts are whose. */
export const SCAFFOLD_VERSION = 1;

/**
 * Every draft's title ends with this until a person or agent has read its expectations against
 * the Oracle line its `clauses` names. Reviewed drafts may satisfy manifest clauses (Paul,
 * 2026-11-16); `bun run card:scaffold "<name>" --approve <id>` rewrites the mark to
 * "(generated scaffold vN, reviewed)" and names the draft in the manifest, and `check:manifest-tests` refuses a
 * manifest reference to a draft that still carries this mark.
 */
export const DRAFT_MARK = `(generated scaffold v${SCAFFOLD_VERSION}, review against the Oracle line)`;
const DRAFT_MARK_PATTERN = /\(generated scaffold v(\d+), review against the Oracle line\)$/;
export const REVIEWED_DRAFT_MARK_PATTERN = /\(generated scaffold v(\d+), reviewed\)$/;

/** Whether a scenario title is a generated draft nobody has reviewed yet. */
export const isUnreviewedDraft = (title: string): boolean => DRAFT_MARK_PATTERN.test(title);

/** The title with its draft mark rewritten as reviewed; any other title is returned unchanged. */
export const markReviewed = (title: string): string =>
  title.replace(DRAFT_MARK_PATTERN, '(generated scaffold v$1, reviewed)');

/** One part of a card the generator looked at, and what became of it. */
export interface ScaffoldUnit {
  /** The definition part, as mutation labels name it: `spellAbility`, `triggers[0]`, `keywords`. */
  part: string;
  /** The 1-based Oracle line it exercises, or null when no single line could be named. */
  clause: number | null;
  /**
   * `scaffolded`: a draft passed and is in the file. `unsupported`: the generator does not draft
   * this shape (the reason says which part). `failed`: a draft was built but did not pass; the
   * reason is the runner's failure. On a reviewed card a failure is a generator gap; on an
   * unreviewed card it may be a card bug, and is worth a look either way.
   */
  status: 'scaffolded' | 'unsupported' | 'failed';
  reason?: string;
  scenarioIds: string[];
}

export interface ScaffoldResult {
  card: string;
  /** The file of passing drafts; `scenarios` is empty when nothing passed. */
  file: CardScenarioFile;
  units: ScaffoldUnit[];
}

const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// ── Support cards ────────────────────────────────────────────────────────────────────────────

const FOE = 'Scaffold Foe';
const ALLY = 'Scaffold Ally';
const RELIC = 'Scaffold Relic';
const CHARM = 'Scaffold Charm';
const PLOT = 'Scaffold Plot';
const PAGE = (n: number) => `Scaffold Page ${n}`;

const creatureSpec = (name: string, toughness: number): SupportCardSpec => ({
  name,
  typeLine: 'Creature — Bear',
  manaCost: '{G}',
  power: '1',
  toughness: String(toughness),
});

// ── Values and clauses ───────────────────────────────────────────────────────────────────────

/** A constant `Value`, or null for anything that depends on the game. */
function constant(value: Value | number | undefined): number | null {
  if (typeof value === 'number') return value;
  if (value !== undefined && value.kind === 'const') return value.n;
  return null;
}

/** Front-face Oracle lines with reminder text removed, as clause numbers count them. */
function oracleLines(card: OracleCard): string[] {
  return card.oracleText.split('\n').map((line) => line.replace(/\s*\([^)]*\)/g, '').trim());
}

const TRIGGER_LINE = /^(?:when|whenever|at)\b/i;
/** "{2}, {T}: …", "Equip {1}", "Boast — {1}{R}: …": a cost before a colon outside quotes. */
const ACTIVATED_LINE = /^[^"“]*?:\s/;
const MANA_LINE = /:\s*add\b/i;

/** Lines a spell's own effect could be on: not keywords, costs, triggers or activations. */
function spellLines(lines: string[], keywordLines: Set<number>): number[] {
  return lines.flatMap((line, index) =>
    line === '' ||
    keywordLines.has(index + 1) ||
    TRIGGER_LINE.test(line) ||
    ACTIVATED_LINE.test(line) ||
    /\b(?:costs? \{?\d*\}? ?less|additional cost|can't be countered)\b/i.test(line)
      ? []
      : [index + 1],
  );
}

const words = (text: string): string[] => text.toLowerCase().match(/[a-z0-9{}]+/g) ?? [];

/** The line an ability's description is closest to, when one clearly wins. */
function bestLine(description: string | undefined, candidates: number[], lines: string[]) {
  if (candidates.length === 1) return candidates[0]!;
  if (description === undefined || candidates.length === 0) return null;
  const want = new Set(words(description));
  const scored = candidates
    .map((line) => {
      const have = words(lines[line - 1]!);
      const shared = have.filter((word) => want.has(word)).length;
      return { line, score: shared / Math.max(1, Math.max(have.length, want.size)) };
    })
    .sort((a, b) => b.score - a.score);
  const [first, second] = scored;
  if (first === undefined || first.score < 0.5) return null;
  if (second !== undefined && second.score >= first.score - 0.15) return null;
  return first.line;
}

/** The engine's keyword name as the Oracle text writes it: `firstStrike` is "first strike". */
const keywordText = (keyword: string): string =>
  keyword.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

// ── Effects: arrangement and expectations ─────────────────────────────────────────────────────

type Seat = 'P1' | 'P2' | 'P3' | 'P4';
const OPPONENTS: Seat[] = ['P2', 'P3', 'P4'];

/** What one ability's draft needs and what it must show, built up effect by effect. */
interface Draft {
  seats: Record<Seat, SeatSpec>;
  support: Map<string, SupportCardSpec>;
  /** Preferred choice per target slot: a seat or a support card name. */
  slotChoice: Map<number, string>;
  lifeDelta: Record<Seat, number>;
  energyDelta: number;
  expect: ScenarioExpectation[];
  outcome: string[];
  /** Library cards the draft has used, so two library effects do not share them. */
  libraryUsed: boolean;
  /** Pages P1's library top has dealt so far to draw, mill, scry and surveil, in order. */
  pagesTaken: number;
  /** Where the last page-taking effect put its cards (null for the bottom). */
  lastLibrary: 'hand' | 'graveyard' | null;
  /** Exact descriptions of per-card choices to make (a scry's "Put … on the bottom"). */
  choices: string[];
  /** The card's printed power and toughness, for an effect on its own source. */
  sourcePower: string | null;
  sourceToughness: string | null;
  /** Names a later choice may pick by (a search's "Find Island"). */
  prefer: string[];
  /** Basics the draft pays with, which a search must not find. */
  avoid: Set<string>;
  /** Creatures that attack P2 when a combat comes up. */
  attackers: string[];
}

const BASIC_TYPES: Record<string, string> = {
  Plains: 'Plains',
  Island: 'Island',
  Swamp: 'Swamp',
  Mountain: 'Mountain',
  Forest: 'Forest',
};

/** Whether a basic land matches a search filter built from type, subtype and supertype leaves. */
function basicMatches(selector: Record<string, unknown>, basic: string): boolean | null {
  switch (selector['kind']) {
    case 'allOf':
    case 'anyOf': {
      const results = (selector['of'] as Record<string, unknown>[]).map((child) =>
        basicMatches(child, basic),
      );
      if (results.some((result) => result === null)) return null;
      return selector['kind'] === 'allOf' ? results.every(Boolean) : results.some(Boolean);
    }
    case 'type':
      return selector['value'] === 'Land';
    case 'subtype':
      return selector['value'] === basic;
    case 'supertype':
      return selector['value'] === 'Basic';
    default:
      return null;
  }
}

/** "Harmful" target effects aim at P2's permanent or P2; helpful ones at P1's. */
const HARMFUL = new Set([
  'destroy',
  'exile',
  'returnToHand',
  'tapTarget',
  'dealDamage',
  'loseLifeTarget',
]);

/** The permanent a slot of this kind is offered, and whose it is, for a harmful or helpful effect. */
function permanentFor(kind: TargetSpec['kind'], harmful: boolean): string | null {
  switch (kind) {
    case 'creature':
    case 'permanent':
    case 'nonlandPermanent':
    case 'anyTarget':
      return harmful ? FOE : ALLY;
    case 'artifact':
    case 'artifactOrEnchantment':
    case 'artifactEnchantmentOrPlaneswalker':
      return harmful ? RELIC : null;
    case 'enchantment':
      return harmful ? CHARM : null;
    case 'land':
      return harmful ? PLOT : null;
    default:
      return null;
  }
}

const SUPPORT_OF: Record<string, (toughness: number) => SupportCardSpec> = {
  [FOE]: (toughness) => creatureSpec(FOE, toughness),
  [ALLY]: (toughness) => creatureSpec(ALLY, toughness),
  [RELIC]: () => ({ name: RELIC, typeLine: 'Artifact', manaCost: '{1}' }),
  [CHARM]: () => ({ name: CHARM, typeLine: 'Enchantment', manaCost: '{1}' }),
  [PLOT]: () => ({ name: PLOT, typeLine: 'Land' }),
};

/** Places a support permanent for a slot (once) and returns its name. */
function placeTarget(draft: Draft, slot: number, name: string, toughness = 2): string {
  const owner: Seat = name === ALLY ? 'P1' : 'P2';
  if (!draft.support.has(name)) {
    draft.support.set(name, SUPPORT_OF[name]!(toughness));
    (draft.seats[owner].battlefield ??= []).push(name);
  }
  draft.slotChoice.set(slot, name);
  return name;
}

function ownerOf(name: string): Seat {
  return name === ALLY ? 'P1' : 'P2';
}

/** The next `n` pages of P1's arranged library top, in order. */
function takePages(draft: Draft, n: number): string[] {
  const pages = Array.from({ length: n }, (_, index) => PAGE(draft.pagesTaken + index + 1));
  draft.pagesTaken += n;
  return pages;
}

/**
 * Arranges the pages the effects took plus one more, and checks the extra one stayed where it
 * was: not in the zone the last draw or mill put cards into.
 */
function finishLibrary(draft: Draft): void {
  if (draft.pagesTaken === 0) return;
  const pages = Array.from({ length: draft.pagesTaken + 1 }, (_, index) => PAGE(index + 1));
  for (const page of pages) draft.support.set(page, creatureSpec(page, 1));
  draft.seats.P1.libraryTop = pages;
  draft.libraryUsed = true;
  if (draft.lastLibrary !== null)
    draft.expect.push({
      zone: { player: 'P1', zone: draft.lastLibrary, lacks: [pages[draft.pagesTaken]!] },
    });
}

/**
 * Adds one effect to the draft: what to arrange and what to expect. Returns null when the
 * effect is one the generator does not draft, with the reason.
 */
function addEffect(
  draft: Draft,
  effect: Effect,
  ability: Ability,
  sourceName: string,
): string | null {
  const targetSlot = (ref: unknown): { slot: number; spec: TargetSpec } | null =>
    typeof ref === 'number' && ability.targets[ref] !== undefined
      ? { slot: ref, spec: ability.targets[ref]! }
      : null;
  const amountOf = (value: Value | number | undefined): number | null => {
    const n = constant(value);
    return n === null || n < 0 ? null : n;
  };
  const e = effect as Effect & Record<string, unknown>;
  switch (effect.op) {
    case 'draw':
    case 'mill': {
      if (effect.op === 'draw' && (e['player'] ?? 'controller') !== 'controller')
        return 'draw for another player';
      const n = amountOf(e['count'] as Value);
      if (n === null || n === 0) return `${effect.op} a non-constant count`;
      if (draft.libraryUsed) return 'two library effects in one ability';
      // Pages are dealt from P1's arranged library top in order; the one after the last card an
      // effect takes must stay put, which `finishLibrary` checks.
      const pages = takePages(draft, n);
      const zone = effect.op === 'draw' ? 'hand' : 'graveyard';
      draft.lastLibrary = zone;
      draft.expect.push({ zone: { player: 'P1', zone, has: pages } });
      draft.outcome.push(
        effect.op === 'draw'
          ? `P1 draws exactly ${n} card${n === 1 ? '' : 's'}`
          : `P1 mills exactly ${n} card${n === 1 ? '' : 's'}`,
      );
      return null;
    }
    case 'scry':
    case 'surveil': {
      if ((e['player'] ?? 'controller') !== 'controller') return `${effect.op} for another player`;
      const n = amountOf(e['count'] as Value);
      if (n === null || n === 0) return `${effect.op} a non-constant count`;
      if (draft.libraryUsed) return 'two library effects in one ability';
      // Every looked-at card goes away (bottom or graveyard), so a later draw shows the scry
      // happened, and the event counts how many were looked at.
      const pages = takePages(draft, n);
      if (effect.op === 'scry' && n > 1) draft.choices.push('Keep the current bottom order');
      for (const page of pages)
        draft.choices.push(
          effect.op === 'scry' ? `Put ${page} on the bottom` : `Put ${page} into your graveyard`,
        );
      draft.expect.push({
        event: {
          type: effect.op,
          payload: effect.op === 'scry' ? `"looked":${n},"bottomed":${n}` : `"looked":${n}`,
          count: 1,
        },
      });
      if (effect.op === 'surveil') {
        draft.expect.push({ zone: { player: 'P1', zone: 'graveyard', has: pages } });
        draft.lastLibrary = 'graveyard';
      } else draft.lastLibrary = null;
      draft.outcome.push(
        effect.op === 'scry'
          ? `P1 scries ${n} and puts ${pages.join(', ')} on the bottom`
          : `P1 surveils ${n} and puts ${pages.join(', ')} into the graveyard`,
      );
      return null;
    }
    case 'gainLife':
    case 'loseLife': {
      const n = amountOf(e['amount'] as Value);
      if (n === null) return `${effect.op} a non-constant amount`;
      draft.lifeDelta.P1 += effect.op === 'gainLife' ? n : -n;
      draft.outcome.push(`P1 ${effect.op === 'gainLife' ? 'gains' : 'loses'} ${n} life`);
      return null;
    }
    case 'eachOpponentLosesLife':
    case 'eachOpponentDamage': {
      if (e['emptyHandOnly'] !== undefined) return 'a condition on the opponents';
      const n = amountOf(e['amount'] as Value);
      if (n === null) return `${effect.op} a non-constant amount`;
      for (const seat of OPPONENTS) draft.lifeDelta[seat] -= n;
      draft.outcome.push(
        effect.op === 'eachOpponentLosesLife'
          ? `each opponent loses ${n} life`
          : `${sourceName} deals ${n} damage to each opponent`,
      );
      return null;
    }
    case 'gainEnergy': {
      const n = amountOf(e['amount'] as Value);
      if (n === null) return 'energy of a non-constant amount';
      draft.energyDelta += n;
      draft.outcome.push(`P1 gets ${n} energy`);
      return null;
    }
    case 'drawTarget':
    case 'loseLifeTarget': {
      const target = targetSlot(e['target']);
      if (target === null || target.spec.kind !== 'player')
        return `${effect.op} without a player slot`;
      const n = amountOf((e['count'] ?? e['amount']) as Value);
      if (n === null) return `${effect.op} a non-constant amount`;
      // One slot may carry several effects ("target player draws two cards and loses 2 life"):
      // the first effect picks the player, the rest follow it.
      const seat = (draft.slotChoice.get(target.slot) ??
        (effect.op === 'drawTarget' ? 'P1' : 'P2')) as Seat;
      draft.slotChoice.set(target.slot, seat);
      if (effect.op === 'loseLifeTarget') {
        draft.lifeDelta[seat] -= n;
        draft.outcome.push(`the target player (${seat}) loses ${n} life`);
        return null;
      }
      if (n === 0 || draft.libraryUsed || draft.pagesTaken > 0)
        return 'drawTarget with a shared library';
      draft.libraryUsed = true;
      const pages = Array.from({ length: n + 1 }, (_, index) => PAGE(index + 1));
      for (const page of pages) draft.support.set(page, creatureSpec(page, 1));
      draft.seats[seat].libraryTop = pages;
      draft.expect.push({
        zone: { player: seat, zone: 'hand', has: pages.slice(0, n), lacks: [pages[n]!] },
      });
      draft.outcome.push(
        `the target player (${seat}) draws exactly ${n} card${n === 1 ? '' : 's'}`,
      );
      return null;
    }
    case 'dealDamage': {
      if (e['source'] !== undefined) return 'damage from another source';
      const target = targetSlot(e['target']);
      if (target === null) return 'damage to a non-target';
      const n = amountOf(e['amount'] as Value);
      if (n === null || n === 0) return 'damage of a non-constant amount';
      const kind = target.spec.kind;
      if (kind === 'player' || kind === 'playerOrPlaneswalker' || kind === 'anyTarget') {
        draft.slotChoice.set(target.slot, 'P2');
        draft.lifeDelta.P2 -= n;
        draft.outcome.push(`${sourceName} deals ${n} damage to the target player (P2)`);
        return null;
      }
      if (kind !== 'creature') return `damage to a ${kind} slot`;
      // Exactly lethal: one less damage would leave it alive.
      const name = `${FOE} ${n}`;
      if (!draft.support.has(name)) {
        draft.support.set(name, creatureSpec(name, n));
        (draft.seats.P2.battlefield ??= []).push(name);
      }
      draft.slotChoice.set(target.slot, name);
      draft.expect.push(
        { zone: { player: 'P2', zone: 'graveyard', has: [name] } },
        { event: { type: 'damage', payload: `"amount":${n}`, count: 1 } },
      );
      draft.outcome.push(
        `${sourceName} deals ${n} damage to the target ${n}-toughness creature, which dies`,
      );
      return null;
    }
    case 'destroy':
    case 'exile':
    case 'returnToHand':
    case 'tapTarget':
    case 'untapTarget':
    case 'putCounters':
    case 'pumpUntilEot':
    case 'grantKeywordUntilEot': {
      const ref = e['target'];
      if (
        effect.op === 'pumpUntilEot' &&
        (constant(e['power'] as Value) === null || constant(e['toughness'] as Value) === null)
      )
        return 'a pump of a non-constant size';
      if (effect.op === 'pumpUntilEot' && ref === 'source') {
        const p = constant(e['power'] as Value)!;
        const t = constant(e['toughness'] as Value)!;
        const basePower = Number(draft.sourcePower);
        const baseToughness = Number(draft.sourceToughness);
        if (!Number.isInteger(basePower) || !Number.isInteger(baseToughness))
          return 'a pump on a source with no printed power and toughness';
        if (baseToughness + t <= 0) return 'a pump that kills its source';
        draft.expect.push({
          stats: {
            card: sourceName,
            power: basePower + p,
            toughness: baseToughness + t,
            player: 'P1',
          },
        });
        draft.outcome.push(`${sourceName} gets ${p >= 0 ? '+' : ''}${p}/${t >= 0 ? '+' : ''}${t}`);
        return null;
      }
      if (effect.op === 'putCounters' && ref === 'source') {
        const n = amountOf(e['count'] as Value);
        if (n === null) return 'counters of a non-constant count';
        draft.expect.push({
          counters: { card: sourceName, counter: e['counter'] as string, equals: n, player: 'P1' },
        });
        draft.outcome.push(`${sourceName} gets ${n} ${e['counter'] as string} counter(s)`);
        return null;
      }
      const target = targetSlot(ref);
      if (target === null) return `${effect.op} on a non-target`;
      const pump =
        effect.op === 'pumpUntilEot'
          ? {
              power: constant(e['power'] as Value)!,
              toughness: constant(e['toughness'] as Value)!,
            }
          : null;
      const shrinks =
        (effect.op === 'putCounters' && e['counter'] === '-1/-1') ||
        (pump !== null && (pump.power < 0 || pump.toughness < 0));
      // A slot restricted to one side ("target creature you control") gets that side's permanent.
      const side = (target.spec as { controller?: string }).controller;
      const harmful =
        side === 'you' ? false : side === 'opponent' ? true : HARMFUL.has(effect.op) || shrinks;
      const name = permanentFor(target.spec.kind, harmful);
      if (name === null) return `${effect.op} on a ${target.spec.kind} slot`;
      // -1/-1 counters: a target one tougher than the count survives to be counted.
      const shrinkBy =
        pump !== null
          ? Math.max(0, -pump.toughness)
          : shrinks
            ? amountOf(e['count'] as Value)
            : null;
      if (shrinks && shrinkBy === null) return 'counters of a non-constant count';
      // A pump expects exact power and toughness, so its target must be placed for it alone.
      if (pump !== null && draft.support.has(name)) return 'a pump on a target another effect uses';
      const placedToughness = shrinkBy !== null && shrinkBy > 0 ? shrinkBy + 1 : 2;
      placeTarget(draft, target.slot, name, placedToughness);
      const owner = ownerOf(name);
      if (effect.op === 'destroy') {
        draft.expect.push(
          { zone: { player: owner, zone: 'graveyard', has: [name] } },
          { zone: { player: owner, zone: 'battlefield', lacks: [name] } },
        );
        draft.outcome.push(`the target ${name} is destroyed`);
      } else if (effect.op === 'exile') {
        draft.expect.push(
          { zone: { player: owner, zone: 'exile', has: [name] } },
          { zone: { player: owner, zone: 'battlefield', lacks: [name] } },
        );
        draft.outcome.push(`the target ${name} is exiled`);
      } else if (effect.op === 'returnToHand') {
        draft.expect.push({ zone: { player: owner, zone: 'hand', has: [name] } });
        draft.outcome.push(`the target ${name} returns to its owner's hand`);
      } else if (effect.op === 'tapTarget') {
        draft.expect.push({ tapped: { card: name, equals: true, player: owner } });
        draft.outcome.push(`the target ${name} becomes tapped`);
      } else if (effect.op === 'untapTarget') {
        if (name !== ALLY) return 'untap on a non-creature slot';
        const field = draft.seats.P1.battlefield!;
        field[field.indexOf(ALLY)] = { card: ALLY, tapped: true };
        draft.expect.push({ tapped: { card: name, equals: false, player: owner } });
        draft.outcome.push(`the tapped target ${name} untaps`);
      } else if (effect.op === 'putCounters') {
        const n = amountOf(e['count'] as Value);
        if (n === null) return 'counters of a non-constant count';
        draft.expect.push({
          counters: { card: name, counter: e['counter'] as string, equals: n, player: owner },
        });
        draft.outcome.push(`the target ${name} gets ${n} ${e['counter'] as string} counter(s)`);
      } else if (pump !== null) {
        if (name !== ALLY && name !== FOE) return 'a pump on a non-creature slot';
        draft.expect.push({
          stats: {
            card: name,
            power: 1 + pump.power,
            toughness: placedToughness + pump.toughness,
            player: owner,
          },
        });
        draft.outcome.push(
          `the target ${name} gets ${pump.power >= 0 ? '+' : ''}${pump.power}/${pump.toughness >= 0 ? '+' : ''}${pump.toughness} (1/${placedToughness} to ${1 + pump.power}/${placedToughness + pump.toughness})`,
        );
      } else {
        const keyword = e['keyword'] as string;
        draft.expect.push({ keywords: { card: name, has: [keyword], player: owner } });
        draft.outcome.push(`the target ${name} gains ${keywordText(keyword)}`);
      }
      return null;
    }
    case 'shuffle':
      // Nothing to see in a seeded library; a search before it carries the expectations.
      return ability.effects.some((other) => other.op === 'searchLibrary')
        ? null
        : 'a lone shuffle';
    case 'searchLibrary': {
      const destinations = e['destinations'] as Array<{ zone: string; tapped?: boolean }>;
      const count = e['count'] === undefined ? 1 : constant(e['count'] as Value);
      if (destinations.length !== 1 || count !== 1) return 'a search for several cards';
      const [destination] = destinations;
      if (destination!.zone !== 'battlefield' && destination!.zone !== 'hand')
        return `a search to the ${destination!.zone}`;
      if (draft.libraryUsed || draft.pagesTaken > 0) return 'two library effects in one ability';
      const found = Object.keys(BASIC_TYPES).find(
        (basic) =>
          !draft.avoid.has(basic) &&
          basicMatches(e['filter'] as Record<string, unknown>, basic) === true,
      );
      if (found === undefined) return 'a search filter the generator cannot satisfy with a basic';
      draft.libraryUsed = true;
      draft.seats.P1.libraryTop = [found];
      draft.prefer.push(found);
      draft.expect.push({
        zone: { player: 'P1', zone: destination!.zone as 'hand', has: [found] },
      });
      if (destination!.zone === 'battlefield')
        draft.expect.push({
          tapped: { card: found, equals: destination!.tapped === true, player: 'P1' },
        });
      draft.outcome.push(
        `P1 finds ${found} and puts it ${destination!.zone === 'hand' ? 'into their hand' : `onto the battlefield${destination!.tapped === true ? ' tapped' : ''}`}`,
      );
      return null;
    }
    case 'createToken': {
      if (e['powerOverride'] !== undefined || e['toughnessOverride'] !== undefined)
        return 'a token with changed size';
      const n = amountOf(e['count'] as Value);
      if (n === null || n === 0) return 'tokens of a non-constant count';
      const spec = e['spec'] as { name: string };
      draft.expect.push({
        event: { type: 'tokenCreated', payload: escapeRegex(`"${spec.name}`), count: n },
      });
      draft.expect.push({
        zone: { player: 'P1', zone: 'battlefield', has: Array<string>(n).fill(spec.name) },
      });
      if (e['tapped'] === true)
        draft.outcome.push(`P1 creates ${n} tapped ${spec.name} token${n === 1 ? '' : 's'}`);
      else draft.outcome.push(`P1 creates ${n} ${spec.name} token${n === 1 ? '' : 's'}`);
      return null;
    }
    default:
      return `the ${effect.op} effect`;
  }
}

// ── Mana ─────────────────────────────────────────────────────────────────────────────────────

const BASIC_OF: Record<string, string> = {
  W: 'Plains',
  U: 'Island',
  B: 'Swamp',
  R: 'Mountain',
  G: 'Forest',
};

/** Colorless mana: no basic in the committed pool makes {C}, so a support land does. */
const COLORLESS_LAND: SupportCardSpec = {
  name: 'Scaffold Barrens',
  typeLine: 'Land',
  oracleText: '{T}: Add {C}.',
};

/** Basics that pay a cost exactly, or null for a cost the generator does not pay. */
function landsFor(cost: ParsedManaCost | null, colors: readonly string[]): string[] | null {
  if (cost === null) return [];
  if ((cost.x ?? 0) > 0 || (cost.hybrid?.length ?? 0) > 0 || (cost.phyrexian?.length ?? 0) > 0)
    return null;
  const extra = cost as ParsedManaCost & Record<string, unknown>;
  for (const key of Object.keys(extra))
    if (!['generic', 'colored', 'colorless', 'x', 'hybrid', 'phyrexian'].includes(key)) return null;
  const filler = BASIC_OF[colors[0] ?? 'G'] ?? 'Forest';
  const lands: string[] = [];
  for (const [color, count] of Object.entries(cost.colored))
    lands.push(...Array<string>(count).fill(BASIC_OF[color]!));
  lands.push(...Array<string>(cost.colorless).fill(COLORLESS_LAND.name));
  lands.push(...Array<string>(cost.generic).fill(filler));
  return lands;
}

// ── Recording the script ─────────────────────────────────────────────────────────────────────

/** The recorder's answer when no priority action started the ability. */
const NOT_OFFERED = 'the engine never offered the action that starts it';

interface Intent {
  /** Matches the one priority action that starts the ability. */
  match: (description: string, type: string) => boolean;
  /** The starting action's targets by slot, when they are not the ability's own (a removal spell that kills the card). */
  targets?: string[];
  /**
   * No action starts it: the turn structure does (an upkeep or combat trigger, played through the
   * scenario's `continue`). Priority is always passed and the run ends with the game.
   */
  byTurn?: true;
}

/**
 * Plays the arranged draft once to learn its script: the action that starts the ability, and
 * each later choice the engine asks, answered with the draft's preferred targets ("Yes" to a
 * "you may"). Only the script comes from this run, never an expectation.
 */
function recordScript(
  file: CardScenarioFile,
  scenario: CardScenario,
  intent: Intent,
  draft: Draft,
  resolve: CardResolver,
): ScenarioStep[] | string {
  const { engine } = buildCardScenario(file, scenario, resolve, {
    gameId: `scaffold-${scenario.id}`,
    strictInvariants: true,
  });
  const names = (): Map<string, string> => {
    const state = engine.getState();
    const map = new Map<string, string>();
    for (const permanent of state.battlefield) map.set(permanent.id, permanent.name);
    for (const player of state.players) map.set(player.id, player.id);
    return map;
  };
  const steps: ScenarioStep[] = [];
  let started = intent.byTurn === true;
  for (let count = 0; count < 200; count++) {
    const step = engine.advance();
    // A prepared position ends its game once its priority window closes (no `continue`).
    if (step.kind === 'gameOver') {
      if (step.result.halted)
        return `the game halted: ${step.result.haltReason ?? step.result.haltSite ?? 'no reason'}`;
      return started ? steps : NOT_OFFERED;
    }
    if (step.kind === 'continue') continue;
    const request = step.request;
    const stackEmpty = engine.getState().stack.length === 0;
    if (request.decisionType === 'priority') {
      if (started && stackEmpty && intent.byTurn !== true) return steps;
      if (!started && request.decidingPlayer === 'P1') {
        const actions = request.legalActions.filter((action) =>
          intent.match(action.description, action.type),
        );
        if (actions.length === 0) return NOT_OFFERED;
        if (actions.length !== 1)
          return `${actions.length} actions start the ability:\n${request.legalActions.map((a) => `  ${a.description}`).join('\n')}`;
        const action = actions[0]!;
        const lookup = names();
        const targets: string[] = [];
        for (const slot of action.targets ?? []) {
          const want = intent.targets?.[slot.slot] ?? draft.slotChoice.get(slot.slot);
          const offered = slot.options.map((option) => lookup.get(option) ?? option);
          if (want === undefined || !offered.includes(want))
            return `target ${slot.slot + 1} offers ${offered.join(', ') || 'nothing'}, not ${want ?? 'a known choice'}`;
          targets.push(want);
        }
        steps.push({
          player: 'P1',
          choose: `/^${escapeRegex(action.description)}$/`,
          ...(targets.length > 0 && { targets }),
        });
        engine.submit({
          requestId: request.requestId,
          actionId: action.id,
          ...(action.targets !== undefined && {
            targets: action.targets.map((slot, index) => ({
              slot: slot.slot,
              choice: slot.options.find(
                (option) => (lookup.get(option) ?? option) === targets[index],
              )!,
            })),
          }),
        });
        started = true;
        continue;
      }
      const pass = request.legalActions.find((action) => action.type === 'pass')!;
      engine.submit({ requestId: request.requestId, actionId: pass.id });
      continue;
    }
    if (!started) return `a ${request.decisionType} decision before the ability started`;
    // Combat: the draft's attackers attack P2 and every other creature stays home; nobody blocks.
    if (request.decisionType === 'declareAttackers' || request.decisionType === 'declareBlockers') {
      const action = request.legalActions.find((candidate) => (candidate.targets ?? []).length > 0);
      if (action === undefined || request.legalActions.length !== 1)
        return `an unexpected ${request.decisionType} menu`;
      const lookup = names();
      const subjects = ((action as { data?: { subjects?: Array<{ subjectId: string }> } }).data
        ?.subjects ?? []) as Array<{ subjectId: string }>;
      const targets: string[] = [];
      for (const slot of action.targets!) {
        const subject = subjects[slot.slot];
        const attacks =
          request.decisionType === 'declareAttackers' &&
          subject !== undefined &&
          draft.attackers.includes(lookup.get(subject.subjectId) ?? '');
        const choice = attacks ? 'P2' : slot.options.find((option) => option.startsWith('__no'));
        if (choice === undefined || !slot.options.includes(choice))
          return `a ${request.decisionType} slot offers ${slot.options.join(', ')}`;
        targets.push(choice);
      }
      steps.push({
        player: request.decidingPlayer as Seat,
        choose: `/^${escapeRegex(action.description)}$/`,
        targets,
      });
      engine.submit({
        requestId: request.requestId,
        actionId: action.id,
        targets: action.targets!.map((slot, index) => ({
          slot: slot.slot,
          choice: targets[index]!,
        })),
      });
      continue;
    }
    // A later choice: a trigger's targets, or "you may".
    const lookup = names();
    const yes = request.legalActions.find((action) => /^yes\b/i.test(action.description));
    const withTargets = request.legalActions.filter((action) => (action.targets ?? []).length > 0);
    if (withTargets.length === 1) {
      const action = withTargets[0]!;
      const targets: string[] = [];
      for (const slot of action.targets!) {
        const want = draft.slotChoice.get(slot.slot);
        const offered = slot.options.map((option) => lookup.get(option) ?? option);
        if (want === undefined || !offered.includes(want))
          return `target ${slot.slot + 1} offers ${offered.join(', ') || 'nothing'}, not ${want ?? 'a known choice'}`;
        targets.push(want);
      }
      steps.push({
        player: request.decidingPlayer as Seat,
        choose: `/^${escapeRegex(action.description)}$/`,
        targets,
      });
      engine.submit({
        requestId: request.requestId,
        actionId: action.id,
        targets: action.targets!.map((slot, index) => ({
          slot: slot.slot,
          choice: slot.options.find((option) => (lookup.get(option) ?? option) === targets[index])!,
        })),
      });
      continue;
    }
    // A target decision offered as one action per candidate.
    const named = [...draft.slotChoice.values(), ...draft.prefer];
    const byName = request.legalActions.filter((action) =>
      named.some((name) =>
        new RegExp(`(?:^|\\s)${escapeRegex(name)}(?:\\s|$)`).test(action.description),
      ),
    );
    // Identical descriptions are one choice to the runner ("Put Plains …" for each Plains).
    const oneChoice =
      byName.length > 0 && byName.every((action) => action.description === byName[0]!.description);
    const listed = request.legalActions.filter((action) =>
      draft.choices.includes(action.description),
    );
    const choice = yes ?? (listed.length === 1 ? listed[0] : oneChoice ? byName[0] : undefined);
    if (choice === undefined)
      return `an unexpected ${request.decisionType} decision: "${request.prompt}" [${request.legalActions
        .slice(0, 6)
        .map((action) => action.description)
        .join(' | ')}]`;
    steps.push({
      player: request.decidingPlayer as Seat,
      choose: `/^${escapeRegex(choice.description)}$/`,
    });
    engine.submit({ requestId: request.requestId, actionId: choice.id });
  }
  return 'the ability did not finish resolving';
}

// ── Drafting each part ───────────────────────────────────────────────────────────────────────

interface Part {
  part: string;
  clause: number | null;
  /** Every line an instant or sorcery's one ability spans, when no single line says it all. */
  clauses?: number[];
  /** One mode of a modal spell: the cast action that names it, and the target slots it uses. */
  mode?: { index: number; description: string; slots: number[] };
  ability: Ability;
  /** How the ability starts, and where the card is arranged. */
  start: 'cast' | 'activate' | 'die' | 'watch' | 'phase';
  /** For `phase`: how the turn structure reaches the trigger, and whether the card attacks. */
  phase?: PhaseStart;
  /** For `watch`: the support card P1 plays or casts to fire the trigger. */
  watch?: Watcher;
  activated?: ActivatedAbility;
}

const ALLOWED_COSTS = new Set(['tap', 'sacrificeSelf', 'payLife']);

interface PhaseStart {
  turn?: CardScenario['turn'];
  continue: NonNullable<CardScenario['continue']>;
  /** The card attacks P2 unblocked: its attack and combat damage triggers. */
  attack: boolean;
  /** Words the trigger's line has, to pick it among the card's trigger lines. */
  line: RegExp;
  says: string;
}

/** Turn-structure triggers the generator drafts, by `trigger.when` and its player or subject. */
function phaseStart(trigger: Record<string, unknown>): PhaseStart | null {
  const keys = Object.keys(trigger).sort().join(',');
  const subject = trigger['subject'] as { kind?: string } | undefined;
  switch (trigger['when']) {
    case 'upkeep':
      if (keys !== 'player,when' || (trigger['player'] !== 'you' && trigger['player'] !== 'each'))
        return null;
      // From P4's turn the next upkeep is P1's, which "your" and "each" upkeep both see.
      return {
        turn: { player: 'P4' },
        continue: { throughUpkeeps: 1 },
        attack: false,
        line: /\bupkeep\b/i,
        says: "P1's next upkeep begins",
      };
    case 'endStep':
      if (keys !== 'player,when' || (trigger['player'] !== 'you' && trigger['player'] !== 'each'))
        return null;
      return {
        continue: { toEndStep: true },
        attack: false,
        line: /\bend step\b/i,
        says: "P1's end step begins",
      };
    case 'beginningOfCombat':
      if (keys !== 'player,when' || trigger['player'] !== 'you') return null;
      return {
        continue: { throughCombat: true },
        attack: false,
        line: /\bbeginning of combat\b/i,
        says: "combat on P1's turn begins",
      };
    case 'attacks':
      if (keys !== 'subject,when' || subject?.kind !== 'self') return null;
      return {
        continue: { throughCombat: true },
        attack: true,
        line: /\battacks?\b/i,
        says: 'it attacks P2, unblocked',
      };
    case 'dealsCombatDamageToPlayer':
      if (keys !== 'subject,when' || subject?.kind !== 'self') return null;
      return {
        continue: { throughCombat: true },
        attack: true,
        line: /\bcombat damage\b/i,
        says: 'it attacks P2, unblocked, and deals combat damage',
      };
    default:
      return null;
  }
}

/** A support card P1 plays or casts to fire a trigger on another permanent or spell. */
interface Watcher {
  spec: SupportCardSpec;
  /** The basics it costs. */
  lands: string[];
  play: boolean;
  /** It targets P4 with "gains 1 life", so the draft's P4 life moves by one. */
  p4Life: number;
}

/**
 * Tried in order for a trigger that watches other objects; the first whose draft passes wins.
 * Each one's own effect lands only on P4, which no drafted effect touches.
 */
const WATCHERS: Watcher[] = [
  { spec: { name: 'Scaffold Plot', typeLine: 'Land' }, lands: [], play: true, p4Life: 0 },
  {
    spec: {
      name: 'Scaffold Recruit',
      typeLine: 'Creature — Human Soldier',
      manaCost: '{W}',
      power: '1',
      toughness: '1',
    },
    lands: ['Plains'],
    play: false,
    p4Life: 0,
  },
  {
    spec: {
      name: 'Scaffold Spark',
      typeLine: 'Sorcery',
      manaCost: '{R}',
      oracleText: 'Target player gains 1 life.',
    },
    lands: ['Mountain'],
    play: false,
    p4Life: 1,
  },
  {
    spec: {
      name: 'Scaffold Flicker',
      typeLine: 'Instant',
      manaCost: '{U}',
      oracleText: 'Target player gains 1 life.',
    },
    lands: ['Island'],
    play: false,
    p4Life: 1,
  },
  {
    spec: { name: 'Scaffold Trinket', typeLine: 'Artifact', manaCost: '{1}' },
    lands: ['Plains'],
    play: false,
    p4Life: 0,
  },
  {
    spec: { name: 'Scaffold Wardstone', typeLine: 'Enchantment', manaCost: '{1}' },
    lands: ['Plains'],
    play: false,
    p4Life: 0,
  },
];

/** The removal spell a dies-trigger draft casts on the card. */
const SNUFF: SupportCardSpec = {
  name: 'Scaffold Snuff',
  typeLine: 'Instant',
  manaCost: '{B}',
  oracleText: 'Destroy target creature.',
};

function emptyDraft(): Draft {
  return {
    seats: { P1: {}, P2: {}, P3: {}, P4: {} },
    support: new Map(),
    slotChoice: new Map(),
    lifeDelta: { P1: 0, P2: 0, P3: 0, P4: 0 },
    energyDelta: 0,
    expect: [],
    outcome: [],
    libraryUsed: false,
    pagesTaken: 0,
    lastLibrary: null,
    choices: [],
    sourcePower: null,
    sourceToughness: null,
    prefer: [],
    avoid: new Set(),
    attackers: [],
  };
}

/** Why an ability's envelope is out of the generator's reach, or null. */
function envelopeGap(ability: Ability): string | null {
  const a = ability as Ability & Record<string, unknown>;
  if (a['modes'] !== undefined) return 'a modal ability';
  if (ability.optional === true && ability.kind !== 'triggered') return 'an optional ability';
  if (a['condition'] !== undefined || a['interveningIf'] !== undefined) return 'a condition';
  const trigger = ability.trigger as Record<string, unknown> | undefined;
  if (trigger?.['condition'] !== undefined || trigger?.['eventCondition'] !== undefined)
    return 'a trigger condition';
  if (
    ability.effects.some((effect) => (effect as Record<string, unknown>)['condition'] !== undefined)
  )
    return 'a conditional effect';
  if (ability.effects.length === 0) return 'an ability with no effects';
  if (ability.targets.some((target) => Object.keys(target).length > 1 && target.kind === 'player'))
    return 'a restricted player target';
  return null;
}

function draftPart(
  card: OracleCard,
  definition: CardDefinition,
  part: Part,
  resolve: CardResolver,
): { scenario?: CardScenario; support?: SupportCardSpec[]; gap?: string; failure?: string } {
  const gap = envelopeGap(part.ability);
  if (gap !== null) return { gap };
  const draft = emptyDraft();
  draft.sourcePower = card.power;
  draft.sourceToughness = card.toughness;
  // A search must not find a basic the draft pays with, or the expectations could not tell them apart.
  const payCost =
    part.start === 'activate'
      ? ((
          part.activated!.costs.find((cost) => cost.kind === 'mana') as
            { cost: ParsedManaCost } | undefined
        )?.cost ?? null)
      : part.start === 'die'
        ? null
        : definition.manaCost;
  for (const land of landsFor(payCost, definition.colors) ?? []) draft.avoid.add(land);
  if (part.start === 'die') draft.avoid.add('Swamp');
  for (const land of part.watch?.lands ?? []) draft.avoid.add(land);
  for (const effect of part.ability.effects) {
    const reason = addEffect(draft, effect, part.ability, card.name);
    if (reason !== null) return { gap: reason };
  }
  finishLibrary(draft);
  // Every target slot needs a choice the draft placed.
  const slots = part.mode?.slots ?? part.ability.targets.map((_, slot) => slot);
  for (const slot of slots)
    if (!draft.slotChoice.has(slot)) return { gap: `target slot ${slot + 1} is used by no effect` };

  const isPermanent = !definition.types.some((type) => type === 'Instant' || type === 'Sorcery');
  const id = `${slugOf(card.name)}-scaffold-${slugOf(part.part)}${
    part.mode === undefined ? '' : `-mode-${part.mode.index + 1}`
  }`;
  const instructions: string[] = [];
  let intent: Intent;
  const p1 = draft.seats.P1;
  if (part.start === 'cast') {
    if (definition.hasUnsupportedCost) return { gap: `the mana cost ${card.manaCost ?? ''}` };
    const lands = landsFor(definition.manaCost, definition.colors);
    if (lands === null) return { gap: `the mana cost ${card.manaCost ?? ''}` };
    const isLand = definition.types.includes('Land');
    p1.hand = [card.name];
    p1.battlefield = [...(isLand ? [] : lands), ...(p1.battlefield ?? [])];
    intent = isLand
      ? { match: (description) => description.startsWith(`Play ${card.name}`) }
      : {
          match: (description, type) =>
            type === 'castSpell' &&
            scenarioPattern(`/^Cast ${escapeRegex(card.name)} \\(/`)(description) &&
            (part.mode === undefined || description.endsWith(` — ${part.mode.description}`)),
        };
    instructions.push(
      `${isLand ? 'Play' : 'Cast'} ${card.name}${draft.slotChoice.size > 0 ? ` targeting ${[...draft.slotChoice.values()].join(' and ')}` : ''}, and let it resolve.`,
    );
    if (isPermanent)
      draft.expect.unshift({ zone: { player: 'P1', zone: 'battlefield', has: [card.name] } });
  } else if (part.start === 'watch') {
    const watcher = part.watch!;
    p1.battlefield = [card.name, ...watcher.lands, ...(p1.battlefield ?? [])];
    p1.hand = [watcher.spec.name];
    draft.support.set(watcher.spec.name, watcher.spec);
    for (const land of watcher.lands) draft.avoid.add(land);
    draft.lifeDelta.P4 += watcher.p4Life;
    intent = watcher.play
      ? { match: (description) => description.startsWith(`Play ${watcher.spec.name}`) }
      : {
          match: (description, type) =>
            type === 'castSpell' && description.startsWith(`Cast ${watcher.spec.name} (`),
          ...(watcher.p4Life > 0 && { targets: ['P4'] }),
        };
    instructions.push(
      `${watcher.play ? 'Play' : 'Cast'} ${watcher.spec.name}${watcher.p4Life > 0 ? ' targeting P4' : ''} with ${card.name} on the battlefield, and let everything resolve.`,
    );
    if (watcher.spec.typeLine !== 'Sorcery' && watcher.spec.typeLine !== 'Instant')
      draft.expect.unshift({
        zone: { player: 'P1', zone: 'battlefield', has: [watcher.spec.name] },
      });
  } else if (part.start === 'phase') {
    const phase = part.phase!;
    p1.battlefield = [card.name, ...(p1.battlefield ?? [])];
    intent = { match: () => false, byTurn: true };
    if (phase.attack) {
      const power = Number(card.power);
      if (!definition.types.includes('Creature') || !Number.isInteger(power) || power <= 0)
        return { gap: 'an attack trigger on a card with no printed power' };
      draft.attackers.push(card.name);
      draft.lifeDelta.P2 -= power;
      draft.outcome.unshift(`${card.name} deals ${power} combat damage to P2`);
    }
    draft.outcome.unshift(phase.says);
    instructions.push(
      phase.attack
        ? `Go to combat; ${card.name} attacks P2 and nothing blocks. Let every trigger resolve.`
        : `Pass until ${phase.says}, and let the trigger resolve.`,
    );
  } else if (part.start === 'die') {
    if (!definition.types.includes('Creature')) return { gap: 'a dies trigger on a noncreature' };
    p1.battlefield = [card.name, 'Swamp', ...(p1.battlefield ?? [])];
    p1.hand = [SNUFF.name];
    draft.support.set(SNUFF.name, SNUFF);
    intent = {
      match: (description, type) =>
        type === 'castSpell' && description.startsWith(`Cast ${SNUFF.name} (`),
      targets: [card.name],
    };
    instructions.push(`Cast ${SNUFF.name} on ${card.name}, and let the dies trigger resolve.`);
    draft.expect.unshift({ zone: { player: 'P1', zone: 'graveyard', has: [card.name] } });
    draft.outcome.unshift(`${card.name} dies`);
  } else {
    const activated = part.activated!;
    const costs = activated.costs.filter((cost) => cost.kind !== 'mana');
    const zone = activated.zone ?? 'battlefield';
    const allowed = zone === 'hand' ? new Set(['discardSelf']) : ALLOWED_COSTS;
    const extra = costs.find((cost) => !allowed.has(cost.kind));
    if (extra !== undefined) return { gap: `the ${extra.kind} cost` };
    if (zone !== 'battlefield' && zone !== 'hand')
      return { gap: `an ability activated from the ${zone}` };
    const a = activated as ActivatedAbility & Record<string, unknown>;
    for (const flag of ['condition', 'requiresAttackedThisTurn', 'exhaust', 'loyalty'])
      if (a[flag] !== undefined) return { gap: `an activation with ${flag}` };
    const manaCost = activated.costs.find((cost) => cost.kind === 'mana') as
      { kind: 'mana'; cost: ParsedManaCost } | undefined;
    const lands = landsFor(manaCost?.cost ?? null, definition.colors);
    if (lands === null)
      return { gap: 'an activation mana cost with X, hybrid or Phyrexian symbols' };
    if (zone === 'hand') {
      p1.hand = [card.name];
      p1.battlefield = [...lands, ...(p1.battlefield ?? [])];
    } else p1.battlefield = [card.name, ...lands, ...(p1.battlefield ?? [])];
    const index = definition.activatedAbilities.indexOf(activated);
    const description = part.ability.description;
    intent = {
      match: (text, type) =>
        type === 'activateAbility' &&
        text.startsWith(`${card.name}: `) &&
        (description === undefined
          ? definition.activatedAbilities.length === 1
          : text === `${card.name}: ${description}`),
    };
    instructions.push(
      `Activate ${card.name}'s ability${index > 0 ? ` #${index + 1}` : ''}${draft.slotChoice.size > 0 ? ` targeting ${[...draft.slotChoice.values()].join(' and ')}` : ''}, and let it resolve.`,
    );
    for (const cost of costs)
      if (cost.kind === 'payLife') {
        draft.lifeDelta.P1 -= cost.amount;
        draft.outcome.unshift(`P1 pays ${cost.amount} life`);
      }
    if (costs.some((cost) => cost.kind === 'discardSelf')) {
      draft.expect.unshift({ zone: { player: 'P1', zone: 'graveyard', has: [card.name] } });
      draft.outcome.unshift(`${card.name} is discarded`);
    }
    if (costs.some((cost) => cost.kind === 'sacrificeSelf')) {
      draft.expect.unshift({ zone: { player: 'P1', zone: 'graveyard', has: [card.name] } });
      draft.outcome.unshift(`${card.name} is sacrificed`);
    }
  }
  if (part.ability.optional === true) draft.outcome.unshift('P1 chooses to');
  if (part.mode !== undefined) draft.outcome.unshift(`P1 chooses "${part.mode.description}"`);

  const scenario: CardScenario = {
    id,
    title: `${card.name}: ${draft.outcome.join('; ')} ${DRAFT_MARK}`,
    clauses: part.clauses ?? (part.clause === null ? [] : [part.clause]),
    instructions,
    expectedOutcome: `${draft.outcome.join('; ')}.`.replace(/^./, (c) => c.toUpperCase()),
    seats: Object.fromEntries(
      Object.entries(draft.seats).filter(([, spec]) => Object.keys(spec).length > 0),
    ),
    script: [],
    expect: draft.expect,
    ...(part.phase?.turn !== undefined && { turn: part.phase.turn }),
    // Played to the end of the continuation: with `script` the run would stop at the arranged
    // priority window whenever P1 has something to do there.
    ...(part.phase !== undefined && { continue: part.phase.continue, end: 'gameOver' as const }),
  };
  const base = 40;
  for (const seat of ['P1', 'P2', 'P3', 'P4'] as const)
    if (draft.lifeDelta[seat] !== 0)
      scenario.expect.push({ life: { player: seat, equals: base + draft.lifeDelta[seat] } });
  if (draft.energyDelta !== 0)
    scenario.expect.push({ energy: { player: 'P1', equals: draft.energyDelta } });
  if (scenario.clauses.length === 0) return { gap: 'no single Oracle line names this ability' };

  if (Object.values(draft.seats).some((seat) => seat.battlefield?.includes(COLORLESS_LAND.name)))
    draft.support.set(COLORLESS_LAND.name, COLORLESS_LAND);
  const support = [...draft.support.values()];
  const file: CardScenarioFile = {
    schemaVersion: 1,
    card: card.name,
    supportCards: support,
    scenarios: [scenario],
  };
  const script = recordScript(file, scenario, intent, draft, resolve);
  // The recorder refusing is the generator's limit (a choice it cannot answer, a target it did
  // not arrange); only an expectation that does not hold on the confirming run is a failure.
  if (typeof script === 'string') return { gap: script };
  scenario.script = script;
  // A target the draft arranged must have been asked for; the engine choosing it alone (one
  // legal candidate, perhaps not ours) or finding none means the arrangement missed the filter.
  const ownTargets = script.filter(
    (step, index) => step.targets !== undefined && !(index === 0 && intent.targets !== undefined),
  );
  const autoTargeted = part.ability.targets.length > 0 && ownTargets.length === 0;
  // The confirming run: the real runner, a fresh engine, the draft's own expectations.
  const verdict = confirmVerdict(file, resolve);
  if (verdict.thrown !== undefined) return { gap: verdict.thrown };
  if (verdict.failures.length > 0 && autoTargeted)
    return {
      gap: 'the engine chose the only legal target itself, and it was not the arranged one',
    };
  if (verdict.failures.length > 0) return { failure: verdict.failures.join('; ') };
  return { scenario, support };
}

/** The keyword draft: the card on P1's battlefield has every printed keyword. */
function draftKeywords(
  card: OracleCard,
  definition: CardDefinition,
  lines: string[],
  resolve: CardResolver,
): ScaffoldUnit & { scenario?: CardScenario } {
  const keywords = definition.keywords;
  const clauses = new Set<number>();
  for (const keyword of keywords) {
    const text = keywordText(keyword);
    const line = lines.findIndex((candidate) =>
      candidate
        .toLowerCase()
        .split(/,\s*|\s+and\s+/)
        .some((piece) => piece.trim() === text),
    );
    if (line === -1)
      return {
        part: 'keywords',
        clause: null,
        status: 'unsupported',
        reason: `no keyword line names ${text}`,
        scenarioIds: [],
      };
    clauses.add(line + 1);
  }
  if (definition.types.includes('Instant') || definition.types.includes('Sorcery'))
    return {
      part: 'keywords',
      clause: null,
      status: 'unsupported',
      reason: 'keywords on a spell',
      scenarioIds: [],
    };
  if (definition.subtypes.includes('Aura'))
    return {
      part: 'keywords',
      clause: null,
      status: 'unsupported',
      reason: 'keywords on an Aura',
      scenarioIds: [],
    };
  if (definition.types.includes('Creature') && !((definition.toughness ?? 0) > 0))
    return {
      part: 'keywords',
      clause: null,
      status: 'unsupported',
      reason: 'a creature with no printed toughness',
      scenarioIds: [],
    };
  const id = `${slugOf(card.name)}-scaffold-keywords`;
  const scenario: CardScenario = {
    id,
    title: `${card.name}: it has ${keywords.map(keywordText).join(', ')} on the battlefield ${DRAFT_MARK}`,
    clauses: [...clauses].sort((a, b) => a - b),
    instructions: [`Look at ${card.name} on P1's battlefield.`],
    expectedOutcome: `${card.name} has ${keywords.map(keywordText).join(', ')}.`,
    seats: { P1: { battlefield: [card.name] } },
    script: [],
    expect: [{ keywords: { card: card.name, has: [...keywords], player: 'P1' } }],
  };
  const file: CardScenarioFile = { schemaVersion: 1, card: card.name, scenarios: [scenario] };
  try {
    const failures = scenarioFailures(runScenario(file, scenario, { resolve }), scenario);
    if (failures.length > 0)
      return {
        part: 'keywords',
        clause: scenario.clauses[0]!,
        status: 'failed',
        reason: failures.join('; '),
        scenarioIds: [],
      };
  } catch (error) {
    return {
      part: 'keywords',
      clause: scenario.clauses[0]!,
      status: 'unsupported',
      reason: (error as Error).message.split('\n')[0]!,
      scenarioIds: [],
    };
  }
  return {
    part: 'keywords',
    clause: scenario.clauses[0]!,
    status: 'scaffolded',
    scenarioIds: [id],
    scenario,
  };
}

// ── Static abilities ──────────────────────────────────────────────────────────────────────────

/** A creature a static draft places, and what a selector can ask of it. */
interface StaticSubject {
  name: string;
  seat: Seat;
  self: boolean;
  types: string[];
  subtypes: string[];
  colors: string[];
  attached: boolean;
  power: number;
  toughness: number;
}

/**
 * Whether a static's `affects` selector covers a subject, for the leaves a draft can arrange; null
 * for any other leaf, which leaves the static to the agent.
 */
function staticCovers(selector: Record<string, unknown>, subject: StaticSubject): boolean | null {
  const of = selector['of'];
  switch (selector['kind']) {
    case 'self':
      return subject.self;
    case 'other':
      return !subject.self;
    case 'attachedToSource':
      return subject.attached;
    case 'isToken':
      return false;
    case 'type':
      return subject.types.includes(selector['value'] as string);
    case 'subtype':
      return subject.subtypes.includes(selector['value'] as string);
    case 'color':
      return subject.colors.includes(selector['value'] as string);
    case 'controller': {
      const who = selector['who'];
      if (who === 'you') return subject.seat === 'P1';
      if (who === 'opponents') return subject.seat !== 'P1';
      return null;
    }
    case 'not': {
      const inner = staticCovers(of as Record<string, unknown>, subject);
      return inner === null ? null : !inner;
    }
    case 'allOf': {
      let all = true;
      for (const part of of as Array<Record<string, unknown>>) {
        const covered = staticCovers(part, subject);
        if (covered === null) return null;
        all &&= covered;
      }
      return all;
    }
    default:
      return null;
  }
}

/** Every `value` of one leaf kind in a selector. */
function selectorValues(selector: unknown, kind: string): string[] {
  if (selector === null || typeof selector !== 'object') return [];
  const record = selector as Record<string, unknown>;
  const own = record['kind'] === kind ? [record['value'] as string] : [];
  return [
    ...own,
    ...Object.values(record).flatMap((value) =>
      Array.isArray(value)
        ? value.flatMap((item) => selectorValues(item, kind))
        : selectorValues(value, kind),
    ),
  ];
}

const COLOR_SYMBOL: Record<string, string> = { W: 'W', U: 'U', B: 'B', R: 'R', G: 'G' };

/**
 * A static ability's draft: the card on P1's battlefield with creatures arranged on both sides of
 * its selector, each expected to have the keyword or the power and toughness the IR gives exactly
 * when the selector covers it. Creatures it does not cover are expected unchanged, so the draft
 * also catches a widened selector. Covers layer 6 keyword grants and layer 7c/7d constant P/T
 * changes; anything else is left to the agent.
 */
function draftStatic(
  card: OracleCard,
  definition: CardDefinition,
  index: number,
  lines: string[],
  candidates: number[],
  resolve: CardResolver,
): ScaffoldUnit & { scenario?: CardScenario; support?: SupportCardSpec[] } {
  const part = `staticEffects[${index}]`;
  const unit = (status: ScaffoldUnit['status'], reason?: string, clause: number | null = null) => ({
    part,
    clause,
    status,
    ...(reason !== undefined && { reason }),
    scenarioIds: [],
  });
  const effect = definition.staticEffects[index]!;
  if (effect.condition !== undefined) return unit('unsupported', 'a static with a condition');
  const op = effect.op as Record<string, unknown>;
  let keyword: string | null = null;
  let delta: { power: number; toughness: number } | null = null;
  if (op['layer'] === 6 && typeof op['addKeyword'] === 'string' && Object.keys(op).length === 2)
    keyword = op['addKeyword'];
  else if (op['layer'] === 7 && (op['sublayer'] === 'c' || op['sublayer'] === 'd')) {
    const power = constant(op['power'] as Value | number | undefined);
    const toughness = constant(op['toughness'] as Value | number | undefined);
    if (power === null || toughness === null || Object.keys(op).length !== 4)
      return unit('unsupported', 'a static power/toughness change that is not constant');
    delta = { power, toughness };
  } else
    return unit(
      'unsupported',
      `the static ${Object.keys(op)
        .filter((key) => key !== 'layer' && key !== 'sublayer')
        .join(', ')} (layer ${String(op['layer'])}${(op['sublayer'] as string | undefined) ?? ''})`,
    );

  // The line: the only candidate, or the one naming the keyword or the +N/+N.
  const signed = (n: number) => (n < 0 ? `-${-n}` : `+${n}`);
  const named = candidates.filter((line) => {
    const text = lines[line - 1]!.toLowerCase();
    return keyword !== null
      ? text.includes(keywordText(keyword))
      : text.includes(`${signed(delta!.power)}/${signed(delta!.toughness)}`);
  });
  const clause = candidates.length === 1 ? candidates[0]! : named.length === 1 ? named[0]! : null;
  if (clause === null) return unit('unsupported', 'no single Oracle line names this static');

  const affects = effect.affects as Record<string, unknown>;
  const attaches = JSON.stringify(affects).includes('"attachedToSource"');
  const isCreature = definition.types.includes('Creature');
  if (attaches && isCreature)
    return unit('unsupported', 'a creature that grants to what it is attached to');
  if (attaches && !definition.subtypes.some((type) => type === 'Equipment' || type === 'Aura'))
    return unit('unsupported', 'an attached static on neither an Aura nor an Equipment');
  const subtypes = [...new Set(selectorValues(affects, 'subtype'))];
  const colors = [...new Set(selectorValues(affects, 'color'))];
  if (colors.some((color) => COLOR_SYMBOL[color] === undefined))
    return unit('unsupported', 'a color the draft cannot give a creature');
  const toughness = 2 + Math.max(0, -(delta?.toughness ?? 0));
  // Support cards are shared by name across a file's drafts, so a non-default creature gets a
  // name of its own.
  const distinct = subtypes.length > 0 || colors.length > 0 || toughness !== 2;
  const nameOf = (base: string) => (distinct ? `${base} ${index + 1}` : base);
  const squire = nameOf('Scaffold Squire');
  const subject = (
    name: string,
    seat: Seat,
    withFilters: boolean,
    attached = false,
  ): StaticSubject & { spec: SupportCardSpec } => {
    const types = withFilters && subtypes.length > 0 ? subtypes : ['Bear'];
    const hue = withFilters && colors.length > 0 ? colors[0]! : 'G';
    return {
      name,
      seat,
      self: false,
      types: ['Creature'],
      subtypes: types,
      colors: [hue],
      attached,
      power: 2,
      toughness,
      spec: {
        name,
        typeLine: `Creature — ${types.join(' ')}`,
        manaCost: `{${COLOR_SYMBOL[hue]!}}`,
        power: '2',
        toughness: String(toughness),
      },
    };
  };
  const subjects = [
    subject(squire, 'P1', true, attaches),
    subject(nameOf('Scaffold Rival'), 'P2', true),
    ...(subtypes.length > 0 || colors.length > 0
      ? [subject(nameOf('Scaffold Stranger'), 'P1', false)]
      : []),
  ];
  const printedPower = Number(card.power);
  const printedToughness = Number(card.toughness);
  const selfSubject: StaticSubject | null =
    isCreature && Number.isInteger(printedPower) && Number.isInteger(printedToughness)
      ? {
          name: card.name,
          seat: 'P1',
          self: true,
          types: definition.types,
          subtypes: definition.subtypes,
          colors: definition.colors,
          attached: false,
          power: printedPower,
          toughness: printedToughness,
        }
      : null;
  if (isCreature && selfSubject === null)
    return unit('unsupported', 'a creature with no printed power and toughness', clause);

  const expect: ScenarioExpectation[] = [];
  const outcome: string[] = [];
  for (const target of [...(selfSubject === null ? [] : [selfSubject]), ...subjects]) {
    const covered = staticCovers(affects, target);
    if (covered === null)
      return unit('unsupported', 'a static selector the draft cannot arrange', clause);
    if (target.self && delta !== null && covered && target.toughness + delta.toughness <= 0)
      return unit('unsupported', 'a static that would kill the card itself', clause);
    if (keyword !== null)
      expect.push({
        keywords: {
          card: target.name,
          player: target.seat,
          ...(covered ? { has: [keyword] } : { lacks: [keyword] }),
        },
      });
    else
      expect.push({
        stats: {
          card: target.name,
          player: target.seat,
          power: target.power + (covered ? delta!.power : 0),
          toughness: target.toughness + (covered ? delta!.toughness : 0),
        },
      });
    if (covered)
      outcome.push(
        keyword !== null
          ? `${target.name} (${target.seat}) has ${keywordText(keyword)}`
          : `${target.name} (${target.seat}) is ${target.power + delta!.power}/${target.toughness + delta!.toughness}`,
      );
  }
  if (outcome.length === 0)
    return unit('unsupported', 'no arranged creature falls under the static', clause);
  // A keyword the subject has printed would pass whether or not the static works.
  if (keyword !== null && selfSubject !== null && definition.keywords.includes(keyword as never))
    return unit('unsupported', 'the card already has the keyword it grants', clause);

  const p1Battlefield: Array<string | PlacedSpec> = [
    attaches ? { card: card.name, attachedTo: { player: 'P1', card: squire } } : card.name,
    ...subjects.filter((target) => target.seat === 'P1').map((target) => target.name),
  ];
  const id = `${slugOf(card.name)}-scaffold-${slugOf(part)}`;
  const scenario: CardScenario = {
    id,
    title: `${card.name}: ${outcome.join('; ')} ${DRAFT_MARK}`,
    clauses: [clause],
    instructions: [
      `Look at ${card.name}${attaches ? ` attached to ${squire}` : ''} and the creatures on each side.`,
    ],
    expectedOutcome: `${outcome.join('; ')}; the other arranged creatures are unchanged.`,
    seats: {
      P1: { battlefield: p1Battlefield },
      P2: { battlefield: subjects.filter((target) => target.seat === 'P2').map((t) => t.name) },
    },
    script: [],
    expect,
  };
  const support = subjects.map((target) => target.spec);
  const file: CardScenarioFile = {
    schemaVersion: 1,
    card: card.name,
    supportCards: support,
    scenarios: [scenario],
  };
  const verdict = confirmVerdict(file, resolve);
  if (verdict.thrown !== undefined) return unit('unsupported', verdict.thrown, clause);
  if (verdict.failures.length > 0) return unit('failed', verdict.failures.join('; '), clause);
  return { ...unit('scaffolded', undefined, clause), scenarioIds: [id], scenario, support };
}

/**
 * Runs one draft through the real runner on a fresh engine. `failures` are expectations that did
 * not hold, the only outcome reported as a failed draft; `thrown` is a run that did not fit its
 * arrangement (an unanswered choice), which is the generator's limit.
 */
function confirmVerdict(
  file: CardScenarioFile,
  resolve: CardResolver,
): { failures: string[]; thrown?: string } {
  try {
    const parsed = parseCardScenarioFile(JSON.parse(JSON.stringify(file)));
    return {
      failures: scenarioFailures(
        runScenario(parsed, parsed.scenarios[0]!, { resolve }),
        parsed.scenarios[0]!,
      ),
    };
  } catch (error) {
    return { failures: [], thrown: (error as Error).message.split('\n')[0]! };
  }
}

const SIMPLE_MANA_KEYS = new Set(['units', 'costs']);
const SYMBOL_TEXT: Record<string, string> = { W: 'W', U: 'U', B: 'B', R: 'R', G: 'G', C: 'C' };

/**
 * Mana ability drafts, one per symbol a choice offers: the card alone pays a support creature
 * whose cost is exactly what the ability makes, and ends up tapped. Only `{T}`-cost abilities with
 * fixed output; riders, restrictions and dynamic amounts are left to the agent.
 */
function draftMana(
  card: OracleCard,
  definition: CardDefinition,
  index: number,
  clause: number | null,
  resolve: CardResolver,
): { unit: ScaffoldUnit; scenarios: CardScenario[]; support: SupportCardSpec[] } {
  const part = `manaAbilities[${index}]`;
  const ability = definition.manaAbilities[index]!;
  const unit = (
    status: ScaffoldUnit['status'],
    reason?: string,
    ids: string[] = [],
  ): ScaffoldUnit => ({
    part,
    clause,
    status,
    ...(reason !== undefined && { reason }),
    scenarioIds: ids,
  });
  const extra = Object.keys(ability).find(
    (key) =>
      !SIMPLE_MANA_KEYS.has(key) &&
      (ability as unknown as Record<string, unknown>)[key] !== undefined,
  );
  if (extra !== undefined)
    return {
      unit: unit('unsupported', `a mana ability with ${extra}`),
      scenarios: [],
      support: [],
    };
  if (
    ability.costs !== undefined &&
    !(ability.costs.length === 1 && ability.costs[0]!.kind === 'tap')
  )
    return {
      unit: unit('unsupported', 'a mana ability with a cost other than {T}'),
      scenarios: [],
      support: [],
    };
  if (clause === null)
    return {
      unit: unit('unsupported', 'no single Oracle line names this ability'),
      scenarios: [],
      support: [],
    };
  if (definition.types.includes('Creature') && !((definition.toughness ?? 0) > 0))
    return {
      unit: unit('unsupported', 'a creature with no printed toughness'),
      scenarios: [],
      support: [],
    };
  const widest = Math.max(...ability.units.map((choice) => choice.length));
  const scenarios: CardScenario[] = [];
  const support: SupportCardSpec[] = [];
  for (let pick = 0; pick < widest; pick++) {
    const symbols = ability.units.map((choice) => choice[Math.min(pick, choice.length - 1)]!);
    if (symbols.some((symbol) => SYMBOL_TEXT[symbol] === undefined))
      return {
        unit: unit('unsupported', 'a mana symbol the generator cannot spend'),
        scenarios: [],
        support: [],
      };
    const cost = symbols.map((symbol) => `{${symbol}}`).join('');
    const sink: SupportCardSpec = {
      name: `Scaffold Sink ${symbols.join('')}`,
      typeLine: 'Creature — Construct',
      manaCost: cost,
      power: '1',
      toughness: '1',
    };
    const scenario: CardScenario = {
      id: `${slugOf(card.name)}-scaffold-${slugOf(part)}-${symbols.join('').toLowerCase()}`,
      title: `${card.name}: its mana ability pays ${cost} ${DRAFT_MARK}`,
      clauses: [clause],
      instructions: [`Cast ${sink.name} (${cost}) with only ${card.name}'s mana.`],
      expectedOutcome: `${sink.name} is on the battlefield and ${card.name} is tapped.`,
      seats: { P1: { hand: [sink.name], battlefield: [card.name] } },
      script: [{ player: 'P1', choose: `/^Cast ${escapeRegex(sink.name)} \\(/` }],
      expect: [
        { zone: { player: 'P1', zone: 'battlefield', has: [sink.name] } },
        { tapped: { card: card.name, equals: true, player: 'P1' } },
      ],
    };
    const verdict = confirmVerdict(
      { schemaVersion: 1, card: card.name, supportCards: [sink], scenarios: [scenario] },
      resolve,
    );
    if (verdict.thrown !== undefined)
      return { unit: unit('unsupported', verdict.thrown), scenarios: [], support: [] };
    if (verdict.failures.length > 0)
      return { unit: unit('failed', verdict.failures.join('; ')), scenarios: [], support: [] };
    scenarios.push(scenario);
    support.push(sink);
  }
  return {
    unit: unit(
      'scaffolded',
      undefined,
      scenarios.map((scenario) => scenario.id),
    ),
    scenarios,
    support,
  };
}

/**
 * The arrival draft for replacement fields: play or cast the card and check it enters tapped
 * (`entersTapped`) or with its counters (`entersWithCounters`, constant counts only).
 */
function draftArrival(
  card: OracleCard,
  definition: CardDefinition,
  lines: string[],
  resolve: CardResolver,
): { units: ScaffoldUnit[]; scenario?: CardScenario } {
  const parts: string[] = [];
  const expect: ScenarioExpectation[] = [
    { zone: { player: 'P1', zone: 'battlefield', has: [card.name] } },
  ];
  const outcome: string[] = [];
  const clauses = new Set<number>();
  const units: ScaffoldUnit[] = [];
  if (definition.entersTapped) {
    const line = lines.findIndex((text) => /\benters(?: the battlefield)? tapped\b/i.test(text));
    if (definition.entersTappedUnless !== undefined || line === -1)
      units.push({
        part: 'entersTapped',
        clause: null,
        status: 'unsupported',
        reason: 'a conditional or unnamed enters-tapped line',
        scenarioIds: [],
      });
    else {
      parts.push('entersTapped');
      clauses.add(line + 1);
      expect.push({ tapped: { card: card.name, equals: true, player: 'P1' } });
      outcome.push('it enters tapped');
    }
  }
  if (definition.entersWithCounters !== undefined) {
    const line = lines.findIndex((text) => /\benters(?: the battlefield)? with\b/i.test(text));
    const counts = Object.entries(definition.entersWithCounters).map(
      ([counter, value]) => [counter, constant(value as Value | number)] as const,
    );
    if (line === -1 || counts.some(([, n]) => n === null))
      units.push({
        part: 'entersWithCounters',
        clause: null,
        status: 'unsupported',
        reason: 'counters of a non-constant count',
        scenarioIds: [],
      });
    else {
      parts.push('entersWithCounters');
      clauses.add(line + 1);
      for (const [counter, n] of counts) {
        expect.push({ counters: { card: card.name, counter, equals: n!, player: 'P1' } });
        outcome.push(`it enters with ${n} ${counter} counter(s)`);
      }
    }
  }
  if (parts.length === 0) return { units };
  const isLand = definition.types.includes('Land');
  const lands = isLand ? [] : landsFor(definition.manaCost, definition.colors);
  const failAll = (status: ScaffoldUnit['status'], reason: string) => ({
    units: [
      ...units,
      ...parts.map((part) => ({ part, clause: null, status, reason, scenarioIds: [] })),
    ],
  });
  // An enters trigger acts on arrival too (a bounce land returns a land); its own draft covers it.
  if (
    definition.triggers.some((ability) => {
      const trigger = ability.trigger as { when?: string; subject?: { kind: string } } | undefined;
      return trigger?.when === 'enters' && trigger.subject?.kind === 'self';
    })
  )
    return failAll('unsupported', 'an enters trigger also acts on arrival');
  if (lands === null || definition.hasUnsupportedCost)
    return failAll('unsupported', `the mana cost ${card.manaCost ?? ''}`);
  const scenario: CardScenario = {
    id: `${slugOf(card.name)}-scaffold-arrival`,
    title: `${card.name}: ${outcome.join('; ')} ${DRAFT_MARK}`,
    clauses: [...clauses].sort((a, b) => a - b),
    instructions: [`${isLand ? 'Play' : 'Cast'} ${card.name}.`],
    expectedOutcome: `${card.name} is on the battlefield; ${outcome.join('; ')}.`,
    seats: { P1: { hand: [card.name], ...(lands.length > 0 && { battlefield: lands }) } },
    script: [],
    expect,
  };
  const file: CardScenarioFile = { schemaVersion: 1, card: card.name, scenarios: [scenario] };
  const draft = emptyDraft();
  const script = recordScript(
    file,
    scenario,
    isLand
      ? { match: (description) => description.startsWith(`Play ${card.name}`) }
      : {
          match: (description, type) =>
            type === 'castSpell' && description.startsWith(`Cast ${card.name} (`),
        },
    draft,
    resolve,
  );
  if (typeof script === 'string') return failAll('unsupported', script);
  scenario.script = script;
  const verdict = confirmVerdict(file, resolve);
  if (verdict.thrown !== undefined) return failAll('unsupported', verdict.thrown);
  if (verdict.failures.length > 0) return failAll('failed', verdict.failures.join('; '));
  return {
    units: [
      ...units,
      ...parts.map((part) => ({
        part,
        clause: scenario.clauses[0]!,
        status: 'scaffolded' as const,
        scenarioIds: [scenario.id],
      })),
    ],
    scenario,
  };
}

/**
 * Drafts promotion scenarios for one card. Reads only the card's interpreted definition (the
 * override registry included) and the engine; every returned scenario has passed the runner.
 */
export function scaffoldCard(card: OracleCard, resolve: CardResolver): ScaffoldResult {
  const definition = interpretCard(card);
  const units: ScaffoldUnit[] = [];
  const scenarios: CardScenario[] = [];
  const support = new Map<string, SupportCardSpec>();
  const empty = (): ScaffoldResult => ({
    card: card.name,
    file: { schemaVersion: 1, card: card.name, scenarios: [] },
    units,
  });
  if (!definition.modeled) {
    units.push({
      part: 'card',
      clause: null,
      status: 'unsupported',
      reason: 'the card is not modeled',
      scenarioIds: [],
    });
    return empty();
  }
  if (card.layout !== 'normal' || card.backFace !== undefined) {
    units.push({
      part: 'card',
      clause: null,
      status: 'unsupported',
      reason: `the ${card.layout} layout`,
      scenarioIds: [],
    });
    return empty();
  }
  const lines = oracleLines(card);
  const keywordLines = new Set<number>();
  if (definition.keywords.length > 0) {
    const unit = draftKeywords(card, definition, lines, resolve);
    if (unit.scenario !== undefined) {
      scenarios.push(unit.scenario);
      for (const clause of unit.scenario.clauses) keywordLines.add(clause);
    }
    delete unit.scenario;
    units.push(unit);
  }

  const parts: Part[] = [];
  const triggerLines = lines.flatMap((line, index) => (TRIGGER_LINE.test(line) ? [index + 1] : []));
  const activatedLines = lines.flatMap((line, index) =>
    ACTIVATED_LINE.test(line) && !MANA_LINE.test(line) ? [index + 1] : [],
  );
  if (definition.spellAbility !== undefined && definition.spellAbility !== null) {
    const candidates = spellLines(lines, keywordLines);
    const clause = bestLine(definition.spellAbility.description, candidates, lines);
    // An instant or sorcery is one ability however many lines it takes ("Scry 1." then "Draw a
    // card."), so the draft names them all.
    const spell = definition.types.some((type) => type === 'Instant' || type === 'Sorcery');
    const modes = (
      definition.spellAbility as {
        modes?: {
          maxChoices: number;
          maxChoicesIf?: unknown;
          options: Array<{ effects: Effect[]; description?: string; targetSlots?: number[] }>;
        };
      }
    ).modes;
    if (modes !== undefined && modes.maxChoices === 1 && modes.maxChoicesIf === undefined) {
      // One draft per mode, each cast through the action that names its mode.
      const bullets = lines.flatMap((line, index) => (/^•/.test(line) ? [index + 1] : []));
      modes.options.forEach((option, index) => {
        if (option.description === undefined) return;
        const { modes: _modes, ...rest } = definition.spellAbility as Ability & { modes?: unknown };
        parts.push({
          part: 'spellAbility',
          clause: bestLine(option.description, bullets, lines),
          ability: { ...rest, effects: option.effects },
          start: 'cast',
          mode: { index, description: option.description, slots: option.targetSlots ?? [] },
        });
      });
    } else
      parts.push({
        part: 'spellAbility',
        clause: clause ?? (spell && candidates.length > 1 ? candidates[0]! : null),
        ...(clause === null && spell && candidates.length > 1 && { clauses: candidates }),
        ability: definition.spellAbility,
        start: 'cast',
      });
  }
  definition.triggers.forEach((ability, index) => {
    const part = `triggers[${index}]`;
    const trigger = ability.trigger as { when?: string; subject?: { kind: string } } | undefined;
    if (trigger?.when === 'dies' && trigger.subject?.kind === 'self') {
      const dies = triggerLines.filter((line) => /\bdies\b/i.test(lines[line - 1]!));
      parts.push({
        part,
        clause: bestLine(ability.description, dies, lines),
        ability,
        start: 'die',
      });
      return;
    }
    const caster = (trigger as { caster?: string } | undefined)?.caster;
    const watches =
      (trigger?.when === 'enters' && trigger.subject?.kind === 'permanent') ||
      (trigger?.when === 'castsSpell' && (caster === 'you' || caster === 'each'));
    if (watches) {
      const candidates = triggerLines.filter((line) =>
        trigger.when === 'enters'
          ? /\benters\b/i.test(lines[line - 1]!)
          : /\bcasts?\b/i.test(lines[line - 1]!),
      );
      parts.push({
        part,
        clause: bestLine(ability.description, candidates, lines),
        ability,
        start: 'watch',
      });
      return;
    }
    const phase = trigger === undefined ? null : phaseStart(trigger as Record<string, unknown>);
    if (phase !== null) {
      const candidates = triggerLines.filter((line) => phase.line.test(lines[line - 1]!));
      parts.push({
        part,
        clause: bestLine(ability.description, candidates, lines),
        ability,
        start: 'phase',
        phase,
      });
      return;
    }
    if (trigger?.when !== 'enters' || trigger.subject?.kind !== 'self') {
      units.push({
        part,
        clause: null,
        status: 'unsupported',
        reason: `the ${trigger?.when ?? 'unknown'} trigger`,
        scenarioIds: [],
      });
      return;
    }
    const enters = triggerLines.filter((line) => /\benters\b/i.test(lines[line - 1]!));
    parts.push({
      part,
      clause: bestLine(ability.description, enters, lines),
      ability,
      start: 'cast',
    });
  });
  definition.activatedAbilities.forEach((activated, index) => {
    parts.push({
      part: `activatedAbilities[${index}]`,
      clause: bestLine(activated.ability.description, activatedLines, lines),
      ability: activated.ability,
      start: 'activate',
      activated,
    });
  });

  // Statics: each on its own, against creatures arranged on both sides of its selector.
  const staticLines = spellLines(lines, keywordLines);
  definition.staticEffects.forEach((_, index) => {
    const unit = draftStatic(card, definition, index, lines, staticLines, resolve);
    if (unit.scenario !== undefined) {
      scenarios.push(unit.scenario);
      for (const spec of unit.support ?? []) support.set(spec.name, spec);
    }
    delete unit.scenario;
    delete unit.support;
    units.push(unit);
  });

  const attempt = (part: Part): ReturnType<typeof draftPart> => {
    try {
      return draftPart(card, definition, part, resolve);
    } catch (error) {
      return { failure: (error as Error).message.split('\n')[0]! };
    }
  };
  for (const part of parts) {
    let result: ReturnType<typeof draftPart>;
    if (part.start === 'watch') {
      // The first support card whose draft passes; an effect gap stops the search at once.
      result = { gap: 'no support card fires this trigger' };
      for (const watch of WATCHERS) {
        const tried = attempt({ ...part, watch });
        if (
          tried.scenario !== undefined ||
          (tried.gap !== undefined && tried.gap !== NOT_OFFERED)
        ) {
          result = tried;
          break;
        }
      }
    } else result = attempt(part);
    if (result.scenario !== undefined) {
      scenarios.push(result.scenario);
      for (const spec of result.support ?? []) support.set(spec.name, spec);
      units.push({
        part: part.part,
        clause: part.clause,
        status: 'scaffolded',
        scenarioIds: [result.scenario.id],
      });
    } else if (result.failure !== undefined)
      units.push({
        part: part.part,
        clause: part.clause,
        status: 'failed',
        reason: result.failure,
        scenarioIds: [],
      });
    else
      units.push({
        part: part.part,
        clause: part.clause,
        status: 'unsupported',
        reason: result.gap!,
        scenarioIds: [],
      });
  }
  // Reminder text counts here: a basic land type's mana ability is only reminder text.
  const rawLines = card.oracleText.split('\n');
  const manaLines = rawLines.flatMap((line, index) =>
    /\{T\}: Add\b/.test(line) ? [index + 1] : [],
  );
  definition.manaAbilities.forEach((_, index) => {
    // Lines and abilities pair up in order when there are as many of each; a single line
    // ("{T}: Add {U} or {B}.") can hold several abilities.
    const clause =
      manaLines.length === definition.manaAbilities.length
        ? manaLines[index]!
        : manaLines.length === 1
          ? manaLines[0]!
          : null;
    const result = draftMana(card, definition, index, clause, resolve);
    units.push(result.unit);
    scenarios.push(...result.scenarios);
    for (const spec of result.support) support.set(spec.name, spec);
  });
  const arrival = draftArrival(card, definition, lines, resolve);
  units.push(...arrival.units);
  if (arrival.scenario !== undefined) scenarios.push(arrival.scenario);
  return {
    card: card.name,
    file: {
      schemaVersion: 1,
      card: card.name,
      ...(support.size > 0 && { supportCards: [...support.values()] }),
      scenarios,
    },
    units,
  };
}
