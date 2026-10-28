import { describe, expect, it } from 'vitest';
import {
  attackPreference,
  couldKill,
  damageValue,
  estimateTable,
  inDanger,
  lifeLoss,
  pressureOn,
} from './estimate';
import { creature, opponent, view } from './fixtures.test-helpers';

describe('estimateTable — positions and win shares (ADR 0035 decisions 7-9)', () => {
  it('counts life at or below the danger threshold double', () => {
    expect(lifeLoss(40, 1)).toBe(1);
    expect(lifeLoss(10, 1)).toBe(2);
    expect(lifeLoss(12, 4)).toBe(2 + 2 * 2);
  });

  it('gives the seat with the biggest board and life the largest win share, and names it leader', () => {
    const table = estimateTable(
      view(
        'P1',
        30,
        [opponent('P2', 40), opponent('P3', 25), opponent('P4', 20)],
        [creature('P2', 6), creature('P2', 6), creature('P2', 5), creature('P3', 2)],
      ),
    );
    const shares = table.seats.map((s) => s.winShare);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(table.bySeat.get('P2')!.winShare).toBe(Math.max(...shares));
    expect(table.leader).toBe('P2');
  });

  it('gives a seat the same position from every chair, counting its poison', () => {
    const fromP1 = estimateTable(view('P1', 40, [opponent('P2', 40, { poisonCounters: 9 })]));
    const fromP2 = estimateTable(view('P2', 40, [opponent('P1', 40)], [], { poisonCounters: 9 }));
    expect(fromP1.bySeat.get('P2')!.position).toBe(fromP2.bySeat.get('P2')!.position);
    // Nine poison counters weigh on the seat that has them.
    expect(fromP2.bySeat.get('P2')!.position).toBeLessThan(fromP2.bySeat.get('P1')!.position);
  });

  it('names no leader when the table is even', () => {
    const table = estimateTable(view('P1', 40, [opponent('P2', 40), opponent('P3', 40)]));
    expect(table.leader).toBeNull();
  });

  it('reads the viewer hand only as a count, so every seat builds the same positions', () => {
    const fromP1 = estimateTable(
      view('P1', 30, [opponent('P2', 35, { handSize: 3 })], [creature('P2', 3)]),
    );
    const fromP2 = estimateTable(
      view('P2', 35, [opponent('P1', 30, { handSize: 3 })], [creature('P2', 3)]),
    );
    for (const seat of ['P1', 'P2']) {
      expect(fromP1.bySeat.get(seat)!.position).toBeCloseTo(fromP2.bySeat.get(seat)!.position);
    }
  });

  it('does not count a defender or a zero-power creature as attack pressure', () => {
    const table = estimateTable(
      view(
        'P1',
        40,
        [opponent('P2', 40)],
        [creature('P2', 4, 4, { keywords: ['Defender'] }), creature('P2', 0, 3), creature('P2', 3)],
      ),
    );
    expect(table.bySeat.get('P2')!.attackPower).toBe(3);
  });
});

describe('attack preference and pressure (decision 10)', () => {
  it('prefers attacking the leader over an even seat', () => {
    const table = estimateTable(
      view(
        'P1',
        30,
        [opponent('P2', 40), opponent('P3', 30)],
        [creature('P1', 3), creature('P2', 7), creature('P2', 7), creature('P2', 7)],
      ),
    );
    const prefs = attackPreference(table, 'P1');
    expect(prefs.get('P2')!).toBeGreaterThan(prefs.get('P3')!);
  });

  it('prefers a defender the attack would kill', () => {
    const table = estimateTable(
      view('P1', 30, [opponent('P2', 40), opponent('P3', 4)], [creature('P1', 5)]),
    );
    expect(damageValue(table, 'P3', 5)).toBeGreaterThan(damageValue(table, 'P2', 5));
    expect(attackPreference(table, 'P1').get('P3')!).toBeGreaterThan(0.9);
  });

  it('moves pressure away from an excluded defender', () => {
    const table = estimateTable(
      view('P1', 30, [opponent('P2', 30), opponent('P3', 30)], [creature('P2', 6)]),
    );
    const prefs = attackPreference(table, 'P2', new Set(['P1']));
    expect(prefs.has('P1')).toBe(false);
    expect(prefs.get('P3')).toBeCloseTo(1);
    expect(pressureOn(table, 'P2', 'P1')).toBeGreaterThan(0);
  });
});

describe('danger checks', () => {
  it('counts low life, a lethal board and commander damage as danger', () => {
    expect(inDanger(estimateTable(view('P1', 9, [opponent('P2', 40)])), 'P1')).toBe(true);
    const lethal = estimateTable(view('P1', 12, [opponent('P2', 40)], [creature('P2', 12)]));
    expect(inDanger(lethal, 'P1')).toBe(true);
    expect(couldKill(lethal, 'P2', 'P1')).toBe(true);
    const onBoard = { name: 'Atraxa', zone: 'battlefield', castCount: 1 };
    const commander = estimateTable(
      view(
        'P1',
        40,
        [opponent('P2', 40, { commanderDamageDealtToYou: 16, commanders: [onBoard] })],
        [creature('P2', 5, 5, { name: 'Atraxa' })],
      ),
    );
    expect(inDanger(commander, 'P1')).toBe(true);
    expect(couldKill(commander, 'P2', 'P1')).toBe(true);
    expect(inDanger(estimateTable(view('P1', 40, [opponent('P2', 40)])), 'P1')).toBe(false);
  });

  it('counts only the commander itself toward commander-damage lethal', () => {
    const inCommandZone = { name: 'Atraxa', zone: 'command', castCount: 1 };
    const others = estimateTable(
      view(
        'P1',
        40,
        [opponent('P2', 40, { commanderDamageDealtToYou: 20, commanders: [inCommandZone] })],
        [creature('P2', 1)],
      ),
    );
    expect(couldKill(others, 'P2', 'P1')).toBe(false);
    // A blocked commander deals nothing; the one blocker takes the commander, tied for biggest.
    const onBoard = { ...inCommandZone, zone: 'battlefield' };
    const blocked = estimateTable(
      view(
        'P1',
        40,
        [opponent('P2', 40, { commanderDamageDealtToYou: 16, commanders: [onBoard] })],
        [creature('P2', 5, 5, { name: 'Atraxa' }), creature('P2', 5), creature('P1', 1)],
      ),
    );
    expect(couldKill(blocked, 'P2', 'P1')).toBe(false);
  });
});
