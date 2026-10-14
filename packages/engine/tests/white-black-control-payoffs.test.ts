import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, computeTargetOptions } from '../src/actions/legal';
import type { PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { registerWhiteBlackControlPayoffOverrides } from '../src/cards/overrides/white-black-control-payoffs';
import { computeCharacteristics } from '../src/effects/continuous';
import { priorityCheckpoint } from '../src/sba/sba';
import { discardCard } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { EngineCardObject, EnginePermanent, GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, gameConfig, oracle, pump, spawn, swamp } from './fixtures';

interface PinnedCard {
  sha256: string;
  card: OracleCard;
}

const pinned = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/white-black-control-oracle.json', 'utf8'),
) as { cards: PinnedCard[] };

const pins = {
  'Archfiend of Ifnir': '6c5032145f59037b03b32b5eb8f73eab0da3e75df607c7485f5531b4f3e7d6aa',
  'Waste Not': '45df10c919fc24aac9c6c7a0120063af74262ed0fd1d18776c39f852a54ad04d',
  'Whispers of Emrakul': 'e6f95077a5da3657729c65b8c329cc5e93faffd0a530aee542abc934d02e7be7',
} as const;

type PayoffCardName = keyof typeof pins;
const cards = new Map<PayoffCardName, PinnedCard>();
for (const name of Object.keys(pins) as PayoffCardName[]) {
  const entry = pinned.cards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`Missing pinned Oracle card: ${name}`);
  cards.set(name, entry);
}

beforeAll(() => registerWhiteBlackControlPayoffOverrides());

function card(name: PayoffCardName): OracleCard {
  const entry = cards.get(name);
  if (entry === undefined) throw new Error(`Missing pinned card: ${name}`);
  return entry.card;
}

function context(seed = 'white-black-control-payoffs'): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(12, swamp) })),
      { seed },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  return ctx;
}

function player(ctx: GameContext, playerId: string) {
  const found = ctx.state.players.find((candidate) => candidate.id === playerId);
  if (found === undefined) throw new Error(`Missing player ${playerId}`);
  return found;
}

function cardWithTypes(
  name: string,
  typeLine: string,
  types: string[],
  extra: Partial<OracleCard> = {},
) {
  return oracle({
    name,
    typeLine,
    types,
    manaCost: null,
    cmc: 0,
    power: types.includes('Creature') ? '2' : null,
    toughness: types.includes('Creature') ? '2' : null,
    ...extra,
  });
}

/** Cast a card through priority, target selection, automatic mana payment, and resolution. */
function castFromHand(
  ctx: GameContext,
  playerId: string,
  printed: OracleCard,
  targets: ReadonlyMap<number, string> = new Map(),
): void {
  conjure(ctx, playerId, printed, 'hand');
  let cast = false;
  pump(runPrioritySequence(ctx), (decision) => {
    if (decision.decisionType === 'priority' && decision.player === playerId && !cast) {
      const index = decision.options.findIndex(
        (option) => option.type === 'castSpell' && option.description.includes(printed.name),
      );
      if (index >= 0) {
        cast = true;
        return { index, targets };
      }
    }
    return { index: 0, targets: new Map() };
  });
  expect(cast, `${printed.name} was cast normally`).toBe(true);
}

function castPermanent(ctx: GameContext, printed: OracleCard): EnginePermanent {
  const before = ctx.state.battlefield.map((permanent) => permanent.cardId);
  castFromHand(ctx, 'P1', printed);
  const result = ctx.state.battlefield.find(
    (permanent) => permanent.oracleId === printed.oracleId && !before.includes(permanent.cardId),
  );
  if (result === undefined) throw new Error(`${printed.name} did not resolve as a permanent`);
  return result;
}

function addSwamps(ctx: GameContext, count: number): void {
  for (let i = 0; i < count; i += 1) spawn(ctx, 'P1', swamp());
}

function resolveTriggeredAbilities(ctx: GameContext): void {
  pump(priorityCheckpoint(ctx));
  while (ctx.state.stack.length > 0) pump(resolveTopOfStack(ctx));
}

function discardFromHand(
  ctx: GameContext,
  playerId: string,
  printed: OracleCard,
): EngineCardObject {
  const object = conjure(ctx, playerId, printed, 'hand');
  pump(discardCard(ctx, object, playerId));
  return object;
}

function cyclingOption(ctx: GameContext, playerId: string, objectId: string) {
  return computePriorityOptions(ctx, player(ctx, playerId)).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return (
      payload.kind === 'activateAbility' &&
      payload.fromHand === true &&
      payload.objectId === objectId
    );
  });
}

function activateCycling(ctx: GameContext, playerId: string, object: EngineCardObject): void {
  const option = cyclingOption(ctx, playerId, object.id);
  expect(option, `${object.name} cycling is offered from hand`).toBeDefined();
  pump(
    applyPriorityAction(ctx, player(ctx, playerId), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
}

function discardWitness(
  name: string,
  typeLine: string,
  types: string[],
  extra: Partial<OracleCard> = {},
) {
  return cardWithTypes(name, typeLine, types, extra);
}

describe('white-black-control graveyard and discard payoffs — pinned Oracle', () => {
  it('uses all three exact wrapper hashes and models every printed clause', () => {
    for (const name of Object.keys(pins) as PayoffCardName[]) {
      const entry = cards.get(name)!;
      expect(entry.sha256, name).toBe(pins[name]);
      const definition = interpretCard(entry.card);
      expect(definition.modeled, `${name}: ${definition.unmodeledReasons.join('; ')}`).toBe(true);
      expect(definition.unmodeledReasons).toEqual([]);
    }
  });

  it('casts Archfiend of Ifnir normally and observes one own discard once for each opponent creature', () => {
    const ctx = context('archfiend-own-discard');
    addSwamps(ctx, 5);
    const archfiend = castPermanent(ctx, card('Archfiend of Ifnir'));
    expect(archfiend.controllerId).toBe('P1');

    const ownCreature = spawn(
      ctx,
      'P1',
      discardWitness('Own Bear', 'Creature — Bear', ['Creature']),
    );
    const p2Creature = spawn(ctx, 'P2', discardWitness('P2 Bear', 'Creature — Bear', ['Creature']));
    const p3Creature = spawn(ctx, 'P3', discardWitness('P3 Bear', 'Creature — Bear', ['Creature']));
    const p2Noncreature = spawn(ctx, 'P2', discardWitness('P2 Relic', 'Artifact', ['Artifact']));
    discardFromHand(ctx, 'P1', discardWitness('P1 Discard', 'Instant', ['Instant']));

    expect(ctx.state.pendingTriggers).toHaveLength(1);
    expect(ctx.state.pendingTriggers[0]?.scope?.eventPlayerId).toBe('P1');
    resolveTriggeredAbilities(ctx);

    expect(p2Creature.counters['-1/-1']).toBe(1);
    expect(p3Creature.counters['-1/-1']).toBe(1);
    expect(ownCreature.counters['-1/-1'] ?? 0).toBe(0);
    expect(p2Noncreature.counters['-1/-1'] ?? 0).toBe(0);
  });

  it('does not trigger Archfiend for an opponent discard and keeps the controller discard scope', () => {
    const ctx = context('archfiend-opponent-negative');
    addSwamps(ctx, 5);
    castPermanent(ctx, card('Archfiend of Ifnir'));
    const opponentCard = discardWitness('Opponent Discard', 'Creature — Bear', ['Creature']);
    discardFromHand(ctx, 'P2', opponentCard);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });

  it('casts Archfiend and normally cycles another copy from hand, triggering exactly once', () => {
    const ctx = context('archfiend-cycle-other');
    addSwamps(ctx, 7);
    castPermanent(ctx, card('Archfiend of Ifnir'));
    const p2Creature = spawn(
      ctx,
      'P2',
      discardWitness('Cycle Target', 'Creature — Bear', ['Creature']),
    );
    const otherCopy = conjure(ctx, 'P1', card('Archfiend of Ifnir'), 'hand');

    activateCycling(ctx, 'P1', otherCopy);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    expect(ctx.state.pendingTriggers[0]?.scope?.eventPlayerId).toBe('P1');
    expect(ctx.state.pendingTriggers[0]?.sourceCardId).not.toBe(otherCopy.cardId);
    resolveTriggeredAbilities(ctx);
    expect(p2Creature.counters['-1/-1']).toBe(1);
    expect(
      player(ctx, 'P1').graveyard.filter((entry) => entry.cardId === otherCopy.cardId),
    ).toHaveLength(1);
    expect(player(ctx, 'P1').hand).toHaveLength(1); // one card drawn by cycling
  });

  it('does not observe Archfiend cycling itself, but still pays the cycling cost and draws', () => {
    const ctx = context('archfiend-cycle-self-negative');
    addSwamps(ctx, 2);
    const self = conjure(ctx, 'P1', card('Archfiend of Ifnir'), 'hand');

    activateCycling(ctx, 'P1', self);
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === self.cardId)).toBe(false);
    expect(player(ctx, 'P1').graveyard.some((entry) => entry.cardId === self.cardId)).toBe(true);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    pump(resolveTopOfStack(ctx));
    expect(player(ctx, 'P1').hand).toHaveLength(1);
  });

  it('casts Waste Not and creates a black 2/2 Zombie after an opponent discards a creature', () => {
    const ctx = context('waste-not-creature');
    addSwamps(ctx, 3);
    castPermanent(ctx, card('Waste Not'));
    const librarySize = player(ctx, 'P1').library.length;
    discardFromHand(ctx, 'P2', discardWitness('Discarded Bear', 'Creature — Bear', ['Creature']));
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    resolveTriggeredAbilities(ctx);

    const zombie = ctx.state.battlefield.find(
      (permanent) => permanent.controllerId === 'P1' && permanent.name === 'Zombie',
    );
    expect(zombie).toBeDefined();
    expect(computeCharacteristics(ctx, zombie!).types).toContain('Creature');
    expect(computeCharacteristics(ctx, zombie!).subtypes).toContain('Zombie');
    expect(computeCharacteristics(ctx, zombie!).colors).toContain('B');
    expect(computeCharacteristics(ctx, zombie!).power).toBe(2);
    expect(computeCharacteristics(ctx, zombie!).toughness).toBe(2);
    expect(player(ctx, 'P1').library).toHaveLength(librarySize);
  });

  it('puts Waste Not black mana on the stack and adds {B}{B} only when that trigger resolves', () => {
    const ctx = context('waste-not-land');
    addSwamps(ctx, 3);
    castPermanent(ctx, card('Waste Not'));
    const manaBefore = player(ctx, 'P1').manaPool.B;
    discardFromHand(ctx, 'P2', discardWitness('Discarded Land', 'Land — Swamp', ['Land']));
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    expect(player(ctx, 'P1').manaPool.B).toBe(manaBefore);
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.stack).toHaveLength(1);
    expect(player(ctx, 'P1').manaPool.B).toBe(manaBefore);
    pump(resolveTopOfStack(ctx));
    expect(player(ctx, 'P1').manaPool.B).toBe(manaBefore + 2);
  });

  it('casts Waste Not and draws one for an opponent noncreature, nonland discard, but not its own', () => {
    const ctx = context('waste-not-noncreature');
    addSwamps(ctx, 3);
    castPermanent(ctx, card('Waste Not'));
    const handBefore = player(ctx, 'P1').hand.length;
    discardFromHand(ctx, 'P2', discardWitness('Discarded Instant', 'Instant', ['Instant']));
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    resolveTriggeredAbilities(ctx);
    expect(player(ctx, 'P1').hand).toHaveLength(handBefore + 1);

    discardFromHand(ctx, 'P1', discardWitness('Controller Discard', 'Instant', ['Instant']));
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    expect(player(ctx, 'P1').hand).toHaveLength(handBefore + 1);
  });

  it('dispatches both Waste Not triggers for a discarded creature land by its printed types', () => {
    const ctx = context('waste-not-creature-land');
    addSwamps(ctx, 3);
    castPermanent(ctx, card('Waste Not'));
    const creatureLand = discardWitness(
      'Discarded Dryad Land',
      'Land Creature — Dryad',
      ['Land', 'Creature'],
      { subtypes: ['Dryad'] },
    );
    discardFromHand(ctx, 'P2', creatureLand);
    expect(ctx.state.pendingTriggers).toHaveLength(2);
    resolveTriggeredAbilities(ctx);

    expect(
      ctx.state.battlefield.filter(
        (permanent) => permanent.controllerId === 'P1' && permanent.name === 'Zombie',
      ),
    ).toHaveLength(1);
    expect(player(ctx, 'P1').manaPool.B).toBe(2);
  });

  it('casts Whispers normally and uses one random discard below delirium despite opponent types and the resolving spell', () => {
    const ctx = context('whispers-below-threshold');
    addSwamps(ctx, 2);
    conjure(
      ctx,
      'P1',
      discardWitness('Own Land Type', 'Basic Land — Plains', ['Land'], {
        supertypes: ['Basic'],
        subtypes: ['Plains'],
      }),
      'graveyard',
    );
    conjure(
      ctx,
      'P1',
      discardWitness('Own Creature Type', 'Legendary Creature — Wizard', ['Creature'], {
        supertypes: ['Legendary'],
        subtypes: ['Wizard'],
      }),
      'graveyard',
    );
    conjure(
      ctx,
      'P1',
      discardWitness('Own Enchantment Type', 'Enchantment — Saga', ['Enchantment'], {
        subtypes: ['Saga'],
      }),
      'graveyard',
    );
    conjure(
      ctx,
      'P2',
      discardWitness('Opponent Instant Type', 'Instant', ['Instant'], {
        oracleText: 'Draw a card.',
      }),
      'graveyard',
    );
    conjure(
      ctx,
      'P2',
      discardWitness('Opponent Sorcery Type', 'Sorcery', ['Sorcery'], {
        oracleText: 'Draw a card.',
      }),
      'graveyard',
    );
    for (const name of ['Whispers Target A', 'Whispers Target B', 'Whispers Target C']) {
      conjure(ctx, 'P2', discardWitness(name, 'Land — Test', ['Land']), 'hand');
    }
    const before = player(ctx, 'P2').hand.length;
    castFromHand(ctx, 'P1', card('Whispers of Emrakul'), new Map([[0, 'P2']]));

    expect(player(ctx, 'P2').hand).toHaveLength(before - 1);
    expect(
      player(ctx, 'P2').graveyard.filter((entry) => entry.name.startsWith('Whispers Target')),
    ).toHaveLength(1);
    expect(player(ctx, 'P1').graveyard.some((entry) => entry.name === 'Whispers of Emrakul')).toBe(
      true,
    );
  });

  it('does not count the resolving Whispers of Emrakul as a Sorcery in its own graveyard', () => {
    const ctx = context('whispers-resolving-spell-not-in-graveyard');
    addSwamps(ctx, 2);
    conjure(
      ctx,
      'P1',
      discardWitness('Own Land', 'Basic Land — Plains', ['Land'], {
        supertypes: ['Basic'],
        subtypes: ['Plains'],
      }),
      'graveyard',
    );
    conjure(
      ctx,
      'P1',
      discardWitness('Own Creature', 'Legendary Creature — Wizard', ['Creature'], {
        supertypes: ['Legendary'],
        subtypes: ['Wizard'],
      }),
      'graveyard',
    );
    conjure(
      ctx,
      'P1',
      discardWitness('Own Enchantment', 'Enchantment — Saga', ['Enchantment'], {
        subtypes: ['Saga'],
      }),
      'graveyard',
    );
    for (const name of [
      'Resolving Spell Target A',
      'Resolving Spell Target B',
      'Resolving Spell Target C',
    ]) {
      conjure(ctx, 'P2', discardWitness(name, 'Land — Test', ['Land']), 'hand');
    }

    castFromHand(ctx, 'P1', card('Whispers of Emrakul'), new Map([[0, 'P2']]));
    expect(
      player(ctx, 'P2').graveyard.filter((entry) =>
        entry.name.startsWith('Resolving Spell Target'),
      ),
    ).toHaveLength(1);
    expect(player(ctx, 'P1').graveyard.some((entry) => entry.name === 'Whispers of Emrakul')).toBe(
      true,
    );
  });

  it('counts a multityped artifact creature as two of its own graveyard card types and replays randomly', () => {
    const run = (seed: string): string[] => {
      const ctx = context(seed);
      addSwamps(ctx, 2);
      conjure(
        ctx,
        'P1',
        discardWitness('Own Land', 'Basic Land — Plains', ['Land'], {
          supertypes: ['Basic'],
          subtypes: ['Plains'],
        }),
        'graveyard',
      );
      conjure(
        ctx,
        'P1',
        discardWitness('Own Creature', 'Legendary Creature — Wizard', ['Creature'], {
          supertypes: ['Legendary'],
          subtypes: ['Wizard'],
        }),
        'graveyard',
      );
      conjure(
        ctx,
        'P1',
        discardWitness('Own Enchantment', 'Enchantment — Aura', ['Enchantment'], {
          subtypes: ['Aura'],
        }),
        'graveyard',
      );
      conjure(
        ctx,
        'P1',
        discardWitness(
          'Own Artifact Creature',
          'Artifact Creature — Golem',
          ['Artifact', 'Creature'],
          {
            subtypes: ['Golem'],
          },
        ),
        'graveyard',
      );
      conjure(
        ctx,
        'P2',
        discardWitness('Opponent Enchantment', 'Enchantment — Saga', ['Enchantment']),
        'graveyard',
      );
      conjure(
        ctx,
        'P2',
        discardWitness('Opponent Instant', 'Instant', ['Instant'], { oracleText: 'Draw a card.' }),
        'graveyard',
      );
      for (const name of ['Threshold Target A', 'Threshold Target B', 'Threshold Target C']) {
        conjure(ctx, 'P2', discardWitness(name, 'Land — Test', ['Land']), 'hand');
      }
      castFromHand(ctx, 'P1', card('Whispers of Emrakul'), new Map([[0, 'P2']]));
      return player(ctx, 'P2')
        .graveyard.filter((entry) => entry.name.startsWith('Threshold Target'))
        .map((entry) => entry.name)
        .sort();
    };

    const first = run('whispers-delirium-seeded');
    expect(first).toHaveLength(2);
    expect(run('whispers-delirium-seeded')).toEqual(first);
  });

  it('offers Whispers of Emrakul only to opponents, excluding its controller as an illegal target', () => {
    const ctx = context('whispers-target-eligibility');
    addSwamps(ctx, 2);
    conjure(ctx, 'P1', card('Whispers of Emrakul'), 'hand');
    const def = interpretCard(card('Whispers of Emrakul'));
    expect(def.spellAbility).toBeDefined();
    expect(
      computePriorityOptions(ctx, player(ctx, 'P1')).some((option) => {
        const payload = option.payload as PriorityActionPayload;
        return payload.kind === 'castSpell' && option.description.includes('Whispers of Emrakul');
      }),
    ).toBe(true);
    expect(computeTargetOptions(ctx, def.spellAbility!.targets[0]!, 'P1')).toEqual([
      'P2',
      'P3',
      'P4',
    ]);
  });
});
