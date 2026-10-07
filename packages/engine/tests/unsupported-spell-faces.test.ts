import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { computePriorityOptions } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { createGame } from '../src/state/game';
import { cloneContractContext } from './helpers/contract-harness';
import { conjure, copies, forest, gameConfig } from './fixtures';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/unsupported-spell-faces-oracle.json', import.meta.url), 'utf8'),
) as {
  cards: { sha256: string; card: OracleCard }[];
};
const requirements = [
  [
    'claim-territory-substitute-contained',
    'Bloomvine Regent // Claim Territory',
    '923a1d4e57487e65b17e92d1cfa6fdbf5afbd6b3d0f858826bd94ced7b8b6372',
  ],
  [
    'coil-and-catch-substitute-contained',
    'Marang River Regent // Coil and Catch',
    'a61b03077e75c21a2b78e2698ff0ead3653977e2e29c32b34a6fb84e73b72f8d',
  ],
  [
    'zoological-study-omission-contained',
    'Monster Manual // Zoological Study',
    'f1a88cb9b7a2583e8fec1dea7413b1c0476db8c46cffd38a9da7928858a7ba1e',
  ],
] as const;

describe('confirmed unsupported spell-face containment', () => {
  it.each(requirements)(
    '%s rejects the normal path for real and fixture identities',
    (_id, name, sha256) => {
      const pinned = fixture.cards.find(({ card }) => card.name === name)!;
      expect(pinned.sha256).toBe(sha256);
      expect(createHash('sha256').update(JSON.stringify(pinned.card)).digest('hex')).toBe(sha256);
      expect(pinned.card.backFace?.oracleText.length).toBeGreaterThan(0);
      for (const oracleId of [pinned.card.oracleId, fixtureOracleId(name)]) {
        const input = { ...pinned.card, oracleId };
        const definition = interpretCard(input);
        expect(definition.modeled).toBe(false);
        expect(definition.alternativeCasts).toBeUndefined();
        expect(definition.unmodeledReasons.join('; ')).toContain(pinned.card.backFace!.name);
        const ctx = createGame(
          gameConfig([{ cards: copies(8, forest) }, { cards: copies(8, forest) }]),
        );
        ctx.state.currentTurnPlayer = 'P1';
        ctx.state.phase = 'precombatMain';
        conjure(ctx, 'P1', input, 'hand');
        const before = cloneContractContext(ctx);
        expect(() => computePriorityOptions(ctx, ctx.state.players[0]!)).toThrow('Unmodeled card');
        expect(ctx.state).toEqual(before.state);
        expect(ctx.debugLog).toEqual(before.debugLog);
        expect(ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
      }
    },
  );
});
