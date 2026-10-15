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
import { runCombatAndExtraCombats, runTurn } from '../src/turn/turn';
import { createGame } from '../src/state/game';
import { moveObject, playerById, queueTriggersForEvent } from '../src/state/objects';
import { effectivePT, hasKeyword } from '../src/state/queries';
import type { EnginePermanent, GameContext } from '../src/state/types';
import {
  conjure,
  copies,
  declareAttacks,
  declareBlocks,
  forest,
  gameConfig,
  island,
  mountain,
  oracle,
  plains,
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
// PR06.06 Duelist's Heritage
// ---------------------------------------------------------------------------------------------

describe("Duelist's Heritage", () => {
  const { card } = pinned("Duelist's Heritage");
  const FENCER = (name: string, power = '2') =>
    oracle({ name, typeLine: 'Creature — Human', power, toughness: '9' });

  /** P1 controls Duelist's Heritage; every player controls one idle creature besides attackers. */
  function board(seed: string, active: 'P1' | 'P2') {
    const ctx = pod(seed);
    ctx.state.currentTurnPlayer = active;
    ctx.state.activePlayerIndex = active === 'P1' ? 0 : 1;
    spawn(ctx, 'P1', card);
    const idle = {
      P1: spawn(ctx, 'P1', FENCER('Lab Idle P1')),
      P3: spawn(ctx, 'P3', FENCER('Lab Idle P3')),
    };
    return { ctx, idle };
  }

  /**
   * The active player's combat: `attackers` maps each attacker id to its defender. The trigger's
   * target prompt (object ids on offer) and "you may" prompt are recorded; the target is `aim`
   * (default: first on offer) and the optional grant is taken when `accept` is true.
   */
  function combat(
    ctx: GameContext,
    attackers: Record<string, string>,
    accept: boolean,
    aim?: string,
    phase: typeof runCombatAndExtraCombats = runCombatAndExtraCombats,
  ) {
    const targetPrompts: string[][] = [];
    const mayPrompts: string[] = [];
    pump(phase(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId) => attackers[subjectId] ?? null);
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      const slot = decision.options[0]?.targets?.[0];
      if (slot !== undefined) {
        targetPrompts.push(slot.options);
        return { index: 0, targets: new Map([[slot.slot, aim ?? slot.options[0]!]]) };
      }
      if (decision.options.some((option) => option.type === 'acceptTrigger')) {
        mayPrompts.push(decision.prompt);
        const wanted = accept ? 'acceptTrigger' : 'declineTrigger';
        return {
          index: decision.options.findIndex((option) => option.type === wanted),
          targets: new Map(),
        };
      }
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    return { targetPrompts, mayPrompts };
  }

  const keywordsOf = (ctx: GameContext, perm: EnginePermanent) =>
    computeCharacteristics(ctx, perm).keywords;

  it('duelists-heritage-pinned-oracle-supported — the override reads one aggregate attack trigger for any creature, with an optional grant to a target attacking creature', () => {
    expectModeled(card);
    expect(getOverride(card.oracleId)?.unsupportedReason).toBeUndefined();
    expect(getOverride(fixtureOracleId(card.name))?.unsupportedReason).toBeUndefined();
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(1);
    const [trigger] = def.triggers;
    // Any creature (not only yours), one firing per declaration.
    expect(trigger!.trigger).toEqual({
      when: 'attacks',
      subject: { kind: 'permanent', selector: { kind: 'type', value: 'Creature' } },
      aggregate: true,
    });
    expect(trigger!.optional).toBe(true);
    expect(trigger!.targets).toEqual([
      { kind: 'creature', filter: { kind: 'combatRole', role: 'attacking' } },
    ]);
    expect(trigger!.effects).toEqual([
      { op: 'grantKeywordUntilEot', target: 0, keyword: 'double strike' },
    ]);
  });

  it("duelists-heritage-one-trigger-per-attack — a declaration of several creatures triggers it exactly once, yours or an opponent's", () => {
    const own = board('heritage-own', 'P1');
    const a = spawn(own.ctx, 'P1', FENCER('Lab Attacker A'));
    const b = spawn(own.ctx, 'P1', FENCER('Lab Attacker B'));
    const mine = combat(own.ctx, { [a.id]: 'P2', [b.id]: 'P2' }, true);
    expect(mine.targetPrompts).toHaveLength(1);
    expect(mine.mayPrompts).toHaveLength(1);

    // An opponent's attack with two creatures: P1 (the Heritage's controller) still gets one trigger.
    const theirs = board('heritage-opponent', 'P2');
    const c = spawn(theirs.ctx, 'P2', FENCER('Lab Raider A'));
    const d = spawn(theirs.ctx, 'P2', FENCER('Lab Raider B'));
    const hostile = combat(theirs.ctx, { [c.id]: 'P3', [d.id]: 'P3' }, true);
    expect(hostile.targetPrompts).toHaveLength(1);
    expect(hostile.mayPrompts).toHaveLength(1);
    expect(hostile.mayPrompts[0]).toContain("Duelist's Heritage");

    // No attackers, no trigger.
    const quiet = board('heritage-quiet', 'P1');
    const none = combat(quiet.ctx, {}, true);
    expect(none.targetPrompts).toEqual([]);
    expect(none.mayPrompts).toEqual([]);
  });

  it('duelists-heritage-target-attacking — only attacking creatures are legal targets, whoever controls them, never a creature that stayed home', () => {
    const { ctx, idle } = board('heritage-targets', 'P2');
    const c = spawn(ctx, 'P2', FENCER('Lab Raider A'));
    const d = spawn(ctx, 'P2', FENCER('Lab Raider B'));
    spawn(ctx, 'P2', FENCER('Lab Raider At Home'));
    const run = combat(ctx, { [c.id]: 'P3', [d.id]: 'P3' }, true);
    expect([...run.targetPrompts[0]!].sort()).toEqual([c.id, d.id].sort());
    expect(run.targetPrompts[0]).not.toContain(idle.P1.id);
    expect(run.targetPrompts[0]).not.toContain(idle.P3.id);
  });

  it("duelists-heritage-opponent-attacker — the controller may target an opponent's attacker, which gains double strike and deals its damage twice", () => {
    const { ctx } = board('heritage-grant', 'P2');
    const c = spawn(ctx, 'P2', FENCER('Lab Raider A', '3'));
    const d = spawn(ctx, 'P2', FENCER('Lab Raider B', '3'));
    combat(ctx, { [c.id]: 'P3', [d.id]: 'P3' }, true, d.id);
    expect(keywordsOf(ctx, d)).toContain('double strike');
    expect(keywordsOf(ctx, c)).not.toContain('double strike');
    // 3 power twice from the double striker plus 3 once from the other: 9 damage to P3.
    expect(playerById(ctx, 'P3').life).toBe(40 - 9);
  });

  it('duelists-heritage-may-decline — declining the "you may" grants nothing, to the target or anyone else', () => {
    const { ctx } = board('heritage-decline', 'P1');
    const a = spawn(ctx, 'P1', FENCER('Lab Attacker A', '3'));
    const b = spawn(ctx, 'P1', FENCER('Lab Attacker B', '3'));
    const run = combat(ctx, { [a.id]: 'P2', [b.id]: 'P2' }, false, a.id);
    expect(run.targetPrompts).toHaveLength(1);
    expect(run.mayPrompts).toHaveLength(1);
    expect(keywordsOf(ctx, a)).not.toContain('double strike');
    expect(keywordsOf(ctx, b)).not.toContain('double strike');
    expect(playerById(ctx, 'P2').life).toBe(40 - 6);
  });

  it('duelists-heritage-until-end-of-turn — the double strike lasts only until end of turn', () => {
    const { ctx } = board('heritage-eot', 'P1');
    const a = spawn(ctx, 'P1', FENCER('Lab Attacker A', '3'));
    // A whole turn, through combat to the cleanup step.
    combat(ctx, { [a.id]: 'P2' }, true, undefined, runTurn);
    expect(playerById(ctx, 'P2').life).toBe(40 - 6);
    expect(keywordsOf(ctx, a)).not.toContain('double strike');
  });
});

// ---------------------------------------------------------------------------------------------
// PR06.12 Thunderbreak Regent
// ---------------------------------------------------------------------------------------------

describe('Thunderbreak Regent', () => {
  const { card } = pinned('Thunderbreak Regent');
  const LAB_BOLT = oracle({
    name: 'Lab Bolt',
    typeLine: 'Instant',
    manaCost: '{R}',
    oracleText: 'Lab Bolt deals 3 damage to any target.',
  });
  const PROD_TARGET = oracle({
    name: 'Lab Prodder',
    typeLine: 'Creature — Construct',
    oracleText: '{T}: Lab Prodder deals 1 damage to target creature.',
  });
  const SPARRING_DRAGON = oracle({
    name: 'Lab Sparring Dragon',
    typeLine: 'Creature — Dragon',
    power: '2',
    toughness: '9',
  });

  /** P1 controls the Regent (a Dragon) and another Dragon; P2 and P3 control creatures. */
  function board(seed: string) {
    const ctx = pod(seed);
    const regent = spawn(ctx, 'P1', card);
    const dragon = spawn(ctx, 'P1', SPARRING_DRAGON);
    const bear = spawn(ctx, 'P1', LAB_CARD('Lab Bear'));
    return { ctx, regent, dragon, bear };
  }

  /** `playerId` casts Lab Bolt at `targetId` and the whole stack settles. */
  function bolt(ctx: GameContext, playerId: string, targetId: string) {
    const object = conjure(ctx, playerId, LAB_BOLT, 'hand');
    addMana(playerById(ctx, playerId), red(1));
    const option = optionFor(ctx, playerId, object.id);
    expect(option, `${playerId} casts Lab Bolt`).toBeDefined();
    takeAction(
      ctx,
      playerId,
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[option!.targets![0]!.slot, targetId]]),
    );
    return settle(ctx);
  }

  /** Damage the Regent dealt (its own trigger), as opposed to the bolts and prods in the tests. */
  const regentHits = (ctx: GameContext) =>
    damageEvents(ctx).filter((event) => String(event.payload['source']).includes('Thunderbreak'));

  it('thunderbreak-regent-pinned-oracle-supported — the interpreter alone models the becomes-targeted trigger as damage to the event player', () => {
    expectNoRegistration(card);
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.keywords).toContain('flying');
    expect(def.triggers).toHaveLength(1);
    const [trigger] = def.triggers;
    // A Dragon you control, targeted by an opponent: the head is filtered to "an opponent controls".
    expect(trigger!.trigger).toEqual({
      when: 'becomesTargeted',
      subject: {
        kind: 'permanent',
        selector: {
          kind: 'allOf',
          of: [
            { kind: 'controller', who: 'you' },
            { kind: 'subtype', value: 'Dragon' },
          ],
        },
      },
    });
    expect(trigger!.targets).toEqual([]);
    expect(trigger!.effects).toEqual([
      { op: 'dealDamage', target: 'eventPlayer', amount: { kind: 'const', n: 3 } },
    ]);
  });

  it("thunderbreak-regent-opponent-spell — an opponent's spell targeting your Dragon deals 3 damage to that opponent only, from the Regent", () => {
    const { ctx, regent, dragon } = board('regent-spell');
    spawn(ctx, 'P3', LAB_CARD('Lab Bystander'));
    bolt(ctx, 'P2', dragon.id);
    expect(playerById(ctx, 'P2').life).toBe(37);
    expect(playerById(ctx, 'P3').life).toBe(40);
    expect(playerById(ctx, 'P4').life).toBe(40);
    expect(playerById(ctx, 'P1').life).toBe(40);
    const hit = damageEvents(ctx).find((event) => event.payload['target'] === 'P2');
    expect(hit?.payload).toMatchObject({
      amount: 3,
      controller: 'P1',
      sourceCardId: regent.cardId,
    });
    expect(String(hit?.payload['source'])).toContain('Thunderbreak Regent');
    // The bolt still resolves afterwards.
    expect(onField(ctx, dragon.cardId)?.damageMarked).toBe(3);

    // Multiplayer: a different opponent's spell reaches that opponent, not the first.
    const other = board('regent-spell-p3');
    bolt(other.ctx, 'P3', other.dragon.id);
    expect(playerById(other.ctx, 'P3').life).toBe(37);
    expect(playerById(other.ctx, 'P2').life).toBe(40);
  });

  it('thunderbreak-regent-opponent-ability — an activated ability an opponent controls counts too', () => {
    const { ctx, dragon } = board('regent-ability');
    const prodder = spawn(ctx, 'P2', PROD_TARGET);
    const option = optionFor(ctx, 'P2', prodder.id, /deals 1 damage/);
    expect(option).toBeDefined();
    takeAction(
      ctx,
      'P2',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[option!.targets![0]!.slot, dragon.id]]),
    );
    settle(ctx);
    expect(playerById(ctx, 'P2').life).toBe(37);
    expect(onField(ctx, dragon.cardId)?.damageMarked).toBe(1);
  });

  it('thunderbreak-regent-regent-itself — the Regent is a Dragon, so targeting it triggers it', () => {
    const { ctx, regent } = board('regent-itself');
    bolt(ctx, 'P2', regent.id);
    expect(playerById(ctx, 'P2').life).toBe(37);
    expect(onField(ctx, regent.cardId)?.damageMarked).toBe(3);
  });

  it("thunderbreak-regent-no-trigger — your own spell, a non-Dragon target, or an opponent's Dragon being targeted does nothing", () => {
    const own = board('regent-own');
    bolt(own.ctx, 'P1', own.dragon.id);
    expect(playerById(own.ctx, 'P1').life).toBe(40);
    expect(regentHits(own.ctx)).toEqual([]);

    const bear = board('regent-bear');
    bolt(bear.ctx, 'P2', bear.bear.id);
    expect(playerById(bear.ctx, 'P2').life).toBe(40);
    expect(regentHits(bear.ctx)).toEqual([]);

    const theirs = board('regent-their-dragon');
    const foreign = spawn(theirs.ctx, 'P3', SPARRING_DRAGON);
    bolt(theirs.ctx, 'P2', foreign.id);
    expect(playerById(theirs.ctx, 'P2').life).toBe(40);
    expect(playerById(theirs.ctx, 'P3').life).toBe(40);
  });

  it('thunderbreak-regent-targeting-player — a spell that targets a player rather than a Dragon does not trigger it', () => {
    const { ctx } = board('regent-player');
    bolt(ctx, 'P2', 'P1');
    expect(playerById(ctx, 'P2').life).toBe(40);
    expect(playerById(ctx, 'P1').life).toBe(37);
  });
});

// ---------------------------------------------------------------------------------------------
// PR06.25 Invisible Woman
// ---------------------------------------------------------------------------------------------

describe('Invisible Woman', () => {
  const { card } = pinned('Invisible Woman');
  const BRUISER = (name: string) =>
    oracle({ name, typeLine: 'Creature — Human', power: '2', toughness: '2' });
  const LAB_SPELL = oracle({
    name: 'Lab Trinket',
    typeLine: 'Artifact',
    manaCost: '{0}',
    power: null,
    toughness: null,
  });

  /** P1 controls Invisible Woman, the four basic lands that pay {R}{G}{W}{U}, and `extra` creatures. */
  function board(seed: string, extra: string[], lands = true) {
    const ctx = pod(seed);
    const woman = spawn(ctx, 'P1', card);
    const others = extra.map((name) => spawn(ctx, 'P1', BRUISER(name)));
    if (lands)
      for (const land of [mountain(), forest(), plains(), island()]) spawn(ctx, 'P1', land);
    return { ctx, woman, others };
  }

  /** Whether `perm` is the subject of a "can't be blocked" effect. */
  const unblockable = (ctx: GameContext, perm: EnginePermanent) =>
    ctx.state.effects.some(
      (effect) => effect.kind === 'cantBeBlocked' && effect.targetCardIds.includes(perm.cardId),
    );

  /**
   * P1's combat with `attackers` attacking P2. `pay` answers the "may pay" prompt and `aim` is the
   * reflexive trigger's target (an object id); blockers in `blockers` try to block `attackers[0]`
   * only if the declaration lets them. Records every prompt seen and the target ids on offer.
   */
  function combat(
    ctx: GameContext,
    attackers: EnginePermanent[],
    pay: boolean,
    aim?: string,
    blockers: EnginePermanent[] = [],
  ) {
    const prompts: string[] = [];
    const offered: string[][] = [];
    const blockable: string[][] = [];
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId) =>
          attackers.some((attacker) => attacker.id === subjectId) ? 'P2' : null,
        );
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, (subjectId, subject) => {
          if (!blockers.some((blocker) => blocker.id === subjectId)) return null;
          blockable.push(subject.attackers.map((candidate) => candidate.attackerId));
          const wanted = subject.attackers.find(
            (candidate) => candidate.attackerId === attackers[0]!.id,
          );
          return wanted === undefined ? null : wanted.attackerId;
        });
      const slot = decision.options[0]?.targets?.[0];
      if (slot !== undefined) {
        prompts.push(decision.prompt);
        offered.push(slot.options);
        return { index: 0, targets: new Map([[slot.slot, aim ?? slot.options[0]!]]) };
      }
      const payIndex = decision.options.findIndex((option) => /^Pay /.test(option.description));
      if (payIndex >= 0) {
        prompts.push(decision.prompt);
        const declineIndex = decision.options.findIndex((option) =>
          /^Don't pay$/.test(option.description),
        );
        return { index: pay ? payIndex : declineIndex, targets: new Map() };
      }
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    return { prompts, offered, blockable };
  }

  const payPrompts = (prompts: string[]) => prompts.filter((prompt) => /Pay it\?/.test(prompt));
  const targetPrompts = (prompts: string[]) =>
    prompts.filter((prompt) => /choose targets/i.test(prompt));

  it('invisible-woman-pinned-oracle-supported — the override adds the attack trigger beside the interpreted Wall trigger, with a paid reflexive pump-and-evade', () => {
    expectModeled(card);
    expect(getOverride(card.oracleId)?.unsupportedReason).toBeUndefined();
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(2);
    // The interpreted line: beginning of combat on your turn.
    expect(def.triggers[0]!.trigger).toMatchObject({ when: 'beginningOfCombat', player: 'you' });
    // "Whenever you attack": your creatures, one firing for the whole declaration.
    const attackTrigger = def.triggers[1]!;
    expect(attackTrigger.trigger).toEqual({
      when: 'attacks',
      subject: {
        kind: 'permanent',
        selector: {
          kind: 'allOf',
          of: [
            { kind: 'type', value: 'Creature' },
            { kind: 'controller', who: 'you' },
          ],
        },
      },
      aggregate: true,
    });
    expect(attackTrigger.targets).toEqual([]);
    const [pay] = attackTrigger.effects;
    expect(pay).toMatchObject({ op: 'mayPayManaThenReflexive' });
    const then = (pay as { then: Ability }).then;
    // The target is the reflexive trigger's own: any creature, chosen after payment.
    expect(then.targets).toEqual([{ kind: 'creature' }]);
    expect(then.effects).toEqual([
      {
        op: 'pumpUntilEot',
        target: 0,
        power: {
          kind: 'countPermanents',
          selector: { kind: 'type', value: 'Creature' },
          scope: 'you',
        },
        toughness: 0,
      },
      { op: 'cantBeBlockedUntilEot', target: 0 },
    ]);
  });

  it('invisible-woman-wall-token — the interpreted line still makes a 0/3 Wall at the beginning of combat after you cast a noncreature spell, and not otherwise', () => {
    const quiet = board('woman-wall-quiet', [], false);
    combat(quiet.ctx, [], false);
    expect(quiet.ctx.state.battlefield.filter((perm) => perm.name === 'Wall')).toEqual([]);

    const cast = board('woman-wall-cast', [], false);
    castFromHand(cast.ctx, 'P1', LAB_SPELL, []);
    resolveTop(cast.ctx);
    combat(cast.ctx, [], false);
    const walls = cast.ctx.state.battlefield.filter((perm) => perm.name === 'Wall');
    expect(walls).toHaveLength(1);
    expect(effectivePT(cast.ctx, walls[0]!)).toEqual({ power: 0, toughness: 3 });
    expect(hasKeyword(cast.ctx, walls[0]!, 'defender')).toBe(true);
    expect(hasKeyword(cast.ctx, walls[0]!, 'reach')).toBe(true);
  });

  it("invisible-woman-once-per-attack — attacking with several creatures asks for the payment once, and an opponent's attack never does", () => {
    const { ctx, woman, others } = board('woman-once', ['Lab Bruiser A', 'Lab Bruiser B']);
    const run = combat(ctx, [woman, ...others], false);
    expect(payPrompts(run.prompts)).toHaveLength(1);

    const theirs = board('woman-theirs', []);
    theirs.ctx.state.currentTurnPlayer = 'P2';
    theirs.ctx.state.activePlayerIndex = 1;
    const raider = spawn(theirs.ctx, 'P2', BRUISER('Lab Raider'));
    const answered: string[] = [];
    pump(runCombatAndExtraCombats(theirs.ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId) => (subjectId === raider.id ? 'P3' : null));
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      if (decision.options.some((option) => /^Pay /.test(option.description)))
        answered.push(decision.prompt);
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    expect(answered).toEqual([]);
  });

  it('invisible-woman-decline — declining the payment taps nothing and creates no reflexive trigger or target prompt', () => {
    const { ctx, woman } = board('woman-decline', ['Lab Bruiser A']);
    const run = combat(ctx, [woman], false);
    expect(payPrompts(run.prompts)).toHaveLength(1);
    expect(run.offered).toEqual([]);
    expect(effectivePT(ctx, woman)).toEqual({ power: 3, toughness: 3 });
    expect(unblockable(ctx, woman)).toBe(false);
    expect(
      ctx.state.battlefield.filter((perm) => perm.tapped && perm.typeLine.includes('Land')),
    ).toEqual([]);
  });

  it('invisible-woman-cannot-pay — without {R}{G}{W}{U} there is no payment prompt', () => {
    const { ctx, woman } = board('woman-broke', ['Lab Bruiser A'], false);
    for (const land of [mountain(), forest(), plains()]) spawn(ctx, 'P1', land);
    const run = combat(ctx, [woman], true);
    expect(payPrompts(run.prompts)).toEqual([]);
    expect(run.offered).toEqual([]);
  });

  it('invisible-woman-pay-then-target — paying puts the reflexive trigger on the stack, which then chooses any creature; it gets +1/+0 per creature you control and cannot be blocked', () => {
    const { ctx, woman, others } = board('woman-pay', ['Lab Bruiser A', 'Lab Bruiser B']);
    const enemy = spawn(ctx, 'P2', BRUISER('Lab Enemy'));
    const wall = spawn(
      ctx,
      'P2',
      oracle({ name: 'Lab Deep Wall', typeLine: 'Creature — Wall', power: '0', toughness: '9' }),
    );
    const target = others[0]!;
    const run = combat(ctx, [target], true, target.id, [wall]);
    // The payment is asked before the target; every creature is on offer, whoever controls it.
    expect(run.prompts.findIndex((prompt) => /Pay it\?/.test(prompt))).toBeLessThan(
      run.prompts.findIndex((prompt) => /choose targets/i.test(prompt)),
    );
    expect(targetPrompts(run.prompts)).toHaveLength(1);
    expect(run.offered[0]!.sort()).toEqual(
      [woman.id, ...others.map((perm) => perm.id), enemy.id, wall.id].sort(),
    );
    // Three creatures you control (the Woman and both Bruisers): +3/+0, toughness unchanged.
    expect(effectivePT(ctx, target)).toEqual({ power: 5, toughness: 2 });
    expect(unblockable(ctx, target)).toBe(true);
    // The four lands paid.
    expect(
      ctx.state.battlefield.filter((perm) => perm.tapped && perm.typeLine.includes('Land')),
    ).toHaveLength(4);
    // It was never blockable, so the Deep Wall's block was not even offered, and all of its power got through.
    expect(run.blockable.flat()).not.toContain(target.id);
    expect(playerById(ctx, 'P2').life).toBe(40 - 5);
  });

  it("invisible-woman-count-at-resolution — the number counts every creature you control as the reflexive trigger resolves, attacking or not, and an opponent's creature as target gets the boost too", () => {
    const { ctx, woman, others } = board('woman-count', [
      'Lab Bruiser A',
      'Lab Bruiser B',
      'Lab Bruiser C',
    ]);
    const enemy = spawn(ctx, 'P2', BRUISER('Lab Enemy'));
    // Only the Woman attacks, but all four creatures you control count: +4/+0 on the enemy.
    combat(ctx, [woman], true, enemy.id);
    expect(effectivePT(ctx, onField(ctx, enemy.cardId)!)).toEqual({ power: 6, toughness: 2 });
    expect(others.every((perm) => effectivePT(ctx, perm).power === 2)).toBe(true);
    expect(effectivePT(ctx, woman)).toEqual({ power: 3, toughness: 3 });
  });
});

// ---------------------------------------------------------------------------------------------
// PR06.07 Flameblast Dragon
// ---------------------------------------------------------------------------------------------

describe('Flameblast Dragon', () => {
  const { card } = pinned('Flameblast Dragon');
  /** A creature with protection from red, to show the damage is red and comes from the Dragon. */
  const RED_WARDEN = oracle({
    name: 'Lab Red Warden',
    typeLine: 'Creature — Knight',
    power: '1',
    toughness: '9',
    oracleText: 'Protection from red',
  });
  const VICTIM = oracle({
    name: 'Lab Victim',
    typeLine: 'Creature — Secret',
    power: '1',
    toughness: '9',
  });

  /** P1 controls Flameblast Dragon, `mountains` Mountains and `plainsCount` Plains; P2 controls a Victim. */
  function board(seed: string, mountains = 5, plainsCount = 0) {
    const ctx = pod(seed);
    const dragon = spawn(ctx, 'P1', card);
    const victim = spawn(ctx, 'P2', VICTIM);
    for (let i = 0; i < mountains; i++) spawn(ctx, 'P1', mountain());
    for (let i = 0; i < plainsCount; i++) spawn(ctx, 'P1', plains());
    return { ctx, dragon, victim };
  }

  const tappedLands = (ctx: GameContext) =>
    ctx.state.battlefield.filter((perm) => perm.tapped && perm.typeLine.includes('Land')).length;

  /** The Dragon attacks P2 as the declaration is made; its trigger waits to go on the stack. */
  function attack(ctx: GameContext, dragon: EnginePermanent) {
    dragon.attacking = 'P2';
    queueTriggersForEvent(ctx, 'attacks', [{ permanent: dragon, playerId: 'P1' }]);
  }

  /** What the payment prompt offered, and what the player answered with. */
  interface PaymentPrompt {
    prompt: string;
    options: string[];
  }

  /** Answer the "pay {X}{R}?" prompt with the option whose description matches `choice`. */
  function payment(choice: RegExp, seen: PaymentPrompt[] = []): Answer {
    return (decision) => {
      const index = decision.options.findIndex((option) => choice.test(option.description));
      seen.push({ prompt: decision.prompt, options: decision.options.map((o) => o.description) });
      expect(index, `${decision.prompt} offers ${choice}`).toBeGreaterThanOrEqual(0);
      return { index, targets: new Map() };
    };
  }

  /** Put the attack trigger on the stack aimed at `aim`, then resolve it answering the payment. */
  function triggerAndResolve(
    ctx: GameContext,
    dragon: EnginePermanent,
    aim: string,
    choice: RegExp,
  ) {
    attack(ctx, dragon);
    pump(priorityCheckpoint(ctx), aimAt(aim));
    expect(ctx.state.stack).toHaveLength(1);
    const seen: PaymentPrompt[] = [];
    resolveTop(ctx, payment(choice, seen));
    return seen;
  }

  const dragonHits = (ctx: GameContext) =>
    damageEvents(ctx).filter((event) => String(event.payload['source']).includes('Flameblast'));

  it('flameblast-dragon-pinned-oracle-supported — the override reads flying and an attack trigger that targets any target and then offers the {X}{R} payment', () => {
    expectModeled(card);
    expect(getOverride(card.oracleId)?.unsupportedReason).toBeUndefined();
    expect(getOverride(fixtureOracleId(card.name))?.unsupportedReason).toBeUndefined();
    const def = interpretCard(card);
    expect(def.keywords).toContain('flying');
    expect(def.triggers).toHaveLength(1);
    const [trigger] = def.triggers;
    // "Whenever this creature attacks": the Dragon itself, never another attacker.
    expect(trigger!.trigger).toEqual({ when: 'attacks', subject: { kind: 'self' } });
    // The ability targets, so the target is chosen when the trigger goes on the stack (CR 603.3d).
    expect(trigger!.targets).toEqual([{ kind: 'anyTarget' }]);
    expect(trigger!.effects).toHaveLength(1);
    expect(trigger!.effects[0]).toMatchObject({ op: 'mayPayXThenDealDamage', target: 0 });
  });

  it('flameblast-dragon-target-before-payment — the target is chosen when the trigger goes on the stack, before any payment prompt, and nothing is spent until it resolves', () => {
    const { ctx, dragon, victim } = board('flameblast-order');
    attack(ctx, dragon);
    const targetPrompts: string[][] = [];
    pump(priorityCheckpoint(ctx), (decision) => {
      const slot = decision.options[0]?.targets?.[0];
      expect(slot, 'only the target is asked when the trigger goes on the stack').toBeDefined();
      targetPrompts.push(slot!.options);
      return { index: 0, targets: new Map([[slot!.slot, victim.id]]) };
    });
    // Any target: every player and every creature (the Dragon included) is on offer.
    expect(targetPrompts).toHaveLength(1);
    expect([...targetPrompts[0]!].sort()).toEqual(
      ['P1', 'P2', 'P3', 'P4', dragon.id, victim.id].sort(),
    );
    expect(ctx.state.stack).toHaveLength(1);
    expect(tappedLands(ctx)).toBe(0);
    expect(damageEvents(ctx)).toEqual([]);

    // The payment prompt only appears when the trigger resolves, with the target already fixed.
    const seen: PaymentPrompt[] = [];
    resolveTop(ctx, payment(/^Pay X=2 /, seen));
    expect(seen).toHaveLength(1);
    expect(onField(ctx, victim.cardId)?.damageMarked).toBe(2);
  });

  it("flameblast-dragon-whole-game — a real attack declaration puts the trigger on the stack, asks for the target, then for the payment, and X damage reaches the chosen player alongside the Dragon's combat damage", () => {
    const { ctx, dragon } = board('flameblast-combat');
    const order: string[] = [];
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId) => (subjectId === dragon.id ? 'P2' : null));
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      const slot = decision.options[0]?.targets?.[0];
      if (slot !== undefined) {
        order.push('target');
        expect(tappedLands(ctx)).toBe(0);
        return { index: 0, targets: new Map([[slot.slot, 'P3']]) };
      }
      const pay = decision.options.findIndex((option) => option.description === 'Pay X=3 ({3}{R})');
      if (pay >= 0) {
        order.push('payment');
        expect(ctx.state.stack).toHaveLength(0);
        return { index: pay, targets: new Map() };
      }
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    expect(order).toEqual(['target', 'payment']);
    expect(playerById(ctx, 'P3').life).toBe(40 - 3);
    // The Dragon's 5 flying combat damage went to the defending player.
    expect(playerById(ctx, 'P2').life).toBe(40 - 5);
    expect(tappedLands(ctx)).toBe(4);
    expect(
      dragonHits(ctx).find((event) => event.payload['target'] === 'P3')?.payload,
    ).toMatchObject({
      amount: 3,
      controller: 'P1',
      sourceCardId: dragon.cardId,
    });
  });

  it('flameblast-dragon-decline — declining spends no mana and deals no damage, to the chosen target or anyone else', () => {
    const { ctx, dragon, victim } = board('flameblast-decline');
    const seen = triggerAndResolve(ctx, dragon, victim.id, /^Don't pay$/);
    expect(seen).toHaveLength(1);
    expect(tappedLands(ctx)).toBe(0);
    expect(damageEvents(ctx)).toEqual([]);
    expect(onField(ctx, victim.cardId)?.damageMarked).toBe(0);
    expect(ctx.state.stack).toEqual([]);
  });

  it('flameblast-dragon-pay-x — paying X = 3 spends {3}{R} and the Dragon deals exactly 3 damage to the chosen target, a creature or a player', () => {
    const creature = board('flameblast-pay-creature');
    const seen = triggerAndResolve(creature.ctx, creature.dragon, creature.victim.id, /^Pay X=3 /);
    expect(onField(creature.ctx, creature.victim.cardId)?.damageMarked).toBe(3);
    expect(tappedLands(creature.ctx)).toBe(4);
    // Declining, then X = 0 through the most the lands can pay for ({4}{R} with five lands).
    expect(seen[0]!.options).toEqual([
      "Don't pay",
      'Pay X=0 ({R})',
      'Pay X=1 ({1}{R})',
      'Pay X=2 ({2}{R})',
      'Pay X=3 ({3}{R})',
      'Pay X=4 ({4}{R})',
    ]);
    expect(dragonHits(creature.ctx)).toHaveLength(1);

    const player = board('flameblast-pay-player');
    triggerAndResolve(player.ctx, player.dragon, 'P4', /^Pay X=4 /);
    expect(playerById(player.ctx, 'P4').life).toBe(40 - 4);
    expect(playerById(player.ctx, 'P2').life).toBe(40);
    expect(tappedLands(player.ctx)).toBe(5);
  });

  it('flameblast-dragon-pay-zero — paying X = 0 is its own choice from declining: it spends {R} and deals 0 damage', () => {
    const { ctx, dragon, victim } = board('flameblast-zero');
    const seen = triggerAndResolve(ctx, dragon, victim.id, /^Pay X=0 \(\{R\}\)$/);
    expect(seen[0]!.options.slice(0, 2)).toEqual(["Don't pay", 'Pay X=0 ({R})']);
    expect(tappedLands(ctx)).toBe(1);
    expect(onField(ctx, victim.cardId)?.damageMarked).toBe(0);
    expect(playerById(ctx, 'P2').life).toBe(40);
    expect(ctx.state.stack).toEqual([]);
  });

  it('flameblast-dragon-affordability — X is limited by the mana available, and without red mana the payment is not offered at all', () => {
    const poor = board('flameblast-poor', 2);
    const seen = triggerAndResolve(poor.ctx, poor.dragon, 'P2', /^Pay X=1 /);
    expect(seen[0]!.options).toEqual(["Don't pay", 'Pay X=0 ({R})', 'Pay X=1 ({1}{R})']);
    expect(playerById(poor.ctx, 'P2').life).toBe(39);

    // Only Plains: {R} cannot be paid, so no prompt (and no damage) at all.
    const dry = board('flameblast-no-red', 0, 4);
    attack(dry.ctx, dry.dragon);
    pump(priorityCheckpoint(dry.ctx), aimAt('P2'));
    const prompts: string[] = [];
    resolveTop(dry.ctx, (decision) => {
      prompts.push(decision.prompt);
      return { index: 0, targets: new Map() };
    });
    expect(prompts).toEqual([]);
    expect(damageEvents(dry.ctx)).toEqual([]);
    expect(tappedLands(dry.ctx)).toBe(0);
  });

  it('flameblast-dragon-target-illegal — if the chosen target is gone as the trigger resolves, there is no payment prompt and nothing is spent', () => {
    const { ctx, dragon, victim } = board('flameblast-illegal');
    attack(ctx, dragon);
    pump(priorityCheckpoint(ctx), aimAt(victim.id));
    expect(ctx.state.stack).toHaveLength(1);
    pump(moveObject(ctx, onField(ctx, victim.cardId)!, { zone: 'graveyard' }));
    const prompts: string[] = [];
    resolveTop(ctx, (decision) => {
      prompts.push(decision.prompt);
      return { index: 0, targets: new Map() };
    });
    expect(prompts).toEqual([]);
    expect(tappedLands(ctx)).toBe(0);
    expect(damageEvents(ctx)).toEqual([]);
    expect(ctx.state.stack).toEqual([]);
  });

  it('flameblast-dragon-dragon-gone — the Dragon still deals the damage when it has left the battlefield by resolution, as a red source (CR 608.2h)', () => {
    const { ctx, dragon } = board('flameblast-lki');
    const warden = spawn(ctx, 'P2', RED_WARDEN);
    attack(ctx, dragon);
    pump(priorityCheckpoint(ctx), aimAt('P3'));
    pump(moveObject(ctx, onField(ctx, dragon.cardId)!, { zone: 'graveyard' }));
    expect(onField(ctx, dragon.cardId)).toBeUndefined();
    resolveTop(ctx, payment(/^Pay X=2 /));
    expect(playerById(ctx, 'P3').life).toBe(40 - 2);
    expect(dragonHits(ctx)[0]?.payload).toMatchObject({ amount: 2, controller: 'P1' });

    // The same red damage, from the Dragon on the battlefield, cannot hurt protection from red.
    const alive = board('flameblast-source-red');
    const guard = spawn(alive.ctx, 'P2', RED_WARDEN);
    triggerAndResolve(alive.ctx, alive.dragon, guard.id, /^Pay X=2 /);
    expect(onField(alive.ctx, guard.cardId)?.damageMarked).toBe(0);
    expect(onField(ctx, warden.cardId)?.damageMarked).toBe(0);
  });

  it('flameblast-dragon-only-itself — another creature attacking, or the Dragon staying home, offers nothing', () => {
    const { ctx, dragon } = board('flameblast-others');
    const other = spawn(ctx, 'P1', LAB_CARD('Lab Raider'));
    other.attacking = 'P2';
    queueTriggersForEvent(ctx, 'attacks', [{ permanent: other, playerId: 'P1' }]);
    expect(ctx.state.pendingTriggers).toEqual([]);
    const prompts: string[] = [];
    const run = pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId) => (subjectId === other.id ? 'P2' : null));
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      prompts.push(decision.prompt);
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    expect(run).toBeDefined();
    expect(prompts.filter((prompt) => /Flameblast/.test(prompt))).toEqual([]);
    expect(dragonHits(ctx)).toEqual([]);
    expect(tappedLands(ctx)).toBe(0);
    expect(onField(ctx, dragon.cardId)?.tapped).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// PR06.11 Territorial Aetherkite
// ---------------------------------------------------------------------------------------------

describe('Territorial Aetherkite', () => {
  const { card } = pinned('Territorial Aetherkite');
  const COST = [...red(2), ...generic(4)];
  const BIG = (name: string, controller = 'P2') =>
    oracle({
      name,
      typeLine: 'Creature — Secret',
      power: '1',
      toughness: '9',
      oracleText: controller,
    });
  const RED_WARDEN = oracle({
    name: 'Lab Red Warden',
    typeLine: 'Creature — Knight',
    power: '1',
    toughness: '9',
    oracleText: 'Protection from red',
  });

  /** The "pay energy?" prompt: what it offered, and the answer to give. */
  function pays(amount: number | 'none', seen: string[][] = []): Answer {
    return (decision) => {
      seen.push(decision.options.map((option) => option.description));
      const wanted = amount === 'none' ? 'Pay no energy' : `Pay ${amount} energy`;
      const index = decision.options.findIndex((option) => option.description === wanted);
      expect(index, `${decision.prompt} offers ${wanted}`).toBeGreaterThanOrEqual(0);
      return { index, targets: new Map() };
    };
  }

  /** P1 has `energy` energy and the Aetherkite enters; its enter trigger waits on the stack. */
  function entering(seed: string, energy: number) {
    const ctx = pod(seed);
    playerById(ctx, 'P1').energy = energy;
    const kite = enterFrom(ctx, 'P1', card);
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.stack).toHaveLength(1);
    return { ctx, kite };
  }

  const energyOf = (ctx: GameContext) => playerById(ctx, 'P1').energy;
  const kiteHits = (ctx: GameContext) =>
    damageEvents(ctx).filter((event) => String(event.payload['source']).includes('Aetherkite'));

  it('territorial-aetherkite-pinned-oracle-supported — the override reads flying, haste and an enter trigger that gets {E}{E} and then offers a reflexive payment of any amount of energy', () => {
    expectModeled(card);
    expect(getOverride(card.oracleId)?.unsupportedReason).toBeUndefined();
    expect(getOverride(fixtureOracleId(card.name))?.unsupportedReason).toBeUndefined();
    const def = interpretCard(card);
    expect(def.keywords).toEqual(expect.arrayContaining(['flying', 'haste']));
    expect(def.triggers).toHaveLength(1);
    const [trigger] = def.triggers;
    expect(trigger!.trigger).toEqual({ when: 'enters', subject: { kind: 'self' } });
    expect(trigger!.targets).toEqual([]);
    expect(trigger!.effects[0]).toEqual({ op: 'gainEnergy', amount: { kind: 'const', n: 2 } });
    const [, pay] = trigger!.effects;
    expect(pay).toMatchObject({ op: 'mayPayEnergyThenReflexive', min: 1 });
    // "That much damage to each other creature": the amount paid, every creature but this one.
    const then = (pay as { then: Ability }).then;
    expect(then.targets).toEqual([]);
    expect(then.effects).toEqual([
      {
        op: 'damageEach',
        selector: {
          kind: 'allOf',
          of: [{ kind: 'type', value: 'Creature' }, { kind: 'other' }],
        },
        amount: { kind: 'energyPaid' },
      },
    ]);
  });

  it('territorial-aetherkite-gain-energy — entering gets {E}{E} before the payment is asked, added to the energy you already had', () => {
    const { ctx } = entering('kite-gain', 1);
    const seen: string[][] = [];
    resolveTop(ctx, (decision, count) => {
      // The two energy are already gained when the payment is offered.
      expect(energyOf(ctx)).toBe(3);
      return pays('none', seen)(decision, count);
    });
    expect(seen).toEqual([['Pay no energy', 'Pay 1 energy', 'Pay 2 energy', 'Pay 3 energy']]);
    expect(energyOf(ctx)).toBe(3);
  });

  it('territorial-aetherkite-decline — paying no energy keeps all of it and creates no reflexive trigger or damage', () => {
    const { ctx, kite } = entering('kite-decline', 1);
    const enemy = spawn(ctx, 'P2', BIG('Lab Bystander'));
    resolveTop(ctx, pays('none'));
    expect(energyOf(ctx)).toBe(3);
    expect(ctx.state.pendingTriggers).toEqual([]);
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.stack).toEqual([]);
    expect(damageEvents(ctx)).toEqual([]);
    expect(onField(ctx, enemy.cardId)?.damageMarked).toBe(0);
    expect(onField(ctx, kite.cardId)?.damageMarked).toBe(0);
  });

  it('territorial-aetherkite-pay-any-amount — you may pay from one up to all the energy you have, not only the two just gained', () => {
    const rich = entering('kite-rich', 5);
    const seen: string[][] = [];
    resolveTop(rich.ctx, pays(6, seen));
    expect(seen[0]).toEqual([
      'Pay no energy',
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => `Pay ${n} energy`),
    ]);
    expect(energyOf(rich.ctx)).toBe(1);

    // Exactly the two gained: two payments are on offer, and paying both leaves nothing.
    const poor = entering('kite-poor', 0);
    const offered: string[][] = [];
    resolveTop(poor.ctx, pays(2, offered));
    expect(offered[0]).toEqual(['Pay no energy', 'Pay 1 energy', 'Pay 2 energy']);
    expect(energyOf(poor.ctx)).toBe(0);
  });

  it('territorial-aetherkite-reflexive-trigger — paying puts a separate trigger on the stack, so an opponent gets priority before any damage, and a creature that arrives in response is also damaged', () => {
    const { ctx, kite } = entering('kite-reflexive', 1);
    const early = spawn(ctx, 'P2', BIG('Lab Early'));
    resolveTop(ctx, pays(3));
    // The payment is made; nothing is damaged yet and the reflexive trigger is not on the stack.
    expect(energyOf(ctx)).toBe(0);
    expect(damageEvents(ctx)).toEqual([]);
    expect(ctx.state.stack).toEqual([]);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.stack).toHaveLength(1);
    const [entry] = ctx.state.stack;
    expect(entry!.controllerId).toBe('P1');
    expect(entry!.description).toContain('each other creature');
    expect(entry!.triggerScope?.energyPaid).toBe(3);
    expect(damageEvents(ctx)).toEqual([]);

    // An opponent's creature enters in response: the set of creatures is read as the trigger resolves.
    const late = enterFrom(ctx, 'P2', BIG('Lab Late'));
    resolveTop(ctx);
    expect(onField(ctx, early.cardId)?.damageMarked).toBe(3);
    expect(onField(ctx, late.cardId)?.damageMarked).toBe(3);
    // "Each OTHER creature": the Aetherkite takes nothing from its own trigger.
    expect(onField(ctx, kite.cardId)?.damageMarked).toBe(0);
    expect(ctx.state.stack).toEqual([]);
  });

  it('territorial-aetherkite-damage-amount — each other creature, yours included, takes exactly the amount paid from the Aetherkite, and small creatures die', () => {
    const { ctx, kite } = entering('kite-amount', 0);
    const own = spawn(ctx, 'P1', BIG('Lab Ally', 'P1'));
    const small = spawn(
      ctx,
      'P3',
      oracle({ name: 'Lab Mouse', typeLine: 'Creature — Mouse', power: '1', toughness: '1' }),
    );
    const enemy = spawn(ctx, 'P2', BIG('Lab Enemy'));
    resolveTop(ctx, pays(1));
    pump(priorityCheckpoint(ctx));
    resolveTop(ctx);
    expect(onField(ctx, own.cardId)?.damageMarked).toBe(1);
    expect(onField(ctx, enemy.cardId)?.damageMarked).toBe(1);
    // Lab Mouse is a 1/1: 1 damage kills it once state-based actions run.
    pump(priorityCheckpoint(ctx));
    expect(onField(ctx, small.cardId)).toBeUndefined();
    expect(onField(ctx, kite.cardId)?.damageMarked).toBe(0);
    expect(kiteHits(ctx)).toHaveLength(3);
    expect(kiteHits(ctx).every((event) => event.payload['amount'] === 1)).toBe(true);
    expect(playerById(ctx, 'P2').life).toBe(40);

    // Paying more deals more.
    const more = entering('kite-amount-2', 0);
    const target = spawn(more.ctx, 'P2', BIG('Lab Enemy'));
    resolveTop(more.ctx, pays(2));
    pump(priorityCheckpoint(more.ctx));
    resolveTop(more.ctx);
    expect(onField(more.ctx, target.cardId)?.damageMarked).toBe(2);
  });

  it('territorial-aetherkite-aetherkite-gone — the Aetherkite still deals the damage when it has left the battlefield by resolution, as a red source (CR 608.2h)', () => {
    const { ctx, kite } = entering('kite-lki', 0);
    const enemy = spawn(ctx, 'P2', BIG('Lab Enemy'));
    const guard = spawn(ctx, 'P2', RED_WARDEN);
    resolveTop(ctx, pays(2));
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.stack).toHaveLength(1);
    pump(moveObject(ctx, onField(ctx, kite.cardId)!, { zone: 'graveyard' }));
    expect(onField(ctx, kite.cardId)).toBeUndefined();
    resolveTop(ctx);
    expect(onField(ctx, enemy.cardId)?.damageMarked).toBe(2);
    // Red damage from the Aetherkite as it last existed: protection from red stops it.
    expect(onField(ctx, guard.cardId)?.damageMarked).toBe(0);
    expect(kiteHits(ctx)[0]?.payload).toMatchObject({ amount: 2, sourceCardId: kite.cardId });
  });

  it('territorial-aetherkite-whole-game — casting the Aetherkite through the stack gets {E}{E}, the payment is asked as the enter trigger resolves, and the reflexive trigger resolves after its own priority round', () => {
    const ctx = pod('kite-game');
    playerById(ctx, 'P1').energy = 1;
    const enemy = spawn(ctx, 'P2', BIG('Lab Enemy'));
    const other = spawn(ctx, 'P3', BIG('Lab Other', 'P3'));
    castFromHand(ctx, 'P1', card, COST);
    resolveTop(ctx);
    const kite = ctx.state.battlefield.find((perm) => perm.name === 'Territorial Aetherkite');
    expect(kite).toBeDefined();
    const prompts: string[] = [];
    settle(ctx, (decision, count) => {
      prompts.push(decision.prompt);
      return pays(3)(decision, count);
    });
    expect(prompts).toHaveLength(1);
    expect(energyOf(ctx)).toBe(0);
    expect(onField(ctx, enemy.cardId)?.damageMarked).toBe(3);
    expect(onField(ctx, other.cardId)?.damageMarked).toBe(3);
    expect(onField(ctx, kite!.cardId)?.damageMarked).toBe(0);
    expect(ctx.state.stack).toEqual([]);
    expect(kiteHits(ctx)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// PR06.01 Arcbond
// ---------------------------------------------------------------------------------------------

describe('Arcbond', () => {
  const { card } = pinned('Arcbond');
  const COST = [...red(1), ...generic(2)];
  const LAB_BOLT = oracle({
    name: 'Lab Bolt',
    typeLine: 'Instant',
    manaCost: '{R}',
    oracleText: 'Lab Bolt deals 3 damage to any target.',
  });
  const BRUTE = (name: string, power = '1', toughness = '9') =>
    oracle({ name, typeLine: 'Creature — Ogre', power, toughness });
  /** A blue 1/9 creature with lifelink. */
  const LEECH = oracle({
    name: 'Lab Leech',
    typeLine: 'Creature — Leech',
    colors: ['U'],
    power: '1',
    toughness: '9',
    oracleText: 'Lifelink',
  });
  /** A blue 1/3 creature with lifelink, small enough to die to a bolt. */
  const FRAIL_LEECH = oracle({
    name: 'Lab Frail Leech',
    typeLine: 'Creature — Leech',
    colors: ['U'],
    power: '1',
    toughness: '3',
    oracleText: 'Lifelink',
  });

  /** P1 controls the chosen creature `chosen`; P2 and P3 each control a creature. */
  function board(seed: string, chosenCard: OracleCard = BRUTE('Lab Chosen')) {
    const ctx = pod(seed);
    const chosen = spawn(ctx, 'P1', chosenCard);
    const ally = spawn(ctx, 'P1', BRUTE('Lab Ally'));
    const foe = spawn(ctx, 'P2', BRUTE('Lab Foe'));
    const far = spawn(ctx, 'P3', BRUTE('Lab Far'));
    return { ctx, chosen, ally, foe, far };
  }

  /** P1 casts Arcbond on `targetId` and it resolves. */
  function arcbond(ctx: GameContext, targetId: string) {
    const object = conjure(ctx, 'P1', card, 'hand');
    addMana(playerById(ctx, 'P1'), COST);
    const option = optionFor(ctx, 'P1', object.id);
    expect(option, 'P1 casts Arcbond').toBeDefined();
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[option!.targets![0]!.slot, targetId]]),
    );
    return settle(ctx);
  }

  /** `playerId` bolts `targetId`, and the whole stack (including the Arcbond trigger) settles. */
  function bolt(ctx: GameContext, targetId: string, playerId = 'P2') {
    const object = conjure(ctx, playerId, LAB_BOLT, 'hand');
    addMana(playerById(ctx, playerId), red(1));
    const option = optionFor(ctx, playerId, object.id);
    expect(option, `${playerId} casts Lab Bolt`).toBeDefined();
    takeAction(
      ctx,
      playerId,
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[option!.targets![0]!.slot, targetId]]),
    );
    return settle(ctx);
  }

  const life = (ctx: GameContext, id: string) => playerById(ctx, id).life;

  it('arcbond-pinned-oracle-supported — the override registers a this-turn delayed trigger on the chosen creature that has the creature deal the damage dealt to each other creature and each player', () => {
    expectModeled(card);
    expect(getOverride(card.oracleId)?.unsupportedReason).toBeUndefined();
    expect(getOverride(fixtureOracleId(card.name))?.unsupportedReason).toBeUndefined();
    const def = interpretCard(card);
    const spell = def.spellAbility!;
    expect(spell.targets).toEqual([{ kind: 'creature' }]);
    expect(spell.effects).toHaveLength(1);
    const [register] = spell.effects;
    expect(register).toMatchObject({
      op: 'registerDelayedTrigger',
      when: 'dealtDamage',
      target: 0,
      expiry: 'cleanup',
    });
    expect((register as { ability: Ability }).ability.effects).toEqual([
      {
        op: 'damageEach',
        selector: { kind: 'type', value: 'Creature' },
        amount: { kind: 'damageDealt' },
        source: 'triggerObject',
        exceptSource: true,
      },
      { op: 'damageEachPlayer', amount: { kind: 'damageDealt' }, source: 'triggerObject' },
    ]);
  });

  it('arcbond-damage-everything — a creature dealt 3 deals 3 to every other creature and every player, its controller included, and nothing more to itself', () => {
    const { ctx, chosen, ally, foe, far } = board('arcbond-all');
    arcbond(ctx, chosen.id);
    expect(ctx.state.delayedTriggers).toHaveLength(1);
    bolt(ctx, chosen.id);
    // The bolt's own 3 is all the chosen creature took.
    expect(onField(ctx, chosen.cardId)?.damageMarked).toBe(3);
    for (const other of [ally, foe, far]) expect(onField(ctx, other.cardId)?.damageMarked).toBe(3);
    for (const id of ['P1', 'P2', 'P3', 'P4']) expect(life(ctx, id), id).toBe(37);
    const reflected = damageEvents(ctx).filter((event) => event.payload['amount'] === 3);
    // Three creatures and four players, plus the bolt itself.
    expect(reflected).toHaveLength(8);
    expect(ctx.state.stack).toEqual([]);
  });

  it('arcbond-source-is-creature — the creature is the source: its lifelink gains its controller the total dealt, and protection from its color stops the damage', () => {
    const { ctx, chosen, foe } = board('arcbond-source', LEECH);
    const warden = spawn(ctx, 'P3', WARDEN);
    arcbond(ctx, chosen.id);
    bolt(ctx, chosen.id);
    // Ally, Foe and Far take 3 each, and so do the four players; the Warden's share is prevented.
    expect(onField(ctx, warden.cardId)?.damageMarked).toBe(0);
    expect(onField(ctx, foe.cardId)?.damageMarked).toBe(3);
    // Seven shares of 3 gain 21 life, and P1 itself takes 3.
    expect(life(ctx, 'P1')).toBe(40 - 3 + 21);
    for (const id of ['P2', 'P3', 'P4']) expect(life(ctx, id), id).toBe(37);
    expect(
      damageEvents(ctx).some((event) => String(event.payload['source']).includes('Arcbond')),
    ).toBe(false);
  });

  it('arcbond-creature-died — a creature killed by the damage still deals it, with last known information (lifelink)', () => {
    const { ctx, chosen, ally, foe } = board('arcbond-lki', FRAIL_LEECH);
    arcbond(ctx, chosen.id);
    bolt(ctx, chosen.id);
    expect(onField(ctx, chosen.cardId)).toBeUndefined();
    for (const other of [ally, foe]) expect(onField(ctx, other.cardId)?.damageMarked).toBe(3);
    for (const id of ['P2', 'P3', 'P4']) expect(life(ctx, id), id).toBe(37);
    // Three other creatures and four players: 21 from the dead creature's lifelink, P1 takes 3.
    expect(life(ctx, 'P1')).toBe(40 - 3 + 3 * 3 + 3 * 4);
    // It does not retrigger: no further damage is dealt to the creature or by it twice.
    expect(ctx.state.delayedTriggers.length).toBeLessThanOrEqual(1);
  });

  it('arcbond-each-time — every time the creature is dealt damage this turn triggers again, for that amount', () => {
    const { ctx, chosen, foe } = board('arcbond-twice');
    arcbond(ctx, chosen.id);
    bolt(ctx, chosen.id);
    bolt(ctx, chosen.id);
    expect(onField(ctx, foe.cardId)?.damageMarked).toBe(6);
    for (const id of ['P2', 'P3', 'P4']) expect(life(ctx, id), id).toBe(34);
    expect(life(ctx, 'P1')).toBe(34);
  });

  it('arcbond-this-turn-only — damage dealt to the creature on a later turn does nothing', () => {
    const { ctx, chosen, foe } = board('arcbond-expiry');
    arcbond(ctx, chosen.id);
    pump(runTurn(ctx));
    expect(ctx.state.delayedTriggers).toEqual([]);
    const before = damageEvents(ctx).length;
    bolt(ctx, chosen.id);
    expect(damageEvents(ctx).length).toBe(before + 1);
    expect(onField(ctx, foe.cardId)?.damageMarked).toBe(0);
    for (const id of ['P1', 'P3', 'P4']) expect(life(ctx, id), id).toBe(40);
  });

  it('arcbond-blinked — a creature that left and came back is a new object and is no longer tracked (CR 400.7)', () => {
    const { ctx, chosen, foe } = board('arcbond-blink');
    arcbond(ctx, chosen.id);
    pump(moveObject(ctx, onField(ctx, chosen.cardId)!, { zone: 'exile' }));
    const exiled = ctx.state.exile.find((object) => object.cardId === chosen.cardId)!;
    pump(moveObject(ctx, exiled, { zone: 'battlefield', controllerId: 'P1' }));
    const returned = onField(ctx, chosen.cardId)!;
    expect(returned.id).not.toBe(chosen.id);
    bolt(ctx, returned.id);
    expect(onField(ctx, returned.cardId)?.damageMarked).toBe(3);
    expect(onField(ctx, foe.cardId)?.damageMarked).toBe(0);
    for (const id of ['P1', 'P3', 'P4']) expect(life(ctx, id), id).toBe(40);
  });

  it('arcbond-target-gone — if the chosen creature is gone as Arcbond resolves, nothing is set up', () => {
    const { ctx, chosen } = board('arcbond-gone');
    const object = conjure(ctx, 'P1', card, 'hand');
    addMana(playerById(ctx, 'P1'), COST);
    const option = optionFor(ctx, 'P1', object.id)!;
    takeAction(
      ctx,
      'P1',
      option.payload as PriorityActionPayload,
      undefined,
      new Map([[option.targets![0]!.slot, chosen.id]]),
    );
    pump(moveObject(ctx, onField(ctx, chosen.cardId)!, { zone: 'graveyard' }));
    resolveTop(ctx);
    expect(ctx.state.delayedTriggers).toEqual([]);
  });

  it('arcbond-combat-damage-once — damage from two blockers in one combat damage step is one event: one trigger for the total, not one per blocker', () => {
    const { ctx, chosen, ally, foe } = board('arcbond-double-block', BRUTE('Lab Chosen', '1', '9'));
    const small = spawn(ctx, 'P2', BRUTE('Lab Small Blocker', '2'));
    const large = spawn(ctx, 'P2', BRUTE('Lab Large Blocker', '3'));
    arcbond(ctx, chosen.id);
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId) => (subjectId === chosen.id ? 'P2' : null));
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, (subjectId) =>
          subjectId === small.id || subjectId === large.id ? chosen.id : null,
        );
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    // 2 + 3 = 5 combat damage to the chosen creature, then ONE reflection of 5.
    expect(onField(ctx, chosen.cardId)?.damageMarked).toBe(5);
    expect(onField(ctx, ally.cardId)?.damageMarked).toBe(5);
    expect(onField(ctx, foe.cardId)?.damageMarked).toBe(5);
    expect(life(ctx, 'P3')).toBe(35);
    expect(life(ctx, 'P4')).toBe(35);
    expect(life(ctx, 'P1')).toBe(35);
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
  {
    name: "Duelist's Heritage",
    sha256: '908b2f6e15d136d51dd920e704ec04d5f396d1af17eada7bb6afe7f346439f6d',
    clauseCount: 1,
    authored: true,
  },
  {
    name: 'Thunderbreak Regent',
    sha256: '474f43d9d886bf106e263b10dd214cd579f62aa9dcd1e0e47df42c69b5a14657',
    clauseCount: 2,
  },
  {
    name: 'Invisible Woman',
    sha256: 'e669176870f40516af34d6c86e4ece9afc834da055d65e93f0331026408ddd2c',
    clauseCount: 2,
    authored: true,
  },
  {
    name: 'Flameblast Dragon',
    sha256: '0e43fcdddaf97a13d2c8c714da6e70accf69f025681541279f217f29b9327663',
    clauseCount: 2,
    authored: true,
  },
  {
    name: 'Arcbond',
    sha256: 'c9f9a7fd462c5e9860928053ebcbc0d98b77f2fe5342f50eef740c4aa7fd24c3',
    clauseCount: 1,
    authored: true,
  },
  {
    name: 'Territorial Aetherkite',
    sha256: '3106859a80bb17a69b816832c0e8eb6d49655fb09979542f8aee58130180f893',
    clauseCount: 2,
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
