/**
 * Damage and life cues (ADR 0032 decision 8, plan P6): built from a batch's events against the
 * server-private boards before and after it, carrying object ids and never card ids.
 */

import { describe, expect, it } from 'vitest';
import type { GameEvent, PlayerId } from '@mtg/shared';
import { buildCues, type CueBoard } from './presentation';

let sequence = 0;
function event(type: string, payload: Record<string, unknown>, step = 'combatDamage'): GameEvent {
  sequence += 1;
  return {
    sequence,
    turn: 4,
    phase: 'combat',
    step: step as GameEvent['step'],
    actorSeat: null,
    type,
    payload,
  };
}

function board(objects: Record<string, string>, life: Record<PlayerId, number>): CueBoard {
  return { objects: new Map(Object.entries(objects)), life: new Map(Object.entries(life)) };
}

const LIFE = { P1: 40, P2: 40 };

describe('buildCues', () => {
  it('resolves permanent sources and targets to object ids and players by id', () => {
    const before = board({ 'c-1': 'o-10', 'c-2': 'o-20' }, LIFE);
    const after = board({ 'c-1': 'o-10' }, { P1: 40, P2: 37 });
    const events = [
      event('damage', { sourceCardId: 'c-1', targetCardId: 'c-2', amount: 2, combat: true }),
      event('damage', {
        sourceCardId: 'c-2',
        target: 'P2',
        controller: 'P1',
        amount: 3,
        combat: true,
      }),
    ];
    const cues = buildCues(events, before, after);
    expect(cues).toEqual([
      {
        kind: 'damage',
        sequence: events[0]!.sequence,
        sourceId: 'o-10',
        // The blocker died: it is gone from the board after, and found on the board before.
        target: { kind: 'object', id: 'o-20' },
        amount: 2,
        combat: true,
        group: 0,
      },
      {
        kind: 'damage',
        sequence: events[1]!.sequence,
        sourceId: 'o-20',
        target: { kind: 'player', id: 'P2' },
        amount: 3,
        combat: true,
        group: 0,
      },
      { kind: 'lifeChange', sequence: events[1]!.sequence, player: 'P2', delta: -3 },
    ]);
    expect(JSON.stringify(cues)).not.toMatch(/c-\d/);
  });

  it("keeps a spell's source from the stack, and leaves out a source on neither board", () => {
    const before = board({ 'c-5': 's-1', 'c-2': 'o-20' }, LIFE);
    const after = board({}, LIFE);
    const [fromStack, fromNowhere] = buildCues(
      [
        event(
          'damage',
          { sourceCardId: 'c-5', targetCardId: 'c-2', amount: 3, combat: false },
          'main',
        ),
        event(
          'damage',
          { sourceCardId: 'c-99', targetCardId: 'c-2', amount: 1, combat: false },
          'main',
        ),
      ],
      before,
      after,
    );
    expect(fromStack).toMatchObject({ sourceId: 's-1', combat: false, group: 0 });
    expect(fromNowhere).toMatchObject({ sourceId: null, target: { id: 'o-20' }, group: 1 });
  });

  it('drops a cue whose target is on neither board', () => {
    expect(
      buildCues(
        [event('damage', { sourceCardId: 'c-1', targetCardId: 'c-404', amount: 1, combat: true })],
        board({ 'c-1': 'o-1' }, LIFE),
        board({ 'c-1': 'o-1' }, LIFE),
      ),
    ).toEqual([]);
  });

  it('groups combat damage by step', () => {
    const b = board({ 'c-1': 'o-1', 'c-2': 'o-2', 'c-3': 'o-3' }, LIFE);
    const cues = buildCues(
      [
        event(
          'damage',
          { sourceCardId: 'c-1', targetCardId: 'c-2', amount: 1, combat: true },
          'firstStrikeDamage',
        ),
        event(
          'damage',
          { sourceCardId: 'c-3', targetCardId: 'c-2', amount: 1, combat: true },
          'firstStrikeDamage',
        ),
        event(
          'damage',
          { sourceCardId: 'c-2', targetCardId: 'c-1', amount: 1, combat: true },
          'combatDamage',
        ),
      ],
      b,
      b,
    );
    expect(cues.map((cue) => (cue.kind === 'damage' ? cue.group : -1))).toEqual([0, 0, 1]);
  });

  it('takes the life delta from the totals, not from the damage', () => {
    // Infect: damage to a player that changes no life total gives no life cue.
    const same = buildCues(
      [event('damage', { sourceCardId: 'c-1', target: 'P2', amount: 3, combat: true })],
      board({ 'c-1': 'o-1' }, LIFE),
      board({ 'c-1': 'o-1' }, LIFE),
    );
    expect(same.filter((cue) => cue.kind === 'lifeChange')).toEqual([]);
    // A gain names its own event; a change with no event of its own takes the batch's last.
    const gain = event('lifeGain', { player: 'P1', amount: 4, life: 44 }, 'main');
    const other = event('tapped', { objectId: 'o-1' }, 'main');
    expect(buildCues([gain, other], board({}, LIFE), board({}, { P1: 44, P2: 39 }))).toEqual([
      { kind: 'lifeChange', sequence: gain.sequence, player: 'P1', delta: 4 },
      { kind: 'lifeChange', sequence: other.sequence, player: 'P2', delta: -1 },
    ]);
  });
});
