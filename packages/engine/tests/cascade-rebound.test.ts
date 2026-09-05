import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { computePriorityOptions } from '../src/actions/legal';
import { finishSpellCard, resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import { removeFromCurrentZone } from '../src/state/objects';
import { queueStepTriggers } from '../src/turn/turn';
import type { EngineStackObject, GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump, registerDef } from './fixtures';

function pod(seed = 'cascade-rebound'): GameContext {
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

describe('Cascade and Rebound', () => {
  it('parses repeated Cascade instances and Rebound as implemented keywords', () => {
    const cascade = interpretCard(
      oracle({
        name: 'Apex Test',
        typeLine: 'Creature — Test',
        oracleText: 'Cascade, cascade, cascade, cascade',
      }),
    );
    const rebound = interpretCard(
      oracle({
        name: 'Rebound Test',
        typeLine: 'Sorcery',
        oracleText: 'Draw a card.' + String.fromCharCode(10) + 'Rebound',
      }),
    );

    expect(cascade.modeled).toBe(true);
    expect(cascade.keywords.filter((keyword) => keyword === 'cascade')).toHaveLength(4);
    expect(rebound.modeled).toBe(true);
    expect(rebound.keywords).toContain('rebound');
  });

  it('cascades past lands, casts the first lower-mana-value nonland, and bottoms the rest randomly', () => {
    const ctx = pod();
    const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
    player.library.length = 0;

    const drawCard = oracle({
      name: 'Cascade Draw',
      typeLine: 'Sorcery',
      manaCost: '{1}',
      oracleText: 'Draw a card.',
    });
    const hit = oracle({
      name: 'Cascade Hit',
      typeLine: 'Sorcery',
      manaCost: '{2}',
      oracleText: 'Draw a card.',
    });
    const sourceCard = oracle({
      name: 'Cascade Source',
      typeLine: 'Creature — Test',
      manaCost: '{4}',
      oracleText: 'Cascade',
    });
    conjure(ctx, 'P1', drawCard, 'library');
    conjure(ctx, 'P1', hit, 'library');
    conjure(ctx, 'P1', forest(), 'library');
    const sourceDef = registerDef(ctx, sourceCard);

    const { decisions } = pump(
      executeAbility(
        ctx,
        { cardId: 'source-card', name: sourceCard.name, oracleId: sourceDef.oracleId, controllerId: 'P1' },
        { kind: 'triggered', targets: [], effects: [{ op: 'cascade' }] },
        [],
        undefined,
        { spellManaValue: 4 },
      ),
      (decision) => ({
        index: decision.options.findIndex((option) => option.type === 'castFree'),
        targets: new Map(),
      }),
    );

    expect(decisions.some((decision) => decision.prompt.includes('Cascade hit'))).toBe(true);
    expect(ctx.state.stack.map((entry) => entry.description)).toEqual(['Cascade Hit']);
    expect(player.graveyard).toHaveLength(0);
    pump(resolveTopOfStack(ctx));
    expect(player.graveyard.map((card) => card.name)).toContain('Cascade Hit');
    expect(player.hand.map((card) => card.name)).toContain('Cascade Draw');
    expect(player.library).toHaveLength(1);
    expect(player.library[0]?.name).toBe('Forest');
    expect(ctx.state.exile).toHaveLength(0);
  });

  it('exiles a resolving hand-cast Rebound spell and offers one optional next-upkeep cast', () => {
    const ctx = pod();
    const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
    player.library.length = 0;
    const drawCard = oracle({
      name: 'Rebound Draw',
      typeLine: 'Creature — Test',
      oracleText: '',
    });
    conjure(ctx, 'P1', drawCard, 'library');

    const reboundCard = oracle({
      name: 'Rebound Spell',
      typeLine: 'Sorcery',
      manaCost: '{2}',
      oracleText: 'Draw a card.' + String.fromCharCode(10) + 'Rebound',
    });
    const def = registerDef(ctx, reboundCard);
    const card = conjure(ctx, 'P1', reboundCard, 'hand');
    removeFromCurrentZone(ctx, card);
    card.zone = 'stack';

    const spell: EngineStackObject = {
      id: 'rebound-stack',
      sourceId: card.id,
      controllerId: 'P1',
      kind: 'spell',
      description: card.name,
      targets: [],
      card,
      ability: def.spellAbility,
      sourceOracleId: card.oracleId,
      sourceCardId: card.cardId,
      isCommanderCast: false,
      reboundPending: true,
    };

    pump(finishSpellCard(ctx, spell));

    expect(player.hand).toHaveLength(0);
    expect(ctx.state.exile).toHaveLength(1);
    expect(ctx.state.exile[0]?.reboundCastBy).toBe('P1');
    expect(ctx.state.delayedTriggers).toHaveLength(1);

    queueStepTriggers(ctx, 'upkeep');
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    const pending = ctx.state.pendingTriggers[0]!;
    pump(
      executeAbility(
        ctx,
        { cardId: pending.sourceCardId, name: pending.sourceName, oracleId: pending.sourceOracleId, controllerId: pending.controllerId },
        pending.ability,
        [],
        pending.triggerObjectCardId,
        pending.scope,
      ),
    );

    expect(ctx.state.stack.map((entry) => entry.description)).toEqual(['Rebound Spell']);
    expect(ctx.state.exile).toHaveLength(0);
    pump(resolveTopOfStack(ctx));
    expect(player.hand.map((entry) => entry.name)).toContain('Rebound Draw');
    expect(player.graveyard.map((entry) => entry.name)).toContain('Rebound Spell');
    expect(ctx.state.exile).toHaveLength(0);
  });

  it('closes the one-shot Rebound permission when its controller declines', () => {
    const ctx = pod('rebound-decline');
    const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
    const reboundCard = oracle({
      name: 'Rebound Spell',
      typeLine: 'Sorcery',
      manaCost: '{2}',
      oracleText: 'Draw a card.' + String.fromCharCode(10) + 'Rebound',
    });
    const def = registerDef(ctx, reboundCard);
    const card = conjure(ctx, 'P1', reboundCard, 'hand');
    removeFromCurrentZone(ctx, card);
    card.zone = 'stack';
    pump(finishSpellCard(ctx, {
      id: 'rebound-stack',
      sourceId: card.id,
      controllerId: 'P1',
      kind: 'spell',
      description: card.name,
      targets: [],
      card,
      ability: def.spellAbility,
      sourceOracleId: card.oracleId,
      sourceCardId: card.cardId,
      isCommanderCast: false,
      reboundPending: true,
    }));

    queueStepTriggers(ctx, 'upkeep');
    const pending = ctx.state.pendingTriggers[0]!;
    pump(
      executeAbility(
        ctx,
        { cardId: pending.sourceCardId, name: pending.sourceName, oracleId: pending.sourceOracleId, controllerId: pending.controllerId },
        pending.ability,
        [],
        pending.triggerObjectCardId,
        pending.scope,
      ),
      (decision) => ({
        index: decision.options.findIndex((option) => option.type === 'decline'),
        targets: new Map(),
      }),
    );

    expect(ctx.state.exile[0]?.reboundCastBy).toBeUndefined();
    expect(ctx.state.stack).toHaveLength(0);
    expect(
      computePriorityOptions(ctx, player).some((option) => option.description.includes('Rebound Spell')),
    ).toBe(false);
  });

  it('holds the Rebound cast for the controller own next upkeep, across the intervening cleanup', () => {
    // CR 702.88a: "at the beginning of YOUR NEXT upkeep" — a later turn. The delayed trigger has
    // to survive this turn's cleanup (a turn-scoped expiry would sweep it before it ever fires)
    // and must not fire on the next player's upkeep instead.
    const ctx = pod();
    const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
    player.library.length = 0;
    conjure(ctx, 'P1', oracle({ name: 'Rebound Draw', typeLine: 'Creature — Test', oracleText: '' }), 'library');

    const reboundCard = oracle({
      name: 'Rebound Spell',
      typeLine: 'Sorcery',
      manaCost: '{2}',
      oracleText: 'Draw a card.' + String.fromCharCode(10) + 'Rebound',
    });
    const def = registerDef(ctx, reboundCard);
    const card = conjure(ctx, 'P1', reboundCard, 'hand');
    removeFromCurrentZone(ctx, card);
    card.zone = 'stack';
    pump(
      finishSpellCard(ctx, {
        id: 'rebound-stack',
        sourceId: card.id,
        controllerId: 'P1',
        kind: 'spell',
        description: card.name,
        targets: [],
        card,
        ability: def.spellAbility,
        sourceOracleId: card.oracleId,
        sourceCardId: card.cardId,
        isCommanderCast: false,
        reboundPending: true,
      }),
    );
    expect(ctx.state.delayedTriggers).toHaveLength(1);

    // The cleanup step of the turn the spell resolved on.
    ctx.state.delayedTriggers = ctx.state.delayedTriggers.filter((dt) => dt.expiry !== 'cleanup');
    expect(ctx.state.delayedTriggers).toHaveLength(1);

    // An opponent's upkeep is not "your next upkeep".
    ctx.state.currentTurnPlayer = 'P2';
    queueStepTriggers(ctx, 'upkeep');
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    expect(ctx.state.delayedTriggers).toHaveLength(1);

    // The controller's own upkeep fires it, exactly once.
    ctx.state.currentTurnPlayer = 'P1';
    queueStepTriggers(ctx, 'upkeep');
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    expect(ctx.state.delayedTriggers).toHaveLength(0);
  });
});
