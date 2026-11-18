/**
 * The per-process definition cache (plan E9): each distinct card is interpreted once, the
 * test-only transform still applies on every read, and a runtime override registration is never
 * answered with a definition interpreted before it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { interpretCard, interpretCardWithDiagnostics } from '../src/cards/interpret';
import { clearDefinitionCache, definitionCacheSize } from '../src/cards/definition-cache';
import { registerOverride, unregisterOverride } from '../src/cards/overrides';
import { installDefinitionTransform } from '../src/testing/definition-transform';
import { oracle } from './fixtures';

const ORACLE_ID = 'oracle-definition-cache-test-card';
const card = oracle({
  name: 'Definition Cache Test Card',
  oracleId: ORACLE_ID,
  typeLine: 'Legendary Creature — Dragon',
  manaCost: '{4}{R}',
  oracleText:
    'Whenever a Dragon you control attacks, each opponent sacrifices a permanent of your choice.',
});

afterEach(() => {
  installDefinitionTransform(null);
  unregisterOverride(ORACLE_ID);
});

describe('definition cache', () => {
  it('returns the same definition object for the same card', () => {
    clearDefinitionCache();
    const first = interpretCard(card);
    expect(interpretCard({ ...card })).toBe(first);
    expect(definitionCacheSize()).toBe(1);
  });

  it('keys on the whole card, not the oracle id alone', () => {
    const plain = interpretCard(card);
    const vanilla = interpretCard({ ...card, oracleText: '' });
    expect(vanilla).not.toBe(plain);
    expect(vanilla.modeled).toBe(true);
    expect(plain.modeled).toBe(false);
  });

  it('freezes cached definitions under vitest', () => {
    const definition = interpretCard(card);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(() => {
      (definition as { modeled: boolean }).modeled = true;
    }).toThrow(TypeError);
  });

  it('applies the definition transform on every read, after the cache', () => {
    const cached = interpretCard(card);
    installDefinitionTransform((definition) => ({ ...definition, name: 'Mutated' }));
    expect(interpretCard(card).name).toBe('Mutated');
    installDefinitionTransform(null);
    expect(interpretCard(card)).toBe(cached);
  });

  it('drops stale definitions when an override is registered or removed', () => {
    const before = interpretCard(card);
    expect(before.modeled).toBe(false);
    registerOverride({
      oracleId: ORACLE_ID,
      name: card.name,
      handledLines: [
        'Whenever a Dragon you control attacks, each opponent sacrifices a permanent of your choice.',
      ],
      def: { keywords: ['flying'] },
    });
    const overridden = interpretCard(card);
    expect(overridden).not.toBe(before);
    expect(overridden.keywords).toContain('flying');
    unregisterOverride(ORACLE_ID);
    expect(interpretCard(card).keywords).not.toContain('flying');
  });

  it('collects diagnostics on every call instead of reading the cache', () => {
    const text = 'When ~ enters, you gain life equal to the number of Shrines you control.';
    const shrineCard = { ...card, oracleText: text };
    interpretCard(shrineCard);
    const { definition, failures } = interpretCardWithDiagnostics(shrineCard);
    expect(definition).toEqual(interpretCard(shrineCard));
    expect(failures.length).toBeGreaterThan(0);
  });
});
