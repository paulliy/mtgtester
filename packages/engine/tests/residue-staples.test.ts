/**
 * The B6 residue — cards left over after the clustered sub-plans, each needing one small
 * primitive of its own rather than sharing a shape with anything else.
 *
 * - **Worldly Tutor** — a wording variant ("the card" for "that card") plus a real ordering fix:
 *   the shuffle must happen BEFORE the placement, or the tutor buries what it just fetched.
 * - **Windfall** — "draws cards equal to the greatest number of cards a player discarded this
 *   way". The number is unknowable until every hand is gone, which forced the executor into two
 *   phases — and that is more rules-correct for the fixed-count case too (CR 608.2 resolves the
 *   whole discard before the whole draw).
 * - **Command Beacon** — a way OUT of the command zone, which nothing else in the engine does.
 * - **Tireless Provisioner** — "create a Food token or a Treasure token" is a resolution-time
 *   modal choice, which `chooseOne` already expressed; Food itself did not exist.
 *
 * Oracle text below is verbatim (Scryfall bulk, checked 2026-09-04).
 */

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import { executeAbility, permanentSource } from '../src/effects/resolve';
import type { Ability } from '../src/cards/ability';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

function pod(seed = 'residue'): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
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

const run = (
  ctx: GameContext,
  effects: Ability['effects'],
  controller: EnginePlayerState,
  answer?: Parameters<typeof pump>[1],
): void => {
  const source = spawn(ctx, controller.id, bear());
  pump(
    executeAbility(ctx, permanentSource(source), { kind: 'spell', targets: [], effects }, []),
    answer,
  );
};

/**
 * Decline CR 903.9's "put it into the command zone instead" replacement.
 *
 * It fires on the way to hand and is offered to the commander's owner, so a test that takes the
 * default answer sends the commander straight back where it came from — which is what a Command
 * Beacon player would obviously never choose.
 */
const declineCommandZoneReplacement: Parameters<typeof pump>[1] = () => ({
  index: 1,
  targets: new Map(),
});

describe('Worldly Tutor', () => {
  it('shuffles before it puts the card on top', () => {
    const def = interpretCard(
      oracle({
        name: 'Test Tutor',
        typeLine: 'Instant',
        manaCost: '{G}',
        power: null,
        toughness: null,
        oracleText: 'Search your library for a creature card, reveal it, then shuffle and put the card on top.',
      }),
    );
    expect(def.modeled, JSON.stringify(def.unmodeledReasons)).toBe(true);
    // Order is the assertion: a shuffle AFTER the placement would bury the fetched card.
    expect(def.spellAbility?.effects[0]).toEqual({ op: 'shuffle' });
    expect(def.spellAbility?.effects[1]?.op).toBe('searchLibrary');
  });
});

describe('Windfall', () => {
  it('models the greatest-discarded count', () => {
    const def = interpretCard(
      oracle({
        name: 'Test Windfall',
        typeLine: 'Sorcery',
        manaCost: '{2}{U}',
        power: null,
        toughness: null,
        oracleText:
          'Each player discards their hand, then draws cards equal to the greatest number of cards a player discarded this way.',
      }),
    );
    expect(def.modeled, JSON.stringify(def.unmodeledReasons)).toBe(true);
    expect(def.spellAbility?.effects).toEqual([
      { op: 'eachPlayerDiscardHandThenDraw', greatestDiscarded: true },
    ]);
  });

  it('draws everyone up to the LARGEST hand discarded, not their own', () => {
    const ctx = pod();
    const [me, them] = ctx.state.players as [EnginePlayerState, EnginePlayerState];
    for (let i = 0; i < 1; i += 1) conjure(ctx, me.id, forest(), 'hand');
    for (let i = 0; i < 5; i += 1) conjure(ctx, them.id, forest(), 'hand');

    run(ctx, [{ op: 'eachPlayerDiscardHandThenDraw', greatestDiscarded: true }], me);

    // Five is the greatest anyone discarded, so EVERY player draws five — including the player
    // who pitched one. Drawing each player's own count instead is the obvious wrong answer.
    expect(me.hand.length).toBe(5);
    expect(them.hand.length).toBe(5);
    expect(me.graveyard.length).toBe(1);
    expect(them.graveyard.length).toBe(5);
  });

  it('discards every hand before anyone draws', () => {
    const ctx = pod();
    const [me, them] = ctx.state.players as [EnginePlayerState, EnginePlayerState];
    conjure(ctx, me.id, forest(), 'hand');
    conjure(ctx, them.id, forest(), 'hand');
    conjure(ctx, them.id, forest(), 'hand');

    run(ctx, [{ op: 'eachPlayerDiscardHandThenDraw', greatestDiscarded: true }], me);

    // If the loop discarded and drew per player, P1 would have drawn its cards before P2
    // discarded, and P2's discard count would then include them.
    expect(them.graveyard.length).toBe(2);
    expect(me.hand.length).toBe(2);
  });
});

describe('Command Beacon', () => {
  it('moves the commander out of the command zone into hand', () => {
    const def = interpretCard(
      oracle({
        name: 'Test Beacon',
        typeLine: 'Land',
        manaCost: null,
        power: null,
        toughness: null,
        oracleText: '{T}: Add {C}.\n{T}, Sacrifice this land: Put your commander into your hand from the command zone.',
      }),
    );
    expect(def.modeled, JSON.stringify(def.unmodeledReasons)).toBe(true);

    const ctx = pod();
    const me = ctx.state.players[0] as EnginePlayerState;
    const commander = conjure(ctx, me.id, bear(), 'command', { isCommander: true });
    me.commanderCardIds.push(commander.cardId);

    run(ctx, [{ op: 'commandZoneToHand' }], me, declineCommandZoneReplacement);

    expect(me.commandZone.some((c) => c.cardId === commander.cardId)).toBe(false);
    expect(me.hand.some((c) => c.cardId === commander.cardId)).toBe(true);
  });

  it('leaves a non-commander in the command zone alone', () => {
    const ctx = pod();
    const me = ctx.state.players[0] as EnginePlayerState;
    const stranger = conjure(ctx, me.id, bear(), 'command');

    run(ctx, [{ op: 'commandZoneToHand' }], me, declineCommandZoneReplacement);

    expect(me.commandZone.some((c) => c.cardId === stranger.cardId)).toBe(true);
  });
});

describe('Tireless Provisioner', () => {
  it('models the Food-or-Treasure choice as one modal effect', () => {
    const def = interpretCard(
      oracle({
        name: 'Test Provisioner',
        typeLine: 'Creature — Elf Scout',
        manaCost: '{2}{G}',
        power: '3',
        toughness: '2',
        oracleText: 'Landfall — Whenever a land you control enters, create a Food token or a Treasure token.',
      }),
    );
    expect(def.modeled, JSON.stringify(def.unmodeledReasons)).toBe(true);

    const effects = def.triggers?.[0]?.effects;
    expect(effects).toHaveLength(1);
    expect(effects?.[0]?.op).toBe('chooseOne');
    const options = (effects?.[0] as { options: { description: string }[] }).options;
    expect(options.map((o) => o.description)).toEqual([
      'Create a Food token',
      'Create a Treasure token',
    ]);
  });

  it('gives Food its full printed cost', () => {
    // All three components matter, the same way Treasure's two do: without the {2} it is free
    // life, without the tap it is repeatable, and without the sacrifice it is both.
    const def = interpretCard(
      oracle({
        name: 'Test Food Maker',
        typeLine: 'Sorcery',
        manaCost: '{1}{G}',
        power: null,
        toughness: null,
        oracleText: 'Create a Food token.',
      }),
    );
    const spec = (def.spellAbility?.effects[0] as { spec: { activatedAbilities?: { costs: { kind: string }[] }[] } }).spec;
    const costs = spec.activatedAbilities?.[0]?.costs.map((c) => c.kind);
    expect(costs).toEqual(['mana', 'tap', 'sacrificeSelf']);
  });
});
