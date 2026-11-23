/**
 * Seeking to an action must show the board that action produced.
 *
 * The Phase 4 implementation snapshotted inside `emit`, which runs when an event is
 * *announced* — `applyPriorityAction` emits `playLand` before moving the card, and
 * `Engine.submit` emits `decision` before the generator applies anything at all. Every seek was
 * therefore one action stale: clicking "P2 plays Mountain" showed the board without the
 * Mountain. These tests pin the corrected semantics.
 */

import { describe, expect, it } from 'vitest';
import { Engine, formatSpectatorLog, RandomDecisionProvider } from '../src';
import type { GameEvent, OracleCard, SpectatorState } from '@mtg/shared';

function forest(n: number): OracleCard {
  return {
    oracleId: `forest-${n}`,
    scryfallId: `scry-forest-${n}`,
    name: 'Forest',
    manaCost: null,
    cmc: 0,
    colors: [],
    colorIdentity: ['G'],
    typeLine: 'Basic Land — Forest',
    supertypes: ['Basic'],
    types: ['Land'],
    subtypes: ['Forest'],
    oracleText: '',
    power: null,
    toughness: null,
    loyalty: null,
    defense: null,
    keywords: [],
    layout: 'normal',
    commanderLegality: 'legal',
    isBasicLand: true,
  };
}

function general(seat: string): OracleCard {
  return {
    ...forest(0),
    oracleId: `general-${seat}`,
    scryfallId: `scry-general-${seat}`,
    name: `Test General ${seat}`,
    manaCost: '{G}',
    cmc: 1,
    colors: ['G'],
    typeLine: 'Legendary Creature — Elf',
    supertypes: ['Legendary'],
    types: ['Creature'],
    subtypes: ['Elf'],
    power: '2',
    toughness: '2',
    isBasicLand: false,
  };
}

/** Play a whole game, collecting every per-action snapshot the way the server does. */
function playGame(
  seed = 'seek-test',
  options: ConstructorParameters<typeof Engine>[1] = {},
): {
  events: GameEvent[];
  snapshots: Map<number, SpectatorState>;
  engine: Engine;
} {
  const engine = new Engine(
    {
      gameId: 'g-seek',
      seed,
      turnCap: 25,
      players: [1, 2, 3, 4].map((n) => ({
        id: `P${n}`,
        deckId: `deck-${n}`,
        commanders: [general(`P${n}`)],
        cards: Array.from({ length: 20 }, (_, i) => forest(i)),
      })),
    },
    options,
  );
  const providers = new Map(
    [1, 2, 3, 4].map((n) => [`P${n}`, new RandomDecisionProvider(`${seed}-P${n}`)]),
  );

  const snapshots = new Map<number, SpectatorState>();
  const drain = (): void => {
    for (const [sequence, state] of engine.drainSpectatorSnapshots()) {
      snapshots.set(sequence, state);
    }
  };

  for (;;) {
    const step = engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    const provider = providers.get(step.request.decidingPlayer);
    if (provider === undefined) throw new Error('missing provider');
    engine.submit(provider.decide(step.request));
    drain();
  }
  drain();

  return { events: engine.getState().eventLog as GameEvent[], snapshots, engine };
}

describe('per-action spectator snapshots (brief §10.1 — "step forward action by action")', () => {
  const { events, snapshots } = playGame();

  it('records the board *after* the action, not before it', () => {
    const lands = events.filter((e) => e.type === 'playLand');
    expect(lands.length).toBeGreaterThan(3);

    for (const event of lands) {
      const snapshot = snapshots.get(event.sequence);
      expect(snapshot, `no snapshot for playLand at sequence ${event.sequence}`).toBeDefined();

      const name = event.payload['name'] as string;
      const controller = event.actorSeat;
      const onBattlefield = snapshot!.battlefield.filter(
        (p) => p.name === name && p.controller === controller,
      );
      // The land that was just played is on its controller's battlefield in its own snapshot.
      expect(
        onBattlefield.length,
        `${controller} played ${name} at sequence ${event.sequence} but it is not on the board`,
      ).toBeGreaterThan(0);
    }
  });

  it('gives every rendered log line a board to seek to', () => {
    // Every event that produces a spectator line must be seekable; events that do not are
    // deliberately skipped, which is what keeps the retained state bounded.
    const loggable = new Set([...snapshots.keys()].map((sequence) => sequence));
    expect(loggable.size).toBeGreaterThan(20);
    expect(loggable.size).toBeLessThan(events.length);
  });

  it('does not retain a board per raw event', () => {
    // The original built one on every `emit` — ~11 MB of live objects for a 30-turn game.
    expect(snapshots.size).toBeLessThan(events.length / 2);
  });

  it('drains: the engine does not accumulate snapshots the server already took', () => {
    const { engine } = playGame('drain-test');
    expect(engine.drainSpectatorSnapshots().size).toBe(0);
  });

  it('records none when the host turns them off, and the game plays the same', () => {
    // A table game never seeks, so it turns the per-line boards off (`spectatorSnapshots`).
    const off = playGame('seek-test', { spectatorSnapshots: false });
    expect(off.snapshots.size).toBe(0);
    expect(JSON.stringify(off.events)).toBe(JSON.stringify(events));
  });

  it('logs a land play once, on the line whose board has the land', () => {
    const lines = formatSpectatorLog(events);
    // "Play Forest" (the decision) and "plays Forest" (the event) were both rendered, so the
    // log said everything twice and half the lines showed a board without the land.
    expect(lines.some((l) => /^plays Forest$/.test(l.text))).toBe(true);
    expect(lines.some((l) => /^Play Forest$/.test(l.text))).toBe(false);
  });
});
