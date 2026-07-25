/**
 * Activated abilities with non-mana costs (ADR 0010, Inc 5) — "`<costs>`: `<effect>`" (CR 602).
 *
 * The cost is what makes these different from a spell, and it is where the rules are easy to
 * get wrong. What these tests pin:
 *
 * - a `{T}` cost respects tapped-ness and summoning sickness (CR 302.6); other costs do not;
 * - costs are paid at announcement, as one indivisible act (CR 601.2h) — so sacrificing the
 *   source does NOT stop the ability resolving (CR 608.2f);
 * - a "sacrifice this" mana ability is a payment source while tapped and summoning-sick, which
 *   is the whole reason `ManaSource` carries its cost;
 * - sorcery-timed abilities are absent at instant speed;
 * - the engine never offers an ability it cannot charge for.
 */

import { describe, expect, it } from 'vitest';
import { computePriorityOptions } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import { manaSourcesFor } from '../src/state/queries';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, forest, gameConfig, mountain, oracle, pump, spawn } from './fixtures';

function pod(seed = 'activated'): GameContext {
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
  for (const p of ctx.state.players) conjure(ctx, p.id, forest(), 'library');
  return ctx;
}

const p1 = (ctx: GameContext): EnginePlayerState =>
  ctx.state.players.find((p) => p.id === 'P1') as EnginePlayerState;

/** Dragon's Hoard, verbatim: a trigger, a counter-costed draw, and a mana ability. */
const dragonsHoard = (): ReturnType<typeof oracle> =>
  oracle({
    name: "Test Hoard",
    typeLine: 'Artifact',
    manaCost: '{3}',
    power: null,
    toughness: null,
    oracleText:
      'Whenever a Dragon you control enters, put a gold counter on this artifact.\n{T}, Remove a gold counter from this artifact: Draw a card.\n{T}: Add one mana of any color.',
  });

/** Reckless Barbarian, verbatim: a mana ability whose cost is a sacrifice, not a tap. */
const recklessBarbarian = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Barbarian',
    typeLine: 'Creature — Dragon Barbarian',
    manaCost: '{1}{R}',
    power: '2',
    toughness: '2',
    oracleText: 'Sacrifice this creature: Add {R}{R}.',
  });

const dragon = (): ReturnType<typeof oracle> =>
  oracle({ name: 'Test Whelp', typeLine: 'Creature — Dragon', manaCost: '{4}{R}', power: '5', toughness: '5' });

const optionsFor = (ctx: GameContext): string[] =>
  computePriorityOptions(ctx, p1(ctx)).map((o) => o.description);

describe('parsing costs', () => {
  it("reads Dragon's Hoard as a trigger, a counter-costed ability, and a mana ability", () => {
    const hoard = interpretCard(dragonsHoard());

    expect(hoard.modeled).toBe(true);
    expect(hoard.triggers).toHaveLength(1);
    expect(hoard.manaAbilities).toHaveLength(1);
    expect(hoard.activatedAbilities).toHaveLength(1);
    expect(hoard.activatedAbilities[0]?.costs).toEqual([
      { kind: 'tap' },
      { kind: 'removeCounters', counter: 'gold', count: 1 },
    ]);
    expect(hoard.activatedAbilities[0]?.ability.effects).toEqual([{ op: 'draw', count: 1 }]);
  });

  it('records a sacrifice cost on the mana ability rather than assuming {T}', () => {
    const def = interpretCard(recklessBarbarian());

    expect(def.modeled).toBe(true);
    expect(def.manaAbilities[0]?.costs).toEqual([{ kind: 'sacrificeSelf' }]);
    expect(def.manaAbilities[0]?.units).toEqual([['R'], ['R']]);
  });

  it('refuses a mana ability that costs mana, rather than making it free', () => {
    // Paying mana to make mana would make `planPayment` recursive. Unmodeled halts loudly;
    // parsing it while ignoring the cost would hand the player free mana every turn.
    const def = interpretCard(
      oracle({
        name: 'Test Filter',
        typeLine: 'Land',
        manaCost: null,
        power: null,
        toughness: null,
        oracleText: '{1}, {T}: Add {W}{U}.',
      }),
    );

    expect(def.modeled).toBe(false);
    expect(def.manaAbilities).toHaveLength(0);
  });
});

describe('cost availability', () => {
  it('offers the ability only once its counter cost can be paid', () => {
    const ctx = pod();
    const hoard = spawn(ctx, 'P1', dragonsHoard());

    expect(optionsFor(ctx).some((d) => d.includes('Draw a card'))).toBe(false);

    hoard.counters['gold'] = 1;
    expect(optionsFor(ctx).some((d) => d.includes('Draw a card'))).toBe(true);
  });

  it('withdraws a {T} ability once the source is tapped', () => {
    const ctx = pod();
    const hoard = spawn(ctx, 'P1', dragonsHoard());
    hoard.counters['gold'] = 2;
    expect(optionsFor(ctx).some((d) => d.includes('Draw a card'))).toBe(true);

    hoard.tapped = true;
    expect(optionsFor(ctx).some((d) => d.includes('Draw a card'))).toBe(false);
  });

  it('a sacrifice-costed mana ability is available while tapped AND summoning-sick', () => {
    const ctx = pod();
    const barb = spawn(ctx, 'P1', recklessBarbarian(), { tapped: true, summoningSick: true });

    const source = manaSourcesFor(ctx, 'P1').find((s) => s.cardId === barb.cardId);
    expect(source?.units).toEqual([['R'], ['R']]);
    expect(source?.costs).toEqual([{ kind: 'sacrificeSelf' }]);
  });

  it('a {T} mana ability is NOT available while summoning-sick', () => {
    const ctx = pod();
    const tapper = oracle({
      name: 'Test Elf',
      typeLine: 'Creature — Elf Druid',
      manaCost: '{G}',
      power: '1',
      toughness: '1',
      oracleText: '{T}: Add {G}.',
    });
    const perm = spawn(ctx, 'P1', tapper, { summoningSick: true });

    expect(manaSourcesFor(ctx, 'P1').some((s) => s.cardId === perm.cardId)).toBe(false);
  });
});

describe('paying and resolving', () => {
  it('charges the cost and resolves the effect', () => {
    const ctx = pod();
    const hoard = spawn(ctx, 'P1', dragonsHoard());
    hoard.counters['gold'] = 2;
    const before = p1(ctx).hand.length;

    pump(runPrioritySequence(ctx), (d) => {
      const i = d.options.findIndex((o) => o.description.includes('Draw a card'));
      return { index: i >= 0 ? i : 0, targets: new Map() };
    });

    expect(hoard.tapped).toBe(true);
    expect(hoard.counters['gold']).toBe(1);
    expect(p1(ctx).hand.length).toBe(before + 1);
  });

  it('resolves even though the cost sacrificed the source (CR 608.2f)', () => {
    const ctx = pod();
    // A sacrifice-costed mana ability is the only Inc-5 card that removes its own source, so
    // spend it on a real cost and check both halves: the source is gone, the mana was made.
    const barb = spawn(ctx, 'P1', recklessBarbarian());
    const bolt = oracle({
      name: 'Test Bolt',
      typeLine: 'Instant',
      manaCost: '{R}{R}',
      power: null,
      toughness: null,
      oracleText: 'Test Bolt deals 3 damage to any target.',
    });
    conjure(ctx, 'P1', bolt, 'hand');

    pump(runPrioritySequence(ctx), (d) => {
      const i = d.options.findIndex((o) => o.description.includes('Cast Test Bolt'));
      if (i < 0) return { index: 0, targets: new Map() };
      // Target an opponent, not a permanent: the only creature on the board is the Barbarian,
      // and sacrificing it to pay would then (correctly) fizzle the spell.
      const slot = d.options[i]?.targets?.[0];
      const player = slot?.options.find((o) => o === 'P2');
      return { index: i, targets: new Map(player === undefined ? [] : [[0, player]]) };
    });

    expect(ctx.state.battlefield.some((p) => p.cardId === barb.cardId)).toBe(false);
    expect(p1(ctx).graveyard.some((c) => c.name === 'Test Barbarian')).toBe(true);
    expect(ctx.state.eventLog.some((e) => e.type === 'sacrifice')).toBe(true);
    // The spell was paid for by the sacrifice and still resolved.
    expect(ctx.state.players.find((p) => p.id === 'P2')?.life).toBe(37);
  });

  it('the gold-counter trigger and the draw ability compose over a real turn', () => {
    const ctx = pod();
    const hoard = spawn(ctx, 'P1', dragonsHoard());
    spawn(ctx, 'P1', mountain());

    // A Dragon entering adds the counter that pays for the draw.
    const whelp = conjure(ctx, 'P1', dragon(), 'hand');
    pump(moveObject(ctx, whelp, { zone: 'battlefield', controllerId: 'P1' }));
    expect(ctx.state.pendingTriggers).toHaveLength(1);

    pump(runPrioritySequence(ctx));
    expect(hoard.counters['gold']).toBe(1);
  });
});

describe('timing', () => {
  it('offers a sorcery-timed ability only at sorcery speed', () => {
    const ctx = pod();
    const slow = oracle({
      name: 'Test Slowpoke',
      typeLine: 'Artifact',
      manaCost: '{2}',
      power: null,
      toughness: null,
      oracleText: '{T}: You gain 2 life. Activate only as a sorcery.',
    });
    spawn(ctx, 'P1', slow);

    expect(optionsFor(ctx).some((d) => d.includes('gain 2 life'))).toBe(true);

    // A non-empty stack ends the sorcery-speed window (CR 602.5d).
    ctx.state.phase = 'ending';
    ctx.state.step = 'end';
    expect(optionsFor(ctx).some((d) => d.includes('gain 2 life'))).toBe(false);
  });
});
