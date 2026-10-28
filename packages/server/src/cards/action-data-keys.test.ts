/**
 * ADR 0032 decision 4: every key the engine puts in `LegalAction.data` is registered in
 * `@mtg/shared`'s `ACTION_DATA_KEYS`, with the value types it carries.
 *
 * Keys are collected from two sources:
 *   - the first surfaced decision of every Card Test Lab scenario;
 *   - four fixed-seed four-bot games over generated decks from the committed coverage oracle.
 *
 * This proves coverage only of the keys those runs reach. A change that adds a `data` key
 * registers it in `packages/shared/src/action-data-keys.ts`.
 */

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { HeuristicDecisionProvider } from '@mtg/bot';
import { Engine, runToCompletion } from '@mtg/engine';
import { ACTION_DATA_KEYS } from '@mtg/shared';
import type { ActionDataValueType, DecisionRequest, OracleCard, PlayerId } from '@mtg/shared';
import { generateCommanderDeck } from '../decks/generate';
import { CARD_TEST_SCENARIO_IDS, createCardTestScenario } from './card-test-scenarios';
import { buildSupportedPool } from './pool';

const GAME_SEEDS = ['keys-1', 'keys-2', 'keys-3', 'keys-4'];
/** Enough turns for lands, casts, activations and combat to surface; the sweep must stay fast. */
const GAME_TURN_CAP = 8;

/** key -> value types seen -> where first seen, for failure messages. */
/** A value type outside the registry's vocabulary (a function, bigint, ...) is `other`. */
type ObservedType = ActionDataValueType | 'other';
type Observed = Map<string, Map<ObservedType, string>>;

function valueType(value: unknown): ObservedType {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'object';
  const kind = typeof value;
  return kind === 'number' || kind === 'string' || kind === 'boolean' || kind === 'object'
    ? kind
    : 'other';
}

function observe(observed: Observed, request: DecisionRequest, source: string): void {
  for (const action of request.legalActions) {
    for (const [key, value] of Object.entries(action.data ?? {})) {
      // `undefined` is dropped by the JSON the AI and the browser actually receive.
      if (value === undefined) continue;
      const type = valueType(value);
      const seen = observed.get(key) ?? new Map<ObservedType, string>();
      if (!seen.has(type)) seen.set(type, `${source} (${action.type})`);
      observed.set(key, seen);
    }
  }
}

function sweepScenarios(observed: Observed): void {
  for (const id of CARD_TEST_SCENARIO_IDS) {
    const scenario = createCardTestScenario(id, 'action-data-keys');
    if (scenario === null) throw new Error(`unknown scenario ${id}`);
    for (;;) {
      const step = scenario.engine.advance();
      if (step.kind === 'continue') continue;
      if (step.kind === 'decision') observe(observed, step.request, id);
      break;
    }
  }
}

function sweepGames(observed: Observed): void {
  // The committed oracle fixture, so the sweep runs without the gitignored Scryfall bulk file.
  const cards = JSON.parse(
    readFileSync(new URL('../../fixtures/coverage-oracle.json', import.meta.url), 'utf8'),
  ) as OracleCard[];
  const pool = buildSupportedPool(cards);
  for (const seed of GAME_SEEDS) {
    const decks = [1, 2, 3, 4].map((seat) =>
      generateCommanderDeck(pool, { seed: `${seed}-deck-${seat}` }),
    );
    const engine = new Engine({
      gameId: seed,
      seed,
      turnCap: GAME_TURN_CAP,
      players: decks.map((deck, i) => ({
        id: `P${i + 1}`,
        deckId: `${seed}-${i + 1}`,
        commanders: [deck.commander],
        cards: deck.cards,
      })),
    });
    const bots = new Map<string, HeuristicDecisionProvider>();
    runToCompletion(
      engine,
      (seat) => {
        let bot = bots.get(seat);
        if (bot === undefined) {
          bot = new HeuristicDecisionProvider(`${seed}-${seat}`, () =>
            engine.view(seat as PlayerId),
          );
          bots.set(seat, bot);
        }
        return bot;
      },
      { onDecision: (request) => observe(observed, request, seed) },
    );
  }
}

describe('LegalAction.data key registry', () => {
  const observed: Observed = new Map();

  beforeAll(() => {
    sweepScenarios(observed);
    sweepGames(observed);
  }, 120_000);

  it('registers every emitted key', () => {
    const unregistered = [...observed]
      .filter(([key]) => !Object.hasOwn(ACTION_DATA_KEYS, key))
      .map(([key, types]) => `${key} (${[...types.values()][0]})`);
    expect(unregistered, 'add these to packages/shared/src/action-data-keys.ts').toEqual([]);
  });

  it('only emits registered value types', () => {
    const unexpected: string[] = [];
    for (const [key, types] of observed) {
      const info = ACTION_DATA_KEYS[key];
      if (info === undefined) continue;
      for (const [type, where] of types) {
        if (type === 'other' || !info.types.includes(type))
          unexpected.push(`${key}: ${type} from ${where}`);
      }
    }
    expect(unexpected, 'widen the key in packages/shared/src/action-data-keys.ts').toEqual([]);
  });

  it('emits every presentation key unless it is marked rare', () => {
    const silent = Object.entries(ACTION_DATA_KEYS)
      .filter(([, info]) => info.consumers.includes('presentation') && info.rare !== true)
      .map(([key]) => key)
      .filter((key) => !observed.has(key));
    expect(silent, 'nothing emitted these; mark them rare or remove the dead read').toEqual([]);
  });
});
