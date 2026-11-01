/**
 * Contract tests for the `payLifeOrTopDrawnCards` primitive, started with card:new --primitive:
 * "choose two cards in your hand drawn this turn. For each of those cards, pay 4 life or put the
 * card on top of your library" (Sylvan Library). A draw marks the hand card with its turn, so only
 * cards drawn this turn and still in hand are offered. Contract tests may not use the scenario
 * runner (their evidence hashes this file's closure).
 */
import { describe, expect, it } from 'vitest';
import type { Effect } from '../src/cards/ability';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { deriveCardCapabilities } from '../src/cards/capabilities';
import { EFFECT_REFERENCE_CONTRACTS } from '../src/cards/effect-reference-contracts';
import { interpretCard } from '../src/cards/interpret';
import { spell } from '../src/cards/templates';
import { constant } from '../src/cards/value';
import { drawCards, executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import {
  bear,
  bolt,
  conjure,
  copies,
  forest,
  gameConfig,
  oracle,
  pick,
  pump,
  pumpStrict,
  spawn,
} from './fixtures';

const effect: Effect = { op: 'payLifeOrTopDrawnCards', count: constant(2), life: constant(4) };
const ability = spell({ effects: [effect], description: 'Pay 4 life or put back' });

function game(): GameContext {
  return createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(6, forest) })),
      { seed: 'pay-life-or-top-contract' },
    ),
  );
}

const source = (ctx: GameContext) =>
  spawn(ctx, 'P1', oracle({ name: 'Contract Library', typeLine: 'Enchantment', manaCost: '{1}' }));
const names = (cards: ReadonlyArray<{ name: string }>) => cards.map((card) => card.name);

describe('payLifeOrTopDrawnCards primitive contract', () => {
  it('executes through a real spell or ability, with the engine path', () => {
    const ctx = game();
    const p1 = playerById(ctx, 'P1');
    conjure(ctx, 'P1', bear(), 'hand');
    // Library top: Test Bolt, then Forests. Draw two: Bolt and a Forest, both drawn this turn.
    conjure(ctx, 'P1', bolt(), 'library');
    pumpStrict(drawCards(ctx, p1, 2));
    const asked: string[][] = [];
    const life = p1.life;
    pump(
      executeAbility(ctx, source(ctx), ability, []),
      (decision) => {
        asked.push(decision.options.map((option) => option.description));
        // The first pick is the Bolt; the Forest, the only card left, is chosen with it. Keep the
        // Bolt for 4 life; put the Forest back.
        if (asked.length === 1) return pick(decision, 'Test Bolt');
        return pick(decision, asked.length === 2 ? /^Pay 4 life/ : /^Put Forest on top/);
      },
      { strict: true },
    );
    // The Bear was not drawn this turn, so it is never offered.
    expect(asked[0]!.some((description) => description.includes('Test Bear'))).toBe(false);
    expect(asked).toEqual([
      ['Choose Test Bolt', 'Choose Forest'],
      ['Pay 4 life: keep Test Bolt', 'Put Test Bolt on top of your library'],
      ['Pay 4 life: keep Forest', 'Put Forest on top of your library'],
    ]);
    expect(p1.life).toBe(life - 4);
    expect(names(p1.hand).sort()).toEqual(['Test Bear', 'Test Bolt']);
    expect(p1.library[0]!.name).toBe('Forest');
  });

  it('does nothing it should not: the negative case', () => {
    const ctx = game();
    const p1 = playerById(ctx, 'P1');
    conjure(ctx, 'P1', bear(), 'hand');
    pumpStrict(executeAbility(ctx, source(ctx), ability, []));
    expect(names(p1.hand)).toEqual(['Test Bear']);

    // Without 4 life to pay, the drawn card goes back without a question (CR 119.4).
    const poor = game();
    const p = playerById(poor, 'P1');
    pumpStrict(drawCards(poor, p, 1));
    p.life = 3;
    pumpStrict(executeAbility(poor, source(poor), ability, []));
    expect(p.hand).toHaveLength(0);
    expect(p.life).toBe(3);
  });

  it('validation rejects malformed IR for it', () => {
    const card = interpretCard(
      oracle({ name: 'Contract Card', typeLine: 'Sorcery', manaCost: '{G}' }),
    );
    const withEffect = (candidate: unknown) =>
      validateCardDefinition({
        ...card,
        modeled: true,
        unmodeledReasons: [],
        spellAbility: spell({ effects: [candidate as Effect], description: 'Pay or put back' }),
      });
    expect(withEffect(effect)).toEqual([]);
    expect(withEffect({ op: 'payLifeOrTopDrawnCards', count: constant(2) }).length).toBeGreaterThan(
      0,
    );
    expect(
      withEffect({ op: 'payLifeOrTopDrawnCards', count: { kind: 'bogus' }, life: constant(4) })
        .length,
    ).toBeGreaterThan(0);
  });

  it('every reference it reads or writes resolves (effect-reference-contracts)', () => {
    // It reads no target slot or earlier result: the cards are chosen from the hand.
    expect(EFFECT_REFERENCE_CONTRACTS.payLifeOrTopDrawnCards).toEqual({});
  });

  it('its capability tag matches what the executor supports', () => {
    const definition = {
      ...interpretCard(oracle({ name: 'Contract Card', typeLine: 'Sorcery', manaCost: '{G}' })),
      spellAbility: ability,
    };
    expect(deriveCardCapabilities(definition)).toContain('Effect.payLifeOrTopDrawnCards');
  });
});
