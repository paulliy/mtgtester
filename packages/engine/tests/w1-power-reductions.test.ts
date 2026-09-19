import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import {
  costReductionFor,
  computePriorityOptions,
  type PriorityActionPayload,
} from '../src/actions/legal';
import { applyPriorityAction } from '../src/actions/apply';
import { computeCharacteristics } from '../src/effects/continuous';
import { createGame } from '../src/state/game';
import { queueTriggersForEvent } from '../src/state/objects';
import { runPrioritySequence } from '../src/turn/priority';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';
const cards = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../server/fixtures/coverage-oracle.json'), 'utf8'),
) as OracleCard[];
function real(name: string) {
  return cards.find((c) => c.name === name)!;
}
function pod() {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(4, forest) })),
      { seed: 'w1-power' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}
it.each(['Ghalta, Primal Hunger', 'Goreclaw, Terror of Qal Sisma'])(
  'interprets all of %s',
  (name) => {
    const def = interpretCard(real(name));
    expect(def.unmodeledReasons).toEqual([]);
    expect(def.modeled).toBe(true);
  },
);
describe('power-based spell reductions', () => {
  it('Ghalta counts current friendly power, preserves colored pips, and pays the resulting cost', () => {
    const ctx = pod();
    const player = ctx.state.players.find((p) => p.id === 'P1')!;
    const card = conjure(ctx, 'P1', real('Ghalta, Primal Hunger'), 'hand');
    const first = spawn(ctx, 'P1', forest());
    const creature = spawn(ctx, 'P1', oracle({ name: 'Large Friend', power: '8', toughness: '8' }));
    spawn(ctx, 'P2', oracle({ name: 'Huge Opponent', power: '20', toughness: '20' }));
    const reduction = () => costReductionFor(ctx, 'P1', card.oracleId, card.cardId).generic;
    expect(reduction()).toBe(8);
    creature.counters['+1/+1'] = 2;
    expect(reduction()).toBe(10);
    const cast = () =>
      computePriorityOptions(ctx, player).find(
        (o) => (o.payload as PriorityActionPayload).kind === 'castSpell',
      );
    expect(cast()).toBeUndefined();
    const second = spawn(ctx, 'P1', forest());
    const option = cast();
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(first.tapped && second.tapped).toBe(true);
    expect(ctx.state.stack).toHaveLength(1);
  });
  it('sums negative power before clamping the reduction to zero', () => {
    const ctx = pod();
    const card = conjure(ctx, 'P1', real('Ghalta, Primal Hunger'), 'hand');
    spawn(ctx, 'P1', oracle({ name: 'Negative Power', power: '-3', toughness: '4' }));
    const positive = spawn(
      ctx,
      'P1',
      oracle({ name: 'Positive Power', power: '4', toughness: '4' }),
    );
    const reduction = () => costReductionFor(ctx, 'P1', card.oracleId, card.cardId).generic;
    expect(reduction()).toBe(1);
    positive.power = 1;
    expect(reduction()).toBe(0);
  });
  it('Goreclaw reduces qualifying creature spells only, for its controller', () => {
    const ctx = pod();
    spawn(ctx, 'P1', real('Goreclaw, Terror of Qal Sisma'));
    const low = conjure(
      ctx,
      'P1',
      oracle({ name: 'Small Spell', power: '3', toughness: '3' }),
      'hand',
    );
    const high = conjure(
      ctx,
      'P1',
      oracle({ name: 'Large Spell', power: '4', toughness: '4' }),
      'hand',
    );
    const opponent = conjure(
      ctx,
      'P2',
      oracle({ name: 'Opponent Spell', power: '5', toughness: '5' }),
      'hand',
    );
    expect(costReductionFor(ctx, 'P1', low.oracleId, low.cardId).generic).toBe(0);
    expect(costReductionFor(ctx, 'P1', high.oracleId, high.cardId).generic).toBe(2);
    expect(costReductionFor(ctx, 'P2', opponent.oracleId, opponent.cardId).generic).toBe(0);
  });
  it('Goreclaw checks current power when its attack trigger resolves', () => {
    const ctx = pod();
    const source = spawn(ctx, 'P1', real('Goreclaw, Terror of Qal Sisma'));
    const eligible = spawn(ctx, 'P1', bear());
    eligible.counters['+1/+1'] = 2;
    const small = spawn(ctx, 'P1', bear());
    const opponent = spawn(ctx, 'P2', oracle({ name: 'Opponent', power: '4', toughness: '4' }));
    source.attacking = 'P2';
    queueTriggersForEvent(ctx, 'attacks', [{ permanent: source, playerId: 'P2' }]);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(runPrioritySequence(ctx));
    expect(computeCharacteristics(ctx, source).power).toBe(5);
    expect(computeCharacteristics(ctx, eligible).power).toBe(5);
    expect(computeCharacteristics(ctx, eligible).keywords).toContain('trample');
    expect(computeCharacteristics(ctx, small).power).toBe(2);
    expect(computeCharacteristics(ctx, opponent).power).toBe(4);
  });
});
