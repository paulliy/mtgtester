import { describe, expect, it } from 'vitest';

import { validateCardDefinition } from '../src/cards/authoring-validation';
import type { CardDefinition } from '../src/cards/definition';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { executeAbility } from '../src/effects/resolve';
import { interpretCard } from '../src/cards/interpret';
import { manaCost } from '../src/cards/templates';
import { changeController, moveObject, queueTriggersForEvent } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { constant } from '../src/cards/value';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { applyPriorityAction } from '../src/actions/apply';
import { addMana } from '../src/mana/pool';
import { runPrioritySequence } from '../src/turn/priority';
import {
  copies,
  conjure,
  forest,
  gameConfig,
  oracle,
  pick,
  pump,
  registerCustomDef,
  spawn,
} from './fixtures';

/**
 * Contract tests for `unlessPays` with `payer: 'eventObjectController'` (PR08.16 engine primitive).
 * The payer is the CURRENT controller of the exact original event permanent; once it has
 * departed, the controller it last had (departure LKI) — never the ability's event player,
 * never a blinked new incarnation. A payer who left the game cannot pay: no prompt, unpaid
 * branch. Everything here uses a generic fixture creature and a generic unlessPays ability.
 */

const creatureCard = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Generic Fixture Creature',
    typeLine: 'Creature — Generic',
    power: '2',
    toughness: '2',
  });

function pod(): GameContext {
  return createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
      { seed: 'event-object-payer' },
    ),
  );
}

function player(ctx: GameContext, id: string) {
  const p = ctx.state.players.find((pl) => pl.id === id);
  if (p === undefined) throw new Error(`no player ${id}`);
  return p;
}

/** A generic watcher whose trigger taxes the event permanent's controller {2} or P1 draws. */
function watcherCard(payer: 'eventPlayer' | 'controller' | 'eventObjectController') {
  const payment =
    payer === 'controller'
      ? 'you pay'
      : payer === 'eventPlayer'
        ? 'the attacking player pays'
        : "that creature's controller pays";
  return oracle({
    name: 'Generic Unless Watcher',
    typeLine: 'Enchantment',
    manaCost: '{1}',
    oracleText: `Whenever a creature attacks, draw a card unless ${payment} {2}.`,
  });
}

function watcherDef(payer: 'eventPlayer' | 'controller' | 'eventObjectController'): CardDefinition {
  const card = watcherCard(payer);
  const interpreted = interpretCard(card);
  expect(interpreted.unmodeledReasons).toEqual([`unrecognized rules text: "${card.oracleText}"`]);
  const remaining = interpreted.unmodeledReasons.filter(
    (reason) => reason !== `unrecognized rules text: "${card.oracleText}"`,
  );
  return {
    ...interpreted,
    unmodeledReasons: remaining,
    modeled: remaining.length === 0,
    triggers: [
      {
        kind: 'triggered',
        trigger: {
          when: 'attacks',
          subject: { kind: 'permanent', selector: { kind: 'type', value: 'Creature' } },
        },
        targets: [],
        effects: [
          {
            op: 'unlessPays',
            payer,
            cost: manaCost('{2}'),
            then: [{ op: 'draw', count: constant(1) }],
          },
        ],
      },
    ],
  };
}

function spawnWatcher(
  ctx: GameContext,
  payer: 'eventPlayer' | 'controller' | 'eventObjectController',
) {
  const card = watcherCard(payer);
  registerCustomDef(ctx, watcherDef(payer));
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  const object = conjure(ctx, 'P1', card, 'hand');
  addMana(player(ctx, 'P1'), [{ symbol: 'C' }]);
  const cast = computePriorityOptions(ctx, player(ctx, 'P1')).find(
    (option) => (option.payload as PriorityActionPayload).kind === 'castSpell',
  );
  expect(cast).toBeDefined();
  pump(
    applyPriorityAction(ctx, player(ctx, 'P1'), cast!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  expect(ctx.state.stack).toHaveLength(1);
  pump(runPrioritySequence(ctx));
  expect(player(ctx, 'P1').manaEntries).toEqual([]);
  const watcher = ctx.state.battlefield.find((entry) => entry.cardId === object.cardId);
  expect(watcher).toBeDefined();
  return watcher!;
}

/** Fire the `attacks` event for `creature` under attacker control; return the queued trigger. */
function queueAttack(ctx: GameContext, creature: ReturnType<typeof spawn>, attacker: string) {
  queueTriggersForEvent(ctx, 'attacks', [{ permanent: creature, playerId: attacker }]);
  if (ctx.state.pendingTriggers.length !== 1)
    throw new Error(`expected exactly one queued trigger, got ${ctx.state.pendingTriggers.length}`);
  return ctx.state.pendingTriggers[0]!;
}

function resolvePending(
  ctx: GameContext,
  pending: ReturnType<typeof queueAttack>,
  answer?: (decision: PendingDecision, count: number) => DecisionOutcome,
) {
  return pump(
    executeAbility(
      ctx,
      {
        cardId: pending.sourceCardId,
        name: pending.sourceName,
        oracleId: pending.sourceOracleId,
        controllerId: pending.controllerId,
      },
      pending.ability,
      [],
      undefined,
      pending.scope,
    ),
    answer,
  );
}

const genericMana = () => [{ symbol: 'C' as const }, { symbol: 'C' as const }];

describe('unlessPays eventObjectController payer', () => {
  it('rejects a physical card id without the exact event incarnation', () => {
    const ctx = pod();
    spawnWatcher(ctx, 'eventObjectController');
    const creature = spawn(ctx, 'P2', creatureCard());
    const pending = queueAttack(ctx, creature, 'P2');
    expect(() =>
      pump(
        executeAbility(
          ctx,
          {
            cardId: pending.sourceCardId,
            name: pending.sourceName,
            oracleId: pending.sourceOracleId,
            controllerId: pending.controllerId,
          },
          pending.ability,
          [],
          creature.cardId,
        ),
      ),
    ).toThrow('unlessPays has no exact event object');
  });

  it('prompts the event permanent controller, who can pay to suppress the wrapped effect', () => {
    const ctx = pod();
    spawnWatcher(ctx, 'eventObjectController');
    const creature = spawn(ctx, 'P2', creatureCard());
    player(ctx, 'P2').manaEntries = genericMana();
    const libraryBefore = player(ctx, 'P1').library.length;

    const pending = queueAttack(ctx, creature, 'P2');
    const { decisions } = resolvePending(ctx, pending, (d) => pick(d, 'Pay {2}'));

    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.player).toBe('P2');
    expect(player(ctx, 'P2').manaEntries).toHaveLength(0);
    expect(player(ctx, 'P1').library.length).toBe(libraryBefore);
  });

  it('runs the wrapped effect when the event permanent controller declines', () => {
    const ctx = pod();
    spawnWatcher(ctx, 'eventObjectController');
    const creature = spawn(ctx, 'P2', creatureCard());
    player(ctx, 'P2').manaEntries = genericMana();
    const libraryBefore = player(ctx, 'P1').library.length;

    const pending = queueAttack(ctx, creature, 'P2');
    const { decisions } = resolvePending(ctx, pending, (d) => pick(d, "Don't pay"));

    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.player).toBe('P2');
    expect(player(ctx, 'P2').manaEntries).toHaveLength(2);
    expect(player(ctx, 'P1').library.length).toBe(libraryBefore - 1);
  });

  it('offers no prompt and runs the wrapped effect when the controller cannot pay', () => {
    const ctx = pod();
    spawnWatcher(ctx, 'eventObjectController');
    const creature = spawn(ctx, 'P2', creatureCard());
    const libraryBefore = player(ctx, 'P1').library.length;

    const pending = queueAttack(ctx, creature, 'P2');
    const { decisions } = resolvePending(ctx, pending);

    expect(decisions).toEqual([]);
    expect(player(ctx, 'P1').library.length).toBe(libraryBefore - 1);
  });

  it('sends the pay choice to the controller the event permanent has NOW, not the original one', () => {
    const ctx = pod();
    spawnWatcher(ctx, 'eventObjectController');
    const creature = spawn(ctx, 'P2', creatureCard());
    const pending = queueAttack(ctx, creature, 'P2');
    // Control changes after the event fired but before the ability resolves
    // (CR 506.4 removal from combat through the real transition path, never a field poke).
    changeController(ctx, creature, 'P3');
    player(ctx, 'P3').manaEntries = genericMana();
    const libraryBefore = player(ctx, 'P1').library.length;

    const { decisions } = resolvePending(ctx, pending, (d) => pick(d, 'Pay {2}'));

    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.player).toBe('P3');
    expect(player(ctx, 'P3').manaEntries).toHaveLength(0);
    expect(player(ctx, 'P2').manaEntries).toHaveLength(0);
    expect(player(ctx, 'P1').library.length).toBe(libraryBefore);
  });

  it('uses the departure controller when the event permanent left after a control change', () => {
    const ctx = pod();
    spawnWatcher(ctx, 'eventObjectController');
    const creature = spawn(ctx, 'P2', creatureCard());
    const pending = queueAttack(ctx, creature, 'P2');
    changeController(ctx, creature, 'P3');
    pump(moveObject(ctx, creature, { zone: 'graveyard' }));
    player(ctx, 'P3').manaEntries = genericMana();
    const libraryBefore = player(ctx, 'P1').library.length;

    const { decisions } = resolvePending(ctx, pending, (d) => pick(d, "Don't pay"));

    // The LAST controller at departure (P3) is asked — not the original controller P2.
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.player).toBe('P3');
    expect(player(ctx, 'P1').library.length).toBe(libraryBefore - 1);
  });

  it("never follows a blink's new incarnation — the departure controller pays, not the returned object's", () => {
    const ctx = pod();
    spawnWatcher(ctx, 'eventObjectController');
    const creature = spawn(ctx, 'P2', creatureCard());
    const pending = queueAttack(ctx, creature, 'P2');
    // The event permanent leaves (departure LKI: controller P2), then the SAME card returns
    // under a different controller as a NEW object — a blinked incarnation, not a fresh spawn.
    pump(moveObject(ctx, creature, { zone: 'exile' }));
    const exiled = ctx.state.exile.find((o) => o.cardId === creature.cardId);
    if (exiled === undefined) throw new Error('creature card not found in exile');
    const returned = pump(moveObject(ctx, exiled, { zone: 'battlefield', controllerId: 'P3' }));
    if (returned.value === null || returned.value.id === creature.id)
      throw new Error('blink must produce a new object id for the same card');
    player(ctx, 'P2').manaEntries = genericMana();
    const libraryBefore = player(ctx, 'P1').library.length;

    const { decisions } = resolvePending(ctx, pending, (d) => pick(d, 'Pay {2}'));

    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.player).toBe('P2');
    expect(player(ctx, 'P2').manaEntries).toHaveLength(0);
    expect(player(ctx, 'P1').library.length).toBe(libraryBefore);
  });

  it('never prompts a payer who left the game — the unpaid branch just happens', () => {
    const ctx = pod();
    spawnWatcher(ctx, 'eventObjectController');
    const creature = spawn(ctx, 'P2', creatureCard());
    const pending = queueAttack(ctx, creature, 'P2');
    pump(moveObject(ctx, creature, { zone: 'graveyard' }));
    player(ctx, 'P2').hasLost = true;
    const libraryBefore = player(ctx, 'P1').library.length;

    const { decisions } = resolvePending(ctx, pending);

    expect(decisions).toEqual([]);
    expect(player(ctx, 'P1').library.length).toBe(libraryBefore - 1);
  });
});

describe('eventObjectController authoring scope', () => {
  it('accepts the payer with an owning permanent event-object scope', () => {
    expect(validateCardDefinition(watcherDef('eventObjectController'))).toEqual([]);
  });

  it('rejects a self-subject trigger — no event object id is bound', () => {
    const def = structuredClone(watcherDef('eventObjectController'));
    def.triggers[0]!.trigger = { when: 'attacks', subject: { kind: 'self' } };
    expect(validateCardDefinition(def).map((issue) => issue.message)).toContain(
      'event object controller payer requires an owning permanent event-object scope',
    );
  });

  it('rejects a card-scope event', () => {
    const def = structuredClone(watcherDef('eventObjectController'));
    def.triggers[0]!.trigger = { when: 'discardsCard', player: 'you' };
    expect(validateCardDefinition(def).map((issue) => issue.message)).toContain(
      'event object controller payer requires an owning permanent event-object scope',
    );
  });

  it('rejects a spell ability — no owning event scope at all', () => {
    const def = {
      ...interpretCard(oracle({ name: 'Spell Event Object Payer', typeLine: 'Instant' })),
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [
          {
            op: 'unlessPays',
            payer: 'eventObjectController',
            cost: manaCost('{2}'),
            then: [{ op: 'draw', count: constant(1) }],
          },
        ],
      },
    } as unknown as CardDefinition;
    expect(validateCardDefinition(def).map((issue) => issue.message)).toContain(
      'event object controller payer requires an owning permanent event-object scope',
    );
  });

  it('rejects an unknown payer value', () => {
    const def = {
      ...interpretCard(oracle({ name: 'Unknown Payer Watcher', typeLine: 'Enchantment' })),
      triggers: [
        {
          kind: 'triggered',
          trigger: {
            when: 'attacks',
            subject: { kind: 'permanent', selector: { kind: 'type', value: 'Creature' } },
          },
          targets: [],
          effects: [
            {
              op: 'unlessPays',
              payer: 'theMoon',
              cost: manaCost('{2}'),
              then: [{ op: 'draw', count: constant(1) }],
            },
          ],
        },
      ],
    } as unknown as CardDefinition;
    expect(validateCardDefinition(def).map((issue) => issue.message)).toContain('unknown payer');
  });
});
