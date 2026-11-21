/**
 * The benchmark case format. A case arranges one position with the engine's own scenario format
 * (`CardScenario`, the format the Card Test Lab and engine tests use), names the seat under test,
 * and carries the reviewed reference analysis the harness scores against.
 *
 *  - `single`: the seat answers ONE decision. Every legal answer is graded by the reference.
 *  - `turn`: the seat answers every decision it is shown until the arranged turn ends. The final
 *    position is scored against the reference objectives.
 *
 * Parsing is strict: an unknown field anywhere is an error, as in the scenario format itself.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CARD_SCENARIO_SEATS,
  parseCardScenarioFile,
  type CardScenario,
  type CardScenarioFile,
} from '../../packages/engine/src';

export type Seat = (typeof CARD_SCENARIO_SEATS)[number];
export type Grade = 'best' | 'good' | 'weak' | 'blunder';
export const GRADES: readonly Grade[] = ['best', 'good', 'weak', 'blunder'];
/** What each grade is worth on a one-decision case. */
export const GRADE_POINTS: Record<Grade, number> = { best: 1, good: 0.7, weak: 0.3, blunder: 0 };

/**
 * One answer, named the way a person would: the action by its description (a substring, or a
 * `/pattern/flags` string), then either each target slot in order (`targets`) or, for an attack or
 * block declaration, each creature by name (`assign`).
 *
 * In `assign`, a value is a seat (`"P3"`), a card name (the attacker to block), or `"-"` for
 * "holds back". When matching an answer, `"*"` accepts anything, `"+"` accepts anything but
 * holding back, and a creature left out is not checked. When scripting a line, a creature left
 * out holds back.
 */
export interface AnswerSpec {
  choose: string;
  targets?: string[];
  assign?: Record<string, string>;
  /**
   * Scripted lines only: how a blocked attacker's combat damage is divided, by blocker name and
   * defending seat (`{ "Savannah Lions": 1, "P3": 5 }`). `choose` is then ignored.
   */
  split?: Record<string, number>;
  /** Only answer a decision whose prompt matches (scripted lines only). */
  prompt?: string;
}

/** One reviewed answer to a one-decision case. The first option that matches an answer grades it. */
export interface ReferenceOption {
  label: string;
  when: AnswerSpec;
  grade: Grade;
  why: string;
}

export interface SingleReference {
  /** The reviewer's reading of the position, shown to judges. */
  analysis: string;
  options: ReferenceOption[];
  /** The grade of any legal answer no option matches. */
  otherwise: { grade: Grade; why: string };
}

/** A whole-turn line the reviewer played out; the harness replays it through the engine. */
export interface ReferenceLine {
  id: string;
  label: string;
  grade: Grade;
  why: string;
  steps: AnswerSpec[];
}

/** One fact about the end of the turn, checked against the engine's final state. */
export type ObjectiveCheck =
  | { eliminated: Seat }
  | { life: { player: Seat; atLeast?: number; atMost?: number } }
  | {
      zone: {
        player: Seat;
        zone: 'hand' | 'battlefield' | 'graveyard' | 'exile';
        has?: string[];
        lacks?: string[];
      };
    }
  /** A pattern over the seat's own actions, in order, as the report words them. */
  | { action: { took?: string; neverTook?: string } };

export interface Objective {
  id: string;
  label: string;
  points: number;
  check: ObjectiveCheck;
}

export interface TurnReference {
  analysis: string;
  lines: ReferenceLine[];
  objectives: Objective[];
}

/** A deal in force at the position, as the engine's diplomacy table states one. */
export interface BenchDeal {
  parties: [Seat, Seat];
  /** Rounds the deal still has to run. */
  rounds: number;
  obligations: Array<
    | { kind: 'noAttack' | 'noTarget' | 'noCounter'; by: Seat; against: Seat }
    | { kind: 'attackPlayer'; by: Seat; target: Seat }
  >;
}

export interface BenchContext {
  strategy?: {
    intent: string;
    threatOrder?: Seat[];
    steering?: {
      aggression?: number;
      targetOrder?: Seat[];
      prioritize?: string[];
      hold?: string[];
      holdUpMana?: number;
      avoidOverextending?: boolean;
    };
  };
  deals?: BenchDeal[];
}

/** How every seat the benchmark is not testing plays: the heuristic bot, or holding still. */
export type TablePolicy = 'heuristic' | 'passive';

export interface BenchCase {
  schemaVersion: 1;
  id: string;
  role: 'tactician';
  scope: 'single' | 'turn';
  title: string;
  /** Short tags: `lethal`, `blocking`, `removal-targeting`, `sequencing`, ... */
  skills: string[];
  /** What the case tests and why it is hard, for the judge. Never shown to the model. */
  briefing: string;
  actor: Seat;
  position: {
    seed?: string;
    turnCap?: number;
    turn?: NonNullable<CardScenario['turn']>;
    seats: CardScenario['seats'];
    /**
     * Each seat's commander(s) by card name, one or two (CR 903.3). A commander its seat's
     * battlefield names starts there with commander status; one named nowhere else waits in the
     * command zone. Either way the seat's `PlayerView.commanders`, and every opponent's
     * `opponents[].commanders`, show it.
     */
    commanders?: Partial<Record<Seat, string[]>>;
    continue?: NonNullable<CardScenario['continue']>;
  };
  supportCards?: NonNullable<CardScenarioFile['supportCards']>;
  /** Decisions played before the one under test, in order, by any seat. */
  setup?: Array<AnswerSpec & { player: Seat }>;
  /** Which of the actor's decisions is under test; the first one after `setup` by default. */
  focus?: { decisionType?: string; prompt?: string };
  table?: {
    policy?: TablePolicy;
    /**
     * Decisions made after the focus, in order, before the policy answers. A step that no longer
     * applies (the creature it names is gone) is skipped rather than failing the run.
     */
    script?: Array<AnswerSpec & { player: Seat }>;
    /**
     * One-decision cases only: how the tested seat plays AFTER its one decision. `still` (the
     * default) passes and declares nothing, so the run shows that decision alone; `heuristic`
     * lets the bot play on, for a case whose consequence needs the seat to block later.
     */
    actorAfterFocus?: 'still' | 'heuristic';
  };
  /** A turn case stops asking the seat after this many decisions (default 24). */
  maxActorDecisions?: number;
  /**
   * Turn cases only: how many of the seat's own turns the case spans (ADR 0045 decision 6). Above
   * 1, `position.continue` must reach past the first turn (`throughNextTurn` or a count), and the
   * seat answers every decision of those turns under `maxActorDecisions`.
   */
  turns?: number;
  /**
   * What the seat's strategist and table would have told the tactician (ADR 0045 decision 6): the
   * strategist's view, and deals in force. Handed to a model through the production
   * `TacticalGuidance`; the local and bot-led bots do not read it.
   */
  context?: BenchContext;
  reference: SingleReference | TurnReference;
}

export const DEFAULT_MAX_ACTOR_DECISIONS = 24;

class CaseFormatError extends Error {}

function fail(path: string, message: string): never {
  throw new CaseFormatError(`${path}: ${message}`);
}

type Check = (value: unknown, path: string) => void;

function object(
  value: unknown,
  path: string,
  shape: Record<string, Check>,
  required: readonly string[],
): asserts value is Record<string, unknown> {
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

const str: Check = (value, path) => {
  if (typeof value !== 'string' || value === '') fail(path, 'must be a non-empty string');
};
const int: Check = (value, path) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail(path, 'must be a whole number from 0');
};
const seat: Check = (value, path) => {
  if (!CARD_SCENARIO_SEATS.includes(value as Seat)) fail(path, 'must be P1, P2, P3 or P4');
};
const grade: Check = (value, path) => {
  if (!GRADES.includes(value as Grade)) fail(path, `must be one of ${GRADES.join(', ')}`);
};
const oneOf =
  (...allowed: string[]): Check =>
  (value, path) => {
    if (!allowed.includes(value as string)) fail(path, `must be one of ${allowed.join(', ')}`);
  };
const list =
  (each: Check, min = 0): Check =>
  (value, path) => {
    if (!Array.isArray(value)) fail(path, 'must be a list');
    if (value.length < min) fail(path, `needs at least ${min} entr${min === 1 ? 'y' : 'ies'}`);
    value.forEach((entry, index) => each(entry, `${path}[${index}]`));
  };
const shaped =
  (shape: Record<string, Check>, required: readonly string[] = []): Check =>
  (value, path) =>
    object(value, path, shape, required);
/** Checked by the engine's scenario parser, which owns that format. */
const scenarioOwned: Check = () => undefined;

const ANSWER_SHAPE: Record<string, Check> = {
  choose: str,
  targets: list(str),
  assign: (value, path) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      fail(path, 'must map creature names to choices');
    for (const [key, entry] of Object.entries(value)) str(entry, `${path}.${key}`);
  },
  split: (value, path) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      fail(path, 'must map blocker names and seats to damage');
    for (const [key, entry] of Object.entries(value)) int(entry, `${path}.${key}`);
  },
  prompt: str,
};
const answer = shaped(ANSWER_SHAPE, ['choose']);
const seatedAnswer = shaped({ ...ANSWER_SHAPE, player: seat }, ['player', 'choose']);

const objectiveCheck: Check = (value, path) => {
  object(
    value,
    path,
    {
      eliminated: seat,
      life: shaped({ player: seat, atLeast: int, atMost: int }, ['player']),
      zone: shaped(
        {
          player: seat,
          zone: oneOf('hand', 'battlefield', 'graveyard', 'exile'),
          has: list(str),
          lacks: list(str),
        },
        ['player', 'zone'],
      ),
      action: shaped({ took: str, neverTook: str }),
    },
    [],
  );
  if (Object.keys(value).length !== 1) fail(path, 'must state exactly one check');
};

const fraction: Check = (value, path) => {
  if (typeof value !== 'number' || !(value >= 0 && value <= 1)) fail(path, 'must be from 0 to 1');
};
const flag: Check = (value, path) => {
  if (typeof value !== 'boolean') fail(path, 'must be true or false');
};
const obligation: Check = (value, path) => {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind === 'attackPlayer')
    object(value, path, { kind: str, by: seat, target: seat }, ['kind', 'by', 'target']);
  else if (kind === 'noAttack' || kind === 'noTarget' || kind === 'noCounter')
    object(value, path, { kind: str, by: seat, against: seat }, ['kind', 'by', 'against']);
  else fail(`${path}.kind`, 'must be noAttack, noTarget, noCounter or attackPlayer');
};
const benchContext = shaped({
  strategy: shaped(
    {
      intent: str,
      threatOrder: list(seat),
      steering: shaped({
        aggression: fraction,
        targetOrder: list(seat),
        prioritize: list(str),
        hold: list(str),
        holdUpMana: int,
        avoidOverextending: flag,
      }),
    },
    ['intent'],
  ),
  deals: list(
    shaped({ parties: list(seat, 2), rounds: int, obligations: list(obligation, 1) }, [
      'parties',
      'rounds',
      'obligations',
    ]),
  ),
});

const commanderSeats: Check = (value, path) =>
  object(
    value,
    path,
    Object.fromEntries(
      CARD_SCENARIO_SEATS.map((id) => [
        id,
        (names: unknown, at: string) => {
          list(str, 1)(names, at);
          const named = names as string[];
          if (named.length > 2) fail(at, 'names one commander, or two partners');
          if (new Set(named).size !== named.length) fail(at, 'repeats a commander');
        },
      ]),
    ),
    [],
  );

const singleReference = shaped(
  {
    analysis: str,
    options: list(
      shaped({ label: str, when: answer, grade, why: str }, ['label', 'when', 'grade', 'why']),
      1,
    ),
    otherwise: shaped({ grade, why: str }, ['grade', 'why']),
  },
  ['analysis', 'options', 'otherwise'],
);

const turnReference = shaped(
  {
    analysis: str,
    lines: list(
      shaped({ id: str, label: str, grade, why: str, steps: list(answer) }, [
        'id',
        'label',
        'grade',
        'why',
        'steps',
      ]),
      1,
    ),
    objectives: list(
      shaped({ id: str, label: str, points: int, check: objectiveCheck }, [
        'id',
        'label',
        'points',
        'check',
      ]),
      1,
    ),
  },
  ['analysis', 'lines', 'objectives'],
);

/** The scenario file and scenario a case's position is, for the engine's builder. */
export function caseScenario(benchCase: BenchCase): {
  file: CardScenarioFile;
  scenario: CardScenario;
} {
  const { position } = benchCase;
  const scenario: CardScenario = {
    id: benchCase.id,
    title: benchCase.title,
    clauses: [],
    instructions: [],
    expectedOutcome: benchCase.title,
    seed: position.seed ?? `bot-bench-${benchCase.id}`,
    ...(position.turnCap !== undefined && { turnCap: position.turnCap }),
    ...(position.turn !== undefined && { turn: position.turn }),
    seats: position.seats,
    script: [],
    expect: [],
    ...(position.continue !== undefined && { continue: position.continue }),
  };
  const file: CardScenarioFile = {
    schemaVersion: 1,
    card: benchCase.id,
    ...(benchCase.supportCards !== undefined && { supportCards: benchCase.supportCards }),
    scenarios: [scenario],
  };
  return { file, scenario };
}

/** Parse one case, refusing unknown fields, a reference of the wrong kind, and a bad position. */
export function parseBenchCase(json: unknown, path = 'case'): BenchCase {
  object(
    json,
    path,
    {
      schemaVersion: (value, at) => {
        if (value !== 1) fail(at, 'must be 1');
      },
      id: (value, at) => {
        str(value, at);
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value as string))
          fail(at, 'must be lowercase words joined by hyphens');
      },
      role: oneOf('tactician'),
      scope: oneOf('single', 'turn'),
      title: str,
      skills: list(str, 1),
      briefing: str,
      actor: seat,
      position: shaped(
        {
          seed: str,
          turnCap: int,
          turn: scenarioOwned,
          seats: scenarioOwned,
          commanders: commanderSeats,
          continue: scenarioOwned,
        },
        ['seats'],
      ),
      supportCards: scenarioOwned,
      setup: list(seatedAnswer),
      focus: shaped({ decisionType: str, prompt: str }),
      table: shaped({
        policy: oneOf('heuristic', 'passive'),
        script: list(seatedAnswer),
        actorAfterFocus: oneOf('still', 'heuristic'),
      }),
      maxActorDecisions: int,
      turns: int,
      context: benchContext,
      reference: () => undefined,
    },
    [
      'schemaVersion',
      'id',
      'role',
      'scope',
      'title',
      'skills',
      'briefing',
      'actor',
      'position',
      'reference',
    ],
  );
  const benchCase = json as unknown as BenchCase;
  if (benchCase.scope === 'single') singleReference(benchCase.reference, `${path}.reference`);
  else turnReference(benchCase.reference, `${path}.reference`);
  if (benchCase.scope === 'turn') {
    const reference = benchCase.reference as TurnReference;
    const ids = new Set<string>();
    for (const item of [...reference.lines, ...reference.objectives]) {
      if (ids.has(item.id)) fail(`${path}.reference`, `repeats id ${item.id}`);
      ids.add(item.id);
    }
    if (!reference.lines.some((line) => line.grade === 'best'))
      fail(`${path}.reference.lines`, 'needs a line graded best');
    if (reference.objectives.reduce((sum, objective) => sum + objective.points, 0) <= 0)
      fail(`${path}.reference.objectives`, 'must be worth points');
  } else if (!(benchCase.reference as SingleReference).options.some((o) => o.grade === 'best')) {
    fail(`${path}.reference.options`, 'needs an option graded best');
  }
  if (benchCase.turns !== undefined) {
    if (benchCase.scope !== 'turn') fail(`${path}.turns`, 'is for turn cases');
    if (benchCase.turns < 1) fail(`${path}.turns`, 'must be at least 1');
    const reach = benchCase.position.continue;
    if (
      benchCase.turns > 1 &&
      reach?.throughNextTurn !== true &&
      (reach?.throughPrecombatMains ?? 0) < 2 &&
      (reach?.throughUpkeeps ?? 0) < 2
    )
      fail(`${path}.position.continue`, 'must reach past the first turn of a multi-turn case');
  }
  for (const [index, deal] of (benchCase.context?.deals ?? []).entries()) {
    if (deal.parties.length !== 2 || deal.parties[0] === deal.parties[1])
      fail(`${path}.context.deals[${index}].parties`, 'must name two different seats');
    for (const o of deal.obligations)
      if (!deal.parties.includes(o.by))
        fail(`${path}.context.deals[${index}]`, `an obligation is owed by ${o.by}, not a party`);
  }
  for (const [id, names] of Object.entries(benchCase.position.commanders ?? {}) as [
    Seat,
    string[],
  ][]) {
    const spec = benchCase.position.seats[id] ?? {};
    const elsewhere = [
      ...(spec.hand ?? []),
      ...(spec.graveyard ?? []),
      ...(spec.libraryTop ?? []),
      ...(spec.foretold?.cards ?? []),
    ];
    for (const name of names)
      if (elsewhere.includes(name))
        fail(
          `${path}.position.commanders.${id}`,
          `${name} must be on ${id}'s battlefield or in the command zone, not in a hand, graveyard or library`,
        );
  }
  // The engine's parser owns the position's shape (seats, turn, continuation, support cards).
  parseCardScenarioFile(caseScenario(benchCase).file, `${path}.position`);
  return benchCase;
}

export const CASES_DIRECTORY = fileURLToPath(new URL('../cases/', import.meta.url));

/** Every committed case of a role, one-decision cases first, each group in file-name order. */
export function loadCases(role: 'tactician' = 'tactician', root = CASES_DIRECTORY): BenchCase[] {
  const cases: BenchCase[] = [];
  for (const scope of ['single', 'turn'] as const) {
    const directory = join(root, role, scope);
    let names: string[];
    try {
      names = readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(directory, name);
      const parsed = parseBenchCase(JSON.parse(readFileSync(path, 'utf8')), path);
      if (parsed.scope !== scope) fail(path, `is a ${parsed.scope} case in the ${scope} folder`);
      if (`${parsed.id}.json` !== name) fail(path, `must be named ${parsed.id}.json`);
      if (cases.some((existing) => existing.id === parsed.id)) fail(path, 'repeats a case id');
      cases.push(parsed);
    }
  }
  return cases;
}
