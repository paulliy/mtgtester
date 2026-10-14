import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { registerWhiteBlackControlGraveyardTriggerOverrides } from '../src/cards/overrides/white-black-control-graveyard-triggers';
import { registerWhiteBlackControlGraveyardOverrides } from '../src/cards/overrides/white-black-control-graveyard';
import { computeCharacteristics } from '../src/effects/continuous';
import { discardCard, moveObject, movePermanentsTogether } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { EnginePermanent, EnginePlayerState, GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { priorityCheckpoint } from '../src/sba/sba';
import { runCombatPhase } from '../src/combat/combat';
import {
  declareAttacks,
  copies,
  conjure,
  gameConfig,
  oracle,
  pick,
  plains,
  pump,
  spawn,
  swamp,
} from './fixtures';

interface PinnedCard {
  sha256: string;
  card: OracleCard;
}
const pinned = JSON.parse(
  readFileSync(new URL('./fixtures/white-black-control-oracle.json', import.meta.url), 'utf8'),
) as { cards: PinnedCard[] };
const pins = {
  'Planar Void': '146d72b8e678921fad84434578e02fd647a18c6cf2733a55c2df2d45080cf066',
  'The Haunt of Hightower': '85b6c7f3a24a701a82b107aa6b27a0a07cc0796d83f3dcc13d7bedfbd6870e31',
} as const;
const cards = new Map(
  Object.keys(pins).map((name) => {
    const entry = pinned.cards.find((item) => item.card.name === name);
    if (!entry) throw new Error(`Missing pinned Oracle card: ${name}`);
    return [name, entry] as const;
  }),
);
beforeAll(() => {
  registerWhiteBlackControlGraveyardOverrides();
  registerWhiteBlackControlGraveyardTriggerOverrides();
});
function card(name: keyof typeof pins): OracleCard {
  return cards.get(name)!.card;
}
function ctx(seed: string): GameContext {
  const game = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(14, swamp) })),
      { seed },
    ),
  );
  Object.assign(game.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 3,
    phase: 'precombatMain',
    step: null,
  });
  return game;
}
function player(game: GameContext, id: string): EnginePlayerState {
  return game.state.players.find((p) => p.id === id)!;
}
function cast(game: GameContext, playerId: string, source: OracleCard): EnginePermanent {
  for (let i = 0; i < 7; i++) spawn(game, playerId, swamp());
  conjure(game, playerId, source, 'hand');
  let casted = false;
  pump(runPrioritySequence(game), (decision) => {
    if (decision.decisionType === 'priority' && decision.player === playerId && !casted) {
      const index = decision.options.findIndex(
        (o) => o.type === 'castSpell' && o.description.includes(source.name),
      );
      if (index >= 0) {
        casted = true;
        return { index, targets: new Map() };
      }
    }
    return pick(decision, /Pass|does not/i);
  });
  expect(casted, `normal cast: ${source.name}`).toBe(true);
  const permanent = game.state.battlefield.find((p) => p.name === source.name);
  if (!permanent) throw new Error(`${source.name} did not resolve to the battlefield`);
  return permanent;
}
function simple(name: string, typeLine: string, manaCost: string | null = '{0}'): OracleCard {
  return oracle({
    name,
    typeLine,
    manaCost,
    cmc: 0,
    power: typeLine.includes('Creature') ? '2' : null,
    toughness: typeLine.includes('Creature') ? '2' : null,
  });
}
function moveToGraveyard(game: GameContext, object: EnginePermanent | ReturnType<typeof conjure>) {
  pump(moveObject(game, object, { zone: 'graveyard' }));
}
function settleTriggers(game: GameContext) {
  while (game.state.pendingTriggers.length) pump(runPrioritySequence(game));
  while (game.state.stack.length) pump(resolveTopOfStack(game));
}

describe('Planar Void and The Haunt of Hightower — pinned Oracle', () => {
  it('pins both Oracle hashes, normally casts both cards, and preserves Haunt flying/lifelink', () => {
    for (const name of Object.keys(pins) as (keyof typeof pins)[]) {
      expect(cards.get(name)!.sha256).toBe(pins[name]);
      const definition = interpretCard(card(name));
      expect(definition.modeled, `${name}: ${definition.unmodeledReasons.join('; ')}`).toBe(true);
      expect(validateCardDefinition(definition)).toEqual([]);
    }
    const game = ctx('graveyard-normal-casts');
    const planar = cast(game, 'P1', card('Planar Void'));
    expect(planar.name).toBe('Planar Void');
    const hauntGame = ctx('haunt-normal-cast');
    const haunt = cast(hauntGame, 'P1', card('The Haunt of Hightower'));
    expect(computeCharacteristics(hauntGame, haunt).keywords).toEqual(
      expect.arrayContaining(['flying', 'lifelink']),
    );
  });

  it('Planar Void queues once for real nonbattlefield entries and deaths, excludes itself and tokens', () => {
    const game = ctx('planar-entry-coverage');
    const planar = cast(game, 'P1', card('Planar Void'));
    const discarded = conjure(game, 'P2', simple('Discarded Card', 'Creature — Bear'), 'hand');
    pump(discardCard(game, discarded, 'P2'));
    expect(game.state.pendingTriggers).toHaveLength(1);
    settleTriggers(game);
    expect(game.state.exile.some((c) => c.cardId === discarded.cardId)).toBe(true);

    const milled = conjure(game, 'P2', simple('Milled Card', 'Creature — Bear'), 'library');
    moveToGraveyard(game, milled);
    expect(game.state.pendingTriggers).toHaveLength(1);
    settleTriggers(game);
    expect(game.state.exile.some((c) => c.cardId === milled.cardId)).toBe(true);

    const resolved = conjure(game, 'P3', simple('Stack Card', 'Creature — Bear'), 'hand');
    pump(moveObject(game, resolved, { zone: 'stack' }));
    pump(moveObject(game, resolved, { zone: 'graveyard' }));
    expect(game.state.pendingTriggers).toHaveLength(1);
    settleTriggers(game);
    expect(game.state.exile.some((c) => c.cardId === resolved.cardId)).toBe(true);

    const death = spawn(game, 'P4', simple('Died Card', 'Creature — Bear'));
    moveToGraveyard(game, death);
    expect(game.state.pendingTriggers).toHaveLength(1);
    settleTriggers(game);
    expect(game.state.exile.some((c) => c.cardId === death.cardId)).toBe(true);

    moveToGraveyard(game, planar);
    expect(game.state.pendingTriggers).toHaveLength(0);
    expect(player(game, 'P1').graveyard.some((c) => c.cardId === planar.cardId)).toBe(true);
    const token = spawn(game, 'P2', simple('Planar Token', 'Creature — Spirit'), { isToken: true });
    moveToGraveyard(game, token);
    expect(game.state.pendingTriggers).toHaveLength(0);
  });

  it('Planar Void exile trigger uses the exact graveyard incarnation and survives its source leaving', () => {
    const game = ctx('planar-incarnation');
    const planar = cast(game, 'P1', card('Planar Void'));
    const victim = spawn(game, 'P2', simple('Reanimated Victim', 'Creature — Bear'));
    moveToGraveyard(game, victim);
    const original = player(game, 'P2').graveyard.find((c) => c.cardId === victim.cardId)!;
    pump(priorityCheckpoint(game));
    expect(game.state.stack).toHaveLength(1);
    const returned = pump(moveObject(game, original, { zone: 'battlefield' })).value;
    expect(returned).not.toBeNull();
    const rebury = returned as EnginePermanent;
    moveToGraveyard(game, planar);
    moveToGraveyard(game, rebury);
    const newIncarnation = player(game, 'P2').graveyard.find((c) => c.cardId === victim.cardId)!;
    expect(newIncarnation.id).not.toBe(original.id);
    pump(resolveTopOfStack(game));
    expect(player(game, 'P2').graveyard.some((c) => c.id === newIncarnation.id)).toBe(true);
    expect(game.state.exile.some((c) => c.id === original.id)).toBe(false);

    const nextPlanar = cast(game, 'P1', card('Planar Void'));
    const second = spawn(game, 'P3', simple('Source Leaves Victim', 'Creature — Bear'));
    moveToGraveyard(game, second);
    pump(priorityCheckpoint(game));
    const secondCard = player(game, 'P3').graveyard.find((c) => c.cardId === second.cardId)!;
    moveToGraveyard(game, nextPlanar);
    expect(game.state.stack.length).toBeGreaterThan(0);
    pump(resolveTopOfStack(game));
    expect(game.state.exile.some((c) => c.cardId === secondCard.cardId)).toBe(true);
  });

  it('a simultaneous Planar Void departure does not trigger from the other card in that batch', () => {
    const game = ctx('planar-simultaneous-departure');
    const planar = cast(game, 'P1', card('Planar Void'));
    const creature = spawn(game, 'P2', simple('Same Batch Creature', 'Creature — Bear'));
    pump(movePermanentsTogether(game, [planar, creature], { zone: 'graveyard' }));
    expect(game.state.pendingTriggers).toHaveLength(0);
    expect(player(game, 'P1').graveyard.some((c) => c.cardId === planar.cardId)).toBe(true);
    expect(player(game, 'P2').graveyard.some((c) => c.cardId === creature.cardId)).toBe(true);
  });

  it('Haunt attacks a player, gains lifelink value, and has the defending player discard', () => {
    const game = ctx('haunt-attacks-player');
    const haunt = cast(game, 'P1', card('The Haunt of Hightower'));
    haunt.summoningSick = false;
    const discarded = conjure(game, 'P2', simple('Defender Discard', 'Creature — Bear'), 'hand');
    game.state.phase = 'combat';
    pump(runCombatPhase(game), (decision) => {
      if (decision.decisionType === 'declareAttackers')
        return declareAttacks(decision, (id) => (id === haunt.id ? 'P2' : null));
      return pick(decision, /Defender Discard|Pass|does not/i);
    });
    expect(player(game, 'P2').graveyard.some((c) => c.cardId === discarded.cardId)).toBe(true);
    expect(player(game, 'P1').life).toBeGreaterThan(40);
    expect(haunt.counters['+1/+1'] ?? 0).toBe(1);
  });

  it('Haunt counts each opponent-owned card entry, excluding own cards, tokens, and replacement exiles', () => {
    const game = ctx('haunt-all-origin');
    const haunt = cast(game, 'P1', card('The Haunt of Hightower'));
    const first = conjure(game, 'P2', simple('Opponent Hand Card', 'Creature — Bear'), 'hand');
    pump(discardCard(game, first, 'P2'));
    expect(game.state.pendingTriggers).toHaveLength(1);
    settleTriggers(game);
    expect(haunt.counters['+1/+1']).toBe(1);
    const milled = conjure(
      game,
      'P3',
      simple('Opponent Library Card', 'Creature — Bear'),
      'library',
    );
    moveToGraveyard(game, milled);
    expect(game.state.pendingTriggers).toHaveLength(1);
    settleTriggers(game);
    expect(haunt.counters['+1/+1']).toBe(2);
    const resolved = conjure(game, 'P4', simple('Opponent Stack Spell', 'Creature — Bear'), 'hand');
    pump(moveObject(game, resolved, { zone: 'stack' }));
    pump(moveObject(game, resolved, { zone: 'graveyard' }));
    expect(player(game, 'P4').graveyard.some((c) => c.cardId === resolved.cardId)).toBe(true);
    expect(game.state.pendingTriggers).toHaveLength(1);
    settleTriggers(game);
    expect(haunt.counters['+1/+1']).toBe(3);
    const battlefieldCard = spawn(game, 'P3', simple('Opponent Dies', 'Creature — Bear'));
    moveToGraveyard(game, battlefieldCard);
    expect(game.state.pendingTriggers).toHaveLength(1);
    settleTriggers(game);
    expect(haunt.counters['+1/+1']).toBe(4);
    const own = conjure(game, 'P1', simple('Own Hand Card', 'Creature — Bear'), 'hand');
    pump(discardCard(game, own, 'P1'));
    expect(game.state.pendingTriggers).toHaveLength(0);
    const token = spawn(game, 'P2', simple('Opponent Token Card', 'Creature — Spirit'), {
      isToken: true,
    });
    moveToGraveyard(game, token);
    expect(game.state.pendingTriggers).toHaveLength(0);

    const peaceCard = pinned.cards.find((item) => item.card.name === 'Rest in Peace')?.card;
    if (!peaceCard) throw new Error('Missing Rest in Peace fixture');
    spawn(game, 'P1', plains());
    cast(game, 'P1', peaceCard);
    const replaced = conjure(game, 'P3', simple('Exiled Instead', 'Creature — Bear'), 'hand');
    moveToGraveyard(game, replaced);
    expect(game.state.pendingTriggers).toHaveLength(0);
    expect(game.state.exile.some((c) => c.cardId === replaced.cardId)).toBe(true);
  });

  it("binds Haunt's attack discard to the defender as a player characteristic, not a card target", () => {
    const definition = interpretCard(card('The Haunt of Hightower'));
    expect(definition.triggers[0]?.trigger).toMatchObject({
      when: 'attacks',
      defendingPlayerIsEventPlayer: true,
    });
    expect(definition.triggers[0]?.effects[0]).toMatchObject({
      op: 'discardTarget',
      target: 'eventPlayer',
    });
  });

  it('a dying Haunt does not receive counters from simultaneous opponent-card entries', () => {
    const game = ctx('haunt-simultaneous-death');
    const haunt = cast(game, 'P1', card('The Haunt of Hightower'));
    const opponent = spawn(game, 'P2', simple('Simultaneous Opponent Death', 'Creature — Bear'));
    pump(movePermanentsTogether(game, [haunt, opponent], { zone: 'graveyard' }));
    expect(game.state.pendingTriggers).toHaveLength(0);
    expect(player(game, 'P1').graveyard.some((c) => c.cardId === haunt.cardId)).toBe(true);
  });

  it('a Haunt blink does not let its old trigger put counters on the new permanent incarnation', () => {
    const game = ctx('haunt-blink-before-trigger');
    const haunt = cast(game, 'P1', card('The Haunt of Hightower'));
    const triggeringCard = conjure(
      game,
      'P2',
      simple('Blink Trigger Card', 'Creature — Bear'),
      'hand',
    );
    moveToGraveyard(game, triggeringCard);
    pump(priorityCheckpoint(game));
    expect(game.state.stack).toHaveLength(1);
    const toHand = pump(moveObject(game, haunt, { zone: 'hand' })).value;
    expect(toHand).not.toBeNull();
    const returned = pump(moveObject(game, toHand!, { zone: 'battlefield' }))
      .value as EnginePermanent;
    expect(returned.id).not.toBe(haunt.id);
    pump(resolveTopOfStack(game));
    expect(returned.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('keeps Planar Void all-origin flags and event-card effects constrained to their event types', () => {
    const definition = interpretCard(card('Planar Void'));
    const invalidFlag = structuredClone(definition);
    invalidFlag.triggers[0]!.trigger = {
      ...invalidFlag.triggers[0]!.trigger!,
      fromAnyOrigin: true,
      when: 'dies',
    } as never;
    expect(
      validateCardDefinition(invalidFlag)
        .map((issue) => issue.message)
        .join('\n'),
    ).toMatch(/all-origin graveyard entry|card-zone event/i);
    const invalidEventEffect = structuredClone(definition);
    invalidEventEffect.triggers[0]!.trigger = {
      ...invalidEventEffect.triggers[0]!.trigger!,
      fromAnyOrigin: undefined,
      when: 'dies',
    } as never;
    expect(
      validateCardDefinition(invalidEventEffect)
        .map((issue) => issue.message)
        .join('\n'),
    ).toMatch(/graveyard event|card event/i);
  });

  it('keeps the older Konrad-style graveyard-entry watcher separate from its dies trigger', () => {
    const watcher = oracle({
      name: 'Konrad Clause Watcher',
      typeLine: 'Legendary Creature — Human Knight',
      manaCost: '{0}',
      cmc: 0,
      power: '3',
      toughness: '3',
      oracleText:
        'Whenever another creature dies, or a creature card is put into a graveyard from anywhere other than the battlefield, or a creature card leaves your graveyard, this creature deals 1 damage to each opponent.',
    });
    const definition = interpretCard(watcher);
    expect(definition.triggers.map((ability) => ability.trigger?.when)).toEqual([
      'dies',
      'putIntoGraveyardFromAnywhere',
      'leavesGraveyard',
    ]);
    expect(definition.triggers[1]?.trigger).not.toHaveProperty('fromAnyOrigin');
    const game = ctx('konrad-separated-events');
    spawn(game, 'P1', watcher);
    const victim = spawn(game, 'P2', simple('Konrad Test Death', 'Creature — Bear'));
    const lifeBefore = player(game, 'P2').life;
    moveToGraveyard(game, victim);
    expect(game.state.pendingTriggers).toHaveLength(1);
    settleTriggers(game);
    expect(player(game, 'P2').life).toBe(lifeBefore - 1);
  });
});
