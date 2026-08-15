/**
 * "<effect> and <effect>" in one printed sentence — the EDH-staple coverage plan's Tier 1
 * item 1.1 (Tatyova, and the second halves of Deadly Dispute / Big Score / Storm-Kiln Artist).
 *
 * The ", then " split was already the model; this is the same sequencing printed without the
 * "then". What makes it safe is the acceptance rule, not the regex: the split is taken only
 * when BOTH halves parse as effects on their own, so an "and" that joins a noun phrase rather
 * than two effects — "destroy all creatures and planeswalkers" — is left alone, because
 * "planeswalkers" is not an effect. Over-permissive splitting here would silently drop a
 * clause, which brief §6.3 rates as strictly worse than leaving the card unmodeled.
 */

import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { oracle } from './fixtures';

const spell = (name: string, oracleText: string): OracleCard =>
  oracle({ name, typeLine: 'Sorcery', manaCost: '{2}{G}', power: null, toughness: null, oracleText });

describe('splitting an effect sentence on "and"', () => {
  it('reads both halves of a trigger body, in order', () => {
    // The Tatyova shape.
    const def = interpretCard(
      oracle({
        name: 'Test Landfall Sage',
        typeLine: 'Creature — Merfolk',
        manaCost: '{3}{G}{U}',
        oracleText: 'Whenever a land you control enters, draw a card and you gain 1 life.',
      }),
    );

    expect(def.modeled).toBe(true);
    expect(def.triggers[0]?.effects).toEqual([
      { op: 'draw', count: { kind: 'const', n: 1 } },
      { op: 'gainLife', amount: { kind: 'const', n: 1 } },
    ]);
  });

  it('reads a spell whose payoff is two effects', () => {
    // The Deadly Dispute / Big Score tail.
    const def = interpretCard(spell('Test Dispute Tail', 'Draw two cards and create a Treasure token.'));

    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.effects.map((e) => e.op)).toEqual(['draw', 'createToken']);
  });

  it('does not split an "and" that joins a noun phrase', () => {
    // "planeswalkers" is not an effect, so the split is rejected and the sentence stays whole —
    // where it is still unmodeled, which is the correct outcome, not a silent half-reading.
    const def = interpretCard(spell('Test Wrath Variant', 'Destroy all creatures and planeswalkers.'));

    expect(def.modeled).toBe(false);
    expect(def.spellAbility).toBeNull();
  });

  it('does not split when only one half is an effect', () => {
    const def = interpretCard(spell('Test Half Sentence', 'Draw two cards and something the engine cannot read.'));

    expect(def.modeled).toBe(false);
  });

  it('leaves an already-understood sentence exactly as it was', () => {
    // The fallback runs last, so a whole-sentence rule that contains its own "and" still wins.
    const def = interpretCard(
      spell('Test Mass Pump', 'Creatures you control get +2/+2 and gain trample until end of turn.'),
    );

    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.effects).toEqual([
      {
        op: 'pumpEachUntilEot',
        selector: { kind: 'allOf', of: [{ kind: 'controller', who: 'you' }, { kind: 'type', value: 'Creature' }] },
        power: 2,
        toughness: 2,
      },
      {
        op: 'grantKeywordEachUntilEot',
        selector: { kind: 'allOf', of: [{ kind: 'controller', who: 'you' }, { kind: 'type', value: 'Creature' }] },
        keyword: 'trample',
      },
    ]);
  });

  it('chains across two "and"s', () => {
    const def = interpretCard(spell('Test Triple', 'You gain 3 life and scry 2 and draw a card.'));

    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.effects.map((e) => e.op)).toEqual(['gainLife', 'scry', 'draw']);
  });
});
