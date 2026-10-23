import { describe, expect, it } from 'vitest';
import { computeCharacteristics } from '../src/effects/continuous';
import { applyCopy } from '../src/state/objects';
import { resolveTopOfStack } from '../src/stack/stack';
import type { GameContext } from '../src/state/types';
import { pump, spawn } from './fixtures';
import { bear, castFromHand, choose, pinned, pinnedDefinition, pod } from './pr10-helpers';

const doppelganger = pinned('Mocking Doppelganger');

/** P1 casts Mocking Doppelganger and answers the as-enters copy choice with `answer`. */
function castDoppelganger(ctx: GameContext, answer: RegExp) {
  castFromHand(ctx, 'P1', doppelganger);
  let offered: string[] = [];
  pump(resolveTopOfStack(ctx), (decision) => {
    offered = decision.options.map((option) => option.description);
    return choose(answer)(decision);
  });
  const entered = ctx.state.battlefield.find(
    (permanent) => permanent.controllerId === 'P1' && permanent.copyOriginal !== undefined,
  );
  return { offered, entered };
}

const goadersOf = (ctx: GameContext, id: string) => {
  const permanent = ctx.state.battlefield.find((candidate) => candidate.id === id)!;
  return computeCharacteristics(ctx, permanent).staticGoadedBy ?? [];
};

describe('PR10.22 Mocking Doppelganger', () => {
  it('pr10-mocking-doppelganger-pinned-oracle-supported — both lines are modeled', () => {
    const def = pinnedDefinition('Mocking Doppelganger');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
    expect(def.keywords).toContain('flash');
    expect(def.entersAsCopy).toBeDefined();
  });

  it("pr10-mocking-doppelganger-opponents-only — only an opponent's creature is offered", () => {
    const ctx = pod('pr10-doppel-offer');
    spawn(ctx, 'P1', bear('Doppel Ally'));
    spawn(ctx, 'P2', bear('Doppel Foe'));
    const { offered } = castDoppelganger(ctx, /Doppel Foe/);
    expect(offered.some((description) => description.includes('Doppel Foe'))).toBe(true);
    expect(offered.some((description) => description.includes('Doppel Ally'))).toBe(false);
  });

  it('pr10-mocking-doppelganger-copy — it enters as a copy of the chosen creature', () => {
    const ctx = pod('pr10-doppel-copy');
    spawn(ctx, 'P2', bear('Doppel Foe', { power: '3', toughness: '4' }));
    const { entered } = castDoppelganger(ctx, /Doppel Foe/);
    expect(entered?.name).toBe('Doppel Foe');
    const chars = computeCharacteristics(ctx, entered!);
    expect([chars.power, chars.toughness]).toEqual([3, 4]);
  });

  it('pr10-mocking-doppelganger-goads-same-name — other creatures with its name are goaded by P1', () => {
    const ctx = pod('pr10-doppel-goad');
    const original = spawn(ctx, 'P2', bear('Doppel Foe'));
    const sameNameElsewhere = spawn(ctx, 'P3', bear('Doppel Foe'));
    const other = spawn(ctx, 'P2', bear('Doppel Bystander'));
    const { entered } = castDoppelganger(ctx, /Doppel Foe/);
    expect(goadersOf(ctx, original.id)).toEqual(['P1']);
    expect(goadersOf(ctx, sameNameElsewhere.id)).toEqual(['P1']);
    expect(goadersOf(ctx, other.id)).toEqual([]);
    // "Other": the Doppelganger does not goad itself.
    expect(goadersOf(ctx, entered!.id)).toEqual([]);
  });

  it('pr10-mocking-doppelganger-decline — entering normally goads nothing', () => {
    const ctx = pod('pr10-doppel-decline');
    const foe = spawn(ctx, 'P2', bear('Doppel Foe'));
    castFromHand(ctx, 'P1', doppelganger);
    pump(resolveTopOfStack(ctx), choose(/Enter normally/));
    const entered = ctx.state.battlefield.find(
      (permanent) => permanent.name === 'Mocking Doppelganger',
    );
    expect(entered).toBeDefined();
    expect(computeCharacteristics(ctx, entered!).power).toBe(0);
    expect(goadersOf(ctx, foe.id)).toEqual([]);
  });

  it('pr10-mocking-doppelganger-copiable-exception — a copy of the copy has the goad ability too', () => {
    const ctx = pod('pr10-doppel-copy-of-copy');
    const foe = spawn(ctx, 'P2', bear('Doppel Foe'));
    const { entered } = castDoppelganger(ctx, /Doppel Foe/);
    // P3's clone copies the Doppelganger: the exception is part of its copiable values (CR 707.9b).
    const clone = spawn(ctx, 'P3', bear('Doppel Clone'));
    applyCopy(ctx, clone, entered!);
    expect(clone.name).toBe('Doppel Foe');
    expect(goadersOf(ctx, foe.id).sort()).toEqual(['P1', 'P3']);
    expect(goadersOf(ctx, entered!.id)).toEqual(['P3']);
    expect(goadersOf(ctx, clone.id)).toEqual(['P1']);
  });
});
