/**
 * PR08.02 Druid of Purification — the NORMAL paid-cast path.
 *
 * The card is one creature spell: pay {3}{G} through the real legal-action menu
 * (`computePriorityOptions` / `applyPriorityAction`), let the spell sit on the stack, pass priority
 * around the table (`runPrioritySequence`), resolve it, then put the printed "When this creature
 * enters" trigger on the stack and resolve that too. Nothing here hand-builds a cost, a
 * `ManaEntry`, a stack object, or an `Ability`: the mana is four ordinary entries
 * (G, C, C, C) added to the pool and consumed by the engine's own payment, and the only decisions
 * the test answers are the ones the engine really surfaces.
 *
 * Clause mapping (Oracle: "When this creature enters, starting with you, each player may choose an
 * artifact or enchantment you don't control. Destroy each permanent chosen this way."):
 *  - "starting with you"  -> APNAP choice order that begins at the controller's own turn slot.
 *  - "an artifact or enchantment you don't control" -> one shared pool, identical for every chooser:
 *    it excludes everything the Druid's controller controls (including their own) and it is NOT
 *    restricted by shroud/hexproof, because this is an untargeted destroy.
 *  - "may choose"        -> declining is legal, and nothing is destroyed on a decline.
 *  - "each permanent chosen this way" -> all four choices are collected BEFORE any destruction
 *    (CR 608.2c) and each distinct permanent is destroyed exactly once however many players named it.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ObjectId, OracleCard, PlayerId } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import type { ManaEntry } from '../src/cards/ability';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { applyPriorityAction } from '../src/actions/apply';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { addMana } from '../src/mana/pool';
import { computeCharacteristics } from '../src/effects/continuous';
import { runPrioritySequence } from '../src/turn/priority';
import type { PendingDecision } from '../src/decisions';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

interface PinnedFixture {
  schemaVersion: number;
  source: string;
  retrievedAt: string;
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/coverage-pr08-oracle.json'), 'utf8'),
) as PinnedFixture;
const selected = fixture.cards.find((entry) => entry.card.name === 'Druid of Purification');
if (selected === undefined) throw new Error('Missing Druid of Purification pin');
const pinned = selected;

/** Key order is irrelevant to the pin's digest, so canonicalize before hashing. */
function canonical(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    }
    return input;
  };
  return JSON.stringify(ordered(value));
}

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(12, forest) })),
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

/** {3}{G}: one green and three colorless, as four separate real mana objects. */
function druidPayment(): ManaEntry[] {
  return [{ symbol: 'G' }, { symbol: 'C' }, { symbol: 'C' }, { symbol: 'C' }];
}

/** Non-creature permanents only — a creature is never a legal pick for this trigger. */
function relicOn(ctx: GameContext, name: string, controller: PlayerId, typeLine = 'Artifact') {
  return spawn(ctx, controller, oracle({ name, typeLine }));
}

function castOptionFor(ctx: GameContext, playerId: PlayerId, objectId: ObjectId) {
  return computePriorityOptions(ctx, playerById(ctx, playerId)).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === objectId;
  });
}

interface CastResult {
  /** The four mana objects handed to the pool, for a by-identity payment assertion. */
  payment: ManaEntry[];
  decisions: PendingDecision[];
}

/**
 * Pay the printed {3}{G} the way a player does: the cast must appear in the real legal-action
 * menu, and the engine's own payment consumes the pool. No surfaced decision means the payment
 * was unambiguous ({3}{G} against G/C/C/C has exactly one solution), which is asserted rather
 * than silently answered.
 */
function castDruid(ctx: GameContext, playerId: PlayerId, payment: ManaEntry[]): CastResult {
  const card = conjure(ctx, playerId, pinned.card, 'hand');
  addMana(playerById(ctx, playerId), payment);
  const option = castOptionFor(ctx, playerId, card.id);
  expect(option, `${pinned.card.name} ({3}{G}) offered to ${playerId}`).toBeDefined();
  const cast = pump(
    applyPriorityAction(ctx, playerById(ctx, playerId), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  return { payment, decisions: cast.decisions };
}

interface ChoiceRecord {
  player: PlayerId;
  prompt: string;
  options: string[];
  /** Whether the watched permanent was still on the battlefield when this chooser was asked. */
  watchedOnBattlefield: boolean;
  /** How many `destroy` events the log held when this chooser was asked. */
  destroyEventsSoFar: number;
}

function destroyEvents(ctx: GameContext): number {
  return ctx.state.eventLog.filter((event) => event.type === 'destroy').length;
}

/** A per-seat plan of what each chooser names; an unplanned seat is a test bug, not a decline. */
function planned(picks: Record<PlayerId, string>): (decision: PendingDecision) => string {
  return (decision) => {
    const wanted = picks[decision.player];
    if (wanted === undefined) throw new Error(`no planned choice for ${decision.player}`);
    return wanted;
  };
}

/**
 * Pass priority around the table until the sequence ends, answering only the trigger's own choice
 * decisions with the exact option text `choose` returns.
 */
function settleThroughTable(
  ctx: GameContext,
  choose: (decision: PendingDecision) => string,
  watched?: ObjectId,
): ChoiceRecord[] {
  const records: ChoiceRecord[] = [];
  pump(runPrioritySequence(ctx), (decision) => {
    if (decision.decisionType === 'priority') {
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: pass >= 0 ? pass : 0, targets: new Map() };
    }
    // The enter trigger is mandatory: the players' choices come with no "use this ability?" first.
    expect(decision.decisionType).not.toBe('optionalTrigger');
    if (decision.decisionType !== 'general')
      throw new Error(`unexpected ${decision.decisionType} decision for ${decision.player}`);
    const wanted = choose(decision);
    const index = decision.options.findIndex((option) => option.description === wanted);
    if (index < 0)
      throw new Error(
        `${decision.player} was never offered "${wanted}" in: ${decision.options
          .map((option) => option.description)
          .join(' | ')}`,
      );
    records.push({
      player: decision.player,
      prompt: decision.prompt,
      options: decision.options.map((option) => option.description),
      watchedOnBattlefield:
        watched === undefined ? true : ctx.state.battlefield.some((perm) => perm.id === watched),
      destroyEventsSoFar: destroyEvents(ctx),
    });
    return { index, targets: new Map() };
  });
  return records;
}

/** A P1-controlled artifact: never in the pool, because the pool is what "you" does not control. */
const ownRelicName = 'Cartographers Idol';

function battlefield(ctx: GameContext, name: string) {
  return ctx.state.battlefield.filter((permanent) => permanent.name === name);
}

function inGraveyard(ctx: GameContext, playerId: PlayerId, name: string): number {
  return playerById(ctx, playerId).graveyard.filter((card) => card.name === name).length;
}

describe('Druid of Purification (PR08.02) — normal paid cast', () => {
  it('druid-cast-oracle-pins — the pinned record and both ids carry the authored trigger', () => {
    expect(fixture.source).toBe('packages/server/fixtures/coverage-oracle.json');
    expect(fixture.retrievedAt).toBe('2026-10-17');
    expect(pinned.card.oracleId).toBe('5bb32efd-9e58-4021-bbda-4ffccfa1d601');
    expect(pinned.card.manaCost).toBe('{3}{G}');
    expect(pinned.card.oracleText).toBe(
      "When this creature enters, starting with you, each player may choose an artifact or enchantment you don't control. Destroy each permanent chosen this way.",
    );
    expect(createHash('sha256').update(canonical(pinned.card)).digest('hex')).toBe(pinned.sha256);

    // The real Oracle id and the fixture alias must behave identically, not merely parse.
    for (const id of [pinned.card.oracleId, 'oracle-druid-of-purification']) {
      const def = interpretCard({ ...pinned.card, oracleId: id });
      expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
      expect(def.unmodeledReasons).toEqual([]);
      expect(def.manaCost).toEqual({
        generic: 3,
        colored: { W: 0, U: 0, B: 0, R: 0, G: 1 },
        colorless: 0,
      });
      expect(def.power).toBe(2);
      expect(def.toughness).toBe(3);
      expect(def.spellAbility).toBeNull();
      expect(def.triggers).toHaveLength(1);
      const trigger = def.triggers[0]!;
      expect(trigger.kind).toBe('triggered');
      expect(trigger.trigger).toEqual({ when: 'enters', subject: { kind: 'self' } });
      expect(trigger.targets).toEqual([]);
      expect(trigger.effects).toEqual([{ op: 'druidPurification' }]);
      expect(trigger.description).toContain('Starting with you');
    }
  });

  it('druid-normal-cast-shared-target — four real mana, all four players choose the same relic, one destroy', () => {
    const ctx = pod('druid-normal-cast');
    const own = relicOn(ctx, ownRelicName, 'P1');
    const shared = relicOn(ctx, 'Culling Reliquary', 'P2');
    const shrouded = spawn(
      ctx,
      'P2',
      oracle({ name: 'Warding Mask', typeLine: 'Artifact', oracleText: 'Shroud' }),
    );
    const seal = relicOn(ctx, 'Third Seal', 'P3', 'Enchantment');

    const { payment, decisions } = castDruid(ctx, 'P1', druidPayment());

    // Paid {3}{G} out of four distinct mana objects; nothing invented, nothing left over.
    expect(decisions).toEqual([]);
    expect(playerById(ctx, 'P1').manaEntries.filter((entry) => payment.includes(entry))).toEqual(
      [],
    );
    expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
    expect(
      ctx.state.eventLog.some(
        (event) =>
          event.type === 'castSpell' &&
          event.payload['name'] === 'Druid of Purification' &&
          event.payload['player'] === 'P1',
      ),
    ).toBe(true);

    // The spell is really on the stack before anyone passes.
    expect(ctx.state.stack).toHaveLength(1);
    const onStack = ctx.state.stack[0]!;
    expect(onStack.kind).toBe('spell');
    expect(onStack.description).toBe('Druid of Purification');
    expect(onStack.controllerId).toBe('P1');
    expect(battlefield(ctx, 'Druid of Purification')).toHaveLength(0);

    const choices = settleThroughTable(ctx, () => 'Destroy Culling Reliquary', shared.id);

    // Resolution order: spell resolves, the Druid enters, then its trigger goes on the stack.
    expect(ctx.state.stack).toHaveLength(0);
    const druid = battlefield(ctx, 'Druid of Purification');
    expect(druid).toHaveLength(1);
    expect(computeCharacteristics(ctx, druid[0]!)).toMatchObject({ power: 2, toughness: 3 });
    expect(
      ctx.state.eventLog.some(
        (event) =>
          event.type === 'triggerOnStack' &&
          String(event.payload['source']).startsWith('Druid of Purification'),
      ),
    ).toBe(true);

    // "starting with you": APNAP order from the controller's own slot.
    expect(choices.map((choice) => choice.player)).toEqual(['P1', 'P2', 'P3', 'P4']);
    for (const choice of choices) {
      expect(choice.prompt).toContain(
        "choose an artifact or enchantment P1 doesn't control to destroy, or choose none.",
      );
      // "you don't control" is the Druid's controller, so P1's own relic is nobody's option —
      // including P1's — and every chooser (P2 included) may name a relic another player holds.
      expect(choice.options).not.toContain(`Destroy ${ownRelicName}`);
      expect(choice.options).toContain('Choose none');
      expect(choice.options).toContain('Destroy Culling Reliquary');
      expect(choice.options).toContain('Destroy Third Seal');
      // An untargeted destroy ignores shroud.
      expect(choice.options).toContain('Destroy Warding Mask');
    }

    // All four choices are collected before anything is destroyed (CR 608.2c).
    expect(choices.map((choice) => choice.watchedOnBattlefield)).toEqual([true, true, true, true]);
    expect(choices.map((choice) => choice.destroyEventsSoFar)).toEqual([0, 0, 0, 0]);

    // "each permanent chosen this way": four choosers, one permanent, exactly one destroy.
    const destroys = ctx.state.eventLog.filter((event) => event.type === 'destroy');
    expect(destroys).toHaveLength(1);
    expect(destroys[0]!.payload['target']).toBe('Culling Reliquary');
    expect(String(destroys[0]!.payload['source'])).toContain('Druid of Purification');
    expect(
      ctx.state.eventLog.filter(
        (event) =>
          event.type === 'zoneChange' &&
          event.payload['name'] === 'Culling Reliquary' &&
          event.payload['from'] === 'battlefield' &&
          event.payload['to'] === 'graveyard',
      ),
    ).toHaveLength(1);
    expect(battlefield(ctx, 'Culling Reliquary')).toHaveLength(0);
    expect(inGraveyard(ctx, 'P2', 'Culling Reliquary')).toBe(1);

    // Nothing else moved: the Druid's controller's relic is untouchable, and the two relics
    // nobody chose survive. The Druid itself is a 2/3 that never attacked and stays on the field.
    expect(battlefield(ctx, ownRelicName)).toEqual([own]);
    expect(battlefield(ctx, 'Warding Mask')).toEqual([shrouded]);
    expect(battlefield(ctx, 'Third Seal')).toEqual([seal]);
    expect(battlefield(ctx, 'Druid of Purification')).toHaveLength(1);
    expect(inGraveyard(ctx, 'P1', 'Druid of Purification')).toBe(0);
  });

  it('druid-distinct-choices — two different named relics destroy once each, a decline destroys nothing', () => {
    const ctx = pod('druid-distinct-choices');
    const shared = relicOn(ctx, 'Culling Reliquary', 'P2');
    const seal = relicOn(ctx, 'Third Seal', 'P3', 'Enchantment');
    const untouched = relicOn(ctx, 'Quiet Relic', 'P4');

    castDruid(ctx, 'P1', druidPayment());

    const picks: Record<PlayerId, string> = {
      P1: 'Destroy Culling Reliquary',
      P2: 'Destroy Third Seal',
      P3: 'Choose none',
      P4: 'Choose none',
    };
    const choices = settleThroughTable(ctx, planned(picks), shared.id);

    expect(choices.map((choice) => choice.player)).toEqual(['P1', 'P2', 'P3', 'P4']);
    const destroys = ctx.state.eventLog.filter((event) => event.type === 'destroy');
    expect(destroys.map((event) => event.payload['target'])).toEqual([
      'Culling Reliquary',
      'Third Seal',
    ]);
    expect(battlefield(ctx, 'Culling Reliquary')).toHaveLength(0);
    expect(battlefield(ctx, 'Third Seal')).toHaveLength(0);
    expect(inGraveyard(ctx, 'P2', 'Culling Reliquary')).toBe(1);
    expect(inGraveyard(ctx, 'P3', 'Third Seal')).toBe(1);
    // The exact objects chosen are the ones that died, by card id.
    expect(playerById(ctx, 'P2').graveyard.some((card) => card.cardId === shared.cardId)).toBe(
      true,
    );
    expect(playerById(ctx, 'P3').graveyard.some((card) => card.cardId === seal.cardId)).toBe(true);
    // "may choose" is real: the two declines leave the third relic alone.
    expect(battlefield(ctx, 'Quiet Relic')).toEqual([untouched]);
    expect(inGraveyard(ctx, 'P4', 'Quiet Relic')).toBe(0);
  });

  it("druid-cast-starting-with-you-order — a non-first seat's cast still starts the choices with itself", () => {
    const ctx = pod('druid-order-p3');
    ctx.state.currentTurnPlayer = 'P3';
    ctx.state.activePlayerIndex = 2;
    const seal = relicOn(ctx, 'Third Seal', 'P2', 'Enchantment');
    playerById(ctx, 'P3').hasLost = false;

    castDruid(ctx, 'P3', druidPayment());
    const choices = settleThroughTable(ctx, () => 'Choose none');

    // APNAP from P3's own slot, skipping nobody: P3, P4, P1, P2.
    expect(choices.map((choice) => choice.player)).toEqual(['P3', 'P4', 'P1', 'P2']);
    for (const choice of choices) {
      expect(choice.prompt).toContain(
        "choose an artifact or enchantment P3 doesn't control to destroy, or choose none.",
      );
      // The pool is still P3's non-controlled permanents: P2's enchantment, offered to everybody.
      expect(choice.options).toContain('Destroy Third Seal');
    }
    // Every player declined, so nothing was destroyed.
    expect(destroyEvents(ctx)).toBe(0);
    expect(battlefield(ctx, 'Third Seal')).toEqual([seal]);
    expect(battlefield(ctx, 'Druid of Purification')[0]!.controllerId).toBe('P3');
  });

  it('druid-cast-cost-and-timing — {3}{G} needs green, a fourth mana, and a sorcery window', () => {
    const ctx = pod('druid-legality');
    const card = conjure(ctx, 'P1', pinned.card, 'hand');
    const offered = () => castOptionFor(ctx, 'P1', card.id) !== undefined;

    // Four colorless: right total, no green.
    addMana(playerById(ctx, 'P1'), [
      { symbol: 'C' },
      { symbol: 'C' },
      { symbol: 'C' },
      { symbol: 'C' },
    ]);
    expect(offered()).toBe(false);

    // Green plus two colorless: the color is there, the total is not.
    playerById(ctx, 'P1').manaEntries = [];
    addMana(playerById(ctx, 'P1'), [{ symbol: 'G' }, { symbol: 'C' }, { symbol: 'C' }]);
    expect(offered()).toBe(false);

    // The same four real entries that the positive test pays with do make it legal.
    playerById(ctx, 'P1').manaEntries = [];
    addMana(playerById(ctx, 'P1'), druidPayment());
    expect(offered()).toBe(true);

    // Creature main phase: the cast window closes during combat.
    ctx.state.phase = 'combat';
    ctx.state.step = 'combatDamage';
    expect(offered()).toBe(false);

    // Back to P1's main phase, then someone else's turn: sorcery timing (CR 307.1).
    ctx.state.phase = 'precombatMain';
    ctx.state.step = null;
    expect(offered()).toBe(true);
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    expect(offered()).toBe(false);

    // Nothing above moved the card or spent the mana: the negatives were about the window/cost.
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    expect(offered()).toBe(true);
    expect(
      playerById(ctx, 'P1').hand.filter((held) => held.name === 'Druid of Purification'),
    ).toHaveLength(1);
    expect(playerById(ctx, 'P1').manaEntries).toHaveLength(4);
    expect(battlefield(ctx, 'Druid of Purification')).toHaveLength(0);
    expect(destroyEvents(ctx)).toBe(0);
  });
});
