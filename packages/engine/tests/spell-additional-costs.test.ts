import { describe, expect, it } from 'vitest';
import { computePriorityOptions } from '../src/actions/legal';
import type { PriorityActionPayload } from '../src/actions/legal';
import { applyPriorityAction } from '../src/actions/apply';
import { interpretCard } from '../src/cards/interpret';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import { addMana } from '../src/mana/pool';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

function pod(seed = 'spell-additional-costs'): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const additionalCostCards = [
  {
    name: 'Deadly Dispute',
    typeLine: 'Instant',
    manaCost: '{1}{B}',
    oracleText:
      'As an additional cost to cast this spell, sacrifice an artifact or creature.' +
      String.fromCharCode(10) +
      'Draw two cards and create a Treasure token.',
    expected: { kind: 'sacrificeOther', selector: 'artifactOrCreature' },
  },
  {
    name: 'Big Score',
    typeLine: 'Instant',
    manaCost: '{3}{R}',
    oracleText:
      'As an additional cost to cast this spell, discard a card.' +
      String.fromCharCode(10) +
      'Draw two cards and create two Treasure tokens.',
    expected: { kind: 'discardCard' },
  },
  {
    name: 'Thrill of Possibility',
    typeLine: 'Instant',
    manaCost: '{1}{R}',
    oracleText:
      'As an additional cost to cast this spell, discard a card.' +
      String.fromCharCode(10) +
      'Draw two cards.',
    expected: { kind: 'discardCard' },
  },
  {
    name: 'Village Rites',
    typeLine: 'Instant',
    manaCost: '{B}',
    oracleText:
      'As an additional cost to cast this spell, sacrifice a creature.' +
      String.fromCharCode(10) +
      'Draw two cards.',
    expected: { kind: 'sacrificeOther', selector: 'creature' },
  },
  {
    name: 'Crop Rotation',
    typeLine: 'Instant',
    manaCost: '{G}',
    oracleText:
      'As an additional cost to cast this spell, sacrifice a land.' +
      String.fromCharCode(10) +
      'Search your library for a land card, put that card onto the battlefield, then shuffle.',
    expected: { kind: 'sacrificeOther', selector: 'land' },
  },
  {
    name: 'Harrow',
    typeLine: 'Instant',
    manaCost: '{2}{G}',
    oracleText:
      'As an additional cost to cast this spell, sacrifice a land.' +
      String.fromCharCode(10) +
      'Search your library for up to two basic land cards, put them onto the battlefield, then shuffle.',
    expected: { kind: 'sacrificeOther', selector: 'land' },
  },
] as const;

describe('spell additional casting costs', () => {
  it('parses the six Tier 2.1 card shapes into typed announcement costs', () => {
    for (const card of additionalCostCards) {
      const def = interpretCard(oracle(card));
      expect(def.modeled, card.name + ': ' + def.unmodeledReasons.join('; ')).toBe(true);
      expect(def.spellAdditionalCosts).toHaveLength(1);
      const cost = def.spellAdditionalCosts?.[0];
      expect(cost?.kind).toBe(card.expected.kind);
      if (card.expected.kind === 'discardCard') {
        expect(cost).toEqual({ kind: 'discardCard' });
      } else {
        expect(cost?.kind).toBe('sacrificeOther');
      }
    }
  });

  it('does not offer a sacrifice spell without a legal sacrifice, then pays the selected creature before resolution', () => {
    const ctx = pod('village-rites');
    const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
    const rites = oracle({
      name: 'Village Rites',
      typeLine: 'Instant',
      manaCost: '{B}',
      oracleText:
        'As an additional cost to cast this spell, sacrifice a creature.' +
        String.fromCharCode(10) +
        'Draw two cards.',
    });
    const ritesObject = conjure(ctx, 'P1', rites, 'hand');
    addMana(player, [{ symbol: 'B' }]);

    expect(
      computePriorityOptions(ctx, player).some(
        (option) =>
          option.type === 'castSpell' &&
          (option.payload as PriorityActionPayload).kind === 'castSpell',
      ),
    ).toBe(false);

    const first = spawn(
      ctx,
      'P1',
      oracle({ name: 'First Creature', typeLine: 'Creature — Test', manaCost: '{1}' }),
    );
    const second = spawn(
      ctx,
      'P1',
      oracle({ name: 'Second Creature', typeLine: 'Creature — Test', manaCost: '{1}' }),
    );
    const drawOne = oracle({ name: 'Draw One', typeLine: 'Creature — Test', manaCost: '{1}' });
    const drawTwo = oracle({ name: 'Draw Two', typeLine: 'Creature — Test', manaCost: '{1}' });
    conjure(ctx, 'P1', drawOne, 'library');
    conjure(ctx, 'P1', drawTwo, 'library');

    const cast = computePriorityOptions(ctx, player).find(
      (option) =>
        option.type === 'castSpell' &&
        (option.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>).objectId ===
          ritesObject.id,
    );
    expect(cast).toBeDefined();
    const payload = cast!.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>;

    pump(
      applyPriorityAction(ctx, player, payload, { index: 0, targets: new Map() }),
      (decision) => {
        expect(decision.prompt).toContain('sacrifice');
        return { index: 1, targets: new Map() };
      },
    );

    expect(ctx.state.battlefield.some((perm) => perm.cardId === second.cardId)).toBe(false);
    expect(player.graveyard.some((card) => card.cardId === second.cardId)).toBe(true);
    expect(ctx.state.stack.at(-1)?.sourceCardId).toBe(ritesObject.cardId);

    pump(resolveTopOfStack(ctx));

    expect(player.hand.map((card) => card.name)).toEqual(['Draw Two', 'Draw One']);
    expect(player.graveyard.some((card) => card.name === 'Village Rites')).toBe(true);
    expect(ctx.state.battlefield.some((perm) => perm.cardId === first.cardId)).toBe(true);
  });

  it('pays a forced multi-sacrifice spell cost without asking, and asks when there is a spare', () => {
    const cast = (creatures: number) => {
      const ctx = pod(`sacrifice-two-${creatures}`);
      const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
      const spell = conjure(
        ctx,
        'P1',
        oracle({
          name: 'Twin Offering',
          typeLine: 'Sorcery',
          manaCost: '{B}',
          oracleText:
            'As an additional cost to cast this spell, sacrifice two creatures.' +
            String.fromCharCode(10) +
            'Draw two cards.',
        }),
        'hand',
      );
      addMana(player, [{ symbol: 'B' }]);
      for (let i = 0; i < creatures; i++)
        spawn(
          ctx,
          'P1',
          oracle({ name: `Offered ${i}`, typeLine: 'Creature — Test', manaCost: '{1}' }),
        );
      const option = computePriorityOptions(ctx, player).find(
        (candidate) =>
          candidate.type === 'castSpell' &&
          (candidate.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>).objectId ===
            spell.id,
      );
      expect(option).toBeDefined();
      const prompts: string[] = [];
      pump(
        applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
          index: 0,
          targets: new Map(),
        }),
        (decision) => {
          prompts.push(decision.prompt);
          return { index: 0, targets: new Map() };
        },
        { strict: true },
      );
      return { ctx, player, prompts };
    };

    // Exactly two creatures: both must go, so nothing is asked.
    const forced = cast(2);
    expect(forced.prompts.filter((prompt) => prompt.includes('sacrifice'))).toEqual([]);
    expect(forced.ctx.state.battlefield).toHaveLength(0);
    expect(forced.player.graveyard.map((card) => card.name).sort()).toEqual([
      'Offered 0',
      'Offered 1',
    ]);

    // Three creatures: which two is a choice, so both picks are asked.
    const choice = cast(3);
    expect(choice.prompts.filter((prompt) => prompt.includes('sacrifice'))).toHaveLength(2);
    expect(choice.ctx.state.battlefield).toHaveLength(1);
  });

  it('does not offer a discard spell with no other card, then discards a different hand card at announcement', () => {
    const ctx = pod('thrill-of-possibility');
    const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
    const thrill = oracle({
      name: 'Thrill of Possibility',
      typeLine: 'Instant',
      manaCost: '{1}{R}',
      oracleText:
        'As an additional cost to cast this spell, discard a card.' +
        String.fromCharCode(10) +
        'Draw two cards.',
    });
    const thrillObject = conjure(ctx, 'P1', thrill, 'hand');
    player.manaEntries = [{ symbol: 'R' }, { symbol: 'C' }];
    player.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 1 };

    expect(
      computePriorityOptions(ctx, player).some(
        (option) =>
          option.type === 'castSpell' &&
          (option.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>).objectId ===
            thrillObject.id,
      ),
    ).toBe(false);

    const spare = oracle({ name: 'Spare Card', typeLine: 'Creature — Test', manaCost: '{1}' });
    const spareObject = conjure(ctx, 'P1', spare, 'hand');
    const drawOne = oracle({
      name: 'Thrill Draw One',
      typeLine: 'Creature — Test',
      manaCost: '{1}',
    });
    const drawTwo = oracle({
      name: 'Thrill Draw Two',
      typeLine: 'Creature — Test',
      manaCost: '{1}',
    });
    conjure(ctx, 'P1', drawOne, 'library');
    conjure(ctx, 'P1', drawTwo, 'library');

    const cast = computePriorityOptions(ctx, player).find(
      (option) =>
        option.type === 'castSpell' &&
        (option.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>).objectId ===
          thrillObject.id,
    );
    expect(cast).toBeDefined();
    const payload = cast!.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>;

    pump(applyPriorityAction(ctx, player, payload, { index: 0, targets: new Map() }));

    expect(player.hand.some((card) => card.cardId === thrillObject.cardId)).toBe(false);
    expect(player.hand.some((card) => card.cardId === spareObject.cardId)).toBe(false);
    expect(player.graveyard.some((card) => card.cardId === spareObject.cardId)).toBe(true);
    expect(ctx.state.stack.at(-1)?.sourceCardId).toBe(thrillObject.cardId);

    pump(resolveTopOfStack(ctx));

    expect(player.hand.map((card) => card.name)).toEqual(['Thrill Draw Two', 'Thrill Draw One']);
    expect(player.graveyard.some((card) => card.name === 'Thrill of Possibility')).toBe(true);
  });
});
