import { describe, expect, it } from 'vitest';
import type { PermanentView, PlayerView, StackObjectView } from '@mtg/shared';
import type { CardKnowledge, CardTraits } from './card-knowledge';
import {
  bestCastingOrder,
  combatBody,
  damageThrough,
  incomingDamage,
  manaUnitsOf,
  parseCost,
  pay,
  pendingOwnDamage,
  producedThisTurn,
  readyAttackers,
  untappedCreatures,
  type CastCandidate,
  type CombatBody,
} from './tactics';

function view(overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    seat: 'P1',
    life: 40,
    hand: [],
    deck: [],
    graveyard: [],
    exile: [],
    availableMana: {},
    manaSources: [],
    commanders: [],
    battlefield: [],
    stack: [],
    recentLog: [],
    opponents: [],
    ...overrides,
  } as PlayerView;
}

function creature(
  id: string,
  controller: string,
  power: number,
  toughness: number,
  extra: Partial<PermanentView> = {},
): PermanentView {
  return {
    id,
    controller,
    name: `Creature ${id}`,
    typeLine: 'Creature — Bear',
    power,
    toughness,
    keywords: [],
    tapped: false,
    status: [],
    ...extra,
  };
}

function knowledge(table: Record<string, Partial<CardTraits>>): CardKnowledge {
  return (name) => {
    const t = table[name];
    return t === undefined ? undefined : { manaValue: 0, types: [], roles: [], ...t };
  };
}

function stackItem(
  id: string,
  controller: string,
  description: string,
  targets: string[],
): StackObjectView {
  return { id, controller, description, targets };
}

const body = (
  id: string,
  power: number,
  toughness: number,
  extra: Partial<CombatBody> = {},
): CombatBody => ({
  id,
  power,
  toughness,
  flying: false,
  reach: false,
  trample: false,
  menace: false,
  ...extra,
});

describe('pendingOwnDamage', () => {
  const k = knowledge({ Bolt: { spellDamage: [3] }, Fork: { spellDamage: [2, 2] } });

  it("counts only this seat's stack objects", () => {
    const v = view({
      stack: [
        stackItem('s1', 'P1', 'Bolt', ['c1']),
        stackItem('s2', 'P2', 'Bolt', ['c1']),
        stackItem('s3', 'P1', 'Bolt', ['c1']),
      ],
    });
    expect(pendingOwnDamage(v, k).get('c1')).toBe(6);
  });

  it('counts nothing when the slots and targets disagree in length', () => {
    const v = view({ stack: [stackItem('s1', 'P1', 'Fork', ['c1'])] });
    expect(pendingOwnDamage(v, k).size).toBe(0);
  });

  it('assigns each slot to its target and skips null amounts', () => {
    const v = view({ stack: [stackItem('s1', 'P1', 'Fork', ['c1', 'P2'])] });
    const pending = pendingOwnDamage(v, k);
    expect(pending.get('c1')).toBe(2);
    expect(pending.get('P2')).toBe(2);
    const partial = knowledge({ Fork: { spellDamage: [2, null] } });
    expect(pendingOwnDamage(v, partial).has('P2')).toBe(false);
  });

  it('is empty without knowledge or for unknown spells', () => {
    const v = view({ stack: [stackItem('s1', 'P1', 'Bolt', ['c1'])] });
    expect(pendingOwnDamage(v, undefined).size).toBe(0);
    expect(pendingOwnDamage(v, knowledge({})).size).toBe(0);
  });
});

describe('incomingDamage', () => {
  it('counts unblocked attackers at full power', () => {
    const v = view({
      battlefield: [creature('a', 'P2', 4, 4, { attacking: 'P1' })],
    });
    expect(incomingDamage(v).get('a')).toBe(4);
  });

  it('counts a blocked non-trampler as 0', () => {
    const v = view({
      battlefield: [
        creature('a', 'P2', 4, 4, { attacking: 'P1', blockedBy: ['b'] }),
        creature('b', 'P1', 1, 1),
      ],
    });
    expect(incomingDamage(v).has('a')).toBe(false);
  });

  it('counts a blocked trampler as power minus blocker toughness', () => {
    const v = view({
      battlefield: [
        creature('a', 'P2', 5, 5, {
          attacking: 'P1',
          blockedBy: ['b', 'c'],
          keywords: ['Trample'],
        }),
        creature('b', 'P1', 1, 2),
        creature('c', 'P1', 1, 1),
      ],
    });
    expect(incomingDamage(v).get('a')).toBe(2);
  });

  it('ignores attackers at other seats or at planeswalkers', () => {
    const v = view({
      battlefield: [
        creature('a', 'P2', 4, 4, { attacking: 'P3' }),
        creature('b', 'P2', 4, 4, { attacking: 'P1', attackingPlaneswalker: 'pw' }),
        creature('c', 'P2', 4, 4),
      ],
    });
    expect(incomingDamage(v).size).toBe(0);
    expect(incomingDamage(v, 'P3').get('a')).toBe(4);
  });
});

describe('combatBody', () => {
  it('reads stats, keywords case-insensitively, boosts and extra keywords', () => {
    const p = creature('a', 'P1', 2, 3, { keywords: ['Flying'] });
    expect(combatBody(p)).toMatchObject({ power: 2, toughness: 3, flying: true, trample: false });
    expect(combatBody(p, { power: 3, toughness: 3 }, ['Trample'])).toMatchObject({
      power: 5,
      toughness: 6,
      trample: true,
    });
    expect(combatBody(p, { power: -9, toughness: -9 })).toMatchObject({ power: 0, toughness: 0 });
  });
});

describe('damageThrough', () => {
  it('is full power with no blockers', () => {
    expect(damageThrough([body('a', 3, 3), body('b', 2, 2)], [])).toBe(5);
  });

  it('lets a flier past non-flying blockers but not past reach or flying', () => {
    const flier = body('a', 3, 3, { flying: true });
    expect(damageThrough([flier], [body('b', 1, 5)])).toBe(3);
    expect(damageThrough([flier], [body('b', 1, 5, { reach: true })])).toBe(0);
    expect(damageThrough([flier], [body('b', 1, 5, { flying: true })])).toBe(0);
  });

  it('blocks the biggest attacker first with the toughest blocker', () => {
    expect(damageThrough([body('a', 5, 5), body('b', 2, 2)], [body('x', 1, 1)])).toBe(2);
  });

  it('sends only excess through when a trampler is blocked', () => {
    expect(damageThrough([body('a', 6, 6, { trample: true })], [body('x', 1, 4)])).toBe(2);
  });

  it('needs two blockers for menace', () => {
    const menace = body('a', 4, 4, { menace: true });
    expect(damageThrough([menace], [body('x', 1, 1)])).toBe(4);
    expect(damageThrough([menace], [body('x', 1, 1), body('y', 1, 1)])).toBe(0);
  });
});

describe('untappedCreatures and readyAttackers', () => {
  const bf = [
    creature('ok', 'P1', 2, 2),
    creature('tapped', 'P1', 2, 2, { tapped: true }),
    creature('sick', 'P1', 2, 2, { status: ['summoningSick'] }),
    creature('hasty', 'P1', 2, 2, { status: ['summoningSick'], keywords: ['Haste'] }),
    creature('wall', 'P1', 0, 4, { keywords: ['Defender'] }),
    creature('theirs', 'P2', 2, 2),
    { id: 'land', controller: 'P1', name: 'Forest', typeLine: 'Land', tapped: false, status: [] },
  ] as PermanentView[];

  it('lists untapped creatures of a seat, including sick ones and defenders', () => {
    const ids = untappedCreatures(view({ battlefield: bf }), 'P1').map((p) => p.id);
    expect(ids).toEqual(['ok', 'sick', 'hasty', 'wall']);
  });

  it('excludes tapped, summoning-sick (unless haste) and defender creatures', () => {
    const ids = readyAttackers(view({ battlefield: bf })).map((p) => p.id);
    expect(ids).toEqual(['ok', 'hasty']);
  });

  it('honours an exclude set', () => {
    expect(readyAttackers(view({ battlefield: bf }), new Set(['ok'])).map((p) => p.id)).toEqual([
      'hasty',
    ]);
  });
});

describe('parseCost', () => {
  it('parses generic and coloured pips', () => {
    expect(parseCost('{2}{G}{G}')).toEqual({ generic: 2, pips: ['G', 'G'] });
  });
  it('treats X as 0', () => {
    expect(parseCost('{X}{R}')).toEqual({ generic: 0, pips: ['R'] });
  });
  it('takes the first half of a hybrid pip', () => {
    expect(parseCost('{W/U}')).toEqual({ generic: 0, pips: ['W'] });
  });
  it('treats phyrexian as its colour', () => {
    expect(parseCost('{G/P}')).toEqual({ generic: 0, pips: ['G'] });
  });
  it('treats {2/W} as 2 generic', () => {
    expect(parseCost('{2/W}')).toEqual({ generic: 2, pips: [] });
  });
  it('keeps colourless pips', () => {
    expect(parseCost('{C}{1}')).toEqual({ generic: 1, pips: ['C'] });
  });
  it('returns null for undefined or unknown symbols', () => {
    expect(parseCost(undefined)).toBeNull();
    expect(parseCost('{Q}')).toBeNull();
  });
});

describe('manaUnitsOf', () => {
  it('expands single-symbol sources by count and keeps multi-symbol sources once', () => {
    const v = view({
      manaSources: [
        { name: 'Forest', symbols: ['G'], count: 2 },
        { name: 'Command Tower', symbols: ['W', 'U'], count: 1 },
      ],
    });
    expect(manaUnitsOf(v)).toEqual([['G'], ['G'], ['W', 'U']]);
  });
});

describe('pay', () => {
  it('pays coloured then generic and returns the rest', () => {
    expect(pay([['G'], ['G'], ['G']], { generic: 1, pips: ['G'] })).toEqual([['G']]);
  });
  it('fails when a colour is missing or mana is short', () => {
    expect(pay([['R'], ['R']], { generic: 0, pips: ['G'] })).toBeNull();
    expect(pay([['G']], { generic: 2, pips: [] })).toBeNull();
  });
  it('spends colourless for generic first', () => {
    expect(pay([['G'], ['C']], { generic: 1, pips: [] })).toEqual([['G']]);
  });
  it('keeps a dual source for later by paying pips from the narrowest source', () => {
    expect(pay([['G', 'U'], ['G']], { generic: 0, pips: ['G'] })).toEqual([['G', 'U']]);
  });
});

describe('bestCastingOrder', () => {
  const pool = [['G'], ['G'], ['G'], ['G']];
  const cand = (
    actionId: number,
    name: string,
    cost: string,
    manaValue: number,
    produces: string[][] = [],
  ): CastCandidate => ({ actionId, name, cost: parseCost(cost)!, manaValue, produces });

  it('finds the ramp order: Sol Ring leads to 6, Harmonize or Cultivate first do not', () => {
    const { best, firstActions } = bestCastingOrder(pool, [
      cand(1, 'Sol Ring', '{1}', 1, [['C'], ['C']]),
      cand(2, 'Harmonize', '{2}{G}{G}', 4),
      cand(3, 'Llanowar Elves', '{G}', 1),
      cand(4, 'Cultivate', '{2}{G}', 3),
    ]);
    expect(best).toBe(6);
    // Elves first also reaches 6 (Elves, Sol Ring, Harmonize); casting Harmonize or Cultivate
    // first strands mana and tops out at 4.
    expect([...firstActions].sort()).toEqual([1, 3]);
  });

  it('is zero when nothing can be cast', () => {
    const { best, firstActions } = bestCastingOrder([['G']], [cand(1, 'Big', '{5}', 5)]);
    expect(best).toBe(0);
    expect(firstActions.size).toBe(0);
  });

  it('only considers the first four candidates', () => {
    const many = [1, 2, 3, 4, 5].map((i) => cand(i, `c${i}`, '{G}', 1));
    expect(bestCastingOrder([['G'], ['G'], ['G'], ['G'], ['G']], many).best).toBe(4);
  });
});

describe('producedThisTurn', () => {
  const k = knowledge({
    'Sol Ring': { types: ['Artifact'], manaUnits: [['C'], ['C']] },
    'Llanowar Elves': { types: ['Creature'], manaUnits: [['G']] },
    'Command Tower': { types: ['Land'], manaUnits: [['W', 'U']] },
  });
  it('returns units for a noncreature, nonland source only', () => {
    expect(producedThisTurn({ name: 'Sol Ring' }, k)).toEqual([['C'], ['C']]);
    expect(producedThisTurn({ name: 'Llanowar Elves' }, k)).toEqual([]);
    expect(producedThisTurn({ name: 'Command Tower' }, k)).toEqual([]);
    expect(producedThisTurn({ name: 'Unknown' }, k)).toEqual([]);
  });
});
