import { describe, expect, it } from 'vitest';
import type { LegalAction } from '@mtg/shared';
import type { CardKnowledge, CardTraits } from './card-knowledge';
import { passesVeto, totalDiscardCount, totalLifeCost, totalSacrificeCount } from './veto';

function payLifeAction(amount: number): LegalAction {
  return {
    id: 0,
    type: 'activateAbility',
    description: `Pay ${amount} life: draw a card`,
    data: { abilityCosts: [{ kind: 'payLife', amount }] },
  };
}

describe('passesVeto', () => {
  it('rejects a payLife cost equal to current life — the original suicide-loop bug', () => {
    expect(passesVeto(payLifeAction(20), 20)).toBe(false);
  });

  it('rejects a payLife cost exceeding current life', () => {
    expect(passesVeto(payLifeAction(25), 20)).toBe(false);
  });

  it('allows a payLife cost strictly below current life', () => {
    expect(passesVeto(payLifeAction(2), 20)).toBe(true);
  });

  it('allows actions with no ability costs at all', () => {
    const action: LegalAction = { id: 1, type: 'pass', description: 'Pass priority' };
    expect(passesVeto(action, 1)).toBe(true);
  });

  it('is unaffected by non-life costs regardless of life total', () => {
    const action: LegalAction = {
      id: 2,
      type: 'activateAbility',
      description: 'Sacrifice a creature: draw a card',
      data: { abilityCosts: [{ kind: 'sacrificeSelf' }] },
    };
    expect(passesVeto(action, 1)).toBe(true);
  });
});

describe('cost accessors', () => {
  it('sums payLife amounts across multiple costs', () => {
    const action: LegalAction = {
      id: 3,
      type: 'activateAbility',
      description: 'multi-cost',
      data: {
        abilityCosts: [
          { kind: 'payLife', amount: 3 },
          { kind: 'payLife', amount: 2 },
        ],
      },
    };
    expect(totalLifeCost(action)).toBe(5);
  });

  it('counts sacrificeOther by its count field, defaulting to 1', () => {
    const action: LegalAction = {
      id: 4,
      type: 'activateAbility',
      description: 'sac two',
      data: { abilityCosts: [{ kind: 'sacrificeOther', count: 2 }] },
    };
    expect(totalSacrificeCount(action)).toBe(2);
  });

  it('counts discardHand as the full hand size', () => {
    const action: LegalAction = {
      id: 5,
      type: 'activateAbility',
      description: 'discard hand',
      data: { abilityCosts: [{ kind: 'discardHand' }] },
    };
    expect(totalDiscardCount(action, 4)).toBe(4);
  });
});

describe('each-player damage veto', () => {
  const base: CardTraits = { manaValue: 1, types: ['Sorcery'], roles: [] };
  const knowledge: CardKnowledge = (name) =>
    name === 'Earthquake'
      ? { ...base, damagesEachPlayer: 'X' }
      : name === 'Flame Rift'
        ? { ...base, damagesEachPlayer: 3 }
        : undefined;
  const cast = (name: string, x?: number): LegalAction => ({
    id: 0,
    type: 'castSpell',
    description: `Cast ${name} ({X}{R})${x === undefined ? '' : ` with X=${x}`}`,
    data: { sourceName: name, instantSpeed: false },
  });

  it('never casts Earthquake for at least its controller life, but X below that is fine', () => {
    expect(passesVeto(cast('Earthquake', 20), 20, knowledge)).toBe(false);
    expect(passesVeto(cast('Earthquake', 167), 20, knowledge)).toBe(false);
    expect(passesVeto(cast('Earthquake', 19), 20, knowledge)).toBe(true);
  });

  it('reads X from data.x when the action carries it', () => {
    const action = { ...cast('Earthquake'), data: { sourceName: 'Earthquake', x: 20 } };
    expect(passesVeto(action, 20, knowledge)).toBe(false);
  });

  it('vetoes a constant each-player damage of 3 at 2 life, allows it at 4', () => {
    expect(passesVeto(cast('Flame Rift'), 2, knowledge)).toBe(false);
    expect(passesVeto(cast('Flame Rift'), 3, knowledge)).toBe(false);
    expect(passesVeto(cast('Flame Rift'), 4, knowledge)).toBe(true);
  });

  it('does nothing without knowledge or for other spells', () => {
    expect(passesVeto(cast('Earthquake', 99), 20)).toBe(true);
    expect(passesVeto(cast('Shock'), 1, knowledge)).toBe(true);
  });
});
