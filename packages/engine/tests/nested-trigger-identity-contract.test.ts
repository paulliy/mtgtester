import { describe, expect, it } from 'vitest';
import type { Effect } from '../src/cards/ability';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { createGame } from '../src/state/game';
import { applyPriorityAction } from '../src/actions/apply';
import { resolveTopOfStack } from '../src/stack/stack';
import { moveObject } from '../src/state/objects';
import { queueStepTriggers } from '../src/turn/turn';
import { runPrioritySequence } from '../src/turn/priority';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const wrap = (kind: 'direct' | 'conditional' | 'choice', effect: Effect): Effect =>
  kind === 'direct'
    ? effect
    : kind === 'conditional'
      ? { op: 'conditionalEffect', condition: { kind: 'yourTurn' }, then: [effect], else: [] }
      : {
          op: 'chooseOne',
          options: [{ description: 'Apply the independent event effect', effects: [effect] }],
        };

describe('nested event-object identity through normal casting', () => {
  it.each(['direct', 'conditional', 'choice'] as const)(
    '%s event effect acts on the original object and skips its blinked incarnation',
    (kind) => {
      for (const blink of [false, true]) {
        const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
        ctx.state.currentTurnPlayer = 'P1';
        ctx.state.activePlayerIndex = 0;
        ctx.state.phase = 'precombatMain';
        const player = ctx.state.players[0]!;
        const watcher = spawn(
          ctx,
          'P1',
          oracle({ name: 'Independent nested identity watcher', typeLine: 'Enchantment' }),
        );
        const base = ctx.defs.get(watcher.oracleId)!;
        const definition = {
          ...base,
          triggers: [
            {
              kind: 'triggered' as const,
              trigger: {
                when: 'enters' as const,
                subject: {
                  kind: 'permanent' as const,
                  selector: { kind: 'type' as const, value: 'Creature' },
                },
              },
              targets: [],
              effects: [
                wrap(kind, {
                  op: 'putCounters',
                  target: 'triggerObject',
                  counter: 'charge',
                  count: { kind: 'const', n: 1 },
                }),
              ],
            },
          ],
        };
        expect(validateCardDefinition(definition)).toEqual([]);
        ctx.defs.set(watcher.oracleId, definition);
        const card = conjure(ctx, 'P1', { ...bear(), manaCost: '{0}', cmc: 0 }, 'hand');
        pump(
          applyPriorityAction(
            ctx,
            player,
            { kind: 'castSpell', objectId: card.id, fromCommand: false },
            { index: 0, targets: new Map() },
          ),
        );
        pump(resolveTopOfStack(ctx));
        expect(ctx.state.pendingTriggers).toHaveLength(1);
        ctx.defs.set(watcher.oracleId, base);
        const original = ctx.state.battlefield.find((object) => object.cardId === card.cardId)!;
        if (blink) {
          const exiled = pump(moveObject(ctx, original, { zone: 'exile' })).value!;
          pump(moveObject(ctx, exiled, { zone: 'battlefield', controllerId: 'P1' }));
        }
        const current = ctx.state.battlefield.find((object) => object.cardId === card.cardId)!;
        if (blink) expect(current.id).not.toBe(original.id);
        pump(runPrioritySequence(ctx));
        expect(current.counters['charge'] ?? 0).toBe(blink ? 0 : 1);
      }
    },
  );
  it.each(['direct', 'conditional', 'choice'] as const)(
    '%s delayed registration remembers the firing incarnation after a blink',
    (kind) => {
      const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
      ctx.state.currentTurnPlayer = 'P1';
      ctx.state.activePlayerIndex = 0;
      ctx.state.phase = 'precombatMain';
      const player = ctx.state.players[0]!;
      const watcher = spawn(
        ctx,
        'P1',
        oracle({ name: 'Independent nested delayed watcher', typeLine: 'Enchantment' }),
      );
      const base = ctx.defs.get(watcher.oracleId)!;
      const definition = {
        ...base,
        triggers: [
          {
            kind: 'triggered' as const,
            trigger: {
              when: 'enters' as const,
              subject: {
                kind: 'permanent' as const,
                selector: { kind: 'type' as const, value: 'Creature' },
              },
            },
            targets: [],
            effects: [
              wrap(kind, {
                op: 'registerDelayedTrigger',
                target: 'triggerObject',
                sameObject: true,
                when: 'upkeep',
                expiry: 'onFire',
                ability: {
                  kind: 'triggered',
                  targets: [],
                  effects: [
                    {
                      op: 'putCounters',
                      target: 'triggerObject',
                      counter: 'charge',
                      count: { kind: 'const', n: 1 },
                    },
                  ],
                },
              }),
            ],
          },
        ],
      };
      expect(validateCardDefinition(definition)).toEqual([]);
      ctx.defs.set(watcher.oracleId, definition);
      const card = conjure(ctx, 'P1', { ...bear(), manaCost: '{0}', cmc: 0 }, 'hand');
      pump(
        applyPriorityAction(
          ctx,
          player,
          { kind: 'castSpell', objectId: card.id, fromCommand: false },
          { index: 0, targets: new Map() },
        ),
      );
      pump(resolveTopOfStack(ctx));
      expect(ctx.state.pendingTriggers).toHaveLength(1);
      ctx.defs.set(watcher.oracleId, base);
      const original = ctx.state.battlefield.find((object) => object.cardId === card.cardId)!;
      const exiled = pump(moveObject(ctx, original, { zone: 'exile' })).value!;
      pump(moveObject(ctx, exiled, { zone: 'battlefield', controllerId: 'P1' }));
      const current = ctx.state.battlefield.find((object) => object.cardId === card.cardId)!;
      pump(runPrioritySequence(ctx));
      expect(ctx.state.delayedTriggers).toHaveLength(1);
      expect(ctx.state.delayedTriggers[0]!.targetObjectId).toBe(original.id);
      queueStepTriggers(ctx, 'upkeep');
      pump(runPrioritySequence(ctx));
      expect(current.counters['charge'] ?? 0).toBe(0);
      expect(ctx.state.delayedTriggers).toEqual([]);
    },
  );
});

describe('event-reference identity across trigger source zones', () => {
  it.each(['dies', 'graveyard', 'emblem'] as const)(
    '%s trigger keeps the event incarnation after a normal cast and later zone changes',
    (location) => {
      const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
      ctx.state.currentTurnPlayer = 'P1';
      ctx.state.activePlayerIndex = 0;
      ctx.state.phase = 'precombatMain';
      const player = ctx.state.players[0]!;
      const eventAbility = {
        kind: 'triggered' as const,
        trigger: {
          when: location === 'dies' ? ('dies' as const) : ('enters' as const),
          subject: {
            kind: 'permanent' as const,
            selector: { kind: 'type' as const, value: 'Creature' },
          },
        },
        targets: [],
        effects: [
          wrap('conditional', {
            op: 'putCounters',
            target: 'triggerObject',
            counter: 'charge',
            count: { kind: 'const', n: 1 },
          }),
        ],
        ...(location === 'graveyard' ? { functionsInGraveyard: true as const } : {}),
      };
      const watcherCard = oracle({
        name: 'Independent source-zone watcher',
        typeLine: 'Enchantment',
      });
      const watcher =
        location === 'graveyard'
          ? conjure(ctx, 'P1', watcherCard, 'graveyard')
          : spawn(ctx, 'P1', watcherCard);
      const base = ctx.defs.get(watcher.oracleId)!;
      const definition = { ...base, triggers: location === 'emblem' ? [] : [eventAbility] };
      expect(validateCardDefinition(definition)).toEqual([]);
      ctx.defs.set(watcher.oracleId, definition);
      if (location === 'emblem')
        player.emblems.push({
          id: 'independent-emblem',
          name: 'Independent event emblem',
          controllerId: 'P1',
          abilities: [eventAbility],
        });
      const card = conjure(ctx, 'P1', { ...bear(), manaCost: '{0}', cmc: 0 }, 'hand');
      pump(
        applyPriorityAction(
          ctx,
          player,
          { kind: 'castSpell', objectId: card.id, fromCommand: false },
          { index: 0, targets: new Map() },
        ),
      );
      pump(resolveTopOfStack(ctx));
      const original = ctx.state.battlefield.find((object) => object.cardId === card.cardId)!;
      let departed;
      if (location === 'dies')
        departed = pump(moveObject(ctx, original, { zone: 'graveyard' })).value!;
      expect(ctx.state.pendingTriggers).toHaveLength(1);
      expect(ctx.state.pendingTriggers[0]!.scope?.eventObjectId).toBe(original.id);
      ctx.defs.set(watcher.oracleId, base);
      player.emblems = [];
      departed ??= pump(moveObject(ctx, original, { zone: 'exile' })).value!;
      pump(moveObject(ctx, departed, { zone: 'battlefield', controllerId: 'P1' }));
      const current = ctx.state.battlefield.find((object) => object.cardId === card.cardId)!;
      expect(current.id).not.toBe(original.id);
      pump(runPrioritySequence(ctx));
      expect(current.counters['charge'] ?? 0).toBe(0);
    },
  );
});
