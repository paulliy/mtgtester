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
import type { CardDefinition } from '../src/cards/definition';
import { interpretCard } from '../src/cards/interpret';
import { ofType } from '../src/cards/selector';
import { dealDamageToCreature, dealDamageToPlayer, permanentSource } from '../src/effects/resolve';
import { fixtureOracleId, getOverride } from '../src/cards/overrides';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { addMana } from '../src/mana/pool';
import type { Ability } from '../src/cards/ability';
import { computeCharacteristics } from '../src/effects/continuous';
import { priorityCheckpoint } from '../src/sba/sba';
import { GameOverSignal } from '../src/signals';
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
  declareNoAttacks,
  forest,
  gameConfig,
  island,
  mountain,
  oracle,
  pick,
  plains,
  pump,
  registerCustomDef,
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
// PR06.13 Thundermaw Hellkite
// ---------------------------------------------------------------------------------------------

describe('Thundermaw Hellkite', () => {
  const { card } = pinned('Thundermaw Hellkite');
  const COST = [...red(2), ...generic(3)];
  const flier = (name: string, extra = '') =>
    oracle({
      name,
      typeLine: 'Creature — Bird',
      power: '1',
      toughness: '3',
      oracleText: `Flying${extra}`,
    });
  const GROUNDED = oracle({
    name: 'Lab Grounded',
    typeLine: 'Creature — Ogre',
    power: '1',
    toughness: '3',
  });

  /** P1 controls an own flier and a grounded creature; P2 and P3 control fliers and a grounded one. */
  function board(seed: string) {
    const ctx = pod(seed);
    const mine = spawn(ctx, 'P1', flier('Lab Own Flier'));
    const foeFlier = spawn(ctx, 'P2', flier('Lab Foe Flier'));
    const farFlier = spawn(ctx, 'P3', flier('Lab Far Flier'));
    const foeGround = spawn(ctx, 'P2', GROUNDED);
    return { ctx, mine, foeFlier, farFlier, foeGround };
  }

  const hits = (ctx: GameContext) =>
    damageEvents(ctx).filter((event) => String(event.payload['source']).includes('Thundermaw'));
  const marked = (ctx: GameContext, perm: EnginePermanent) =>
    onField(ctx, perm.cardId)?.damageMarked;
  const tapped = (ctx: GameContext, perm: EnginePermanent) => onField(ctx, perm.cardId)?.tapped;

  it('thundermaw-hellkite-pinned-oracle-supported — the override reads flying, haste and an enter trigger that damages and then taps the same opposing-fliers selector', () => {
    expectModeled(card);
    expect(getOverride(card.oracleId)?.unsupportedReason).toBeUndefined();
    expect(getOverride(fixtureOracleId(card.name))?.unsupportedReason).toBeUndefined();
    const def = interpretCard(card);
    expect(def.keywords).toEqual(expect.arrayContaining(['flying', 'haste']));
    expect(def.triggers).toHaveLength(1);
    const [trigger] = def.triggers;
    expect(trigger!.trigger).toEqual({ when: 'enters', subject: { kind: 'self' } });
    expect(trigger!.targets).toEqual([]);
    const selector = {
      kind: 'allOf',
      of: [
        { kind: 'type', value: 'Creature' },
        { kind: 'controller', who: 'opponents' },
        { kind: 'hasKeyword', keyword: 'flying' },
      ],
    };
    expect(trigger!.effects).toEqual([
      { op: 'damageEach', selector, amount: { kind: 'const', n: 1 } },
      { op: 'tapEach', selector },
    ]);
  });

  it('thundermaw-hellkite-damage-and-tap — each flier your opponents control takes 1 and is tapped; your own fliers and their non-fliers are untouched', () => {
    const { ctx, mine, foeFlier, farFlier, foeGround } = board('thundermaw-basic');
    enterFrom(ctx, 'P1', card);
    settle(ctx);
    for (const perm of [foeFlier, farFlier]) {
      expect(marked(ctx, perm), perm.name).toBe(1);
      expect(tapped(ctx, perm), perm.name).toBe(true);
    }
    for (const perm of [mine, foeGround]) {
      expect(marked(ctx, perm), perm.name).toBe(0);
      expect(tapped(ctx, perm), perm.name).toBe(false);
    }
    expect(hits(ctx)).toHaveLength(2);
    expect(hits(ctx).every((event) => event.payload['amount'] === 1)).toBe(true);
    expect(ctx.state.stack).toEqual([]);
  });

  it('thundermaw-hellkite-source — Thundermaw is the damage source, so protection from red stops the damage but the flier is still tapped (Gatherer ruling 2017-11-17)', () => {
    const { ctx, foeFlier } = board('thundermaw-protection');
    const guard = spawn(ctx, 'P3', flier('Lab Red Guard', '\nProtection from red'));
    enterFrom(ctx, 'P1', card);
    settle(ctx);
    expect(marked(ctx, guard)).toBe(0);
    expect(tapped(ctx, guard)).toBe(true);
    expect(marked(ctx, foeFlier)).toBe(1);
    expect(tapped(ctx, foeFlier)).toBe(true);
    expect(hits(ctx).map((event) => event.payload['targetCardId'])).not.toContain(guard.cardId);
  });

  it('thundermaw-hellkite-tap-not-damage-bound — a flier that dies to the damage or was already tapped causes no trouble, and an untapped survivor stays tapped', () => {
    const { ctx, foeFlier } = board('thundermaw-dies');
    const frail = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Lab Frail Flier',
        typeLine: 'Creature — Bird',
        power: '1',
        toughness: '1',
        oracleText: 'Flying',
      }),
    );
    const sleepy = spawn(ctx, 'P3', flier('Lab Sleepy Flier'), { tapped: true });
    enterFrom(ctx, 'P1', card);
    settle(ctx);
    expect(onField(ctx, frail.cardId)).toBeUndefined();
    expect(tapped(ctx, sleepy)).toBe(true);
    expect(marked(ctx, sleepy)).toBe(1);
    expect(tapped(ctx, foeFlier)).toBe(true);
  });

  it('thundermaw-hellkite-set-at-resolution — the fliers are those your opponents control as the trigger resolves, including one that arrived in response and excluding one that left', () => {
    const { ctx, foeFlier } = board('thundermaw-resolution');
    enterFrom(ctx, 'P1', card);
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.stack).toHaveLength(1);
    const late = enterFrom(ctx, 'P2', flier('Lab Late Flier'));
    pump(moveObject(ctx, onField(ctx, foeFlier.cardId)!, { zone: 'graveyard' }));
    resolveTop(ctx);
    expect(marked(ctx, late)).toBe(1);
    expect(tapped(ctx, late)).toBe(true);
  });

  it('thundermaw-hellkite-hellkite-gone — Thundermaw still deals the damage and taps when it left the battlefield before the trigger resolved', () => {
    const { ctx, foeFlier } = board('thundermaw-lki');
    const kite = enterFrom(ctx, 'P1', card);
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.stack).toHaveLength(1);
    pump(moveObject(ctx, onField(ctx, kite.cardId)!, { zone: 'graveyard' }));
    resolveTop(ctx);
    expect(marked(ctx, foeFlier)).toBe(1);
    expect(tapped(ctx, foeFlier)).toBe(true);
    expect(hits(ctx)).toHaveLength(2);
  });

  it('thundermaw-hellkite-whole-game — casting it through the stack, the enter trigger resolves after its own priority round, and it can attack at once with haste', () => {
    const { ctx, mine, foeFlier } = board('thundermaw-game');
    castFromHand(ctx, 'P1', card, COST);
    resolveTop(ctx);
    const kite = ctx.state.battlefield.find((perm) => perm.name === 'Thundermaw Hellkite');
    expect(kite).toBeDefined();
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    settle(ctx);
    expect(marked(ctx, foeFlier)).toBe(1);
    expect(tapped(ctx, foeFlier)).toBe(true);
    expect(marked(ctx, mine)).toBe(0);
    expect(hasKeyword(ctx, kite!, 'haste')).toBe(true);
    expect(hasKeyword(ctx, kite!, 'flying')).toBe(true);
    expect(ctx.state.stack).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// PR06.02 Backlash
// ---------------------------------------------------------------------------------------------

describe('Backlash', () => {
  const { card } = pinned('Backlash');
  const COST = [{ symbol: 'B' as const }, { symbol: 'R' as const }, ...generic(1)];
  const BRUTE = (name: string, power = '3', text = '') =>
    oracle({ name, typeLine: 'Creature — Ogre', power, toughness: '9', oracleText: text });

  /** P2 controls `target`, P3 a bystander; P1 casts Backlash. */
  function board(seed: string, targetCard: OracleCard = BRUTE('Lab Target')) {
    const ctx = pod(seed);
    const target = spawn(ctx, 'P2', targetCard);
    const bystander = spawn(ctx, 'P3', BRUTE('Lab Bystander'));
    return { ctx, target, bystander };
  }

  /** P1 casts Backlash at `targetId` and leaves it on the stack. */
  function cast(ctx: GameContext, targetId: string) {
    const object = conjure(ctx, 'P1', card, 'hand');
    addMana(playerById(ctx, 'P1'), COST);
    const option = optionFor(ctx, 'P1', object.id);
    expect(option, 'P1 casts Backlash').toBeDefined();
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[option!.targets![0]!.slot, targetId]]),
    );
    return { object, option: option! };
  }

  const life = (ctx: GameContext, id: string) => playerById(ctx, id).life;

  it('backlash-pinned-oracle-supported — the override targets an untapped creature, taps it, and has that creature deal damage equal to its power to its controller', () => {
    expectModeled(card);
    expect(getOverride(card.oracleId)?.unsupportedReason).toBeUndefined();
    expect(getOverride(fixtureOracleId(card.name))?.unsupportedReason).toBeUndefined();
    const def = interpretCard(card);
    expect(def.spellAbility!.targets).toEqual([{ kind: 'creature', tapState: 'untapped' }]);
    expect(def.spellAbility!.effects).toEqual([
      { op: 'tapTarget', target: 0 },
      {
        op: 'dealDamage',
        target: { controllerOf: 0 },
        source: 0,
        amount: { kind: 'powerOfTarget', target: 0 },
      },
    ]);
  });

  it('backlash-untapped-only — a tapped creature is not a legal target, and with only tapped creatures Backlash cannot be cast', () => {
    const { ctx, target, bystander } = board('backlash-untapped');
    onField(ctx, bystander.cardId)!.tapped = true;
    const object = conjure(ctx, 'P1', card, 'hand');
    addMana(playerById(ctx, 'P1'), COST);
    const option = optionFor(ctx, 'P1', object.id);
    expect(option).toBeDefined();
    const offered = option!.targets![0]!.options;
    expect(offered).toContain(target.id);
    expect(offered).not.toContain(bystander.id);

    onField(ctx, target.cardId)!.tapped = true;
    expect(optionFor(ctx, 'P1', object.id)).toBeUndefined();
  });

  it('backlash-tapped-in-response — a target that became tapped is illegal on resolution, so Backlash does nothing and deals no damage', () => {
    const { ctx, target } = board('backlash-response');
    const { object } = cast(ctx, target.id);
    onField(ctx, target.cardId)!.tapped = true;
    resolveTop(ctx);
    expect(damageEvents(ctx)).toEqual([]);
    expect(life(ctx, 'P2')).toBe(40);
    expect(ctx.state.stack).toEqual([]);
    expect(playerById(ctx, 'P1').graveyard.some((c) => c.cardId === object.cardId)).toBe(true);
  });

  it('backlash-tap-and-damage — it taps the creature, which deals damage equal to its power to its controller, and to no one else', () => {
    const { ctx, target, bystander } = board('backlash-basic');
    cast(ctx, target.id);
    resolveTop(ctx);
    expect(onField(ctx, target.cardId)?.tapped).toBe(true);
    expect(life(ctx, 'P2')).toBe(37);
    for (const id of ['P1', 'P3', 'P4']) expect(life(ctx, id), id).toBe(40);
    expect(onField(ctx, bystander.cardId)?.tapped).toBe(false);
    expect(damageEvents(ctx)).toHaveLength(1);
    expect(ctx.state.stack).toEqual([]);
  });

  it('backlash-source-is-creature — the creature deals the damage: lifelink gains its controller the life back, and infect gives poison instead of life loss', () => {
    const lifelink = board('backlash-lifelink', BRUTE('Lab Leech', '3', 'Lifelink'));
    cast(lifelink.ctx, lifelink.target.id);
    resolveTop(lifelink.ctx);
    expect(life(lifelink.ctx, 'P2')).toBe(40);
    expect(life(lifelink.ctx, 'P1')).toBe(40);
    expect(String(damageEvents(lifelink.ctx)[0]?.payload['source'])).toContain('Lab Leech');

    const infect = board('backlash-infect', BRUTE('Lab Plaguer', '3', 'Infect'));
    cast(infect.ctx, infect.target.id);
    resolveTop(infect.ctx);
    expect(life(infect.ctx, 'P2')).toBe(40);
    expect(playerById(infect.ctx, 'P2').poisonCounters).toBe(3);
  });

  it("backlash-power-at-resolution — the damage is the creature's power as Backlash resolves, after it was changed in response", () => {
    const { ctx, target } = board('backlash-power');
    cast(ctx, target.id);
    onField(ctx, target.cardId)!.counters['+1/+1'] = 2;
    resolveTop(ctx);
    expect(life(ctx, 'P2')).toBe(35);
  });

  it('backlash-controller-at-resolution — the player who controls the creature as Backlash resolves takes the damage, and your own creature hurts you', () => {
    const { ctx, target } = board('backlash-control');
    cast(ctx, target.id);
    onField(ctx, target.cardId)!.controllerId = 'P3';
    resolveTop(ctx);
    expect(life(ctx, 'P3')).toBe(37);
    expect(life(ctx, 'P2')).toBe(40);

    const own = pod('backlash-own');
    const mine = spawn(own, 'P1', BRUTE('Lab Mine', '2'));
    cast(own, mine.id);
    resolveTop(own);
    expect(life(own, 'P1')).toBe(38);
    expect(onField(own, mine.cardId)?.tapped).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// PR06.24 Guard Gomazoa, and the damage modifier pipeline it introduces
// ---------------------------------------------------------------------------------------------

describe('Guard Gomazoa', () => {
  const { card } = pinned('Guard Gomazoa');
  const LAB_BOLT = oracle({
    name: 'Lab Bolt',
    typeLine: 'Instant',
    manaCost: '{R}',
    colors: ['R'],
    oracleText: 'Lab Bolt deals 3 damage to any target.',
  });
  const OX = (name = 'Lab Ox', text = '') =>
    oracle({ name, typeLine: 'Creature — Ox', power: '4', toughness: '4', oracleText: text });
  const WALL = oracle({
    name: 'Lab Wall',
    typeLine: 'Creature — Wall',
    power: '0',
    toughness: '5',
  });
  const HUMILITY = oracle({
    oracleId: 'lab-humility',
    name: 'Lab Humility',
    typeLine: 'Enchantment',
    manaCost: '{2}{W}',
    power: null,
    toughness: null,
  });
  /** "Creatures lose all abilities" (Humility style), for the ability-loss check. */
  const humilityDef = (): CardDefinition => ({
    oracleId: 'lab-humility',
    name: 'Lab Humility',
    typeLine: 'Enchantment',
    supertypes: [],
    types: ['Enchantment'],
    subtypes: [],
    colors: [],
    colorIdentity: [],
    manaCost: null,
    hasUnsupportedCost: false,
    power: null,
    toughness: null,
    loyalty: null,
    defense: null,
    keywords: [],
    manaAbilities: [],
    activatedAbilities: [],
    entersTapped: false,
    spellAbility: null,
    triggers: [],
    staticEffects: [{ affects: ofType('Creature'), op: { layer: 6, loseAllAbilities: true } }],
    ruleStatics: [],
    modeled: true,
    unmodeledReasons: [],
  });
  const gisela = oracle({
    oracleId: '66f9f325-5e8e-4ebf-b5b3-c6410d80f2c5',
    name: 'Gisela, Blade of Goldnight',
    typeLine: 'Legendary Creature — Angel',
    supertypes: ['Legendary'],
    manaCost: '{4}{R}{W}{W}',
    colors: ['R', 'W'],
    colorIdentity: ['R', 'W'],
    power: '5',
    toughness: '5',
    oracleText:
      'If a source would deal damage to an opponent or a permanent an opponent controls, that source deals double that damage to that player or permanent instead.\n' +
      'If a source would deal damage to you or a permanent you control, prevent half that damage, rounded up.',
  });
  const neriv = oracle({
    name: 'Neriv, Heart of the Storm',
    typeLine: 'Legendary Creature — Spirit Dragon',
    supertypes: ['Legendary'],
    manaCost: '{1}{R}{W}{B}',
    colors: ['B', 'R', 'W'],
    colorIdentity: ['B', 'R', 'W'],
    power: '4',
    toughness: '5',
    oracleText:
      'Flying\nIf a creature you control that entered this turn would deal damage, it deals ' +
      'twice that much damage instead.',
  });
  const INKLING = {
    name: 'Inkling',
    typeLine: 'Creature — Inkling',
    types: ['Creature' as const],
    subtypes: ['Inkling'],
    colors: ['W' as const, 'B' as const],
    power: 2,
    toughness: 1,
    keywords: ['flying' as const],
  };

  const life = (ctx: GameContext, id: string) => playerById(ctx, id).life;
  const preventedEvents = (ctx: GameContext) =>
    ctx.state.eventLog.filter((event) => event.type === 'damagePrevented');

  /** P1 attacks P2 with `attackers`; P2 blocks as `blocks` says (blocker id to attacker id). */
  function combat(ctx: GameContext, attackers: string[], blocks: Record<string, string>) {
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId) =>
          attackers.includes(subjectId) ? 'P2' : null,
        );
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, (subjectId) => blocks[subjectId] ?? null);
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
  }

  /** P1 casts Lab Bolt at `targetId` and the stack settles; `answer` gets any other decision. */
  function bolt(ctx: GameContext, targetId: string, answer?: Answer) {
    const object = conjure(ctx, 'P1', LAB_BOLT, 'hand');
    addMana(playerById(ctx, 'P1'), red(1));
    const option = optionFor(ctx, 'P1', object.id);
    expect(option, 'P1 casts Lab Bolt').toBeDefined();
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[option!.targets![0]!.slot, targetId]]),
    );
    return settle(ctx, answer);
  }

  it('guard-gomazoa-pinned-oracle-supported — the interpreter alone reads defender, flying and the combat damage prevention static', () => {
    expectNoRegistration(card);
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.keywords).toEqual(expect.arrayContaining(['defender', 'flying']));
    expect(def.ruleStatics).toEqual([{ kind: 'preventCombatDamageToSelf' }]);
    expect(def.triggers).toEqual([]);
  });

  it('guard-gomazoa-combat-prevented — it takes no combat damage when it blocks, in the first-strike step and again in the regular step, while a creature beside it takes damage', () => {
    const ctx = pod('gomazoa-block');
    const gomazoa = spawn(ctx, 'P2', card);
    const wall = spawn(ctx, 'P2', WALL);
    const ox = spawn(ctx, 'P1', OX());
    const striker = spawn(ctx, 'P1', OX('Lab Double Striker', 'Double strike'));
    combat(ctx, [ox.id, striker.id], { [gomazoa.id]: striker.id, [wall.id]: ox.id });
    // Gomazoa blocked a 4/4 double striker (8 damage over two steps): none was marked, so it lives.
    expect(onField(ctx, gomazoa.cardId)).toBeDefined();
    expect(onField(ctx, gomazoa.cardId)!.damageMarked).toBe(0);
    // The ordinary Wall beside it is not protected.
    expect(onField(ctx, wall.cardId)!.damageMarked).toBe(4);
    // The attacker it blocked still takes Gomazoa's own 1 damage.
    expect(onField(ctx, striker.cardId)!.damageMarked).toBe(1);
    const hits = preventedEvents(ctx).filter(
      (event) => event.payload['target'] === 'Guard Gomazoa',
    );
    expect(hits.map((event) => event.payload['amount'])).toEqual([4, 4]);
    expect(hits.every((event) => event.payload['reason'] === 'preventCombatDamageToSelf')).toBe(
      true,
    );
    expect(life(ctx, 'P2')).toBe(40);
  });

  it('guard-gomazoa-combat-prevented — deathtouch combat damage to it is prevented as well, so it does not die', () => {
    const ctx = pod('gomazoa-deathtouch');
    const gomazoa = spawn(ctx, 'P2', card);
    const ox = spawn(ctx, 'P1', OX('Lab Venomous Ox', 'Deathtouch'));
    combat(ctx, [ox.id], { [gomazoa.id]: ox.id });
    expect(onField(ctx, gomazoa.cardId)).toBeDefined();
    expect(onField(ctx, gomazoa.cardId)!.damagedByDeathtouch).toBe(false);
  });

  it('guard-gomazoa-noncombat-damage — a spell that deals noncombat damage to it still does, through the stack, and 3 damage destroys it', () => {
    const ctx = pod('gomazoa-bolt');
    const gomazoa = spawn(ctx, 'P2', card);
    bolt(ctx, gomazoa.id);
    expect(onField(ctx, gomazoa.cardId)).toBeUndefined();
    expect(playerById(ctx, 'P2').graveyard.some((c) => c.cardId === gomazoa.cardId)).toBe(true);
    expect(preventedEvents(ctx)).toEqual([]);
  });

  it('guard-gomazoa-loses-abilities — the prevention is an ability of the creature, so it stops while the creature has lost all abilities', () => {
    const lost = pod('gomazoa-humility');
    registerCustomDef(lost, humilityDef());
    spawn(lost, 'P2', HUMILITY);
    const gomazoa = spawn(lost, 'P2', card);
    const ox = spawn(lost, 'P1', OX());
    combat(lost, [ox.id], { [gomazoa.id]: ox.id });
    // Without its abilities the 3-toughness creature takes the 4 combat damage and dies.
    expect(onField(lost, gomazoa.cardId)).toBeUndefined();
    expect(preventedEvents(lost)).toEqual([]);

    // Control: the same combat without the enchantment deals it no damage.
    const kept = pod('gomazoa-humility-absent');
    const fresh = spawn(kept, 'P2', card);
    const attacker = spawn(kept, 'P1', OX());
    combat(kept, [attacker.id], { [fresh.id]: attacker.id });
    expect(onField(kept, fresh.cardId)!.damageMarked).toBe(0);
  });

  it('damage-modifiers-order-choice — two replacements that change the outcome ask the damaged player, and each order gives its own amount', () => {
    const play = (pickText: RegExp) => {
      const ctx = pod(`order-${pickText.source}`);
      spawn(ctx, 'P1', gisela);
      spawn(ctx, 'P2', gisela);
      const asked: PendingDecision[] = [];
      bolt(ctx, 'P2', (decision) => {
        asked.push(decision);
        return {
          index: decision.options.findIndex((o) => pickText.test(o.description)),
          targets: new Map(),
        };
      });
      return { ctx, asked };
    };
    // P2 takes 3: halved first it is 1, then doubled to 2; doubled first it is 6, then halved to 3.
    const halveFirst = play(/prevent half/);
    expect(halveFirst.asked).toHaveLength(1);
    expect(halveFirst.asked[0]!.player).toBe('P2');
    expect(halveFirst.asked[0]!.decisionType).toBe('general');
    expect(halveFirst.asked[0]!.prompt).toContain('3 damage from Lab Bolt to P2');
    expect(halveFirst.asked[0]!.options).toHaveLength(2);
    expect(life(halveFirst.ctx, 'P2')).toBe(38);
    const doubleFirst = play(/double/);
    expect(doubleFirst.asked).toHaveLength(1);
    expect(life(doubleFirst.ctx, 'P2')).toBe(37);
  });

  it('damage-modifiers-order-choice — a choice that cannot change the outcome is not asked: even damage, two doublers, a doubler and a plain prevention, and two plain preventions', () => {
    // 4 damage: halved then doubled is 4 and doubled then halved is 4, so there is nothing to choose.
    const even = pod('order-even');
    spawn(even, 'P1', gisela);
    spawn(even, 'P2', gisela);
    const evenHit = pump(
      dealDamageToPlayer(
        even,
        permanentSource(spawn(even, 'P3', OX())),
        playerById(even, 'P2'),
        4,
        {
          combat: false,
          sourceIsCommander: false,
          sourceHasLifelink: false,
        },
      ),
    );
    expect(evenHit.decisions).toEqual([]);
    expect(life(even, 'P2')).toBe(36);

    // Neriv and Gisela both double, so the order never matters.
    const doublers = pod('order-doublers');
    spawn(doublers, 'P1', neriv);
    spawn(doublers, 'P1', gisela);
    const newcomer = spawn(doublers, 'P1', OX());
    const doublerHit = pump(
      dealDamageToPlayer(doublers, permanentSource(newcomer), playerById(doublers, 'P2'), 3, {
        combat: false,
        sourceIsCommander: false,
        sourceHasLifelink: false,
      }),
    );
    expect(doublerHit.decisions).toEqual([]);
    expect(life(doublers, 'P2')).toBe(28);

    // A doubler and Gomazoa's plain prevention: the damage is prevented whichever applies first.
    const mixed = pod('order-mixed');
    spawn(mixed, 'P1', neriv);
    const gomazoa = spawn(mixed, 'P2', card);
    const mixedHit = pump(
      dealDamageToCreature(mixed, permanentSource(spawn(mixed, 'P1', OX())), gomazoa, 3, {
        combat: true,
        sourceHasDeathtouch: false,
        sourceHasLifelink: false,
      }),
    );
    expect(mixedHit.decisions).toEqual([]);
    expect(onField(mixed, gomazoa.cardId)!.damageMarked).toBe(0);

    // Two plain prevent-alls, Gomazoa's static and a Fog-style shield: one applies, nothing is
    // asked, and the other drops out because there is nothing left to prevent.
    const plain = pod('order-plain');
    const shielded = spawn(plain, 'P2', card);
    plain.state.combatDamagePrevention.all = true;
    const plainHit = pump(
      dealDamageToCreature(plain, permanentSource(spawn(plain, 'P1', OX())), shielded, 3, {
        combat: true,
        sourceHasDeathtouch: false,
        sourceHasLifelink: false,
      }),
    );
    expect(plainHit.decisions).toEqual([]);
    expect(preventedEvents(plain)).toHaveLength(1);
    expect(onField(plain, shielded.cardId)!.damageMarked).toBe(0);
  });

  it('damage-modifiers-order-choice — a prevention with a follow-up counts as a different outcome: a token shield and a halving ask the player, and each order creates its own tokens', () => {
    const play = (pickText: RegExp) => {
      const ctx = pod(`order-tokens-${pickText.source}`);
      spawn(ctx, 'P2', gisela);
      ctx.state.combatDamagePrevention = {
        all: false,
        players: { P2: true },
        tokenSpecs: { P2: INKLING },
      };
      const attacker = spawn(ctx, 'P1', OX('Lab Attacker'));
      const { decisions } = pump(
        dealDamageToPlayer(ctx, permanentSource(attacker), playerById(ctx, 'P2'), 3, {
          combat: true,
          sourceIsCommander: false,
          sourceHasLifelink: false,
        }),
        (decision) => ({
          index: decision.options.findIndex((o) => pickText.test(o.description)),
          targets: new Map(),
        }),
      );
      const tokens = ctx.state.battlefield.filter((p) => p.name === 'Inkling').length;
      return { decisions, tokens, ctx };
    };
    // Shield first prevents all 3 and makes 3 tokens; halving first leaves 1, which the shield prevents.
    const shieldFirst = play(/Prevent all combat damage/);
    expect(shieldFirst.decisions).toHaveLength(1);
    expect(shieldFirst.tokens).toBe(3);
    expect(life(shieldFirst.ctx, 'P2')).toBe(40);
    const halveFirst = play(/prevent half/);
    expect(halveFirst.decisions).toHaveLength(1);
    expect(halveFirst.tokens).toBe(1);
    expect(life(halveFirst.ctx, 'P2')).toBe(40);
  });
});

// ---------------------------------------------------------------------------------------------
// PR06.20 Selfless Squire
// ---------------------------------------------------------------------------------------------

describe('Selfless Squire', () => {
  const { card } = pinned('Selfless Squire');
  const COST = [{ symbol: 'W' as const }, ...generic(3)];
  const LAB_BOLT = oracle({
    name: 'Lab Bolt',
    typeLine: 'Instant',
    manaCost: '{R}',
    colors: ['R'],
    oracleText: 'Lab Bolt deals 3 damage to any target.',
  });
  const BRUTE = (name: string, power: string) =>
    oracle({ name, typeLine: 'Creature — Ogre', power, toughness: '9' });
  const gisela = oracle({
    oracleId: '66f9f325-5e8e-4ebf-b5b3-c6410d80f2c5',
    name: 'Gisela, Blade of Goldnight',
    typeLine: 'Legendary Creature — Angel',
    supertypes: ['Legendary'],
    manaCost: '{4}{R}{W}{W}',
    colors: ['R', 'W'],
    colorIdentity: ['R', 'W'],
    power: '5',
    toughness: '5',
    oracleText:
      'If a source would deal damage to an opponent or a permanent an opponent controls, that source deals double that damage to that player or permanent instead.\n' +
      'If a source would deal damage to you or a permanent you control, prevent half that damage, rounded up.',
  });
  const life = (ctx: GameContext, id: string) => playerById(ctx, id).life;
  const counters = (ctx: GameContext, perm: EnginePermanent) =>
    onField(ctx, perm.cardId)!.counters['+1/+1'] ?? 0;

  /** P1 casts the Squire (Flash) and the stack settles, so its enter trigger has resolved. */
  function castSquire(ctx: GameContext) {
    const object = castFromHand(ctx, 'P1', card, COST);
    settle(ctx);
    return onField(ctx, object.cardId)!;
  }

  /** `playerId` casts Lab Bolt at `targetId` and the stack settles; `answer` gets other decisions. */
  function bolt(ctx: GameContext, playerId: string, targetId: string, answer?: Answer) {
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
    return settle(ctx, answer);
  }

  /** P2's turn: each creature in `attackers` attacks P1, who does not block. */
  function attackP1(ctx: GameContext, attackers: string[], answer?: Answer) {
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    pump(runCombatAndExtraCombats(ctx), (decision, count) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId) =>
          attackers.includes(subjectId) ? 'P1' : null,
        );
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      if (pass >= 0) return { index: pass, targets: new Map() };
      return answer?.(decision, count) ?? { index: 0, targets: new Map() };
    });
  }

  it('selfless-squire-pinned-oracle-supported — the override reads flash, an enter trigger that makes a damage shield, and a prevented-damage trigger that counts the prevented amount on this creature', () => {
    expectModeled(card);
    expect(getOverride(card.oracleId)?.unsupportedReason).toBeUndefined();
    expect(getOverride(fixtureOracleId(card.name))?.unsupportedReason).toBeUndefined();
    const def = interpretCard(card);
    expect(def.keywords).toContain('flash');
    expect(def.triggers.map((t) => t.trigger)).toEqual([
      { when: 'enters', subject: { kind: 'self' } },
      { when: 'damagePreventedToPlayer', player: 'you' },
    ]);
    expect(def.triggers[0]!.effects).toEqual([{ op: 'createDamageShield', player: 'you' }]);
    expect(def.triggers[1]!.effects).toEqual([
      { op: 'putCounters', target: 'source', counter: '+1/+1', count: { kind: 'damageDealt' } },
    ]);
  });

  it('selfless-squire-shield — through the stack, the shield prevents combat and noncombat damage to you this turn, but not damage to your creatures', () => {
    const ctx = pod('squire-shield');
    const squire = castSquire(ctx);
    expect(ctx.state.damageShields).toHaveLength(1);
    expect(counters(ctx, squire)).toBe(0);
    const mine = spawn(ctx, 'P1', BRUTE('Lab Mine', '1'));

    bolt(ctx, 'P2', 'P1');
    expect(life(ctx, 'P1')).toBe(40);

    const ogre = spawn(ctx, 'P2', BRUTE('Lab Ogre', '4'));
    attackP1(ctx, [ogre.id]);
    expect(life(ctx, 'P1')).toBe(40);

    // Damage to your creatures is not damage to you.
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    bolt(ctx, 'P2', mine.id);
    expect(onField(ctx, mine.cardId)!.damageMarked).toBe(3);
    // Damage to another player is not covered.
    bolt(ctx, 'P1', 'P3');
    expect(life(ctx, 'P3')).toBe(37);
  });

  it('selfless-squire-this-turn — the shield ends with the turn: damage the next turn is dealt', () => {
    const ctx = pod('squire-next-turn');
    castSquire(ctx);
    pump(runTurn(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined) return declareNoAttacks(decision);
      return pick(decision, /Pass|Discard|does not/);
    });
    expect(ctx.state.damageShields).toEqual([]);
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    bolt(ctx, 'P2', 'P1');
    expect(life(ctx, 'P1')).toBe(37);
  });

  it('selfless-squire-counters — each prevented source puts that many +1/+1 counters on the Squire, once per source: two attackers make two triggers', () => {
    const ctx = pod('squire-counters');
    const squire = castSquire(ctx);
    const a = spawn(ctx, 'P2', BRUTE('Lab Ogre A', '4'));
    const b = spawn(ctx, 'P2', BRUTE('Lab Ogre B', '2'));
    attackP1(ctx, [a.id, b.id]);
    expect(life(ctx, 'P1')).toBe(40);
    expect(counters(ctx, squire)).toBe(6);
    // Noncombat damage is prevented and counted too.
    bolt(ctx, 'P2', 'P1');
    expect(counters(ctx, squire)).toBe(9);
    // The counters are triggers, not prevented-damage reflection: nothing hurt the attackers.
    expect(onField(ctx, a.cardId)!.damageMarked).toBe(0);
  });

  it('selfless-squire-counters — the trigger belongs to the Squire alone: with no shield, a Fog-style combat shield to you still counts, and damage to someone else or to your creature does not', () => {
    const ctx = pod('squire-fog');
    const squire = enterFrom(ctx, 'P1', card);
    // Enter trigger is not resolved here: no shield exists, only the combat shield below.
    ctx.state.pendingTriggers = [];
    ctx.state.damageShields = [];
    ctx.state.combatDamagePrevention = { all: false, players: { P1: true } };
    const ogre = spawn(ctx, 'P2', BRUTE('Lab Ogre', '3'));
    attackP1(ctx, [ogre.id]);
    expect(counters(ctx, squire)).toBe(3);
    expect(life(ctx, 'P1')).toBe(40);

    const other = pod('squire-others');
    const watcher = enterFrom(other, 'P1', card);
    other.state.pendingTriggers = [];
    other.state.damageShields = [];
    const bystander = spawn(other, 'P1', BRUTE('Lab Bystander', '1'));
    bolt(other, 'P1', 'P3');
    bolt(other, 'P2', bystander.id);
    expect(counters(other, watcher)).toBe(0);
    // An opponent's Squire does not count damage prevented for you.
    const rival = pod('squire-rival');
    const theirs = enterFrom(rival, 'P2', card);
    rival.state.pendingTriggers = [];
    rival.state.combatDamagePrevention = { all: false, players: { P1: true } };
    attackP1(rival, [spawn(rival, 'P2', BRUTE('Lab Ogre', '3')).id]);
    expect(counters(rival, theirs)).toBe(0);
  });

  it('selfless-squire-counters — Gisela\'s "prevent half that damage, rounded up" is prevention too: with no shield, 3 damage to you is 2 prevented and counted, 1 dealt', () => {
    const ctx = pod('squire-gisela-half');
    const squire = enterFrom(ctx, 'P1', card);
    ctx.state.pendingTriggers = [];
    ctx.state.damageShields = [];
    spawn(ctx, 'P1', gisela);
    bolt(ctx, 'P2', 'P1');
    expect(life(ctx, 'P1')).toBe(39);
    expect(counters(ctx, squire)).toBe(2);
  });

  it('selfless-squire-order-choice — a doubling replacement and the shield change how many counters the Squire gets, so you choose the order', () => {
    const play = (pickText: RegExp) => {
      const ctx = pod(`squire-order-${pickText.source}`);
      const squire = castSquire(ctx);
      spawn(ctx, 'P2', gisela);
      const asked: PendingDecision[] = [];
      bolt(ctx, 'P2', 'P1', (decision) => {
        asked.push(decision);
        return {
          index: decision.options.findIndex((o) => pickText.test(o.description)),
          targets: new Map(),
        };
      });
      return { ctx, squire, asked };
    };
    // P2's Gisela doubles damage dealt to P1: 3 becomes 6 if that applies first, else the shield
    // prevents 3.
    const shieldFirst = play(/prevent all damage/);
    expect(shieldFirst.asked).toHaveLength(1);
    expect(shieldFirst.asked[0]!.player).toBe('P1');
    expect(counters(shieldFirst.ctx, shieldFirst.squire)).toBe(3);
    const doubleFirst = play(/double/);
    expect(doubleFirst.asked).toHaveLength(1);
    expect(counters(doubleFirst.ctx, doubleFirst.squire)).toBe(6);
    expect(life(doubleFirst.ctx, 'P1')).toBe(40);

    // Without the Squire to watch, the same two effects give the same result either way: no prompt.
    const unwatched = pod('squire-order-unwatched');
    const shield = enterFrom(unwatched, 'P1', card);
    unwatched.state.pendingTriggers = [];
    onField(unwatched, shield.cardId)!.faceDown = true;
    unwatched.state.damageShields.push({
      id: 'lab-shield',
      effectSource: permanentSource(shield),
      playerId: 'P1',
    });
    spawn(unwatched, 'P2', gisela);
    const hit = pump(
      dealDamageToPlayer(
        unwatched,
        permanentSource(spawn(unwatched, 'P2', BRUTE('Lab Ogre', '2'))),
        playerById(unwatched, 'P1'),
        3,
        {
          combat: false,
          sourceIsCommander: false,
          sourceHasLifelink: false,
        },
      ),
    );
    expect(hit.decisions).toEqual([]);
    expect(life(unwatched, 'P1')).toBe(40);
  });
});

// ---------------------------------------------------------------------------------------------
// PR06.05 Deflecting Palm
// ---------------------------------------------------------------------------------------------

describe('Deflecting Palm', () => {
  const { card } = pinned('Deflecting Palm');
  const COST = [{ symbol: 'R' as const }, { symbol: 'W' as const }];
  const LAB_BOLT = oracle({
    name: 'Lab Bolt',
    typeLine: 'Instant',
    manaCost: '{R}',
    colors: ['R'],
    oracleText: 'Lab Bolt deals 3 damage to any target.',
  });
  const OGRE = (name: string, power: string, text = '') =>
    oracle({ name, typeLine: 'Creature — Ogre', power, toughness: '9', oracleText: text });
  const life = (ctx: GameContext, id: string) => playerById(ctx, id).life;
  const damagePayloads = (ctx: GameContext) => damageEvents(ctx).map((event) => event.payload);

  /** The decision's option whose description is exactly `name`. */
  const choose =
    (name: string): Answer =>
    (decision) => {
      const index = decision.options.findIndex((option) => option.description === name);
      expect(
        index,
        `${name} is offered among ${decision.options.map((o) => o.description)}`,
      ).toBeGreaterThanOrEqual(0);
      return { index, targets: new Map() };
    };

  /** P1 casts Deflecting Palm with the stack as it is and leaves it on the stack. */
  function castPalm(ctx: GameContext) {
    const object = conjure(ctx, 'P1', card, 'hand');
    addMana(playerById(ctx, 'P1'), COST);
    const option = optionFor(ctx, 'P1', object.id);
    expect(option, 'P1 casts Deflecting Palm').toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    return object;
  }

  /** On P2's turn P1 casts Palm, choosing `source`; it resolves. */
  function palmChoosing(ctx: GameContext, source: string) {
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    const object = castPalm(ctx);
    resolveTop(ctx, choose(source));
    return object;
  }

  /** `turn`'s combat: each creature in `attackers` attacks P1, who does not block. */
  function attackP1(ctx: GameContext, attackers: string[], answer?: Answer, turn = 'P2') {
    ctx.state.currentTurnPlayer = turn;
    ctx.state.activePlayerIndex = Number(turn.slice(1)) - 1;
    pump(runCombatAndExtraCombats(ctx), (decision, count) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId) =>
          attackers.includes(subjectId) ? 'P1' : null,
        );
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      if (pass >= 0) return { index: pass, targets: new Map() };
      return answer?.(decision, count) ?? { index: 0, targets: new Map() };
    });
  }

  /** `playerId` casts Lab Bolt at `targetId`, leaving it on the stack. */
  function castBolt(ctx: GameContext, playerId: string, targetId: string) {
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
    return object;
  }

  it("deflecting-palm-pinned-oracle-supported — the override reads a one-shot shield for a chosen source that reflects the prevented damage to that source's controller", () => {
    expectModeled(card);
    expect(getOverride(card.oracleId)?.unsupportedReason).toBeUndefined();
    expect(getOverride(fixtureOracleId(card.name))?.unsupportedReason).toBeUndefined();
    const def = interpretCard(card);
    expect(def.spellAbility!.targets).toEqual([]);
    expect(def.spellAbility!.effects).toEqual([
      {
        op: 'createDamageShield',
        player: 'you',
        chosenSource: true,
        oneShot: true,
        reflect: 'toSourceController',
      },
    ]);
  });

  it("deflecting-palm-chosen-source — the chosen creature's combat damage to you is prevented and Deflecting Palm deals that much to its controller, after the combat damage and as itself", () => {
    const ctx = pod('palm-combat');
    const ogre = spawn(ctx, 'P2', OGRE('Lab Ogre', '3'));
    const palm = palmChoosing(ctx, 'Lab Ogre');
    attackP1(ctx, [ogre.id]);
    expect(life(ctx, 'P1')).toBe(40);
    expect(life(ctx, 'P2')).toBe(37);
    // Choosing offered every permanent, and the damage that was dealt is Palm's alone.
    expect(damagePayloads(ctx)).toMatchObject([
      { source: 'Deflecting Palm', target: 'P2', amount: 3, combat: false },
    ]);
    expect(String(damagePayloads(ctx)[0]!['sourceCardId'])).toBe(palm.cardId);
    expect(ctx.state.damageShields).toEqual([]);
    expect(ctx.state.damageReflections).toEqual([]);
  });

  it('deflecting-palm-chosen-source — damage from a different source is not prevented, and the shield is still there for the chosen one', () => {
    const ctx = pod('palm-other-source');
    const chosen = spawn(ctx, 'P2', OGRE('Lab Chosen', '3'));
    const other = spawn(ctx, 'P3', OGRE('Lab Other', '2'));
    palmChoosing(ctx, 'Lab Chosen');
    ctx.state.currentTurnPlayer = 'P3';
    ctx.state.activePlayerIndex = 2;
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId) => (subjectId === other.id ? 'P1' : null));
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      return {
        index: Math.max(
          decision.options.findIndex((o) => o.type === 'pass'),
          0,
        ),
        targets: new Map(),
      };
    });
    expect(life(ctx, 'P1')).toBe(38);
    expect(life(ctx, 'P3')).toBe(40);
    expect(ctx.state.damageShields).toHaveLength(1);
    expect(chosen.cardId).toBeDefined();
  });

  it('deflecting-palm-one-shot — only the first damage from the chosen source is prevented: a double striker is stopped once and hits you the second time', () => {
    const ctx = pod('palm-one-shot');
    const striker = spawn(ctx, 'P2', OGRE('Lab Striker', '3', 'Double strike'));
    palmChoosing(ctx, 'Lab Striker');
    attackP1(ctx, [striker.id]);
    expect(life(ctx, 'P1')).toBe(37);
    // Reflected 3 to P2 after the first-strike step; the regular step's 3 reached P1.
    expect(life(ctx, 'P2')).toBe(37);
    expect(ctx.state.damageShields).toEqual([]);
  });

  it('deflecting-palm-this-turn — the shield ends with the turn', () => {
    const ctx = pod('palm-next-turn');
    spawn(ctx, 'P2', OGRE('Lab Ogre', '3'));
    palmChoosing(ctx, 'Lab Ogre');
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    pump(runTurn(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined) return declareNoAttacks(decision);
      return pick(decision, /Pass|Discard|does not/);
    });
    expect(ctx.state.damageShields).toEqual([]);
  });

  it('deflecting-palm-chosen-source — a chosen spell on the stack is prevented and reflected to its controller, and the choice also offers permanents', () => {
    const ctx = pod('palm-spell');
    const prowler = spawn(ctx, 'P2', OGRE('Lab Prowler', '1'));
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    const offered: string[][] = [];
    castBolt(ctx, 'P2', 'P1');
    castPalm(ctx);
    resolveTop(ctx, (decision) => {
      offered.push(decision.options.map((o) => o.description));
      return {
        index: decision.options.findIndex((o) => o.description === 'Lab Bolt (spell)'),
        targets: new Map(),
      };
    });
    resolveTop(ctx);
    expect(offered[0]).toEqual(expect.arrayContaining(['Lab Prowler', 'Lab Bolt (spell)']));
    expect(life(ctx, 'P1')).toBe(40);
    expect(life(ctx, 'P2')).toBe(37);
    expect(damagePayloads(ctx)).toMatchObject([
      { source: 'Deflecting Palm', target: 'P2', amount: 3 },
    ]);
    expect(onField(ctx, prowler.cardId)).toBeDefined();
  });

  it('deflecting-palm-new-object — a chosen permanent that leaves and returns is a new object, so its damage is no longer prevented', () => {
    const ctx = pod('palm-new-object');
    const ogre = spawn(ctx, 'P2', OGRE('Lab Ogre', '3'));
    palmChoosing(ctx, 'Lab Ogre');
    pump(moveObject(ctx, ogre, { zone: 'hand' }));
    const returned = playerById(ctx, 'P2').hand.find((c) => c.cardId === ogre.cardId);
    expect(returned).toBeDefined();
    pump(moveObject(ctx, returned!, { zone: 'battlefield', controllerId: 'P2' }));
    const fresh = onField(ctx, ogre.cardId)!;
    expect(fresh.id).not.toBe(ogre.id);
    pump(
      dealDamageToPlayer(ctx, permanentSource(fresh), playerById(ctx, 'P1'), 3, {
        combat: false,
        sourceIsCommander: false,
        sourceHasLifelink: false,
      }),
    );
    expect(life(ctx, 'P1')).toBe(37);
    expect(ctx.state.damageShields).toHaveLength(1);
  });

  it('deflecting-palm-reflection-target — the damage goes to the controller of the source, not to another opponent', () => {
    const ctx = pod('palm-controller');
    const ogre = spawn(ctx, 'P3', OGRE('Lab Ogre', '4'));
    palmChoosing(ctx, 'Lab Ogre');
    attackP1(ctx, [ogre.id], undefined, 'P3');
    expect(life(ctx, 'P1')).toBe(40);
    expect(life(ctx, 'P2')).toBe(40);
    expect(life(ctx, 'P3')).toBe(36);
  });

  it('deflecting-palm-order-choice — Deflecting Palm and a Fog-style combat shield both prevent the damage, and the choice decides whether the Palm is used up and reflects', () => {
    const play = (pickText: RegExp) => {
      const ctx = pod(`palm-order-${pickText.source}`);
      const ogre = spawn(ctx, 'P2', OGRE('Lab Ogre', '3'));
      palmChoosing(ctx, 'Lab Ogre');
      ctx.state.combatDamagePrevention = { all: false, players: { P1: true } };
      const asked: PendingDecision[] = [];
      attackP1(ctx, [ogre.id], (decision) => {
        asked.push(decision);
        return {
          index: decision.options.findIndex((o) => pickText.test(o.description)),
          targets: new Map(),
        };
      });
      return { ctx, asked };
    };
    const palmFirst = play(/Deflecting Palm/);
    expect(palmFirst.asked).toHaveLength(1);
    expect(palmFirst.asked[0]!.player).toBe('P1');
    expect(life(palmFirst.ctx, 'P2')).toBe(37);
    expect(palmFirst.ctx.state.damageShields).toEqual([]);
    const shieldFirst = play(/Prevent all combat damage/);
    expect(shieldFirst.asked).toHaveLength(1);
    expect(life(shieldFirst.ctx, 'P2')).toBe(40);
    expect(shieldFirst.ctx.state.damageShields).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// PR06.04 Comeuppance
// ---------------------------------------------------------------------------------------------

describe('Comeuppance', () => {
  const { card } = pinned('Comeuppance');
  const palmCard = pinned('Deflecting Palm').card;
  const COST = [{ symbol: 'W' as const }, ...generic(3)];
  const LAB_BOLT = oracle({
    name: 'Lab Bolt',
    typeLine: 'Instant',
    manaCost: '{R}',
    colors: ['R'],
    oracleText: 'Lab Bolt deals 3 damage to any target.',
  });
  const OGRE = (name: string, power: string) =>
    oracle({ name, typeLine: 'Creature — Ogre', power, toughness: '9' });
  const PINGER = oracle({
    name: 'Lab Pinger',
    typeLine: 'Creature — Construct',
    power: '1',
    toughness: '9',
    oracleText: '{T}: Lab Pinger deals 2 damage to any target.',
  });
  const ROD = oracle({
    name: 'Lab Rod',
    typeLine: 'Artifact',
    manaCost: '{1}',
    oracleText: '{T}: Lab Rod deals 2 damage to any target.',
  });
  const WALKER = oracle({
    name: 'Lab Walker',
    typeLine: 'Legendary Planeswalker — Lab',
    manaCost: '{2}',
    loyalty: '5',
  });
  const life = (ctx: GameContext, id: string) => playerById(ctx, id).life;
  const loyalty = (ctx: GameContext, perm: EnginePermanent) =>
    onField(ctx, perm.cardId)!.counters['loyalty'];
  const marked = (ctx: GameContext, perm: EnginePermanent) =>
    onField(ctx, perm.cardId)?.damageMarked;
  const damagePayloads = (ctx: GameContext) => damageEvents(ctx).map((event) => event.payload);

  /** It is P2's turn and P1 casts Comeuppance, which resolves. */
  function comeuppance(ctx: GameContext) {
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    const object = castFromHand(ctx, 'P1', card, COST);
    resolveTop(ctx);
    return object;
  }

  /** `playerId` casts Lab Bolt at `targetId` and the stack settles; `answer` gets other decisions. */
  function bolt(ctx: GameContext, playerId: string, targetId: string, answer?: Answer) {
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
    return settle(ctx, answer);
  }

  /** `permanent`'s controller activates its tap ability at `targetId`, leaving it on the stack. */
  function activate(ctx: GameContext, perm: EnginePermanent, targetId: string) {
    const option = optionFor(ctx, perm.controllerId, perm.id, /deals 2 damage/);
    expect(option, `${perm.name} activates`).toBeDefined();
    takeAction(
      ctx,
      perm.controllerId,
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[option!.targets![0]!.slot, targetId]]),
    );
  }

  /** `turn`'s combat: each creature in `attackers` attacks P1, who does not block. */
  function attackP1(ctx: GameContext, attackers: string[], answer?: Answer, turn = 'P2') {
    ctx.state.currentTurnPlayer = turn;
    ctx.state.activePlayerIndex = Number(turn.slice(1)) - 1;
    pump(runCombatAndExtraCombats(ctx), (decision, count) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId) =>
          attackers.includes(subjectId) ? 'P1' : null,
        );
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      if (pass >= 0) return { index: pass, targets: new Map() };
      return answer?.(decision, count) ?? { index: 0, targets: new Map() };
    });
  }

  it("comeuppance-pinned-oracle-supported — the override reads one shield for you and your planeswalkers against sources you do not control, reflecting to a creature source or else to the source's controller", () => {
    expectModeled(card);
    expect(getOverride(card.oracleId)?.unsupportedReason).toBeUndefined();
    expect(getOverride(fixtureOracleId(card.name))?.unsupportedReason).toBeUndefined();
    const def = interpretCard(card);
    expect(def.spellAbility!.targets).toEqual([]);
    expect(def.spellAbility!.effects).toEqual([
      {
        op: 'createDamageShield',
        player: 'you',
        andPlaneswalkersYouControl: true,
        sources: 'youDontControl',
        reflect: 'toSourceCreatureElseController',
      },
    ]);
  });

  it('comeuppance-creature-source — combat damage from a creature is prevented and Comeuppance deals that much to that creature, not to its controller', () => {
    const ctx = pod('comeuppance-combat');
    const ogre = spawn(ctx, 'P2', OGRE('Lab Ogre', '4'));
    comeuppance(ctx);
    attackP1(ctx, [ogre.id]);
    expect(life(ctx, 'P1')).toBe(40);
    expect(life(ctx, 'P2')).toBe(40);
    expect(marked(ctx, ogre)).toBe(4);
    expect(damagePayloads(ctx)).toMatchObject([
      { source: 'Comeuppance', target: 'Lab Ogre', amount: 4, combat: false },
    ]);
  });

  it('comeuppance-creature-source — noncombat damage from a creature ability is prevented and reflected to that creature too, and a creature that has left takes nothing and its controller is not hurt instead', () => {
    const ctx = pod('comeuppance-pinger');
    const pinger = spawn(ctx, 'P2', PINGER);
    comeuppance(ctx);
    activate(ctx, pinger, 'P1');
    settle(ctx);
    expect(life(ctx, 'P1')).toBe(40);
    expect(life(ctx, 'P2')).toBe(40);
    expect(marked(ctx, pinger)).toBe(2);

    const gone = pod('comeuppance-pinger-gone');
    const leaver = spawn(gone, 'P2', PINGER);
    comeuppance(gone);
    activate(gone, leaver, 'P1');
    pump(moveObject(gone, leaver, { zone: 'graveyard' }));
    settle(gone);
    expect(life(gone, 'P1')).toBe(40);
    expect(life(gone, 'P2')).toBe(40);
    expect(damagePayloads(gone)).toEqual([]);
  });

  it("comeuppance-noncreature-source — a spell's damage is prevented and Comeuppance deals that much to the spell's controller, and so does a noncreature permanent's ability", () => {
    const ctx = pod('comeuppance-bolt');
    comeuppance(ctx);
    bolt(ctx, 'P2', 'P1');
    expect(life(ctx, 'P1')).toBe(40);
    expect(life(ctx, 'P2')).toBe(37);
    expect(damagePayloads(ctx)).toMatchObject([{ source: 'Comeuppance', target: 'P2', amount: 3 }]);

    const rod = pod('comeuppance-rod');
    const artifact = spawn(rod, 'P3', ROD);
    comeuppance(rod);
    activate(rod, artifact, 'P1');
    settle(rod);
    expect(life(rod, 'P1')).toBe(40);
    expect(life(rod, 'P3')).toBe(38);
    expect(life(rod, 'P2')).toBe(40);
  });

  it('comeuppance-your-sources — damage from sources you control is not prevented, nor is damage to your creatures or to another player', () => {
    const ctx = pod('comeuppance-own');
    const mine = spawn(ctx, 'P1', OGRE('Lab Mine', '1'));
    const walker = spawn(ctx, 'P1', WALKER);
    comeuppance(ctx);
    bolt(ctx, 'P1', 'P1');
    expect(life(ctx, 'P1')).toBe(37);
    bolt(ctx, 'P1', walker.id);
    expect(loyalty(ctx, walker)).toBe(2);
    // Damage to your creature is not damage to you or a planeswalker.
    bolt(ctx, 'P2', mine.id);
    expect(marked(ctx, mine)).toBe(3);
    // Damage to another player is not covered.
    bolt(ctx, 'P2', 'P3');
    expect(life(ctx, 'P3')).toBe(37);
    expect(life(ctx, 'P2')).toBe(40);
  });

  it("comeuppance-planeswalkers — planeswalkers you control are protected, including one that arrives after it resolved, but not another player's", () => {
    const ctx = pod('comeuppance-walker');
    const early = spawn(ctx, 'P1', WALKER);
    const theirs = spawn(
      ctx,
      'P2',
      oracle({ ...WALKER, name: 'Lab Rival Walker', oracleId: 'oracle-lab-rival-walker' }),
    );
    comeuppance(ctx);
    bolt(ctx, 'P2', early.id);
    expect(loyalty(ctx, early)).toBe(5);
    expect(life(ctx, 'P2')).toBe(37);
    // A planeswalker gained later this turn is covered because "you control" is checked as the
    // damage would be dealt.
    const late = spawn(
      ctx,
      'P1',
      oracle({ ...WALKER, name: 'Lab Late Walker', oracleId: 'oracle-lab-late-walker' }),
    );
    bolt(ctx, 'P3', late.id);
    expect(loyalty(ctx, late)).toBe(5);
    expect(life(ctx, 'P3')).toBe(37);
    // Not yours, so not covered.
    bolt(ctx, 'P3', theirs.id);
    expect(loyalty(ctx, theirs)).toBe(2);
    // A walker you stop controlling is no longer covered.
    onField(ctx, early.cardId)!.controllerId = 'P2';
    bolt(ctx, 'P3', early.id);
    expect(loyalty(ctx, early)).toBe(2);
  });

  it('comeuppance-this-turn — the shield ends with the turn', () => {
    const ctx = pod('comeuppance-next-turn');
    comeuppance(ctx);
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    pump(runTurn(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined) return declareNoAttacks(decision);
      return pick(decision, /Pass|Discard|does not/);
    });
    expect(ctx.state.damageShields).toEqual([]);
    bolt(ctx, 'P2', 'P1');
    expect(life(ctx, 'P1')).toBe(37);
  });

  it('comeuppance-order-choice — Comeuppance and Deflecting Palm both prevent the damage and reflect differently, so you choose which applies first', () => {
    const play = (pickText: RegExp) => {
      const ctx = pod(`comeuppance-palm-${pickText.source}`);
      const ogre = spawn(ctx, 'P2', OGRE('Lab Ogre', '4'));
      comeuppance(ctx);
      const palm = castFromHand(ctx, 'P1', palmCard, [{ symbol: 'R' }, { symbol: 'W' }]);
      resolveTop(ctx, (decision) => ({
        index: decision.options.findIndex((o) => o.description === 'Lab Ogre'),
        targets: new Map(),
      }));
      const asked: PendingDecision[] = [];
      attackP1(ctx, [ogre.id], (decision) => {
        asked.push(decision);
        return {
          index: decision.options.findIndex((o) => pickText.test(o.description)),
          targets: new Map(),
        };
      });
      return { ctx, ogre, asked, palm };
    };
    const comeuppanceFirst = play(/Comeuppance/);
    expect(comeuppanceFirst.asked).toHaveLength(1);
    expect(comeuppanceFirst.asked[0]!.player).toBe('P1');
    expect(marked(comeuppanceFirst.ctx, comeuppanceFirst.ogre)).toBe(4);
    expect(life(comeuppanceFirst.ctx, 'P2')).toBe(40);
    // The Palm was not used up, so it is still waiting.
    expect(comeuppanceFirst.ctx.state.damageShields.map((s) => s.oneShot === true)).toContain(true);
    const palmFirst = play(/Deflecting Palm/);
    expect(palmFirst.asked).toHaveLength(1);
    expect(life(palmFirst.ctx, 'P2')).toBe(36);
    expect(marked(palmFirst.ctx, palmFirst.ogre)).toBe(0);
    expect(life(palmFirst.ctx, 'P1')).toBe(40);
  });

  it("comeuppance-mandatory-loop — two Comeuppances that prevent and reflect each other's damage forever are an unbreakable loop, and the game is a draw (CR 104.4b)", () => {
    const ctx = pod('comeuppance-loop');
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    castFromHand(ctx, 'P1', card, COST);
    resolveTop(ctx);
    // P2 has its own Comeuppance, protecting P2 from everything P2 does not control.
    const second = conjure(ctx, 'P2', card, 'hand');
    addMana(playerById(ctx, 'P2'), COST);
    const option = optionFor(ctx, 'P2', second.id);
    expect(option).toBeDefined();
    takeAction(ctx, 'P2', option!.payload as PriorityActionPayload);
    resolveTop(ctx);
    let thrown: unknown;
    try {
      bolt(ctx, 'P2', 'P1');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GameOverSignal);
    expect((thrown as GameOverSignal).winner).toBeNull();
    expect((thrown as GameOverSignal).haltReason).toContain('draw');
    expect((thrown as GameOverSignal).haltReason).toContain('CR 104.4b');
  });
});

// ---------------------------------------------------------------------------------------------
// PR06.09 Michiko Konda, Truth Seeker
// ---------------------------------------------------------------------------------------------

describe('Michiko Konda, Truth Seeker', () => {
  const { card } = pinned('Michiko Konda, Truth Seeker');
  const COST = [{ symbol: 'W' as const }, ...generic(3)];
  const LAB_BOLT = oracle({
    name: 'Lab Bolt',
    typeLine: 'Instant',
    manaCost: '{R}',
    colors: ['R'],
    oracleText: 'Lab Bolt deals 3 damage to any target.',
  });
  const OGRE = (name: string, power: string, text = '') =>
    oracle({ name, typeLine: 'Creature — Ogre', power, toughness: '9', oracleText: text });
  const FODDER = (n: number) =>
    oracle({ name: `Lab Fodder ${n}`, typeLine: 'Artifact', manaCost: '{1}' });
  const life = (ctx: GameContext, id: string) => playerById(ctx, id).life;
  const fodderOf = (ctx: GameContext, id: string) =>
    ctx.state.battlefield.filter((p) => p.controllerId === id && p.name.startsWith('Lab Fodder'));

  /** The sacrifice decisions asked, and answered by sacrificing the first Lab Fodder on offer. */
  function sacrificing(asked: PendingDecision[]): Answer {
    return (decision) => {
      // Only the sacrifice choices are recorded; ordering two simultaneous triggers is another.
      if (decision.options.some((option) => option.type === 'sacrifice')) asked.push(decision);
      const index = decision.options.findIndex((option) =>
        option.description.includes('Lab Fodder'),
      );
      return { index: Math.max(index, 0), targets: new Map() };
    };
  }

  /** P1 controls Michiko on the battlefield; `holders` each control two Lab Fodder. */
  function board(seed: string, holders: string[] = ['P2', 'P3']) {
    const ctx = pod(seed);
    const michiko = spawn(ctx, 'P1', card);
    for (const holder of holders) for (const n of [1, 2]) spawn(ctx, holder, FODDER(n));
    return { ctx, michiko };
  }

  /** `playerId` casts Lab Bolt at `targetId` and the stack settles. */
  function bolt(ctx: GameContext, playerId: string, targetId: string, answer?: Answer) {
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
    return settle(ctx, answer);
  }

  /** `turn`'s combat: each creature in `attackers` attacks P1, who does not block. */
  function attackP1(ctx: GameContext, attackers: string[], answer?: Answer, turn = 'P2') {
    ctx.state.currentTurnPlayer = turn;
    ctx.state.activePlayerIndex = Number(turn.slice(1)) - 1;
    pump(runCombatAndExtraCombats(ctx), (decision, count) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId) =>
          attackers.includes(subjectId) ? 'P1' : null,
        );
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      if (pass >= 0) return { index: pass, targets: new Map() };
      return answer?.(decision, count) ?? { index: 0, targets: new Map() };
    });
  }

  it('michiko-konda-pinned-oracle-supported — the override reads a trigger on damage dealt to you by a source an opponent controls, making that player sacrifice a permanent of their choice', () => {
    expectModeled(card);
    expect(getOverride(card.oracleId)?.unsupportedReason).toBeUndefined();
    expect(getOverride(fixtureOracleId(card.name))?.unsupportedReason).toBeUndefined();
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toEqual({
      when: 'playerDealtDamage',
      player: 'you',
      sourceController: 'opponent',
    });
    expect(def.triggers[0]!.targets).toEqual([]);
    expect(def.triggers[0]!.effects).toEqual([{ op: 'eventPlayerSacrificesPermanents', count: 1 }]);
  });

  it('michiko-konda-combat-damage — cast through the stack, each opposing attacker that deals combat damage to you makes its controller sacrifice a permanent of their choice: two attackers, two sacrifices', () => {
    const ctx = pod('michiko-combat');
    const castObject = castFromHand(ctx, 'P1', card, COST);
    resolveTop(ctx);
    expect(onField(ctx, castObject.cardId)).toBeDefined();
    const a = spawn(ctx, 'P2', OGRE('Lab Ogre A', '3'));
    const b = spawn(ctx, 'P2', OGRE('Lab Ogre B', '2'));
    for (const n of [1, 2, 3]) spawn(ctx, 'P2', FODDER(n));
    const asked: PendingDecision[] = [];
    attackP1(ctx, [a.id, b.id], sacrificing(asked));
    expect(life(ctx, 'P1')).toBe(35);
    expect(asked).toHaveLength(2);
    expect(asked.every((decision) => decision.player === 'P2')).toBe(true);
    expect(fodderOf(ctx, 'P2')).toHaveLength(1);
    // The sacrificing player chose among every permanent they control, not just creatures.
    expect(asked[0]!.options.map((o) => o.description)).toEqual(
      expect.arrayContaining(['Sacrifice Lab Ogre A', 'Sacrifice Lab Fodder 1']),
    );
  });

  it("michiko-konda-noncombat-damage — damage from an opponent's spell triggers it too, and an infect source counts because the damage is still dealt", () => {
    const { ctx } = board('michiko-bolt', ['P2']);
    const asked: PendingDecision[] = [];
    bolt(ctx, 'P2', 'P1', sacrificing(asked));
    expect(life(ctx, 'P1')).toBe(37);
    expect(asked).toHaveLength(1);
    expect(fodderOf(ctx, 'P2')).toHaveLength(1);

    const infect = board('michiko-infect', ['P2']);
    const plaguer = spawn(infect.ctx, 'P2', OGRE('Lab Plaguer', '2', 'Infect'));
    const poisoned: PendingDecision[] = [];
    attackP1(infect.ctx, [plaguer.id], sacrificing(poisoned));
    expect(playerById(infect.ctx, 'P1').poisonCounters).toBe(2);
    expect(life(infect.ctx, 'P1')).toBe(40);
    expect(poisoned).toHaveLength(1);
  });

  it('michiko-konda-no-damage-no-trigger — prevented damage deals none, so nothing triggers', () => {
    const { ctx } = board('michiko-prevented', ['P2']);
    const ogre = spawn(ctx, 'P2', OGRE('Lab Ogre', '3'));
    ctx.state.combatDamagePrevention = { all: false, players: { P1: true } };
    const asked: PendingDecision[] = [];
    attackP1(ctx, [ogre.id], sacrificing(asked));
    expect(life(ctx, 'P1')).toBe(40);
    expect(asked).toEqual([]);
    expect(fodderOf(ctx, 'P2')).toHaveLength(2);
  });

  it('michiko-konda-only-opponents-sources-to-you — your own source, damage to your creature, and damage to another player do not trigger it', () => {
    const { ctx } = board('michiko-others', ['P2', 'P3']);
    const mine = spawn(ctx, 'P1', OGRE('Lab Mine', '1'));
    const asked: PendingDecision[] = [];
    const answer = sacrificing(asked);
    bolt(ctx, 'P1', 'P1', answer);
    bolt(ctx, 'P2', mine.id, answer);
    bolt(ctx, 'P2', 'P3', answer);
    expect(life(ctx, 'P1')).toBe(37);
    expect(asked).toEqual([]);
    expect(fodderOf(ctx, 'P2')).toHaveLength(2);
    expect(fodderOf(ctx, 'P3')).toHaveLength(2);
  });

  it('michiko-konda-multiplayer — the opponent whose source dealt the damage sacrifices, not the other opponents', () => {
    const { ctx } = board('michiko-multiplayer');
    const asked: PendingDecision[] = [];
    bolt(ctx, 'P3', 'P1', sacrificing(asked));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.player).toBe('P3');
    expect(fodderOf(ctx, 'P3')).toHaveLength(1);
    expect(fodderOf(ctx, 'P2')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// PR06.17 Delirium
// ---------------------------------------------------------------------------------------------

describe('Delirium', () => {
  const { card } = pinned('Delirium');
  const COST = [{ symbol: 'B' as const }, { symbol: 'R' as const }, ...generic(1)];
  const LAB_BOLT = oracle({
    name: 'Lab Bolt',
    typeLine: 'Instant',
    manaCost: '{R}',
    colors: ['R'],
    oracleText: 'Lab Bolt deals 3 damage to any target.',
  });
  const BRUTE = (name: string, power: string, text = '') =>
    oracle({ name, typeLine: 'Creature — Ogre', power, toughness: '9', oracleText: text });
  const life = (ctx: GameContext, id: string) => playerById(ctx, id).life;
  const marked = (ctx: GameContext, perm: EnginePermanent) =>
    onField(ctx, perm.cardId)?.damageMarked;

  /** It is `turn`'s turn (P2 by default), in its precombat main phase. */
  function turnOf(ctx: GameContext, turn: string) {
    ctx.state.currentTurnPlayer = turn;
    ctx.state.activePlayerIndex = Number(turn.slice(1)) - 1;
  }

  /** P1's option to cast Delirium, with its payload. */
  function deliriumOption(ctx: GameContext) {
    const object = conjure(ctx, 'P1', card, 'hand');
    addMana(playerById(ctx, 'P1'), COST);
    return { object, option: optionFor(ctx, 'P1', object.id) };
  }

  /** P1 casts Delirium at `targetId` and it resolves. */
  function cast(ctx: GameContext, targetId: string) {
    const { object, option } = deliriumOption(ctx);
    expect(option, 'P1 casts Delirium').toBeDefined();
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[option!.targets![0]!.slot, targetId]]),
    );
    resolveTop(ctx);
    return object;
  }

  /** P2's turn: `attackers` attack P1, whose `blocks` (blocker id to attacker id) stand. */
  function combat(ctx: GameContext, attackers: string[], blocks: Record<string, string> = {}) {
    turnOf(ctx, 'P2');
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId) =>
          attackers.includes(subjectId) ? 'P1' : null,
        );
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, (subjectId) => blocks[subjectId] ?? null);
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
  }

  it("delirium-pinned-oracle-supported — the override reads a cast restriction to an opponent's turn, a target creature the active player controls, damage from it equal to its power, and a shield on that creature", () => {
    expectModeled(card);
    expect(getOverride(card.oracleId)?.unsupportedReason).toBeUndefined();
    expect(getOverride(fixtureOracleId(card.name))?.unsupportedReason).toBeUndefined();
    const def = interpretCard(card);
    expect(def.castRestriction).toEqual({ kind: 'notYourTurn' });
    expect(def.spellAbility!.targets).toEqual([{ kind: 'creature', controller: 'activePlayer' }]);
    expect(def.spellAbility!.effects).toEqual([
      { op: 'tapTarget', target: 0 },
      {
        op: 'dealDamage',
        target: { controllerOf: 0 },
        source: 0,
        amount: { kind: 'powerOfTarget', target: 0 },
      },
      { op: 'createDamageShield', target: 0, dealtTo: true, dealtBy: true, combatOnly: true },
    ]);
  });

  it("delirium-cast-timing — it is offered only during an opponent's turn, in any opponent's turn, and a forced cast on your own turn is rejected", () => {
    const own = pod('delirium-own-turn');
    spawn(own, 'P2', BRUTE('Lab Ogre', '3'));
    // On your own turn "that player" would be you, and you have a creature to aim it at.
    spawn(own, 'P1', BRUTE('Lab Mine', '1'));
    turnOf(own, 'P1');
    expect(deliriumOption(own).option).toBeUndefined();

    const theirs = pod('delirium-their-turn');
    const ogre = spawn(theirs, 'P2', BRUTE('Lab Ogre', '3'));
    turnOf(theirs, 'P2');
    const { option } = deliriumOption(theirs);
    expect(option).toBeDefined();
    const payload = option!.payload as PriorityActionPayload;
    const slot = option!.targets![0]!.slot;

    const later = pod('delirium-later-turn');
    spawn(later, 'P3', BRUTE('Lab Ogre', '3'));
    turnOf(later, 'P3');
    expect(deliriumOption(later).option).toBeDefined();

    // The same payload, forced on P1's own turn, is refused as it is cast.
    turnOf(theirs, 'P1');
    expect(() => takeAction(theirs, 'P1', payload, undefined, new Map([[slot, ogre.id]]))).toThrow(
      'casting restriction is not met',
    );
    expect(theirs.state.stack).toEqual([]);
  });

  it("delirium-target-active-player — the target must be a creature the player whose turn it is controls, not yours and not another player's", () => {
    const ctx = pod('delirium-target');
    const active = spawn(ctx, 'P2', BRUTE('Lab Active', '3'));
    const mine = spawn(ctx, 'P1', BRUTE('Lab Mine', '1'));
    const other = spawn(ctx, 'P3', BRUTE('Lab Bystander', '1'));
    turnOf(ctx, 'P2');
    const { option } = deliriumOption(ctx);
    expect(option!.targets![0]!.options).toEqual([active.id]);
    expect(option!.targets![0]!.options).not.toContain(mine.id);
    expect(option!.targets![0]!.options).not.toContain(other.id);

    // It stops being legal on resolution if the creature changes hands in response.
    const { object } = deliriumOption(ctx);
    const again = optionFor(ctx, 'P1', object.id)!;
    takeAction(
      ctx,
      'P1',
      again.payload as PriorityActionPayload,
      undefined,
      new Map([[again.targets![0]!.slot, active.id]]),
    );
    onField(ctx, active.cardId)!.controllerId = 'P3';
    resolveTop(ctx);
    expect(life(ctx, 'P3')).toBe(40);
    expect(onField(ctx, active.cardId)!.tapped).toBe(false);
    expect(ctx.state.damageShields).toEqual([]);
  });

  it('delirium-damage-by-creature — it taps the creature, which deals damage equal to its power to the player, as itself: lifelink gains its controller the life, and the power is the one on resolution', () => {
    const ctx = pod('delirium-damage');
    const ogre = spawn(ctx, 'P2', BRUTE('Lab Ogre', '3'));
    turnOf(ctx, 'P2');
    const { object, option } = deliriumOption(ctx);
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[option!.targets![0]!.slot, ogre.id]]),
    );
    onField(ctx, ogre.cardId)!.counters['+1/+1'] = 2;
    resolveTop(ctx);
    expect(onField(ctx, ogre.cardId)!.tapped).toBe(true);
    expect(life(ctx, 'P2')).toBe(35);
    expect(life(ctx, 'P1')).toBe(40);
    expect(damageEvents(ctx).map((e) => e.payload)).toMatchObject([
      { source: 'Lab Ogre', target: 'P2', amount: 5, combat: false },
    ]);
    expect(playerById(ctx, 'P1').graveyard.some((c) => c.cardId === object.cardId)).toBe(true);

    const leech = pod('delirium-lifelink');
    const lifelinker = spawn(leech, 'P2', BRUTE('Lab Leech', '3', 'Lifelink'));
    turnOf(leech, 'P2');
    cast(leech, lifelinker.id);
    expect(life(leech, 'P2')).toBe(40);
  });

  it('delirium-combat-shield — this turn the creature neither deals nor takes combat damage, while another attacker and noncombat damage are unaffected', () => {
    const ctx = pod('delirium-combat');
    const target = spawn(ctx, 'P2', BRUTE('Lab Target', '4', 'Haste'));
    const other = spawn(ctx, 'P2', BRUTE('Lab Other', '2', 'Haste'));
    const wall = spawn(ctx, 'P1', BRUTE('Lab Wall', '3'));
    const blocker = spawn(ctx, 'P1', BRUTE('Lab Second Wall', '3'));
    turnOf(ctx, 'P2');
    cast(ctx, target.id);
    // The Delirium damage came out of P2's own life.
    expect(life(ctx, 'P2')).toBe(36);
    // A tapped creature can't attack, so untap it to make it attack: the shield, not the tap, is under test.
    onField(ctx, target.cardId)!.tapped = false;
    combat(ctx, [target.id, other.id], { [wall.id]: target.id, [blocker.id]: other.id });
    // Dealt by the creature: the wall took nothing. Dealt to it: the wall's 3 did not mark it.
    expect(marked(ctx, wall)).toBe(0);
    expect(marked(ctx, target)).toBe(0);
    // The other attacker and its blocker traded normally.
    expect(marked(ctx, blocker)).toBe(2);
    expect(marked(ctx, other)).toBe(3);
    expect(life(ctx, 'P1')).toBe(40);

    // Unblocked, the creature deals no combat damage to the player either.
    const open = pod('delirium-unblocked');
    const raider = spawn(open, 'P2', BRUTE('Lab Raider', '4', 'Haste'));
    const free = spawn(open, 'P2', BRUTE('Lab Free', '2', 'Haste'));
    turnOf(open, 'P2');
    cast(open, raider.id);
    onField(open, raider.cardId)!.tapped = false;
    combat(open, [raider.id, free.id]);
    expect(life(open, 'P1')).toBe(38);

    // Noncombat damage to it is still dealt.
    const burned = pod('delirium-noncombat');
    const victim = spawn(burned, 'P2', BRUTE('Lab Victim', '3'));
    turnOf(burned, 'P2');
    cast(burned, victim.id);
    const spell = conjure(burned, 'P1', LAB_BOLT, 'hand');
    addMana(playerById(burned, 'P1'), red(1));
    const bolt = optionFor(burned, 'P1', spell.id)!;
    takeAction(
      burned,
      'P1',
      bolt.payload as PriorityActionPayload,
      undefined,
      new Map([[bolt.targets![0]!.slot, victim.id]]),
    );
    settle(burned);
    expect(marked(burned, victim)).toBe(3);
  });

  it('delirium-new-object — the shield is on that one object, so a creature that leaves and returns is no longer covered', () => {
    const ctx = pod('delirium-blink');
    const ogre = spawn(ctx, 'P2', BRUTE('Lab Ogre', '4', 'Haste'));
    turnOf(ctx, 'P2');
    cast(ctx, ogre.id);
    pump(moveObject(ctx, ogre, { zone: 'hand' }));
    const returned = playerById(ctx, 'P2').hand.find((c) => c.cardId === ogre.cardId)!;
    pump(moveObject(ctx, returned, { zone: 'battlefield', controllerId: 'P2' }));
    const fresh = onField(ctx, ogre.cardId)!;
    expect(fresh.id).not.toBe(ogre.id);
    combat(ctx, [fresh.id]);
    expect(life(ctx, 'P1')).toBe(36);
  });
});

// ---------------------------------------------------------------------------------------------
// Attack declaration helpers (cards that watch a whole attack)
// ---------------------------------------------------------------------------------------------

const WALKER = (name = 'Lab Walker') =>
  oracle({
    name,
    typeLine: 'Planeswalker — Lab',
    manaCost: '{3}',
    cmc: 3,
    loyalty: '5',
    oracleText: '',
  });
const GRIZZLY = (name: string) =>
  oracle({ name, typeLine: 'Creature — Bear', power: '2', toughness: '2' });

/** It is `playerId`'s turn, before combat. */
function turnOfPlayer(ctx: GameContext, playerId: string): void {
  ctx.state.currentTurnPlayer = playerId;
  ctx.state.activePlayerIndex = Number(playerId.slice(1)) - 1;
}

/**
 * The active player declares `attacks` (creature object id to a player id or planeswalker object
 * id; everything else stays home), nobody blocks, and every player passes, so triggers go on the
 * stack and resolve through the normal priority loop. `answer` takes any other decision.
 */
function declareAndFight(
  ctx: GameContext,
  attacks: Record<string, string>,
  answer?: Answer,
  blocks: Record<string, string> = {},
) {
  return pump(runCombatAndExtraCombats(ctx), (decision, count) => {
    if (decision.presentationAttackDeclaration !== undefined)
      return declareAttacks(decision, (subjectId) => attacks[subjectId] ?? null);
    if (decision.presentationBlockDeclaration !== undefined)
      return declareBlocks(decision, (subjectId) => blocks[subjectId] ?? null);
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    if (pass >= 0) return { index: pass, targets: new Map() };
    return answer?.(decision, count) ?? { index: 0, targets: new Map() };
  });
}

const ZAP = oracle({
  name: 'Lab Zap',
  typeLine: 'Instant',
  manaCost: '{0}',
  oracleText: 'Destroy target creature.',
});
const RAZE = oracle({
  name: 'Lab Raze',
  typeLine: 'Instant',
  manaCost: '{0}',
  oracleText: 'Destroy target planeswalker.',
});

/**
 * The active player declares `attacks`, `blocks` (blocker id to attacker id) stand, and P1 casts the
 * named instant at `target` the first time anything is on the stack, or, with `step`, the first time
 * P1 has priority in that step. Returns whether it was cast.
 */
function respondWith(
  ctx: GameContext,
  attacks: Record<string, string>,
  spell: string,
  target: string,
  opts: { step?: string; blocks?: Record<string, string> } = {},
): () => boolean {
  let cast = false;
  pump(runCombatAndExtraCombats(ctx), (decision) => {
    if (decision.presentationAttackDeclaration !== undefined)
      return declareAttacks(decision, (subjectId) => attacks[subjectId] ?? null);
    if (decision.presentationBlockDeclaration !== undefined)
      return declareBlocks(decision, (subjectId) => opts.blocks?.[subjectId] ?? null);
    const option = decision.options.findIndex(
      (candidate) => decision.player === 'P1' && candidate.description.includes(spell),
    );
    const ready =
      opts.step === undefined ? ctx.state.stack.length > 0 : ctx.state.step === opts.step;
    if (option >= 0 && !cast && ready) {
      cast = true;
      const slot = decision.options[option]!.targets![0]!;
      return { index: option, targets: new Map([[slot.slot, target]]) };
    }
    const pass = decision.options.findIndex((candidate) => candidate.type === 'pass');
    return { index: Math.max(pass, 0), targets: new Map() };
  });
  return () => cast;
}

const handSize = (ctx: GameContext, playerId: string) => playerById(ctx, playerId).hand.length;
const counterOf = (perm: EnginePermanent, kind = 'loyalty') => perm.counters[kind] ?? 0;

// ---------------------------------------------------------------------------------------------
// PR06.19 Firemane Commando
// ---------------------------------------------------------------------------------------------

describe('Firemane Commando', () => {
  const { card } = pinned('Firemane Commando');

  /** P1 controls the Commando; every player has `bears` Bears ready to attack. */
  function board(seed: string, bears = 2) {
    const ctx = pod(seed);
    const commando = spawn(ctx, 'P1', card);
    const bearsOf = Object.fromEntries(
      (['P1', 'P2', 'P3', 'P4'] as const).map((id) => [
        id,
        Array.from({ length: bears }, (_, i) => spawn(ctx, id, GRIZZLY(`Lab ${id} Bear ${i + 1}`))),
      ]),
    ) as Record<'P1' | 'P2' | 'P3' | 'P4', EnginePermanent[]>;
    return { ctx, commando, bearsOf };
  }
  const at = (creatures: EnginePermanent[], target: string) =>
    Object.fromEntries(creatures.map((c) => [c.id, target]));

  it('firemane-commando-pinned-oracle-supported — authored triggers watch a whole attack by you and by another player, the second drawing for the attacker unless none attacked you', () => {
    expectModeled(card);
    expect(getOverride(card.oracleId)?.unsupportedReason).toBeUndefined();
    expect(getOverride(fixtureOracleId(card.name))?.unsupportedReason).toBeUndefined();
    const def = interpretCard(card);
    expect(def.keywords).toContain('flying');
    expect(def.triggers.map((t) => t.trigger)).toEqual([
      { when: 'attackDeclared', attacker: 'you', minAttackers: 2 },
      { when: 'attackDeclared', attacker: 'otherPlayer', minAttackers: 2 },
    ]);
    expect(def.triggers[0]!.effects).toEqual([{ op: 'draw', count: { kind: 'const', n: 1 } }]);
    expect(def.triggers[1]!.effects).toEqual([
      {
        op: 'conditionalEffect',
        condition: { kind: 'attackWasNotAtYou' },
        then: [{ op: 'draw', count: { kind: 'const', n: 1 }, player: 'eventPlayer' }],
        else: [],
      },
    ]);
  });

  it('firemane-commando-own-attack — you draw once when you attack with two or more creatures, and not with one', () => {
    const one = board('firemane-one');
    declareAndFight(one.ctx, at([one.bearsOf.P1[0]!], 'P2'));
    expect(handSize(one.ctx, 'P1')).toBe(0);

    const two = board('firemane-two');
    declareAndFight(two.ctx, at(two.bearsOf.P1, 'P2'));
    expect(handSize(two.ctx, 'P1')).toBe(1);
    expect(two.ctx.state.stack).toEqual([]);

    // Two or more counts the whole attack, whatever each creature attacks: one trigger, one card.
    const split = board('firemane-split', 3);
    declareAndFight(split.ctx, {
      [split.bearsOf.P1[0]!.id]: 'P2',
      [split.bearsOf.P1[1]!.id]: 'P3',
      [split.bearsOf.P1[2]!.id]: 'P4',
    });
    expect(handSize(split.ctx, 'P1')).toBe(1);
  });

  it('firemane-commando-other-player-attack — another player attacking an opponent with two creatures draws a card for that player, while the controller draws nothing', () => {
    const { ctx, bearsOf } = board('firemane-other');
    turnOfPlayer(ctx, 'P2');
    declareAndFight(ctx, at(bearsOf.P2, 'P3'));
    expect(handSize(ctx, 'P2')).toBe(1);
    expect(handSize(ctx, 'P1')).toBe(0);
    expect(handSize(ctx, 'P3')).toBe(0);

    // One attacker is not two: no draw.
    const lone = board('firemane-other-one');
    turnOfPlayer(lone.ctx, 'P2');
    declareAndFight(lone.ctx, at([lone.bearsOf.P2[0]!], 'P3'));
    expect(handSize(lone.ctx, 'P2')).toBe(0);
  });

  it('firemane-commando-not-at-you — no card when any of those creatures attacked you, however the rest attacked', () => {
    const { ctx, bearsOf } = board('firemane-at-you');
    turnOfPlayer(ctx, 'P2');
    declareAndFight(ctx, {
      [bearsOf.P2[0]!.id]: 'P1',
      [bearsOf.P2[1]!.id]: 'P3',
    });
    expect(handSize(ctx, 'P2')).toBe(0);
    // The ability still triggered and went on the stack: it is a resolution check, not an intervening-if.
    expect(
      ctx.state.eventLog.filter(
        (e) => e.type === 'triggerOnStack' && e.payload['source'] === 'Firemane Commando',
      ),
    ).toHaveLength(1);
  });

  it('firemane-commando-planeswalker — attacking your planeswalker is not attacking you, so they draw', () => {
    const { ctx, bearsOf } = board('firemane-walker');
    const walker = spawn(ctx, 'P1', WALKER());
    turnOfPlayer(ctx, 'P2');
    declareAndFight(ctx, at(bearsOf.P2, walker.id));
    expect(handSize(ctx, 'P2')).toBe(1);
    expect(counterOf(walker)).toBe(1);
  });

  it('firemane-commando-snapshot — the check is on the declaration: the trigger goes on the stack even when it will draw nothing, and a creature destroyed in response still attacked you', () => {
    const triggered = (ctx: GameContext) =>
      ctx.state.eventLog.filter(
        (e) => e.type === 'triggerOnStack' && e.payload['source'] === 'Firemane Commando',
      ).length;

    const { ctx, bearsOf } = board('firemane-snapshot');
    turnOfPlayer(ctx, 'P2');
    declareAndFight(ctx, { [bearsOf.P2[0]!.id]: 'P1', [bearsOf.P2[1]!.id]: 'P3' });
    expect(triggered(ctx)).toBe(1);
    expect(handSize(ctx, 'P2')).toBe(0);

    // In response to the trigger, P1 destroys the one creature that attacked P1: it is gone from
    // combat, but it did attack P1, so P2 still draws nothing.
    let zapped = false;
    const later = board('firemane-snapshot-2');
    turnOfPlayer(later.ctx, 'P2');
    const [doomed, safe] = later.bearsOf.P2 as [EnginePermanent, EnginePermanent];
    conjure(later.ctx, 'P1', ZAP, 'hand');
    pump(runCombatAndExtraCombats(later.ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (id) =>
          id === doomed.id ? 'P1' : id === safe.id ? 'P3' : null,
        );
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      const zap = decision.options.findIndex(
        (option) => decision.player === 'P1' && option.description.includes('Lab Zap'),
      );
      if (zap >= 0 && !zapped && later.ctx.state.stack.length > 0) {
        zapped = true;
        const slot = decision.options[zap]!.targets![0]!;
        return { index: zap, targets: new Map([[slot.slot, doomed.id]]) };
      }
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    expect(zapped).toBe(true);
    expect(later.ctx.state.battlefield.includes(doomed)).toBe(false);
    expect(handSize(later.ctx, 'P2')).toBe(0);
  });

  it('firemane-commando-whole-game — the trigger goes on the stack as the attack is declared and resolves for the right player', () => {
    const { ctx, bearsOf } = board('firemane-game');
    declareAndFight(ctx, at(bearsOf.P1, 'P2'));
    const events = ctx.state.eventLog.filter(
      (e) => e.type === 'triggerOnStack' && e.payload['source'] === 'Firemane Commando',
    );
    expect(events).toHaveLength(1);
    expect(String(events[0]!.payload['description'])).toContain('two or more creatures');
    expect(handSize(ctx, 'P1')).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// PR06.03 Breena, the Demagogue
// ---------------------------------------------------------------------------------------------

describe('Breena, the Demagogue', () => {
  const { card } = pinned('Breena, the Demagogue');
  const BOLT = oracle({
    name: 'Lab Bolt',
    typeLine: 'Instant',
    manaCost: '{0}',
    oracleText: 'Lab Bolt deals 3 damage to any target.',
  });

  /** P1 controls Breena and an Ally; P2, P3 and P4 are at 30, 20 and `p4` life, with a Bear each. */
  function board(seed: string, p4 = 20) {
    const ctx = pod(seed);
    const breena = spawn(ctx, 'P1', card);
    const ally = spawn(ctx, 'P1', GRIZZLY('Lab Ally'));
    const bears = Object.fromEntries(
      (['P1', 'P2', 'P3', 'P4'] as const).map((id) => [
        id,
        spawn(ctx, id, GRIZZLY(`Lab ${id} Bear`)),
      ]),
    ) as Record<'P1' | 'P2' | 'P3' | 'P4', EnginePermanent>;
    playerById(ctx, 'P2').life = 30;
    playerById(ctx, 'P3').life = 20;
    playerById(ctx, 'P4').life = p4;
    return { ctx, breena, ally, bears };
  }
  /** Choose the Ally for the counters. */
  const toAlly =
    (ally: EnginePermanent): Answer =>
    (decision) => ({
      index: Math.max(
        decision.options.findIndex((option) => option.description.includes(ally.name)),
        0,
      ),
      targets: new Map(),
    });
  const counters = (perm: EnginePermanent) => perm.counters['+1/+1'] ?? 0;

  it('breena-pinned-oracle-supported — the override reads one attack trigger per attacked opponent of yours, intervening-if on that opponent’s life, drawing for the attacking player and putting counters on a creature you choose', () => {
    expectModeled(card);
    expect(getOverride(card.oracleId)?.unsupportedReason).toBeUndefined();
    expect(getOverride(fixtureOracleId(card.name))?.unsupportedReason).toBeUndefined();
    const def = interpretCard(card);
    expect(def.keywords).toContain('flying');
    expect(def.triggers).toHaveLength(1);
    const [trigger] = def.triggers;
    expect(trigger!.trigger).toEqual({
      when: 'attackDeclared',
      attacker: 'any',
      attacking: { who: 'opponent', planeswalkers: false },
      perDefender: true,
      condition: { kind: 'attackedPlayerHasMoreLifeThanAnotherOpponent' },
    });
    expect(trigger!.effects).toEqual([
      { op: 'draw', count: { kind: 'const', n: 1 }, player: 'eventPlayer' },
      { op: 'putCountersOnCreatureOfChoice', counter: '+1/+1', count: 2 },
    ]);
  });

  it('breena-more-life — another player attacking the opponent with more life draws that player a card and puts two counters on your creature; attacking one with no more life does neither', () => {
    const high = board('breena-high');
    turnOfPlayer(high.ctx, 'P3');
    declareAndFight(high.ctx, { [high.bears.P3.id]: 'P2' }, toAlly(high.ally));
    expect(handSize(high.ctx, 'P3')).toBe(1);
    expect(handSize(high.ctx, 'P1')).toBe(0);
    expect(counters(high.ally)).toBe(2);
    expect(counters(high.breena)).toBe(0);

    // P3 (20) is tied with P4 (20): no more life than another of your opponents.
    const low = board('breena-low');
    turnOfPlayer(low.ctx, 'P2');
    declareAndFight(low.ctx, { [low.bears.P2.id]: 'P3' }, toAlly(low.ally));
    expect(handSize(low.ctx, 'P2')).toBe(0);
    expect(counters(low.ally)).toBe(0);
  });

  it('breena-you-attack — you attack the opponent with more life: you draw as the attacking player', () => {
    const { ctx, ally, bears } = board('breena-self');
    declareAndFight(ctx, { [bears.P1.id]: 'P2' }, toAlly(ally));
    expect(handSize(ctx, 'P1')).toBe(1);
    expect(counters(ally)).toBe(2);
  });

  it('breena-planeswalker — attacking an opponent’s planeswalker is not attacking that opponent', () => {
    const { ctx, ally, bears } = board('breena-walker');
    const walker = spawn(ctx, 'P2', WALKER());
    turnOfPlayer(ctx, 'P3');
    declareAndFight(ctx, { [bears.P3.id]: walker.id }, toAlly(ally));
    expect(handSize(ctx, 'P3')).toBe(0);
    expect(counters(ally)).toBe(0);
    expect(counterOf(walker)).toBe(3);
  });

  it('breena-per-opponent — one attack on two of your opponents triggers once for each that qualifies', () => {
    const { ctx, ally, bears } = board('breena-two', 25);
    const extra = spawn(ctx, 'P3', GRIZZLY('Lab P3 Second Bear'));
    turnOfPlayer(ctx, 'P3');
    declareAndFight(ctx, { [bears.P3.id]: 'P2', [extra.id]: 'P4' }, toAlly(ally));
    // P2 (30) and P4 (25) both have more life than P3 (20): two triggers, two draws.
    expect(handSize(ctx, 'P3')).toBe(2);
    expect(counters(ally)).toBe(4);
    expect(
      ctx.state.eventLog.filter(
        (e) => e.type === 'triggerOnStack' && e.payload['source'] === 'Breena, the Demagogue',
      ),
    ).toHaveLength(2);

    // Two attackers on one opponent are one trigger.
    const same = board('breena-same');
    const second = spawn(same.ctx, 'P3', GRIZZLY('Lab P3 Second Bear'));
    turnOfPlayer(same.ctx, 'P3');
    declareAndFight(same.ctx, { [same.bears.P3.id]: 'P2', [second.id]: 'P2' }, toAlly(same.ally));
    expect(handSize(same.ctx, 'P3')).toBe(1);
  });

  it('breena-intervening-if — checked again as the ability resolves: if that opponent no longer has more life, nothing happens', () => {
    const { ctx, ally, bears } = board('breena-resolve');
    playerById(ctx, 'P2').life = 22;
    conjure(ctx, 'P1', BOLT, 'hand');
    turnOfPlayer(ctx, 'P3');
    let bolted = false;
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (id) => (id === bears.P3.id ? 'P2' : null));
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      const bolt = decision.options.findIndex(
        (option) => decision.player === 'P1' && option.description.includes('Lab Bolt'),
      );
      if (bolt >= 0 && !bolted && ctx.state.stack.length > 0) {
        bolted = true;
        const slot = decision.options[bolt]!.targets![0]!;
        return { index: bolt, targets: new Map([[slot.slot, 'P2']]) };
      }
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    expect(bolted).toBe(true);
    // 22 less the Bolt's 3, less the unblocked Bear's 2.
    expect(playerById(ctx, 'P2').life).toBe(17);
    expect(handSize(ctx, 'P3')).toBe(0);
    expect(counters(ally)).toBe(0);
  });

  it('breena-no-creature — with no other creature of yours, Breena herself is the creature the counters go on', () => {
    const { ctx, breena, ally, bears } = board('breena-none');
    pump(moveObject(ctx, ally, { zone: 'graveyard' }));
    turnOfPlayer(ctx, 'P3');
    declareAndFight(ctx, { [bears.P3.id]: 'P2' });
    expect(counters(breena)).toBe(2);
    expect(handSize(ctx, 'P3')).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// PR06.22 Ever-Watching Threshold
// ---------------------------------------------------------------------------------------------

describe('Ever-Watching Threshold', () => {
  const { card } = pinned('Ever-Watching Threshold');

  /** P1 controls the Threshold; each other player has two Bears. */
  function board(seed: string) {
    const ctx = pod(seed);
    spawn(ctx, 'P1', card);
    const mine = spawn(ctx, 'P1', GRIZZLY('Lab P1 Bear'));
    const bears = Object.fromEntries(
      (['P2', 'P3', 'P4'] as const).map((id) => [
        id,
        [spawn(ctx, id, GRIZZLY(`Lab ${id} Bear 1`)), spawn(ctx, id, GRIZZLY(`Lab ${id} Bear 2`))],
      ]),
    ) as Record<'P2' | 'P3' | 'P4', EnginePermanent[]>;
    return { ctx, mine, bears };
  }
  const triggers = (ctx: GameContext) =>
    ctx.state.eventLog.filter(
      (e) => e.type === 'triggerOnStack' && e.payload['source'] === 'Ever-Watching Threshold',
    ).length;

  it('ever-watching-threshold-pinned-oracle-supported — the override reads one attack trigger for an opponent with an intervening-if on their attackers attacking you or your planeswalkers', () => {
    expectModeled(card);
    expect(getOverride(card.oracleId)?.unsupportedReason).toBeUndefined();
    expect(getOverride(fixtureOracleId(card.name))?.unsupportedReason).toBeUndefined();
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toEqual({
      when: 'attackDeclared',
      attacker: 'opponent',
      condition: { kind: 'attackGroupAttackingYou', planeswalkers: true, cmp: '>=', n: 1 },
    });
    expect(def.triggers[0]!.effects).toEqual([{ op: 'draw', count: { kind: 'const', n: 1 } }]);
  });

  it('ever-watching-threshold-attacks-you — you draw once when an opponent attacks you, however many creatures, and not when they attack someone else or you attack', () => {
    const one = board('ewt-one');
    turnOfPlayer(one.ctx, 'P2');
    declareAndFight(one.ctx, { [one.bears.P2[0]!.id]: 'P1' });
    expect(handSize(one.ctx, 'P1')).toBe(1);

    const two = board('ewt-two');
    turnOfPlayer(two.ctx, 'P2');
    declareAndFight(two.ctx, { [two.bears.P2[0]!.id]: 'P1', [two.bears.P2[1]!.id]: 'P1' });
    expect(handSize(two.ctx, 'P1')).toBe(1);
    expect(triggers(two.ctx)).toBe(1);

    const elsewhere = board('ewt-elsewhere');
    turnOfPlayer(elsewhere.ctx, 'P2');
    declareAndFight(elsewhere.ctx, { [elsewhere.bears.P2[0]!.id]: 'P3' });
    expect(handSize(elsewhere.ctx, 'P1')).toBe(0);
    // The ability's condition is false, so it never even goes on the stack.
    expect(triggers(elsewhere.ctx)).toBe(0);

    const mine = board('ewt-mine');
    declareAndFight(mine.ctx, { [mine.mine.id]: 'P2' });
    expect(handSize(mine.ctx, 'P1')).toBe(0);
  });

  it('ever-watching-threshold-planeswalker — attacking a planeswalker you control counts, attacking another player’s does not', () => {
    const yours = board('ewt-walker');
    const walker = spawn(yours.ctx, 'P1', WALKER());
    turnOfPlayer(yours.ctx, 'P3');
    declareAndFight(yours.ctx, { [yours.bears.P3[0]!.id]: walker.id });
    expect(handSize(yours.ctx, 'P1')).toBe(1);
    expect(counterOf(walker)).toBe(3);

    const theirs = board('ewt-their-walker');
    const other = spawn(theirs.ctx, 'P4', WALKER());
    turnOfPlayer(theirs.ctx, 'P3');
    declareAndFight(theirs.ctx, { [theirs.bears.P3[0]!.id]: other.id });
    expect(handSize(theirs.ctx, 'P1')).toBe(0);

    // One attacker at you and one elsewhere is still one card.
    const mixed = board('ewt-mixed');
    turnOfPlayer(mixed.ctx, 'P4');
    declareAndFight(mixed.ctx, {
      [mixed.bears.P4[0]!.id]: 'P1',
      [mixed.bears.P4[1]!.id]: 'P2',
    });
    expect(handSize(mixed.ctx, 'P1')).toBe(1);
  });

  it('ever-watching-threshold-resolution-check — checked again as it resolves: if every creature attacking you is gone, or its planeswalker is, nothing is drawn', () => {
    const gone = board('ewt-gone');
    conjure(gone.ctx, 'P1', ZAP, 'hand');
    turnOfPlayer(gone.ctx, 'P2');
    const [doomed, safe] = gone.bears.P2 as [EnginePermanent, EnginePermanent];
    const zapped = respondWith(
      gone.ctx,
      { [doomed.id]: 'P1', [safe.id]: 'P3' },
      'Lab Zap',
      doomed.id,
    );
    expect(zapped()).toBe(true);
    expect(handSize(gone.ctx, 'P1')).toBe(0);
    expect(gone.ctx.state.eventLog.some((e) => e.type === 'triggerConditionFailed')).toBe(true);

    // Only the creature attacking the planeswalker counted; the planeswalker is destroyed.
    const walked = board('ewt-walker-gone');
    const walker = spawn(walked.ctx, 'P1', WALKER());
    conjure(walked.ctx, 'P1', RAZE, 'hand');
    turnOfPlayer(walked.ctx, 'P2');
    const razed = respondWith(
      walked.ctx,
      { [walked.bears.P2[0]!.id]: walker.id },
      'Lab Raze',
      walker.id,
    );
    expect(razed()).toBe(true);
    expect(walked.ctx.state.battlefield.includes(walker)).toBe(false);
    expect(handSize(walked.ctx, 'P1')).toBe(0);
    expect(walked.ctx.state.eventLog.some((e) => e.type === 'triggerConditionFailed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// PR06.08 Mangara, the Diplomat
// ---------------------------------------------------------------------------------------------

describe('Mangara, the Diplomat', () => {
  const { card } = pinned('Mangara, the Diplomat');
  const CANTRIP = oracle({
    name: 'Lab Sip',
    typeLine: 'Instant',
    manaCost: '{0}',
    oracleText: 'You gain 1 life.',
  });

  /** P1 controls Mangara; each other player has three Bears. */
  function board(seed: string) {
    const ctx = pod(seed);
    const mangara = spawn(ctx, 'P1', card);
    const mine = spawn(ctx, 'P1', GRIZZLY('Lab P1 Bear'));
    const bears = Object.fromEntries(
      (['P2', 'P3', 'P4'] as const).map((id) => [
        id,
        [1, 2, 3].map((n) => spawn(ctx, id, GRIZZLY(`Lab ${id} Bear ${n}`))),
      ]),
    ) as Record<'P2' | 'P3' | 'P4', EnginePermanent[]>;
    return { ctx, mangara, mine, bears };
  }
  const triggers = (ctx: GameContext) =>
    ctx.state.eventLog.filter(
      (e) => e.type === 'triggerOnStack' && e.payload['source'] === 'Mangara, the Diplomat',
    ).length;

  it('mangara-pinned-oracle-supported — the interpreter reads lifelink and the second-spell line, and the override adds one attack trigger with an intervening-if on two or more attackers at you or your planeswalkers', () => {
    expectModeled(card);
    expect(getOverride(card.oracleId)?.unsupportedReason).toBeUndefined();
    expect(getOverride(fixtureOracleId(card.name))?.unsupportedReason).toBeUndefined();
    const def = interpretCard(card);
    expect(def.keywords).toContain('lifelink');
    const heads = def.triggers.map((t) => t.trigger);
    expect(heads).toContainEqual({
      when: 'attackDeclared',
      attacker: 'opponent',
      condition: { kind: 'attackGroupAttackingYou', planeswalkers: true, cmp: '>=', n: 2 },
    });
    expect(heads).toContainEqual(
      expect.objectContaining({ when: 'castsSpell', caster: 'opponent', ordinal: 2 }),
    );
    expect(def.triggers).toHaveLength(2);
  });

  it('mangara-two-attackers — you draw when an opponent attacks you with two or more creatures, and not with one, or with two split between you and someone else', () => {
    const two = board('mangara-two');
    turnOfPlayer(two.ctx, 'P2');
    declareAndFight(two.ctx, { [two.bears.P2[0]!.id]: 'P1', [two.bears.P2[1]!.id]: 'P1' });
    expect(handSize(two.ctx, 'P1')).toBe(1);
    expect(triggers(two.ctx)).toBe(1);

    const three = board('mangara-three');
    turnOfPlayer(three.ctx, 'P2');
    declareAndFight(three.ctx, {
      [three.bears.P2[0]!.id]: 'P1',
      [three.bears.P2[1]!.id]: 'P1',
      [three.bears.P2[2]!.id]: 'P1',
    });
    expect(handSize(three.ctx, 'P1')).toBe(1);

    const one = board('mangara-one');
    turnOfPlayer(one.ctx, 'P2');
    declareAndFight(one.ctx, { [one.bears.P2[0]!.id]: 'P1' });
    expect(handSize(one.ctx, 'P1')).toBe(0);
    expect(triggers(one.ctx)).toBe(0);

    const split = board('mangara-split');
    turnOfPlayer(split.ctx, 'P2');
    declareAndFight(split.ctx, { [split.bears.P2[0]!.id]: 'P1', [split.bears.P2[1]!.id]: 'P3' });
    expect(handSize(split.ctx, 'P1')).toBe(0);

    const mine = board('mangara-own');
    declareAndFight(mine.ctx, { [mine.mine.id]: 'P2' });
    expect(handSize(mine.ctx, 'P1')).toBe(0);
  });

  it('mangara-planeswalkers — attackers at you and/or your planeswalkers together make two, while attackers at another player’s planeswalker do not count', () => {
    const mixed = board('mangara-mixed');
    const walker = spawn(mixed.ctx, 'P1', WALKER());
    turnOfPlayer(mixed.ctx, 'P3');
    declareAndFight(mixed.ctx, {
      [mixed.bears.P3[0]!.id]: 'P1',
      [mixed.bears.P3[1]!.id]: walker.id,
    });
    expect(handSize(mixed.ctx, 'P1')).toBe(1);

    const onlyWalker = board('mangara-walker');
    const mine = spawn(onlyWalker.ctx, 'P1', WALKER());
    turnOfPlayer(onlyWalker.ctx, 'P3');
    declareAndFight(onlyWalker.ctx, {
      [onlyWalker.bears.P3[0]!.id]: mine.id,
      [onlyWalker.bears.P3[1]!.id]: mine.id,
    });
    expect(handSize(onlyWalker.ctx, 'P1')).toBe(1);

    const theirs = board('mangara-their-walker');
    const other = spawn(theirs.ctx, 'P4', WALKER());
    turnOfPlayer(theirs.ctx, 'P3');
    declareAndFight(theirs.ctx, {
      [theirs.bears.P3[0]!.id]: 'P1',
      [theirs.bears.P3[1]!.id]: other.id,
    });
    expect(handSize(theirs.ctx, 'P1')).toBe(0);
  });

  it('mangara-resolution-check — checked again as it resolves: a creature destroyed, or whose planeswalker is, no longer counts', () => {
    const gone = board('mangara-gone');
    conjure(gone.ctx, 'P1', ZAP, 'hand');
    turnOfPlayer(gone.ctx, 'P2');
    const [first, second] = gone.bears.P2 as [EnginePermanent, EnginePermanent, EnginePermanent];
    const zapped = respondWith(
      gone.ctx,
      { [first.id]: 'P1', [second.id]: 'P1' },
      'Lab Zap',
      first.id,
    );
    expect(zapped()).toBe(true);
    expect(handSize(gone.ctx, 'P1')).toBe(0);
    expect(gone.ctx.state.eventLog.some((e) => e.type === 'triggerConditionFailed')).toBe(true);

    const walked = board('mangara-walker-gone');
    const walker = spawn(walked.ctx, 'P1', WALKER());
    conjure(walked.ctx, 'P1', RAZE, 'hand');
    turnOfPlayer(walked.ctx, 'P2');
    const razed = respondWith(
      walked.ctx,
      { [walked.bears.P2[0]!.id]: 'P1', [walked.bears.P2[1]!.id]: walker.id },
      'Lab Raze',
      walker.id,
    );
    expect(razed()).toBe(true);
    expect(handSize(walked.ctx, 'P1')).toBe(0);
  });

  it('mangara-second-spell — you draw when an opponent casts their second spell each turn, and not their first or third, or your own', () => {
    const ctx = board('mangara-spells').ctx;
    turnOfPlayer(ctx, 'P2');
    const cast = () => {
      const object = conjure(ctx, 'P2', CANTRIP, 'hand');
      const option = optionFor(ctx, 'P2', object.id);
      expect(option, 'P2 casts Lab Sip').toBeDefined();
      takeAction(ctx, 'P2', option!.payload as PriorityActionPayload);
      settle(ctx);
    };
    cast();
    expect(handSize(ctx, 'P1')).toBe(0);
    cast();
    expect(handSize(ctx, 'P1')).toBe(1);
    cast();
    expect(handSize(ctx, 'P1')).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// PR06.21 Tomik, Wielder of Law
// ---------------------------------------------------------------------------------------------

describe('Tomik, Wielder of Law', () => {
  const { card } = pinned('Tomik, Wielder of Law');
  const W = { symbol: 'W' as const };
  const B = { symbol: 'B' as const };

  /** P1 controls Tomik; each other player has two Bears. */
  function board(seed: string) {
    const ctx = pod(seed);
    const tomik = spawn(ctx, 'P1', card);
    const bears = Object.fromEntries(
      (['P2', 'P3', 'P4'] as const).map((id) => [
        id,
        [1, 2].map((n) => spawn(ctx, id, GRIZZLY(`Lab ${id} Bear ${n}`))),
      ]),
    ) as Record<'P2' | 'P3' | 'P4', EnginePermanent[]>;
    return { ctx, tomik, bears };
  }
  const life = (ctx: GameContext, id: string) => playerById(ctx, id).life;

  it('tomik-pinned-oracle-supported — the interpreter reads affinity for planeswalkers and flying and vigilance, and the override adds the attack trigger that drains the attacking opponent and draws', () => {
    expectModeled(card);
    expect(getOverride(card.oracleId)?.unsupportedReason).toBeUndefined();
    expect(getOverride(fixtureOracleId(card.name))?.unsupportedReason).toBeUndefined();
    const def = interpretCard(card);
    expect(def.keywords).toEqual(expect.arrayContaining(['flying', 'vigilance']));
    expect(def.ruleStatics).toEqual([
      {
        kind: 'costReduction',
        amount: {
          kind: 'countPermanents',
          selector: {
            kind: 'allOf',
            of: [
              { kind: 'type', value: 'Planeswalker' },
              { kind: 'controller', who: 'you' },
            ],
          },
          scope: 'all',
        },
        selfOnly: true,
      },
    ]);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toEqual({
      when: 'attackDeclared',
      attacker: 'opponent',
      condition: { kind: 'attackGroupAttackingYou', planeswalkers: true, cmp: '>=', n: 2 },
    });
    expect(def.triggers[0]!.effects).toEqual([
      { op: 'loseLifeTarget', target: 'eventPlayer', amount: { kind: 'const', n: 3 } },
      { op: 'draw', count: { kind: 'const', n: 1 } },
    ]);
  });

  it('tomik-affinity — it costs {1} less for each planeswalker you control, for generic mana only', () => {
    const none = pod('tomik-cost-none');
    const inHand = conjure(none, 'P1', card, 'hand');
    addMana(playerById(none, 'P1'), [W, B]);
    expect(
      optionFor(none, 'P1', inHand.id),
      'no planeswalker: {1}{W}{B} unaffordable',
    ).toBeUndefined();

    const one = pod('tomik-cost-one');
    spawn(one, 'P1', WALKER());
    castFromHand(one, 'P1', card, [W, B]);
    resolveTop(one);
    expect(one.state.battlefield.some((p) => p.name === card.name)).toBe(true);

    // Two planeswalkers reduce only the generic {1}: {W}{B} is still owed.
    const two = pod('tomik-cost-two');
    spawn(two, 'P1', WALKER('Lab Walker One'));
    spawn(two, 'P1', WALKER('Lab Walker Two'));
    const other = conjure(two, 'P1', card, 'hand');
    addMana(playerById(two, 'P1'), [W]);
    expect(optionFor(two, 'P1', other.id), 'only {W}').toBeUndefined();
    // An opponent's planeswalker does not count.
    const theirs = pod('tomik-cost-theirs');
    spawn(theirs, 'P2', WALKER());
    const third = conjure(theirs, 'P1', card, 'hand');
    addMana(playerById(theirs, 'P1'), [W, B]);
    expect(optionFor(theirs, 'P1', third.id)).toBeUndefined();
  });

  it('tomik-attack-trigger — an opponent attacking you with two or more creatures loses 3 life and you draw; one attacker, or an attack elsewhere, does neither', () => {
    const two = board('tomik-two');
    turnOfPlayer(two.ctx, 'P2');
    declareAndFight(two.ctx, { [two.bears.P2[0]!.id]: 'P1', [two.bears.P2[1]!.id]: 'P1' });
    expect(life(two.ctx, 'P2')).toBe(37);
    expect(handSize(two.ctx, 'P1')).toBe(1);
    // Nobody else is touched: only the attacking opponent loses life.
    expect(life(two.ctx, 'P3')).toBe(40);

    const one = board('tomik-one');
    turnOfPlayer(one.ctx, 'P2');
    declareAndFight(one.ctx, { [one.bears.P2[0]!.id]: 'P1' });
    expect(life(one.ctx, 'P2')).toBe(40);
    expect(handSize(one.ctx, 'P1')).toBe(0);

    const elsewhere = board('tomik-elsewhere');
    turnOfPlayer(elsewhere.ctx, 'P3');
    declareAndFight(elsewhere.ctx, {
      [elsewhere.bears.P3[0]!.id]: 'P2',
      [elsewhere.bears.P3[1]!.id]: 'P2',
    });
    expect(life(elsewhere.ctx, 'P3')).toBe(40);
    expect(handSize(elsewhere.ctx, 'P1')).toBe(0);
  });

  it('tomik-planeswalkers — attackers at you and/or your planeswalkers count together, and a creature removed from combat no longer counts on resolution', () => {
    const mixed = board('tomik-mixed');
    const walker = spawn(mixed.ctx, 'P1', WALKER());
    turnOfPlayer(mixed.ctx, 'P4');
    declareAndFight(mixed.ctx, {
      [mixed.bears.P4[0]!.id]: 'P1',
      [mixed.bears.P4[1]!.id]: walker.id,
    });
    expect(life(mixed.ctx, 'P4')).toBe(37);
    expect(handSize(mixed.ctx, 'P1')).toBe(1);

    const gone = board('tomik-gone');
    conjure(gone.ctx, 'P1', ZAP, 'hand');
    turnOfPlayer(gone.ctx, 'P2');
    const [first, second] = gone.bears.P2 as [EnginePermanent, EnginePermanent];
    const zapped = respondWith(
      gone.ctx,
      { [first.id]: 'P1', [second.id]: 'P1' },
      'Lab Zap',
      first.id,
    );
    expect(zapped()).toBe(true);
    expect(life(gone.ctx, 'P2')).toBe(40);
    expect(handSize(gone.ctx, 'P1')).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// PR06.23 Frontier Warmonger
// ---------------------------------------------------------------------------------------------

describe('Frontier Warmonger', () => {
  const { card } = pinned('Frontier Warmonger');

  /** P1 controls the Warmonger and a Bear; each other player has two Bears. */
  function board(seed: string) {
    const ctx = pod(seed);
    const warmonger = spawn(ctx, 'P1', card);
    const mine = spawn(ctx, 'P1', GRIZZLY('Lab P1 Bear'));
    const bears = Object.fromEntries(
      (['P2', 'P3', 'P4'] as const).map((id) => [
        id,
        [1, 2].map((n) => spawn(ctx, id, GRIZZLY(`Lab ${id} Bear ${n}`))),
      ]),
    ) as Record<'P2' | 'P3' | 'P4', EnginePermanent[]>;
    return { ctx, warmonger, mine, bears };
  }
  const triggers = (ctx: GameContext) =>
    ctx.state.eventLog.filter(
      (e) => e.type === 'triggerOnStack' && e.payload['source'] === 'Frontier Warmonger',
    ).length;
  /** Which of `creatures` have menace as the blockers are declared, that is during combat. */
  function menaceAtBlocks(ctx: GameContext, attacks: Record<string, string>, ids: string[]) {
    const seen = new Set<string>();
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId) => attacks[subjectId] ?? null);
      if (decision.presentationBlockDeclaration !== undefined) {
        for (const id of ids) {
          const perm = ctx.state.battlefield.find((p) => p.id === id);
          if (perm !== undefined && hasKeyword(ctx, perm, 'menace')) seen.add(id);
        }
        return declareBlocks(decision, () => null);
      }
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    return seen;
  }

  it('frontier-warmonger-pinned-oracle-supported — the override reads one attack trigger per attacked opponent of yours, counting planeswalker attacks, granting menace to exactly that group', () => {
    expectModeled(card);
    expect(getOverride(card.oracleId)?.unsupportedReason).toBeUndefined();
    expect(getOverride(fixtureOracleId(card.name))?.unsupportedReason).toBeUndefined();
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toEqual({
      when: 'attackDeclared',
      attacker: 'any',
      attacking: { who: 'opponent', planeswalkers: true },
      perDefender: true,
    });
    expect(def.triggers[0]!.effects).toEqual([
      { op: 'grantKeywordToAttackGroupUntilEot', keyword: 'menace' },
    ]);
  });

  it('frontier-warmonger-group — the creatures attacking an opponent of yours gain menace, and creatures attacking you or another target do not', () => {
    const { ctx, bears } = board('warmonger-group');
    turnOfPlayer(ctx, 'P2');
    const [first, second] = bears.P2 as [EnginePermanent, EnginePermanent];
    const seen = menaceAtBlocks(ctx, { [first.id]: 'P3', [second.id]: 'P1' }, [
      first.id,
      second.id,
    ]);
    expect([...seen]).toEqual([first.id]);
    expect(triggers(ctx)).toBe(1);

    // You are not your own opponent: your creatures attacking an opponent do get menace.
    const mine = board('warmonger-mine');
    const seenMine = menaceAtBlocks(mine.ctx, { [mine.mine.id]: 'P2' }, [mine.mine.id]);
    expect([...seenMine]).toEqual([mine.mine.id]);
  });

  it('frontier-warmonger-per-opponent — one attack on two opponents triggers once for each group, and one on a single opponent is one trigger for all its attackers', () => {
    const split = board('warmonger-split');
    turnOfPlayer(split.ctx, 'P2');
    const [a, b] = split.bears.P2 as [EnginePermanent, EnginePermanent];
    const seenSplit = menaceAtBlocks(split.ctx, { [a.id]: 'P3', [b.id]: 'P4' }, [a.id, b.id]);
    expect(seenSplit.size).toBe(2);
    expect(triggers(split.ctx)).toBe(2);

    const same = board('warmonger-same');
    turnOfPlayer(same.ctx, 'P2');
    const [c, d] = same.bears.P2 as [EnginePermanent, EnginePermanent];
    const seenSame = menaceAtBlocks(same.ctx, { [c.id]: 'P3', [d.id]: 'P3' }, [c.id, d.id]);
    expect(seenSame.size).toBe(2);
    expect(triggers(same.ctx)).toBe(1);
  });

  it('frontier-warmonger-planeswalker — attacking an opponent’s planeswalker counts, attacking your own planeswalker does not', () => {
    const theirs = board('warmonger-their-walker');
    const walker = spawn(theirs.ctx, 'P3', WALKER());
    turnOfPlayer(theirs.ctx, 'P2');
    const bear = theirs.bears.P2[0]!;
    expect([...menaceAtBlocks(theirs.ctx, { [bear.id]: walker.id }, [bear.id])]).toEqual([bear.id]);

    const mine = board('warmonger-my-walker');
    const own = spawn(mine.ctx, 'P1', WALKER());
    turnOfPlayer(mine.ctx, 'P2');
    const other = mine.bears.P2[0]!;
    expect(menaceAtBlocks(mine.ctx, { [other.id]: own.id }, [other.id]).size).toBe(0);
    expect(triggers(mine.ctx)).toBe(0);
  });

  it('frontier-warmonger-binding — the group is bound when it triggers: if one of those creatures is destroyed in response the rest still gain menace, a creature that entered later does not, and it all ends with the turn', () => {
    const { ctx, bears } = board('warmonger-bound');
    conjure(ctx, 'P1', ZAP, 'hand');
    turnOfPlayer(ctx, 'P2');
    const [first, second] = bears.P2 as [EnginePermanent, EnginePermanent];
    const late = spawn(ctx, 'P2', GRIZZLY('Lab Late Bear'));
    let zapped = false;
    let menaceAtBlocks: boolean[] = [];
    pump(runTurn(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (id) =>
          id === first.id || id === second.id ? 'P3' : null,
        );
      if (decision.presentationBlockDeclaration !== undefined) {
        menaceAtBlocks = [hasKeyword(ctx, second, 'menace'), hasKeyword(ctx, late, 'menace')];
        return declareBlocks(decision, () => null);
      }
      const zap = decision.options.findIndex(
        (option) => decision.player === 'P1' && option.description.includes('Lab Zap'),
      );
      if (zap >= 0 && !zapped && ctx.state.stack.length > 0) {
        zapped = true;
        const slot = decision.options[zap]!.targets![0]!;
        return { index: zap, targets: new Map([[slot.slot, first.id]]) };
      }
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    expect(zapped).toBe(true);
    expect(ctx.state.battlefield.includes(first)).toBe(false);
    expect(menaceAtBlocks).toEqual([true, false]);
    // Until end of turn: the turn is over and the grant is gone.
    expect(hasKeyword(ctx, second, 'menace')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// PR06.28 Tenuous Truce
// ---------------------------------------------------------------------------------------------

describe('Tenuous Truce', () => {
  const { card } = pinned('Tenuous Truce');

  /** P1's Truce enchanting P2; every player has a Bear and P1 and P3 a planeswalker. */
  function board(seed: string) {
    const ctx = pod(seed);
    const aura = spawn(ctx, 'P1', card);
    aura.attachedTo = 'P2';
    const bears = Object.fromEntries(
      (['P1', 'P2', 'P3', 'P4'] as const).map((id) => [
        id,
        spawn(ctx, id, GRIZZLY(`Lab ${id} Bear`)),
      ]),
    ) as Record<'P1' | 'P2' | 'P3' | 'P4', EnginePermanent>;
    const walkers = {
      P1: spawn(ctx, 'P1', WALKER('Lab P1 Walker')),
      P2: spawn(ctx, 'P2', WALKER('Lab P2 Walker')),
      P3: spawn(ctx, 'P3', WALKER('Lab P3 Walker')),
    };
    return { ctx, aura, bears, walkers };
  }
  const present = (ctx: GameContext, aura: EnginePermanent) => ctx.state.battlefield.includes(aura);
  /** `playerId`'s whole turn, attacking with `attacks`; nobody blocks. */
  function turnWith(ctx: GameContext, playerId: string, attacks: Record<string, string> = {}) {
    turnOfPlayer(ctx, playerId);
    pump(runTurn(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (id) => attacks[id] ?? null);
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
  }

  it('tenuous-truce-pinned-oracle-supported — the interpreter reads Enchant opponent, and the override adds the enchanted end-step draw and two attack triggers that sacrifice the Aura', () => {
    expectModeled(card);
    expect(getOverride(card.oracleId)?.unsupportedReason).toBeUndefined();
    expect(getOverride(fixtureOracleId(card.name))?.unsupportedReason).toBeUndefined();
    const def = interpretCard(card);
    expect(def.spellAbility?.targets).toEqual([{ kind: 'player', controller: 'opponent' }]);
    expect(def.triggers.map((t) => t.trigger)).toEqual([
      { when: 'endStep', player: 'enchanted' },
      {
        when: 'attackDeclared',
        attacker: 'you',
        attacking: { who: 'enchantedPlayer', planeswalkers: true },
      },
      {
        when: 'attackDeclared',
        attacker: 'enchantedPlayer',
        attacking: { who: 'you', planeswalkers: true },
      },
    ]);
    expect(def.triggers[1]!.effects).toEqual([{ op: 'sacrifice', target: 'source' }]);
  });

  it('tenuous-truce-enchant-opponent — it is cast targeting an opponent only and enters attached to that player', () => {
    const ctx = pod('truce-cast');
    const object = conjure(ctx, 'P1', card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'W' }, ...generic(1)]);
    const option = optionFor(ctx, 'P1', object.id);
    expect(option, 'P1 casts Tenuous Truce').toBeDefined();
    expect([...option!.targets![0]!.options].sort()).toEqual(['P2', 'P3', 'P4']);
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[option!.targets![0]!.slot, 'P3']]),
    );
    resolveTop(ctx);
    const aura = ctx.state.battlefield.find((perm) => perm.name === 'Tenuous Truce');
    expect(aura?.attachedTo).toBe('P3');
    expect(aura?.controllerId).toBe('P1');
  });

  it('tenuous-truce-end-step — you and the enchanted opponent each draw at that opponent’s end step, and no one draws at anyone else’s', () => {
    const { ctx, aura } = board('truce-draw');
    turnWith(ctx, 'P2');
    // P2 draws for the turn, then the Aura's draw: two cards. You draw one.
    expect(handSize(ctx, 'P2')).toBe(2);
    expect(handSize(ctx, 'P1')).toBe(1);
    expect(present(ctx, aura)).toBe(true);

    const other = board('truce-other-turn');
    turnWith(other.ctx, 'P3');
    expect(handSize(other.ctx, 'P3')).toBe(1);
    expect(handSize(other.ctx, 'P1')).toBe(0);
    turnWith(other.ctx, 'P1');
    expect(handSize(other.ctx, 'P1')).toBe(1);
  });

  it('tenuous-truce-you-attack — you attacking the enchanted opponent, or their planeswalker, sacrifices the Aura; attacking anyone else does not', () => {
    const player = board('truce-you-player');
    turnWith(player.ctx, 'P1', { [player.bears.P1.id]: 'P2' });
    expect(present(player.ctx, player.aura)).toBe(false);
    expect(player.ctx.state.players[0]!.graveyard.some((c) => c.name === 'Tenuous Truce')).toBe(
      true,
    );

    const walker = board('truce-you-walker');
    turnWith(walker.ctx, 'P1', { [walker.bears.P1.id]: walker.walkers.P2.id });
    expect(present(walker.ctx, walker.aura)).toBe(false);

    const elsewhere = board('truce-you-elsewhere');
    turnWith(elsewhere.ctx, 'P1', { [elsewhere.bears.P1.id]: 'P3' });
    expect(present(elsewhere.ctx, elsewhere.aura)).toBe(true);
    const elsewhereWalker = board('truce-you-other-walker');
    turnWith(elsewhereWalker.ctx, 'P1', {
      [elsewhereWalker.bears.P1.id]: elsewhereWalker.walkers.P3.id,
    });
    expect(present(elsewhereWalker.ctx, elsewhereWalker.aura)).toBe(true);
  });

  it('tenuous-truce-they-attack — the enchanted opponent attacking you, or your planeswalker, sacrifices the Aura; attacking anyone else, or another player attacking you, does not', () => {
    const player = board('truce-they-player');
    turnWith(player.ctx, 'P2', { [player.bears.P2.id]: 'P1' });
    expect(present(player.ctx, player.aura)).toBe(false);

    const walker = board('truce-they-walker');
    turnWith(walker.ctx, 'P2', { [walker.bears.P2.id]: walker.walkers.P1.id });
    expect(present(walker.ctx, walker.aura)).toBe(false);

    const elsewhere = board('truce-they-elsewhere');
    turnWith(elsewhere.ctx, 'P2', { [elsewhere.bears.P2.id]: 'P3' });
    expect(present(elsewhere.ctx, elsewhere.aura)).toBe(true);

    const third = board('truce-third-player');
    turnWith(third.ctx, 'P3', { [third.bears.P3.id]: 'P1' });
    expect(present(third.ctx, third.aura)).toBe(true);
  });

  it('tenuous-truce-sacrificed-before-end-step — once sacrificed it no longer draws at the enchanted opponent’s end step', () => {
    const { ctx, aura, bears } = board('truce-gone');
    turnWith(ctx, 'P1', { [bears.P1.id]: 'P2' });
    expect(present(ctx, aura)).toBe(false);
    const before = handSize(ctx, 'P1');
    turnWith(ctx, 'P2');
    expect(handSize(ctx, 'P1')).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------
// PR06.26 Wall of Tears
// ---------------------------------------------------------------------------------------------

describe('Wall of Tears', () => {
  const { card } = pinned('Wall of Tears');

  /** P1's two Bears attack; P2 controls the Wall (and a Giant that can kill it). */
  function board(seed: string) {
    const ctx = pod(seed);
    const wall = spawn(ctx, 'P2', card);
    const bears = [1, 2].map((n) => spawn(ctx, 'P1', GRIZZLY(`Lab P1 Bear ${n}`)));
    return { ctx, wall, bears: bears as [EnginePermanent, EnginePermanent] };
  }
  const inHand = (ctx: GameContext, owner: string, name: string) =>
    playerById(ctx, owner).hand.some((c) => c.name === name);
  const onBoard = (ctx: GameContext, perm: EnginePermanent) => ctx.state.battlefield.includes(perm);

  it('wall-of-tears-pinned-oracle-supported — the interpreter reads defender and the override reads one block trigger that creates the end-of-combat return', () => {
    expectModeled(card);
    expect(getOverride(card.oracleId)?.unsupportedReason).toBeUndefined();
    expect(getOverride(fixtureOracleId(card.name))?.unsupportedReason).toBeUndefined();
    const def = interpretCard(card);
    expect(def.keywords).toContain('defender');
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toEqual({ when: 'blocks', subject: { kind: 'self' } });
    expect(def.triggers[0]!.effects).toEqual([{ op: 'returnBlockedCreatureAtEndOfCombat' }]);
  });

  it('wall-of-tears-blocks — the creature it blocks is returned to its owner’s hand at end of combat, after combat damage, and the other attacker stays', () => {
    const { ctx, wall, bears } = board('wall-blocks');
    const [blocked, other] = bears;
    declareAndFight(ctx, { [blocked.id]: 'P2', [other.id]: 'P2' }, undefined, {
      [wall.id]: blocked.id,
    });
    expect(onBoard(ctx, blocked)).toBe(false);
    expect(inHand(ctx, 'P1', 'Lab P1 Bear 1')).toBe(true);
    expect(onBoard(ctx, other)).toBe(true);
    // Combat damage happened first: the Wall (0/4) took 2 and the other Bear hit P2 for 2.
    expect(wall.damageMarked).toBe(2);
    expect(playerById(ctx, 'P2').life).toBe(38);
    expect(
      ctx.state.eventLog.findIndex((e) => e.type === 'combatDamageStep') <
        ctx.state.eventLog.findIndex(
          (e) => e.type === 'returnToHand' && e.payload['target'] === 'Lab P1 Bear 1',
        ),
    ).toBe(true);
    expect(ctx.state.delayedTriggers).toEqual([]);
  });

  it('wall-of-tears-unblocked — nothing is returned when it does not block, and a block that does not happen creates nothing', () => {
    const { ctx, bears } = board('wall-no-block');
    declareAndFight(ctx, { [bears[0].id]: 'P2' });
    expect(onBoard(ctx, bears[0])).toBe(true);
    expect(ctx.state.delayedTriggers).toEqual([]);
  });

  it('wall-of-tears-independent — the return still happens if the Wall dies in combat or left the battlefield', () => {
    const slain = pod('wall-dies');
    const wall = spawn(slain, 'P2', card);
    const giant = spawn(
      slain,
      'P1',
      oracle({ name: 'Lab Giant', typeLine: 'Creature — Giant', power: '5', toughness: '5' }),
    );
    declareAndFight(slain, { [giant.id]: 'P2' }, undefined, { [wall.id]: giant.id });
    expect(onBoard(slain, wall)).toBe(false);
    expect(inHand(slain, 'P1', 'Lab Giant')).toBe(true);

    const gone = board('wall-removed');
    conjure(gone.ctx, 'P1', ZAP, 'hand');
    const zapped = respondWith(gone.ctx, { [gone.bears[0].id]: 'P2' }, 'Lab Zap', gone.wall.id, {
      step: 'combatDamage',
      blocks: { [gone.wall.id]: gone.bears[0].id },
    });
    expect(zapped()).toBe(true);
    expect(onBoard(gone.ctx, gone.wall)).toBe(false);
    expect(inHand(gone.ctx, 'P1', 'Lab P1 Bear 1')).toBe(true);
  });

  it('wall-of-tears-new-object — a creature that left and returned before end of combat is a new object and is not returned', () => {
    const { ctx, wall, bears } = board('wall-new-object');
    const [blocked] = bears;
    // An instant P1 never casts: it makes P1's priority in each step a real decision.
    conjure(ctx, 'P1', ZAP, 'hand');
    let blinked = false;
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (id) => (id === blocked.id ? 'P2' : null));
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, (id) => (id === wall.id ? blocked.id : null));
      if (!blinked && ctx.state.step === 'combatDamage' && decision.player === 'P1') {
        blinked = true;
        pump(moveObject(ctx, blocked, { zone: 'hand' }));
        const card = playerById(ctx, 'P1').hand.find((c) => c.cardId === blocked.cardId)!;
        pump(moveObject(ctx, card, { zone: 'battlefield', controllerId: 'P1' }));
      }
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    expect(blinked).toBe(true);
    const fresh = ctx.state.battlefield.find((p) => p.name === 'Lab P1 Bear 1');
    expect(fresh).toBeDefined();
    expect(fresh!.id).not.toBe(blocked.id);
    expect(inHand(ctx, 'P1', 'Lab P1 Bear 1')).toBe(false);
  });

  it('wall-of-tears-bounce-owner — it returns to its OWNER’s hand, not its controller’s', () => {
    const { ctx, wall, bears } = board('wall-owner');
    const [stolen] = bears;
    stolen.controllerId = 'P3';
    stolen.ownerId = 'P1';
    ctx.state.currentTurnPlayer = 'P3';
    ctx.state.activePlayerIndex = 2;
    declareAndFight(ctx, { [stolen.id]: 'P2' }, undefined, { [wall.id]: stolen.id });
    expect(inHand(ctx, 'P1', 'Lab P1 Bear 1')).toBe(true);
    expect(inHand(ctx, 'P3', 'Lab P1 Bear 1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// PR06.27 Human Torch
// ---------------------------------------------------------------------------------------------

describe('Human Torch', () => {
  const { card } = pinned('Human Torch');
  const SIP = oracle({
    name: 'Lab Sip',
    typeLine: 'Instant',
    manaCost: '{0}',
    oracleText: 'You gain 1 life.',
  });
  const SPIRIT = oracle({
    name: 'Lab Spirit',
    typeLine: 'Creature — Spirit',
    manaCost: '{0}',
    power: '1',
    toughness: '1',
  });
  const life = (ctx: GameContext, id: string) => playerById(ctx, id).life;

  /** P1 controls a summoning-sick Human Torch and (with `lands`) the lands paying {R}{G}{W}{U}. */
  function board(seed: string, lands = true) {
    const ctx = pod(seed);
    const torch = spawn(ctx, 'P1', card, { summoningSick: true });
    if (lands)
      for (const land of [mountain(), forest(), plains(), island()]) spawn(ctx, 'P1', land);
    const bears = Object.fromEntries(
      (['P2', 'P3', 'P4'] as const).map((id) => [id, spawn(ctx, id, GRIZZLY(`Lab ${id} Bear`))]),
    ) as Record<'P2' | 'P3' | 'P4', EnginePermanent>;
    return { ctx, torch, bears };
  }
  /** P1 casts `spell` from hand with no mana and lets it resolve. */
  function castSpell(ctx: GameContext, playerId: string, spell: OracleCard) {
    const object = conjure(ctx, playerId, spell, 'hand');
    const option = optionFor(ctx, playerId, object.id);
    expect(option, `${playerId} casts ${spell.name}`).toBeDefined();
    takeAction(ctx, playerId, option!.payload as PriorityActionPayload);
    settle(ctx);
  }
  /**
   * P1's combat with Torch attacking `target`. Records Torch's keywords as blockers are declared,
   * answers the pay prompt with `pay`, and lets `blockers` (blocker id to attacker id) stand.
   */
  function combat(
    ctx: GameContext,
    torch: EnginePermanent,
    target: string,
    pay: boolean,
    blocks: Record<string, string> = {},
  ) {
    const seen: { keywords: string[]; prompts: string[] } = { keywords: [], prompts: [] };
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined) {
        // After the beginning of combat trigger resolved, as attackers are declared.
        seen.keywords = [...computeCharacteristics(ctx, torch).keywords];
        return declareAttacks(decision, (id) => (id === torch.id ? target : null));
      }
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, (id) => blocks[id] ?? null);
      const payIndex = decision.options.findIndex((option) => /^Pay /.test(option.description));
      if (payIndex >= 0) {
        seen.prompts.push(decision.prompt);
        const decline = decision.options.findIndex((option) =>
          /^Don't pay$/.test(option.description),
        );
        return { index: pay ? payIndex : decline, targets: new Map() };
      }
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    return seen;
  }

  it('human-torch-pinned-oracle-supported — the override reads an intervening-if beginning-of-combat grant of three keywords and an attack trigger whose payment grants a damage-copying trigger', () => {
    expectModeled(card);
    expect(getOverride(card.oracleId)?.unsupportedReason).toBeUndefined();
    expect(getOverride(fixtureOracleId(card.name))?.unsupportedReason).toBeUndefined();
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(2);
    const [combatTrigger, attackTrigger] = def.triggers as [Ability, Ability];
    expect(combatTrigger.trigger).toEqual({
      when: 'beginningOfCombat',
      player: 'you',
      condition: { kind: 'castSpellThisTurn', category: 'noncreature', cmp: '>=', n: 1 },
    });
    expect(combatTrigger.effects.map((e) => (e as { keyword: string }).keyword)).toEqual([
      'flying',
      'double strike',
      'haste',
    ]);
    const [pay] = attackTrigger.effects as [
      { op: string; condition: unknown; then: { op: string; ability: Ability }[] },
    ];
    expect(pay.op).toBe('conditionalEffect');
    expect(pay.condition).toMatchObject({ kind: 'mayPayMana' });
    expect(pay.then[0]!.op).toBe('grantAbilityUntilEot');
    expect(pay.then[0]!.ability.trigger).toEqual({
      when: 'dealsCombatDamageToPlayer',
      subject: { kind: 'self' },
    });
    expect(pay.then[0]!.ability.effects).toEqual([
      { op: 'damageEachOtherOpponent', amount: { kind: 'damageDealt' } },
    ]);
  });

  it('human-torch-keywords — with a noncreature spell cast this turn it gains flying, double strike and haste as combat begins, and with none (or only a creature spell) it does not', () => {
    const noncreature = board('torch-noncreature', false);
    castSpell(noncreature.ctx, 'P1', SIP);
    const seen = combat(noncreature.ctx, noncreature.torch, 'P2', false);
    expect(seen.keywords).toEqual(expect.arrayContaining(['flying', 'double strike', 'haste']));
    // Haste let a summoning-sick Torch attack: it dealt double strike damage, 3 + 3.
    expect(life(noncreature.ctx, 'P2')).toBe(34);

    const none = board('torch-none', false);
    const unseen = combat(none.ctx, none.torch, 'P2', false);
    expect(unseen.keywords).not.toContain('flying');
    expect(unseen.keywords).not.toContain('double strike');
    expect(life(none.ctx, 'P2')).toBe(40); // summoning sick: it could not attack

    const creature = board('torch-creature', false);
    castSpell(creature.ctx, 'P1', SPIRIT);
    expect(combat(creature.ctx, creature.torch, 'P2', false).keywords).not.toContain('haste');

    // A noncreature spell an opponent cast is not yours.
    const theirs = board('torch-their-spell', false);
    castSpell(theirs.ctx, 'P2', SIP);
    expect(combat(theirs.ctx, theirs.torch, 'P2', false).keywords).not.toContain('haste');
  });

  it('human-torch-keywords-end — the keywords last until end of turn only', () => {
    const { ctx, torch } = board('torch-eot', false);
    castSpell(ctx, 'P1', SIP);
    pump(runTurn(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (id) => (id === torch.id ? 'P2' : null));
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    expect(hasKeyword(ctx, torch, 'double strike')).toBe(false);
    expect(hasKeyword(ctx, torch, 'flying')).toBe(false);
  });

  it('human-torch-pay — paying {R}{G}{W}{U} as it attacks makes each combat damage it deals to an opponent also damage each other opponent, and declining does nothing', () => {
    const paid = board('torch-pay');
    // Not summoning sick: attacking needs no haste for this clause.
    paid.torch.summoningSick = false;
    const seen = combat(paid.ctx, paid.torch, 'P2', true);
    expect(seen.prompts).toHaveLength(1);
    expect(life(paid.ctx, 'P2')).toBe(37);
    expect(life(paid.ctx, 'P3')).toBe(37);
    expect(life(paid.ctx, 'P4')).toBe(37);
    expect(life(paid.ctx, 'P1')).toBe(40);
    // The mana was spent: all four lands are tapped.
    expect(
      paid.ctx.state.battlefield.filter((p) => p.tapped && p.name !== 'Human Torch'),
    ).toHaveLength(4);

    const declined = board('torch-decline');
    declined.torch.summoningSick = false;
    combat(declined.ctx, declined.torch, 'P2', false);
    expect(life(declined.ctx, 'P2')).toBe(37);
    expect(life(declined.ctx, 'P3')).toBe(40);
    expect(life(declined.ctx, 'P4')).toBe(40);

    // Without the four colors there is no prompt at all.
    const broke = board('torch-broke', false);
    broke.torch.summoningSick = false;
    expect(combat(broke.ctx, broke.torch, 'P2', true).prompts).toHaveLength(0);
    expect(life(broke.ctx, 'P3')).toBe(40);
  });

  it('human-torch-double-strike — each combat damage event copies on its own, so double strike deals that much again to every other opponent', () => {
    const { ctx, torch } = board('torch-double');
    castSpell(ctx, 'P1', SIP);
    combat(ctx, torch, 'P3', true);
    expect(life(ctx, 'P3')).toBe(34);
    expect(life(ctx, 'P2')).toBe(34);
    expect(life(ctx, 'P4')).toBe(34);
    // The copied damage is noncombat damage from Human Torch, dealt by the granted trigger.
    const copies = ctx.state.eventLog.filter(
      (e) =>
        e.type === 'damage' &&
        e.payload['combat'] === false &&
        String(e.payload['source']).startsWith('Human Torch'),
    );
    expect(copies).toHaveLength(4);
  });

  it('human-torch-not-an-opponent — damage to a planeswalker, and a blocked Torch, copy nothing, and the grant is gone after the turn', () => {
    const walked = board('torch-walker');
    walked.torch.summoningSick = false;
    const walker = spawn(walked.ctx, 'P2', WALKER());
    combat(walked.ctx, walked.torch, walker.id, true);
    expect(counterOf(walker)).toBe(2);
    for (const id of ['P2', 'P3', 'P4']) expect(life(walked.ctx, id)).toBe(40);

    const blocked = board('torch-blocked');
    blocked.torch.summoningSick = false;
    combat(blocked.ctx, blocked.torch, 'P2', true, { [blocked.bears.P2.id]: blocked.torch.id });
    for (const id of ['P2', 'P3', 'P4']) expect(life(blocked.ctx, id)).toBe(40);

    const turn = board('torch-turn');
    turn.torch.summoningSick = false;
    pump(runTurn(turn.ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (id) => (id === turn.torch.id ? 'P2' : null));
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      const pay = decision.options.findIndex((option) => /^Pay /.test(option.description));
      if (pay >= 0) return { index: pay, targets: new Map() };
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    expect(turn.ctx.state.effects.filter((e) => e.kind === 'grantAbility')).toEqual([]);
  });
});

// @@CARDS@@
// ---------------------------------------------------------------------------------------------
// Restoration gate
// ---------------------------------------------------------------------------------------------

interface RestoredCard {
  name: string;
  sha256: string;
  clauseCount: number;
  /** An authored override (not the interpreter alone) carries the card; it must be executable. */
  authored?: true;
  /**
   * Restored by both PR06 and the white-black control work (merged from main). The shared
   * verification manifest entry is main's, pinned by white-black-control-manifest.test.ts; the
   * PR06 tests above remain as additional engine evidence for the same implementation.
   */
  manifestOwnedByWhiteBlackControl?: true;
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
    manifestOwnedByWhiteBlackControl: true,
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
    name: 'Backlash',
    sha256: '116b1ea7f57a9a829f03d7c0a6ffeafd34ece8beb23320dcd9b13668659a9ae5',
    clauseCount: 1,
    authored: true,
  },
  {
    name: 'Thundermaw Hellkite',
    sha256: '6e4aa521c27b28fb2861e03abdda06a0e8b850bce340e5e4950ad313afe845f4',
    clauseCount: 3,
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
  {
    name: 'Selfless Squire',
    sha256: 'debd579414a52e7e7cc408bd06d4bf3f3862f42f108196365a37c3f6d72dc6a6',
    clauseCount: 3,
    authored: true,
  },
  {
    name: 'Deflecting Palm',
    sha256: '3993eb90435f19d48756dd73a5c98c1f311389efee795e82a5f8aa58277b936a',
    clauseCount: 2,
    authored: true,
  },
  {
    name: 'Comeuppance',
    sha256: 'c51d55e7df204a7b74f5ccfe5f5a58b4349adecad02f0c0fe15b2b1940059d75',
    clauseCount: 3,
    authored: true,
  },
  {
    name: 'Michiko Konda, Truth Seeker',
    sha256: 'cb2ada5b8d71925822fca64f34bed81777cfff96d71c183470213cb575282a47',
    clauseCount: 1,
    authored: true,
  },
  {
    name: 'Delirium',
    sha256: '7f67096386be6374ad6079171689a2ceec128353a3e0e2abe544784ad5181573',
    clauseCount: 2,
    authored: true,
  },
  {
    name: 'Firemane Commando',
    sha256: '20c0287a3dd96d72f6a5f557813f972125a91a6506ed4b957cf022bf32a2437a',
    clauseCount: 2,
    authored: true,
  },
  {
    name: 'Breena, the Demagogue',
    sha256: '1a3ea33cc0a417228dcd76cf55f55186215b4f741905684aaeeae17e74d16996',
    clauseCount: 1,
    authored: true,
    manifestOwnedByWhiteBlackControl: true,
  },
  {
    name: 'Ever-Watching Threshold',
    sha256: 'f91221e3d2d8a8761c35115ed9e63e8bf90737cb6ac40a697aed18fb15a93af5',
    clauseCount: 1,
    authored: true,
  },
  {
    name: 'Mangara, the Diplomat',
    sha256: '23cad2e1c9fb1f941dc492639a8b70d798f9f8dd018480d3bb38c767a1ed3a0a',
    clauseCount: 1,
    authored: true,
  },
  {
    name: 'Tomik, Wielder of Law',
    sha256: 'aa74d762952c526ea0bbb4b56566782832d8946544c2c236d52f6dfc069548dc',
    clauseCount: 2,
    authored: true,
  },
  {
    name: 'Frontier Warmonger',
    sha256: '044d015a5eddb088abf9886152e757d272a25c2beea3f16771376e4fe2c229de',
    clauseCount: 1,
    authored: true,
  },
  {
    name: 'Tenuous Truce',
    sha256: '95353ba0725d65be6feae67f59b0d786e508ea3715860f75f4c70ef848999a45',
    clauseCount: 2,
    authored: true,
  },
  {
    name: 'Wall of Tears',
    sha256: '00f50e798f0e2fb5bc6f144abb87651c501e511007b14a3c2c99ad434e1aa9cd',
    clauseCount: 1,
    authored: true,
  },
  {
    name: 'Human Torch',
    sha256: 'f335ec2abc29e719d8092c9d014a85aaf39073c6c40d93548a0d66f8846826a4',
    clauseCount: 2,
    authored: true,
  },
  {
    name: 'Guard Gomazoa',
    sha256: 'c74c28c601c8f2f0527f10baab04b1fe96da7dd1ebac4bff48d4909fffb22eeb',
    clauseCount: 2,
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

  it.each(
    RESTORED.filter((card) => card.manifestOwnedByWhiteBlackControl !== true).map(
      (card) => [card.name, card] as const,
    ),
  )(
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
        for (const id of clause.engineTestIds)
          expect(engineSource, id).toContain(`${id.split(' — ')[0]} —`);
        for (const id of clause.viewerScenarioIds) expect(viewerSource, id).toContain(id);
      }
    },
  );
});
