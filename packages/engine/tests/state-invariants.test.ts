/** Whole-state invariants (ADR 0034 decision 8): each check fires, and checking changes nothing. */
import { describe, expect, it } from 'vitest';
import { computeAllCharacteristics } from '../src/effects/continuous';
import { getCached, setCached } from '../src/effects/layer-cache';
import { Engine } from '../src/engine';
import { EngineInvariantError } from '../src/errors';
import { RandomDecisionProvider, runToCompletion } from '../src/providers/providers';
import { priorityCheckpoint } from '../src/sba/sba';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { installCheckpointHook } from '../src/testing/checkpoint-hook';
import { checkStateInvariants, installStateInvariants } from '../src/testing/invariants';
import {
  bear,
  bolt,
  commanderFor,
  copies,
  forest,
  gameConfig,
  giantGrowth,
  mountain,
  pumpStrict,
  spawn,
} from './fixtures';

function game(): GameContext {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(6, forest) }))));
  ctx.state.players[0]!.hand.push(...ctx.state.players[0]!.library.splice(0, 2));
  return ctx;
}

describe('state invariants', () => {
  it('holds for a fresh game', () => {
    expect(checkStateInvariants(game())).toEqual([]);
  });

  it('finds an object in two zones, and a card in two places', () => {
    const ctx = game();
    const p1 = ctx.state.players[0]!;
    const card = p1.hand[0]!;
    ctx.state.exile.push({ ...card });
    p1.graveyard.push({ ...p1.hand[1]!, id: 'o-copy' });
    expect(checkStateInvariants(ctx)).toEqual([
      `card ${p1.hand[1]!.cardId} (Forest) is in P1 graveyard and in P1 hand`,
      `object ${card.id} (Forest) is in exile and in P1 hand`,
      `card ${card.cardId} (Forest) is in exile and in P1 hand`,
      // The copy in exile is public, so P2 now sees the id of a card in P1's hand.
      `P2's view shows ${card.id}, a card in P1's hand`,
    ]);
  });

  it('finds an attachment to nothing', () => {
    const ctx = game();
    const permanent = spawn(ctx, 'P1', bear());
    permanent.attachedTo = 'o-nowhere';
    expect(checkStateInvariants(ctx)).toEqual([
      `Test Bear (${permanent.id}) is attached to o-nowhere, which is not a permanent, a player or a graveyard card`,
    ]);
  });

  it("finds a hidden card's id in a view", () => {
    const ctx = game();
    const source = spawn(ctx, 'P1', bear());
    const hidden = ctx.state.players[0]!.library[0]!;
    // An ability on the stack that names a card in P1's library: every view shows its targets.
    ctx.state.stack.push({
      id: 'o-probe',
      sourceId: source.id,
      controllerId: 'P1',
      kind: 'ability',
      description: 'probe',
      targets: [hidden.id],
      card: null,
      ability: null,
      sourceOracleId: source.oracleId,
      sourceCardId: source.cardId,
      isCommanderCast: false,
    } as unknown as GameContext['state']['stack'][number]);
    expect(checkStateInvariants(ctx)).toEqual([
      `P1's view shows ${hidden.id}, a card in P1's library`,
      `P2's view shows ${hidden.id}, a card in P1's library`,
    ]);
  });

  it('finds a life total, energy or counter that is not a safe integer or is negative', () => {
    const ctx = game();
    const p1 = ctx.state.players[0]!;
    p1.life = Number.NaN;
    p1.energy = -1;
    p1.counters['poison'] = 1.5;
    const permanent = spawn(ctx, 'P2', bear());
    permanent.counters['+1/+1'] = -2;
    expect(checkStateInvariants(ctx)).toEqual([
      "P1's life is NaN, not a safe integer",
      "P1's energy is -1, below zero",
      "P1's poison counters is 1.5, not a safe integer",
      `Test Bear (${permanent.id})'s +1/+1 counters is -2, below zero`,
    ]);
  });

  it('throws at the checkpoint only for a game run with strictInvariants', () => {
    const restore = installStateInvariants();
    try {
      for (const strict of [false, true]) {
        const ctx = game();
        if (strict) ctx.strictInvariants = true;
        ctx.state.players[0]!.life = Number.NaN;
        const run = () => pumpStrict(priorityCheckpoint(ctx));
        if (strict) {
          expect(run).toThrow(EngineInvariantError);
          expect(run).toThrow(/at state: P1's life is NaN/);
        } else expect(run).not.toThrow();
      }
    } finally {
      restore();
    }
  });
});

describe('sampled layer-cache verification', () => {
  it('recomputes one hit in sixty-four under strictInvariants and fails on a stale entry', () => {
    for (const strict of [false, true]) {
      const ctx = game();
      if (strict) ctx.strictInvariants = true;
      spawn(ctx, 'P1', bear());
      computeAllCharacteristics(ctx);
      // Corrupt the cached pass without changing its digest: a stale hit.
      const cached = getCached(ctx)!;
      setCached(ctx, { ...cached, map: new Map() });
      const hits = () => {
        for (let hit = 0; hit < 64; hit++) computeAllCharacteristics(ctx);
      };
      if (strict) expect(hits).toThrow(/stale layer cache/);
      else expect(hits).not.toThrow();
    }
  });
});

describe('checking changes nothing', () => {
  function play(strict: boolean): { log: string; rng: number[] } {
    const seats = [0, 1, 2, 3].map((i) => ({
      commander: commanderFor(i % 2 === 0 ? 'G' : 'R', `Test General ${i + 1}`),
      cards: [
        ...copies(10, forest),
        ...copies(4, mountain),
        ...copies(6, bear),
        ...copies(2, giantGrowth),
        ...copies(2, bolt),
      ],
    }));
    const engine = new Engine(
      gameConfig(seats, {
        gameId: 'invariants-on-off',
        seed: 'seed-A',
        turnCap: 30,
        ...(strict && { strictInvariants: true }),
      }),
    );
    const providers = new Map<string, RandomDecisionProvider>();
    runToCompletion(engine, (playerId) => {
      let provider = providers.get(playerId);
      if (provider === undefined) {
        provider = new RandomDecisionProvider(`prov-A-${playerId}`);
        providers.set(playerId, provider);
      }
      return provider;
    });
    const rng = (engine as unknown as { ctx: GameContext }).ctx.rng.clone();
    return {
      log: JSON.stringify(engine.getState().eventLog),
      rng: [rng.nextUint32(), rng.nextUint32(), rng.nextUint32()],
    };
  }

  it('plays the same game, event for event and to the same RNG state, with the checker on', () => {
    const restore = installStateInvariants();
    let checked = 0;
    const counting = installCheckpointHook(null);
    installCheckpointHook((ctx) => {
      checked++;
      counting?.(ctx);
    });
    try {
      const on = play(true);
      expect(checked).toBeGreaterThan(100);
      const off = play(false);
      expect(on.log).toBe(off.log);
      expect(on.rng).toEqual(off.rng);
      expect(on.log.length).toBeGreaterThan(1000);
    } finally {
      installCheckpointHook(counting);
      restore();
    }
  }, 60_000);
});
