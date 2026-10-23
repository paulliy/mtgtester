import { describe, expect, it } from 'vitest';
import { computeTargetOptions } from '../src/actions/legal';
import { computeCharacteristics } from '../src/effects/continuous';
import { queueStepTriggers } from '../src/turn/turn';
import { resolveTopOfStack } from '../src/stack/stack';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { conjure, oracle, pump, spawn } from './fixtures';
import {
  bear,
  castFromHand,
  p,
  pinned,
  pinnedDefinition,
  pod,
  putPendingTriggersOnStack,
  settle,
} from './pr10-helpers';

const artifactCreature = (name: string) =>
  oracle({ name, typeLine: 'Artifact Creature — Golem', power: '1', toughness: '1' });
const instant = (name: string) =>
  oracle({ name, typeLine: 'Instant', power: null, toughness: null, oracleText: 'Draw a card.' });

const pt = (ctx: GameContext, permanent: EnginePermanent) => {
  const chars = computeCharacteristics(ctx, permanent);
  return [chars.power, chars.toughness];
};

describe('PR10.15 Nighthawk Scavenger', () => {
  /** P1's Nighthawk Scavenger, entered through the real cast. */
  function scavenger(seed: string) {
    const ctx = pod(seed);
    castFromHand(ctx, 'P1', pinned('Nighthawk Scavenger'));
    pump(resolveTopOfStack(ctx));
    const nighthawk = ctx.state.battlefield.find(
      (permanent) => permanent.name === 'Nighthawk Scavenger',
    )!;
    return { ctx, nighthawk };
  }

  it('pr10-nighthawk-scavenger-pinned-oracle-supported — every line is modeled', () => {
    const def = pinnedDefinition('Nighthawk Scavenger');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
    expect(def.keywords).toEqual(expect.arrayContaining(['flying', 'deathtouch', 'lifelink']));
  });

  it('pr10-nighthawk-scavenger-empty — with no cards in opponents graveyards it is a 1/3', () => {
    const { ctx, nighthawk } = scavenger('pr10-nighthawk-empty');
    expect(pt(ctx, nighthawk)).toEqual([1, 3]);
  });

  it("pr10-nighthawk-scavenger-counts-types — each card type among opponents' graveyards counts once", () => {
    const { ctx, nighthawk } = scavenger('pr10-nighthawk-types');
    // Artifact and Creature from one card, Instant from another, and a repeated Creature.
    conjure(ctx, 'P2', artifactCreature('Graveyard Golem'), 'graveyard');
    conjure(ctx, 'P3', instant('Graveyard Insight'), 'graveyard');
    conjure(ctx, 'P4', bear('Graveyard Bear'), 'graveyard');
    expect(pt(ctx, nighthawk)).toEqual([4, 3]);
  });

  it('pr10-nighthawk-scavenger-own-graveyard — cards in your own graveyard do not count', () => {
    const { ctx, nighthawk } = scavenger('pr10-nighthawk-own');
    conjure(ctx, 'P1', artifactCreature('Own Golem'), 'graveyard');
    conjure(ctx, 'P1', instant('Own Insight'), 'graveyard');
    expect(pt(ctx, nighthawk)).toEqual([1, 3]);
  });

  it('pr10-nighthawk-scavenger-left-game — a player who left the game is no longer an opponent', () => {
    const { ctx, nighthawk } = scavenger('pr10-nighthawk-left');
    conjure(ctx, 'P2', instant('Departed Insight'), 'graveyard');
    expect(pt(ctx, nighthawk)).toEqual([2, 3]);
    p(ctx, 'P2').hasLost = true;
    ctx.state.eliminatedPlayers.push('P2');
    expect(pt(ctx, nighthawk)).toEqual([1, 3]);
  });
});

describe('PR10.28 Xenagos, God of Revels', () => {
  /** A noncreature permanent whose mana cost is exactly `manaCost`. */
  const devotionStone = (name: string, manaCost: string) =>
    oracle({ name, typeLine: 'Artifact', manaCost, power: null, toughness: null });

  /** P1's Xenagos, entered through the real cast. Its own {R}{G} is devotion 2. */
  function xenagos(seed: string) {
    const ctx = pod(seed);
    castFromHand(ctx, 'P1', pinned('Xenagos, God of Revels'));
    pump(resolveTopOfStack(ctx));
    const god = ctx.state.battlefield.find((permanent) => permanent.name.startsWith('Xenagos'))!;
    return { ctx, god };
  }
  const typesOf = (ctx: GameContext, permanent: EnginePermanent) => {
    const chars = computeCharacteristics(ctx, permanent);
    return { types: chars.types, subtypes: chars.subtypes };
  };

  it('pr10-xenagos-pinned-oracle-supported — every line is modeled', () => {
    const def = pinnedDefinition('Xenagos, God of Revels');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
    expect(def.keywords).toContain('indestructible');
  });

  it("pr10-xenagos-low-devotion — below seven it isn't a creature and isn't a God", () => {
    const { ctx, god } = xenagos('pr10-xenagos-low');
    expect(typesOf(ctx, god)).toEqual({ types: ['Enchantment'], subtypes: [] });
    expect(computeCharacteristics(ctx, god).supertypes).toContain('Legendary');
  });

  it('pr10-xenagos-seven-devotion — at seven it is an enchantment creature God', () => {
    const { ctx, god } = xenagos('pr10-xenagos-seven');
    spawn(ctx, 'P1', devotionStone('Revel Stone', '{R}{R}{G}{G}{R}'));
    expect(typesOf(ctx, god)).toEqual({
      types: ['Enchantment', 'Creature'],
      subtypes: ['God'],
    });
    expect(computeCharacteristics(ctx, god).power).toBe(6);
  });

  it('pr10-xenagos-hybrid-once — a red-green hybrid symbol counts once', () => {
    const { ctx, god } = xenagos('pr10-xenagos-hybrid');
    // Four hybrid symbols are devotion 4, not 8: 2 + 4 = 6.
    spawn(ctx, 'P1', devotionStone('Hybrid Stone', '{R/G}{R/G}{R/G}{R/G}'));
    expect(typesOf(ctx, god).types).not.toContain('Creature');
    // A red-white hybrid symbol counts too, for its red half: 7.
    spawn(ctx, 'P1', devotionStone('Mixed Stone', '{R/W}'));
    expect(typesOf(ctx, god).types).toContain('Creature');
  });

  it("pr10-xenagos-opponents-permanents — an opponent's symbols don't count", () => {
    const { ctx, god } = xenagos('pr10-xenagos-opponent');
    spawn(ctx, 'P2', devotionStone('Rival Stone', '{R}{R}{G}{G}{R}'));
    expect(typesOf(ctx, god).types).not.toContain('Creature');
  });

  it('pr10-xenagos-combat — another creature you control gains haste and doubles its power', () => {
    const { ctx, god } = xenagos('pr10-xenagos-combat');
    spawn(ctx, 'P1', devotionStone('Revel Stone', '{R}{R}{G}{G}{R}'));
    const ally = spawn(ctx, 'P1', bear('Revel Bear', { power: '3', toughness: '2' }));
    const rival = spawn(ctx, 'P2', bear('Revel Rival'));
    const spec = pinnedDefinition('Xenagos, God of Revels').triggers[0]!.targets[0]!;
    const legal = computeTargetOptions(ctx, spec, 'P1', ['R', 'G'], undefined, [], god.cardId);
    expect(legal).toContain(ally.id);
    expect(legal).not.toContain(god.id);
    expect(legal).not.toContain(rival.id);
    queueStepTriggers(ctx, 'beginningOfCombat');
    putPendingTriggersOnStack(ctx, () => ({ index: 0, targets: new Map([[0, ally.id]]) }));
    settle(ctx);
    const chars = computeCharacteristics(ctx, ally);
    expect([chars.power, chars.toughness]).toEqual([6, 5]);
    expect(chars.keywords).toContain('haste');
  });
});
