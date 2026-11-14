/**
 * Shared pieces of the batch card compiler (scripts/card-compiler/README.md): the card pool, the
 * shape of a compiled patch, how a patch is applied and validated, and the generated smoke test.
 *
 * A compiled patch is data, never code: a `Partial<CardDefinition>` that is merged over the
 * interpreter's output exactly as an authored `extendCard` override is (compose 'append'), so the
 * lines the grammar already reads keep their parsed abilities and the patch only adds the
 * abilities for the lines it claims. Every check here works on a patch regardless of who wrote it
 * (a model from Oracle text, a translator from another engine, or a person).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CardDefinition } from '../../packages/engine/src/cards/definition';
import type {
  DecisionRequest,
  DecisionResponse,
  OracleCard,
  PlayerView,
  TargetChoice,
} from '../../packages/shared/src';
import { CREATURE_TYPE_BY_LOWER } from '../../packages/engine/src/cards/creature-types';
import { interpretCard } from '../../packages/engine/src/cards/interpret';
import {
  registerOverride,
  unregisterOverride,
  getOverride,
  type CardOverride,
} from '../../packages/engine/src/cards/overrides/index';
import {
  validateCardDefinition,
  validateOverrideDefinition,
} from '../../packages/engine/src/cards/authoring-validation';
import {
  buildCardScenario,
  type CardScenario,
  type CardScenarioFile,
  type SupportCardSpec,
} from '../../packages/engine/src/testing/card-scenario';
import { Prng } from '../../packages/engine/src/rng/prng';

export const SCRATCH_DEFAULT = 'scripts/card-compiler/.work';

export const REVIEWS_DIR = 'docs/reviews';
/** Every card any trial has taken and where it ended up (`run.ts ledger`). */
export const LEDGER_PATH = 'docs/reviews/compiled-card-ledger.json';
/** The review queue: every checked patch, with the reviewer's verdict once it has one. */
export const QUEUE_PATH = 'docs/reviews/compiled-card-queue.json';

export interface PinnedRow {
  rank: number;
  card: OracleCard;
}

let pinnedCache: PinnedRow[] | undefined;
/** The frozen EDHREC pool (8,972 cards) with real Oracle data, committed. */
export function pinnedPool(): PinnedRow[] {
  pinnedCache ??= JSON.parse(
    readFileSync('packages/server/fixtures/edhrec-pinned-oracle.json', 'utf8'),
  ) as PinnedRow[];
  return pinnedCache;
}

let byNameCache: Map<string, OracleCard> | undefined;
export function cardByName(name: string): OracleCard {
  if (byNameCache === undefined) {
    byNameCache = new Map();
    const basics = JSON.parse(
      readFileSync('packages/server/fixtures/coverage-oracle.json', 'utf8'),
    ) as OracleCard[];
    for (const card of basics) if (card.isBasicLand) byNameCache.set(card.name, card);
    for (const row of pinnedPool()) byNameCache.set(row.card.name, row.card);
  }
  const card = byNameCache.get(name);
  if (card === undefined) throw new Error(`no pinned card named "${name}"`);
  return card;
}

/** The body of an interpreter reason that quotes one unparsed rules line, or null. */
export function quotedLine(reason: string): string | null {
  const match = /"(.*)"$/s.exec(reason);
  return match === null ? null : match[1]!;
}

/** What the compiler is asked to model for a card: its unparsed lines, from the interpreter. */
export interface CompileTarget {
  name: string;
  rank: number;
  oracleId: string;
  card: OracleCard;
  /** Every unmodeled reason, verbatim. */
  reasons: string[];
  /** The rules lines the patch must implement (the quoted bodies of `reasons`). */
  lines: string[];
}

export function compileTarget(row: PinnedRow): CompileTarget | null {
  const definition = interpretCard(row.card);
  if (definition.modeled) return null;
  const lines = definition.unmodeledReasons.map(quotedLine);
  if (lines.some((line) => line === null)) return null;
  return {
    name: row.card.name,
    rank: row.rank,
    oracleId: row.card.oracleId,
    card: row.card,
    reasons: definition.unmodeledReasons,
    lines: lines as string[],
  };
}

/** Identity and printed characteristics: Oracle data owns these, a patch may not set them. */
export const IDENTITY_FIELDS = [
  'oracleId',
  'scryfallId',
  'name',
  'typeLine',
  'supertypes',
  'types',
  'subtypes',
  'colors',
  'colorIdentity',
  'manaCost',
  'hasUnsupportedCost',
  'power',
  'toughness',
  'loyalty',
  'defense',
  'modeled',
  'unmodeledReasons',
] as const;

/** A definition with identity fields and empty defaults removed: what a patch would add. */
export function behaviorOf(definition: CardDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(definition)) {
    if ((IDENTITY_FIELDS as readonly string[]).includes(key)) continue;
    if (value === undefined || value === null || value === false) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/** The per-line ability lists a patch appends to (`APPENDABLE_LISTS` in the override registry). */
const ABILITY_LISTS = new Set([
  'manaAbilities',
  'activatedAbilities',
  'triggers',
  'staticEffects',
  'ruleStatics',
  'keywords',
]);

/**
 * Behavior of a definition as canonical JSON: descriptions dropped, keys sorted. allOf and anyOf
 * are unordered, so "another Elf" and "an Elf that is another" are the same.
 *
 * With `unorderedAbilities`, the order of the card's ability lists is ignored too. A patch
 * appends its abilities after the parsed ones, while the interpreter emits them in line order,
 * so the same card read two ways differs only in that order.
 */
export function canonicalBehavior(
  definition: CardDefinition,
  options: { unorderedAbilities?: boolean } = {},
): string {
  const byJson = (a: unknown, b: unknown): number =>
    JSON.stringify(a).localeCompare(JSON.stringify(b));
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value === null || typeof value !== 'object') return value;
    const node = Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'description' && key !== 'prompt' && key !== 'label')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
    if ((node['kind'] === 'allOf' || node['kind'] === 'anyOf') && Array.isArray(node['of']))
      node['of'] = [...(node['of'] as unknown[])].sort(byJson);
    return node;
  };
  const behavior = sortKeys(behaviorOf(definition)) as Record<string, unknown>;
  if (options.unorderedAbilities === true)
    for (const [key, value] of Object.entries(behavior))
      if (ABILITY_LISTS.has(key) && Array.isArray(value))
        behavior[key] = [...(value as unknown[])].sort(byJson);
  return JSON.stringify(behavior);
}

/** The model's answer for one card. */
export type CompiledAnswer =
  | { status: 'compiled'; def: Partial<CardDefinition> }
  | { status: 'inexpressible'; reason: string };

export function parseAnswer(raw: string): CompiledAnswer {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON object in the answer');
  const value = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  if (value['status'] === 'inexpressible')
    return { status: 'inexpressible', reason: String(value['reason'] ?? '') };
  const def = value['def'];
  if (def === null || typeof def !== 'object' || Array.isArray(def))
    throw new Error('answer has no "def" object');
  return { status: 'compiled', def: def as Partial<CardDefinition> };
}

export interface PatchResult {
  ok: boolean;
  definition: CardDefinition | null;
  /** Validator and merge failures, as the engine reports them. */
  issues: string[];
}

/** Interpret the card with the patch registered, then validate the merged definition. */
export function applyPatch(target: CompileTarget, def: Partial<CardDefinition>): PatchResult {
  const forbidden = Object.keys(def).filter((key) =>
    (IDENTITY_FIELDS as readonly string[]).includes(key),
  );
  if (forbidden.length > 0)
    return {
      ok: false,
      definition: null,
      issues: [`the patch may not set identity fields: ${forbidden.join(', ')}`],
    };
  const override: CardOverride = {
    oracleId: target.oracleId as CardOverride['oracleId'],
    name: target.name,
    handledLines: target.lines,
    def,
    compose: 'append',
  };
  const early = validateOverrideDefinition(override);
  if (early.length > 0)
    return {
      ok: false,
      definition: null,
      issues: early.map((issue) => `${issue.path}: ${issue.message}`),
    };
  const previous = getOverride(override.oracleId);
  if (previous !== undefined) unregisterOverride(override.oracleId);
  registerOverride(override);
  try {
    const definition = interpretCard(target.card);
    const issues = definition.modeled
      ? validateCardDefinition(definition).map((issue) => `${issue.path}: ${issue.message}`)
      : definition.unmodeledReasons;
    return { ok: issues.length === 0 && definition.modeled, definition, issues };
  } catch (error) {
    return { ok: false, definition: null, issues: [`interpretation threw: ${String(error)}`] };
  } finally {
    unregisterOverride(override.oracleId);
    if (previous !== undefined) registerOverride(previous);
  }
}

/** Run `body` with the patch registered (for the smoke test, which interprets cards itself). */
export function withPatch<T>(
  target: CompileTarget,
  def: Partial<CardDefinition>,
  body: () => T,
): T {
  const oracleId = target.oracleId as CardOverride['oracleId'];
  const previous = getOverride(oracleId);
  if (previous !== undefined) unregisterOverride(oracleId);
  registerOverride({
    oracleId,
    name: target.name,
    handledLines: target.lines,
    def,
    compose: 'append',
  });
  try {
    return body();
  } finally {
    unregisterOverride(oracleId);
    if (previous !== undefined) registerOverride(previous);
  }
}

/**
 * Hide every free-text string before back-translation, so the back-translator reads only the
 * behavior. This is an allow-list: short enum-like strings (op names, kinds, keywords, types,
 * counter names, zones) are kept, and any other string, wherever it sits, becomes a placeholder.
 * A compile answer therefore cannot pass the Oracle text through a token name or a new field.
 */
export function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDescriptions);
  if (typeof value === 'string') return ENUM_LIKE.test(value) ? value : '<text>';
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'description' || key === 'prompt' || key === 'label') continue;
    // A discriminant is a schema name the validator already checked against the engine's own
    // list, so it cannot carry card text, however long it is (`enchantedByAuraYouControl`).
    out[key] =
      DISCRIMINANTS.has(key) && typeof entry === 'string' && SCHEMA_NAME.test(entry)
        ? entry
        : stripDescriptions(entry);
  }
  return out;
}

const DISCRIMINANTS = new Set(['kind', 'op', 'when']);
const SCHEMA_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * At most three words of letters, digits and symbol characters: "first strike", "+1/+1",
 * "Treasure". A comparison operator (">=", "==") is kept too: hiding it would let a patch with the
 * wrong comparison through the meaning check.
 */
const ENUM_LIKE = /^(?:[A-Za-z0-9+/'{}-]{1,24}( [A-Za-z0-9+/'{}-]{1,24}){0,2}|[<>=!]=?)$/;

// ── Generated smoke test ──────────────────────────────────────────────────────────────────────

/** Plain support cards every smoke board uses, so targets and sacrifice fodder always exist. */
const SUPPORT: SupportCardSpec[] = [
  {
    name: 'Smoke Bear',
    typeLine: 'Creature — Bear',
    manaCost: '{1}{G}',
    power: '2',
    toughness: '2',
  },
  {
    name: 'Smoke Knight',
    typeLine: 'Creature — Human Knight',
    manaCost: '{3}{W}',
    power: '3',
    toughness: '3',
  },
  { name: 'Smoke Relic', typeLine: 'Artifact', manaCost: '{2}' },
  { name: 'Smoke Charm', typeLine: 'Enchantment', manaCost: '{1}{W}' },
  {
    name: 'Smoke Bolt',
    typeLine: 'Instant',
    manaCost: '{R}',
    oracleText: 'Smoke Bolt deals 1 damage to any target.',
  },
  { name: 'Smoke Study', typeLine: 'Sorcery', manaCost: '{1}{U}', oracleText: 'Draw a card.' },
  // The busy board's extra stimulus: a death, a life gain, a small creature that can die.
  {
    name: 'Smoke Edict',
    typeLine: 'Sorcery',
    manaCost: '{1}{B}',
    oracleText: 'Destroy target creature.',
  },
  { name: 'Smoke Feast', typeLine: 'Sorcery', manaCost: '{W}', oracleText: 'You gain 3 life.' },
  {
    name: 'Smoke Wisp',
    typeLine: 'Creature — Spirit',
    manaCost: '{W}',
    power: '1',
    toughness: '1',
  },
  {
    name: 'Smoke Muster',
    typeLine: 'Sorcery',
    manaCost: '{W}',
    oracleText: 'Create a 1/1 white Soldier creature token.',
  },
  {
    name: 'Smoke Growth',
    typeLine: 'Sorcery',
    manaCost: '{G}',
    oracleText: 'Put a +1/+1 counter on target creature.',
  },
];

/**
 * Two creatures cut to the card under test: legendary, black, 4/4, and of every creature type
 * its unparsed lines name. A line that cares about Zombies, a legendary spell, a black creature
 * dying or a creature with toughness 4 then has something to act on. One starts on the
 * battlefield and one in hand, under different names so the legend rule leaves both alone.
 */
function kinCards(target: CompileTarget): SupportCardSpec[] {
  const types = new Set<string>();
  for (const word of target.lines.join(' ').match(/[A-Za-z]+/g) ?? []) {
    const lower = word.toLowerCase();
    const type =
      CREATURE_TYPE_BY_LOWER.get(lower) ??
      (lower.endsWith('s') ? CREATURE_TYPE_BY_LOWER.get(lower.slice(0, -1)) : undefined);
    if (type !== undefined && types.size < 4) types.add(type);
  }
  const subtypes = types.size === 0 ? ['Shade'] : [...types];
  return ['Smoke Kin', 'Smoke Kindred'].map((name) => ({
    name,
    typeLine: `Legendary Creature — ${subtypes.join(' ')}`,
    manaCost: '{2}{B}',
    power: '4',
    toughness: '4',
  }));
}
const LANDS = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];

export interface SmokeResult {
  /** The scenario played to its end with no halt, throw or invariant failure. */
  ok: boolean;
  scenario: string;
  /** The card's own behavior ran: it resolved, or an ability with it as source resolved. */
  exercised: boolean;
  /** An ability of the card (not the card itself as a spell) resolved. */
  abilityResolved: boolean;
  /** Descriptions of stack objects that resolved and mention the card. */
  resolved: string[];
  /** Why it failed, or what the harness could not do. */
  detail: string;
  decisions: number;
  eventTypes: string[];
  /**
   * Whether the game differed from the same game played with the card's patched lines removed:
   * a different event, legal action, life total, or computed characteristic of any permanent.
   * This is how a static ability, a replacement effect or a keyword shows it did something,
   * since none of them ever resolves. Absent when no baseline could be built for the card.
   */
  changedGame?: boolean;
  /** Hash of everything the game showed, compared with the baseline's and then dropped. */
  digest?: string;
}

/**
 * A smoke run exercised the patch when it visibly changed the game. A run that did not only
 * shows that the card does not crash the engine.
 */
export function smokeExercised(runs: readonly SmokeResult[]): boolean {
  return runs.some((run) =>
    // With a baseline, only a visible difference counts: an ability resolving may belong to a
    // line the interpreter already read. Without one (a spell whose whole text is the patch),
    // the spell or one of its abilities resolving is the evidence there is.
    run.changedGame === undefined ? run.exercised : run.changedGame,
  );
}

function smokeScenarios(target: CompileTarget): CardScenario[] {
  const isPermanent = target.card.types.some((type) =>
    ['Creature', 'Artifact', 'Enchantment', 'Land', 'Planeswalker', 'Battle'].includes(type),
  );
  const lands = LANDS.flatMap((land) => [land, land, land]);
  const opponent = {
    battlefield: ['Smoke Bear', 'Smoke Knight', 'Smoke Relic', 'Smoke Charm'],
    hand: ['Smoke Bear'],
    graveyard: ['Smoke Bear'],
  };
  const base = {
    clauses: [1],
    instructions: [],
    expectedOutcome: 'no halt',
    script: [],
    expect: [],
    turnCap: 12,
  };
  const scenarios: CardScenario[] = [
    {
      ...base,
      id: 'from-hand',
      title: `${target.name} from hand`,
      seats: {
        P1: {
          hand: [target.name, 'Smoke Bolt', 'Smoke Study'],
          battlefield: [...lands, 'Smoke Bear', 'Smoke Relic'],
          graveyard: ['Smoke Bear', 'Smoke Bolt', 'Smoke Knight'],
          libraryTop: ['Smoke Bear', 'Smoke Knight', 'Smoke Relic', 'Smoke Study'],
        },
        P2: opponent,
        P3: opponent,
        P4: opponent,
      },
      continue: {
        throughCombat: true,
        toPostcombatMain: true,
        toEndStep: true,
        throughNextTurn: true,
      },
    },
  ];
  if (isPermanent)
    scenarios.push({
      ...base,
      id: 'on-battlefield',
      title: `${target.name} on the battlefield`,
      turn: { player: 'P1', phase: 'beginning', step: 'upkeep', number: 4 },
      seats: {
        P1: {
          hand: ['Smoke Bolt', 'Smoke Study', 'Smoke Bear'],
          battlefield: [...lands, target.name, 'Smoke Bear', 'Smoke Relic'],
          graveyard: ['Smoke Bear', 'Smoke Bolt', 'Smoke Knight'],
          libraryTop: ['Smoke Bear', 'Smoke Knight', 'Smoke Relic', 'Smoke Study'],
        },
        P2: opponent,
        P3: opponent,
        P4: opponent,
      },
      continue: {
        throughCombat: true,
        toPostcombatMain: true,
        toEndStep: true,
        throughNextTurn: true,
      },
    });
  // The busy board: every seat plays what it can, so the events most triggers and statics wait
  // for actually happen (a creature enters, one dies, a spell is cast, life is gained, a card is
  // drawn, creatures attack and deal damage, each player takes a turn).
  const busyOpponent = {
    battlefield: [...LANDS, 'Smoke Bear', 'Smoke Knight', 'Smoke Relic', 'Smoke Charm'],
    hand: ['Smoke Bear', 'Smoke Bolt'],
    graveyard: ['Smoke Bear'],
  };
  const busySeats = {
    P1: {
      hand: [
        ...(isPermanent ? [] : [target.name]),
        'Smoke Kindred',
        'Smoke Muster',
        'Smoke Growth',
        'Smoke Edict',
        'Smoke Feast',
        'Smoke Study',
        'Smoke Wisp',
        'Smoke Relic',
        'Smoke Bolt',
        'Forest',
      ],
      battlefield: [
        ...lands,
        ...(isPermanent ? [target.name] : []),
        'Smoke Kin',
        'Smoke Bear',
        'Smoke Knight',
        'Smoke Wisp',
        'Smoke Relic',
      ],
      // One card of each type, for the cards that count types or cards in a graveyard.
      graveyard: [
        'Smoke Bear',
        'Smoke Bolt',
        'Smoke Knight',
        'Smoke Relic',
        'Smoke Charm',
        'Smoke Study',
        'Forest',
      ],
      libraryTop: ['Smoke Bear', 'Smoke Knight', 'Smoke Relic', 'Smoke Study'],
    },
    P2: busyOpponent,
    P3: busyOpponent,
    P4: busyOpponent,
  };
  const busyContinue = {
    throughCombat: true,
    toPostcombatMain: true,
    toEndStep: true,
    throughNextTurn: true,
  } as const;
  scenarios.push(
    // P1's turn from its upkeep window on, then the next player's whole turn.
    {
      ...base,
      id: 'busy-board',
      title: `${target.name} on a busy board`,
      turn: { player: 'P1', phase: 'beginning', step: 'upkeep', number: 4 },
      seats: busySeats,
      continue: busyContinue,
    },
    // The end of the previous player's turn, then P1's whole turn from its untap step: the only
    // scenario in which P1's own upkeep, draw step and end step begin, and their triggers fire.
    {
      ...base,
      id: 'busy-own-turn',
      title: `${target.name} through its controller's whole turn`,
      turn: { player: 'P4', phase: 'postcombatMain', step: null, number: 4 },
      seats: busySeats,
      continue: busyContinue,
    },
  );
  return scenarios;
}

/** The scenarios in which every seat plays, not only the seat holding the card under test. */
const BUSY_SCENARIOS = new Set(['busy-board', 'busy-own-turn']);
/** Ways of passing priority: a busy seat takes every other action first. */
const PASSING = new Set(['pass', 'passAndYieldTurn', 'yieldToAbility']);

const MAX_DECISIONS = 600;

/**
 * Drive one smoke scenario. P1 takes every action that involves the card under test once (cast
 * it, activate each of its abilities), with first-legal targets; everyone else passes priority;
 * every other decision is answered by a seeded random choice. Pass = the game never halts, throws
 * or breaks an invariant. `exercised` says whether the card's behavior actually ran.
 */
function runSmoke(
  target: CompileTarget,
  scenario: CardScenario,
  resolveCard: (name: string) => OracleCard = cardByName,
): SmokeResult {
  const file: CardScenarioFile = {
    schemaVersion: 1,
    card: target.name,
    supportCards: [...SUPPORT, ...kinCards(target)],
    scenarios: [scenario],
  };
  const result: SmokeResult = {
    ok: false,
    scenario: scenario.id,
    exercised: false,
    abilityResolved: false,
    resolved: [],
    detail: '',
    decisions: 0,
    eventTypes: [],
  };
  let engine;
  try {
    ({ engine } = buildCardScenario(file, scenario, resolveCard, {
      gameId: `smoke-${scenario.id}`,
      strictInvariants: true,
    }));
  } catch (error) {
    result.detail = `harness: could not arrange the board: ${String(error)}`;
    return result;
  }
  const rng = new Prng(`smoke-${target.oracleId}-${scenario.id}`);
  const tried = new Set<string>();
  const busy = BUSY_SCENARIOS.has(scenario.id);
  const digest = createHash('sha256');
  const firstSequence = engine.getState().eventLog.length;
  const nameLower = target.name.split(' // ')[0]!.toLowerCase();
  try {
    for (; result.decisions < MAX_DECISIONS; result.decisions++) {
      const step = engine.advance();
      if (step.kind === 'continue') continue;
      if (step.kind === 'gameOver') {
        if (step.result.halted) {
          result.detail = `halted${step.result.haltSite === undefined ? '' : ` at ${step.result.haltSite}`}: ${step.result.haltReason ?? ''}`;
          return finish(result, engine, firstSequence, target, digest);
        }
        result.ok = true;
        result.detail = 'game ended';
        return finish(result, engine, firstSequence, target, digest);
      }
      const request = step.request;
      digest.update(observed(engine.view('P1'), request));
      const response = chooseSmokeAction(request, rng, tried, nameLower, busy);
      if (response === null) {
        result.ok = true;
        result.detail = 'scenario finished';
        return finish(result, engine, firstSequence, target, digest);
      }
      engine.submit(response);
    }
    // Hitting the cap is what a looping card looks like, so it is not a pass.
    result.ok = false;
    result.detail = `inconclusive: stopped after ${MAX_DECISIONS} decisions`;
  } catch (error) {
    result.detail = `threw: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
  }
  return finish(result, engine, firstSequence, target, digest);
}

/**
 * What a decision point shows that a card's behavior could have changed: every seat's life and
 * zone sizes, each permanent's computed power, toughness, keywords and status, the stack, and
 * the actions offered. Printed text is left out, so a baseline card that only lacks a line of
 * text does not differ until that line does something.
 */
function observed(view: PlayerView, request: DecisionRequest): string {
  const names = (cards: readonly { name: string }[]): string[] => cards.map((card) => card.name);
  return JSON.stringify({
    deciding: request.decidingPlayer,
    type: request.decisionType,
    step: [request.turn, request.phase, request.step],
    actions: request.legalActions.map((action) => [
      action.type,
      action.description,
      (action.targets ?? []).map((slot) => slot.options.length),
    ]),
    life: view.life,
    hand: names(view.hand),
    graveyard: names(view.graveyard),
    exile: names(view.exile),
    mana: view.availableMana,
    energy: view.energy,
    poison: view.poisonCounters,
    opponents: view.opponents,
    stack: view.stack.map((object) => [
      object.controller,
      object.description,
      object.targets.length,
    ]),
    battlefield: view.battlefield.map((permanent) => [
      permanent.id,
      permanent.controller,
      permanent.name,
      permanent.power,
      permanent.toughness,
      permanent.keywords,
      permanent.tapped,
      permanent.status,
    ]),
  });
}

function finish(
  result: SmokeResult,
  engine: { getState(): { eventLog: { type: string; payload: Record<string, unknown> }[] } },
  firstSequence: number,
  target: CompileTarget,
  digest: ReturnType<typeof createHash>,
): SmokeResult {
  const events = engine.getState().eventLog.slice(firstSequence);
  result.eventTypes = [...new Set(events.map((event) => event.type))].sort();
  digest.update(JSON.stringify(events.map((event) => [event.type, event.payload])));
  digest.update(`${result.ok}|${result.detail}`);
  result.digest = digest.digest('hex');
  const name = target.name.split(' // ')[0]!;
  result.resolved = events
    .filter((event) => event.type === 'resolved')
    .map((event) => String(event.payload['description'] ?? ''))
    .filter((description) => description.includes(name));
  result.exercised = result.resolved.length > 0;
  result.abilityResolved = result.resolved.some(
    (description) => description !== name && !description.startsWith('Copy of'),
  );
  return result;
}

/**
 * A random legal target for each slot, never the same object in two slots: "fights another target
 * creature" offers the same creatures to both slots, and picking one twice is an illegal
 * announcement, not a defect of the card. Slots with fewer options choose first.
 */
export function firstTargets(
  action: Pick<DecisionRequest['legalActions'][number], 'targets'>,
  rng: Prng,
): TargetChoice[] {
  const slots = action.targets ?? [];
  const taken = new Set<string>();
  const chosen = new Map<number, string>();
  for (const slot of [...slots].sort((a, b) => a.options.length - b.options.length)) {
    const fresh = slot.options.filter((option) => !taken.has(option));
    const pool = fresh.length > 0 ? fresh : slot.options;
    const choice = pool[rng.nextInt(pool.length)] as string;
    taken.add(choice);
    chosen.set(slot.slot, choice);
  }
  return slots.map((slot) => ({ slot: slot.slot, choice: chosen.get(slot.slot) as string }));
}

function chooseSmokeAction(
  request: DecisionRequest,
  rng: Prng,
  tried: Set<string>,
  nameLower: string,
  busy: boolean,
): DecisionResponse | null {
  const respond = (action: DecisionRequest['legalActions'][number]): DecisionResponse => {
    const response: DecisionResponse = { requestId: request.requestId, actionId: action.id };
    const targets = firstTargets(action, rng);
    if (targets.length > 0) response.targets = targets;
    return response;
  };
  if (request.decisionType === 'priority') {
    if (request.decidingPlayer === 'P1') {
      const fresh = request.legalActions.find(
        (action) =>
          action.type !== 'pass' &&
          action.description.toLowerCase().includes(nameLower) &&
          !tried.has(action.description),
      );
      if (fresh !== undefined) {
        tried.add(fresh.description);
        return respond(fresh);
      }
    }
    if (busy) {
      // Every seat takes each action it is offered once, the card's own first (above).
      const key = (action: DecisionRequest['legalActions'][number]): string =>
        `${request.decidingPlayer}|${action.description}`;
      const other = request.legalActions.find(
        (action) => !PASSING.has(action.type) && !tried.has(key(action)),
      );
      if (other !== undefined) {
        tried.add(key(other));
        return respond(other);
      }
    }
    const pass = request.legalActions.find((action) => action.type === 'pass');
    if (pass !== undefined) return respond(pass);
  }
  const action = request.legalActions[rng.nextInt(request.legalActions.length)];
  if (action === undefined) throw new Error(`decision with no legal actions: ${request.prompt}`);
  return respond(action);
}

/**
 * The card with its unparsed lines taken out of the Oracle text, which the interpreter models on
 * its own: the same card minus what the patch adds. Null when no such card can be built (removing
 * the lines one at a time never yields a modeled card).
 */
export function baselineCard(target: CompileTarget): OracleCard | null {
  const id = target.oracleId as CardOverride['oracleId'];
  const registered = getOverride(id);
  if (registered !== undefined) unregisterOverride(id);
  try {
    let lines = (target.card.oracleText ?? '').split('\n');
    // One pass per unparsed line: drop the first printed line whose removal clears a reason.
    for (let pass = 0; pass < target.lines.length; pass++) {
      const reasons = interpretCard({ ...target.card, oracleText: lines.join('\n') })
        .unmodeledReasons.length;
      const drop = lines.findIndex((_, index) => {
        const without = lines.filter((__, other) => other !== index).join('\n');
        return (
          interpretCard({ ...target.card, oracleText: without }).unmodeledReasons.length < reasons
        );
      });
      if (drop < 0) return null;
      lines = lines.filter((_, index) => index !== drop);
    }
    const card = { ...target.card, oracleText: lines.join('\n') };
    return interpretCard(card).modeled ? card : null;
  } finally {
    if (registered !== undefined) registerOverride(registered);
  }
}

/**
 * Every smoke scenario for the card, with the patch registered (or none, for an unpatched run).
 * With a patch, each scenario is also played with the baseline card, and `changedGame` says
 * whether the two games differed.
 */
export function smokeTest(
  target: CompileTarget,
  def: Partial<CardDefinition> | null,
): SmokeResult[] {
  const scenarios = smokeScenarios(target);
  const stored = ({ digest: _digest, ...run }: SmokeResult): SmokeResult => run;
  if (def === null) return scenarios.map((scenario) => stored(runSmoke(target, scenario)));
  const runs = withPatch(target, def, () =>
    scenarios.map((scenario) => runSmoke(target, scenario)),
  );
  const baseline = baselineCard(target);
  if (baseline === null) return runs.map(stored);
  const id = target.oracleId as CardOverride['oracleId'];
  const registered = getOverride(id);
  if (registered !== undefined) unregisterOverride(id);
  try {
    const resolveCard = (name: string): OracleCard =>
      name === target.name ? baseline : cardByName(name);
    return runs.map((run, index) => {
      const plain = runSmoke(target, scenarios[index]!, resolveCard);
      return { ...stored(run), changedGame: plain.digest !== run.digest };
    });
  } finally {
    if (registered !== undefined) registerOverride(registered);
  }
}
