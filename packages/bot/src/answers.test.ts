/**
 * Burn on the stack counts toward lethal at stake (`publicLethal`), so the last counterspell is
 * not held while a spell aimed at the seat would kill it.
 */
import { describe, expect, it } from 'vitest';
import type { DecisionRequest, PlayerView, StackObjectView } from '@mtg/shared';
import { publicLethal, stackDamageToSeat } from './answers';
import type { CardKnowledge, CardTraits } from './card-knowledge';

function view(life: number, stack: StackObjectView[]): PlayerView {
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
    battlefield: [],
    stack,
    recentLog: [],
    opponents: [
      {
        seat: 'P3',
        life: 30,
        handSize: 3,
        librarySize: 50,
        graveyard: [],
        commanders: [],
        poisonCounters: 0,
        commanderDamageDealtToYou: 0,
      },
    ],
  } as unknown as PlayerView;
}

const knowledge: CardKnowledge = (name) => {
  const table: Record<string, Partial<CardTraits>> = {
    'Lightning Bolt': { manaValue: 1, roles: ['burn'], spellDamage: [3] },
    Fireball: { manaValue: 1, roles: ['burn'], spellDamage: [null] },
  };
  const t = table[name];
  return t === undefined ? undefined : ({ manaValue: 0, types: [], roles: [], ...t } as CardTraits);
};

const request = {
  requestId: 'r',
  decisionType: 'priority',
  activePlayer: 'P3',
  decidingPlayer: 'P1',
  phase: 'precombatMain',
  step: null,
  legalActions: [],
} as unknown as DecisionRequest;

const bolt = (controller: string, target: string): StackObjectView => ({
  id: `bolt-${controller}-${target}`,
  controller,
  description: 'Lightning Bolt',
  targets: [target],
});

describe('burn on the stack and lethal at stake', () => {
  it("counts an opponent's burn aimed at this seat", () => {
    expect(stackDamageToSeat(view(3, [bolt('P3', 'P1')]), knowledge)).toBe(3);
    expect(publicLethal(view(3, [bolt('P3', 'P1')]), request, knowledge)).toBe(true);
  });

  it('is not lethal when the burn falls short of the life total', () => {
    expect(publicLethal(view(4, [bolt('P3', 'P1')]), request, knowledge)).toBe(false);
  });

  it("ignores burn aimed elsewhere, the seat's own burn, and damage that is not a constant", () => {
    expect(stackDamageToSeat(view(3, [bolt('P3', 'P2')]), knowledge)).toBe(0);
    expect(stackDamageToSeat(view(3, [bolt('P1', 'P1')]), knowledge)).toBe(0);
    const fireball = { id: 'f', controller: 'P3', description: 'Fireball', targets: ['P1'] };
    expect(stackDamageToSeat(view(3, [fireball]), knowledge)).toBe(0);
  });

  it('adds two burn spells together', () => {
    expect(publicLethal(view(6, [bolt('P3', 'P1'), bolt('P4', 'P1')]), request, knowledge)).toBe(
      true,
    );
  });
});
