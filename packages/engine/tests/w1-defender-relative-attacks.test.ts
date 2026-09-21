import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { computeCharacteristics } from '../src/effects/continuous';
import { createGame } from '../src/state/game';
import { queueTriggersForEvent } from '../src/state/objects';
import { runPrioritySequence } from '../src/turn/priority';
import { bear, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const cards = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../server/fixtures/coverage-oracle.json'), 'utf8'),
) as OracleCard[];
const card = cards.find((candidate) => candidate.name === 'Namor, Atlantean King')!;
const definition = interpretCard(card);

function pod() {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(4, forest) })),
      { seed: 'w1-defender-relative-attacks' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  return ctx;
}

describe('Namor defender-relative attack trigger', () => {
  it('fully interprets the frozen Oracle text', () => {
    expect(definition.unmodeledReasons).toEqual([]);
    expect(definition.modeled).toBe(true);
  });

  it('pumps only other friendly creatures attacking that higher-life player', () => {
    const ctx = pod();
    const namor = spawn(ctx, 'P1', card);
    const sameDefender = spawn(ctx, 'P1', bear());
    const otherDefender = spawn(ctx, 'P1', bear());
    const opponentAttacker = spawn(
      ctx,
      'P2',
      oracle({ name: 'Opponent Attacker', power: '2', toughness: '2' }),
    );
    ctx.state.players.find((player) => player.id === 'P2')!.life = 41;
    namor.attacking = 'P2';
    sameDefender.attacking = 'P2';
    otherDefender.attacking = 'P3';
    opponentAttacker.attacking = 'P2';

    queueTriggersForEvent(ctx, 'attacks', [{ permanent: namor, playerId: 'P2' }]);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(runPrioritySequence(ctx));

    expect(computeCharacteristics(ctx, namor).power).toBe(2);
    expect(computeCharacteristics(ctx, sameDefender).power).toBe(4);
    expect(computeCharacteristics(ctx, otherDefender).power).toBe(2);
    expect(computeCharacteristics(ctx, opponentAttacker).power).toBe(2);
  });

  it('checks the defending player life condition both when queued and when resolving', () => {
    const ctx = pod();
    const namor = spawn(ctx, 'P1', card);
    const other = spawn(ctx, 'P1', bear());
    namor.attacking = 'P2';
    other.attacking = 'P2';

    queueTriggersForEvent(ctx, 'attacks', [{ permanent: namor, playerId: 'P2' }]);
    expect(ctx.state.pendingTriggers).toHaveLength(0);

    ctx.state.players.find((player) => player.id === 'P2')!.life = 41;
    queueTriggersForEvent(ctx, 'attacks', [{ permanent: namor, playerId: 'P2' }]);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    ctx.state.players.find((player) => player.id === 'P2')!.life = 40;
    pump(runPrioritySequence(ctx));
    expect(computeCharacteristics(ctx, other).power).toBe(2);
  });
});
