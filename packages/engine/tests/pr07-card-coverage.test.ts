/**
 * PR07 card coverage: combat requirements, restrictions and extra combats
 * (docs/plans/card-coverage-chunks.md).
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
import { spell } from '../src/cards/templates';
import { executeAbility } from '../src/effects/resolve';
import { fixtureOracleId, getOverride } from '../src/cards/overrides';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { addMana } from '../src/mana/pool';
import { priorityCheckpoint } from '../src/sba/sba';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { computeCharacteristics } from '../src/effects/continuous';
import { applyCopy } from '../src/state/objects';
import { beginEndStep, queueStepTriggers, runCombatAndExtraCombats } from '../src/turn/turn';
import { createGame } from '../src/state/game';
import { phaseInAtUntap, phaseOutControlledPermanents } from '../src/state/phasing';
import { playerById } from '../src/state/objects';
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

const PINNED_FILES = ['fixtures/coverage-pr07-oracle.json'];
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

const white = (n: number) => Array.from({ length: n }, () => ({ symbol: 'W' as const }));
const generic = (n: number) => Array.from({ length: n }, () => ({ symbol: 'C' as const }));

/** The pinned card is modeled under both ids with no remaining reasons. */
function expectModeled(card: OracleCard): void {
  for (const candidate of [card, { ...card, oracleId: fixtureOracleId(card.name) }]) {
    const def = interpretCard(candidate);
    expect(def.unmodeledReasons, candidate.oracleId).toEqual([]);
    expect(def.modeled, candidate.oracleId).toBe(true);
  }
}

const GRIZZLY = (name: string) =>
  oracle({ name, typeLine: 'Creature — Bear', power: '2', toughness: '2' });
const WALKER = (name = 'Lab Walker') =>
  oracle({
    name,
    typeLine: 'Planeswalker — Lab',
    manaCost: '{3}',
    cmc: 3,
    loyalty: '5',
    oracleText: '',
  });

/** It is `playerId`'s turn, before combat. */
function turnOfPlayer(ctx: GameContext, playerId: string): void {
  ctx.state.currentTurnPlayer = playerId;
  ctx.state.activePlayerIndex = Number(playerId.slice(1)) - 1;
}

/**
 * The attack options the active player is offered for `creature`: the defending players and the
 * planeswalker object ids it may be declared against. Nobody attacks, so the turn ends quietly.
 */
function attackOptionsFor(
  ctx: GameContext,
  playerId: string,
  creature: EnginePermanent,
): { players: string[]; planeswalkers: string[]; taxes: Record<string, number> } {
  turnOfPlayer(ctx, playerId);
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  let offered: { players: string[]; planeswalkers: string[]; taxes: Record<string, number> } = {
    players: [],
    planeswalkers: [],
    taxes: {},
  };
  pump(runCombatAndExtraCombats(ctx), (decision) => {
    if (decision.presentationAttackDeclaration !== undefined) {
      const subject = decision.presentationAttackDeclaration.subjects.find(
        (candidate) => candidate.subjectId === creature.id,
      );
      offered = {
        players: subject?.defenders.map((defender) => defender.playerId) ?? [],
        planeswalkers: subject?.planeswalkers.map((walker) => walker.objectId) ?? [],
        taxes: Object.fromEntries([
          ...(subject?.defenders.map((d) => [d.playerId, d.attackTax] as const) ?? []),
          ...(subject?.planeswalkers.map((w) => [w.objectId, w.attackTax] as const) ?? []),
        ]),
      };
      return declareAttacks(decision, () => null);
    }
    if (decision.presentationBlockDeclaration !== undefined)
      return declareBlocks(decision, () => null);
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    return { index: Math.max(pass, 0), targets: new Map() };
  });
  return offered;
}

/**
 * Whether `playerId` is required to attack with each of `creatures` in the next declaration, by
 * object id. Everything else, including the creatures with no requirement, stays home.
 */
function mustAttackIn(
  ctx: GameContext,
  playerId: string,
  creatures: readonly EnginePermanent[],
): Record<string, boolean | undefined> {
  turnOfPlayer(ctx, playerId);
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  const seen: Record<string, boolean | undefined> = {};
  for (const creature of creatures) creature.tapped = false;
  pump(runCombatAndExtraCombats(ctx), (decision) => {
    if (decision.presentationAttackDeclaration !== undefined) {
      for (const creature of creatures)
        seen[creature.id] = decision.presentationAttackDeclaration.subjects.find(
          (subject) => subject.subjectId === creature.id,
        )?.mustAttack;
      return declareAttacks(decision, (subjectId, subject) => {
        if (!subject.mustAttack) return null;
        return subject.defenders[0]?.playerId ?? subject.planeswalkers[0]?.objectId ?? null;
      });
    }
    if (decision.presentationBlockDeclaration !== undefined)
      return declareBlocks(decision, () => null);
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    return { index: Math.max(pass, 0), targets: new Map() };
  });
  return seen;
}

/**
 * Run the active player's combat phases (the regular one and any additional ones). `attacksFor`
 * gives that combat's attacks (creature object id to a player id or planeswalker object id;
 * everything else stays home), `onDeclare` sees the game just before each declaration, nobody
 * blocks, and every player passes so triggers go on the stack and resolve through the normal
 * priority loop. `answer` takes any other decision.
 */
function fight(
  ctx: GameContext,
  attacksFor: (combat: number) => Record<string, string>,
  answer?: Answer,
  onDeclare?: (combat: number) => void,
  onBlockers?: (combat: number) => void,
) {
  let combats = 0;
  const run = pump(runCombatAndExtraCombats(ctx), (decision, count) => {
    if (decision.presentationAttackDeclaration !== undefined) {
      const combat = combats++;
      const attacks = attacksFor(combat);
      onDeclare?.(combat);
      return declareAttacks(decision, (subjectId) => attacks[subjectId] ?? null);
    }
    if (decision.presentationBlockDeclaration !== undefined) {
      onBlockers?.(combats - 1);
      return declareBlocks(decision, () => null);
    }
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    if (pass >= 0) return { index: pass, targets: new Map() };
    return answer?.(decision, count) ?? { index: 0, targets: new Map() };
  });
  return { combats, decisions: run.decisions };
}

/** Pays energy when offered; with `decline`, always declines. */
const payEnergy =
  (decline = false): Answer =>
  (decision) => {
    const index = decision.options.findIndex((option) =>
      decline ? option.type === 'decline' : /^Pay \d+ energy$/.test(option.description),
    );
    return { index: Math.max(index, 0), targets: new Map() };
  };

/** Aim every targeted trigger at `target` (a player id or a permanent's object id). */
const aimAt =
  (target: string, offered?: string[][]): Answer =>
  (decision) => {
    const slot = decision.options[0]?.targets?.[0];
    if (slot === undefined) return { index: 0, targets: new Map() };
    offered?.push([...slot.options]);
    return { index: 0, targets: new Map([[slot.slot, target]]) };
  };

const handSize = (ctx: GameContext, playerId: string) => playerById(ctx, playerId).hand.length;

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

/** It is `playerId`'s end step: its beginning-of-end-step triggers go on the stack and resolve. */
function endStepOf(ctx: GameContext, playerId: string, answer?: Answer) {
  turnOfPlayer(ctx, playerId);
  ctx.state.phase = 'ending';
  beginEndStep(ctx);
  pump(priorityCheckpoint(ctx), answer);
  return settle(ctx, answer);
}

/** It is `playerId`'s upkeep: its beginning-of-upkeep triggers go on the stack and resolve. */
function upkeepOf(ctx: GameContext, playerId: string, answer?: Answer) {
  turnOfPlayer(ctx, playerId);
  ctx.state.phase = 'beginning';
  ctx.state.step = 'upkeep';
  queueStepTriggers(ctx, 'upkeep');
  pump(priorityCheckpoint(ctx), answer);
  return settle(ctx, answer);
}

const AURA = (name: string) =>
  oracle({ name, typeLine: 'Enchantment — Aura', manaCost: '{1}', power: null, toughness: null });
/** An Aura that enchants a player (a Curse), so it can stay attached to one. */
const CURSE = (name: string) =>
  oracle({
    name,
    typeLine: 'Enchantment — Aura Curse',
    manaCost: '{1}',
    power: null,
    toughness: null,
    oracleText: 'Enchant player',
  });

/** Attach `aura` (a permanent) to a creature or player, as an Aura attached on an earlier turn. */
function attach(aura: EnginePermanent, to: EnginePermanent | string): void {
  aura.attachedTo = typeof to === 'string' ? to : to.id;
}

// ---------------------------------------------------------------------------------------------
// PR07.04 Promise of Loyalty
// ---------------------------------------------------------------------------------------------

describe('Promise of Loyalty', () => {
  const { card } = pinned('Promise of Loyalty');
  const COST = [...white(1), ...generic(4)];

  /** Every player controls two named creatures; P1 holds the Promise. */
  function board(seed: string) {
    const ctx = pod(seed);
    const creatures: Record<string, EnginePermanent[]> = {};
    for (const id of ['P1', 'P2', 'P3', 'P4']) {
      creatures[id] = [
        spawn(ctx, id, GRIZZLY(`${id} Keeper`)),
        spawn(ctx, id, GRIZZLY(`${id} Spare`)),
      ];
    }
    return { ctx, creatures };
  }

  /** Each deciding player keeps their own "Keeper" and the decider order is recorded. */
  function keepKeepers(order: string[]): Answer {
    return (decision) => {
      order.push(decision.player);
      const index = decision.options.findIndex((option) =>
        option.description.includes(`${decision.player} Keeper`),
      );
      return { index: Math.max(index, 0), targets: new Map() };
    };
  }

  const stillThere = (ctx: GameContext, perm: EnginePermanent) =>
    ctx.state.battlefield.some((candidate) => candidate.id === perm.id);

  it('promise-of-loyalty-pinned-oracle-supported — the authored override carries the whole Oracle line under both ids', () => {
    expectModeled(card);
    for (const id of [card.oracleId, fixtureOracleId(card.name)]) {
      const override = getOverride(id);
      expect(override?.unsupportedReason, id).toBeUndefined();
      expect(override?.def.spellAbility?.effects, id).toEqual([
        { op: 'eachPlayerKeepsCreatureWithVow' },
      ]);
    }
    expect(interpretCard(card).spellAbility).toBeDefined();
  });

  it('promise-of-loyalty-keep-one — every player keeps one creature in turn order and sacrifices the rest, each kept creature gaining a vow counter', () => {
    const { ctx, creatures } = board('promise-keep');
    // The active player chooses first, then each other player in turn order (CR 101.4).
    turnOfPlayer(ctx, 'P2');
    const order: string[] = [];
    castFromHand(ctx, 'P2', card, COST);
    resolveTop(ctx, keepKeepers(order));
    expect(order).toEqual(['P2', 'P3', 'P4', 'P1']);
    for (const id of ['P1', 'P2', 'P3', 'P4']) {
      const [keeper, spare] = creatures[id]!;
      expect(stillThere(ctx, keeper!), `${id} keeper`).toBe(true);
      expect(keeper!.counters['vow'], `${id} vow counter`).toBe(1);
      expect(stillThere(ctx, spare!), `${id} spare`).toBe(false);
      expect(playerById(ctx, id).graveyard.map((entry) => entry.name)).toContain(`${id} Spare`);
    }
    expect(ctx.state.stack).toEqual([]);
  });

  it("promise-of-loyalty-cant-attack-you — a vowed creature can't attack the caster or the caster's planeswalkers, but can attack other players and their planeswalkers", () => {
    const { ctx, creatures } = board('promise-restriction');
    const casterWalker = spawn(ctx, 'P1', WALKER('P1 Walker'));
    const otherWalker = spawn(ctx, 'P3', WALKER('P3 Walker'));
    castFromHand(ctx, 'P1', card, COST);
    resolveTop(ctx, keepKeepers([]));
    const vowed = creatures['P2']![0]!;
    const offered = attackOptionsFor(ctx, 'P2', vowed);
    expect(offered.players.sort()).toEqual(['P3', 'P4']);
    expect(offered.planeswalkers).toEqual([otherWalker.id]);
    expect(offered.planeswalkers).not.toContain(casterWalker.id);
    // The caster's own vowed creature is not restricted against the caster's opponents.
    expect(attackOptionsFor(ctx, 'P1', creatures['P1']![0]!).players.sort()).toEqual([
      'P2',
      'P3',
      'P4',
    ]);
  });

  it("promise-of-loyalty-later-creatures — a creature that enters after Promise resolves has no vow counter and isn't restricted", () => {
    const { ctx } = board('promise-later');
    castFromHand(ctx, 'P1', card, COST);
    resolveTop(ctx, keepKeepers([]));
    const latecomer = spawn(ctx, 'P2', GRIZZLY('P2 Latecomer'));
    expect(latecomer.counters['vow']).toBeUndefined();
    expect(attackOptionsFor(ctx, 'P2', latecomer).players.sort()).toEqual(['P1', 'P3', 'P4']);
  });

  it('promise-of-loyalty-counter-removed — the restriction ends when the vow counter is removed and does not return with a new counter', () => {
    const { ctx, creatures } = board('promise-counter');
    castFromHand(ctx, 'P1', card, COST);
    resolveTop(ctx, keepKeepers([]));
    const vowed = creatures['P2']![0]!;
    expect(attackOptionsFor(ctx, 'P2', vowed).players).not.toContain('P1');
    const source = {
      cardId: vowed.cardId,
      oracleId: vowed.oracleId,
      name: vowed.name,
      controllerId: 'P2',
    };
    const change = (op: 'removeCounters' | 'putCounters') =>
      pump(
        executeAbility(
          ctx,
          source,
          spell({
            targets: [{ kind: 'permanent' }],
            effects: [{ op, target: 0, counter: 'vow', count: 1 }],
          }),
          [vowed.id],
        ),
      );
    change('removeCounters');
    expect(attackOptionsFor(ctx, 'P2', vowed).players).toContain('P1');
    change('putCounters');
    expect(attackOptionsFor(ctx, 'P2', vowed).players).toContain('P1');
  });

  it("promise-of-loyalty-phasing — a creature that phases out and back in keeps its vow counter and still can't attack the caster (CR 702.26)", () => {
    const { ctx, creatures } = board('promise-phasing');
    castFromHand(ctx, 'P1', card, COST);
    resolveTop(ctx, keepKeepers([]));
    const vowed = creatures['P2']![0]!;
    phaseOutControlledPermanents(ctx, 'P2');
    expect(stillThere(ctx, vowed)).toBe(false);
    phaseInAtUntap(ctx, 'P2');
    expect(stillThere(ctx, vowed)).toBe(true);
    expect(vowed.counters['vow']).toBe(1);
    const offered = attackOptionsFor(ctx, 'P2', vowed);
    expect(offered.players.sort()).toEqual(['P3', 'P4']);
  });
});

// ---------------------------------------------------------------------------------------------
// PR07.03 Lightning Runner
// ---------------------------------------------------------------------------------------------

describe('Lightning Runner', () => {
  const { card } = pinned('Lightning Runner');
  const TRINKET = oracle({ name: 'Lab Trinket', typeLine: 'Artifact', manaCost: '{1}' });
  const BYSTANDER = GRIZZLY('Lab Bystander');

  /**
   * P1 controls the Runner (2/2 double strike, haste), a tapped Bear, a tapped Forest and a tapped
   * Trinket; P2 controls a tapped Bystander. P1 has `energy` energy counters.
   */
  function board(seed: string, energy: number) {
    const ctx = pod(seed);
    const runner = spawn(ctx, 'P1', card);
    const bear = spawn(ctx, 'P1', GRIZZLY('Lab Bear'), { tapped: true });
    const forestPermanent = spawn(ctx, 'P1', forest(), { tapped: true });
    const trinket = spawn(ctx, 'P1', TRINKET, { tapped: true });
    const bystander = spawn(ctx, 'P2', BYSTANDER, { tapped: true });
    playerById(ctx, 'P1').energy = energy;
    return { ctx, runner, bear, forestPermanent, trinket, bystander };
  }

  it('lightning-runner-pinned-oracle-supported — the authored override carries the attack trigger and the keywords still parse', () => {
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toEqual({ when: 'attacks', subject: { kind: 'self' } });
    expect(def.triggers[0]!.effects).toEqual([
      { op: 'gainEnergy', amount: { kind: 'const', n: 2 } },
      {
        op: 'mayPayEnergy',
        amount: { kind: 'const', n: 8 },
        then: [
          {
            op: 'untapEach',
            selector: {
              kind: 'allOf',
              of: [
                { kind: 'type', value: 'Creature' },
                { kind: 'controller', who: 'you' },
              ],
            },
          },
          { op: 'extraCombatPhase' },
        ],
      },
    ]);
    const { ctx, runner } = board('runner-keywords', 0);
    const chars = computeCharacteristics(ctx, runner);
    expect(chars.keywords).toEqual(expect.arrayContaining(['double strike', 'haste']));
  });

  it('lightning-runner-pay-eight — attacking gains two energy, then paying eight untaps only your creatures and adds a combat phase right after this one', () => {
    const { ctx, runner, bear, forestPermanent, trinket, bystander } = board('runner-pay', 6);
    const seen: { bear: boolean; bystander: boolean; land: boolean; trinket: boolean }[] = [];
    const run = fight(
      ctx,
      () => ({ [runner.id]: 'P2' }),
      payEnergy(),
      () =>
        seen.push({
          bear: bear.tapped,
          bystander: bystander.tapped,
          land: forestPermanent.tapped,
          trinket: trinket.tapped,
        }),
    );
    // Two combat phases: the regular one and the additional one.
    expect(run.combats).toBe(2);
    // 6 + 2 = 8 energy, all paid; the untapped Runner then attacks again and gains two more.
    expect(playerById(ctx, 'P1').energy).toBe(2);
    // Before the second declaration the Bear is untapped; the opposing creature, the land and the
    // artifact are not creatures you control, so they stay tapped.
    expect(seen[0]).toEqual({ bear: true, bystander: true, land: true, trinket: true });
    expect(seen[1]).toEqual({ bear: false, bystander: true, land: true, trinket: true });
    // The untapped Runner attacked again: 4 double-strike damage in each combat.
    expect(playerById(ctx, 'P2').life).toBe(40 - 8);
    expect(ctx.state.extraCombatPhases).toBe(0);
  });

  it('lightning-runner-decline — declining the payment keeps the energy and adds no combat phase', () => {
    const { ctx, runner, bear } = board('runner-decline', 6);
    const run = fight(ctx, () => ({ [runner.id]: 'P2' }), payEnergy(true));
    expect(run.combats).toBe(1);
    expect(playerById(ctx, 'P1').energy).toBe(8);
    expect(bear.tapped).toBe(true);
    expect(playerById(ctx, 'P2').life).toBe(40 - 4);
  });

  it('lightning-runner-short-of-energy — with fewer than eight energy after gaining two, no payment is offered and nothing happens', () => {
    const { ctx, runner, bear } = board('runner-short', 5);
    const run = fight(ctx, () => ({ [runner.id]: 'P2' }), payEnergy());
    expect(run.combats).toBe(1);
    expect(
      run.decisions.some((decision) =>
        decision.options.some((option) => option.type === 'payEnergy'),
      ),
    ).toBe(false);
    expect(playerById(ctx, 'P1').energy).toBe(7);
    expect(bear.tapped).toBe(true);
  });

  it('lightning-runner-chained — an additional combat made during an additional combat is also run, once each', () => {
    const { ctx, runner } = board('runner-chain', 14);
    const run = fight(ctx, () => ({ [runner.id]: 'P2' }), payEnergy());
    // 14 + 2 = 16, pay 8; in the second combat 8 + 2 = 10, pay 8; in the third 2 + 2 = 4, no payment.
    expect(run.combats).toBe(3);
    expect(playerById(ctx, 'P1').energy).toBe(4);
    expect(ctx.state.extraCombatPhases).toBe(0);
  });

  it("lightning-runner-opponent-attack — an opponent's creature attacking does not trigger it, and the Runner not attacking gains nothing", () => {
    const { ctx, bystander } = board('runner-quiet', 6);
    bystander.tapped = false;
    turnOfPlayer(ctx, 'P2');
    const run = fight(ctx, () => ({ [bystander.id]: 'P1' }));
    expect(run.combats).toBe(1);
    expect(playerById(ctx, 'P1').energy).toBe(6);
  });
});

// ---------------------------------------------------------------------------------------------
// PR07.07 Firkraag, Cunning Instigator
// ---------------------------------------------------------------------------------------------

describe('Firkraag, Cunning Instigator', () => {
  const { card } = pinned('Firkraag, Cunning Instigator');
  const DRAGON = oracle({
    name: 'Lab Dragon',
    typeLine: 'Creature — Dragon',
    manaCost: '{0}',
    power: '2',
    toughness: '2',
    oracleText: 'Flying',
  });
  const ZAP = oracle({
    name: 'Lab Zap',
    typeLine: 'Instant',
    manaCost: '{0}',
    oracleText: 'Destroy target creature.',
  });

  /** P1 controls Firkraag and a Lab Dragon; every opponent controls a Bear. */
  function board(seed: string) {
    const ctx = pod(seed);
    const firkraag = spawn(ctx, 'P1', card);
    const dragon = spawn(ctx, 'P1', DRAGON);
    const bears = {
      P2: spawn(ctx, 'P2', GRIZZLY('P2 Bear')),
      P3: spawn(ctx, 'P3', GRIZZLY('P3 Bear')),
      P4: spawn(ctx, 'P4', GRIZZLY('P4 Bear')),
    };
    // A second creature each, so a goad target is a real choice.
    const spares = {
      P2: spawn(ctx, 'P2', GRIZZLY('P2 Spare')),
      P3: spawn(ctx, 'P3', GRIZZLY('P3 Spare')),
      P4: spawn(ctx, 'P4', GRIZZLY('P4 Spare')),
    };
    return { ctx, firkraag, dragon, bears, spares };
  }

  const goaders = (perm: EnginePermanent) => (perm.goadedBy ?? []).map((entry) => entry.goaderId);

  it('firkraag-pinned-oracle-supported — the authored override carries both abilities under both ids', () => {
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(2);
    // One shared firing for each opponent attacked, aimed at a creature that opponent controls.
    expect(def.triggers[0]!.trigger).toMatchObject({
      when: 'attacks',
      aggregate: 'byEventPlayer',
      subject: {
        kind: 'permanent',
        selector: {
          kind: 'allOf',
          of: [
            { kind: 'subtype', value: 'Dragon' },
            { kind: 'controller', who: 'you' },
          ],
        },
      },
    });
    expect(def.triggers[0]!.targets).toEqual([{ kind: 'creature', controller: 'eventPlayer' }]);
    expect(def.triggers[0]!.effects).toEqual([{ op: 'goad', target: 0 }]);
    // The intervening-if is about the creature that dealt the damage.
    expect(def.triggers[1]!.trigger).toMatchObject({
      when: 'dealsCombatDamageToPlayer',
      condition: {
        kind: 'allOf',
        of: [
          { kind: 'triggerObjectHadToAttackThisCombat' },
          { kind: 'triggerObjectAttackingOpponent' },
        ],
      },
    });
    expect(def.triggers[1]!.effects).toEqual([
      { op: 'putCountersEach', selector: { kind: 'self' }, counter: '+1/+1', count: 1 },
      { op: 'draw', count: { kind: 'const', n: 1 } },
    ]);
  });

  it('firkraag-dragons-attack-goad — two Dragons attacking one opponent trigger once; the target is a creature that opponent controls and it is goaded by you', () => {
    const { ctx, firkraag, dragon, bears, spares } = board('firkraag-goad');
    const offered: string[][] = [];
    const run = fight(
      ctx,
      () => ({ [firkraag.id]: 'P2', [dragon.id]: 'P2' }),
      aimAt(bears.P2.id, offered),
    );
    expect(run.combats).toBe(1);
    expect(offered.map((options) => options.sort())).toEqual([[bears.P2.id, spares.P2.id].sort()]);
    expect(goaders(bears.P2)).toEqual(['P1']);
    expect(goaders(spares.P2)).toEqual([]);
    expect(goaders(bears.P3)).toEqual([]);
    expect(goaders(bears.P4)).toEqual([]);
  });

  it('firkraag-each-opponent — Dragons attacking two opponents trigger once for each, aimed at that opponent’s creatures only', () => {
    const { ctx, firkraag, dragon, bears, spares } = board('firkraag-two-opponents');
    const offered: string[][] = [];
    const answer: Answer = (decision) => {
      // Aim each trigger at the first creature it can target.
      const slot = decision.options[0]?.targets?.[0];
      if (slot === undefined) return { index: 0, targets: new Map() };
      offered.push([...slot.options]);
      return { index: 0, targets: new Map([[slot.slot, [...slot.options].sort()[0]!]]) };
    };
    fight(ctx, () => ({ [firkraag.id]: 'P2', [dragon.id]: 'P3' }), answer);
    // One trigger per attacked opponent, each limited to that opponent's own creatures.
    expect(offered.map((options) => options.sort()).sort()).toEqual(
      [[bears.P2.id, spares.P2.id].sort(), [bears.P3.id, spares.P3.id].sort()].sort(),
    );
    const goaded = ctx.state.battlefield.filter((perm) => goaders(perm).length > 0);
    expect(goaded.map((perm) => perm.controllerId).sort()).toEqual(['P2', 'P3']);
    expect(goaded.every((perm) => goaders(perm)[0] === 'P1')).toBe(true);
    expect(goaders(bears.P4)).toEqual([]);
  });

  it('firkraag-negatives — a non-Dragon attacking, an opponent’s Dragon attacking, or a Dragon attacking only a planeswalker does not trigger the goad', () => {
    const { ctx, firkraag, dragon, bears } = board('firkraag-no-trigger');
    const bear = spawn(ctx, 'P1', GRIZZLY('P1 Bear'));
    const walker = spawn(ctx, 'P2', WALKER('P2 Walker'));
    // A non-Dragon attacks a player; both Dragons attack only a planeswalker.
    const offered: string[][] = [];
    fight(
      ctx,
      () => ({ [bear.id]: 'P2', [firkraag.id]: walker.id, [dragon.id]: walker.id }),
      aimAt(bears.P2.id, offered),
    );
    expect(offered).toEqual([]);
    expect(goaders(bears.P2)).toEqual([]);
    // An opponent's Dragon attacking does not trigger it either (it is not a Dragon you control).
    const rival = spawn(ctx, 'P2', DRAGON);
    turnOfPlayer(ctx, 'P2');
    fight(ctx, () => ({ [rival.id]: 'P3' }), aimAt(bears.P3.id, offered));
    expect(offered).toEqual([]);
    expect(goaders(bears.P3)).toEqual([]);
  });

  it('firkraag-draw-and-counter — a creature that had to attack deals combat damage to one of your opponents: Firkraag gets a +1/+1 counter and you draw', () => {
    const { ctx, firkraag, bears } = board('firkraag-damage');
    // P2's Bear is goaded by you: it must attack, and not you.
    bears.P2.goadedBy = [{ goaderId: 'P1', appliedTurn: ctx.state.turnNumber }];
    turnOfPlayer(ctx, 'P2');
    const before = handSize(ctx, 'P1');
    fight(ctx, () => ({ [bears.P2.id]: 'P3' }));
    expect(playerById(ctx, 'P3').life).toBe(38);
    expect(firkraag.counters['+1/+1']).toBe(1);
    expect(handSize(ctx, 'P1')).toBe(before + 1);
    expect(ctx.state.stack).toEqual([]);
  });

  it('firkraag-damage-negatives — no counter or card when the creature did not have to attack, when the damaged player is not your opponent, or when the damage goes to a planeswalker', () => {
    const { ctx, firkraag, bears } = board('firkraag-damage-negatives');
    const before = handSize(ctx, 'P1');
    // Not required to attack: a plain attack on P3.
    turnOfPlayer(ctx, 'P2');
    fight(ctx, () => ({ [bears.P2.id]: 'P3' }));
    expect(playerById(ctx, 'P3').life).toBe(38);
    // Required to attack (goaded by P3), but it hits YOU, who are not your own opponent.
    bears.P2.tapped = false;
    bears.P2.goadedBy = [{ goaderId: 'P3', appliedTurn: ctx.state.turnNumber }];
    fight(ctx, () => ({ [bears.P2.id]: 'P1' }));
    expect(playerById(ctx, 'P1').life).toBe(38);
    // Required to attack, but it attacks a planeswalker, which is not damage to a player.
    const walker = spawn(ctx, 'P4', WALKER('P4 Walker'));
    bears.P2.tapped = false;
    bears.P2.goadedBy = [{ goaderId: 'P1', appliedTurn: ctx.state.turnNumber }];
    fight(ctx, () => ({ [bears.P2.id]: walker.id }));
    expect(firkraag.counters['+1/+1']).toBeUndefined();
    expect(handSize(ctx, 'P1')).toBe(before);
  });

  it('firkraag-any-creature — your own creature that had to attack counts too, hitting an opponent', () => {
    const { ctx, firkraag, dragon, bears } = board('firkraag-own-creature');
    dragon.goadedBy = [{ goaderId: 'P2', appliedTurn: ctx.state.turnNumber }];
    const before = handSize(ctx, 'P1');
    // Goaded by P2, the Dragon may not attack P2: it attacks P3.
    fight(ctx, () => ({ [dragon.id]: 'P3' }), aimAt(bears.P3.id));
    expect(firkraag.counters['+1/+1']).toBe(1);
    expect(handSize(ctx, 'P1')).toBe(before + 1);
  });

  it('firkraag-last-known-information — the intervening-if still holds when the damaging creature has left the battlefield before the trigger resolves', () => {
    const { ctx, firkraag, bears } = board('firkraag-lki');
    bears.P2.goadedBy = [{ goaderId: 'P1', appliedTurn: ctx.state.turnNumber }];
    turnOfPlayer(ctx, 'P2');
    const zap = conjure(ctx, 'P1', ZAP, 'hand');
    const before = handSize(ctx, 'P1');
    let cast = false;
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId) => (subjectId === bears.P2.id ? 'P3' : null));
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      // With the Firkraag trigger on the stack, destroy the Bear in response.
      const option = decision.options.findIndex(
        (candidate) => decision.player === 'P1' && candidate.description.includes('Lab Zap'),
      );
      if (option >= 0 && !cast && ctx.state.stack.length > 0) {
        cast = true;
        const slot = decision.options[option]!.targets![0]!;
        return { index: option, targets: new Map([[slot.slot, bears.P2.id]]) };
      }
      const pass = decision.options.findIndex((candidate) => candidate.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    expect(cast).toBe(true);
    expect(ctx.state.battlefield.some((perm) => perm.id === bears.P2.id)).toBe(false);
    expect(firkraag.counters['+1/+1']).toBe(1);
    // The Zap left your hand, and you drew from Firkraag.
    expect(handSize(ctx, 'P1')).toBe(before);
    expect(playerById(ctx, 'P1').graveyard.map((entry) => entry.cardId)).toContain(zap.cardId);
  });

  it('firkraag-goad-then-damage — cast Firkraag, attack with it, goad through the stack, then the goaded creature must attack on its controller’s turn and pays you off', () => {
    const ctx = pod('firkraag-chain');
    const bear = spawn(ctx, 'P2', GRIZZLY('P2 Bear'));
    spawn(ctx, 'P3', GRIZZLY('P3 Bear'));
    const firkraagObject = castFromHand(ctx, 'P1', card, [
      { symbol: 'U' },
      { symbol: 'R' },
      ...generic(3),
    ]);
    pump(resolveTopOfStack(ctx));
    const firkraag = ctx.state.battlefield.find((perm) => perm.cardId === firkraagObject.cardId)!;
    // Haste: it attacks this turn; its trigger puts a goad on P2's Bear.
    fight(ctx, () => ({ [firkraag.id]: 'P2' }), aimAt(bear.id));
    expect(goaders(bear)).toEqual(['P1']);
    // P2's turn: the goaded Bear must attack, and not P1.
    turnOfPlayer(ctx, 'P2');
    ctx.state.turnNumber += 1;
    const before = handSize(ctx, 'P1');
    let mustAttack = false;
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId, subject) => {
          if (subjectId !== bear.id) return null;
          mustAttack = subject.mustAttack;
          expect(subject.defenders.map((defender) => defender.playerId)).not.toContain('P1');
          return 'P3';
        });
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      const pass = decision.options.findIndex((candidate) => candidate.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    expect(mustAttack).toBe(true);
    expect(firkraag.counters['+1/+1']).toBe(1);
    expect(handSize(ctx, 'P1')).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------------------------
// PR07.06 Eriette of the Charmed Apple
// ---------------------------------------------------------------------------------------------

describe('Eriette of the Charmed Apple', () => {
  const { card } = pinned('Eriette of the Charmed Apple');

  /** P1 controls Eriette; each opponent controls a Bear. */
  function board(seed: string) {
    const ctx = pod(seed);
    const eriette = spawn(ctx, 'P1', card);
    const bears = {
      P2: spawn(ctx, 'P2', GRIZZLY('P2 Bear')),
      P3: spawn(ctx, 'P3', GRIZZLY('P3 Bear')),
      P4: spawn(ctx, 'P4', GRIZZLY('P4 Bear')),
    };
    return { ctx, eriette, bears };
  }

  it('eriette-pinned-oracle-supported — the authored override carries the attack restriction and the end-step drain under both ids', () => {
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.ruleStatics).toEqual([
      {
        kind: 'attackRestriction',
        filter: { kind: 'enchantedByAuraYouControl' },
        includePlaneswalkers: true,
      },
    ]);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toEqual({ when: 'endStep', player: 'you' });
    const x = {
      kind: 'countPermanents',
      selector: {
        kind: 'allOf',
        of: [
          { kind: 'subtype', value: 'Aura' },
          { kind: 'controller', who: 'you' },
        ],
      },
      scope: 'you',
    };
    expect(def.triggers[0]!.effects).toEqual([
      { op: 'eachOpponentLosesLife', amount: x },
      { op: 'gainLife', amount: x },
    ]);
  });

  it("eriette-cant-attack-you — a creature enchanted by an Aura you control can't attack you or your planeswalkers, whoever controls the creature or the Aura's host", () => {
    const { ctx, bears } = board('eriette-restriction');
    const walker = spawn(ctx, 'P1', WALKER('P1 Walker'));
    const otherWalker = spawn(ctx, 'P3', WALKER('P3 Walker'));
    // Your Aura on P2's Bear, P3's Aura on P3's Bear (not yours), and nothing on P4's Bear.
    attach(spawn(ctx, 'P1', AURA('P1 Aura')), bears.P2);
    attach(spawn(ctx, 'P3', AURA('P3 Aura')), bears.P3);
    const enchanted = attackOptionsFor(ctx, 'P2', bears.P2);
    expect(enchanted.players.sort()).toEqual(['P3', 'P4']);
    expect(enchanted.planeswalkers).toEqual([otherWalker.id]);
    expect(enchanted.planeswalkers).not.toContain(walker.id);
    // An Aura another player controls does not restrict attacks on you; neither does having none.
    expect(attackOptionsFor(ctx, 'P3', bears.P3).players.sort()).toEqual(['P1', 'P2', 'P4']);
    expect(attackOptionsFor(ctx, 'P4', bears.P4).players.sort()).toEqual(['P1', 'P2', 'P3']);
  });

  it('eriette-restriction-follows-the-aura — it applies as the Aura attaches and ends when the Aura leaves, and an enchantment that is not an Aura does nothing', () => {
    const { ctx, bears } = board('eriette-aura-leaves');
    // The Aura starts on another creature (an unattached Aura would go to the graveyard) and an
    // enchantment that is not an Aura stays on this one.
    const aura = spawn(ctx, 'P1', AURA('P1 Aura'));
    attach(aura, bears.P3);
    const plain = spawn(
      ctx,
      'P1',
      oracle({ name: 'P1 Enchantment', typeLine: 'Enchantment', manaCost: '{1}', power: null }),
    );
    attach(plain, bears.P2);
    expect(attackOptionsFor(ctx, 'P2', bears.P2).players).toContain('P1');
    // Moving the Aura onto this creature (CR 303.4) restricts it, and takes the restriction off the other.
    attach(aura, bears.P2);
    expect(attackOptionsFor(ctx, 'P2', bears.P2).players).not.toContain('P1');
    expect(attackOptionsFor(ctx, 'P3', bears.P3).players).toContain('P1');
    ctx.state.battlefield = ctx.state.battlefield.filter((perm) => perm.id !== aura.id);
    expect(attackOptionsFor(ctx, 'P2', bears.P2).players).toContain('P1');
  });

  it('eriette-drain — at your end step each opponent loses X and you gain X, where X counts every Aura you control, attached to anything', () => {
    const { ctx, bears } = board('eriette-drain');
    // Four Auras you control: on an opponent's creature, on your own, on a player, and on one of
    // your own creatures too. Auras and enchantments you do not control or that are not Auras do
    // not count.
    const mine = spawn(ctx, 'P1', GRIZZLY('P1 Bear'));
    attach(spawn(ctx, 'P1', AURA('Aura A')), bears.P2);
    attach(spawn(ctx, 'P1', AURA('Aura B')), mine);
    attach(spawn(ctx, 'P1', CURSE('Aura C')), 'P3');
    attach(spawn(ctx, 'P1', AURA('Aura D')), bears.P4);
    attach(spawn(ctx, 'P2', AURA('Their Aura')), bears.P2);
    spawn(
      ctx,
      'P1',
      oracle({ name: 'P1 Enchantment', typeLine: 'Enchantment', manaCost: '{1}', power: null }),
    );
    endStepOf(ctx, 'P1');
    expect(playerById(ctx, 'P1').life).toBe(44);
    for (const id of ['P2', 'P3', 'P4']) expect(playerById(ctx, id).life, id).toBe(36);
    expect(ctx.state.stack).toEqual([]);
  });

  it("eriette-drain-your-turn-only — it does not trigger at an opponent's end step, and with no Auras it drains nothing", () => {
    const { ctx, bears } = board('eriette-drain-negatives');
    attach(spawn(ctx, 'P1', AURA('Aura A')), bears.P2);
    endStepOf(ctx, 'P2');
    expect(playerById(ctx, 'P1').life).toBe(40);
    expect(playerById(ctx, 'P2').life).toBe(40);
    const empty = board('eriette-no-auras');
    endStepOf(empty.ctx, 'P1');
    expect(playerById(empty.ctx, 'P1').life).toBe(40);
    expect(playerById(empty.ctx, 'P2').life).toBe(40);
  });

  it('eriette-cast-and-attack — cast Eriette through the stack, and a creature already enchanted by your Aura then has no attack on you', () => {
    const ctx = pod('eriette-cast');
    const bear = spawn(ctx, 'P2', GRIZZLY('P2 Bear'));
    attach(spawn(ctx, 'P1', AURA('P1 Aura')), bear);
    expect(attackOptionsFor(ctx, 'P2', bear).players).toContain('P1');
    turnOfPlayer(ctx, 'P1');
    ctx.state.phase = 'precombatMain';
    castFromHand(ctx, 'P1', card, [{ symbol: 'W' }, { symbol: 'B' }, ...generic(1)]);
    resolveTop(ctx);
    expect(ctx.state.battlefield.some((perm) => perm.name === 'Eriette of the Charmed Apple')).toBe(
      true,
    );
    expect(attackOptionsFor(ctx, 'P2', bear).players).not.toContain('P1');
  });
});

// ---------------------------------------------------------------------------------------------
// PR07.21 Rite of the Raging Storm
// ---------------------------------------------------------------------------------------------

describe('Rite of the Raging Storm', () => {
  const { card } = pinned('Rite of the Raging Storm');
  const RAGER = (name = 'Lightning Rager') =>
    oracle({ name, typeLine: 'Creature — Elemental', power: '5', toughness: '1' });

  /** P1 controls Rite of the Raging Storm. */
  function board(seed: string) {
    const ctx = pod(seed);
    const rite = spawn(ctx, 'P1', card);
    return { ctx, rite };
  }

  const ragers = (ctx: GameContext) =>
    ctx.state.battlefield.filter((perm) => perm.name === 'Lightning Rager' && perm.isToken);

  it('rite-of-the-raging-storm-pinned-oracle-supported — the authored override carries the named restriction and the upkeep token under both ids', () => {
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.ruleStatics).toEqual([
      {
        kind: 'attackRestriction',
        filter: { kind: 'name', value: 'Lightning Rager' },
        includePlaneswalkers: true,
      },
    ]);
    expect(def.triggers).toHaveLength(1);
    // Each player's upkeep, not only yours; the token is made for that player.
    expect(def.triggers[0]!.trigger).toEqual({ when: 'upkeep', player: 'each' });
    const [effect] = def.triggers[0]!.effects;
    expect(effect).toMatchObject({
      op: 'createTokenForPlayer',
      target: 'eventPlayer',
      count: { kind: 'const', n: 1 },
      spec: {
        name: 'Lightning Rager',
        types: ['Creature'],
        subtypes: ['Elemental'],
        colors: ['R'],
        power: 5,
        toughness: 1,
        keywords: ['trample', 'haste'],
      },
    });
  });

  it("rite-of-the-raging-storm-cant-attack-you — creatures named Lightning Rager, whoever controls them, can't attack you or your planeswalkers; other creatures can", () => {
    const { ctx } = board('rite-restriction');
    const walker = spawn(ctx, 'P1', WALKER('P1 Walker'));
    const otherWalker = spawn(ctx, 'P3', WALKER('P3 Walker'));
    const rager = spawn(ctx, 'P2', RAGER());
    const lookalike = spawn(ctx, 'P2', RAGER('Lightning Rager Fan'));
    const offered = attackOptionsFor(ctx, 'P2', rager);
    expect(offered.players.sort()).toEqual(['P3', 'P4']);
    expect(offered.planeswalkers).toEqual([otherWalker.id]);
    expect(offered.planeswalkers).not.toContain(walker.id);
    expect(attackOptionsFor(ctx, 'P2', lookalike).players).toContain('P1');
    // Your own Lightning Rager is not restricted against anyone else.
    const mine = spawn(ctx, 'P1', RAGER());
    expect(attackOptionsFor(ctx, 'P1', mine).players.sort()).toEqual(['P2', 'P3', 'P4']);
  });

  it('rite-of-the-raging-storm-copies-and-face-down — a copy of a Lightning Rager has the name and is restricted, while a face-down creature has no name and is not', () => {
    const { ctx } = board('rite-copy');
    const rager = spawn(ctx, 'P3', RAGER());
    const clay = spawn(ctx, 'P2', GRIZZLY('Lab Clay'));
    expect(attackOptionsFor(ctx, 'P2', clay).players).toContain('P1');
    applyCopy(ctx, clay, rager);
    expect(attackOptionsFor(ctx, 'P2', clay).players).not.toContain('P1');
    const hidden = spawn(ctx, 'P2', RAGER());
    hidden.faceDown = true;
    expect(attackOptionsFor(ctx, 'P2', hidden).players).toContain('P1');
  });

  it("rite-of-the-raging-storm-upkeep-token — at each player's upkeep THAT player creates the 5/1 red Elemental Lightning Rager with trample and haste", () => {
    const { ctx } = board('rite-upkeep');
    for (const id of ['P1', 'P2', 'P3']) upkeepOf(ctx, id);
    const tokens = ragers(ctx);
    expect(tokens.map((token) => token.controllerId).sort()).toEqual(['P1', 'P2', 'P3']);
    for (const token of tokens) {
      const chars = computeCharacteristics(ctx, token);
      expect(chars.power).toBe(5);
      expect(chars.toughness).toBe(1);
      expect(chars.colors).toEqual(['R']);
      expect(chars.subtypes).toEqual(['Elemental']);
      expect(chars.keywords).toEqual(expect.arrayContaining(['trample', 'haste']));
    }
    // A player who is not the active player gets nothing: P4's upkeep has not come.
    expect(tokens.some((token) => token.controllerId === 'P4')).toBe(false);
  });

  it('rite-of-the-raging-storm-two-rites — each Rite makes its own token at each upkeep, and each restricts attacks on its own controller', () => {
    const { ctx } = board('rite-two');
    spawn(ctx, 'P3', card);
    upkeepOf(ctx, 'P2');
    expect(ragers(ctx).map((token) => token.controllerId)).toEqual(['P2', 'P2']);
    // P1's and P3's Rites both forbid it: it can attack neither of them.
    expect(attackOptionsFor(ctx, 'P2', ragers(ctx)[0]!).players).toEqual(['P4']);
  });

  it('rite-of-the-raging-storm-sacrifice — the token is sacrificed at the beginning of the next end step, whoever’s end step it is', () => {
    const { ctx } = board('rite-sacrifice');
    upkeepOf(ctx, 'P2');
    expect(ragers(ctx)).toHaveLength(1);
    endStepOf(ctx, 'P2');
    expect(ragers(ctx)).toEqual([]);
    // A token made at P2's upkeep that is still around at P3's end step is sacrificed then.
    const second = board('rite-sacrifice-other-end-step');
    upkeepOf(second.ctx, 'P2');
    expect(ragers(second.ctx)).toHaveLength(1);
    endStepOf(second.ctx, 'P3');
    expect(ragers(second.ctx)).toEqual([]);
  });

  it('rite-of-the-raging-storm-whole-turn — P2 gets a Lightning Rager at upkeep, it attacks (haste) P3 but cannot attack P1, and it is sacrificed at the end step', () => {
    const { ctx } = board('rite-turn');
    upkeepOf(ctx, 'P2');
    const [token] = ragers(ctx);
    expect(token!.controllerId).toBe('P2');
    ctx.state.phase = 'precombatMain';
    ctx.state.step = null;
    const offered = attackOptionsFor(ctx, 'P2', token!);
    expect(offered.players.sort()).toEqual(['P3', 'P4']);
    ctx.state.phase = 'precombatMain';
    ctx.state.step = null;
    fight(ctx, () => ({ [token!.id]: 'P3' }));
    expect(playerById(ctx, 'P3').life).toBe(35);
    expect(playerById(ctx, 'P1').life).toBe(40);
    endStepOf(ctx, 'P2');
    expect(ragers(ctx)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// PR07.09 Nils, Discipline Enforcer
// ---------------------------------------------------------------------------------------------

describe('Nils, Discipline Enforcer', () => {
  const { card } = pinned('Nils, Discipline Enforcer');

  /** P1 controls Nils and a Wolf; every opponent controls two Bears. */
  function board(seed: string) {
    const ctx = pod(seed);
    const nils = spawn(ctx, 'P1', card);
    const mine = spawn(ctx, 'P1', GRIZZLY('P1 Wolf'));
    const bears: Record<string, EnginePermanent[]> = {};
    for (const id of ['P2', 'P3', 'P4'])
      bears[id] = [spawn(ctx, id, GRIZZLY(`${id} Bear`)), spawn(ctx, id, GRIZZLY(`${id} Cub`))];
    return { ctx, nils, mine, bears };
  }

  /**
   * Answers each per-player target prompt (it names the player) with the creature named in
   * `picks` for that player, or declines when the player has no entry. Records every prompt.
   */
  function choose(picks: Record<string, string>, asked: string[] = []): Answer {
    return (decision) => {
      asked.push(decision.prompt);
      const player = /controlled by (P\d)/.exec(decision.prompt)?.[1];
      const wanted = player === undefined ? undefined : picks[player];
      const index = decision.options.findIndex(
        (option) => wanted !== undefined && option.description === `Target ${wanted}`,
      );
      if (index >= 0) return { index, targets: new Map() };
      const decline = decision.options.findIndex((option) => option.type === 'decline');
      return { index: Math.max(decline, 0), targets: new Map() };
    };
  }

  const plus = (perm: EnginePermanent) => perm.counters['+1/+1'] ?? 0;

  it('nils-pinned-oracle-supported — the authored override carries the per-player counter trigger and the costed attack restriction under both ids', () => {
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.ruleStatics).toEqual([
      {
        kind: 'attackRestriction',
        filter: {
          kind: 'allOf',
          of: [{ kind: 'type', value: 'Creature' }, { kind: 'hasAnyCounter' }],
        },
        includePlaneswalkers: true,
        cost: { perCounterOnCreature: true },
      },
    ]);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toEqual({ when: 'endStep', player: 'you' });
    expect(def.triggers[0]!.targets).toEqual([
      { kind: 'creature', count: { min: 0, max: 1 }, perPlayer: true },
    ]);
    expect(def.triggers[0]!.effects).toEqual([
      { op: 'putCountersEachChosen', targetSlot: 0, counter: '+1/+1', count: 1 },
    ]);
  });

  it('nils-per-player-targets — the trigger asks for up to one creature for each player, you included, and each chosen creature gets a +1/+1 counter', () => {
    const { ctx, mine, bears } = board('nils-targets');
    const asked: string[] = [];
    endStepOf(
      ctx,
      'P1',
      choose({ P1: 'P1 Wolf', P2: 'P2 Cub', P3: 'P3 Bear', P4: 'P4 Cub' }, asked),
    );
    // One prompt for each of the four players, in turn order starting with you.
    expect(asked.map((prompt) => /controlled by (P\d)/.exec(prompt)?.[1])).toEqual([
      'P1',
      'P2',
      'P3',
      'P4',
    ]);
    expect(plus(mine)).toBe(1);
    expect([bears['P2']!, bears['P3']!, bears['P4']!].map((pair) => pair.map(plus))).toEqual([
      [0, 1],
      [1, 0],
      [0, 1],
    ]);
    expect(ctx.state.stack).toEqual([]);
  });

  it('nils-up-to-one — at most one creature per player, and any player may be left out', () => {
    const { ctx, mine, bears } = board('nils-up-to-one');
    const asked: string[] = [];
    // Decline for you and for P3 and P4; P2 picks a Bear. Once P2 has a target its slot is done:
    // the Cub is never offered as a second target.
    endStepOf(ctx, 'P1', choose({ P2: 'P2 Bear' }, asked));
    expect(plus(mine)).toBe(0);
    expect(bears['P2']!.map(plus)).toEqual([1, 0]);
    expect(bears['P3']!.map(plus)).toEqual([0, 0]);
    expect(bears['P4']!.map(plus)).toEqual([0, 0]);
    expect(asked).toHaveLength(4);
  });

  it('nils-options-per-player — each slot offers only that player’s creatures, and a player with no creatures is not asked', () => {
    const { ctx, bears } = board('nils-options');
    ctx.state.battlefield = ctx.state.battlefield.filter((perm) => perm.controllerId !== 'P3');
    const offered = new Map<string, string[]>();
    endStepOf(ctx, 'P1', (decision) => {
      const player = /controlled by (P\d)/.exec(decision.prompt)?.[1] ?? 'unknown';
      offered.set(
        player,
        decision.options.filter((option) => option.type === 'pickTarget').map((o) => o.description),
      );
      return { index: 0, targets: new Map() };
    });
    expect([...offered.keys()]).toEqual(['P1', 'P2', 'P4']);
    expect(offered.get('P2')!.sort()).toEqual(['Target P2 Bear', 'Target P2 Cub']);
    expect(offered.get('P4')!.sort()).toEqual(['Target P4 Bear', 'Target P4 Cub']);
    expect(offered.get('P1')!.sort()).toEqual([
      'Target Nils, Discipline Enforcer',
      'Target P1 Wolf',
    ]);
    expect(bears['P3']!.map(plus)).toEqual([0, 0]);
  });

  it('nils-eliminated-player — a player who has left the game gets no slot', () => {
    const { ctx } = board('nils-eliminated');
    ctx.state.battlefield = ctx.state.battlefield.filter((perm) => perm.controllerId !== 'P4');
    playerById(ctx, 'P4').hasLost = true;
    const asked: string[] = [];
    endStepOf(ctx, 'P1', choose({}, asked));
    expect(asked.map((prompt) => /controlled by (P\d)/.exec(prompt)?.[1])).toEqual([
      'P1',
      'P2',
      'P3',
    ]);
  });

  it('nils-recheck-on-resolution — a target that is no longer that player’s creature as the trigger resolves gets nothing, the others still do', () => {
    const { ctx, bears } = board('nils-recheck');
    turnOfPlayer(ctx, 'P1');
    ctx.state.phase = 'ending';
    beginEndStep(ctx);
    pump(priorityCheckpoint(ctx), choose({ P2: 'P2 Bear', P3: 'P3 Bear' }));
    expect(ctx.state.stack).toHaveLength(1);
    // In response, P2's chosen Bear changes controllers: it is no longer a creature P2 controls.
    bears['P2']![0]!.controllerId = 'P4';
    resolveTop(ctx);
    expect(plus(bears['P2']![0]!)).toBe(0);
    expect(plus(bears['P3']![0]!)).toBe(1);
    expect(ctx.state.stack).toEqual([]);
  });

  it('nils-attack-tax — a creature with counters can attack you or your planeswalkers only by paying {X}, X being its counters of any kind; others, and attacks elsewhere, cost nothing', () => {
    const { ctx, bears } = board('nils-tax');
    const walker = spawn(ctx, 'P1', WALKER('P1 Walker'));
    const bear = bears['P2']![0]!;
    bear.counters = { '+1/+1': 2, shield: 1 };
    const lands = Array.from({ length: 3 }, () => spawn(ctx, 'P2', forest()));
    // What it is offered: {3} to attack you or your planeswalker, nothing to attack anyone else.
    const offered = attackOptionsFor(ctx, 'P2', bear);
    expect(offered.taxes['P1']).toBe(3);
    expect(offered.taxes[walker.id]).toBe(3);
    expect(offered.taxes['P3']).toBe(0);
    // A creature with no counters pays nothing to attack you.
    expect(attackOptionsFor(ctx, 'P2', bears['P2']![1]!).taxes['P1']).toBe(0);
    // Declared and paid: three generic mana, one for each counter.
    fight(ctx, () => ({ [bear.id]: 'P1' }));
    expect(lands.every((land) => land.tapped)).toBe(true);
    const attackEvent = ctx.state.eventLog.find(
      (event) => event.type === 'attack' && event.payload['attacker'] === 'P2 Bear',
    );
    expect(attackEvent?.payload['defender']).toBe('P1');
  });

  it('nils-whole-turn — cast Nils, grow a creature at your end step, and on its controller’s turn that creature must pay to attack you', () => {
    const ctx = pod('nils-turn');
    const cub = spawn(ctx, 'P2', GRIZZLY('P2 Cub'));
    const lands = [spawn(ctx, 'P2', forest()), spawn(ctx, 'P2', forest())];
    castFromHand(ctx, 'P1', card, [...white(1), ...generic(2)]);
    resolveTop(ctx);
    endStepOf(ctx, 'P1', choose({ P2: 'P2 Cub' }));
    expect(plus(cub)).toBe(1);
    // P2's turn: one counter means {1}, and with no mana it cannot attack you at all.
    for (const land of lands) land.tapped = true;
    expect(attackOptionsFor(ctx, 'P2', cub).players).not.toContain('P1');
    for (const land of lands) land.tapped = false;
    const offered = attackOptionsFor(ctx, 'P2', cub);
    expect(offered.players).toContain('P1');
    expect(offered.taxes['P1']).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// PR07.05 Combat Calligrapher
// ---------------------------------------------------------------------------------------------

describe('Combat Calligrapher', () => {
  const { card } = pinned('Combat Calligrapher');
  const INKLING = (name: string) =>
    oracle({ name, typeLine: 'Creature — Inkling', power: '2', toughness: '1' });
  /** Gains life whenever a creature you control attacks, to show the token was never declared. */
  const WATCHER = oracle({
    name: 'Lab Watcher',
    typeLine: 'Creature — Wall',
    power: '0',
    toughness: '4',
    oracleText: 'Whenever a creature you control attacks, you gain 1 life.',
  });

  /** P1 controls Combat Calligrapher; each opponent controls a Bear. */
  function board(seed: string) {
    const ctx = pod(seed);
    const calligrapher = spawn(ctx, 'P1', card);
    const bears = {
      P2: spawn(ctx, 'P2', GRIZZLY('P2 Bear')),
      P3: spawn(ctx, 'P3', GRIZZLY('P3 Bear')),
      P4: spawn(ctx, 'P4', GRIZZLY('P4 Bear')),
    };
    return { ctx, calligrapher, bears };
  }

  const inklings = (ctx: GameContext) =>
    ctx.state.battlefield.filter((perm) => perm.name === 'Inkling' && perm.isToken);

  it('combat-calligrapher-pinned-oracle-supported — the authored override carries the Inkling restriction and the per-opponent token trigger under both ids, and Flying still parses', () => {
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.keywords).toContain('flying');
    expect(def.ruleStatics).toEqual([
      {
        kind: 'attackRestriction',
        filter: { kind: 'subtype', value: 'Inkling' },
        includePlaneswalkers: true,
      },
    ]);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toEqual({
      when: 'attackDeclared',
      attacker: 'any',
      attacking: { who: 'opponent', planeswalkers: false },
      perDefender: true,
    });
    expect(def.triggers[0]!.effects).toMatchObject([
      {
        op: 'createTokenAttacking',
        player: 'eventPlayer',
        defender: 'attackedPlayer',
        count: { kind: 'const', n: 1 },
        spec: {
          name: 'Inkling',
          colors: ['W', 'B'],
          power: 2,
          toughness: 1,
          keywords: ['flying'],
        },
      },
    ]);
  });

  it("combat-calligrapher-inklings-cant-attack-you — Inklings, token or not and whoever controls them, can't attack you or your planeswalkers; other creatures can", () => {
    const { ctx } = board('calligrapher-restriction');
    const walker = spawn(ctx, 'P1', WALKER('P1 Walker'));
    const otherWalker = spawn(ctx, 'P3', WALKER('P3 Walker'));
    const inkling = spawn(ctx, 'P2', INKLING('P2 Inkling'));
    const bear = spawn(ctx, 'P2', GRIZZLY('P2 Other Bear'));
    const offered = attackOptionsFor(ctx, 'P2', inkling);
    expect(offered.players.sort()).toEqual(['P3', 'P4']);
    expect(offered.planeswalkers).toEqual([otherWalker.id]);
    expect(offered.planeswalkers).not.toContain(walker.id);
    expect(attackOptionsFor(ctx, 'P2', bear).players).toContain('P1');
  });

  it('combat-calligrapher-token-is-an-inkling — the Inkling token it makes is restricted like any other Inkling, and a later attack cannot send it at you', () => {
    const { ctx, bears } = board('calligrapher-restriction-token');
    turnOfPlayer(ctx, 'P2');
    fight(ctx, () => ({ [bears.P2.id]: 'P3' }));
    const [token] = inklings(ctx);
    expect(token).toBeDefined();
    token!.tapped = false;
    token!.summoningSick = false;
    expect(attackOptionsFor(ctx, 'P2', token!).players.sort()).toEqual(['P3', 'P4']);
  });

  it('combat-calligrapher-token — a player attacking one of your opponents creates a tapped 2/1 white and black flying Inkling, controlled by that attacking player, attacking that opponent', () => {
    const { ctx, bears } = board('calligrapher-token');
    spawn(ctx, 'P2', WATCHER);
    turnOfPlayer(ctx, 'P2');
    const seen: { controller: string; tapped: boolean; attacking: string | null }[] = [];
    fight(
      ctx,
      () => ({ [bears.P2.id]: 'P3' }),
      undefined,
      undefined,
      () =>
        seen.push(
          ...inklings(ctx).map((token) => ({
            controller: token.controllerId,
            tapped: token.tapped,
            attacking: token.attacking,
          })),
        ),
    );
    // Controlled by the ATTACKING player (P2), not the Calligrapher's controller, tapped and
    // attacking the opponent who was attacked.
    expect(seen).toEqual([{ controller: 'P2', tapped: true, attacking: 'P3' }]);
    const [token] = inklings(ctx);
    const chars = computeCharacteristics(ctx, token!);
    expect(chars.power).toBe(2);
    expect(chars.toughness).toBe(1);
    expect(chars.colors.sort()).toEqual(['B', 'W']);
    expect(chars.keywords).toContain('flying');
    // Both attackers connect: the Bear's 2 and the Inkling's 2.
    expect(playerById(ctx, 'P3').life).toBe(36);
    // The token was never declared as an attacker, so P2's Watcher saw only the Bear attack.
    expect(playerById(ctx, 'P2').life).toBe(41);
    expect(ctx.state.stack).toEqual([]);
  });

  it('combat-calligrapher-you-attack — your own attack on an opponent makes the token for you', () => {
    const { ctx } = board('calligrapher-own-attack');
    const bear = spawn(ctx, 'P1', GRIZZLY('P1 Bear'));
    fight(ctx, () => ({ [bear.id]: 'P2' }));
    expect(inklings(ctx).map((token) => token.controllerId)).toEqual(['P1']);
    expect(playerById(ctx, 'P2').life).toBe(36);
  });

  it('combat-calligrapher-not-you — an attack on you, on your planeswalker, or on an opponent’s planeswalker creates nothing', () => {
    const { ctx, bears } = board('calligrapher-negatives');
    const mine = spawn(ctx, 'P1', WALKER('P1 Walker'));
    const theirs = spawn(ctx, 'P3', WALKER('P3 Walker'));
    const second = spawn(ctx, 'P2', GRIZZLY('P2 Second'));
    // At you.
    turnOfPlayer(ctx, 'P2');
    fight(ctx, () => ({ [bears.P2.id]: 'P1' }));
    expect(inklings(ctx)).toEqual([]);
    // At your planeswalker and at an opponent's planeswalker.
    bears.P2.tapped = false;
    second.tapped = false;
    fight(ctx, () => ({ [bears.P2.id]: mine.id, [second.id]: theirs.id }));
    expect(inklings(ctx)).toEqual([]);
  });

  it('combat-calligrapher-per-opponent — one token for each opponent attacked, however many creatures attack that opponent', () => {
    const { ctx, bears } = board('calligrapher-per-defender');
    const extra = spawn(ctx, 'P2', GRIZZLY('P2 Extra'));
    const third = spawn(ctx, 'P2', GRIZZLY('P2 Third'));
    const seen: string[] = [];
    turnOfPlayer(ctx, 'P2');
    fight(
      ctx,
      () => ({ [bears.P2.id]: 'P3', [extra.id]: 'P3', [third.id]: 'P4' }),
      undefined,
      undefined,
      // Each defending player declares blocks in turn; look once.
      () => {
        if (seen.length === 0)
          seen.push(...inklings(ctx).map((token) => token.attacking ?? 'none'));
      },
    );
    expect(seen.sort()).toEqual(['P3', 'P4']);
  });

  it('combat-calligrapher-two — each Calligrapher triggers separately', () => {
    const { ctx, bears } = board('calligrapher-two');
    spawn(ctx, 'P4', card);
    const seen: string[] = [];
    turnOfPlayer(ctx, 'P2');
    // P3 is an opponent of both controllers (P1 and P4): one trigger each, so two tokens.
    fight(
      ctx,
      () => ({ [bears.P2.id]: 'P3' }),
      undefined,
      undefined,
      () => {
        if (seen.length === 0)
          seen.push(...inklings(ctx).map((token) => token.attacking ?? 'none'));
      },
    );
    expect(seen).toEqual(['P3', 'P3']);
  });

  it('combat-calligrapher-defender-gone — the token is made for the attacked opponent only while they are in the game, and never attacking its own controller', () => {
    const { ctx } = board('calligrapher-gone');
    const [ability] = interpretCard(card).triggers;
    const resolveFor = (eventPlayerId: string, attackedPlayerId: string) =>
      pump(
        executeAbility(
          ctx,
          { cardId: 'c', oracleId: card.oracleId, name: card.name, controllerId: 'P1' },
          ability!,
          [],
          undefined,
          { eventPlayerId, attackedPlayerId },
        ),
      );
    // The attacked opponent has left the game: nothing is created.
    playerById(ctx, 'P3').hasLost = true;
    resolveFor('P2', 'P3');
    expect(inklings(ctx)).toEqual([]);
    // An attacked player who is the attacking player themselves cannot be attacked by their own token.
    resolveFor('P2', 'P2');
    expect(inklings(ctx)).toEqual([]);
    // With the opponent in the game, it is made for the event player and attacks that opponent.
    resolveFor('P2', 'P4');
    expect(
      inklings(ctx).map((token) => [token.controllerId, token.attacking, token.tapped]),
    ).toEqual([['P2', 'P4', true]]);
  });
});

// ---------------------------------------------------------------------------------------------
// PR07.14 Goblin Spymaster
// ---------------------------------------------------------------------------------------------

describe('Goblin Spymaster', () => {
  const { card } = pinned('Goblin Spymaster');

  /** P1 controls Goblin Spymaster; every player has a Bear. */
  function board(seed: string) {
    const ctx = pod(seed);
    const spymaster = spawn(ctx, 'P1', card);
    const bears = {
      P1: spawn(ctx, 'P1', GRIZZLY('P1 Bear')),
      P2: spawn(ctx, 'P2', GRIZZLY('P2 Bear')),
      P3: spawn(ctx, 'P3', GRIZZLY('P3 Bear')),
    };
    return { ctx, spymaster, bears };
  }

  const goblins = (ctx: GameContext) =>
    ctx.state.battlefield.filter((perm) => perm.name === 'Goblin' && perm.isToken);

  it("goblin-spymaster-pinned-oracle-supported — the authored override makes the token for the event player at each opponent's end step under both ids", () => {
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toEqual({ when: 'endStep', player: 'opponent' });
    const [effect] = def.triggers[0]!.effects;
    expect(effect).toMatchObject({
      op: 'createTokenForPlayer',
      target: 'eventPlayer',
      count: { kind: 'const', n: 1 },
      spec: {
        name: 'Goblin',
        types: ['Creature'],
        subtypes: ['Goblin'],
        colors: ['R'],
        power: 1,
        toughness: 1,
        staticEffects: [
          {
            affects: { kind: 'allOf' },
            op: { layer: 6, setMustAttackEachCombat: true },
          },
        ],
      },
    });
  });

  it("goblin-spymaster-opponent-end-step — at each opponent's end step THAT player creates a 1/1 red Goblin; your own end step makes nothing", () => {
    const { ctx } = board('spymaster-end-step');
    endStepOf(ctx, 'P1');
    expect(goblins(ctx)).toEqual([]);
    endStepOf(ctx, 'P2');
    endStepOf(ctx, 'P3');
    const tokens = goblins(ctx);
    expect(tokens.map((token) => token.controllerId).sort()).toEqual(['P2', 'P3']);
    for (const token of tokens) {
      const chars = computeCharacteristics(ctx, token);
      expect(chars.power).toBe(1);
      expect(chars.toughness).toBe(1);
      expect(chars.colors).toEqual(['R']);
      expect(chars.subtypes).toEqual(['Goblin']);
    }
    // P4's end step has not come, and P1 never got one.
    expect(tokens.some((token) => ['P1', 'P4'].includes(token.controllerId))).toBe(false);
  });

  it("goblin-spymaster-token-forces-attack — the token's controller's creatures, the token included and ones that arrive later, attack each combat if able; nobody else's do", () => {
    const { ctx, bears } = board('spymaster-forced');
    endStepOf(ctx, 'P2');
    const [token] = goblins(ctx);
    token!.summoningSick = false;
    const later = spawn(ctx, 'P2', GRIZZLY('P2 Latecomer'));
    const seen = mustAttackIn(ctx, 'P2', [token!, bears.P2, later]);
    expect(seen).toEqual({ [token!.id]: true, [bears.P2.id]: true, [later.id]: true });
    // Another player's creatures, and Goblin Spymaster's controller's, are not affected.
    expect(mustAttackIn(ctx, 'P3', [bears.P3])).toEqual({ [bears.P3.id]: false });
    expect(mustAttackIn(ctx, 'P1', [bears.P1])).toEqual({ [bears.P1.id]: false });
  });

  it('goblin-spymaster-token-control — "you" is whoever controls the token: under another player\'s control it forces that player\'s creatures instead', () => {
    const { ctx, bears } = board('spymaster-control');
    endStepOf(ctx, 'P2');
    const [token] = goblins(ctx);
    token!.controllerId = 'P3';
    expect(mustAttackIn(ctx, 'P3', [bears.P3])).toEqual({ [bears.P3.id]: true });
    expect(mustAttackIn(ctx, 'P2', [bears.P2])).toEqual({ [bears.P2.id]: false });
  });

  it('goblin-spymaster-token-leaves — the requirement ends when the token leaves the battlefield, and Goblin Spymaster leaving does not end it', () => {
    const { ctx, spymaster, bears } = board('spymaster-leaves');
    endStepOf(ctx, 'P2');
    const [token] = goblins(ctx);
    // The Spymaster itself is not what keeps the requirement: it is the token's own ability.
    ctx.state.battlefield = ctx.state.battlefield.filter((perm) => perm.id !== spymaster.id);
    expect(mustAttackIn(ctx, 'P2', [bears.P2])).toEqual({ [bears.P2.id]: true });
    ctx.state.battlefield = ctx.state.battlefield.filter((perm) => perm.id !== token!.id);
    expect(mustAttackIn(ctx, 'P2', [bears.P2])).toEqual({ [bears.P2.id]: false });
  });

  it('goblin-spymaster-whole-game — cast it, let P2 reach the end step, and P2 gets a Goblin that makes P2 attack on its next turn', () => {
    const ctx = pod('spymaster-chain');
    const bear = spawn(ctx, 'P2', GRIZZLY('P2 Bear'));
    const cast = castFromHand(ctx, 'P1', card, [{ symbol: 'R' }, ...generic(2)]);
    resolveTop(ctx);
    expect(ctx.state.battlefield.some((perm) => perm.cardId === cast.cardId)).toBe(true);
    endStepOf(ctx, 'P2');
    const [token] = goblins(ctx);
    expect(token?.controllerId).toBe('P2');
    expect(ctx.state.stack).toEqual([]);
    // P2's next combat: the Bear must attack, and so must the Goblin once it can.
    ctx.state.turnNumber += 4;
    token!.summoningSick = false;
    expect(mustAttackIn(ctx, 'P2', [bear, token!])).toEqual({
      [bear.id]: true,
      [token!.id]: true,
    });
    // They did attack: the declaration was made for them.
    expect(bear.tapped).toBe(true);
    expect(token!.tapped).toBe(true);
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
   * The shared verification manifest entry belongs to the white-black control work (pinned by
   * white-black-control-manifest.test.ts); the PR07 tests above are additional engine evidence for
   * the same implementation.
   */
  manifestOwnedByWhiteBlackControl?: true;
}

const RESTORED: RestoredCard[] = [
  {
    name: 'Promise of Loyalty',
    sha256: '2c168d95b98fc29bee9fb1d7a562d50070400c32fe9b4476196eb820d301b472',
    clauseCount: 1,
    authored: true,
    manifestOwnedByWhiteBlackControl: true,
  },
  {
    name: 'Lightning Runner',
    sha256: '3c1a95336f34a682447de952888e4e51c9a8490195569c715edf15cbba6b2b43',
    clauseCount: 1,
    authored: true,
  },
  {
    name: 'Firkraag, Cunning Instigator',
    sha256: 'c4087982a8080ccc5e5214a58683928378c732ba9e32679700dd7e87a7299579',
    clauseCount: 2,
    authored: true,
  },
  {
    name: 'Eriette of the Charmed Apple',
    sha256: '427382fa2460cff57a7df369156701a3a2c58178f0cec4ef5d1bf7909f937023',
    clauseCount: 2,
    authored: true,
  },
  {
    name: 'Rite of the Raging Storm',
    sha256: '8084d5a45cbb44df44eb1f24fae2549e89b2b59f375e1901b47aed4f9cf22725',
    clauseCount: 2,
    authored: true,
  },
  {
    name: 'Nils, Discipline Enforcer',
    sha256: '4b08785cec3c0e9c1c5e4aea30160faebdf81b037e7f82fb75675151bb8a002e',
    clauseCount: 2,
    authored: true,
  },
  {
    name: 'Combat Calligrapher',
    sha256: '14ed62e99aefd29f2bdb7438445b5787d32bdb14c528e3a05d8e02154c55bc25',
    clauseCount: 2,
    authored: true,
  },
  {
    name: 'Goblin Spymaster',
    sha256: 'dc6ec963c76cddaf6add831da4fd2f1eaf97c23fc0b035f66702f1ecefc40736',
    clauseCount: 1,
    authored: true,
  },
];

interface ManifestClause {
  id: string;
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

describe('PR07 restoration gate', () => {
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
      (entry) => entry.restoredIn === 'coverage-pr07',
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
        for (const id of clause.engineTestIds) expect(engineSource, id).toContain(`${id} —`);
        for (const id of clause.viewerScenarioIds) expect(viewerSource, id).toContain(id);
      }
    },
  );
});
