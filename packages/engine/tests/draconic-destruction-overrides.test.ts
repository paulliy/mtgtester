/**
 * Behavioral tests for the 15 Draconic Destruction cards filled in on top of `main`'s existing
 * (previously empty-stub) registrations — see `cards/overrides/draconic-destruction.ts`. Each
 * test exercises the mechanic directly via `executeAbility`, not a `modeled === true` check
 * (per `overrides/index.ts`'s rule 3).
 */

import { describe, expect, it } from 'vitest';
import { effectivePT, getDefByOracleId } from '../src/state/queries';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { priorityCheckpoint } from '../src/sba/sba';
import { computeCharacteristics } from '../src/effects/continuous';
import { activationCostReductionFor } from '../src/actions/legal';
import type { EffectSource } from '../src/effects/resolve';
import type { GameContext } from '../src/state/types';
import { bear, copies, forest, gameConfig, oracle, pick, pump, registerDef, spawn } from './fixtures';

function pod(seed: string): GameContext {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) })), { seed }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  return ctx;
}

const p1 = (ctx: GameContext) => ctx.state.players.find((p) => p.id === 'P1')!;
const p2 = (ctx: GameContext) => ctx.state.players.find((p) => p.id === 'P2')!;

const sourceOf = (perm: ReturnType<typeof spawn>): EffectSource => ({
  cardId: perm.cardId,
  name: perm.name,
  oracleId: perm.oracleId,
  controllerId: perm.controllerId,
});

describe('Primal Might', () => {
  it('pumps the chosen creature and fights it against an opponent creature', () => {
    const ctx = pod('primal-might');
    const mine = spawn(ctx, 'P1', bear());
    const theirs = spawn(ctx, 'P2', bear());
    registerDef(ctx, oracle({
      oracleId: '58d7b8b3-ac47-4805-8259-4ba8e70d7dc3', name: 'Primal Might', typeLine: 'Sorcery', manaCost: '{X}{G}',
    }));
    const def = getDefByOracleId(ctx, '58d7b8b3-ac47-4805-8259-4ba8e70d7dc3', 'Primal Might');
    const ability = def.spellAbility!;

    pump(
      executeAbility(
        ctx,
        { cardId: 'c-pm', name: 'Primal Might', oracleId: def.oracleId, controllerId: 'P1' },
        ability,
        [mine.id],
        undefined,
        { x: 3 },
        { 1: [theirs.id] },
      ),
    );
    pump(priorityCheckpoint(ctx));

    // +3/+3 then fight: mine (2+3=5 power) deals 5 to theirs (2 toughness) — dead.
    // theirs (2 power) deals 2 back to mine (5 toughness) — mine survives, marked 2 damage.
    expect(ctx.state.battlefield.some((p) => p.cardId === theirs.cardId)).toBe(false);
    expect(ctx.state.battlefield.some((p) => p.cardId === mine.cardId)).toBe(true);
  });
});

describe('Hoard-Smelter Dragon', () => {
  it("destroys the target artifact and pumps by its mana value", () => {
    const ctx = pod('hoard-smelter');
    const dragon = spawn(ctx, 'P1', oracle({
      oracleId: 'cf9db2be-3c95-45a2-ab85-694e3bd3bf1d',
      name: 'Hoard-Smelter Dragon', typeLine: 'Creature — Dragon', manaCost: '{4}{R}', power: '4', toughness: '4',
    }));
    const artifact = spawn(ctx, 'P2', oracle({
      name: 'Test Artifact', typeLine: 'Artifact', manaCost: '{3}{R}',
    }));
    const def = getDefByOracleId(ctx, dragon.oracleId, dragon.name);
    const ability = def.activatedAbilities[0]!.ability;

    pump(executeAbility(ctx, sourceOf(dragon), ability, [artifact.id]));

    expect(ctx.state.battlefield.some((p) => p.cardId === artifact.cardId)).toBe(false);
    expect(effectivePT(ctx, dragon).power).toBe(8); // 4 base + 4 mana value
  });
});

describe('Steel Hellkite', () => {
  it('destroys each nonland permanent with mana value X whose controller it damaged this turn', () => {
    const ctx = pod('steel-hellkite');
    const hellkite = spawn(ctx, 'P1', oracle({
      oracleId: '6e64f1e0-ddd6-4ee7-8797-086e234b02e8',
      name: 'Steel Hellkite', typeLine: 'Artifact Creature — Dragon', manaCost: '{6}', power: '5', toughness: '5',
    }));
    const threeDrop = spawn(ctx, 'P2', oracle({ name: 'Three Drop', typeLine: 'Creature — Bear', manaCost: '{2}{G}', power: '2', toughness: '2' }));
    const twoDrop = spawn(ctx, 'P2', oracle({ name: 'Two Drop', typeLine: 'Creature — Bear', manaCost: '{1}{G}', power: '2', toughness: '2' }));
    ctx.state.combatDamagePlayersBySource[hellkite.cardId] = ['P2'];

    const def = getDefByOracleId(ctx, hellkite.oracleId, hellkite.name);
    const ability = def.activatedAbilities[1]!.ability;

    pump(executeAbility(ctx, sourceOf(hellkite), ability, [], undefined, { x: 3 }));

    expect(ctx.state.battlefield.some((p) => p.cardId === threeDrop.cardId)).toBe(false);
    expect(ctx.state.battlefield.some((p) => p.cardId === twoDrop.cardId)).toBe(true);
  });
});

describe('Thunderbreak Regent', () => {
  it('deals 3 damage to the opponent when a Dragon it controls becomes the target of their spell', () => {
    const ctx = pod('thunderbreak-regent');
    const regent = spawn(ctx, 'P1', oracle({
      oracleId: 'bb04f927-0348-4a14-9e74-381f18083f6a',
      name: 'Thunderbreak Regent', typeLine: 'Creature — Dragon', manaCost: '{3}{R}{R}', power: '4', toughness: '4',
    }));
    const def = getDefByOracleId(ctx, regent.oracleId, regent.name);
    const ability = def.triggers[0]!;
    const before = p2(ctx).life;

    pump(executeAbility(ctx, sourceOf(regent), ability, [], undefined, { eventPlayerId: 'P2' }));

    expect(p2(ctx).life).toBe(before - 3);
  });
});

describe('Dragonkin Berserker', () => {
  it('reduces Boast activation cost by {1} per Dragon controlled, and creates a Dragon token when boasted', () => {
    const ctx = pod('dragonkin-berserker');
    const berserker = spawn(ctx, 'P1', oracle({
      oracleId: '06b77a80-4968-4385-960a-fb66bb4faa94',
      name: 'Dragonkin Berserker', typeLine: 'Creature — Human Berserker', manaCost: '{2}{R}', power: '3', toughness: '3',
    }));
    spawn(ctx, 'P1', oracle({ name: 'Some Dragon', typeLine: 'Creature — Dragon', manaCost: '{2}{R}', power: '2', toughness: '2' }));

    const reduction = activationCostReductionFor(ctx, 'P1', berserker.oracleId, berserker.cardId);
    expect(reduction.generic).toBe(1);

    const def = getDefByOracleId(ctx, berserker.oracleId, berserker.name);
    const ability = def.activatedAbilities[0]!;
    expect(ability.requiresAttackedThisTurn).toBe(true);
    expect(ability.oncePerTurn).toBe(true);

    const before = ctx.state.battlefield.length;
    pump(executeAbility(ctx, sourceOf(berserker), ability.ability, []));
    expect(ctx.state.battlefield.length).toBe(before + 1);
    expect(ctx.state.battlefield.some((p) => p.name === 'Dragon' && p.controllerId === 'P1')).toBe(true);
  });
});

describe('Flameblast Dragon', () => {
  it('may pay {X}{R} on attack to deal X damage to any target', () => {
    const ctx = pod('flameblast-dragon');
    const dragon = spawn(ctx, 'P1', oracle({
      oracleId: '3180ee4f-66d7-4b73-bc10-9ee0c790ec18',
      name: 'Flameblast Dragon', typeLine: 'Creature — Dragon', manaCost: '{5}{R}{R}', power: '5', toughness: '5',
    }));
    p1(ctx).manaEntries = Array.from({ length: 6 }, () => ({ symbol: 'R' as const }));

    const def = getDefByOracleId(ctx, dragon.oracleId, dragon.name);
    const ability = def.triggers[0]!;
    const before = p2(ctx).life;

    pump(executeAbility(ctx, sourceOf(dragon), ability, [p2(ctx).id]), (dec) => pick(dec, 'Pay X=4'));

    expect(p2(ctx).life).toBe(before - 4);
  });
});

describe('Loaming Shaman', () => {
  it("shuffles the chosen graveyard cards into that player's library", () => {
    const ctx = pod('loaming-shaman');
    const shaman = spawn(ctx, 'P1', oracle({
      oracleId: 'cf7352bf-3971-4bb7-88b9-65ab9a219289',
      name: 'Loaming Shaman', typeLine: 'Creature — Human Shaman', manaCost: '{3}{G}', power: '3', toughness: '2',
    }));
    const gy = p2(ctx);
    gy.graveyard.push({
      id: 'gy-1', cardId: 'gy-c-1', oracleId: 'oracle-bear', ownerId: 'P2', name: 'Test Bear',
      typeLine: 'Creature — Bear', oracleText: '', manaCost: '{1}{G}', isToken: false, isCommander: false, zone: 'graveyard',
    });
    const before = gy.library.length;

    const def = getDefByOracleId(ctx, shaman.oracleId, shaman.name);
    const ability = def.triggers[0]!;

    pump(executeAbility(ctx, sourceOf(shaman), ability, ['P2', gy.id], undefined, undefined, { 1: ['gy-1'] }));

    expect(gy.graveyard.length).toBe(0);
    expect(gy.library.length).toBe(before + 1);
  });
});

describe('Foe-Razer Regent', () => {
  it('fights on entry and registers a delayed +1/+1 counter trigger for the fighting creature', () => {
    const ctx = pod('foe-razer-regent');
    const regent = spawn(ctx, 'P1', oracle({
      oracleId: 'e7dd3e2c-34a5-4097-b6d1-2ccd097fe57f',
      name: 'Foe-Razer Regent', typeLine: 'Creature — Dragon', manaCost: '{4}{R}{G}', power: '4', toughness: '4',
    }));
    const foe = spawn(ctx, 'P2', bear());
    const def = getDefByOracleId(ctx, regent.oracleId, regent.name);
    const enterAbility = def.triggers[0]!;

    pump(executeAbility(ctx, sourceOf(regent), enterAbility, [foe.id]));
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield.some((p) => p.cardId === foe.cardId)).toBe(false); // 4 damage kills a 2/2

    const fightsAbility = def.triggers[1]!;
    pump(executeAbility(ctx, sourceOf(regent), fightsAbility, [], regent.cardId));
    expect(ctx.state.delayedTriggers.length).toBe(1);
    expect(ctx.state.delayedTriggers[0]!.targetId).toBe(regent.cardId);
  });
});

describe('Atarka Monument', () => {
  it('becomes a 4/4 red and green Dragon artifact creature with flying until end of turn', () => {
    const ctx = pod('atarka-monument');
    const monument = spawn(ctx, 'P1', oracle({
      oracleId: 'eb287c04-97f5-4e47-beb1-66cc7d15e748',
      name: 'Atarka Monument', typeLine: 'Artifact', manaCost: '{3}',
    }));
    const def = getDefByOracleId(ctx, monument.oracleId, monument.name);
    const ability = def.activatedAbilities[0]!.ability;

    pump(executeAbility(ctx, sourceOf(monument), ability, []));

    const chars = computeCharacteristics(ctx, monument);
    expect(chars.types).toContain('Creature');
    expect(chars.subtypes).toContain('Dragon');
    expect(chars.keywords).toContain('flying');
    const pt = effectivePT(ctx, monument);
    expect(pt.power).toBe(4);
    expect(pt.toughness).toBe(4);
  });
});

describe('Clan Defiance', () => {
  it('deals X damage to target player or planeswalker under the third mode', () => {
    const ctx = pod('clan-defiance');
    registerDef(ctx, oracle({
      oracleId: 'abcf5e77-88fc-4b76-a1e8-907a5b27d612', name: 'Clan Defiance', typeLine: 'Sorcery', manaCost: '{X}{R}{R}{G}',
    }));
    const def = getDefByOracleId(ctx, 'abcf5e77-88fc-4b76-a1e8-907a5b27d612', 'Clan Defiance');
    const mode = def.spellAbility!.modes!.options[2]!;
    const ability = { ...def.spellAbility!, effects: mode.effects };
    const before = p2(ctx).life;

    pump(
      executeAbility(
        ctx,
        { cardId: 'c-cd', name: 'Clan Defiance', oracleId: def.oracleId, controllerId: 'P1' },
        ability,
        ['unused-0', 'unused-1', p2(ctx).id],
        undefined,
        { x: 5 },
      ),
    );

    expect(p2(ctx).life).toBe(before - 5);
  });
});

describe('Sarkhan, the Dragonspeaker', () => {
  it('+1 becomes a 4/4 Dragon creature (type-replacing) until end of turn', () => {
    const ctx = pod('sarkhan-plus1');
    const sarkhan = spawn(ctx, 'P1', oracle({
      oracleId: '80c26f58-04b0-4db0-b84e-9b136609abe0',
      name: 'Sarkhan, the Dragonspeaker', typeLine: 'Legendary Planeswalker — Sarkhan', manaCost: '{4}{R}{R}', loyalty: '4',
    }));
    const def = getDefByOracleId(ctx, sarkhan.oracleId, sarkhan.name);
    pump(executeAbility(ctx, sourceOf(sarkhan), def.activatedAbilities[0]!.ability, []));

    const chars = computeCharacteristics(ctx, sarkhan);
    expect(chars.types).toEqual(['Creature']);
    expect(chars.keywords).toEqual(expect.arrayContaining(['flying', 'indestructible', 'haste']));
  });

  it('-3 deals 4 damage to a creature and 4 damage back to itself', () => {
    const ctx = pod('sarkhan-minus3');
    const sarkhan = spawn(ctx, 'P1', oracle({
      oracleId: '80c26f58-04b0-4db0-b84e-9b136609abe0',
      name: 'Sarkhan, the Dragonspeaker', typeLine: 'Legendary Planeswalker — Sarkhan', manaCost: '{4}{R}{R}', loyalty: '4',
    }));
    sarkhan.counters['loyalty'] = 4;
    const foe = spawn(ctx, 'P2', bear());
    const def = getDefByOracleId(ctx, sarkhan.oracleId, sarkhan.name);

    pump(executeAbility(ctx, sourceOf(sarkhan), def.activatedAbilities[1]!.ability, [foe.id]));
    pump(priorityCheckpoint(ctx));

    expect(ctx.state.battlefield.some((p) => p.cardId === foe.cardId)).toBe(false);
    expect(sarkhan.counters['loyalty']).toBe(0);
  });

  it('-6 grants an emblem that draws two extra cards and discards the hand', () => {
    const ctx = pod('sarkhan-minus6');
    const sarkhan = spawn(ctx, 'P1', oracle({
      oracleId: '80c26f58-04b0-4db0-b84e-9b136609abe0',
      name: 'Sarkhan, the Dragonspeaker', typeLine: 'Legendary Planeswalker — Sarkhan', manaCost: '{4}{R}{R}', loyalty: '4',
    }));
    const def = getDefByOracleId(ctx, sarkhan.oracleId, sarkhan.name);
    pump(executeAbility(ctx, sourceOf(sarkhan), def.activatedAbilities[2]!.ability, []));

    expect(p1(ctx).emblems.length).toBe(1);
    expect(p1(ctx).emblems[0]!.abilities.length).toBe(2);
  });
});

describe('Spit Flame', () => {
  it('may return itself from the graveyard to hand by paying {R} when a Dragon enters', () => {
    const ctx = pod('spit-flame');
    const spitFlame = {
      id: 'gy-sf', cardId: 'c-sf', oracleId: 'f63278e0-3c67-421d-87ce-67725e5e74df', ownerId: 'P1',
      name: 'Spit Flame', typeLine: 'Sorcery', oracleText: '', manaCost: '{1}{R}', isToken: false, isCommander: false, zone: 'graveyard' as const,
    };
    p1(ctx).graveyard.push(spitFlame);
    p1(ctx).manaEntries = [{ symbol: 'R' }];
    registerDef(ctx, oracle({ oracleId: spitFlame.oracleId, name: 'Spit Flame', typeLine: 'Sorcery', manaCost: '{1}{R}' }));

    const def = getDefByOracleId(ctx, spitFlame.oracleId, spitFlame.name);
    const ability = def.triggers[0]!;

    pump(executeAbility(ctx, { cardId: 'c-sf', name: 'Spit Flame', oracleId: spitFlame.oracleId, controllerId: 'P1' }, ability, []));

    expect(p1(ctx).hand.some((c) => c.cardId === 'c-sf')).toBe(true);
    expect(p1(ctx).graveyard.some((c) => c.cardId === 'c-sf')).toBe(false);
  });
});

describe('Dream Pillager', () => {
  it('exiles cards equal to combat damage dealt, flagged playable until end of turn', () => {
    const ctx = pod('dream-pillager');
    const pillager = spawn(ctx, 'P1', oracle({
      oracleId: '504cc26d-3fd5-4391-9d30-f0614e5c8bbc',
      name: 'Dream Pillager', typeLine: 'Creature — Human Rogue', manaCost: '{3}{R}', power: '3', toughness: '2',
    }));
    const def = getDefByOracleId(ctx, pillager.oracleId, pillager.name);
    const ability = def.triggers[0]!;

    pump(executeAbility(ctx, sourceOf(pillager), ability, [], undefined, { damageDealt: 3 }));

    expect(ctx.state.exile.length).toBe(3);
    expect(ctx.state.exile.every((c) => c.playableUntilEotBy === 'P1')).toBe(true);
  });
});

describe('Dragon Mage', () => {
  it('each player discards their hand, then draws seven cards on combat damage', () => {
    const ctx = pod('dragon-mage');
    const mage = spawn(ctx, 'P1', oracle({
      oracleId: 'eab71e4e-27c3-4c41-b95f-259c1d14b97a',
      name: 'Dragon Mage', typeLine: 'Creature — Dragon', manaCost: '{4}{R}{R}', power: '4', toughness: '4',
    }));
    p1(ctx).hand = [{ id: 'h1', cardId: 'h1c', oracleId: 'oracle-bear', ownerId: 'P1', name: 'Bear', typeLine: 'Creature — Bear', oracleText: '', manaCost: '{1}{G}', isToken: false, isCommander: false, zone: 'hand' }];
    const before2 = p2(ctx).library.length;
    const before1 = p1(ctx).library.length;

    const def = getDefByOracleId(ctx, mage.oracleId, mage.name);
    pump(executeAbility(ctx, sourceOf(mage), def.triggers[0]!, []));

    expect(p1(ctx).hand.length).toBe(7);
    expect(p2(ctx).hand.length).toBe(7);
    expect(p1(ctx).library.length).toBe(before1 - 7);
    expect(p2(ctx).library.length).toBe(before2 - 7);
  });
});

describe('Runehorn Hellkite', () => {
  it('exiling itself from the graveyard makes each player discard, then draw seven', () => {
    const ctx = pod('runehorn-hellkite');
    const hellkite = {
      id: 'gy-rh', cardId: 'c-rh', oracleId: 'a3f2c946-409f-4093-b4db-c954d3480a72', ownerId: 'P1',
      name: 'Runehorn Hellkite', typeLine: 'Creature — Dragon', oracleText: '', manaCost: '{4}{R}{R}', isToken: false, isCommander: false, zone: 'graveyard' as const,
    };
    p1(ctx).graveyard.push(hellkite);
    registerDef(ctx, oracle({ oracleId: hellkite.oracleId, name: 'Runehorn Hellkite', typeLine: 'Creature — Dragon', manaCost: '{4}{R}{R}' }));
    const before1 = p1(ctx).library.length;

    const def = getDefByOracleId(ctx, hellkite.oracleId, hellkite.name);
    const ability = def.activatedAbilities[0]!;
    expect(ability.zone).toBe('graveyard');
    expect(ability.costs.some((c) => c.kind === 'exileSelfFromGraveyard')).toBe(true);

    pump(executeAbility(ctx, { cardId: 'c-rh', name: 'Runehorn Hellkite', oracleId: hellkite.oracleId, controllerId: 'P1' }, ability.ability, []));

    expect(p1(ctx).hand.length).toBe(7);
    expect(p1(ctx).library.length).toBe(before1 - 7);
  });
});
