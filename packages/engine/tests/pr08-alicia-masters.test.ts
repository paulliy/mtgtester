/**
 * PR08 card coverage: Alicia Masters, Skilled Sculptor
 * (docs/plans/card-coverage-chunks.md — 8.14, control changes and multiplayer choices).
 *
 * Both triggers run through production paths: the begin-combat trigger is queued by
 * `queueStepTriggers` exactly as CR 507.1 queues it and resolves off the real stack, and "Sense the
 * Good" is queued by `beginEndStep`. Nothing here resolves the card's ability directly — that would
 * skip the intervening-if check at the queue and again on resolution (CR 603.4), which is most of
 * what the combat line means.
 *
 * Every card authored inside this file is a real, readable piece of test IR, and none of them
 * declares support the engine cannot back up. The cast-history witness is a genuine instant the
 * generic interpreter already understands; the only fixture that carries its own definition is
 * the "Artifacts you control are creatures" carrier, whose static is the engine's own primitive.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { allOf, ofType, YOURS } from '../src/cards/selector';
import type { PendingDecision, DecisionOutcome } from '../src/decisions';
import { computeCharacteristics } from '../src/effects/continuous';
import { endUntilEotEffects } from '../src/effects/resolve';
import { addMana, drainPool } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { changeController, controlledBy, moveObject, playerById } from '../src/state/objects';
import { manaSourcesFor } from '../src/state/queries';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { beginEndStep, queueStepTriggers, runBeginningAndPrecombatMain } from '../src/turn/turn';
import {
  conjure,
  copies,
  forest,
  gameConfig,
  mountain,
  oracle,
  pump,
  registerCustomDef,
  spawn,
} from './fixtures';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}
const pins = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/coverage-pr08-oracle.json'), 'utf8'),
  ) as PinnedFixture
).cards;
const aliciaPin = pins.find((pin) => pin.card.name === 'Alicia Masters, Skilled Sculptor');
if (aliciaPin === undefined)
  throw new Error('missing pinned Oracle fixture for Alicia Masters, Skilled Sculptor');

const PIN_TEXT =
  "At the beginning of combat on your turn, if you've cast a noncreature spell this turn, create a Treasure token.\n" +
  'Sense the Good — At the beginning of your end step, each player gains control of all creatures they own.';

const CARD_NAME = 'Alicia Masters, Skilled Sculptor';

/**
 * The cast-history witness for Alicia's intervening if: a plain, fully supported instant.
 *
 * It is deliberately NOT a blank placeholder. A blank instant has no interpretable effect at all,
 * so using one would mean force-declaring it `modeled: true` with an empty `effects: []` — faking
 * support the engine does not have, which is the failure mode `docs/guides/card-modeling-and-testing.md`
 * calls out. Instead this is a real Oracle line the generic parser reads into a real `spellAbility`,
 * the definition used below is the interpreter's own (registered by `conjure`), and every cast
 * asserts the life actually changed — so if the witness ever stopped being a supported instant,
 * these tests would fail rather than quietly stop counting casts.
 */
const spark = oracle({
  name: 'Sculptors Spark',
  typeLine: 'Instant',
  manaCost: '{R}',
  oracleText: 'You gain 1 life.',
});

const restorationBear = oracle({
  name: 'Restoration Bear',
  typeLine: 'Creature — Bear',
  manaCost: '{1}{G}',
});

const bear = (name: string): OracleCard =>
  oracle({ name, typeLine: 'Creature — Test', manaCost: '{1}' });

const relic = (name: string): OracleCard =>
  oracle({ name, typeLine: 'Artifact', manaCost: '{2}', power: null, toughness: null });

/** A creature card that will carry the printed static "Artifacts you control are creatures". */
const keeperCard = (name: string): OracleCard => bear(name);

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 5;
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

function playLandOptionFor(ctx: GameContext, playerId: string, objectId: string) {
  return priorityOptions(ctx, playerId).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'playLand' && payload.objectId === objectId;
  });
}

function takeAction(ctx: GameContext, playerId: string, payload: PriorityActionPayload) {
  return pump(
    applyPriorityAction(ctx, playerById(ctx, playerId), payload, {
      index: 0,
      targets: new Map(),
    }),
  );
}

/** Drive a real priority sequence to the resolution of whatever is on the stack. */
function resolveTop(ctx: GameContext, answer?: Answer) {
  return pump(runPrioritySequence(ctx), answer ?? passFirst);
}

/** Every player passes, so waiting triggers go on the stack and resolve in order. */
function settle(ctx: GameContext, answer?: Answer) {
  return pump(runPrioritySequence(ctx), (decision, count) => {
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    if (pass >= 0) return { index: pass, targets: new Map() };
    return answer?.(decision, count) ?? { index: 0, targets: new Map() };
  });
}

function turnOfPlayer(ctx: GameContext, playerId: string): void {
  ctx.state.currentTurnPlayer = playerId;
  ctx.state.activePlayerIndex = Number(playerId.slice(1)) - 1;
}

/** Cast and resolve the real instant for `playerId` through the ordinary cast path. */
function castSpark(ctx: GameContext, playerId: string): void {
  const caster = playerById(ctx, playerId);
  const lifeBefore = caster.life;
  const card = conjure(ctx, playerId, spark, 'hand');
  addMana(caster, [{ symbol: 'R' }]);
  const option = castOptionFor(ctx, playerId, card.id);
  expect(option, `${playerId} may cast Sculptors Spark`).toBeDefined();
  takeAction(ctx, playerId, option!.payload as PriorityActionPayload);
  expect(ctx.state.stack, 'the spell is on the stack').toHaveLength(1);
  settle(ctx);
  expect(ctx.state.stack, 'the spell resolved').toHaveLength(0);
  // The witness really resolved its printed effect. A blank spell could not show this, and a
  // witness that silently did nothing would make every "cast history" assertion below meaningless.
  expect(caster.life, `${playerId} gained the life Sculptors Spark prints`).toBe(lifeBefore + 1);
  expect(caster.noncreatureSpellsCastThisTurn).toBeGreaterThanOrEqual(1);
}

const treasuresOf = (ctx: GameContext) =>
  ctx.state.battlefield.filter((perm) => perm.name === 'Treasure');

/** Put a permanent in play under `controllerId` while `ownerId` keeps ownership of it. */
function spawnStolen(
  ctx: GameContext,
  controllerId: string,
  ownerId: string,
  card: OracleCard,
): EnginePermanent {
  const perm = spawn(ctx, controllerId, card);
  perm.ownerId = ownerId;
  return perm;
}

/** Register the generic keeper with its controller-dependent static BEFORE it enters play. */
function registerKeeper(ctx: GameContext, name: string): OracleCard {
  const card = keeperCard(name);
  const def = interpretCard(card);
  registerCustomDef(ctx, {
    ...def,
    staticEffects: [
      ...def.staticEffects,
      { affects: allOf(ofType('Artifact'), YOURS), op: { layer: 4, addTypes: ['Creature'] } },
    ],
  });
  return card;
}

describe('Alicia Masters, Skilled Sculptor', () => {
  it('alicia-masters-pinned-oracle-supported — pinned oracle, real id and fixture alias agree', () => {
    expect(aliciaPin.sha256).toBe(
      'ec7af585cca0a36073614bba7446b7d7b2aaa339e874ced506af201a7f51c466',
    );
    expect(aliciaPin.card.oracleId).toBe('223504ba-174a-46f2-a4a2-5d663a82dfd3');
    expect(aliciaPin.card.oracleText).toBe(PIN_TEXT);
    for (const card of [
      aliciaPin.card,
      { ...aliciaPin.card, oracleId: fixtureOracleId(CARD_NAME) },
    ]) {
      const def = interpretCard(card);
      expect(def.unmodeledReasons, card.oracleId).toEqual([]);
      expect(def.modeled, card.oracleId).toBe(true);
      // The override adds no typed card behavior of its own — the printed card is unchanged.
      expect(def.name, card.oracleId).toBe(CARD_NAME);
      expect(def.types, card.oracleId).toEqual(['Creature']);
      expect(def.supertypes, card.oracleId).toEqual(['Legendary']);
      expect(def.subtypes, card.oracleId).toEqual(['Human', 'Artificer']);
      expect([def.power, def.toughness], card.oracleId).toEqual([0, 4]);
      expect(def.manaCost, card.oracleId).toMatchObject({ generic: 1, colored: { R: 1 } });
      expect(def.spellAbility, card.oracleId).toBeNull();
      expect(def.activatedAbilities, card.oracleId).toEqual([]);
      expect(def.staticEffects, card.oracleId).toEqual([]);
      expect(def.triggers, card.oracleId).toHaveLength(2);

      // The combat ability is the interpreter's own, carried across verbatim: the intervening-if
      // is the printed "if you've cast a noncreature spell this turn" (CR 603.4), not a
      // resolution-time substitution.
      expect(def.triggers[0]).toMatchObject({
        kind: 'triggered',
        trigger: {
          when: 'beginningOfCombat',
          player: 'you',
          condition: { kind: 'castSpellThisTurn', category: 'noncreature', cmp: '>=', n: 1 },
        },
        targets: [],
        effects: [
          {
            op: 'createToken',
            spec: {
              name: 'Treasure',
              typeLine: 'Artifact — Treasure',
              types: ['Artifact'],
              subtypes: ['Treasure'],
              colors: [],
              // Both costs are load-bearing: a Treasure without them is a different card.
              manaAbilities: [
                {
                  units: [['W', 'U', 'B', 'R', 'G']],
                  costs: [{ kind: 'tap' }, { kind: 'sacrificeSelf' }],
                },
              ],
            },
            count: { kind: 'const', n: 1 },
          },
        ],
      });
      expect(def.triggers[0]?.optional).toBeFalsy();

      // "Sense the Good" is the only line the interpreter could not account for.
      expect(def.triggers[1]).toMatchObject({
        kind: 'triggered',
        trigger: { when: 'endStep', player: 'you' },
        targets: [],
        effects: [{ op: 'regainControlOfOwnCreatures' }],
      });
      expect(def.triggers[1]?.trigger?.condition).toBeUndefined();
      expect(validateCardDefinition(def), card.oracleId).toEqual([]);
    }
  });

  it('alicia-masters-triggers-carry-only-interpreted-and-catalog-primitives', () => {
    const def = interpretCard(aliciaPin.card);
    expect(def.triggers.map((ability) => ability.description)).toEqual([
      "At the beginning of combat on your turn, if you've cast a noncreature spell this turn, create a Treasure token",
      'At the beginning of your end step, each player gains control of all creatures they own',
    ]);
    // The Treasure is the catalog entry, not a token spelled out inside an override file.
    const [treasureEffect] = def.triggers[0]?.effects ?? [];
    expect(treasureEffect).toMatchObject({ op: 'createToken', count: { kind: 'const', n: 1 } });
    expect(treasureEffect).not.toHaveProperty('powerOverride');
    expect(treasureEffect).not.toHaveProperty('toughnessOverride');
  });

  it('alicia-masters-cast-history-witness-is-a-real-supported-instant-not-a-blank-spell', () => {
    // The intervening if only ever needs "a noncreature spell went on the stack". That witness is
    // a genuine supported instant the generic parser already reads, so nothing here has to declare
    // support the engine cannot back up.
    const def = interpretCard(spark);
    expect(def.unmodeledReasons).toEqual([]);
    expect(def.modeled).toBe(true);
    expect(def.types).toEqual(['Instant']);
    expect(def.spellAbility).toMatchObject({
      kind: 'spell',
      targets: [],
      effects: [{ op: 'gainLife', amount: { kind: 'const', n: 1 } }],
    });
    expect(validateCardDefinition(def)).toEqual([]);

    // And it behaves: casting it normally through legality, payment, priority and resolution
    // gains the life its text prints.
    const ctx = pod('alicia-spark-witness');
    const caster = playerById(ctx, 'P1');
    const lifeBefore = caster.life;
    const card = conjure(ctx, 'P1', spark, 'hand');
    addMana(caster, [{ symbol: 'R' }]);
    const option = castOptionFor(ctx, 'P1', card.id);
    expect(option, 'the real {R} instant is castable from hand').toBeDefined();
    expect(option!.targets ?? []).toHaveLength(0);
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(caster.manaEntries).toHaveLength(0);
    resolveTop(ctx);
    expect(caster.life).toBe(lifeBefore + 1);
    expect(caster.spellsCastThisTurn).toBe(1);
    expect(caster.noncreatureSpellsCastThisTurn).toBe(1);
    expect(
      ctx.state.eventLog.some(
        (event) => event.type === 'castSpell' && event.payload['name'] === 'Sculptors Spark',
      ),
    ).toBe(true);
  });

  it('alicia-masters-normal-cast-pays-one-and-one-red-and-enters-the-battlefield — printed payment precedes stack resolution', () => {
    const ctx = pod('alicia-cast');
    const caster = playerById(ctx, 'P1');
    const card = conjure(ctx, 'P1', aliciaPin.card, 'hand');
    addMana(caster, [{ symbol: 'C' }, { symbol: 'R' }]);

    const option = castOptionFor(ctx, 'P1', card.id);
    expect(option, 'printed {1}{R} is castable from hand in a main phase').toBeDefined();
    expect(option!.targets ?? []).toHaveLength(0);
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(ctx.state.stack).toHaveLength(1);
    expect(caster.manaEntries).toHaveLength(0);

    resolveTop(ctx);
    const permanent = ctx.state.battlefield.find((entry) => entry.cardId === card.cardId);
    expect(permanent).toBeDefined();
    expect(permanent!.controllerId).toBe('P1');
    expect(permanent!.ownerId).toBe('P1');
    expect(permanent!.summoningSick).toBe(true);
    expect(permanent!.isToken).toBe(false);
    expect(
      ctx.state.eventLog.some(
        (event) => event.type === 'castSpell' && event.payload['name'] === CARD_NAME,
      ),
    ).toBe(true);
  });

  it('alicia-masters-normal-cast-rejects-missing-red-and-insufficient-total — both colored and total mana requirements apply', () => {
    const ctx = pod('alicia-cast-illegal');
    const player = playerById(ctx, 'P1');
    const card = conjure(ctx, 'P1', aliciaPin.card, 'hand');

    // One generic and nothing else: {1}{R} cannot be paid without the red pip.
    addMana(player, [{ symbol: 'C' }]);
    expect(castOptionFor(ctx, 'P1', card.id)).toBeUndefined();

    // A red pip alone is a real total shortfall for {1}{R}.
    drainPool(player, true);
    addMana(player, [{ symbol: 'R' }]);
    expect(castOptionFor(ctx, 'P1', card.id)).toBeUndefined();

    addMana(player, [{ symbol: 'C' }]);
    expect(castOptionFor(ctx, 'P1', card.id)).toBeDefined();

    // A creature is cast on main phases only.
    ctx.state.phase = 'combat';
    ctx.state.step = 'declareBlockers';
    expect(castOptionFor(ctx, 'P1', card.id)).toBeUndefined();
    ctx.state.phase = 'precombatMain';
    ctx.state.step = null;
    expect(castOptionFor(ctx, 'P1', card.id)).toBeDefined();
  });

  it('alicia-masters-combat-trigger-creates-the-treasure-after-a-noncreature-spell-this-turn — own combat checks the actual cast history', () => {
    const ctx = pod('alicia-combat');
    spawn(ctx, 'P1', aliciaPin.card);
    expect(treasuresOf(ctx)).toHaveLength(0);

    castSpark(ctx, 'P1');
    expect(playerById(ctx, 'P1').noncreatureSpellsCastThisTurn).toBe(1);

    // CR 507.1: "at the beginning of combat" triggers are queued as the step begins, before
    // anyone receives priority in it.
    ctx.state.phase = 'combat';
    ctx.state.step = 'beginCombat';
    queueStepTriggers(ctx, 'beginningOfCombat');
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    expect(ctx.state.pendingTriggers[0]?.controllerId).toBe('P1');
    expect(ctx.state.stack).toHaveLength(0);

    settle(ctx);
    const treasures = treasuresOf(ctx);
    expect(treasures).toHaveLength(1);
    expect(ctx.state.stack).toHaveLength(0);
    const [treasure] = treasures;
    expect(treasure!.isToken).toBe(true);
    expect(treasure!.controllerId).toBe('P1');
    expect(treasure!.ownerId).toBe('P1');
    expect(treasure!.tapped).toBe(false);
    // A token's {T} cost is never barred by summoning sickness, because it is not a creature
    // (CR 302.6), and the engine's tokens are born summoning-sick regardless.
    expect(treasure!.summoningSick).toBe(true);
    const chars = computeCharacteristics(ctx, treasure!);
    expect(chars.types).toEqual(['Artifact']);
    expect(chars.subtypes).toEqual(['Treasure']);
    expect(chars.colors).toEqual([]);
    expect(chars.manaAbilities).toEqual([
      { units: [['W', 'U', 'B', 'R', 'G']], costs: [{ kind: 'tap' }, { kind: 'sacrificeSelf' }] },
    ]);
  });

  it('alicia-masters-treasure-is-a-real-mana-source-that-taps-and-sacrifices-itself — the token pays for a second real spell', () => {
    const ctx = pod('alicia-treasure-mana');
    spawn(ctx, 'P1', aliciaPin.card);
    castSpark(ctx, 'P1');
    ctx.state.phase = 'combat';
    ctx.state.step = 'beginCombat';
    queueStepTriggers(ctx, 'beginningOfCombat');
    settle(ctx);

    const [treasure] = treasuresOf(ctx);
    expect(treasure).toBeDefined();
    expect(treasure!.tapped).toBe(false);

    // The pool is empty and no land is in play: only the Treasure can pay anything.
    drainPool(playerById(ctx, 'P1'), true);
    expect(manaSourcesFor(ctx, 'P1').map((source) => source.cardId)).toEqual([treasure!.cardId]);
    const [source] = manaSourcesFor(ctx, 'P1');
    expect(source!.units).toEqual([['W', 'U', 'B', 'R', 'G']]);
    expect(source!.costs.map((cost) => cost.kind)).toEqual(['tap', 'sacrificeSelf']);

    // Pay for a real {R} cast through the ordinary payment path.
    const caster = playerById(ctx, 'P1');
    const card = conjure(ctx, 'P1', spark, 'hand');
    const option = castOptionFor(ctx, 'P1', card.id);
    expect(option).toBeDefined();
    const lifeBefore = caster.life;
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(ctx.state.stack).toHaveLength(1);

    // The token paid by tapping AND sacrificing itself, so it is gone from every zone: a token
    // that left the battlefield ceases to exist (CR 111.7).
    expect(treasuresOf(ctx)).toHaveLength(0);
    expect(ctx.state.battlefield.some((perm) => perm.cardId === treasure!.cardId)).toBe(false);
    expect(
      ctx.state.players
        .flatMap((player) => player.graveyard)
        .some((cardInGY) => cardInGY.cardId === treasure!.cardId),
    ).toBe(false);
    expect(caster.noncreatureSpellsCastThisTurn).toBe(2);

    resolveTop(ctx);
    expect(ctx.state.stack).toHaveLength(0);
    expect(caster.life, 'the Treasure really paid for the second cast').toBe(lifeBefore + 1);
  });

  it('alicia-masters-combat-trigger-needs-your-own-combat — another player combat creates no token', () => {
    const ctx = pod('alicia-combat-not-yours');
    spawn(ctx, 'P1', aliciaPin.card);
    castSpark(ctx, 'P1');

    turnOfPlayer(ctx, 'P2');
    ctx.state.phase = 'combat';
    ctx.state.step = 'beginCombat';
    queueStepTriggers(ctx, 'beginningOfCombat');
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    settle(ctx);
    expect(treasuresOf(ctx)).toHaveLength(0);
  });

  it('alicia-masters-combat-trigger-ignores-another-players-noncreature-spell — another player cast does not satisfy your history', () => {
    const ctx = pod('alicia-combat-other-caster');
    spawn(ctx, 'P1', aliciaPin.card);
    castSpark(ctx, 'P2');

    ctx.state.phase = 'combat';
    ctx.state.step = 'beginCombat';
    queueStepTriggers(ctx, 'beginningOfCombat');
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    settle(ctx);
    expect(treasuresOf(ctx)).toHaveLength(0);
  });

  it('alicia-masters-combat-trigger-ignores-a-creature-spell-cast-this-turn — creature spells do not satisfy the condition', () => {
    const ctx = pod('alicia-combat-creature-spell');
    spawn(ctx, 'P1', aliciaPin.card);
    const card = conjure(ctx, 'P1', restorationBear, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'C' }, { symbol: 'G' }]);
    const option = castOptionFor(ctx, 'P1', card.id);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    settle(ctx);
    expect(playerById(ctx, 'P1').spellsCastThisTurn).toBe(1);
    expect(playerById(ctx, 'P1').noncreatureSpellsCastThisTurn).toBe(0);

    ctx.state.phase = 'combat';
    ctx.state.step = 'beginCombat';
    queueStepTriggers(ctx, 'beginningOfCombat');
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    settle(ctx);
    expect(treasuresOf(ctx)).toHaveLength(0);
  });

  it('alicia-masters-combat-trigger-ignores-a-land-played-this-turn — land plays are not spell casts', () => {
    const ctx = pod('alicia-combat-land');
    spawn(ctx, 'P1', aliciaPin.card);
    const land = conjure(ctx, 'P1', mountain(), 'hand');
    const option = playLandOptionFor(ctx, 'P1', land.id);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    // A land drop is not a spell cast, so neither tally moves.
    expect(playerById(ctx, 'P1').spellsCastThisTurn).toBe(0);
    expect(playerById(ctx, 'P1').noncreatureSpellsCastThisTurn).toBe(0);

    ctx.state.phase = 'combat';
    ctx.state.step = 'beginCombat';
    queueStepTriggers(ctx, 'beginningOfCombat');
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    settle(ctx);
    expect(treasuresOf(ctx)).toHaveLength(0);
  });

  it('alicia-masters-combat-trigger-ignores-a-spell-cast-on-a-previous-turn — the turn opening clears the relevant history', () => {
    const ctx = pod('alicia-combat-previous-turn');
    spawn(ctx, 'P1', aliciaPin.card);
    castSpark(ctx, 'P1');
    expect(playerById(ctx, 'P1').noncreatureSpellsCastThisTurn).toBe(1);

    // A later turn's untap step is what clears a per-turn tally, so it is run through the real
    // turn opening rather than by assigning over the field.
    turnOfPlayer(ctx, 'P2');
    ctx.state.turnNumber += 1;
    turnOfPlayer(ctx, 'P1');
    pump(runBeginningAndPrecombatMain(ctx));
    expect(playerById(ctx, 'P1').noncreatureSpellsCastThisTurn).toBe(0);

    ctx.state.phase = 'combat';
    ctx.state.step = 'beginCombat';
    queueStepTriggers(ctx, 'beginningOfCombat');
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    settle(ctx);
    expect(treasuresOf(ctx)).toHaveLength(0);
  });

  it('alicia-masters-intervening-if-is-checked-again-as-the-trigger-resolves — a queued trigger fails when its condition no longer holds', () => {
    const ctx = pod('alicia-intervening-if');
    spawn(ctx, 'P1', aliciaPin.card);
    castSpark(ctx, 'P1');

    ctx.state.phase = 'combat';
    ctx.state.step = 'beginCombat';
    queueStepTriggers(ctx, 'beginningOfCombat');
    expect(ctx.state.pendingTriggers).toHaveLength(1);

    // The trigger has already been queued, so the first CR 603.4 check has passed. The condition
    // is read again as the ability resolves: a later turn has begun and the tally it names is
    // gone, so the trigger is simply removed and creates nothing.
    turnOfPlayer(ctx, 'P2');
    ctx.state.turnNumber += 1;
    turnOfPlayer(ctx, 'P1');
    pump(runBeginningAndPrecombatMain(ctx));

    settle(ctx);
    expect(ctx.state.stack).toHaveLength(0);
    expect(treasuresOf(ctx)).toHaveLength(0);
    expect(
      ctx.state.eventLog.filter((event) => event.type === 'triggerConditionFailed'),
    ).not.toHaveLength(0);
  });

  it('alicia-masters-end-step-restores-every-players-own-creatures — fresh permanent grants mask temporary control history', () => {
    const ctx = pod('alicia-end-step');
    spawn(ctx, 'P1', aliciaPin.card);
    const stolen = spawnStolen(ctx, 'P1', 'P2', bear('Borrowed Bear'));
    const stolenToo = spawnStolen(ctx, 'P2', 'P3', bear('Third Party Fox'));
    const mine = spawn(ctx, 'P1', bear('My Own Grizzly'));

    // Two temporary grants sit under the restoration's permanent one, and both expire at the
    // cleanup step (CR 514.2). The creature is already back with its owner when they do.
    changeController(ctx, stolen, 'P1', { kind: 'untilEndOfTurn' });
    changeController(ctx, stolen, 'P2', { kind: 'untilEndOfTurn' });

    beginEndStep(ctx);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    const { decisions } = settle(ctx);
    // The end-step trigger is mandatory: nobody is asked "use this ability?".
    expect(decisions.map((decision) => decision.decisionType)).not.toContain('optionalTrigger');

    expect(stolen.controllerId).toBe('P2');
    expect(stolen.ownerId).toBe('P2');
    expect(stolenToo.controllerId).toBe('P3');
    expect(mine.controllerId).toBe('P1');
    // A real controller transition sets summoning sickness and drops the creature from combat.
    expect(stolen.summoningSick).toBe(true);
    expect(stolenToo.summoningSick).toBe(true);
    // Handing a creature to the player who already controls it is no controller change at all.
    expect(mine.summoningSick).toBe(false);

    // Every grant is a fresh PERMANENT record with its own effect timestamp — including the one
    // for a creature its owner already controls, which is what masks the older history.
    for (const perm of [stolen, stolenToo, mine]) {
      const grant = perm.controlChanges?.at(-1);
      expect(grant?.controllerId, perm.name).toBe(perm.ownerId);
      expect(grant?.duration, perm.name).toEqual({ kind: 'permanent' });
      expect(grant?.timestamp ?? 0, perm.name).toBeGreaterThan(0);
    }
    endUntilEotEffects(ctx);
    expect(controlledBy(stolen)).toBe('P2');
    expect(controlledBy(stolenToo)).toBe('P3');
    expect(controlledBy(mine)).toBe('P1');
    expect(stolen.controlChanges).toHaveLength(1);
  });

  it('alicia-masters-end-step-is-your-end-step-only — another player end step does not trigger', () => {
    const ctx = pod('alicia-end-step-not-yours');
    spawn(ctx, 'P1', aliciaPin.card);
    const stolen = spawnStolen(ctx, 'P1', 'P2', bear('Borrowed Bear'));

    turnOfPlayer(ctx, 'P2');
    beginEndStep(ctx);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    settle(ctx);
    expect(stolen.controllerId).toBe('P1');
  });

  it('alicia-masters-end-step-leaves-noncreatures-alone — lands and artifacts retain their controllers', () => {
    const ctx = pod('alicia-end-step-noncreatures');
    spawn(ctx, 'P1', aliciaPin.card);
    const stolenLand = spawnStolen(ctx, 'P1', 'P2', forest());
    const stolenRelic = spawnStolen(ctx, 'P1', 'P2', relic('Borrowed Relic'));
    const stolenCreature = spawnStolen(ctx, 'P1', 'P2', bear('Borrowed Bear'));

    beginEndStep(ctx);
    settle(ctx);

    expect(stolenLand.controllerId).toBe('P1');
    expect(stolenRelic.controllerId).toBe('P1');
    expect(stolenLand.controlChanges).toBeUndefined();
    expect(stolenRelic.controlChanges).toBeUndefined();
    expect(stolenCreature.controllerId).toBe('P2');
  });

  it('alicia-masters-end-step-freezes-the-creature-set-before-any-control-change — controller-dependent type changes cannot expand the sweep', () => {
    const ctx = pod('alicia-end-step-frozen');
    // "Artifacts you control are creatures", carried by a creature that is itself stolen. Once the
    // restoration hands that carrier to its owner the static follows it, and a plain artifact the
    // carrier used to cover BECOMES a creature — but only part way through the same effect.
    const keeperDef = registerKeeper(ctx, 'Contract Keeper');
    const keeper = spawnStolen(ctx, 'P2', 'P1', keeperDef);
    const plainRelic = spawnStolen(ctx, 'P1', 'P2', relic('Plain Relic'));
    expect(computeCharacteristics(ctx, plainRelic).types.includes('Creature')).toBe(false);
    const secondKeeper = spawnStolen(ctx, 'P2', 'P1', registerKeeper(ctx, 'Second Keeper'));
    expect(computeCharacteristics(ctx, secondKeeper).types.includes('Creature')).toBe(true);

    // Battlefield order puts the carriers first, so a per-iteration characteristics read would see
    // the plain relic turn into a creature mid-sweep.
    expect(ctx.state.battlefield.map((perm) => perm.name)).toEqual([
      'Contract Keeper',
      'Plain Relic',
      'Second Keeper',
    ]);

    spawn(ctx, 'P1', aliciaPin.card);
    beginEndStep(ctx);
    settle(ctx);

    expect(keeper.controllerId).toBe('P1');
    expect(secondKeeper.controllerId).toBe('P1');
    // "all creatures they own" is chosen when the effect resolves; a relic that only became a
    // creature because of an earlier grant in the same sweep is not one of them.
    expect(plainRelic.controllerId).toBe('P1');
    expect(plainRelic.controlChanges).toBeUndefined();
    // And it really did become a creature during that sweep — the carriers are P1's now, so
    // their statics reach P1's artifacts. That is precisely the read a per-iteration
    // characteristics check would have taken mid-effect and swept up.
    expect(computeCharacteristics(ctx, plainRelic).types.includes('Creature')).toBe(true);
  });

  it('alicia-masters-end-step-does-not-reach-a-creature-that-arrives-later — later objects receive no earlier grant', () => {
    const ctx = pod('alicia-end-step-arrival');
    spawn(ctx, 'P1', aliciaPin.card);
    beginEndStep(ctx);
    settle(ctx);

    const latecomer = spawnStolen(ctx, 'P1', 'P2', bear('Late Arrival'));
    expect(latecomer.controllerId).toBe('P1');
    // Nothing about it was in the set the already-resolved effect chose: no control record at all.
    expect(latecomer.controlChanges).toBeUndefined();
  });

  it('alicia-masters-end-step-still-resolves-after-the-source-leaves — the queued ability survives source departure', () => {
    const ctx = pod('alicia-end-step-source-gone');
    const alicia = spawn(ctx, 'P1', aliciaPin.card);
    const stolen = spawnStolen(ctx, 'P1', 'P2', bear('Borrowed Bear'));

    beginEndStep(ctx);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    // An ability that has already triggered uses the game state that existed when it triggered
    // (CR 608.2h reaches the SOURCE, not an ability already on the stack).
    pump(moveObject(ctx, alicia, { zone: 'graveyard' }));
    expect(ctx.state.battlefield.some((perm) => perm.id === alicia.id)).toBe(false);

    settle(ctx);
    expect(ctx.state.stack).toHaveLength(0);
    expect(stolen.controllerId).toBe('P2');
    expect(stolen.ownerId).toBe('P2');
  });

  it('alicia-masters-end-step-grants-through-the-original-ability-controller — changing Alicia control cannot change the queued controller', () => {
    const ctx = pod('alicia-end-step-pending-controller');
    const alicia = spawn(ctx, 'P1', aliciaPin.card);
    const stolen = spawnStolen(ctx, 'P1', 'P2', bear('Borrowed Bear'));

    beginEndStep(ctx);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    const queuedController = ctx.state.pendingTriggers[0]?.controllerId;
    // Whoever controls the permanent now cannot re-scope a queued ability: the effect still runs
    // as P1's, and "each player" reaches the same four players it always did.
    changeController(ctx, alicia, 'P4', { kind: 'untilEndOfTurn' });
    expect(ctx.state.pendingTriggers[0]?.controllerId).toBe(queuedController);
    settle(ctx);

    expect(queuedController).toBe('P1');
    expect(stolen.controllerId).toBe('P2');
    expect(stolen.ownerId).toBe('P2');
    // P1's ability also hands Alicia itself back — she is a creature P1 owns, and the effect is
    // not a self-exclusion the way "each opponent" would be.
    expect(alicia.controllerId).toBe('P1');
    expect(alicia.controlChanges?.at(-1)).toMatchObject({
      controllerId: 'P1',
      duration: { kind: 'permanent' },
    });
  });
});
