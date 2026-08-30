import { describe, expect, it } from 'vitest';
import { computePriorityOptions } from '../src/actions/legal';
import type { PriorityActionPayload } from '../src/actions/legal';
import { applyPriorityAction } from '../src/actions/apply';
import { resolveTopOfStack } from '../src/stack/stack';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pick, pump, spawn } from './fixtures';

const cyclonicRift = () =>
  oracle({
    name: 'Cyclonic Rift',
    manaCost: '{1}{U}',
    cmc: 2,
    colors: ['U'],
    colorIdentity: ['U'],
    typeLine: 'Instant',
    oracleText:
      'Return target nonland permanent you don\'t control to its owner\'s hand.\nOverload {6}{U} (You may cast this spell for its overload cost. If you do, change "target" in its text to "each.")',
  });

function pod(seed = 'alt-casts-test'): GameContext {
  const ctx = createGame(
    gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })), { seed }),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

describe('Increment 17: Alternative Casts (Overload)', () => {
  it('models Cyclonic Rift with alternative overload cast', () => {
    const def = interpretCard(cyclonicRift());
    expect(def.modeled).toBe(true);
    expect(def.alternativeCasts).toBeDefined();
    expect(def.alternativeCasts?.length).toBe(1);
    expect(def.alternativeCasts?.[0]?.kind).toBe('overload');
  });

  it('resolves Overload mode returning all nonland opponent permanents to hand', () => {
    const ctx = pod();
    const p1Perm = spawn(ctx, 'P1', oracle({ name: 'P1 Bear', typeLine: 'Creature' }));
    const p2Perm1 = spawn(ctx, 'P2', oracle({ name: 'P2 Bear 1', typeLine: 'Creature' }));
    const p2Perm2 = spawn(ctx, 'P2', oracle({ name: 'P2 Artifact', typeLine: 'Artifact' }));
    const p2Land = spawn(ctx, 'P2', oracle({ name: 'P2 Forest', typeLine: 'Land' }));

    const def = interpretCard(cyclonicRift());
    const overloadAbility = {
      kind: 'spell' as const,
      targets: [],
      effects: [{ op: 'overloadBounceAllNonlandOpponents' as const }],
    };

    pump(
      executeAbility(
        ctx,
        { cardId: 'rift-1', name: 'Cyclonic Rift', oracleId: def.oracleId, controllerId: 'P1' },
        overloadAbility,
        [],
      ),
    );

    // P1 permanent untouched
    expect(ctx.state.battlefield.find((p) => p.id === p1Perm.id)).toBeDefined();
    // P2 nonland permanents bounced to P2's hand
    expect(ctx.state.battlefield.find((p) => p.id === p2Perm1.id)).toBeUndefined();
    expect(ctx.state.battlefield.find((p) => p.id === p2Perm2.id)).toBeUndefined();
    // P2 land untouched
    expect(ctx.state.battlefield.find((p) => p.id === p2Land.id)).toBeDefined();
  });
});

const forceCards = [
  oracle({
    name: 'Force of Will',
    typeLine: 'Instant',
    manaCost: '{3}{U}{U}',
    cmc: 5,
    colors: ['U'],
    colorIdentity: ['U'],
    oracleText: 'You may pay 1 life and exile a blue card from your hand rather than pay this spell\'s mana cost.\nCounter target spell.',
    power: null,
    toughness: null,
  }),
  oracle({
    name: 'Force of Negation',
    typeLine: 'Instant',
    manaCost: '{1}{U}{U}',
    cmc: 3,
    colors: ['U'],
    colorIdentity: ['U'],
    oracleText: 'If it\'s not your turn, you may pay 1 life and exile a blue card from your hand rather than pay its mana cost.\nCounter target spell.',
    power: null,
    toughness: null,
  }),
];

describe('non-mana alternative casts', () => {
  it.each(forceCards)('parses $name as a life-and-pitch alternative cost', (card) => {
    const def = interpretCard(card);
    expect(def.modeled, def.unmodeledReasons.join('; ')).toBe(true);
    expect(def.alternativeCasts).toEqual([
      expect.objectContaining({
        kind: 'nonMana',
        manaCost: expect.objectContaining({ generic: 0 }),
        costs: [
          { kind: 'payLife', amount: 1 },
          { kind: 'exileCardFromHand', selector: { kind: 'color', value: 'U' } },
        ],
      }),
    ]);
  });

  it('offers, pays, and resolves Force of Will using its blue pitch cost', () => {
    const ctx = pod('force-of-will');
    const force = conjure(ctx, 'P1', forceCards[0]!, 'hand');
    const pitch = conjure(ctx, 'P1', oracle({
      name: 'Blue Pitch Card',
      typeLine: 'Instant',
      manaCost: '{U}',
      colors: ['U'],
      colorIdentity: ['U'],
      oracleText: 'Draw a card.',
      power: null,
      toughness: null,
    }), 'hand');
    const target = oracle({
      name: 'Target Spell',
      typeLine: 'Instant',
      manaCost: '{0}',
      cmc: 0,
      oracleText: 'Draw a card.',
      power: null,
      toughness: null,
    });
    const targetObject = conjure(ctx, 'P2', target, 'hand');
    const p2 = ctx.state.players.find((player) => player.id === 'P2')!;
    const targetOption = computePriorityOptions(ctx, p2).find((option) =>
      option.type === 'castSpell' && (option.payload as PriorityActionPayload).kind === 'castSpell' &&
      (option.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>).objectId === targetObject.id,
    );
    expect(targetOption).toBeDefined();
    pump(applyPriorityAction(ctx, p2, targetOption!.payload as PriorityActionPayload, { index: 0, targets: new Map() }));

    const p1 = ctx.state.players.find((player) => player.id === 'P1')!;
    const forceOption = computePriorityOptions(ctx, p1).find((option) =>
      option.type === 'castSpell' && (option.payload as PriorityActionPayload).kind === 'castSpell' &&
      (option.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>).objectId === force.id &&
      (option.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>).alternativeCast === 'nonMana',
    );
    expect(forceOption).toBeDefined();
    expect(forceOption?.data).toMatchObject({ manaCost: 'free', castVariant: 'nonMana' });
    const forcePayload = forceOption!.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>;
    const lifeBefore = p1.life;
    pump(
      applyPriorityAction(ctx, p1, forcePayload, {
        index: 0,
        targets: new Map([[0, ctx.state.stack.at(-1)!.id]]),
      }),
      (decision) => pick(decision, 'Blue Pitch Card'),
    );

    expect(p1.life).toBe(lifeBefore - 1);
    expect(p1.hand.some((card) => card.cardId === force.cardId)).toBe(false);
    expect(ctx.state.exile.some((card) => card.cardId === pitch.cardId)).toBe(true);
    expect(ctx.state.stack.at(-1)?.sourceCardId).toBe(force.cardId);
    expect(ctx.state.stack.at(-1)?.alternativeCastKind).toBe('nonMana');

    pump(resolveTopOfStack(ctx));

    expect(p1.graveyard.some((card) => card.cardId === force.cardId)).toBe(true);
    expect(p2.graveyard.some((card) => card.cardId === targetObject.cardId)).toBe(true);
    expect(p2.hand.some((card) => card.name === 'Target Spell')).toBe(false);
  });

  it('does not offer the alternative cast without a matching blue card in hand', () => {
    const ctx = pod('force-no-pitch');
    const force = conjure(ctx, 'P1', forceCards[0]!, 'hand');
    conjure(ctx, 'P1', forest(), 'hand');
    const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;

    expect(computePriorityOptions(ctx, player).some((option) =>
      option.type === 'castSpell' &&
      (option.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>).objectId === force.id &&
      (option.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>).alternativeCast === 'nonMana',
    )).toBe(false);
  });
});
describe('conditional non-mana alternative casts', () => {
  it('only offers Force of Negation pitch casting during an opponent turn', () => {
    const ctx = pod('force-of-negation-turn');
    const force = conjure(ctx, 'P1', forceCards[1]!, 'hand');
    conjure(ctx, 'P1', oracle({
      name: 'Blue Pitch Card',
      typeLine: 'Instant',
      manaCost: '{U}',
      colors: ['U'],
      colorIdentity: ['U'],
      oracleText: 'Draw a card.',
      power: null,
      toughness: null,
    }), 'hand');
    const target = oracle({ name: 'Opponent Spell', typeLine: 'Instant', manaCost: '{0}', cmc: 0, oracleText: 'Draw a card.', power: null, toughness: null });
    const targetObject = conjure(ctx, 'P2', target, 'hand');
    const p2 = ctx.state.players.find((player) => player.id === 'P2')!;
    const targetOption = computePriorityOptions(ctx, p2).find((option) =>
      option.type === 'castSpell' && (option.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>).objectId === targetObject.id,
    );
    expect(targetOption).toBeDefined();
    pump(applyPriorityAction(ctx, p2, targetOption!.payload as PriorityActionPayload, { index: 0, targets: new Map() }));

    const p1 = ctx.state.players.find((player) => player.id === 'P1')!;
    const hasPitchOption = () => computePriorityOptions(ctx, p1).some((option) =>
      option.type === 'castSpell' &&
      (option.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>).objectId === force.id &&
      (option.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>).alternativeCast === 'nonMana',
    );

    expect(hasPitchOption()).toBe(false);
    ctx.state.currentTurnPlayer = 'P2';
    expect(hasPitchOption()).toBe(true);
    expect(interpretCard(forceCards[1]!).alternativeCasts?.[0]).toEqual(expect.objectContaining({ condition: { kind: 'notYourTurn' } }));
  });
});