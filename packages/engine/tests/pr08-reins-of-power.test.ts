/**
 * PR08.17: Reins of Power ({2}{U}{U} Instant) — pinned Oracle, normal cast path, and the exact
 * resolution order of the three sentences:
 *
 *   1. "Untap all creatures you control and all creatures target opponent controls." — the
 *      complete union of BOTH players' creatures, untapped before any control changes, and the
 *      creature sets recomputed afterwards (an untap can change a permanent's types).
 *   2. "You and that opponent each gain control of all creatures the other controls until end
 *      of turn." — both sets frozen before the first grant, because granting control can itself
 *      change a controller-dependent creature type.
 *   3. "Those creatures gain haste until end of turn." — exactly the frozen sets, by object id.
 *
 * Neither group is all-or-nothing: either or both may be empty, and the third player's
 * creatures are never touched.
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
import type { Condition } from '../src/cards/condition';
import { interpretCard } from '../src/cards/interpret';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { computeCharacteristics } from '../src/effects/continuous';
import { endUntilEotEffects } from '../src/effects/resolve';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { changeController, controlledBy, moveObject, playerById } from '../src/state/objects';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { constant } from '../src/cards/value';
import { conjure, copies, forest, gameConfig, oracle, pump, registerDef, spawn } from './fixtures';

const pins = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/coverage-pr08-oracle.json'), 'utf8'),
  ) as { cards: { sha256: string; card: OracleCard }[] }
).cards;
const selected = pins.find((entry) => entry.card.name === 'Reins of Power');
if (selected === undefined) throw new Error('missing pinned Oracle fixture for Reins of Power');
const pin = selected;

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 7;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const manaTotal = (ctx: GameContext, playerId: string): number =>
  Object.values(playerById(ctx, playerId).manaPool).reduce((sum, value) => sum + (value ?? 0), 0);

const haste = (ctx: GameContext, perm: EnginePermanent): boolean =>
  computeCharacteristics(ctx, perm).keywords.includes('haste');

const isCreature = (ctx: GameContext, perm: EnginePermanent): boolean =>
  computeCharacteristics(ctx, perm).types.includes('Creature');

function bear(ctx: GameContext, controllerId: string, name: string): EnginePermanent {
  return spawn(
    ctx,
    controllerId,
    oracle({ name, typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
    { tapped: true },
  );
}

function castOptionFor(ctx: GameContext, cardId: string) {
  return computePriorityOptions(ctx, playerById(ctx, 'P1')).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === cardId;
  });
}

function passEverything(): (decision: PendingDecision) => DecisionOutcome {
  return (decision) => ({
    index: Math.max(
      0,
      decision.options.findIndex((option) => option.type === 'pass'),
    ),
    targets: new Map(),
  });
}

/** Hand the caster the printed {2}{U}{U} in a legal {U}{U}{C}{C} arrangement. */
function fund(ctx: GameContext, symbols: readonly ('U' | 'C')[]): void {
  addMana(
    playerById(ctx, 'P1'),
    symbols.map((symbol) => ({ symbol })),
  );
}

const PRINTED_MANA: readonly ('U' | 'C')[] = ['U', 'U', 'C', 'C'];

interface CastOptions {
  target?: string;
  mana?: readonly ('U' | 'C')[];
  beforeResolve?: () => void;
}

/** Cast Reins of Power through the real menu and stack, optionally acting before resolution. */
function castReins(ctx: GameContext, options: CastOptions = {}): void {
  const card = conjure(ctx, 'P1', pin.card, 'hand');
  fund(ctx, options.mana ?? PRINTED_MANA);
  const option = castOptionFor(ctx, card.id);
  expect(option, 'normal {2}{U}{U} cast offered').toBeDefined();
  pump(
    applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map([[0, options.target ?? 'P2']]),
    }),
  );
  expect(ctx.state.stack).toHaveLength(1);
  expect(manaTotal(ctx, 'P1')).toBe(0);
  options.beforeResolve?.();
  pump(runPrioritySequence(ctx), passEverything());
  expect(ctx.state.stack).toHaveLength(0);
  expect(
    ctx.state.eventLog.some(
      (event) => event.type === 'castSpell' && event.payload['name'] === 'Reins of Power',
    ),
  ).toBe(true);
}

/**
 * A custom-definition permanent whose ONLY reason to be a creature is a generic static effect.
 * The same condition also gates a characteristic-defining P/T, so a probe can never be a 0/0
 * that dies to state-based actions the moment it gains the Creature type.
 */
function typeProbe(
  ctx: GameContext,
  controllerId: string,
  name: string,
  condition?: Condition,
): EnginePermanent {
  const card = oracle({ name, typeLine: 'Artifact' });
  const base = registerDef(ctx, card);
  const gate = condition === undefined ? {} : { condition };
  ctx.defs.set(card.oracleId, {
    ...base,
    staticEffects: [
      { affects: { kind: 'self' }, op: { layer: 4, addTypes: ['Creature'] }, ...gate },
      {
        affects: { kind: 'self' },
        op: { layer: 7, sublayer: 'b', power: constant(3), toughness: constant(3) },
        ...gate,
      },
    ],
  });
  return spawn(ctx, controllerId, card, { tapped: true });
}

/**
 * A tapped custom-definition creature whose static reads its OWN untapped-ness and, only then,
 * makes every permanent its controller controls a creature ("each permanent you control is a
 * Creature while I am untapped").
 */
function untappedBeacon(ctx: GameContext, controllerId: string, name: string): EnginePermanent {
  const card = oracle({ name, typeLine: 'Creature — Beacon', power: '1', toughness: '1' });
  const base = registerDef(ctx, card);
  ctx.defs.set(card.oracleId, {
    ...base,
    staticEffects: [
      {
        affects: { kind: 'controller', who: 'you' },
        op: { layer: 4, addTypes: ['Creature'] },
        condition: { kind: 'isUntapped' },
      },
      {
        affects: { kind: 'controller', who: 'you' },
        op: { layer: 7, sublayer: 'b', power: constant(3), toughness: constant(3) },
        condition: { kind: 'isUntapped' },
      },
    ],
  });
  return spawn(ctx, controllerId, card, { tapped: true });
}

/** A static source controlled by `controllerId` making every OPPONENT-controlled permanent a creature. */
function oppositionProbe(ctx: GameContext, controllerId: string, name: string): EnginePermanent {
  const card = oracle({ name, typeLine: 'Artifact' });
  const base = registerDef(ctx, card);
  ctx.defs.set(card.oracleId, {
    ...base,
    staticEffects: [
      {
        affects: { kind: 'controller', who: 'opponents' },
        op: { layer: 4, addTypes: ['Creature'] },
      },
      {
        affects: { kind: 'controller', who: 'opponents' },
        op: { layer: 7, sublayer: 'b', power: constant(3), toughness: constant(3) },
      },
    ],
  });
  return spawn(ctx, controllerId, card);
}

/** A tapped bear owned by `ownerId` but answering to `controllerId`. */
function lentBear(
  ctx: GameContext,
  ownerId: string,
  controllerId: string,
  name: string,
): EnginePermanent {
  const card = conjure(
    ctx,
    ownerId,
    oracle({ name, typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
    'hand',
  );
  pump(moveObject(ctx, card, { zone: 'battlefield', controllerId }));
  const perm = ctx.state.battlefield.find((entry) => entry.cardId === card.cardId);
  if (perm === undefined) throw new Error(`${name} did not enter the battlefield`);
  perm.tapped = true;
  perm.summoningSick = false;
  return perm;
}

describe('Reins of Power (PR08.17)', () => {
  it('reins-pinned-oracle-authors-the-one-unsupplied-sentence — pins the Oracle hash and authors the exact target and effect', () => {
    expect(pin.sha256).toBe('d83ab9041af563dfad9ec6940c985c7a25de35b0ecfc955793da7577e2c591c2');
    expect(pin.card.oracleId).toBe('96381388-1e82-411c-8290-1f3e909d3b5f');
    expect(pin.card.manaCost).toBe('{2}{U}{U}');
    expect(pin.card.typeLine).toBe('Instant');
    for (const card of [pin.card, { ...pin.card, oracleId: 'oracle-reins-of-power' }]) {
      const def = interpretCard(card);
      expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
      expect(def.unmodeledReasons).toEqual([]);
      expect(def.spellAbility?.targets).toEqual([{ kind: 'player', controller: 'opponent' }]);
      expect(def.spellAbility?.effects).toEqual([{ op: 'swapCreatureControlUntilEot', target: 0 }]);
    }
  });

  it('reins-normal-cast-untaps-swaps-and-grants-haste — a real {2}{U}{U} cast untaps, swaps and hastes exactly both groups', () => {
    const ctx = pod('reins-normal-cast');
    const mine = [bear(ctx, 'P1', 'Caster Bear One'), bear(ctx, 'P1', 'Caster Bear Two')];
    const theirs = [bear(ctx, 'P2', 'Opponent Ox'), bear(ctx, 'P2', 'Opponent Boar')];
    const bystander = bear(ctx, 'P3', 'Uninvolved Servo');

    castReins(ctx);

    for (const perm of mine) {
      expect(controlledBy(perm)).toBe('P2');
      expect(perm.ownerId).toBe('P1');
      expect(perm.tapped).toBe(false);
      expect(haste(ctx, perm)).toBe(true);
    }
    for (const perm of theirs) {
      expect(controlledBy(perm)).toBe('P1');
      expect(perm.ownerId).toBe('P2');
      expect(perm.tapped).toBe(false);
      expect(haste(ctx, perm)).toBe(true);
    }
    // A third player is never in either group.
    expect(controlledBy(bystander)).toBe('P3');
    expect(bystander.tapped).toBe(true);
    expect(haste(ctx, bystander)).toBe(false);
    expect(manaTotal(ctx, 'P1')).toBe(0);
  });

  it('reins-cast-cost-needs-two-blue-and-four-mana — missing blue or an insufficient total both remove the cast from the menu', () => {
    const ctx = pod('reins-cast-cost');
    const card = conjure(ctx, 'P1', pin.card, 'hand');
    fund(ctx, ['C', 'C', 'C', 'C']);
    expect(castOptionFor(ctx, card.id)).toBeUndefined();
    playerById(ctx, 'P1').manaEntries = [];
    fund(ctx, ['U', 'U', 'C']);
    expect(castOptionFor(ctx, card.id)).toBeUndefined();
    playerById(ctx, 'P1').manaEntries = [];
    fund(ctx, ['U', 'C', 'C', 'C']);
    expect(castOptionFor(ctx, card.id)).toBeUndefined();
    playerById(ctx, 'P1').manaEntries = [];
    fund(ctx, PRINTED_MANA);
    expect(castOptionFor(ctx, card.id)).toBeDefined();
  });

  it('reins-instant-speed-is-legal-on-an-opponent-turn-and-in-combat — an instant is castable at either, with priority', () => {
    const ctx = pod('reins-speed');
    const card = conjure(ctx, 'P1', pin.card, 'hand');
    fund(ctx, PRINTED_MANA);
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    expect(castOptionFor(ctx, card.id)).toBeDefined();
    ctx.state.phase = 'combat';
    ctx.state.step = 'declareBlockers';
    expect(castOptionFor(ctx, card.id)).toBeDefined();
    ctx.state.phase = 'combat';
    ctx.state.step = 'combatDamage';
    expect(castOptionFor(ctx, card.id)).toBeDefined();
    expect(castOptionFor(ctx, card.id)?.description).toContain('Reins of Power');
  });

  it('reins-target-is-an-opponent-player-only — the target domain is players, opponents, alive and without hexproof', () => {
    const ctx = pod('reins-target-domain');
    const bearWitness = bear(ctx, 'P2', 'Target Domain Bear');
    const spec = interpretCard(pin.card).spellAbility!.targets[0]!;
    const legal = () => computeTargetOptions(ctx, spec, 'P1');
    expect(legal()).toEqual(expect.arrayContaining(['P2', 'P3']));
    expect(legal()).not.toContain('P1');
    expect(legal()).not.toContain(bearWitness.id);
    expect(ctx.state.playerHexproofTurn).toBeUndefined();
    ctx.state.playerHexproofTurn = { P2: ctx.state.turnNumber };
    expect(legal()).not.toContain('P2');
    expect(legal()).toContain('P3');
    delete ctx.state.playerHexproofTurn;
    playerById(ctx, 'P3').hasLost = true;
    expect(legal()).not.toContain('P3');
    expect(legal()).toContain('P2');
  });

  it('reins-sole-target-illegal-at-resolution-fizzles-everything — a dead target player fizzles the whole spell with mana paid and the card in the graveyard', () => {
    const ctx = pod('reins-fizzle');
    const mine = bear(ctx, 'P1', 'Fizzle Caster Bear');
    const theirs = bear(ctx, 'P2', 'Fizzle Opponent Bear');
    const card = conjure(ctx, 'P1', pin.card, 'hand');
    const cardId = card.cardId;
    fund(ctx, PRINTED_MANA);
    const option = castOptionFor(ctx, card.id);
    expect(option, 'normal {2}{U}{U} cast offered').toBeDefined();
    pump(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, 'P2']]),
      }),
    );
    expect(ctx.state.stack).toHaveLength(1);
    playerById(ctx, 'P2').hasLost = true;
    pump(runPrioritySequence(ctx), passEverything());

    expect(ctx.state.stack).toHaveLength(0);
    expect(ctx.state.eventLog.some((event) => event.type === 'fizzle')).toBe(true);
    expect(manaTotal(ctx, 'P1')).toBe(0);
    expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
    expect(playerById(ctx, 'P1').graveyard.some((entry) => entry.cardId === cardId)).toBe(true);
    for (const perm of [mine, theirs]) {
      expect(controlledBy(perm)).toBe(perm.ownerId);
      expect(perm.tapped).toBe(true);
      expect(haste(ctx, perm)).toBe(false);
    }
  });

  it.each([
    ['both-groups-empty', false, false],
    ['only-the-casters-group', true, false],
    ['only-the-opponents-group', false, true],
  ])(
    'reins-%s-still-resolves — an empty group is legal, never an all-or-nothing exchange',
    (_label, casterGroup, opponentGroup) => {
      const ctx = pod(`reins-empty-${_label}`);
      const bystander = bear(ctx, 'P3', 'Empty Set Bystander');
      const mine = casterGroup ? bear(ctx, 'P1', 'Only Caster Bear') : undefined;
      const theirs = opponentGroup ? bear(ctx, 'P2', 'Only Opponent Bear') : undefined;
      castReins(ctx);
      if (mine !== undefined) {
        expect(controlledBy(mine)).toBe('P2');
        expect(mine.tapped).toBe(false);
        expect(haste(ctx, mine)).toBe(true);
      }
      if (theirs !== undefined) {
        expect(controlledBy(theirs)).toBe('P1');
        expect(theirs.tapped).toBe(false);
        expect(haste(ctx, theirs)).toBe(true);
      }
      expect(controlledBy(bystander)).toBe('P3');
      expect(bystander.tapped).toBe(true);
      expect(haste(ctx, bystander)).toBe(false);
    },
  );

  it('reins-owner-is-irrelevant-to-group-membership — membership follows the controller, not the owner', () => {
    const ctx = pod('reins-owner-irrelevant');
    const borrowed = lentBear(ctx, 'P3', 'P1', 'Third Party Gift');
    const stolen = lentBear(ctx, 'P2', 'P1', 'Caster Gift In Opponent Hands');
    const theirGift = lentBear(ctx, 'P1', 'P2', 'Opponent Gift In Caster Hands');

    expect(borrowed.ownerId).toBe('P3');
    expect(stolen.ownerId).toBe('P2');
    expect(theirGift.ownerId).toBe('P1');
    castReins(ctx);

    expect(controlledBy(borrowed)).toBe('P2');
    expect(controlledBy(stolen)).toBe('P2');
    expect(controlledBy(theirGift)).toBe('P1');
    expect(haste(ctx, borrowed)).toBe(true);
    expect(haste(ctx, stolen)).toBe(true);
    expect(haste(ctx, theirGift)).toBe(true);
    endUntilEotEffects(ctx);
    // Cleanup restores the controller each permanent answered to, never its owner.
    expect(controlledBy(borrowed)).toBe('P1');
    expect(controlledBy(stolen)).toBe('P1');
    expect(controlledBy(theirGift)).toBe('P2');
  });

  it('reins-both-sets-frozen-before-the-first-control-change — haste covers the frozen set even when the grant itself removes the creature type', () => {
    const ctx = pod('reins-frozen-sets');
    const standard = oppositionProbe(ctx, 'P1', 'Allegiance Standard');
    expect(isCreature(ctx, standard)).toBe(false);
    const mine = bear(ctx, 'P1', 'Caster Bear');
    const theirs = spawn(
      ctx,
      'P2',
      oracle({ name: 'Opponent Shape Artifact', typeLine: 'Artifact' }),
    );
    // The only reason the opponent's artifact is a creature is that P1 controls the standard.
    expect(isCreature(ctx, theirs)).toBe(true);

    castReins(ctx);

    expect(controlledBy(mine)).toBe('P2');
    expect(haste(ctx, mine)).toBe(true);
    expect(controlledBy(theirs)).toBe('P1');
    // Control has already flipped, so the probe is no longer a creature — yet it was one when
    // the control instruction began, so "those creatures" still includes it.
    expect(isCreature(ctx, theirs)).toBe(false);
    expect(haste(ctx, theirs)).toBe(true);
    expect(theirs.tapped).toBe(false);
  });

  it('reins-untap-that-removes-the-creature-type-drops-the-permanent — a former creature untaps but neither transfers nor gains haste', () => {
    const ctx = pod('reins-untap-removes-type');
    const mine = bear(ctx, 'P1', 'Caster Bear');
    const theirs = bear(ctx, 'P2', 'Opponent Bear');
    const fading = typeProbe(ctx, 'P2', 'Sealed While Tapped', {
      kind: 'not',
      of: { kind: 'isUntapped' },
    });
    expect(isCreature(ctx, fading)).toBe(true);

    castReins(ctx);

    // Untapped by the first sentence, so no longer a creature for either later sentence.
    expect(fading.tapped).toBe(false);
    expect(isCreature(ctx, fading)).toBe(false);
    expect(controlledBy(fading)).toBe('P2');
    expect(haste(ctx, fading)).toBe(false);
    // The genuinely-creature members of both groups are unaffected by that exclusion.
    expect(controlledBy(mine)).toBe('P2');
    expect(haste(ctx, mine)).toBe(true);
    expect(controlledBy(theirs)).toBe('P1');
    expect(haste(ctx, theirs)).toBe(true);
  });

  it('reins-untap-that-adds-the-creature-type-includes-the-permanent — an artifact that becomes a creature once another creature untaps joins the post-untap set', () => {
    const ctx = pod('reins-untap-adds-type');
    const beacon = untappedBeacon(ctx, 'P2', 'Opponent Beacon');
    const waking = spawn(ctx, 'P2', oracle({ name: 'Dormant Construct', typeLine: 'Artifact' }), {
      tapped: true,
    });
    const mine = bear(ctx, 'P1', 'Caster Bear');
    // Tapped, so the beacon's static is inactive and the artifact is not yet a creature.
    expect(beacon.tapped).toBe(true);
    expect(isCreature(ctx, waking)).toBe(false);

    castReins(ctx);

    expect(beacon.tapped).toBe(false);
    expect(controlledBy(beacon)).toBe('P1');
    expect(haste(ctx, beacon)).toBe(true);
    // Only the untap made the artifact a creature, and that happened before the set was read.
    expect(isCreature(ctx, waking)).toBe(true);
    expect(controlledBy(waking)).toBe('P1');
    expect(haste(ctx, waking)).toBe(true);
    expect(controlledBy(mine)).toBe('P2');
  });

  it('reins-permanents-arriving-before-resolution-join-the-swap — creatures that arrive while the spell is on the stack are in the frozen set', () => {
    const ctx = pod('reins-before-resolution-arrivals');
    const early = bear(ctx, 'P1', 'Early Caster Creature');
    let lateCaster: EnginePermanent | undefined;
    let lateOpponent: EnginePermanent | undefined;

    castReins(ctx, {
      beforeResolve: () => {
        lateCaster = bear(ctx, 'P1', 'Late Caster Creature');
        lateOpponent = bear(ctx, 'P2', 'Late Opponent Creature');
      },
    });

    if (lateCaster === undefined || lateOpponent === undefined)
      throw new Error('the before-resolution arrivals were never put onto the battlefield');
    expect(controlledBy(early)).toBe('P2');
    expect(haste(ctx, early)).toBe(true);
    expect(controlledBy(lateCaster)).toBe('P2');
    expect(haste(ctx, lateCaster)).toBe(true);
    expect(controlledBy(lateOpponent)).toBe('P1');
    expect(haste(ctx, lateOpponent)).toBe(true);
  });

  it('reins-permanents-arriving-after-resolution-are-unaffected — a later creature is neither swapped, untapped nor hasted', () => {
    const ctx = pod('reins-after-resolution-arrivals');
    const swapped = bear(ctx, 'P1', 'Swapped Caster Bear');
    castReins(ctx);

    const afterCaster = bear(ctx, 'P1', 'After Resolution Caster');
    const afterOpponent = bear(ctx, 'P2', 'After Resolution Opponent');

    expect(controlledBy(afterCaster)).toBe('P1');
    expect(afterCaster.tapped).toBe(true);
    expect(haste(ctx, afterCaster)).toBe(false);
    expect(controlledBy(afterOpponent)).toBe('P2');
    expect(afterOpponent.tapped).toBe(true);
    expect(haste(ctx, afterOpponent)).toBe(false);
    expect(controlledBy(swapped)).toBe('P2');
  });

  it('reins-a-blinked-permanent-does-not-inherit-control-or-haste — a new object starts clean after the spell resolved', () => {
    const ctx = pod('reins-blink');
    const ox = bear(ctx, 'P2', 'Blinking Opponent Ox');
    castReins(ctx);
    expect(controlledBy(ox)).toBe('P1');
    expect(haste(ctx, ox)).toBe(true);

    pump(moveObject(ctx, ox, { zone: 'hand' }));
    const card = playerById(ctx, 'P2').hand.find((entry) => entry.cardId === ox.cardId);
    expect(card).toBeDefined();
    pump(moveObject(ctx, card!, { zone: 'battlefield', controllerId: 'P2' }));
    const next = ctx.state.battlefield.find((perm) => perm.cardId === ox.cardId)!;
    expect(next.id).not.toBe(ox.id);
    expect(controlledBy(next)).toBe('P2');
    expect(haste(ctx, next)).toBe(false);
    expect(next.controlChanges).toBeUndefined();
  });

  it('reins-cleanup-restores-the-underlying-controller-not-the-owner — control reverts, the untap stays and haste ends', () => {
    const ctx = pod('reins-cleanup');
    const borrowed = lentBear(ctx, 'P3', 'P1', 'Borrowed From The Third Seat');
    const ox = lentBear(ctx, 'P3', 'P2', 'Lent Opponent Ox');

    castReins(ctx);

    expect(controlledBy(borrowed)).toBe('P2');
    expect(controlledBy(ox)).toBe('P1');
    expect(borrowed.controlChanges?.at(-1)?.duration.kind).toBe('untilEndOfTurn');

    endUntilEotEffects(ctx);

    // Falls back to the record UNDERNEATH the temporary grant, never to the owner.
    expect(controlledBy(borrowed)).toBe('P1');
    expect(borrowed.ownerId).toBe('P3');
    expect(controlledBy(ox)).toBe('P2');
    expect(ox.ownerId).toBe('P3');
    // The untap was a real game-state change and is not undone.
    expect(borrowed.tapped).toBe(false);
    expect(ox.tapped).toBe(false);
    expect(haste(ctx, borrowed)).toBe(false);
    expect(haste(ctx, ox)).toBe(false);
  });

  it('reins-a-later-permanent-control-grant-survives-cleanup — a permanent grant made after the spell outranks the expiring one', () => {
    const ctx = pod('reins-later-permanent-grant');
    const ox = bear(ctx, 'P2', 'Reclaimed Opponent Ox');
    castReins(ctx);
    expect(controlledBy(ox)).toBe('P1');

    changeController(ctx, ox, 'P3');

    endUntilEotEffects(ctx);
    expect(controlledBy(ox)).toBe('P3');
    expect(haste(ctx, ox)).toBe(false);
  });

  it('reins-control-change-removes-creatures-from-combat — a swapped attacker or blocker is no longer in combat', () => {
    const ctx = pod('reins-combat');
    ctx.state.phase = 'combat';
    const attacker = bear(ctx, 'P1', 'Attacking Caster Bear');
    const blocker = bear(ctx, 'P2', 'Blocking Opponent Bear');
    attacker.attacking = 'P2';
    attacker.statuses = ['attacking'];
    blocker.blocking = attacker.id;
    blocker.statuses = ['blocking'];

    castReins(ctx);

    expect(controlledBy(attacker)).toBe('P2');
    expect(attacker.attacking).toBeNull();
    expect(attacker.statuses).not.toContain('attacking');
    expect(controlledBy(blocker)).toBe('P1');
    expect(blocker.blocking).toBeNull();
    expect(blocker.statuses).not.toContain('blocking');
  });
});
