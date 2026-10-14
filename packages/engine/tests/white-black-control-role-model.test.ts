import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { registerWhiteBlackControlRoleModelOverrides } from '../src/cards/overrides/white-black-control-role-model';
import type { PendingDecision } from '../src/decisions';
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility, permanentSource } from '../src/effects/resolve';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { priorityCheckpoint } from '../src/sba/sba';
import { resolveTopOfStack } from '../src/stack/stack';
import { beginPostcombatMain } from '../src/turn/turn';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, gameConfig, oracle, pump, spawn, plains } from './fixtures';

interface Pinned {
  sha256: string;
  card: OracleCard;
}
const fixture = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/white-black-control-oracle.json', 'utf8'),
) as { cards: Pinned[] };
const pin = 'caa828b6f32adc5fd8882f6eac989c02e9a14c5b7d69d5e5946abe279ba88ac2';
const entry = fixture.cards.find((candidate) => candidate.card.name === 'Reluctant Role Model');
if (!entry) throw new Error('Missing pinned Oracle card: Reluctant Role Model');
const card = entry.card;
beforeAll(() => registerWhiteBlackControlRoleModelOverrides());

function ctx(seed = 'role-model'): GameContext {
  const game = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(10, plains) })),
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
function player(game: GameContext, id: string) {
  return game.state.players.find((candidate) => candidate.id === id)!;
}
function castRole(game: GameContext, who = 'P1'): EnginePermanent {
  const object = conjure(game, who, card, 'hand');
  addMana(player(game, who), [{ symbol: 'W' }, { symbol: 'C' }]);
  const option = computePriorityOptions(game, player(game, who)).find((candidate) => {
    const payload = candidate.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === object.id;
  });
  expect(option, 'Role Model is cast through the regular priority action').toBeDefined();
  pump(
    applyPriorityAction(game, player(game, who), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  pump(resolveTopOfStack(game));
  return game.state.battlefield.find((permanent) => permanent.cardId === object.cardId)!;
}
function settle(game: GameContext, answer: (decision: PendingDecision) => number = () => 0): void {
  pump(runPrioritySequence(game), (decision) => {
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    return { index: pass >= 0 ? pass : answer(decision), targets: new Map() };
  });
}
function chooseSurvival(game: GameContext, counter: 'flying' | 'lifelink' | '+1/+1'): void {
  pump(priorityCheckpoint(game));
  const resolver = resolveTopOfStack(game);
  pump(resolver, (decision) => {
    const index = decision.options.findIndex((option) =>
      option.description.includes(`a ${counter} counter`),
    );
    return { index, targets: new Map() };
  });
}
function die(game: GameContext, permanent: EnginePermanent): void {
  pump(moveObject(game, permanent, { zone: 'graveyard' }));
}
function characteristics(game: GameContext, permanent: EnginePermanent) {
  return computeCharacteristics(game, permanent);
}

describe('Reluctant Role Model — pinned Oracle behavior', () => {
  it('pins and models the exact Oracle text; its normal cast does not grant printed flying or lifelink', () => {
    expect(entry.sha256).toBe(pin);
    const def = interpretCard(card);
    expect(def.modeled, def.unmodeledReasons.join('; ')).toBe(true);
    expect(def.unmodeledReasons).toEqual([]);
    const game = ctx('role-model-normal-cast');
    const role = castRole(game);
    expect(role.controllerId).toBe('P1');
    expect(characteristics(game, role).keywords).not.toContain('flying');
    expect(characteristics(game, role).keywords).not.toContain('lifelink');
  });

  it.each(['flying', 'lifelink', '+1/+1'] as const)(
    'second-main Survival chooses a %s counter only when tapped',
    (counter) => {
      const game = ctx(`role-model-${counter}`);
      const role = castRole(game);
      role.tapped = true;
      game.state.mainPhasesStartedThisTurn = 1;
      beginPostcombatMain(game);
      expect(
        game.state.pendingTriggers.some((trigger) => trigger.sourceCardId === role.cardId),
      ).toBe(true);
      chooseSurvival(game, counter);
      expect(role.counters[counter]).toBe(1);
      if (counter === 'flying' || counter === 'lifelink')
        expect(characteristics(game, role).keywords).toContain(counter);
    },
  );

  it('does not trigger in the first or third main phase, for an opponent, or if untapped before resolution', () => {
    const first = ctx('role-model-first-main');
    const firstRole = castRole(first);
    firstRole.tapped = true;
    first.state.mainPhasesStartedThisTurn = 0;
    beginPostcombatMain(first);
    expect(
      first.state.pendingTriggers.some((trigger) => trigger.sourceCardId === firstRole.cardId),
    ).toBe(false);

    const untapped = ctx('role-model-untapped-queue');
    const ready = castRole(untapped);
    untapped.state.mainPhasesStartedThisTurn = 1;
    beginPostcombatMain(untapped);
    expect(
      untapped.state.pendingTriggers.some((trigger) => trigger.sourceCardId === ready.cardId),
    ).toBe(false);

    const third = ctx('role-model-third-main');
    const thirdRole = castRole(third);
    thirdRole.tapped = true;
    third.state.mainPhasesStartedThisTurn = 2;
    beginPostcombatMain(third);
    expect(
      third.state.pendingTriggers.some((trigger) => trigger.sourceCardId === thirdRole.cardId),
    ).toBe(false);

    const opponent = ctx('role-model-opponent-main');
    const opponentRole = spawn(opponent, 'P2', card);
    opponentRole.tapped = true;
    opponent.state.mainPhasesStartedThisTurn = 1;
    beginPostcombatMain(opponent);
    expect(
      opponent.state.pendingTriggers.some(
        (trigger) => trigger.sourceCardId === opponentRole.cardId,
      ),
    ).toBe(false);

    const intervening = ctx('role-model-tap-recheck');
    const tapped = castRole(intervening);
    tapped.tapped = true;
    intervening.state.mainPhasesStartedThisTurn = 1;
    beginPostcombatMain(intervening);
    expect(
      intervening.state.pendingTriggers.some((trigger) => trigger.sourceCardId === tapped.cardId),
    ).toBe(true);
    tapped.tapped = false;
    pump(priorityCheckpoint(intervening));
    pump(resolveTopOfStack(intervening));
    expect(tapped.counters).toEqual({});
  });

  it('transfers every counter from its own death and another controlled creature, but not opponent/no-counter deaths', () => {
    const game = ctx('role-model-death-transfer');
    const role = castRole(game);
    const recipient = spawn(
      game,
      'P1',
      oracle({
        name: 'Recipient',
        typeLine: 'Creature',
        manaCost: '{0}',
        power: '2',
        toughness: '2',
      }),
    );
    role.counters['flying'] = 1;
    role.counters['+1/+1'] = 2;
    die(game, role);
    expect(game.state.pendingTriggers.some((trigger) => trigger.sourceCardId === role.cardId)).toBe(
      true,
    );
    pump(priorityCheckpoint(game));
    settle(game, (decision) =>
      decision.options.findIndex((option) => option.description.includes(recipient.name)),
    );
    expect(recipient.counters['flying']).toBe(1);
    expect(recipient.counters['+1/+1']).toBe(2);

    const otherGame = ctx('role-model-other-death');
    const model = castRole(otherGame);
    const ally = spawn(
      otherGame,
      'P1',
      oracle({
        name: 'Countered ally',
        typeLine: 'Creature',
        manaCost: '{0}',
        power: '1',
        toughness: '1',
      }),
    );
    const target = spawn(
      otherGame,
      'P1',
      oracle({
        name: 'Ally recipient',
        typeLine: 'Creature',
        manaCost: '{0}',
        power: '1',
        toughness: '1',
      }),
    );
    ally.counters['shield'] = 2;
    die(otherGame, ally);
    pump(priorityCheckpoint(otherGame), (decision) => {
      const index = decision.options.findIndex((option) =>
        option.description.includes(target.name),
      );
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: index >= 0 ? index : Math.max(pass, 0), targets: new Map() };
    });
    expect(otherGame.state.stack.at(-1)?.countTargets?.[0]).toContain(target.id);
    settle(otherGame);
    expect(target.counters['shield']).toBe(2);
    expect(model.zone).toBe('battlefield');

    const noCounterGame = ctx('role-model-no-counter-death');
    const active = castRole(noCounterGame);
    const empty = spawn(
      noCounterGame,
      'P1',
      oracle({
        name: 'Empty ally',
        typeLine: 'Creature',
        manaCost: '{0}',
        power: '1',
        toughness: '1',
      }),
    );
    die(noCounterGame, empty);
    expect(
      noCounterGame.state.pendingTriggers.filter(
        (trigger) => trigger.sourceCardId === active.cardId,
      ),
    ).toHaveLength(0);
    const rival = spawn(
      noCounterGame,
      'P2',
      oracle({
        name: 'Rival countered',
        typeLine: 'Creature',
        manaCost: '{0}',
        power: '1',
        toughness: '1',
      }),
    );
    rival.counters['shield'] = 1;
    die(noCounterGame, rival);
    expect(
      noCounterGame.state.pendingTriggers.filter(
        (trigger) => trigger.sourceCardId === active.cardId,
      ),
    ).toHaveLength(0);
  });

  it('allows zero or one target, skips a target that leaves, applies counter replacements/events, and tracks keyword counter timestamps', () => {
    const game = ctx('role-model-replacement-transfer');
    const role = castRole(game);
    const recipientCard = oracle({
      name: 'Counter Witness',
      typeLine: 'Creature — Human',
      manaCost: '{0}',
      power: '1',
      toughness: '1',
      oracleText:
        'This creature enters with two +1/+1 counters on it.\nWhenever one or more +1/+1 counters are put on this creature, draw a card.',
    });
    expect(interpretCard(recipientCard).triggers?.[0]?.trigger?.when).toBe('countersPut');
    const scales = oracle({
      name: 'Hardened Scales',
      typeLine: 'Enchantment',
      manaCost: '{G}',
      oracleText:
        'If one or more +1/+1 counters would be put on a creature you control, that many plus one +1/+1 counters are put on it instead.',
    });
    spawn(game, 'P1', scales);
    const recipient = spawn(game, 'P1', recipientCard);
    settle(game); // clear its own entry-counter trigger before observing inherited counters
    const beforeDraw = player(game, 'P1').hand.length;
    role.counters['+1/+1'] = 2;
    role.counters['flying'] = 1;
    role.counters['lifelink'] = 1;
    die(game, role);
    pump(priorityCheckpoint(game)); // one legal creature makes the optional target automatic
    pump(resolveTopOfStack(game));
    expect(recipient.counters['+1/+1']).toBe(6); // three from entry plus three transferred through Scales
    expect(recipient.counters['flying']).toBe(1);
    expect(recipient.counters['lifelink']).toBe(1);
    expect(
      game.state.eventLog.some(
        (event) =>
          event.type === 'counters' &&
          event.payload['counter'] === '+1/+1' &&
          event.payload['added'] === 3,
      ),
    ).toBe(true);
    expect(characteristics(game, recipient).keywords).toEqual(
      expect.arrayContaining(['flying', 'lifelink']),
    );
    expect(
      game.state.pendingTriggers.some(
        (trigger) =>
          trigger.sourceCardId === recipient.cardId &&
          trigger.ability.trigger?.when === 'countersPut',
      ),
    ).toBe(true);
    pump(priorityCheckpoint(game));
    expect(
      game.state.stack.some(
        (item) =>
          item.sourceCardId === recipient.cardId &&
          item.ability?.effects.some((effect) => effect.op === 'draw'),
      ),
    ).toBe(true);
    pump(resolveTopOfStack(game));
    expect(player(game, 'P1').hand.length).toBe(beforeDraw + 1);

    const none = ctx('role-model-no-chosen-creature');
    const model = castRole(none);
    const unselected = spawn(
      none,
      'P1',
      oracle({
        name: 'Optional recipient',
        typeLine: 'Creature',
        manaCost: '{0}',
        power: '1',
        toughness: '1',
      }),
    );
    model.counters['flying'] = 1;
    die(none, model);
    pump(priorityCheckpoint(none), (decision) => {
      const decline = decision.options.findIndex(
        (option) => option.description === 'Choose no more targets',
      );
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: decline >= 0 ? decline : Math.max(pass, 0), targets: new Map() };
    });
    expect(none.state.stack.at(-1)?.countTargets?.[0]).toEqual([]);
    settle(none);
    expect(unselected.counters['flying']).toBeUndefined();

    const leaving = ctx('role-model-target-leaves');
    const dying = castRole(leaving);
    const departs = spawn(
      leaving,
      'P1',
      oracle({
        name: 'Departing recipient',
        typeLine: 'Creature',
        manaCost: '{0}',
        power: '1',
        toughness: '1',
      }),
    );
    dying.counters['+1/+1'] = 1;
    die(leaving, dying);
    pump(priorityCheckpoint(leaving));
    expect(leaving.state.stack.at(-1)?.countTargets?.[0]).toEqual([departs.id]);
    // Move the target away before its trigger resolves; there is no legal target at resolution.
    die(leaving, departs);
    settle(leaving);
    expect(leaving.state.battlefield).toHaveLength(0);
  });

  it('removing the last keyword counter removes the layer-6 grant', () => {
    const game = ctx('role-model-counter-removal');
    const role = castRole(game);
    pump(
      executeAbility(
        game,
        permanentSource(role),
        {
          kind: 'activated',
          targets: [],
          effects: [{ op: 'putCounters', target: 'source', counter: 'flying', count: 1 }],
        },
        [],
      ),
    );
    expect(characteristics(game, role).keywords).toContain('flying');
    pump(
      executeAbility(
        game,
        permanentSource(role),
        {
          kind: 'activated',
          targets: [],
          effects: [{ op: 'removeCounters', target: 'source', counter: 'flying', count: 1 }],
        },
        [],
      ),
    );
    expect(characteristics(game, role).keywords).not.toContain('flying');
  });

  it('applies a newer lose-all-abilities effect after an older counter grant, then restores the grant with a newly placed counter', () => {
    const game = ctx('role-model-counter-timestamp-order');
    const role = castRole(game);
    pump(
      executeAbility(
        game,
        permanentSource(role),
        {
          kind: 'activated',
          targets: [],
          effects: [{ op: 'putCounters', target: 'source', counter: 'flying', count: 1 }],
        },
        [],
      ),
    );
    expect(characteristics(game, role).keywords).toContain('flying');
    const silence = spawn(
      game,
      'P1',
      oracle({ name: 'Ability eraser', typeLine: 'Enchantment', manaCost: '{0}' }),
    );
    game.defs.set(silence.oracleId, {
      ...game.defs.get(silence.oracleId)!,
      staticEffects: [
        { affects: { kind: 'type', value: 'Creature' }, op: { layer: 6, loseAllAbilities: true } },
      ],
    });
    expect(characteristics(game, role).keywords).not.toContain('flying');
    pump(
      executeAbility(
        game,
        permanentSource(role),
        {
          kind: 'activated',
          targets: [],
          effects: [{ op: 'putCounters', target: 'source', counter: 'flying', count: 1 }],
        },
        [],
      ),
    );
    expect(role.counterTimestamps?.['flying']).toBeGreaterThan(silence.timestamp);
    expect(characteristics(game, role).keywords).toContain('flying');
  });
});
