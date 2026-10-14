import { describe, expect, it } from 'vitest';
import type { Ability, Effect, TriggerHead } from '../src/cards/ability';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { interpretCard } from '../src/cards/interpret';
import { constant } from '../src/cards/value';
import { executeAbility } from '../src/effects/resolve';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import { resolveTopOfStack } from '../src/stack/stack';
import type { EngineCardObject, EnginePermanent, GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

function pod(seed = 'discard-event-contract'): GameContext {
  const ctx = createGame(
    gameConfig(Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })), { seed }),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

function card(name: string, typeLine = 'Sorcery') {
  return oracle({ name, typeLine, manaCost: '{1}', power: null, toughness: null });
}

function watcher(
  ctx: GameContext,
  head: TriggerHead,
  effects: Effect[] = [],
  name = 'Discard Watcher',
  typeLine = 'Enchantment',
): EnginePermanent {
  const printed = oracle({ name, typeLine, manaCost: null, power: null, toughness: null });
  const def = interpretCard(printed);
  def.triggers = [
    { kind: 'triggered', trigger: head, targets: [], effects },
  ];
  ctx.defs.set(def.oracleId, def);
  return spawn(ctx, 'P1', printed);
}

function putInHand(ctx: GameContext, ownerId: string, ...printed: ReturnType<typeof card>[]): EngineCardObject[] {
  return printed.map((entry) => conjure(ctx, ownerId, entry, 'hand'));
}

function runEffect(
  ctx: GameContext,
  source: EnginePermanent,
  effect: Effect,
  targets: Ability['targets'] = [],
  targetIds: string[] = [],
  answer?: Parameters<typeof pump>[1],
) {
  return pump(
    executeAbility(
      ctx,
      { id: source.id, cardId: source.cardId, name: source.name, oracleId: source.oracleId, controllerId: source.controllerId },
      { kind: 'spell', targets, effects: [effect] },
      targetIds,
    ),
    answer,
  );
}

function player(ctx: GameContext, id: string) {
  const found = ctx.state.players.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing player ${id}`);
  return found;
}

describe('discardsCard trigger contract', () => {
  it('observes controller and opponent scopes, with each observing both and retaining eventPlayer', () => {
    const ctx = pod();
    watcher(ctx, { when: 'discardsCard', player: 'you' }, [], 'You Watcher');
    watcher(ctx, { when: 'discardsCard', player: 'opponent' }, [], 'Opponent Watcher');
    watcher(ctx, { when: 'discardsCard', player: 'each' }, [], 'Each Watcher');

    const [own] = putInHand(ctx, 'P1', card('Own Discard'));
    runEffect(ctx, ctx.state.battlefield[0]!, { op: 'discardTarget', target: 0, count: constant(1) }, [{ kind: 'player' }], ['P1']);
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.sourceName).sort()).toEqual(['Each Watcher', 'You Watcher']);
    expect(ctx.state.pendingTriggers.every((trigger) => trigger.scope?.eventPlayerId === 'P1')).toBe(true);
    expect(player(ctx, 'P1').graveyard).toContainEqual(expect.objectContaining({ cardId: own!.cardId }));

    ctx.state.pendingTriggers = [];
    const [opponent] = putInHand(ctx, 'P2', card('Opponent Discard'));
    runEffect(ctx, ctx.state.battlefield[0]!, { op: 'discardTarget', target: 0, count: constant(1) }, [{ kind: 'player' }], ['P2']);
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.sourceName).sort()).toEqual(['Each Watcher', 'Opponent Watcher']);
    expect(ctx.state.pendingTriggers.every((trigger) => trigger.scope?.eventPlayerId === 'P2')).toBe(true);
    expect(player(ctx, 'P2').graveyard).toContainEqual(expect.objectContaining({ cardId: opponent!.cardId }));
  });

  it.each([
    ['creature', 'Creature — Bear', 'Creature', true],
    ['creature', 'Sorcery', 'Sorcery', false],
    ['land', 'Land', 'Land', true],
    ['land', 'Artifact', 'Artifact', false],
    ['noncreature', 'Artifact Creature — Golem', 'Artifact Creature — Golem', false],
    ['noncreature', 'Artifact', 'Artifact', true],
    ['nonland', 'Land', 'Land', false],
    ['nonland', 'Instant', 'Instant', true],
  ] as const)('matches %s selector against card characteristics (%s)', (filterName, actualType, label, expected) => {
    const ctx = pod(`filter-${filterName}-${actualType}`);
    const selectors = {
      creature: { kind: 'type', value: 'Creature' },
      land: { kind: 'type', value: 'Land' },
      noncreature: { kind: 'not', of: { kind: 'type', value: 'Creature' } },
      nonland: { kind: 'not', of: { kind: 'type', value: 'Land' } },
    } as const;
    const head = { when: 'discardsCard', player: 'each', filter: selectors[filterName] } as TriggerHead;
    const source = watcher(ctx, head);
    putInHand(ctx, 'P2', card(`Filter ${label}`, actualType));
    runEffect(ctx, source, { op: 'discardTarget', target: 0, count: constant(1) }, [{ kind: 'player' }], ['P2']);
    expect(ctx.state.pendingTriggers).toHaveLength(expected ? 1 : 0);
  });

  it('dispatches chosen, random, and each-player discard effects through the same event path', () => {
    const ctx = pod();
    const source = watcher(ctx, { when: 'discardsCard', player: 'each' });
    putInHand(ctx, 'P2', card('Chosen A'), card('Chosen B'));
    runEffect(ctx, source, { op: 'discardTarget', target: 0, count: constant(1) }, [{ kind: 'player' }], ['P2'], (decision) => ({ index: 1, targets: new Map() }));
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.scope?.eventPlayerId)).toEqual(['P2']);
    ctx.state.pendingTriggers = [];

    putInHand(ctx, 'P3', card('Random A'), card('Random B'));
    runEffect(ctx, source, { op: 'discardTarget', target: 0, count: constant(1), atRandom: true }, [{ kind: 'player' }], ['P3']);
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.scope?.eventPlayerId)).toEqual(['P3']);
    ctx.state.pendingTriggers = [];

    for (const id of ['P1', 'P2', 'P3', 'P4']) putInHand(ctx, id, card(`${id} Each`));
    runEffect(ctx, source, { op: 'discardEachPlayer', scope: 'all', count: constant(1) });
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.scope?.eventPlayerId)).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(ctx.state.eventLog.filter((event) => event.type === 'discard')).toHaveLength(6);
  });

  it('does not treat milling or a direct zone move as a discard', () => {
    const ctx = pod();
    const source = watcher(ctx, { when: 'discardsCard', player: 'each' });
    const [hand] = putInHand(ctx, 'P2', card('Moved Directly'));
    pump(moveObject(ctx, hand!, { zone: 'graveyard' }));
    conjure(ctx, 'P2', card('Milled Card'), 'library');
    runEffect(ctx, source, { op: 'mill', count: constant(1) });
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    expect(ctx.state.eventLog.filter((event) => event.type === 'discard')).toHaveLength(0);
  });

  it('fires once for a normal cycling activation and resolves the trigger for eventPlayer', () => {
    const ctx = pod();
    const source = watcher(ctx, { when: 'discardsCard', player: 'each' }, [{ op: 'draw', count: constant(1), player: 'eventPlayer' }]);
    const cycleCard = oracle({ name: 'Test Cycler', typeLine: 'Creature — Bear', manaCost: '{0}', power: '2', toughness: '2', oracleText: 'Cycling {0}' });
    const cardInHand = conjure(ctx, 'P1', cycleCard, 'hand');
    const option = computePriorityOptions(ctx, player(ctx, 'P1')).find((candidate) => {
      const payload = candidate.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.fromHand === true && payload.objectId === cardInHand.id;
    });
    expect(option).toBeDefined();
    pump(applyPriorityAction(ctx, player(ctx, 'P1'), option!.payload as PriorityActionPayload, { index: 0, targets: new Map() }));
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    expect(ctx.state.pendingTriggers[0]?.scope?.eventPlayerId).toBe('P1');
    expect(ctx.state.eventLog.filter((event) => event.type === 'discard')).toHaveLength(1);
    expect(player(ctx, 'P1').graveyard.some((entry) => entry.cardId === cardInHand.cardId)).toBe(true);

    pump(resolveTopOfStack(ctx));
    pump(runPrioritySequence(ctx));
    expect(player(ctx, 'P1').hand).toHaveLength(2); // cycling draw plus the eventPlayer trigger draw
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });

  it('applies the existing typed-trigger amplifier exactly once per additional copy', () => {
    const ctx = pod();
    const source = watcher(ctx, { when: 'discardsCard', player: 'you' }, [], 'Wizard Discarder', 'Creature — Wizard');
    const amplifierCard = oracle({ name: 'Test Amplifier', typeLine: 'Artifact', manaCost: null, power: null, toughness: null });
    const ampDef = interpretCard(amplifierCard);
    ampDef.ruleStatics = [{ kind: 'triggerAdditionalForShamanOrOtherWizard' }];
    ctx.defs.set(ampDef.oracleId, ampDef);
    spawn(ctx, 'P1', amplifierCard);
    putInHand(ctx, 'P1', card('Copied Discard'));
    runEffect(ctx, source, { op: 'discardTarget', target: 0, count: constant(1) }, [{ kind: 'player' }], ['P1']);
    expect(ctx.state.pendingTriggers).toHaveLength(2);
    expect(ctx.state.pendingTriggers.every((trigger) => trigger.sourceCardId === source.cardId)).toBe(true);
  });

  it('rejects invalid scope, object-only fields, and permanent references to a discarded card event', () => {
    const printed = oracle({ name: 'Invalid Discard Watcher', typeLine: 'Enchantment', manaCost: null, power: null, toughness: null });
    const base = interpretCard(printed);
    const invalidScope = structuredClone(base);
    invalidScope.triggers = [{ kind: 'triggered', trigger: { when: 'discardsCard', player: 'controller' } as never, targets: [], effects: [] }];
    expect(validateCardDefinition(invalidScope).map((issue) => issue.message).join('\n')).toMatch(/supported player scope|player/);

    const objectField = structuredClone(base);
    objectField.triggers = [{ kind: 'triggered', trigger: { when: 'discardsCard', player: 'you', subject: { kind: 'self' } } as never, targets: [], effects: [] }];
    expect(validateCardDefinition(objectField).map((issue) => issue.message).join('\n')).toMatch(/incompatible with card trigger/);

    const referent = structuredClone(base);
    referent.triggers = [{ kind: 'triggered', trigger: { when: 'discardsCard', player: 'you' }, targets: [], effects: [{ op: 'destroy', target: 'triggerObject' } as Effect] }];
    expect(validateCardDefinition(referent).map((issue) => issue.message).join('\n')).toMatch(/card event object is incompatible with this permanent reference/);
  });
});
