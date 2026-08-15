/**
 * "You may … rather than pay this spell's mana cost" — a free cast whose price is not mana
 * (Force of Will, Force of Negation). The EDH-staple coverage plan's Tier 2 item 5.
 *
 * `AlternativeCast` already existed but was keyed to a mana cost, so an alternative cost paid
 * in life and exiled cards had nowhere to live. It is generalized to carry `AbilityCost[]` —
 * which is deliberately the SAME list a spell's additional cost uses (Tier 2 item 1), so the
 * payability check that gates the option and the payment itself are shared code rather than a
 * second implementation that would drift from it.
 *
 * The two properties that matter, both of which the option menu is the contract for: the cast
 * is not offered when its price cannot be paid, and the price is actually charged.
 */

import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, island, oracle, pump, spawn } from './fixtures';

const forceOfWill = (): OracleCard =>
  oracle({
    name: 'Test Force of Will',
    typeLine: 'Instant',
    manaCost: '{3}{U}{U}',
    cmc: 5,
    colors: ['U'],
    colorIdentity: ['U'],
    power: null,
    toughness: null,
    oracleText:
      "You may pay 1 life and exile a blue card from your hand rather than pay this spell's mana cost.\nCounter target spell.",
  });

const blueCard = (name: string): OracleCard =>
  oracle({ name, typeLine: 'Creature — Merfolk', manaCost: '{1}{U}', colors: ['U'], colorIdentity: ['U'] });

const greenCard = (name: string): OracleCard =>
  oracle({ name, typeLine: 'Creature — Bear', manaCost: '{1}{G}', colors: ['G'], colorIdentity: ['G'] });

function pod(seed = 'free-alt-casts'): GameContext {
  const ctx = createGame(
    gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(6, forest) })), { seed }),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const p1 = (ctx: GameContext): EnginePlayerState =>
  ctx.state.players.find((p) => p.id === 'P1') as EnginePlayerState;

/** A spell for Force of Will to counter, so its target requirement is satisfiable. */
function opponentSpellOnStack(ctx: GameContext): void {
  const card = conjure(ctx, 'P2', oracle({ name: 'Test Rival Spell', typeLine: 'Sorcery', manaCost: '{1}', power: null, toughness: null }), 'hand');
  ctx.state.stack.push({
    id: card.id,
    sourceId: card.id,
    controllerId: 'P2',
    kind: 'spell',
    description: card.name,
    targets: [],
    card,
    ability: null,
    sourceOracleId: card.oracleId,
    sourceCardId: card.cardId,
    isCommanderCast: false,
  });
}

const altCastOptions = (ctx: GameContext): string[] =>
  computePriorityOptions(ctx, p1(ctx))
    .filter((o) => o.data?.['castVariant'] === 'alternativeCost')
    .map((o) => o.description);

describe('free alternative casts — parsing', () => {
  it('reads the price as ordinary ability costs', () => {
    const def = interpretCard(forceOfWill());

    expect(def.modeled).toBe(true);
    expect(def.alternativeCasts).toHaveLength(1);
    expect(def.alternativeCasts?.[0]).toMatchObject({
      kind: 'alternativeCost',
      costs: [
        { kind: 'payLife', amount: 1 },
        { kind: 'exileFromHand', filter: { kind: 'color', value: 'U' }, count: 1 },
      ],
    });
  });

  it('marks the hand-only variant, and leaves an unreadable price unmodeled', () => {
    const negation = interpretCard(
      oracle({
        name: 'Test Force of Negation',
        typeLine: 'Instant',
        manaCost: '{1}{U}{U}',
        power: null,
        toughness: null,
        oracleText:
          "If this spell was cast from your hand, you may exile a blue card from your hand rather than pay this spell's mana cost.\nCounter target spell.",
      }),
    );
    expect(negation.modeled).toBe(true);
    expect(negation.alternativeCasts?.[0]).toMatchObject({ kind: 'alternativeCost', fromHandOnly: true });

    // Fail closed: a price the engine cannot charge must not become a free cast.
    const unreadable = interpretCard(
      oracle({
        name: 'Test Unreadable Alt',
        typeLine: 'Instant',
        manaCost: '{2}{U}',
        power: null,
        toughness: null,
        oracleText:
          "You may reveal a Faerie card from your hand rather than pay this spell's mana cost.\nCounter target spell.",
      }),
    );
    expect(unreadable.modeled).toBe(false);
    expect(unreadable.alternativeCasts).toBeUndefined();
  });
});

describe('free alternative casts — legality', () => {
  it('is not offered without a card matching the exile cost', () => {
    const ctx = pod();
    opponentSpellOnStack(ctx);
    conjure(ctx, 'P1', forceOfWill(), 'hand');
    conjure(ctx, 'P1', greenCard('Test Green Card'), 'hand');

    expect(altCastOptions(ctx)).toEqual([]);
  });

  it('is offered once a blue card is in hand, with no lands at all', () => {
    const ctx = pod();
    opponentSpellOnStack(ctx);
    conjure(ctx, 'P1', forceOfWill(), 'hand');
    conjure(ctx, 'P1', blueCard('Test Blue Card'), 'hand');

    // The point of the card: castable on an empty board.
    expect(ctx.state.battlefield.filter((p) => p.controllerId === 'P1')).toHaveLength(0);
    expect(altCastOptions(ctx)).toHaveLength(1);
  });

  it('never counts the spell itself as the blue card exiled for its own cost', () => {
    const ctx = pod();
    opponentSpellOnStack(ctx);
    // Force of Will is itself blue and in hand; it is on the stack by CR 601.2a when the cost
    // is paid, so it cannot pay for itself.
    conjure(ctx, 'P1', forceOfWill(), 'hand');

    expect(altCastOptions(ctx)).toEqual([]);
  });

  it('is not offered when the life payment would kill you', () => {
    const ctx = pod();
    opponentSpellOnStack(ctx);
    conjure(ctx, 'P1', forceOfWill(), 'hand');
    conjure(ctx, 'P1', blueCard('Test Blue Card'), 'hand');
    p1(ctx).life = 0;

    // CR 118.8 — life is payable only down to 0, never below.
    expect(altCastOptions(ctx)).toEqual([]);
  });
});

describe('free alternative casts — payment', () => {
  it('pays the life, exiles the card, and casts for no mana', () => {
    const ctx = pod();
    opponentSpellOnStack(ctx);
    const fow = conjure(ctx, 'P1', forceOfWill(), 'hand');
    conjure(ctx, 'P1', blueCard('Test Blue Card'), 'hand');
    spawn(ctx, 'P1', island()); // available, and must go unused
    const lifeBefore = p1(ctx).life;
    const rivalSpellId = ctx.state.stack[0]?.id as string;

    pump(
      applyPriorityAction(
        ctx,
        p1(ctx),
        { kind: 'castSpell', objectId: fow.id, fromCommand: false, alternativeCast: 'alternativeCost', altIndex: 0 },
        { index: 0, targets: new Map([[0, rivalSpellId]]) },
      ),
    );

    expect(p1(ctx).life).toBe(lifeBefore - 1);
    expect(ctx.state.exile.map((c) => c.name)).toEqual(['Test Blue Card']);
    expect(ctx.state.battlefield.filter((p) => p.controllerId === 'P1' && p.tapped)).toHaveLength(0);
    expect(ctx.state.stack.map((s) => s.description)).toEqual(['Test Rival Spell', 'Test Force of Will']);
  });
});
