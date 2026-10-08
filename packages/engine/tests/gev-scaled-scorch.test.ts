import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ObjectId, OracleCard, PlayerId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import {
  computePriorityOptions,
  computeTargetOptions,
  type PriorityActionPayload,
} from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import type { EngineActionOption } from '../src/decisions';
import { executeAbility } from '../src/effects/resolve';
import { priorityCheckpoint } from '../src/sba/sba';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import { queueCastTriggers } from '../src/state/objects';
import type { EngineCardObject, EngineStackObject, GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

interface PinnedFixture {
  cards: { card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/reviewed-five-oracle.json'), 'utf8'),
) as PinnedFixture;
const gev = fixture.cards.find(({ card }) => card.name === 'Gev, Scaled Scorch')!.card;

function pod(seed: string, seats = 2): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: seats }, () => ({ cards: copies(8, forest) })),
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

function zeroManaRemoval(): OracleCard {
  return oracle({
    name: 'Ward Test Removal',
    typeLine: 'Instant',
    manaCost: '{0}',
    oracleText: 'Destroy target creature.',
  });
}

function castTargeting(ctx: GameContext, casterId: PlayerId, targetId: ObjectId): EngineCardObject {
  const player = ctx.state.players.find(({ id }) => id === casterId)!;
  const spell = conjure(ctx, casterId, zeroManaRemoval(), 'hand');
  const isSpell = (option: EngineActionOption): boolean => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === spell.id;
  };
  const option = computePriorityOptions(ctx, player).find(isSpell);
  expect(option).toBeDefined();
  pump(
    applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map([[0, targetId]]),
    }),
  );
  return spell;
}

function resolveWard(ctx: GameContext, choice: 'payCost' | 'decline'): { decisions: number } {
  pump(priorityCheckpoint(ctx));
  const result = pump(resolveTopOfStack(ctx), (decision) => ({
    index: decision.options.findIndex((option) => option.type === choice),
    targets: new Map(),
  }));
  return { decisions: result.decisions.length };
}

describe('Gev, Scaled Scorch', () => {
  it('models every pinned Oracle clause for real and fixture IDs', () => {
    for (const card of [gev, { ...gev, oracleId: fixtureOracleId(gev.name) }]) {
      const def = interpretCard(card);
      expect(def.modeled, card.oracleId).toBe(true);
      expect(def.unmodeledReasons, card.oracleId).toEqual([]);
      expect(def.ward).toEqual({ kind: 'life', amount: 2 });
      expect(def.additionalCountersOnEntry).toHaveLength(1);
      expect(def.triggers).toHaveLength(1);
    }
  });

  it.each([
    ['gev-ward-pay-life', 10, 'payCost', 8, true, 1, false],
    ['gev-ward-pay-exact-life', 2, 'payCost', 0, true, 1, false],
    ['gev-ward-decline', 10, 'decline', 10, false, 1, false],
    ['gev-ward-insufficient-life', 1, 'payCost', 1, false, 0, false],
    ['gev-ward-protected-life-floor', 2, 'payCost', 0, true, 1, true],
  ] as const)(
    '%s applies the life payment and counter outcome',
    (_id, life, choice, expectedLife, spellRemains, decisions, lifeFloor) => {
      const ctx = pod(`gev-ward-${life}-${choice}`);
      ctx.state.currentTurnPlayer = 'P2';
      ctx.state.activePlayerIndex = 1;
      ctx.state.players[1]!.life = life;
      ctx.state.lifeFloorPlayers['P2'] = lifeFloor;
      const permanent = spawn(ctx, 'P1', gev);

      const spell = castTargeting(ctx, 'P2', permanent.id);
      expect(ctx.state.pendingTriggers).toHaveLength(1);
      expect(resolveWard(ctx, choice).decisions).toBe(decisions);
      expect(ctx.state.players[1]!.life).toBe(expectedLife);
      expect(ctx.state.stack.some((entry) => entry.sourceCardId === spell.cardId)).toBe(
        spellRemains,
      );
      if (!spellRemains) {
        expect(ctx.state.players[1]!.graveyard.some((card) => card.cardId === spell.cardId)).toBe(
          true,
        );
      }
    },
  );

  it('gev-own-spell-no-ward and low-life legality keep targeting separate from payment', () => {
    const own = pod('gev-own-target');
    const ownGev = spawn(own, 'P1', gev);
    castTargeting(own, 'P1', ownGev.id);
    expect(own.state.pendingTriggers).toHaveLength(0);

    const opponent = pod('gev-low-life-target');
    opponent.state.currentTurnPlayer = 'P2';
    opponent.state.activePlayerIndex = 1;
    opponent.state.players[1]!.life = 1;
    const opposingGev = spawn(opponent, 'P1', gev);
    const spell = conjure(opponent, 'P2', zeroManaRemoval(), 'hand');
    const cast = computePriorityOptions(opponent, opponent.state.players[1]!).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === spell.id;
    });
    expect(cast).toBeDefined();
    expect(cast!.targets?.find(({ slot }) => slot === 0)?.options.includes(opposingGev.id)).toBe(
      true,
    );
  });

  it('gev-lizard-opponent-target-only triggers only for your Lizard and damages an opponent', () => {
    const ctx = pod('gev-lizard', 3);
    const source = spawn(ctx, 'P1', gev);
    const trigger = interpretCard(gev).triggers![0]!;
    expect(computeTargetOptions(ctx, trigger.targets[0]!, 'P1')).toEqual(['P2', 'P3']);

    const lifeBefore = ctx.state.players[1]!.life;
    pump(executeAbility(ctx, source, trigger, ['P2']));
    expect(ctx.state.players[1]!.life).toBe(lifeBefore - 1);

    const lizard = conjure(
      ctx,
      'P1',
      oracle({ name: 'Test Lizard', typeLine: 'Creature — Lizard' }),
      'hand',
    );
    queueCastTriggers(ctx, stackSpell(lizard, 'P1'));
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    ctx.state.pendingTriggers = [];

    const bear = conjure(
      ctx,
      'P1',
      oracle({ name: 'Test Bear', typeLine: 'Creature — Bear' }),
      'hand',
    );
    queueCastTriggers(ctx, stackSpell(bear, 'P1'));
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });

  it('gev-entry-counters-opponents-lost-life counts each opponent once and excludes Gev', () => {
    const ctx = pod('gev-counters', 4);
    const source = spawn(ctx, 'P1', gev);
    expect(source.counters['+1/+1'] ?? 0).toBe(0);
    ctx.state.lifeLostThisTurn['P2'] = true;
    ctx.state.lifeLostThisTurn['P3'] = true;

    const other = spawn(
      ctx,
      'P1',
      oracle({ name: 'Entering Ally', typeLine: 'Creature — Lizard' }),
    );
    expect(other.counters['+1/+1']).toBe(2);
  });

  it('casts Gev through the normal mana, legality, stack, and resolution path', () => {
    const ctx = pod('gev-normal-cast');
    const player = ctx.state.players[0]!;
    const spell = conjure(ctx, 'P1', gev, 'hand');
    spawn(ctx, 'P1', oracle({ name: 'Swamp', typeLine: 'Basic Land — Swamp' }));
    spawn(ctx, 'P1', oracle({ name: 'Mountain', typeLine: 'Basic Land — Mountain' }));
    const option = computePriorityOptions(ctx, player).find((candidate) => {
      const payload = candidate.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === spell.id;
    });
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === spell.cardId)).toBe(true);
  });
});

function stackSpell(card: EngineCardObject, controllerId: PlayerId): EngineStackObject {
  return {
    id: `stack-${card.cardId}` as ObjectId,
    sourceId: card.id,
    controllerId,
    kind: 'spell',
    description: card.name,
    targets: [],
    card,
    ability: null,
    sourceOracleId: card.oracleId,
    sourceCardId: card.cardId,
    isCommanderCast: false,
  };
}
