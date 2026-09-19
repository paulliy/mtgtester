import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility } from '../src/effects/resolve';
import { priorityCheckpoint } from '../src/sba/sba';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import { runPrioritySequence } from '../src/turn/priority';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const dash = String.fromCharCode(0x2014);
const nl = String.fromCharCode(10);

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(3, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

function transformingCard() {
  return oracle({
    name: 'Test Initiate // Test Ravager',
    typeLine: `Creature ${dash} Human`,
    types: ['Creature'],
    subtypes: ['Human'],
    manaCost: '{1}{G}',
    colors: ['G'],
    colorIdentity: ['G'],
    power: '2',
    toughness: '2',
    layout: 'transform',
    oracleText: '{1}{G}: Transform Test Initiate.',
    backFace: {
      name: 'Test Ravager',
      typeLine: `Creature ${dash} Werewolf`,
      oracleText: [
        'Trample',
        'Whenever Test Ravager enters or transforms into Test Ravager, draw a card.',
        'Other creatures you control get +1/+1.',
        '{T}: Add {G}.',
        '{1}: Draw a card.',
      ].join(nl),
      manaCost: null,
      colors: ['G'],
      power: '4',
      toughness: '4',
      loyalty: null,
      defense: null,
    },
  });
}

describe('Tier 3 transforming double-faced permanents', () => {
  it('switches all active characteristics and preserves permanent state across a transform', () => {
    const card = transformingCard();
    const def = interpretCard(card);
    expect(def.modeled, def.unmodeledReasons.join('; ')).toBe(true);
    expect(def.backFace?.types).toEqual(['Creature']);
    expect(def.backFace?.subtypes).toEqual(['Werewolf']);

    const ctx = pod('tier3-transform-characteristics');
    const source = spawn(ctx, 'P1', card);
    const other = spawn(ctx, 'P1', bear());
    conjure(
      ctx,
      'P1',
      oracle({ name: 'Transform Draw', typeLine: 'Sorcery', oracleText: 'Draw a card.' }),
      'library',
    );
    source.counters['+1/+1'] = 2;
    source.damageMarked = 1;
    source.tapped = true;
    source.attachedTo = other.id;

    const frontAbility = def.activatedAbilities[0]?.ability;
    expect(frontAbility).toBeDefined();
    pump(
      executeAbility(
        ctx,
        {
          cardId: source.cardId,
          oracleId: source.oracleId,
          name: source.name,
          controllerId: source.controllerId,
        },
        frontAbility!,
        [],
      ),
    );

    expect(source.transformed).toBe(true);
    expect(source.name).toBe('Test Ravager');
    expect(source.counters['+1/+1']).toBe(2);
    expect(source.damageMarked).toBe(1);
    expect(source.tapped).toBe(true);
    expect(source.attachedTo).toBe(other.id);
    const back = computeCharacteristics(ctx, source);
    expect(back.types).toEqual(['Creature']);
    expect(back.subtypes).toEqual(['Werewolf']);
    expect(back.power).toBe(6);
    expect(back.toughness).toBe(6);
    expect(back.keywords).toContain('trample');
    expect(back.manaAbilities).toHaveLength(1);
    expect(back.activatedAbilities).toHaveLength(1);
    expect(computeCharacteristics(ctx, other).power).toBe(3);
    expect(ctx.state.pendingTriggers).toHaveLength(1);

    const handBefore = ctx.state.players[0]!.hand.length;
    pump(priorityCheckpoint(ctx));
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.players[0]!.hand).toHaveLength(handBefore + 1);
  });

  it('resets to the front face after leaving the battlefield and reentering', () => {
    const ctx = pod('tier3-transform-zone-reset');
    const source = spawn(ctx, 'P1', transformingCard());
    const def = ctx.defs.get(source.oracleId)!;
    pump(
      executeAbility(
        ctx,
        {
          cardId: source.cardId,
          oracleId: source.oracleId,
          name: source.name,
          controllerId: source.controllerId,
        },
        def.activatedAbilities[0]!.ability,
        [],
      ),
    );

    pump(moveObject(ctx, source, { zone: 'graveyard' }));
    const graveCard = ctx.state.players[0]!.graveyard.find(
      (card) => card.cardId === source.cardId,
    )!;
    expect(graveCard.name).toBe('Test Initiate');
    expect(graveCard.oracleText).toBe('{1}{G}: Transform Test Initiate.');
    const { value } = pump(moveObject(ctx, graveCard, { zone: 'battlefield', controllerId: 'P1' }));
    const returned = value as EnginePermanent;
    expect(returned.transformed).toBe(false);
    expect(returned.name).toBe('Test Initiate');
    expect(computeCharacteristics(ctx, returned).subtypes).toEqual(['Human']);
    expect(computeCharacteristics(ctx, returned).power).toBe(2);
  });

  it('models and resolves the optional mana-payment transform trigger', () => {
    const card = oracle({
      name: 'Test Tender // Test Beast',
      typeLine: `Creature ${dash} Human`,
      types: ['Creature'],
      subtypes: ['Human'],
      manaCost: '{G}',
      colors: ['G'],
      colorIdentity: ['G'],
      power: '1',
      toughness: '1',
      layout: 'transform',
      oracleText:
        'At the beginning of your end step, you may pay {G}. If you do, transform Test Tender.',
      backFace: {
        name: 'Test Beast',
        typeLine: `Creature ${dash} Beast`,
        oracleText: '',
        manaCost: null,
        colors: ['G'],
        power: '3',
        toughness: '3',
        loyalty: null,
        defense: null,
      },
    });
    const def = interpretCard(card);
    expect(def.modeled, def.unmodeledReasons.join('; ')).toBe(true);
    expect(def.triggers[0]?.effects[0]).toMatchObject({
      op: 'conditionalEffect',
      condition: { kind: 'mayPayMana' },
      then: [{ op: 'transformSelf' }],
    });

    const ctx = pod('tier3-transform-payment');
    const source = spawn(ctx, 'P1', card);
    const manaLand = spawn(ctx, 'P1', forest());
    pump(
      executeAbility(
        ctx,
        {
          cardId: source.cardId,
          oracleId: source.oracleId,
          name: source.name,
          controllerId: source.controllerId,
        },
        def.triggers[0]!,
        [],
      ),
    );
    expect(source.transformed).toBe(true);
    expect(manaLand.tapped).toBe(true);
  });

  /**
   * Thing in the Ice, with both faces' text copied VERBATIM from the printing. The earlier Tier 3
   * transform work passed its tests against invented phrasings while every real transform card
   * stayed unmodeled, so this suite drives the printed wording — named entry counters, the
   * "Then if ..." resolution check, and the back face's bare "transforms into" head.
   */
  function thingInTheIce() {
    return oracle({
      name: 'Thing in the Ice // Awoken Horror',
      typeLine: `Creature ${dash} Wall`,
      types: ['Creature'],
      subtypes: ['Wall'],
      manaCost: '{1}{U}',
      colors: ['U'],
      colorIdentity: ['U'],
      power: '0',
      toughness: '4',
      layout: 'transform',
      oracleText: [
        'Defender',
        'Thing in the Ice enters with four ice counters on it.',
        'Whenever you cast an instant or sorcery spell, remove an ice counter from this creature. Then if it has no ice counters on it, transform it.',
      ].join(nl),
      backFace: {
        name: 'Awoken Horror',
        typeLine: `Creature ${dash} Kraken Horror`,
        oracleText:
          "When this creature transforms into Awoken Horror, return all non-Horror creatures to their owners' hands.",
        manaCost: null,
        colors: ['U'],
        power: '7',
        toughness: '8',
        loyalty: null,
        defense: null,
      },
    });
  }

  it('enters with named counters and transforms only when the last one is removed', () => {
    const card = thingInTheIce();
    const def = interpretCard(card);
    expect(def.modeled, def.unmodeledReasons.join('; ')).toBe(true);
    expect(def.entersWithCounters).toEqual({ ice: 4 });
    expect(def.triggers[0]?.effects[1]).toMatchObject({
      op: 'conditionalEffect',
      condition: { kind: 'sourceHasCounters', counter: 'ice', cmp: '<=', n: 0 },
      then: [{ op: 'transformSelf' }],
    });

    const ctx = pod('tier3-thing-in-the-ice');
    const source = spawn(ctx, 'P1', card);
    expect(source.counters['ice']).toBe(4);

    const castTrigger = def.triggers[0]!;
    const fire = (): void => {
      pump(
        executeAbility(
          ctx,
          {
            cardId: source.cardId,
            oracleId: source.oracleId,
            name: source.name,
            controllerId: source.controllerId,
          },
          castTrigger,
          [],
        ),
      );
    };

    // Three instants: counters drain but the creature stays a 0/4 Wall with defender.
    for (let i = 0; i < 3; i++) fire();
    expect(source.counters['ice']).toBe(1);
    expect(source.transformed).toBe(false);
    expect(computeCharacteristics(ctx, source).keywords).toContain('defender');

    // The fourth removes the last counter, and the SAME resolution flips it.
    fire();
    expect(source.counters['ice'] ?? 0).toBe(0);
    expect(source.transformed).toBe(true);
    const back = computeCharacteristics(ctx, source);
    expect(back.subtypes).toEqual(['Kraken', 'Horror']);
    expect(back.power).toBe(7);
    expect(back.toughness).toBe(8);
    expect(back.keywords).not.toContain('defender');
  });

  it('fires the back face bare transforms-into trigger on the flip', () => {
    const def = interpretCard(thingInTheIce());
    expect(def.backFace?.triggers[0]?.trigger).toMatchObject({ when: 'transformsInto' });

    const ctx = pod('tier3-transforms-into-head');
    const source = spawn(ctx, 'P1', thingInTheIce());
    const bystander = spawn(ctx, 'P2', bear());
    source.counters['ice'] = 1;

    pump(
      executeAbility(
        ctx,
        {
          cardId: source.cardId,
          oracleId: source.oracleId,
          name: source.name,
          controllerId: source.controllerId,
        },
        ctx.defs.get(source.oracleId)!.triggers[0]!,
        [],
      ),
    );

    expect(source.transformed).toBe(true);
    // The back face's own trigger is queued by the flip, and bounces the non-Horror creature.
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(runPrioritySequence(ctx));
    expect(ctx.state.battlefield.some((perm) => perm.cardId === bystander.cardId)).toBe(false);
    // …and leaves the Horror itself alone.
    expect(ctx.state.battlefield.some((perm) => perm.cardId === source.cardId)).toBe(true);
  });

  it('parses Westvale Abbey transform-then-untap with its five-creature sacrifice cost', () => {
    const def = interpretCard(
      oracle({
        name: 'Test Abbey // Test Prince',
        typeLine: 'Land',
        types: ['Land'],
        subtypes: [],
        manaCost: null,
        power: null,
        toughness: null,
        layout: 'transform',
        oracleText: [
          '{T}: Add {C}.',
          '{5}, {T}, Sacrifice five creatures: Transform Test Abbey, then untap it.',
        ].join(nl),
        backFace: {
          name: 'Test Prince',
          typeLine: `Creature ${dash} Demon`,
          oracleText: 'Flying',
          manaCost: null,
          colors: ['B'],
          power: '9',
          toughness: '7',
          loyalty: null,
          defense: null,
        },
      }),
    );
    expect(def.modeled, def.unmodeledReasons.join('; ')).toBe(true);
    const activated = def.activatedAbilities[0]!;
    expect(activated.costs).toContainEqual(
      expect.objectContaining({ kind: 'sacrificeOther', count: 5 }),
    );
    expect(activated.ability.effects).toEqual([
      { op: 'transformSelf' },
      { op: 'untapTarget', target: 'source' },
    ]);
  });
});
