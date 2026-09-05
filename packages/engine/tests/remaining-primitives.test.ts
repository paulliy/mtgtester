import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, costReductionFor } from '../src/actions/legal';
import type { PriorityActionPayload } from '../src/actions/legal';
import type { Ability } from '../src/cards/ability';
import { interpretCard } from '../src/cards/interpret';
import { computeCharacteristics } from '../src/effects/continuous';
import { endUntilEotEffects, executeAbility, payAbilityCosts } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { effectivePT } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

function pod(): GameContext {
  const ctx = createGame(gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(2, forest) })), { seed: 'remaining-primitives' }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 2;
  for (const player of ctx.state.players) conjure(ctx, player.id, forest(), 'library');
  return ctx;
}

const creature = (name: string, power: string, text = '') => oracle({
  name,
  typeLine: 'Creature — Test',
  manaCost: '{2}',
  power,
  toughness: power,
  oracleText: text,
});

const trazyn = () => oracle({
  oracleId: '1ef3b48a-55ef-4221-a0bc-e1c1057eec2c',
  name: 'Trazyn the Infinite',
  typeLine: 'Legendary Artifact Creature — Necron',
  supertypes: ['Legendary'],
  manaCost: '{4}{U}{B}',
  power: '4',
  toughness: '6',
  oracleText: 'As long as Trazyn the Infinite is on the battlefield, it has all activated abilities of all artifact cards in your graveyard.',
});

describe('ADR 0020 Phase 1 primitives', () => {
  it('Trazyn copies activated abilities from artifact cards and invalidates when the graveyard changes', () => {
    const ctx = pod();
    const artifact = oracle({
      name: 'Graveyard Relic',
      typeLine: 'Artifact',
      manaCost: '{2}',
      oracleText: '{T}: Draw a card.',
      power: null,
      toughness: null,
    });
    conjure(ctx, 'P1', artifact, 'graveyard');
    const source = spawn(ctx, 'P1', trazyn());

    expect(computeCharacteristics(ctx, source).activatedAbilities?.map((ability) => ability.ability.description)).toContain('{T}: Draw a card.');
    ctx.state.players[0]!.graveyard.length = 0;
    expect(computeCharacteristics(ctx, source).activatedAbilities).toEqual([]);
  });

  it('Necron Overlord exposes one X choice and one grouped artifact-tap cost', () => {
    const raw = oracle({
      oracleId: '2c0de95f-4269-439c-a1bc-faa11348b185',
      name: 'Necron Overlord',
      typeLine: 'Creature — Necron',
      manaCost: '{3}{B}',
      power: '3',
      toughness: '3',
      oracleText: 'Relentless March — {X}, {T}, Tap X untapped artifacts you control: Target opponent loses X life.',
    });
    const ability = interpretCard(raw).activatedAbilities[0];
    expect(ability?.costs).toEqual(expect.arrayContaining([
      { kind: 'tap' },
      { kind: 'tapXOthers', selector: expect.anything() },
    ]));
    expect(ability?.costs.some((cost) => cost.kind === 'mana' && cost.cost.x === 1)).toBe(true);
    expect(ability?.ability.effects).toContainEqual({ op: 'loseLifeTarget', target: 0, amount: { kind: 'xValue' } });
  });

  it('fight uses simultaneous printed/current power damage and waits for SBAs', () => {
    const ctx = pod();
    const first = spawn(ctx, 'P1', creature('First Fighter', '3'));
    const second = spawn(ctx, 'P2', creature('Second Fighter', '4'));
    pump(executeAbility(ctx, { cardId: first.cardId, oracleId: first.oracleId, name: first.name, controllerId: 'P1' }, {
      kind: 'activated', targets: [{ kind: 'creature' }, { kind: 'creature' }],
      effects: [{ op: 'fight', first: 0, second: 1 }],
    }, [first.id, second.id]));
    expect(first.damageMarked).toBe(4);
    expect(second.damageMarked).toBe(3);
    expect(ctx.state.battlefield).toContain(first);
    expect(ctx.state.battlefield).toContain(second);
  });

  it('parses and pays a sacrifice-another-artifact activation cost', () => {
    const ctx = pod();
    const raw = oracle({
      name: 'Test Foundry', typeLine: 'Artifact', manaCost: '{2}', power: null, toughness: null,
      oracleText: 'Sacrifice another artifact: Draw a card.',
    });
    const def = interpretCard(raw);
    expect(def.activatedAbilities[0]?.costs).toEqual([
      { kind: 'sacrificeOther', selector: { kind: 'allOf', of: [{ kind: 'controller', who: 'you' }, { kind: 'type', value: 'Artifact' }] } },
    ]);
    const source = spawn(ctx, 'P1', raw);
    const fodder = spawn(ctx, 'P1', oracle({ name: 'Test Servo', typeLine: 'Artifact Creature — Servo', manaCost: '{1}', power: '1', toughness: '1' }));
    pump(payAbilityCosts(ctx, ctx.state.players[0]!, source, def.activatedAbilities[0]!.costs, 'tap'));
    expect(ctx.state.battlefield).toContain(source);
    expect(ctx.state.battlefield).not.toContain(fodder);
    expect(ctx.state.players[0]!.graveyard.some((card) => card.cardId === fodder.cardId)).toBe(true);
  });

  it('doubles every existing counter kind on a target', () => {
    const ctx = pod();
    const target = spawn(ctx, 'P1', creature('Counter Bear', '2'));
    target.counters['+1/+1'] = 2;
    target.counters['charge'] = 3;
    pump(executeAbility(ctx, { cardId: 'double-source', oracleId: target.oracleId, name: 'Doubler', controllerId: 'P1' }, {
      kind: 'spell', targets: [{ kind: 'permanent' }], effects: [{ op: 'doubleCountersTarget', target: 0 }],
    }, [target.id]));
    expect(target.counters).toMatchObject({ '+1/+1': 4, charge: 6 });
  });

  it('becomes a printed-characteristics copy, then restores a temporary copy at cleanup', () => {
    const ctx = pod();
    const source = spawn(ctx, 'P1', creature('Shapeshifter', '1'));
    const target = spawn(ctx, 'P1', creature('Printed Giant', '5', 'Trample'));
    target.counters['+1/+1'] = 2;
    pump(executeAbility(ctx, { cardId: source.cardId, oracleId: source.oracleId, name: source.name, controllerId: 'P1' }, {
      kind: 'activated', targets: [{ kind: 'permanent' }], effects: [{ op: 'becomeCopyOf', ref: 0, untilEot: true }],
    }, [target.id]));
    expect(source.name).toBe('Printed Giant');
    expect(effectivePT(ctx, source)).toEqual({ power: 5, toughness: 5 });
    expect(computeCharacteristics(ctx, source).keywords).toContain('trample');
    endUntilEotEffects(ctx);
    expect(source.name).toBe('Shapeshifter');
    expect(effectivePT(ctx, source)).toEqual({ power: 1, toughness: 1 });
  });

  it('infect gives players poison and creatures -1/-1 counters instead of ordinary damage', () => {
    const ctx = pod();
    const infecter = spawn(ctx, 'P1', creature('Infecter', '2', 'Infect'));
    const victim = spawn(ctx, 'P2', creature('Victim', '3'));
    pump(executeAbility(ctx, { cardId: infecter.cardId, oracleId: infecter.oracleId, name: infecter.name, controllerId: 'P1' }, {
      kind: 'spell', targets: [{ kind: 'creature' }], effects: [{ op: 'fight', first: 'source', second: 0 }],
    }, [victim.id]));
    expect(victim.damageMarked).toBe(0);
    expect(victim.counters['-1/-1']).toBe(2);
    pump(executeAbility(ctx, { cardId: infecter.cardId, oracleId: infecter.oracleId, name: infecter.name, controllerId: 'P1' }, {
      kind: 'spell', targets: [], effects: [{ op: 'giveTargetPoisonCounters', target: 'eachOpponent', count: 1 }],
    }, []));
    expect(ctx.state.players.slice(1).map((player) => player.poisonCounters)).toEqual([1, 1, 1]);
  });

  it('Affinity for artifacts is a self-only dynamic cost reduction', () => {
    const ctx = pod();
    spawn(ctx, 'P1', oracle({ name: 'Rock One', typeLine: 'Artifact', manaCost: '{1}', power: null, toughness: null }));
    spawn(ctx, 'P1', oracle({ name: 'Rock Two', typeLine: 'Artifact', manaCost: '{1}', power: null, toughness: null }));
    const affinity = oracle({ name: 'Affinity Test', typeLine: 'Artifact Creature — Construct', manaCost: '{6}', power: '3', toughness: '3', oracleText: 'Affinity for artifacts' });
    const object = conjure(ctx, 'P1', affinity, 'hand');
    const def = interpretCard(affinity);
    expect(def.modeled).toBe(true);
    expect(def.ruleStatics[0]).toMatchObject({ kind: 'costReduction', selfOnly: true });
    expect(costReductionFor(ctx, 'P1', object.oracleId, object.cardId).generic).toBe(2);
  });

  it('parses choose-one-or-more as a ranged announcement-time modal spell', () => {
    const def = interpretCard(oracle({
      name: 'Flexible Command', typeLine: 'Sorcery', manaCost: '{2}', power: null, toughness: null,
      oracleText: 'Choose one or more —\n• Target player gets a poison counter.\n• Untap target permanent.',
    }));
    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.modes).toMatchObject({ minChoices: 1, maxChoices: 2 });
  });
  it('Station taps another creature, snapshots its power, and gates threshold abilities', () => {
    const ctx = pod();
    const raw = oracle({
      name: 'Test Research Craft', typeLine: 'Artifact', manaCost: '{3}', power: null, toughness: null,
      oracleText: 'Station\n3+ | Flying',
    });
    const def = interpretCard(raw);
    const craft = spawn(ctx, 'P1', raw);
    const crew = spawn(ctx, 'P1', creature('Station Crew', '4'));
    expect(computeCharacteristics(ctx, craft).keywords).not.toContain('flying');
    const payment = pump(payAbilityCosts(ctx, ctx.state.players[0]!, craft, def.activatedAbilities[0]!.costs, 'tap'));
    expect(crew.tapped).toBe(true);
    pump(executeAbility(
      ctx,
      { cardId: craft.cardId, oracleId: craft.oracleId, name: craft.name, controllerId: 'P1' },
      def.activatedAbilities[0]!.ability,
      [],
      undefined,
      payment.value,
    ));
    expect(craft.counters['charge']).toBe(4);
    expect(computeCharacteristics(ctx, craft).keywords).toContain('flying');
  });

  it('Spree enumerates only affordable mode subsets and charges each chosen mode cost', () => {
    const ctx = pod();
    ctx.state.phase = 'precombatMain';
    const raw = oracle({
      name: 'Test Spree', typeLine: 'Sorcery', manaCost: '{0}', power: null, toughness: null,
      oracleText: 'Spree\n+ {1} - Destroy target artifact.\n+ {2} - Untap target permanent.',
    });
    const spell = conjure(ctx, 'P1', raw, 'hand');
    const target = spawn(ctx, 'P1', oracle({ name: 'Target Relic', typeLine: 'Artifact', manaCost: '{1}', power: null, toughness: null }));
    target.tapped = true;
    const lands = [spawn(ctx, 'P1', forest()), spawn(ctx, 'P1', forest())];
    const casts = computePriorityOptions(ctx, ctx.state.players[0]!).filter((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === spell.id;
    });
    expect(casts.map((option) => (option.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>).modes)).toEqual([[0], [1]]);
    const secondMode = casts.find((option) => (option.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>).modes?.[0] === 1);
    expect(secondMode?.targets?.map((slot) => slot.slot)).toEqual([1]);
    const secondPayload = secondMode?.payload as PriorityActionPayload | undefined;
    if (secondPayload?.kind !== 'castSpell') throw new Error('missing second Spree mode');
    const selectedTarget = secondMode?.targets?.[0]?.options[0];
    if (selectedTarget === undefined) throw new Error('missing legal Spree target');
    pump(applyPriorityAction(ctx, ctx.state.players[0]!, secondPayload, {
      index: 0,
      targets: new Map([[1, selectedTarget]]),
    }));
    expect(lands.every((land) => land.tapped)).toBe(true);
    expect(ctx.state.stack.at(-1)?.ability?.effects).toEqual([{ op: 'untapTarget', target: 1 }]);
  });

  it('stores emblems outside the battlefield and gathers their object triggers once per transition', () => {
    const ctx = pod();
    const source = spawn(ctx, 'P1', creature('Emblem Maker', '2'));
    const artifact = spawn(ctx, 'P1', oracle({ name: 'Emblem Relic', typeLine: 'Artifact', manaCost: '{1}', power: null, toughness: null }));
    const emblemAbility: Ability = {
      kind: 'triggered',
      trigger: { when: 'becomesTapped', subject: { kind: 'permanent', selector: { kind: 'type', value: 'Artifact' } } },
      targets: [],
      effects: [{ op: 'draw', count: { kind: 'const', n: 1 } }],
      description: 'Whenever an artifact becomes tapped, draw a card.',
    };
    pump(executeAbility(ctx, { cardId: source.cardId, oracleId: source.oracleId, name: source.name, controllerId: 'P1' }, {
      kind: 'activated', targets: [], effects: [{ op: 'createEmblem', name: 'Test Emblem', abilities: [emblemAbility] }],
    }, []));
    expect(ctx.state.players[0]!.emblems).toHaveLength(1);
    expect(ctx.state.battlefield.some((permanent) => permanent.name === 'Test Emblem')).toBe(false);
    const tapAbility = { kind: 'spell' as const, targets: [{ kind: 'permanent' as const }], effects: [{ op: 'tapTarget' as const, target: 0 }] };
    pump(executeAbility(ctx, { cardId: source.cardId, oracleId: source.oracleId, name: source.name, controllerId: 'P1' }, tapAbility, [artifact.id]));
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(executeAbility(ctx, { cardId: source.cardId, oracleId: source.oracleId, name: source.name, controllerId: 'P1' }, tapAbility, [artifact.id]));
    expect(ctx.state.pendingTriggers).toHaveLength(1);
  });
});
