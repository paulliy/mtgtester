import { describe, expect, it } from 'vitest';
import type { DecisionRequest, LegalAction, PlayerView } from '@mtg/shared';
import type { CardKnowledge, CardTraits } from './card-knowledge';
import { decide } from './evaluate';
import { Rng } from './rng';
import { resolveSteering, roleScale, styleProfile } from './styles';

describe('play styles', () => {
  it('fills only the knobs the strategist left unset', () => {
    expect(resolveSteering({ style: 'control' })).toEqual({
      style: 'control',
      aggression: 0.3,
      holdUpMana: 2,
      avoidOverextending: true,
    });
    expect(resolveSteering({ style: 'control', aggression: 0.9 })?.aggression).toBe(0.9);
    expect(resolveSteering({ aggression: 0.4 })).toEqual({ aggression: 0.4 });
    expect(resolveSteering(undefined)).toBeUndefined();
  });

  it('midrange and no style are the plain weights', () => {
    for (const profile of [styleProfile('midrange'), styleProfile(undefined)]) {
      expect(profile).toMatchObject({ faceDamage: 1, counterThreshold: 1, removalThreshold: 1 });
    }
    expect(roleScale(undefined, 'draw')).toBe(1);
    expect(roleScale('control', 'draw')).toBe(1.5);
  });

  it('places each in-between preset between its neighbours on every scale', () => {
    const between = (a: number, x: number, b: number) => Math.min(a, b) <= x && x <= Math.max(a, b);
    for (const [low, mid, high] of [
      ['aggro', 'tempo', 'midrange'],
      ['midrange', 'value', 'control'],
      ['midrange', 'ramp', 'combo'],
    ] as const) {
      const [a, x, b] = [styleProfile(low), styleProfile(mid), styleProfile(high)];
      for (const key of ['faceDamage', 'counterThreshold', 'removalThreshold'] as const) {
        expect({ preset: mid, key, ok: between(a[key], x[key], b[key]) }).toEqual({
          preset: mid,
          key,
          ok: true,
        });
      }
    }
  });

  describe('what a last counterspell is kept for', () => {
    const table: Record<string, Partial<CardTraits>> = {
      Counterspell: { manaValue: 2, roles: ['counter'], spellTargets: ['hostile'] },
      'Three Drop': { manaValue: 3, types: ['Creature'] },
      'Four Drop': { manaValue: 4, types: ['Creature'] },
    };
    const knowledge: CardKnowledge = (name) => {
      const t = table[name];
      return t === undefined ? undefined : { manaValue: 0, types: [], roles: [], ...t };
    };
    const counter: LegalAction = {
      id: 1,
      type: 'castSpell',
      description: 'Cast Counterspell',
      interaction: { kind: 'source', sourceId: 'c1' },
      targets: [{ slot: 0, options: ['s1'] }],
      data: { sourceName: 'Counterspell', manaCost: '{U}{U}', instantSpeed: true },
    };
    const request: DecisionRequest = {
      requestId: 'r',
      gameId: 'g',
      turn: 5,
      activePlayer: 'P2',
      decidingPlayer: 'P1',
      phase: 'precombatMain',
      step: null,
      decisionType: 'priority',
      prompt: '',
      legalActions: [{ id: 0, type: 'pass', description: 'Pass priority' }, counter],
    };
    const facing = (spell: string): PlayerView =>
      ({
        seat: 'P1',
        life: 40,
        hand: [{ id: 'c1', name: 'Counterspell', typeLine: 'Instant' }],
        battlefield: [],
        stack: [{ id: 's1', controller: 'P2', description: spell, targets: [] }],
        graveyard: [],
        exile: [],
        manaSources: [],
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
      }) as unknown as PlayerView;
    const answer = (spell: string, style?: 'control' | 'aggro') =>
      decide(request, facing(spell), new Rng('a'), {
        knowledge,
        ...(style !== undefined && { steering: { style } }),
      }).actionId;

    it('midrange keeps it from a three-drop and spends it on a four-drop', () => {
      expect(answer('Three Drop')).toBe(0);
      expect(answer('Four Drop')).toBe(1);
    });

    it('control spends it on the three-drop; aggro keeps it from the four-drop', () => {
      expect(answer('Three Drop', 'control')).toBe(1);
      expect(answer('Four Drop', 'aggro')).toBe(0);
    });
  });
});
