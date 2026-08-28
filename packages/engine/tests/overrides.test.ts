/**
 * The authored-override registry and its drift guard (ADR 0010, Inc 3).
 *
 * The registry only earns its place if it CANNOT quietly go stale. These tests pin that: an
 * override exempts specific oracle lines byte-exactly, so editing the card's text — an errata,
 * or an override authored against a different printing — puts the card back to
 * `modeled: false` instead of silently keeping behavior that no longer matches the card.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { failedRegistrations, getOverride, registerOverride, unregisterOverride } from '../src/cards/overrides';
import { oracle } from './fixtures';

const ORACLE_ID = 'oracle-test-override-card';

/**
 * A card with one line the text grammar cannot read.
 *
 * The line has to be *chosen*, and re-chosen as the grammar grows: this fixture previously used
 * "…, untap all Dragons", which Inc 10 taught the parser to read. A fixture that quietly starts
 * parsing turns these tests green for the wrong reason, so the line below is deliberately one
 * whose machinery (choosing which permanents an opponent sacrifices) no increment has built.
 */
const bespoke = (
  text = 'Whenever a Dragon you control attacks, each opponent sacrifices a permanent of your choice.',
) =>
  oracle({
    name: 'Test Bespoke',
    oracleId: ORACLE_ID,
    typeLine: 'Legendary Creature — Dragon',
    manaCost: '{4}{R}',
    oracleText: text,
  });

afterEach(() => unregisterOverride(ORACLE_ID));

describe('authored-override registry', () => {
  it('leaves a card unmodeled when no override is registered', () => {
    const def = interpretCard(bespoke());

    expect(def.modeled).toBe(false);
    expect(def.unmodeledReasons).toHaveLength(1);
  });

  it('does not let a no-op override hide unsupported text', () => {
    const def = interpretCard(bespoke());
    const line = /^unrecognized rules text: "([\s\S]*)"$/.exec(
      def.unmodeledReasons[0] as string,
    )?.[1] as string;

    registerOverride({
      oracleId: ORACLE_ID,
      name: 'Test Bespoke',
      handledLines: [line],
      def: {},
    });

    const overridden = interpretCard(bespoke());
    expect(overridden.modeled).toBe(false);
    expect(overridden.unmodeledReasons).toContain(def.unmodeledReasons[0]);

  });
  it('clears exactly the reasons an override names, and merges its authored behavior', () => {
    const def = interpretCard(bespoke());
    const line = /^unrecognized rules text: "([\s\S]*)"$/.exec(def.unmodeledReasons[0] as string);
    expect(line).not.toBeNull();

    registerOverride({
      oracleId: ORACLE_ID,
      name: 'Test Bespoke',
      handledLines: [line?.[1] as string],
      def: { keywords: ['flying'] },
    });

    const overridden = interpretCard(bespoke());
    expect(overridden.modeled).toBe(true);
    expect(overridden.unmodeledReasons).toEqual([]);
    expect(overridden.keywords).toEqual(['flying']);
  });

  it('treats a patch of only empty arrays/objects/optional-false the same as {} (it adds no real behavior)', () => {
    // Two real registrations shipped exactly this shape — a leftover `staticEffects: []` /
    // `triggers: []` from a template that was never filled in — and reported `modeled: true`
    // for a card with zero executable abilities, because `Object.keys({ staticEffects: [] })`
    // is length 1, not 0. `isEmptyPatch` looks at the VALUES, not just the key count.
    registerOverride({
      oracleId: ORACLE_ID,
      name: 'Test Bespoke',
      handledLines: [
        /^unrecognized rules text: "([\s\S]*)"$/.exec(
          interpretCard(bespoke()).unmodeledReasons[0] as string,
        )?.[1] as string,
      ],
      def: { staticEffects: [], triggers: [], commanderFreeCast: false, entersWithCounters: {} },
    });

    const overridden = interpretCard(bespoke());
    expect(overridden.modeled).toBe(false);
    expect(overridden.unmodeledReasons.some((r) => r.includes('has no executable behavior'))).toBe(true);
  });

  it('does NOT treat `entersTapped: false` as an empty patch, even alone', () => {
    // `entersTapped` is a required field the interpreter always fills in with a real value
    // (possibly `true`) — unlike an optional flag, `false` here is a meaningful correction, not
    // a leftover unfilled template field. Misclassifying it would let `applyOverride` silently
    // drop the fix and keep shipping the interpreted (wrong) value.
    const line = /^unrecognized rules text: "([\s\S]*)"$/.exec(
      interpretCard(bespoke()).unmodeledReasons[0] as string,
    )?.[1] as string;

    registerOverride({
      oracleId: ORACLE_ID,
      name: 'Test Bespoke',
      handledLines: [line],
      def: { entersTapped: false },
    });

    const overridden = interpretCard(bespoke());
    expect(overridden.unmodeledReasons.some((r) => r.includes('has no executable behavior'))).toBe(false);
    expect(overridden.entersTapped).toBe(false);
  });

  it('registerOverride guards a real registration by patch CONTENT, not key count', () => {
    // The same bug class `isEmptyPatch` fixes for `applyOverride`, in its sibling guard: a
    // content-empty-but-key-nonempty re-registration (e.g. a leftover `manaAbilities: []` from
    // a later, unrelated file re-registering the same oracle id) must not silently erase a real
    // registration already in the map. `Object.keys({ manaAbilities: [] }).length` is 1, not 0,
    // so a key-count guard would have let this overwrite through.
    registerOverride({
      oracleId: ORACLE_ID,
      name: 'Test Bespoke',
      handledLines: ['irrelevant'],
      def: { keywords: ['flying'] },
    });
    registerOverride({
      oracleId: ORACLE_ID,
      name: 'Test Bespoke',
      handledLines: ['irrelevant'],
      def: { manaAbilities: [] },
    });

    expect(getOverride(ORACLE_ID)?.def).toEqual({ keywords: ['flying'] });
  });

  describe('drift guard', () => {
    it('re-opens the card when its oracle text changes by even one character', () => {
      const original = interpretCard(bespoke());
      const line = /^unrecognized rules text: "([\s\S]*)"$/.exec(
        original.unmodeledReasons[0] as string,
      )?.[1] as string;

      registerOverride({
        oracleId: ORACLE_ID,
        name: 'Test Bespoke',
        handledLines: [line],
        def: { keywords: ['flying'] },
      });
      expect(interpretCard(bespoke()).modeled).toBe(true);

      // Errata: "untap all Dragons" → "untap each Dragon". The override no longer matches.
      const errata = bespoke('Whenever a Dragon you control attacks, untap each Dragon.');
      const after = interpretCard(errata);

      expect(after.modeled).toBe(false);
      // Both the unread new line AND the now-stale override claim are reported.
      expect(after.unmodeledReasons).toHaveLength(2);
      expect(after.unmodeledReasons.some((r) => r.includes('untap each Dragon'))).toBe(true);
      expect(after.unmodeledReasons.some((r) => r.includes('no longer has'))).toBe(true);
    });

    it('ignores a no-op override even when it claims a line the card never had', () => {
      registerOverride({
        oracleId: ORACLE_ID,
        name: 'Test Bespoke',
        handledLines: ['A line this card does not contain.'],
        def: {},
      });

      const def = interpretCard(bespoke());
      expect(def.modeled).toBe(false);
      expect(def.unmodeledReasons).toHaveLength(2);
    });

    it('ignores a no-op override that claims a duplicated line', () => {
      const text = 'Untap all Dragons.\nUntap all Dragons.';
      const def = interpretCard(bespoke(text));
      expect(def.unmodeledReasons).toHaveLength(2);

      // Note the terminal period: reasons quote the line as the interpreter saw it, which is
      // exactly why `handledLines` must be copied from `unmodeledReasons` and not retyped.
      registerOverride({
        oracleId: ORACLE_ID,
        name: 'Test Bespoke',
        handledLines: ['Untap all Dragons.'],
        def: {},
      });

      // One claim clears one reason — not both.
      expect(interpretCard(bespoke(text)).unmodeledReasons).toHaveLength(3);
    });
  });
});

describe('registry module init', () => {
  it('every deck registration succeeded (a bad mana string etc. would only fail its own deck)', () => {
    // `registerDeck` isolates each deck file's registration so a typo in one does not crash the
    // whole registry (and every other deck's overrides with it). This must still be caught
    // loudly, in CI, at the file that has the bug — this is that check.
    expect(failedRegistrations).toEqual([]);
  });
});

describe('Desolate Mire (real registration regression)', () => {
  // No registerOverride/afterEach here on purpose: this exercises the REAL production
  // registration already in the registry (from `silverquill-influence-remaining.ts`), not a
  // test-local one. `unregisterOverride` deletes from the shared, process-wide `OVERRIDES` map —
  // calling it on a real oracle id would permanently remove that card's override for every other
  // test in this worker, corrupting `override-defs.test.ts`'s golden-snapshot check.

  it('does not leave the interpreter\'s own stack-based reading of the same line behind', () => {
    // "{1}, {T}: Add {W}{B}." has a mana-inclusive cost, so CR 605.1a disqualifies it as a mana
    // ability and the interpreter's OWN generic parse reads it as a stack-based activated
    // ability. The override deliberately keeps this land a true (uncounterable) mana ability
    // instead — which means it must also clear the interpreter's activated-ability reading, or
    // the land would offer its mana twice.
    const def = interpretCard(
      oracle({
        name: 'Desolate Mire',
        typeLine: 'Land',
        manaCost: null,
        oracleText: '{1}, {T}: Add {W}{B}.',
      }),
    );

    expect(def.manaAbilities).toHaveLength(1);
    expect(def.activatedAbilities).toEqual([]);
  });
});
