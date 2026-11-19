/**
 * One scenario format for engine tests and the Card Test Lab (ADR 0034 decision 10). A scenario
 * file is JSON: the card under test, any lab support cards, and scenarios that each arrange a
 * position (a `PreparedScenarioSpec` underneath), script every decision a test must not guess,
 * and state what must be true at the end. The engine-test runner (`engine/tests/scenario/`)
 * drives one through `Engine.advance`/`Engine.submit`; the server turns the same file into Card
 * Test Lab scenarios. Parsing is strict: an unknown field anywhere is an error, not ignored.
 */
import type {
  DecisionRequest,
  DecisionResponse,
  GameId,
  GameState,
  OracleCard,
  Phase,
  Step,
} from '@mtg/shared';
import { Engine } from '../engine';
import type { EnginePlayerConfig } from '../state/types';
import type { PreparedScenarioSpec } from './prepared-scenario';

export const CARD_SCENARIO_SEATS = ['P1', 'P2', 'P3', 'P4'] as const;
type Seat = (typeof CARD_SCENARIO_SEATS)[number];

/** A lab card that exists only for scenarios; the engine interprets its Oracle text as usual. */
export interface SupportCardSpec {
  name: string;
  typeLine: string;
  manaCost?: string;
  oracleText?: string;
  power?: string;
  toughness?: string;
  /** A planeswalker's starting loyalty (CR 306.5b). */
  loyalty?: string;
}

/** How one arranged permanent differs from an untapped one its owner controls. */
export interface PlacedSpec {
  card: string;
  tapped?: true;
  counters?: Record<string, number>;
  /** Under another player's control. */
  controller?: Seat;
  /** An Aura enchanting this player. */
  enchantedPlayer?: Seat;
  /** An Aura or Equipment attached to a permanent this player controls. */
  attachedTo?: { player: Seat; card: string };
  goadedBy?: Seat;
  transformed?: true;
}

export interface SeatSpec {
  life?: number;
  energy?: number;
  hand?: string[];
  battlefield?: Array<string | PlacedSpec>;
  graveyard?: string[];
  libraryTop?: string[];
  foretold?: { cards: string[]; reduction: number };
}

/**
 * One scripted decision. `choose` names one legal action by its description, as a substring or a
 * `/pattern/flags` string; `targets` names each target slot's choice, a seat or a card name.
 */
export interface ScenarioStep {
  player: Seat;
  choose: string;
  prompt?: string;
  targets?: string[];
}

export type ScenarioExpectation =
  | { life: { player: Seat; equals: number } }
  | { energy: { player: Seat; equals: number } }
  | {
      zone: {
        player: Seat;
        zone: 'hand' | 'battlefield' | 'graveyard' | 'library' | 'exile';
        has?: string[];
        lacks?: string[];
      };
    }
  /** `player` picks whose permanent, when more than one has the name. */
  | { counters: { card: string; counter: string; equals: number; player?: Seat } }
  | { tapped: { card: string; equals: boolean; player?: Seat } }
  /** Keywords the permanent has now, after layers, as its controller's view shows them. */
  | { keywords: { card: string; has?: string[]; lacks?: string[]; player?: Seat } }
  /** Power and toughness the permanent has now, after layers, as its controller's view shows them. */
  | { stats: { card: string; power?: number; toughness?: number; player?: Seat } }
  /** An engine event of this type after the position was arranged; `payload` patterns its JSON. */
  | { event: { type: string; payload?: string; count?: number } };

/** Where the run stops: once the script is used up and the stack is empty, at a turn, or at the end. */
export type ScenarioEnd = 'script' | 'gameOver' | { turn: number };

/**
 * The production turn structure to run after the arranged priority window, which is all a
 * scenario plays without one: this turn's combat, postcombat main and end step, the next player's
 * whole turn, or the next upkeeps or precombat mains (`PreparedScenarioSpec`'s continuations).
 */
export interface ScenarioContinue {
  throughCombat?: true;
  toPostcombatMain?: true;
  toEndStep?: true;
  throughNextTurn?: true;
  throughUpkeeps?: number;
  throughPrecombatMains?: number;
}

export interface CardScenario {
  id: string;
  title: string;
  /** Oracle lines (1-based, front face first) this scenario exercises. */
  clauses: number[];
  instructions: string[];
  expectedOutcome: string;
  seed?: string;
  turnCap?: number;
  turn?: { player?: Seat; phase?: Phase; step?: Step | null; number?: number };
  seats: Partial<Record<Seat, SeatSpec>>;
  script: ScenarioStep[];
  expect: ScenarioExpectation[];
  end?: ScenarioEnd;
  continue?: ScenarioContinue;
}

export interface CardScenarioFile {
  schemaVersion: 1;
  /** The card under test, by its pin-store name. */
  card: string;
  supportCards?: SupportCardSpec[];
  scenarios: CardScenario[];
}

// ── Strict parsing ─────────────────────────────────────────────────────────────────────────────

class ScenarioFormatError extends Error {}

function fail(path: string, message: string): never {
  throw new ScenarioFormatError(`${path}: ${message}`);
}

type Shape = Record<string, (value: unknown, path: string) => void>;

function object(value: unknown, path: string, shape: Shape, required: readonly string[]): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(path, 'must be an object');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const check = shape[key];
    if (check === undefined)
      fail(path, `unknown field "${key}" (allowed: ${Object.keys(shape).join(', ')})`);
    check(record[key], `${path}.${key}`);
  }
  for (const key of required) if (!(key in record)) fail(path, `is missing "${key}"`);
}

const str = (value: unknown, path: string): void => {
  if (typeof value !== 'string' || value === '') fail(path, 'must be a non-empty string');
};
const int = (value: unknown, path: string): void => {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail(path, 'must be a whole number from 0');
};
/** Power and toughness after layers can be negative (a 1/5 under -4/-4 is -3/1). */
const signedInt = (value: unknown, path: string): void => {
  if (!Number.isSafeInteger(value)) fail(path, 'must be a whole number');
};
const text = (value: unknown, path: string): void => {
  if (typeof value !== 'string') fail(path, 'must be a string');
};
const yes = (value: unknown, path: string): void => {
  if (value !== true) fail(path, 'must be true when present');
};
const bool = (value: unknown, path: string): void => {
  if (typeof value !== 'boolean') fail(path, 'must be true or false');
};
const seat = (value: unknown, path: string): void => {
  if (!CARD_SCENARIO_SEATS.includes(value as Seat)) fail(path, 'must be P1, P2, P3 or P4');
};
const list =
  (each: (value: unknown, path: string) => void) =>
  (value: unknown, path: string): void => {
    if (!Array.isArray(value)) fail(path, 'must be a list');
    value.forEach((entry, index) => each(entry, `${path}[${index}]`));
  };
const record =
  (each: (value: unknown, path: string) => void) =>
  (value: unknown, path: string): void => {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      fail(path, 'must be an object');
    for (const [key, entry] of Object.entries(value)) each(entry, `${path}.${key}`);
  };
const shaped =
  (shape: Shape, required: readonly string[] = []) =>
  (value: unknown, path: string): void =>
    object(value, path, shape, required);

const placed = shaped(
  {
    card: str,
    tapped: yes,
    counters: record(int),
    controller: seat,
    enchantedPlayer: seat,
    attachedTo: shaped({ player: seat, card: str }, ['player', 'card']),
    goadedBy: seat,
    transformed: yes,
  },
  ['card'],
);

const seatSpec = shaped({
  life: int,
  energy: int,
  hand: list(str),
  battlefield: list((value, path) =>
    typeof value === 'string' ? str(value, path) : placed(value, path),
  ),
  graveyard: list(str),
  libraryTop: list(str),
  foretold: shaped({ cards: list(str), reduction: int }, ['cards', 'reduction']),
});

const expectation = (value: unknown, path: string): void => {
  object(
    value,
    path,
    {
      life: shaped({ player: seat, equals: int }, ['player', 'equals']),
      energy: shaped({ player: seat, equals: int }, ['player', 'equals']),
      zone: shaped(
        {
          player: seat,
          zone: (zone, at) => {
            if (!['hand', 'battlefield', 'graveyard', 'library', 'exile'].includes(zone as string))
              fail(at, 'must be hand, battlefield, graveyard, library or exile');
          },
          has: list(str),
          lacks: list(str),
        },
        ['player', 'zone'],
      ),
      counters: shaped({ card: str, counter: str, equals: int, player: seat }, [
        'card',
        'counter',
        'equals',
      ]),
      tapped: shaped({ card: str, equals: bool, player: seat }, ['card', 'equals']),
      keywords: shaped({ card: str, has: list(str), lacks: list(str), player: seat }, ['card']),
      stats: shaped({ card: str, power: signedInt, toughness: signedInt, player: seat }, ['card']),
      event: shaped({ type: str, payload: str, count: int }, ['type']),
    },
    [],
  );
  if (Object.keys(value as object).length !== 1) fail(path, 'must state exactly one expectation');
};

const scenarioShape = shaped(
  {
    id: (value, path) => {
      str(value, path);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value as string))
        fail(path, 'must be lowercase words joined by hyphens');
    },
    title: str,
    clauses: list((value, path) => {
      int(value, path);
      if ((value as number) < 1) fail(path, 'Oracle lines count from 1');
    }),
    instructions: list(str),
    expectedOutcome: str,
    seed: str,
    turnCap: int,
    turn: shaped({
      player: seat,
      phase: str,
      step: (value, path) => {
        if (value !== null) str(value, path);
      },
      number: int,
    }),
    seats: shaped(Object.fromEntries(CARD_SCENARIO_SEATS.map((id) => [id, seatSpec]))),
    script: list(
      shaped({ player: seat, choose: str, prompt: str, targets: list(str) }, ['player', 'choose']),
    ),
    expect: list(expectation),
    end: (value, path) => {
      if (value === 'script' || value === 'gameOver') return;
      object(value, path, { turn: int }, ['turn']);
    },
    continue: shaped({
      throughCombat: yes,
      toPostcombatMain: yes,
      toEndStep: yes,
      throughNextTurn: yes,
      throughUpkeeps: int,
      throughPrecombatMains: int,
    }),
  },
  ['id', 'title', 'clauses', 'instructions', 'expectedOutcome', 'seats', 'script', 'expect'],
);

/** Parse a scenario file, refusing an unknown field anywhere and a repeated scenario id. */
export function parseCardScenarioFile(json: unknown, path = 'scenario file'): CardScenarioFile {
  object(
    json,
    path,
    {
      schemaVersion: (value, at) => {
        if (value !== 1) fail(at, 'must be 1');
      },
      card: str,
      supportCards: list(
        shaped(
          {
            name: str,
            typeLine: str,
            manaCost: str,
            oracleText: text,
            power: str,
            toughness: str,
            loyalty: str,
          },
          ['name', 'typeLine'],
        ),
      ),
      scenarios: list(scenarioShape),
    },
    ['schemaVersion', 'card', 'scenarios'],
  );
  const file = json as CardScenarioFile;
  const ids = new Set<string>();
  for (const scenario of file.scenarios) {
    if (ids.has(scenario.id)) fail(path, `repeats scenario id ${scenario.id}`);
    ids.add(scenario.id);
  }
  return file;
}

/** `"/pattern/flags"` is a regular expression; anything else is a substring. */
export function scenarioPattern(text: string): (subject: string) => boolean {
  const regex = /^\/(.+)\/([a-z]*)$/.exec(text);
  if (regex !== null) {
    const compiled = new RegExp(regex[1]!, regex[2]);
    return (subject) => compiled.test(subject);
  }
  return (subject) => subject.includes(text);
}

// ── Support cards ──────────────────────────────────────────────────────────────────────────────

const CARD_TYPES = [
  'Artifact',
  'Battle',
  'Creature',
  'Enchantment',
  'Instant',
  'Land',
  'Planeswalker',
  'Sorcery',
];
const COLOR_OF: Record<string, OracleCard['colors'][number]> = {
  W: 'W',
  U: 'U',
  B: 'B',
  R: 'R',
  G: 'G',
};

export function supportCard(spec: SupportCardSpec): OracleCard {
  const [left, right] = spec.typeLine.split(/\s+—\s+/, 2);
  const words = (left ?? '').split(/\s+/);
  const manaCost = spec.manaCost ?? null;
  const symbols = [...(manaCost ?? '').matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
  const colors = [
    ...new Set(symbols.flatMap((symbol) => [...symbol].filter((c) => c in COLOR_OF))),
  ].map((c) => COLOR_OF[c]!);
  const cmc = symbols.reduce(
    (sum, symbol) => sum + (/^\d+$/.test(symbol) ? Number(symbol) : symbol === 'X' ? 0 : 1),
    0,
  );
  const id = `lab-${spec.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`;
  return {
    oracleId: id as OracleCard['oracleId'],
    scryfallId: id,
    name: spec.name,
    manaCost: manaCost as OracleCard['manaCost'],
    cmc,
    colors,
    colorIdentity: colors,
    typeLine: spec.typeLine,
    supertypes: words.filter((word) =>
      ['Basic', 'Legendary', 'Snow'].includes(word),
    ) as OracleCard['supertypes'],
    types: words.filter((word) => CARD_TYPES.includes(word)) as OracleCard['types'],
    subtypes: right === undefined ? [] : right.split(/\s+/).filter(Boolean),
    oracleText: spec.oracleText ?? '',
    power: spec.power ?? null,
    toughness: spec.toughness ?? null,
    loyalty: spec.loyalty ?? null,
    defense: null,
    keywords: [],
    layout: 'normal',
    commanderLegality: 'legal',
    isBasicLand: words.includes('Basic') && words.includes('Land'),
  };
}

// ── Building the game ──────────────────────────────────────────────────────────────────────────

/** Finds a card by name: pinned real cards first, then the file's support cards. Throws when unknown. */
export type CardResolver = (name: string) => OracleCard;

/** Basics that fill each library under the arranged cards, so no seat decks out. */
const FILLER = ['Forest', 'Plains', 'Swamp', 'Island', 'Mountain'];
const FILLER_COUNT = 24;

function placedOf(entry: string | PlacedSpec): PlacedSpec {
  return typeof entry === 'string' ? { card: entry } : entry;
}

export interface BuiltScenario {
  engine: Engine;
  players: EnginePlayerConfig[];
  prepared: PreparedScenarioSpec;
  seed: string;
}

/**
 * The scenario's engine, positioned. Every card a seat needs goes into its library first, so the
 * prepared position draws it out by name, exactly as hand-written Card Test Lab scenarios do.
 */
function continuation(spec: ScenarioContinue | undefined): Partial<PreparedScenarioSpec> {
  if (spec === undefined) return {};
  return {
    ...(spec.throughCombat === true && { continueThroughCombat: true }),
    ...(spec.toPostcombatMain === true && { continueToPostcombatMain: true }),
    ...(spec.toEndStep === true && { continueToEndStep: true }),
    ...(spec.throughNextTurn === true && { continueThroughNextTurn: true }),
    ...(spec.throughUpkeeps !== undefined && { continueThroughUpkeeps: spec.throughUpkeeps }),
    ...(spec.throughPrecombatMains !== undefined && {
      continueThroughPrecombatMains: spec.throughPrecombatMains,
    }),
  };
}

export function buildCardScenario(
  file: CardScenarioFile,
  scenario: CardScenario,
  resolve: CardResolver,
  options: { gameId: string; strictInvariants?: boolean },
): BuiltScenario {
  const lookup = (name: string): OracleCard => {
    const support = file.supportCards?.find((spec) => spec.name === name);
    return support === undefined ? resolve(name) : supportCard(support);
  };
  const players: EnginePlayerConfig[] = CARD_SCENARIO_SEATS.map((id) => {
    const spec = scenario.seats[id] ?? {};
    const names = [
      ...(spec.hand ?? []),
      ...(spec.battlefield ?? []).map((entry) => placedOf(entry).card),
      ...(spec.graveyard ?? []),
      ...(spec.libraryTop ?? []),
      ...(spec.foretold?.cards ?? []),
    ];
    return {
      id,
      deckId: `scenario-${scenario.id}-${id}`,
      commanders: [],
      cards: [
        ...names.map(lookup),
        ...Array.from({ length: FILLER_COUNT }, (_, index) => lookup(FILLER[index % 3]!)),
      ],
    };
  });

  const active = scenario.turn?.player ?? 'P1';
  const battlefield: PreparedScenarioSpec['battlefield'] = [];
  for (const id of CARD_SCENARIO_SEATS) {
    for (const entry of (scenario.seats[id]?.battlefield ?? []).map(placedOf)) {
      battlefield.push({
        playerId: id,
        cardNames: [entry.card],
        ...(entry.tapped === true && { tapped: true }),
        ...(entry.counters !== undefined && { counters: entry.counters }),
        ...(entry.controller !== undefined && { controllerId: entry.controller }),
        ...(entry.enchantedPlayer !== undefined && { enchantedPlayerId: entry.enchantedPlayer }),
        ...(entry.attachedTo !== undefined && {
          attachedToCard: { playerId: entry.attachedTo.player, cardName: entry.attachedTo.card },
        }),
        ...(entry.goadedBy !== undefined && { goadedBy: entry.goadedBy }),
        ...(entry.transformed === true && { transformed: true }),
      });
    }
  }
  const perSeat = <T>(pick: (spec: SeatSpec) => T | undefined) =>
    CARD_SCENARIO_SEATS.flatMap((id) => {
      const spec = scenario.seats[id];
      const value = spec === undefined ? undefined : pick(spec);
      return value === undefined ? [] : [{ id, value }];
    });

  const prepared: PreparedScenarioSpec = {
    currentTurnPlayer: active,
    phase: scenario.turn?.phase ?? 'precombatMain',
    step: scenario.turn?.step === undefined ? null : scenario.turn.step,
    turnNumber: scenario.turn?.number ?? 4,
    hand: perSeat((spec) => spec.hand).map(({ id, value }) => ({ playerId: id, cardNames: value })),
    battlefield,
    graveyard: perSeat((spec) => spec.graveyard).map(({ id, value }) => ({
      playerId: id,
      cardNames: value,
    })),
    libraryTop: perSeat((spec) => spec.libraryTop).map(({ id, value }) => ({
      playerId: id,
      cardNames: value,
    })),
    lifeTotals: perSeat((spec) => spec.life).map(({ id, value }) => ({
      playerId: id,
      life: value,
    })),
    energy: perSeat((spec) => spec.energy).map(({ id, value }) => ({
      playerId: id,
      amount: value,
    })),
    foretold: perSeat((spec) => spec.foretold).map(({ id, value }) => ({
      playerId: id,
      cardNames: value.cards,
      reduction: value.reduction,
    })),
    ...continuation(scenario.continue),
  };

  const seed = scenario.seed ?? `scenario-${scenario.id}`;
  const engine = new Engine(
    {
      gameId: options.gameId as GameId,
      seed,
      players,
      turnCap: scenario.turnCap ?? 12,
      ...(options.strictInvariants === true && { strictInvariants: true }),
    },
    { preparedScenario: prepared },
  );
  return { engine, players, prepared, seed };
}

// ── Answering decisions ────────────────────────────────────────────────────────────────────────

/** A decision as a failure message shows it. */
export function describeRequest(request: DecisionRequest): string {
  const actions = request.legalActions.map((action) => `    [${action.id}] ${action.description}`);
  return `${request.decidingPlayer} on turn ${request.turn} (${request.step ?? request.phase}): "${request.prompt}"\n${actions.join('\n')}`;
}

/** Every object's name by id, across zones. */
function namesById(state: GameState): Map<string, string> {
  const names = new Map<string, string>();
  for (const permanent of state.battlefield) names.set(permanent.id, permanent.name);
  for (const object of state.exile) names.set(object.id, object.name);
  for (const player of state.players)
    for (const zone of [player.hand, player.graveyard, player.library])
      for (const object of zone) names.set(object.id, object.name);
  for (const item of state.stack) names.set(item.id, item.description);
  return names;
}

/** The step's named target per slot, as the request's option ids. Throws on a name that is not exactly one option. */
export function scenarioTargets(
  state: GameState,
  request: DecisionRequest,
  action: DecisionRequest['legalActions'][number],
  step: ScenarioStep,
): DecisionResponse['targets'] {
  const slots = action.targets ?? [];
  if (slots.length === 0) {
    if (step.targets !== undefined && step.targets.length > 0)
      throw new Error(
        `"${step.choose}" takes no targets, but the step names ${step.targets.join(', ')}`,
      );
    return undefined;
  }
  if (step.targets === undefined || step.targets.length !== slots.length)
    throw new Error(
      `"${step.choose}" has ${slots.length} target slot(s); the step must name each:\n${describeRequest(request)}`,
    );
  const names = namesById(state);
  return slots.map((slot, index) => {
    const want = step.targets![index]!;
    const matching = slot.options.filter((option) => option === want || names.get(option) === want);
    if (matching.length !== 1)
      throw new Error(
        `target ${index + 1} of "${step.choose}" names "${want}", which matches ${matching.length} of: ${slot.options
          .map((option) => names.get(option) ?? option)
          .join(', ')}`,
      );
    return { slot: slot.slot, choice: matching[0]! };
  });
}

/** The step's single matching action, or null when it does not apply to this decision. */
export function scenarioAction(request: DecisionRequest, step: ScenarioStep | undefined) {
  if (step === undefined || step.player !== request.decidingPlayer) return null;
  if (step.prompt !== undefined && !scenarioPattern(step.prompt)(request.prompt)) return null;
  const matches = scenarioPattern(step.choose);
  const actions = request.legalActions.filter((action) => matches(action.description));
  // Actions the engine describes identically (eight "Find Forest" in a search) are interchangeable.
  if (
    actions.length > 1 &&
    actions.every((action) => action.description === actions[0]!.description)
  )
    return actions[0]!;
  if (actions.length > 1)
    throw new Error(
      `step "${step.choose}" matches ${actions.length} actions:\n${describeRequest(request)}`,
    );
  return actions[0] ?? null;
}
