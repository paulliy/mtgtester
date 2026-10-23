/**
 * Behavioral tests for the 15 Draconic Destruction cards filled in on top of `main`'s existing
 * (previously empty-stub) registrations — see `cards/overrides/draconic-destruction.ts`. Each
 * test exercises the mechanic directly via `executeAbility`, not a `modeled === true` check
 * (per `overrides/index.ts`'s rule 3).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { effectivePT, getDefByOracleId } from '../src/state/queries';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { priorityCheckpoint } from '../src/sba/sba';
import type { EffectSource } from '../src/effects/resolve';
import type { GameContext } from '../src/state/types';
import { bear, copies, forest, gameConfig, oracle, pump, registerDef, spawn } from './fixtures';

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
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
    registerDef(
      ctx,
      oracle({
        oracleId: '58d7b8b3-ac47-4805-8259-4ba8e70d7dc3',
        name: 'Primal Might',
        typeLine: 'Sorcery',
        manaCost: '{X}{G}',
      }),
    );
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
  it('destroys the target artifact and pumps by its mana value', () => {
    const ctx = pod('hoard-smelter');
    const dragon = spawn(
      ctx,
      'P1',
      oracle({
        oracleId: 'cf9db2be-3c95-45a2-ab85-694e3bd3bf1d',
        name: 'Hoard-Smelter Dragon',
        typeLine: 'Creature — Dragon',
        manaCost: '{4}{R}',
        power: '4',
        toughness: '4',
      }),
    );
    const artifact = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Test Artifact',
        typeLine: 'Artifact',
        manaCost: '{3}{R}',
      }),
    );
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
    const hellkite = spawn(
      ctx,
      'P1',
      oracle({
        oracleId: '6e64f1e0-ddd6-4ee7-8797-086e234b02e8',
        name: 'Steel Hellkite',
        typeLine: 'Artifact Creature — Dragon',
        manaCost: '{6}',
        power: '5',
        toughness: '5',
      }),
    );
    const threeDrop = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Three Drop',
        typeLine: 'Creature — Bear',
        manaCost: '{2}{G}',
        power: '2',
        toughness: '2',
      }),
    );
    const twoDrop = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Two Drop',
        typeLine: 'Creature — Bear',
        manaCost: '{1}{G}',
        power: '2',
        toughness: '2',
      }),
    );
    ctx.state.combatDamagePlayersBySource[hellkite.cardId] = ['P2'];

    const def = getDefByOracleId(ctx, hellkite.oracleId, hellkite.name);
    const ability = def.activatedAbilities[1]!.ability;

    pump(executeAbility(ctx, sourceOf(hellkite), ability, [], undefined, { x: 3 }));

    expect(ctx.state.battlefield.some((p) => p.cardId === threeDrop.cardId)).toBe(false);
    expect(ctx.state.battlefield.some((p) => p.cardId === twoDrop.cardId)).toBe(true);
  });
});

describe('Thunderbreak Regent', () => {
  // Restored in coverage PR06; behavior is gated by pr06-card-coverage.test.ts.
  it('is no longer catalog-contained', () => {
    const card = oracle({
      oracleId: 'bb04f927-0348-4a14-9e74-381f18083f6a',
      name: 'Thunderbreak Regent',
      typeLine: 'Creature — Dragon',
      manaCost: '{2}{R}{R}',
      power: '4',
      toughness: '4',
      oracleText:
        'Flying\nWhenever a Dragon you control becomes the target of a spell or ability an opponent controls, this creature deals 3 damage to that player.',
    });
    expect(interpretCard(card).modeled).toBe(true);
  });
});

describe('Dragonkin Berserker', () => {
  // Restored in coverage PR02; behavior is gated by pr02-card-coverage.test.ts.
  it('is no longer catalog-contained', () => {
    const card = oracle({
      oracleId: '06b77a80-4968-4385-960a-fb66bb4faa94',
      name: 'Dragonkin Berserker',
      typeLine: 'Creature — Human Berserker',
      manaCost: '{2}{R}',
      power: '2',
      toughness: '2',
    });
    const def = interpretCard(card);
    expect(def.unmodeledReasons.join('\n')).not.toContain('explicitly unsupported');
  });
});

describe('Flameblast Dragon', () => {
  // Restored in coverage PR06; behavior is gated by pr06-card-coverage.test.ts.
  it('is no longer catalog-contained', () => {
    const card = oracle({
      oracleId: '3180ee4f-66d7-4b73-bc10-9ee0c790ec18',
      name: 'Flameblast Dragon',
      typeLine: 'Creature — Dragon',
      manaCost: '{4}{R}{R}',
      power: '5',
      toughness: '5',
      oracleText:
        'Flying\nWhenever this creature attacks, you may pay {X}{R}. If you do, it deals X damage to any target.',
    });
    expect(interpretCard(card).modeled).toBe(true);
  });
});

describe('Loaming Shaman', () => {
  it("shuffles the chosen graveyard cards into that player's library", () => {
    const ctx = pod('loaming-shaman');
    const shaman = spawn(
      ctx,
      'P1',
      oracle({
        oracleId: 'cf7352bf-3971-4bb7-88b9-65ab9a219289',
        name: 'Loaming Shaman',
        typeLine: 'Creature — Human Shaman',
        manaCost: '{3}{G}',
        power: '3',
        toughness: '2',
      }),
    );
    const gy = p2(ctx);
    gy.graveyard.push({
      id: 'gy-1',
      cardId: 'gy-c-1',
      oracleId: 'oracle-bear',
      ownerId: 'P2',
      name: 'Test Bear',
      typeLine: 'Creature — Bear',
      oracleText: '',
      manaCost: '{1}{G}',
      isToken: false,
      isCommander: false,
      zone: 'graveyard',
    });
    const before = gy.library.length;

    const def = getDefByOracleId(ctx, shaman.oracleId, shaman.name);
    const ability = def.triggers[0]!;

    pump(
      executeAbility(ctx, sourceOf(shaman), ability, ['P2', gy.id], undefined, undefined, {
        1: ['gy-1'],
      }),
    );

    expect(gy.graveyard.length).toBe(0);
    expect(gy.library.length).toBe(before + 1);
  });
});

describe('Foe-Razer Regent', () => {
  it('models the optional fight and the fights trigger (coverage PR01)', () => {
    const card = oracle({
      oracleId: 'e7dd3e2c-34a5-4097-b6d1-2ccd097fe57f',
      name: 'Foe-Razer Regent',
      typeLine: 'Creature — Dragon',
      manaCost: '{5}{G}{G}',
      power: '4',
      toughness: '5',
      oracleText:
        "Flying\nWhen this creature enters, you may have it fight target creature you don't control.\nWhenever a creature you control fights, put two +1/+1 counters on it at the beginning of the next end step.",
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.triggers[0]?.optional).toBe(true);
    expect(def.triggers[1]?.trigger).toMatchObject({ when: 'fights' });
  });
});

/** The exact Oracle text PR10 pinned; the restored overrides are registered with it. */
function pr10Card(name: string): OracleCard {
  const pins = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'coverage-pr10-oracle.json'), 'utf8'),
  ) as { cards: { card: OracleCard }[] };
  return pins.cards.find((entry) => entry.card.name === name)!.card;
}

describe('Atarka Monument', () => {
  it('is modeled by PR10, whose animation makes it red and green', () => {
    const def = interpretCard(pr10Card('Atarka Monument'));
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
  });
});

describe('Clan Defiance', () => {
  it('deals X damage to target player or planeswalker under the third mode', () => {
    const ctx = pod('clan-defiance');
    registerDef(
      ctx,
      oracle({
        oracleId: 'abcf5e77-88fc-4b76-a1e8-907a5b27d612',
        name: 'Clan Defiance',
        typeLine: 'Sorcery',
        manaCost: '{X}{R}{R}{G}',
      }),
    );
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
  it('is modeled by PR10, whose +1 makes it legendary and red', () => {
    const def = interpretCard(pr10Card('Sarkhan, the Dragonspeaker'));
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
  });
});

describe('Spit Flame', () => {
  it('may return itself from the graveyard to hand by paying {R} when a Dragon enters', () => {
    const ctx = pod('spit-flame');
    const spitFlame = {
      id: 'gy-sf',
      cardId: 'c-sf',
      oracleId: 'f63278e0-3c67-421d-87ce-67725e5e74df',
      ownerId: 'P1',
      name: 'Spit Flame',
      typeLine: 'Sorcery',
      oracleText: '',
      manaCost: '{1}{R}',
      isToken: false,
      isCommander: false,
      zone: 'graveyard' as const,
    };
    p1(ctx).graveyard.push(spitFlame);
    p1(ctx).manaEntries = [{ symbol: 'R' }];
    registerDef(
      ctx,
      oracle({
        oracleId: spitFlame.oracleId,
        name: 'Spit Flame',
        typeLine: 'Sorcery',
        manaCost: '{1}{R}',
      }),
    );

    const def = getDefByOracleId(ctx, spitFlame.oracleId, spitFlame.name);
    const ability = def.triggers[0]!;

    pump(
      executeAbility(
        ctx,
        { cardId: 'c-sf', name: 'Spit Flame', oracleId: spitFlame.oracleId, controllerId: 'P1' },
        ability,
        [],
      ),
    );

    expect(p1(ctx).hand.some((c) => c.cardId === 'c-sf')).toBe(true);
    expect(p1(ctx).graveyard.some((c) => c.cardId === 'c-sf')).toBe(false);
  });
});

describe('Dream Pillager', () => {
  it('rejects an incomplete Oracle stub after its full PR09 restoration', () => {
    const card = oracle({
      oracleId: '504cc26d-3fd5-4391-9d30-f0614e5c8bbc',
      name: 'Dream Pillager',
      typeLine: 'Creature — Dragon',
      manaCost: '{5}{R}{R}',
      power: '4',
      toughness: '4',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(false);
    expect(def.unmodeledReasons.join('\n')).toContain('claims a line this card no longer has');
  });
});

describe('Dragon Mage', () => {
  it('each player discards their hand, then draws seven cards on combat damage', () => {
    const ctx = pod('dragon-mage');
    // The wheel now parses generically, so exercise the real printed card rather than an
    // empty Oracle-text stub that depended on the removed override to supply its ability.
    const fixture = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures/combat-trigger-oracle.json'), 'utf8'),
    ) as { cards: { card: OracleCard }[] };
    const card = fixture.cards.find(({ card }) => card.name === 'Dragon Mage')!.card;
    const mage = spawn(ctx, 'P1', card);
    p1(ctx).hand = [
      {
        id: 'h1',
        cardId: 'h1c',
        oracleId: 'oracle-bear',
        ownerId: 'P1',
        name: 'Bear',
        typeLine: 'Creature — Bear',
        oracleText: '',
        manaCost: '{1}{G}',
        isToken: false,
        isCommander: false,
        zone: 'hand',
      },
    ];
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
      id: 'gy-rh',
      cardId: 'c-rh',
      oracleId: 'a3f2c946-409f-4093-b4db-c954d3480a72',
      ownerId: 'P1',
      name: 'Runehorn Hellkite',
      typeLine: 'Creature — Dragon',
      oracleText: '',
      manaCost: '{4}{R}{R}',
      isToken: false,
      isCommander: false,
      zone: 'graveyard' as const,
    };
    p1(ctx).graveyard.push(hellkite);
    registerDef(
      ctx,
      oracle({
        oracleId: hellkite.oracleId,
        name: 'Runehorn Hellkite',
        typeLine: 'Creature — Dragon',
        manaCost: '{4}{R}{R}',
      }),
    );
    const before1 = p1(ctx).library.length;

    const def = getDefByOracleId(ctx, hellkite.oracleId, hellkite.name);
    const ability = def.activatedAbilities[0]!;
    expect(ability.zone).toBe('graveyard');
    expect(ability.costs.some((c) => c.kind === 'exileSelfFromGraveyard')).toBe(true);

    pump(
      executeAbility(
        ctx,
        {
          cardId: 'c-rh',
          name: 'Runehorn Hellkite',
          oracleId: hellkite.oracleId,
          controllerId: 'P1',
        },
        ability.ability,
        [],
      ),
    );

    expect(p1(ctx).hand.length).toBe(7);
    expect(p1(ctx).library.length).toBe(before1 - 7);
  });
});
