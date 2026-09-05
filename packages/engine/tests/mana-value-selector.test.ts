/**
 * `manaValueAtMost`/`manaValueAtLeast` against BATTLEFIELD permanents (Austere Command's two
 * mana-value-bounded modes). The selector kind already existed for off-battlefield cards
 * (Sunforger's hand search); this pins the newer battlefield half — `candidateOf` now looks up
 * each permanent's own `CardDefinition` and computes its mana value (X read as 0, CR 202.3b) —
 * since a wiring mistake here would silently destroy either everything or nothing rather than
 * failing loudly.
 */

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { gameConfig, copies, forest, oracle, pump, spawn } from './fixtures';

function pod(seed = 'mana-value-selector'): GameContext {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(3, forest) })), { seed }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

describe('mana value selector on battlefield permanents', () => {
  it('models and executes both bounds of "destroy all creatures with mana value N or less/greater"', () => {
    const austereCommand = interpretCard(
      oracle({
        name: 'Austere Command Test',
        typeLine: 'Sorcery',
        manaCost: '{4}{W}{W}',
        power: null,
        toughness: null,
        oracleText:
          'Choose two —\n• Destroy all artifacts.\n• Destroy all enchantments.\n• Destroy all creatures with mana value 3 or less.\n• Destroy all creatures with mana value 4 or greater.',
      }),
    );
    expect(austereCommand.modeled).toBe(true);
    expect(austereCommand.spellAbility?.modes?.minChoices).toBe(2);
    expect(austereCommand.spellAbility?.modes?.maxChoices).toBe(2);
    const cheapMode = austereCommand.spellAbility?.modes?.options[2];
    const expensiveMode = austereCommand.spellAbility?.modes?.options[3];
    expect(cheapMode?.effects).toEqual([
      {
        op: 'destroyEach',
        selector: { kind: 'allOf', of: [{ kind: 'manaValueAtMost', n: 3 }, { kind: 'type', value: 'Creature' }] },
      },
    ]);
    expect(expensiveMode?.effects).toEqual([
      {
        op: 'destroyEach',
        selector: { kind: 'allOf', of: [{ kind: 'manaValueAtLeast', n: 4 }, { kind: 'type', value: 'Creature' }] },
      },
    ]);

    const ctx = pod();
    const source = spawn(ctx, 'P1', oracle({ name: 'Test Caster', typeLine: 'Artifact', manaCost: '{1}', power: null, toughness: null }));
    const cheap = spawn(ctx, 'P1', oracle({ name: 'Cheap Creature', typeLine: 'Creature — Bear', manaCost: '{2}', power: '2', toughness: '2' }));
    const boundary = spawn(ctx, 'P2', oracle({ name: 'Boundary Creature', typeLine: 'Creature — Bear', manaCost: '{3}', power: '3', toughness: '3' }));
    const expensive = spawn(ctx, 'P2', oracle({ name: 'Expensive Creature', typeLine: 'Creature — Dragon', manaCost: '{4}{R}', power: '5', toughness: '5' }));

    // The "3 or less" mode: destroys the {2} and the {3} boundary, spares the {4}{R}.
    pump(
      executeAbility(
        ctx,
        source,
        // `description` is optional; under exactOptionalPropertyTypes it must be omitted, not undefined.
        { kind: 'spell', targets: [], effects: cheapMode!.effects, ...(cheapMode!.description === undefined ? {} : { description: cheapMode!.description }) },
        [],
      ),
    );
    expect(ctx.state.battlefield.some((p) => p.id === cheap.id)).toBe(false);
    expect(ctx.state.battlefield.some((p) => p.id === boundary.id)).toBe(false);
    expect(ctx.state.battlefield.some((p) => p.id === expensive.id)).toBe(true);
  });
});
