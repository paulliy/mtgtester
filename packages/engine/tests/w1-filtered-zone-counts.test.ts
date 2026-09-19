import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const cards = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../server/fixtures/coverage-oracle.json'), 'utf8'),
) as OracleCard[];
const card = cards.find((candidate) => candidate.name === 'Flame On!')!;
const definition = interpretCard(card);

function pod() {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(4, forest) })),
      { seed: 'w1-filtered-zone-counts' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  return ctx;
}

describe('Flame On! filtered graveyard count', () => {
  it('fully interprets the frozen Oracle text', () => {
    expect(definition.unmodeledReasons).toEqual([]);
    expect(definition.modeled).toBe(true);
  });

  it('counts only your noncreature, nonland cards and grants flying until end of turn', () => {
    const ctx = pod();
    const target = spawn(ctx, 'P1', bear());
    conjure(ctx, 'P1', oracle({ name: 'Own Sorcery', typeLine: 'Sorcery' }), 'graveyard');
    conjure(ctx, 'P1', oracle({ name: 'Own Artifact', typeLine: 'Artifact' }), 'graveyard');
    conjure(ctx, 'P1', oracle({ name: 'Own Creature', typeLine: 'Creature' }), 'graveyard');
    conjure(ctx, 'P1', forest(), 'graveyard');
    conjure(ctx, 'P2', oracle({ name: 'Opponent Instant', typeLine: 'Instant' }), 'graveyard');

    pump(
      executeAbility(
        ctx,
        { cardId: 'flame-on', oracleId: card.oracleId, name: card.name, controllerId: 'P1' },
        definition.spellAbility!,
        [target.id],
      ),
    );

    expect(target.counters['+1/+1']).toBe(2);
    expect(computeCharacteristics(ctx, target).keywords).toContain('flying');
  });

  it('permits a zero count while still granting flying', () => {
    const ctx = pod();
    const target = spawn(ctx, 'P1', bear());
    conjure(ctx, 'P1', bear(), 'graveyard');
    conjure(ctx, 'P1', forest(), 'graveyard');

    pump(
      executeAbility(
        ctx,
        { cardId: 'flame-on-zero', oracleId: card.oracleId, name: card.name, controllerId: 'P1' },
        definition.spellAbility!,
        [target.id],
      ),
    );

    expect(target.counters['+1/+1'] ?? 0).toBe(0);
    expect(computeCharacteristics(ctx, target).keywords).toContain('flying');
  });
});
