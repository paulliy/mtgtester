/**
 * EDHREC coverage plan, Phase 4 batch 2: the "look at the top N cards of your library" shapes,
 * each read from a stand-in card and run through the executor (D1).
 */
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import type { Ability } from '../src/cards/ability';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump } from './fixtures';
import { script } from './script';

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.phase = 'precombatMain';
  return ctx;
}
const named = (name: string, typeLine = 'Creature — Elf') =>
  oracle({ name, typeLine, manaCost: '{G}', power: '1', toughness: '1' });
/** Put the named cards on top of P1's library, first name on top. */
function stack(ctx: GameContext, names: string[], typeLine?: string): void {
  for (const name of [...names].reverse()) conjure(ctx, 'P1', named(name, typeLine), 'library');
}
const p1 = (ctx: GameContext) => ctx.state.players.find((p) => p.id === 'P1')!;
function run(ctx: GameContext, text: string, answer?: Parameters<typeof pump>[1]): void {
  const card: OracleCard = oracle({
    name: 'P4 Look',
    typeLine: 'Sorcery',
    manaCost: '{U}',
    oracleText: text,
  });
  const def = interpretCard(card);
  expect(def.modeled, def.unmodeledReasons.join('; ')).toBe(true);
  pump(
    executeAbility(
      ctx,
      { cardId: 'p4-look', name: card.name, oracleId: card.oracleId, controllerId: 'P1' },
      def.spellAbility as Ability,
      [],
    ),
    answer,
    { strict: true },
  );
}

describe('Phase 4 batch 2: look at the top N', () => {
  it('put one of them into your hand and the rest into your graveyard (Forbidden Alchemy)', () => {
    const ctx = pod('p4-alchemy');
    stack(ctx, ['Look A', 'Look B', 'Look C', 'Look D']);
    run(
      ctx,
      'Look at the top four cards of your library. Put one of them into your hand and the rest into your graveyard.',
      script([{ prompt: 'put a card from among the top 4', choose: 'Put Look A into your hand' }]),
    );
    expect(p1(ctx).hand.map((c) => c.name)).toEqual(['Look A']);
    expect(
      p1(ctx)
        .graveyard.map((c) => c.name)
        .sort(),
    ).toEqual(['Look B', 'Look C', 'Look D']);
  });

  it('put two of them into your hand and the rest on the bottom (Stock Up)', () => {
    const ctx = pod('p4-stock-up');
    stack(ctx, ['Look A', 'Look B', 'Look C', 'Look D', 'Look E']);
    const size = p1(ctx).library.length;
    run(
      ctx,
      'Look at the top five cards of your library. Put two of them into your hand and the rest on the bottom of your library in any order.',
      script([
        { prompt: 'put a card from among the top 5', choose: 'Put Look A into your hand' },
        { prompt: 'put another card from among them', choose: 'Look B' },
        { prompt: 'reorder the cards on the bottom', choose: 'Keep the current bottom order' },
      ]),
    );
    expect(p1(ctx).hand).toHaveLength(2);
    expect(p1(ctx).library).toHaveLength(size - 2);
    const bottom = p1(ctx)
      .library.slice(-3)
      .map((c) => c.name);
    expect(bottom.every((name) => name.startsWith('Look '))).toBe(true);
    expect(p1(ctx).graveyard).toHaveLength(0);
  });

  it('you may reveal a creature card and put it into your hand; declining puts all four on the bottom', () => {
    const ctx = pod('p4-henge-decline');
    stack(ctx, ['Look A', 'Look B', 'Look C', 'Look D']);
    const text =
      'Look at the top four cards of your library. You may reveal a creature card from among them and put it into your hand. Put the rest on the bottom of your library in a random order.';
    run(ctx, text, (decision) => ({ index: decision.options.length - 1, targets: new Map() }));
    expect(p1(ctx).hand).toHaveLength(0);
    expect(
      p1(ctx)
        .library.slice(-4)
        .map((c) => c.name)
        .sort(),
    ).toEqual(['Look A', 'Look B', 'Look C', 'Look D']);
  });

  it('a non-matching card is never offered to reveal', () => {
    const ctx = pod('p4-henge-filter');
    stack(ctx, ['Look Land'], 'Land');
    stack(ctx, ['Look Elf']);
    let offered: string[] = [];
    run(
      ctx,
      'Look at the top two cards of your library. You may reveal a creature card from among them and put it into your hand. Put the rest on the bottom of your library in a random order.',
      (decision) => {
        offered = decision.options.map((option) => option.description);
        return { index: 0, targets: new Map() };
      },
    );
    expect(offered).toEqual(['Put Look Elf into your hand', 'Put none of them']);
    expect(p1(ctx).hand.map((c) => c.name)).toEqual(['Look Elf']);
  });
});
