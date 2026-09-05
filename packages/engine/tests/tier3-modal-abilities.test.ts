import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump } from './fixtures';

const nl = String.fromCharCode(10);
const dash = String.fromCharCode(0x2014);
const bullet = String.fromCharCode(0x2022);

function pod(seed: string): GameContext {
  const ctx = createGame(gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(3, forest) })), { seed }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const p1 = (ctx: GameContext): EnginePlayerState =>
  ctx.state.players.find((player) => player.id === 'P1') as EnginePlayerState;

describe('Tier 3 modal triggered and activated abilities', () => {
  it('parses and resolves an activated modal block', () => {
    const def = interpretCard(oracle({
      name: 'Test Modal Relic',
      typeLine: 'Artifact',
      manaCost: '{2}',
      oracleText: `{2}: Choose one ${dash}${nl}${bullet} You gain 3 life.${nl}${bullet} Draw a card.`,
    }));
    expect(def.modeled, def.unmodeledReasons.join('; ')).toBe(true);
    expect(def.activatedAbilities[0]?.ability.modes).toMatchObject({ minChoices: 1, maxChoices: 1 });

    const ctx = pod('tier3-activated-modal');
    const player = p1(ctx);
    const lifeBefore = player.life;
    pump(executeAbility(ctx, {
      cardId: 'c-modal-relic',
      oracleId: def.oracleId,
      name: def.name,
      controllerId: 'P1',
    }, def.activatedAbilities[0]!.ability, []), (decision) => ({
      index: Math.max(0, decision.options.findIndex((option) => option.description.includes('gain 3 life'))),
      targets: new Map(),
    }));
    expect(player.life).toBe(lifeBefore + 3);
  });

  it('supports named repeatable modes and executes the same mode three times', () => {
    const def = interpretCard(oracle({
      name: 'Test Repeatable Engine',
      typeLine: 'Artifact',
      manaCost: '{3}',
      oracleText: `{3}: Choose three. You may choose the same mode more than once.${nl}${bullet} Insight ${dash} Draw a card.${nl}${bullet} Vitality ${dash} You gain 1 life.`,
    }));
    const modes = def.activatedAbilities[0]?.ability.modes;
    expect(def.modeled, def.unmodeledReasons.join('; ')).toBe(true);
    expect(modes).toMatchObject({ minChoices: 3, maxChoices: 3, repeatable: true });
    expect(modes?.options[1]?.description).toBe('vitality: you gain 1 life');

    const ctx = pod('tier3-repeatable-modal');
    const player = p1(ctx);
    const lifeBefore = player.life;
    pump(executeAbility(ctx, {
      cardId: 'c-repeatable',
      oracleId: def.oracleId,
      name: def.name,
      controllerId: 'P1',
    }, def.activatedAbilities[0]!.ability, []), (decision) => {
      const index = decision.options.findIndex((option) =>
        option.description.split('vitality').length - 1 === 3,
      );
      return { index: Math.max(0, index), targets: new Map() };
    });
    expect(player.life).toBe(lifeBefore + 3);
  });

  it('supports choose up to one on triggers and fails closed if any bullet is unknown', () => {
    const optional = interpretCard(oracle({
      name: 'Test Optional Sage',
      typeLine: `Creature ${dash} Human Wizard`,
      manaCost: '{1}{U}',
      power: '2',
      toughness: '2',
      oracleText: `At the beginning of your upkeep, choose up to one ${dash}${nl}${bullet} Draw a card.${nl}${bullet} You gain 2 life.`,
    }));
    expect(optional.modeled, optional.unmodeledReasons.join('; ')).toBe(true);
    expect(optional.triggers[0]?.modes).toMatchObject({ minChoices: 0, maxChoices: 1 });

    const invalid = interpretCard(oracle({
      name: 'Test Broken Modal Relic',
      typeLine: 'Artifact',
      manaCost: '{2}',
      oracleText: `{2}: Choose one ${dash}${nl}${bullet} Draw a card.${nl}${bullet} Reverse the polarity of the moon.`,
    }));
    expect(invalid.modeled).toBe(false);
    expect(invalid.activatedAbilities).toHaveLength(0);
  });

  /**
   * Hullbreaker Horror, verbatim. Its blocker was never the modal header — it was the bullet
   * "Return target spell you don't control to its owner's hand", which needs a spell on the
   * STACK as a target. `returnToHand` already knew how to move a stack object; only the
   * phrasing was missing, so this drives the whole path end to end.
   */
  it("returns a spell from the stack to its owner's hand", () => {
    const def = interpretCard(oracle({
      name: 'Test Hullbreaker',
      typeLine: `Creature ${dash} Kraken Horror`,
      manaCost: '{5}{U}{U}',
      power: '7',
      toughness: '8',
      oracleText: [
        'Flash',
        "This spell can't be countered.",
        `Whenever you cast a spell, choose up to one ${dash}`,
        `${bullet} Return target spell you don't control to its owner's hand.`,
        `${bullet} Return target nonland permanent to its owner's hand.`,
      ].join(nl),
    }));
    expect(def.modeled, def.unmodeledReasons.join('; ')).toBe(true);
    const trigger = def.triggers[0]!;
    expect(trigger.targets[0]).toEqual({ kind: 'spell', controller: 'opponent' });
    expect(trigger.modes?.options[0]?.effects).toEqual([{ op: 'returnToHand', target: 0 }]);

    const ctx = pod('tier3-bounce-spell');
    // An opponent's sorcery waiting on the stack, with its card object attached the way a real
    // cast leaves it — that card is what has to end up in hand.
    const spellCard = conjure(ctx, 'P2', oracle({
      name: 'Test Opposing Bolt',
      typeLine: 'Sorcery',
      manaCost: '{R}',
      oracleText: 'Draw a card.',
    }), 'hand');
    const spellDef = interpretCard(oracle({
      name: 'Test Opposing Bolt',
      typeLine: 'Sorcery',
      manaCost: '{R}',
      oracleText: 'Draw a card.',
    }));
    ctx.state.stack.push({
      id: 'o-stack-bolt',
      kind: 'spell',
      sourceId: spellCard.id,
      sourceCardId: spellCard.cardId,
      sourceOracleId: spellCard.oracleId,
      controllerId: 'P2',
      description: spellCard.name,
      ability: spellDef.spellAbility,
      targets: [],
      card: spellCard,
    } as never);
    spellCard.zone = 'stack';
    const opponentHandBefore = ctx.state.players.find((p) => p.id === 'P2')!.hand.length;

    // Resolve the first mode directly: `exactOptionalPropertyTypes` forbids spreading
    // `modes: undefined`, so the key is dropped rather than set.
    const { modes: _modes, ...withoutModes } = trigger;
    pump(executeAbility(ctx, {
      cardId: 'c-hullbreaker',
      oracleId: def.oracleId,
      name: def.name,
      controllerId: 'P1',
    }, { ...withoutModes, effects: trigger.modes!.options[0]!.effects }, ['o-stack-bolt' as never]));

    expect(ctx.state.stack).toHaveLength(0);
    const opponent = ctx.state.players.find((player) => player.id === 'P2')!;
    expect(opponent.hand).toHaveLength(opponentHandBefore + 1);
    expect(opponent.hand.some((card) => card.name === 'Test Opposing Bolt')).toBe(true);
    // Bounced, not countered: it must NOT be in the graveyard.
    expect(opponent.graveyard.some((card) => card.name === 'Test Opposing Bolt')).toBe(false);
  });
});
