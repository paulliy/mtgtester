/**
 * Modal spells, a fixed-plus-variable-count damage split, damage divided among a variable
 * number of targets, and a resolution-time conditional effect (ADR 0010, Inc 14). Closes Crux
 * of Fate, Drakuseth, Maw of Flames, Ureni, the Song Unending, and Stubborn Denial.
 *
 * What these tests pin:
 *
 * - Crux of Fate's mode is chosen at ANNOUNCEMENT (CR 601.2b): each mode is its own cast
 *   option, and only the chosen mode's effects run — the other mode's destruction never
 *   happens even though both are "on the card";
 * - Drakuseth's variable "other targets" slot excludes whatever the fixed slot already chose,
 *   never offers more than two picks, and each chosen "other" target takes the fixed amount
 *   independently of the others;
 * - Ureni's divided damage assigns at least 1 to every chosen target and sums to exactly X
 *   (the number of lands controlled); choosing zero targets is a legal "divide among none",
 *   not a fizzle;
 * - Stubborn Denial's Ferocious clause is checked at RESOLUTION: with no power-4-or-greater
 *   creature the spell only fizzles unless its controller pays {1}; with one, it counters the
 *   spell unconditionally, and no payment decision is ever asked.
 */

import { describe, expect, it } from 'vitest';
import { computePriorityOptions } from '../src/actions/legal';
import type { Ability, Effect } from '../src/cards/ability';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import {
  conjure,
  copies,
  forest,
  gameConfig,
  island,
  oracle,
  pick,
  pump,
  registerDef,
  spawn,
  swamp,
} from './fixtures';

function pod(seed = 'modal-and-divided'): GameContext {
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

const p1 = (ctx: GameContext): EnginePlayerState =>
  ctx.state.players.find((p) => p.id === 'P1') as EnginePlayerState;

// --- Verbatim oracle text (packages/engine/tests/fixtures/urdragon-oracle.json) ---

const cruxOfFate = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Crux of Fate',
    typeLine: 'Sorcery',
    manaCost: '{3}{B}{B}',
    colors: ['B'],
    colorIdentity: ['B'],
    power: null,
    toughness: null,
    oracleText:
      'Choose one —\n• Destroy all Dragon creatures.\n• Destroy all non-Dragon creatures.',
  });

const drakuseth = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Drakuseth, Maw of Flames',
    typeLine: 'Legendary Creature — Dragon',
    supertypes: ['Legendary'],
    manaCost: '{4}{R}{R}{R}',
    colors: ['R'],
    colorIdentity: ['R'],
    power: '7',
    toughness: '7',
    oracleText:
      'Flying\nWhenever Drakuseth attacks, it deals 4 damage to any target and 3 damage to each of up to two other targets.',
  });

const ureni = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Ureni, the Song Unending',
    typeLine: 'Legendary Creature — Spirit Dragon',
    supertypes: ['Legendary'],
    manaCost: '{5}{G}{U}{R}',
    colors: ['G', 'U', 'R'],
    colorIdentity: ['G', 'U', 'R'],
    power: '10',
    toughness: '10',
    oracleText:
      'Flying, protection from white and from black\nWhen Ureni enters, it deals X damage divided ' +
      'as you choose among any number of target creatures and/or planeswalkers your opponents ' +
      'control, where X is the number of lands you control.',
  });

const stubbornDenial = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Stubborn Denial',
    typeLine: 'Instant',
    manaCost: '{U}',
    colors: ['U'],
    colorIdentity: ['U'],
    power: null,
    toughness: null,
    oracleText:
      "Counter target noncreature spell unless its controller pays {1}.\nFerocious — If you " +
      'control a creature with power 4 or greater, counter that spell instead.',
  });

const bear = (power: string, name = 'Test Bear'): ReturnType<typeof oracle> =>
  oracle({ name, typeLine: 'Creature — Bear', manaCost: '{2}', power, toughness: '2' });

const testDragon = (name: string): ReturnType<typeof oracle> =>
  oracle({ name, typeLine: 'Creature — Dragon', manaCost: '{3}', power: '2', toughness: '2' });

describe('Crux of Fate — modal spell', () => {
  it('parses to two modes, each an untargeted mass destroy by tribe', () => {
    const def = interpretCard(cruxOfFate());

    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.effects).toEqual([]); // effects live on the modes, not here
    const modes = def.spellAbility?.modes;
    expect(modes).toMatchObject({ minChoices: 1, maxChoices: 1 });
    expect(modes?.options).toHaveLength(2);
    expect(modes?.options[0]?.effects).toEqual([
      { op: 'destroyEach', selector: expect.anything() },
    ]);
    expect(modes?.options[1]?.effects).toEqual([
      { op: 'destroyEach', selector: expect.anything() },
    ]);
  });

  it('offers one cast option per mode, each independently affordable', () => {
    const ctx = pod();
    for (let i = 0; i < 5; i++) spawn(ctx, 'P1', swamp());
    conjure(ctx, 'P1', cruxOfFate(), 'hand');

    const options = computePriorityOptions(ctx, p1(ctx)).filter((o) => o.type === 'castSpell');
    expect(options).toHaveLength(2);
    expect(options.some((o) => /Destroy all Dragon creatures/.test(o.description))).toBe(true);
    expect(options.some((o) => /Destroy all non-Dragon creatures/.test(o.description))).toBe(true);
  });

  it('destroys only Dragons when that mode is chosen, sparing everything else', () => {
    const ctx = pod();
    for (let i = 0; i < 5; i++) spawn(ctx, 'P1', swamp());
    const dragon = spawn(ctx, 'P2', testDragon('Test Target Dragon'));
    const nonDragon = spawn(ctx, 'P3', bear('2'));
    conjure(ctx, 'P1', cruxOfFate(), 'hand');

    pump(runPrioritySequence(ctx), (d) => {
      const match = d.options.find((o) => /Destroy all Dragon creatures/.test(o.description));
      return match !== undefined ? pick(d, /Destroy all Dragon creatures/) : { index: 0, targets: new Map() };
    });

    expect(ctx.state.battlefield.some((p) => p.id === dragon.id)).toBe(false);
    expect(ctx.state.battlefield.some((p) => p.id === nonDragon.id)).toBe(true);
  });

  it('destroys only non-Dragons when that mode is chosen instead — the other mode never runs', () => {
    const ctx = pod();
    for (let i = 0; i < 5; i++) spawn(ctx, 'P1', swamp());
    const dragon = spawn(ctx, 'P2', testDragon('Test Target Dragon 2'));
    const nonDragon = spawn(ctx, 'P3', bear('2', 'Test Bear 2'));
    conjure(ctx, 'P1', cruxOfFate(), 'hand');

    pump(runPrioritySequence(ctx), (d) => {
      const match = d.options.find((o) => /Destroy all non-Dragon creatures/.test(o.description));
      return match !== undefined
        ? pick(d, /Destroy all non-Dragon creatures/)
        : { index: 0, targets: new Map() };
    });

    expect(ctx.state.battlefield.some((p) => p.id === dragon.id)).toBe(true);
    expect(ctx.state.battlefield.some((p) => p.id === nonDragon.id)).toBe(false);
  });
});

describe("Drakuseth, Maw of Flames — fixed hit plus a variable-count 'other' group", () => {
  it('parses to a fixed anyTarget slot plus a count slot excluding it, each with its own effect', () => {
    const def = interpretCard(drakuseth());
    expect(def.modeled).toBe(true);
    const trigger = def.triggers.find((t) => t.trigger?.when === 'attacks') as Ability;
    expect(trigger.targets).toEqual([
      { kind: 'anyTarget' },
      { kind: 'anyTarget', count: { min: 0, max: 2 } },
    ]);
    expect(trigger.effects).toEqual([
      { op: 'dealDamage', target: 0, amount: { kind: 'const', n: 4 } },
      { op: 'dealDamageEachChosen', targetSlot: 1, amount: { kind: 'const', n: 3 } },
    ]);
  });

  it('deals 4 to the fixed target and 3 to each of up to two OTHER targets, excluding the fixed pick', () => {
    const ctx = pod();
    const source = spawn(ctx, 'P1', drakuseth());
    const fixed = spawn(ctx, 'P2', bear('2', 'Fixed Target'));
    const otherA = spawn(ctx, 'P2', bear('2', 'Other A'));
    const otherB = spawn(ctx, 'P2', bear('2', 'Other B'));
    const bystander = spawn(ctx, 'P2', bear('2', 'Bystander'));
    const trigger = interpretCard(drakuseth()).triggers.find(
      (t) => t.trigger?.when === 'attacks',
    ) as Ability;

    ctx.state.pendingTriggers.push({
      controllerId: 'P1',
      sourceCardId: source.cardId,
      sourceOracleId: source.oracleId,
      sourceName: source.name,
      ability: trigger,
    });

    let pickCount = 0;
    const { decisions } = pump(runPrioritySequence(ctx), (d) => {
      if (d.decisionType === 'chooseTargets') {
        return { index: 0, targets: new Map([[0, fixed.id]]) };
      }
      if (d.decisionType === 'general' && /choose (a|another) target/.test(d.prompt)) {
        // Excluding the fixed pick is the assertion: it must never appear as a candidate.
        expect(d.options.some((o) => o.description.includes('Fixed Target'))).toBe(false);
        pickCount += 1;
        const wantOther = pickCount === 1 ? 'Other A' : 'Other B';
        const idx = d.options.findIndex((o) => o.description.includes(wantOther));
        return { index: idx, targets: new Map() };
      }
      return { index: 0, targets: new Map() };
    });

    // Never more than two picks, and never a third decision offered.
    expect(decisions.filter((d) => /choose (a|another) target/.test(d.prompt))).toHaveLength(2);
    expect(fixed.damageMarked).toBe(4);
    expect(otherA.damageMarked).toBe(3);
    expect(otherB.damageMarked).toBe(3);
    expect(bystander.damageMarked).toBe(0);
  });

  it('stops early when the controller declines further "other" targets', () => {
    const ctx = pod();
    const source = spawn(ctx, 'P1', drakuseth());
    const fixed = spawn(ctx, 'P2', bear('2', 'Fixed Only'));
    const other = spawn(ctx, 'P2', bear('2', 'Declined Other'));
    const trigger = interpretCard(drakuseth()).triggers.find(
      (t) => t.trigger?.when === 'attacks',
    ) as Ability;

    ctx.state.pendingTriggers.push({
      controllerId: 'P1',
      sourceCardId: source.cardId,
      sourceOracleId: source.oracleId,
      sourceName: source.name,
      ability: trigger,
    });

    pump(runPrioritySequence(ctx), (d) => {
      if (d.decisionType === 'chooseTargets') {
        return { index: 0, targets: new Map([[0, fixed.id]]) };
      }
      if (d.decisionType === 'general' && /choose a target/.test(d.prompt)) {
        const idx = d.options.findIndex((o) => o.type === 'decline');
        return { index: idx, targets: new Map() };
      }
      return { index: 0, targets: new Map() };
    });

    expect(fixed.damageMarked).toBe(4);
    expect(other.damageMarked).toBe(0);
  });
});

describe('Ureni, the Song Unending — damage divided among a variable-count group', () => {
  it('parses to a count slot over opponents’ creatures and a dealDamageDivided effect', () => {
    const def = interpretCard(ureni());
    expect(def.modeled).toBe(true);
    const trigger = def.triggers.find((t) => t.trigger?.when === 'enters') as Ability;
    expect(trigger.targets).toEqual([
      { kind: 'creature', count: { min: 0, max: Infinity }, controller: 'opponent' },
    ]);
    expect(trigger.effects).toEqual([
      {
        op: 'dealDamageDivided',
        targetSlot: 0,
        total: { kind: 'countPermanents', selector: expect.anything(), scope: 'you' },
      },
    ]);
  });

  it('divides X (lands controlled) among the chosen targets, each getting at least 1', () => {
    const ctx = pod();
    for (let i = 0; i < 4; i++) spawn(ctx, 'P1', forest()); // pod() already gave 4 forests? no — spawn extra
    const source = spawn(ctx, 'P1', ureni());
    const chosenA = spawn(ctx, 'P2', bear('2', 'Chosen A'));
    const chosenB = spawn(ctx, 'P2', bear('2', 'Chosen B'));
    const untouched = spawn(ctx, 'P2', bear('2', 'Untouched'));
    const trigger = interpretCard(ureni()).triggers.find((t) => t.trigger?.when === 'enters') as Ability;

    const landCount = ctx.state.battlefield.filter(
      (p) => p.controllerId === 'P1' && ctx.defs.get(p.oracleId)?.types.includes('Land') === true,
    ).length;
    expect(landCount).toBeGreaterThan(0);

    ctx.state.pendingTriggers.push({
      controllerId: 'P1',
      sourceCardId: source.cardId,
      sourceOracleId: source.oracleId,
      sourceName: source.name,
      ability: trigger,
    });

    let pickCount = 0;
    pump(runPrioritySequence(ctx), (d) => {
      if (d.decisionType === 'general' && /choose (a|another) target/.test(d.prompt)) {
        pickCount += 1;
        const want = pickCount === 1 ? 'Chosen A' : 'Chosen B';
        const idx = d.options.findIndex((o) => o.description.includes(want));
        if (idx >= 0) return { index: idx, targets: new Map() };
        return { index: d.options.findIndex((o) => o.type === 'decline'), targets: new Map() };
      }
      if (d.decisionType === 'general' && /how much of the remaining/.test(d.prompt)) {
        return { index: 0, targets: new Map() }; // take the minimum (1) each time offered
      }
      return { index: 0, targets: new Map() };
    });

    const total = chosenA.damageMarked + chosenB.damageMarked;
    expect(total).toBe(landCount);
    expect(chosenA.damageMarked).toBeGreaterThanOrEqual(1);
    expect(chosenB.damageMarked).toBeGreaterThanOrEqual(1);
    expect(untouched.damageMarked).toBe(0);
  });

  it('choosing zero targets resolves as a no-op, not a fizzle', () => {
    const ctx = pod();
    const source = spawn(ctx, 'P1', ureni());
    const bystander = spawn(ctx, 'P2', bear('2', 'Untargeted Bystander'));
    const trigger = interpretCard(ureni()).triggers.find((t) => t.trigger?.when === 'enters') as Ability;

    ctx.state.pendingTriggers.push({
      controllerId: 'P1',
      sourceCardId: source.cardId,
      sourceOracleId: source.oracleId,
      sourceName: source.name,
      ability: trigger,
    });

    pump(runPrioritySequence(ctx), (d) => {
      if (d.decisionType === 'general' && /choose a target/.test(d.prompt)) {
        const idx = d.options.findIndex((o) => o.type === 'decline');
        return { index: idx, targets: new Map() };
      }
      return { index: 0, targets: new Map() };
    });

    expect(bystander.damageMarked).toBe(0);
    expect(ctx.state.eventLog.some((e) => e.type === 'fizzle')).toBe(false);
  });
});

describe('Stubborn Denial — Ferocious checked at resolution', () => {
  it('parses to a conditional counter over one noncreature-spell target', () => {
    const def = interpretCard(stubbornDenial());
    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.targets).toEqual([
      { kind: 'noncreatureSpell', controller: 'opponent' },
    ]);
    const effect = def.spellAbility?.effects[0] as Extract<Effect, { op: 'conditionalEffect' }>;
    expect(effect.op).toBe('conditionalEffect');
    expect(effect.then).toEqual([{ op: 'counter', target: 0 }]);
    expect(effect.else).toEqual([
      { op: 'counterUnlessControllerPays', target: 0, cost: expect.anything() },
    ]);
  });

  function pushFakeNoncreatureSpell(
    ctx: GameContext,
    controllerId: string,
    id = 'o-fake-spell',
  ): void {
    const def = registerDef(ctx, oracle({ name: 'Test Noncreature Spell', typeLine: 'Sorcery', manaCost: '{2}' }));
    ctx.state.stack.push({
      id,
      sourceId: 'c-fake-spell',
      controllerId,
      kind: 'spell',
      description: 'Test Noncreature Spell',
      targets: [],
      card: null,
      ability: { kind: 'spell', targets: [], effects: [] },
      sourceOracleId: def.oracleId,
      sourceCardId: 'c-fake-spell',
      isCommanderCast: false,
    });
  }

  it('never offers its controller\'s own spell as a counterspell target', () => {
    const ctx = pod();
    pushFakeNoncreatureSpell(ctx, 'P1', 'o-own-spell');
    pushFakeNoncreatureSpell(ctx, 'P2', 'o-opponent-spell');
    spawn(ctx, 'P1', island());
    conjure(ctx, 'P1', stubbornDenial(), 'hand');

    const action = computePriorityOptions(ctx, p1(ctx)).find(
      (option) => option.type === 'castSpell' && option.description.startsWith('Cast Stubborn Denial'),
    );

    expect(action?.targets).toEqual([{ slot: 0, options: ['o-opponent-spell'] }]);
  });

  it("without Ferocious, counters unless the spell's controller pays {1} — and they can and do", () => {
    const ctx = pod();
    pushFakeNoncreatureSpell(ctx, 'P2');
    spawn(ctx, 'P2', island());
    const ability = interpretCard(stubbornDenial()).spellAbility as Ability;

    pump(
      executeAbility(
        ctx,
        { cardId: 'c-denial', name: 'Stubborn Denial', oracleId: 'oracle-stubborn-denial', controllerId: 'P1' },
        ability,
        ['o-fake-spell'],
      ),
      (d) => pick(d, /Pay/),
    );

    expect(ctx.state.stack).toHaveLength(1); // still there — the tax was paid
  });

  it('without Ferocious, counters when the spell’s controller has no mana to pay', () => {
    const ctx = pod();
    pushFakeNoncreatureSpell(ctx, 'P2');
    const ability = interpretCard(stubbornDenial()).spellAbility as Ability;

    pump(
      executeAbility(
        ctx,
        { cardId: 'c-denial', name: 'Stubborn Denial', oracleId: 'oracle-stubborn-denial', controllerId: 'P1' },
        ability,
        ['o-fake-spell'],
      ),
    );

    expect(ctx.state.stack).toHaveLength(0);
    expect(ctx.state.eventLog.some((e) => e.type === 'counterSpell')).toBe(true);
  });

  it('with Ferocious active, counters unconditionally — no payment decision is ever asked', () => {
    const ctx = pod();
    pushFakeNoncreatureSpell(ctx, 'P2');
    spawn(ctx, 'P2', island()); // could afford the tax, but Ferocious never asks
    spawn(ctx, 'P1', bear('4', 'Ferocious Enabler'));
    const ability = interpretCard(stubbornDenial()).spellAbility as Ability;

    const { decisions } = pump(
      executeAbility(
        ctx,
        { cardId: 'c-denial', name: 'Stubborn Denial', oracleId: 'oracle-stubborn-denial', controllerId: 'P1' },
        ability,
        ['o-fake-spell'],
      ),
    );

    expect(decisions).toHaveLength(0);
    expect(ctx.state.stack).toHaveLength(0);
    expect(ctx.state.eventLog.some((e) => e.type === 'counterSpell')).toBe(true);
  });
});
