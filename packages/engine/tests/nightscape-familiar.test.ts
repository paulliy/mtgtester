import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import {
  computePriorityOptions,
  costReductionFor,
  type PriorityActionPayload,
} from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { executeAbility } from '../src/effects/resolve';
import { priorityCheckpoint } from '../src/sba/sba';
import { resolveTopOfStack } from '../src/stack/stack';
import { expireRegenerationShields, moveObject } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

interface PinnedFixture {
  cards: { card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/reviewed-five-oracle.json'), 'utf8'),
) as PinnedFixture;
const nightscape = fixture.cards.find(({ card }) => card.name === 'Nightscape Familiar')!.card;

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

function source(nightscapeId: string) {
  return {
    cardId: nightscapeId,
    oracleId: nightscape.oracleId,
    name: nightscape.name,
    controllerId: 'P1' as const,
  };
}

function destroy(ctx: GameContext, targetId: string, cantRegenerate = false): void {
  pump(
    executeAbility(
      ctx,
      source('destroy-source'),
      {
        kind: 'spell',
        targets: [{ kind: 'creature' }],
        effects: [{ op: 'destroy', target: 0, cantRegenerate }],
      },
      [targetId],
    ),
  );
}

describe('Nightscape Familiar regeneration', () => {
  it('models both Oracle clauses for real and fixture IDs without a no-op', () => {
    for (const card of [
      nightscape,
      { ...nightscape, oracleId: fixtureOracleId(nightscape.name) },
    ]) {
      const def = interpretCard(card);
      expect(def.modeled, card.oracleId).toBe(true);
      expect(def.unmodeledReasons, card.oracleId).toEqual([]);
      expect(def.ruleStatics).toHaveLength(1);
      expect(def.activatedAbilities[0]?.ability.effects).toEqual([
        { op: 'regenerate', target: 'source' },
      ]);
    }
  });

  it('nightscape-regenerate-next-destroy — consumes one shield, taps, clears damage, and removes combat', () => {
    const ctx = pod('nightscape-destroy');
    const familiar = spawn(ctx, 'P1', nightscape);
    const blocker = spawn(
      ctx,
      'P2',
      oracle({ name: 'Blocking Bear', typeLine: 'Creature — Bear' }),
    );
    familiar.attacking = 'P2';
    familiar.blockedByOrdered = [blocker.id];
    blocker.blocking = familiar.id;
    familiar.damageMarked = 1;
    familiar.regenerationShields = 1;

    destroy(ctx, familiar.id);

    expect(ctx.state.battlefield).toContain(familiar);
    expect(familiar.regenerationShields).toBe(0);
    expect(familiar.damageMarked).toBe(0);
    expect(familiar.tapped).toBe(true);
    expect(familiar.attacking).toBeNull();
    expect(familiar.blockedByOrdered).toEqual([]);
    expect(blocker.blocking).toBeNull();
  });

  it('nightscape-regeneration-consumed — protects only the next destruction', () => {
    const ctx = pod('nightscape-one-shot');
    const familiar = spawn(ctx, 'P1', nightscape);
    familiar.regenerationShields = 1;
    destroy(ctx, familiar.id);
    expect(ctx.state.battlefield).toContain(familiar);
    destroy(ctx, familiar.id);
    expect(ctx.state.battlefield).not.toContain(familiar);
    expect(ctx.state.players[0]!.graveyard).toHaveLength(1);
  });

  it('nightscape-regeneration-expires — clears unused shields at cleanup', () => {
    const ctx = pod('nightscape-expiry');
    const familiar = spawn(ctx, 'P1', nightscape);
    familiar.regenerationShields = 2;
    expireRegenerationShields(ctx);
    expect(familiar.regenerationShields).toBe(0);
    destroy(ctx, familiar.id);
    expect(ctx.state.battlefield).not.toContain(familiar);
  });

  it('nightscape-sacrifice-not-prevented — and exile-not-prevented bypass shields', () => {
    const sacrificeCtx = pod('nightscape-sacrifice');
    const sacrificed = spawn(sacrificeCtx, 'P1', nightscape);
    sacrificed.regenerationShields = 1;
    pump(
      executeAbility(
        sacrificeCtx,
        source('sacrifice-source'),
        {
          kind: 'spell',
          targets: [{ kind: 'creature' }],
          effects: [{ op: 'sacrifice', target: 0 }],
        },
        [sacrificed.id],
      ),
    );
    expect(sacrificeCtx.state.battlefield).not.toContain(sacrificed);

    const exileCtx = pod('nightscape-exile');
    const exiled = spawn(exileCtx, 'P1', nightscape);
    exiled.regenerationShields = 1;
    pump(
      executeAbility(
        exileCtx,
        source('exile-source'),
        {
          kind: 'spell',
          targets: [{ kind: 'creature' }],
          effects: [{ op: 'exile', target: 0 }],
        },
        [exiled.id],
      ),
    );
    expect(exileCtx.state.battlefield).not.toContain(exiled);
    expect(exileCtx.state.exile.some((card) => card.cardId === exiled.cardId)).toBe(true);
  });

  it('nightscape-zero-toughness-not-prevented — ignores regeneration shields', () => {
    const ctx = pod('nightscape-zero-toughness');
    const familiar = spawn(ctx, 'P1', nightscape);
    familiar.regenerationShields = 1;
    familiar.counters['-1/-1'] = 1;
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield).not.toContain(familiar);
  });

  it('nightscape-cant-regenerate — bypasses but does not consume the shield', () => {
    const ctx = pod('nightscape-cant-regenerate');
    const familiar = spawn(ctx, 'P1', nightscape);
    familiar.regenerationShields = 1;
    destroy(ctx, familiar.id, true);
    expect(ctx.state.battlefield).not.toContain(familiar);
    expect(familiar.regenerationShields).toBe(1);
  });

  it('nightscape-blue-red-cost-reduction — reduces generic costs only for blue or red spells', () => {
    const ctx = pod('nightscape-reduction');
    spawn(ctx, 'P1', nightscape);
    const blue = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Blue Spell',
        typeLine: 'Sorcery',
        manaCost: '{2}{U}',
        colors: ['U'],
      }),
      'hand',
    );
    const red = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Red Spell',
        typeLine: 'Sorcery',
        manaCost: '{2}{R}',
        colors: ['R'],
      }),
      'hand',
    );
    const black = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Black Spell',
        typeLine: 'Sorcery',
        manaCost: '{2}{B}',
        colors: ['B'],
      }),
      'hand',
    );
    expect(costReductionFor(ctx, 'P1', blue.oracleId, blue.cardId).generic).toBe(1);
    expect(costReductionFor(ctx, 'P1', red.oracleId, red.cardId).generic).toBe(1);
    expect(costReductionFor(ctx, 'P1', black.oracleId, black.cardId).generic).toBe(0);
  });

  it('nightscape-normal-activation — uses legality, mana payment, stack, and resolution', () => {
    const ctx = pod('nightscape-normal-activation');
    const player = ctx.state.players[0]!;
    const familiar = spawn(ctx, 'P1', nightscape);
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', oracle({ name: 'Swamp', typeLine: 'Basic Land — Swamp' }));
    const option = computePriorityOptions(ctx, player).find((candidate) => {
      const payload = candidate.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === familiar.id;
    });
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(familiar.regenerationShields).toBe(0);
    expect(ctx.state.stack.at(-1)?.kind).toBe('activatedAbility');
    pump(resolveTopOfStack(ctx));
    expect(familiar.regenerationShields).toBe(1);
  });

  it('zone changes discard shields with the old object', () => {
    const ctx = pod('nightscape-zone-change');
    const familiar = spawn(ctx, 'P1', nightscape);
    familiar.regenerationShields = 1;
    const moved = pump(moveObject(ctx, familiar, { zone: 'graveyard' })).value;
    expect(moved?.zone).toBe('graveyard');
    expect(ctx.state.battlefield).not.toContain(familiar);
  });
});
