/**
 * Known engine gaps as IR shapes (`scripts/card-compiler/known-gaps.ts`, issue #95): each detector
 * still matches the retired cards it was written from, the compiler refuses a patch that uses an
 * open gap, and no promoted compiled card uses one unless it is listed below with a reason.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CardDefinition } from '../../../engine/src/cards/definition';
import { compiledCards } from '../../../engine/src/cards/overrides/compiled/register';
import { DETECTORS, knownGapIssues, knownGaps } from '../../../../scripts/card-compiler/known-gaps';
import { compileTarget, pinnedPool } from '../../../../scripts/card-compiler/lib';

const root = resolve(import.meta.dirname, '../../../..');
const pinned = new Map(pinnedPool().map((row) => [row.card.name, row]));

/** Every trial patch file, by card name (a later chunk's file wins, as in the sweep). */
function trialPatches(): Map<string, { def: Partial<CardDefinition>; handledLines: string[] }> {
  const patches = new Map<string, { def: Partial<CardDefinition>; handledLines: string[] }>();
  const reviews = resolve(root, 'docs/reviews');
  for (const dir of readdirSync(reviews).filter((d) => d.startsWith('card-compiler-trial'))) {
    let files: string[] = [];
    try {
      files = readdirSync(resolve(reviews, dir, 'patches'));
    } catch {
      continue;
    }
    for (const file of files.filter((f) => f.endsWith('.json'))) {
      const patch = JSON.parse(readFileSync(resolve(reviews, dir, 'patches', file), 'utf8')) as {
        name?: string;
        def: Partial<CardDefinition>;
        handledLines: string[];
      };
      if (patch.name !== undefined) patches.set(patch.name, patch);
    }
  }
  return patches;
}

/**
 * Promoted cards that match an open detector and were kept on review, with the reason. A new
 * entry needs the owner's decision; remove one when its card is retired or its gap closes.
 */
const KEPT: Record<string, string> = {
  'Avacyn, Angel of Horror': 'end-step delayed trigger: wrong only if created during an end step',
  'Ideas Unbound': 'end-step delayed trigger: wrong only if cast during an end step',
  'Honor-Worn Shaku': 'owner backlog (#95 section 5): self-eligible cost, pending review',
  'Castle Doom': 'owner backlog (#95 section 5): self-eligible cost, pending review',
  'Slobad, Goblin Tinkerer': 'owner backlog (#95 section 5): self-eligible cost, pending review',
  'Hearthhull, the Worldseed': 'owner backlog (#95 section 5): self-eligible cost, pending review',
  'Jinxed Idol': 'owner backlog (#95 section 5): self-eligible cost, pending review',
  'Scion of Opulence': 'owner backlog (#95 section 5): self-eligible cost, pending review',
  'Savage Thallid': 'owner backlog (#95 section 5): self-eligible cost, pending review',
  'Dark Privilege': 'sweep 2026-11-19: self-eligible cost, pending review',
};

describe('known engine gap detectors', () => {
  const patches = trialPatches();

  it('have unique ids and say what is wrong', () => {
    expect(new Set(DETECTORS.map((d) => d.id)).size).toBe(DETECTORS.length);
    for (const detector of DETECTORS) expect(detector.gap.length, detector.id).toBeGreaterThan(20);
  });

  it.each(DETECTORS.filter((d) => d.examples.length > 0).map((d) => [d.id, d] as const))(
    '%s matches every retired card it was written from',
    (_id, detector) => {
      for (const name of detector.examples) {
        const patch = patches.get(name);
        expect(patch, `${name}: no trial patch`).toBeDefined();
        const typeLine = pinned.get(name)?.card.typeLine ?? '';
        expect(
          detector.matches(patch!.def, patch!.handledLines.join('\n'), typeLine),
          `${detector.id} misses ${name}`,
        ).toBe(true);
      }
    },
  );

  it('make the compiler refuse a patch that uses an open gap, and pass a clean one', () => {
    // Leonin Warleader was retired for its attacking tokens; it is unmodeled, so it is a target.
    const warleader = compileTarget(pinned.get('Leonin Warleader')!)!;
    const issues = knownGapIssues(warleader, patches.get('Leonin Warleader')!.def);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^known engine gap token-created-attacking: .*inexpressible/);

    // The same card with a patch that uses no gap shape: one ordinary token, not attacking.
    const clean: Partial<CardDefinition> = {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'attacks', subject: { kind: 'self' } },
          optional: false,
          targets: [],
          effects: [{ op: 'draw', count: { kind: 'const', n: 1 } }],
        },
      ],
    } as Partial<CardDefinition>;
    expect(knownGapIssues(warleader, clean)).toEqual([]);
  });

  it('match no promoted compiled card except those kept on review', () => {
    const matched: Record<string, string[]> = {};
    for (const card of compiledCards().values()) {
      const typeLine = pinned.get(card.name)?.card.typeLine ?? '';
      const ids = knownGaps(card.def, card.handledLines, typeLine).map((d) => d.id);
      if (ids.length > 0) matched[card.name] = ids;
    }
    expect(Object.keys(matched).sort()).toEqual(Object.keys(KEPT).sort());
  });
});
