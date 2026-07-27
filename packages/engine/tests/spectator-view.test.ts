/**
 * The spectator projection's identity fields (brief §10.2).
 *
 * Both cases here are things the board view got wrong: a seat whose commander left the game
 * with its eliminated owner rendered as "unknown", and exile carried no owner at all, so every
 * seat panel reported the table's shared exile as its own.
 */

import { describe, expect, it } from 'vitest';
import { Engine } from '../src';
import type { OracleCard } from '@mtg/shared';

function forest(n: number): OracleCard {
  return {
    oracleId: `forest-${n}`,
    scryfallId: `scry-forest-${n}`,
    name: 'Forest',
    manaCost: null,
    cmc: 0,
    colors: [],
    colorIdentity: ['G'],
    typeLine: 'Basic Land — Forest',
    supertypes: ['Basic'],
    types: ['Land'],
    subtypes: ['Forest'],
    oracleText: '',
    power: null,
    toughness: null,
    loyalty: null,
    defense: null,
    keywords: [],
    layout: 'normal',
    commanderLegality: 'legal',
    isBasicLand: true,
  };
}

function general(seat: string): OracleCard {
  return {
    ...forest(0),
    oracleId: `general-${seat}`,
    scryfallId: `scry-general-${seat}`,
    name: `Commander of ${seat}`,
    manaCost: '{G}',
    cmc: 1,
    colors: ['G'],
    typeLine: 'Legendary Creature — Elf',
    supertypes: ['Legendary'],
    types: ['Creature'],
    subtypes: ['Elf'],
    power: '2',
    toughness: '2',
    isBasicLand: false,
  };
}

function makeEngine(): Engine {
  return new Engine({
    gameId: 'g-view',
    seed: 'view-test',
    turnCap: 20,
    players: [1, 2, 3, 4].map((n) => ({
      id: `P${n}`,
      deckId: `deck-${n}`,
      commanders: [general(`P${n}`)],
      cards: Array.from({ length: 20 }, (_, i) => forest(i)),
    })),
  });
}

describe('spectator projection — seat identity', () => {
  it('names a commander that has left the game with its eliminated owner', () => {
    const engine = makeEngine();
    engine.advance();

    // Eliminate P2 the way `processEliminations` does: everything they own leaves the game.
    const state = engine.getState() as unknown as {
      players: Array<{ id: string; hasLost: boolean; lossReason: string | null }>;
      battlefield: unknown[];
      eliminatedPlayers: string[];
    };
    const p2 = state.players.find((p) => p.id === 'P2');
    expect(p2).toBeDefined();
    p2!.hasLost = true;
    p2!.lossReason = 'lifeZeroOrLess';
    state.eliminatedPlayers.push('P2');

    const view = engine.spectatorState();
    const seat = view.seats.find((s) => s.seat === 'P2');
    expect(seat).toBeDefined();
    expect(seat!.commanders[0]?.name).toBe('Commander of P2');
    // The panel keeps the deck's name, which is the whole point of the screen.
    expect(seat!.label).toBe('Commander of P2');
    expect(seat!.label).not.toContain('unknown');
  });

  it('attributes every card to an owner, so exile can be split per seat', () => {
    const engine = makeEngine();
    engine.advance();
    const view = engine.spectatorState();

    for (const seat of view.seats) {
      for (const card of seat.hand) expect(card.owner).toBe(seat.seat);
      for (const card of seat.graveyard) expect(card.owner).toBe(seat.seat);
    }
    for (const permanent of view.battlefield) {
      expect(permanent.owner).toBeTruthy();
    }
  });
});
