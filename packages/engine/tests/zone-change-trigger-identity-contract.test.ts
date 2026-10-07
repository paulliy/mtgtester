import { describe, expect, it } from 'vitest';
import type { Effect, TargetSpec } from '../src/cards/ability';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { createGame } from '../src/state/game';
import { applyPriorityAction } from '../src/actions/apply';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { queueStepTriggers } from '../src/turn/turn';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

describe('zone-change triggers remember only the first public destination incarnation', () => {
  for (const delayed of [false, true])
    for (const owner of ['P1', 'P2'] as const)
      for (const movement of delayed
        ? ['stayed', 'before registration', 'after registration']
        : ['stayed', 'before registration'])
        it(`${delayed ? 'delayed' : 'immediate'} return of ${owner} owned creature after ${movement}`, () => {
          const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
          ctx.state.currentTurnPlayer = 'P1';
          ctx.state.activePlayerIndex = 0;
          ctx.state.phase = 'precombatMain';
          const player = ctx.state.players[0]!;
          const watcher = spawn(
            ctx,
            'P1',
            oracle({ name: 'Independent first-zone watcher', typeLine: 'Enchantment' }),
          );
          const victim = spawn(ctx, owner, oracle({ name: 'Independent first-zone victim' }));
          victim.controllerId = 'P1';
          const base = ctx.defs.get(watcher.oracleId)!;
          const returnEffect: Effect = { op: 'graveyardToBattlefield', target: 'triggerObject' };
          const effects: Effect[] = delayed
            ? [
                {
                  op: 'registerDelayedTrigger',
                  target: 'triggerObject',
                  when: 'upkeep',
                  expiry: 'onFire',
                  ability: { kind: 'triggered', targets: [], effects: [returnEffect] },
                },
              ]
            : [returnEffect];
          const definition = {
            ...base,
            triggers: [
              {
                kind: 'triggered' as const,
                trigger: {
                  when: 'dies' as const,
                  subject: {
                    kind: 'permanent' as const,
                    selector: { kind: 'type' as const, value: 'Creature' },
                  },
                },
                targets: [],
                effects,
              },
            ],
          };
          expect(validateCardDefinition(definition)).toEqual([]);
          ctx.defs.set(watcher.oracleId, definition);
          let sequence = 0;
          function cast(effect: Effect, spec: TargetSpec, targetId: string) {
            const card = conjure(
              ctx,
              'P1',
              oracle({
                name: `Independent first-zone response ${sequence++}`,
                typeLine: 'Instant',
                manaCost: '{0}',
                oracleText: 'You gain 1 life.',
              }),
              'hand',
            );
            const def = {
              ...ctx.defs.get(card.oracleId)!,
              spellAbility: { kind: 'spell' as const, targets: [spec], effects: [effect] },
            };
            expect(validateCardDefinition(def)).toEqual([]);
            ctx.defs.set(card.oracleId, def);
            pump(
              applyPriorityAction(
                ctx,
                player,
                { kind: 'castSpell', objectId: card.id, fromCommand: false },
                { index: 0, targets: new Map([[0, targetId]]) },
              ),
            );
            pump(resolveTopOfStack(ctx));
          }
          cast({ op: 'destroy', target: 0 }, { kind: 'creature' }, victim.id);
          expect(ctx.state.pendingTriggers).toHaveLength(1);
          // The firing is retained, while later independent deaths cannot create a second return.
          ctx.defs.set(watcher.oracleId, base);
          const first = ctx.state.players
            .find((player) => player.id === owner)!
            .graveyard.find((card) => card.cardId === victim.cardId)!;
          function leaveAndReturn() {
            cast(
              { op: 'graveyardToBattlefield', target: 0 },
              { kind: 'cardInGraveyard', graveyardOwnerScope: 'any' },
              first.id,
            );
            const returning = ctx.state.battlefield.find(
              (object) => object.cardId === victim.cardId,
            )!;
            expect(returning).toBeDefined();
            cast({ op: 'destroy', target: 0 }, { kind: 'creature' }, returning.id);
            const next = ctx.state.players
              .find((player) => player.id === owner)!
              .graveyard.find((card) => card.cardId === victim.cardId)!;
            expect(next.id).not.toBe(first.id);
          }
          if (movement === 'before registration') leaveAndReturn();
          pump(runPrioritySequence(ctx));
          if (delayed) {
            expect(ctx.state.delayedTriggers).toHaveLength(1);
            if (movement === 'after registration') leaveAndReturn();
            queueStepTriggers(ctx, 'upkeep');
            pump(runPrioritySequence(ctx));
            expect(ctx.state.delayedTriggers).toEqual([]);
          }
          const returned = ctx.state.battlefield.find((object) => object.cardId === victim.cardId);
          if (movement === 'stayed') {
            expect(returned).toBeDefined();
            expect(returned!.ownerId).toBe(owner);
            expect(returned!.controllerId).toBe('P1');
          } else expect(returned).toBeUndefined();
        });
});
