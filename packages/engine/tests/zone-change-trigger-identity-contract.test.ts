import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import type { Effect, TargetSpec } from '../src/cards/ability';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { createGame } from '../src/state/game';
import { addMana } from '../src/mana/pool';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
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

it.each(['stayed', 'after registration'])(
  'batch-death-first-destination — preserves separate identities after %s',
  (movement) => {
    const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    ctx.state.phase = 'precombatMain';
    const player = ctx.state.players[0]!;
    const pins = JSON.parse(
      readFileSync('packages/engine/tests/fixtures/zone-change-trigger-oracle.json', 'utf8'),
    ) as { cards: { card: OracleCard }[] };
    const marchesa = spawn(
      ctx,
      'P1',
      pins.cards.find(({ card }) => card.name === 'Marchesa, the Black Rose')!.card,
    );
    const own = spawn(ctx, 'P1', oracle({ name: 'Independent batch own victim' }));
    const theirs = spawn(ctx, 'P2', oracle({ name: 'Independent batch stolen victim' }));
    theirs.controllerId = 'P1';
    for (const permanent of [marchesa, own, theirs]) permanent.counters['+1/+1'] = 1;
    const batchPins = JSON.parse(
      readFileSync('packages/engine/tests/fixtures/overload-static-review-oracle.json', 'utf8'),
    ) as { cards: { card: OracleCard }[] };
    const spell = conjure(
      ctx,
      'P1',
      batchPins.cards.find(({ card }) => card.name === 'Blasphemous Act')!.card,
      'hand',
    );
    addMana(
      player,
      Array.from({ length: 9 }, () => ({ symbol: 'R' as const })),
    );
    const action = computePriorityOptions(ctx, player).find(
      (option) =>
        (option.payload as PriorityActionPayload).kind === 'castSpell' &&
        (option.payload as { objectId?: string }).objectId === spell.id,
    )!;
    expect(action).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, action.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    pump(resolveTopOfStack(ctx));
    pump(runPrioritySequence(ctx));
    expect(ctx.state.delayedTriggers).toHaveLength(3);
    const destinations = ctx.state.delayedTriggers.map((trigger) => trigger.targetObjectId);
    expect(new Set(destinations).size).toBe(3);
    // A normal graveyard response cannot make a delayed return follow a later incarnation.
    if (movement !== 'stayed') {
      const response = conjure(
        ctx,
        'P1',
        oracle({
          name: 'Independent batch graveyard response',
          typeLine: 'Instant',
          manaCost: '{0}',
          oracleText: 'You gain 1 life.',
        }),
        'hand',
      );
      ctx.defs.set(response.oracleId, {
        ...ctx.defs.get(response.oracleId)!,
        spellAbility: {
          kind: 'spell',
          targets: [{ kind: 'player' }],
          effects: [{ op: 'exileTargetPlayerGraveyard', target: 0 }],
        },
      });
      pump(
        applyPriorityAction(
          ctx,
          player,
          { kind: 'castSpell', objectId: response.id, fromCommand: false },
          { index: 0, targets: new Map([[0, 'P2']]) },
        ),
      );
      pump(resolveTopOfStack(ctx));
    }
    queueStepTriggers(ctx, 'endStep');
    pump(runPrioritySequence(ctx));
    expect(ctx.state.battlefield.some((card) => card.cardId === own.cardId)).toBe(true);
    expect(ctx.state.battlefield.some((card) => card.cardId === marchesa.cardId)).toBe(true);
    const returned = ctx.state.battlefield.find((card) => card.cardId === theirs.cardId);
    if (movement === 'stayed') {
      expect(returned?.ownerId).toBe('P2');
      expect(returned?.controllerId).toBe('P1');
    } else expect(returned).toBeUndefined();
  },
);
