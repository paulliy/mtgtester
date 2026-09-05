import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { computeCharacteristics } from '../src/effects/continuous';
import { createGame } from '../src/state/game';
import { landPlayLimitFor, manaSourcesFor } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

function pod(seed: string): GameContext {
  const ctx = createGame(gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })), { seed }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const exploration = oracle({
  name: 'Test Exploration',
  typeLine: 'Enchantment',
  manaCost: '{G}',
  oracleText: 'You may play an additional land on each of your turns.',
});

const grandAbolisher = oracle({
  name: 'Test Grand Abolisher',
  typeLine: 'Creature — Human Cleric',
  manaCost: '{W}{W}',
  power: '2',
  toughness: '2',
  oracleText: "During your turn, your opponents can't cast spells or activate abilities of artifacts, creatures, or enchantments.",
});

const songOfTheDryads = oracle({
  name: 'Test Song of the Dryads',
  typeLine: 'Enchantment — Aura',
  manaCost: '{2}{G}',
  oracleText: 'Enchant permanent\nEnchanted permanent is a colorless Forest land.',
});

describe('Tier 3 zone and rule statics', () => {
  it('evaluates additional land drops as Values and offers the second land play', () => {
    const ctx = pod('tier3-additional-land');
    spawn(ctx, 'P1', exploration);
    const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
    const first = conjure(ctx, 'P1', forest(), 'hand');
    const second = conjure(ctx, 'P1', forest(), 'hand');

    expect(landPlayLimitFor(ctx, 'P1')).toBe(2);
    const firstOption = computePriorityOptions(ctx, player).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'playLand' && payload.objectId === first.id;
    });
    expect(firstOption).toBeDefined();
    pump(applyPriorityAction(ctx, player, firstOption!.payload as PriorityActionPayload, { index: 0, targets: new Map() }));

    const secondOption = computePriorityOptions(ctx, player).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'playLand' && payload.objectId === second.id;
    });
    expect(player.landsPlayedThisTurn).toBe(1);
    expect(secondOption).toBeDefined();
  });

  it('blocks matching opponent activations only during the source controller turn', () => {
    const ctx = pod('tier3-activation-lock');
    spawn(ctx, 'P1', grandAbolisher);
    const source = spawn(ctx, 'P2', oracle({
      name: 'Test Drawing Idol',
      typeLine: 'Artifact',
      manaCost: '{1}',
      oracleText: '{T}: Draw a card.',
    }));
    const opponent = ctx.state.players.find((candidate) => candidate.id === 'P2')!;

    expect(computePriorityOptions(ctx, opponent).some((option) =>
      option.type === 'activateAbility' &&
      (option.payload as PriorityActionPayload).kind === 'activateAbility' &&
      (option.payload as Extract<PriorityActionPayload, { kind: 'activateAbility' }>).objectId === source.id,
    )).toBe(false);

    ctx.state.currentTurnPlayer = 'P2';
    expect(computePriorityOptions(ctx, opponent).some((option) =>
      option.type === 'activateAbility' &&
      (option.payload as PriorityActionPayload).kind === 'activateAbility' &&
      (option.payload as Extract<PriorityActionPayload, { kind: 'activateAbility' }>).objectId === source.id,
    )).toBe(true);
  });

  it('sets the enchanted permanent to a colorless Forest and derives green mana', () => {
    const ctx = pod('tier3-basic-land-type');
    const target = spawn(ctx, 'P2', oracle({
      name: 'Test Relic',
      typeLine: 'Artifact',
      manaCost: '{2}',
      oracleText: '{T}: Add {C}.',
    }));
    const aura = spawn(ctx, 'P1', songOfTheDryads);
    aura.attachedTo = target.id;

    const chars = computeCharacteristics(ctx, target);
    expect(chars.types).toEqual(['Land']);
    expect(chars.subtypes).toEqual(['Forest']);
    expect(chars.colors).toEqual([]);
    expect(chars.manaAbilities).toEqual([{ units: [['G']] }]);
    expect(manaSourcesFor(ctx, 'P2').find((source) => source.cardId === target.cardId)?.units).toEqual([['G']]);
  });

  it('tracks Muldrotha permission once per permanent type and preserves multitype choice', () => {
    const ctx = pod('tier3-muldrotha-budget');
    const muldrotha = oracle({
      name: 'Test Muldrotha',
      typeLine: 'Legendary Creature \u2014 Elemental Avatar',
      manaCost: '{3}{B}{G}{U}',
      power: '6',
      toughness: '6',
      oracleText: 'During each of your turns, you may play a land and cast a permanent spell of each permanent type from your graveyard.',
    });
    const muldrothaPermanent = spawn(ctx, 'P1', muldrotha);
    expect(ctx.defs.get(muldrothaPermanent.oracleId)?.ruleStatics).toEqual([expect.objectContaining({
      kind: 'playFromZone',
      zone: 'graveyard',
      yourTurnOnly: true,
      permanentTypeBudget: 1,
    })]);
    const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
    const hybrid = conjure(ctx, 'P1', oracle({
      name: 'Test Hybrid Relic',
      typeLine: 'Artifact Creature \u2014 Construct',
      manaCost: '{0}',
      power: '1',
      toughness: '1',
      oracleText: '',
    }), 'graveyard');
    const artifact = conjure(ctx, 'P1', oracle({
      name: 'Test Spare Relic',
      typeLine: 'Artifact',
      manaCost: '{0}',
      oracleText: '',
    }), 'graveyard');
    const creature = conjure(ctx, 'P1', oracle({
      name: 'Test Spare Creature',
      typeLine: 'Creature \u2014 Bear',
      manaCost: '{0}',
      power: '2',
      toughness: '2',
      oracleText: '',
    }), 'graveyard');

    const hybridOptions = computePriorityOptions(ctx, player).filter((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === hybrid.id;
    });
    expect(hybridOptions.map((option) =>
      (option.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>).zoneBudgetType,
    )).toEqual(['Artifact', 'Creature']);

    const artifactChoice = hybridOptions.find((option) =>
      (option.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>).zoneBudgetType === 'Artifact',
    )!;
    pump(applyPriorityAction(ctx, player, artifactChoice.payload as PriorityActionPayload, { index: 0, targets: new Map() }));
    expect(player.playFromZoneTypeUsesThisTurn).toEqual({ Artifact: 1 });

    ctx.state.stack = [];
    const remaining = computePriorityOptions(ctx, player);
    expect(remaining.some((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === artifact.id;
    })).toBe(false);
    expect(remaining.some((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === creature.id && payload.zoneBudgetType === 'Creature';
    })).toBe(true);

    ctx.state.currentTurnPlayer = 'P2';
    expect(computePriorityOptions(ctx, player).some((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.fromGraveyard === true && payload.alternativeCast === undefined;
    })).toBe(false);
  });

});
