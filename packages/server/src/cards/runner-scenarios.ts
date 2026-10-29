/**
 * Card Test Lab scenarios from the scenario files the engine tests run (ADR 0034 decision 10):
 * the same position, cards and script, so a scenario is written once. P1 is the viewer, who plays
 * the script's P1 steps by hand; every other seat answers its own script steps in order, passes
 * priority otherwise, and takes its first legal action for any other choice, as lab bots do.
 * Scenario IDs come from the files, so there is no hand-kept list to drift.
 */
import { readFileSync } from 'node:fs';
import {
  CARD_SCENARIO_SEATS,
  buildCardScenario,
  parseCardScenarioFile,
  scenarioAction,
  scenarioTargets,
  type CardScenario,
  type CardScenarioFile,
} from '@mtg/engine';
import type { Engine } from '@mtg/engine';
import type { DecisionRequest, DecisionResponse, GameId, OracleCard, PlayerId } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';

interface PinStoreFile {
  names: Record<string, string>;
  cards: Record<string, OracleCard>;
}

const store = JSON.parse(
  readFileSync(
    new URL('../../../../packages/engine/tests/fixtures/pin-store.json', import.meta.url),
    'utf8',
  ),
) as PinStoreFile;
const pool = JSON.parse(
  readFileSync(new URL('../../fixtures/coverage-oracle.json', import.meta.url), 'utf8'),
) as OracleCard[];

function resolveCard(name: string): OracleCard {
  const sha = store.names[name];
  if (sha !== undefined) return store.cards[sha]!;
  const basic = pool.find((card) => card.name === name && card.isBasicLand);
  if (basic !== undefined) return basic;
  throw new Error(`Scenario card "${name}" is neither pinned nor a basic land`);
}

const scenarioFile = (name: string, text: string): CardScenarioFile =>
  parseCardScenarioFile(JSON.parse(text), `engine/tests/scenarios/${name}`);

/**
 * Every scenario file, each read through its own literal path so viewer evidence binds its bytes.
 * `card:finish` adds a line here; `runner-scenarios.test.ts` checks it against the directory.
 */
export const RUNNER_SCENARIO_FILES: ReadonlyArray<{ name: string; file: CardScenarioFile }> = [
  {
    name: 'path-to-exile.json',
    file: scenarioFile(
      'path-to-exile.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/path-to-exile.json', import.meta.url),
        'utf8',
      ),
    ),
  },
];
const FILES = RUNNER_SCENARIO_FILES.map(({ file }) => file);

/** Every runner scenario, for the lab's picker and the viewer spec. */
export const RUNNER_SCENARIOS = FILES.flatMap((file) =>
  file.scenarios.map(({ id, title }) => ({ id, cardName: file.card, title })),
);

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Clause ids for the Oracle lines a scenario exercises. */
export function runnerClauseIds(cardName: string, lines: readonly number[]): string[] {
  return lines.map((line) => `${slug(cardName)}-clause-${line}`);
}

/** A non-viewer seat that answers its script steps, in order, and otherwise plays it safe. */
function scriptedSeat(seat: PlayerId, scenario: CardScenario, engine: () => Engine) {
  const steps = scenario.script.filter((step) => step.player === seat);
  let next = 0;
  return {
    decide(request: DecisionRequest): DecisionResponse {
      const step = steps[next];
      const action = scenarioAction(request, step);
      if (action !== null && step !== undefined) {
        next += 1;
        const targets = scenarioTargets(engine().getState(), request, action, step);
        return {
          requestId: request.requestId,
          actionId: action.id,
          ...(targets !== undefined && { targets }),
        };
      }
      const pass = request.legalActions.find((candidate) => candidate.type === 'pass');
      const fallback = pass ?? request.legalActions[0]!;
      return {
        requestId: request.requestId,
        actionId: fallback.id,
        ...(fallback.targets !== undefined && {
          targets: fallback.targets.map((slot) => ({ slot: slot.slot, choice: slot.options[0]! })),
        }),
      };
    },
  };
}

export function runnerScenario(id: string, gameId: GameId): CardTestScenario {
  for (const file of FILES) {
    const scenario = file.scenarios.find((candidate) => candidate.id === id);
    if (scenario === undefined) continue;
    const built = buildCardScenario(file, scenario, resolveCard, { gameId });
    const engine = built.engine;
    const sha = store.names[file.card];
    if (sha === undefined) throw new Error(`Scenario card ${file.card} is not pinned`);
    return {
      metadata: {
        id,
        version: 1,
        title: scenario.title,
        instructions: scenario.instructions,
        expectedOutcome: scenario.expectedOutcome,
        oracleSha256: sha,
        clauseIds: runnerClauseIds(file.card, scenario.clauses),
      },
      seed: built.seed,
      seats: built.players.map((config) => ({
        seat: config.id,
        config,
        deckSnapshotId: null,
        summary: {
          seat: config.id,
          deckId: config.deckId,
          label: config.id,
          commanderNames: [],
          colorIdentity: [],
          archetypeTag: 'card-test-lab',
        },
      })),
      engine,
      decisionProviderOverrides: Object.fromEntries(
        CARD_SCENARIO_SEATS.filter((seat) => seat !== 'P1').map((seat) => [
          seat,
          scriptedSeat(seat, scenario, () => engine),
        ]),
      ),
    };
  }
  throw new Error(`Unknown runner scenario ${id}`);
}
