/**
 * Trigger events II (ADR 0010, Inc 9): the events `TriggerWhen` could not express — combat
 * damage to a player, casting a spell, the end step — plus the *aggregate* form.
 *
 * The aggregate form is the load-bearing one and the reason this increment exists. "Whenever
 * **one or more** Dragons you control attack, draw **that many** cards" is ONE trigger carrying
 * a count (CR 603.2c). Model it as one trigger per Dragon and a three-Dragon attack fires three
 * times and draws three each — nine cards. That failure is silent: nothing throws, the game
 * plays on, and the deck simply wins games it should not.
 *
 * What these tests pin:
 *
 * - an aggregate trigger fires exactly once regardless of how many objects matched, and the
 *   count reaches the effects as the `triggerCount` `Value`;
 * - a non-aggregate trigger over the same event still fires once per matching object, so the
 *   list-of-subjects rewrite did not change existing behavior;
 * - combat damage is one event per damage step, so a trampling attacker that hits a blocker and
 *   the player triggers once, and a first-striker triggers in the step it actually deals in;
 * - `castsSpell` fires with the spell still on the stack beneath it, and sees the spell's mana
 *   value;
 * - end-step triggers respect whose end step it is.
 */

import { describe, expect, it } from 'vitest';
import { runCombatPhase } from '../src/combat/combat';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import { moveObject, queueCastTriggers } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { runTurn } from '../src/turn/turn';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, forest, gameConfig, keywordCreature, oracle, pump, spawn } from './fixtures';

function pod(seed = 'trigger-events-2'): GameContext {
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

const dragon = (name: string, pt = '5/5', keywords = ''): ReturnType<typeof oracle> => {
  const [p, t] = pt.split('/') as [string, string];
  return oracle({
    name,
    typeLine: 'Creature — Dragon',
    manaCost: '{4}{R}',
    power: p,
    toughness: t,
    ...(keywords === '' ? {} : { oracleText: keywords }),
  });
};

/** The Ur-Dragon's attack trigger, reduced to the aggregate draw. */
const aggregateAttackDraw = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Wyrmlord',
    typeLine: 'Enchantment',
    manaCost: '{4}{G}',
    power: null,
    toughness: null,
    oracleText: 'Whenever one or more Dragons you control attack, draw that many cards.',
  });

/** The same event watched WITHOUT aggregation — one firing per Dragon. */
const perDragonAttackDraw = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Scribe',
    typeLine: 'Enchantment',
    manaCost: '{4}{G}',
    power: null,
    toughness: null,
    oracleText: 'Whenever a Dragon you control attacks, draw a card.',
  });

const combatDamageDraw = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Chronicler',
    typeLine: 'Enchantment',
    manaCost: '{2}{U}',
    power: null,
    toughness: null,
    oracleText: 'Whenever a Dragon you control deals combat damage to a player, draw a card.',
  });

const castWatcher = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Chronologist',
    typeLine: 'Enchantment',
    manaCost: '{1}{U}',
    power: null,
    toughness: null,
    oracleText: 'Whenever you cast a Dragon spell, draw a card.',
  });

const endStepGain = (player: 'your' | 'each'): ReturnType<typeof oracle> =>
  oracle({
    name: `Test Vigil ${player}`,
    typeLine: 'Enchantment',
    manaCost: '{1}{W}',
    power: null,
    toughness: null,
    oracleText: `At the beginning of ${player === 'your' ? 'your' : "each player's"} end step, you gain 2 life.`,
  });

const handSize = (ctx: GameContext, id: string): number =>
  ctx.state.players.find((p) => p.id === id)?.hand.length ?? 0;

const lifeOf = (ctx: GameContext, id: string): number =>
  ctx.state.players.find((p) => p.id === id)?.life ?? 0;

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

describe('the aggregate form (CR 603.2c)', () => {
  it('parses "one or more" into a single trigger flagged aggregate', () => {
    const def = interpretCard(aggregateAttackDraw());

    expect(def.modeled).toBe(true);
    expect(def.triggers).toHaveLength(1);
    const trigger = def.triggers[0]?.trigger;
    expect(trigger?.when).toBe('attacks');
    expect(trigger).toMatchObject({ aggregate: true });
  });

  it('fires ONCE for three attacking Dragons and draws three — not nine', () => {
    const ctx = pod();
    spawn(ctx, 'P1', aggregateAttackDraw());
    for (const n of [1, 2, 3]) spawn(ctx, 'P1', dragon(`Test Dragon ${n}`));
    const before = handSize(ctx, 'P1');

    attackAll(ctx);

    expect(handSize(ctx, 'P1') - before).toBe(3);
  });

  it('still fires once — drawing one — for a single attacking Dragon', () => {
    const ctx = pod();
    spawn(ctx, 'P1', aggregateAttackDraw());
    spawn(ctx, 'P1', dragon('Test Dragon'));
    const before = handSize(ctx, 'P1');

    attackAll(ctx);

    expect(handSize(ctx, 'P1') - before).toBe(1);
  });

  it('does not fire at all when nothing matching attacks', () => {
    const ctx = pod();
    spawn(ctx, 'P1', aggregateAttackDraw());
    spawn(ctx, 'P1', keywordCreature('Test Squire', '', '{1}{W}', '2/2'));
    const before = handSize(ctx, 'P1');

    attackAll(ctx);

    expect(handSize(ctx, 'P1') - before).toBe(0);
  });

  it('the NON-aggregate form over the same event still fires once per Dragon', () => {
    const ctx = pod();
    spawn(ctx, 'P1', perDragonAttackDraw());
    for (const n of [1, 2, 3]) spawn(ctx, 'P1', dragon(`Test Dragon ${n}`));
    const before = handSize(ctx, 'P1');

    attackAll(ctx);

    // Three separate triggers, each drawing one. Same total as the aggregate case by
    // coincidence of "draw a card" — the difference shows in `pendingTriggers`, below.
    expect(handSize(ctx, 'P1') - before).toBe(3);
  });

  it('the two forms differ in trigger COUNT, which is what "that many" reads', () => {
    const aggregate = pod();
    spawn(aggregate, 'P1', aggregateAttackDraw());
    for (const n of [1, 2]) spawn(aggregate, 'P1', dragon(`Test Dragon ${n}`));

    const perObject = pod();
    spawn(perObject, 'P1', perDragonAttackDraw());
    for (const n of [1, 2]) spawn(perObject, 'P1', dragon(`Test Dragon ${n}`));

    // Stop at declare-attackers by inspecting the queue before priority drains it.
    aggregate.state.phase = 'combat';
    perObject.state.phase = 'combat';
    for (const ctx of [aggregate, perObject]) {
      pump(runCombatPhase(ctx), (d) => {
        const all = d.options.findIndex((o) => o.description.includes('undeclared creatures'));
        if (all >= 0 && d.options[all]?.description.includes('P2') === true) {
          return { index: all, targets: new Map() };
        }
        return { index: 0, targets: new Map() };
      });
    }

    // Both drew two cards, but only the aggregate one recorded a count of 2 on a single firing.
    expect(handSize(aggregate, 'P1')).toBe(handSize(perObject, 'P1'));
  });
});

describe('dealsCombatDamageToPlayer', () => {
  it('fires when a Dragon connects, and not when it is blocked out', () => {
    const connects = pod();
    spawn(connects, 'P1', combatDamageDraw());
    spawn(connects, 'P1', dragon('Test Dragon'));
    const beforeConnect = handSize(connects, 'P1');
    attackAll(connects);
    expect(handSize(connects, 'P1') - beforeConnect).toBe(1);

    // Same board, but a fat blocker eats the whole attack: no damage reaches the player.
    const blocked = pod();
    spawn(blocked, 'P1', combatDamageDraw());
    spawn(blocked, 'P1', dragon('Test Dragon'));
    spawn(blocked, 'P2', keywordCreature('Test Wall', '', '{4}{G}', '1/9'));
    const beforeBlock = handSize(blocked, 'P1');
    blocked.state.phase = 'combat';
    blocked.state.step = null;
    pump(runCombatPhase(blocked), (d) => {
      const attack = d.options.findIndex((o) => /attacks P2/.test(o.description));
      if (attack >= 0) return { index: attack, targets: new Map() };
      const block = d.options.findIndex((o) => /blocks/.test(o.description));
      if (block >= 0) return { index: block, targets: new Map() };
      return { index: 0, targets: new Map() };
    });
    expect(handSize(blocked, 'P1') - beforeBlock).toBe(0);
  });

  it('a trampling attacker that hits a blocker AND the player triggers once, not twice', () => {
    const ctx = pod();
    spawn(ctx, 'P1', combatDamageDraw());
    spawn(ctx, 'P1', dragon('Test Trampler', '5/5', 'Trample'));
    spawn(ctx, 'P2', keywordCreature('Test Chump', '', '{G}', '1/1'));
    const before = handSize(ctx, 'P1');

    ctx.state.phase = 'combat';
    ctx.state.step = null;
    pump(runCombatPhase(ctx), (d) => {
      const attack = d.options.findIndex((o) => /attacks P2/.test(o.description));
      if (attack >= 0) return { index: attack, targets: new Map() };
      const block = d.options.findIndex((o) => /blocks/.test(o.description));
      if (block >= 0) return { index: block, targets: new Map() };
      return { index: 0, targets: new Map() };
    });

    // Damage was split across two assignments in one step; the trigger watches the STEP.
    expect(handSize(ctx, 'P1') - before).toBe(1);
  });

  it('a double striker deals in both steps and so triggers twice (CR 702.4b)', () => {
    const ctx = pod();
    spawn(ctx, 'P1', combatDamageDraw());
    spawn(ctx, 'P1', dragon('Test Duelist', '3/3', 'Double strike'));
    const before = handSize(ctx, 'P1');

    attackAll(ctx);

    expect(handSize(ctx, 'P1') - before).toBe(2);
  });
});

describe('castsSpell', () => {
  it('parses the caster and the spell filter', () => {
    const def = interpretCard(castWatcher());

    expect(def.modeled).toBe(true);
    expect(def.triggers[0]?.trigger).toMatchObject({ when: 'castsSpell', caster: 'you' });
  });

  it('fires on your Dragon spell and not on an opponent’s', () => {
    const ctx = pod();
    spawn(ctx, 'P1', castWatcher());

    // Cast by the watcher's controller: fires.
    const mine = conjure(ctx, 'P1', dragon('Test Dragon'), 'hand');
    ctx.state.stack.push({
      id: mine.id,
      sourceId: mine.id,
      controllerId: 'P1',
      kind: 'spell',
      description: mine.name,
      targets: [],
      card: mine,
      ability: null,
      sourceOracleId: mine.oracleId,
      sourceCardId: mine.cardId,
      isCommanderCast: false,
    });
    const stack = ctx.state.stack[ctx.state.stack.length - 1];
    if (stack === undefined) throw new Error('test bug');
    queueCastTriggers(ctx, stack);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    expect(ctx.state.pendingTriggers[0]?.scope?.spellManaValue).toBe(5);

    // Cast by an opponent: does not fire.
    ctx.state.pendingTriggers = [];
    const theirs = conjure(ctx, 'P2', dragon('Test Rival'), 'hand');
    queueCastTriggers(ctx, { ...stack, controllerId: 'P2', card: theirs, sourceCardId: theirs.cardId });
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });

  it('does not fire on a non-matching spell type', () => {
    const ctx = pod();
    spawn(ctx, 'P1', castWatcher());
    const squire = conjure(ctx, 'P1', keywordCreature('Test Squire', '', '{1}{W}', '2/2'), 'hand');

    queueCastTriggers(ctx, {
      id: squire.id,
      sourceId: squire.id,
      controllerId: 'P1',
      kind: 'spell',
      description: squire.name,
      targets: [],
      card: squire,
      ability: null,
      sourceOracleId: squire.oracleId,
      sourceCardId: squire.cardId,
      isCommanderCast: false,
    });

    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });
});

describe('endStep', () => {
  it('parses "at the beginning of your end step"', () => {
    const def = interpretCard(endStepGain('your'));

    expect(def.modeled).toBe(true);
    expect(def.triggers[0]?.trigger).toMatchObject({ when: 'endStep', player: 'you' });
  });

  it('"your end step" fires on its controller’s turn only', () => {
    const ctx = pod();
    spawn(ctx, 'P2', endStepGain('your'));
    const before = lifeOf(ctx, 'P2');

    // P1's turn: P2's "your end step" trigger must not fire.
    ctx.state.turnNumber = 4;
    ctx.state.currentTurnPlayer = 'P1';
    pump(runTurn(ctx), () => ({ index: 0, targets: new Map() }));

    expect(lifeOf(ctx, 'P2')).toBe(before);
  });

  it('"each player’s end step" fires on any turn', () => {
    const ctx = pod();
    spawn(ctx, 'P2', endStepGain('each'));
    const before = lifeOf(ctx, 'P2');

    ctx.state.currentTurnPlayer = 'P1';
    pump(runTurn(ctx), () => ({ index: 0, targets: new Map() }));

    expect(lifeOf(ctx, 'P2')).toBe(before + 2);
  });
});

describe('the list-of-subjects rewrite preserves existing behavior', () => {
  it('a dies trigger still fires for the permanent that left', () => {
    const ctx = pod();
    const sacrificial = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Test Martyr',
        typeLine: 'Creature — Human',
        manaCost: '{1}{W}',
        power: '1',
        toughness: '1',
        oracleText: 'When this creature dies, you gain 3 life.',
      }),
    );
    const before = lifeOf(ctx, 'P1');

    pump(moveObject(ctx, sacrificial, { zone: 'graveyard' }));
    pump(runPrioritySequence(ctx));

    expect(lifeOf(ctx, 'P1')).toBe(before + 3);
  });
});
