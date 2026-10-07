import { describe, expect, it } from 'vitest';
import type { Effect } from '../src/cards/ability';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { createGame } from '../src/state/game';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { queueStepTriggers } from '../src/turn/turn';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const effects: Effect[] = [
  { op: 'transformSelf' },
  { op: 'selfToLibraryTop' },
  { op: 'exileSource' },
];
describe('implicit source instructions respect their originating incarnation', () => {
  for (const effect of effects)
    for (const blink of [false, true]) {
      it(`${effect.op} ${blink ? 'skips the returning incarnation' : 'acts on the live original'}`, () => {
        const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
        ctx.state.currentTurnPlayer = 'P1';
        ctx.state.activePlayerIndex = 0;
        ctx.state.phase = 'precombatMain';
        ctx.state.turnNumber = 3;
        const player = ctx.state.players[0]!;
        const source = spawn(
          ctx,
          'P1',
          oracle({
            name: 'Independent source front // Independent source back',
            typeLine: 'Creature — Witness',
            manaCost: '{0}',
            cmc: 0,
            layout: 'transform',
            backFace: {
              name: 'Independent source back',
              typeLine: 'Creature — Witness',
              oracleText: '',
              manaCost: null,
              colors: [],
              power: '4',
              toughness: '4',
              loyalty: null,
              defense: null,
            },
          }),
        );
        const definition = {
          ...ctx.defs.get(source.oracleId)!,
          activatedAbilities: [
            {
              costs: [],
              timing: 'any' as const,
              ability: { kind: 'activated' as const, targets: [], effects: [effect] },
            },
          ],
        };
        expect(validateCardDefinition(definition)).toEqual([]);
        ctx.defs.set(source.oracleId, definition);
        const option = computePriorityOptions(ctx, player).find((option) => {
          const payload = option.payload as PriorityActionPayload;
          return payload.kind === 'activateAbility' && payload.objectId === source.id;
        })!;
        expect(option).toBeDefined();
        pump(
          applyPriorityAction(ctx, player, option.payload as PriorityActionPayload, {
            index: 0,
            targets: new Map(),
          }),
        );
        if (blink) {
          const response = conjure(
            ctx,
            'P1',
            oracle({
              name: 'Independent source blink',
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
              targets: [{ kind: 'creature' }],
              effects: [{ op: 'blinkTarget', target: 0 }],
            },
          });
          pump(
            applyPriorityAction(
              ctx,
              player,
              { kind: 'castSpell', objectId: response.id, fromCommand: false },
              { index: 0, targets: new Map([[0, source.id]]) },
            ),
          );
          pump(resolveTopOfStack(ctx));
          expect(ctx.state.battlefield.find((card) => card.cardId === source.cardId)!.id).not.toBe(
            source.id,
          );
        }
        pump(runPrioritySequence(ctx));
        const current = ctx.state.battlefield.find((card) => card.cardId === source.cardId);
        if (blink) {
          expect(current).toBeDefined();
          expect(current!.transformed).toBe(false);
          expect(current!.power).toBe(2);
        } else if (effect.op === 'transformSelf') {
          expect(current!.transformed).toBe(true);
          expect(current!.name).toBe('Independent source back');
        } else {
          expect(current).toBeUndefined();
          expect(
            (effect.op === 'exileSource' ? ctx.state.exile : player.library).some(
              (card) => card.cardId === source.cardId,
            ),
          ).toBe(true);
        }
      });
    }
});

describe('unearth remembers the returned incarnation', () => {
  it.each([false, true])('end-step exile respects blink=%s', (blink) => {
    const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    ctx.state.phase = 'precombatMain';
    ctx.state.turnNumber = 3;
    const player = ctx.state.players[0]!;
    const card = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Independent unearth witness',
        typeLine: 'Creature — Witness',
        oracleText: 'Unearth {0}',
      }),
      'graveyard',
    );
    const option = computePriorityOptions(ctx, player).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === card.id;
    })!;
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, option.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    pump(resolveTopOfStack(ctx));
    const returned = ctx.state.battlefield.find((object) => object.cardId === card.cardId)!;
    expect(returned).toBeDefined();
    if (blink) {
      const response = conjure(
        ctx,
        'P1',
        oracle({
          name: 'Independent unearth blink',
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
          targets: [{ kind: 'creature' }],
          effects: [{ op: 'blinkTarget', target: 0 }],
        },
      });
      pump(
        applyPriorityAction(
          ctx,
          player,
          { kind: 'castSpell', objectId: response.id, fromCommand: false },
          { index: 0, targets: new Map([[0, returned.id]]) },
        ),
      );
      pump(resolveTopOfStack(ctx));
      expect(ctx.state.battlefield.find((object) => object.cardId === card.cardId)!.id).not.toBe(
        returned.id,
      );
    }
    queueStepTriggers(ctx, 'endStep');
    pump(runPrioritySequence(ctx));
    expect(ctx.state.battlefield.some((object) => object.cardId === card.cardId)).toBe(blink);
    expect(ctx.state.exile.some((object) => object.cardId === card.cardId)).toBe(!blink);
    expect(ctx.state.delayedTriggers).toEqual([]);
  });
});
