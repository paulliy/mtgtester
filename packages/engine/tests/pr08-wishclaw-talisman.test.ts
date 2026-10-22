/**
 * PR08 card coverage: Wishclaw Talisman
 * (docs/plans/card-coverage-chunks.md — 8.05, control changes and multiplayer choices).
 *
 * The activation has no printed target at all: the search and shuffle resolve first, and only
 * then does the ability's controller choose which living opponent receives the artifact.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import {
  computePriorityOptions,
  computeTargetOptions,
  type PriorityActionPayload,
} from '../src/actions/legal';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import type { CardDefinition } from '../src/cards/definition';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import type { PendingDecision, DecisionOutcome } from '../src/decisions';
import { endUntilEotEffects } from '../src/effects/resolve';
import { addMana, drainPool } from '../src/mana/pool';
import { changeController, controlledBy, moveObject, playerById } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}
const pins = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/coverage-pr08-oracle.json'), 'utf8'),
  ) as PinnedFixture
).cards;
const wishPin = pins.find((pin) => pin.card.name === 'Wishclaw Talisman');
if (wishPin === undefined) throw new Error('missing pinned Oracle fixture for Wishclaw Talisman');

const PIN_TEXT =
  'This artifact enters with three wish counters on it.\n' +
  '{1}, {T}, Remove a wish counter from this artifact: Search your library for a card, put it into your hand, then shuffle. An opponent gains control of this artifact. Activate only during your turn.';

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

type Answer = (decision: PendingDecision, count: number) => DecisionOutcome;

const passFirst = (decision: PendingDecision): DecisionOutcome => ({
  index: Math.max(
    0,
    decision.options.findIndex((option) => option.type === 'pass'),
  ),
  targets: new Map(),
});

function priorityOptions(ctx: GameContext, playerId: string) {
  return computePriorityOptions(ctx, playerById(ctx, playerId));
}

function castOptionFor(ctx: GameContext, playerId: string, objectId: string) {
  return priorityOptions(ctx, playerId).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === objectId;
  });
}

function activationOf(ctx: GameContext, playerId: string, source: EnginePermanent) {
  return priorityOptions(ctx, playerId).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'activateAbility' && payload.objectId === source.id;
  });
}

function takeAction(
  ctx: GameContext,
  playerId: string,
  payload: PriorityActionPayload,
  answer?: Answer,
  targets: ReadonlyMap<number, string> = new Map(),
) {
  return pump(
    applyPriorityAction(ctx, playerById(ctx, playerId), payload, { index: 0, targets }),
    answer,
  );
}

/** Drive a real priority sequence to the resolution of the ability on the stack. */
function resolveTop(ctx: GameContext, answer?: Answer) {
  return pump(runPrioritySequence(ctx), answer ?? passFirst);
}

function turnOfPlayer(ctx: GameContext, playerId: string): void {
  ctx.state.currentTurnPlayer = playerId;
  ctx.state.activePlayerIndex = Number(playerId.slice(1)) - 1;
}

const events = (ctx: GameContext, type: string) =>
  ctx.state.eventLog.filter((event) => event.type === type);

function setLibrary(ctx: GameContext, playerId: string, names: string[]) {
  const player = playerById(ctx, playerId);
  player.library = names.map((name) =>
    conjure(
      ctx,
      playerId,
      oracle({ name, typeLine: 'Instant', manaCost: '{0}', oracleText: 'You gain 1 life.' }),
      'library',
    ),
  );
}

const isOpponentChoice = (decision: PendingDecision): boolean =>
  decision.options.some((option) => option.type === 'choosePlayer');

function chooseOpponent(decision: PendingDecision, wanted: string): DecisionOutcome {
  const index = decision.options.findIndex((option) => opponentId(option) === wanted);
  if (index < 0) throw new Error(`no opponent option ${wanted} in ${decision.prompt}`);
  return { index, targets: new Map() };
}
function opponentId(option: PendingDecision['options'][number]) {
  const subject = option.presentation?.subjects[0];
  return subject?.kind === 'player' ? subject.playerId : undefined;
}

/** One ready permanent with exactly the printed three wish counters, and one mana for {1}. */
const readyTalisman = (ctx: GameContext): EnginePermanent => {
  const self = spawn(ctx, 'P1', wishPin.card);
  expect(self.counters['wish']).toBe(3);
  addMana(playerById(ctx, 'P1'), [{ symbol: 'C' }]);
  return self;
};

function activate(ctx: GameContext, self: EnginePermanent): void {
  const option = activationOf(ctx, 'P1', self);
  expect(option, 'Wishclaw Talisman activation is offered').toBeDefined();
  takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
  expect(ctx.state.stack).toHaveLength(1);
}

describe('Wishclaw Talisman', () => {
  it('wishclaw-talisman-pinned-oracle-supported — pinned oracle, real id and fixture alias agree', () => {
    expect(wishPin.sha256).toBe('446292abbc221b8f58e0346f35354508e4d3b7866c29c7f51c91c80a046f1c33');
    expect(wishPin.card.oracleId).toBe('81c70ae7-3c18-4c9b-8505-e4db9e0e6518');
    expect(wishPin.card.oracleText).toBe(PIN_TEXT);
    for (const card of [
      wishPin.card,
      { ...wishPin.card, oracleId: fixtureOracleId('Wishclaw Talisman') },
    ]) {
      const def = interpretCard(card);
      expect(def.unmodeledReasons, card.oracleId).toEqual([]);
      expect(def.modeled, card.oracleId).toBe(true);
      // "enters with three wish counters" stays the interpreter's replacement effect (CR 614.1c).
      expect(def.entersWithCounters, card.oracleId).toEqual({ wish: 3 });
      expect(def.activatedAbilities, card.oracleId).toHaveLength(1);
      expect(def.activatedAbilities[0]).toMatchObject({
        costs: [
          { kind: 'mana', cost: { generic: 1 } },
          { kind: 'tap' },
          { kind: 'removeCounters', counter: 'wish', count: 1 },
        ],
        timing: 'yourTurn',
        ability: {
          kind: 'activated',
          // The printed activation names no target: the opponent is chosen as it resolves.
          targets: [],
          effects: [
            { op: 'searchLibrary', destinations: [{ zone: 'hand' }] },
            { op: 'shuffle' },
            {
              op: 'gainControlTarget',
              target: 'source',
              recipient: { chooseOpponent: true },
            },
          ],
        },
      });
      expect(validateCardDefinition(def), card.oracleId).toEqual([]);
    }
  });

  it('wishclaw-talisman-normal-cast-pays-one-black-and-enters-with-three-wish — normal cast', () => {
    const ctx = pod('wishclaw-cast');
    const caster = playerById(ctx, 'P1');
    const card = conjure(ctx, 'P1', wishPin.card, 'hand');
    addMana(caster, [{ symbol: 'C' }, { symbol: 'B' }]);
    const option = castOptionFor(ctx, 'P1', card.id);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(ctx.state.stack).toHaveLength(1);
    expect(caster.manaEntries).toHaveLength(0);
    resolveTop(ctx);
    const permanent = ctx.state.battlefield.find((entry) => entry.cardId === card.cardId);
    expect(permanent).toBeDefined();
    expect(permanent!.controllerId).toBe('P1');
    expect(permanent!.summoningSick).toBe(true);
    expect(permanent!.counters['wish']).toBe(3);
    expect(
      ctx.state.eventLog.some(
        (event) => event.type === 'castSpell' && event.payload['name'] === 'Wishclaw Talisman',
      ),
    ).toBe(true);
  });

  it('wishclaw-talisman-normal-cast-needs-black-and-a-main-phase — normal cast rejects {1}{C} and combat', () => {
    const ctx = pod('wishclaw-cast-illegal');
    const player = playerById(ctx, 'P1');
    const card = conjure(ctx, 'P1', wishPin.card, 'hand');
    addMana(player, [{ symbol: 'C' }, { symbol: 'C' }]);
    expect(castOptionFor(ctx, 'P1', card.id)).toBeUndefined();
    addMana(player, [{ symbol: 'B' }]);
    ctx.state.phase = 'combat';
    ctx.state.step = 'combatDamage';
    expect(castOptionFor(ctx, 'P1', card.id)).toBeUndefined();
    ctx.state.phase = 'precombatMain';
    ctx.state.step = null;
    expect(castOptionFor(ctx, 'P1', card.id)).toBeDefined();
  });

  it('wishclaw-talisman-activation-pays-one-mana-taps-and-removes-one-wish — activation cost and stack', () => {
    const ctx = pod('wishclaw-activate');
    const player = playerById(ctx, 'P1');
    const self = readyTalisman(ctx);
    const option = activationOf(ctx, 'P1', self);
    expect(option).toBeDefined();
    // No player (or any other) target slot is announced for this activation.
    expect(option!.targets ?? []).toHaveLength(0);
    const beforeLibrary = playerById(ctx, 'P1').library.map((card) => card.name);
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(player.manaEntries).toHaveLength(0);
    expect(self.tapped).toBe(true);
    expect(self.counters['wish']).toBe(2);
    expect(ctx.state.stack).toHaveLength(1);
    // Costs are paid as one indivisible act before the ability is on the stack (CR 602.1b/608.2).
    expect(playerById(ctx, 'P1').library.map((card) => card.name)).toEqual(beforeLibrary);
    resolveTop(ctx);
    expect(self.controllerId).toBe('P2');
  });

  it('wishclaw-talisman-search-and-shuffle-precede-the-opponent-choice — ordering of the resolution', () => {
    const ctx = pod('wishclaw-order');
    const self = readyTalisman(ctx);
    setLibrary(ctx, 'P1', [
      'Wishclaw Alpha',
      'Wishclaw Beta',
      'Wishclaw Gamma',
      'Wishclaw Delta',
      'Wishclaw Epsilon',
    ]);
    const beforeHand = playerById(ctx, 'P1').hand.length;
    const beforeOrder = playerById(ctx, 'P1').library.map((card) => card.name);
    activate(ctx, self);

    let handAtChoice = -1;
    let libraryAtChoice: string[] = [];
    let shufflesAtChoice = -1;
    const { decisions } = resolveTop(ctx, (decision) => {
      if (!isOpponentChoice(decision)) return passFirst(decision);
      handAtChoice = playerById(ctx, 'P1').hand.length;
      libraryAtChoice = playerById(ctx, 'P1').library.map((card) => card.name);
      shufflesAtChoice = events(ctx, 'shuffle').length;
      return chooseOpponent(decision, 'P4');
    });
    const searchAt = decisions.findIndex((decision) =>
      decision.options.some((option) => option.type === 'findCard'),
    );
    const choiceAt = decisions.findIndex(isOpponentChoice);
    expect(searchAt).toBeGreaterThanOrEqual(0);
    expect(choiceAt).toBeGreaterThan(searchAt);
    // By the time the opponent is asked, the card is already in hand and the library shuffled.
    expect(handAtChoice).toBe(beforeHand + 1);
    expect(shufflesAtChoice).toBeGreaterThanOrEqual(1);
    // The found card has already left the library — and the remainder is ALREADY shuffled, which
    // is what "the shuffle precedes the gift" means. Nothing shuffles again afterwards.
    expect([...libraryAtChoice].sort()).toEqual(beforeOrder.slice(1).sort());
    expect(libraryAtChoice).not.toEqual(beforeOrder.slice(1));
    expect(playerById(ctx, 'P1').library.map((card) => card.name)).toEqual(libraryAtChoice);
    expect(events(ctx, 'searchFound')).toHaveLength(1);
    expect(self.controllerId).toBe('P4');
    expect(events(ctx, 'gainControl')).toHaveLength(1);
  });

  it('wishclaw-talisman-opponent-choice-offers-every-living-opponent — the choice is not a target', () => {
    const ctx = pod('wishclaw-menu');
    const self = readyTalisman(ctx);
    setLibrary(ctx, 'P1', []);
    playerById(ctx, 'P4').hasLost = true;
    // A player with hexproof can never be TARGETED by P1, but is still a legal recipient
    // (CR 300.7 — nothing about this choice is a targeting restriction).
    ctx.state.playerHexproofTurn ??= {};
    ctx.state.playerHexproofTurn['P3'] = ctx.state.turnNumber;
    expect(computeTargetOptions(ctx, { kind: 'player', controller: 'opponent' }, 'P1')).toEqual([
      'P2',
    ]);
    activate(ctx, self);
    const { decisions } = resolveTop(ctx, (decision) =>
      isOpponentChoice(decision) ? chooseOpponent(decision, 'P3') : passFirst(decision),
    );
    const choice = decisions.find(isOpponentChoice);
    expect(choice).toBeDefined();
    expect(choice!.player).toBe('P1');
    expect(choice!.options.map(opponentId)).toEqual(['P2', 'P3']);
    expect(
      choice!.options.every((option) => option.presentation?.subjects[0]?.kind === 'player'),
    ).toBe(true);
    expect(self.controllerId).toBe('P3');
    expect(self.summoningSick).toBe(true);
  });

  it('wishclaw-talisman-empty-library-still-shuffles-and-transfers — an empty library is not a fizzle', () => {
    const ctx = pod('wishclaw-empty-library');
    const self = readyTalisman(ctx);
    setLibrary(ctx, 'P1', []);
    const beforeHand = playerById(ctx, 'P1').hand.length;
    activate(ctx, self);
    const { decisions } = resolveTop(ctx, (decision) =>
      isOpponentChoice(decision) ? chooseOpponent(decision, 'P2') : passFirst(decision),
    );
    expect(decisions.some((decision) => decision.options.some((o) => o.type === 'findCard'))).toBe(
      false,
    );
    expect(playerById(ctx, 'P1').hand).toHaveLength(beforeHand);
    expect(events(ctx, 'shuffle')).toHaveLength(1);
    expect(events(ctx, 'searchFound')).toHaveLength(0);
    expect(self.controllerId).toBe('P2');
  });

  it('wishclaw-talisman-source-gone-still-searches — the gift fails without touching another object', () => {
    const ctx = pod('wishclaw-source-gone');
    const self = readyTalisman(ctx);
    setLibrary(ctx, 'P1', ['Wishclaw Alpha']);
    const beforeHand = playerById(ctx, 'P1').hand.length;
    const other = spawn(
      ctx,
      'P1',
      oracle({ name: 'Untouched Artifact', typeLine: 'Artifact', manaCost: '{0}' }),
    );
    activate(ctx, self);
    void pump(moveObject(ctx, self, { zone: 'exile' }));
    expect(ctx.state.battlefield.some((entry) => entry.id === self.id)).toBe(false);
    const { decisions } = resolveTop(ctx, (decision) =>
      isOpponentChoice(decision) ? chooseOpponent(decision, 'P2') : passFirst(decision),
    );
    expect(playerById(ctx, 'P1').hand).toHaveLength(beforeHand + 1);
    expect(events(ctx, 'shuffle')).toHaveLength(1);
    // No recipient is asked at all: the object the printed text names is gone (CR 608.2h).
    expect(decisions.some(isOpponentChoice)).toBe(false);
    expect(events(ctx, 'gainControl')).toHaveLength(0);
    expect(other.controllerId).toBe('P1');
  });

  it('wishclaw-talisman-source-blink-is-not-inherited — a new incarnation is not the ability source', () => {
    const ctx = pod('wishclaw-blink');
    const self = readyTalisman(ctx);
    setLibrary(ctx, 'P1', ['Wishclaw Alpha']);
    const beforeHand = playerById(ctx, 'P1').hand.length;
    activate(ctx, self);
    const exiled = pump(moveObject(ctx, self, { zone: 'exile' })).value;
    expect(exiled).not.toBeNull();
    const returned = pump(moveObject(ctx, exiled!, { zone: 'battlefield' })).value;
    expect(returned).not.toBeNull();
    expect(ctx.state.exile.some((entry) => entry.cardId === self.cardId)).toBe(false);
    const { decisions } = resolveTop(ctx, (decision) =>
      isOpponentChoice(decision) ? chooseOpponent(decision, 'P2') : passFirst(decision),
    );
    expect(playerById(ctx, 'P1').hand).toHaveLength(beforeHand + 1);
    const incarnation = ctx.state.battlefield.find(
      (entry) => entry.cardId === self.cardId && entry.id !== self.id,
    );
    expect(incarnation).toBeDefined();
    expect(incarnation!.id).not.toBe(self.id);
    expect(incarnation!.controllerId).toBe('P1');
    expect(decisions.some(isOpponentChoice)).toBe(false);
    expect(events(ctx, 'gainControl')).toHaveLength(0);
  });

  it('wishclaw-talisman-controller-change-before-resolution-keeps-the-original-controller — library and opponents', () => {
    const ctx = pod('wishclaw-pending');
    const self = readyTalisman(ctx);
    setLibrary(ctx, 'P1', ['Wishclaw Alpha']);
    setLibrary(ctx, 'P2', ['Wishclaw P2 Only']);
    activate(ctx, self);
    // A temporary controller does not become the chooser: the ABILITY's controller still searches
    // its own library and still offers its own opponents (P1 and P4 are excluded here).
    changeController(ctx, self, 'P2', { kind: 'untilEndOfTurn' });
    const beforeP1Hand = playerById(ctx, 'P1').hand.length;
    const beforeP2Hand = playerById(ctx, 'P2').hand.length;
    const { decisions } = resolveTop(ctx, (decision) =>
      isOpponentChoice(decision) ? chooseOpponent(decision, 'P4') : passFirst(decision),
    );
    const choice = decisions.find(isOpponentChoice);
    expect(choice!.player).toBe('P1');
    expect(choice!.options.map(opponentId)).toEqual(['P2', 'P3', 'P4']);
    expect(playerById(ctx, 'P1').hand).toHaveLength(beforeP1Hand + 1);
    expect(playerById(ctx, 'P1').hand.some((card) => card.name === 'Wishclaw Alpha')).toBe(true);
    expect(playerById(ctx, 'P2').hand).toHaveLength(beforeP2Hand);
    expect(events(ctx, 'shuffle').map((event) => event.payload['player'])).toEqual(['P1']);
    expect(self.controllerId).toBe('P4');
  });

  it('wishclaw-talisman-your-turn-timing-allows-combat-and-rejects-another-turn — timing', () => {
    const ctx = pod('wishclaw-timing');
    const self = readyTalisman(ctx);
    setLibrary(ctx, 'P1', []);
    ctx.state.phase = 'combat';
    ctx.state.step = 'combatDamage';
    expect(activationOf(ctx, 'P1', self)).toBeDefined();
    turnOfPlayer(ctx, 'P2');
    expect(activationOf(ctx, 'P1', self)).toBeUndefined();
    turnOfPlayer(ctx, 'P1');
    expect(activationOf(ctx, 'P1', self)).toBeDefined();
  });

  it('wishclaw-talisman-activation-requires-one-wish-one-mana-and-an-untapped-source — negative legality', () => {
    const ctx = pod('wishclaw-rejections');
    const player = playerById(ctx, 'P1');
    const noWish = spawn(ctx, 'P1', wishPin.card);
    noWish.counters['wish'] = 0;
    addMana(player, [{ symbol: 'C' }]);
    expect(activationOf(ctx, 'P1', noWish)).toBeUndefined();
    noWish.counters['wish'] = 1;
    expect(activationOf(ctx, 'P1', noWish)).toBeDefined();

    const noMana = spawn(ctx, 'P1', wishPin.card);
    drainPool(player, true);
    expect(activationOf(ctx, 'P1', noMana)).toBeUndefined();
    addMana(player, [{ symbol: 'C' }]);
    expect(activationOf(ctx, 'P1', noMana)).toBeDefined();

    const tapped = spawn(ctx, 'P1', wishPin.card, { tapped: true });
    expect(activationOf(ctx, 'P1', tapped)).toBeUndefined();

    // CR 302.6 blocks a {T} cost only on a CREATURE, so a freshly cast Artifact can be used the
    // turn it arrives. Asserted rather than assumed: it is the one "sickness" that is not a bar.
    const sick = spawn(ctx, 'P1', wishPin.card, { summoningSick: true });
    expect(activationOf(ctx, 'P1', sick)).toBeDefined();
  });

  it('wishclaw-talisman-gift-is-permanent-and-survives-an-older-end-of-turn-grant — permanent duration', () => {
    const ctx = pod('wishclaw-permanent');
    const self = readyTalisman(ctx);
    setLibrary(ctx, 'P1', ['Wishclaw Alpha']);
    activate(ctx, self);
    changeController(ctx, self, 'P2', { kind: 'untilEndOfTurn' });
    const stampBefore = ctx.state.nextTimestamp;
    resolveTop(ctx, (decision) =>
      isOpponentChoice(decision) ? chooseOpponent(decision, 'P3') : passFirst(decision),
    );
    const records = self.controlChanges ?? [];
    expect(records).toHaveLength(2);
    const gift = records.at(-1)!;
    expect(gift.controllerId).toBe('P3');
    expect(gift.duration).toEqual({ kind: 'permanent' });
    // A FRESH effect timestamp for the gift, past the older grant it sits on top of.
    expect(gift.timestamp).toBeGreaterThanOrEqual(stampBefore);
    expect(records[0]!.duration).toEqual({ kind: 'untilEndOfTurn' });
    expect(self.controllerId).toBe('P3');
    expect(self.summoningSick).toBe(true);
    // Expiring the older grant falls back to the record beneath it — the permanent gift.
    endUntilEotEffects(ctx);
    expect(controlledBy(self)).toBe('P3');
    expect(self.controllerId).toBe('P3');
    expect(self.controlChanges).toHaveLength(1);
  });

  it('wishclaw-talisman-three-activations-consume-one-wish-each — the counter is spent per activation', () => {
    const ctx = pod('wishclaw-three');
    const self = readyTalisman(ctx);
    setLibrary(ctx, 'P1', ['Wishclaw Alpha']);
    activate(ctx, self);
    expect(self.counters['wish']).toBe(2);
    resolveTop(ctx, (decision) =>
      isOpponentChoice(decision) ? chooseOpponent(decision, 'P2') : passFirst(decision),
    );
    // The artifact now belongs to P2, so P1 cannot activate it again; P2 can.
    self.tapped = false;
    self.summoningSick = false;
    expect(activationOf(ctx, 'P1', self)).toBeUndefined();
    turnOfPlayer(ctx, 'P2');
    addMana(playerById(ctx, 'P2'), [{ symbol: 'C' }]);
    const option = activationOf(ctx, 'P2', self);
    expect(option).toBeDefined();
    takeAction(ctx, 'P2', option!.payload as PriorityActionPayload);
    expect(self.counters['wish']).toBe(1);
    resolveTop(ctx, (decision) =>
      isOpponentChoice(decision) ? chooseOpponent(decision, 'P3') : passFirst(decision),
    );
    // P2's activation searches P2's own library and offers P2's own opponents.
    expect(events(ctx, 'gainControl').map((event) => event.payload['newController'])).toEqual([
      'P2',
      'P3',
    ]);
    expect(self.controllerId).toBe('P3');
  });

  it('wishclaw-talisman-unrestricted-search-must-find — a nonempty library cannot decline an unrestricted search', () => {
    const ctx = pod('wishclaw-decline');
    const self = readyTalisman(ctx);
    setLibrary(ctx, 'P1', ['Wishclaw Alpha', 'Wishclaw Beta']);
    const beforeHand = playerById(ctx, 'P1').hand.length;
    activate(ctx, self);
    const { decisions } = resolveTop(ctx, (decision) => {
      if (isOpponentChoice(decision)) return chooseOpponent(decision, 'P2');
      if (decision.options.some((option) => option.type === 'findCard')) {
        expect(decision.options.some((option) => option.type === 'findNothing')).toBe(false);
        return {
          index: decision.options.findIndex((option) =>
            option.description.includes('Wishclaw Beta'),
          ),
          targets: new Map(),
        };
      }
      return passFirst(decision);
    });
    expect(
      decisions.some((decision) => decision.options.some((o) => o.type === 'findNothing')),
    ).toBe(false);
    expect(playerById(ctx, 'P1').hand).toHaveLength(beforeHand + 1);
    expect(playerById(ctx, 'P1').hand.some((card) => card.name === 'Wishclaw Beta')).toBe(true);
    expect(events(ctx, 'shuffle')).toHaveLength(1);
    expect(self.controllerId).toBe('P2');
  });

  it('wishclaw-talisman-definition-carries-no-illegal-mapped-field — the new key stays out of the expression map', () => {
    const def: CardDefinition = interpretCard(wishPin.card);
    const gift = def.activatedAbilities[0]!.ability.effects[2]!;
    expect(gift).toMatchObject({ op: 'gainControlTarget', recipient: { chooseOpponent: true } });
    // `duration` stays the only mapped ExpressionField this primitive admits; `recipient` is a
    // plain authoring field validated by the recipient registry, not an expression operand.
    expect(Object.hasOwn(gift, 'duration')).toBe(false);
    expect(validateCardDefinition(def)).toEqual([]);
  });
});
