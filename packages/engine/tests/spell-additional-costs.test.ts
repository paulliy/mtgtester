/**
 * Additional costs on casting a spell (CR 601.2b/601.2h) — `CardDefinition.spellAdditionalCosts`.
 *
 * The EDH-staple coverage plan's Tier 2 item 1: the template
 * "As an additional cost to cast this spell, `<cost>`" appears on Village Rites, Deadly
 * Dispute, Thrill of Possibility, Big Score, Crop Rotation and Harrow, and before this there
 * was nowhere to hang a cost on a *spell* — `ActivatedAbility` carries `costs`, and
 * `modes[].additionalCost` is per-mode (Spree), not per-spell.
 *
 * The cards are named for orientation only; every case below is exercised through a synthetic
 * card built from the printed TEMPLATE, which is what the grammar actually contracts to. The
 * two halves that matter are tested separately, because either one alone is a bug:
 *
 *   - *payability gates the option* — a spell whose cost cannot be paid is never offered, or
 *     the engine hands the AI an action it will then refuse to apply;
 *   - *the cost is actually charged* — a parsed-but-unpaid cost makes the spell strictly
 *     better than printed, the failure mode brief §6.3 exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, mountain, oracle, pump, spawn, swamp } from './fixtures';

const villageRitesText =
  'As an additional cost to cast this spell, sacrifice a creature.\nDraw two cards.';

const villageRites = (): OracleCard =>
  oracle({
    name: 'Test Village Rites',
    typeLine: 'Instant',
    manaCost: '{B}',
    cmc: 1,
    colors: ['B'],
    colorIdentity: ['B'],
    power: null,
    toughness: null,
    oracleText: villageRitesText,
  });

const thrill = (): OracleCard =>
  oracle({
    name: 'Test Thrill',
    typeLine: 'Instant',
    manaCost: '{1}{R}',
    cmc: 2,
    colors: ['R'],
    colorIdentity: ['R'],
    power: null,
    toughness: null,
    oracleText: 'As an additional cost to cast this spell, discard a card.\nDraw two cards.',
  });

const bear = (name: string): OracleCard =>
  oracle({ name, typeLine: 'Creature — Bear', manaCost: '{1}{G}', power: '2', toughness: '2' });

function pod(seed = 'spell-additional-costs'): GameContext {
  const ctx = createGame(
    gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })), { seed }),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const p1 = (ctx: GameContext): EnginePlayerState =>
  ctx.state.players.find((p) => p.id === 'P1') as EnginePlayerState;

const castOptions = (ctx: GameContext, name: string): string[] =>
  computePriorityOptions(ctx, p1(ctx))
    .filter((o) => o.type === 'castSpell' && o.description.includes(name))
    .map((o) => o.description);

describe('spell additional costs — parsing', () => {
  it('reads the sacrifice template and still parses the spell’s own effect', () => {
    const def = interpretCard(villageRites());

    expect(def.modeled).toBe(true);
    expect(def.spellAdditionalCosts).toEqual([
      {
        kind: 'sacrificeOther',
        selector: {
          kind: 'allOf',
          of: [{ kind: 'other' }, { kind: 'controller', who: 'you' }, { kind: 'type', value: 'Creature' }],
        },
      },
    ]);
    expect(def.spellAbility?.effects).toEqual([{ op: 'draw', count: { kind: 'const', n: 2 } }]);
  });

  it('reads a discard cost', () => {
    const def = interpretCard(thrill());

    expect(def.modeled).toBe(true);
    expect(def.spellAdditionalCosts).toEqual([{ kind: 'discardCards', count: 1 }]);
  });

  it('reads "an artifact or creature" as a union, not a compound type', () => {
    // The Deadly Dispute shape. `anyOf` matters: a permanent needs to match EITHER type.
    const def = interpretCard(
      oracle({
        name: 'Test Dispute',
        typeLine: 'Instant',
        manaCost: '{1}{B}',
        power: null,
        toughness: null,
        oracleText:
          'As an additional cost to cast this spell, sacrifice an artifact or creature.\nDraw two cards.',
      }),
    );

    expect(def.modeled).toBe(true);
    expect(def.spellAdditionalCosts?.[0]).toEqual({
      kind: 'sacrificeOther',
      selector: {
        kind: 'allOf',
        of: [
          { kind: 'other' },
          { kind: 'controller', who: 'you' },
          { kind: 'anyOf', of: [{ kind: 'type', value: 'Artifact' }, { kind: 'type', value: 'Creature' }] },
        ],
      },
    });
  });

  it('leaves the card unmodeled when the cost phrase is not understood', () => {
    // Fail closed: a cost the engine cannot charge would otherwise be silently free.
    const def = interpretCard(
      oracle({
        name: 'Test Exile Cost',
        typeLine: 'Sorcery',
        manaCost: '{1}{G}',
        power: null,
        toughness: null,
        oracleText:
          'As an additional cost to cast this spell, exile a creature card from your graveyard.\nDraw two cards.',
      }),
    );

    expect(def.modeled).toBe(false);
    expect(def.spellAdditionalCosts).toBeUndefined();
    expect(def.unmodeledReasons.join(' ')).toContain('As an additional cost');
  });
});

describe('spell additional costs — legality', () => {
  it('does not offer the spell when the cost cannot be paid', () => {
    const ctx = pod();
    spawn(ctx, 'P1', swamp());
    conjure(ctx, 'P1', villageRites(), 'hand');

    // Mana is available; the missing creature is what makes the cast illegal (CR 601.2h).
    expect(castOptions(ctx, 'Test Village Rites')).toEqual([]);
  });

  it('offers it once a sacrificeable creature is on the battlefield', () => {
    const ctx = pod();
    spawn(ctx, 'P1', swamp());
    spawn(ctx, 'P1', bear('Test Bear A'));
    conjure(ctx, 'P1', villageRites(), 'hand');

    expect(castOptions(ctx, 'Test Village Rites')).toHaveLength(1);
  });

  it('never counts the spell itself as the card discarded for its own cost', () => {
    const ctx = pod();
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', mountain());
    const spell = conjure(ctx, 'P1', thrill(), 'hand');

    // Hand is the spell alone — CR 601.2a puts it on the stack before costs are paid, so
    // there is nothing left to discard.
    expect(p1(ctx).hand.map((c) => c.id)).toEqual([spell.id]);
    expect(castOptions(ctx, 'Test Thrill')).toEqual([]);

    conjure(ctx, 'P1', bear('Test Spare Card'), 'hand');
    expect(castOptions(ctx, 'Test Thrill')).toHaveLength(1);
  });
});

describe('spell additional costs — payment', () => {
  it('sacrifices the chosen creature as the spell is cast, then draws', () => {
    const ctx = pod();
    spawn(ctx, 'P1', swamp());
    const doomed = spawn(ctx, 'P1', bear('Test Bear A'));
    const spared = spawn(ctx, 'P1', bear('Test Bear B'));
    const spell = conjure(ctx, 'P1', villageRites(), 'hand');
    const handBefore = p1(ctx).hand.length;

    pump(
      applyPriorityAction(
        ctx,
        p1(ctx),
        { kind: 'castSpell', objectId: spell.id, fromCommand: false },
        { index: 0, targets: new Map() },
      ),
      (decision) => {
        const pick = decision.options.findIndex((o) => o.description === 'Sacrifice Test Bear A');
        return { index: pick >= 0 ? pick : 0, targets: new Map() };
      },
    );

    expect(ctx.state.battlefield.find((p) => p.id === doomed.id)).toBeUndefined();
    expect(ctx.state.battlefield.find((p) => p.id === spared.id)).toBeDefined();
    expect(p1(ctx).graveyard.some((c) => c.name === 'Test Bear A')).toBe(true);
    // The spell is on the stack and has not resolved, so no cards are drawn yet.
    expect(ctx.state.stack).toHaveLength(1);
    expect(p1(ctx).hand).toHaveLength(handBefore - 1);
  });

  it('discards a real card, and never the spell being cast', () => {
    const ctx = pod();
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', mountain());
    const spell = conjure(ctx, 'P1', thrill(), 'hand');
    const spare = conjure(ctx, 'P1', bear('Test Spare Card'), 'hand');

    pump(
      applyPriorityAction(
        ctx,
        p1(ctx),
        { kind: 'castSpell', objectId: spell.id, fromCommand: false },
        { index: 0, targets: new Map() },
      ),
    );

    // Zone changes re-id the object (CR 400.7), so identity is by name here.
    expect(p1(ctx).graveyard.map((c) => c.name)).toEqual([spare.name]);
    expect(p1(ctx).hand).toHaveLength(0);
    expect(ctx.state.stack).toHaveLength(1);
    expect(ctx.state.stack[0]?.description).toBe('Test Thrill');
  });
});
