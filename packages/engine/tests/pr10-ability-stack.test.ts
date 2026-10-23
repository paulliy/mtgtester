import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import type { PriorityActionPayload } from '../src/actions/legal';
import { addMana } from '../src/mana/pool';
import { resolveTopOfStack } from '../src/stack/stack';
import { queueStepTriggers } from '../src/turn/turn';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { conjure, oracle, pump, spawn } from './fixtures';
import {
  activate,
  activateOption,
  asActive,
  bear,
  castFromHand,
  castOption,
  choose,
  labShock,
  p,
  pinned,
  pinnedDefinition,
  pod,
  putPendingTriggersOnStack,
  settle,
} from './pr10-helpers';

const lab = (name: string, oracleText: string, extra: Parameters<typeof oracle>[0] | object = {}) =>
  oracle({
    name,
    typeLine: 'Creature — Bear',
    manaCost: '{1}',
    cmc: 1,
    power: '2',
    toughness: '2',
    oracleText,
    ...extra,
  });

const mana = (...symbols: ('W' | 'U' | 'B' | 'R' | 'G' | 'C')[]) =>
  symbols.map((symbol) => ({ symbol }));

const hand = (ctx: GameContext, playerId: string) => p(ctx, playerId).hand.length;

describe('PR10.20 Siren Stormtamer', () => {
  function setup(seed: string) {
    const ctx = pod(seed);
    const siren = spawn(ctx, 'P1', pinned('Siren Stormtamer'));
    const mine = spawn(ctx, 'P1', bear('Stormtamer Ward'));
    const theirs = spawn(ctx, 'P2', bear('Stormtamer Rival'));
    return { ctx, siren, mine, theirs };
  }

  function shockFromP2(ctx: GameContext, target: string) {
    const restore = asActive(ctx, 'P2');
    const shock = castFromHand(ctx, 'P2', labShock(), new Map([[0, target]]));
    restore();
    return shock;
  }

  it('pr10-siren-stormtamer-pinned-oracle-supported — flying and the counter ability are modeled', () => {
    const def = pinnedDefinition('Siren Stormtamer');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
    expect(def.keywords).toContain('flying');
    expect(def.activatedAbilities).toHaveLength(1);
  });

  it('pr10-siren-stormtamer-counters-spell-targeting-you — sacrifices itself and counters it', () => {
    const { ctx, siren } = setup('pr10-siren-you');
    const shock = shockFromP2(ctx, 'P1');
    addMana(p(ctx, 'P1'), mana('U'));
    activate(ctx, 'P1', siren, new Map([[0, shock.id]]));
    expect(ctx.state.battlefield.some((permanent) => permanent.id === siren.id)).toBe(false);
    expect(p(ctx, 'P1').graveyard.map((card) => card.name)).toContain('Siren Stormtamer');
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.stack.some((entry) => entry.id === shock.id)).toBe(false);
    expect(p(ctx, 'P2').graveyard.map((card) => card.name)).toContain('Lab Shock');
    expect(p(ctx, 'P1').life).toBe(40);
  });

  it('pr10-siren-stormtamer-counters-ability-targeting-your-creature — abilities count too', () => {
    const { ctx, siren, mine } = setup('pr10-siren-ability');
    const pinger = spawn(
      ctx,
      'P2',
      lab('Stormtamer Pinger', '{T}: This creature deals 1 damage to any target.'),
    );
    const restore = asActive(ctx, 'P2');
    const ping = activate(ctx, 'P2', pinger, new Map([[0, mine.id]]));
    restore();
    addMana(p(ctx, 'P1'), mana('U'));
    activate(ctx, 'P1', siren, new Map([[0, ping.id]]));
    settle(ctx);
    expect(mine.damageMarked).toBe(0);
    expect(ctx.state.eventLog.some((event) => event.type === 'counterSpell')).toBe(true);
  });

  it("pr10-siren-stormtamer-not-your-target — a spell aimed elsewhere can't be targeted", () => {
    const { ctx, siren, theirs } = setup('pr10-siren-elsewhere');
    shockFromP2(ctx, theirs.id);
    addMana(p(ctx, 'P1'), mana('U'));
    expect(activateOption(ctx, 'P1', siren)).toBeUndefined();
  });

  it('pr10-siren-stormtamer-rechecked-on-resolution — no counter once the spell no longer targets yours', () => {
    const { ctx, siren, mine } = setup('pr10-siren-recheck');
    const shock = shockFromP2(ctx, mine.id);
    addMana(p(ctx, 'P1'), mana('U'));
    activate(ctx, 'P1', siren, new Map([[0, shock.id]]));
    // The targeted creature changes control before Siren's ability resolves.
    mine.controllerId = 'P3';
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.stack.some((entry) => entry.id === shock.id)).toBe(true);
  });

  it('pr10-siren-stormtamer-insufficient-cost — needs {U}', () => {
    const { ctx, siren } = setup('pr10-siren-cost');
    shockFromP2(ctx, 'P1');
    addMana(p(ctx, 'P1'), mana('G'));
    expect(activateOption(ctx, 'P1', siren)).toBeUndefined();
  });
});

describe('PR10.27 Mana Sculpt', () => {
  const sculpt = pinned('Mana Sculpt');
  const wizard = () => bear('Sculpt Apprentice', { typeLine: 'Creature — Human Wizard' });

  /** P2 casts Bolt Bend for {R} (a power 4 creature reduces it by {3}) at P2's own Lab Shock. */
  function boltBendForOne(seed: string) {
    const ctx = pod(seed);
    spawn(ctx, 'P2', bear('Sculpt Brute', { power: '4', toughness: '4' }));
    const restore = asActive(ctx, 'P2');
    const shock = castFromHand(ctx, 'P2', labShock(), new Map([[0, 'P1']]));
    const bend = conjure(ctx, 'P2', pinned('Bolt Bend'), 'hand');
    addMana(p(ctx, 'P2'), mana('R'));
    const option = castOption(ctx, 'P2', bend.id);
    expect(option, 'reduced Bolt Bend is castable for {R}').toBeDefined();
    pump(
      applyPriorityAction(ctx, p(ctx, 'P2'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, shock.id]]),
      }),
    );
    restore();
    const bendEntry = ctx.state.stack.at(-1)!;
    return { ctx, bendEntry };
  }

  function nextMainPhase(ctx: GameContext) {
    Object.assign(ctx.state, { phase: 'postcombatMain', step: null });
    queueStepTriggers(ctx, 'mainPhase');
    settle(ctx);
  }

  it('pr10-mana-sculpt-pinned-oracle-supported — both sentences are modeled', () => {
    const def = pinnedDefinition('Mana Sculpt');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
  });

  it('pr10-mana-sculpt-wizard-mana-spent — adds the mana spent, not the mana value, next main phase', () => {
    const { ctx, bendEntry } = boltBendForOne('pr10-sculpt-wizard');
    spawn(ctx, 'P1', wizard());
    castFromHand(ctx, 'P1', sculpt, new Map([[0, bendEntry.id]]));
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.stack.some((entry) => entry.id === bendEntry.id)).toBe(false);
    expect(p(ctx, 'P2').graveyard.map((card) => card.name)).toContain('Bolt Bend');
    // Nothing yet: the mana comes at the beginning of the next main phase.
    expect(p(ctx, 'P1').manaPool.C).toBe(0);
    ctx.state.stack = [];
    nextMainPhase(ctx);
    expect(p(ctx, 'P1').manaPool.C).toBe(1);
  });

  it('pr10-mana-sculpt-no-wizard — counters without adding mana', () => {
    const { ctx, bendEntry } = boltBendForOne('pr10-sculpt-nowizard');
    castFromHand(ctx, 'P1', sculpt, new Map([[0, bendEntry.id]]));
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.stack.some((entry) => entry.id === bendEntry.id)).toBe(false);
    ctx.state.stack = [];
    nextMainPhase(ctx);
    expect(p(ctx, 'P1').manaPool.C).toBe(0);
  });

  it('pr10-mana-sculpt-wizard-checked-on-resolution — a Wizard gone before it resolves adds nothing', () => {
    const { ctx, bendEntry } = boltBendForOne('pr10-sculpt-late');
    const apprentice = spawn(ctx, 'P1', wizard());
    castFromHand(ctx, 'P1', sculpt, new Map([[0, bendEntry.id]]));
    ctx.state.battlefield = ctx.state.battlefield.filter((permanent) => permanent !== apprentice);
    pump(resolveTopOfStack(ctx));
    ctx.state.stack = [];
    nextMainPhase(ctx);
    expect(p(ctx, 'P1').manaPool.C).toBe(0);
  });

  it("pr10-mana-sculpt-uncounterable-still-adds — mana comes even if the spell can't be countered", () => {
    const ctx = pod('pr10-sculpt-uncounterable');
    spawn(ctx, 'P1', wizard());
    const restore = asActive(ctx, 'P2');
    const stubborn = castFromHand(
      ctx,
      'P2',
      oracle({
        name: 'Lab Stubborn Insight',
        typeLine: 'Instant',
        manaCost: '{2}{U}',
        cmc: 3,
        colors: ['U'],
        power: null,
        toughness: null,
        oracleText: "This spell can't be countered.\nDraw a card.",
      }),
    );
    restore();
    castFromHand(ctx, 'P1', sculpt, new Map([[0, stubborn.id]]));
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.stack.some((entry) => entry.id === stubborn.id)).toBe(true);
    ctx.state.stack = [];
    nextMainPhase(ctx);
    expect(p(ctx, 'P1').manaPool.C).toBe(3);
  });
});

describe('PR10.21 Mister Fantastic', () => {
  const sparker = () =>
    lab(
      'Fantastic Sparker',
      'When this creature enters, this creature deals 1 damage to any target.',
    );

  /** P1's Sparker enters and its trigger targets `firstTarget`. */
  function triggerOnStack(seed: string) {
    const ctx = pod(seed);
    const fantastic = spawn(ctx, 'P1', pinned('Mister Fantastic'));
    const a = spawn(ctx, 'P2', bear('Fantastic Bear A'));
    const b = spawn(ctx, 'P2', bear('Fantastic Bear B'));
    const c = spawn(ctx, 'P3', bear('Fantastic Bear C'));
    castFromHand(ctx, 'P1', sparker());
    pump(resolveTopOfStack(ctx));
    putPendingTriggersOnStack(ctx, () => ({ index: 0, targets: new Map([[0, a.id]]) }));
    const trigger = ctx.state.stack.at(-1)!;
    expect(trigger.kind).toBe('triggeredAbility');
    return { ctx, fantastic, a, b, c, trigger };
  }

  it('pr10-mister-fantastic-pinned-oracle-supported — the combat draw and the copy ability are modeled', () => {
    const def = pinnedDefinition('Mister Fantastic');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
    expect(def.triggers).toHaveLength(1);
    expect(def.activatedAbilities).toHaveLength(1);
  });

  it('pr10-mister-fantastic-copies-twice — two copies, each with its own new target', () => {
    const { ctx, fantastic, a, b, c, trigger } = triggerOnStack('pr10-fantastic-twice');
    addMana(p(ctx, 'P1'), mana('R', 'G', 'W', 'U'));
    activate(ctx, 'P1', fantastic, new Map([[0, trigger.id]]));
    expect(fantastic.tapped).toBe(true);
    let call = 0;
    pump(resolveTopOfStack(ctx), (decision) =>
      choose(call++ === 0 ? 'Fantastic Bear B' : 'Fantastic Bear C')(decision),
    );
    const copies = ctx.state.stack.filter((entry) => entry.description.startsWith('Copy of'));
    expect(copies).toHaveLength(2);
    expect(copies.every((copy) => copy.kind === 'triggeredAbility')).toBe(true);
    expect(copies.map((copy) => copy.targets)).toEqual([[b.id], [c.id]]);
    settle(ctx);
    expect([a.damageMarked, b.damageMarked, c.damageMarked]).toEqual([1, 1, 1]);
  });

  it('pr10-mister-fantastic-only-your-triggered-abilities — not a spell, not an opponent trigger', () => {
    const ctx = pod('pr10-fantastic-illegal');
    const fantastic = spawn(ctx, 'P1', pinned('Mister Fantastic'));
    const restore = asActive(ctx, 'P2');
    castFromHand(ctx, 'P2', sparker());
    pump(resolveTopOfStack(ctx));
    putPendingTriggersOnStack(ctx, () => ({ index: 0, targets: new Map([[0, fantastic.id]]) }));
    restore();
    expect(ctx.state.stack.at(-1)!.controllerId).toBe('P2');
    castFromHand(ctx, 'P1', labShock(), new Map([[0, 'P2']]));
    addMana(p(ctx, 'P1'), mana('R', 'G', 'W', 'U'));
    expect(activateOption(ctx, 'P1', fantastic)).toBeUndefined();
  });

  it('pr10-mister-fantastic-insufficient-cost — needs all four colors', () => {
    const { ctx, fantastic } = triggerOnStack('pr10-fantastic-cost');
    addMana(p(ctx, 'P1'), mana('R', 'G', 'W', 'C'));
    expect(activateOption(ctx, 'P1', fantastic)).toBeUndefined();
  });

  it('pr10-mister-fantastic-combat-draw — draws only after a noncreature spell this turn', () => {
    const ctx = pod('pr10-fantastic-combat');
    spawn(ctx, 'P1', pinned('Mister Fantastic'));
    const before = hand(ctx, 'P1');
    queueStepTriggers(ctx, 'beginningOfCombat');
    settle(ctx);
    expect(hand(ctx, 'P1')).toBe(before);
    castFromHand(ctx, 'P1', labShock(), new Map([[0, 'P2']]));
    settle(ctx);
    queueStepTriggers(ctx, 'beginningOfCombat');
    settle(ctx);
    expect(hand(ctx, 'P1')).toBe(before + 1);
  });
});

describe('PR10.22 Verrak, Warped Sengir', () => {
  const bloodletter = () => lab('Verrak Bloodletter', 'Pay 2 life: Draw a card.');
  const bloodPinger = () =>
    lab('Verrak Blood Pinger', 'Pay 1 life: This creature deals 1 damage to any target.');

  function setup(seed: string) {
    const ctx = pod(seed);
    const verrak = spawn(ctx, 'P1', pinned('Verrak, Warped Sengir'));
    return { ctx, verrak };
  }

  /** Activate `source` and put Verrak's trigger on the stack above it. */
  function activateWithTrigger(
    ctx: GameContext,
    source: EnginePermanent,
    targets: Map<number, string> = new Map(),
  ) {
    const original = activate(ctx, 'P1', source, targets);
    putPendingTriggersOnStack(ctx);
    return original;
  }

  it('pr10-verrak-pinned-oracle-supported — keywords and the copy trigger are modeled', () => {
    const def = pinnedDefinition('Verrak, Warped Sengir');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
    expect(def.keywords).toEqual(expect.arrayContaining(['flying', 'deathtouch', 'lifelink']));
    expect(def.triggers[0]?.trigger).toEqual({
      when: 'activatesAbility',
      player: 'you',
      lifePaid: true,
    });
  });

  it('pr10-verrak-pay-again-copies — paying that much life again copies the ability', () => {
    const { ctx } = setup('pr10-verrak-pay');
    const source = spawn(ctx, 'P1', bloodletter());
    const before = hand(ctx, 'P1');
    activateWithTrigger(ctx, source);
    expect(p(ctx, 'P1').life).toBe(38);
    expect(ctx.state.stack.at(-1)!.kind).toBe('triggeredAbility');
    pump(resolveTopOfStack(ctx), choose('Pay 2 life'));
    expect(p(ctx, 'P1').life).toBe(36);
    expect(ctx.state.stack.at(-1)!.description).toMatch(/^Copy of /);
    settle(ctx);
    expect(hand(ctx, 'P1')).toBe(before + 2);
  });

  it('pr10-verrak-decline — declining pays nothing and copies nothing', () => {
    const { ctx } = setup('pr10-verrak-decline');
    const source = spawn(ctx, 'P1', bloodletter());
    const before = hand(ctx, 'P1');
    activateWithTrigger(ctx, source);
    pump(resolveTopOfStack(ctx), choose('Decline'));
    settle(ctx);
    expect(p(ctx, 'P1').life).toBe(38);
    expect(hand(ctx, 'P1')).toBe(before + 1);
  });

  it('pr10-verrak-copy-new-target — the copy may choose a new target', () => {
    const { ctx } = setup('pr10-verrak-retarget');
    const source = spawn(ctx, 'P1', bloodPinger());
    const a = spawn(ctx, 'P2', bear('Verrak Bear A'));
    const b = spawn(ctx, 'P2', bear('Verrak Bear B'));
    activateWithTrigger(ctx, source, new Map([[0, a.id]]));
    pump(resolveTopOfStack(ctx), (decision) =>
      choose(decision.prompt.includes('pay 1 life') ? 'Pay 1 life' : 'Verrak Bear B')(decision),
    );
    expect(ctx.state.stack.at(-1)!.targets).toEqual([b.id]);
    settle(ctx);
    expect([a.damageMarked, b.damageMarked]).toEqual([1, 1]);
    expect(p(ctx, 'P1').life).toBe(38);
  });

  it('pr10-verrak-no-life-no-trigger — an ability that cost no life does not trigger it', () => {
    const { ctx } = setup('pr10-verrak-nolife');
    const source = spawn(ctx, 'P1', lab('Verrak Scholar', '{1}: Draw a card.'));
    addMana(p(ctx, 'P1'), mana('C'));
    activate(ctx, 'P1', source);
    putPendingTriggersOnStack(ctx);
    expect(ctx.state.stack).toHaveLength(1);
  });

  it("pr10-verrak-opponent-activation — an opponent's activation does not trigger it", () => {
    const { ctx } = setup('pr10-verrak-opponent');
    const source = spawn(ctx, 'P2', bloodletter());
    const restore = asActive(ctx, 'P2');
    activate(ctx, 'P2', source);
    restore();
    putPendingTriggersOnStack(ctx);
    expect(ctx.state.stack).toHaveLength(1);
  });

  it('pr10-verrak-cant-pay — with too little life nothing is paid or copied', () => {
    const { ctx } = setup('pr10-verrak-poor');
    const source = spawn(ctx, 'P1', bloodletter());
    p(ctx, 'P1').life = 3;
    const original = activateWithTrigger(ctx, source);
    const asked: string[][] = [];
    pump(resolveTopOfStack(ctx), (decision) => {
      asked.push(decision.options.map((option) => option.description));
      return choose('Pay 2 life')(decision);
    });
    expect(asked.flat()).not.toContain('Pay 2 life');
    expect(p(ctx, 'P1').life).toBe(1);
    expect(ctx.state.stack.map((entry) => entry.id)).toEqual([original.id]);
  });

  it('pr10-verrak-original-left-stack — the copy is made from last known information', () => {
    const { ctx } = setup('pr10-verrak-lki');
    const source = spawn(ctx, 'P1', bloodletter());
    const before = hand(ctx, 'P1');
    const original = activateWithTrigger(ctx, source);
    // The original ability leaves the stack (as if countered) before Verrak's trigger resolves.
    ctx.state.stack = ctx.state.stack.filter((entry) => entry.id !== original.id);
    pump(resolveTopOfStack(ctx), choose('Pay 2 life'));
    settle(ctx);
    expect(hand(ctx, 'P1')).toBe(before + 1);
  });

  it('pr10-verrak-copy-is-not-activated — the copy does not trigger Verrak again', () => {
    const { ctx } = setup('pr10-verrak-once');
    const source = spawn(ctx, 'P1', bloodletter());
    activateWithTrigger(ctx, source);
    pump(resolveTopOfStack(ctx), choose('Pay 2 life'));
    putPendingTriggersOnStack(ctx);
    expect(ctx.state.stack.filter((entry) => entry.kind === 'triggeredAbility')).toHaveLength(0);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });
});
