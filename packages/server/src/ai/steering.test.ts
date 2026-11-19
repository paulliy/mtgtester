import { describe, expect, it } from 'vitest';
import type { PermanentView, PlayerView } from '@mtg/shared';
import {
  cleanSteering,
  tableChangeReasons,
  tableChanged,
  tableSnapshot,
  type SeatSnapshot,
  type TableSnapshot,
} from './steering';

describe('cleanSteering', () => {
  it('clamps numbers, drops unknown seats and keeps names', () => {
    const steering = cleanSteering(
      {
        aggression: 3,
        targetOrder: ['P3', 'P9', 'P3', 'P2'],
        prioritize: ['Sol Ring', 7, ''],
        hold: ['Blasphemous Act'],
        holdUpMana: -4,
        avoidOverextending: true,
        bogus: 1,
      },
      ['P2', 'P3', 'P4'],
    );
    expect(steering).toEqual({
      aggression: 1,
      targetOrder: ['P3', 'P2'],
      prioritize: ['Sol Ring'],
      hold: ['Blasphemous Act'],
      holdUpMana: 0,
      avoidOverextending: true,
    });
  });

  it('returns null for an answer with nothing usable', () => {
    expect(cleanSteering(undefined, ['P2'])).toBeNull();
    expect(cleanSteering({ targetOrder: ['P9'] }, ['P2'])).toBeNull();
    expect(cleanSteering([], ['P2'])).toBeNull();
  });
});

function view(battlefield: PermanentView[], life = 40): PlayerView {
  return {
    seat: 'P1',
    life,
    hand: [],
    deck: [],
    graveyard: [],
    exile: [],
    availableMana: {},
    manaSources: [],
    commanders: [],
    battlefield,
    stack: [],
    recentLog: [],
    opponents: [
      {
        seat: 'P2',
        life: 40,
        handSize: 5,
        librarySize: 80,
        graveyard: [],
        commanders: [],
        poisonCounters: 0,
        commanderDamageDealtToYou: 0,
      },
    ],
  } as PlayerView;
}

const bear = (id: string, power = 2): PermanentView => ({
  id,
  controller: 'P2',
  name: 'Bear',
  typeLine: 'Creature — Bear',
  power,
  toughness: 2,
  tapped: false,
  status: [],
});

describe('tableChanged', () => {
  it('ignores a small change and notices a big one', () => {
    const base = tableSnapshot(view([bear('a')]));
    expect(tableChanged(base, tableSnapshot(view([bear('a'), bear('b')])))).toBe(false);
    expect(tableChanged(base, tableSnapshot(view([bear('a')], 35)))).toBe(false);
    expect(tableChanged(base, tableSnapshot(view([bear('a', 12)])))).toBe(true);
    expect(tableChanged(base, tableSnapshot(view([bear('a')], 25)))).toBe(true);
    expect(tableChanged(base, tableSnapshot(view([bear('a')], 0)))).toBe(true);
  });
});

describe('tableChangeReasons (ADR 0045)', () => {
  it('names what moved, and nothing when the table is quiet', () => {
    const base = tableSnapshot(view([bear('a')]));
    expect(tableChangeReasons(base, base)).toEqual([]);
    const after = { ...base, P1: { ...base['P1']!, life: base['P1']!.life - 15 } };
    expect(tableChangeReasons(base, after)).toEqual(['P1 life']);
    expect(tableChanged(base, after)).toBe(true);
  });
});

describe('tableChangeReasons, table-v2 (hill-climb S7)', () => {
  const seat = (over: Partial<SeatSnapshot> = {}): SeatSnapshot => ({
    life: 40,
    power: 4,
    nonland: 3,
    commanderOut: false,
    ...over,
  });
  const before: TableSnapshot = { P1: seat(), P2: seat() };
  const v2 = { self: 'P1', rule: 'table-v2' as const };
  const v1 = { self: 'P1', rule: 'table-v1' as const };

  it('ignores the seat’s own board growing and its own commander arriving', () => {
    const grown = { ...before, P1: seat({ power: 16, nonland: 9, commanderOut: true }) };
    expect(tableChangeReasons(before, grown, v2)).toEqual([]);
    expect(tableChangeReasons(before, grown, v1)).toEqual([
      'P1 power',
      'P1 permanents',
      'P1 commander',
    ]);
  });

  it('still wakes on the seat’s own losses', () => {
    const wiped = { ...before, P1: seat({ power: 0, nonland: 0, life: 25 }) };
    expect(tableChangeReasons({ ...before, P1: seat({ power: 12 }) }, wiped, v2)).toEqual([
      'P1 life',
      'P1 power',
    ]);
    const lostCommander = { ...before, P1: seat() };
    expect(
      tableChangeReasons({ ...before, P1: seat({ commanderOut: true }) }, lostCommander, v2),
    ).toEqual(['P1 commander']);
  });

  it('ignores an opponent’s commander arriving but not it leaving, nor its board growing', () => {
    const arrived = { ...before, P2: seat({ commanderOut: true }) };
    expect(tableChangeReasons(before, arrived, v2)).toEqual([]);
    expect(tableChangeReasons(before, arrived, v1)).toEqual(['P2 commander']);
    expect(tableChangeReasons(arrived, before, v2)).toEqual(['P2 commander']);
    const grown = { ...before, P2: seat({ power: 12 }) };
    expect(tableChangeReasons(before, grown, v2)).toEqual(['P2 power']);
  });

  it('wakes on an elimination under either rule', () => {
    const dead = { ...before, P2: seat({ life: 0 }) };
    expect(tableChangeReasons(before, dead, v2)).toEqual(['P2 eliminated']);
  });

  it('reads as table-v1 without a rule, as before the rule existed', () => {
    const grown = { ...before, P1: seat({ commanderOut: true }) };
    expect(tableChangeReasons(before, grown)).toEqual(['P1 commander']);
    expect(tableChanged(before, grown, v2)).toBe(false);
  });
});
