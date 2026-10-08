/**
 * Guard for ADR 0007: computed characteristics are the single source of truth for a
 * *permanent*. Reading types, subtypes, supertypes, keywords, triggers or mana abilities off a
 * `CardDefinition` is how a permanent ends up with the right combat math and the wrong
 * state-based action — the exact inconsistency ADR 0007 removed.
 *
 * This is a lint, not a proof: it cannot tell a permanent read from a card-in-hand read, so
 * legitimate sites are listed explicitly with the reason they are legitimate. A new occurrence
 * fails here and has to be justified by adding it to the list — which is the point.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');

/** Printed-characteristic reads that are correct, and why. */
const ALLOWED: Record<string, string> = {
  'cards/definition.ts': 'declares the CardDefinition model and its type predicates',
  'cards/interpret.ts':
    'buildTransformBackFace copies printed characteristics from a freshly interpreted synthetic card face',
  'effects/continuous.ts': 'the layer engine itself: printed values seed the layer pass',
  'stack/stack.ts': 'finishSpellCard reads a resolving spell card before it enters the battlefield',
  'stack/copy.ts':
    'a spell copy on the stack copies the spell it copies (CR 707.10), not a permanent',
  'actions/apply.ts':
    'reads the printed type of a card being announced from hand or the command zone, before it is a permanent',
  'casting/free.ts': 'previews cards outside the battlefield for an immediate casting permission',
  'casting/cast.ts':
    'reads the announced card outside the battlefield; casting uses its printed characteristics',
  'actions/legal.ts':
    'reads cards in hand / the command zone, which no continuous effect reaches — ' +
    'a permanent read here would be a bug',
  'targets/legality.ts':
    'spellMatchesSelector and isCreatureSpell read stack spells; battlefield targets still ' +
    'use computeCharacteristics and candidateOf, not printed CardDefinition properties',
  'state/objects.ts':
    'makePermanent, before the object is on the battlefield: a permanent enters with its ' +
    'printed loyalty/defense (CR 306.5b, 310.6)',
  'cards/value.ts': 'counts card types of cards in graveyards, not permanents',
  'state/queries.ts':
    'cardZoneCandidate builds a selector candidate for a card in a LIBRARY, HAND, or GRAVEYARD ' +
    '(search, look-at-top, reanimation targets). No continuous effect reaches those, so printed ' +
    'characteristics are the only ones they have',
  'effects/resolve.ts': 'reads cards in exile for playExiledCardFree (not battlefield permanents)',
  'cards/condition.ts':
    "mayRevealCardFromHand checks a player's HAND for a qualifying card (Game Trail and the " +
    'other reveal-a-land duals) — no continuous effect reaches a card that never entered play',
};

const PATTERN = /\bdef\.(types|subtypes|supertypes|colors|keywords|triggers|manaAbilities)\b/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('computed characteristics are the single source of truth (ADR 0007)', () => {
  it('no unreviewed module reads a permanent characteristic off its CardDefinition', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = file.slice(SRC.length + 1).replaceAll('\\', '/');
      if (rel in ALLOWED) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (PATTERN.test(line) && !line.trimStart().startsWith('*')) {
            offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
          }
        });
    }
    expect(
      offenders,
      'Route these through computeCharacteristics(ctx, perm) — or, if the read is genuinely ' +
        'about a card outside the battlefield, add the file to ALLOWED with the reason.',
    ).toEqual([]);
  });

  it('the allowlist has no stale entries', () => {
    for (const rel of Object.keys(ALLOWED)) {
      const body = readFileSync(join(SRC, rel), 'utf8');
      expect(PATTERN.test(body), `${rel} no longer needs an exemption`).toBe(true);
    }
  });
});
