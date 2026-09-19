import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { EnginePermanent } from '../src/state/types';
import { bear, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';
const cards = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../server/fixtures/coverage-oracle.json'), 'utf8'),
) as OracleCard[];
const card = cards.find((c) => c.name === 'Pick Your Poison')!;
const definition = interpretCard(card);
function pod() {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(4, forest) })),
      { seed: 'pick-poison' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P3';
  ctx.state.activePlayerIndex = 2;
  return ctx;
}
describe('Pick Your Poison real Oracle modes', () => {
  it('models all three choices without targets', () => {
    expect(definition.unmodeledReasons).toEqual([]);
    expect(definition.modeled).toBe(true);
    expect(definition.spellAbility?.modes?.options).toHaveLength(3);
    expect(definition.spellAbility?.targets).toEqual([]);
  });
  it.each([0, 1, 2])('each opponent chooses one matching permanent in mode %i', (mode) => {
    const ctx = pod();
    const source = spawn(ctx, 'P1', bear());
    const shape =
      mode === 0
        ? { typeLine: 'Artifact', oracleText: '' }
        : mode === 1
          ? { typeLine: 'Enchantment', oracleText: '' }
          : { typeLine: 'Creature', oracleText: 'Flying' };
    const preserved = spawn(ctx, 'P1', oracle({ name: 'Friendly Match', ...shape }));
    const ground = spawn(ctx, 'P2', bear());
    const chosen: EnginePermanent[] = [];
    for (const player of ['P2', 'P3', 'P4'] as const) {
      spawn(ctx, player, oracle({ name: `Keep ${player}`, ...shape }));
      chosen.push(spawn(ctx, player, oracle({ name: `Sacrifice ${player}`, ...shape })));
    }
    const order: string[] = [];
    pump(
      executeAbility(
        ctx,
        source,
        {
          kind: 'spell',
          targets: [],
          effects: definition.spellAbility!.modes!.options[mode]!.effects,
        },
        [],
      ),
      (decision) => {
        order.push(decision.player);
        expect(decision.options).toHaveLength(2);
        // All earlier choices remain in play until every opponent has chosen.
        expect(chosen.every((p) => ctx.state.battlefield.includes(p))).toBe(true);
        return { index: 1, targets: new Map() };
      },
    );
    expect(order).toEqual(['P3', 'P4', 'P2']);
    expect(chosen.every((p) => !ctx.state.battlefield.includes(p))).toBe(true);
    expect(ctx.state.battlefield).toContain(preserved);
    expect(ctx.state.battlefield).toContain(ground);
  });
  it('does nothing for opponents without a matching permanent', () => {
    const ctx = pod();
    const source = spawn(ctx, 'P1', bear());
    spawn(ctx, 'P2', bear());
    const before = ctx.state.battlefield.length;
    const result = pump(
      executeAbility(
        ctx,
        source,
        {
          kind: 'spell',
          targets: [],
          effects: definition.spellAbility!.modes!.options[2]!.effects,
        },
        [],
      ),
    );
    expect(result.decisions).toHaveLength(0);
    expect(ctx.state.battlefield).toHaveLength(before);
  });
  it('dying watchers see other simultaneous sacrifices', () => {
    const ctx = pod();
    const source = spawn(ctx, 'P1', bear());
    for (const player of ['P2', 'P3'] as const)
      spawn(
        ctx,
        player,
        oracle({
          name: `Watcher ${player}`,
          oracleText: 'Flying\nWhenever another creature dies, draw a card.',
        }),
      );
    pump(
      executeAbility(
        ctx,
        source,
        {
          kind: 'spell',
          targets: [],
          effects: definition.spellAbility!.modes!.options[2]!.effects,
        },
        [],
      ),
    );
    expect(ctx.state.pendingTriggers).toHaveLength(2);
  });
});
