/**
 * The per-turn object budget (ADR 0031 decision 9, extended 2026-11-16). A loop that grows the
 * board costs more per iteration as it goes, so the step and game budgets alone would let it run
 * for hours; a turn's objects stop it in about a second.
 */
import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { DEFAULT_MAX_TOKEN_CHAIN_DEPTH, DEFAULT_MAX_TURN_OBJECTS, Engine } from '../src/engine';
import { TREASURE } from '../src/cards/tokens';
import { createGame } from '../src/state/game';
import { atResolutionDepth, createToken, resolutionDepth } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { installDefinitionTransform } from '../src/testing/definition-transform';
import { cardMutants, mutate } from './mutation/operators';
import { resolveScenarioCard, runScenario } from './scenario/runner';
import { scaffoldCard } from './scenario/scaffold';
import { RuleBasedProvider, drive, forestsPod, gameConfig } from './fixtures';

const pinned = JSON.parse(
  readFileSync(new URL('../../server/fixtures/edhrec-pinned-oracle.json', import.meta.url), 'utf8'),
) as Array<{ card: OracleCard }>;
const assembler = pinned.find((pin) => pin.card.name === 'Mechan Assembler')!.card;
const resolve = (name: string): OracleCard =>
  name === assembler.name ? assembler : resolveScenarioCard(name);

const budgetOf = (engine: Engine) => (engine as unknown as { ctx: GameContext }).ctx.budget;

describe('per-turn object budget', () => {
  it('applies by default wherever a game limit is set, and never to an unlimited game', () => {
    const config = () => gameConfig(forestsPod(8), { seed: 'turn-objects' });
    expect(budgetOf(new Engine(config(), { maxObjects: 20_000 }))?.maxTurnObjects).toBe(
      DEFAULT_MAX_TURN_OBJECTS,
    );
    expect(budgetOf(new Engine(config(), { maxObjects: 20_000 }))?.maxTokenChainDepth).toBe(
      DEFAULT_MAX_TOKEN_CHAIN_DEPTH,
    );
    expect(budgetOf(new Engine(config()))).toBeUndefined();
    expect(
      budgetOf(new Engine(config(), { maxObjects: 20_000, maxTurnObjects: 50 }))?.maxTurnObjects,
    ).toBe(50);
  });

  it('halts a turn that creates too many objects, counting each turn afresh', () => {
    const engine = new Engine(gameConfig(forestsPod(8), { seed: 'turn-objects-halt' }), {
      maxTurnObjects: 1,
    });
    const result = drive(engine, new RuleBasedProvider([], { fallback: 'first' }), {
      allowHalt: true,
    });
    expect(result.halted).toBe(true);
    expect(result.haltReason).toBe('one turn created more than 1 objects');
  });

  // The runner checks invariants strictly, which multiplies the loop's cost, so this uses a lower
  // limit than a table's; the default's timing is measured in DEFAULT_MAX_TURN_OBJECTS's comment.
  it('halts a board-growing token loop quickly, which the table limits alone would not', () => {
    // Mechan Assembler without "This ability triggers only once each turn" retriggers on its own
    // Robot token forever, emitting a few events per token.
    const definition = interpretCard(assembler);
    const index = cardMutants(definition).findIndex(
      (mutant) => mutant.label === 'triggers[0]: drop trigger oncePerTurn',
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const { file } = scaffoldCard(assembler, resolve);
    const scenario = file.scenarios[0]!;
    const previous = installDefinitionTransform((candidate) =>
      candidate.name === assembler.name ? mutate(candidate, index) : candidate,
    );
    try {
      const started = Date.now();
      expect(() =>
        runScenario(file, scenario, {
          resolve,
          maxStepWork: 50_000,
          maxObjects: 20_000,
          maxTurnObjects: 300,
        }),
      ).toThrow('one turn created more than 300 objects');
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      installDefinitionTransform(previous);
    }
  }, 60_000);
  // The runner checks invariants strictly; with the object limits out of reach, the chain depth
  // alone stops the loop, after about a hundred rounds.
  it('halts a token loop on its chain depth, long before any object limit', () => {
    const definition = interpretCard(assembler);
    const index = cardMutants(definition).findIndex(
      (mutant) => mutant.label === 'triggers[0]: drop trigger oncePerTurn',
    );
    const { file } = scaffoldCard(assembler, resolve);
    const scenario = file.scenarios[0]!;
    const previous = installDefinitionTransform((candidate) =>
      candidate.name === assembler.name ? mutate(candidate, index) : candidate,
    );
    try {
      const started = Date.now();
      expect(() =>
        runScenario(file, scenario, {
          resolve,
          maxStepWork: 50_000,
          maxObjects: 100_000,
          maxTurnObjects: 100_000,
          maxTokenChainDepth: DEFAULT_MAX_TOKEN_CHAIN_DEPTH,
        }),
      ).toThrow(`ran more than ${DEFAULT_MAX_TOKEN_CHAIN_DEPTH} deep in one turn`);
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      installDefinitionTransform(previous);
    }
  }, 60_000);

  /** A game with only the chain limit set, in a main phase. */
  function chainGame(limit = 3): GameContext {
    const ctx = createGame(gameConfig(forestsPod(8), { seed: 'token-chain' }));
    ctx.budget = { maxTokenChainDepth: limit, stepWork: { count: 0 }, objectsAtStart: 0 };
    return ctx;
  }
  /** `make` as a generator with nothing to ask, the shape a resolution has. */
  function* plain<T>(make: () => T): Generator<never, T, unknown> {
    yield* [];
    return make();
  }
  const run = <T>(gen: Generator<unknown, T, unknown>): T => {
    for (let step = gen.next(); ; step = gen.next()) if (step.done === true) return step.value;
  };

  it('counts a token one step deeper than the token that triggered its maker', () => {
    const ctx = chainGame(3);
    // A spell (no trigger object) makes the first token: depth 1.
    let token = run(
      atResolutionDepth(ctx, resolutionDepth(ctx, undefined), () =>
        plain(() => createToken(ctx, TREASURE, 'P1')),
      ),
    );
    // Each later token comes from an ability its predecessor triggered.
    for (let depth = 1; depth <= 3; depth++) {
      expect(resolutionDepth(ctx, token.cardId)).toBe(depth);
      token = run(
        atResolutionDepth(ctx, resolutionDepth(ctx, token.cardId), () =>
          plain(() => createToken(ctx, TREASURE, 'P1')),
        ),
      );
    }
    expect(() => resolutionDepth(ctx, token.cardId)).toThrow('ran more than 3 deep in one turn');
    // A new turn starts a new chain.
    ctx.state.turnNumber++;
    expect(resolutionDepth(ctx, token.cardId)).toBe(0);
  });

  it('keeps a wide legal turn shallow: hundreds of tokens each triggering an ability (fuzz-203)', () => {
    const ctx = chainGame(3);
    // Rabble Rousing makes many tokens in one resolution; each entering triggers Champion of
    // Lambholt, whose resolution makes nothing.
    const tokens = run(
      atResolutionDepth(ctx, 0, () =>
        plain(() => Array.from({ length: 600 }, () => createToken(ctx, TREASURE, 'P1'))),
      ),
    );
    for (const token of tokens) expect(resolutionDepth(ctx, token.cardId)).toBe(1);
  });
});
