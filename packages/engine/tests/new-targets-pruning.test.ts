import { describe, expect, it } from 'vitest';
import type { Ability, TargetSpec } from '../src/cards/ability';
import { chooseNewTargets } from '../src/stack/replicate-targets';
import { pump, spawn } from './fixtures';
import { bear, pod } from './pr10-helpers';
import { script } from './script';

const source = { traits: { colors: [], types: [] }, kind: 'spell' as const };

function request(
  ctx: ReturnType<typeof pod>,
  ability: Ability,
  targets: string[],
  counted: Record<number, string[]> = {},
) {
  return chooseNewTargets(ctx, 'P1', {
    name: 'Test Spell',
    subject: 'the copy',
    ability,
    source,
    sourceCardId: 'test-spell',
    originalTargets: targets,
    originalCounted: counted,
    originalDivision: {},
  });
}

const spell = (targets: TargetSpec[]): Ability => ({ kind: 'spell', targets, effects: [] });

describe('chooseNewTargets legality pruning', () => {
  it('new-targets-scale-counted-you-control — 8 counted targets amid 60 foreign permanents finish fast and offer only your own', () => {
    const ctx = pod('new-targets-scale');
    const mine = Array.from({ length: 12 }, (_, i) => spawn(ctx, 'P1', bear(`Mine ${i}`)));
    for (let i = 0; i < 60; i++) spawn(ctx, 'P2', bear(`Theirs ${i}`));
    const ability = spell([
      { kind: 'nonlandPermanent', controller: 'you', count: { min: 0, max: 20 } },
    ]);
    const originals = mine.slice(0, 8).map((perm) => perm.id);
    const steps = originals.map((_, i) => ({
      prompt: `target ${i + 1}.`,
      choose: `Keep Mine ${i} as the target`,
    }));
    const started = performance.now();
    const { value, decisions } = pump(request(ctx, ability, [], { 0: originals }), script(steps));
    expect(performance.now() - started).toBeLessThan(3000);
    expect(value.countTargets[0]).toEqual(originals);
    for (const [i, decision] of decisions.entries()) {
      const names = decision.options.map((option) => option.description);
      expect(names.some((n) => n.includes('Theirs'))).toBe(false);
      // Keep, plus each of your other permanents not already used by an earlier position.
      expect(names).toHaveLength(12 - i);
    }
  });

  it('new-targets-different-from-slot-still-rejected — a slot cannot change to the object it must differ from', () => {
    const ctx = pod('new-targets-different');
    const a = spawn(ctx, 'P1', bear('Alpha'));
    const b = spawn(ctx, 'P1', bear('Bravo'));
    spawn(ctx, 'P1', bear('Charlie'));
    const ability = spell([{ kind: 'creature' }, { kind: 'creature', differentFromSlots: [0] }]);
    const { value, decisions } = pump(
      request(ctx, ability, [a.id, b.id]),
      script([
        { prompt: 'slot 0', choose: 'Keep Alpha' },
        { prompt: 'slot 1', choose: 'Keep Bravo' },
      ]),
    );
    expect(value.targets).toEqual([a.id, b.id]);
    const second = decisions[1]!.options.map((option) => option.description);
    expect(second).toEqual(['Keep Bravo as the target', 'Target Charlie']);
  });

  it('new-targets-unchanged-illegal-may-stay — CR 115.7d keeps an illegal original but offers only legal changes', () => {
    const ctx = pod('new-targets-115-7d');
    const theirs = spawn(ctx, 'P2', bear('Foreign'));
    spawn(ctx, 'P2', bear('Foreign Two'));
    spawn(ctx, 'P1', bear('Domestic'));
    const ability = spell([{ kind: 'creature', controller: 'you' }]);
    const { value, decisions } = pump(
      request(ctx, ability, [theirs.id]),
      script([{ prompt: 'choose a target', choose: 'Keep Foreign as the target' }]),
    );
    expect(value.targets).toEqual([theirs.id]);
    expect(decisions[0]!.options.map((option) => option.description)).toEqual([
      'Keep Foreign as the target',
      'Target Domestic',
    ]);
  });
});
