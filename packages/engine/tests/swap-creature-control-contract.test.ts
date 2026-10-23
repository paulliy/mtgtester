/**
 * Generic contract for the narrow `swapCreatureControlUntilEot` effect primitive.
 *
 * Independent of any one card: the fixture is an ordinary zero-cost instant that names an
 * ordinary player target, so the primitive is proven to be caster <-> *targeted player* rather
 * than caster <-> a hard-coded opponent, and proven to reject a target whose domain is not a
 * player.
 */
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import type { TargetSpec } from '../src/cards/definition';
import { computeCharacteristics } from '../src/effects/continuous';
import { endUntilEotEffects } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { controlledBy, playerById } from '../src/state/objects';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, forest, gameConfig, oracle, pump, registerDef, spawn } from './fixtures';

const PROBE = () =>
  oracle({
    name: 'Independent swap probe',
    typeLine: 'Instant',
    manaCost: '{0}',
    oracleText: 'You gain 1 life.',
  });

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 5;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

/** Register the probe card and return a definition whose only content is the primitive. */
function probeDefinition(ctx: GameContext, targets: TargetSpec[], target: number) {
  const base = registerDef(ctx, PROBE());
  return {
    ...base,
    spellAbility: {
      kind: 'spell' as const,
      targets,
      effects: [{ op: 'swapCreatureControlUntilEot' as const, target }],
      description: 'Swap the two players’ creatures',
    },
  };
}

function tappedBear(ctx: GameContext, controllerId: string, name: string): EnginePermanent {
  return spawn(
    ctx,
    controllerId,
    oracle({ name, typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
    { tapped: true },
  );
}

const haste = (ctx: GameContext, perm: EnginePermanent): boolean =>
  computeCharacteristics(ctx, perm).keywords.includes('haste');

/** Cast the probe through the real menu for its printed cost of {0}. */
function castProbe(ctx: GameContext, targets: TargetSpec[], target: number, chosen: string): void {
  const card = conjure(ctx, 'P1', PROBE(), 'hand');
  ctx.defs.set(card.oracleId, probeDefinition(ctx, targets, target));
  const option = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((entry) => {
    const payload = entry.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === card.id;
  });
  expect(option, 'normal zero-cost cast offered').toBeDefined();
  pump(
    applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map([[0, chosen]]),
    }),
  );
  expect(ctx.state.stack).toHaveLength(1);
  expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
  pump(runPrioritySequence(ctx), (decision) => ({
    index: Math.max(
      0,
      decision.options.findIndex((entry) => entry.type === 'pass'),
    ),
    targets: new Map(),
  }));
  expect(ctx.state.stack).toHaveLength(0);
}

describe('swapCreatureControlUntilEot is an ordinary player-target primitive', () => {
  it('swap-contract-player-slot-is-the-only-legal-reference — an ordinary player slot validates clean', () => {
    const ctx = pod('swap-contract-valid');
    expect(validateCardDefinition(probeDefinition(ctx, [{ kind: 'player' }], 0))).toEqual([]);
  });

  it.each([
    ['a-creature-slot', [{ kind: 'creature' } as TargetSpec], 0],
    ['a-slot-past-the-target-list', [{ kind: 'player' } as TargetSpec], 3],
    ['no-target-list-at-all', [] as TargetSpec[], 0],
  ])(
    'swap-contract-rejects-%s — a non-player or out-of-range target slot fails authoring validation',
    (_label, targets, target) => {
      const ctx = pod(`swap-contract-invalid-${_label}`);
      const issues = validateCardDefinition(probeDefinition(ctx, targets, target));
      expect(issues.map((issue) => issue.path)).toContain(
        'definition.spellAbility.effects[0].target',
      );
    },
  );

  it('swap-contract-caster-and-named-player-swap-only-those-two-groups — a normal cast swaps caster and the named player, leaving every other seat alone', () => {
    const ctx = pod('swap-contract-generic');
    const mine = tappedBear(ctx, 'P1', 'Contract Caster Bear');
    const named = tappedBear(ctx, 'P3', 'Contract Named Bear');
    const namedSecond = tappedBear(ctx, 'P3', 'Contract Named Second Bear');
    const bystander = tappedBear(ctx, 'P2', 'Contract Bystander Bear');

    castProbe(ctx, [{ kind: 'player' }], 0, 'P3');

    expect(controlledBy(mine)).toBe('P3');
    expect(controlledBy(named)).toBe('P1');
    expect(controlledBy(namedSecond)).toBe('P1');
    // The bystander opponent is neither the caster nor the named player.
    expect(controlledBy(bystander)).toBe('P2');
    expect(bystander.tapped).toBe(true);
    expect(haste(ctx, bystander)).toBe(false);

    for (const perm of [mine, named, namedSecond]) {
      expect(perm.tapped).toBe(false);
      expect(haste(ctx, perm)).toBe(true);
      expect(perm.controlChanges?.at(-1)?.duration.kind).toBe('untilEndOfTurn');
    }
    endUntilEotEffects(ctx);
    expect(controlledBy(mine)).toBe('P1');
    expect(controlledBy(named)).toBe('P3');
    expect(controlledBy(namedSecond)).toBe('P3');
    for (const perm of [mine, named, namedSecond]) {
      expect(perm.tapped).toBe(false);
      expect(haste(ctx, perm)).toBe(false);
    }
  });
});
