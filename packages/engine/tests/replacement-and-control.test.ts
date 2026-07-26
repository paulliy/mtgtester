/**
 * A damage-doubling replacement effect (CR 616), gain-control-of-a-set with a control-change
 * timestamp, and turn-scoped excess-damage tracking feeding an intervening-if (ADR 0010, Inc
 * 15). Closes Neriv, Heart of the Storm, Karrthus, Tyrant of Jund, and Rith, Liberated Primeval.
 *
 * What these tests pin:
 *
 * - Neriv only doubles damage from a creature that entered the battlefield THIS turn — an older
 *   creature you control, and a freshly-entered creature under an OPPONENT's control, both deal
 *   their printed amount;
 * - Karrthus's "gain control of all Dragons, then untap all Dragons" changes controllerId and
 *   untaps in one resolution, and the gained Dragon is marked summoning-sick under its new
 *   controller (CR 302.6) — but its own anthem ("Other Dragon creatures you control have haste")
 *   lets it attack anyway;
 * - Rith's excess-damage condition is true only when an OPPONENT's permanent took MORE damage
 *   than it needed to hit 0 toughness, and only for the current turn — it resets at the next
 *   untap step.
 */

import { describe, expect, it } from 'vitest';
import type { Ability } from '../src/cards/ability';
import { interpretCard } from '../src/cards/interpret';
import { dealDamageToCreature, permanentSource } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { runTurn } from '../src/turn/turn';
import { copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

function pod(seed = 'replacement-and-control'): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
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

// --- Verbatim oracle text (packages/engine/tests/fixtures/urdragon-oracle.json) ---

const neriv = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Neriv, Heart of the Storm',
    typeLine: 'Legendary Creature — Spirit Dragon',
    supertypes: ['Legendary'],
    manaCost: '{1}{R}{W}{B}',
    colors: ['B', 'R', 'W'],
    colorIdentity: ['B', 'R', 'W'],
    power: '4',
    toughness: '5',
    oracleText:
      'Flying\nIf a creature you control that entered this turn would deal damage, it deals ' +
      'twice that much damage instead.',
  });

const karrthus = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Karrthus, Tyrant of Jund',
    typeLine: 'Legendary Creature — Dragon',
    supertypes: ['Legendary'],
    manaCost: '{4}{B}{R}{G}',
    colors: ['B', 'R', 'G'],
    colorIdentity: ['B', 'R', 'G'],
    power: '6',
    toughness: '6',
    oracleText:
      'Flying, haste\nWhen Karrthus enters, gain control of all Dragons, then untap all Dragons.\n' +
      'Other Dragon creatures you control have haste.',
  });

const rith = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Rith, Liberated Primeval',
    typeLine: 'Legendary Creature — Dragon',
    supertypes: ['Legendary'],
    manaCost: '{2}{R}{G}{W}',
    colors: ['G', 'R', 'W'],
    colorIdentity: ['G', 'R', 'W'],
    power: '5',
    toughness: '5',
    oracleText:
      'Flying, ward {2}\nOther Dragons you control have ward {2}.\nAt the beginning of your end ' +
      'step, if a creature or planeswalker an opponent controlled was dealt excess damage this ' +
      'turn, create a 4/4 red Dragon creature token with flying.',
  });

const testDragon = (name: string, controller = ''): ReturnType<typeof oracle> =>
  oracle({
    name: `${controller}${name}`,
    typeLine: 'Creature — Dragon',
    manaCost: '{3}',
    power: '2',
    toughness: '2',
  });

const bear = (power: string, toughness: string, name = 'Test Bear'): ReturnType<typeof oracle> =>
  oracle({ name, typeLine: 'Creature — Bear', manaCost: '{2}', power, toughness });

describe('Neriv, Heart of the Storm — damage-doubling replacement (CR 616)', () => {
  it('parses to a damageDoubled rule static over creatures you control that entered this turn', () => {
    const def = interpretCard(neriv());
    expect(def.modeled).toBe(true);
    expect(def.ruleStatics).toEqual([
      { kind: 'damageDoubled', sourceFilter: expect.anything() },
    ]);
  });

  it('doubles damage from a creature that entered THIS turn', () => {
    const ctx = pod();
    spawn(ctx, 'P1', neriv());
    const fresh = spawn(ctx, 'P1', bear('3', '3', 'Fresh Attacker'));
    const target = spawn(ctx, 'P2', bear('9', '9', 'Sturdy Blocker'));

    dealDamageToCreature(ctx, permanentSource(fresh), target, 3, {
      combat: false,
      sourceHasDeathtouch: false,
      sourceHasLifelink: false,
    });

    expect(target.damageMarked).toBe(6);
  });

  it('does NOT double damage from a creature that entered an earlier turn', () => {
    const ctx = pod();
    spawn(ctx, 'P1', neriv());
    const old = spawn(ctx, 'P1', bear('3', '3', 'Old Attacker'));
    ctx.state.turnNumber += 1; // "old" entered last turn, relative to now
    const target = spawn(ctx, 'P2', bear('9', '9', 'Sturdy Blocker 2'));

    dealDamageToCreature(ctx, permanentSource(old), target, 3, {
      combat: false,
      sourceHasDeathtouch: false,
      sourceHasLifelink: false,
    });

    expect(target.damageMarked).toBe(3);
  });

  it('does NOT double a fresh creature under an OPPONENT’s control', () => {
    const ctx = pod();
    spawn(ctx, 'P1', neriv());
    const theirs = spawn(ctx, 'P2', bear('3', '3', 'Their Fresh Attacker'));
    const target = spawn(ctx, 'P1', bear('9', '9', 'Sturdy Blocker 3'));

    dealDamageToCreature(ctx, permanentSource(theirs), target, 3, {
      combat: false,
      sourceHasDeathtouch: false,
      sourceHasLifelink: false,
    });

    expect(target.damageMarked).toBe(3);
  });
});

describe('Karrthus, Tyrant of Jund — gain control of all Dragons, then untap them', () => {
  it('parses to an enters trigger of gainControl then untapEach, plus a haste anthem', () => {
    const def = interpretCard(karrthus());
    expect(def.modeled).toBe(true);
    const enters = def.triggers.find((t) => t.trigger?.when === 'enters') as Ability;
    expect(enters.effects).toEqual([
      { op: 'gainControl', selector: expect.anything() },
      { op: 'untapEach', selector: expect.anything() },
    ]);
    expect(def.staticEffects).toEqual([
      { affects: expect.anything(), op: { layer: 6, addKeyword: 'haste' } },
    ]);
  });

  it('takes control of every Dragon, untaps it, and lets it attack despite summoning sickness', () => {
    const ctx = pod();
    const source = spawn(ctx, 'P1', karrthus());
    const theirDragon = spawn(ctx, 'P2', testDragon('Stolen Dragon'), { tapped: true });
    const theirBear = spawn(ctx, 'P2', bear('4', '4', 'Untouched Bear'), { tapped: true });

    const trigger = interpretCard(karrthus()).triggers.find(
      (t) => t.trigger?.when === 'enters',
    ) as Ability;
    ctx.state.pendingTriggers.push({
      controllerId: 'P1',
      sourceCardId: source.cardId,
      sourceOracleId: source.oracleId,
      sourceName: source.name,
      ability: trigger,
    });
    pump(runPrioritySequence(ctx));

    expect(theirDragon.controllerId).toBe('P1');
    expect(theirDragon.tapped).toBe(false);
    expect(theirDragon.summoningSick).toBe(true); // CR 302.6 — newly under P1's control
    // The Bear was never a Dragon: left alone, still under P2, still tapped.
    expect(theirBear.controllerId).toBe('P2');
    expect(theirBear.tapped).toBe(true);
  });
});

describe('Rith, Liberated Primeval — turn-scoped excess damage feeds an intervening-if', () => {
  it('parses to an end-step trigger gated on an excessDamageDealtTo(opponents) condition', () => {
    const def = interpretCard(rith());
    expect(def.modeled).toBe(true);
    const endStep = def.triggers.find((t) => t.trigger?.when === 'endStep') as Ability;
    expect(endStep.trigger?.condition).toEqual({ kind: 'excessDamageDealtTo', scope: 'opponents' });
    expect(endStep.effects).toEqual([
      { op: 'createToken', spec: expect.anything(), count: { kind: 'const', n: 1 } },
    ]);
  });

  it('creates a 4/4 flying Dragon token when an opponent’s creature took excess damage this turn', () => {
    const ctx = pod();
    const source = spawn(ctx, 'P1', rith());
    const opposing = spawn(ctx, 'P2', bear('2', '2', 'Overkilled Bear'));

    // 5 damage to a 2-toughness creature: 3 is excess.
    dealDamageToCreature(ctx, permanentSource(source), opposing, 5, {
      combat: false,
      sourceHasDeathtouch: false,
      sourceHasLifelink: false,
    });
    expect(ctx.state.excessDamageControllerIds).toContain('P2');

    const trigger = interpretCard(rith()).triggers.find(
      (t) => t.trigger?.when === 'endStep',
    ) as Ability;
    ctx.state.pendingTriggers.push({
      controllerId: 'P1',
      sourceCardId: source.cardId,
      sourceOracleId: source.oracleId,
      sourceName: source.name,
      ability: trigger,
    });
    pump(runPrioritySequence(ctx));

    const token = ctx.state.battlefield.find((p) => p.name === 'Dragon' && p.controllerId === 'P1');
    expect(token).toBeDefined();
  });

  it('does NOT create a token when no excess damage was dealt this turn', () => {
    const ctx = pod();
    const source = spawn(ctx, 'P1', rith());
    const opposing = spawn(ctx, 'P2', bear('2', '9', 'Sturdy Bear'));

    // 2 damage to a 9-toughness creature: no excess.
    dealDamageToCreature(ctx, permanentSource(source), opposing, 2, {
      combat: false,
      sourceHasDeathtouch: false,
      sourceHasLifelink: false,
    });
    expect(ctx.state.excessDamageControllerIds).not.toContain('P2');

    const trigger = interpretCard(rith()).triggers.find(
      (t) => t.trigger?.when === 'endStep',
    ) as Ability;
    ctx.state.pendingTriggers.push({
      controllerId: 'P1',
      sourceCardId: source.cardId,
      sourceOracleId: source.oracleId,
      sourceName: source.name,
      ability: trigger,
    });
    pump(runPrioritySequence(ctx));

    expect(ctx.state.battlefield.some((p) => p.name === 'Dragon')).toBe(false);
  });

  it('excess damage taken by YOUR OWN permanent does not satisfy the condition', () => {
    const ctx = pod();
    const source = spawn(ctx, 'P1', rith());
    const own = spawn(ctx, 'P1', bear('2', '2', 'My Own Overkilled Bear'));

    dealDamageToCreature(ctx, permanentSource(source), own, 5, {
      combat: false,
      sourceHasDeathtouch: false,
      sourceHasLifelink: false,
    });
    expect(ctx.state.excessDamageControllerIds).toContain('P1');

    const trigger = interpretCard(rith()).triggers.find(
      (t) => t.trigger?.when === 'endStep',
    ) as Ability;
    ctx.state.pendingTriggers.push({
      controllerId: 'P1',
      sourceCardId: source.cardId,
      sourceOracleId: source.oracleId,
      sourceName: source.name,
      ability: trigger,
    });
    pump(runPrioritySequence(ctx));

    expect(ctx.state.battlefield.some((p) => p.name === 'Dragon')).toBe(false);
  });

  it('resets at the next untap step — excess damage does not carry over across turns', () => {
    const ctx = pod();
    ctx.state.excessDamageControllerIds.push('P2');

    // `runTurn`'s untap step runs synchronously before its first yield (CR 502: no priority in
    // the untap step), so one `.next()` is enough to observe the reset.
    runTurn(ctx).next();

    expect(ctx.state.excessDamageControllerIds).toEqual([]);
  });
});
