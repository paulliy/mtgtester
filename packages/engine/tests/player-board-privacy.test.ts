// ADR 0031 decision 12: hidden-information fixes for every player game. Another seat's
// commander in a hidden zone, its yield flag, face-down objects and private log lines never
// reach a player's projection; the spectator projection is unchanged.
import { describe, expect, it } from 'vitest';
import type { GameEvent } from '@mtg/shared';
import { Engine, buildPlayerBoardState } from '../src';
import { moveObject } from '../src/state/objects';
import { createGame } from '../src/state/game';
import {
  PLAYER_BOARD_DISCLOSURE,
  PLAYER_HALT_TEXT,
  buildSpectatorState,
  formatPlayerLog,
} from '../src/view/spectator';
import { buildPlayerView } from '../src/view/view';
import { commanderFor, copies, forest, gameConfig, pump, spawn } from './fixtures';

function pod() {
  return gameConfig(
    [1, 2, 3, 4].map((seat) => ({
      commander: commanderFor('G', `General ${seat}`),
      cards: copies(12, forest),
    })),
    { seed: 'player-board-privacy' },
  );
}

function seatOf(state: ReturnType<typeof buildPlayerBoardState>, seat: string) {
  const found = state.seats.find((candidate) => candidate.seat === seat);
  if (found === undefined) throw new Error(`no seat ${seat}`);
  return found;
}

const event = (overrides: Partial<GameEvent>): GameEvent => ({
  sequence: 1,
  turn: 1,
  phase: 'precombatMain',
  step: null,
  actorSeat: 'P2',
  type: 'decision',
  payload: {},
  ...overrides,
});

describe('player projection privacy (ADR 0031 decision 12)', () => {
  it("hides another seat's commander in its hand, and shows it to its owner", () => {
    const ctx = createGame(pod());
    const p2 = ctx.state.players.find((player) => player.id === 'P2')!;
    const commander = p2.commandZone.splice(0, 1)[0]!;
    commander.zone = 'hand';
    p2.hand.push(commander);

    const opponent = seatOf(buildPlayerBoardState(ctx, 'P1'), 'P2').commanders[0];
    expect(opponent).toMatchObject({ zone: 'hidden', objectId: null, scryfallId: null });
    expect(opponent?.name).toBe('General 2');
    const owner = seatOf(buildPlayerBoardState(ctx, 'P2'), 'P2').commanders[0];
    expect(owner).toMatchObject({ zone: 'hand', objectId: commander.id });
    // The spectator projection is unchanged.
    const spectator = buildSpectatorState(ctx).seats.find((seat) => seat.seat === 'P2');
    expect(spectator?.commanders[0]?.zone).toBe('hand');
  });

  it('keeps a commander in the command zone public', () => {
    const ctx = createGame(pod());
    const commander = seatOf(buildPlayerBoardState(ctx, 'P1'), 'P2').commanders[0];
    expect(commander?.zone).toBe('command');
    expect(commander?.objectId).not.toBeNull();
  });

  it("shows a seat's yield flag to that seat only", () => {
    const ctx = createGame(pod());
    ctx.state.players.find((player) => player.id === 'P2')!.yieldUntilEndOfTurn = true;

    expect(seatOf(buildPlayerBoardState(ctx, 'P1'), 'P2').yieldingUntilEndOfTurn).toBe(false);
    expect(seatOf(buildPlayerBoardState(ctx, 'P2'), 'P2').yieldingUntilEndOfTurn).toBe(true);
  });

  it('flags a card moved to exile face down and hides it from everyone else', () => {
    const ctx = createGame(pod());
    const p2 = ctx.state.players.find((player) => player.id === 'P2')!;
    const card = p2.library[0]!;
    const exiled = pump(moveObject(ctx, card, { zone: 'exile', faceDown: true })).value;

    expect(exiled).not.toBeNull();
    const projected = buildPlayerBoardState(ctx, 'P1').exile.find((c) => c.id === exiled!.id);
    expect(projected).toEqual({
      id: exiled!.id,
      owner: 'P2',
      name: 'Face-down card',
      typeLine: '',
      manaCost: null,
      oracleText: '',
      scryfallId: null,
    });
    expect(buildPlayerBoardState(ctx, 'P2').exile.find((c) => c.id === exiled!.id)?.name).toBe(
      card.name,
    );
  });

  it('redacts a face-down permanent field by field', () => {
    const ctx = createGame(pod());
    const permanent = spawn(ctx, 'P2', forest());
    permanent.faceDown = true;
    permanent.counters['+1/+1'] = 1;

    const projected = buildPlayerBoardState(ctx, 'P1').battlefield.find(
      (p) => p.id === permanent.id,
    );
    expect(projected).toMatchObject({
      name: 'Face-down permanent',
      typeLine: 'Creature',
      oracleText: '',
      scryfallId: null,
      counters: { '+1/+1': 1 },
    });
    expect(projected).not.toHaveProperty('imageFace');
  });

  it('classifies every key a real projection carries', () => {
    const ctx = createGame(pod());
    spawn(ctx, 'P2', forest()).faceDown = true;
    const state = buildSpectatorState(ctx);
    const unclassified = (keys: string[], table: object) =>
      keys.filter((key) => !Object.hasOwn(table, key));

    for (const permanent of state.battlefield)
      expect(
        unclassified(Object.keys(permanent), PLAYER_BOARD_DISCLOSURE.faceDownPermanent),
      ).toEqual([]);
    for (const seat of state.seats) {
      for (const card of seat.hand)
        expect(unclassified(Object.keys(card), PLAYER_BOARD_DISCLOSURE.faceDownCard)).toEqual([]);
      for (const commander of seat.commanders)
        expect(
          unclassified(Object.keys(commander), PLAYER_BOARD_DISCLOSURE.hiddenCommander),
        ).toEqual([]);
    }
  });
});

describe('player log privacy (ADR 0031 decision 12)', () => {
  it("withholds another seat's private lines and unknown decision types", () => {
    const lines = formatPlayerLog(
      [
        event({ sequence: 1, payload: { decisionType: 'mulligan', description: 'Keep' } }),
        event({ sequence: 2, payload: { decisionType: 'brandNew', description: 'Secret' } }),
        event({ sequence: 3, payload: { decisionType: 'priority', description: 'Cast it' } }),
      ],
      'P1',
    );
    expect(lines.map((line) => line.sequence)).toEqual([3]);
  });

  it('shows players a fixed halt text instead of the engine reason', () => {
    const [line] = formatPlayerLog(
      [event({ type: 'engineHalt', actorSeat: null, payload: { reason: 'resolve.ts:1234' } })],
      'P1',
    );
    expect(line?.text).toContain(PLAYER_HALT_TEXT);
    expect(line?.text).not.toContain('resolve.ts');
  });
});

describe('a cancelled yield is a logged input (ADR 0031 decision 8)', () => {
  it('emits yieldCancelled only when it changes state, and keeps it out of the AI view', () => {
    const engine = new Engine(pod());
    engine.advance();
    // The engine context is private; a yield is otherwise set only by a submitted pass.
    const ctx = (engine as unknown as { ctx: Parameters<typeof buildPlayerView>[0] }).ctx;
    expect(engine.cancelYield('P1')).toBe(false);
    expect(engine.eventsSince(0).some((e) => e.type === 'yieldCancelled')).toBe(false);

    ctx.state.players.find((player) => player.id === 'P1')!.yieldUntilEndOfTurn = true;
    expect(engine.cancelYield('P1')).toBe(true);

    const cancelled = engine.eventsSince(0).filter((e) => e.type === 'yieldCancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ actorSeat: 'P1', payload: { player: 'P1' } });
    expect(JSON.stringify(buildPlayerView(ctx, 'P2'))).not.toContain('yieldCancelled');
  });
});
