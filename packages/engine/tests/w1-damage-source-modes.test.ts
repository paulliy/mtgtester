import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const cards = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../server/fixtures/coverage-oracle.json'), 'utf8'),
) as OracleCard[];
const card = cards.find((candidate) => candidate.name === "It's Clobberin' Time!")!;
const definition = interpretCard(card);

function pod() {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(4, forest) })),
      { seed: 'w1-damage-source-modes' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  return ctx;
}

const source = {
  cardId: 'clobberin-time',
  oracleId: card.oracleId,
  name: card.name,
  controllerId: 'P1' as const,
};

describe("It's Clobberin' Time! modal damage source", () => {
  it('fully interprets both modes with independent target slots', () => {
    expect(definition.unmodeledReasons).toEqual([]);
    expect(definition.modeled).toBe(true);
    expect(definition.spellAbility?.modes?.options).toHaveLength(2);
    expect(definition.spellAbility?.modes?.options[0]?.targetSlots).toEqual([0, 1]);
    expect(definition.spellAbility?.modes?.options[1]?.targetSlots).toEqual([2]);
  });

  it("uses the chosen creature's current power and attributes its lifelink", () => {
    const ctx = pod();
    const brawler = spawn(
      ctx,
      'P1',
      oracle({ name: 'Brawler', power: '4', toughness: '4', oracleText: 'Lifelink' }),
    );
    const victim = spawn(ctx, 'P2', oracle({ name: 'Large Victim', power: '6', toughness: '6' }));
    brawler.counters['+1/+1'] = 1;
    const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
    const beforeLife = player.life;
    const mode = definition.spellAbility!.modes!.options[0]!;

    pump(
      executeAbility(
        ctx,
        source,
        {
          kind: 'spell',
          targets: definition.spellAbility!.targets.slice(0, 2),
          effects: mode.effects,
        },
        [brawler.id, victim.id],
      ),
    );

    expect(victim.damageMarked).toBe(5);
    expect(player.life).toBe(beforeLife + 5);
  });

  it('destroys an artifact in the other mode without requiring creature targets', () => {
    const ctx = pod();
    const artifact = spawn(
      ctx,
      'P2',
      oracle({ name: 'Target Artifact', typeLine: 'Artifact', power: null, toughness: null }),
    );
    const mode = definition.spellAbility!.modes!.options[1]!;
    const targetSlot = mode.targetSlots![0]!;

    pump(
      executeAbility(
        ctx,
        source,
        {
          kind: 'spell',
          targets: [definition.spellAbility!.targets[targetSlot]!],
          effects: mode.effects.map((effect) =>
            effect.op === 'destroy' ? { ...effect, target: 0 } : effect,
          ),
        },
        [artifact.id],
      ),
    );

    expect(ctx.state.battlefield).not.toContain(artifact);
    expect(ctx.state.players.find((player) => player.id === 'P2')!.graveyard).toHaveLength(1);
  });
});
