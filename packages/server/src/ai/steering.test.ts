import { describe, expect, it } from 'vitest';
import type { PermanentView, PlayerView } from '@mtg/shared';
import { cleanSteering, tableChangeReasons, tableChanged, tableSnapshot } from './steering';

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
