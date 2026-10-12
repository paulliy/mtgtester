/**
 * PR06 card coverage: combat and damage events (docs/plans/card-coverage-chunks.md).
 *
 * Each restored card has a `describe` block whose test names start with the engine test IDs the
 * verification manifest declares for it. The gate at the bottom ties the two together: every
 * restored card must be pinned, modeled under both its real Oracle ID and its fixture alias,
 * declared `implemented-unreviewed` in the manifest, and mapped to engine tests in this file and to
 * Card Test Lab scenarios that the real-viewer Playwright spec exercises.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId, getOverride } from '../src/cards/overrides';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { addMana } from '../src/mana/pool';
import type { Ability } from '../src/cards/ability';
import { computeCharacteristics } from '../src/effects/continuous';
import { priorityCheckpoint } from '../src/sba/sba';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { runCombatAndExtraCombats } from '../src/turn/turn';
import { createGame } from '../src/state/game';
import { moveObject, playerById } from '../src/state/objects';
import { effectivePT, hasKeyword } from '../src/state/queries';
import type { EnginePermanent, GameContext } from '../src/state/types';
import {
  conjure,
  copies,
  declareAttacks,
  declareBlocks,
  forest,
  gameConfig,
  oracle,
  pump,
  spawn,
} from './fixtures';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}

const PINNED_FILES = ['fixtures/coverage-pr06-oracle.json'];
const pinnedCards = PINNED_FILES.flatMap(
  (file) =>
    (JSON.parse(readFileSync(join(import.meta.dirname, file), 'utf8')) as PinnedFixture).cards,
);

function pinned(name: string): { sha256: string; card: OracleCard } {
  const entry = pinnedCards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`missing pinned Oracle fixture for ${name}`);
  return entry;
}

function canonical(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
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

function priorityOptions(ctx: GameContext, playerId: string) {
  return computePriorityOptions(ctx, playerById(ctx, playerId));
}

/** The priority option whose payload object and description match, if it is legal now. */
function optionFor(ctx: GameContext, playerId: string, objectId: string, pattern?: RegExp) {
  return priorityOptions(ctx, playerId).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return (
      'objectId' in payload &&
      payload.objectId === objectId &&
      (pattern === undefined || pattern.test(option.description))
    );
  });
}

/** Take a priority action through the normal legality/payment path and leave it on the stack. */
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

function resolveTop(ctx: GameContext, answer?: Answer) {
  return pump(resolveTopOfStack(ctx), answer);
}

/**
 * Run the normal priority loop with every player passing: pending triggers go on the stack and
 * resolve in order. Non-priority decisions go to `answer` (default: first option).
 */
function settle(ctx: GameContext, answer?: Answer) {
  return pump(runPrioritySequence(ctx), (decision, count) => {
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    if (pass >= 0) return { index: pass, targets: new Map() };
    return answer?.(decision, count) ?? { index: 0, targets: new Map() };
  });
}

/** Aim every targeted trigger at `target` (a player id or a permanent's object id). */
const aimAt =
  (target: string): Answer =>
  (decision) => {
    const slot = decision.options[0]?.targets?.[0];
    if (slot !== undefined) return { index: 0, targets: new Map([[slot.slot, target]]) };
    return { index: 0, targets: new Map() };
  };

/** `playerId` casts `card` from hand through the normal legality/payment path with `mana`. */
function castFromHand(
  ctx: GameContext,
  playerId: string,
  card: OracleCard,
  mana: { symbol: 'C' | 'W' | 'U' | 'B' | 'R' | 'G' }[],
) {
  const object = conjure(ctx, playerId, card, 'hand');
  addMana(playerById(ctx, playerId), mana);
  const option = optionFor(ctx, playerId, object.id);
  expect(option, `${playerId} casts ${card.name}`).toBeDefined();
  takeAction(ctx, playerId, option!.payload as PriorityActionPayload);
  return object;
}

/** Put a card from `zone` onto the battlefield through the normal zone change (it enters). */
function enterFrom(
  ctx: GameContext,
  controllerId: string,
  card: OracleCard,
  zone: 'hand' | 'graveyard' | 'exile' | 'library' = 'hand',
): EnginePermanent {
  const object = conjure(ctx, controllerId, card, zone);
  pump(moveObject(ctx, object, { zone: 'battlefield', controllerId }));
  return ctx.state.battlefield.find((perm) => perm.cardId === object.cardId)!;
}

const onField = (ctx: GameContext, cardId: string) =>
  ctx.state.battlefield.find((perm) => perm.cardId === cardId);

const red = (n: number) => Array.from({ length: n }, () => ({ symbol: 'R' as const }));
const generic = (n: number) => Array.from({ length: n }, () => ({ symbol: 'C' as const }));

const damageEvents = (ctx: GameContext) =>
  ctx.state.eventLog.filter((event) => event.type === 'damage');

/** The pinned card is modeled under both ids with no remaining reasons. */
function expectModeled(card: OracleCard): void {
  for (const candidate of [card, { ...card, oracleId: fixtureOracleId(card.name) }]) {
    const def = interpretCard(candidate);
    expect(def.unmodeledReasons, candidate.oracleId).toEqual([]);
    expect(def.modeled, candidate.oracleId).toBe(true);
  }
}

/** The fail-closed registration is gone under both ids: the interpreter reads the card. */
function expectNoRegistration(card: OracleCard): void {
  expect(getOverride(card.oracleId)).toBeUndefined();
  expect(getOverride(fixtureOracleId(card.name))).toBeUndefined();
}

const LAB_CARD = (name: string) => oracle({ name, typeLine: 'Creature — Secret' });

// Lab creatures shared by the Dragon cards.
/** A blue 3/3 Dragon with lifelink. */
const DRAKE = oracle({
  name: 'Lab Drake',
  typeLine: 'Creature — Dragon',
  manaCost: '{0}',
  colors: ['U'],
  power: '3',
  toughness: '3',
  oracleText: 'Lifelink',
});
/** A red 2/2 Dragon. */
const EMBER_DRAGON = oracle({
  name: 'Lab Ember Dragon',
  typeLine: 'Creature — Dragon',
  manaCost: '{0}',
  colors: ['R'],
  power: '2',
  toughness: '2',
});
/** A colorless 1/1 flier. */
const FLIER = oracle({
  name: 'Lab Flier',
  typeLine: 'Creature — Bird',
  manaCost: '{0}',
  power: '1',
  toughness: '1',
  oracleText: 'Flying',
});
/** A creature with protection from blue. */
const WARDEN = oracle({
  name: 'Lab Warden',
  typeLine: 'Creature — Knight',
  power: '1',
  toughness: '9',
  oracleText: 'Protection from blue',
});

// ---------------------------------------------------------------------------------------------
// PR06.18 Dragon Tempest
// ---------------------------------------------------------------------------------------------

describe('Dragon Tempest', () => {
  const { card } = pinned('Dragon Tempest');
  /** P1 controls Dragon Tempest. */
  function board(seed: string) {
    const ctx = pod(seed);
    const tempest = spawn(ctx, 'P1', card);
    return { ctx, tempest };
  }

  it('dragon-tempest-pinned-oracle-supported — the interpreter alone models the flying-haste trigger and the Dragon-sourced damage trigger', () => {
    expectNoRegistration(card);
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(2);
    expect(def.triggers[0]!.effects).toEqual([
      { op: 'grantKeywordUntilEot', keyword: 'haste', target: 'triggerObject' },
    ]);
    expect(def.triggers[1]!.targets).toEqual([{ kind: 'anyTarget' }]);
    // "it deals X damage": the entering Dragon is the source, not the enchantment.
    expect(def.triggers[1]!.effects).toEqual([
      {
        op: 'dealDamage',
        target: 0,
        amount: {
          kind: 'countPermanents',
          selector: {
            kind: 'allOf',
            of: [
              { kind: 'controller', who: 'you' },
              { kind: 'subtype', value: 'Dragon' },
            ],
          },
          scope: 'you',
        },
        source: 'triggerObject',
      },
    ]);
  });

  it('dragon-tempest-flying-haste — a flying creature you control entering gains haste until end of turn, and only that creature', () => {
    const { ctx } = board('tempest-haste');
    const bystander = spawn(ctx, 'P1', LAB_CARD('Lab Bystander'), { summoningSick: true });
    const flier = enterFrom(ctx, 'P1', FLIER);
    settle(ctx);
    expect(hasKeyword(ctx, onField(ctx, flier.cardId)!, 'haste')).toBe(true);
    expect(hasKeyword(ctx, bystander, 'haste')).toBe(false);
    // Until end of turn: the haste is a temporary effect that is gone after cleanup.
    expect(ctx.state.stack).toEqual([]);

    // Negative: a creature without flying gains nothing, and an opponent's flier gains nothing.
    const plain = board('tempest-haste-negative');
    const ground = enterFrom(plain.ctx, 'P1', LAB_CARD('Lab Walker'));
    const theirs = enterFrom(plain.ctx, 'P2', FLIER);
    settle(plain.ctx);
    expect(hasKeyword(plain.ctx, onField(plain.ctx, ground.cardId)!, 'haste')).toBe(false);
    expect(hasKeyword(plain.ctx, onField(plain.ctx, theirs.cardId)!, 'haste')).toBe(false);
  });

  it('dragon-tempest-dragon-is-source — the entering Dragon deals the damage: its lifelink gains life for its controller', () => {
    const { ctx } = board('tempest-source-lifelink');
    enterFrom(ctx, 'P1', DRAKE);
    settle(ctx, aimAt('P2'));
    // X is the number of Dragons you control: just the Drake.
    expect(playerById(ctx, 'P2').life).toBe(39);
    expect(playerById(ctx, 'P1').life).toBe(41);
    expect(damageEvents(ctx).at(-1)?.payload).toMatchObject({ source: 'Lab Drake', amount: 1 });
  });

  it("dragon-tempest-dragon-is-source-color — the damage has the Dragon's color: a creature with protection from blue is unhurt by a blue Dragon but hurt by a red one", () => {
    // The enchantment itself is red, so damage from it would always reach the Warden.
    const blue = board('tempest-source-blue');
    const warden = spawn(blue.ctx, 'P2', WARDEN);
    enterFrom(blue.ctx, 'P1', DRAKE);
    settle(blue.ctx, aimAt(warden.id));
    expect(onField(blue.ctx, warden.cardId)?.damageMarked).toBe(0);
    expect(playerById(blue.ctx, 'P1').life).toBe(40);

    const redCase = board('tempest-source-red');
    const guard = spawn(redCase.ctx, 'P2', WARDEN);
    enterFrom(redCase.ctx, 'P1', EMBER_DRAGON);
    settle(redCase.ctx, aimAt(guard.id));
    expect(onField(redCase.ctx, guard.cardId)?.damageMarked).toBe(1);
  });

  it('dragon-tempest-dragon-count — X is the number of Dragons you control as the trigger resolves, not when it triggered', () => {
    // A Dragon you control enters beside two others: X is 3.
    const { ctx } = board('tempest-count');
    spawn(ctx, 'P1', EMBER_DRAGON);
    spawn(ctx, 'P1', EMBER_DRAGON);
    spawn(ctx, 'P2', EMBER_DRAGON);
    enterFrom(ctx, 'P1', DRAKE);
    settle(ctx, aimAt('P2'));
    // The opponent's Dragon is not counted.
    expect(playerById(ctx, 'P2').life).toBe(37);

    // A Dragon arriving while the trigger is on the stack is counted.
    const grows = board('tempest-count-grows');
    enterFrom(grows.ctx, 'P1', DRAKE);
    pump(priorityCheckpoint(grows.ctx), aimAt('P2'));
    expect(grows.ctx.state.stack).toHaveLength(1);
    spawn(grows.ctx, 'P1', EMBER_DRAGON);
    resolveTop(grows.ctx);
    expect(playerById(grows.ctx, 'P2').life).toBe(38);

    // A Dragon leaving while the trigger is on the stack is not counted.
    const shrinks = board('tempest-count-shrinks');
    const other = spawn(shrinks.ctx, 'P1', EMBER_DRAGON);
    enterFrom(shrinks.ctx, 'P1', DRAKE);
    pump(priorityCheckpoint(shrinks.ctx), aimAt('P2'));
    expect(shrinks.ctx.state.stack).toHaveLength(1);
    pump(moveObject(shrinks.ctx, other, { zone: 'graveyard' }));
    resolveTop(shrinks.ctx);
    expect(playerById(shrinks.ctx, 'P2').life).toBe(39);
  });

  it('dragon-tempest-dragon-gone — a Dragon that left the battlefield before the trigger resolves still deals the damage as it last existed (CR 608.2h)', () => {
    const { ctx } = board('tempest-lki');
    spawn(ctx, 'P1', EMBER_DRAGON);
    const drake = enterFrom(ctx, 'P1', DRAKE);
    pump(priorityCheckpoint(ctx), aimAt('P2'));
    expect(ctx.state.stack).toHaveLength(1);
    pump(moveObject(ctx, onField(ctx, drake.cardId)!, { zone: 'exile' }));
    resolveTop(ctx);
    expect(onField(ctx, drake.cardId)).toBeUndefined();
    // X counts the Dragons still there (the Ember Dragon); the Drake's lifelink still applies.
    expect(playerById(ctx, 'P2').life).toBe(39);
    expect(playerById(ctx, 'P1').life).toBe(41);
    expect(damageEvents(ctx).at(-1)?.payload).toMatchObject({ source: 'Lab Drake', amount: 1 });
  });

  it("dragon-tempest-dragon-trigger-conditions — a non-Dragon creature entering and an opponent's Dragon entering deal no damage", () => {
    const { ctx } = board('tempest-conditions');
    enterFrom(ctx, 'P1', LAB_CARD('Lab Walker'));
    enterFrom(ctx, 'P2', DRAKE);
    expect(ctx.state.pendingTriggers).toEqual([]);
    settle(ctx, aimAt('P2'));
    expect(playerById(ctx, 'P2').life).toBe(40);
    expect(playerById(ctx, 'P1').life).toBe(40);
    expect(damageEvents(ctx)).toEqual([]);
    expect(ctx.state.stack).toEqual([]);
  });

  it('dragon-tempest-cast-dragon — a Dragon cast from hand and resolved goes through the stack: the trigger targets, then the Dragon deals X damage', () => {
    const { ctx } = board('tempest-cast');
    castFromHand(ctx, 'P1', DRAKE, []);
    resolveTop(ctx);
    expect(ctx.state.battlefield.some((perm) => perm.name === 'Lab Drake')).toBe(true);
    const run = settle(ctx, aimAt('P3'));
    expect(run.decisions.length).toBeGreaterThan(0);
    expect(playerById(ctx, 'P3').life).toBe(39);
    expect(playerById(ctx, 'P1').life).toBe(41);
    expect(playerById(ctx, 'P2').life).toBe(40);
    expect(ctx.state.stack).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// PR06.10 Scourge of Valkas
// ---------------------------------------------------------------------------------------------

describe('Scourge of Valkas', () => {
  const { card } = pinned('Scourge of Valkas');
  const COST = [...red(3), ...generic(2)];

  /** P1 controls Scourge of Valkas. */
  function board(seed: string) {
    const ctx = pod(seed);
    const scourge = spawn(ctx, 'P1', card);
    return { ctx, scourge };
  }

  it('scourge-of-valkas-pinned-oracle-supported — the interpreter alone models the self-or-other-Dragon enters trigger, the Dragon-sourced damage and the red pump', () => {
    expectNoRegistration(card);
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(1);
    const [trigger] = def.triggers;
    // This creature, or another Dragon you control: never an opponent's Dragon.
    expect(trigger!.trigger).toEqual({
      when: 'enters',
      subject: {
        kind: 'permanent',
        selector: {
          kind: 'anyOf',
          of: [
            { kind: 'self' },
            {
              kind: 'allOf',
              of: [
                { kind: 'other' },
                { kind: 'controller', who: 'you' },
                { kind: 'subtype', value: 'Dragon' },
              ],
            },
          ],
        },
      },
    });
    expect(trigger!.targets).toEqual([{ kind: 'anyTarget' }]);
    // "it deals X damage": the entering creature is the source, X counted on resolution.
    expect(trigger!.effects).toEqual([
      {
        op: 'dealDamage',
        target: 0,
        amount: {
          kind: 'countPermanents',
          selector: {
            kind: 'allOf',
            of: [
              { kind: 'controller', who: 'you' },
              { kind: 'subtype', value: 'Dragon' },
            ],
          },
          scope: 'you',
        },
        source: 'triggerObject',
      },
    ]);
    expect(def.activatedAbilities).toHaveLength(1);
  });

  it('scourge-of-valkas-self-enters — Scourge entering from the stack triggers itself, as the source, for X = the Dragons you control', () => {
    const ctx = pod('scourge-self');
    spawn(ctx, 'P1', EMBER_DRAGON);
    castFromHand(ctx, 'P1', card, COST);
    resolveTop(ctx);
    const scourge = ctx.state.battlefield.find((perm) => perm.name === 'Scourge of Valkas');
    expect(scourge).toBeDefined();
    const run = settle(ctx, aimAt('P2'));
    expect(run.decisions.length).toBeGreaterThan(0);
    // Scourge and the Ember Dragon: X = 2.
    expect(playerById(ctx, 'P2').life).toBe(38);
    expect(damageEvents(ctx).at(-1)?.payload).toMatchObject({
      source: 'Scourge of Valkas',
      amount: 2,
    });
    expect(ctx.state.stack).toEqual([]);
  });

  it("scourge-of-valkas-other-dragon-source — another Dragon you control entering triggers it, and that Dragon (not Scourge) is the source: Scourge doesn't gain life, the lifelink Dragon's controller does", () => {
    const { ctx } = board('scourge-other');
    enterFrom(ctx, 'P1', DRAKE);
    settle(ctx, aimAt('P2'));
    // Scourge and the Drake: X = 2, dealt by the Drake, whose lifelink gains 2.
    expect(playerById(ctx, 'P2').life).toBe(38);
    expect(playerById(ctx, 'P1').life).toBe(42);
    expect(damageEvents(ctx).at(-1)?.payload).toMatchObject({ source: 'Lab Drake', amount: 2 });
  });

  it("scourge-of-valkas-source-color — the damage has the entering Dragon's color: a creature with protection from blue is unhurt by a blue Dragon but hurt by a red one", () => {
    // Scourge itself is red, so damage from it would always reach the Warden.
    const blue = board('scourge-source-blue');
    const warden = spawn(blue.ctx, 'P2', WARDEN);
    enterFrom(blue.ctx, 'P1', DRAKE);
    settle(blue.ctx, aimAt(warden.id));
    expect(onField(blue.ctx, warden.cardId)?.damageMarked).toBe(0);

    const redCase = board('scourge-source-red');
    const guard = spawn(redCase.ctx, 'P2', WARDEN);
    enterFrom(redCase.ctx, 'P1', EMBER_DRAGON);
    settle(redCase.ctx, aimAt(guard.id));
    expect(onField(redCase.ctx, guard.cardId)?.damageMarked).toBe(2);
  });

  it('scourge-of-valkas-dragon-count — X is the number of Dragons you control as the trigger resolves, counting only your own', () => {
    const { ctx } = board('scourge-count');
    spawn(ctx, 'P1', EMBER_DRAGON);
    spawn(ctx, 'P2', EMBER_DRAGON);
    enterFrom(ctx, 'P1', DRAKE);
    settle(ctx, aimAt('P2'));
    // Scourge, the Ember Dragon and the Drake; the opponent's Dragon is not counted.
    expect(playerById(ctx, 'P2').life).toBe(37);

    // A Dragon arriving while the trigger is on the stack is counted.
    const grows = board('scourge-count-grows');
    enterFrom(grows.ctx, 'P1', DRAKE);
    pump(priorityCheckpoint(grows.ctx), aimAt('P2'));
    expect(grows.ctx.state.stack).toHaveLength(1);
    spawn(grows.ctx, 'P1', EMBER_DRAGON);
    resolveTop(grows.ctx);
    expect(playerById(grows.ctx, 'P2').life).toBe(37);

    // A Dragon leaving while the trigger is on the stack is not counted.
    const shrinks = board('scourge-count-shrinks');
    const other = spawn(shrinks.ctx, 'P1', EMBER_DRAGON);
    enterFrom(shrinks.ctx, 'P1', DRAKE);
    pump(priorityCheckpoint(shrinks.ctx), aimAt('P2'));
    pump(moveObject(shrinks.ctx, other, { zone: 'graveyard' }));
    resolveTop(shrinks.ctx);
    expect(playerById(shrinks.ctx, 'P2').life).toBe(38);
  });

  it('scourge-of-valkas-dragon-gone — the entering creature, whether another Dragon or Scourge itself, still deals the damage after it left the battlefield (CR 608.2h)', () => {
    const other = board('scourge-lki-other');
    spawn(other.ctx, 'P1', EMBER_DRAGON);
    const drake = enterFrom(other.ctx, 'P1', DRAKE);
    pump(priorityCheckpoint(other.ctx), aimAt('P2'));
    expect(other.ctx.state.stack).toHaveLength(1);
    pump(moveObject(other.ctx, onField(other.ctx, drake.cardId)!, { zone: 'exile' }));
    resolveTop(other.ctx);
    // Scourge and the Ember Dragon remain: X = 2, dealt by the Drake as it last existed.
    expect(playerById(other.ctx, 'P2').life).toBe(38);
    expect(playerById(other.ctx, 'P1').life).toBe(42);
    expect(damageEvents(other.ctx).at(-1)?.payload).toMatchObject({
      source: 'Lab Drake',
      amount: 2,
    });

    const own = pod('scourge-lki-self');
    spawn(own, 'P1', EMBER_DRAGON);
    spawn(own, 'P1', EMBER_DRAGON);
    const entered = enterFrom(own, 'P1', card);
    pump(priorityCheckpoint(own), aimAt('P2'));
    expect(own.state.stack).toHaveLength(1);
    pump(moveObject(own, onField(own, entered.cardId)!, { zone: 'graveyard' }));
    resolveTop(own);
    expect(onField(own, entered.cardId)).toBeUndefined();
    expect(playerById(own, 'P2').life).toBe(38);
    expect(damageEvents(own).at(-1)?.payload).toMatchObject({
      source: 'Scourge of Valkas',
      amount: 2,
    });
  });

  it("scourge-of-valkas-trigger-conditions — a non-Dragon creature and an opponent's Dragon entering deal no damage", () => {
    const { ctx } = board('scourge-conditions');
    enterFrom(ctx, 'P1', LAB_CARD('Lab Walker'));
    enterFrom(ctx, 'P2', DRAKE);
    expect(ctx.state.pendingTriggers).toEqual([]);
    settle(ctx, aimAt('P2'));
    expect(playerById(ctx, 'P2').life).toBe(40);
    expect(damageEvents(ctx)).toEqual([]);
    expect(ctx.state.stack).toEqual([]);
  });

  it('scourge-of-valkas-two-scourges — with two Scourges, another Dragon entering triggers each of them, and a Scourge entering triggers itself and the other', () => {
    const { ctx } = board('scourge-two');
    spawn(ctx, 'P1', card);
    enterFrom(ctx, 'P1', DRAKE);
    expect(ctx.state.pendingTriggers).toHaveLength(2);
    settle(ctx, aimAt('P2'));
    // Two Scourges and the Drake: each trigger deals X = 3 from the Drake.
    expect(playerById(ctx, 'P2').life).toBe(34);
    expect(playerById(ctx, 'P1').life).toBe(46);
    expect(damageEvents(ctx).map((event) => event.payload['source'])).toEqual([
      'Lab Drake',
      'Lab Drake',
    ]);

    // The second Scourge entering is "this creature" for itself and "another Dragon" for the first.
    const entering = board('scourge-two-entering');
    enterFrom(entering.ctx, 'P1', card);
    expect(entering.ctx.state.pendingTriggers).toHaveLength(2);
    settle(entering.ctx, aimAt('P2'));
    expect(playerById(entering.ctx, 'P2').life).toBe(36);
    expect(
      damageEvents(entering.ctx).every((event) => event.payload['source'] === 'Scourge of Valkas'),
    ).toBe(true);
  });

  it('scourge-of-valkas-red-pump — {R} gives +1/+0 until end of turn, once per red mana, and is not offered without red mana', () => {
    const { ctx, scourge } = board('scourge-pump');
    expect(optionFor(ctx, 'P1', scourge.id, /gets \+1\/\+0/)).toBeUndefined();
    addMana(playerById(ctx, 'P1'), red(2));
    const first = optionFor(ctx, 'P1', scourge.id, /gets \+1\/\+0/);
    expect(first).toBeDefined();
    takeAction(ctx, 'P1', first!.payload as PriorityActionPayload);
    resolveTop(ctx);
    expect(effectivePT(ctx, scourge)).toEqual({ power: 5, toughness: 4 });
    takeAction(
      ctx,
      'P1',
      optionFor(ctx, 'P1', scourge.id, /gets \+1\/\+0/)!.payload as PriorityActionPayload,
    );
    resolveTop(ctx);
    expect(effectivePT(ctx, scourge)).toEqual({ power: 6, toughness: 4 });
    // Colorless mana cannot pay {R}.
    const dry = board('scourge-pump-colorless');
    addMana(playerById(dry.ctx, 'P1'), generic(2));
    expect(optionFor(dry.ctx, 'P1', dry.scourge.id, /gets \+1\/\+0/)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// PR06.15 Tyrant's Familiar
// ---------------------------------------------------------------------------------------------

describe("Tyrant's Familiar", () => {
  const { card } = pinned("Tyrant's Familiar");
  const GENERAL = oracle({
    name: 'Lab General',
    typeLine: 'Legendary Creature — Human',
    manaCost: '{2}',
  });
  const BEAR = (name: string, toughness = '2') =>
    oracle({ name, typeLine: 'Creature — Bear', power: '2', toughness });

  const stats = (ctx: GameContext, permanent: EnginePermanent) => {
    const c = computeCharacteristics(ctx, permanent);
    return {
      power: c.power,
      toughness: c.toughness,
      flying: c.keywords.includes('flying'),
      haste: c.keywords.includes('haste'),
      triggers: c.triggers.length,
    };
  };

  /** P1 controls the Familiar; P2, P3 and P4 each control a creature. */
  function board(seed: string, commander: boolean) {
    const ctx = pod(seed);
    const familiar = spawn(ctx, 'P1', card);
    const bears = {
      P2: spawn(ctx, 'P2', BEAR('Lab Bear P2', '9')),
      P3: spawn(ctx, 'P3', BEAR('Lab Bear P3', '9')),
      P4: spawn(ctx, 'P4', BEAR('Lab Bear P4', '9')),
    };
    // A second creature each for P2 and P3, so the target is a real choice for either defender.
    const spares = [
      spawn(ctx, 'P2', BEAR('Lab Spare P2', '9')),
      spawn(ctx, 'P3', BEAR('Lab Spare P3', '9')),
    ];
    const own = spawn(ctx, 'P1', BEAR('Lab Own Bear', '9'));
    const general = commander ? spawn(ctx, 'P1', GENERAL) : undefined;
    if (general !== undefined) general.isCommander = true;
    return { ctx, familiar, bears, spares, own, general };
  }

  /**
   * P1's combat with the Familiar attacking `defender`. Each attack-trigger target prompt is
   * recorded (object ids on offer) and answered with `aim` (a permanent id), if given.
   */
  function attack(ctx: GameContext, familiar: EnginePermanent, defender: string, aim?: string) {
    const offered: string[][] = [];
    const run = pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId) =>
          subjectId === familiar.id ? defender : null,
        );
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      const slot = decision.options[0]?.targets?.[0];
      if (slot !== undefined) {
        offered.push(slot.options);
        return { index: 0, targets: new Map([[slot.slot, aim ?? slot.options[0]!]]) };
      }
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    return { offered, run };
  }

  it('tyrants-familiar-pinned-oracle-supported — the override reads the lieutenant line as a pump and a granted attack trigger, both only while you control your commander', () => {
    expectModeled(card);
    expect(getOverride(card.oracleId)?.unsupportedReason).toBeUndefined();
    expect(getOverride(fixtureOracleId(card.name))?.unsupportedReason).toBeUndefined();
    const def = interpretCard(card);
    expect(def.keywords).toEqual(expect.arrayContaining(['flying', 'haste']));
    expect(def.triggers).toEqual([]);
    expect(def.staticEffects).toHaveLength(2);
    for (const effect of def.staticEffects) {
      expect(effect.affects).toEqual({ kind: 'self' });
      expect(effect.condition).toEqual({ kind: 'controlsYourCommander' });
    }
    expect(def.staticEffects[0]!.op).toEqual({
      layer: 7,
      sublayer: 'd',
      power: 2,
      toughness: 2,
    });
    const granted = (def.staticEffects[1]!.op as { addTrigger: Ability }).addTrigger;
    // The defending player is the player this creature attacks, and the target is theirs.
    expect(granted.trigger).toEqual({
      when: 'attacks',
      subject: { kind: 'self' },
      defendingPlayerIsEventPlayer: true,
    });
    expect(granted.targets).toEqual([{ kind: 'creature', controller: 'eventPlayer' }]);
    expect(granted.effects).toEqual([
      { op: 'dealDamage', target: 0, amount: { kind: 'const', n: 7 } },
    ]);
  });

  it('tyrants-familiar-no-commander — without your commander it is a plain 5/5 flying haste creature with no attack trigger', () => {
    const { ctx, familiar, bears } = board('familiar-off', false);
    expect(stats(ctx, familiar)).toEqual({
      power: 5,
      toughness: 5,
      flying: true,
      haste: true,
      triggers: 0,
    });
    const { offered } = attack(ctx, familiar, 'P2');
    expect(offered).toEqual([]);
    expect(onField(ctx, bears.P2.cardId)?.damageMarked).toBe(0);
    expect(damageEvents(ctx).filter((event) => event.payload['combat'] !== true)).toEqual([]);
  });

  it('tyrants-familiar-lieutenant-active — with your commander out it is a 7/7 with the granted trigger, and both end when the commander leaves', () => {
    const { ctx, familiar, general } = board('familiar-on', true);
    expect(stats(ctx, familiar)).toEqual({
      power: 7,
      toughness: 7,
      flying: true,
      haste: true,
      triggers: 1,
    });
    pump(moveObject(ctx, general!, { zone: 'graveyard' }));
    expect(stats(ctx, familiar)).toEqual({
      power: 5,
      toughness: 5,
      flying: true,
      haste: true,
      triggers: 0,
    });
  });

  it("tyrants-familiar-commander-control — a stolen commander or another player's commander does not count", () => {
    const stolen = board('familiar-stolen', true);
    stolen.general!.controllerId = 'P2';
    expect(stats(stolen.ctx, stolen.familiar)).toMatchObject({ power: 5, triggers: 0 });

    const borrowed = board('familiar-borrowed', false);
    const theirs = spawn(borrowed.ctx, 'P2', GENERAL);
    theirs.isCommander = true;
    theirs.controllerId = 'P1';
    expect(stats(borrowed.ctx, borrowed.familiar)).toMatchObject({ power: 5, triggers: 0 });
  });

  it("tyrants-familiar-defending-player — attacking one player offers only creatures that player controls, never your own or another opponent's", () => {
    const p2 = board('familiar-defender-p2', true);
    const first = attack(p2.ctx, p2.familiar, 'P2');
    expect(first.offered).toHaveLength(1);
    expect([...first.offered[0]!].sort()).toEqual([p2.bears.P2.id, p2.spares[0]!.id].sort());

    const p3 = board('familiar-defender-p3', true);
    const second = attack(p3.ctx, p3.familiar, 'P3');
    expect([...second.offered[0]!].sort()).toEqual([p3.bears.P3.id, p3.spares[1]!.id].sort());
    expect(second.offered[0]).not.toContain(p3.bears.P2.id);
    expect(second.offered[0]).not.toContain(p3.own.id);
  });

  it('tyrants-familiar-seven-damage — the Familiar deals 7 damage to the chosen creature, not to a player, and the other creatures are untouched', () => {
    const { ctx, familiar, bears, spares, own } = board('familiar-damage', true);
    attack(ctx, familiar, 'P2', bears.P2.id);
    expect(onField(ctx, bears.P2.cardId)?.damageMarked).toBe(7);
    for (const untouched of [spares[0]!, bears.P3, spares[1]!, bears.P4, own])
      expect(onField(ctx, untouched.cardId)?.damageMarked).toBe(0);
    // The only non-combat damage is the trigger's: from the Familiar itself, 7 to the chosen creature.
    const triggerDamage = damageEvents(ctx).filter((event) => event.payload['combat'] === false);
    expect(triggerDamage).toHaveLength(1);
    expect(triggerDamage[0]?.payload).toMatchObject({
      sourceCardId: familiar.cardId,
      target: 'Lab Bear P2',
      targetCardId: bears.P2.cardId,
      amount: 7,
    });
    // The attack itself (7 flying combat damage) still reaches the defending player.
    expect(playerById(ctx, 'P2').life).toBe(33);
    expect(playerById(ctx, 'P3').life).toBe(40);
  });

  it("tyrants-familiar-cast-and-attack — cast with your commander out, its haste lets it attack at once and the trigger kills the defender's creature", () => {
    const ctx = pod('familiar-cast');
    spawn(ctx, 'P1', GENERAL).isCommander = true;
    const victim = spawn(ctx, 'P2', BEAR('Lab Victim'));
    const object = castFromHand(ctx, 'P1', card, [...red(2), ...generic(5)]);
    resolveTop(ctx);
    const familiar = ctx.state.battlefield.find((perm) => perm.cardId === object.cardId)!;
    expect(stats(ctx, familiar)).toMatchObject({ power: 7, toughness: 7, triggers: 1 });
    attack(ctx, familiar, 'P2');
    expect(onField(ctx, victim.cardId)).toBeUndefined();
    expect(ctx.state.players.find((p) => p.id === 'P2')!.graveyard.map((c) => c.name)).toContain(
      'Lab Victim',
    );
    expect(playerById(ctx, 'P2').life).toBe(33);
  });
});

// ---------------------------------------------------------------------------------------------
// PR06.16 Brash Taunter
// ---------------------------------------------------------------------------------------------

describe('Brash Taunter', () => {
  const { card } = pinned('Brash Taunter');
  const BRUTE = (name: string, power: string) =>
    oracle({ name, typeLine: 'Creature — Ogre', power, toughness: '9' });
  const LAB_BOLT = oracle({
    name: 'Lab Bolt',
    typeLine: 'Instant',
    manaCost: '{R}',
    oracleText: 'Lab Bolt deals 3 damage to any target.',
  });
  const FIGHT_COST = [...red(1), ...generic(2)];

  /** P1 controls the Taunter; every opponent controls a creature. */
  function board(seed: string) {
    const ctx = pod(seed);
    const taunter = spawn(ctx, 'P1', card);
    const brute = spawn(ctx, 'P2', BRUTE('Lab Brute', '3'));
    const wall = spawn(ctx, 'P3', BRUTE('Lab Wall', '0'));
    const ally = spawn(ctx, 'P1', BRUTE('Lab Ally', '2'));
    return { ctx, taunter, brute, wall, ally };
  }

  /** The Taunter's fight option, with mana in P1's pool to pay for it. */
  function fightOption(ctx: GameContext, taunter: EnginePermanent) {
    addMana(playerById(ctx, 'P1'), FIGHT_COST);
    return optionFor(ctx, 'P1', taunter.id, /fights/);
  }

  /** Activate the fight against `targetId` and resolve it, aiming the reflected damage at `aim`. */
  function fight(ctx: GameContext, taunter: EnginePermanent, targetId: string, aim: string) {
    const option = fightOption(ctx, taunter);
    expect(option, 'the fight is offered').toBeDefined();
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[option!.targets![0]!.slot, targetId]]),
    );
    return settle(ctx, aimAt(aim));
  }

  /** P1's combat: `attackers` maps each attacking creature id to its defender, `blocks` blocker to attacker. */
  function combat(
    ctx: GameContext,
    attackers: Record<string, string>,
    blocks: Record<string, string>,
    aim: string,
  ) {
    const offered: string[][] = [];
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId) => attackers[subjectId] ?? null);
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, (subjectId) => blocks[subjectId] ?? null);
      const slot = decision.options[0]?.targets?.[0];
      if (slot !== undefined) {
        offered.push(slot.options);
        return { index: 0, targets: new Map([[slot.slot, aim]]) };
      }
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    return offered;
  }

  /** Damage events that are not combat damage, oldest first. */
  const nonCombatDamage = (ctx: GameContext) =>
    damageEvents(ctx).filter((event) => event.payload['combat'] === false);

  it('brash-taunter-pinned-oracle-supported — the override reads the dealt-damage reflection and the another-target fight, beside the interpreted indestructible', () => {
    expectModeled(card);
    expect(getOverride(card.oracleId)?.unsupportedReason).toBeUndefined();
    expect(getOverride(fixtureOracleId(card.name))?.unsupportedReason).toBeUndefined();
    const def = interpretCard(card);
    expect(def.keywords).toContain('indestructible');
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toEqual({ when: 'dealtDamage', subject: { kind: 'self' } });
    expect(def.triggers[0]!.targets).toEqual([{ kind: 'player', controller: 'opponent' }]);
    // "that much damage": the amount dealt in the triggering event, dealt by the Taunter.
    expect(def.triggers[0]!.effects).toEqual([
      { op: 'dealDamage', target: 0, amount: { kind: 'damageDealt' } },
    ]);
    expect(def.activatedAbilities).toHaveLength(1);
    const [fightAbility] = def.activatedAbilities;
    expect(fightAbility!.ability.targets).toEqual([
      { kind: 'creature', filter: { kind: 'other' } },
    ]);
    expect(fightAbility!.ability.effects).toEqual([{ op: 'fight', first: 'source', second: 0 }]);
  });

  it('brash-taunter-indestructible — lethal damage marks but does not destroy it', () => {
    const { ctx, taunter, brute } = board('taunter-indestructible');
    fight(ctx, taunter, brute.id, 'P2');
    expect(hasKeyword(ctx, taunter, 'indestructible')).toBe(true);
    pump(priorityCheckpoint(ctx));
    // Dealt 3 damage with 1 toughness: still on the battlefield.
    expect(onField(ctx, taunter.cardId)?.damageMarked).toBe(3);
  });

  it("brash-taunter-fight-other-creature — the fight can target any creature but the Taunter itself, yours or an opponent's", () => {
    const { ctx, taunter, brute, wall, ally } = board('taunter-fight-targets');
    const option = fightOption(ctx, taunter);
    expect(option).toBeDefined();
    const legal = option!.targets!.flatMap((slot) => slot.options).sort();
    expect(legal).toEqual([ally.id, brute.id, wall.id].sort());
    expect(legal).not.toContain(taunter.id);

    // Costs {2}{R} and {T}: not offered without the mana, nor once tapped.
    const poor = board('taunter-fight-cost');
    addMana(playerById(poor.ctx, 'P1'), generic(3));
    expect(optionFor(poor.ctx, 'P1', poor.taunter.id, /fights/)).toBeUndefined();
    const tapped = board('taunter-fight-tapped');
    tapped.taunter.tapped = true;
    expect(fightOption(tapped.ctx, tapped.taunter)).toBeUndefined();

    // Fighting your own creature is legal too.
    const own = board('taunter-fight-own');
    fight(own.ctx, own.taunter, own.ally.id, 'P2');
    expect(onField(own.ctx, own.ally.cardId)?.damageMarked).toBe(1);
    expect(onField(own.ctx, own.taunter.cardId)?.damageMarked).toBe(2);
    expect(playerById(own.ctx, 'P2').life).toBe(38);
  });

  it('brash-taunter-fight-reflects-damage — fight damage dealt to it triggers the reflection for exactly that much, dealt by the Taunter to the chosen opponent only', () => {
    const { ctx, taunter, brute } = board('taunter-fight-reflect');
    fight(ctx, taunter, brute.id, 'P3');
    // The Brute deals 3 to the Taunter in the fight; the Taunter deals 1 to the Brute.
    expect(onField(ctx, brute.cardId)?.damageMarked).toBe(1);
    expect(playerById(ctx, 'P3').life).toBe(37);
    expect(playerById(ctx, 'P2').life).toBe(40);
    expect(playerById(ctx, 'P4').life).toBe(40);
    expect(playerById(ctx, 'P1').life).toBe(40);
    const reflected = damageEvents(ctx).find((event) => event.payload['target'] === 'P3');
    expect(reflected?.payload).toMatchObject({ controller: 'P1', amount: 3 });
    expect(String(reflected?.payload['source'])).toContain('Brash Taunter');
    expect(onField(ctx, taunter.cardId)?.tapped).toBe(true);
  });

  it('brash-taunter-spell-damage-amount — any damage to it counts, once per hit: a 3-damage spell reflects 3, and a second hit reflects its own amount', () => {
    const { ctx, taunter } = board('taunter-spell');
    const cast = (target: string) => {
      const object = conjure(ctx, 'P2', LAB_BOLT, 'hand');
      addMana(playerById(ctx, 'P2'), red(1));
      const option = optionFor(ctx, 'P2', object.id);
      expect(option).toBeDefined();
      takeAction(
        ctx,
        'P2',
        option!.payload as PriorityActionPayload,
        undefined,
        new Map([[option!.targets![0]!.slot, target]]),
      );
      return settle(ctx, aimAt('P2'));
    };
    cast(taunter.id);
    expect(onField(ctx, taunter.cardId)).toBeDefined();
    expect(playerById(ctx, 'P2').life).toBe(37);
    cast(taunter.id);
    expect(playerById(ctx, 'P2').life).toBe(34);
    expect(nonCombatDamage(ctx).filter((event) => event.payload['target'] === 'P2')).toHaveLength(
      2,
    );
  });

  it('brash-taunter-combat-damage-amount — combat damage dealt to it reflects exactly the damage dealt', () => {
    const { ctx, taunter } = board('taunter-combat');
    const blocker = spawn(ctx, 'P2', BRUTE('Lab Blocker', '4'));
    combat(ctx, { [taunter.id]: 'P2' }, { [blocker.id]: taunter.id }, 'P4');
    expect(onField(ctx, taunter.cardId)).toBeDefined();
    expect(playerById(ctx, 'P4').life).toBe(36);
    expect(playerById(ctx, 'P2').life).toBe(40);
  });

  it('brash-taunter-simultaneous-combat-damage — damage from two blockers in one step is one event: one trigger for the total, not one per blocker (CR 510.2, 603.2c)', () => {
    const { ctx, taunter } = board('taunter-double-block');
    const small = spawn(ctx, 'P2', BRUTE('Lab Small Blocker', '2'));
    const large = spawn(ctx, 'P2', BRUTE('Lab Large Blocker', '3'));
    const offered = combat(
      ctx,
      { [taunter.id]: 'P2' },
      { [small.id]: taunter.id, [large.id]: taunter.id },
      'P4',
    );
    expect(onField(ctx, taunter.cardId)?.damageMarked).toBe(5);
    // Exactly one reflection prompt and one hit of 5, not hits of 2 and 3.
    expect(offered).toHaveLength(1);
    const hits = damageEvents(ctx).filter((event) => event.payload['target'] === 'P4');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.payload).toMatchObject({ controller: 'P1', amount: 5 });
    expect(playerById(ctx, 'P4').life).toBe(35);
  });

  it('brash-taunter-target-opponent — the reflection can only be aimed at an opponent, never at you', () => {
    const { ctx, taunter, wall } = board('taunter-target-opponent');
    const offered = combat(ctx, { [taunter.id]: 'P2' }, { [wall.id]: taunter.id }, 'P2');
    // The Wall has no power, so nothing is dealt and nothing triggers.
    expect(offered).toEqual([]);

    const hit = board('taunter-target-opponent-hit');
    const blocker = spawn(hit.ctx, 'P2', BRUTE('Lab Blocker', '2'));
    const seen = combat(
      hit.ctx,
      { [hit.taunter.id]: 'P2' },
      { [blocker.id]: hit.taunter.id },
      'P3',
    );
    expect(seen).toHaveLength(1);
    expect([...seen[0]!].sort()).toEqual(['P2', 'P3', 'P4']);
    expect(playerById(hit.ctx, 'P3').life).toBe(38);
  });

  it('brash-taunter-no-damage-no-trigger — a fight with a 0-power creature deals it no damage, so nothing is reflected', () => {
    const { ctx, taunter, wall } = board('taunter-no-damage');
    const run = fight(ctx, taunter, wall.id, 'P2');
    expect(onField(ctx, wall.cardId)?.damageMarked).toBe(1);
    expect(onField(ctx, taunter.cardId)?.damageMarked).toBe(0);
    expect(run.decisions).toHaveLength(0);
    expect(damageEvents(ctx).every((event) => event.payload['target'] === 'Lab Wall')).toBe(true);
    for (const id of ['P1', 'P2', 'P3', 'P4']) expect(playerById(ctx, id).life).toBe(40);
  });
});

// ---------------------------------------------------------------------------------------------
// PR06.14 Tomb Blade
// ---------------------------------------------------------------------------------------------

describe('Tomb Blade', () => {
  const { card } = pinned('Tomb Blade');
  const FODDER = (name: string) =>
    oracle({ name, typeLine: 'Creature — Soldier', power: '1', toughness: '1' });

  /** P1 controls Tomb Blade; P2 controls `p2` creatures, P3 controls `p3`, P4 controls none. */
  function board(seed: string, p2: number, p3 = 2) {
    const ctx = pod(seed);
    const blade = spawn(ctx, 'P1', card);
    for (let i = 1; i <= p2; i++) spawn(ctx, 'P2', FODDER(`Lab Fodder P2-${i}`));
    for (let i = 1; i <= p3; i++) spawn(ctx, 'P3', FODDER(`Lab Fodder P3-${i}`));
    return { ctx, blade };
  }

  /**
   * P1's combat with Tomb Blade attacking `defender` (and `blocks` mapping a blocker id to the
   * Blade). The defender's sacrifice-or-lose prompt is recorded and answered with `answer`:
   * 'decline' loses the life, a creature name sacrifices that creature.
   */
  function swing(
    ctx: GameContext,
    blade: EnginePermanent,
    defender: string,
    answer: 'decline' | string,
    blocks: Record<string, string> = {},
  ) {
    const prompts: { player: string; options: string[] }[] = [];
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId) => (subjectId === blade.id ? defender : null));
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, (subjectId) => blocks[subjectId] ?? null);
      if (decision.options.some((option) => option.type === 'decline')) {
        prompts.push({
          player: decision.player,
          options: decision.options.map((option) => option.description),
        });
        const index = decision.options.findIndex((option) =>
          answer === 'decline' ? option.type === 'decline' : option.description.includes(answer),
        );
        return { index, targets: new Map() };
      }
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    return prompts;
  }

  const creaturesOf = (ctx: GameContext, playerId: string) =>
    ctx.state.battlefield.filter(
      (perm) => perm.controllerId === playerId && perm.typeLine.includes('Creature'),
    );

  it('tomb-blade-pinned-oracle-supported — the override reads the combat-damage trigger as an untargeted effect on the damaged player, beside the interpreted flying and unearth', () => {
    expectModeled(card);
    expect(getOverride(card.oracleId)?.unsupportedReason).toBeUndefined();
    expect(getOverride(fixtureOracleId(card.name))?.unsupportedReason).toBeUndefined();
    const def = interpretCard(card);
    expect(def.keywords).toContain('flying');
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toEqual({
      when: 'dealsCombatDamageToPlayer',
      subject: { kind: 'self' },
    });
    // "that player" is the damaged player, not a target.
    expect(def.triggers[0]!.targets).toEqual([]);
    expect(def.triggers[0]!.effects).toEqual([{ op: 'tombBladeHit', target: 'eventPlayer' }]);
    expect(def.activatedAbilities).toHaveLength(1);
  });

  it('tomb-blade-decline-loses-life — declining the sacrifice loses life equal to the number of creatures they control, and they keep every creature', () => {
    const { ctx, blade } = board('blade-decline', 3);
    const prompts = swing(ctx, blade, 'P2', 'decline');
    // The Blade's own 5 combat damage, then 3 more for three creatures.
    expect(playerById(ctx, 'P2').life).toBe(40 - 5 - 3);
    expect(creaturesOf(ctx, 'P2')).toHaveLength(3);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.player).toBe('P2');
    expect(prompts[0]!.options.some((option) => /Lose 3 life/.test(option))).toBe(true);
  });

  it('tomb-blade-sacrifice-instead — sacrificing a creature of their choice avoids the life loss, and only that one creature goes', () => {
    const { ctx, blade } = board('blade-sacrifice', 3);
    swing(ctx, blade, 'P2', 'Lab Fodder P2-2');
    expect(playerById(ctx, 'P2').life).toBe(40 - 5);
    expect(
      creaturesOf(ctx, 'P2')
        .map((perm) => perm.name)
        .sort(),
    ).toEqual(['Lab Fodder P2-1', 'Lab Fodder P2-3']);
    expect(playerById(ctx, 'P2').graveyard.map((object) => object.name)).toEqual([
      'Lab Fodder P2-2',
    ]);
  });

  it('tomb-blade-no-creatures — a player with no creatures cannot sacrifice and loses no life from the rider', () => {
    const { ctx, blade } = board('blade-none', 0);
    const prompts = swing(ctx, blade, 'P2', 'decline');
    expect(prompts).toEqual([]);
    expect(playerById(ctx, 'P2').life).toBe(40 - 5);
  });

  it('tomb-blade-damaged-player-only — only the player the Blade hit is affected: other opponents lose nothing and keep their creatures', () => {
    const { ctx, blade } = board('blade-multiplayer', 2, 4);
    const prompts = swing(ctx, blade, 'P3', 'decline');
    expect(playerById(ctx, 'P3').life).toBe(40 - 5 - 4);
    expect(playerById(ctx, 'P2').life).toBe(40);
    expect(playerById(ctx, 'P4').life).toBe(40);
    expect(creaturesOf(ctx, 'P2')).toHaveLength(2);
    expect(creaturesOf(ctx, 'P3')).toHaveLength(4);
    expect(prompts.map((prompt) => prompt.player)).toEqual(['P3']);
  });

  it('tomb-blade-count-at-resolution — the creature count is taken as the trigger resolves, including a creature that arrived since the damage was dealt', () => {
    const { ctx, blade } = board('blade-count', 2);
    // The defender's own trigger is put on the stack after (so resolves before) the Blade's.
    spawn(
      ctx,
      'P2',
      oracle({
        name: 'Lab Reactor',
        typeLine: 'Creature — Construct',
        oracleText:
          'Whenever a creature deals combat damage to a player, create a 1/1 white Soldier creature token.',
      }),
    );
    const prompts = swing(ctx, blade, 'P2', 'decline');
    // Two Fodder, the Reactor and the Soldier it made first: four creatures when the Blade's
    // trigger resolves.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.options.some((option) => /Lose 4 life/.test(option))).toBe(true);
    expect(playerById(ctx, 'P2').life).toBe(40 - 5 - 4);
  });

  it('tomb-blade-no-combat-damage — no trigger when the Blade is blocked by a creature that absorbs it, or deals no damage to a player', () => {
    const { ctx, blade } = board('blade-blocked', 2);
    const blocker = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Lab Flier Wall',
        typeLine: 'Creature — Wall',
        power: '0',
        toughness: '9',
        oracleText: 'Flying',
      }),
    );
    const prompts = swing(ctx, blade, 'P2', 'decline', { [blocker.id]: blade.id });
    expect(prompts).toEqual([]);
    expect(playerById(ctx, 'P2').life).toBe(40);
    expect(creaturesOf(ctx, 'P2')).toHaveLength(3);
  });

  it('tomb-blade-unearth — Unearth {6}{B}{B} is offered from the graveyard at sorcery speed and brings the Blade back with haste', () => {
    const ctx = pod('blade-unearth');
    const blade = conjure(ctx, 'P1', card, 'graveyard');
    expect(optionFor(ctx, 'P1', blade.id, /Unearth/)).toBeUndefined();
    addMana(playerById(ctx, 'P1'), [
      ...Array.from({ length: 2 }, () => ({ symbol: 'B' as const })),
      ...generic(6),
    ]);
    const option = optionFor(ctx, 'P1', blade.id, /Unearth/);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    resolveTop(ctx);
    const back = ctx.state.battlefield.find((perm) => perm.cardId === blade.cardId);
    expect(back).toBeDefined();
    expect(hasKeyword(ctx, back!, 'haste')).toBe(true);
    expect(hasKeyword(ctx, back!, 'flying')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Restoration gate
// ---------------------------------------------------------------------------------------------

interface RestoredCard {
  name: string;
  sha256: string;
  clauseCount: number;
  /** An authored override (not the interpreter alone) carries the card; it must be executable. */
  authored?: true;
}

const RESTORED: RestoredCard[] = [
  {
    name: 'Dragon Tempest',
    sha256: 'cb94ffadd9ec7da7b016f68309f21ef28565cd589b728d83d2c5d33f41f84e13',
    clauseCount: 2,
  },
  {
    name: 'Scourge of Valkas',
    sha256: 'b870fa6ef4866f453377d14c044c5ebdd8d5a336d798e8f6b63846df5bac377c',
    clauseCount: 3,
  },
  {
    name: "Tyrant's Familiar",
    sha256: 'c5d073e500e8090f478e0095df9dde5215600f5bcb347d0fbdbbe526b8c020c4',
    clauseCount: 3,
    authored: true,
  },
  {
    name: 'Brash Taunter',
    sha256: '811ca00fb845c5c1d6c5a9e1e67d6114c45a9af8f482ad5de6d04549f9dd130c',
    clauseCount: 3,
    authored: true,
  },
  {
    name: 'Tomb Blade',
    sha256: 'ff9a089b1474562a1dc75e86a4175fb3eaf92fffb089e5e1207ed1b2a90089cf',
    clauseCount: 3,
    authored: true,
  },
];

interface ManifestClause {
  id?: string;
  oracleText: string;
  implementation: string[];
  engineTestIds: string[];
  viewerScenarioIds: string[];
}

interface Manifest {
  cards: Record<
    string,
    {
      name: string;
      oracleSha256: string;
      implementationStatus: string;
      clauses: ManifestClause[];
      gameplayAiScenarioIds: string[];
    }
  >;
}

const repoFile = (path: string): string =>
  readFileSync(resolve(import.meta.dirname, '../../..', path), 'utf8');

describe('PR06 restoration gate', () => {
  const manifest = JSON.parse(
    repoFile('packages/server/fixtures/card-verification-manifest.json'),
  ) as Manifest;
  const engineSource = readFileSync(import.meta.filename, 'utf8');
  const viewerSource = [
    repoFile('packages/server/src/cards/card-test-scenarios.ts'),
    repoFile('apps/web/e2e/card-test-lab.spec.ts'),
  ].join('\n');

  it.each(RESTORED.map((card) => [card.name, card] as const))(
    '%s is pinned and modeled under its real id and fixture alias',
    (name, expected) => {
      const entry = pinned(name);
      expect(entry.sha256).toBe(expected.sha256);
      expect(createHash('sha256').update(canonical(entry.card)).digest('hex')).toBe(
        expected.sha256,
      );
      expectModeled(entry.card);
    },
  );

  it('leaves no registration behind for cards the audit records as interpreter-restored', () => {
    const audit = JSON.parse(repoFile('docs/plans/card-catalog-audit.json')) as {
      interpreterRestored?: { oracleId: string; name: string; restoredIn: string }[];
    };
    const ours = (audit.interpreterRestored ?? []).filter(
      (entry) => entry.restoredIn === 'coverage-pr06',
    );
    expect(ours.length).toBeGreaterThan(0);
    for (const entry of ours) {
      const restored = RESTORED.find((card) => card.name === entry.name);
      expect(restored, entry.name).toBeDefined();
      for (const id of [entry.oracleId, fixtureOracleId(entry.name)]) {
        // The fail-closed or placeholder registration is gone: nothing, or an executable override.
        const override = getOverride(id);
        if (restored?.authored === true) {
          expect(override?.unsupportedReason, entry.name).toBeUndefined();
          expect(override?.def, entry.name).not.toEqual({});
        } else expect(override, entry.name).toBeUndefined();
      }
      expect(interpretCard(pinned(entry.name).card).modeled, entry.name).toBe(true);
    }
  });

  it.each(RESTORED.map((card) => [card.name, card] as const))(
    '%s declares implemented-unreviewed clauses mapped to engine and viewer evidence',
    (name, expected) => {
      const entry = pinned(name);
      const declared = manifest.cards[entry.card.oracleId];
      expect(declared?.name).toBe(name);
      expect(declared?.oracleSha256).toBe(expected.sha256);
      expect(declared?.implementationStatus).toBe('implemented-unreviewed');
      expect(declared?.clauses).toHaveLength(expected.clauseCount);
      for (const clause of declared!.clauses) {
        expect(clause.id, `${name} clause id`).toBeTruthy();
        expect(entry.card.oracleText, `${name} clause text`).toContain(clause.oracleText);
        expect(clause.implementation, `${name} implementation`).not.toHaveLength(0);
        expect(clause.engineTestIds, `${name} engine tests`).not.toHaveLength(0);
        expect(clause.viewerScenarioIds, `${name} viewer scenarios`).not.toHaveLength(0);
        for (const id of clause.engineTestIds) expect(engineSource, id).toContain(`${id} —`);
        for (const id of clause.viewerScenarioIds) expect(viewerSource, id).toContain(id);
      }
    },
  );
});
