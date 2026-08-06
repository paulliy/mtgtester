/**
 * Structured trigger specs (ADR 0010, Inc 4): a trigger names an *event* and a *subject*,
 * so "When ~ enters" and "Whenever a creature you control enters" are one mechanism seen
 * from two vantage points, not two enum values.
 *
 * What these tests pin, in order of how easy each is to get quietly wrong:
 *
 * - a selector subject is matched against the object that moved, and against the *ability's*
 *   controller — "you control" means the watcher's controller, not the event's;
 * - `attacks` triggers fire once the whole attacking set is declared (CR 508.2), once per
 *   matching attacker;
 * - the `'triggerObject'` referent reaches the right object, and is not a target: it is never
 *   announced, and an ability using it does not fizzle when that object leaves;
 * - the intervening-if clause (CR 603.4) is checked BOTH when the trigger would fire and
 *   again on resolution. Only checking once is the classic bug, and it is invisible until the
 *   board changes while the trigger is on the stack.
 */

import { describe, expect, it } from 'vitest';
import { runCombatPhase } from '../src/combat/combat';
import { interpretCard } from '../src/cards/interpret';
import { computeCharacteristics } from '../src/effects/continuous';
import { createGame } from '../src/state/game';
import { moveObject, queueTriggersForObject } from '../src/state/objects';
import { hasKeyword } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import {
  conjure,
  copies,
  declareAttacks,
  forest,
  gameConfig,
  keywordCreature,
  oracle,
  pump,
  registerCustomDef,
  spawn,
} from './fixtures';

function pod(seed = 'trigger-events'): GameContext {
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

// --- The three Ur-Dragon cards this increment closes, verbatim ---

const temurAscendancy = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Ascendancy',
    typeLine: 'Enchantment',
    manaCost: '{G}{U}{R}',
    power: null,
    toughness: null,
    oracleText:
      'Creatures you control have haste.\nWhenever a creature you control with power 4 or greater enters, you may draw a card.',
  });

const atarka = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Atarka',
    typeLine: 'Legendary Creature — Dragon',
    manaCost: '{5}{R}{G}',
    power: '6',
    toughness: '4',
    oracleText:
      'Flying, trample\nWhenever a Dragon you control attacks, it gains double strike until end of turn.',
  });

const garruksUprising = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Uprising',
    typeLine: 'Enchantment',
    manaCost: '{2}{G}',
    power: null,
    toughness: null,
    oracleText:
      'When this enchantment enters, if you control a creature with power 4 or greater, draw a card.',
  });

const dragon = (name: string, pt = '5/5'): ReturnType<typeof oracle> => {
  const [p, t] = pt.split('/') as [string, string];
  return oracle({
    name,
    typeLine: 'Creature — Dragon',
    manaCost: '{4}{R}',
    power: p,
    toughness: t,
  });
};

/** Put a card onto the battlefield the way the game does, so triggers actually queue. */
function playFromHand(
  ctx: GameContext,
  playerId: 'P1' | 'P2',
  card: ReturnType<typeof oracle>,
): void {
  const obj = conjure(ctx, playerId, card, 'hand');
  pump(moveObject(ctx, obj, { zone: 'battlefield', controllerId: playerId }));
}

const handSize = (ctx: GameContext, id: string): number =>
  ctx.state.players.find((p) => p.id === id)?.hand.length ?? 0;

describe('selector-subject triggers', () => {
  it('fires for another permanent that matches, and passes on one that does not', () => {
    const ctx = pod();
    spawn(ctx, 'P1', temurAscendancy());

    // A 2/2 is below the power threshold — nothing queues.
    playFromHand(ctx, 'P1', keywordCreature('Test Squire', '', '{1}{W}', '2/2'));
    expect(ctx.state.pendingTriggers).toHaveLength(0);

    // A 5/5 clears it.
    playFromHand(ctx, 'P1', dragon('Test Whelp'));
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    expect(ctx.state.pendingTriggers[0]?.controllerId).toBe('P1');
  });

  it('reads "you control" as the WATCHER\'s controller, not the event\'s', () => {
    const ctx = pod();
    spawn(ctx, 'P1', temurAscendancy());

    playFromHand(ctx, 'P2', dragon('Test Rival'));

    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });

  it('counts current power, so a permanent that only clears the bar with counters still fires', () => {
    const ctx = pod();
    spawn(ctx, 'P1', temurAscendancy());
    const small = spawn(ctx, 'P1', keywordCreature('Test Runt', '', '{G}', '1/1'));

    // The selector reads CURRENT characteristics (layer 7c), not printed power.
    small.counters['+1/+1'] = 3;
    queueTriggersForObject(ctx, 'enters', small);

    expect(ctx.state.pendingTriggers).toHaveLength(1);
  });

  it('a matching permanent fires every watcher, including its own', () => {
    const ctx = pod();
    spawn(ctx, 'P1', temurAscendancy());
    spawn(ctx, 'P1', temurAscendancy());

    playFromHand(ctx, 'P1', dragon('Test Whelp'));

    expect(ctx.state.pendingTriggers).toHaveLength(2);
  });
});

describe('attack triggers and the trigger-object referent', () => {
  /** Declare every eligible attacker against P2 and run the combat phase to completion. */
  function attackAll(ctx: GameContext): void {
    ctx.state.phase = 'combat';
    ctx.state.step = null;
    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers') return declareAttacks(d, () => 'P2');
      return { index: 0, targets: new Map() };
    });
  }

  it('grants the keyword to each attacking Dragon and to nothing else', () => {
    const ctx = pod();
    const source = spawn(ctx, 'P1', atarka());
    const other = spawn(ctx, 'P1', dragon('Test Whelp'));
    const soldier = spawn(ctx, 'P1', keywordCreature('Test Squire', '', '{1}{W}', '2/2'));

    attackAll(ctx);

    // Atarka watches "a Dragon you control", which includes itself.
    expect(hasKeyword(ctx, source, 'double strike')).toBe(true);
    expect(hasKeyword(ctx, other, 'double strike')).toBe(true);
    expect(hasKeyword(ctx, soldier, 'double strike')).toBe(false);
  });

  it('does not fire for a Dragon that stayed home', () => {
    const ctx = pod();
    spawn(ctx, 'P1', atarka());
    const homebody = spawn(ctx, 'P1', dragon('Test Whelp'));
    homebody.tapped = true; // ineligible to attack

    attackAll(ctx);

    expect(hasKeyword(ctx, homebody, 'double strike')).toBe(false);
  });

  it('resolves harmlessly when the trigger object has left the battlefield', () => {
    const ctx = pod();
    spawn(ctx, 'P1', atarka());
    const doomed = spawn(ctx, 'P1', dragon('Test Whelp'));

    queueTriggersForObject(ctx, 'attacks', doomed);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    // The Dragon dies with the trigger still waiting — the referent has nothing to point at.
    // `'triggerObject'` is not a target (CR 115.10a), so this is a no-op, not a fizzle.
    pump(moveObject(ctx, doomed, { zone: 'graveyard' }));
    pump(runPrioritySequence(ctx));

    expect(ctx.state.eventLog.some((e) => e.type === 'fizzle')).toBe(false);
    expect(ctx.state.effects).toHaveLength(0);
  });

  it('a trigger-object effect is never announced as a target', () => {
    const ctx = pod();
    spawn(ctx, 'P1', atarka());
    const other = spawn(ctx, 'P1', dragon('Test Whelp'));

    queueTriggersForObject(ctx, 'attacks', other);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    const { decisions } = pump(runPrioritySequence(ctx));

    expect(decisions.some((d) => d.decisionType === 'chooseTargets')).toBe(false);
    // It still did its job — the keyword landed without a target ever being chosen.
    expect(hasKeyword(ctx, other, 'double strike')).toBe(true);
  });
});

describe('intervening-if (CR 603.4)', () => {
  it('does not queue the trigger at all when the condition is false', () => {
    const ctx = pod();
    spawn(ctx, 'P1', keywordCreature('Test Squire', '', '{1}{W}', '2/2'));

    playFromHand(ctx, 'P1', garruksUprising());

    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });

  it('queues and resolves when the condition holds', () => {
    const ctx = pod();
    spawn(ctx, 'P1', dragon('Test Whelp'));
    const before = handSize(ctx, 'P1');

    playFromHand(ctx, 'P1', garruksUprising());
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(runPrioritySequence(ctx));

    expect(handSize(ctx, 'P1')).toBe(before + 1);
  });

  it('checks AGAIN on resolution, so a board change between the two removes it', () => {
    const ctx = pod();
    const enabler = spawn(ctx, 'P1', dragon('Test Whelp'));
    const before = handSize(ctx, 'P1');

    playFromHand(ctx, 'P1', garruksUprising());
    expect(ctx.state.pendingTriggers).toHaveLength(1);

    // The only power-4 creature dies while the trigger is still waiting.
    pump(moveObject(ctx, enabler, { zone: 'graveyard' }));
    pump(runPrioritySequence(ctx));

    expect(handSize(ctx, 'P1')).toBe(before);
    expect(ctx.state.eventLog.some((e) => e.type === 'triggerConditionFailed')).toBe(true);
  });
});

describe('the event-only selector ban', () => {
  it('rejects a static ability whose affected set reads power', () => {
    const ctx = pod();
    const card = oracle({
      name: 'Test Illegal Anthem',
      typeLine: 'Enchantment',
      power: null,
      toughness: null,
    });
    const perm = spawn(ctx, 'P1', card);
    // Hand-built: the text grammar has no way to produce this, which is the point. The guard
    // catches a *modeling* mistake — an override, or a future parse arm — not a card. Without
    // it, one 7d effect could change another's affected set, and `applyGroup` skips dependency
    // analysis in 7d precisely because that cannot happen.
    registerCustomDef(ctx, {
      ...interpretCard(card),
      staticEffects: [
        {
          affects: { kind: 'allOf', of: [{ kind: 'powerAtLeast', n: 4 }] },
          op: { layer: 6, addKeyword: 'flying' },
        },
      ],
    });

    expect(() => computeCharacteristics(ctx, perm)).toThrow(/reads power/);
  });

  it('allows the same selector as a trigger subject', () => {
    const def = interpretCard(temurAscendancy());

    expect(def.modeled).toBe(true);
    expect(JSON.stringify(def.triggers[0]?.trigger)).toContain('powerAtLeast');
    // …and the card's own static ability is a plain anthem, with no power leaf in it.
    expect(JSON.stringify(def.staticEffects)).not.toContain('powerAtLeast');
  });
});

describe('regression: self-subject triggers still route through the same path', () => {
  it('queues an enters trigger for the permanent that entered, and only that one', () => {
    const ctx = pod();
    const drawer = oracle({
      name: 'Test Sage',
      typeLine: 'Creature — Test Wizard',
      manaCost: '{2}{U}',
      oracleText: 'When this creature enters, draw a card.',
    });
    spawn(ctx, 'P1', drawer); // already on the battlefield: must NOT re-fire

    playFromHand(ctx, 'P1', drawer);

    expect(ctx.state.pendingTriggers).toHaveLength(1);
    expect(ctx.state.pendingTriggers[0]?.triggerObjectCardId).toBeUndefined();
  });
});
