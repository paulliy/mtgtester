/**
 * Restricted and tagged mana (ADR 0010, Inc 12a; CR 106.4/106.6).
 *
 * The engine-side pool became a LIST of `ManaEntry` because two mana of the same color stop being
 * interchangeable once one carries a spending restriction, a reflexive spend trigger, or an
 * exemption from the end-of-step drain.
 *
 * The load-bearing insight this file pins: **a CR 106.6 restriction is a property of the payment
 * as a whole, not of an individual pip.** "Spend this mana only to cast a Dragon creature spell"
 * is answered once, before any mana moves, so restricted mana is either fully usable for this
 * payment or entirely unusable — which is why it filters the payment solver's inputs instead of
 * adding a dimension to its search, and why the solver's exactness argument survived unchanged.
 *
 * What these tests pin:
 *
 * - restricted mana cannot pay for an ineligible spell, and CAN pay for an eligible one;
 * - a purpose the restriction does not name (a ward tax) fails CLOSED — the direction that
 *   cannot silently turn "spend only on X" into "spend on anything" (brief §6.3);
 * - a mixed pool spends the restricted mana FIRST, since it is strictly less flexible;
 * - a spend trigger fires once per consumed mana that carries one, and not on mana left
 *   floating — the difference between "when you spend this" and "when this is produced";
 * - Path of Ancestry's narrower condition can decline to fire on mana that was still spendable;
 * - persistent mana survives a step boundary and is dropped at end of turn;
 * - the derived `manaPool` summary never drifts from the entries.
 */

import { describe, expect, it } from 'vitest';
import type { ManaEntry, ManaRestriction } from '../src/cards/ability';
import { interpretCard } from '../src/cards/interpret';
import { canPay, parseManaCost, planPayment } from '../src/mana/cost';
import type { ManaSource } from '../src/mana/cost';
import { addMana, drainPool, selectEntriesToSpend, summarize } from '../src/mana/pool';
import { executeAbility, payManaCost } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { allowanceFor, manaSourcesFor } from '../src/state/queries';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import { emptyManaPools } from '../src/turn/priority';
import { TAP_COST } from '../src/cards/definition';
import { copies, forest, gameConfig, oracle, pump, registerDef, spawn } from './fixtures';

function pod(seed = 'mana-restricted'): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(6, forest) })),
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

const p1 = (ctx: GameContext): EnginePlayerState =>
  ctx.state.players.find((p) => p.id === 'P1') as EnginePlayerState;

const haven = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Haven of the Spirit Dragon',
    typeLine: 'Land',
    manaCost: null,
    power: null,
    toughness: null,
    oracleText:
      '{T}: Add {C}.\n{T}: Add one mana of any color. Spend this mana only to cast a Dragon creature spell.\n{2}, {T}, Sacrifice this land: Return target Dragon creature card or Ugin planeswalker card from your graveyard to your hand.',
  });

const scaledNurturer = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Scaled Nurturer',
    typeLine: 'Creature — Dragon Druid',
    manaCost: '{1}{G}',
    power: '1',
    toughness: '3',
    oracleText:
      '{T}: Add {G}. When you spend this mana to cast a Dragon creature spell, you gain 2 life.',
  });

const pathOfAncestry = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Path of Ancestry',
    typeLine: 'Land',
    manaCost: null,
    power: null,
    toughness: null,
    oracleText:
      "This land enters tapped.\n{T}: Add one mana of any color in your commander's color identity. When that mana is spent to cast a creature spell that shares a creature type with your commander, scry 1.",
  });

/** A {G} Dragon creature — what Scaled Nurturer's and Haven's restrictions are looking for. */
const dragon = (name = 'Test Green Dragon', manaCost = '{G}'): ReturnType<typeof oracle> =>
  oracle({
    name,
    typeLine: 'Creature — Dragon',
    manaCost,
    colors: ['G'],
    colorIdentity: ['G'],
    power: '4',
    toughness: '4',
  });

const bear = (): ReturnType<typeof oracle> =>
  oracle({ name: 'Test Plain Bear', typeLine: 'Creature — Bear', manaCost: '{G}' });

describe('the restriction is a property of the payment, not the pip', () => {
  const dragonsOnly: ManaRestriction = {
    purposes: ['castSpell'],
    filter: { kind: 'subtype', value: 'Dragon' },
    description: 'cast a Dragon spell',
  };

  it('restricted mana pays for an eligible spell and not an ineligible one', () => {
    const ctx = pod();
    registerDef(ctx, dragon());
    registerDef(ctx, bear());
    const restricted: ManaEntry[] = [{ symbol: 'G', restriction: dragonsOnly }];
    const cost = parseManaCost('{G}').cost!;

    const forDragon = allowanceFor(ctx, 'P1', {
      kind: 'castSpell',
      oracleId: dragon().oracleId,
    });
    const forBear = allowanceFor(ctx, 'P1', { kind: 'castSpell', oracleId: bear().oracleId });

    expect(canPay(cost, restricted, [], forDragon)).toBe(true);
    expect(canPay(cost, restricted, [], forBear)).toBe(false);
  });

  it('a restricted SOURCE is dropped wholesale, not partially', () => {
    const ctx = pod();
    registerDef(ctx, bear());
    const restrictedLand: ManaSource = {
      cardId: 'haven',
      units: [['G']],
      costs: TAP_COST,
      restriction: dragonsOnly,
    };
    const forBear = allowanceFor(ctx, 'P1', { kind: 'castSpell', oracleId: bear().oracleId });

    expect(canPay(parseManaCost('{G}').cost!, [], [restrictedLand], forBear)).toBe(false);
  });

  it('fails CLOSED for a purpose the restriction does not name (a ward tax)', () => {
    const ctx = pod();
    const restricted: ManaEntry[] = [{ symbol: 'G', restriction: dragonsOnly }];
    // `{kind:'other'}` — neither casting nor activating. The default allowance refuses every
    // restriction, which is what keeps an unmodeled purpose from unlocking restricted mana.
    const forWard = allowanceFor(ctx, 'P1', { kind: 'other' });

    expect(canPay(parseManaCost('{G}').cost!, restricted, [], forWard)).toBe(false);
    expect(canPay(parseManaCost('{G}').cost!, restricted, [])).toBe(false);
  });

  it('spends the restricted mana first out of a mixed pool', () => {
    // Restricted mana is strictly less useful than unrestricted mana of the same symbol, so
    // spending it first can never lose a payment the player could otherwise have made.
    const mixed: ManaEntry[] = [
      { symbol: 'G' },
      { symbol: 'G', restriction: dragonsOnly },
    ];
    const spent = selectEntriesToSpend(mixed, parseManaCost('{G}').cost!);

    expect(spent).toHaveLength(1);
    expect(spent?.[0]?.restriction).toBe(dragonsOnly);
  });

  it('a hybrid pip actually consumes one matching pool entry, not zero', () => {
    // Regression: selectEntriesToSpend's cost parameter didn't carry `hybrid` at all, so a
    // pure-hybrid cost like {U/B} returned an EMPTY spend list — payManaCost then removed
    // nothing from the pool, making every hybrid-costed activation free and repeatable forever.
    const pool: ManaEntry[] = [{ symbol: 'U' }];
    const spent = selectEntriesToSpend(pool, parseManaCost('{U/B}').cost!);

    expect(spent).toHaveLength(1);
    expect(spent?.[0]?.symbol).toBe('U');
  });

  it('a hybrid pip fails when the pool has neither named color', () => {
    const pool: ManaEntry[] = [{ symbol: 'G' }];
    const spent = selectEntriesToSpend(pool, parseManaCost('{U/B}').cost!);

    expect(spent).toBeNull();
  });
});

describe('Haven of the Spirit Dragon — alternatives on one permanent', () => {
  it('parses into two separate mana abilities, only one of them restricted', () => {
    const def = interpretCard(haven());

    expect(def.modeled).toBe(true);
    expect(def.manaAbilities).toHaveLength(2);
    expect(def.manaAbilities[0]).toEqual({ units: [['C']] });
    expect(def.manaAbilities[1]?.restriction).toMatchObject({ purposes: ['castSpell'] });
    // "Ugin planeswalker card" resolves as a SUBTYPE filter (CR 205.3j), needing no name matching.
    expect(def.activatedAbilities[0]?.ability.targets[0]?.kind).toBe('cardInGraveyard');
  });

  it('is emitted as two sources sharing a cardId, and taps only once', () => {
    const ctx = pod();
    const perm = spawn(ctx, 'P1', haven());
    registerDef(ctx, dragon());
    registerDef(ctx, bear());

    const sources = manaSourcesFor(ctx, 'P1').filter((s) => s.cardId === perm.cardId);
    expect(sources).toHaveLength(2);

    const forDragon = allowanceFor(ctx, 'P1', {
      kind: 'castSpell',
      oracleId: dragon().oracleId,
    });
    const forBear = allowanceFor(ctx, 'P1', { kind: 'castSpell', oracleId: bear().oracleId });

    // A {G} Dragon: the restricted any-color ability is available.
    expect(canPay(parseManaCost('{G}').cost!, [], sources, forDragon)).toBe(true);
    // A {G} Bear: only the {C} ability is available, which cannot make {G}.
    expect(canPay(parseManaCost('{G}').cost!, [], sources, forBear)).toBe(false);
    // Either way it is ONE land, so it can never pay a two-mana cost by itself.
    expect(canPay(parseManaCost('{2}').cost!, [], sources, forDragon)).toBe(false);
  });
});

describe('mana spend triggers', () => {
  /** Tap Scaled Nurturer to pay {G} for `card`, and report the triggers that queued. */
  const spendOn = (card: ReturnType<typeof oracle>) => {
    const ctx = pod();
    spawn(ctx, 'P1', scaledNurturer());
    const player = p1(ctx);
    registerDef(ctx, card);
    pump(
      payManaCost(ctx, player, parseManaCost('{G}').cost!, {
        kind: 'castSpell',
        oracleId: card.oracleId,
      }),
    );
    return { ctx, player, queued: ctx.state.pendingTriggers };
  };

  it('fires when the mana is spent on a Dragon creature spell', () => {
    const { queued } = spendOn(dragon());

    expect(queued).toHaveLength(1);
    expect(queued[0]?.ability.effects).toEqual([{ op: 'gainLife', amount: { kind: 'const', n: 2 } }]);
  });

  it('does NOT fire when the same mana pays for something else', () => {
    // The mana is unrestricted — paying for a Bear is perfectly legal. Only the *trigger* is
    // conditional, so the payment succeeds and nothing is queued.
    const { queued, player } = spendOn(bear());

    expect(queued).toHaveLength(0);
    expect(player.manaEntries).toEqual([]); // the mana was still spent
  });

  it('does not fire for mana left FLOATING — "when you spend", not "when produced"', () => {
    // A two-mana source paying a one-mana cost: one mana is spent (and triggers), one floats.
    // If the trigger fired on production instead, this would gain life twice.
    const ctx = pod();
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Test Twin Nurturer',
        typeLine: 'Creature — Dragon Druid',
        manaCost: '{2}{G}',
        power: '1',
        toughness: '3',
        oracleText:
          '{T}: Add {G}{G}. When you spend this mana to cast a Dragon creature spell, you gain 2 life.',
      }),
    );
    const player = p1(ctx);
    registerDef(ctx, dragon());

    pump(
      payManaCost(ctx, player, parseManaCost('{G}').cost!, {
        kind: 'castSpell',
        oracleId: dragon().oracleId,
      }),
    );

    expect(ctx.state.pendingTriggers).toHaveLength(1);
    // The surplus is still in the pool, still carrying its trigger for whenever it IS spent.
    expect(player.manaEntries).toHaveLength(1);
    expect(player.manaEntries[0]?.spendTrigger).toBeDefined();
    expect(player.manaPool.G).toBe(1);
  });

  it('fires once per consumed mana that carries one', () => {
    const ctx = pod();
    spawn(ctx, 'P1', scaledNurturer());
    spawn(ctx, 'P1', scaledNurturer());
    const player = p1(ctx);
    registerDef(ctx, dragon('Test Big Dragon', '{G}{G}'));

    pump(
      payManaCost(ctx, player, parseManaCost('{G}{G}').cost!, {
        kind: 'castSpell',
        oracleId: dragon('Test Big Dragon', '{G}{G}').oracleId,
      }),
    );

    expect(ctx.state.pendingTriggers).toHaveLength(2);
  });

  it("Path of Ancestry's narrower condition declines on mana that was still spendable", () => {
    // Path of Ancestry's mana is unrestricted, but the scry only happens for a creature spell
    // sharing a type with the commander. The fixture commander is a "Test Captain", so a Dragon
    // pays fine and does not scry.
    const ctx = pod();
    const path = spawn(ctx, 'P1', pathOfAncestry());
    path.tapped = false;
    const player = p1(ctx);
    registerDef(ctx, dragon());

    pump(
      payManaCost(ctx, player, parseManaCost('{G}').cost!, {
        kind: 'castSpell',
        oracleId: dragon().oracleId,
      }),
    );

    expect(ctx.state.pendingTriggers).toHaveLength(0);
    expect(player.manaEntries).toEqual([]);
  });
});

describe('persistent mana (CR 500.4 exception)', () => {
  it('survives the end of a step but not the end of the turn', () => {
    const ctx = pod();
    const player = p1(ctx);
    addMana(player, [
      { symbol: 'R', persistent: true },
      { symbol: 'G' },
    ]);
    expect(player.manaPool).toEqual({ W: 0, U: 0, B: 0, R: 1, G: 1, C: 0 });

    // End of a step: ordinary mana drains, persistent mana stays.
    emptyManaPools(ctx);
    expect(player.manaEntries.map((e) => e.symbol)).toEqual(['R']);
    expect(player.manaPool.R).toBe(1);
    expect(player.manaPool.G).toBe(0);

    // End of turn (cleanup): everything goes.
    emptyManaPools(ctx, true);
    expect(player.manaEntries).toEqual([]);
    expect(player.manaPool.R).toBe(0);
  });
});

describe('the derived summary never drifts from the entries', () => {
  it('holds across add, spend and drain', () => {
    const ctx = pod();
    const player = p1(ctx);
    const check = (): void => expect(player.manaPool).toEqual(summarize(player.manaEntries));

    check();
    addMana(player, [{ symbol: 'W' }, { symbol: 'W' }, { symbol: 'C', persistent: true }]);
    check();
    drainPool(player, false);
    check();
    drainPool(player, true);
    check();
    expect(player.manaPool).toEqual({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });
  });
});

describe('Path of Ancestry', () => {
  it('parses the commander-type clause onto the spend trigger, not the restriction', () => {
    const def = interpretCard(pathOfAncestry());

    expect(def.modeled).toBe(true);
    expect(def.entersTapped).toBe(true);
    const ability = def.manaAbilities[0];
    // The mana itself is UNRESTRICTED — Path of Ancestry taps for any color in your identity and
    // that mana may be spent on anything. Only the scry is conditional.
    expect(ability?.restriction).toBeUndefined();
    expect(ability?.dynamic).toBe('commanderIdentity');
    expect(ability?.spendTrigger?.when).toMatchObject({
      purposes: ['castSpell'],
      sharesCreatureTypeWithCommander: true,
    });
    expect(ability?.spendTrigger?.ability.effects).toEqual([{ op: 'scry', count: 1 }]);
  });
});

const ilysianCaryatid = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Ilysian Caryatid',
    typeLine: 'Creature — Elf Druid',
    manaCost: '{1}{G}',
    power: '0',
    toughness: '3',
    oracleText:
      '{T}: Add one mana of any color. If you control a creature with power 4 or greater, add two mana of any one color instead.',
  });

const bigCreature = (name = 'Test Big Creature'): ReturnType<typeof oracle> =>
  oracle({ name, typeLine: 'Creature — Giant', manaCost: '{4}', power: '4', toughness: '4' });

describe('Ilysian Caryatid — a conditional AMOUNT, not an activation gate', () => {
  it('parses the base production and the linked conditional replacement', () => {
    const def = interpretCard(ilysianCaryatid());

    expect(def.modeled).toBe(true);
    expect(def.manaAbilities).toHaveLength(1);
    const ability = def.manaAbilities[0];
    expect(ability?.units).toEqual([['W', 'U', 'B', 'R', 'G']]);
    expect(ability?.conditionalUnits?.units).toEqual([
      ['W', 'U', 'B', 'R', 'G'],
      ['W', 'U', 'B', 'R', 'G'],
    ]);
    expect(ability?.conditionalUnits?.linked).toBe(true);
  });

  it('with no big creature, produces one mana of any color and cannot pay two', () => {
    const ctx = pod();
    spawn(ctx, 'P1', ilysianCaryatid());
    const sources = manaSourcesFor(ctx, 'P1');

    expect(canPay(parseManaCost('{W}').cost!, [], sources)).toBe(true);
    expect(canPay(parseManaCost('{W}{W}').cost!, [], sources)).toBe(false);
  });

  it('with a power-4+ creature, "instead" REPLACES the production: two mana of one color', () => {
    const ctx = pod();
    spawn(ctx, 'P1', ilysianCaryatid());
    spawn(ctx, 'P1', bigCreature());
    const sources = manaSourcesFor(ctx, 'P1');

    // Linked: two mana that must match. {W}{W} payable, {W}{U} is not — never both offered as
    // the weaker one-mana production, since "instead" replaces it rather than adding to it.
    expect(canPay(parseManaCost('{W}{W}').cost!, [], sources)).toBe(true);
    expect(canPay(parseManaCost('{W}{U}').cost!, [], sources)).toBe(false);
    expect(canPay(parseManaCost('{W}').cost!, [], sources)).toBe(true); // surplus floats

    const plan = planPayment(parseManaCost('{W}{W}').cost!, [], sources);
    expect(plan?.produced.map((p) => p.symbol)).toEqual(['W', 'W']);
  });
});

const klauth = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Klauth, Unrivaled Ancient',
    typeLine: 'Legendary Creature — Dragon',
    manaCost: '{4}{R}{R}',
    colors: ['R'],
    colorIdentity: ['R'],
    power: '8',
    toughness: '8',
    oracleText:
      "Flying, haste\nWhenever Klauth attacks, add X mana in any combination of colors, where X is the total power of attacking creatures. Spend this mana only to cast spells. Until end of turn, you don't lose this mana as steps and phases end.",
  });

describe('Klauth, Unrivaled Ancient — addMana from a resolving (non-activation) ability', () => {
  it('parses to one triggered ability with an addMana effect', () => {
    const def = interpretCard(klauth());

    expect(def.modeled).toBe(true);
    expect(def.triggers).toHaveLength(1);
    const trigger = def.triggers[0];
    expect(trigger?.trigger).toMatchObject({ when: 'attacks', subject: { kind: 'self' } });
    expect(trigger?.effects).toEqual([
      {
        op: 'addMana',
        amount: { kind: 'totalPowerOfAttackers' },
        colors: 'any',
        restriction: { purposes: ['castSpell'], description: 'cast spells' },
        persistent: true,
      },
    ]);
  });

  it('adds X mana (total attacking power), spend-restricted and persistent', () => {
    const ctx = pod();
    const dragon = spawn(ctx, 'P1', klauth());
    const other = spawn(ctx, 'P1', bigCreature('Test Attacker'));
    dragon.attacking = 'P2';
    other.attacking = 'P2';
    const player = p1(ctx);
    const def = interpretCard(klauth());
    const trigger = def.triggers[0]!;

    pump(
      executeAbility(
        ctx,
        { cardId: dragon.cardId, name: dragon.name, oracleId: dragon.oracleId, controllerId: 'P1' },
        trigger,
        [],
      ),
    );

    // 8 (Klauth) + 4 (the other attacker) = 12 mana, one per point of total attacking power.
    expect(player.manaEntries).toHaveLength(12);
    for (const entry of player.manaEntries) {
      expect(entry.restriction).toMatchObject({ purposes: ['castSpell'] });
      expect(entry.persistent).toBe(true);
    }

    // Persistent: survives a step boundary.
    emptyManaPools(ctx);
    expect(player.manaEntries).toHaveLength(12);
    // But not cleanup.
    emptyManaPools(ctx, true);
    expect(player.manaEntries).toHaveLength(0);
  });
});

describe('Maelstrom of the Spirit Dragon', () => {
  it('reads "an Omen spell" as a spell subtype (CR 205.3k)', () => {
    const def = interpretCard(
      oracle({
        name: 'Maelstrom of the Spirit Dragon',
        typeLine: 'Land',
        manaCost: null,
        power: null,
        toughness: null,
        oracleText:
          '{T}: Add {C}.\n{T}: Add one mana of any color. Spend this mana only to cast a Dragon spell or an Omen spell.\n{4}, {T}, Sacrifice this land: Search your library for a Dragon card, reveal it, put it into your hand, then shuffle.',
      }),
    );

    expect(def.modeled).toBe(true);
    expect(def.manaAbilities[1]?.restriction?.filter).toEqual({
      kind: 'anyOf',
      of: [
        { kind: 'subtype', value: 'Dragon' },
        { kind: 'subtype', value: 'Omen' },
      ],
    });
  });
});
