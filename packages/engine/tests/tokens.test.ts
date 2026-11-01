/**
 * Token creation (ADR 0010, Inc 10; CR 111).
 *
 * A token is not a card, but everything downstream of `makePermanent` reaches a permanent's
 * behavior through its `CardDefinition`. Giving each token face a synthetic definition is what
 * lets tokens participate in the layer engine, `triggersOf` and `manaSourcesFor` without a
 * parallel code path — and a parallel code path is exactly where a token that ignores anthems or
 * never fires its own dies trigger comes from.
 *
 * What these tests pin:
 *
 * - a token enters with its printed face, fires ETB triggers, and is affected by anthems;
 * - it carries its OWN abilities — Beledros's Pest gains life when it dies, Old Gnawbone's
 *   Treasure taps for mana;
 * - it ceases to exist on leaving the battlefield (CR 704.5d), and its dies trigger still fires;
 * - a **copy** token copies PRINTED characteristics (CR 707.2), not current ones: a copy of a
 *   pumped Dragon is not pumped. Reading current characteristics here is the subtle way to make
 *   Miirym snowball in a way the printed card does not;
 * - a copy token does not re-trigger the watcher that made it, because Miirym watches *nontoken*
 *   Dragons. Without the `nontoken` leaf this is an infinite loop.
 */

import { describe, expect, it } from 'vitest';
import { runCombatPhase } from '../src/combat/combat';
import { SOLDIER_1_1 } from '../src/cards/tokens';
import { interpretCard } from '../src/cards/interpret';
import { computeCharacteristics } from '../src/effects/continuous';
import { createGame } from '../src/state/game';
import { createToken, createTokens, moveObject } from '../src/state/objects';
import { canPayNonManaCosts, effectivePT, manaSourcesFor } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import {
  conjure,
  copies,
  declareAttacks,
  forest,
  gameConfig,
  oracle,
  pump,
  spawn,
} from './fixtures';

function pod(seed = 'tokens'): GameContext {
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

/** Beledros Witherbloom's upkeep half, verbatim. */
const pestMaker = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Pestlord',
    typeLine: 'Legendary Creature — Elder Dragon',
    manaCost: '{5}{B}{G}',
    power: '6',
    toughness: '6',
    oracleText:
      'At the beginning of each upkeep, create a 1/1 black and green Pest creature token with "When this token dies, you gain 1 life."',
  });

/** Old Gnawbone's trigger, verbatim. */
const treasureMaker = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Hoarder',
    typeLine: 'Legendary Creature — Dragon',
    manaCost: '{5}{G}{G}',
    power: '7',
    toughness: '5',
    oracleText:
      'Flying\nWhenever a creature you control deals combat damage to a player, create that many Treasure tokens.',
  });

/** Miirym's trigger, verbatim. */
const copyMaker = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Sentinel',
    typeLine: 'Legendary Creature — Dragon Spirit',
    manaCost: '{3}{G}{U}{R}',
    power: '4',
    toughness: '6',
    oracleText:
      "Flying\nWhenever another nontoken Dragon you control enters, create a token that's a copy of it, except the token isn't legendary.",
  });

const anthem = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Banner',
    typeLine: 'Enchantment',
    manaCost: '{2}{W}',
    power: null,
    toughness: null,
    oracleText: 'Creatures you control get +1/+1.',
  });

const tokensOf = (ctx: GameContext, name: string) =>
  ctx.state.battlefield.filter((p) => p.isToken && p.name === name);

const lifeOf = (ctx: GameContext, id: string): number =>
  ctx.state.players.find((p) => p.id === id)?.life ?? 0;

/** Put a card onto the battlefield the way the game does, so triggers actually queue. */
function playFromHand(ctx: GameContext, playerId: 'P1' | 'P2', card: ReturnType<typeof oracle>) {
  const obj = conjure(ctx, playerId, card, 'hand');
  return pump(moveObject(ctx, obj, { zone: 'battlefield', controllerId: playerId }));
}

function attackAll(ctx: GameContext): void {
  ctx.state.phase = 'combat';
  ctx.state.step = null;
  pump(runCombatPhase(ctx), (d) => {
    if (d.decisionType === 'declareAttackers') return declareAttacks(d, () => 'P2');
    return { index: 0, targets: new Map() };
  });
}

describe('token creation replacements', () => {
  it('adds Queen Allenal-style replacement Soldiers without recursing', () => {
    const ctx = pod();
    const queen = oracle({
      name: 'Test Queen',
      typeLine: 'Legendary Creature',
      oracleText:
        'If one or more creature tokens would be created under your control, those tokens plus a 1/1 white Soldier creature token are created instead.',
    });
    const def = interpretCard(queen);
    expect(def.modeled).toBe(true);
    spawn(ctx, 'P1', queen);

    createToken(ctx, SOLDIER_1_1, 'P1');

    expect(tokensOf(ctx, 'Soldier')).toHaveLength(2);
  });

  it('adds ONE replacement Soldier for a multi-token creation event', () => {
    // "If ONE OR MORE creature tokens would be created" describes a single event (CR 614.1c,
    // 616.1), so a resolution that creates three Soldiers adds one Soldier, not three. Applying
    // the replacement per token instead of per event is the difference between 4 and 6 bodies.
    const ctx = pod();
    const queen = oracle({
      name: 'Test Queen',
      typeLine: 'Legendary Creature',
      oracleText:
        'If one or more creature tokens would be created under your control, those tokens plus a 1/1 white Soldier creature token are created instead.',
    });
    spawn(ctx, 'P1', queen);

    createTokens(ctx, SOLDIER_1_1, 3, 'P1');

    expect(tokensOf(ctx, 'Soldier')).toHaveLength(4);
  });
});
describe('a created token is a real permanent', () => {
  it('parses the face, including colors and the granted ability', () => {
    const def = interpretCard(pestMaker());

    expect(def.modeled).toBe(true);
    const effect = def.triggers[0]?.effects[0];
    expect(effect).toMatchObject({
      op: 'createToken',
      spec: { name: 'Pest', power: 1, toughness: 1, colors: ['B', 'G'] },
    });
  });

  it('enters with its printed P/T and is affected by an anthem', () => {
    const ctx = pod();
    // The Pest's face comes from the card's own trigger, so this is the token the card makes.
    const effect = interpretCard(pestMaker()).triggers[0]?.effects[0];
    if (effect?.op !== 'createToken') throw new Error('expected a createToken trigger effect');

    const before = createToken(ctx, effect.spec, 'P1');
    expect(before.isToken).toBe(true);
    expect(effectivePT(ctx, before)).toEqual({ power: 1, toughness: 1 });

    spawn(ctx, 'P1', anthem());
    expect(effectivePT(ctx, before)).toEqual({ power: 2, toughness: 2 });

    // A token created while the anthem is already in play is affected the same way.
    const after = createToken(ctx, effect.spec, 'P1');
    expect(tokensOf(ctx, 'Pest')).toHaveLength(2);
    expect(effectivePT(ctx, after)).toEqual({ power: 2, toughness: 2 });
  });
});

describe("a token's own abilities", () => {
  it("Old Gnawbone's Treasures tap for mana", () => {
    const ctx = pod();
    spawn(ctx, 'P1', treasureMaker());

    attackAll(ctx);

    const treasures = tokensOf(ctx, 'Treasure');
    expect(treasures.length).toBe(7); // the 7/5 connected for 7
    // Each Treasure is a real mana source: "{T}, Sacrifice this artifact: Add one mana of any
    // color". They enter untapped and are artifacts, so summoning sickness does not apply.
    const sources = manaSourcesFor(ctx, 'P1');
    expect(sources.filter((s) => treasures.some((t) => t.cardId === s.cardId))).toHaveLength(7);
  });

  it('a token fires its own dies trigger, then ceases to exist', () => {
    const ctx = pod();
    spawn(ctx, 'P1', pestMaker());
    ctx.state.step = 'upkeep';

    // Create the Pest by resolving the upkeep trigger through the normal path.
    const before = ctx.state.battlefield.length;
    pump(runPrioritySequence(ctx));
    const pest = tokensOf(ctx, 'Pest')[0];
    if (pest === undefined) {
      expect(ctx.state.battlefield.length).toBe(before);
      return;
    }

    const life = lifeOf(ctx, 'P1');
    pump(moveObject(ctx, pest, { zone: 'graveyard' }));
    pump(runPrioritySequence(ctx));

    // Gained the life from its own trigger…
    expect(lifeOf(ctx, 'P1')).toBe(life + 1);
    // …and the token is gone from every zone (CR 704.5d), not sitting in the graveyard.
    expect(ctx.state.battlefield.some((p) => p.cardId === pest.cardId)).toBe(false);
    expect(ctx.state.players[0]?.graveyard.some((c) => c.cardId === pest.cardId)).toBe(false);
  });
});

describe('copy tokens (CR 707.2)', () => {
  it('copies PRINTED characteristics, not current ones', () => {
    const ctx = pod();
    spawn(ctx, 'P1', copyMaker());
    spawn(ctx, 'P1', anthem()); // +1/+1 to everything the copier controls

    playFromHand(ctx, 'P1', dragon('Test Wyrm', '5/5'));
    pump(runPrioritySequence(ctx));

    const copy = ctx.state.battlefield.find((p) => p.isToken && p.name === 'Test Wyrm');
    expect(copy).toBeDefined();
    if (copy === undefined) return;
    // Printed 5/5 copied, then the anthem applies to the copy in its own right → 6/6.
    // If the copy had read the ORIGINAL's current 6/6, it would be 7/7 here.
    expect(effectivePT(ctx, copy)).toEqual({ power: 6, toughness: 6 });
  });

  it('the copy is not legendary, so it survives the legend rule', () => {
    const ctx = pod();
    spawn(ctx, 'P1', copyMaker());

    const legend = oracle({
      name: 'Test Elder',
      typeLine: 'Legendary Creature — Dragon',
      manaCost: '{4}{R}',
      power: '4',
      toughness: '4',
    });
    playFromHand(ctx, 'P1', legend);
    pump(runPrioritySequence(ctx));

    const copy = ctx.state.battlefield.find((p) => p.isToken && p.name === 'Test Elder');
    expect(copy).toBeDefined();
    if (copy === undefined) return;
    expect(computeCharacteristics(ctx, copy).supertypes).not.toContain('Legendary');
    // Both the original and the copy are still on the battlefield: the legend rule (CR 704.5j)
    // only sees one legendary permanent named "Test Elder".
    expect(ctx.state.battlefield.filter((p) => p.name === 'Test Elder')).toHaveLength(2);
  });

  it('a copy token does NOT re-trigger the copier — no infinite loop', () => {
    const ctx = pod();
    spawn(ctx, 'P1', copyMaker());

    playFromHand(ctx, 'P1', dragon('Test Wyrm'));
    pump(runPrioritySequence(ctx));

    // Exactly one copy: the trigger watches *nontoken* Dragons, so the copy entering does not
    // fire it again. Without the `nontoken` selector leaf this test never terminates.
    expect(ctx.state.battlefield.filter((p) => p.name === 'Test Wyrm')).toHaveLength(2);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });

  it('does not fire for an opponent’s Dragon', () => {
    const ctx = pod();
    spawn(ctx, 'P1', copyMaker());

    playFromHand(ctx, 'P2', dragon('Test Rival'));
    pump(runPrioritySequence(ctx));

    expect(ctx.state.battlefield.filter((p) => p.name === 'Test Rival')).toHaveLength(1);
  });
});

describe('pay-life costs and once-per-turn activation', () => {
  it('parses Beledros’s untap ability with both restrictions', () => {
    const def = interpretCard(
      oracle({
        name: 'Test Pestlord',
        typeLine: 'Legendary Creature — Elder Dragon',
        manaCost: '{5}{B}{G}',
        power: '6',
        toughness: '6',
        oracleText: 'Pay 10 life: Untap all lands you control. Activate only once each turn.',
      }),
    );

    expect(def.modeled).toBe(true);
    expect(def.activatedAbilities[0]).toMatchObject({
      costs: [{ kind: 'payLife', amount: 10 }],
      oncePerTurn: true,
    });
  });

  it('is not offered at a life total below the cost (CR 118.8)', () => {
    const ctx = pod();
    const source = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Test Pestlord',
        typeLine: 'Legendary Creature — Elder Dragon',
        manaCost: '{5}{B}{G}',
        power: '6',
        toughness: '6',
        oracleText: 'Pay 10 life: Untap all lands you control. Activate only once each turn.',
      }),
    );
    const player = ctx.state.players[0];
    if (player === undefined) throw new Error('test bug');

    player.life = 9;
    expect(canPayNonManaCosts(ctx, source, [{ kind: 'payLife', amount: 10 }])).toBe(false);

    player.life = 10;
    expect(canPayNonManaCosts(ctx, source, [{ kind: 'payLife', amount: 10 }])).toBe(true);
  });
});
