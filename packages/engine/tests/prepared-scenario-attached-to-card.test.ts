import { describe, expect, it } from 'vitest';
import { priorityCheckpoint } from '../src/sba/sba';
import { createGame } from '../src/state/game';
import { prepareScenario, type PreparedScenarioSpec } from '../src/testing/prepared-scenario';
import { copies, forest, gameConfig, oracle, pump } from './fixtures';

const AURA = oracle({
  name: 'Lab Aura',
  typeLine: 'Enchantment — Aura',
  manaCost: '{1}',
  oracleText: 'Enchant creature\nEnchanted creature gets +1/+1.',
});
const OWN_AURA = oracle({
  name: 'Lab Own Aura',
  typeLine: 'Enchantment — Aura',
  manaCost: '{1}',
  oracleText: 'Enchant creature you control\nEnchanted creature gets +1/+1.',
});
const HOST = oracle({ name: 'Lab Host', typeLine: 'Creature — Bear', power: '2', toughness: '2' });
const ROCK = oracle({ name: 'Lab Rock', typeLine: 'Artifact', power: null, toughness: null });

function arrange(
  aura: typeof AURA,
  battlefield: PreparedScenarioSpec['battlefield'],
  extraP2: Array<ReturnType<typeof oracle>> = [HOST],
) {
  const ctx = createGame(
    gameConfig([
      { cards: [aura, ...copies(4, forest)] },
      { cards: [...extraP2, ...copies(5, forest)] },
      ...[1, 2].map(() => ({ cards: copies(5, forest) })),
    ]),
  );
  const spec = {
    currentTurnPlayer: 'P2',
    phase: 'precombatMain',
    step: null,
    turnNumber: 2,
    hand: [],
    battlefield,
  } as PreparedScenarioSpec;
  return { ctx, run: () => prepareScenario(ctx, spec) };
}

describe('prepared scenario attached-to-card', () => {
  it('arranges an Aura as already attached to the named permanent another player controls', () => {
    const { ctx, run } = arrange(AURA, [
      {
        playerId: 'P1',
        cardNames: ['Lab Aura'],
        attachedToCard: { playerId: 'P2', cardName: 'Lab Host' },
      },
      { playerId: 'P2', cardNames: ['Lab Host'] },
    ]);
    run();
    const aura = ctx.state.battlefield.find((perm) => perm.name === 'Lab Aura');
    const host = ctx.state.battlefield.find((perm) => perm.name === 'Lab Host');
    expect(aura?.attachedTo).toBe(host?.id);
    expect(aura?.controllerId).toBe('P1');
    expect(host?.controllerId).toBe('P2');
    // A legal position stays put when state-based actions run.
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield.includes(aura!)).toBe(true);
  });

  it('rejects a permanent the named player does not control', () => {
    expect(() =>
      arrange(AURA, [
        {
          playerId: 'P1',
          cardNames: ['Lab Aura'],
          attachedToCard: { playerId: 'P3', cardName: 'Lab Host' },
        },
        { playerId: 'P2', cardNames: ['Lab Host'] },
      ]).run(),
    ).toThrow(/P3 controls no Lab Host/);
    expect(() =>
      arrange(AURA, [
        {
          playerId: 'P1',
          cardNames: ['Lab Aura'],
          attachedToCard: { playerId: 'P2', cardName: 'Lab Missing' },
        },
      ]).run(),
    ).toThrow(/P2 controls no Lab Missing/);
  });

  it('leaves legality to state-based actions: an illegal host makes the Aura fall off', () => {
    const { ctx, run } = arrange(OWN_AURA, [
      {
        playerId: 'P1',
        cardNames: ['Lab Own Aura'],
        attachedToCard: { playerId: 'P2', cardName: 'Lab Host' },
      },
      { playerId: 'P2', cardNames: ['Lab Host'] },
    ]);
    run();
    const aura = ctx.state.battlefield.find((perm) => perm.name === 'Lab Own Aura');
    expect(aura?.attachedTo).toBeTruthy();
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield.includes(aura!)).toBe(false);
    const rocked = arrange(
      AURA,
      [
        {
          playerId: 'P1',
          cardNames: ['Lab Aura'],
          attachedToCard: { playerId: 'P2', cardName: 'Lab Rock' },
        },
        { playerId: 'P2', cardNames: ['Lab Rock'] },
      ],
      [ROCK],
    );
    rocked.run();
    pump(priorityCheckpoint(rocked.ctx));
    expect(rocked.ctx.state.battlefield.some((perm) => perm.name === 'Lab Aura')).toBe(false);
  });
});
