/**
 * The per-turn object budget (ADR 0031 decision 9, extended 2026-11-16). A loop that grows the
 * board costs more per iteration as it goes, so the step and game budgets alone would let it run
 * for hours; a turn's objects stop it in about a second.
 */
import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { TREASURE } from '../src/cards/tokens';
import { DEFAULT_MAX_TURN_OBJECTS, Engine } from '../src/engine';
import { createGame } from '../src/state/game';
import { createTokens } from '../src/state/objects';
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

  // Regression (fuzz-203, fuzz-212): the guard counted `nextObjectNum` ids, which a token spends
  // about three of, so a legal turn of ~330 tokens halted at "1000 objects".
  it('counts objects, not ids: 600 Treasures in one turn do not halt under a limit of 1000', () => {
    const ctx = createGame(gameConfig(forestsPod(8), { seed: 'turn-objects-ids' }));
    ctx.budget = {
      stepWork: { count: 0 },
      objectsAtStart: ctx.state.nextObjectNum,
      maxTurnObjects: 1_000,
    };
    const idsAtStart = ctx.state.nextObjectNum;
    const created = createTokens(ctx, TREASURE, 600, 'P1');
    expect(created).toHaveLength(600);
    // The id counter advanced past the limit, yet only 600 objects were made.
    expect(ctx.state.nextObjectNum - idsAtStart).toBeGreaterThan(1_000);
    expect(ctx.budget.turnObjects?.created).toBe(600);
    // The limit still bites on real objects: 400 more reach 1000, the 1001st halts.
    createTokens(ctx, TREASURE, 400, 'P1');
    expect(() => createTokens(ctx, TREASURE, 1, 'P1')).toThrow(
      'one turn created more than 1000 objects',
    );
  });

  // The runner checks invariants strictly, which multiplies the loop's cost, so this uses a lower
  // limit than a table's (100 objects, about the 300 ids it was before the guard counted objects); the default's timing is measured in DEFAULT_MAX_TURN_OBJECTS's comment.
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
          maxTurnObjects: 100,
        }),
      ).toThrow('one turn created more than 100 objects');
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      installDefinitionTransform(previous);
    }
  }, 60_000);
});
