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
  type ScenarioExpectation,
  type ScenarioStep,
  type SeatSpec,
  type SupportCardSpec,
} from '../../src/testing/card-scenario';
import { runScenario, scenarioFailures } from './runner';

/** Bumped when the generator's output changes shape, so a reviewer knows which drafts are whose. */
export const SCAFFOLD_VERSION = 1;

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
      draft.libraryUsed = true;
      const pages = Array.from({ length: n + 1 }, (_, index) => PAGE(index + 1));
      for (const page of pages) draft.support.set(page, creatureSpec(page, 1));
      draft.seats.P1.libraryTop = pages;
      const zone = effect.op === 'draw' ? 'hand' : 'graveyard';
      draft.expect.push({
        zone: { player: 'P1', zone, has: pages.slice(0, n), lacks: [pages[n]!] },
      });
      draft.outcome.push(
        effect.op === 'draw'
          ? `P1 draws exactly ${n} card${n === 1 ? '' : 's'}`
          : `P1 mills exactly ${n} card${n === 1 ? '' : 's'}`,
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
      if (target === null || target.spec.kind !== 'player') return `${effect.op} without a player slot`;
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
      if (n === 0 || draft.libraryUsed) return 'drawTarget with a shared library';
      draft.libraryUsed = true;
      const pages = Array.from({ length: n + 1 }, (_, index) => PAGE(index + 1));
      for (const page of pages) draft.support.set(page, creatureSpec(page, 1));
      draft.seats[seat].libraryTop = pages;
      draft.expect.push({
        zone: { player: seat, zone: 'hand', has: pages.slice(0, n), lacks: [pages[n]!] },
      });
      draft.outcome.push(`the target player (${seat}) draws exactly ${n} card${n === 1 ? '' : 's'}`);
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
      draft.outcome.push(`${sourceName} deals ${n} damage to the target ${n}-toughness creature, which dies`);
      return null;
    }
    case 'destroy':
    case 'exile':
    case 'returnToHand':
    case 'tapTarget':
    case 'untapTarget':
    case 'putCounters':
    case 'grantKeywordUntilEot': {
      const ref = e['target'];
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
      const harmful = HARMFUL.has(effect.op);
      const name = permanentFor(target.spec.kind, harmful);
      if (name === null) return `${effect.op} on a ${target.spec.kind} slot`;
      placeTarget(draft, target.slot, name);
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
      } else {
        const keyword = e['keyword'] as string;
        draft.expect.push({ keywords: { card: name, has: [keyword], player: owner } });
        draft.outcome.push(`the target ${name} gains ${keywordText(keyword)}`);
      }
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

interface Intent {
  /** Matches the one priority action that starts the ability. */
  match: (description: string, type: string) => boolean;
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
  let started = false;
  for (let count = 0; count < 200; count++) {
    const step = engine.advance();
    // A prepared position ends its game once its priority window closes (no `continue`).
    if (step.kind === 'gameOver') {
      if (step.result.halted)
        return `the game halted: ${step.result.haltReason ?? step.result.haltSite ?? 'no reason'}`;
      return started ? steps : 'the game ended before the ability started';
    }
    if (step.kind === 'continue') continue;
    const request = step.request;
    const stackEmpty = engine.getState().stack.length === 0;
    if (request.decisionType === 'priority') {
      if (started && stackEmpty) return steps;
      if (!started && request.decidingPlayer === 'P1') {
        const actions = request.legalActions.filter((action) =>
          intent.match(action.description, action.type),
        );
        if (actions.length !== 1)
          return `${actions.length} actions start the ability:\n${request.legalActions.map((a) => `  ${a.description}`).join('\n')}`;
        const action = actions[0]!;
        const lookup = names();
        const targets: string[] = [];
        for (const slot of action.targets ?? []) {
          const want = draft.slotChoice.get(slot.slot);
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
              choice: slot.options.find((option) => (lookup.get(option) ?? option) === targets[index])!,
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
    const named = [...draft.slotChoice.values()];
    const byName = request.legalActions.filter((action) =>
      named.some((name) => action.description === name || action.description.endsWith(` ${name}`)),
    );
    const choice = yes ?? (byName.length === 1 ? byName[0] : undefined);
    if (choice === undefined)
      return `an unexpected ${request.decisionType} decision: "${request.prompt}"`;
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
  ability: Ability;
  /** How the ability starts, and where the card is arranged. */
  start: 'cast' | 'activate';
  activated?: ActivatedAbility;
}

const ALLOWED_COSTS = new Set(['tap', 'sacrificeSelf']);

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
  if (ability.effects.some((effect) => (effect as Record<string, unknown>)['condition'] !== undefined))
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
  for (const effect of part.ability.effects) {
    const reason = addEffect(draft, effect, part.ability, card.name);
    if (reason !== null) return { gap: reason };
  }
  // Every target slot needs a choice the draft placed.
  for (let slot = 0; slot < part.ability.targets.length; slot++)
    if (!draft.slotChoice.has(slot)) return { gap: `target slot ${slot + 1} is used by no effect` };

  const isPermanent = !definition.types.some((type) => type === 'Instant' || type === 'Sorcery');
  const id = `${slugOf(card.name)}-scaffold-${slugOf(part.part)}`;
  const instructions: string[] = [];
  let intent: Intent;
  const p1 = draft.seats.P1;
  if (part.start === 'cast') {
    if (definition.hasUnsupportedCost) return { gap: `the mana cost ${card.manaCost ?? ''}` };
    const lands = landsFor(definition.manaCost, definition.colors);
    if (lands === null) return { gap: `the mana cost ${card.manaCost ?? ''}` };
    if (definition.types.includes('Land')) return { gap: 'a land played, not cast' };
    p1.hand = [card.name];
    p1.battlefield = [...lands, ...(p1.battlefield ?? [])];
    intent = {
      match: (description, type) =>
        type === 'castSpell' && scenarioPattern(`/^Cast ${escapeRegex(card.name)} \\(/`)(description),
    };
    instructions.push(`Cast ${card.name}${draft.slotChoice.size > 0 ? ` targeting ${[...draft.slotChoice.values()].join(' and ')}` : ''}, and let it resolve.`);
    if (isPermanent) draft.expect.unshift({ zone: { player: 'P1', zone: 'battlefield', has: [card.name] } });
  } else {
    const activated = part.activated!;
    const costs = activated.costs.filter((cost) => cost.kind !== 'mana');
    const extra = costs.find((cost) => !ALLOWED_COSTS.has(cost.kind));
    if (extra !== undefined) return { gap: `the ${extra.kind} cost` };
    if ((activated.zone ?? 'battlefield') !== 'battlefield') return { gap: 'an ability activated from another zone' };
    const a = activated as ActivatedAbility & Record<string, unknown>;
    for (const flag of ['condition', 'requiresAttackedThisTurn', 'exhaust', 'loyalty'])
      if (a[flag] !== undefined) return { gap: `an activation with ${flag}` };
    const manaCost = activated.costs.find((cost) => cost.kind === 'mana') as
      | { kind: 'mana'; cost: ParsedManaCost }
      | undefined;
    const lands = landsFor(manaCost?.cost ?? null, definition.colors);
    if (lands === null) return { gap: 'an activation mana cost with X, hybrid or Phyrexian symbols' };
    p1.battlefield = [card.name, ...lands, ...(p1.battlefield ?? [])];
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
    instructions.push(`Activate ${card.name}'s ability${index > 0 ? ` #${index + 1}` : ''}${draft.slotChoice.size > 0 ? ` targeting ${[...draft.slotChoice.values()].join(' and ')}` : ''}, and let it resolve.`);
    if (costs.some((cost) => cost.kind === 'sacrificeSelf')) {
      draft.expect.unshift({ zone: { player: 'P1', zone: 'graveyard', has: [card.name] } });
      draft.outcome.unshift(`${card.name} is sacrificed`);
    }
  }
  if (part.ability.optional === true) draft.outcome.unshift('P1 chooses to');

  const scenario: CardScenario = {
    id,
    title: `${card.name}: ${draft.outcome.join('; ')} (generated scaffold v${SCAFFOLD_VERSION}, review against the Oracle line)`,
    clauses: part.clause === null ? [] : [part.clause],
    instructions,
    expectedOutcome: `${draft.outcome.join('; ')}.`.replace(/^./, (c) => c.toUpperCase()),
    seats: Object.fromEntries(
      Object.entries(draft.seats).filter(([, spec]) => Object.keys(spec).length > 0),
    ),
    script: [],
    expect: draft.expect,
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
  const file: CardScenarioFile = { schemaVersion: 1, card: card.name, supportCards: support, scenarios: [scenario] };
  const script = recordScript(file, scenario, intent, draft, resolve);
  if (typeof script === 'string') return { failure: script };
  scenario.script = script;
  // The confirming run: the real runner, a fresh engine, the draft's own expectations.
  try {
    const parsed = parseCardScenarioFile(JSON.parse(JSON.stringify(file)));
    const failures = scenarioFailures(runScenario(parsed, parsed.scenarios[0]!, { resolve }), parsed.scenarios[0]!);
    if (failures.length > 0) return { failure: failures.join('; ') };
  } catch (error) {
    return { failure: (error as Error).message.split('\n')[0]! };
  }
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
      return { part: 'keywords', clause: null, status: 'unsupported', reason: `no keyword line names ${text}`, scenarioIds: [] };
    clauses.add(line + 1);
  }
  if (definition.types.includes('Instant') || definition.types.includes('Sorcery'))
    return { part: 'keywords', clause: null, status: 'unsupported', reason: 'keywords on a spell', scenarioIds: [] };
  const id = `${slugOf(card.name)}-scaffold-keywords`;
  const scenario: CardScenario = {
    id,
    title: `${card.name}: it has ${keywords.map(keywordText).join(', ')} on the battlefield (generated scaffold v${SCAFFOLD_VERSION}, review against the Oracle line)`,
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
      return { part: 'keywords', clause: scenario.clauses[0]!, status: 'failed', reason: failures.join('; '), scenarioIds: [] };
  } catch (error) {
    return { part: 'keywords', clause: scenario.clauses[0]!, status: 'failed', reason: (error as Error).message.split('\n')[0]!, scenarioIds: [] };
  }
  return { part: 'keywords', clause: scenario.clauses[0]!, status: 'scaffolded', scenarioIds: [id], scenario };
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
    units.push({ part: 'card', clause: null, status: 'unsupported', reason: 'the card is not modeled', scenarioIds: [] });
    return empty();
  }
  if (card.layout !== 'normal' || card.backFace !== undefined) {
    units.push({ part: 'card', clause: null, status: 'unsupported', reason: `the ${card.layout} layout`, scenarioIds: [] });
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
    parts.push({
      part: 'spellAbility',
      clause: bestLine(definition.spellAbility.description, spellLines(lines, keywordLines), lines),
      ability: definition.spellAbility,
      start: 'cast',
    });
  }
  definition.triggers.forEach((ability, index) => {
    const part = `triggers[${index}]`;
    const trigger = ability.trigger as { when?: string; subject?: { kind: string } } | undefined;
    if (trigger?.when !== 'enters' || trigger.subject?.kind !== 'self') {
      units.push({ part, clause: null, status: 'unsupported', reason: `the ${trigger?.when ?? 'unknown'} trigger`, scenarioIds: [] });
      return;
    }
    const enters = triggerLines.filter((line) => /\benters\b/i.test(lines[line - 1]!));
    parts.push({ part, clause: bestLine(ability.description, enters, lines), ability, start: 'cast' });
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

  for (const part of parts) {
    let result: ReturnType<typeof draftPart>;
    try {
      result = draftPart(card, definition, part, resolve);
    } catch (error) {
      result = { failure: (error as Error).message.split('\n')[0]! };
    }
    if (result.scenario !== undefined) {
      scenarios.push(result.scenario);
      for (const spec of result.support ?? []) support.set(spec.name, spec);
      units.push({ part: part.part, clause: part.clause, status: 'scaffolded', scenarioIds: [result.scenario.id] });
    } else if (result.failure !== undefined)
      units.push({ part: part.part, clause: part.clause, status: 'failed', reason: result.failure, scenarioIds: [] });
    else units.push({ part: part.part, clause: part.clause, status: 'unsupported', reason: result.gap!, scenarioIds: [] });
  }
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
