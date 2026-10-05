/**
 * Regressions from an engine-wide rules sweep: the monarch's end-step draw and succession
 * (CR 725), first/double strike step membership (CR 510.4, 702.7c), an attacker staying blocked
 * after its blocker regenerates (CR 509.1h), "you lose the game" effects actually removing the
 * player (CR 104.3a/800.4a), protection's targeting and damage halves (CR 702.16), "any target"
 * including planeswalkers (CR 115.4), and cost reductions applying after {X} (CR 601.2f).
 */

import { describe, expect, it } from 'vitest';
import type { ObjectId } from '@mtg/shared';
import { computePriorityOptions, computeTargetOptions } from '../src/actions/legal';
import { runCombatPhase } from '../src/combat/combat';
import { executeAbility } from '../src/effects/resolve';
import { priorityCheckpoint } from '../src/sba/sba';
import { createGame } from '../src/state/game';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { runTurn } from '../src/turn/turn';
import { createToken, moveObject } from '../src/state/objects';
import { evaluateValueIn } from '../src/effects/values';
import { cardTypesInAllGraveyards } from '../src/cards/value';
import { evaluateCondition } from '../src/cards/condition';
import type { EngineCardObject, EngineStackObject } from '../src/state/types';
import {
  conjure,
  copies,
  declareAttacks,
  declareBlocks,
  forest,
  gameConfig,
  giantGrowth,
  keywordCreature,
  mountain,
  oracle,
  pump,
  registerDef,
  spawn,
} from './fixtures';

function pod(): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(6, forest) })),
      { seed: 'rules-sweep' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  return ctx;
}

const redBolt = () =>
  oracle({
    name: 'Sweep Bolt',
    typeLine: 'Instant',
    manaCost: '{R}',
    colors: ['R'],
    oracleText: 'Sweep Bolt deals 3 damage to any target.',
  });

const redSweeper = () =>
  oracle({
    name: 'Sweep Pyroclasm',
    typeLine: 'Sorcery',
    manaCost: '{1}{R}',
    colors: ['R'],
    oracleText: 'Sweep Pyroclasm deals 2 damage to each creature.',
  });

const proRedBear = () => keywordCreature('Sweep Pro-Red Bear', 'Protection from red', '{1}{W}');

const planeswalker = () =>
  oracle({
    name: 'Sweep Walker',
    typeLine: 'Legendary Planeswalker — Test',
    manaCost: '{3}',
    loyalty: '5',
  });

function giveFirstStrike(ctx: GameContext, perm: EnginePermanent): string {
  const id = `eff-${ctx.state.nextObjectNum++}`;
  ctx.state.effects.push({
    id,
    sourceId: perm.cardId,
    description: `${perm.name} gains first strike`,
    targetCardIds: [perm.cardId],
    kind: 'grantKeyword',
    keyword: 'first strike',
    timestamp: ctx.state.nextTimestamp++,
  });
  return id;
}

describe('the monarch (CR 725)', () => {
  it('draws at the beginning of the end step, using the stack — not in the draw step', () => {
    const ctx = pod();
    ctx.state.monarchPlayerId = 'P1';
    pump(runTurn(ctx));
    const draws = ctx.state.eventLog.filter((e) => e.type === 'draw');
    // The draw step draws only the turn's own card; the monarch's card comes in the end step.
    expect(draws.filter((e) => e.step === 'draw')).toHaveLength(1);
    expect(draws.filter((e) => e.step === 'end')).toHaveLength(1);
    expect(
      ctx.state.eventLog.some(
        (e) => e.type === 'triggerOnStack' && e.payload['source'] === 'The monarch',
      ),
    ).toBe(true);
  });

  it('passes to the active player when the monarch leaves the game', () => {
    const ctx = pod();
    ctx.state.monarchPlayerId = 'P3';
    ctx.state.players[2]!.life = 0;
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.eliminatedPlayers).toContain('P3');
    expect(ctx.state.monarchPlayerId).toBe('P1');
  });

  it('passes to the next player in turn order when the monarch is the active player leaving', () => {
    const ctx = pod();
    ctx.state.monarchPlayerId = 'P1';
    ctx.state.players[0]!.life = 0;
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.monarchPlayerId).toBe('P2');
  });

  it('is not stolen by combat damage that was prevented', () => {
    const ctx = pod();
    ctx.state.phase = 'combat';
    ctx.state.monarchPlayerId = 'P2';
    ctx.state.combatDamagePrevention = { all: true, players: {} };
    spawn(ctx, 'P1', keywordCreature('Sweep Raider', '', '{1}{R}', '3/3'));
    pump(runCombatPhase(ctx), (d) =>
      d.decisionType === 'declareAttackers'
        ? declareAttacks(d, (_id, s) => (s.name === 'Sweep Raider' ? 'P2' : null))
        : { index: 0, targets: new Map() },
    );
    expect(ctx.state.players[1]!.life).toBe(40);
    expect(ctx.state.monarchPlayerId).toBe('P2');
  });
});

describe('combat damage steps (CR 510.4, 702.7c)', () => {
  it('a creature that loses first strike after the first step does not deal damage again, and one that gains it still does', () => {
    const ctx = pod();
    ctx.state.phase = 'combat';
    const early = spawn(ctx, 'P1', keywordCreature('Sweep Early', '', '{1}{R}', '2/2'));
    const late = spawn(ctx, 'P1', keywordCreature('Sweep Late', '', '{1}{R}', '2/2'));
    const grant = giveFirstStrike(ctx, early);
    // Something to cast keeps P1's priority windows from being auto-passed, so the test can act
    // inside the first-strike damage step.
    spawn(ctx, 'P1', forest());
    conjure(ctx, 'P1', giantGrowth(), 'hand');
    let swapped = false;
    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers') {
        return declareAttacks(d, (_id, s) =>
          s.name === 'Sweep Early' ? 'P2' : s.name === 'Sweep Late' ? 'P3' : null,
        );
      }
      if (ctx.state.step === 'firstStrikeCombatDamage' && !swapped) {
        swapped = true;
        ctx.state.effects = ctx.state.effects.filter((e) => e.id !== grant);
        giveFirstStrike(ctx, late);
      }
      return { index: 0, targets: new Map() };
    });
    expect(swapped).toBe(true);
    expect(ctx.state.players[1]!.life).toBe(38); // Early: first-strike step only
    expect(ctx.state.players[2]!.life).toBe(38); // Late: regular step, despite first strike now
  });

  it('an attacker whose blocker regenerated stays blocked and deals no damage to the player', () => {
    const ctx = pod();
    ctx.state.phase = 'combat';
    const attacker = spawn(
      ctx,
      'P1',
      keywordCreature('Sweep Lancer', 'Double strike', '{2}{R}', '3/3'),
    );
    const blocker = spawn(ctx, 'P2', keywordCreature('Sweep Troll', '', '{1}{G}', '2/2'));
    blocker.regenerationShields = 1;
    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers') {
        return declareAttacks(d, (_id, s) => (s.name === 'Sweep Lancer' ? 'P2' : null));
      }
      if (d.decisionType === 'declareBlockers') {
        return declareBlocks(d, (_id, s) => (s.name === 'Sweep Troll' ? attacker.id : null));
      }
      return { index: 0, targets: new Map() };
    });
    expect(ctx.state.eventLog.some((e) => e.type === 'regenerated')).toBe(true);
    expect(ctx.state.players[1]!.life).toBe(40);
  });
});

describe('losing the game from an effect (CR 104.3a)', () => {
  it('removes a player an effect marked as having lost', () => {
    const ctx = pod();
    const p2 = ctx.state.players[1]!;
    p2.library = [];
    pump(
      executeAbility(
        ctx,
        { cardId: 'sweep-src', name: 'Sweep Source', oracleId: 'sweep-src', controllerId: 'P2' },
        { kind: 'spell', targets: [], effects: [{ op: 'emptyLibraryCreatureOrLose' }] },
        [],
      ),
    );
    expect(p2.hasLost).toBe(true);
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.eliminatedPlayers).toContain('P2');
    expect(ctx.state.turnOrder).not.toContain('P2');
    expect(p2.lossReason).toBe('other');
  });
});

describe('protection (CR 702.16)', () => {
  it('a red spell cannot target a creature with protection from red', () => {
    const ctx = pod();
    ctx.state.phase = 'precombatMain';
    spawn(ctx, 'P1', mountain());
    conjure(ctx, 'P1', redBolt(), 'hand');
    const proRed = spawn(ctx, 'P2', proRedBear());
    const plain = spawn(ctx, 'P2', keywordCreature('Sweep Plain Bear', '', '{1}{G}'));
    const cast = computePriorityOptions(ctx, ctx.state.players[0]!).find((o) =>
      o.description.startsWith('Cast Sweep Bolt'),
    );
    const options = cast?.targets?.[0]?.options ?? [];
    expect(options).toContain(plain.id);
    expect(options).not.toContain(proRed.id);
  });

  it('a red spell does not affect a target that gained protection from red before resolution', () => {
    const ctx = pod();
    const def = registerDef(ctx, redBolt());
    const bear = spawn(ctx, 'P2', proRedBear());
    pump(
      executeAbility(
        ctx,
        { cardId: 'sweep-bolt', name: 'Sweep Bolt', oracleId: def.oracleId, controllerId: 'P1' },
        def.spellAbility!,
        [bear.id],
      ),
    );
    expect(bear.damageMarked).toBe(0);
  });

  it('prevents noncombat damage from a source of that color', () => {
    const ctx = pod();
    const def = registerDef(ctx, redSweeper());
    const proRed = spawn(ctx, 'P2', proRedBear());
    const plain = spawn(ctx, 'P2', keywordCreature('Sweep Plain Bear', '', '{1}{G}', '2/4'));
    pump(
      executeAbility(
        ctx,
        {
          cardId: 'sweep-clasm',
          name: 'Sweep Pyroclasm',
          oracleId: def.oracleId,
          controllerId: 'P1',
        },
        def.spellAbility!,
        [],
      ),
    );
    expect(proRed.damageMarked).toBe(0);
    expect(plain.damageMarked).toBe(2);
  });
});

describe('"any target" (CR 115.4)', () => {
  it('includes planeswalkers, and damage to one removes loyalty', () => {
    const ctx = pod();
    const walker = spawn(ctx, 'P2', planeswalker());
    walker.counters['loyalty'] = 5;
    const def = registerDef(ctx, redBolt());
    const options = computeTargetOptions(ctx, def.spellAbility!.targets[0]!, 'P1', def.colors);
    expect(options).toContain(walker.id);
    pump(
      executeAbility(
        ctx,
        { cardId: 'sweep-bolt', name: 'Sweep Bolt', oracleId: def.oracleId, controllerId: 'P1' },
        def.spellAbility!,
        [walker.id],
      ),
    );
    expect(walker.counters['loyalty']).toBe(2);
  });

  it('"untap target permanent" can target a land', () => {
    const ctx = pod();
    const def = registerDef(
      ctx,
      oracle({
        name: 'Sweep Untapper',
        typeLine: 'Artifact',
        manaCost: '{2}',
        oracleText: '{T}: Untap target permanent.',
      }),
    );
    const land = spawn(ctx, 'P1', forest(), { tapped: true });
    const spec = def.activatedAbilities[0]!.ability.targets[0]!;
    expect(computeTargetOptions(ctx, spec, 'P1')).toContain(land.id as ObjectId);
  });
});

describe('cost reductions and {X} (CR 601.2f)', () => {
  it('a generic reduction can pay part of X', () => {
    const ctx = pod();
    ctx.state.phase = 'precombatMain';
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Sweep Reducer',
        typeLine: 'Artifact',
        manaCost: '{2}',
        oracleText: 'Instant and sorcery spells you cast cost {1} less to cast.',
      }),
    );
    spawn(ctx, 'P1', mountain());
    conjure(
      ctx,
      'P1',
      oracle({
        name: 'Sweep Quake',
        typeLine: 'Sorcery',
        manaCost: '{X}{R}',
        colors: ['R'],
        oracleText: 'Sweep Quake deals X damage to each creature without flying and each player.',
      }),
      'hand',
    );
    const xValues = computePriorityOptions(ctx, ctx.state.players[0]!)
      .filter((o) => o.description.startsWith('Cast Sweep Quake'))
      .map((o) => (o.payload as { x?: number }).x);
    // One Mountain plus the {1} reduction: X=1 costs {1}{R} − {1} = {R}.
    expect(xValues).toEqual([0, 1]);
  });
});

/** A spell card sitting on the stack, as `applyPriorityAction` leaves it after casting. */
function spellOnStack(
  ctx: GameContext,
  controllerId: 'P1' | 'P2',
  card: ReturnType<typeof oracle>,
  extra: Partial<EngineStackObject> = {},
  cardExtra: Partial<EngineCardObject> = {},
): EngineStackObject {
  const def = registerDef(ctx, card);
  const n = ctx.state.nextObjectNum++;
  const cardObj: EngineCardObject = {
    id: `o-${n}` as ObjectId,
    cardId: `sweep-card-${n}`,
    oracleId: def.oracleId,
    ownerId: controllerId,
    name: card.name,
    typeLine: card.typeLine,
    oracleText: card.oracleText,
    manaCost: card.manaCost,
    isToken: false,
    isCommander: false,
    zone: 'stack',
    ...cardExtra,
  };
  const entry: EngineStackObject = {
    id: cardObj.id,
    sourceId: cardObj.id,
    controllerId,
    kind: 'spell',
    description: card.name,
    targets: [],
    card: cardObj,
    ability: def.spellAbility ?? { kind: 'spell', targets: [], effects: [] },
    sourceOracleId: def.oracleId,
    sourceCardId: cardObj.cardId,
    isCommanderCast: false,
    ...extra,
  };
  ctx.state.stack.push(entry);
  return entry;
}

const sweepCounterspell = (ctx: GameContext, target: EngineStackObject, controllerId = 'P1') =>
  pump(
    executeAbility(
      ctx,
      { cardId: 'sweep-cancel', name: 'Sweep Cancel', oracleId: 'sweep-cancel', controllerId },
      { kind: 'spell', targets: [{ kind: 'spell' }], effects: [{ op: 'counter', target: 0 }] },
      [target.id],
    ),
  );

describe('how a spell was cast stays with the permanent it became (CR 107.3m, 702.33d)', () => {
  it('a kicked creature that dies and is reanimated is not kicked, and has X = 0', () => {
    const ctx = pod();
    const card = keywordCreature('Sweep Kicked Beast', '', '{X}{G}', '2/2');
    const spell = spellOnStack(
      ctx,
      'P1',
      card,
      {},
      { announcedX: 3, optionalCostCounts: { kicker: 1 } },
    );
    const first = pump(moveObject(ctx, spell.card!, { zone: 'battlefield', controllerId: 'P1' }))
      .value as EnginePermanent;
    ctx.state.stack.pop();
    expect(first.wasKicked).toBe(true);
    const dead = pump(moveObject(ctx, first, { zone: 'graveyard' })).value as EngineCardObject;
    expect(dead.optionalCostCounts).toBeUndefined();
    expect(dead.announcedX).toBeUndefined();
    const back = pump(moveObject(ctx, dead, { zone: 'battlefield', controllerId: 'P1' }))
      .value as EnginePermanent;
    expect(back.wasKicked).toBeUndefined();
    expect(back.announcedX).toBeUndefined();
  });
});

describe('flashback leaves the stack only to exile (CR 702.34a)', () => {
  const flashbackSpell = () =>
    oracle({ name: 'Sweep Flashback Spell', typeLine: 'Sorcery', manaCost: '{1}{R}' });

  it('a countered flashback spell is exiled, not put into the graveyard', () => {
    const ctx = pod();
    const spell = spellOnStack(ctx, 'P2', flashbackSpell(), { exileOnResolution: true });
    sweepCounterspell(ctx, spell);
    expect(ctx.state.stack).toHaveLength(0);
    expect(ctx.state.exile.some((c) => c.cardId === spell.sourceCardId)).toBe(true);
    expect(ctx.state.players[1]!.graveyard.some((c) => c.cardId === spell.sourceCardId)).toBe(
      false,
    );
  });

  it('a flashback spell bounced off the stack is exiled, not returned to hand', () => {
    const ctx = pod();
    const spell = spellOnStack(ctx, 'P2', flashbackSpell(), { exileOnResolution: true });
    pump(
      executeAbility(
        ctx,
        {
          cardId: 'sweep-remand',
          name: 'Sweep Remand',
          oracleId: 'sweep-remand',
          controllerId: 'P1',
        },
        {
          kind: 'spell',
          targets: [{ kind: 'spell' }],
          effects: [{ op: 'returnToHand', target: 0 }],
        },
        [spell.id],
      ),
    );
    expect(ctx.state.exile.some((c) => c.cardId === spell.sourceCardId)).toBe(true);
    expect(ctx.state.players[1]!.hand.some((c) => c.cardId === spell.sourceCardId)).toBe(false);
  });
});

describe('"each player sacrifices" (CR 101.4)', () => {
  it('asks in APNAP order and sacrifices everything chosen at once', () => {
    const ctx = pod();
    ctx.state.currentTurnPlayer = 'P3';
    ctx.state.activePlayerIndex = 2;
    for (const id of ['P1', 'P2', 'P3', 'P4'] as const) {
      spawn(ctx, id, keywordCreature(`Sweep ${id} Bear A`, '', '{1}{G}'));
      spawn(ctx, id, keywordCreature(`Sweep ${id} Bear B`, '', '{1}{G}'));
    }
    const askedOrder: string[] = [];
    let creaturesWhenLastAsked = -1;
    pump(
      executeAbility(
        ctx,
        { cardId: 'sweep-edict', name: 'Sweep Edict', oracleId: 'sweep-edict', controllerId: 'P1' },
        {
          kind: 'spell',
          targets: [],
          effects: [{ op: 'sacrificeOneCreatureEachPlayer' }],
        },
        [],
      ),
      (d) => {
        askedOrder.push(d.player);
        creaturesWhenLastAsked = ctx.state.battlefield.length;
        return { index: 0, targets: new Map() };
      },
    );
    expect(askedOrder).toEqual(['P3', 'P4', 'P1', 'P2']);
    // Nothing left the battlefield until every player had chosen.
    expect(creaturesWhenLastAsked).toBe(8);
    expect(ctx.state.battlefield).toHaveLength(4);
  });
});

describe('a player leaving the game (CR 800.4a)', () => {
  it("returns permanents they controlled but didn't own to their owners", () => {
    const ctx = pod();
    const stolen = spawn(ctx, 'P1', keywordCreature('Sweep Stolen Bear', '', '{1}{G}'));
    stolen.controllerId = 'P2';
    ctx.state.players[1]!.life = 0;
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.eliminatedPlayers).toContain('P2');
    expect(ctx.state.battlefield.find((p) => p.cardId === stolen.cardId)?.controllerId).toBe('P1');
  });
});

describe('an eliminated player is out of the game (CR 800.4a, 102.2)', () => {
  it('takes every card they own with them, graveyard included', () => {
    const ctx = pod();
    conjure(ctx, 'P2', keywordCreature('Sweep Dead Bear', '', '{1}{G}'), 'graveyard');
    conjure(ctx, 'P2', redBolt(), 'graveyard');
    expect(cardTypesInAllGraveyards(ctx)).toBe(2);
    ctx.state.players[1]!.life = 0;
    pump(priorityCheckpoint(ctx));
    const p2 = ctx.state.players[1]!;
    expect(p2.graveyard).toHaveLength(0);
    expect(p2.hand).toHaveLength(0);
    expect(p2.library).toHaveLength(0);
    expect(cardTypesInAllGraveyards(ctx)).toBe(0);
  });

  it('is no longer counted as an opponent', () => {
    const ctx = pod();
    ctx.state.players[3]!.life = 0;
    pump(priorityCheckpoint(ctx));
    spawn(ctx, 'P1', keywordCreature('Sweep Counter Bear', '', '{1}{G}'));
    const scope = { controllerId: 'P1' as const, sourceCardId: 'sweep' };
    expect(evaluateValueIn(ctx, { kind: 'countOpponents' }, scope)).toBe(2);
    // P2 and P3 have no creatures; the departed P4 must not count as a third.
    expect(evaluateValueIn(ctx, { kind: 'countOpponentsWithFewerCreatures' }, scope)).toBe(2);
  });
});

describe('"if you created a token this turn"', () => {
  it('is set by creating a token, not by any permanent entering', () => {
    const ctx = pod();
    const source = { cardId: 'sweep', controllerId: 'P1' as const };
    const bearCard = conjure(ctx, 'P1', keywordCreature('Sweep Real Bear', '', '{1}{G}'), 'hand');
    pump(moveObject(ctx, bearCard, { zone: 'battlefield', controllerId: 'P1' }));
    expect(evaluateCondition(ctx, { kind: 'createdTokenThisTurn' }, source)).toBe(false);
    createToken(
      ctx,
      {
        name: 'Sweep Soldier',
        typeLine: 'Token Creature — Soldier',
        types: ['Creature'],
        subtypes: ['Soldier'],
        colors: ['W'],
        power: 1,
        toughness: 1,
      },
      'P1',
    );
    expect(evaluateCondition(ctx, { kind: 'createdTokenThisTurn' }, source)).toBe(true);
  });
});
