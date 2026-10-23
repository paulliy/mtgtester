import { describe, expect, it } from 'vitest';

import type { OracleCard } from '@mtg/shared';
import { evaluateCondition } from '../src/cards/condition';
import type { Condition } from '../src/cards/condition';
import { interpretCard } from '../src/cards/interpret';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { captureObjectFacts, eventObjectScope } from '../src/cards/source-identity';
import {
  changeController,
  moveObject,
  queueTriggersForEvent,
  removeFromCombat,
} from '../src/state/objects';
import { runPrioritySequence } from '../src/turn/priority';
import { createGame } from '../src/state/game';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { copies, forest, gameConfig, pump, spawn } from './fixtures';

/**
 * Contract tests for `eventObjectDefendingPlayerIsYou` (PR08.16 engine primitive): Kazuul's
 * genuine intervening-if over the trigger's exact original attacker. The answer follows CR
 * 508.5's retained information, not the current combat assignment: a still-current `attacking`
 * wins; once combat assignment for the attacker ends, the defender retained at that clear, else
 * the captured event's facts. A redirect keeps the recheck honest — the answer follows the
 * attack's own defender, never the original fired event; the exact departed original answers
 * from departure LKI, never a blinked new incarnation.
 */

const KAZUUL_ORACLE_ID = 'f8bf3d91-cb50-48ce-88c6-cdcb37b64b57';

/** Kazuul's real oracle card — the override in `overrides/coverage-pr08.ts` models it. */
const kazuul = (): OracleCard => ({
  oracleId: KAZUUL_ORACLE_ID,
  scryfallId: 'kazuul-scry',
  name: 'Kazuul, Tyrant of the Cliffs',
  manaCost: '{3}{R}{R}',
  cmc: 5,
  colors: ['R'],
  colorIdentity: ['R'],
  typeLine: 'Legendary Creature — Ogre Warrior',
  supertypes: ['Legendary'],
  types: ['Creature'],
  subtypes: ['Ogre', 'Warrior'],
  oracleText:
    "Whenever a creature an opponent controls attacks, if you're the defending player, create a 3/3 red Ogre creature token unless that creature's controller pays {3}.",
  power: '5',
  toughness: '4',
  loyalty: null,
  defense: null,
  keywords: [],
  layout: 'normal',
  commanderLegality: 'legal',
  isBasicLand: false,
});

const creatureCard = (): OracleCard => ({
  oracleId: 'defending-witness-oracle-id',
  scryfallId: 'defending-witness-scry',
  name: 'Defender Witness Creature',
  manaCost: '{1}',
  cmc: 1,
  colors: [],
  colorIdentity: [],
  typeLine: 'Creature — Generic',
  supertypes: [],
  types: ['Creature'],
  subtypes: ['Generic'],
  oracleText: '',
  power: '2',
  toughness: '2',
  loyalty: null,
  defense: null,
  keywords: [],
  layout: 'normal',
  commanderLegality: 'legal',
  isBasicLand: false,
});

/** The condition exactly as Kazuul's override authored it. */
const defendingYou: Condition = { kind: 'eventObjectDefendingPlayerIsYou' };

function pod(): GameContext {
  return createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
      { seed: 'defending-player-event' },
    ),
  );
}

/**
 * The trigger event's scope, exactly as `queueTriggersForEvent` binds it: the event's own scope
 * plus the bounded event object's identity. Pass `facts` for departure handling.
 */
function attackScope(
  ctx: GameContext,
  attacker: EnginePermanent,
  facts?: ReturnType<typeof captureObjectFacts>,
) {
  return {
    controllerId: 'P4',
    cardId: 'test-watcher-card',
    ...eventObjectScope(ctx, attacker),
    ...(facts === undefined ? {} : { triggerObjectFacts: facts }),
  };
}

/**
 * The same scope with the event object's own captured facts removed — a scope the round-trip
 * queueing would never bind, used only to prove the condition fails closed without facts.
 */
function factslessScope(ctx: GameContext, attacker: EnginePermanent) {
  const { triggerObjectFacts: unused, ...rest } = attackScope(ctx, attacker, undefined);
  void unused;
  return rest;
}

function kazuulAt(ctx: GameContext, controllerId: string): EnginePermanent {
  const walker = spawn(ctx, controllerId, kazuul());
  expect(walker.oracleId).toBe(KAZUUL_ORACLE_ID);
  return walker;
}

function attackingWitness(ctx: GameContext, defenderId: string): EnginePermanent {
  const witness = spawn(ctx, 'P2', creatureCard());
  witness.attacking = defenderId;
  return witness;
}

function ogers(ctx: GameContext, controllerId: string): number {
  return ctx.state.battlefield.filter(
    (p) => p.isToken && p.name === 'Ogre' && p.controllerId === controllerId,
  ).length;
}

describe('eventObjectDefendingPlayerIsYou runtime semantics', () => {
  it('rejects a physical card id without the exact event incarnation', () => {
    const ctx = pod();
    const witness = attackingWitness(ctx, 'P4');
    expect(
      evaluateCondition(ctx, defendingYou, {
        cardId: 'fixture-watcher',
        controllerId: 'P4',
        triggerObjectCardId: witness.cardId,
      }),
    ).toBe(false);
  });

  it('fails closed with no bound event object', () => {
    const ctx = pod();
    const kazuul = kazuulAt(ctx, 'P3');
    // Kazuul's own permanent is the "you" the condition evaluates for (SelectorSource identity).
    expect(
      evaluateCondition(ctx, defendingYou, { cardId: kazuul.cardId, controllerId: 'P3' }),
    ).toBe(false);
  });

  it('answers with the current defending player while the attacker is still attacking', () => {
    const ctx = pod();
    kazuulAt(ctx, 'P4');
    const witness = attackingWitness(ctx, 'P4');
    expect(evaluateCondition(ctx, defendingYou, attackScope(ctx, witness))).toBe(true);
    witness.attacking = 'P3';
    expect(evaluateCondition(ctx, defendingYou, attackScope(ctx, witness))).toBe(false);
  });

  it('counts a planeswalker attack: the defending player is the planeswalker controller', () => {
    const ctx = pod();
    const walker = kazuulAt(ctx, 'P4');
    const witness = attackingWitness(ctx, 'P4');
    witness.attackingPlaneswalker = walker.id;
    expect(evaluateCondition(ctx, defendingYou, attackScope(ctx, witness))).toBe(true);
  });

  it('reads the retained defender once combat assignment ended (CR 508.5)', () => {
    const ctx = pod();
    kazuulAt(ctx, 'P3');
    const witness = attackingWitness(ctx, 'P3');
    removeFromCombat(ctx, witness);
    // The witness still stands on the battlefield but attacks nothing: the retained answer is
    // the defender combat assignment named when it ended, not "not attacking" and not the event.
    expect(
      evaluateCondition(ctx, defendingYou, { ...attackScope(ctx, witness), controllerId: 'P3' }),
    ).toBe(true);
    expect(
      evaluateCondition(ctx, defendingYou, { ...attackScope(ctx, witness), controllerId: 'P4' }),
    ).toBe(false);
  });

  it('answers a departed attacker from the captured event facts, never a fresh cardId search', () => {
    const ctx = pod();
    kazuulAt(ctx, 'P4');
    const witness = attackingWitness(ctx, 'P4');
    const facts = captureObjectFacts(ctx, witness);
    const scope = attackScope(ctx, witness, facts);
    pump(moveObject(ctx, witness, { zone: 'graveyard' }));
    // The exact departed original answers from LKI (CR 608.2h).
    expect(evaluateCondition(ctx, defendingYou, scope)).toBe(true);
    // The same scope WITHOUT facts fails closed — no cardId fallback finds another incarnation
    // of that card on the battlefield and answers for the departed attacker (CR 400.7, 603.7).
    // Blink the same card back (same cardId, new object id) under the defending player and let
    // it attack again: the factsless scope must still refuse to answer through its cardId.
    const factsless = factslessScope(ctx, witness);
    const exiled = ctx.state.players
      .flatMap((p) => p.graveyard)
      .find((o) => o.cardId === witness.cardId);
    if (exiled === undefined) throw new Error('witness card not found in graveyard funnel');
    const returned = pump(moveObject(ctx, exiled, { zone: 'battlefield', controllerId: 'P4' }));
    if (returned.value === null || returned.value.id === witness.id)
      throw new Error('blink must produce a new object id for the same card');
    expect(returned.value.cardId).toBe(witness.cardId);
    (returned.value as EnginePermanent).attacking = 'P4';
    expect(evaluateCondition(ctx, defendingYou, factsless)).toBe(false);
  });
});

describe('eventObjectDefendingPlayerIsYou through the real Kazuul trigger', () => {
  /** Spawn Kazuul (P4) and a witness attacker (P2) attacking P4, then queue the real trigger. */
  function queued(ctx: GameContext) {
    const walker = kazuulAt(ctx, 'P4');
    const witness = attackingWitness(ctx, 'P4');
    queueTriggersForEvent(ctx, 'attacks', [{ permanent: witness, playerId: 'P2' }]);
    if (ctx.state.pendingTriggers.length !== 1)
      throw new Error(`expected one queued trigger, got ${ctx.state.pendingTriggers.length}`);
    const ability = ctx.state.pendingTriggers[0]!.ability;
    if (ability.trigger?.condition?.kind !== 'eventObjectDefendingPlayerIsYou')
      throw new Error('the override does not carry the event-object defending player condition');
    return { walker, witness };
  }

  it('resolves and creates the token when the payer cannot pay', () => {
    const ctx = pod();
    queued(ctx);
    const before = ogers(ctx, 'P4');
    pump(runPrioritySequence(ctx));
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    expect(ogers(ctx, 'P4')).toBe(before + 1);
  });

  it('resolves true after the attacker was removed from combat — the retained defender', () => {
    const ctx = pod();
    const { witness } = queued(ctx);
    removeFromCombat(ctx, witness);
    expect(witness.attacking).toBeNull();
    const before = ogers(ctx, 'P4');
    pump(runPrioritySequence(ctx));
    expect(ogers(ctx, 'P4')).toBe(before + 1);
  });

  it('removes the trigger without a token after the attack was redirected to another player', () => {
    const ctx = pod();
    const { witness } = queued(ctx);
    witness.attacking = 'P3';
    const before = ogers(ctx, 'P4');
    pump(runPrioritySequence(ctx));
    expect(ogers(ctx, 'P4')).toBe(before);
    expect(ctx.state.eventLog.some((e) => e.type === 'triggerConditionFailed')).toBe(true);
  });

  it('keeps the honest answer even after the redirected attacker is removed from combat', () => {
    const ctx = pod();
    const { witness } = queued(ctx);
    witness.attacking = 'P3';
    removeFromCombat(ctx, witness);
    const before = ogers(ctx, 'P4');
    pump(runPrioritySequence(ctx));
    expect(ogers(ctx, 'P4')).toBe(before);
  });

  it('answers from departure LKI when the attacker died before the trigger resolved', () => {
    const ctx = pod();
    const { witness } = queued(ctx);
    pump(moveObject(ctx, witness, { zone: 'graveyard' }));
    const before = ogers(ctx, 'P4');
    pump(runPrioritySequence(ctx));
    expect(ogers(ctx, 'P4')).toBe(before + 1);
  });

  it('answers the departed original, not its blinked re-attacking incarnation', () => {
    const ctx = pod();
    const { witness } = queued(ctx);
    pump(moveObject(ctx, witness, { zone: 'exile' }));
    // Blink: the SAME card returns under a different controller and attacks someone ELSE. The
    // recheck must answer over the DEPARTED original's own LKI (it attacked P4), never the new
    // incarnation's fresh assignment — with the wrong binding this would flip the answer.
    const exiled = ctx.state.exile.find((o) => o.cardId === witness.cardId);
    if (exiled === undefined) throw new Error('witness card not found in exile');
    const returned = pump(moveObject(ctx, exiled, { zone: 'battlefield', controllerId: 'P3' }));
    if (returned.value === null || returned.value.id === witness.id)
      throw new Error('blink must produce a new object id for the same card');
    (returned.value as EnginePermanent).attacking = 'P3';
    const before = ogers(ctx, 'P4');
    pump(runPrioritySequence(ctx));
    expect(ogers(ctx, 'P4')).toBe(before + 1);
  });

  it('resolves under the ability controller frozen at the event, even later control-changed', () => {
    const ctx = pod();
    const { walker } = queued(ctx);
    expect(ctx.state.pendingTriggers[0]!.controllerId).toBe('P4');
    changeController(ctx, walker, 'P2');
    const before = ogers(ctx, 'P4');
    pump(runPrioritySequence(ctx));
    const created = ctx.state.battlefield.filter((p) => p.isToken && p.name === 'Ogre');
    expect(created).toHaveLength(1);
    expect(created[0]!.controllerId).toBe('P4');
    expect(ogers(ctx, 'P4')).toBe(before + 1);
  });
});

describe('eventObjectDefendingPlayerIsYou authoring scope', () => {
  it('accepts Kazuul itself as authored', () => {
    const def = interpretCard(kazuul());
    expect(def.modeled).toBe(true);
    expect(def.unmodeledReasons).toEqual([]);
    expect(validateCardDefinition(def)).toEqual([]);
  });

  it('rejects a self-subject event — no event object is bound', () => {
    const def = structuredClone(interpretCard(kazuul()));
    const trigger = def.triggers[0]!;
    def.triggers = [
      {
        ...trigger,
        trigger: {
          when: 'attacks',
          subject: { kind: 'self' },
          condition: { kind: 'eventObjectDefendingPlayerIsYou' },
        },
      },
    ];
    expect(validateCardDefinition(def).map((issue) => issue.message)).toContain(
      'event object defending player check requires an owning permanent event scope',
    );
  });

  it('rejects a card-scope event', () => {
    const def = structuredClone(interpretCard(kazuul()));
    const trigger = def.triggers[0]!;
    def.triggers = [
      {
        ...trigger,
        trigger: {
          when: 'discardsCard',
          player: 'you',
          condition: { kind: 'eventObjectDefendingPlayerIsYou' },
        },
      },
    ];
    expect(validateCardDefinition(def).map((issue) => issue.message)).toContain(
      'event object defending player check requires an owning permanent event scope',
    );
  });

  it('rejects a non-attack permanent event even though it binds a permanent object', () => {
    const def = structuredClone(interpretCard(kazuul()));
    const trigger = def.triggers[0]!;
    def.triggers = [
      {
        ...trigger,
        trigger: {
          when: 'enters',
          subject: {
            kind: 'permanent',
            selector: { kind: 'type', value: 'Creature' },
          },
          condition: { kind: 'eventObjectDefendingPlayerIsYou' },
        },
      },
    ];
    expect(validateCardDefinition(def).map((issue) => issue.message)).toContain(
      'event object defending player check requires a creature attack event',
    );
  });

  it('rejects a spell ability — no owning event scope at all', () => {
    const def = structuredClone(interpretCard(creatureCard()));
    def.triggers = [];
    def.spellAbility = {
      kind: 'spell',
      targets: [],
      effects: [
        {
          op: 'conditionalEffect',
          condition: { kind: 'eventObjectDefendingPlayerIsYou' },
          then: [],
          else: [],
        },
      ],
    };
    expect(validateCardDefinition(def).map((issue) => issue.message)).toContain(
      'event object defending player check requires an owning permanent event scope',
    );
  });
});
