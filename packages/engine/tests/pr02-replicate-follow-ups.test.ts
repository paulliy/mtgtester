import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { manaCost } from '../src/cards/templates';
import type { PendingDecision } from '../src/decisions';
import { resolveTopOfStack } from '../src/stack/stack';
import { priorityCheckpoint } from '../src/sba/sba';
import { createGame } from '../src/state/game';
import { moveObject, playerById } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { addMana } from '../src/mana/pool';
import { copies, conjure, forest, gameConfig, oracle, pump, spawn } from './fixtures';

type CastPayload = Extract<PriorityActionPayload, { kind: 'castSpell' }>;

function setup(seed: string, count: number, countTargets: number) {
  const ctx = createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  const player = playerById(ctx, 'P1');
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  ctx.state.turnNumber = 3;
  const card = oracle({
    name: `Replicate Probe ${seed}`,
    typeLine: 'Instant',
    manaCost: '{X}',
    oracleText: 'You gain 1 life.',
  });
  const spell = conjure(ctx, 'P1', card, 'hand');
  const ability = {
    kind: 'spell' as const,
    effects: [],
    targets: [
      { kind: 'creature' as const },
      { kind: 'creature' as const, count: { min: 0, max: 3 } },
    ],
    modes: {
      minChoices: 1,
      maxChoices: 1,
      options: [
        {
          description: 'Track targets',
          targetSlots: [0, 1],
          effects: [{ op: 'gainLife' as const, amount: { kind: 'const' as const, n: 1 } }],
        },
        {
          description: 'Split damage',
          targetSlots: [0, 1],
          effects: [
            { op: 'dealDamage' as const, target: 0, amount: { kind: 'const' as const, n: 1 } },
            { op: 'dealDamageDivided' as const, targetSlot: 1, total: { kind: 'xValue' as const } },
          ],
        },
      ],
    },
  };
  const def = ctx.defs.get(spell.oracleId)!;
  ctx.defs.set(spell.oracleId, {
    ...def,
    optionalAdditionalCost: { mechanic: 'replicate', cost: manaCost('{1}'), repeatable: true },
    spellAbility: ability,
  });
  const names = [
    'Original target',
    'Count target A',
    'Count target B',
    'Count target C',
    'Count target D',
  ];
  const permanents = names.map((name) =>
    spawn(ctx, 'P2', oracle({ name, typeLine: 'Creature', power: '5', toughness: '5' })),
  );
  addMana(
    player,
    Array.from({ length: 5 }, () => ({ symbol: 'C' as const })),
  );
  const option = computePriorityOptions(ctx, player).find((candidate) => {
    const payload = candidate.payload as CastPayload;
    return (
      payload.kind === 'castSpell' &&
      payload.objectId === spell.id &&
      payload.modes?.[0] === (countTargets === 0 ? 0 : 1) &&
      payload.x === (countTargets === 0 ? 0 : 3) &&
      payload.optionalCostCount === count
    );
  });
  expect(option, `cast option with ${count} replicate payments`).toBeDefined();
  const castResult = pump(
    applyPriorityAction(ctx, player, option!.payload as CastPayload, {
      index: 0,
      targets: new Map([[0, permanents[0]!.id]]),
    }),
    (decision) => {
      if (decision.prompt.startsWith('Choose target ')) {
        const desired = countTargetsNames(countTargets).find((target) =>
          decision.options.some((entry) => entry.description.includes(target)),
        );
        if (desired !== undefined) {
          const index = decision.options.findIndex((entry) => entry.description.includes(desired));
          return { index, targets: new Map() };
        }
        const decline = decision.options.findIndex((entry) => entry.type === 'decline');
        return { index: decline, targets: new Map() };
      }
      // For divided damage, assigning one to each earlier target leaves the remainder to the last.
      return { index: 0, targets: new Map() };
    },
  );
  expect(castResult.value).toBeUndefined();
  const original = ctx.state.stack.find((entry) => entry.card?.cardId === spell.cardId)!;
  return { ctx, player, spell, original, permanents };
}

function countTargetsNames(count: number) {
  return ['Count target A', 'Count target B', 'Count target C'].slice(0, count);
}

function resolveReplicateTrigger(ctx: GameContext, answer?: (decision: PendingDecision) => number) {
  pump(priorityCheckpoint(ctx));
  expect(ctx.state.stack.at(-1)?.kind).toBe('triggeredAbility');
  return pump(resolveTopOfStack(ctx), (decision) => ({
    index: answer?.(decision) ?? 0,
    targets: new Map(),
  }));
}

function replicateCopies(ctx: ReturnType<typeof setup>['ctx']) {
  return ctx.state.stack.filter((entry) => entry.kind === 'spell' && entry.card === null);
}

describe('PR02 replicate choice-copy follow-ups', () => {
  it.each([0, 1, 2])(
    'retains a counted target slot with %i original targets on both copies',
    (count) => {
      const { ctx, original } = setup(`replicate-count-${count}`, 2, count);
      const originalCountTargets = [...(original.countTargets?.[1] ?? [])];
      const originalDivision = { ...(original.divisionAmounts ?? {}) };
      const originalAbility = original.ability;

      resolveReplicateTrigger(ctx);

      const copiesOnStack = replicateCopies(ctx);
      expect(copiesOnStack).toHaveLength(2);
      for (const copy of copiesOnStack) {
        expect(copy.countTargets?.[1]).toEqual(originalCountTargets);
        expect(copy.countTargets?.[1]).toHaveLength(count);
        expect(copy.divisionAmounts ?? {}).toEqual(originalDivision);
        expect(copy.ability).toEqual(originalAbility);
      }
      expect(copiesOnStack[0]!.countTargets![1]).not.toBe(copiesOnStack[1]!.countTargets![1]);
      expect(original.countTargets?.[1]).toEqual(originalCountTargets);
      expect(original.divisionAmounts ?? {}).toEqual(originalDivision);
    },
  );

  it('lets a copy keep one counted target and change another to a legal creature', () => {
    const { ctx, original, permanents } = setup('replicate-counted-retarget', 1, 2);
    const keep = original.countTargets![1]![1]!;
    const replacement = permanents[3]!.id;
    let changed = false;
    const originalDivision = { ...original.divisionAmounts };
    resolveReplicateTrigger(ctx, (decision) => {
      if (/copy 1 of 1.*slot 1.*target 1/i.test(decision.prompt)) {
        const index = decision.options.findIndex((entry) =>
          entry.description.includes('Count target C'),
        );
        if (index >= 0) {
          changed = true;
          return index;
        }
      }
      if (/copy 1 of 1.*slot 1.*target 2/i.test(decision.prompt)) {
        return decision.options.findIndex((entry) =>
          entry.description.includes('Keep Count target B'),
        );
      }
      return 0;
    });

    expect(changed).toBe(true);
    const copy = replicateCopies(ctx)[0]!;
    expect(copy.countTargets?.[1]).toEqual([replacement, keep]);
    expect(copy.divisionAmounts?.[replacement]).toBe(
      originalDivision[original.countTargets![1]![0]!],
    );
    expect(copy.divisionAmounts?.[keep]).toBe(originalDivision[keep]);
    expect(original.countTargets?.[1]).toEqual([permanents[1]!.id, permanents[2]!.id]);
  });

  it('retargets two copies independently and allows a final-set swap without duplicate targets', () => {
    const { ctx, original, permanents } = setup('replicate-two-copy-retarget', 2, 2);
    const originalTargets = [...original.countTargets![1]!];
    const prompts: string[] = [];
    let swapCandidateAvailable = false;
    resolveReplicateTrigger(ctx, (decision) => {
      prompts.push(decision.prompt);
      if (/copy 1 of 2.*slot 1.*target 1/i.test(decision.prompt)) {
        const swap = decision.options.findIndex(
          (entry) => entry.description === 'Target Count target B',
        );
        swapCandidateAvailable = swap >= 0;
        return swap;
      }
      if (/copy 1 of 2.*slot 1.*target 2/i.test(decision.prompt)) {
        return decision.options.findIndex((entry) => entry.description === 'Target Count target A');
      }
      if (/copy 2 of 2.*slot 1.*target 1/i.test(decision.prompt)) {
        return decision.options.findIndex((entry) => entry.description === 'Target Count target D');
      }
      if (/copy 2 of 2.*slot 1.*target 2/i.test(decision.prompt)) {
        return decision.options.findIndex((entry) => entry.description === 'Target Count target C');
      }
      return 0;
    });

    expect(prompts.some((prompt) => /copy 1 of 2.*slot 1.*target 1/i.test(prompt))).toBe(true);
    expect(prompts.some((prompt) => /copy 2 of 2.*slot 1.*target 1/i.test(prompt))).toBe(true);
    expect(swapCandidateAvailable).toBe(true);
    const copies = replicateCopies(ctx);
    expect(copies).toHaveLength(2);
    expect(copies[0]?.countTargets?.[1]).toEqual([originalTargets[1], originalTargets[0]]);
    expect(copies[1]?.countTargets?.[1]).toEqual([permanents[4]!.id, permanents[3]!.id]);
    expect(new Set(copies[0]!.countTargets![1]).size).toBe(2);
    expect(new Set(copies[1]!.countTargets![1]).size).toBe(2);
    expect(copies[0]!.countTargets![1]).not.toBe(copies[1]!.countTargets![1]);
    expect(original.countTargets?.[1]).toEqual(originalTargets);
  });

  it('copies the announced mode, X, counted targets, and division from the cast snapshot after the original leaves', () => {
    const { ctx, original, permanents } = setup('replicate-last-known-copy', 1, 2);
    const originalId = original.id;
    const expectedAbility = original.ability;
    const expectedCounts = structuredClone(original.countTargets);
    const expectedDivision = structuredClone(original.divisionAmounts);
    expect(original.announcedX).toBe(3);
    expect(original.optionalCostCounts?.replicate).toBe(1);
    expect(original.ability?.effects).toEqual([
      { op: 'dealDamage', target: 0, amount: { kind: 'const', n: 1 } },
      { op: 'dealDamageDivided', targetSlot: 1, total: { kind: 'xValue' } },
    ]);
    expect(original.divisionAmounts).toBeDefined();
    expect(original.countTargets?.[1]).toHaveLength(2);
    ctx.state.stack.splice(
      ctx.state.stack.findIndex((entry) => entry.id === originalId),
      1,
    );

    resolveReplicateTrigger(ctx, (decision) => {
      const keepIndex = decision.options.findIndex((entry) =>
        entry.description.startsWith('Keep '),
      );
      return keepIndex >= 0 ? keepIndex : 0;
    });

    const copy = replicateCopies(ctx)[0]!;
    expect(copy.announcedX).toBe(3);
    expect(copy.optionalCostCounts?.replicate).toBe(1);
    expect(copy.ability).toEqual(expectedAbility);
    expect(copy.countTargets).toEqual(expectedCounts);
    expect(copy.divisionAmounts ?? {}).toEqual(expectedDivision ?? {});
    expect(copy.targets).toEqual([permanents[0]!.id]);
  });

  it('allows a copy to keep an unchanged target that became illegal', () => {
    const { ctx, original, permanents } = setup('replicate-illegal-keep', 1, 0);
    const departed = permanents[0]!;
    pump(moveObject(ctx, departed, { zone: 'graveyard' }));
    let sawKeep = false;
    resolveReplicateTrigger(ctx, (decision) => {
      if (!decision.prompt.includes('choose a target for copy 1 of 1')) return 0;
      sawKeep ||= decision.options.some((entry) =>
        entry.description.includes('Keep Original target'),
      );
      return decision.options.findIndex((entry) =>
        entry.description.includes('Keep Original target'),
      );
    });

    expect(sawKeep).toBe(true);
    expect(replicateCopies(ctx)[0]?.targets[0]).toBe(departed.id);
    expect(original.targets[0]).toBe(departed.id);
  });

  it('resolves legal members of a counted copy target group and skips members that became illegal', () => {
    const { ctx, original, permanents } = setup('replicate-counted-fizzle-subset', 1, 2);
    resolveReplicateTrigger(ctx);
    const copy = replicateCopies(ctx)[0]!;
    const illegal = permanents[1]!;
    const legal = permanents[2]!;
    pump(moveObject(ctx, illegal, { zone: 'graveyard' }));
    const health = legal.damageMarked;
    pump(resolveTopOfStack(ctx));

    expect(legal.damageMarked).toBe(health + (copy.divisionAmounts?.[legal.id] ?? 0));
    expect(ctx.state.battlefield.some((entry) => entry.id === illegal.id)).toBe(false);
    expect(original.countTargets?.[1]).toEqual([permanents[1]!.id, permanents[2]!.id]);
  });

  it('fizzles a copy when its only ordinary target is illegal at resolution', () => {
    const { ctx, original, permanents } = setup('replicate-single-target-fizzle', 1, 0);
    resolveReplicateTrigger(ctx);
    const copy = replicateCopies(ctx)[0]!;
    pump(moveObject(ctx, permanents[0]!, { zone: 'graveyard' }));
    const life = playerById(ctx, 'P2').life;
    pump(resolveTopOfStack(ctx));

    expect(copy.targets[0]).toBe(permanents[0]!.id);
    expect(playerById(ctx, 'P2').life).toBe(life);
    expect(ctx.state.eventLog.some((event) => event.type === 'fizzle')).toBe(true);
    expect(original.targets[0]).toBe(permanents[0]!.id);
  });
});
