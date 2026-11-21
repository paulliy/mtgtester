/**
 * CR 732.4 backstop in `runPrioritySequence`: a decider that keeps taking the same optional
 * action from an identical menu is stopped after `OPTIONAL_LOOP_ITERATIONS` repeats, so a
 * mana-neutral untap loop (Aggravated Assault paid from untapping mana creatures) cannot keep a
 * step alive forever. The guard is silent for any other pattern of play.
 */

import { describe, expect, it } from 'vitest';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { OPTIONAL_LOOP_ITERATIONS, runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const untapper = () =>
  oracle({
    name: 'Test Untapper',
    typeLine: 'Enchantment',
    oracleText: '{1}: Untap all creatures you control. Activate only as a sorcery.',
  });

const elf = () =>
  oracle({
    name: 'Test Mana Elf',
    typeLine: 'Creature — Elf',
    manaCost: '{G}',
    power: '1',
    toughness: '1',
    oracleText: '{T}: Add {G}.',
  });

const cantrip = () =>
  oracle({
    name: 'Test Cantrip Rock',
    typeLine: 'Artifact',
    oracleText: '{0}: You gain 1 life. Activate only as a sorcery.',
  });

function pod(): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(3, forest) })),
      { seed: 'optional-loop' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  for (const p of ctx.state.players) conjure(ctx, p.id, forest(), 'library');
  return ctx;
}

describe('optional loop backstop (CR 732.4)', () => {
  it('stops offering a repeated identical action after the iteration limit and ends the step', () => {
    const ctx = pod();
    spawn(ctx, 'P1', untapper());
    spawn(ctx, 'P1', elf());
    spawn(ctx, 'P1', elf());

    let activations = 0;
    let withheldMenus = 0;
    pump(
      runPrioritySequence(ctx),
      (d) => {
        if (d.player !== 'P1') return { index: 0, targets: new Map() };
        const i = d.options.findIndex((o) => o.description.includes('Untap all creatures'));
        if (i < 0) {
          withheldMenus += 1;
          const pass = d.options.findIndex((o) => o.type === 'pass');
          return { index: pass, targets: new Map() };
        }
        activations += 1;
        expect(activations).toBeLessThanOrEqual(OPTIONAL_LOOP_ITERATIONS);
        return { index: i, targets: new Map() };
      },
      { strict: true },
    );

    expect(activations).toBe(OPTIONAL_LOOP_ITERATIONS);
    expect(withheldMenus).toBeGreaterThan(0);
    expect(ctx.state.stack).toHaveLength(0);
  });

  it('withholds only the repeated action: pass and other actions stay offered', () => {
    const ctx = pod();
    spawn(ctx, 'P1', untapper());
    spawn(ctx, 'P1', elf());
    spawn(ctx, 'P1', cantrip());
    let activations = 0;
    let afterLimit: string[] | null = null;
    pump(
      runPrioritySequence(ctx),
      (d) => {
        if (d.player !== 'P1') return { index: 0, targets: new Map() };
        const i = d.options.findIndex((o) => o.description.includes('Untap all creatures'));
        if (i >= 0) {
          activations += 1;
          return { index: i, targets: new Map() };
        }
        if (activations >= OPTIONAL_LOOP_ITERATIONS && afterLimit === null) {
          afterLimit = d.options.map((o) => o.type + ':' + o.description);
        }
        return { index: d.options.findIndex((o) => o.type === 'pass'), targets: new Map() };
      },
      { strict: true },
    );
    expect(activations).toBe(OPTIONAL_LOOP_ITERATIONS);
    expect(afterLimit).not.toBeNull();
    const menu = afterLimit as unknown as string[];
    expect(menu.some((o) => o.startsWith('pass:'))).toBe(true);
    expect(menu.some((o) => o.includes('gain 1 life'))).toBe(true);
    expect(menu.some((o) => o.includes('Untap all creatures'))).toBe(false);
  });

  it('a different action in between resets the counter', () => {
    const ctx = pod();
    spawn(ctx, 'P1', untapper());
    spawn(ctx, 'P1', elf());
    spawn(ctx, 'P1', elf());
    spawn(ctx, 'P1', cantrip());

    let activations = 0;
    let sinceBreak = 0;
    let breaks = 0;
    pump(
      runPrioritySequence(ctx),
      (d) => {
        if (d.player !== 'P1') return { index: 0, targets: new Map() };
        const untap = d.options.findIndex((o) => o.description.includes('Untap all creatures'));
        const gain = d.options.findIndex((o) => o.description.includes('gain 1 life'));
        // Take a different action every 5th choice, so no streak ever reaches the limit.
        if (untap >= 0 && sinceBreak >= 5 && gain >= 0 && breaks < 3) {
          sinceBreak = 0;
          breaks += 1;
          return { index: gain, targets: new Map() };
        }
        if (untap >= 0) {
          activations += 1;
          sinceBreak += 1;
          return { index: untap, targets: new Map() };
        }
        return { index: d.options.findIndex((o) => o.type === 'pass'), targets: new Map() };
      },
      { strict: true },
    );

    // 3 breaks x 5 activations, then a final streak that is capped at the limit.
    expect(breaks).toBe(3);
    expect(activations).toBe(15 + OPTIONAL_LOOP_ITERATIONS);
  });
});
