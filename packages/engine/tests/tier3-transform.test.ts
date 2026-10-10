import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { computeCharacteristics } from '../src/effects/continuous';
import { endUntilEotEffects, executeAbility } from '../src/effects/resolve';
import { priorityCheckpoint } from '../src/sba/sba';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import {
  applyCopy,
  copyImageFace,
  createToken,
  moveObject,
  tokenSpecCopying,
  transformPermanent,
} from '../src/state/objects';
import { permanentManaValue } from '../src/targets/legality';
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
  it('copies the active back face and all its abilities, excluding counters and later layers', () => {
    const ctx = pod('dfc-back-copy');
    const source = spawn(ctx, 'P1', transformingCard());
    const clone = spawn(ctx, 'P2', bear());
    transformPermanent(ctx, source);
    source.counters['+1/+1'] = 3;
    // Prime the cache before copying; the copy must invalidate its old characteristics.
    expect(computeCharacteristics(ctx, clone).keywords).toEqual([]);
    applyCopy(ctx, clone, source);
    const chars = computeCharacteristics(ctx, clone);
    expect(clone.name).toBe('Test Ravager');
    expect(copyImageFace(ctx, clone)).toBe('back');
    expect(clone.oracleText).toBe(transformingCard().backFace!.oracleText);
    expect(chars).toMatchObject({
      power: 4,
      toughness: 4,
      subtypes: ['Werewolf'],
      keywords: ['trample'],
    });
    expect(chars.manaAbilities).toHaveLength(1);
    expect(chars.activatedAbilities).toHaveLength(1);
    expect(chars.triggers).toHaveLength(2);
    expect(computeCharacteristics(ctx, source).power).toBe(7);
    expect(permanentManaValue(ctx, source)).toBe(2);
    expect(permanentManaValue(ctx, clone)).toBe(0);
    expect(transformPermanent(ctx, clone)).toBe(false);
    const ally = spawn(ctx, 'P2', bear());
    expect(computeCharacteristics(ctx, ally).power).toBe(3);
  });

  it('creates a double-faced token with its back face up and no transform trigger on entry', () => {
    const ctx = pod('dfc-token-back');
    const source = spawn(ctx, 'P1', transformingCard());
    transformPermanent(ctx, source);
    ctx.state.pendingTriggers = [];
    const token = createToken(ctx, tokenSpecCopying(ctx, source, false), 'P2');
    expect(token.name).toBe('Test Ravager');
    expect(token.transformed).toBe(true);
    expect(copyImageFace(ctx, token)).toBe('back');
    expect(token.manaCost).toBeNull();
    expect(permanentManaValue(ctx, token)).toBe(2);
    expect(computeCharacteristics(ctx, token).power).toBe(4);
    expect(ctx.state.pendingTriggers).toHaveLength(1); // ETB only, never transformsInto.
    expect(transformPermanent(ctx, token)).toBe(true);
    expect(token.name).toBe('Test Initiate');
    expect(copyImageFace(ctx, token)).toBe('front');
    expect(computeCharacteristics(ctx, token).power).toBe(2);
    expect(transformPermanent(ctx, token)).toBe(true);
    expect(computeCharacteristics(ctx, token).keywords).toEqual(['trample']);
  });

  it('copies front-face tokens with both faces and separates their interned definitions', () => {
    const ctx = pod('dfc-token-front');
    const source = spawn(ctx, 'P1', transformingCard());
    const front = createToken(ctx, tokenSpecCopying(ctx, source, false), 'P2');
    expect(front.name).toBe('Test Initiate');
    expect(front.manaCost).toBe('{1}{G}');
    expect(computeCharacteristics(ctx, front).activatedAbilities).toHaveLength(1);
    transformPermanent(ctx, source);
    const back = createToken(ctx, tokenSpecCopying(ctx, source, false), 'P3');
    expect(front.oracleId).not.toBe(back.oracleId);
    expect(front.transformed).toBe(false);
    expect(back.transformed).toBe(true);
    transformPermanent(ctx, front);
    expect(front.name).toBe('Test Ravager');
    expect(permanentManaValue(ctx, front)).toBe(2);
  });

  it('applies nonlegendary copy exceptions to an inactive legendary front face too', () => {
    const ctx = pod('dfc-copy-nonlegendary-both-faces');
    const card = transformingCard();
    card.typeLine = `Legendary ${card.typeLine}`;
    card.supertypes = ['Legendary'];
    const source = spawn(ctx, 'P1', card);
    transformPermanent(ctx, source); // Back is not legendary; front is.
    const token = createToken(ctx, tokenSpecCopying(ctx, source, true), 'P2');
    expect(computeCharacteristics(ctx, token).supertypes).not.toContain('Legendary');
    transformPermanent(ctx, token);
    expect(computeCharacteristics(ctx, token).supertypes).not.toContain('Legendary');
    expect(token.typeLine).not.toContain('Legendary');
    const legendary = createToken(ctx, tokenSpecCopying(ctx, source, false), 'P3');
    transformPermanent(ctx, legendary);
    expect(computeCharacteristics(ctx, legendary).supertypes).toContain('Legendary');
  });

  it('keeps copied face and copy exceptions when copying a copy', () => {
    const ctx = pod('dfc-copy-chain');
    const source = spawn(ctx, 'P1', transformingCard());
    transformPermanent(ctx, source);
    const first = spawn(ctx, 'P2', bear());
    applyCopy(ctx, first, source, {
      addTypes: ['Artifact'],
      addKeywords: ['haste'],
      nameOverride: 'Copied Ravager',
    });
    const second = spawn(ctx, 'P3', bear());
    applyCopy(ctx, second, first);
    expect(second.name).toBe('Copied Ravager');
    expect(computeCharacteristics(ctx, second)).toMatchObject({
      types: ['Creature', 'Artifact'],
      keywords: ['trample', 'haste'],
    });
    const token = createToken(ctx, tokenSpecCopying(ctx, first, false), 'P4');
    expect(token.name).toBe('Copied Ravager');
    expect(computeCharacteristics(ctx, token).keywords).toEqual(['trample', 'haste']);
    expect(transformPermanent(ctx, token)).toBe(false);
    transformPermanent(ctx, source);
    expect(computeCharacteristics(ctx, second).power).toBe(4);
  });

  it('restores a transformed physical DFC at cleanup and its front face after a zone change', () => {
    const ctx = pod('dfc-copy-restoration');
    const source = spawn(ctx, 'P1', transformingCard());
    const target = spawn(ctx, 'P2', bear());
    transformPermanent(ctx, source);
    applyCopy(ctx, source, target, { untilEot: true });
    expect(copyImageFace(ctx, source)).toBe('front');
    expect(computeCharacteristics(ctx, source).power).toBe(2);
    endUntilEotEffects(ctx);
    expect(source.transformed).toBe(true);
    expect(source.name).toBe('Test Ravager');
    expect(copyImageFace(ctx, source)).toBe('back');
    expect(computeCharacteristics(ctx, source).power).toBe(4);
    applyCopy(ctx, source, target);
    const moved = pump(moveObject(ctx, source, { zone: 'hand' })).value!;
    expect(moved.name).toBe('Test Initiate');
    expect(moved.manaCost).toBe('{1}{G}');
    expect(moved.oracleText).toBe('{1}{G}: Transform Test Initiate.');
  });

  it('does not inherit a target DFC transform state when the copying physical card is transformed', () => {
    const ctx = pod('dfc-copy-physical-transform');
    const source = spawn(ctx, 'P1', transformingCard());
    transformPermanent(ctx, source);
    const target = spawn(ctx, 'P2', transformingCard());
    applyCopy(ctx, source, target, { untilEot: true });
    expect(source.name).toBe('Test Initiate');
    expect(computeCharacteristics(ctx, source).power).toBe(2);
    expect(transformPermanent(ctx, source)).toBe(true);
    expect(source.transformed).toBe(false);
    expect(source.name).toBe('Test Initiate');
    endUntilEotEffects(ctx);
    expect(source.name).toBe('Test Initiate');
    expect(computeCharacteristics(ctx, source).power).toBe(2);
  });

  it('copies face-down characteristics without exposing its printed face or abilities', () => {
    const ctx = pod('dfc-copy-face-down');
    const source = spawn(ctx, 'P1', transformingCard());
    source.faceDown = true;
    const clone = spawn(ctx, 'P2', bear());
    applyCopy(ctx, clone, source);
    expect(clone.name).toBe('');
    expect(clone.oracleText).toBe('');
    expect(clone.manaCost).toBeNull();
    expect(computeCharacteristics(ctx, clone)).toMatchObject({
      power: 2,
      toughness: 2,
      colors: [],
      subtypes: [],
      activatedAbilities: [],
    });
    expect(permanentManaValue(ctx, clone)).toBe(0);
    const token = createToken(ctx, tokenSpecCopying(ctx, source, false), 'P3');
    expect(token.oracleId).not.toContain(source.oracleId);
    expect(ctx.defs.get(token.oracleId)?.scryfallId).toBeUndefined();
    expect(computeCharacteristics(ctx, token).activatedAbilities).toEqual([]);
  });
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
