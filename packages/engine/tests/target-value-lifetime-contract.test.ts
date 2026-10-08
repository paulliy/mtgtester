import { describe, expect, it } from 'vitest';
import type { Effect } from '../src/cards/ability';
import type { Value } from '../src/cards/value';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { createGame } from '../src/state/game';
import { applyPriorityAction } from '../src/actions/apply';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const values: { name: string; value: Value; leaving: number; returning: number }[] = [
  { name: 'power', value: { kind: 'powerOfTarget', target: 0 }, leaving: 7, returning: 2 },
  {
    name: 'counters',
    value: { kind: 'countersOnTarget', target: 0, counter: 'charge' },
    leaving: 7,
    returning: 0,
  },
  { name: 'mana value', value: { kind: 'manaValueOfTarget', target: 0 }, leaving: 2, returning: 2 },
];
const moves: Effect[] = [
  { op: 'destroy', target: 0 },
  { op: 'exile', target: 0 },
  { op: 'returnToHand', target: 0 },
  { op: 'blinkTarget', target: 0 },
];
describe('ordinary target information across this resolution zone changes', () => {
  for (const entry of values)
    for (const move of moves) {
      it(`${entry.name} after ${move.op} distinguishes information from object tracking`, () => {
        const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
        ctx.state.currentTurnPlayer = 'P1';
        ctx.state.activePlayerIndex = 0;
        ctx.state.phase = 'precombatMain';
        const player = ctx.state.players[0]!;
        const target = spawn(
          ctx,
          'P2',
          oracle({
            name: 'Independent lifetime value witness',
            typeLine: 'Creature — Witness',
            manaCost: '{1}{G}',
            cmc: 2,
          }),
        );
        target.counters = { charge: 2 };
        const card = conjure(
          ctx,
          'P1',
          oracle({
            name: 'Independent ordered target information',
            typeLine: 'Sorcery',
            manaCost: '{0}',
            oracleText: 'You gain 1 life.',
          }),
          'hand',
        );
        const definition = {
          ...ctx.defs.get(card.oracleId)!,
          spellAbility: {
            kind: 'spell' as const,
            targets: [{ kind: 'creature' as const }],
            effects: [
              { op: 'pumpUntilEot' as const, target: 0, power: 5, toughness: 5 },
              { op: 'putCounters' as const, target: 0, counter: 'charge', count: 5 },
              move,
              { op: 'gainLife' as const, amount: entry.value },
            ],
          },
        };
        expect(validateCardDefinition(definition)).toEqual([]);
        ctx.defs.set(card.oracleId, definition);
        pump(
          applyPriorityAction(
            ctx,
            player,
            { kind: 'castSpell', objectId: card.id, fromCommand: false },
            { index: 0, targets: new Map([[0, target.id]]) },
          ),
        );
        pump(runPrioritySequence(ctx));
        expect(player.life).toBe(
          40 + (move.op === 'blinkTarget' ? entry.returning : entry.leaving),
        );
        const live = ctx.state.battlefield.find((object) => object.cardId === target.cardId);
        if (move.op === 'blinkTarget') {
          expect(live).toBeDefined();
          expect(live!.id).not.toBe(target.id);
        } else expect(live).toBeUndefined();
        if (move.op === 'returnToHand')
          expect(ctx.state.players[1]!.hand.some((object) => object.cardId === target.cardId)).toBe(
            true,
          );
      });
    }
});
