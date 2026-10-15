import { describe, expect, it } from 'vitest';
import type { Condition } from '../src/cards/condition';
import type { EnginePermanent } from '../src/state/types';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { manaCost } from '../src/cards/templates';
import { graveyardAlternativeCost } from '../src/cards/effect-builders';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { createGame } from '../src/state/game';
import { applyPriorityAction } from '../src/actions/apply';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const cases: {
  name: string;
  condition: Condition;
  original: Partial<EnginePermanent>;
  returning: Partial<EnginePermanent>;
  expected: boolean;
  combat?: boolean;
}[] = [
  {
    name: 'untapped',
    condition: { kind: 'isUntapped' },
    original: { tapped: false },
    returning: { tapped: true },
    expected: true,
  },
  {
    name: 'entry turn',
    condition: { kind: 'enteredThisTurn' },
    original: { enteredTurnNumber: 0 },
    returning: { enteredTurnNumber: 1 },
    expected: false,
  },
  {
    name: 'attack requirement',
    condition: { kind: 'hadToAttackThisCombat' },
    original: { hadToAttackThisCombat: true },
    returning: { hadToAttackThisCombat: false },
    expected: true,
  },
  {
    name: 'chosen option',
    condition: { kind: 'chosenOptionIs', value: 'blue' },
    original: { chosenOption: 'blue' },
    returning: { chosenOption: 'red' },
    expected: true,
  },
  {
    name: 'kicked',
    condition: { kind: 'wasKicked' },
    original: { wasKicked: true },
    returning: { wasKicked: false },
    expected: true,
  },
  {
    name: 'announced X',
    condition: { kind: 'announcedXAtLeast', n: 3 },
    original: { announcedX: 4 },
    returning: { announcedX: 0 },
    expected: true,
  },
  {
    name: 'escaped',
    condition: { kind: 'escaped' },
    original: { escaped: true },
    returning: { escaped: false },
    expected: true,
  },
  {
    name: 'source counters',
    condition: { kind: 'sourceHasCounters', counter: 'charge', cmp: '>=', n: 2 },
    original: { counters: { charge: 2 } },
    returning: { counters: { charge: 0 } },
    expected: true,
  },
  {
    name: 'self counter selector',
    condition: {
      kind: 'hasCounters',
      selector: { kind: 'self' },
      counter: 'charge',
      cmp: '>=',
      n: 2,
    },
    original: { counters: { charge: 2 } },
    returning: { counters: { charge: 0 } },
    expected: true,
  },
  {
    name: 'most-life defender',
    condition: { kind: 'attackingPlayerHasMoreLife' },
    original: { attacking: 'P2' },
    returning: { attacking: 'P2' },
    expected: true,
    combat: true,
  },
  {
    name: 'higher-life defender',
    condition: { kind: 'attackingPlayerHasMoreLifeThanYou' },
    original: { attacking: 'P2' },
    returning: { attacking: 'P2' },
    expected: true,
    combat: true,
  },
];

describe('resolving spell predicates use announced cast metadata', () => {
  for (const kind of ['wasKicked', 'announcedXAtLeast', 'escaped'] as const)
    for (const positive of [false, true])
      it(`${kind} reads its own ${positive ? 'positive' : 'negative'} announcement after stack removal`, () => {
        const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
        ctx.state.currentTurnPlayer = 'P1';
        ctx.state.activePlayerIndex = 0;
        ctx.state.phase = 'precombatMain';
        const player = ctx.state.players[0]!;
        spawn(ctx, 'P1', forest());
        const card = conjure(
          ctx,
          'P1',
          oracle({
            name: 'Independent spell metadata predicate',
            typeLine: 'Sorcery',
            manaCost: kind === 'announcedXAtLeast' ? '{X}' : '{0}',
            oracleText: 'You gain 1 life.',
          }),
          kind === 'escaped' && positive ? 'graveyard' : 'hand',
        );
        const condition: Condition = kind === 'announcedXAtLeast' ? { kind, n: 1 } : { kind };
        const definition = {
          ...ctx.defs.get(card.oracleId)!,
          ...(kind === 'wasKicked'
            ? { optionalAdditionalCost: { mechanic: 'kicker' as const, cost: manaCost('{G}') } }
            : {}),
          ...(kind === 'escaped'
            ? {
                alternativeCasts: [
                  graveyardAlternativeCost('escape', manaCost('{0}'), {
                    description: 'Independent escape contract',
                  }),
                ],
              }
            : {}),
          spellAbility: {
            kind: 'spell' as const,
            targets: [],
            effects: [
              {
                op: 'conditionalEffect' as const,
                condition,
                then: [{ op: 'gainLife' as const, amount: { kind: 'const' as const, n: 7 } }],
                else: [{ op: 'gainLife' as const, amount: { kind: 'const' as const, n: 2 } }],
              },
            ],
          },
        };
        expect(validateCardDefinition(definition)).toEqual([]);
        ctx.defs.set(card.oracleId, definition);
        const option = computePriorityOptions(ctx, player).find((option) => {
          const payload = option.payload as PriorityActionPayload;
          return (
            payload.kind === 'castSpell' &&
            payload.objectId === card.id &&
            (kind !== 'wasKicked' || (payload.optionalCostCount ?? 0) === (positive ? 1 : 0)) &&
            (kind !== 'announcedXAtLeast' || (payload.x ?? 0) === (positive ? 1 : 0))
          );
        });
        expect(option).toBeDefined();
        pump(
          applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
            index: 0,
            targets: new Map(),
          }),
        );
        pump(runPrioritySequence(ctx));
        expect(player.life).toBe(positive ? 47 : 42);
      });
});

describe('source predicates retain the announced source incarnation', () => {
  it.each(['blue', 'red'])(
    'a self death trigger retains the departed source choice %s',
    (choice) => {
      const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
      ctx.state.currentTurnPlayer = 'P1';
      ctx.state.activePlayerIndex = 0;
      ctx.state.phase = 'precombatMain';
      const player = ctx.state.players[0]!;
      const source = spawn(ctx, 'P1', oracle({ name: 'Independent dying predicate source' }));
      source.chosenOption = choice;
      const definition = {
        ...ctx.defs.get(source.oracleId)!,
        triggers: [
          {
            kind: 'triggered' as const,
            trigger: {
              when: 'dies' as const,
              subject: { kind: 'self' as const },
              condition: { kind: 'chosenOptionIs' as const, value: 'blue' },
            },
            targets: [],
            effects: [
              {
                op: 'conditionalEffect' as const,
                condition: { kind: 'chosenOptionIs' as const, value: 'blue' },
                then: [{ op: 'gainLife' as const, amount: { kind: 'const' as const, n: 7 } }],
                else: [{ op: 'gainLife' as const, amount: { kind: 'const' as const, n: 2 } }],
              },
            ],
          },
        ],
      };
      expect(validateCardDefinition(definition)).toEqual([]);
      ctx.defs.set(source.oracleId, definition);
      const response = conjure(
        ctx,
        'P1',
        oracle({
          name: 'Independent dying predicate response',
          typeLine: 'Sorcery',
          manaCost: '{0}',
          oracleText: 'You gain 1 life.',
        }),
        'hand',
      );
      const responseDef = {
        ...ctx.defs.get(response.oracleId)!,
        spellAbility: {
          kind: 'spell' as const,
          targets: [{ kind: 'creature' as const }],
          effects: [{ op: 'destroy' as const, target: 0 }],
        },
      };
      expect(validateCardDefinition(responseDef)).toEqual([]);
      ctx.defs.set(response.oracleId, responseDef);
      pump(
        applyPriorityAction(
          ctx,
          player,
          { kind: 'castSpell', objectId: response.id, fromCommand: false },
          { index: 0, targets: new Map([[0, source.id]]) },
        ),
      );
      pump(resolveTopOfStack(ctx));
      expect(ctx.state.pendingTriggers).toHaveLength(choice === 'blue' ? 1 : 0);
      pump(runPrioritySequence(ctx));
      expect(player.life).toBe(choice === 'blue' ? 47 : 40);
    },
  );
  for (const entry of cases)
    for (const move of ['live', 'destroy', 'blink'] as const)
      it(`${entry.name} uses original information after ${move}`, () => {
        const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
        ctx.state.currentTurnPlayer = 'P1';
        ctx.state.activePlayerIndex = 0;
        ctx.state.phase = 'precombatMain';
        ctx.state.turnNumber = 1;
        if (entry.combat) {
          ctx.state.phase = 'combat';
          ctx.state.players[1]!.life = 50;
        }
        const player = ctx.state.players[0]!;
        const source = spawn(ctx, 'P1', oracle({ name: 'Independent source predicate witness' }));
        Object.assign(source, entry.original);
        const definition = {
          ...ctx.defs.get(source.oracleId)!,
          activatedAbilities: [
            {
              costs: [],
              timing: 'any' as const,
              ability: {
                kind: 'activated' as const,
                targets: [],
                effects: [
                  {
                    op: 'conditionalEffect' as const,
                    condition: entry.condition,
                    then: [{ op: 'gainLife' as const, amount: { kind: 'const' as const, n: 7 } }],
                    else: [{ op: 'gainLife' as const, amount: { kind: 'const' as const, n: 2 } }],
                  },
                ],
              },
            },
          ],
        };
        expect(validateCardDefinition(definition)).toEqual([]);
        ctx.defs.set(source.oracleId, definition);
        pump(
          applyPriorityAction(
            ctx,
            player,
            { kind: 'activateAbility', objectId: source.id, index: 0 },
            { index: 0, targets: new Map() },
          ),
        );
        if (move !== 'live') {
          const response = conjure(
            ctx,
            'P1',
            oracle({
              name: 'Independent predicate response',
              typeLine: 'Instant',
              manaCost: '{0}',
              oracleText: 'You gain 1 life.',
            }),
            'hand',
          );
          const responseDef = {
            ...ctx.defs.get(response.oracleId)!,
            spellAbility: {
              kind: 'spell' as const,
              targets: [{ kind: 'creature' as const }],
              effects: [
                {
                  op: move === 'destroy' ? ('destroy' as const) : ('blinkTarget' as const),
                  target: 0,
                },
              ],
            },
          };
          expect(validateCardDefinition(responseDef)).toEqual([]);
          ctx.defs.set(response.oracleId, responseDef);
          pump(
            applyPriorityAction(
              ctx,
              player,
              { kind: 'castSpell', objectId: response.id, fromCommand: false },
              { index: 0, targets: new Map([[0, source.id]]) },
            ),
          );
          pump(resolveTopOfStack(ctx));
          const returning = ctx.state.battlefield.find((object) => object.cardId === source.cardId);
          if (move === 'blink') {
            expect(returning).toBeDefined();
            expect(returning!.id).not.toBe(source.id);
            Object.assign(returning!, entry.returning);
          } else expect(returning).toBeUndefined();
        }
        pump(runPrioritySequence(ctx));
        expect(player.life).toBe(40 + (entry.expected ? 7 : 2));
      });
});
