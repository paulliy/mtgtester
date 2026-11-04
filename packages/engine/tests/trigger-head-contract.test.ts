import { describe, expect, it } from 'vitest';
import type { Ability, TriggerHead } from '../src/cards/ability';
import {
  assertValidModeledDefinition,
  enforceCardDefinition,
  validateCardDefinition,
  validateOverrideDefinition,
} from '../src/cards/authoring-validation';
import { triggerEventFamily } from '../src/cards/trigger-contracts';
import { queuePlayerTriggersForEvent, queueTriggersForEvent } from '../src/state/objects';
import { cloneContractContext } from './helpers/contract-harness';
import { interpretCard } from '../src/cards/interpret';
import { applyPriorityAction } from '../src/actions/apply';
import { createGame } from '../src/state/game';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { queueStepTriggers } from '../src/turn/turn';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const malformed = [
  { name: 'missing event', head: {} },
  { name: 'missing object subject', head: { when: 'enters' } },
  { name: 'step subject', head: { when: 'upkeep', player: 'you', subject: { kind: 'self' } } },
  { name: 'spell subject', head: { when: 'castsSpell', caster: 'you', subject: { kind: 'self' } } },
  { name: 'missing spell caster', head: { when: 'castsSpell' } },
  { name: 'invalid spell caster', head: { when: 'castsSpell', caster: 'friendly' } },
  { name: 'invalid player scope', head: { when: 'gainsLife', player: 'enchanted' } },
  { name: 'missing step player', head: { when: 'upkeep' } },
  { name: 'fractional spell ordinal', head: { when: 'castsSpell', caster: 'you', ordinal: 1.5 } },
  {
    name: 'invalid aggregation',
    head: { when: 'attacks', subject: { kind: 'self' }, aggregate: 'allPlayers' },
  },
  {
    name: 'untapped on deaths',
    head: { when: 'dies', subject: { kind: 'self' }, entersUntapped: true },
  },
  {
    name: 'defender on entry',
    head: { when: 'enters', subject: { kind: 'self' }, defendingPlayerIsEventPlayer: true },
  },
];
function ability(head: unknown): Ability {
  return {
    kind: 'triggered',
    trigger: head as TriggerHead,
    targets: [],
    effects: [{ op: 'gainLife', amount: { kind: 'const', n: 2 } }],
  };
}

describe('trigger event shape contracts independent of production wiring', () => {
  it.each(malformed)('contains $name at final and override boundaries', ({ head }) => {
    const base = interpretCard(bear());
    const definition = { ...base, triggers: [ability(head)] };
    expect(validateCardDefinition(definition).length).toBeGreaterThan(0);
    expect(enforceCardDefinition(definition).modeled).toBe(false);
    expect(() => assertValidModeledDefinition(definition)).toThrow();
    expect(
      validateOverrideDefinition({
        oracleId: base.oracleId,
        name: base.name,
        handledLines: [],
        def: { triggers: [ability(head)] },
      }).length,
    ).toBeGreaterThan(0);
  });
  it.each([
    { when: 'enters', subject: { kind: 'self' } },
    { when: 'castsSpell', caster: 'you' },
    { when: 'gainsLife', player: 'you' },
    { when: 'upkeep', player: 'you' },
  ] as TriggerHead[])(
    'queues and resolves an independent $when trigger after a normal cast',
    (head) => {
      const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
      ctx.state.currentTurnPlayer = 'P1';
      ctx.state.activePlayerIndex = 0;
      ctx.state.phase = 'precombatMain';
      const player = ctx.state.players[0]!;
      const watcher = spawn(
        ctx,
        'P1',
        oracle({ name: 'Independent trigger watcher', typeLine: 'Enchantment' }),
      );
      const watcherDefinition = {
        ...ctx.defs.get(watcher.oracleId)!,
        triggers: head.when === 'enters' ? [] : [ability(head)],
      };
      expect(validateCardDefinition(watcherDefinition)).toEqual([]);
      ctx.defs.set(watcher.oracleId, watcherDefinition);
      const card = conjure(
        ctx,
        'P1',
        head.when === 'enters'
          ? oracle({
              name: 'Independent entering creature',
              typeLine: 'Creature — Bear',
              manaCost: '{0}',
              power: '2',
              toughness: '2',
            })
          : oracle({
              name: 'Independent trigger event spell',
              typeLine: 'Instant',
              manaCost: '{0}',
              oracleText: head.when === 'gainsLife' ? 'You gain 1 life.' : 'You gain 0 life.',
            }),
        'hand',
      );
      if (head.when === 'enters')
        ctx.defs.set(card.oracleId, { ...ctx.defs.get(card.oracleId)!, triggers: [ability(head)] });
      pump(
        applyPriorityAction(
          ctx,
          player,
          { kind: 'castSpell', objectId: card.id, fromCommand: false },
          { index: 0, targets: new Map() },
        ),
      );
      pump(resolveTopOfStack(ctx));
      if (head.when === 'upkeep') queueStepTriggers(ctx, 'upkeep');
      expect(ctx.state.pendingTriggers).toHaveLength(1);
      // The life watcher would trigger itself; remove its ability after the independent event.
      ctx.defs.set(watcher.oracleId, { ...watcherDefinition, triggers: [] });
      pump(runPrioritySequence(ctx), (decision) => ({
        index: decision.options.findIndex(
          (option) => (option.payload as { kind?: string } | undefined)?.kind === 'pass',
        ),
        targets: new Map(),
      }));
      expect(player.life).toBe(head.when === 'gainsLife' ? 43 : 42);
      expect(ctx.state.pendingTriggers).toEqual([]);
      expect(ctx.state.stack).toEqual([]);
    },
  );
});

describe('specialized trigger dispatch fails closed', () => {
  it.each(['inventedEvent', 'castsSpell', 'upkeep', 'gainsLife'])(
    'rejects %s through the object dispatcher even with no subjects',
    (when) => {
      const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
      const before = cloneContractContext(ctx);
      expect(() => queueTriggersForEvent(ctx, when as never, [])).toThrow();
      expect(ctx.state).toEqual(before.state);
      expect(ctx.debugLog).toEqual(before.debugLog);
      expect(ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
    },
  );
  it('rejects unknown event kinds rather than silently skipping all triggers', () => {
    const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
    const before = cloneContractContext(ctx);
    expect(() => triggerEventFamily('inventedEvent' as never)).toThrow('trigger event dispatcher');
    expect(() => queueStepTriggers(ctx, 'drawsCard' as never)).toThrow();
    expect(() => queuePlayerTriggersForEvent(ctx, 'upkeep' as never, 'P1')).toThrow();
    expect(ctx.state).toEqual(before.state);
    expect(ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
  });
});
