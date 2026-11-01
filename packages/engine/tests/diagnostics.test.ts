/**
 * The test-only diagnostics sink and the early-exit helpers (ADR 0034 decision 4): an early exit
 * is charged to the op running, speculative work records nothing, and recording changes nothing.
 */
import { describe, expect, it } from 'vitest';
import { castingCheckpoint } from '../src/casting/checkpoint';
import { castingPreviewContext } from '../src/casting/preview';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { Engine } from '../src/engine';
import { EngineInvariantError } from '../src/errors';
import { invariant, noop } from '../src/exits';
import { RandomDecisionProvider, runToCompletion } from '../src/providers/providers';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { DiagnosticsSink, installDefaultDiagnostics } from '../src/testing/diagnostics';
import {
  bear,
  bolt,
  commanderFor,
  copies,
  forest,
  gameConfig,
  mountain,
  pumpStrict,
  spawn,
} from './fixtures';

const game = (diagnostics?: DiagnosticsSink): GameContext =>
  createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(6, forest) })),
      diagnostics === undefined ? {} : { diagnostics },
    ),
  );

describe('diagnostics sink', () => {
  it('diagnostics-charged-to-op — an illegal target is an early exit of the op that skips it', () => {
    const sink = new DiagnosticsSink();
    const ctx = game(sink);
    const source = spawn(ctx, 'P1', bolt());
    const target = spawn(ctx, 'P2', bear());
    pumpStrict(moveObject(ctx, target, { zone: 'graveyard' }));

    pumpStrict(executeAbility(ctx, source, interpretCard(bolt()).spellAbility!, [target.id]));

    expect(sink.opRuns()).toEqual([
      { card: 'Test Bolt', op: 'dealDamage', runs: 1, earlyExits: 1 },
    ]);
    expect(sink.exits()).toEqual([
      { site: 'resolve.ref.targetIllegal', reason: 'targetIllegal', count: 1 },
    ]);
    expect(sink.current).toBeNull();
  });

  it('diagnostics-op-that-acts — an op that acts is a run without an early exit', () => {
    const sink = new DiagnosticsSink();
    const ctx = game(sink);
    const source = spawn(ctx, 'P1', bolt());
    pumpStrict(executeAbility(ctx, source, interpretCard(bolt()).spellAbility!, ['P2']));
    expect(sink.opRuns()).toEqual([
      { card: 'Test Bolt', op: 'dealDamage', runs: 1, earlyExits: 0 },
    ]);
    expect(sink.exits()).toEqual([]);
  });

  it('records nothing and builds no detail without a sink', () => {
    const ctx = game();
    expect(ctx.diagnostics).toBeUndefined();
    noop(ctx, 'probe', 'nothingQualifies', () => {
      throw new Error('detail built without a sink');
    });
  });

  it('drops what a rolled-back cast recorded, and a cast preview carries no sink', () => {
    const sink = new DiagnosticsSink();
    const ctx = game(sink);
    sink.enterOp('Before', 'draw');
    const rollback = castingCheckpoint(ctx);
    sink.enterOp('During', 'draw');
    noop(ctx, 'probe', 'nothingQualifies');
    rollback();
    expect(sink.opRuns()).toEqual([{ card: 'Before', op: 'draw', runs: 1, earlyExits: 0 }]);
    expect(sink.exits()).toEqual([]);

    const card = ctx.state.players[0]!.hand[0] ?? ctx.state.players[0]!.library[0]!;
    expect(castingPreviewContext(ctx, card).diagnostics).toBeUndefined();
  });

  it('gives each new game its own sink while the default is installed', () => {
    const { sinks, restore } = installDefaultDiagnostics();
    try {
      const first = game();
      const second = game();
      expect(sinks).toEqual([first.diagnostics, second.diagnostics]);
      expect(first.diagnostics).not.toBe(second.diagnostics);
    } finally {
      restore();
    }
    expect(game().diagnostics).toBeUndefined();
  });

  it('plays the same game, event for event, with the sink on', () => {
    const play = (): string => {
      const engine = new Engine(
        gameConfig(
          [0, 1, 2, 3].map((i) => ({
            commander: commanderFor(i % 2 === 0 ? 'G' : 'R', `Sink General ${i + 1}`),
            cards: [
              ...copies(10, forest),
              ...copies(4, mountain),
              ...copies(6, bear),
              ...copies(4, bolt),
            ],
          })),
          { gameId: 'diagnostics-on-off', seed: 'sink', turnCap: 20 },
        ),
      );
      runToCompletion(engine, (seat) => new RandomDecisionProvider(`sink-${seat}`));
      return JSON.stringify(engine.getState().eventLog);
    };
    const off = play();
    const { sinks, restore } = installDefaultDiagnostics();
    let on: string;
    try {
      on = play();
    } finally {
      restore();
    }
    expect(on).toBe(off);
    expect(sinks).toHaveLength(1);
    expect(sinks[0]!.opRuns().length).toBeGreaterThan(0);
  }, 60_000);
});

describe('invariant', () => {
  it('throws an EngineInvariantError naming the site', () => {
    expect(() => invariant('probe.site', 'unreachable from a validated definition')).toThrow(
      EngineInvariantError,
    );
    expect(() => invariant('probe.site', 'unreachable')).toThrow(/at probe\.site: unreachable/);
  });
});
