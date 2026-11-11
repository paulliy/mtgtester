/**
 * EDHREC coverage plan, Phase 4 batch 6: trigger heads, intervening-if conditions, payments
 * inside triggers, and battle cry, extort and squad. The runner scenarios of Howling Golem,
 * Ophiomancer, Ripjaw Raptor, Megrim, Tithe Drinker, Seer's Sundial and Goblin Wardriver drive the
 * productions through the engine; this file covers the edges (D1).
 */
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { priorityCheckpoint } from '../src/sba/sba';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import { movePermanentsToGraveyard, queueTriggersForObject } from '../src/state/objects';
import { forestsPod, gameConfig, oracle, pumpStrict, spawn } from './fixtures';

const creature = (oracleText: string, extra: Partial<OracleCard> = {}): OracleCard =>
  oracle({
    name: 'P6 Probe',
    typeLine: 'Creature — Human',
    manaCost: '{1}',
    power: '2',
    toughness: '2',
    oracleText,
    ...extra,
  });
const head = (text: string, extra: Partial<OracleCard> = {}) =>
  interpretCard(creature(text, extra)).triggers.map((t) => t.trigger);

describe('Phase 4 batch 6: trigger heads', () => {
  it('reads the step heads the engine dispatches', () => {
    expect(head("At the beginning of each opponent's upkeep, draw a card.")).toEqual([
      { when: 'upkeep', player: 'opponent' },
    ]);
    expect(head("At the beginning of each player's draw step, you gain 1 life.")).toEqual([
      { when: 'drawStep', player: 'each' },
    ]);
    expect(head('At the beginning of the end step, you gain 1 life.')).toEqual([
      { when: 'endStep', player: 'each' },
    ]);
    // The engine queues an opponent's step only for upkeep, end step and combat.
    expect(
      interpretCard(creature("At the beginning of each opponent's draw step, draw a card."))
        .modeled,
    ).toBe(false);
  });

  it('"enchanted player\'s upkeep" is read only on an Aura', () => {
    expect(
      interpretCard(creature("At the beginning of enchanted player's upkeep, draw a card."))
        .modeled,
    ).toBe(false);
  });

  it('compound heads are two triggers (CR 603.2)', () => {
    expect(head('When this creature enters or dies, draw a card.')).toEqual([
      { when: 'enters', subject: { kind: 'self' } },
      { when: 'dies', subject: { kind: 'self' } },
    ]);
    expect(head('Whenever this creature attacks or blocks, draw a card.')).toEqual([
      { when: 'attacks', subject: { kind: 'self' } },
      { when: 'blocks', subject: { kind: 'self' } },
    ]);
  });

  it('"whenever you attack" is the aggregate attack, and "you discard a card" the discard event', () => {
    expect(head('Whenever you attack, draw a card.')[0]).toMatchObject({
      when: 'attacks',
      aggregate: true,
    });
    expect(head('Whenever you discard a card, you gain 1 life.')).toEqual([
      { when: 'discardsCard', player: 'you' },
    ]);
  });
});

describe('Phase 4 batch 6: conditions and payments', () => {
  it('reads turn-history and board conditions as intervening ifs', () => {
    expect(
      head('At the beginning of each end step, if a creature died this turn, draw a card.')[0],
    ).toMatchObject({
      condition: { kind: 'compareValues', left: { kind: 'creaturesDiedThisTurn' }, cmp: '>=' },
    });
    expect(
      head('At the beginning of your upkeep, if you control no Snakes, draw a card.')[0],
    ).toMatchObject({ condition: { kind: 'countPermanents', scope: 'you', cmp: '<=', n: 0 } });
  });

  it('"you may pay {G}. If you do, …" pays on resolution and does nothing unpaid', () => {
    const def = interpretCard(
      creature('Whenever you gain life, you may pay {G}. If you do, draw a card.'),
    );
    expect(def.triggers[0]!.optional).toBe(false);
    expect(def.triggers[0]!.effects).toEqual([
      {
        op: 'conditionalEffect',
        condition: {
          kind: 'mayPayMana',
          cost: { generic: 0, colored: { W: 0, U: 0, B: 0, R: 0, G: 1 }, colorless: 0 },
        },
        then: [{ op: 'draw', count: { kind: 'const', n: 1 } }],
        else: [],
      },
    ]);
  });

  it('"you may pay 2 life. If you do" is a life payment', () => {
    const def = interpretCard(
      creature('Whenever a creature you control dies, you may pay 2 life. If you do, draw a card.'),
    );
    expect(def.triggers[0]!.effects[0]).toMatchObject({
      op: 'conditionalEffect',
      condition: { kind: 'mayPayLife', n: 2 },
    });
  });

  it('after "create a … token", "It gains haste" is about the token and is not read', () => {
    const def = interpretCard(
      creature(
        'Whenever a creature you control dies, create a 1/1 red Goblin creature token. It gains haste until end of turn.',
      ),
    );
    expect(def.modeled).toBe(false);
  });
});

describe('Phase 4 batch 6: keywords', () => {
  it('extort pays {W/B} for each opponent losing 1 and you gaining what was lost', () => {
    const effects = interpretCard(creature('Extort')).triggers[0]!.effects;
    expect(effects[0]).toMatchObject({
      op: 'conditionalEffect',
      then: [{ op: 'eachOpponentLosesLife', amount: 1 }, { op: 'gainLifeEqualToLifeLostThisWay' }],
    });
  });

  it('squad is a repeatable additional cost and a copy for each payment', () => {
    const def = interpretCard(creature('Squad {2}'));
    expect(def.optionalAdditionalCost).toMatchObject({ mechanic: 'squad', repeatable: true });
    expect(def.triggers[0]!.effects).toEqual([
      {
        op: 'createTokenCopyOf',
        ref: 'source',
        count: { kind: 'optionalCostCount', mechanic: 'squad' },
      },
    ]);
    // Squad on a noncreature is not this keyword's shape.
    expect(
      interpretCard(oracle({ name: 'P6 Spell', typeLine: 'Sorcery', oracleText: 'Squad {2}' }))
        .modeled,
    ).toBe(false);
  });

  it('squad keeps its paid count once the creature has left (CR 113.7a)', () => {
    const ctx = createGame(gameConfig(forestsPod(), { seed: 'p6-squad-left' }));
    const probe = creature('Squad {2}', { name: 'P6 Squad Probe' });
    const entered = spawn(ctx, 'P1', probe);
    entered.optionalCostCounts = { squad: 2 };
    queueTriggersForObject(ctx, 'enters', entered);
    pumpStrict(priorityCheckpoint(ctx));
    pumpStrict(movePermanentsToGraveyard(ctx, [entered]));
    pumpStrict(resolveTopOfStack(ctx));
    const copies = ctx.state.battlefield.filter((p) => p.name === 'P6 Squad Probe');
    expect(copies).toHaveLength(2);
    expect(copies.every((p) => p.isToken === true)).toBe(true);
  });

  it('an enters trigger reads the X its spell was cast with, even once it has left (CR 107.3m)', () => {
    const ctx = createGame(gameConfig(forestsPod(), { seed: 'p6-gadwick-x' }));
    const gadwick = creature(
      'When Gadwick enters, draw X cards.\nWhenever you cast a blue spell, tap target nonland permanent an opponent controls.',
      {
        name: 'Gadwick, the Wizened',
        manaCost: '{X}{U}{U}{U}',
        // Gadwick calls itself "Gadwick"; only a legendary card uses a short name (CR 201.5).
        typeLine: 'Legendary Creature — Human Wizard',
      },
    );
    const entered = spawn(ctx, 'P1', gadwick);
    entered.announcedX = 3;
    const handBefore = ctx.state.players.find((p) => p.id === 'P1')!.hand.length;
    queueTriggersForObject(ctx, 'enters', entered);
    pumpStrict(priorityCheckpoint(ctx));
    pumpStrict(movePermanentsToGraveyard(ctx, [entered]));
    pumpStrict(resolveTopOfStack(ctx));
    expect(ctx.state.players.find((p) => p.id === 'P1')!.hand.length).toBe(handBefore + 3);
  });

  it('squad paid twice creates both copies in one event: one "one or more tokens enter" trigger', () => {
    const ctx = createGame(gameConfig(forestsPod(), { seed: 'p6-squad-one-event' }));
    const watcher = oracle({
      name: 'P6 Token Watcher',
      typeLine: 'Enchantment',
      oracleText: 'Whenever one or more tokens you control enter, draw a card.',
    });
    spawn(ctx, 'P1', watcher);
    const entered = spawn(ctx, 'P1', creature('Squad {2}', { name: 'P6 Squad Batch' }));
    entered.optionalCostCounts = { squad: 2 };
    queueTriggersForObject(ctx, 'enters', entered);
    pumpStrict(priorityCheckpoint(ctx));
    // The squad trigger is the only one waiting; resolving it creates the copies.
    ctx.state.pendingTriggers = [];
    pumpStrict(resolveTopOfStack(ctx));
    const copies = ctx.state.battlefield.filter((p) => p.name === 'P6 Squad Batch' && p.isToken);
    expect(copies).toHaveLength(2);
    // "For each time its squad cost was paid" is one creation event (CR 111.1, 702.157a).
    const tokenWatches = ctx.state.pendingTriggers.filter((t) => t.sourceCardId !== entered.cardId);
    expect(tokenWatches.filter((t) => t.ability.effects.some((e) => e.op === 'draw'))).toHaveLength(
      1,
    );
  });

  it('battle cry pumps only the other attackers', () => {
    const effects = interpretCard(creature('Battle cry')).triggers[0]!.effects;
    expect(effects[0]).toMatchObject({
      op: 'pumpEachUntilEot',
      selector: { kind: 'allOf', of: [{ kind: 'other' }, expect.anything()] },
      power: 1,
      toughness: 0,
    });
  });
});
