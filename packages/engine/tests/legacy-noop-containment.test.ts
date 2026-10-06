import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { computePriorityOptions } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import { copies, forest, gameConfig, conjure } from './fixtures';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/urdragon-oracle.json', import.meta.url), 'utf8'),
) as OracleCard[];
const cases = [
  [
    'sivitri-noop-contained',
    'Sivitri, Dragon Master',
    'f3e1cc6f16f788685d23f89ea4ee1c95a0122e8053265fb69cc371ac01490b64',
  ],
  [
    'zurgo-noop-contained',
    'Zurgo and Ojutai',
    '45392f93794edf49d1b74a1d73be74a4c4ce7f0815f3f49262a78b6a94618493',
  ],
] as const;

describe('legacy executable placeholder containment', () => {
  it.each(cases)(
    '%s — pinned Oracle cannot become an executable support claim',
    (_id, name, sha) => {
      const card = fixture.find((card) => card.name === name)!;
      expect(createHash('sha256').update(JSON.stringify(card)).digest('hex')).toBe(sha);
      const definition = interpretCard(card);
      expect(definition.modeled).toBe(false);
      expect(definition.unmodeledReasons.join('; ')).toContain('executable noOp');
      const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(4, forest) }))));
      conjure(ctx, 'P1', card, 'hand');
      ctx.state.currentTurnPlayer = 'P1';
      ctx.state.phase = 'precombatMain';
      expect(() => computePriorityOptions(ctx, ctx.state.players[0]!)).toThrow('executable noOp');
      expect(ctx.state.stack).toHaveLength(0);
    },
  );
});
