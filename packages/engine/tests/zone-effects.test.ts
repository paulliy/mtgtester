/**
 * Zone-movement primitives and non-battlefield targets (ADR 0010, Inc 11): reanimation from a
 * graveyard, "put a/any number of cards from your hand onto the battlefield", and a permanent
 * bounce. Closes Bladewing the Risen, Broodcaller Scourge, and Last March of the Ents.
 *
 * What these tests pin:
 *
 * - `cardInGraveyard` is a target on a CARD, not a permanent — always the ability's own
 *   controller's graveyard, filtered by the printed clause ("Dragon permanent card");
 * - a graveyard target that leaves before the ability resolves fizzles quietly, the same
 *   `isTargetStillLegal` re-check every other targeted primitive gets (CR 608.2b);
 * - a reanimated permanent enters summoning-sick and fires its OWN "enters" trigger — it goes
 *   through the ordinary `moveObject` path, not a parallel one;
 * - "put a/any number of `<filter>` cards from your hand onto the battlefield" is one op
 *   (`handToBattlefield`) whether the pick is singular-and-bounded (Broodcaller) or
 *   unbounded (Last March), and it stops asking once nothing left in hand still qualifies;
 * - "This spell can't be countered" is checked by the `counter` executor at resolution — the
 *   spell is still a legal target, the countering itself just has no effect (DEBT-style);
 * - a bounced permanent that is a token ceases to exist (CR 704.5d), via the generic
 *   `moveObject` token-ceasing path — `returnToHand` adds no special case for it.
 */

import { describe, expect, it } from 'vitest';
import type { Ability } from '../src/cards/ability';
import { interpretCard } from '../src/cards/interpret';
import { computeTargetOptions } from '../src/actions/legal';
import { executeAbility, optionalAbilityHasNothingToDo } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { createToken, moveObject } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import {
  cancel,
  conjure,
  copies,
  forest,
  gameConfig,
  island,
  oracle,
  pick,
  pump,
  registerDef,
  spawn,
} from './fixtures';

function pod(seed = 'zone-effects'): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(10, forest) })),
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

const bladewing = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Bladewing the Risen',
    typeLine: 'Legendary Creature — Zombie Dragon',
    supertypes: ['Legendary'],
    manaCost: '{3}{B}{B}{R}{R}',
    power: '4',
    toughness: '4',
    oracleText:
      'Flying\nWhen Bladewing enters, you may return target Dragon permanent card from your graveyard to the battlefield.\n{B}{R}: Dragon creatures get +1/+1 until end of turn.',
  });

const testDragon = (name: string, extraText = ''): ReturnType<typeof oracle> =>
  oracle({
    name,
    typeLine: 'Creature — Dragon',
    manaCost: '{4}{R}',
    power: '5',
    toughness: '5',
    oracleText: extraText,
  });

const broodcaller = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Broodcaller Scourge',
    typeLine: 'Creature — Dragon',
    manaCost: '{5}{G}{G}',
    power: '5',
    toughness: '7',
    oracleText:
      'Flying\nWhenever one or more Dragons you control deal combat damage to a player, you may put a permanent card with mana value less than or equal to that damage from your hand onto the battlefield.',
  });

const lastMarch = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Last March of the Ents',
    typeLine: 'Sorcery',
    manaCost: '{6}{G}{G}',
    power: null,
    toughness: null,
    oracleText:
      "This spell can't be countered.\nDraw cards equal to the greatest toughness among creatures you control, then put any number of creature cards from your hand onto the battlefield.",
  });

/** A cheap stand-in proving `cantBeCountered` end-to-end without funding Last March's {8}. */
const uncounterableDraw = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Unstoppable Draw',
    typeLine: 'Sorcery',
    manaCost: '{G}',
    power: null,
    toughness: null,
    oracleText: "This spell can't be countered.\nDraw a card.",
  });

describe('Bladewing the Risen — graveyard reanimation target', () => {
  it('parses as a modeled optional ETB with a filtered graveyard target', () => {
    const def = interpretCard(bladewing());

    expect(def.modeled).toBe(true);
    const trigger = def.triggers[0];
    expect(trigger?.optional).toBe(true);
    expect(trigger?.targets[0]?.kind).toBe('cardInGraveyard');
    expect(trigger?.effects).toEqual([{ op: 'graveyardToBattlefield', target: 0 }]);
    // The other printed line — the activated pump ability — is not lost in the process.
    expect(def.activatedAbilities).toHaveLength(1);
  });

  it('offers only Dragon PERMANENT cards from the caster’s own graveyard', () => {
    const ctx = pod();
    const def = interpretCard(bladewing());
    const trigger = def.triggers[0] as Ability;
    const spec = trigger.targets[0];
    if (spec === undefined) throw new Error('test bug');

    const goodDragon = conjure(ctx, 'P1', testDragon('Test Graveyard Dragon'), 'graveyard');
    const nonDragon = conjure(
      ctx,
      'P1',
      oracle({ name: 'Test Bear In The Yard', typeLine: 'Creature — Bear', manaCost: '{1}{G}' }),
      'graveyard',
    );
    const dragonInstant = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Test Dragon Instant',
        typeLine: 'Instant',
        subtypes: [],
        manaCost: '{R}',
        power: null,
        toughness: null,
        oracleText: '',
      }),
      'graveyard',
    );
    const opponentsDragon = conjure(ctx, 'P2', testDragon('Test Rival Dragon'), 'graveyard');

    const options = computeTargetOptions(ctx, spec, 'P1');

    expect(options).toContain(goodDragon.id);
    expect(options).not.toContain(nonDragon.id);
    expect(options).not.toContain(dragonInstant.id);
    expect(options).not.toContain(opponentsDragon.id);
  });

  it('reanimates the target: summoning-sick, and its own ETB trigger fires', () => {
    const ctx = pod();
    const def = interpretCard(bladewing());
    const trigger = def.triggers[0] as Ability;

    const dragonCard = conjure(
      ctx,
      'P1',
      testDragon('Test Lifegain Dragon', 'When this creature enters, you gain 1 life.'),
      'graveyard',
    );
    const p1 = ctx.state.players.find((p) => p.id === 'P1');
    if (p1 === undefined) throw new Error('test bug');
    const lifeBefore = p1.life;

    pump(
      executeAbility(
        ctx,
        {
          cardId: 'c-bladewing',
          name: 'Bladewing the Risen',
          oracleId: def.oracleId,
          controllerId: 'P1',
        },
        trigger,
        [dragonCard.id],
      ),
    );

    const perm = ctx.state.battlefield.find((p) => p.cardId === dragonCard.cardId);
    expect(perm).toBeDefined();
    expect(perm?.summoningSick).toBe(true);
    expect(p1.graveyard.some((c) => c.cardId === dragonCard.cardId)).toBe(false);

    // The reanimated Dragon's own "enters" trigger was queued by the ordinary moveObject path;
    // resolve it and confirm it actually fired, not merely queued.
    pump(runPrioritySequence(ctx));
    expect(p1.life).toBe(lifeBefore + 1);
  });

  it('fizzles quietly when the target leaves the graveyard before resolution', () => {
    const ctx = pod();
    const def = interpretCard(bladewing());
    const trigger = def.triggers[0] as Ability;

    const dragonCard = conjure(ctx, 'P1', testDragon('Test Fleeting Dragon'), 'graveyard');
    const before = ctx.state.battlefield.length;

    // Something else exiled it in response, between announcement and resolution.
    pump(moveObject(ctx, dragonCard, { zone: 'exile' }));

    pump(
      executeAbility(
        ctx,
        {
          cardId: 'c-bladewing',
          name: 'Bladewing the Risen',
          oracleId: def.oracleId,
          controllerId: 'P1',
        },
        trigger,
        [dragonCard.id],
      ),
    );

    expect(ctx.state.battlefield).toHaveLength(before);
  });
});

describe('Broodcaller Scourge — bounded hand-to-battlefield', () => {
  it('parses as an aggregate combat-damage trigger with a mana-value-bounded pick', () => {
    const def = interpretCard(broodcaller());

    expect(def.modeled).toBe(true);
    const trigger = def.triggers[0];
    expect(trigger?.trigger).toMatchObject({
      when: 'dealsCombatDamageToPlayer',
      aggregate: 'byEventPlayer',
    });
    expect(trigger?.optional).toBe(true);
    expect(trigger?.effects).toEqual([
      {
        op: 'handToBattlefield',
        filter: expect.anything(),
        maxManaValue: { kind: 'damageDealt' },
        count: 'one',
      },
    ]);
  });

  it('offers only the affordable card, and puts it onto the battlefield', () => {
    const ctx = pod();
    const def = interpretCard(broodcaller());
    const trigger = def.triggers[0] as Ability;

    const cheap = conjure(
      ctx,
      'P1',
      oracle({ name: 'Test Cheap Rock', typeLine: 'Artifact', manaCost: '{3}' }),
      'hand',
    );
    conjure(
      ctx,
      'P1',
      oracle({ name: 'Test Pricey Rock', typeLine: 'Artifact', manaCost: '{6}' }),
      'hand',
    );

    const { decisions } = pump(
      executeAbility(
        ctx,
        {
          cardId: 'c-brood',
          name: 'Broodcaller Scourge',
          oracleId: def.oracleId,
          controllerId: 'P1',
        },
        trigger,
        [],
        undefined,
        { damageDealt: 4 },
      ),
      (d) => pick(d, 'Test Cheap Rock'),
    );

    const ask = decisions.find((d) => d.prompt.includes('Broodcaller Scourge'));
    expect(ask?.options.map((o) => o.description)).toEqual([
      'Put Test Cheap Rock onto the battlefield',
      'Put none of them',
    ]);
    expect(ctx.state.battlefield.some((p) => p.cardId === cheap.cardId)).toBe(true);
  });

  it('skips the "use this ability?" question when nothing in hand is affordable', () => {
    const ctx = pod();
    const def = interpretCard(broodcaller());
    const trigger = def.triggers[0] as Ability;
    const source = { cardId: 'c-brood', controllerId: 'P1' as const };

    // Empty hand: every answer would do nothing.
    expect(optionalAbilityHasNothingToDo(ctx, source, trigger, { damageDealt: 4 })).toBe(true);

    conjure(
      ctx,
      'P1',
      oracle({ name: 'Test Pricey Rock', typeLine: 'Artifact', manaCost: '{6}' }),
      'hand',
    );
    // Only a card above the damage: still nothing to put.
    expect(optionalAbilityHasNothingToDo(ctx, source, trigger, { damageDealt: 4 })).toBe(true);
    // The same hand with more damage dealt does have a legal pick, so the question stays.
    expect(optionalAbilityHasNothingToDo(ctx, source, trigger, { damageDealt: 6 })).toBe(false);
  });

  it('declining leaves the card in hand', () => {
    const ctx = pod();
    const def = interpretCard(broodcaller());
    const trigger = def.triggers[0] as Ability;
    const cheap = conjure(
      ctx,
      'P1',
      oracle({ name: 'Test Cheap Rock', typeLine: 'Artifact', manaCost: '{3}' }),
      'hand',
    );

    pump(
      executeAbility(
        ctx,
        {
          cardId: 'c-brood',
          name: 'Broodcaller Scourge',
          oracleId: def.oracleId,
          controllerId: 'P1',
        },
        trigger,
        [],
        undefined,
        { damageDealt: 4 },
      ),
      (d) => pick(d, 'Put none of them'),
    );

    expect(ctx.state.battlefield.some((p) => p.cardId === cheap.cardId)).toBe(false);
    const p1 = ctx.state.players.find((p) => p.id === 'P1');
    expect(p1?.hand.some((c) => c.cardId === cheap.cardId)).toBe(true);
  });
});

describe('Last March of the Ents — draw-then-put and uncounterability', () => {
  it('parses as an uncounterable draw + unbounded hand-to-battlefield', () => {
    const def = interpretCard(lastMarch());

    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.cantBeCountered).toBe(true);
    expect(def.spellAbility?.effects).toEqual([
      {
        op: 'draw',
        count: { kind: 'greatestToughnessAmong', selector: expect.anything(), scope: 'all' },
      },
      { op: 'handToBattlefield', filter: expect.anything(), count: 'any' },
    ]);
  });

  it('draws by the greatest toughness, then puts every matching card from hand', () => {
    const ctx = pod(); // library starts with 10 Forests — plenty for a 5-card draw
    const def = registerDef(ctx, lastMarch());
    const ability = def.spellAbility as Ability;

    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Test Small',
        typeLine: 'Creature — Bear',
        manaCost: '{1}{G}',
        power: '2',
        toughness: '3',
      }),
    );
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Test Big',
        typeLine: 'Creature — Bear',
        manaCost: '{1}{G}',
        power: '2',
        toughness: '5',
      }),
    );

    const creatureA = conjure(
      ctx,
      'P1',
      oracle({ name: 'Test Hand Creature A', typeLine: 'Creature — Bear', manaCost: '{2}{G}' }),
      'hand',
    );
    const creatureB = conjure(
      ctx,
      'P1',
      oracle({ name: 'Test Hand Creature B', typeLine: 'Creature — Bear', manaCost: '{2}{G}' }),
      'hand',
    );
    const nonCreature = conjure(
      ctx,
      'P1',
      oracle({ name: 'Test Hand Rock', typeLine: 'Artifact', manaCost: '{2}' }),
      'hand',
    );

    const p1 = ctx.state.players.find((p) => p.id === 'P1');
    if (p1 === undefined) throw new Error('test bug');
    const handBefore = p1.hand.length;

    pump(
      executeAbility(
        ctx,
        {
          cardId: 'c-march',
          name: 'Last March of the Ents',
          oracleId: def.oracleId,
          controllerId: 'P1',
        },
        ability,
        [],
      ),
      // Always accept the offered pick (the loop stops on its own once nothing matches).
      () => ({ index: 0, targets: new Map() }),
    );

    // Drew 5 (the greatest toughness among P1's creatures) plus the 3 conjured hand cards,
    // minus the 2 creatures that were put onto the battlefield.
    expect(p1.hand.length).toBe(handBefore + 5 - 2);
    expect(ctx.state.battlefield.some((p) => p.cardId === creatureA.cardId)).toBe(true);
    expect(ctx.state.battlefield.some((p) => p.cardId === creatureB.cardId)).toBe(true);
    expect(p1.hand.some((c) => c.cardId === nonCreature.cardId)).toBe(true);
  });

  it("can't be countered — the counter spell resolves against it with no effect", () => {
    const ctx = pod();
    ctx.state.turnNumber = 5;
    spawn(ctx, 'P1', forest());
    conjure(ctx, 'P1', uncounterableDraw(), 'hand');
    conjure(ctx, 'P2', cancel(), 'hand');
    spawn(ctx, 'P2', island()); // Test Cancel costs {U}
    const p1 = ctx.state.players.find((p) => p.id === 'P1');

    let drawCast = false;
    let cancelCast = false;
    pump(runPrioritySequence(ctx), (d) => {
      if (d.player === 'P1' && !drawCast) {
        drawCast = true;
        return pick(d, 'Test Unstoppable Draw');
      }
      if (d.player === 'P2' && !cancelCast && ctx.state.stack.length === 1) {
        cancelCast = true;
        const idx = d.options.findIndex((o) => o.description.includes('Test Cancel'));
        const spellOnStack = ctx.state.stack[0];
        return { index: idx, targets: new Map([[0, spellOnStack?.id as string]]) };
      }
      return pick(d, 'Pass');
    });

    // Not countered — never even attempted.
    expect(ctx.state.eventLog.some((e) => e.type === 'counterSpell')).toBe(false);
    expect(ctx.state.eventLog.some((e) => e.type === 'counterPrevented')).toBe(true);
    // The draw actually happened, and the spell resolved into the graveyard like any sorcery.
    expect(ctx.state.eventLog.some((e) => e.type === 'draw' && e.payload['player'] === 'P1')).toBe(
      true,
    );
    expect(p1?.graveyard.some((c) => c.name === 'Test Unstoppable Draw')).toBe(true);
  });
});

describe('returnToHand — the general bounce primitive', () => {
  it('a bounced TOKEN ceases to exist instead of landing in hand (CR 704.5d)', () => {
    const ctx = pod();
    const token = createToken(
      ctx,
      {
        name: 'Test Spirit',
        typeLine: 'Token Creature — Spirit',
        types: ['Creature'],
        subtypes: ['Spirit'],
        colors: [],
        power: 1,
        toughness: 1,
      },
      'P1',
    );

    const ability: Ability = {
      kind: 'triggered',
      targets: [{ kind: 'creature' }],
      effects: [{ op: 'returnToHand', target: 0 }],
    };
    pump(
      executeAbility(
        ctx,
        { cardId: 'c-bouncer', name: 'Test Bouncer', oracleId: 'test-bouncer', controllerId: 'P1' },
        ability,
        [token.id],
      ),
    );

    expect(ctx.state.battlefield.some((p) => p.cardId === token.cardId)).toBe(false);
    const p1 = ctx.state.players.find((p) => p.id === 'P1');
    expect(p1?.hand.some((c) => c.cardId === token.cardId)).toBe(false);
    expect(ctx.state.eventLog.some((e) => e.type === 'tokenCeased')).toBe(true);
  });

  it('a bounced non-token permanent lands in its owner’s hand', () => {
    const ctx = pod();
    const bear = spawn(
      ctx,
      'P1',
      oracle({ name: 'Test Bear', typeLine: 'Creature — Bear', manaCost: '{1}{G}' }),
    );

    const ability: Ability = {
      kind: 'triggered',
      targets: [{ kind: 'creature' }],
      effects: [{ op: 'returnToHand', target: 0 }],
    };
    pump(
      executeAbility(
        ctx,
        { cardId: 'c-bouncer', name: 'Test Bouncer', oracleId: 'test-bouncer', controllerId: 'P1' },
        ability,
        [bear.id],
      ),
    );

    expect(ctx.state.battlefield.some((p) => p.cardId === bear.cardId)).toBe(false);
    const p1 = ctx.state.players.find((p) => p.id === 'P1');
    expect(p1?.hand.some((c) => c.cardId === bear.cardId)).toBe(true);
  });
});
