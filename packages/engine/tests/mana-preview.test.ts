/**
 * Tier 0 correctness fixes surfaced by a logged AI game misplaying its mana (see the
 * conversation that produced this file's ADR-adjacent context): a flexible mana source
 * collapsed to its first alternative in `PlayerView.availableMana`, `playLand` options carried
 * no data on what they produce, and re-equipping an Equipment to the creature it is already
 * attached to was offered as a legal (no-op) action.
 */

import { describe, expect, it } from 'vitest';
import type { PlayerId } from '@mtg/shared';
import { computePriorityOptions } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import { previewLandManaSymbols } from '../src/state/queries';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import { buildPlayerView } from '../src/view/view';
import { commanderFor, conjure, copies, forest, gameConfig, oracle, spawn } from './fixtures';

const playerOf = (ctx: GameContext, id: PlayerId): EnginePlayerState =>
  ctx.state.players.find((p) => p.id === id) as EnginePlayerState;

const land = (name: string, oracleText: string): ReturnType<typeof oracle> =>
  oracle({
    name,
    typeLine: 'Land',
    oracleText,
    manaCost: null,
    cmc: 0,
    power: null,
    toughness: null,
  });

const commandTower = (): ReturnType<typeof oracle> =>
  land('Test Tower', "{T}: Add one mana of any color in your commander's color identity.");

/** Yavimaya Coast, verbatim: two separate abilities sharing one permanent. */
const painlandFilter = (): ReturnType<typeof oracle> =>
  land('Test Coast', '{T}: Add {C}.\n{T}, Pay 1 life: Add {G} or {U}.');

function ctxWithCommander(colors: ('W' | 'U' | 'B' | 'R' | 'G')[]): GameContext {
  const cmd = oracle({
    name: 'Test Identity Commander',
    typeLine: 'Legendary Creature — Test Captain',
    manaCost: '{1}{G}',
    colors,
    colorIdentity: colors,
    power: '3',
    toughness: '3',
  });
  const ctx = createGame(
    gameConfig(
      [
        { commander: cmd, cards: copies(4, forest) },
        { commander: commanderFor('U', 'Opp Commander'), cards: copies(4, forest) },
      ],
      { seed: 'mana-preview' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

describe('PlayerView mana reporting (ADR 0010, Tier 0 fix)', () => {
  it('availableMana credits every alternative of a flexible source, not just the first', () => {
    const ctx = ctxWithCommander(['W', 'U', 'B', 'R', 'G']);
    spawn(ctx, 'P1', commandTower());

    const view = buildPlayerView(ctx, 'P1');
    for (const color of ['W', 'U', 'B', 'R', 'G'] as const) {
      expect(view.availableMana[color]).toBeGreaterThanOrEqual(1);
    }
  });

  it("manaSources groups a permanent's several abilities into one entry with the union of symbols", () => {
    const ctx = ctxWithCommander(['G']);
    spawn(ctx, 'P1', painlandFilter());

    const view = buildPlayerView(ctx, 'P1');
    const coast = view.manaSources.find((s) => s.name === 'Test Coast');
    expect(coast).toBeDefined();
    expect(coast?.symbols.sort()).toEqual(['C', 'G', 'U']);
    // Two abilities, each producing one mana — the permanent can only be tapped once, but
    // it is still two distinct alternatives worth reporting as "count".
    expect(coast?.count).toBe(2);
  });

  it("manaSources reports a Command Tower's full commander identity, not just one color", () => {
    const ctx = ctxWithCommander(['B', 'G', 'R']);
    spawn(ctx, 'P1', commandTower());

    const view = buildPlayerView(ctx, 'P1');
    const tower = view.manaSources.find((s) => s.name === 'Test Tower');
    expect(tower?.symbols.sort()).toEqual(['B', 'G', 'R']);
  });
});

describe('previewLandManaSymbols — what a hand land would produce if played (Tier 0 fix)', () => {
  it('resolves commander-identity production for a land still in hand', () => {
    const ctx = ctxWithCommander(['U', 'R']);
    const def = interpretCard(commandTower());
    ctx.defs.set(def.oracleId, def);

    const symbols = previewLandManaSymbols(ctx, def, 'P1');
    expect(symbols.sort()).toEqual(['R', 'U']);
  });

  it("resolves a static multi-ability land's full symbol set for a land still in hand", () => {
    const ctx = ctxWithCommander(['G']);
    const def = interpretCard(painlandFilter());
    ctx.defs.set(def.oracleId, def);

    const symbols = previewLandManaSymbols(ctx, def, 'P1');
    expect(symbols.sort()).toEqual(['C', 'G', 'U']);
  });
});

describe('playLand legal actions carry mana/tapped data (Tier 0 fix)', () => {
  it('offers every physical copy of a playable land, not just the first name match', () => {
    const ctx = ctxWithCommander(['G']);
    const first = conjure(ctx, 'P1', forest(), 'hand');
    const second = conjure(ctx, 'P1', forest(), 'hand');

    const options = computePriorityOptions(ctx, playerOf(ctx, 'P1')).filter(
      (option) => option.type === 'playLand' && option.description === 'Play Forest',
    );

    expect(options.map((option) => option.payload)).toEqual([
      { kind: 'playLand', objectId: first.id },
      { kind: 'playLand', objectId: second.id },
    ]);
  });

  it('a plain basic-like land reports its color and untapped-ness', () => {
    const ctx = ctxWithCommander(['G']);
    conjure(ctx, 'P1', forest(), 'hand');

    const options = computePriorityOptions(ctx, playerOf(ctx, 'P1'));
    const playForest = options.find(
      (o) => o.type === 'playLand' && o.description === 'Play Forest',
    );
    expect(playForest?.data?.['producesMana']).toEqual(['G']);
    expect(playForest?.data?.['entersTapped']).toBe(false);
  });

  it('a shockland in hand reports payLifeToUntap instead of a flat entersTapped', () => {
    const ctx = ctxWithCommander(['G']);
    const shock = land(
      'Test Shock',
      "As this land enters, you may pay 2 life. If you don't, it enters tapped.",
    );
    conjure(ctx, 'P1', shock, 'hand');

    const options = computePriorityOptions(ctx, playerOf(ctx, 'P1'));
    const playShock = options.find(
      (o) => o.type === 'playLand' && o.description === 'Play Test Shock',
    );
    expect(playShock?.data?.['payLifeToUntap']).toBe(2);
    expect(playShock?.data?.['entersTapped']).toBeUndefined();
  });

  it('publishes the authoritative auto-pay sources for a cast without changing legality', () => {
    const ctx = ctxWithCommander(['G']);
    const first = spawn(ctx, 'P1', forest());
    const second = spawn(ctx, 'P1', forest());
    const spell = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Test Double Green',
        typeLine: 'Sorcery',
        manaCost: '{G}{G}',
        power: null,
        toughness: null,
        oracleText: 'Draw a card.',
      }),
      'hand',
    );

    const cast = computePriorityOptions(ctx, playerOf(ctx, 'P1')).find(
      (option) =>
        option.type === 'castSpell' &&
        (option.payload as { objectId: string }).objectId === spell.id,
    );

    expect(cast?.data).toMatchObject({
      sourceName: 'Test Double Green',
      manaCost: '{G}{G}',
      paymentSourceIds: [first.id, second.id],
      paymentSourceNames: ['Forest', 'Forest'],
    });
  });

  it("unlocks lists a hand card that becomes castable once this land's mana is added", () => {
    const ctx = ctxWithCommander(['G']);
    // Hand has exactly one Forest (untapped, producing {G}) already on the battlefield is not
    // the point — the land in HAND is what should unlock a {G}{G} spell needing a second source.
    spawn(ctx, 'P1', forest());
    conjure(ctx, 'P1', forest(), 'hand');
    conjure(
      ctx,
      'P1',
      oracle({
        name: 'Test Double Green',
        typeLine: 'Sorcery',
        manaCost: '{G}{G}',
        power: null,
        toughness: null,
        oracleText: 'Draw a card.',
      }),
      'hand',
    );

    const options = computePriorityOptions(ctx, playerOf(ctx, 'P1'));
    const playForest = options.find(
      (o) => o.type === 'playLand' && o.description === 'Play Forest',
    );
    expect(playForest?.data?.['unlocks']).toContain('Test Double Green');
  });
});

describe('Equip no-op suppression (Tier 0 fix)', () => {
  const equipment = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Test Blade',
      typeLine: 'Artifact — Equipment',
      manaCost: '{1}',
      power: null,
      toughness: null,
      oracleText: 'Equip {0}',
    });

  const bear = (): ReturnType<typeof oracle> =>
    oracle({ name: 'Test Bear', typeLine: 'Creature — Bear', manaCost: '{1}{G}' });

  it('offers equipping an unattached creature', () => {
    const ctx = ctxWithCommander(['G']);
    spawn(ctx, 'P1', equipment());
    spawn(ctx, 'P1', bear());

    const options = computePriorityOptions(ctx, playerOf(ctx, 'P1'));
    const equip = options.find(
      (o) => o.type === 'activateAbility' && o.description.includes('Equip'),
    );
    expect(equip).toBeDefined();
    expect(equip?.targets?.[0]?.options).toHaveLength(1);
  });

  it('does not offer re-equipping to the creature already attached (a strict no-op)', () => {
    const ctx = ctxWithCommander(['G']);
    const eq = spawn(ctx, 'P1', equipment());
    const creature = spawn(ctx, 'P1', bear());
    eq.attachedTo = creature.id;

    const options = computePriorityOptions(ctx, playerOf(ctx, 'P1'));
    const equip = options.find(
      (o) => o.type === 'activateAbility' && o.description.includes('Equip'),
    );
    // The only legal creature target is the one it's already attached to, so the ability
    // is not offered at all (CR 602.2b treatment, extended to "no MEANINGFUL target").
    expect(equip).toBeUndefined();
  });

  it('still offers re-attaching to a DIFFERENT creature you control', () => {
    const ctx = ctxWithCommander(['G']);
    const eq = spawn(ctx, 'P1', equipment());
    const creatureA = spawn(ctx, 'P1', bear());
    const creatureB = spawn(ctx, 'P1', bear());
    eq.attachedTo = creatureA.id;

    const options = computePriorityOptions(ctx, playerOf(ctx, 'P1'));
    const equip = options.find(
      (o) => o.type === 'activateAbility' && o.description.includes('Equip'),
    );
    expect(equip?.targets?.[0]?.options).toEqual([creatureB.id]);
  });
});
