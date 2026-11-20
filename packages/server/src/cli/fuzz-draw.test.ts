import { describe, expect, it } from 'vitest';
import { verifyDraw, type DrawState } from './fuzz-draw';
import { failureOf } from './fuzz-plan';

const player = (id: string, over: Partial<DrawState['players'][number]> = {}) => ({
  id,
  life: 40,
  poisonCounters: 0,
  commanderDamageTaken: {},
  hasLost: true,
  lossReason: 'lifeZeroOrLess',
  ...over,
});

/** Fuzz-26's end: P1 and P2 out earlier, then an Earthquake takes P3 and P4 together. */
function earthquake(over: Partial<DrawState> = {}): DrawState {
  return {
    players: [
      player('P1', { life: -3 }),
      player('P2', { life: -1 }),
      player('P3', { life: -62 }),
      player('P4', { life: -44 }),
    ],
    eliminatedPlayers: ['P1', 'P2', 'P3', 'P4'],
    eventLog: [
      { type: 'playerEliminated', payload: { player: 'P1' } },
      { type: 'stepBegin' },
      { type: 'playerEliminated', payload: { player: 'P2' } },
      { type: 'castSpell' },
      { type: 'damage' },
      { type: 'resolved' },
      { type: 'playerEliminated', payload: { player: 'P3' } },
      { type: 'zoneChange' },
      { type: 'playerEliminated', payload: { player: 'P4' } },
      { type: 'gameOver' },
    ],
    ...over,
  };
}

describe('fuzz draws', () => {
  it('fuzz-draw-earthquake — the last two players losing to one check is a draw (fuzz-26)', () => {
    expect(verifyDraw(earthquake())).toEqual({
      players: [
        { player: 'P3', reason: 'lifeZeroOrLess' },
        { player: 'P4', reason: 'lifeZeroOrLess' },
      ],
    });
  });

  it('fuzz-draw-reasons — poison, commander damage and an empty-library draw count; others do not', () => {
    const with4 = (over: Partial<DrawState['players'][number]>) =>
      earthquake({
        players: [
          player('P1', { life: -3 }),
          player('P2', { life: -1 }),
          player('P3', { life: -62 }),
          player('P4', over),
        ],
      });
    expect(verifyDraw(with4({ lossReason: 'poisonCounters', poisonCounters: 10 }))).toHaveProperty(
      'players',
    );
    expect(
      verifyDraw(with4({ lossReason: 'commanderDamage', commanderDamageTaken: { 'c-1': 21 } })),
    ).toHaveProperty('players');
    expect(verifyDraw(with4({ lossReason: 'emptyLibraryDraw' }))).toHaveProperty('players');
    // A recorded reason the state does not show, or one it cannot check, is not a draw.
    expect(verifyDraw(with4({ lossReason: 'lifeZeroOrLess', life: 5 }))).toEqual({
      unverified: "P4's loss (lifeZeroOrLess) does not show in the final state",
    });
    expect(verifyDraw(with4({ lossReason: 'other' }))).toHaveProperty('unverified');
    expect(verifyDraw(with4({ lossReason: 'poisonCounters', poisonCounters: 9 }))).toHaveProperty(
      'unverified',
    );
  });

  it('fuzz-draw-separate — losses in separate checks, or a player left over, are not a draw', () => {
    // P4 went out after something else happened: the last check took one player only.
    const log = earthquake().eventLog;
    expect(
      verifyDraw(
        earthquake({ eventLog: [...log.slice(0, 7), { type: 'resolved' }, ...log.slice(7)] }),
      ),
    ).toEqual({ unverified: 'the final check eliminated fewer than two players' });
    expect(
      verifyDraw(
        earthquake({
          players: [...earthquake().players.slice(0, 3), player('P4', { hasLost: false })],
        }),
      ),
    ).toHaveProperty('unverified');
  });

  it('fuzz-draw-failure — a confirmed draw passes, an unconfirmed one still fails', () => {
    const played = (
      halt: NonNullable<Parameters<typeof failureOf>[0] & { kind: 'played' }>['reply']['halt'],
    ) => ({
      kind: 'played' as const,
      reply: {
        winner: null,
        turns: 34,
        decisions: 200,
        halt,
        error: null,
        budgetExhausted: false,
        emptyVetoes: 0,
        ops: [],
        exits: [],
        ms: 1,
      },
    });
    const reason = 'all remaining players lost simultaneously (draw)';
    const draw = [
      { player: 'P3' as const, reason: 'lifeZeroOrLess' },
      { player: 'P4' as const, reason: 'lifeZeroOrLess' },
    ];
    expect(failureOf(played({ reason, turnCap: false, draw }), ['heuristic'], 1000)).toBeNull();
    expect(
      failureOf(
        played({ reason: `${reason}, unverified: x`, turnCap: false }),
        ['heuristic'],
        1000,
      ),
    ).toMatch(/^halted: .*unverified/);
  });
});
