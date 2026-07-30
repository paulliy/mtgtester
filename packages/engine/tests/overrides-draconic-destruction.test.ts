/**
 * Behavioral tests for the Draconic Destruction precon's authored overrides
 * (`packages/engine/src/cards/overrides/draconic-destruction.ts`, ADR 0009/0010).
 *
 * Each `describe` block pins one card's actual mechanical behavior — never just
 * `modeled === true` (the overrides module comment's rule 3).
 */

import { describe, expect, it } from 'vitest';
import { computePriorityOptions } from '../src/actions/legal';
import { runCombatPhase } from '../src/combat/combat';
import { computeCharacteristics } from '../src/effects/continuous';
import { endUntilEotEffects, executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { runPrioritySequence } from '../src/turn/priority';
import { moveObject } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { conjure, forest, copies, gameConfig, mountain, oracle, pump, spawn } from './fixtures';

function pod(seed = 'draconic-destruction-overrides'): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(3, forest) })),
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

const handSize = (ctx: GameContext, id: string): number =>
  ctx.state.players.find((p) => p.id === id)?.hand.length ?? 0;

/** Declare every eligible attacker against P2 and run combat to completion. */
function attackAll(ctx: GameContext): void {
  ctx.state.phase = 'combat';
  ctx.state.step = null;
  pump(runCombatPhase(ctx), (d) => {
    const all = d.options.findIndex((o) => o.description.includes('undeclared creatures'));
    if (all >= 0 && d.options[all]?.description.includes('P2') === true) {
      return { index: all, targets: new Map() };
    }
    const one = d.options.findIndex((o) => /attacks P2/.test(o.description));
    if (one >= 0) return { index: one, targets: new Map() };
    return { index: 0, targets: new Map() };
  });
}

describe('Dragon Mage', () => {
  const dragonMage = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Dragon Mage',
      oracleId: 'oracle-dragon-mage',
      typeLine: 'Creature — Dragon Wizard',
      manaCost: '{5}{R}{R}',
      power: '5',
      toughness: '5',
      oracleText:
        'Flying\nWhenever Dragon Mage deals combat damage to a player, each player discards their hand, then draws seven cards.',
    });

  it('when it connects, every player discards their hand and draws seven', () => {
    const ctx = pod();
    spawn(ctx, 'P1', dragonMage());

    // Fill every hand with a few library-backed cards so "discard hand" has something in it,
    // and enough library so seven-card draws don't hit an empty deck.
    for (const p of ctx.state.players) {
      for (let i = 0; i < 3; i++) conjure(ctx, p.id, forest(), 'hand');
      for (let i = 0; i < 10; i++) conjure(ctx, p.id, forest(), 'library');
    }
    const handsBefore = ctx.state.players.map((p) => handSize(ctx, p.id));
    expect(handsBefore.every((n) => n === 3)).toBe(true);

    attackAll(ctx);

    for (const p of ctx.state.players) {
      expect(handSize(ctx, p.id)).toBe(7);
    }
    // The three original hand cards were discarded, not drawn back into a fresh top-of-library.
    const p1 = ctx.state.players.find((p) => p.id === 'P1')!;
    expect(p1.graveyard.length).toBe(3);
  });
});

describe('Dream Pillager', () => {
  const dreamPillager = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Dream Pillager',
      oracleId: 'oracle-dream-pillager',
      typeLine: 'Creature — Dragon',
      manaCost: '{5}{R}{R}',
      power: '4',
      toughness: '4',
      oracleText:
        'Flying\nWhenever Dream Pillager deals combat damage to a player, exile that many cards from the top of your library. Until end of turn, you may cast spells from among those exiled cards.',
    });

  const testShock = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Test Shock',
      typeLine: 'Instant',
      manaCost: '{R}',
      power: null,
      toughness: null,
      oracleText: 'Test Shock deals 2 damage to any target.',
    });

  it('exiles cards equal to the damage dealt and lets its controller cast one of them', () => {
    const ctx = pod();
    spawn(ctx, 'P1', dreamPillager());
    spawn(ctx, 'P1', mountain());
    // `conjure(..., 'library')` unshifts, so the LAST card conjured ends up on top.
    for (let i = 0; i < 5; i++) conjure(ctx, 'P1', forest(), 'library');
    const shock = conjure(ctx, 'P1', testShock(), 'library');

    attackAll(ctx);

    // Exactly 4 cards (Dream Pillager's power) came off the top of the library into exile,
    // playable by P1 until end of turn — starting with the Shock that was on top.
    expect(ctx.state.exile.filter((c) => c.playableUntilEotBy === 'P1')).toHaveLength(4);
    expect(ctx.state.exile.some((c) => c.cardId === shock.cardId)).toBe(true);

    const p2Before = ctx.state.players.find((p) => p.id === 'P2')?.life;
    pump(runPrioritySequence(ctx), (d) => {
      const i = d.options.findIndex((o) => o.description.includes('Cast Test Shock'));
      if (i < 0) return { index: 0, targets: new Map() };
      const slot = d.options[i]?.targets?.[0];
      const target = slot?.options.find((o) => o === 'P2');
      return { index: i, targets: new Map(target === undefined ? [] : [[0, target]]) };
    });

    expect(ctx.state.players.find((p) => p.id === 'P2')?.life).toBe((p2Before ?? 0) - 2);
    // Cast from exile, then resolved to the graveyard like any other instant.
    expect(ctx.state.exile.some((c) => c.cardId === shock.cardId)).toBe(false);
    const p1 = ctx.state.players.find((p) => p.id === 'P1')!;
    expect(p1.graveyard.some((c) => c.cardId === shock.cardId)).toBe(true);
  });

  it('the grant expires at cleanup, and the cards stay in exile unplayable', () => {
    const ctx = pod();
    spawn(ctx, 'P1', dreamPillager());
    spawn(ctx, 'P1', mountain());
    // `conjure(..., 'library')` unshifts, so the LAST card conjured ends up on top.
    for (let i = 0; i < 5; i++) conjure(ctx, 'P1', forest(), 'library');
    const shock = conjure(ctx, 'P1', testShock(), 'library');

    attackAll(ctx);
    expect(ctx.state.exile.find((c) => c.cardId === shock.cardId)?.playableUntilEotBy).toBe('P1');

    // Simulate the cleanup sweep directly rather than driving a full extra turn.
    endUntilEotEffects(ctx);

    const stillExiled = ctx.state.exile.find((c) => c.cardId === shock.cardId);
    expect(stillExiled).toBeDefined();
    expect(stillExiled?.playableUntilEotBy).toBeUndefined();
  });
});

describe('Runehorn Hellkite', () => {
  const runehornHellkite = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Runehorn Hellkite',
      oracleId: 'oracle-runehorn-hellkite',
      typeLine: 'Creature — Dragon',
      manaCost: '{4}{R}{R}',
      power: '5',
      toughness: '5',
      oracleText:
        'Flying\n{5}{R}, Exile this card from your graveyard: Each player discards their hand, then draws seven cards.',
    });

  it('exiling it from the graveyard wheels every hand', () => {
    const ctx = pod();
    for (let i = 0; i < 6; i++) spawn(ctx, 'P1', mountain());
    const inGrave = conjure(ctx, 'P1', runehornHellkite(), 'graveyard');

    for (const p of ctx.state.players) {
      for (let i = 0; i < 3; i++) conjure(ctx, p.id, forest(), 'hand');
      for (let i = 0; i < 10; i++) conjure(ctx, p.id, forest(), 'library');
    }

    pump(runPrioritySequence(ctx), (d) => {
      const i = d.options.findIndex((o) => o.description.includes('discards their hand'));
      return { index: i >= 0 ? i : 0, targets: new Map() };
    });

    for (const p of ctx.state.players) {
      expect(p.hand.length).toBe(7);
    }
    const p1 = ctx.state.players.find((p) => p.id === 'P1')!;
    // Paid for by exiling itself from the graveyard, not left sitting there or destroyed again.
    expect(p1.graveyard.some((c) => c.cardId === inGrave.cardId)).toBe(false);
    expect(ctx.state.exile.some((c) => c.cardId === inGrave.cardId)).toBe(true);
  });
});

describe('Spit Flame', () => {
  const spitFlame = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Spit Flame',
      oracleId: 'oracle-spit-flame',
      typeLine: 'Instant',
      manaCost: '{2}{R}',
      power: null,
      toughness: null,
      oracleText:
        'Spit Flame deals 4 damage to target creature.\nWhenever a Dragon you control enters, you may pay {R}. If you do, return this card from your graveyard to your hand.',
    });

  const dragon = (): ReturnType<typeof oracle> =>
    oracle({ name: 'Test Whelp', typeLine: 'Creature — Dragon', manaCost: '{4}{R}', power: '5', toughness: '5' });

  it('returns itself from the graveyard when its controller pays {R} as a Dragon enters', () => {
    const ctx = pod();
    spawn(ctx, 'P1', mountain());
    const inGrave = conjure(ctx, 'P1', spitFlame(), 'graveyard');
    const whelp = conjure(ctx, 'P1', dragon(), 'hand');

    pump(moveObject(ctx, whelp, { zone: 'battlefield', controllerId: 'P1' }));
    expect(ctx.state.pendingTriggers).toHaveLength(1);

    pump(runPrioritySequence(ctx), (d) => {
      const i = d.options.findIndex((o) => o.type === 'payMana');
      return { index: i >= 0 ? i : 0, targets: new Map() };
    });

    const p1 = ctx.state.players.find((p) => p.id === 'P1')!;
    expect(p1.graveyard.some((c) => c.cardId === inGrave.cardId)).toBe(false);
    expect(p1.hand.some((c) => c.cardId === inGrave.cardId)).toBe(true);
  });

  it('declining the payment leaves it in the graveyard', () => {
    const ctx = pod();
    spawn(ctx, 'P1', mountain());
    const inGrave = conjure(ctx, 'P1', spitFlame(), 'graveyard');
    const whelp = conjure(ctx, 'P1', dragon(), 'hand');

    pump(moveObject(ctx, whelp, { zone: 'battlefield', controllerId: 'P1' }));

    pump(runPrioritySequence(ctx), (d) => {
      const decline = d.options.findIndex((o) => o.type === 'decline');
      return { index: decline >= 0 ? decline : 0, targets: new Map() };
    });

    const p1 = ctx.state.players.find((p) => p.id === 'P1')!;
    expect(p1.graveyard.some((c) => c.cardId === inGrave.cardId)).toBe(true);
  });
});

describe('Primal Might', () => {
  const primalMight = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Primal Might',
      oracleId: 'oracle-primal-might',
      typeLine: 'Sorcery',
      manaCost: '{X}{G}',
      power: null,
      toughness: null,
      oracleText:
        "Target creature you control gets +X/+X until end of turn. Then it fights up to one target creature you don't control.",
    });

  it('pumps the target by X and fights the chosen opposing creature', () => {
    const ctx = pod();
    for (let i = 0; i < 3; i++) spawn(ctx, 'P1', forest());
    const bearCard = oracle({ name: 'Test Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' });
    const ogreCard = oracle({ name: 'Test Ogre', typeLine: 'Creature — Ogre', power: '3', toughness: '3' });
    const bear = spawn(ctx, 'P1', bearCard);
    const ogre = spawn(ctx, 'P2', ogreCard);
    conjure(ctx, 'P1', primalMight(), 'hand');

    pump(runPrioritySequence(ctx), (d) => {
      if (d.decisionType === 'general' && /choose (a|another) target/.test(d.prompt)) {
        const idx = d.options.findIndex((o) => o.description.includes('Test Ogre'));
        return { index: idx >= 0 ? idx : d.options.length - 1, targets: new Map() };
      }
      const i = d.options.findIndex(
        (o) => o.description.includes('Cast Primal Might') && o.description.includes('X=2'),
      );
      if (i >= 0) {
        const slot = d.options[i]?.targets?.[0];
        const target = slot?.options.find((id) => id === bear.id);
        return { index: i, targets: new Map(target === undefined ? [] : [[0, target]]) };
      }
      return { index: 0, targets: new Map() };
    });

    // +2/+2 until end of turn: 2/2 -> 4/4, then it fights the Ogre — 4 damage out, 3 back.
    expect(bear.damageMarked).toBe(3);
    expect(ogre.damageMarked).toBe(4);
    expect(ctx.state.battlefield.some((p) => p.cardId === ogre.cardId)).toBe(false);
    expect(ctx.state.battlefield.some((p) => p.cardId === bear.cardId)).toBe(true);
  });

  it('with no legal opposing creature, still offers the cast and just pumps', () => {
    const ctx = pod();
    for (let i = 0; i < 3; i++) spawn(ctx, 'P1', forest());
    const bearCard = oracle({ name: 'Test Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' });
    const bear = spawn(ctx, 'P1', bearCard);
    conjure(ctx, 'P1', primalMight(), 'hand');

    pump(runPrioritySequence(ctx), (d) => {
      const i = d.options.findIndex(
        (o) => o.description.includes('Cast Primal Might') && o.description.includes('X=2'),
      );
      if (i >= 0) {
        const slot = d.options[i]?.targets?.[0];
        const target = slot?.options.find((id) => id === bear.id);
        return { index: i, targets: new Map(target === undefined ? [] : [[0, target]]) };
      }
      return { index: 0, targets: new Map() };
    });

    expect(ctx.state.battlefield.some((p) => p.cardId === bear.cardId)).toBe(true);
    expect(bear.damageMarked).toBe(0);
  });
});

describe('Foe-Razer Regent', () => {
  const foeRazerRegent = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Foe-Razer Regent',
      oracleId: 'oracle-foe-razer-regent',
      typeLine: 'Creature — Dragon',
      manaCost: '{5}{G}{G}',
      power: '4',
      toughness: '5',
      oracleText:
        "Flying\nWhen ~ enters, you may have it fight target creature you don't control.\nWhenever a creature you control fights, put two +1/+1 counters on it at the beginning of the next end step.",
    });

  it('fights an opposing creature on ETB and gets two +1/+1 counters at the next end step', () => {
    const ctx = pod();
    const ogreCard = oracle({ name: 'Test Ogre', typeLine: 'Creature — Ogre', power: '3', toughness: '4' });
    const ogre = spawn(ctx, 'P2', ogreCard);
    const regent = spawn(ctx, 'P1', foeRazerRegent());

    // Queue and resolve the ETB trigger by hand (mirrors the Kiora/Drakuseth harness pattern):
    // accept the "you may", then choose the Ogre as the fight target.
    ctx.state.pendingTriggers.push({
      controllerId: 'P1',
      sourceCardId: regent.cardId,
      sourceOracleId: regent.oracleId,
      sourceName: regent.name,
      ability: ctx.defs.get(regent.oracleId)!.triggers.find((t) => t.trigger?.when === 'enters')!,
    });

    pump(runPrioritySequence(ctx), (d) => {
      if (d.decisionType === 'optionalTrigger') {
        const yes = d.options.findIndex((o) => o.type === 'acceptTrigger');
        return { index: yes, targets: new Map() };
      }
      if (d.decisionType === 'chooseTargets') {
        return { index: 0, targets: new Map([[0, ogre.id]]) };
      }
      return { index: 0, targets: new Map() };
    });

    // Fight: Regent (4 power) deals 4 to the 4-toughness Ogre — dead. Ogre (3 power) deals 3
    // to Regent, who survives at 5 toughness.
    expect(ctx.state.battlefield.some((p) => p.cardId === ogre.cardId)).toBe(false);
    expect(regent.damageMarked).toBe(3);
    expect(regent.counters['+1/+1'] ?? 0).toBe(0);

    // The fights-trigger should already have registered a delayed "at the next end step" —
    // simulate that end step the same way delayed-triggers.test.ts does, by firing it directly.
    expect(ctx.state.delayedTriggers).toHaveLength(1);
    expect(ctx.state.delayedTriggers[0]?.when).toBe('endStep');
    const delayed = ctx.state.delayedTriggers.pop()!;
    pump(
      executeAbility(
        ctx,
        {
          cardId: delayed.sourceCardId,
          name: 'Delayed Trigger',
          oracleId: delayed.sourceOracleId,
          controllerId: delayed.controllerId,
        },
        delayed.ability,
        [],
        delayed.targetId,
      ),
    );
    expect(regent.counters['+1/+1']).toBe(2);
  });
});

describe('Hoard-Smelter Dragon', () => {
  const hoardSmelterDragon = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Hoard-Smelter Dragon',
      oracleId: 'oracle-hoard-smelter-dragon',
      typeLine: 'Creature — Dragon',
      manaCost: '{4}{R}{R}',
      power: '5',
      toughness: '5',
      oracleText:
        "Flying\n{3}{R}: Destroy target artifact. This creature gets +X/+0 until end of turn, where X is that artifact's mana value.",
    });

  it('destroys the artifact and pumps by its mana value', () => {
    const ctx = pod();
    for (let i = 0; i < 4; i++) spawn(ctx, 'P1', mountain());
    const dragon = spawn(ctx, 'P1', hoardSmelterDragon());
    const sol = spawn(ctx, 'P2', oracle({ name: 'Test Rock', typeLine: 'Artifact', manaCost: '{5}', power: null, toughness: null }));

    pump(runPrioritySequence(ctx), (d) => {
      const i = d.options.findIndex((o) => o.description.includes('Hoard-Smelter Dragon'));
      if (i < 0) return { index: 0, targets: new Map() };
      const slot = d.options[i]?.targets?.[0];
      const target = slot?.options.find((id) => id === sol.id);
      return { index: i, targets: new Map(target === undefined ? [] : [[0, target]]) };
    });

    expect(ctx.state.battlefield.some((p) => p.cardId === sol.cardId)).toBe(false);
    // +5/+0 until end of turn: 5/5 -> 10/5.
    const pt = ctx.state.effects.filter((e) => e.targetCardIds.includes(dragon.cardId));
    expect(pt.some((e) => e.kind === 'ptDelta' && e.power === 5 && e.toughness === 0)).toBe(true);
  });
});

describe('Steel Hellkite', () => {
  const steelHellkite = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Steel Hellkite',
      oracleId: 'oracle-steel-hellkite',
      typeLine: 'Artifact Creature — Dragon',
      manaCost: '{6}',
      power: '5',
      toughness: '5',
      oracleText:
        'Flying\n{2}: This creature gets +1/+0 until end of turn.\n{X}: Destroy each nonland permanent with mana value X whose controller was dealt combat damage by this creature this turn. Activate only once each turn.',
    });

  it('{2} pumps itself +1/+0 until end of turn', () => {
    // Executed directly (like the Kiora ability-resolution tests) rather than through the full
    // priority menu: outside combat, `computePriorityOptions` deliberately hides pure pump/
    // keyword-grant abilities as "combat tricks with no relevant window" (legal.ts), so driving
    // this through `runPrioritySequence` would need to fake an actual attack in progress. What
    // this test pins is simpler: does the ABILITY itself apply the right pump.
    const ctx = pod();
    const hellkite = spawn(ctx, 'P1', steelHellkite());
    const ability = ctx.defs.get(hellkite.oracleId)!.activatedAbilities[0]!.ability;

    pump(
      executeAbility(
        ctx,
        { cardId: hellkite.cardId, name: hellkite.name, oracleId: hellkite.oracleId, controllerId: 'P1' },
        ability,
        [],
      ),
    );

    const pt = ctx.state.effects.filter((e) => e.targetCardIds.includes(hellkite.cardId));
    expect(pt.some((e) => e.kind === 'ptDelta' && e.power === 1 && e.toughness === 0)).toBe(true);
  });

  it('{X} destroys only the damaged opponent\'s nonland permanents with mana value X', () => {
    const ctx = pod();
    for (let i = 0; i < 3; i++) spawn(ctx, 'P1', mountain());
    const hellkite = spawn(ctx, 'P1', steelHellkite());

    const mv3Artifact = (name: string) =>
      oracle({ name, typeLine: 'Artifact', manaCost: '{3}', power: null, toughness: null });
    const p2Match1 = spawn(ctx, 'P2', mv3Artifact('P2 MV3 A'));
    const p2Match2 = spawn(ctx, 'P2', mv3Artifact('P2 MV3 B'));
    const p2Mismatch = spawn(ctx, 'P2', oracle({ name: 'P2 MV4', typeLine: 'Artifact', manaCost: '{4}', power: null, toughness: null }));
    const p2Land = spawn(ctx, 'P2', mountain());
    const p1Own = spawn(ctx, 'P1', mv3Artifact('P1 MV3, not damaged by Hellkite'));

    attackAll(ctx); // Steel Hellkite (flying, unblocked) deals combat damage to P2.
    expect(ctx.state.combatDamagePlayersBySource[hellkite.cardId]).toEqual(['P2']);

    pump(runPrioritySequence(ctx), (d) => {
      const i = d.options.findIndex((o) => o.description.includes('X=3'));
      return { index: i >= 0 ? i : 0, targets: new Map() };
    });

    const onBoard = (p: { cardId: string }): boolean =>
      ctx.state.battlefield.some((perm) => perm.cardId === p.cardId);
    expect(onBoard(p2Match1)).toBe(false);
    expect(onBoard(p2Match2)).toBe(false);
    expect(onBoard(p2Mismatch)).toBe(true); // wrong mana value
    expect(onBoard(p2Land)).toBe(true); // land, excluded
    expect(onBoard(p1Own)).toBe(true); // P1 was never dealt damage BY the Hellkite
  });
});

describe('Thunderbreak Regent', () => {
  const thunderbreakRegent = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Thunderbreak Regent',
      oracleId: 'oracle-thunderbreak-regent',
      typeLine: 'Creature — Dragon',
      manaCost: '{2}{R}{R}',
      power: '4',
      toughness: '4',
      oracleText:
        'Flying\nWhenever a Dragon you control becomes the target of a spell or ability an opponent controls, ~ deals 3 damage to that player.',
    });

  const testShock = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Test Shock',
      typeLine: 'Instant',
      manaCost: '{R}',
      power: null,
      toughness: null,
      oracleText: 'Test Shock deals 2 damage to any target.',
    });

  it('deals 3 damage to an opponent who targets the watched Dragon with a spell', () => {
    const ctx = pod();
    const regent = spawn(ctx, 'P1', thunderbreakRegent());
    spawn(ctx, 'P2', mountain());
    conjure(ctx, 'P2', testShock(), 'hand');

    const p1LifeBefore = ctx.state.players.find((p) => p.id === 'P1')?.life ?? 0;
    const p2LifeBefore = ctx.state.players.find((p) => p.id === 'P2')?.life ?? 0;

    pump(runPrioritySequence(ctx), (d) => {
      const i = d.options.findIndex((o) => o.description.includes('Cast Test Shock'));
      if (i < 0) return { index: 0, targets: new Map() };
      const slot = d.options[i]?.targets?.[0];
      const target = slot?.options.find((id) => id === regent.id);
      return { index: i, targets: new Map(target === undefined ? [] : [[0, target]]) };
    });

    // The Shock still deals its 2 to the Regent, and the Regent's trigger hits the opponent
    // (P2, the Shock's controller) for 3 — not P1, its own controller.
    expect(regent.damageMarked).toBe(2);
    expect(ctx.state.players.find((p) => p.id === 'P2')?.life).toBe(p2LifeBefore - 3);
    expect(ctx.state.players.find((p) => p.id === 'P1')?.life).toBe(p1LifeBefore);
  });

  it("does not fire when its own controller targets it", () => {
    const ctx = pod();
    const regent = spawn(ctx, 'P1', thunderbreakRegent());
    spawn(ctx, 'P1', mountain());
    conjure(ctx, 'P1', testShock(), 'hand');

    const p1LifeBefore = ctx.state.players.find((p) => p.id === 'P1')?.life ?? 0;

    pump(runPrioritySequence(ctx), (d) => {
      const i = d.options.findIndex((o) => o.description.includes('Cast Test Shock'));
      if (i < 0) return { index: 0, targets: new Map() };
      const slot = d.options[i]?.targets?.[0];
      const target = slot?.options.find((id) => id === regent.id);
      return { index: i, targets: new Map(target === undefined ? [] : [[0, target]]) };
    });

    expect(regent.damageMarked).toBe(2);
    // No self-inflicted trigger damage: P1 only lost life to nothing here.
    expect(ctx.state.players.find((p) => p.id === 'P1')?.life).toBe(p1LifeBefore);
  });
});

describe('Dragonkin Berserker', () => {
  const dragonkinBerserker = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Dragonkin Berserker',
      oracleId: 'oracle-dragonkin-berserker',
      typeLine: 'Creature — Human Berserker',
      manaCost: '{1}{R}',
      power: '2',
      toughness: '2',
      oracleText:
        'First strike\nBoast abilities you activate cost {1} less to activate for each Dragon you control.\nBoast — {4}{R}: Create a 5/5 red Dragon creature token with flying. (Activate only if this creature attacked this turn and only once each turn.)',
    });

  const otherDragon = (): ReturnType<typeof oracle> =>
    oracle({ name: 'Test Whelp', typeLine: 'Creature — Dragon', power: '1', toughness: '1' });

  it('cannot Boast before attacking, even with mana available', () => {
    const ctx = pod();
    for (let i = 0; i < 5; i++) spawn(ctx, 'P1', mountain());
    spawn(ctx, 'P1', dragonkinBerserker());

    const options = computePriorityOptions(ctx, ctx.state.players.find((p) => p.id === 'P1')!);
    expect(options.some((o) => o.description.includes('create a 5/5'))).toBe(false);
  });

  it('Boasting after attacking costs {1} less per Dragon controlled and makes a 5/5 flying Dragon', () => {
    const ctx = pod();
    for (let i = 0; i < 4; i++) spawn(ctx, 'P1', mountain()); // exactly {3}{R} worth — no more.
    const berserker = spawn(ctx, 'P1', dragonkinBerserker());
    spawn(ctx, 'P1', otherDragon()); // one other Dragon controlled: -{1}.

    attackAll(ctx); // Berserker attacks P2, satisfying "attacked this turn".
    const tokensBefore = ctx.state.battlefield.filter((p) => p.name === 'Dragon').length;

    pump(runPrioritySequence(ctx), (d) => {
      const i = d.options.findIndex((o) => o.description.includes('create a 5/5'));
      return { index: i >= 0 ? i : 0, targets: new Map() };
    });

    const tokens = ctx.state.battlefield.filter((p) => p.name === 'Dragon' && p.cardId !== berserker.cardId);
    expect(tokens.length).toBe(tokensBefore + 1);
    const token = tokens[tokens.length - 1]!;
    expect(token.power).toBe(5);
    expect(token.toughness).toBe(5);
    expect(token.isToken).toBe(true);
  });
});

describe('Flameblast Dragon', () => {
  const flameblastDragon = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Flameblast Dragon',
      oracleId: 'oracle-flameblast-dragon',
      typeLine: 'Creature — Dragon',
      manaCost: '{4}{R}{R}',
      power: '5',
      toughness: '5',
      oracleText: 'Flying\nWhenever ~ attacks, you may pay {X}{R}. If you do, it deals X damage to any target.',
    });

  it('paying {X}{R} on attack deals X damage to the chosen target', () => {
    const ctx = pod();
    for (let i = 0; i < 3; i++) spawn(ctx, 'P1', mountain());
    const dragon = spawn(ctx, 'P1', flameblastDragon());

    const p2LifeBefore = ctx.state.players.find((p) => p.id === 'P2')?.life ?? 0;

    ctx.state.phase = 'combat';
    ctx.state.step = null;
    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'chooseTargets') return { index: 0, targets: new Map([[0, 'P2']]) };
      if (d.decisionType === 'general' && d.prompt.includes('choose X')) {
        const i = d.options.findIndex((o) => o.description.includes('X=2'));
        return { index: i >= 0 ? i : 0, targets: new Map() };
      }
      const all = d.options.findIndex((o) => o.description.includes('undeclared creatures'));
      if (all >= 0 && d.options[all]?.description.includes('P2') === true) {
        return { index: all, targets: new Map() };
      }
      const one = d.options.findIndex((o) => /attacks P2/.test(o.description));
      if (one >= 0) return { index: one, targets: new Map() };
      return { index: 0, targets: new Map() };
    });

    // Combat damage (5, unblocked) + the paid X=2 = 7 total life loss.
    expect(ctx.state.players.find((p) => p.id === 'P2')?.life).toBe(p2LifeBefore - 5 - 2);
    expect(dragon.tapped).toBe(true);
  });

  it('declining the payment deals no bonus damage', () => {
    const ctx = pod();
    for (let i = 0; i < 3; i++) spawn(ctx, 'P1', mountain());
    spawn(ctx, 'P1', flameblastDragon());
    const p2LifeBefore = ctx.state.players.find((p) => p.id === 'P2')?.life ?? 0;

    ctx.state.phase = 'combat';
    ctx.state.step = null;
    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'chooseTargets') return { index: 0, targets: new Map([[0, 'P2']]) };
      if (d.decisionType === 'general' && d.prompt.includes('choose X')) {
        const decline = d.options.findIndex((o) => o.type === 'decline');
        return { index: decline, targets: new Map() };
      }
      const all = d.options.findIndex((o) => o.description.includes('undeclared creatures'));
      if (all >= 0 && d.options[all]?.description.includes('P2') === true) {
        return { index: all, targets: new Map() };
      }
      const one = d.options.findIndex((o) => /attacks P2/.test(o.description));
      if (one >= 0) return { index: one, targets: new Map() };
      return { index: 0, targets: new Map() };
    });

    // Only the 5 unblocked combat damage — no extra from the declined trigger.
    expect(ctx.state.players.find((p) => p.id === 'P2')?.life).toBe(p2LifeBefore - 5);
  });
});

describe('Loaming Shaman', () => {
  const loamingShaman = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Loaming Shaman',
      oracleId: 'oracle-loaming-shaman',
      typeLine: 'Creature — Centaur Shaman',
      manaCost: '{2}{G}',
      power: '3',
      toughness: '2',
      oracleText:
        'When ~ enters the battlefield, target player shuffles any number of target cards from their graveyard into their library.',
    });

  it("shuffles all chosen cards from the TARGET player's graveyard into their library, leaving the caster's own alone", () => {
    const ctx = pod();
    const p2Card1 = conjure(ctx, 'P2', forest(), 'graveyard');
    const p2Card2 = conjure(ctx, 'P2', mountain(), 'graveyard');
    const p1Card = conjure(ctx, 'P1', forest(), 'graveyard'); // must be left untouched.
    for (let i = 0; i < 3; i++) conjure(ctx, 'P2', forest(), 'library');

    const shamanCard = conjure(ctx, 'P1', loamingShaman(), 'hand');
    pump(moveObject(ctx, shamanCard, { zone: 'battlefield', controllerId: 'P1' }));
    expect(ctx.state.pendingTriggers).toHaveLength(1);

    pump(runPrioritySequence(ctx), (d) => {
      if (d.decisionType === 'chooseTargets') return { index: 0, targets: new Map([[0, 'P2']]) };
      if (d.decisionType === 'general' && /choose (a|another) target/.test(d.prompt)) {
        const pick = d.options.findIndex((o) => o.type === 'pickTarget');
        return { index: pick >= 0 ? pick : 0, targets: new Map() };
      }
      return { index: 0, targets: new Map() };
    });

    const p1 = ctx.state.players.find((p) => p.id === 'P1')!;
    const p2 = ctx.state.players.find((p) => p.id === 'P2')!;
    expect(p2.graveyard.some((c) => c.cardId === p2Card1.cardId)).toBe(false);
    expect(p2.graveyard.some((c) => c.cardId === p2Card2.cardId)).toBe(false);
    expect(p2.library.some((c) => c.cardId === p2Card1.cardId)).toBe(true);
    expect(p2.library.some((c) => c.cardId === p2Card2.cardId)).toBe(true);
    // Never touched P1's own graveyard: graveyardOwnerSlot correctly followed the CHOSEN
    // player (P2), not the ability's controller.
    expect(p1.graveyard.some((c) => c.cardId === p1Card.cardId)).toBe(true);
  });

  it('choosing zero cards still shuffles the library', () => {
    const ctx = pod();
    conjure(ctx, 'P2', forest(), 'graveyard');
    for (let i = 0; i < 3; i++) conjure(ctx, 'P2', forest(), 'library');
    const shamanCard = conjure(ctx, 'P1', loamingShaman(), 'hand');
    pump(moveObject(ctx, shamanCard, { zone: 'battlefield', controllerId: 'P1' }));

    let sawShuffleEvent = false;
    pump(runPrioritySequence(ctx), (d) => {
      if (d.decisionType === 'chooseTargets') return { index: 0, targets: new Map([[0, 'P2']]) };
      if (d.decisionType === 'general' && /choose (a|another) target/.test(d.prompt)) {
        const decline = d.options.findIndex((o) => o.type === 'decline');
        return { index: decline >= 0 ? decline : 0, targets: new Map() };
      }
      return { index: 0, targets: new Map() };
    });
    sawShuffleEvent = ctx.state.eventLog.some((e) => e.type === 'shuffle' && e.payload['player'] === 'P2');
    expect(sawShuffleEvent).toBe(true);

    const p2 = ctx.state.players.find((p) => p.id === 'P2')!;
    expect(p2.graveyard.length).toBe(1); // declined — nothing moved.
  });
});

describe('Atarka Monument', () => {
  const atarkaMonument = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Atarka Monument',
      oracleId: 'oracle-atarka-monument',
      typeLine: 'Artifact',
      manaCost: '{3}',
      power: null,
      toughness: null,
      oracleText:
        '{T}: Add {R} or {G}.\n{4}{R}{G}: ~ becomes a 4/4 red and green Dragon artifact creature with flying until end of turn.',
    });

  it('becomes a 4/4 flying Dragon artifact creature until end of turn, then reverts', () => {
    const ctx = pod();
    for (let i = 0; i < 6; i++) spawn(ctx, 'P1', mountain());
    const monument = spawn(ctx, 'P1', atarkaMonument());

    expect(computeCharacteristics(ctx, monument).types).not.toContain('Creature');

    pump(runPrioritySequence(ctx), (d) => {
      const i = d.options.findIndex((o) => o.description.includes('becomes a 4/4'));
      return { index: i >= 0 ? i : 0, targets: new Map() };
    });

    const chars = computeCharacteristics(ctx, monument);
    expect(chars.types).toContain('Artifact');
    expect(chars.types).toContain('Creature');
    expect(chars.subtypes).toContain('Dragon');
    expect(chars.power).toBe(4);
    expect(chars.toughness).toBe(4);
    expect(chars.keywords).toContain('flying');

    endUntilEotEffects(ctx);
    const after = computeCharacteristics(ctx, monument);
    expect(after.types).not.toContain('Creature');
  });
});
