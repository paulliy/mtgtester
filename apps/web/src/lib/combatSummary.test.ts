import { describe, expect, it } from 'vitest';
import { summarizeCombat, type CombatPermanent } from './combatSummary';

const seats = [
  { seat: 'P1', label: 'The Ur-Dragon' },
  { seat: 'P2', label: 'Queen Marchesa' },
  { seat: 'P4', label: 'Marchesa, the Black Rose' },
];

function creature(
  id: string,
  name: string,
  controller: string,
  extra: Partial<CombatPermanent> = {},
): CombatPermanent {
  return {
    id,
    name,
    controller,
    power: 5,
    toughness: 7,
    attacking: null,
    blocking: null,
    blockedBy: [],
    ...extra,
  };
}

describe('summarizeCombat', () => {
  it('says nothing outside combat', () => {
    expect(
      summarizeCombat({
        phase: 'precombatMain',
        step: null,
        priorityPlayer: 'P1',
        permanents: [],
        seats,
        plan: null,
      }),
    ).toBeNull();
  });

  it('describes an attack waiting for blocks and marks the attacked seat', () => {
    const summary = summarizeCombat({
      phase: 'combat',
      step: 'declareBlockers',
      priorityPlayer: null,
      permanents: [creature('a', 'Broodcaller Scourge', 'P1', { attacking: 'P2' })],
      seats,
      plan: null,
    });
    expect(summary?.label).toBe('Combat · blockers');
    expect(summary?.lines).toEqual([
      'Broodcaller Scourge 5/7 → P2 Queen Marchesa · waiting for blocks',
    ]);
    expect(summary?.attacked.get('P2')).toBe('Under attack · 5 incoming');
  });

  it('reads declared blocks and unblocked damage', () => {
    const summary = summarizeCombat({
      phase: 'combat',
      step: 'declareBlockers',
      priorityPlayer: 'P1',
      permanents: [
        creature('k', 'Klauth, Unrivaled Ancient', 'P1', {
          power: 4,
          toughness: 4,
          attacking: 'P4',
          blockedBy: ['m'],
        }),
        creature('u', 'The Ur-Dragon', 'P1', { power: 10, toughness: 10, attacking: 'P2' }),
        creature('m', 'Midnight Reaper', 'P4', { power: 4, toughness: 3, blocking: 'k' }),
      ],
      seats,
      plan: null,
    });
    expect(summary?.label).toBe('Combat · blocks declared');
    expect(summary?.lines).toEqual([
      'Klauth, Unrivaled Ancient 4/4 → P4 Marchesa, the Black Rose · blocked by Midnight Reaper 4/3',
      'The Ur-Dragon 10/10 → P2 Queen Marchesa · unblocked, 10 damage',
    ]);
    expect(summary?.attacked.get('P4')).toBe('Under attack · blocked');
    expect(summary?.attacked.get('P2')).toBe('Under attack · 10 incoming');
    expect(summary?.prose).toEqual([
      'Klauth, Unrivaled Ancient is blocked by Midnight Reaper.',
      'The Ur-Dragon is unblocked and deals 10 to Queen Marchesa.',
    ]);
  });

  it('keeps an attack on a planeswalker off its controller’s chip', () => {
    const blocks = (step: 'declareBlockers', priorityPlayer: string | null) =>
      summarizeCombat({
        phase: 'combat',
        step,
        priorityPlayer,
        permanents: [
          creature('d', 'Shivan Dragon', 'P1', {
            power: 6,
            toughness: 6,
            attacking: 'P2',
            attackingPlaneswalker: 'w',
          }),
          creature('o', 'Grizzly Bears', 'P1', { power: 2, toughness: 2, attacking: 'P2' }),
          creature('w', 'Teferi, Hero of Dominaria', 'P2', { power: null, toughness: null }),
        ],
        seats,
        plan: null,
      });

    // Waiting for blocks: only the Bears threaten P2's life.
    expect(blocks('declareBlockers', null)?.attacked.get('P2')).toBe('Under attack · 2 incoming');

    // Both unblocked: the Dragon's 6 goes to Teferi, not to P2.
    const declared = blocks('declareBlockers', 'P1');
    expect(declared?.attacked.get('P2')).toBe('Under attack · 2 incoming');
    expect(declared?.prose).toContain(
      'Shivan Dragon is unblocked and deals 6 to Teferi, Hero of Dominaria.',
    );
  });

  it('gives no chip to a player whose planeswalker alone is attacked', () => {
    const summary = summarizeCombat({
      phase: 'combat',
      step: 'declareBlockers',
      priorityPlayer: 'P1',
      permanents: [
        creature('d', 'Shivan Dragon', 'P1', {
          power: 6,
          toughness: 6,
          attacking: 'P2',
          attackingPlaneswalker: 'w',
        }),
        creature('w', 'Teferi, Hero of Dominaria', 'P2', { power: null, toughness: null }),
      ],
      seats,
      plan: null,
    });
    expect(summary?.lines).toEqual([
      'Shivan Dragon 6/6 → Teferi, Hero of Dominaria · unblocked, 6 damage',
    ]);
    expect(summary?.attacked.has('P2')).toBe(false);
  });

  it('does not repeat a seat id that doubles as its label', () => {
    const summary = summarizeCombat({
      phase: 'combat',
      step: 'declareAttackers',
      priorityPlayer: 'P1',
      permanents: [creature('s', 'Lab Servo', 'P2', { power: 1, toughness: 1, attacking: 'P3' })],
      seats: [{ seat: 'P3', label: 'P3' }],
      plan: null,
    });
    expect(summary?.lines).toEqual(['Lab Servo 1/1 → P3 · waiting for blocks']);
    expect(summary?.prose).toEqual([]);
  });

  it('lists the attackers you have chosen but not confirmed', () => {
    const summary = summarizeCombat({
      phase: 'combat',
      step: 'declareAttackers',
      priorityPlayer: null,
      permanents: [
        creature('a', 'Dragon token', 'P1'),
        creature('b', 'Dragon token', 'P1'),
        creature('c', 'Old Gnawbone', 'P1'),
      ],
      seats,
      plan: {
        kind: 'attackers',
        assignment: new Map([
          ['a', 'P4'],
          ['b', 'P4'],
          ['c', 'P4'],
        ]),
        subjects: 3,
      },
    });
    expect(summary?.label).toBe('Combat · choose attackers');
    expect(summary?.lines[0]).toBe(
      '3 selected: Dragon token ×2, Old Gnawbone. Click a creature to add or remove it.',
    );
  });

  it('shows your planned blocks before you confirm them', () => {
    const summary = summarizeCombat({
      phase: 'combat',
      step: 'declareBlockers',
      priorityPlayer: null,
      permanents: [
        creature('g', 'Ghalta, Primal Hunger', 'P2', { power: 12, toughness: 12, attacking: 'P1' }),
        creature('w', 'Wall of Omens', 'P1', { power: 0, toughness: 4 }),
      ],
      seats,
      plan: { kind: 'blockers', assignment: new Map([['w', 'g']]), subjects: 1 },
    });
    expect(summary?.label).toBe('Combat · declare blockers');
    expect(summary?.lines).toEqual([
      'Ghalta, Primal Hunger 12/12 → P1 The Ur-Dragon · blocked by Wall of Omens, not confirmed',
    ]);
    expect(summary?.attacked.get('P1')).toBe('Under attack · 12 incoming');
  });

  it('does not claim an exact number while a blocked trampler can push damage through', () => {
    const summary = summarizeCombat({
      phase: 'combat',
      step: 'declareBlockers',
      priorityPlayer: 'P1',
      permanents: [
        creature('g', 'Ghalta, Primal Hunger', 'P1', {
          power: 12,
          toughness: 12,
          attacking: 'P2',
          blockedBy: ['w'],
          keywords: ['trample'],
        }),
        creature('b', 'Grizzly Bears', 'P1', { power: 2, toughness: 2, attacking: 'P2' }),
        creature('w', 'Wall of Omens', 'P2', { power: 0, toughness: 4, blocking: 'g' }),
        creature('t', 'Craterhoof Behemoth', 'P1', {
          power: 5,
          toughness: 5,
          attacking: 'P4',
          blockedBy: ['r'],
          keywords: ['haste', 'trample'],
        }),
        creature('r', 'Midnight Reaper', 'P4', { power: 3, toughness: 2, blocking: 't' }),
      ],
      seats,
      plan: null,
    });
    expect(summary?.attacked.get('P2')).toBe('Under attack · 2 incoming + trample');
    expect(summary?.attacked.get('P4')).toBe('Under attack · 0 incoming + trample');
  });

  it('stops calling damage incoming once it has been dealt', () => {
    const at = (step: 'firstStrikeCombatDamage' | 'combatDamage' | 'endCombat') =>
      summarizeCombat({
        phase: 'combat',
        step,
        priorityPlayer: 'P1',
        permanents: [
          creature('a', 'Grizzly Bears', 'P1', { power: 5, toughness: 5, attacking: 'P2' }),
          creature('f', 'White Knight', 'P1', {
            power: 2,
            toughness: 2,
            attacking: 'P4',
            keywords: ['first strike'],
          }),
          creature('d', 'Boros Swiftblade', 'P1', {
            power: 1,
            toughness: 2,
            attacking: 'P4',
            keywords: ['double strike'],
          }),
        ],
        seats,
        plan: null,
      });
    // After first-strike damage: the first striker is done, the double striker deals again.
    expect(at('firstStrikeCombatDamage')?.attacked.get('P2')).toBe('Under attack · 5 incoming');
    expect(at('firstStrikeCombatDamage')?.attacked.get('P4')).toBe('Under attack · 1 incoming');
    expect(at('combatDamage')?.attacked.get('P2')).toBe('Attacked · damage dealt');
    expect(at('endCombat')?.attacked.get('P2')).toBe('Attacked · damage dealt');
    expect(at('endCombat')?.attacked.get('P4')).toBe('Attacked · damage dealt');
  });

  it("still predicts damage while a trampler's damage is being assigned", () => {
    const summary = summarizeCombat({
      phase: 'combat',
      step: 'combatDamage',
      priorityPlayer: null,
      permanents: [
        creature('a', 'Grizzly Bears', 'P1', { power: 5, toughness: 5, attacking: 'P2' }),
      ],
      seats,
      plan: null,
    });
    expect(summary?.attacked.get('P2')).toBe('Under attack · 5 incoming');
  });

  it('counts double strike twice until its first hit lands', () => {
    const at = (
      step: 'declareBlockers' | 'firstStrikeCombatDamage',
      priorityPlayer: string | null,
    ) =>
      summarizeCombat({
        phase: 'combat',
        step,
        priorityPlayer,
        permanents: [
          creature('d', 'Boros Swiftblade', 'P1', {
            power: 5,
            toughness: 5,
            attacking: 'P2',
            keywords: ['double strike'],
          }),
        ],
        seats,
        plan: null,
      });
    expect(at('declareBlockers', null)?.attacked.get('P2')).toBe('Under attack · 10 incoming');
    const declared = at('declareBlockers', 'P1');
    expect(declared?.attacked.get('P2')).toBe('Under attack · 10 incoming');
    expect(declared?.prose).toEqual([
      'Boros Swiftblade is unblocked and deals 10 to Queen Marchesa.',
    ]);
    expect(at('firstStrikeCombatDamage', 'P1')?.attacked.get('P2')).toBe(
      'Under attack · 5 incoming',
    );
  });
});
