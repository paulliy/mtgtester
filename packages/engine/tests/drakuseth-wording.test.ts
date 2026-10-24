import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';

const pins = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/drakuseth-wording-oracle.json', 'utf8'),
) as { cards: { card: OracleCard; sha256: string }[] };

describe('Drakuseth wording compatibility', () => {
  it('pins both projections and preserves the same attack event, flying and damage instructions', () => {
    expect(pins.cards).toHaveLength(2);
    const definitions = pins.cards.map(({ card, sha256 }) => {
      expect(createHash('sha256').update(JSON.stringify(card)).digest('hex')).toBe(sha256);
      const definition = interpretCard(card);
      expect(definition.modeled).toBe(true);
      expect(definition.keywords).toContain('flying');
      expect(definition.triggers).toHaveLength(1);
      expect(definition.triggers[0]?.trigger?.when).toBe('attacks');
      expect(definition.triggers[0]?.effects).toEqual([
        { op: 'dealDamage', target: 0, amount: { kind: 'const', n: 4 } },
        { op: 'dealDamageEachChosen', targetSlot: 1, amount: { kind: 'const', n: 3 } },
      ]);
      return definition;
    });
    expect(
      definitions[1]?.triggers.map(({ description: _description, ...ability }) => ability),
    ).toEqual(definitions[0]?.triggers.map(({ description: _description, ...ability }) => ability));
  });

  it('does not turn damage dealt by another named creature into source damage', () => {
    const current = pins.cards[1]!.card;
    const otherSource = {
      ...current,
      oracleText: current.oracleText.replace('Drakuseth deals', 'Another Dragon deals'),
    };
    expect(interpretCard(otherSource).modeled).toBe(false);
  });
});
