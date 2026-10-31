/**
 * A copy of a permanent spell becomes a token as it resolves (CR 608.3f, 707.10f). It copies the
 * choices made for the spell, kicker counts among them (CR 707.10), and enters the battlefield as
 * any permanent does, so its own entry replacements apply (CR 614.1c). Cosmic Crucible copies.
 */
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { addMana } from '../src/mana/pool';
import { priorityCheckpoint } from '../src/sba/sba';
import { resolveTopOfStack } from '../src/stack/stack';
import type { GameContext } from '../src/state/types';
import { conjure, forest, pump, spawn } from './fixtures';
import { castFromHand, choose, p, pinned, pod } from './pr10-helpers';
import { pinStore } from './scenario/pin-store';

/** Resolve the stack, answering Crucible's copy and any discard as `answer` says. */
function resolveAll(ctx: GameContext, answer: (decision: PendingDecision) => DecisionOutcome) {
  for (let guard = 0; guard < 50; guard++) {
    pump(priorityCheckpoint(ctx), answer, { strict: true });
    if (ctx.state.stack.length === 0) return;
    pump(resolveTopOfStack(ctx), answer, { strict: true });
  }
  throw new Error('stack did not settle');
}

const named = (ctx: GameContext, name: string) =>
  ctx.state.battlefield.filter((perm) => perm.name === name);

describe('a resolving copy of a permanent spell enters as a permanent', () => {
  it("permanent-spell-copy-mox-diamond — a copy of Mox Diamond needs its own land to discard, or it doesn't enter", () => {
    const ctx = pod('copy-diamond-none');
    spawn(ctx, 'P1', pinned('Cosmic Crucible'));
    castFromHand(ctx, 'P1', pinStore.get('Mox Diamond'));
    resolveAll(ctx, (decision) => {
      if (/Copy/.test(decision.options.map((option) => option.description).join('|')))
        return choose('Copy Mox Diamond')(decision);
      return choose('Discard nothing')(decision);
    });
    // Neither the copy nor the original had a land to discard: with nothing to choose, neither asks.
    expect(named(ctx, 'Mox Diamond')).toEqual([]);
  });

  it('permanent-spell-copy-mox-diamond-pays — a copy that discards a land enters as a token', () => {
    const ctx = pod('copy-diamond-one');
    spawn(ctx, 'P1', pinned('Cosmic Crucible'));
    conjure(ctx, 'P1', forest(), 'hand');
    castFromHand(ctx, 'P1', pinStore.get('Mox Diamond'));
    resolveAll(ctx, (decision) => {
      const options = decision.options.map((option) => option.description).join('|');
      if (/Copy/.test(options)) return choose('Copy Mox Diamond')(decision);
      // The copy resolves first and takes the one Forest; the original then has none.
      return choose(/Forest/.test(options) ? 'Forest' : 'Discard nothing')(decision);
    });
    expect(named(ctx, 'Mox Diamond').map((perm) => perm.isToken)).toEqual([true]);
    expect(
      p(ctx, 'P1')
        .graveyard.map((card) => card.name)
        .sort(),
    ).toEqual(['Forest', 'Mox Diamond']);
  });

  it('permanent-spell-copy-kicked-chalice — a copy of a twice-kicked Chalice enters with two counters', () => {
    const ctx = pod('copy-chalice');
    spawn(ctx, 'P1', pinned('Cosmic Crucible'));
    const chalice = conjure(ctx, 'P1', pinStore.get('Everflowing Chalice'), 'hand');
    addMana(p(ctx, 'P1'), [{ symbol: 'C' }, { symbol: 'C' }, { symbol: 'C' }, { symbol: 'C' }]);
    const kickedTwice = computePriorityOptions(ctx, p(ctx, 'P1')).find((option) => {
      const payload = option.payload as PriorityActionPayload & {
        objectId?: string;
        optionalCostCount?: number;
      };
      return payload.objectId === chalice.id && payload.optionalCostCount === 2;
    })!;
    pump(
      applyPriorityAction(ctx, p(ctx, 'P1'), kickedTwice.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
      undefined,
      { strict: true },
    );
    resolveAll(ctx, choose('Copy Everflowing Chalice'));
    const chalices = named(ctx, 'Everflowing Chalice');
    expect(chalices.map((perm) => [perm.isToken, perm.counters['charge']]).sort()).toEqual([
      [false, 2],
      [true, 2],
    ]);
  });
});
