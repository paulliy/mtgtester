import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ObjectId, OracleCard, PlayerId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import type { EngineActionOption } from '../src/decisions';
import { computeCharacteristics } from '../src/effects/continuous';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import { queueCastTriggers, queueTriggersForObject } from '../src/state/objects';
import type { EngineCardObject, EngineStackObject, GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

interface PinnedFixture {
  cards: { card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/reviewed-five-oracle.json'), 'utf8'),
) as PinnedFixture;
const harmonic = fixture.cards.find(({ card }) => card.name === 'Harmonic Prodigy')!.card;

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

function triggeredCreature(name: string, subtype: string): OracleCard {
  return oracle({
    name,
    typeLine: `Creature — ${subtype}`,
    manaCost: '{1}{U}',
    power: '2',
    toughness: '2',
    oracleText: 'When this creature enters, draw a card.',
  });
}

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

function castEvent(ctx: GameContext, playerId: PlayerId, card: OracleCard): void {
  queueCastTriggers(ctx, stackSpell(conjure(ctx, playerId, card, 'exile'), playerId));
}

describe('Harmonic Prodigy', () => {
  it('models both pinned Oracle clauses for real and fixture IDs', () => {
    for (const card of [harmonic, { ...harmonic, oracleId: fixtureOracleId(harmonic.name) }]) {
      const def = interpretCard(card);
      expect(def.modeled, card.oracleId).toBe(true);
      expect(def.unmodeledReasons, card.oracleId).toEqual([]);
      expect(def.ruleStatics).toContainEqual({
        kind: 'triggerAdditionalForShamanOrOtherWizard',
      });
      expect(def.triggers[0]?.trigger).toMatchObject({
        when: 'castsSpell',
        caster: 'you',
      });
    }
  });

  it('harmonic-prowess-noncreature-only — triggers for noncreature but not creature spells', () => {
    const ctx = pod('harmonic-prowess-filter');
    spawn(ctx, 'P1', harmonic);
    castEvent(ctx, 'P1', oracle({ name: 'Test Instant', typeLine: 'Instant', manaCost: '{0}' }));
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    ctx.state.pendingTriggers = [];

    castEvent(ctx, 'P1', triggeredCreature('Test Creature', 'Bear'));
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });

  it('harmonic-own-shaman-trigger-doubled — queues and resolves the trigger twice', () => {
    const ctx = pod('harmonic-shaman');
    spawn(ctx, 'P1', harmonic);
    const shaman = spawn(ctx, 'P1', triggeredCreature('Entry Shaman', 'Shaman'));
    const handBefore = ctx.state.players[0]!.hand.length;

    queueTriggersForObject(ctx, 'enters', shaman);
    expect(ctx.state.pendingTriggers).toHaveLength(2);
    pump(runPrioritySequence(ctx));
    expect(ctx.state.players[0]!.hand).toHaveLength(handBefore + 2);
  });

  it('harmonic-other-own-wizard-trigger-doubled — but own Wizard prowess is not self-doubled', () => {
    const ctx = pod('harmonic-wizard-and-self');
    const prodigy = spawn(ctx, 'P1', harmonic);
    const wizard = spawn(ctx, 'P1', triggeredCreature('Entry Wizard', 'Wizard'));
    queueTriggersForObject(ctx, 'enters', wizard);
    expect(ctx.state.pendingTriggers).toHaveLength(2);
    ctx.state.pendingTriggers = [];

    castEvent(ctx, 'P1', oracle({ name: 'Prowess Instant', typeLine: 'Instant', manaCost: '{0}' }));
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    const { decisions } = pump(runPrioritySequence(ctx));
    // Prowess is mandatory: nothing asks "use it?" before the pump.
    expect(decisions.map((decision) => decision.decisionType)).not.toContain('optionalTrigger');
    expect(computeCharacteristics(ctx, prodigy)).toMatchObject({ power: 2, toughness: 4 });
  });

  it('harmonic-ineligible-and-opponent-sources — are not doubled', () => {
    const ctx = pod('harmonic-ineligible');
    spawn(ctx, 'P1', harmonic);
    const soldier = spawn(ctx, 'P1', triggeredCreature('Entry Soldier', 'Soldier'));
    queueTriggersForObject(ctx, 'enters', soldier);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    ctx.state.pendingTriggers = [];

    const opposingShaman = spawn(ctx, 'P2', triggeredCreature('Opposing Shaman', 'Shaman'));
    queueTriggersForObject(ctx, 'enters', opposingShaman);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
  });

  it('harmonic-multiple-effects-exact-count — adds one copy per Prodigy without recursion', () => {
    const ctx = pod('harmonic-multiple');
    spawn(ctx, 'P1', harmonic);
    spawn(ctx, 'P1', harmonic);
    const shaman = spawn(ctx, 'P1', triggeredCreature('Many-Echo Shaman', 'Shaman'));

    queueTriggersForObject(ctx, 'enters', shaman);
    expect(ctx.state.pendingTriggers).toHaveLength(3);
    ctx.state.pendingTriggers = [];

    castEvent(ctx, 'P1', oracle({ name: 'Shared Instant', typeLine: 'Instant', manaCost: '{0}' }));
    // Each Prodigy's prowess is doubled only by the other Prodigy: two triggers per source.
    expect(ctx.state.pendingTriggers).toHaveLength(4);
  });

  it('harmonic-normal-cast — resolves through normal mana, legality, and stack paths', () => {
    const ctx = pod('harmonic-cast');
    const player = ctx.state.players[0]!;
    const spell = conjure(ctx, 'P1', harmonic, 'hand');
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', oracle({ name: 'Mountain', typeLine: 'Basic Land — Mountain' }));
    const isCast = (option: EngineActionOption): boolean => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === spell.id;
    };

    const cast = computePriorityOptions(ctx, player).find(isCast);
    expect(cast).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, cast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === spell.cardId)).toBe(true);
  });
});
