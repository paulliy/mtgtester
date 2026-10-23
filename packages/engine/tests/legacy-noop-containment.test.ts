import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { computePriorityOptions } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import { copies, forest, gameConfig, conjure } from './fixtures';

const fixture = [
  ...(JSON.parse(
    readFileSync(new URL('./fixtures/urdragon-oracle.json', import.meta.url), 'utf8'),
  ) as OracleCard[]),
  ...(JSON.parse(
    readFileSync(new URL('./fixtures/invalid-ir-oracle.json', import.meta.url), 'utf8'),
  ) as OracleCard[]),
];
// Sivitri and Zurgo and Ojutai left this list in coverage PR12, which implements both placeholders.
// Forbidding Spirit's attack tax is paid in mana, so the life-tax grammar leaves its line unread.
const cases = [
  [
    'forbidding-spirit-noop-contained',
    'Forbidding Spirit',
    'a15c65a6ecf3766c5ab5a38ef6ed59680bbd503c8bb0098a1924f2cf7fe2e9fc',
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
      expect(definition.unmodeledReasons.join('; ')).toContain(
        'unrecognized rules text: "When this creature enters, until your next turn, creatures can\'t attack you',
      );
      const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(4, forest) }))));
      conjure(ctx, 'P1', card, 'hand');
      ctx.state.currentTurnPlayer = 'P1';
      ctx.state.phase = 'precombatMain';
      expect(() => computePriorityOptions(ctx, ctx.state.players[0]!)).toThrow('Unmodeled card');
      expect(ctx.state.stack).toHaveLength(0);
    },
  );
});
