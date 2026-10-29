// ADR 0031 decision 9: a deterministic work budget. Events emitted in one `advance()` and objects
// created in one game are counted, so a runaway loop that keeps emitting halts the game instead of
// blocking the process; computation that emits nothing is the worker watchdog's to stop. Both are
// unlimited unless set, so every tester game is unchanged.
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine';
import { EngineBudgetError } from '../src/errors';
import { emit } from '../src/log/log';
import { createGame } from '../src/state/game';
import { RuleBasedProvider, drive, forestsPod, gameConfig } from './fixtures';

describe('engine work budget (ADR 0031 decision 9)', () => {
  it('counts events emitted through a spread copy of the context against the same budget', () => {
    const ctx = createGame(gameConfig(forestsPod(8), { seed: 'budget-shared' }));
    ctx.budget = {
      maxStepWork: 3,
      stepWork: { count: 0 },
      objectsAtStart: ctx.state.nextObjectNum,
    };
    // Effect resolution copies the context by spreading it; a plain number would not be shared.
    const resolving = { ...ctx };
    emit(resolving, 'probe', {});
    emit(ctx, 'probe', {});
    emit(resolving, 'probe', {});

    expect(ctx.budget.stepWork.count).toBe(3);
    expect(() => emit(ctx, 'probe', {})).toThrow(EngineBudgetError);
    // The halt itself is never refused.
    expect(() => emit(resolving, 'engineHalt', { reason: 'x' })).not.toThrow();
  });

  it('halts the game through advance(), naming the limit', () => {
    const engine = new Engine(gameConfig(forestsPod(8), { seed: 'budget-halt' }), {
      maxStepWork: 3,
    });
    const step = engine.advance();

    expect(step.kind).toBe('gameOver');
    if (step.kind !== 'gameOver') return;
    expect(step.result.halted).toBe(true);
    expect(step.result.haltReason).toBe('the engine emitted more than 3 events in one step');
    const halt = engine.eventsSince(0).find((event) => event.type === 'engineHalt');
    expect(halt?.payload).toMatchObject({ budget: 'stepWork' });
  });

  it('halts a game that creates too many objects', () => {
    const engine = new Engine(gameConfig(forestsPod(8), { seed: 'budget-objects' }), {
      maxObjects: 2,
    });
    const result = drive(engine, new RuleBasedProvider([], { fallback: 'first' }), {
      allowHalt: true,
    });

    expect(result.halted).toBe(true);
    expect(result.haltReason).toBe('the game created more than 2 objects');
  });

  it('leaves a game inside its budget exactly as it is unlimited', () => {
    const play = (options: ConstructorParameters<typeof Engine>[1]) => {
      const engine = new Engine(gameConfig(forestsPod(10), { seed: 'budget-same' }), options);
      const result = drive(engine, new RuleBasedProvider([], { fallback: 'first' }));
      return { result, events: JSON.stringify(engine.eventsSince(0)) };
    };
    const unlimited = play({});
    const budgeted = play({ maxStepWork: 50_000, maxObjects: 20_000 });

    expect(budgeted.result).toEqual(unlimited.result);
    expect(budgeted.events).toBe(unlimited.events);
  });
});
