import { describe, expect, it } from 'vitest';
import type { Deal, LegalAction, PlayerBoardState } from '@mtg/shared';
import { NO_ATTACK_TARGET } from '@mtg/shared';
import { dealWarnings } from './dealWarnings';

const board = {
  seats: ['P1', 'P2', 'P3', 'P4'].map((seat) => ({ seat, graveyard: [] })),
  battlefield: [
    { id: 'p2-bear', controller: 'P2' },
    { id: 'p3-walker', controller: 'P3' },
  ],
  stack: [{ id: 'p2-spell', controller: 'P2' }],
} as unknown as PlayerBoardState;

function deal(obligations: Deal['obligations']): Deal {
  return {
    id: 'deal-1',
    proposer: 'P1',
    parties: ['P1', 'P2'],
    obligations,
    proposedTurn: 1,
    rounds: 1,
    status: 'active',
  };
}

const attack: LegalAction = {
  id: 7,
  type: 'attackDeclaration',
  description: 'Declare attackers',
  targets: [
    { slot: 0, options: [NO_ATTACK_TARGET, 'P2', 'P3', 'p3-walker'] },
    { slot: 1, options: [NO_ATTACK_TARGET, 'P2', 'P3', 'p3-walker'] },
  ],
  // A 1-power and a 9-power attacker.
  data: { subjects: [{ power: 1 }, { power: 9 }] },
} as unknown as LegalAction;
const removal = {
  id: 3,
  type: 'castSpell',
  description: 'Cast Murder',
  targets: [{ slot: 0, options: ['p2-bear', 'p3-walker', 'p2-spell'] }],
} as unknown as LegalAction;

describe('dealWarnings (ADR 0035)', () => {
  const truce = deal([
    { kind: 'noAttack', by: 'P1', against: 'P2' },
    { kind: 'noAttack', by: 'P2', against: 'P1' },
  ]);

  it('warns when an attack goes at a seat the player promised to spare', () => {
    const warnings = dealWarnings('P1', [truce], attack, [{ slot: 0, choice: 'P2' }], board);
    expect(warnings).toEqual([
      'Deal deal-1 with P2: you promised not to attack P2. This may break it.',
    ]);
  });

  it('stays quiet for a complying attack, a skipped slot, and the other side of the deal', () => {
    expect(
      dealWarnings(
        'P1',
        [truce],
        attack,
        [
          { slot: 0, choice: 'P3' },
          { slot: 1, choice: NO_ATTACK_TARGET },
        ],
        board,
      ),
    ).toEqual([]);
    expect(dealWarnings('P2', [truce], removal, [{ slot: 0, choice: 'p3-walker' }], board)).toEqual(
      [],
    );
  });

  it('reads targets by their public owner, and counters only on the stack', () => {
    const noTarget = deal([{ kind: 'noTarget', by: 'P1', against: 'P2' }]);
    expect(
      dealWarnings('P1', [noTarget], removal, [{ slot: 0, choice: 'p2-bear' }], board),
    ).toHaveLength(1);
    const noCounter = deal([{ kind: 'noCounter', by: 'P1', against: 'P2' }]);
    expect(
      dealWarnings('P1', [noCounter], removal, [{ slot: 0, choice: 'p2-bear' }], board),
    ).toEqual([]);
    expect(
      dealWarnings('P1', [noCounter], removal, [{ slot: 0, choice: 'p2-spell' }], board),
    ).toHaveLength(1);
    // Attack promises say nothing about spells.
    expect(dealWarnings('P1', [truce], removal, [{ slot: 0, choice: 'p2-bear' }], board)).toEqual(
      [],
    );
  });

  it('reminds the player of a promised attack the declaration leaves out', () => {
    const promised = deal([{ kind: 'attackPlayer', by: 'P1', target: 'P3' }]);
    expect(dealWarnings('P1', [promised], attack, [{ slot: 0, choice: 'P2' }], board)).toEqual([
      'Deal deal-1 with P2: you promised to attack P3, and this attack sends nothing at P3.',
    ]);
    expect(
      dealWarnings('P1', [promised], attack, [{ slot: 1, choice: 'p3-walker' }], board),
    ).toEqual([]);
  });

  it('does not remind of a promised attack the declaration could not make', () => {
    const promised = deal([{ kind: 'attackPlayer', by: 'P1', target: 'P4' }]);
    expect(dealWarnings('P1', [promised], attack, [{ slot: 0, choice: 'P2' }], board)).toEqual([]);
  });

  it('warns when a promised attack sends only a token at the target', () => {
    const promised = deal([{ kind: 'attackPlayer', by: 'P1', target: 'P3' }]);
    const token = [
      { slot: 0, choice: 'P3' },
      { slot: 1, choice: 'P2' },
    ];
    // Half of 10 power is 5; the 1-power attacker falls short.
    expect(dealWarnings('P1', [promised], attack, token, board)).toEqual([
      'Deal deal-1 with P2: you promised to attack P3, and this attack sends 1 of the 5 power it needs at P3.',
    ]);
    const earnest = [
      { slot: 0, choice: 'P2' },
      { slot: 1, choice: 'P3' },
    ];
    expect(dealWarnings('P1', [promised], attack, earnest, board)).toEqual([]);
    // A lower share from the table lowers the bar.
    expect(dealWarnings('P1', [promised], attack, token, board, 0.1)).toEqual([]);
  });

  it('never warns about blocks', () => {
    const block = { ...attack, type: 'blockDeclaration' } as LegalAction;
    expect(dealWarnings('P1', [truce], block, [{ slot: 0, choice: 'P2' }], board)).toEqual([]);
  });
});
