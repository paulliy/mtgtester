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
import { readFileSync } from 'node:fs';
import type { CardDefinition } from '../../packages/engine/src/cards/definition';
import type {
  DecisionRequest,
  DecisionResponse,
  OracleCard,
  TargetChoice,
} from '../../packages/shared/src';
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
    out[key] = stripDescriptions(entry);
  }
  return out;
}

/** At most three words of letters, digits and symbol characters: "first strike", "+1/+1", "Treasure". */
const ENUM_LIKE = /^[A-Za-z0-9+/'{}-]{1,24}( [A-Za-z0-9+/'{}-]{1,24}){0,2}$/;

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
];
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
  return scenarios;
}

const MAX_DECISIONS = 600;

/**
 * Drive one smoke scenario. P1 takes every action that involves the card under test once (cast
 * it, activate each of its abilities), with first-legal targets; everyone else passes priority;
 * every other decision is answered by a seeded random choice. Pass = the game never halts, throws
 * or breaks an invariant. `exercised` says whether the card's behavior actually ran.
 */
function runSmoke(target: CompileTarget, scenario: CardScenario): SmokeResult {
  const file: CardScenarioFile = {
    schemaVersion: 1,
    card: target.name,
    supportCards: SUPPORT,
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
    ({ engine } = buildCardScenario(file, scenario, cardByName, {
      gameId: `smoke-${scenario.id}`,
      strictInvariants: true,
    }));
  } catch (error) {
    result.detail = `harness: could not arrange the board: ${String(error)}`;
    return result;
  }
  const rng = new Prng(`smoke-${target.oracleId}-${scenario.id}`);
  const tried = new Set<string>();
  const firstSequence = engine.getState().eventLog.length;
  const nameLower = target.name.split(' // ')[0]!.toLowerCase();
  try {
    for (; result.decisions < MAX_DECISIONS; result.decisions++) {
      const step = engine.advance();
      if (step.kind === 'continue') continue;
      if (step.kind === 'gameOver') {
        if (step.result.halted) {
          result.detail = `halted${step.result.haltSite === undefined ? '' : ` at ${step.result.haltSite}`}: ${step.result.haltReason ?? ''}`;
          return finish(result, engine, firstSequence, target);
        }
        result.ok = true;
        result.detail = 'game ended';
        return finish(result, engine, firstSequence, target);
      }
      const request = step.request;
      const response = chooseSmokeAction(request, rng, tried, nameLower);
      if (response === null) {
        result.ok = true;
        result.detail = 'scenario finished';
        return finish(result, engine, firstSequence, target);
      }
      engine.submit(response);
    }
    // Hitting the cap is what a looping card looks like, so it is not a pass.
    result.ok = false;
    result.detail = `inconclusive: stopped after ${MAX_DECISIONS} decisions`;
  } catch (error) {
    result.detail = `threw: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
  }
  return finish(result, engine, firstSequence, target);
}

function finish(
  result: SmokeResult,
  engine: { getState(): { eventLog: { type: string; payload: Record<string, unknown> }[] } },
  firstSequence: number,
  target: CompileTarget,
): SmokeResult {
  const events = engine.getState().eventLog.slice(firstSequence);
  result.eventTypes = [...new Set(events.map((event) => event.type))].sort();
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

function firstTargets(action: DecisionRequest['legalActions'][number], rng: Prng): TargetChoice[] {
  return (action.targets ?? []).map((slot) => ({
    slot: slot.slot,
    choice: slot.options[rng.nextInt(slot.options.length)] as string,
  }));
}

function chooseSmokeAction(
  request: DecisionRequest,
  rng: Prng,
  tried: Set<string>,
  nameLower: string,
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
    const pass = request.legalActions.find((action) => action.type === 'pass');
    if (pass !== undefined) return respond(pass);
  }
  const action = request.legalActions[rng.nextInt(request.legalActions.length)];
  if (action === undefined) throw new Error(`decision with no legal actions: ${request.prompt}`);
  return respond(action);
}

/** Every smoke scenario for the card, with the patch registered (or none, for a baseline). */
export function smokeTest(
  target: CompileTarget,
  def: Partial<CardDefinition> | null,
): SmokeResult[] {
  const run = () => smokeScenarios(target).map((scenario) => runSmoke(target, scenario));
  return def === null ? run() : withPatch(target, def, run);
}
