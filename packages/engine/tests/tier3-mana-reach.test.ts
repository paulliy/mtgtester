import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { executeAbility, payManaCost } from '../src/effects/resolve';
import { evaluateValueIn } from '../src/effects/values';
import { parseManaCost } from '../src/mana/cost';
import { priorityCheckpoint } from '../src/sba/sba';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import { manaSourcesFor } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import { queueStepTriggers } from '../src/turn/turn';
import { conjure, copies, forest, gameConfig, oracle, pump, registerDef, spawn } from './fixtures';

const dash = String.fromCharCode(0x2014);
const nl = String.fromCharCode(10);

function pod(seed: string): GameContext {
  const ctx = createGame(gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(3, forest) })), { seed }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

describe('Tier 3 mana-system reach', () => {
  it('counts permanent colors and devotion pips', () => {
    const ctx = pod('tier3-mana-counts');
    const tender = spawn(ctx, 'P1', oracle({
      name: 'Test Bloom Tender',
      typeLine: `Creature ${dash} Elf Druid`,
      manaCost: '{1}{G}',
      colors: ['G'],
      colorIdentity: ['G'],
      power: '1',
      toughness: '1',
      oracleText: '{T}: For each color among permanents you control, add one mana of that color.',
    }));
    tender.enteredTurnNumber = 3;
    tender.summoningSick = false;
    spawn(ctx, 'P1', oracle({ name: 'White Devotee', typeLine: 'Enchantment', manaCost: '{W}{W}', colors: ['W'], colorIdentity: ['W'], oracleText: '' }));
    spawn(ctx, 'P1', oracle({ name: 'Dimir Devotee', typeLine: 'Enchantment', manaCost: '{U}{B}{B}', colors: ['U', 'B'], colorIdentity: ['U', 'B'], oracleText: '' }));
    spawn(ctx, 'P1', oracle({ name: 'Black Devotee', typeLine: 'Artifact', manaCost: '{2}{B}', colors: ['B'], colorIdentity: ['B'], oracleText: '' }));

    const source = manaSourcesFor(ctx, 'P1').find((candidate) => candidate.cardId === tender.cardId);
    expect(source?.units.map((unit) => unit[0]).sort()).toEqual(['B', 'G', 'U', 'W']);
    expect(evaluateValueIn(ctx, { kind: 'colorsAmongPermanents' }, { controllerId: 'P1' })).toBe(4);
    expect(evaluateValueIn(ctx, { kind: 'devotionTo', color: 'B' }, { controllerId: 'P1' })).toBe(3);
  });

  it('applies Wild Growth and Mirari\'s Wake riders inline to the same land activation', () => {
    const ctx = pod('tier3-mana-static-riders');
    const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
    const land = spawn(ctx, 'P1', forest());
    const growth = spawn(ctx, 'P1', oracle({
      name: 'Test Wild Growth',
      typeLine: `Enchantment ${dash} Aura`,
      manaCost: '{G}',
      oracleText: `Enchant land${nl}Whenever enchanted land is tapped for mana, its controller adds an additional {G}.`,
    }));
    growth.attachedTo = land.id;
    spawn(ctx, 'P1', oracle({
      name: 'Test Mirari Wake',
      typeLine: 'Enchantment',
      manaCost: '{3}{G}{W}',
      oracleText: 'Whenever you tap a land for mana, add one mana of any type that land produced.',
    }));

    const source = manaSourcesFor(ctx, 'P1').find((candidate) => candidate.cardId === land.cardId);
    expect(source?.units).toEqual([['G'], ['G'], ['G']]);
    pump(payManaCost(ctx, player, parseManaCost('{G}').cost!));
    expect(land.tapped).toBe(true);
    expect(player.manaEntries.map((entry) => entry.symbol)).toEqual(['G', 'G']);
    expect(ctx.state.stack).toHaveLength(0);
  });

  it('makes a legendary spell uncounterable when qualifying mana pays for it', () => {
    const ctx = pod('tier3-uncounterable-mana');
    const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
    const halfling = spawn(ctx, 'P1', oracle({
      name: 'Test Delighted Halfling',
      typeLine: `Creature ${dash} Halfling Citizen`,
      manaCost: '{G}',
      power: '1',
      toughness: '2',
      oracleText: `{T}: Add {C}.${nl}{T}: Add one mana of any color. Spend this mana only to cast a legendary spell, and that spell can't be countered.`,
    }));
    halfling.enteredTurnNumber = 3;
    halfling.summoningSick = false;
    const spell = conjure(ctx, 'P1', oracle({
      name: 'Test Legendary One',
      typeLine: `Legendary Creature ${dash} Elf`,
      manaCost: '{G}',
      power: '1',
      toughness: '1',
      oracleText: '',
    }), 'hand');
    const option = computePriorityOptions(ctx, player).find((candidate) => {
      const payload = candidate.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === spell.id;
    });
    expect(option).toBeDefined();
    pump(applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, { index: 0, targets: new Map() }));
    const stackSpell = ctx.state.stack.at(-1)!;
    expect(stackSpell.ability?.cantBeCountered).toBe(true);

    pump(executeAbility(ctx, {
      cardId: 'c-test-counter',
      oracleId: 'oracle-test-counter',
      name: 'Test Counter',
      controllerId: 'P2',
    }, { kind: 'spell', targets: [{ kind: 'spell' }], effects: [{ op: 'counter', target: 0 }] }, [stackSpell.id]));
    expect(ctx.state.stack.some((candidate) => candidate.id === stackSpell.id)).toBe(true);
  });

  it('tracks Treasure mana spent on a creature spell for Kalain entry counters', () => {
    const ctx = pod('tier3-kalain-treasure-payment');
    const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
    spawn(ctx, 'P1', oracle({
      oracleId: '4fca09ac-8134-43d9-a84b-686db5e2bf69',
      name: 'Kalain, Reclusive Painter',
      typeLine: `Legendary Creature ${dash} Human Elf Bard`,
      types: ['Creature'],
      subtypes: ['Human', 'Elf', 'Bard'],
      manaCost: '{B}{R}',
      colors: ['B', 'R'],
      colorIdentity: ['B', 'R'],
      power: '1',
      toughness: '2',
      oracleText: `When this creature enters, create a Treasure token.${nl}Other creatures you control enter with an additional +1/+1 counter on them for each mana from a Treasure spent to cast them.`,
    }));
    spawn(ctx, 'P1', oracle({
      name: 'Test Treasure',
      typeLine: `Token Artifact ${dash} Treasure`,
      types: ['Artifact'],
      subtypes: ['Treasure'],
      manaCost: null,
      oracleText: '{T}, Sacrifice this artifact: Add one mana of any color.',
    }));
    const creature = conjure(ctx, 'P1', oracle({
      name: 'Treasure-Funded Bear',
      typeLine: `Creature ${dash} Bear`,
      types: ['Creature'],
      subtypes: ['Bear'],
      manaCost: '{G}',
      colors: ['G'],
      colorIdentity: ['G'],
      power: '2',
      toughness: '2',
      oracleText: '',
    }), 'hand');

    const option = computePriorityOptions(ctx, player).find((candidate) => {
      const payload = candidate.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === creature.id;
    });
    expect(option).toBeDefined();
    pump(applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }));
    expect(ctx.state.stack.at(-1)?.card?.treasureManaSpentToCast).toBe(1);
    pump(resolveTopOfStack(ctx));

    const entered = ctx.state.battlefield.find((perm) => perm.cardId === creature.cardId);
    expect(entered?.counters['+1/+1']).toBe(1);
  });

  it('captures a countered spell mana value and adds that much colorless next main phase', () => {
    const ctx = pod('tier3-mana-drain');
    const drain = registerDef(ctx, oracle({
      name: 'Test Mana Drain',
      typeLine: 'Instant',
      manaCost: '{U}{U}',
      oracleText: `Counter target spell. At the beginning of your next main phase, add an amount of {C} equal to that spell's mana value.`,
    }));
    expect(drain.modeled, drain.unmodeledReasons.join('; ')).toBe(true);
    const targetCard = conjure(ctx, 'P2', oracle({
      name: 'Test Three Mana Spell',
      typeLine: 'Sorcery',
      manaCost: '{2}{U}',
      oracleText: 'Draw a card.',
    }), 'hand');
    const targetOwner = ctx.state.players.find((candidate) => candidate.id === 'P2')!;
    targetOwner.hand = targetOwner.hand.filter((card) => card.id !== targetCard.id);
    targetCard.zone = 'stack';
    ctx.state.stack.push({
      id: targetCard.id,
      sourceId: targetCard.id,
      controllerId: 'P2',
      kind: 'spell',
      description: targetCard.name,
      targets: [],
      card: targetCard,
      ability: { kind: 'spell', targets: [], effects: [{ op: 'draw', count: { kind: 'const', n: 1 } }] },
      sourceOracleId: targetCard.oracleId,
      sourceCardId: targetCard.cardId,
      isCommanderCast: false,
    });

    pump(executeAbility(ctx, {
      cardId: 'c-mana-drain',
      oracleId: drain.oracleId,
      name: drain.name,
      controllerId: 'P1',
    }, drain.spellAbility!, [targetCard.id]));
    expect(ctx.state.delayedTriggers).toHaveLength(1);
    expect(ctx.state.delayedTriggers[0]?.when).toBe('mainPhase');

    queueStepTriggers(ctx, 'mainPhase');
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.stack.at(-1)?.kind).toBe('triggeredAbility');
    pump(resolveTopOfStack(ctx));
    const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
    expect(player.manaEntries.map((entry) => entry.symbol)).toEqual(['C', 'C', 'C']);
  });
});
