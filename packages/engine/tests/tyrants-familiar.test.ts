/**
 * Tyrant's Familiar is catalog-contained: combat queues attacks with the attacking player as
 * eventPlayer, so "target creature defending player controls" would target the attacker's
 * creatures.
 */

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { oracle } from './fixtures';

describe("Tyrant's Familiar (catalog containment)", () => {
  it('is explicitly unsupported for defending-player targeting', () => {
    const card = oracle({
      oracleId: '63394e24-a456-4cc6-9885-8c62447b050a',
      name: "Tyrant's Familiar",
      typeLine: 'Creature — Dragon',
      manaCost: '{5}{R}{R}',
      power: '5',
      toughness: '5',
      oracleText:
        'Flying, haste\nLieutenant — As long as you control your commander, this creature gets +2/+2 and has "Whenever this creature attacks, it deals 7 damage to target creature defending player controls."',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(false);
    expect(def.unmodeledReasons.join('\n')).toContain(
      'Defending-player creature targeting uses eventPlayer, which is the attacking player.',
    );
  });
});
