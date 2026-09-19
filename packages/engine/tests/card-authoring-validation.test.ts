import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import type { CardOverride } from '../src/cards/overrides';
import {
  validateCardDefinition,
  validateOverrideDefinition,
} from '../src/cards/authoring-validation';
import { interpretCard } from '../src/cards/interpret';
import {
  conflictingRegistrations,
  explicitReplacements,
  fixtureOracleId,
  getOverride,
  registrationsConflict,
} from '../src/cards/overrides';

interface PinnedFixture {
  cards: { card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/reviewed-five-oracle.json'), 'utf8'),
) as PinnedFixture;

function withoutIdentity<T extends { oracleId: unknown }>(value: T): Omit<T, 'oracleId'> {
  const { oracleId: _oracleId, ...rest } = value;
  return rest;
}

describe('card authoring validation', () => {
  it('validates complete merged definitions and equal real/fixture behavior for reviewed cards', () => {
    for (const { card } of fixture.cards) {
      const alias = { ...card, oracleId: fixtureOracleId(card.name) };
      const realDefinition = interpretCard(card);
      const aliasDefinition = interpretCard(alias);
      expect(validateCardDefinition(realDefinition), card.name).toEqual([]);
      expect(validateCardDefinition(aliasDefinition), `${card.name} fixture alias`).toEqual([]);
      expect(withoutIdentity(aliasDefinition), card.name).toEqual(withoutIdentity(realDefinition));

      const realOverride = getOverride(card.oracleId)!;
      const aliasOverride = getOverride(alias.oracleId)!;
      expect(validateOverrideDefinition(realOverride), card.name).toEqual([]);
      expect(aliasOverride.def, card.name).toEqual(realOverride.def);
      expect(aliasOverride.handledLines, card.name).toEqual(realOverride.handledLines);
    }
  });

  it('rejects executable placeholders, invalid target references, and misordered target slots', () => {
    const malformed = {
      oracleId: 'malformed',
      name: 'Malformed',
      handledLines: ['Malformed line.'],
      def: {
        triggers: [
          {
            kind: 'triggered',
            trigger: { when: 'enters', subject: { kind: 'self' } },
            targets: [{ kind: 'creature', count: { min: 0, max: 1 } }, { kind: 'player' }],
            effects: [
              { op: 'destroy', target: 1 },
              { op: 'putCountersEachChosen', targetSlot: 2, counter: '+1/+1', count: 1 },
              { op: 'noOp' },
            ],
          },
        ],
      },
    } as unknown as CardOverride;

    expect(validateOverrideDefinition(malformed).map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('variable-count target slots'),
        expect.stringContaining('does not reference an ordinary target slot'),
        expect.stringContaining('outside the ability target list'),
        expect.stringContaining('noOp'),
      ]),
    );
  });

  it('detects differing executable duplicates while allowing exact repeats and backlog promotion', () => {
    const base: CardOverride = {
      oracleId: 'duplicate',
      name: 'Duplicate',
      handledLines: ['line'],
      def: { keywords: ['flying'] },
    };
    expect(registrationsConflict(base, { ...base })).toBe(false);
    expect(registrationsConflict(base, { ...base, def: { keywords: ['haste'] } })).toBe(true);
    expect(registrationsConflict({ ...base, def: {} }, base)).toBe(false);
  });

  it('has no silent executable conflicts and documents every intentional replacement', () => {
    expect(conflictingRegistrations).toEqual([]);
    expect(explicitReplacements.length).toBeGreaterThan(0);
    for (const replacement of explicitReplacements) {
      expect(replacement.reason.trim().length, replacement.name).toBeGreaterThan(20);
    }
  });
});
