/**
 * The spectator projection (brief §10.2) — the inverse of `PlayerView`. The human is watching,
 * so hands are visible; library ORDER still is not, because it is secret to every player
 * including its owner (brief §7.1).
 */

import { describe, expect, it } from 'vitest';
import type { GameEvent } from '@mtg/shared';
import { formatSpectatorLine, formatSpectatorLog } from '../src/view/spectator';
import { copies, forest, forestsPod, makeEngine } from './fixtures';

function event(over: Partial<GameEvent> & { type: string }): GameEvent {
  return {
    sequence: 0,
    turn: 1,
    phase: 'precombatMain',
    step: null,
    actorSeat: 'P1',
    payload: {},
    ...over,
  };
}

describe('buildSpectatorState', () => {
  it('projects every seat, in fixed seating order, with hands visible to the spectator', () => {
    const engine = makeEngine(forestsPod(12));
    engine.advance();

    const state = engine.spectatorState();

    expect(state.seats.map((s) => s.seat)).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(state.seats.every((s) => s.life === 40)).toBe(true);
    // Spectator-only information: the actual cards, not just a count (brief §10.2).
    expect(state.seats[0]?.hand.length).toBeGreaterThan(0);
    expect(state.seats[0]?.hand[0]?.name).toBe('Forest');
  });

  it('never carries library order — only a count', () => {
    const engine = makeEngine(forestsPod(12));
    engine.advance();

    const state = engine.spectatorState();
    const serialized = JSON.stringify(state);

    expect(state.seats[0]?.librarySize).toBeGreaterThan(0);
    // Structurally: no seat has a `library` array at all.
    for (const seat of state.seats) {
      expect(seat).not.toHaveProperty('library');
    }
    expect(serialized).not.toContain('"library"');
  });

  it('is JSON-serializable, so it can be pushed over a socket and stored as a snapshot', () => {
    const engine = makeEngine(forestsPod(12));
    engine.advance();

    const state = engine.spectatorState();
    const roundTripped = JSON.parse(JSON.stringify(state)) as typeof state;

    expect(roundTripped.seats.length).toBe(4);
    expect(roundTripped.gameId).toBe(state.gameId);
    expect(roundTripped.seed).toBe(state.seed);
  });

  it('reports commander tax as {2} per previous cast from the command zone', () => {
    const engine = makeEngine(forestsPod(12));
    engine.advance();

    const state = engine.spectatorState();
    const commander = state.seats[0]?.commanders[0];

    expect(commander?.zone).toBe('command');
    expect(commander?.castCount).toBe(0);
    expect(commander?.taxGeneric).toBe(0);
  });

  it('exposes events incrementally by sequence, so the log can stream', () => {
    const engine = makeEngine([
      { cards: copies(12, forest) },
      { cards: copies(12, forest) },
      { cards: copies(12, forest) },
      { cards: copies(12, forest) },
    ]);
    engine.advance();

    const all = engine.eventsSince(0);
    expect(all.length).toBeGreaterThan(0);

    const cursor = all[Math.floor(all.length / 2)]?.sequence ?? 0;
    const tail = engine.eventsSince(cursor);

    expect(tail.length).toBeLessThan(all.length);
    expect(tail.every((e) => e.sequence >= cursor)).toBe(true);
  });
});

describe('formatSpectatorLine', () => {
  it('drops priority passes, which are the majority of decisions and say nothing', () => {
    const line = formatSpectatorLine(
      event({ type: 'decision', payload: { description: 'Pass priority' } }),
    );
    expect(line).toBeNull();
  });

  it('renders a chosen action using the description the engine already wrote for a human', () => {
    const line = formatSpectatorLine(
      event({
        type: 'decision',
        payload: { description: 'Cast Giant Growth targeting Llanowar Elves' },
      }),
    );
    expect(line?.text).toBe('Cast Giant Growth targeting Llanowar Elves');
    expect(line?.actorSeat).toBe('P1');
  });

  it('never leaks AI reasoning into the spectator log (brief §7.3, §15)', () => {
    const line = formatSpectatorLine(
      event({
        type: 'decision',
        payload: {
          description: 'Cast Swords to Plowshares',
          note: 'Removing their commander before it connects again.',
        },
      }),
    );
    expect(line?.text).toBe('Cast Swords to Plowshares');
    expect(JSON.stringify(line)).not.toContain('Removing their commander');
  });

  it('marks eliminations and halts so they cannot be missed (brief §13)', () => {
    const elimination = formatSpectatorLine(
      event({ type: 'playerEliminated', actorSeat: 'P3', payload: { reason: 'commanderDamage' } }),
    );
    expect(elimination?.emphasis).toBe('elimination');
    expect(elimination?.text).toContain('commanderDamage');

    const halt = formatSpectatorLine(
      event({ type: 'engineHalt', payload: { reason: 'cannot model Ancestral Vision' } }),
    );
    expect(halt?.emphasis).toBe('warning');
  });

  it('flags commander damage distinctly, since only it counts toward 21 (brief §5.7)', () => {
    const line = formatSpectatorLine(
      event({
        type: 'damage',
        payload: { source: 'Krenko, Mob Boss', target: 'P2', amount: 6, commanderDamage: true },
      }),
    );
    expect(line?.text).toBe('Krenko, Mob Boss deals 6 to P2 (commander damage)');
  });

  it('drops events with no spectator meaning rather than rendering them generically', () => {
    expect(formatSpectatorLine(event({ type: 'phaseBegin' }))).toBeNull();
    expect(formatSpectatorLine(event({ type: 'stepBegin' }))).toBeNull();
    expect(formatSpectatorLine(event({ type: 'attackersDeclared', payload: { count: 0 } }))).toBeNull();
  });

  it('formats a run of events, preserving sequence for timeline seeking', () => {
    const lines = formatSpectatorLog([
      event({ sequence: 1, type: 'turnBegin', payload: { turn: 1 } }),
      event({ sequence: 2, type: 'phaseBegin' }),
      event({ sequence: 3, type: 'playLand', payload: { name: 'Forest' } }),
    ]);

    expect(lines.map((l) => l.sequence)).toEqual([1, 3]);
    expect(lines[1]?.text).toBe('plays Forest');
  });
});
