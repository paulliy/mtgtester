import { describe, expect, it } from 'vitest';
import type { PermanentView, PlayerView } from '@mtg/shared';
import { ProxyStrategist, proxyKnobs } from './proxy-strategist';

const creature = (id: string, controller: string, power: number): PermanentView => ({
  id,
  controller,
  name: id,
  typeLine: 'Creature',
  power,
  toughness: power,
  tapped: false,
  status: [],
});

function view(battlefield: PermanentView[], life = 40): PlayerView {
  const opponent = (seat: string, l = 40) => ({
    seat,
    life: l,
    handSize: 5,
    librarySize: 80,
    graveyard: [],
    commanders: [],
    poisonCounters: 0,
    commanderDamageDealtToYou: 0,
  });
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
    opponents: [opponent('P2'), opponent('P3'), opponent('P4', 0)],
  } as unknown as PlayerView;
}

describe('proxyKnobs', () => {
  it('targets the biggest live board, attacks when ahead and holds back when low', () => {
    const board = [creature('a', 'P1', 9), creature('b', 'P3', 6), creature('c', 'P2', 1)];
    expect(proxyKnobs(view(board))).toEqual({
      aggression: 0.8,
      targetOrder: ['P3', 'P2'],
      avoidOverextending: false,
    });
    expect(proxyKnobs(view(board, 10)).aggression).toBe(0.3);
  });
});

describe('ProxyStrategist', () => {
  const quiet = view([]);
  const big = view([creature('x', 'P2', 12)]);

  it('asks once per own turn, reuses on a quiet table up to the limit, and wakes on a change', () => {
    const proxy = new ProxyStrategist({ replan: 'onChange', rule: 'table-v2', maxReuseTurns: 2 });
    proxy.knobsFor(1, true, quiet);
    proxy.knobsFor(1, true, quiet);
    proxy.knobsFor(2, false, big); // not its turn: never asks
    for (const turn of [5, 9]) proxy.knobsFor(turn, true, quiet);
    expect(proxy).toMatchObject({ calls: 1, reused: 2 });
    proxy.knobsFor(13, true, quiet); // reuse limit
    proxy.knobsFor(17, true, big); // P2's power moved
    expect(proxy).toMatchObject({ calls: 3, reused: 2 });
  });

  it('asks every own turn under everyTurn', () => {
    const proxy = new ProxyStrategist({ replan: 'everyTurn', rule: 'table-v1', maxReuseTurns: 3 });
    for (const turn of [1, 5, 9]) proxy.knobsFor(turn, true, quiet);
    expect(proxy).toMatchObject({ calls: 3, reused: 0 });
  });
});
