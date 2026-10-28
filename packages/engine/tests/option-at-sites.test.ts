/**
 * ADR 0034 decision 3: a decision answer whose index is outside the offered options is a test
 * driver or engine bug, so every "true fallback" site reads it through `optionAt` and throws
 * `EngineInvariantError` rather than quietly taking the first option. One test per site listed in
 * `docs/reviews/decision-index-sites-2026-10-28.md`; each reaches the decision through the real
 * generator, answers it with `options.length`, and answers every other decision validly.
 */

import { describe, expect, it } from 'vitest';
import type { Ability, Effect } from '../src/cards/ability';
import { interpretCard } from '../src/cards/interpret';
import { ofType } from '../src/cards/selector';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { dealDamageToPlayer, executeAbility, permanentSource } from '../src/effects/resolve';
import { EngineInvariantError } from '../src/errors';
import { priorityCheckpoint } from '../src/sba/sba';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { bear, conjure, copies, forest, gameConfig, island, oracle, pump, spawn } from './fixtures';

function pod(players: number, seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: players }, () => ({ cards: copies(8, forest) })),
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

const named = (name: string) => oracle({ name, typeLine: 'Creature — Test', manaCost: '{1}' });

/** Answer the decision whose prompt matches with an index one past its menu; all others with 0. */
const outOfRangeOn =
  (prompt: RegExp) =>
  (decision: PendingDecision): DecisionOutcome =>
    prompt.test(decision.prompt)
      ? { index: decision.options.length, targets: new Map() }
      : { index: 0, targets: new Map() };

/** Run `body`, require it to throw `EngineInvariantError`, and return the error's site. */
function invariantSite(body: () => unknown): string {
  let thrown: unknown;
  try {
    body();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(EngineInvariantError);
  return (thrown as EngineInvariantError).site;
}

const triggered = (effects: Effect[]): Ability => ({
  kind: 'triggered',
  targets: [],
  effects,
  description: 'Test ability',
});

/** Resolve `effects` as an ability of a fresh P1 permanent, answering out of range on `prompt`. */
function resolveOutOfRange(ctx: GameContext, effects: Effect[], prompt: RegExp): string {
  const holder = spawn(ctx, 'P1', named('Ability Holder'));
  return invariantSite(() =>
    pump(
      executeAbility(ctx, permanentSource(holder), triggered(effects), []),
      outOfRangeOn(prompt),
    ),
  );
}

describe('an out-of-range answer at an optionAt site throws EngineInvariantError (ADR 0034)', () => {
  it('resolve.chooseEnteringAttackTarget', () => {
    const ctx = pod(2, 'option-at-attack-target');
    // A planeswalker gives the one opponent two choices: the player or the planeswalker.
    spawn(
      ctx,
      'P2',
      oracle({
        name: 'Test Walker',
        typeLine: 'Planeswalker — Test',
        manaCost: '{3}',
        loyalty: '3',
      }),
    );
    const site = resolveOutOfRange(
      ctx,
      [
        {
          op: 'createTokenForEachOpponent',
          spec: {
            name: 'Test Token',
            typeLine: 'Token Creature — Test',
            types: ['Creature'],
            subtypes: ['Test'],
            colors: [],
            power: 1,
            toughness: 1,
          },
          attacking: true,
          orPlaneswalker: true,
        },
      ],
      /choose who the token attacks/,
    );
    expect(site).toBe('resolve.chooseEnteringAttackTarget');
  });

  it('resolve.executeAbility.modes', () => {
    const ctx = pod(2, 'option-at-ability-modes');
    const holder = spawn(ctx, 'P1', named('Modal Holder'));
    const ability: Ability = {
      kind: 'activated',
      targets: [],
      effects: [],
      modes: {
        minChoices: 1,
        maxChoices: 1,
        options: [
          { effects: [], description: 'First mode' },
          { effects: [], description: 'Second mode' },
        ],
      },
    };
    const site = invariantSite(() =>
      pump(executeAbility(ctx, permanentSource(holder), ability, []), outOfRangeOn(/choose modes/)),
    );
    expect(site).toBe('resolve.executeAbility.modes');
  });

  it('resolve.chooseOne', () => {
    const ctx = pod(2, 'option-at-choose-one');
    const site = resolveOutOfRange(
      ctx,
      [
        {
          op: 'chooseOne',
          options: [
            { effects: [], description: 'Option A' },
            { effects: [], description: 'Option B' },
          ],
        },
      ],
      /choose one/,
    );
    expect(site).toBe('resolve.chooseOne');
  });

  it('resolve.populate', () => {
    const ctx = pod(2, 'option-at-populate');
    // Two creature tokens make "which one to copy" a real choice.
    spawn(ctx, 'P1', named('Token A'), { isToken: true });
    spawn(ctx, 'P1', named('Token B'), { isToken: true });
    const site = resolveOutOfRange(ctx, [{ op: 'populate' }], /populate/);
    expect(site).toBe('resolve.populate');
  });

  it('resolve.returnOneFromYourGraveyardToBattlefield', () => {
    const ctx = pod(2, 'option-at-graveyard-return');
    // Differently named cards, so the choice is not collapsed to one.
    conjure(ctx, 'P1', named('Dead A'), 'graveyard');
    conjure(ctx, 'P1', named('Dead B'), 'graveyard');
    const site = resolveOutOfRange(
      ctx,
      [{ op: 'returnOneFromYourGraveyardToBattlefield', filter: ofType('Creature') }],
      /from your graveyard to the battlefield/,
    );
    expect(site).toBe('resolve.returnOneFromYourGraveyardToBattlefield');
  });

  it('resolve.shadrixModes', () => {
    const ctx = pod(4, 'option-at-shadrix');
    const site = resolveOutOfRange(ctx, [{ op: 'shadrixModes' }], /choose the first target player/);
    expect(site).toBe('resolve.shadrixModes');
  });

  it('resolve.vindictiveLichModes', () => {
    const ctx = pod(4, 'option-at-vindictive-lich');
    const site = resolveOutOfRange(ctx, [{ op: 'vindictiveLichModes' }], /choose the opponent/);
    expect(site).toBe('resolve.vindictiveLichModes');
  });

  it('resolve.halfLifeDrainTargetOpponent', () => {
    const ctx = pod(4, 'option-at-half-life');
    const site = resolveOutOfRange(
      ctx,
      [{ op: 'halfLifeDrainTargetOpponent' }],
      /choose an opponent/,
    );
    expect(site).toBe('resolve.halfLifeDrainTargetOpponent');
  });

  it('resolve.reflexiveOnCreatedToken', () => {
    const ctx = pod(2, 'option-at-reflexive-token');
    const site = resolveOutOfRange(
      ctx,
      [
        {
          op: 'createToken',
          spec: {
            name: 'Test Token',
            typeLine: 'Token Creature — Test',
            types: ['Creature'],
            subtypes: ['Test'],
            colors: [],
            power: 1,
            toughness: 1,
          },
          count: { kind: 'const', n: 2 },
        },
        { op: 'reflexiveOnCreatedToken', then: triggered([]) },
      ],
      /the reflexive ability refers to/,
    );
    expect(site).toBe('resolve.reflexiveOnCreatedToken');
  });

  it('resolve.returnOneToHand', () => {
    const ctx = pod(2, 'option-at-return-one-to-hand');
    spawn(ctx, 'P2', named('Bounce A'));
    spawn(ctx, 'P2', named('Bounce B'));
    const site = resolveOutOfRange(
      ctx,
      [{ op: 'returnOneToHand', selector: ofType('Creature') }],
      /return to its owner/,
    );
    expect(site).toBe('resolve.returnOneToHand');
  });

  it('resolve.chooseOpponentForSource', () => {
    const ctx = pod(4, 'option-at-choose-opponent');
    const site = resolveOutOfRange(ctx, [{ op: 'chooseOpponentForSource' }], /choose an opponent/);
    expect(site).toBe('resolve.chooseOpponentForSource');
  });

  it('resolve.searchBasicsNamedLikeChosenLand', () => {
    const ctx = pod(2, 'option-at-named-land');
    // Two differently named lands: the menu has one entry per distinct name.
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', island());
    const site = resolveOutOfRange(
      ctx,
      [{ op: 'searchBasicsNamedLikeChosenLand', count: 1, destination: { zone: 'hand' } }],
      /choose a land you control/,
    );
    expect(site).toBe('resolve.searchBasicsNamedLikeChosenLand');
  });

  it('resolve.addManaFromAbility', () => {
    const ctx = pod(2, 'option-at-add-mana');
    // No `manaSplit` on the answer, so there is no valid split and the index is read instead.
    const site = resolveOutOfRange(
      ctx,
      [{ op: 'addMana', amount: { kind: 'const', n: 3 }, colors: 'any' }],
      /distribute all 3 mana/,
    );
    expect(site).toBe('resolve.addManaFromAbility');
  });

  it('damageModifiers.applyDamageModifiers', () => {
    const ctx = pod(2, 'option-at-damage-order');
    const shieldSource = permanentSource(spawn(ctx, 'P1', named('Shield Source')));
    // Two prevention shields over the same damage; the one-shot's consequence differs by order,
    // so the order is a real choice (CR 616.1).
    ctx.state.damageShields.push(
      { id: 'shield-a', effectSource: shieldSource, playerId: 'P1', oneShot: true },
      { id: 'shield-b', effectSource: shieldSource, playerId: 'P1' },
    );
    const attacker = spawn(ctx, 'P2', named('Attacker'));
    const site = invariantSite(() =>
      pump(
        dealDamageToPlayer(
          ctx,
          permanentSource(attacker),
          ctx.state.players.find((p) => p.id === 'P1')!,
          3,
          { combat: false, sourceIsCommander: false, sourceHasLifelink: false },
        ),
        outOfRangeOn(/Choose which effect applies first/),
      ),
    );
    expect(site).toBe('damageModifiers.applyDamageModifiers');
  });

  it('sba.pushTriggerOnStack.modes', () => {
    const ctx = pod(2, 'option-at-trigger-modes');
    // Adaptive Sporesinger: "choose one — target creature gets +2/+2 / proliferate". A creature
    // on the board makes both modes choosable.
    spawn(ctx, 'P1', bear());
    const sporesinger = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Adaptive Sporesinger',
        typeLine: 'Creature — Phyrexian Druid',
        manaCost: '{2}{G}',
        power: '2',
        toughness: '3',
        keywords: ['Vigilance', 'Proliferate'],
        oracleText:
          'Vigilance\nWhen this creature enters, choose one —\n• Target creature gets +2/+2 and gains vigilance until end of turn.\n• Proliferate. (Choose any number of permanents and/or players, then give each another counter of each kind already there.)',
      }),
      'hand',
    );
    pump(moveObject(ctx, sporesinger, { zone: 'battlefield', controllerId: 'P1' }));
    const site = invariantSite(() =>
      pump(priorityCheckpoint(ctx), (decision) =>
        decision.options.some((option) => option.type === 'chooseModes')
          ? { index: decision.options.length, targets: new Map() }
          : { index: 0, targets: new Map() },
      ),
    );
    expect(site).toBe('sba.pushTriggerOnStack.modes');
  });

  it('sba.pushTriggerOnStack.division', () => {
    const ctx = pod(2, 'option-at-trigger-division');
    // Ureni: "X damage divided among any number of target creatures ..., X = lands you control".
    // Four lands and two chosen targets leave the first target a 1..3 menu.
    for (let i = 0; i < 4; i++) spawn(ctx, 'P1', forest());
    const ureni = oracle({
      name: 'Ureni, the Song Unending',
      typeLine: 'Legendary Creature — Spirit Dragon',
      supertypes: ['Legendary'],
      manaCost: '{5}{G}{U}{R}',
      colors: ['G', 'U', 'R'],
      colorIdentity: ['G', 'U', 'R'],
      power: '10',
      toughness: '10',
      oracleText:
        'Flying, protection from white and from black\nWhen Ureni enters, it deals X damage divided ' +
        'as you choose among any number of target creatures and/or planeswalkers your opponents ' +
        'control, where X is the number of lands you control.',
    });
    const source = spawn(ctx, 'P1', ureni);
    spawn(ctx, 'P2', named('Chosen A'));
    spawn(ctx, 'P2', named('Chosen B'));
    const trigger = interpretCard(ureni).triggers.find((t) => t.trigger?.when === 'enters');
    expect(trigger).toBeDefined();
    ctx.state.pendingTriggers.push({
      controllerId: 'P1',
      sourceCardId: source.cardId,
      sourceOracleId: source.oracleId,
      sourceName: source.name,
      ability: trigger as Ability,
    });
    const site = invariantSite(() =>
      pump(runPrioritySequence(ctx), (decision) => {
        if (/how much of the remaining/.test(decision.prompt))
          return { index: decision.options.length, targets: new Map() };
        // Take the first two targets, then stop.
        if (/choose (a|another) target/.test(decision.prompt)) {
          const stop = decision.options.findIndex((option) => option.type === 'decline');
          const taken = decision.prompt.includes('(0/')
            ? 0
            : decision.prompt.includes('(1/')
              ? 1
              : 2;
          return { index: taken < 2 || stop < 0 ? 0 : stop, targets: new Map() };
        }
        return { index: 0, targets: new Map() };
      }),
    );
    expect(site).toBe('sba.pushTriggerOnStack.division');
  });
});
