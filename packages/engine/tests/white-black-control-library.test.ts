import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import type { Ability } from '../src/cards/ability';
import { interpretCard } from '../src/cards/interpret';
import { registerWhiteBlackControlLibraryOverrides } from '../src/cards/overrides/white-black-control-library';
import { registerWhiteBlackControlDiscardOverrides } from '../src/cards/overrides/white-black-control-discard';
import { registerWhiteBlackControlPayoffOverrides } from '../src/cards/overrides/white-black-control-payoffs';
import { registerWhiteBlackControlTinybonesOverrides } from '../src/cards/overrides/white-black-control-tinybones';
import { resolveTopOfStack } from '../src/stack/stack';
import { priorityCheckpoint } from '../src/sba/sba';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { discardCard } from '../src/state/objects';
import { hasNoMaximumHandSize } from '../src/state/queries';
import { createGame } from '../src/state/game';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { executeAbility } from '../src/effects/resolve';
import { runPrioritySequence } from '../src/turn/priority';
import { queueStepTriggers, runTurn } from '../src/turn/turn';
import { registerWhiteBlackControlGraveyardOverrides } from '../src/cards/overrides/white-black-control-graveyard';
import { copies, conjure, gameConfig, oracle, pick, plains, pump, spawn, swamp } from './fixtures';

interface PinnedCard {
  sha256: string;
  card: OracleCard;
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/white-black-control-oracle.json', import.meta.url), 'utf8'),
) as { cards: PinnedCard[] };

const pins = {
  'Library of Leng': 'f31e4191d9a77e591944db00ae0e1ba6ed3809c0a66f3287bd97be79ddfe5571',
  "Geth's Grimoire": '5b69db18aafa89cd067bbe5be9d0b6397b00200abe381fbfea927a3d6e682a91',
  'Archfiend of Ifnir': '6c5032145f59037b03b32b5eb8f73eab0da3e75df607c7485f5531b4f3e7d6aa',
  'Waste Not': '45df10c919fc24aac9c6c7a0120063af74262ed0fd1d18776c39f852a54ad04d',
  'Tinybones, Trinket Thief': 'fa942a88eac3190440d190334f15b964ae56dfb0fb5bcc87d876b8df28cf4651',
  'Rest in Peace': '9519ed723522e91ca26f35969166d20f2c1e764dc274282a377c52851a63d2a4',
} as const;

type CardName = keyof typeof pins;
const cards = new Map<CardName, PinnedCard>();
for (const [name, sha256] of Object.entries(pins) as [CardName, string][]) {
  const entry = fixture.cards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`Missing pinned Oracle card: ${name}`);
  if (entry.sha256 !== sha256) throw new Error(`Oracle hash drift for ${name}`);
  cards.set(name, entry);
}

beforeAll(() => {
  registerWhiteBlackControlLibraryOverrides();
  registerWhiteBlackControlDiscardOverrides();
  registerWhiteBlackControlPayoffOverrides();
  registerWhiteBlackControlTinybonesOverrides();
  registerWhiteBlackControlGraveyardOverrides();
});

function card(name: CardName): OracleCard {
  const entry = cards.get(name);
  if (entry === undefined) throw new Error(`Missing pinned card ${name}`);
  return entry.card;
}

function context(seed = 'white-black-control-library'): GameContext {
  const game = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(16, swamp) })),
      { seed },
    ),
  );
  Object.assign(game.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  return game;
}

function player(game: GameContext, id: string) {
  const found = game.state.players.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`Missing player ${id}`);
  return found;
}

function castFromHand(
  game: GameContext,
  playerId: string,
  printed: OracleCard,
): EnginePermanent | undefined {
  const previous = new Set(game.state.battlefield.map((permanent) => permanent.cardId));
  const oldTurnPlayer = game.state.currentTurnPlayer;
  const oldActiveIndex = game.state.activePlayerIndex;
  game.state.currentTurnPlayer = playerId;
  game.state.activePlayerIndex = game.state.players.findIndex(
    (candidate) => candidate.id === playerId,
  );
  conjure(game, playerId, printed, 'hand');
  let cast = false;
  pump(runPrioritySequence(game), (decision) => {
    if (decision.decisionType === 'priority' && decision.player === playerId && !cast) {
      const index = decision.options.findIndex(
        (option) => option.type === 'castSpell' && option.description.includes(printed.name),
      );
      if (index >= 0) {
        cast = true;
        return { index, targets: new Map() };
      }
    }
    return pick(decision, /Pass|does not/i);
  });
  game.state.currentTurnPlayer = oldTurnPlayer;
  game.state.activePlayerIndex = oldActiveIndex;
  expect(cast, `${printed.name} cast from hand through priority`).toBe(true);
  return game.state.battlefield.find(
    (permanent) =>
      permanent.cardId !== undefined &&
      !previous.has(permanent.cardId) &&
      permanent.name === printed.name,
  );
}

function addMana(game: GameContext, playerId: string, count: number): void {
  for (let index = 0; index < count; index++) spawn(game, playerId, swamp());
}

function castLibrary(game: GameContext): EnginePermanent {
  return castLibraryFor(game, 'P1');
}

function castLibraryFor(game: GameContext, playerId: string): EnginePermanent {
  const oldTurnPlayer = game.state.currentTurnPlayer;
  const oldActiveIndex = game.state.activePlayerIndex;
  game.state.currentTurnPlayer = playerId;
  game.state.activePlayerIndex = game.state.players.findIndex(
    (candidate) => candidate.id === playerId,
  );
  addMana(game, playerId, 1);
  const library = castFromHand(game, playerId, card('Library of Leng'));
  game.state.currentTurnPlayer = oldTurnPlayer;
  game.state.activePlayerIndex = oldActiveIndex;
  if (library === undefined) throw new Error('Library of Leng did not resolve as a permanent');
  return library;
}

function dummyEffectSource(game: GameContext, id = 'P1'): EnginePermanent {
  return spawn(
    game,
    id,
    oracle({
      name: 'Discard Effect Source',
      typeLine: 'Artifact',
      types: ['Artifact'],
      manaCost: null,
      cmc: 0,
      power: null,
      toughness: null,
    }),
  );
}

function discardAbility(count = 1, atRandom = false): Ability {
  return {
    kind: 'activated',
    targets: [{ kind: 'player' }],
    effects: [
      {
        op: 'discardTarget',
        target: 0,
        count: { kind: 'const', n: count },
        ...(atRandom ? { atRandom: true as const } : {}),
      },
    ],
  };
}

function resolveAbility(
  game: GameContext,
  source: EnginePermanent,
  ability: Ability,
  target: string,
  answer?: Parameters<typeof pump>[1],
): void {
  const ref = {
    id: source.id,
    cardId: source.cardId,
    name: source.name,
    oracleId: source.oracleId,
    controllerId: source.controllerId,
  };
  pump(executeAbility(game, ref, ability, [target]), answer);
  pump(priorityCheckpoint(game));
}

function settleStack(game: GameContext, answer?: Parameters<typeof pump>[1]): void {
  while (game.state.stack.length > 0) pump(resolveTopOfStack(game), answer);
}

function handCard(name: string, typeLine = 'Basic Land — Test'): OracleCard {
  const types = typeLine.includes('Creature')
    ? ['Creature']
    : typeLine.includes('Land')
      ? ['Land']
      : typeLine.includes('Artifact')
        ? ['Artifact']
        : typeLine.includes('Enchantment')
          ? ['Enchantment']
          : ['Instant'];
  return oracle({ name, typeLine, types, manaCost: null, cmc: 1, power: null, toughness: null });
}

describe('Library of Leng — pinned Oracle effect-discard and hand-size behavior', () => {
  it('pins and locally replaces the exact Oracle card with both printed clauses', () => {
    expect(cards.get('Library of Leng')?.sha256).toBe(pins['Library of Leng']);
    const definition = interpretCard(card('Library of Leng'));
    expect(definition.modeled, definition.unmodeledReasons.join('; ')).toBe(true);
    expect(definition.unmodeledReasons).toEqual([]);
    expect(definition.ruleStatics).toEqual(
      expect.arrayContaining([
        { kind: 'noMaximumHandSize' },
        { kind: 'effectDiscardMayGoToLibraryTop' },
      ]),
    );
  });

  it('library-leng-c01-positive — casts normally and preserves more than seven cards through the real cleanup step', () => {
    const game = context('library-leng-cleanup');
    castLibrary(game);
    for (let index = 0; index < 8; index++)
      conjure(game, 'P1', handCard(`Excess Hand ${index}`), 'hand');
    expect(player(game, 'P1').hand).toHaveLength(8);
    expect(hasNoMaximumHandSize(game, 'P1')).toBe(true);

    // The turn runner includes the real ending/cleanup loop after normal priority passes.
    pump(runTurn(game), (decision) => pick(decision, /Pass|does not/i));
    expect(player(game, 'P1').hand).toHaveLength(9); // Eight cards plus the normal draw step card.
    expect(hasNoMaximumHandSize(game, 'P1')).toBe(true);
  });

  it('library-leng-c02-positive — an effect discard may go to the top, stays private, and still counts as a discard', () => {
    const game = context('library-leng-effect-top');
    castLibrary(game);
    const source = dummyEffectSource(game);
    const discarded = conjure(game, 'P1', handCard('Controller Artifact'), 'hand');
    const initialDiscardCount = player(game, 'P1').discardedCardsThisTurn ?? 0;
    let libraryPrompts = 0;
    resolveAbility(game, source, discardAbility(), 'P1', (decision) => {
      if (decision.prompt.includes('Library of Leng')) {
        libraryPrompts++;
        expect(decision.player).toBe('P1');
        return pick(decision, 'Put it on top of your library');
      }
      return pick(decision, /Pass|does not/i);
    });

    expect(libraryPrompts).toBe(1);
    expect(player(game, 'P1').library[0]?.cardId).toBe(discarded.cardId);
    expect(player(game, 'P1').graveyard.some((object) => object.cardId === discarded.cardId)).toBe(
      false,
    );
    expect(player(game, 'P1').discardedCardsThisTurn).toBe(initialDiscardCount + 1);
    const discardLog = game.state.eventLog.find(
      (entry) => entry.type === 'discard' && entry.payload['cardId'] === discarded.cardId,
    );
    expect(discardLog).toBeDefined();
    expect(discardLog?.payload['name']).toBeUndefined();
  });

  it('library-leng-c02-negative — the affected player may decline, and another player cannot use your Library', () => {
    const game = context('library-leng-decline-and-scope');
    castLibrary(game);
    const source = dummyEffectSource(game);
    const ownCard = conjure(game, 'P1', handCard('Controller Effect Discard'), 'hand');
    let prompts = 0;
    resolveAbility(game, source, discardAbility(), 'P1', (decision) => {
      if (decision.prompt.includes('Library of Leng')) {
        prompts++;
        return pick(decision, 'Discard it normally');
      }
      return pick(decision, /Pass|does not/i);
    });
    expect(prompts).toBe(1);
    expect(player(game, 'P1').graveyard.some((object) => object.cardId === ownCard.cardId)).toBe(
      true,
    );

    const opponentCard = conjure(game, 'P2', handCard('Unaffected Opponent Card'), 'hand');
    pump(discardCard(game, opponentCard, 'P2'));
    expect(
      player(game, 'P2').graveyard.some((object) => object.cardId === opponentCard.cardId),
    ).toBe(true);
  });

  it('library-leng-c03-positive — random and multi-card effect discards ask separately for each card', () => {
    const game = context('library-leng-random-and-multiple');
    castLibrary(game);
    const source = dummyEffectSource(game);
    const first = conjure(game, 'P1', handCard('Random Choice A'), 'hand');
    const second = conjure(game, 'P1', handCard('Random Choice B'), 'hand');
    const third = conjure(game, 'P1', handCard('Chosen Choice C'), 'hand');
    const combined: Ability = {
      kind: 'activated',
      targets: [{ kind: 'player' }],
      effects: [
        { op: 'discardTarget', target: 0, count: { kind: 'const', n: 1 }, atRandom: true },
        { op: 'discardTarget', target: 0, count: { kind: 'const', n: 2 } },
      ],
    };
    const choices: string[] = [];
    resolveAbility(game, source, combined, 'P1', (decision) => {
      if (decision.prompt.includes('Library of Leng')) {
        choices.push(decision.prompt);
        return pick(decision, 'Put it on top of your library');
      }
      if (decision.decisionType === 'general' && decision.prompt.includes('Discard a card'))
        return pick(decision, /^Discard /);
      return pick(decision, /Pass|does not/i);
    });
    expect(choices).toHaveLength(3);
    expect(
      [first, second, third].filter((object) =>
        player(game, 'P1').library.some((entry) => entry.cardId === object.cardId),
      ),
    ).toHaveLength(3);
    expect(player(game, 'P1').discardedCardsThisTurn).toBe(3);
  });

  it('library-leng-c04-negative — costs, cycling, and cleanup discards cannot redirect to the library', () => {
    const game = context('library-leng-cost-cleanup');
    castLibrary(game);
    const costCard = conjure(game, 'P1', handCard('Discard Cost'), 'hand');
    let prompts = 0;
    pump(discardCard(game, costCard, 'P1', 'cost'), (decision) => {
      if (decision.prompt.includes('Library of Leng')) prompts++;
      return pick(decision, /Pass|does not/i);
    });
    const cleanupCard = conjure(game, 'P1', handCard('Cleanup Discard'), 'hand');
    pump(discardCard(game, cleanupCard, 'P1', 'cleanup'), (decision) => {
      if (decision.prompt.includes('Library of Leng')) prompts++;
      return pick(decision, /Pass|does not/i);
    });
    expect(prompts).toBe(0);
    expect(player(game, 'P1').graveyard.map((object) => object.cardId)).toEqual(
      expect.arrayContaining([costCard.cardId, cleanupCard.cardId]),
    );

    const cycling = context('library-leng-cycling-cost');
    castLibrary(cycling);
    addMana(cycling, 'P1', 2);
    const cycler = conjure(cycling, 'P1', card('Archfiend of Ifnir'), 'hand');
    const option = computePriorityOptions(cycling, player(cycling, 'P1')).find((candidate) => {
      const payload = candidate.payload as PriorityActionPayload;
      return (
        payload.kind === 'activateAbility' &&
        payload.fromHand === true &&
        payload.objectId === cycler.id
      );
    });
    expect(option, 'cycling is offered from hand through the normal priority action').toBeDefined();
    let cyclingPrompts = 0;
    pump(
      applyPriorityAction(
        cycling,
        player(cycling, 'P1'),
        option!.payload as PriorityActionPayload,
        {
          index: 0,
          targets: new Map(),
        },
      ),
      (decision) => {
        if (decision.prompt.includes('Library of Leng')) cyclingPrompts++;
        return pick(decision, /Pass|does not/i);
      },
    );
    expect(cyclingPrompts).toBe(0);
    expect(player(cycling, 'P1').graveyard.some((object) => object.cardId === cycler.cardId)).toBe(
      true,
    );
    pump(priorityCheckpoint(cycling));
    settleStack(cycling);
    expect(player(cycling, 'P1').hand).toHaveLength(1); // Cycling still draws normally.
  });

  it('library-leng-c05-positive — hidden discards still trigger generic discard watchers but not type-based effects', () => {
    const game = context('library-leng-hidden-characteristics');
    castLibrary(game);
    addMana(game, 'P1', 10);
    const grimoire = castFromHand(game, 'P1', card("Geth's Grimoire"));
    const wasteNot = castFromHand(game, 'P1', card('Waste Not'));
    const tinybones = castFromHand(game, 'P1', card('Tinybones, Trinket Thief'));
    addMana(game, 'P2', 6);
    const archfiend = castFromHand(game, 'P2', card('Archfiend of Ifnir'));
    if (!grimoire || !archfiend || !wasteNot || !tinybones)
      throw new Error('discard watcher failed normal cast');
    expect(game.defs.get(grimoire.oracleId)?.triggers).toHaveLength(1);
    castLibraryFor(game, 'P2');
    const opponentCreature = spawn(
      game,
      'P1',
      oracle({
        name: 'Archfiend Hidden Discard Target',
        typeLine: 'Creature — Bear',
        types: ['Creature'],
        manaCost: null,
        cmc: 0,
        power: '2',
        toughness: '2',
      }),
    );
    const discardedCreature = conjure(
      game,
      'P2',
      handCard('Hidden Creature', 'Creature — Bear'),
      'hand',
    );
    const handBeforeTriggers = player(game, 'P1').hand.length;
    player(game, 'P1').life = 40;
    pump(discardCard(game, discardedCreature, 'P2'), (decision) =>
      decision.prompt.includes('Library of Leng')
        ? pick(decision, 'Put it on top of your library')
        : pick(decision, /Pass|does not/i),
    );
    expect(game.state.pendingTriggers).toHaveLength(2);
    pump(priorityCheckpoint(game));
    expect(player(game, 'P2').library[0]?.cardId).toBe(discardedCreature.cardId);
    expect(game.state.pendingTriggers).toHaveLength(0);
    expect(game.state.stack).toHaveLength(2);
    settleStack(game, (decision) => {
      if (/draw a card/i.test(decision.prompt)) return pick(decision, 'Yes');
      return pick(decision, /Pass|does not/i);
    });
    expect(opponentCreature.counters['-1/-1']).toBe(1); // Archfiend's 'another card' trigger sees the discard.
    queueStepTriggers(game, 'endStep');
    pump(priorityCheckpoint(game));
    expect(game.state.stack).toHaveLength(1); // Tinybones sees the opponent's discard count, even hidden.
    settleStack(game);
    expect(player(game, 'P1').life).toBe(39);
    expect(player(game, 'P1').hand).toHaveLength(handBeforeTriggers + 2); // Geth and Tinybones each draw.
    expect(game.state.battlefield.filter((permanent) => permanent.name === 'Zombie')).toHaveLength(
      0,
    );
    expect(player(game, 'P1').manaPool.B).toBe(0);
    expect(player(game, 'P1').hand.some((entry) => entry.name === discardedCreature.name)).toBe(
      false,
    );
  });

  it('library-leng-c06-negative — hidden land identity does not produce Waste Not mana', () => {
    const game = context('library-leng-hidden-land');
    castLibrary(game);
    addMana(game, 'P2', 3);
    castLibraryFor(game, 'P2');
    addMana(game, 'P1', 3);
    const wasteNot = castFromHand(game, 'P1', card('Waste Not'));
    if (!wasteNot) throw new Error('Waste Not failed normal cast');
    const discardedLand = conjure(game, 'P2', handCard('Hidden Land', 'Land — Swamp'), 'hand');
    const source = dummyEffectSource(game);
    resolveAbility(game, source, discardAbility(), 'P2', (decision) =>
      decision.prompt.includes('Library of Leng')
        ? pick(decision, 'Put it on top of your library')
        : pick(decision, /Pass|does not/i),
    );
    settleStack(game);
    expect(player(game, 'P2').library[0]?.cardId).toBe(discardedLand.cardId);
    expect(game.state.pendingTriggers).toHaveLength(0);
    expect(player(game, 'P1').manaPool.B).toBe(0);
  });

  it('library-leng-c07-negative — hidden nonland discard does not draw through Waste Not', () => {
    const game = context('library-leng-hidden-noncreature');
    castLibrary(game);
    addMana(game, 'P2', 3);
    castLibraryFor(game, 'P2');
    addMana(game, 'P1', 3);
    const wasteNot = castFromHand(game, 'P1', card('Waste Not'));
    if (!wasteNot) throw new Error('Waste Not failed normal cast');
    const handBefore = player(game, 'P1').hand.length;
    const discarded = conjure(game, 'P2', handCard('Hidden Artifact', 'Artifact'), 'hand');
    const source = dummyEffectSource(game);
    resolveAbility(game, source, discardAbility(), 'P2', (decision) =>
      decision.prompt.includes('Library of Leng')
        ? pick(decision, 'Put it on top of your library')
        : pick(decision, /Pass|does not/i),
    );
    settleStack(game);
    expect(player(game, 'P2').library[0]?.cardId).toBe(discarded.cardId);
    expect(game.state.pendingTriggers).toHaveLength(0);
    expect(player(game, 'P1').hand).toHaveLength(handBefore);
  });

  it('library-leng-c08-negative — an effect discard cannot use Library after it leaves the battlefield', () => {
    const game = context('library-leng-source-gone');
    const library = castLibrary(game);
    const source = dummyEffectSource(game);
    const discarded = conjure(game, 'P1', handCard('No Longer Protected'), 'hand');
    game.state.battlefield = game.state.battlefield.filter(
      (permanent) => permanent.id !== library.id,
    );
    let prompts = 0;
    resolveAbility(game, source, discardAbility(), 'P1', (decision) => {
      if (decision.prompt.includes('Library of Leng')) prompts++;
      return pick(decision, /Pass|does not/i);
    });
    expect(prompts).toBe(0);
    expect(player(game, 'P1').graveyard.some((object) => object.cardId === discarded.cardId)).toBe(
      true,
    );
  });

  it('library-leng-c10-positive — a connive discard redirected to the library has unknown characteristics and adds no counter', () => {
    const game = context('library-leng-connive-hidden');
    castLibraryFor(game, 'P2');
    const conniver = spawn(
      game,
      'P2',
      oracle({
        name: 'Test Conniver',
        typeLine: 'Creature — Rogue',
        types: ['Creature'],
        manaCost: null,
        cmc: 2,
        power: '2',
        toughness: '2',
      }),
    );
    const drawn = conjure(game, 'P2', handCard('Hidden Connive Artifact', 'Artifact'), 'library');
    const source = {
      id: conniver.id,
      cardId: conniver.cardId,
      name: conniver.name,
      oracleId: conniver.oracleId,
      controllerId: conniver.controllerId,
    };
    pump(
      executeAbility(
        game,
        source,
        { kind: 'activated', targets: [], effects: [{ op: 'connive' }] },
        [],
      ),
      (decision) => {
        if (decision.prompt.includes('Library of Leng'))
          return pick(decision, 'Put it on top of your library');
        if (decision.prompt.toLowerCase().includes('discard'))
          return pick(decision, 'Hidden Connive Artifact');
        return pick(decision, /Pass|does not/i);
      },
    );
    expect(player(game, 'P2').library[0]?.cardId).toBe(drawn.cardId);
    expect(conniver.counters['+1/+1'] ?? 0).toBe(0);
    expect(player(game, 'P2').discardedCardsThisTurn).toBe(1);
  });

  it('library-leng-c09-positive — Library can keep a card out of a graveyard replacement, while declining still counts as a discard', () => {
    const game = context('library-leng-rest-in-peace');
    spawn(game, 'P1', plains());
    addMana(game, 'P1', 1);
    const restInPeace = castFromHand(game, 'P1', card('Rest in Peace'));
    if (!restInPeace) throw new Error('Rest in Peace failed normal cast');
    castLibraryFor(game, 'P2');
    const source = dummyEffectSource(game);

    const keptOnTop = conjure(game, 'P2', handCard('Replacement Avoided'), 'hand');
    resolveAbility(game, source, discardAbility(), 'P2', (decision) =>
      decision.prompt.includes('Library of Leng')
        ? pick(decision, 'Put it on top of your library')
        : pick(decision, /Pass|does not/i),
    );
    expect(player(game, 'P2').library[0]?.cardId).toBe(keptOnTop.cardId);
    expect(game.state.exile.some((object) => object.cardId === keptOnTop.cardId)).toBe(false);
    expect(player(game, 'P2').discardedCardsThisTurn).toBe(1);

    const declined = conjure(game, 'P2', handCard('Replacement Exiled'), 'hand');
    resolveAbility(game, source, discardAbility(), 'P2', (decision) =>
      decision.prompt.includes('Library of Leng')
        ? pick(decision, 'Discard it normally')
        : pick(decision, /Pass|does not/i),
    );
    expect(player(game, 'P2').graveyard.some((object) => object.cardId === declined.cardId)).toBe(
      false,
    );
    expect(game.state.exile.some((object) => object.cardId === declined.cardId)).toBe(true);
    expect(player(game, 'P2').discardedCardsThisTurn).toBe(2);
  });
});
