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
import { registerOverride, unregisterOverride } from '../src/cards/overrides';
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

    it('reports an override that claims a line the card never had', () => {
      registerOverride({
        oracleId: ORACLE_ID,
        name: 'Test Bespoke',
        handledLines: ['A line this card does not contain.'],
        def: {},
      });

      const def = interpretCard(bespoke());
      expect(def.modeled).toBe(false);
      expect(def.unmodeledReasons.some((r) => r.includes('no longer has'))).toBe(true);
    });

    it('claiming a duplicated line once leaves the second occurrence unmodeled', () => {
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
      expect(interpretCard(bespoke(text)).unmodeledReasons).toHaveLength(1);
    });
  });
});
