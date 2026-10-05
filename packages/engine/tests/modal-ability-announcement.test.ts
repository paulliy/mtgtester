/**
 * Modal triggered and activated abilities announce their mode BEFORE their targets (CR 700.2a-b,
 * 601.2b-c via 602.2b, 603.3c) — never at resolution. Regression for the browser trial where
 * Adaptive Sporesinger's ETB asked for a creature target first and offered "+2/+2 and
 * vigilance" or "proliferate" only afterward, so a proliferate choice still carried a target
 * whose illegality could fizzle it.
 */

import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import type { PendingDecision } from '../src/decisions';
import { priorityCheckpoint } from '../src/sba/sba';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import { buildSpectatorState } from '../src/view/spectator';
import { buildPlayerView } from '../src/view/view';
import { moveObject } from '../src/state/objects';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const SPORESINGER = () =>
  oracle({
    name: 'Adaptive Sporesinger',
    typeLine: 'Creature — Phyrexian Druid',
    manaCost: '{2}{G}',
    power: '2',
    toughness: '3',
    keywords: ['Vigilance', 'Proliferate'],
    oracleText:
      'Vigilance\nWhen this creature enters, choose one —\n• Target creature gets +2/+2 and gains vigilance until end of turn.\n• Proliferate. (Choose any number of permanents and/or players, then give each another counter of each kind already there.)',
  });

const JITTE = () =>
  oracle({
    name: "Umezawa's Jitte",
    typeLine: 'Legendary Artifact — Equipment',
    manaCost: '{2}',
    oracleText:
      "Whenever equipped creature deals combat damage, put two charge counters on Umezawa's Jitte.\nRemove a charge counter from Umezawa's Jitte: Choose one —\n• Equipped creature gets +2/+2 until end of turn.\n• Target creature gets -1/-1 until end of turn.\n• You gain 2 life.\nEquip {2}",
  });

/** Only one mode has a target, and nothing on the board can be that target. */
const RELIC_WARD = () =>
  oracle({
    name: 'Test Relic Ward',
    typeLine: 'Enchantment',
    manaCost: '{1}{W}',
    oracleText:
      'When this enchantment enters, choose one —\n• Destroy target artifact.\n• You gain 3 life.',
  });

/** Two modes, each with its own target slot: choosing the second leaves slot 0 empty. */
const SPLIT_WARD = () =>
  oracle({
    name: 'Test Split Ward',
    typeLine: 'Enchantment',
    manaCost: '{1}{G}',
    oracleText:
      'When this enchantment enters, choose one —\n• Destroy target artifact.\n• Target creature gets +2/+2 until end of turn.',
  });

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(4, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

/** Put a card onto the battlefield from hand the way a resolving spell would, queuing its ETB. */
function enter(ctx: GameContext, card: ReturnType<typeof oracle>): void {
  const inHand = conjure(ctx, 'P1', card, 'hand');
  pump(moveObject(ctx, inHand, { zone: 'battlefield', controllerId: 'P1' }));
}

const isModeChoice = (d: PendingDecision) => d.options.some((o) => o.type === 'chooseModes');
const isTargetChoice = (d: PendingDecision) => d.decisionType === 'chooseTargets';

describe('modal triggered abilities choose the mode as they go on the stack (CR 603.3c)', () => {
  it('asks for the mode before any target, and announces only the chosen mode’s targets', () => {
    const ctx = pod('modal-trigger-order');
    const ally = spawn(ctx, 'P1', bear());
    enter(ctx, SPORESINGER());

    const order: string[] = [];
    pump(priorityCheckpoint(ctx), (d) => {
      if (isModeChoice(d)) {
        order.push('mode');
        return {
          index: d.options.findIndex((o) => /\+2\/\+2/.test(o.description)),
          targets: new Map(),
        };
      }
      if (isTargetChoice(d)) {
        order.push('target');
        return { index: 0, targets: new Map([[0, ally.id]]) };
      }
      return { index: 0, targets: new Map() };
    });

    expect(order).toEqual(['mode', 'target']);
    const top = ctx.state.stack.at(-1);
    expect(top?.ability?.modes).toBeUndefined();
    expect(top?.description).toMatch(/\[mode: target creature gets \+2\/\+2/);
    expect(top?.targets).toEqual([ally.id]);

    const { decisions } = pump(resolveTopOfStack(ctx));
    expect(decisions.some(isModeChoice)).toBe(false);
  });

  it('choosing proliferate announces no target, so losing a creature cannot fizzle it', () => {
    const ctx = pod('modal-trigger-proliferate');
    const ally = spawn(ctx, 'P1', bear());
    ally.counters['+1/+1'] = 1;
    enter(ctx, SPORESINGER());

    const { decisions } = pump(priorityCheckpoint(ctx), (d) =>
      isModeChoice(d)
        ? {
            index: d.options.findIndex((o) => /proliferate/i.test(o.description)),
            targets: new Map(),
          }
        : { index: 0, targets: new Map() },
    );
    expect(decisions.some(isTargetChoice)).toBe(false);
    const top = ctx.state.stack.at(-1);
    expect(top?.targets.filter((id) => id !== undefined)).toEqual([]);

    // Every creature the old flow would have targeted leaves; the targetless mode still resolves.
    const sporesinger = ctx.state.battlefield.find(
      (p) => p.name === 'Adaptive Sporesinger',
    ) as EnginePermanent;
    pump(moveObject(ctx, sporesinger, { zone: 'graveyard' }));
    pump(resolveTopOfStack(ctx), (d) => ({
      // Proliferate: choose the bear (the only permanent with a counter).
      index: Math.max(
        0,
        d.options.findIndex((o) => o.description.includes('Test Bear')),
      ),
      targets: new Map(),
    }));
    expect(ctx.state.eventLog.some((e) => e.type === 'fizzle')).toBe(false);
    expect(ally.counters['+1/+1']).toBe(2);
  });

  it('a mode with no legal target cannot be chosen, and the trigger still uses the other mode', () => {
    const ctx = pod('modal-trigger-untargetable-mode');
    const lifeBefore = ctx.state.players[0]!.life;
    enter(ctx, RELIC_WARD());

    // No artifact anywhere: "destroy target artifact" is not choosable (CR 700.2b), so the only
    // remaining mode is forced — no decision, and the trigger is NOT removed for lack of targets.
    const { decisions } = pump(priorityCheckpoint(ctx));
    expect(decisions).toHaveLength(0);
    expect(ctx.state.eventLog.some((e) => e.type === 'triggerRemovedNoTargets')).toBe(false);
    expect(ctx.state.stack.at(-1)?.description).toMatch(/\[mode: you gain 3 life\]/);

    pump(resolveTopOfStack(ctx));
    expect(ctx.state.players[0]!.life).toBe(lifeBefore + 3);
  });
});

describe('modal activated abilities choose the mode as part of activation (CR 602.2b, 700.2a)', () => {
  function jitteBoard(seed: string, withCreature: boolean) {
    const ctx = pod(seed);
    const jitte = spawn(ctx, 'P1', JITTE());
    jitte.counters['charge'] = 2;
    const bearPerm = withCreature ? spawn(ctx, 'P2', bear()) : undefined;
    const player = ctx.state.players[0]!;
    const jitteOptions = computePriorityOptions(ctx, player).filter((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === jitte.id;
    });
    return { ctx, player, jitte, bearPerm, jitteOptions };
  }

  it('offers one activation per mode, with only the targeted mode carrying a target slot', () => {
    const { jitteOptions } = jitteBoard('modal-activated-options', true);
    const modeLabels = jitteOptions.map((option) => option.data?.['modeLabel']);
    expect(modeLabels).toEqual([
      'equipped creature gets +2/+2 until end of turn',
      'target creature gets -1/-1 until end of turn',
      'you gain 2 life',
    ]);
    expect(jitteOptions.map((option) => option.targets?.length ?? 0)).toEqual([0, 1, 0]);
  });

  it('still offers the targetless modes when no creature could be targeted', () => {
    // Previously every mode's target slot was required, so Jitte could not be activated at all.
    const { jitteOptions } = jitteBoard('modal-activated-no-target', false);
    expect(jitteOptions.map((option) => option.data?.['modeLabel'])).toEqual([
      'equipped creature gets +2/+2 until end of turn',
      'you gain 2 life',
    ]);
  });

  it('puts the chosen mode on the stack and resolves it without asking again', () => {
    const { ctx, player, jitte, bearPerm, jitteOptions } = jitteBoard(
      'modal-activated-apply',
      true,
    );
    const shrink = jitteOptions.find((option) => option.targets?.length === 1)!;
    const slot = shrink.targets![0]!.slot;
    pump(
      applyPriorityAction(ctx, player, shrink.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[slot, bearPerm!.id]]),
      }),
    );
    expect(jitte.counters['charge']).toBe(1);
    const top = ctx.state.stack.at(-1);
    expect(top?.ability?.modes).toBeUndefined();
    expect(top?.description).toMatch(/\[mode: target creature gets -1\/-1/);

    const { decisions } = pump(resolveTopOfStack(ctx));
    expect(decisions.some(isModeChoice)).toBe(false);
    expect(ctx.state.eventLog.some((e) => e.type === 'fizzle')).toBe(false);
  });

  it('a lifegain activation carries no target and cannot fizzle', () => {
    const { ctx, player, jitteOptions } = jitteBoard('modal-activated-life', true);
    const life = jitteOptions.find((option) => option.data?.['modeLabel'] === 'you gain 2 life')!;
    const before = player.life;
    pump(
      applyPriorityAction(ctx, player, life.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    pump(resolveTopOfStack(ctx));
    expect(player.life).toBe(before + 2);
  });
});

describe('slot-indexed stack targets (unchosen modes leave empty slots)', () => {
  it('projects only the chosen targets — no null for an unchosen mode’s slot', () => {
    const ctx = pod('modal-holes-projection');
    spawn(ctx, 'P2', oracle({ name: 'Test Relic', typeLine: 'Artifact', manaCost: '{1}' }));
    const ally = spawn(ctx, 'P1', bear());
    enter(ctx, SPLIT_WARD());
    pump(priorityCheckpoint(ctx), (d) => {
      if (isModeChoice(d)) {
        return {
          index: d.options.findIndex((o) => /\+2\/\+2/.test(o.description)),
          targets: new Map(),
        };
      }
      if (isTargetChoice(d)) return { index: 0, targets: new Map([[1, ally.id]]) };
      return { index: 0, targets: new Map() };
    });

    // Engine-side the creature sits in slot 1, so slot 0 (the artifact mode) is a hole.
    const top = ctx.state.stack.at(-1)!;
    expect(top.targets[1]).toBe(ally.id);
    expect(0 in top.targets).toBe(false);
    // The projections carry only real targets; a hole would serialize as `null`.
    expect(buildSpectatorState(ctx).stack.at(-1)?.targets).toEqual([ally.id]);
    expect(buildPlayerView(ctx, 'P2').stack.at(-1)?.targets).toEqual([ally.id]);
    expect(JSON.stringify(buildSpectatorState(ctx).stack)).not.toContain('null');
  });

  it('an explicit undefined slot (a copied target array) does not fizzle a targetless mode', () => {
    const ctx = pod('modal-holes-fizzle');
    const lifeBefore = ctx.state.players[0]!.life;
    enter(ctx, RELIC_WARD());
    pump(priorityCheckpoint(ctx));
    const top = ctx.state.stack.at(-1)!;
    // `copyTargetSpell` spreads targets, turning a hole into an explicit undefined entry.
    top.targets = [undefined as unknown as string];

    pump(resolveTopOfStack(ctx));
    expect(ctx.state.eventLog.some((e) => e.type === 'fizzle')).toBe(false);
    expect(ctx.state.players[0]!.life).toBe(lifeBefore + 3);
  });
});
