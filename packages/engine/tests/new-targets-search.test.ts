/**
 * "You may choose new targets for the copy" (CR 115.7d) over a spell with many counted targets.
 * Each new target must be legal, so a permanent the spell can't target is never offered, and the
 * search that proves a completion exists must not walk every assignment behind an illegal pick.
 */
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { chooseNewTargets } from '../src/stack/replicate-targets';
import { targetingFromDefinition } from '../src/state/queries';
import { pump, spawn } from './fixtures';
import { bear, choose, pod } from './pr10-helpers';
import { pinned } from './pr11-helpers';

/** P1's copy of Clever Concealment aimed at six of P1's eight permanents; P2 has thirty. */
function concealmentCopy(seed: string) {
  const ctx = pod(seed);
  const mine = Array.from({ length: 8 }, (_, i) => spawn(ctx, 'P1', bear(`Mine ${i + 1}`)));
  for (let i = 0; i < 30; i++) spawn(ctx, 'P2', bear(`Theirs ${i + 1}`));
  const def = interpretCard(pinned('Clever Concealment'));
  const ability = def.spellAbility!;
  const targeted = mine.slice(0, 6).map((perm) => perm.id);
  const search = chooseNewTargets(ctx, 'P1', {
    name: 'Clever Concealment',
    subject: 'copy 1 of 1',
    ability,
    source: targetingFromDefinition(def, 'spell'),
    sourceCardId: '',
    originalTargets: [],
    originalCounted: { 0: targeted },
    originalDivision: {},
  });
  return { ctx, mine, ability, targeted, search };
}

describe('choosing new targets for a copy with many counted targets', () => {
  it('the copied spell targets nonland permanents its controller controls, any number of them', () => {
    const { ability } = concealmentCopy('new-targets-shape');
    expect(ability.targets).toHaveLength(1);
    expect(ability.targets[0]).toMatchObject({ kind: 'permanent' });
    // "you control" lives in the filter, which reads no other target: the search may prune on it.
    expect(JSON.stringify(ability.targets[0]!.filter)).toContain('"who":"you"');
    expect(ability.targets[0]).not.toHaveProperty('differentFromSlots');
    expect(ability.targets[0]!.count).toBeDefined();
  });

  it("offers only the controller's own permanents, and finishes", () => {
    const { search, targeted } = concealmentCopy('new-targets-own-only');
    const began = performance.now();
    const { value, decisions } = pump(search, choose(/^Keep /));
    expect(performance.now() - began).toBeLessThan(5_000);
    expect(decisions).toHaveLength(6);
    for (const decision of decisions) {
      const names = decision.options.map((option) => option.description).join(' | ');
      expect(names).not.toContain('Theirs');
      expect(names).toContain('Mine 7');
    }
    expect(value.countTargets).toEqual({ 0: targeted });
  });

  it('a target may change to another permanent the controller controls', () => {
    const { search, mine } = concealmentCopy('new-targets-change');
    const { value } = pump(search, (decision, count) =>
      count === 1 ? choose('Target Mine 7')(decision) : choose(/^Keep /)(decision),
    );
    expect(value.countTargets[0]).toEqual([
      mine[6]!.id,
      ...mine.slice(1, 6).map((perm) => perm.id),
    ]);
  });
});
