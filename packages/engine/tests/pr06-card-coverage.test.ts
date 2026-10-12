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
import { priorityCheckpoint } from '../src/sba/sba';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { createGame } from '../src/state/game';
import { moveObject, playerById } from '../src/state/objects';
import { effectivePT, hasKeyword } from '../src/state/queries';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

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
// Restoration gate
// ---------------------------------------------------------------------------------------------

interface RestoredCard {
  name: string;
  sha256: string;
  clauseCount: number;
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
      expect(getOverride(entry.oracleId), entry.name).toBeUndefined();
      expect(
        RESTORED.map((card) => card.name),
        entry.name,
      ).toContain(entry.name);
      expect(getOverride(fixtureOracleId(entry.name)), `${entry.name} alias`).toBeUndefined();
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
