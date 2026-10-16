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
import { applyCopy, createToken, moveObject, tokenSpecCopying } from '../src/state/objects';
import {
  beginEndStep,
  cleanupStep,
  queueStepTriggers,
  runBeginningAndPrecombatMain,
  runCombatAndExtraCombats,
} from '../src/turn/turn';
import { createGame } from '../src/state/game';
import { INKLING_2_1_FLYING } from '../src/cards/tokens';
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
 * object id. Everything else, including the creatures with no requirement, stays home. The
 * declaration is driven by hand because `pump` answers a declaration with one legal choice on its
 * own, which is exactly the case (a creature required to attack one player) this must see.
 */
function mustAttackIn(
  ctx: GameContext,
  playerId: string,
  creatures: readonly EnginePermanent[],
  /** Receives the players each creature may be declared against. */
  defendersSeen: Record<string, string[]> = {},
  /** Receives the planeswalkers (object ids) each creature may be declared against. */
  walkersSeen: Record<string, string[]> = {},
): Record<string, boolean | undefined> {
  turnOfPlayer(ctx, playerId);
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  const seen: Record<string, boolean | undefined> = {};
  for (const creature of creatures) creature.tapped = false;
  const generator = runCombatAndExtraCombats(ctx);
  let outcome: DecisionOutcome | undefined;
  for (;;) {
    const step = outcome === undefined ? generator.next() : generator.next(outcome);
    if (step.done === true) break;
    const decision = step.value;
    if (decision.presentationAttackDeclaration !== undefined) {
      for (const creature of creatures) {
        const subject = decision.presentationAttackDeclaration.subjects.find(
          (candidate) => candidate.subjectId === creature.id,
        );
        seen[creature.id] = subject?.mustAttack;
        defendersSeen[creature.id] = subject?.defenders.map((defender) => defender.playerId) ?? [];
        walkersSeen[creature.id] = subject?.planeswalkers.map((walker) => walker.objectId) ?? [];
      }
      outcome = declareAttacks(decision, (_subjectId, subject) => {
        if (!subject.mustAttack) return null;
        return subject.defenders[0]?.playerId ?? subject.planeswalkers[0]?.objectId ?? null;
      });
    } else if (decision.presentationBlockDeclaration !== undefined)
      outcome = declareBlocks(decision, () => null);
    else {
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      outcome = { index: Math.max(pass, 0), targets: new Map() };
    }
  }
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

/**
 * Run the active player's combat with these declarations (creature object id to the player or
 * planeswalker it attacks, blocker object id to the attacker it blocks; everything else stays
 * home) and record the violation kinds the engine rejected, in order. A rejected declaration is
 * re-sent unchanged, so the engine's own repair decides what happens.
 */
function declaredCombat(
  ctx: GameContext,
  attacks: Record<string, string>,
  blocks: Record<string, string> = {},
) {
  const attackRejections: string[] = [];
  const blockRejections: string[] = [];
  const asked: { attackers: number; blockers: number } = { attackers: 0, blockers: 0 };
  pump(runCombatAndExtraCombats(ctx), (decision) => {
    if (decision.presentationAttackDeclaration !== undefined) {
      asked.attackers++;
      for (const violation of decision.presentationAttackDeclaration.rejection?.violations ?? [])
        attackRejections.push(violation.kind);
      return declareAttacks(decision, (subjectId) => attacks[subjectId] ?? null);
    }
    if (decision.presentationBlockDeclaration !== undefined) {
      asked.blockers++;
      for (const violation of decision.presentationBlockDeclaration.rejection?.violations ?? [])
        blockRejections.push(violation.kind);
      return declareBlocks(decision, (subjectId) => blocks[subjectId] ?? null);
    }
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    return { index: Math.max(pass, 0), targets: new Map() };
  });
  return { attackRejections, blockRejections, asked };
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

// ---------------------------------------------------------------------------------------------
// PR07.23 Toby, Beastie Befriender
// ---------------------------------------------------------------------------------------------

describe('Toby, Beastie Befriender', () => {
  const { card } = pinned('Toby, Beastie Befriender');
  const SERVO = (name: string) =>
    oracle({ name, typeLine: 'Artifact Creature — Servo', power: '1', toughness: '1' });

  /** A Beast token for `playerId`, made by resolving Toby's own enters trigger. */
  function beastFor(ctx: GameContext, playerId: string): EnginePermanent {
    const toby = spawn(ctx, playerId, card);
    const [ability] = interpretCard(card).triggers;
    pump(
      executeAbility(
        ctx,
        {
          cardId: toby.cardId,
          oracleId: card.oracleId,
          name: card.name,
          controllerId: playerId,
        },
        ability!,
        [],
      ),
    );
    const beast = ctx.state.battlefield
      .filter((perm) => perm.name === 'Beast' && perm.isToken)
      .at(-1)!;
    // It has been under your control since an earlier turn.
    beast.summoningSick = false;
    return beast;
  }

  /** A creature token that is not a Beast, made for `playerId` as a creature token. */
  const plainToken = (ctx: GameContext, playerId: string, name: string) =>
    spawn(ctx, playerId, SERVO(name), { isToken: true });

  it('toby-pinned-oracle-supported — the authored override carries the enters trigger and the flying static under both ids', () => {
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toMatchObject({ when: 'enters' });
    expect(def.triggers[0]!.effects).toMatchObject([
      {
        op: 'createToken',
        count: { kind: 'const', n: 1 },
        spec: {
          name: 'Beast',
          colors: ['W'],
          power: 4,
          toughness: 4,
          ruleStatics: [{ kind: 'cantAttackAlone' }, { kind: 'cantBlockAlone' }],
        },
      },
    ]);
    expect(def.staticEffects).toMatchObject([
      {
        op: { layer: 6, addKeyword: 'flying' },
        condition: { kind: 'countPermanents', scope: 'you', cmp: '>=', n: 4 },
      },
    ]);
  });

  it('toby-beast-token — casting Toby creates a 4/4 white Beast creature token for you', () => {
    const ctx = pod('toby-cast');
    castFromHand(ctx, 'P1', card, [{ symbol: 'W' }, ...generic(2)]);
    resolveTop(ctx);
    settle(ctx);
    const beasts = ctx.state.battlefield.filter((perm) => perm.name === 'Beast');
    expect(beasts).toHaveLength(1);
    expect(beasts[0]!.isToken).toBe(true);
    expect(beasts[0]!.controllerId).toBe('P1');
    const chars = computeCharacteristics(ctx, beasts[0]!);
    expect([chars.power, chars.toughness]).toEqual([4, 4]);
    expect(chars.colors).toEqual(['W']);
    expect(chars.subtypes).toEqual(['Beast']);
    expect(ctx.state.stack).toEqual([]);
  });

  it('toby-cant-attack-alone — the Beast alone is rejected and stands down; with another attacker, or with a second such Beast, it attacks', () => {
    const ctx = pod('toby-attack-alone');
    const beast = beastFor(ctx, 'P1');
    const bear = spawn(ctx, 'P1', GRIZZLY('P1 Bear'));
    // Alone: the declaration is rejected twice and the engine repairs it by standing the Beast down.
    const alone = declaredCombat(ctx, { [beast.id]: 'P2' });
    expect(alone.attackRejections).toEqual(['attackAlone']);
    expect(beast.tapped).toBe(false);
    expect(playerById(ctx, 'P2').life).toBe(40);
    // Together with the Bear, it attacks.
    const together = declaredCombat(ctx, { [beast.id]: 'P2', [bear.id]: 'P2' });
    expect(together.attackRejections).toEqual([]);
    expect(playerById(ctx, 'P2').life).toBe(34);
    // The Bear attacking alone is fine (it has no restriction).
    beast.tapped = false;
    bear.tapped = false;
    declaredCombat(ctx, { [bear.id]: 'P3' });
    expect(playerById(ctx, 'P3').life).toBe(38);
    // Two Beasts attack together: each has the other.
    const second = beastFor(ctx, 'P1');
    second.summoningSick = false;
    beast.tapped = false;
    const pair = declaredCombat(ctx, { [beast.id]: 'P4', [second.id]: 'P4' });
    expect(pair.attackRejections).toEqual([]);
    expect(playerById(ctx, 'P4').life).toBe(32);
  });

  it('toby-attack-alone-required — a goaded Beast is not required to attack with no partner, and with one it is required, and the engine brings the partner along', () => {
    const ctx = pod('toby-attack-required');
    const beast = beastFor(ctx, 'P1');
    beast.goadedBy = [{ goaderId: 'P2', appliedTurn: ctx.state.turnNumber }];
    // Nobody else can attack (Toby is tapped): the Beast has no partner, so it is not forced.
    const toby = ctx.state.battlefield.find((perm) => perm.name === card.name)!;
    toby.tapped = true;
    expect(mustAttackIn(ctx, 'P1', [beast])).toEqual({ [beast.id]: false });
    toby.tapped = false;
    expect(playerById(ctx, 'P3').life).toBe(40);
    // With a partner it must attack (a goaded creature never attacks the goader).
    const bear = spawn(ctx, 'P1', GRIZZLY('P1 Bear'));
    beast.tapped = false;
    expect(mustAttackIn(ctx, 'P1', [beast, bear])).toEqual({
      [beast.id]: true,
      [bear.id]: false,
    });
    // Declared alone while required: the Bear is brought along so the requirement is obeyed.
    beast.tapped = false;
    bear.tapped = false;
    const repaired = declaredCombat(ctx, { [beast.id]: 'P3' });
    expect(repaired.attackRejections).toEqual(['attackAlone']);
    expect(beast.tapped).toBe(true);
    expect(bear.tapped).toBe(true);
  });

  it('toby-cant-block-alone — the Beast alone cannot block, and with another of its controller’s blockers it can; another player’s blocker does not count', () => {
    const ctx = pod('toby-block-alone');
    const beast = beastFor(ctx, 'P2');
    const bear = spawn(ctx, 'P2', GRIZZLY('P2 Bear'));
    const raider = spawn(ctx, 'P1', GRIZZLY('P1 Raider'));
    const other = spawn(ctx, 'P1', GRIZZLY('P1 Other'));
    // Alone: rejected, and the engine stands it down, so the Raider is unblocked.
    const alone = declaredCombat(ctx, { [raider.id]: 'P2' }, { [beast.id]: raider.id });
    expect(alone.blockRejections).toEqual(['blockAlone']);
    expect(playerById(ctx, 'P2').life).toBe(38);
    // Together with the Bear (both block the Raider), the block stands.
    raider.tapped = false;
    const together = declaredCombat(
      ctx,
      { [raider.id]: 'P2' },
      { [beast.id]: raider.id, [bear.id]: raider.id },
    );
    expect(together.blockRejections).toEqual([]);
    expect(playerById(ctx, 'P2').life).toBe(38);
    // A blocker another player declares does not make it "not alone": P2's Beast, P3's Bear.
    const bearP3 = spawn(ctx, 'P3', GRIZZLY('P3 Bear'));
    const second = spawn(ctx, 'P1', GRIZZLY('P1 Second Raider'));
    other.tapped = false;
    bear.tapped = true;
    const apart = declaredCombat(
      ctx,
      { [second.id]: 'P2', [other.id]: 'P3' },
      { [beast.id]: second.id, [bearP3.id]: other.id },
    );
    expect(apart.blockRejections).toEqual(['blockAlone']);
    expect(playerById(ctx, 'P2').life).toBe(36);
  });

  it('toby-restriction-scope — only the Beast token has the restriction: Toby and a second creature of yours attack and block alone freely', () => {
    const ctx = pod('toby-scope');
    const toby = spawn(ctx, 'P1', card);
    const run = declaredCombat(ctx, { [toby.id]: 'P2' });
    expect(run.attackRejections).toEqual([]);
    expect(playerById(ctx, 'P2').life).toBe(39);
    const bear = spawn(ctx, 'P2', GRIZZLY('P2 Bear'));
    const attacker = spawn(ctx, 'P1', GRIZZLY('P1 Raider'));
    toby.tapped = false;
    const block = declaredCombat(ctx, { [attacker.id]: 'P2' }, { [bear.id]: attacker.id });
    expect(block.blockRejections).toEqual([]);
  });

  it('toby-flying — creature tokens you control have flying while you control four or more creature tokens, and not otherwise', () => {
    const ctx = pod('toby-flying');
    const toby = spawn(ctx, 'P1', card);
    const keywordsOf = (perm: EnginePermanent) => computeCharacteristics(ctx, perm).keywords;
    const tokens = [1, 2, 3].map((n) => plainToken(ctx, 'P1', `Token ${n}`));
    for (const token of tokens) expect(keywordsOf(token)).not.toContain('flying');
    const fourth = plainToken(ctx, 'P1', 'Token 4');
    for (const token of [...tokens, fourth]) expect(keywordsOf(token)).toContain('flying');
    // Toby and nontoken creatures are not tokens; an opponent's tokens are not yours.
    expect(keywordsOf(toby)).not.toContain('flying');
    const bear = spawn(ctx, 'P1', GRIZZLY('P1 Bear'));
    expect(keywordsOf(bear)).not.toContain('flying');
    const theirs = plainToken(ctx, 'P2', 'Their Token');
    expect(keywordsOf(theirs)).not.toContain('flying');
    // Checked continuously: back to three, and nobody has flying.
    ctx.state.battlefield = ctx.state.battlefield.filter((perm) => perm.id !== fourth.id);
    for (const token of tokens) expect(keywordsOf(token)).not.toContain('flying');
  });

  it('toby-flying-count — non-creature tokens do not count toward four, and four with Toby gone gives nothing', () => {
    const ctx = pod('toby-flying-count');
    const toby = spawn(ctx, 'P1', card);
    const keywordsOf = (perm: EnginePermanent) => computeCharacteristics(ctx, perm).keywords;
    const creatures = [1, 2, 3].map((n) => plainToken(ctx, 'P1', `Token ${n}`));
    const treasure = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Lab Treasure',
        typeLine: 'Artifact — Treasure',
        power: null,
        toughness: null,
      }),
      { isToken: true },
    );
    expect(treasure.isToken).toBe(true);
    for (const token of creatures) expect(keywordsOf(token)).not.toContain('flying');
    const fourth = plainToken(ctx, 'P1', 'Token 4');
    expect(keywordsOf(fourth)).toContain('flying');
    ctx.state.battlefield = ctx.state.battlefield.filter((perm) => perm.id !== toby.id);
    for (const token of [...creatures, fourth]) expect(keywordsOf(token)).not.toContain('flying');
  });

  it('toby-whole-game — cast Toby, the Beast arrives, and on a later turn it attacks only alongside another creature', () => {
    const ctx = pod('toby-chain');
    const bear = spawn(ctx, 'P1', GRIZZLY('P1 Bear'));
    castFromHand(ctx, 'P1', card, [{ symbol: 'W' }, ...generic(2)]);
    resolveTop(ctx);
    settle(ctx);
    const beast = ctx.state.battlefield.find((perm) => perm.name === 'Beast')!;
    beast.summoningSick = false;
    const lone = declaredCombat(ctx, { [beast.id]: 'P2' });
    expect(lone.attackRejections).toEqual(['attackAlone']);
    expect(playerById(ctx, 'P2').life).toBe(40);
    const pair = declaredCombat(ctx, { [beast.id]: 'P2', [bear.id]: 'P2' });
    expect(pair.attackRejections).toEqual([]);
    expect(playerById(ctx, 'P2').life).toBe(34);
  });
});

// ---------------------------------------------------------------------------------------------
// PR07.18 Life of the Party
// ---------------------------------------------------------------------------------------------

describe('Life of the Party', () => {
  const { card } = pinned('Life of the Party');
  const COST = [{ symbol: 'R' as const }, ...generic(3)];

  const copies = (ctx: GameContext) =>
    ctx.state.battlefield.filter((perm) => perm.name === card.name && perm.isToken);
  const goaders = (perm: EnginePermanent) => (perm.goadedBy ?? []).map((entry) => entry.goaderId);

  /** P1 casts Life of the Party and every trigger resolves. */
  function cast(seed: string) {
    const ctx = pod(seed);
    const object = castFromHand(ctx, 'P1', card, COST);
    resolveTop(ctx);
    settle(ctx);
    const party = ctx.state.battlefield.find((perm) => perm.cardId === object.cardId)!;
    return { ctx, party };
  }

  it('life-of-the-party-pinned-oracle-supported — the authored override carries the attack pump and the enters trigger under both ids', () => {
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(2);
    expect(def.triggers[0]!.effects).toMatchObject([
      {
        op: 'pumpUntilEot',
        target: 'source',
        power: { kind: 'countPermanents', scope: 'you' },
        toughness: 0,
      },
    ]);
    expect(def.triggers[1]!.trigger).toMatchObject({
      when: 'enters',
      condition: { kind: 'sourceMatches', selector: { kind: 'not', of: { kind: 'isToken' } } },
    });
    expect(def.triggers[1]!.effects).toMatchObject([
      { op: 'createTokenCopyOf', ref: 'source', eachOpponent: true, goadedForRestOfGame: true },
    ]);
  });

  it('life-of-the-party-attack-pump — it gets +X/+0 where X counts the creatures you control as the trigger resolves, and only it', () => {
    const ctx = pod('lotp-pump');
    const party = spawn(ctx, 'P1', card);
    const bears = [1, 2].map((n) => spawn(ctx, 'P1', GRIZZLY(`P1 Bear ${n}`)));
    spawn(ctx, 'P2', GRIZZLY('P2 Bear'));
    fight(ctx, () => ({ [party.id]: 'P2' }));
    // Three creatures of yours: it hit for 0 + 3, and the Bears stayed 2/2.
    expect(playerById(ctx, 'P2').life).toBe(37);
    expect(computeCharacteristics(ctx, bears[0]!).power).toBe(2);
    // A creature that arrives before the trigger resolves counts: X is read on resolution.
    ctx.state.effects = [];
    party.tapped = false;
    spawn(ctx, 'P1', GRIZZLY('P1 Extra'));
    const [ability] = interpretCard(card).triggers;
    pump(
      executeAbility(
        ctx,
        { cardId: party.cardId, oracleId: card.oracleId, name: card.name, controllerId: 'P1' },
        ability!,
        [],
      ),
    );
    expect(computeCharacteristics(ctx, party).power).toBe(4);
    expect(computeCharacteristics(ctx, party).toughness).toBe(1);
  });

  it('life-of-the-party-copies — each opponent creates and controls a token copy; you get none, and the copies make no more', () => {
    const { ctx, party } = cast('lotp-copies');
    const tokens = copies(ctx);
    expect(tokens.map((token) => token.controllerId).sort()).toEqual(['P2', 'P3', 'P4']);
    expect(tokens.every((token) => token.ownerId === token.controllerId)).toBe(true);
    // The printed abilities are copied.
    for (const token of tokens) {
      const chars = computeCharacteristics(ctx, token);
      expect(chars.keywords).toEqual(expect.arrayContaining(['first strike', 'trample', 'haste']));
      expect(chars.triggers).toHaveLength(2);
    }
    expect(ctx.state.battlefield.filter((perm) => perm.name === card.name)).toHaveLength(4);
    expect(party.isToken).toBe(false);
    expect(ctx.state.stack).toEqual([]);
  });

  it('life-of-the-party-token-no-copies — a token Life of the Party entering makes no copies, because the enters trigger needs a nontoken', () => {
    const { ctx, party } = cast('lotp-token');
    expect(copies(ctx)).toHaveLength(3);
    createToken(ctx, tokenSpecCopying(ctx, party, false), 'P1');
    settle(ctx);
    expect(copies(ctx)).toHaveLength(4);
    expect(copies(ctx).filter((token) => token.controllerId === 'P1')).toHaveLength(1);
    expect(ctx.state.stack).toEqual([]);
  });

  it('life-of-the-party-goaded-forever — the copies are goaded by you, must attack and never you, and the goad survives your own turns', () => {
    const { ctx } = cast('lotp-goad');
    const tokens = copies(ctx);
    for (const token of tokens) {
      expect(goaders(token)).toEqual(['P1']);
      token.summoningSick = false;
    }
    // A goad that ends at your next turn, for contrast, is gone after your untap step...
    const ordinary = spawn(ctx, 'P3', GRIZZLY('P3 Ordinary'));
    ordinary.goadedBy = [{ goaderId: 'P1', appliedTurn: ctx.state.turnNumber - 1 }];
    turnOfPlayer(ctx, 'P1');
    ctx.state.turnNumber += 4;
    pump(runBeginningAndPrecombatMain(ctx));
    expect(ordinary.goadedBy).toBeUndefined();
    // ...while the copies are still goaded for the rest of the game.
    for (const token of tokens) expect(goaders(token)).toEqual(['P1']);
    const p2Token = tokens.find((token) => token.controllerId === 'P2')!;
    const offered: Record<string, string[]> = {};
    expect(mustAttackIn(ctx, 'P2', [p2Token], offered)).toEqual({ [p2Token.id]: true });
    expect(offered[p2Token.id]).not.toContain('P1');
    expect(offered[p2Token.id]).toContain('P3');
    // And on every later turn of theirs.
    ctx.state.turnNumber += 4;
    expect(mustAttackIn(ctx, 'P2', [p2Token])).toEqual({ [p2Token.id]: true });
  });

  it('life-of-the-party-goader-leaves — when you leave the game the goad ends, and the copies are no longer required to attack', () => {
    const { ctx } = cast('lotp-goader-gone');
    const p3Token = copies(ctx).find((token) => token.controllerId === 'P3')!;
    p3Token.summoningSick = false;
    expect(mustAttackIn(ctx, 'P3', [p3Token])).toEqual({ [p3Token.id]: true });
    playerById(ctx, 'P1').hasLost = true;
    expect(mustAttackIn(ctx, 'P3', [p3Token])).toEqual({ [p3Token.id]: false });
  });

  it('life-of-the-party-left-before-resolving — if it leaves the battlefield with the trigger on the stack, the opponents still create copies of it', () => {
    const ctx = pod('lotp-gone');
    const object = castFromHand(ctx, 'P1', card, COST);
    resolveTop(ctx);
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.stack).toHaveLength(1);
    // It dies with the trigger on the stack.
    const party = ctx.state.battlefield.find((perm) => perm.cardId === object.cardId)!;
    pump(moveObject(ctx, party, { zone: 'graveyard' }));
    expect(ctx.state.battlefield.some((perm) => perm.cardId === object.cardId)).toBe(false);
    resolveTop(ctx);
    const tokens = copies(ctx);
    expect(tokens.map((token) => token.controllerId).sort()).toEqual(['P2', 'P3', 'P4']);
    for (const token of tokens) expect(goaders(token)).toEqual(['P1']);
    expect(computeCharacteristics(ctx, tokens[0]!).keywords).toContain('haste');
  });

  it('life-of-the-party-whole-game — cast it, the opponents get goaded copies, and on a copy’s controller’s turn it attacks someone else', () => {
    const { ctx } = cast('lotp-chain');
    const p4Token = copies(ctx).find((token) => token.controllerId === 'P4')!;
    p4Token.summoningSick = false;
    turnOfPlayer(ctx, 'P4');
    ctx.state.turnNumber += 3;
    const before = ['P1', 'P2', 'P3'].map((id) => playerById(ctx, id).life);
    fight(ctx, () => ({ [p4Token.id]: 'P2' }));
    const after = ['P1', 'P2', 'P3'].map((id) => playerById(ctx, id).life);
    expect(after[0]).toBe(before[0]);
    // Haste and first strike aside, it hit P2: 0 power + the X of its attack trigger (4 creatures).
    expect(after[1]).toBeLessThan(before[1]!);
    expect(p4Token.tapped).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// PR07.08 Kardur, Doomscourge
// ---------------------------------------------------------------------------------------------

describe('Kardur, Doomscourge', () => {
  const { card } = pinned('Kardur, Doomscourge');
  const COST = [{ symbol: 'B' as const }, { symbol: 'R' as const }, ...generic(2)];
  const BRUTE_N = (n: number) =>
    oracle({
      name: `Lab Brute ${n}`,
      typeLine: 'Creature — Brute',
      manaCost: '{0}',
      power: '3',
      toughness: '3',
    });
  const BRUTE = BRUTE_N(0);

  /** P1 casts Kardur; each opponent controls a Bear. */
  function board(seed: string) {
    const ctx = pod(seed);
    const bears = {
      P2: spawn(ctx, 'P2', GRIZZLY('P2 Bear')),
      P3: spawn(ctx, 'P3', GRIZZLY('P3 Bear')),
      P4: spawn(ctx, 'P4', GRIZZLY('P4 Bear')),
    };
    const mine = spawn(ctx, 'P1', GRIZZLY('P1 Bear'));
    const object = castFromHand(ctx, 'P1', card, COST);
    resolveTop(ctx);
    settle(ctx);
    const kardur = ctx.state.battlefield.find((perm) => perm.cardId === object.cardId)!;
    return { ctx, kardur, bears, mine };
  }

  it('kardur-pinned-oracle-supported — the authored override carries the enters requirement and the attacking-creature death trigger under both ids', () => {
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(2);
    expect(def.triggers[0]!.trigger).toMatchObject({ when: 'enters' });
    expect(def.triggers[0]!.effects).toEqual([
      {
        op: 'addAttackRequirement',
        selector: {
          kind: 'allOf',
          of: [
            { kind: 'type', value: 'Creature' },
            { kind: 'controller', who: 'opponents' },
          ],
        },
        requirements: [{ kind: 'anyAttack' }, { kind: 'notPlayer', player: 'you' }],
        duration: 'untilYourNextTurn',
      },
    ]);
    expect(def.triggers[1]!.trigger).toMatchObject({
      when: 'dies',
      subject: {
        kind: 'permanent',
        selector: {
          kind: 'allOf',
          of: [
            { kind: 'type', value: 'Creature' },
            { kind: 'combatRole', role: 'attacking' },
          ],
        },
      },
    });
  });

  it('kardur-enters-requirement — Kardur entering makes the requirement for you, until your next turn, with the two requirements', () => {
    const { ctx } = board('kardur-enters');
    expect(ctx.state.attackRequirements).toHaveLength(1);
    expect(ctx.state.attackRequirements![0]).toMatchObject({
      controllerId: 'P1',
      requirements: [{ kind: 'anyAttack' }, { kind: 'notPlayer', playerId: 'P1' }],
      expires: { kind: 'untilNextTurn', playerId: 'P1' },
    });
  });

  it('kardur-opponents-must-attack-not-you — creatures your opponents control attack each combat if able and a player other than you, and your creatures do neither', () => {
    const { ctx, bears, mine } = board('kardur-must-attack');
    const offered: Record<string, string[]> = {};
    expect(mustAttackIn(ctx, 'P2', [bears.P2], offered)).toEqual({ [bears.P2.id]: true });
    // Not you ("a player other than you"): P3 and P4 only.
    expect(offered[bears.P2.id]!.sort()).toEqual(['P3', 'P4']);
    expect(mustAttackIn(ctx, 'P1', [mine])).toEqual({ [mine.id]: false });
  });

  it('kardur-later-arrivals — creatures an opponent gets after it resolved are covered, and so is one they gain control of', () => {
    const { ctx, bears } = board('kardur-later');
    const later = spawn(ctx, 'P3', GRIZZLY('P3 Latecomer'));
    expect(mustAttackIn(ctx, 'P3', [later])).toEqual({ [later.id]: true });
    bears.P2.controllerId = 'P4';
    expect(mustAttackIn(ctx, 'P4', [bears.P2])).toEqual({ [bears.P2.id]: true });
  });

  it('kardur-planeswalker-ruling — a planeswalker attack obeys only "attacks each combat", so with another player available it is not enough, and with none it must still attack you or a planeswalker', () => {
    const { ctx, bears } = board('kardur-walker');
    const p3Walker = spawn(ctx, 'P3', WALKER('P3 Walker'));
    const p1Walker = spawn(ctx, 'P1', WALKER('P1 Walker'));
    const defenders: Record<string, string[]> = {};
    const walkers: Record<string, string[]> = {};
    // With P3 and P4 available, only they obey both: no planeswalker, and not P1 or its walker.
    mustAttackIn(ctx, 'P2', [bears.P2], defenders, walkers);
    expect(defenders[bears.P2.id]!.sort()).toEqual(['P3', 'P4']);
    expect(walkers[bears.P2.id]).toEqual([]);
    expect(walkers[bears.P2.id]).not.toContain(p3Walker.id);
    // Only you and your planeswalker left to attack: it must still attack one of them.
    playerById(ctx, 'P3').hasLost = true;
    playerById(ctx, 'P4').hasLost = true;
    expect(mustAttackIn(ctx, 'P2', [bears.P2], defenders, walkers)).toEqual({
      [bears.P2.id]: true,
    });
    expect(defenders[bears.P2.id]).toEqual(['P1']);
    expect(walkers[bears.P2.id]).toEqual([p1Walker.id]);
  });

  it('kardur-until-your-next-turn — the requirement outlasts Kardur leaving, lasts through every other player’s turn, and ends as your next turn begins', () => {
    const { ctx, kardur, bears } = board('kardur-duration');
    // Kardur leaves the battlefield: the effect is not tied to it.
    pump(moveObject(ctx, kardur, { zone: 'graveyard' }));
    expect(mustAttackIn(ctx, 'P2', [bears.P2])).toEqual({ [bears.P2.id]: true });
    for (const [index, id] of ['P2', 'P3', 'P4'].entries()) {
      turnOfPlayer(ctx, id);
      ctx.state.turnNumber += 1;
      pump(runBeginningAndPrecombatMain(ctx));
      expect(ctx.state.attackRequirements, `before P1's turn, at ${id}`).toHaveLength(1);
      expect(index).toBeLessThan(3);
    }
    turnOfPlayer(ctx, 'P1');
    ctx.state.turnNumber += 1;
    pump(runBeginningAndPrecombatMain(ctx));
    expect(ctx.state.attackRequirements).toHaveLength(0);
    expect(mustAttackIn(ctx, 'P2', [bears.P2])).toEqual({ [bears.P2.id]: false });
  });

  it('kardur-attacker-dies-drain — whenever an attacking creature dies, each opponent loses 1 and you gain 1, whoever controls it', () => {
    const { ctx, mine } = board('kardur-drain');
    const brute = spawn(ctx, 'P2', BRUTE);
    const life = () => ['P1', 'P2', 'P3', 'P4'].map((id) => playerById(ctx, id).life);
    // Your Bear attacks P2 and P2's Brute blocks and kills it: the attacker died.
    declaredCombat(ctx, { [mine.id]: 'P2' }, { [brute.id]: mine.id });
    expect(ctx.state.battlefield.some((perm) => perm.id === mine.id)).toBe(false);
    expect(life()).toEqual([41, 39, 39, 39]);
    expect(ctx.state.stack).toEqual([]);
  });

  it('kardur-blockers-dont-count — a blocking creature dying does not trigger it, and a creature that dies while not attacking does not either', () => {
    const { ctx } = board('kardur-blocker');
    const brute = spawn(ctx, 'P1', BRUTE);
    const blocker = spawn(ctx, 'P2', GRIZZLY('P2 Wall'));
    const life = () => ['P1', 'P2', 'P3', 'P4'].map((id) => playerById(ctx, id).life);
    // Your Brute (3/3) is blocked by a 2/2 that dies: only the blocker died.
    declaredCombat(ctx, { [brute.id]: 'P2' }, { [blocker.id]: brute.id });
    expect(ctx.state.battlefield.some((perm) => perm.id === blocker.id)).toBe(false);
    expect(life()).toEqual([40, 40, 40, 40]);
    // A creature that dies outside combat is not an attacking creature.
    const idle = spawn(ctx, 'P3', GRIZZLY('P3 Idle'));
    pump(moveObject(ctx, idle, { zone: 'graveyard' }));
    pump(priorityCheckpoint(ctx));
    expect(life()).toEqual([40, 40, 40, 40]);
  });

  it('kardur-trade-and-multiple — an attacker trading with a blocker counts once, and two attackers dying count twice; Kardur sees itself die attacking', () => {
    const { ctx, mine, kardur } = board('kardur-multiple');
    const life = () => ['P1', 'P2', 'P3', 'P4'].map((id) => playerById(ctx, id).life);
    // The trade: an attacking 2/2 and a blocking 2/2 both die; only the attacker triggers.
    const wall = spawn(ctx, 'P2', GRIZZLY('P2 Wall'));
    declaredCombat(ctx, { [mine.id]: 'P2' }, { [wall.id]: mine.id });
    expect(life()).toEqual([41, 39, 39, 39]);
    // Two attackers die at once: two triggers.
    const [a, b] = [1, 2].map((n) => spawn(ctx, 'P1', GRIZZLY(`P1 Raider ${n}`)));
    const big = [1, 2].map((n) => spawn(ctx, 'P2', BRUTE_N(n)));
    declaredCombat(
      ctx,
      { [a!.id]: 'P2', [b!.id]: 'P2' },
      { [big[0]!.id]: a!.id, [big[1]!.id]: b!.id },
    );
    expect(life()).toEqual([43, 37, 37, 37]);
    // Kardur itself attacks and dies: it sees its own death.
    kardur.summoningSick = false;
    const brutes = [3, 4].map((n) => spawn(ctx, 'P3', BRUTE_N(n)));
    declaredCombat(
      ctx,
      { [kardur.id]: 'P3' },
      { [brutes[0]!.id]: kardur.id, [brutes[1]!.id]: kardur.id },
    );
    expect(ctx.state.battlefield.some((perm) => perm.id === kardur.id)).toBe(false);
    expect(life()).toEqual([44, 36, 36, 36]);
  });

  it('kardur-whole-game — cast it, an opponent’s required attack runs into a blocker and dies, and the drain resolves through the stack', () => {
    const { ctx, bears } = board('kardur-chain');
    const brute = spawn(ctx, 'P3', BRUTE);
    turnOfPlayer(ctx, 'P2');
    ctx.state.turnNumber += 1;
    const seen: Record<string, boolean | undefined> = {};
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId, subject) => {
          seen[subjectId] = subject.mustAttack;
          expect(subject.defenders.map((defender) => defender.playerId)).not.toContain('P1');
          return subject.mustAttack ? 'P3' : null;
        });
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, (subjectId) =>
          subjectId === brute.id ? bears.P2.id : null,
        );
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    expect(seen[bears.P2.id]).toBe(true);
    expect(ctx.state.battlefield.some((perm) => perm.id === bears.P2.id)).toBe(false);
    expect(['P1', 'P2', 'P3', 'P4'].map((id) => playerById(ctx, id).life)).toEqual([
      41, 39, 39, 39,
    ]);
    expect(ctx.state.stack).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// PR07.13 Galactus, Devourer of Worlds
// ---------------------------------------------------------------------------------------------

describe('Galactus, Devourer of Worlds', () => {
  const { card } = pinned('Galactus, Devourer of Worlds');
  const HERALD = oracle({
    name: "Silver Surfer, Galactus's Herald",
    typeLine: 'Creature — Alien Hero',
    manaCost: '{5}',
    power: '4',
    toughness: '5',
    oracleText: 'Flying',
  });
  const LOOKALIKE = oracle({
    name: 'Silver Surfer, Not The Herald',
    typeLine: 'Creature — Alien Hero',
    manaCost: '{5}',
    power: '4',
    toughness: '5',
  });

  /** P1 controls Galactus; the opponents' life totals are 20, 40 and 30. */
  function board(seed: string) {
    const ctx = pod(seed);
    const galactus = spawn(ctx, 'P1', card);
    playerById(ctx, 'P2').life = 20;
    playerById(ctx, 'P3').life = 40;
    playerById(ctx, 'P4').life = 30;
    return { ctx, galactus };
  }

  it('galactus-pinned-oracle-supported — the authored override carries the Insatiable Hunger requirement under both ids, and the exile trigger still parses', () => {
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.ruleStatics).toEqual([
      {
        kind: 'attackRequirement',
        target: 'opponentWithMostLife',
        unless: {
          kind: 'countPermanents',
          selector: {
            kind: 'allOf',
            of: [
              { kind: 'type', value: 'Creature' },
              { kind: 'name', value: "Silver Surfer, Galactus's Herald" },
            ],
          },
          scope: 'you',
          cmp: '>=',
          n: 1,
        },
      },
    ]);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toMatchObject({ when: 'enters' });
    expect(def.keywords).toEqual(expect.arrayContaining(['flying', 'trample', 'indestructible']));
  });

  it('galactus-attacks-most-life — it must attack the opponent with the most life, and nobody else, nor a planeswalker', () => {
    const { ctx, galactus } = board('galactus-most-life');
    const walker = spawn(ctx, 'P3', WALKER('P3 Walker'));
    const defenders: Record<string, string[]> = {};
    const walkers: Record<string, string[]> = {};
    expect(mustAttackIn(ctx, 'P1', [galactus], defenders, walkers)).toEqual({
      [galactus.id]: true,
    });
    // P3 has the most life (40): only P3 itself obeys it, not P2, P4, or P3's planeswalker.
    expect(defenders[galactus.id]).toEqual(['P3']);
    expect(walkers[galactus.id]).toEqual([]);
    expect(walkers[galactus.id]).not.toContain(walker.id);
  });

  it('galactus-ties — with the most life tied, attacking any tied opponent obeys it', () => {
    const { ctx, galactus } = board('galactus-tie');
    playerById(ctx, 'P4').life = 40;
    const defenders: Record<string, string[]> = {};
    mustAttackIn(ctx, 'P1', [galactus], defenders);
    expect(defenders[galactus.id]!.sort()).toEqual(['P3', 'P4']);
  });

  it('galactus-life-now — the opponent with the most life is read as attackers are declared, and your own life does not count', () => {
    const { ctx, galactus } = board('galactus-now');
    playerById(ctx, 'P1').life = 100;
    const defenders: Record<string, string[]> = {};
    mustAttackIn(ctx, 'P1', [galactus], defenders);
    expect(defenders[galactus.id]).toEqual(['P3']);
    playerById(ctx, 'P3').life = 10;
    mustAttackIn(ctx, 'P1', [galactus], defenders);
    expect(defenders[galactus.id]).toEqual(['P4']);
    // An opponent who has left the game is not among your opponents.
    playerById(ctx, 'P4').hasLost = true;
    mustAttackIn(ctx, 'P1', [galactus], defenders);
    expect(defenders[galactus.id]).toEqual(['P2']);
  });

  it('galactus-unable — when it cannot attack that opponent, nothing is required of it', () => {
    const { ctx, galactus } = board('galactus-unable');
    galactus.cantAttackPlayerWhileCounter = [{ playerId: 'P3', counter: 'vow' }];
    galactus.counters['vow'] = 1;
    const defenders: Record<string, string[]> = {};
    expect(mustAttackIn(ctx, 'P1', [galactus], defenders)).toEqual({ [galactus.id]: false });
    expect(defenders[galactus.id]!.sort()).toEqual(['P2', 'P4']);
  });

  it('galactus-silver-surfer — it has no requirement while you control a creature named Silver Surfer, Galactus’s Herald, and only then', () => {
    const { ctx, galactus } = board('galactus-surfer');
    expect(mustAttackIn(ctx, 'P1', [galactus])).toEqual({ [galactus.id]: true });
    // A creature with a similar name is not enough.
    spawn(ctx, 'P1', LOOKALIKE);
    expect(mustAttackIn(ctx, 'P1', [galactus])).toEqual({ [galactus.id]: true });
    // An opponent's Herald is not "a creature you control".
    const theirs = spawn(ctx, 'P2', HERALD);
    expect(mustAttackIn(ctx, 'P1', [galactus])).toEqual({ [galactus.id]: true });
    // Yours: no requirement; it may attack anyone, or no one.
    ctx.state.battlefield = ctx.state.battlefield.filter((perm) => perm.id !== theirs.id);
    const herald = spawn(ctx, 'P1', HERALD);
    const defenders: Record<string, string[]> = {};
    expect(mustAttackIn(ctx, 'P1', [galactus], defenders)).toEqual({ [galactus.id]: false });
    expect(defenders[galactus.id]!.sort()).toEqual(['P2', 'P3', 'P4']);
    // The Herald leaves and the requirement is back.
    ctx.state.battlefield = ctx.state.battlefield.filter((perm) => perm.id !== herald.id);
    expect(mustAttackIn(ctx, 'P1', [galactus])).toEqual({ [galactus.id]: true });
  });

  it('galactus-control — whoever controls it reads "your opponents" from their own seat', () => {
    const { ctx, galactus } = board('galactus-control');
    galactus.controllerId = 'P2';
    const defenders: Record<string, string[]> = {};
    // P2's opponents are P1 (40), P3 (40) and P4 (30): P1 and P3 are tied for the most life.
    mustAttackIn(ctx, 'P2', [galactus], defenders);
    expect(defenders[galactus.id]!.sort()).toEqual(['P1', 'P3']);
  });

  it('galactus-whole-game — cast it for ten, its enters trigger exiles a permanent, and when it attacks it must go for the opponent with the most life', () => {
    const ctx = pod('galactus-chain');
    const bear = spawn(ctx, 'P2', GRIZZLY('P2 Bear'));
    playerById(ctx, 'P4').life = 35;
    const object = castFromHand(ctx, 'P1', card, generic(10));
    resolveTop(ctx);
    settle(ctx, aimAt(bear.id));
    expect(ctx.state.battlefield.some((perm) => perm.id === bear.id)).toBe(false);
    expect(ctx.state.exile.some((entry) => entry.name === 'P2 Bear')).toBe(true);
    const galactus = ctx.state.battlefield.find((perm) => perm.cardId === object.cardId)!;
    galactus.summoningSick = false;
    const defenders: Record<string, string[]> = {};
    expect(mustAttackIn(ctx, 'P1', [galactus], defenders)).toEqual({ [galactus.id]: true });
    // P2 and P3 are at 40: they are tied for the most.
    expect(defenders[galactus.id]!.sort()).toEqual(['P2', 'P3']);
    expect(playerById(ctx, 'P1').life).toBe(40);
  });
});

// ---------------------------------------------------------------------------------------------
// PR07.22 Silver Surfer, Galactus's Herald
// ---------------------------------------------------------------------------------------------

describe("Silver Surfer, Galactus's Herald", () => {
  const { card } = pinned("Silver Surfer, Galactus's Herald");
  const galactus = pinned('Galactus, Devourer of Worlds').card;
  const COST = generic(5);

  const libraryNames = (ctx: GameContext, playerId: string) =>
    playerById(ctx, playerId).library.map((entry) => entry.name);

  it('silver-surfer-pinned-oracle-supported — the authored override carries the optional search and the damage trigger under both ids', () => {
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(2);
    expect(def.triggers[0]!.optional).toBe(true);
    expect(def.triggers[0]!.effects).toMatchObject([
      {
        op: 'searchLibrary',
        filter: { kind: 'name', value: 'Galactus, Devourer of Worlds' },
        destinations: [{ zone: 'hand' }],
        reveal: true,
      },
      { op: 'shuffle' },
    ]);
    expect(def.triggers[1]!.trigger).toMatchObject({ when: 'dealsCombatDamageToPlayer' });
    expect(def.triggers[1]!.effects).toMatchObject([
      {
        op: 'addAttackRequirement',
        requirements: [{ kind: 'player', player: 'eventPlayer' }],
        duration: 'endOfYourNextTurn',
      },
    ]);
  });

  it('silver-surfer-search — you may search for a card named Galactus: it goes to your hand revealed, and the library is shuffled', () => {
    const ctx = pod('surfer-search');
    conjure(ctx, 'P1', galactus, 'library');
    const decoy = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Galactus, Not Quite',
        typeLine: 'Creature — God',
        power: '1',
        toughness: '1',
      }),
      'library',
    );
    castFromHand(ctx, 'P1', card, COST);
    resolveTop(ctx);
    const shuffles = () => ctx.state.eventLog.filter((event) => event.type === 'shuffle').length;
    const before = shuffles();
    settle(ctx, (decision) => {
      const yes = decision.options.findIndex((option) =>
        /yes|search|accept/i.test(option.description),
      );
      const galactusOption = decision.options.findIndex((option) =>
        option.description.includes('Galactus, Devourer of Worlds'),
      );
      return { index: Math.max(galactusOption >= 0 ? galactusOption : yes, 0), targets: new Map() };
    });
    const hand = playerById(ctx, 'P1').hand.map((entry) => entry.name);
    expect(hand).toContain('Galactus, Devourer of Worlds');
    expect(hand).not.toContain('Galactus, Not Quite');
    expect(libraryNames(ctx, 'P1')).toContain(decoy.name);
    expect(libraryNames(ctx, 'P1')).not.toContain('Galactus, Devourer of Worlds');
    expect(shuffles()).toBe(before + 1);
  });

  it('silver-surfer-search-fails — with no Galactus in the library, nothing is found and the library is still shuffled; declining the search shuffles nothing', () => {
    const ctx = pod('surfer-no-galactus');
    castFromHand(ctx, 'P1', card, COST);
    resolveTop(ctx);
    const shuffles = () => ctx.state.eventLog.filter((event) => event.type === 'shuffle').length;
    const before = shuffles();
    settle(ctx, (decision) => {
      const yes = decision.options.findIndex(
        (option) => !/decline|no\b|skip/i.test(option.description),
      );
      return { index: Math.max(yes, 0), targets: new Map() };
    });
    expect(playerById(ctx, 'P1').hand.map((entry) => entry.name)).not.toContain(
      'Galactus, Devourer of Worlds',
    );
    expect(shuffles()).toBe(before + 1);
    // Declined: no search, no shuffle.
    const second = pod('surfer-decline');
    conjure(second, 'P1', galactus, 'library');
    castFromHand(second, 'P1', card, COST);
    resolveTop(second);
    const base = second.state.eventLog.filter((event) => event.type === 'shuffle').length;
    settle(second, (decision) => ({
      index: Math.max(
        decision.options.findIndex((option) => option.type === 'declineTrigger'),
        0,
      ),
      targets: new Map(),
    }));
    expect(playerById(second, 'P1').hand.map((entry) => entry.name)).not.toContain(
      'Galactus, Devourer of Worlds',
    );
    expect(second.state.eventLog.filter((event) => event.type === 'shuffle').length).toBe(base);
  });

  /** P1's Surfer hits P2; the trigger targets `target`. */
  function hit(ctx: GameContext, surfer: EnginePermanent, target: EnginePermanent) {
    fight(ctx, () => ({ [surfer.id]: 'P2' }), aimAt(target.id));
    expect(playerById(ctx, 'P2').life).toBe(36);
  }

  it('silver-surfer-attack-that-player — the target creature, whoever controls it, must attack the damaged player each combat until the end of your next turn', () => {
    const ctx = pod('surfer-requirement');
    const surfer = spawn(ctx, 'P1', card);
    const bear = spawn(ctx, 'P3', GRIZZLY('P3 Bear'));
    const other = spawn(ctx, 'P3', GRIZZLY('P3 Other'));
    const p2Walker = spawn(ctx, 'P2', WALKER('P2 Walker'));
    hit(ctx, surfer, bear);
    expect(ctx.state.attackRequirements).toHaveLength(1);
    const defenders: Record<string, string[]> = {};
    const walkers: Record<string, string[]> = {};
    // On P3's turn: it must attack P2, the player, and not P1, P4 or P2's planeswalker.
    expect(mustAttackIn(ctx, 'P3', [bear, other], defenders, walkers)).toEqual({
      [bear.id]: true,
      [other.id]: false,
    });
    expect(defenders[bear.id]).toEqual(['P2']);
    expect(walkers[bear.id]).not.toContain(p2Walker.id);
    expect(walkers[bear.id]).toEqual([]);
  });

  it('silver-surfer-duration — it lasts through the other players’ turns and all of your next turn, and ends in that turn’s cleanup step', () => {
    const ctx = pod('surfer-duration');
    const surfer = spawn(ctx, 'P1', card);
    const bear = spawn(ctx, 'P3', GRIZZLY('P3 Bear'));
    hit(ctx, surfer, bear);
    // Cleanup of the turn it was made in does not end it.
    pump(cleanupStep(ctx));
    expect(ctx.state.attackRequirements).toHaveLength(1);
    for (const [index, id] of ['P2', 'P3', 'P4'].entries()) {
      turnOfPlayer(ctx, id);
      ctx.state.turnNumber += 1;
      pump(runBeginningAndPrecombatMain(ctx));
      expect(ctx.state.attackRequirements, `turn of ${id}`).toHaveLength(1);
      expect(index).toBeLessThan(3);
    }
    // Your next turn: still on, through combat.
    turnOfPlayer(ctx, 'P1');
    ctx.state.turnNumber += 1;
    pump(runBeginningAndPrecombatMain(ctx));
    expect(ctx.state.attackRequirements).toHaveLength(1);
    pump(cleanupStep(ctx));
    expect(ctx.state.attackRequirements).toHaveLength(0);
    expect(mustAttackIn(ctx, 'P3', [bear])).toEqual({ [bear.id]: false });
  });

  it('silver-surfer-own-creature-and-unable — it can target your own creature, and a creature that cannot attack that player is not required to attack at all', () => {
    const ctx = pod('surfer-own');
    const surfer = spawn(ctx, 'P1', card);
    const mine = spawn(ctx, 'P1', GRIZZLY('P1 Bear'));
    hit(ctx, surfer, mine);
    turnOfPlayer(ctx, 'P1');
    ctx.state.turnNumber += 4;
    const defenders: Record<string, string[]> = {};
    expect(mustAttackIn(ctx, 'P1', [mine], defenders)).toEqual({ [mine.id]: true });
    expect(defenders[mine.id]).toEqual(['P2']);
    // P2 can no longer be attacked: nothing is required.
    playerById(ctx, 'P2').hasLost = true;
    expect(mustAttackIn(ctx, 'P1', [mine])).toEqual({ [mine.id]: false });
  });
});

// ---------------------------------------------------------------------------------------------
// PR07.15 Taunt from the Rampart
// ---------------------------------------------------------------------------------------------

describe('Taunt from the Rampart', () => {
  const { card } = pinned('Taunt from the Rampart');
  const COST = [{ symbol: 'R' as const }, { symbol: 'W' as const }, ...generic(3)];
  const goaders = (perm: EnginePermanent) => (perm.goadedBy ?? []).map((entry) => entry.goaderId);

  /** P1 casts Taunt; P2 and P3 each control a Bear, P1 a Raider. */
  function board(seed: string) {
    const ctx = pod(seed);
    const bears = {
      P2: spawn(ctx, 'P2', GRIZZLY('P2 Bear')),
      P3: spawn(ctx, 'P3', GRIZZLY('P3 Bear')),
      P4: spawn(ctx, 'P4', GRIZZLY('P4 Bear')),
    };
    const mine = spawn(ctx, 'P1', GRIZZLY('P1 Wall'));
    const raider = spawn(ctx, 'P1', GRIZZLY('P1 Raider'));
    castFromHand(ctx, 'P1', card, COST);
    resolveTop(ctx);
    settle(ctx);
    return { ctx, bears, mine, raider };
  }

  it('taunt-pinned-oracle-supported — the authored override goads and then keeps the same creatures from blocking, under both ids', () => {
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.spellAbility?.effects).toMatchObject([
      { op: 'goadEachOpponent' },
      { op: 'cantBlockEach', duration: 'untilYourNextTurn' },
    ]);
  });

  it('taunt-goads-all — every creature your opponents control is goaded by you, and yours are not', () => {
    const { ctx, bears, mine } = board('taunt-goad');
    for (const bear of Object.values(bears)) expect(goaders(bear)).toEqual(['P1']);
    expect(goaders(mine)).toEqual([]);
    const defenders: Record<string, string[]> = {};
    expect(mustAttackIn(ctx, 'P2', [bears.P2], defenders)).toEqual({ [bears.P2.id]: true });
    expect(defenders[bears.P2.id]).not.toContain('P1');
  });

  it("taunt-cant-block — those creatures can't block until your next turn, and your own creatures can", () => {
    const { ctx, bears, mine, raider } = board('taunt-block');
    // P2's goaded Bear is the only creature P2 has and it can't block your Raider.
    const unblocked = declaredCombat(ctx, { [raider.id]: 'P2' }, { [bears.P2.id]: raider.id });
    expect(unblocked.asked.blockers).toBe(0);
    expect(playerById(ctx, 'P2').life).toBe(38);
    // Your own creatures are not restricted: P2 attacking you can be blocked by your Wall.
    turnOfPlayer(ctx, 'P2');
    ctx.state.turnNumber += 1;
    bears.P2.tapped = false;
    const blocked = declaredCombat(ctx, { [bears.P2.id]: 'P1' }, { [mine.id]: bears.P2.id });
    expect(blocked.asked.blockers).toBe(1);
  });

  it('taunt-fixed-set — a creature an opponent gets afterwards is neither goaded nor kept from blocking, and one that changes hands stays affected', () => {
    const { ctx, bears, raider } = board('taunt-fixed');
    const later = spawn(ctx, 'P2', GRIZZLY('P2 Latecomer'));
    expect(goaders(later)).toEqual([]);
    const blocked = declaredCombat(ctx, { [raider.id]: 'P2' }, { [later.id]: raider.id });
    expect(blocked.asked.blockers).toBe(1);
    // P3's Bear passes to P2: it still can't block, and is still goaded.
    bears.P3.controllerId = 'P2';
    raider.tapped = false;
    const stolen = declaredCombat(ctx, { [raider.id]: 'P2' }, { [bears.P3.id]: raider.id });
    expect(stolen.blockRejections).toEqual([]);
    expect(goaders(bears.P3)).toEqual(['P1']);
    expect(bears.P3.blocking).toBeNull();
  });

  it('taunt-until-your-next-turn — it lasts through every other turn and ends, goad and all, as your next turn begins', () => {
    const { ctx, bears } = board('taunt-duration');
    for (const [index, id] of ['P2', 'P3', 'P4'].entries()) {
      turnOfPlayer(ctx, id);
      ctx.state.turnNumber += 1;
      pump(runBeginningAndPrecombatMain(ctx));
      expect(ctx.state.blockRestrictions, `turn of ${id}`).toHaveLength(1);
      expect(goaders(bears.P2), `turn of ${id}`).toEqual(['P1']);
      expect(index).toBeLessThan(3);
    }
    turnOfPlayer(ctx, 'P1');
    ctx.state.turnNumber += 1;
    pump(runBeginningAndPrecombatMain(ctx));
    expect(ctx.state.blockRestrictions).toHaveLength(0);
    expect(goaders(bears.P2)).toEqual([]);
    // They can block again.
    const raider = spawn(ctx, 'P1', GRIZZLY('P1 Late Raider'));
    const blocked = declaredCombat(ctx, { [raider.id]: 'P2' }, { [bears.P2.id]: raider.id });
    expect(blocked.asked.blockers).toBe(1);
  });

  it('taunt-whole-game — cast through the stack: opponents’ goaded creatures attack someone else on their turns and cannot block yours', () => {
    const { ctx, bears, raider } = board('taunt-chain');
    expect(ctx.state.stack).toEqual([]);
    // P3's turn: its Bear must attack, and not P1.
    const defenders: Record<string, string[]> = {};
    expect(mustAttackIn(ctx, 'P3', [bears.P3], defenders)).toEqual({ [bears.P3.id]: true });
    expect(defenders[bears.P3.id]!.sort()).toEqual(['P2', 'P4']);
    // Back on your turn (before it begins anew) none of them may block your Raider.
    turnOfPlayer(ctx, 'P1');
    bears.P4.tapped = false;
    const before = playerById(ctx, 'P4').life;
    const run = declaredCombat(ctx, { [raider.id]: 'P4' }, { [bears.P4.id]: raider.id });
    expect(run.asked.blockers).toBe(0);
    expect(playerById(ctx, 'P4').life).toBe(before - 2);
  });
});

// ---------------------------------------------------------------------------------------------
// PR07.02 Hexmark Destroyer
// ---------------------------------------------------------------------------------------------

describe('Hexmark Destroyer', () => {
  const { card } = pinned('Hexmark Destroyer');
  const COST = [{ symbol: 'B' as const }, { symbol: 'B' as const }, ...generic(4)];

  /** P1 attacks with Hexmark; P2 controls seven Bears. */
  function board(seed: string) {
    const ctx = pod(seed);
    const hexmark = spawn(ctx, 'P1', card);
    const bears = Array.from({ length: 7 }, (_, n) =>
      spawn(ctx, 'P2', GRIZZLY(`P2 Bear ${n + 1}`)),
    );
    return { ctx, hexmark, bears };
  }
  const blocking = (bears: EnginePermanent[], count: number, hexmark: EnginePermanent) =>
    Object.fromEntries(bears.slice(0, count).map((bear) => [bear.id, hexmark.id]));

  it('hexmark-pinned-oracle-supported — the authored override carries the six-blockers rule and unearth still parses, under both ids', () => {
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.ruleStatics).toEqual([{ kind: 'minBlockers', minimum: 6 }]);
    expect(def.cantBeBlocked).not.toBe(true);
    expect(def.activatedAbilities.length).toBeGreaterThan(0);
  });

  it('hexmark-unblocked-or-six — with no blockers it is unblocked, and six or more creatures may block it', () => {
    const { ctx, hexmark, bears } = board('hexmark-six');
    const none = declaredCombat(ctx, { [hexmark.id]: 'P2' });
    expect(none.blockRejections).toEqual([]);
    expect(playerById(ctx, 'P2').life).toBe(34);
    for (const count of [6, 7]) {
      hexmark.tapped = false;
      const run = declaredCombat(ctx, { [hexmark.id]: 'P2' }, blocking(bears, count, hexmark));
      expect(run.blockRejections, `${count} blockers`).toEqual([]);
    }
  });

  it('hexmark-too-few — one to five blockers are rejected, and the repair drops all of them so it is unblocked', () => {
    for (const count of [1, 2, 5]) {
      const { ctx, hexmark, bears } = board(`hexmark-few-${count}`);
      const run = declaredCombat(ctx, { [hexmark.id]: 'P2' }, blocking(bears, count, hexmark));
      expect(run.blockRejections.length, `${count} blockers`).toBeGreaterThan(0);
      expect(new Set(run.blockRejections)).toEqual(new Set(['minBlockers']));
      expect(playerById(ctx, 'P2').life, `${count} blockers`).toBe(34);
      expect(bears.every((bear) => bear.blocking === null)).toBe(true);
    }
  });

  it('hexmark-others-unaffected — another attacker can be blocked by one creature, and the rule is not menace', () => {
    const { ctx, hexmark, bears } = board('hexmark-other');
    const raider = spawn(ctx, 'P1', GRIZZLY('P1 Raider'));
    const run = declaredCombat(
      ctx,
      { [raider.id]: 'P2', [hexmark.id]: 'P2' },
      { [bears[0]!.id]: raider.id },
    );
    expect(run.blockRejections).toEqual([]);
    expect(playerById(ctx, 'P2').life).toBe(34);
  });

  it('hexmark-copy-and-lost-abilities — a copy of it has the rule, and it loses the rule when it becomes a copy of something else', () => {
    const { ctx, hexmark, bears } = board('hexmark-copy');
    const clay = spawn(ctx, 'P1', GRIZZLY('P1 Clay'));
    applyCopy(ctx, clay, hexmark);
    const copied = declaredCombat(ctx, { [clay.id]: 'P2' }, blocking(bears, 2, clay));
    expect(copied.blockRejections.length).toBeGreaterThan(0);
    applyCopy(ctx, hexmark, bears[6]!);
    hexmark.tapped = false;
    const plain = declaredCombat(ctx, { [hexmark.id]: 'P2' }, blocking(bears, 1, hexmark));
    expect(plain.blockRejections).toEqual([]);
  });

  it('hexmark-whole-game — cast it, attack with it next turn, and two blockers are not enough', () => {
    const ctx = pod('hexmark-chain');
    const bears = [1, 2].map((n) => spawn(ctx, 'P3', GRIZZLY(`P3 Bear ${n}`)));
    const object = castFromHand(ctx, 'P1', card, COST);
    resolveTop(ctx);
    settle(ctx);
    const hexmark = ctx.state.battlefield.find((perm) => perm.cardId === object.cardId)!;
    hexmark.summoningSick = false;
    const run = declaredCombat(ctx, { [hexmark.id]: 'P3' }, blocking(bears, 2, hexmark));
    expect(run.blockRejections.length).toBeGreaterThan(0);
    expect(playerById(ctx, 'P3').life).toBe(34);
  });
});

// ---------------------------------------------------------------------------------------------
// PR07.01 Champion of Lambholt
// ---------------------------------------------------------------------------------------------

describe('Champion of Lambholt', () => {
  const { card } = pinned('Champion of Lambholt');
  const POWER = (name: string, power: number) =>
    oracle({
      name,
      typeLine: 'Creature — Lab',
      manaCost: '{0}',
      power: String(power),
      toughness: '5',
    });

  /** P1's Champion (1/1) with a Raider; P2 has blockers of power 0, 1, 2 and 3. */
  function board(seed: string) {
    const ctx = pod(seed);
    const champion = spawn(ctx, 'P1', card);
    const raider = spawn(ctx, 'P1', GRIZZLY('P1 Raider'));
    const blockers = [0, 1, 2, 3].map((power) =>
      spawn(ctx, 'P2', POWER(`P2 Power ${power}`, power)),
    );
    return { ctx, champion, raider, blockers };
  }

  /** Which of `blockers` could be declared as a blocker of the Raider's attack on P2. */
  function whoCanBlock(
    ctx: GameContext,
    raider: EnginePermanent,
    blockers: EnginePermanent[],
  ): string[] {
    const offered: string[] = [];
    raider.tapped = false;
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (id) => (id === raider.id ? 'P2' : null));
      if (decision.presentationBlockDeclaration !== undefined) {
        for (const subject of decision.presentationBlockDeclaration.subjects)
          if (subject.attackers.some((entry) => entry.attackerId === raider.id))
            offered.push(subject.name);
        return declareBlocks(decision, () => null);
      }
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    return blockers.filter((blocker) => offered.includes(blocker.name)).map((b) => b.name);
  }

  it('champion-pinned-oracle-supported — the authored override carries the can’t-block rule static and the interpreter reads the counter trigger, under both ids', () => {
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.ruleStatics).toEqual([
      {
        kind: 'cantBlockCreatures',
        attackerFilter: { kind: 'controller', who: 'you' },
        blockerPowerLessThanSource: true,
      },
    ]);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toMatchObject({ when: 'enters' });
  });

  it('champion-power-less — creatures with power less than the Champion’s power can’t block your creatures, and the comparison is to its CURRENT power', () => {
    const { ctx, champion, raider, blockers } = board('champion-power');
    // Power 1: only the power-0 creature is shut out.
    expect(whoCanBlock(ctx, raider, blockers)).toEqual(['P2 Power 1', 'P2 Power 2', 'P2 Power 3']);
    // Two +1/+1 counters make it a 3/3: only power 3 or more may block.
    champion.counters['+1/+1'] = 2;
    expect(whoCanBlock(ctx, raider, blockers)).toEqual(['P2 Power 3']);
    // Equal power is fine, and the restriction follows its power back down.
    delete champion.counters['+1/+1'];
    expect(whoCanBlock(ctx, raider, blockers)).toEqual(['P2 Power 1', 'P2 Power 2', 'P2 Power 3']);
  });

  it('champion-only-yours — it restricts blocks of creatures YOU control, not other players’ attackers or your own blockers', () => {
    const { ctx, champion, blockers } = board('champion-yours');
    champion.counters['+1/+1'] = 5;
    // P2's attacker is blocked by P3's weak creature, and your own weak creature can block it.
    const attacker = spawn(ctx, 'P2', GRIZZLY('P2 Attacker'));
    const weakP3 = spawn(ctx, 'P3', POWER('P3 Weak', 0));
    const weakMine = spawn(ctx, 'P1', POWER('P1 Weak', 0));
    turnOfPlayer(ctx, 'P2');
    ctx.state.turnNumber += 1;
    const blocked = declaredCombat(ctx, { [attacker.id]: 'P3' }, { [weakP3.id]: attacker.id });
    expect(blocked.asked.blockers).toBe(1);
    attacker.tapped = false;
    const mine = declaredCombat(ctx, { [attacker.id]: 'P1' }, { [weakMine.id]: attacker.id });
    expect(mine.asked.blockers).toBe(1);
    expect(blockers.length).toBe(4);
  });

  it('champion-copies-and-lost-abilities — a copy has the static, and it is gone when the Champion leaves or becomes something else', () => {
    const { ctx, champion, raider, blockers } = board('champion-copy');
    const clay = spawn(ctx, 'P3', GRIZZLY('P3 Clay'));
    applyCopy(ctx, clay, champion);
    const attackerP3 = clay;
    attackerP3.counters['+1/+1'] = 1;
    // P3's copy restricts blocks of P3's creatures (it is "this creature" for its own controller).
    const victim = spawn(ctx, 'P3', GRIZZLY('P3 Attacker'));
    const weak = spawn(ctx, 'P4', POWER('P4 Weak', 0));
    turnOfPlayer(ctx, 'P3');
    ctx.state.turnNumber += 1;
    victim.tapped = false;
    const run = declaredCombat(ctx, { [victim.id]: 'P4' }, { [weak.id]: victim.id });
    expect(run.asked.blockers).toBe(0);
    // The Champion becomes a Bear (copy of one): the static is gone.
    applyCopy(ctx, champion, spawn(ctx, 'P3', GRIZZLY('P3 Template')));
    turnOfPlayer(ctx, 'P1');
    expect(whoCanBlock(ctx, raider, blockers)).toEqual([
      'P2 Power 0',
      'P2 Power 1',
      'P2 Power 2',
      'P2 Power 3',
    ]);
  });

  it('champion-leaves — with the Champion gone nothing is restricted', () => {
    const { ctx, champion, raider, blockers } = board('champion-gone');
    ctx.state.battlefield = ctx.state.battlefield.filter((perm) => perm.id !== champion.id);
    expect(whoCanBlock(ctx, raider, blockers)).toHaveLength(4);
  });

  it('champion-whole-game — cast it, another creature of yours entering puts a counter on it, and weaker creatures then can’t block', () => {
    const ctx = pod('champion-chain');
    const raider = spawn(ctx, 'P1', GRIZZLY('P1 Raider'));
    const blockers = [1, 2].map((power) => spawn(ctx, 'P2', POWER(`P2 Power ${power}`, power)));
    const object = castFromHand(ctx, 'P1', card, [{ symbol: 'G' }, { symbol: 'G' }, ...generic(1)]);
    resolveTop(ctx);
    settle(ctx);
    const champion = ctx.state.battlefield.find((perm) => perm.cardId === object.cardId)!;
    expect(whoCanBlock(ctx, raider, blockers)).toEqual(['P2 Power 1', 'P2 Power 2']);
    // Another creature enters under your control: a counter, so it is a 2/2 and power 1 is shut out.
    ctx.state.phase = 'precombatMain';
    ctx.state.step = null;
    castFromHand(ctx, 'P1', GRIZZLY('P1 Bear'), generic(1));
    resolveTop(ctx);
    settle(ctx);
    expect(champion.counters['+1/+1']).toBe(1);
    expect(whoCanBlock(ctx, raider, blockers)).toEqual(['P2 Power 2']);
  });
});

// ---------------------------------------------------------------------------------------------
// PR07.20 Pramikon, Sky Rampart
// ---------------------------------------------------------------------------------------------

describe('Pramikon, Sky Rampart', () => {
  const { card } = pinned('Pramikon, Sky Rampart');
  const COST = [{ symbol: 'U' as const }, { symbol: 'R' as const }, { symbol: 'W' as const }];

  /** Pramikon under P1's control with the direction chosen; every player has an attacker. */
  function board(seed: string, direction: 'left' | 'right' | undefined = 'left') {
    const ctx = pod(seed);
    const pramikon = spawn(ctx, 'P1', card);
    if (direction !== undefined) pramikon.chosenOption = direction;
    const attackers: Record<string, EnginePermanent> = {};
    for (const id of ['P1', 'P2', 'P3', 'P4']) {
      attackers[id] = spawn(ctx, id, GRIZZLY(`${id} Attacker`));
    }
    return { ctx, pramikon, attackers };
  }

  /** The players and planeswalkers `creature`'s controller may attack, sorted. */
  const offeredFor = (ctx: GameContext, creature: EnginePermanent) => {
    const offered = attackOptionsFor(ctx, creature.controllerId, creature);
    return { players: offered.players.sort(), planeswalkers: offered.planeswalkers.sort() };
  };

  it('pramikon-pinned-oracle-supported — the authored override carries the as-enters choice and the seat restriction under both ids, and flying and defender still parse', () => {
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.entersChoosingOption?.options?.map((option) => option.key)).toEqual([
      'left',
      'right',
    ]);
    expect(def.ruleStatics).toEqual([{ kind: 'attackOnlyNearestOpponent' }]);
    expect(def.keywords).toEqual(expect.arrayContaining(['flying', 'defender']));
  });

  it('pramikon-left-right — each player may attack only the nearest opponent in the chosen direction, and the direction decides who that is', () => {
    const { ctx, pramikon, attackers } = board('pramikon-seats', 'left');
    // Seating is P1, P2, P3, P4 and turn order passes to the left: P1's left is P2.
    expect(offeredFor(ctx, attackers['P1']!).players).toEqual(['P2']);
    expect(offeredFor(ctx, attackers['P2']!).players).toEqual(['P3']);
    expect(offeredFor(ctx, attackers['P4']!).players).toEqual(['P1']);
    pramikon.chosenOption = 'right';
    expect(offeredFor(ctx, attackers['P1']!).players).toEqual(['P4']);
    expect(offeredFor(ctx, attackers['P2']!).players).toEqual(['P1']);
    expect(offeredFor(ctx, attackers['P3']!).players).toEqual(['P2']);
  });

  it('pramikon-planeswalkers — only the planeswalkers that nearest opponent controls can be attacked too', () => {
    const { ctx, attackers } = board('pramikon-walkers', 'left');
    const mine = spawn(ctx, 'P1', WALKER('P1 Walker'));
    const nearest = spawn(ctx, 'P2', WALKER('P2 Walker'));
    spawn(ctx, 'P3', WALKER('P3 Walker'));
    expect(mine.id).not.toBe(nearest.id);
    expect(offeredFor(ctx, attackers['P1']!)).toEqual({
      players: ['P2'],
      planeswalkers: [nearest.id],
    });
  });

  it('pramikon-skips-eliminated — a player who has left the game is not the nearest opponent', () => {
    const { ctx, pramikon, attackers } = board('pramikon-eliminated', 'left');
    playerById(ctx, 'P2').hasLost = true;
    expect(offeredFor(ctx, attackers['P1']!).players).toEqual(['P3']);
    playerById(ctx, 'P3').hasLost = true;
    expect(offeredFor(ctx, attackers['P1']!).players).toEqual(['P4']);
    // Two players left: the other one, whichever way it points.
    pramikon.chosenOption = 'right';
    expect(offeredFor(ctx, attackers['P1']!).players).toEqual(['P4']);
  });

  it('pramikon-intersect — two Pramikons pointing opposite ways can leave no legal attack, and a creature then is not required to attack', () => {
    const { ctx, attackers } = board('pramikon-two', 'left');
    const second = spawn(ctx, 'P3', card);
    second.chosenOption = 'right';
    expect(offeredFor(ctx, attackers['P1']!)).toEqual({ players: [], planeswalkers: [] });
    // Goaded by P3 and unable to attack anyone: nothing is required of it.
    attackers['P1']!.goadedBy = [{ goaderId: 'P3', appliedTurn: ctx.state.turnNumber }];
    expect(mustAttackIn(ctx, 'P1', [attackers['P1']!])).toEqual({
      [attackers['P1']!.id]: false,
    });
    // Two pointing the same way is the same restriction as one.
    second.chosenOption = 'left';
    expect(offeredFor(ctx, attackers['P2']!).players).toEqual(['P3']);
  });

  it('pramikon-requirements — a goaded creature must still attack its nearest opponent even when that is the goader', () => {
    const { ctx, attackers } = board('pramikon-goad', 'left');
    attackers['P1']!.goadedBy = [{ goaderId: 'P2', appliedTurn: ctx.state.turnNumber }];
    const defenders: Record<string, string[]> = {};
    expect(mustAttackIn(ctx, 'P1', [attackers['P1']!], defenders)).toEqual({
      [attackers['P1']!.id]: true,
    });
    expect(defenders[attackers['P1']!.id]).toEqual(['P2']);
  });

  it('pramikon-no-choice-no-restriction — a Pramikon that never chose a direction restricts nothing', () => {
    const { ctx, pramikon, attackers } = board('pramikon-unchosen', undefined);
    delete pramikon.chosenOption;
    expect(offeredFor(ctx, attackers['P1']!).players).toEqual(['P2', 'P3', 'P4']);
  });

  it('pramikon-leaves — the restriction is gone when Pramikon leaves the battlefield', () => {
    const { ctx, pramikon, attackers } = board('pramikon-gone', 'left');
    expect(offeredFor(ctx, attackers['P1']!).players).toEqual(['P2']);
    ctx.state.battlefield = ctx.state.battlefield.filter((perm) => perm.id !== pramikon.id);
    expect(offeredFor(ctx, attackers['P1']!).players).toEqual(['P2', 'P3', 'P4']);
  });

  it('pramikon-not-attacking-tokens — creatures put onto the battlefield attacking are not limited', () => {
    const { ctx } = board('pramikon-token', 'left');
    const offered: string[] = [];
    turnOfPlayer(ctx, 'P1');
    ctx.state.phase = 'combat';
    ctx.state.step = 'declareAttackers';
    // Someone else's creature already attacks P2 and P3 (it was declared before Pramikon arrived).
    ctx.state.combat = { defendingPlayers: ['P2', 'P3'] };
    pump(
      executeAbility(
        ctx,
        { cardId: 'src', oracleId: card.oracleId, name: card.name, controllerId: 'P1' },
        spell({
          effects: [
            {
              op: 'createTokenAttacking',
              spec: INKLING_2_1_FLYING,
              count: { kind: 'const', n: 1 },
            },
          ],
        }),
        [],
      ),
      (decision) => {
        offered.push(...decision.options.map((option) => option.description));
        return {
          index: Math.max(
            decision.options.findIndex((option) => option.description === 'Attack P3'),
            0,
          ),
          targets: new Map(),
        };
      },
    );
    expect(offered).toEqual(['Attack P2', 'Attack P3']);
    const token = ctx.state.battlefield.find((perm) => perm.isToken && perm.name === 'Inkling')!;
    expect(token.attacking).toBe('P3');
  });

  it('pramikon-whole-game — cast it, choose right as it enters, and every attacker is then limited to its right-hand opponent', () => {
    const ctx = pod('pramikon-chain');
    const attacker = spawn(ctx, 'P1', GRIZZLY('P1 Attacker'));
    const walker = spawn(ctx, 'P4', WALKER('P4 Walker'));
    const object = castFromHand(ctx, 'P1', card, COST);
    resolveTop(ctx, (decision) => ({
      index: Math.max(
        decision.options.findIndex((option) => option.description === 'Right'),
        0,
      ),
      targets: new Map(),
    }));
    settle(ctx);
    const pramikon = ctx.state.battlefield.find((perm) => perm.cardId === object.cardId)!;
    expect(pramikon.chosenOption).toBe('right');
    expect(offeredFor(ctx, attacker)).toEqual({ players: ['P4'], planeswalkers: [walker.id] });
  });
});

// ---------------------------------------------------------------------------------------------
// PR07.10 Teyo, Geometric Tactician
// ---------------------------------------------------------------------------------------------

describe('Teyo, Geometric Tactician', () => {
  const { card } = pinned('Teyo, Geometric Tactician');

  /** Teyo under `controller`'s control; every player has an attacker. */
  function board(seed: string) {
    const ctx = pod(seed);
    const teyo = spawn(ctx, 'P1', card);
    const attackers: Record<string, EnginePermanent> = {};
    for (const id of ['P1', 'P2', 'P3', 'P4']) {
      attackers[id] = spawn(ctx, id, GRIZZLY(`${id} Attacker`));
    }
    return { ctx, teyo, attackers };
  }

  const offeredFor = (ctx: GameContext, creature: EnginePermanent) => {
    const offered = attackOptionsFor(ctx, creature.controllerId, creature);
    return { players: offered.players.sort(), planeswalkers: offered.planeswalkers.sort() };
  };

  /** Activate the loyalty ability whose description starts with `sign` through legality and the stack. */
  function activate(
    ctx: GameContext,
    teyo: EnginePermanent,
    sign: '+1' | '−2',
    answer?: Answer,
    targets?: ReadonlyMap<number, string>,
  ) {
    turnOfPlayer(ctx, teyo.controllerId);
    ctx.state.phase = 'precombatMain';
    ctx.state.step = null;
    const option = optionFor(
      ctx,
      teyo.controllerId,
      teyo.id,
      new RegExp(sign === '+1' ? '\\+1' : sign),
    );
    expect(option, `${sign} is offered`).toBeDefined();
    takeAction(ctx, teyo.controllerId, option!.payload as PriorityActionPayload, answer, targets);
    resolveTop(ctx, answer);
    settle(ctx);
  }

  const choose =
    (label: 'Left' | 'Right'): Answer =>
    (decision) => ({
      index: Math.max(
        decision.options.findIndex((option) => option.description === label),
        0,
      ),
      targets: new Map(),
    });

  it('teyo-pinned-oracle-supported — the Wall line is read and the two loyalty abilities are authored, under both ids', () => {
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toMatchObject({ when: 'enters' });
    expect(def.activatedAbilities.map((ability) => ability.costs)).toEqual([
      [{ kind: 'loyalty', delta: 1 }],
      [{ kind: 'loyalty', delta: -2 }],
    ]);
    expect(def.activatedAbilities[0]!.ability.effects).toEqual([
      { op: 'drawTargetAndController', target: 0 },
    ]);
  });

  it('teyo-enters-wall — when Teyo enters it creates a 0/4 white Wall with defender and flying', () => {
    const ctx = pod('teyo-wall');
    const object = castFromHand(ctx, 'P1', card, [
      { symbol: 'W' },
      { symbol: 'C' },
      { symbol: 'C' },
    ]);
    resolveTop(ctx);
    settle(ctx);
    const teyo = ctx.state.battlefield.find((perm) => perm.cardId === object.cardId)!;
    expect(teyo.counters['loyalty']).toBe(3);
    const wall = ctx.state.battlefield.find((perm) => perm.name === 'Wall')!;
    expect(wall.isToken).toBe(true);
    expect(computeCharacteristics(ctx, wall)).toMatchObject({ power: 0, toughness: 4 });
    expect(wall.controllerId).toBe('P1');
  });

  it('teyo-plus-one-draw — you and the target opponent each draw a card, nobody else does, and it adds loyalty', () => {
    const { ctx, teyo } = board('teyo-plus');
    const before = ['P1', 'P2', 'P3', 'P4'].map((id) => handSize(ctx, id));
    activate(ctx, teyo, '+1', undefined, new Map([[0, 'P3']]));
    const after = ['P1', 'P2', 'P3', 'P4'].map((id) => handSize(ctx, id));
    expect(after.map((n, i) => n - before[i]!)).toEqual([1, 0, 1, 0]);
    expect(teyo.counters['loyalty']).toBe(4);
  });

  it('teyo-plus-one-opponent-only — you are not a legal target of the +1', () => {
    const { ctx, teyo } = board('teyo-plus-targets');
    turnOfPlayer(ctx, 'P1');
    const option = optionFor(ctx, 'P1', teyo.id, /\+1/);
    expect(option).toBeDefined();
    const slots = (option!.targets ?? []).flatMap((slot) => [...slot.options]);
    expect(slots.sort()).toEqual(['P2', 'P3', 'P4']);
  });

  it('teyo-minus-two-direction — choosing left or right limits every player to the nearest opponent that way', () => {
    const { ctx, teyo, attackers } = board('teyo-minus');
    activate(ctx, teyo, '−2', choose('Right'));
    expect(teyo.counters['loyalty']).toBe(1);
    expect(ctx.state.attackDirections).toHaveLength(1);
    expect(offeredFor(ctx, attackers['P1']!).players).toEqual(['P4']);
    expect(offeredFor(ctx, attackers['P2']!).players).toEqual(['P1']);
    expect(offeredFor(ctx, attackers['P3']!).players).toEqual(['P2']);
    expect(offeredFor(ctx, attackers['P4']!).players).toEqual(['P3']);
  });

  it('teyo-left — left is the next player in turn order', () => {
    const { ctx, teyo, attackers } = board('teyo-left');
    activate(ctx, teyo, '−2', choose('Left'));
    expect(offeredFor(ctx, attackers['P1']!).players).toEqual(['P2']);
    expect(offeredFor(ctx, attackers['P4']!).players).toEqual(['P1']);
  });

  it('teyo-planeswalkers — only the planeswalkers of that nearest opponent can be attacked too', () => {
    const { ctx, teyo, attackers } = board('teyo-walkers');
    const nearest = spawn(ctx, 'P2', WALKER('P2 Walker'));
    spawn(ctx, 'P3', WALKER('P3 Walker'));
    spawn(ctx, 'P1', WALKER('P1 Walker'));
    activate(ctx, teyo, '−2', choose('Left'));
    expect(offeredFor(ctx, attackers['P1']!)).toEqual({
      players: ['P2'],
      planeswalkers: [nearest.id],
    });
  });

  it('teyo-until-your-next-turn — it lasts through every other player’s turn and ends as your next turn begins', () => {
    const { ctx, teyo, attackers } = board('teyo-duration');
    activate(ctx, teyo, '−2', choose('Left'));
    for (const id of ['P2', 'P3', 'P4']) {
      turnOfPlayer(ctx, id);
      ctx.state.turnNumber += 1;
      pump(runBeginningAndPrecombatMain(ctx));
      expect(ctx.state.attackDirections, `at the start of ${id}'s turn`).toHaveLength(1);
    }
    expect(offeredFor(ctx, attackers['P4']!).players).toEqual(['P1']);
    turnOfPlayer(ctx, 'P1');
    ctx.state.turnNumber += 1;
    pump(runBeginningAndPrecombatMain(ctx));
    expect(ctx.state.attackDirections).toHaveLength(0);
    expect(offeredFor(ctx, attackers['P1']!).players).toEqual(['P2', 'P3', 'P4']);
  });

  it('teyo-outlasts-teyo — the limit stays when Teyo leaves the battlefield', () => {
    const { ctx, teyo, attackers } = board('teyo-leaves');
    activate(ctx, teyo, '−2', choose('Left'));
    pump(moveObject(ctx, teyo, { zone: 'graveyard' }));
    expect(offeredFor(ctx, attackers['P1']!).players).toEqual(['P2']);
  });

  it('teyo-last-choice-wins — a newer −2 from another Teyo replaces the older one instead of adding to it', () => {
    const { ctx, teyo, attackers } = board('teyo-replace');
    const other = spawn(ctx, 'P3', card);
    activate(ctx, teyo, '−2', choose('Left'));
    expect(offeredFor(ctx, attackers['P1']!).players).toEqual(['P2']);
    ctx.state.turnNumber += 1;
    activate(ctx, other, '−2', choose('Right'));
    expect(ctx.state.attackDirections).toHaveLength(1);
    // Right, not left and right together (which would leave no legal attack).
    expect(offeredFor(ctx, attackers['P1']!).players).toEqual(['P4']);
    expect(offeredFor(ctx, attackers['P3']!).players).toEqual(['P2']);
  });

  it('teyo-with-pramikon — Pramikon and Teyo both apply, and disagreeing directions leave no legal attack', () => {
    const { ctx, teyo, attackers } = board('teyo-pramikon');
    const pramikon = spawn(ctx, 'P4', pinned('Pramikon, Sky Rampart').card);
    pramikon.chosenOption = 'left';
    activate(ctx, teyo, '−2', choose('Left'));
    expect(offeredFor(ctx, attackers['P1']!).players).toEqual(['P2']);
    pramikon.chosenOption = 'right';
    expect(offeredFor(ctx, attackers['P1']!)).toEqual({ players: [], planeswalkers: [] });
  });

  it('teyo-controller-left — once its controller has left the game the limit no longer applies', () => {
    const { ctx, teyo, attackers } = board('teyo-eliminated');
    activate(ctx, teyo, '−2', choose('Left'));
    playerById(ctx, 'P1').hasLost = true;
    expect(offeredFor(ctx, attackers['P3']!).players).toEqual(['P2', 'P4']);
  });

  it('teyo-whole-game — cast it, use the −2 to choose right, and an attack through combat may go only to the nearest opponent on that side', () => {
    const ctx = pod('teyo-chain');
    const attacker = spawn(ctx, 'P1', GRIZZLY('P1 Attacker'));
    const object = castFromHand(ctx, 'P1', card, [
      { symbol: 'W' },
      { symbol: 'C' },
      { symbol: 'C' },
    ]);
    resolveTop(ctx);
    settle(ctx);
    const teyo = ctx.state.battlefield.find((perm) => perm.cardId === object.cardId)!;
    activate(ctx, teyo, '−2', choose('Right'));
    // The attack declaration offers only P4, and a hit on P4 lands.
    attacker.tapped = false;
    const { combats } = fight(ctx, () => ({ [attacker.id]: 'P4' }));
    expect(combats).toBe(1);
    expect(playerById(ctx, 'P4').life).toBe(38);
    expect(playerById(ctx, 'P2').life).toBe(40);
  });
});

// ---------------------------------------------------------------------------------------------
// PR07.11 Triarch Stalker
// ---------------------------------------------------------------------------------------------

describe('Triarch Stalker', () => {
  const { card } = pinned('Triarch Stalker');

  /** P1 controls the Stalker; every player has a Bear. */
  function board(seed: string) {
    const ctx = pod(seed);
    const stalker = spawn(ctx, 'P1', card);
    const bears: Record<string, EnginePermanent> = {};
    for (const id of ['P1', 'P2', 'P3', 'P4']) bears[id] = spawn(ctx, id, GRIZZLY(`${id} Bear`));
    return { ctx, stalker, bears };
  }

  const hasMenace = (ctx: GameContext, perm: EnginePermanent) =>
    computeCharacteristics(ctx, perm).keywords.includes('menace');

  /** Attack as `perm`'s controller does: the player, or one of their planeswalkers. */
  function attacking(perm: EnginePermanent, player: string, walker?: EnginePermanent) {
    perm.attacking = player;
    perm.attackingPlaneswalker = walker?.id ?? null;
  }

  /** `playerId`'s beginning of combat, choosing `pick` when asked to choose an opponent. */
  function beginCombatOf(ctx: GameContext, playerId: string, pick?: string, asked: string[] = []) {
    turnOfPlayer(ctx, playerId);
    ctx.state.turnNumber += 1;
    return fight(
      ctx,
      () => ({}),
      (decision) => {
        asked.push(decision.prompt);
        const index = decision.options.findIndex((option) => option.description === pick);
        return { index: Math.max(index, 0), targets: new Map() };
      },
    );
  }

  it('triarch-stalker-pinned-oracle-supported — the authored override carries the begin-combat choice and the menace static under both ids', () => {
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toEqual({ when: 'beginningOfCombat', player: 'you' });
    expect(def.triggers[0]!.effects).toEqual([{ op: 'chooseOpponentForSource' }]);
    expect(def.staticEffects).toHaveLength(1);
    expect(def.staticEffects[0]!.op).toEqual({ layer: 6, addKeyword: 'menace' });
  });

  it('triarch-stalker-choose-opponent — at the beginning of combat on your turn you choose an opponent, stored on the Stalker', () => {
    const { ctx, stalker } = board('stalker-choose');
    const asked: string[] = [];
    expect(stalker.chosenOption).toBeUndefined();
    beginCombatOf(ctx, 'P1', 'P3', asked);
    expect(asked.filter((prompt) => /choose an opponent/.test(prompt))).toHaveLength(1);
    expect(stalker.chosenOption).toBe('P3');
  });

  it('triarch-stalker-only-your-turn — it does not trigger at the beginning of combat on another player’s turn', () => {
    const { ctx, stalker } = board('stalker-their-turn');
    beginCombatOf(ctx, 'P1', 'P3');
    const asked: string[] = [];
    beginCombatOf(ctx, 'P2', 'P4', asked);
    expect(asked.filter((prompt) => /choose an opponent/.test(prompt))).toEqual([]);
    expect(stalker.chosenOption).toBe('P3');
  });

  it('triarch-stalker-last-chosen — each new choice replaces the last, and only an opponent can be chosen', () => {
    const { ctx, stalker } = board('stalker-last');
    let offered: string[] = [];
    turnOfPlayer(ctx, 'P1');
    ctx.state.turnNumber += 1;
    fight(
      ctx,
      () => ({}),
      (decision) => {
        offered = decision.options.map((option) => option.description);
        return { index: 0, targets: new Map() };
      },
    );
    expect(offered).toEqual(['P2', 'P3', 'P4']);
    expect(stalker.chosenOption).toBe('P2');
    beginCombatOf(ctx, 'P1', 'P4');
    expect(stalker.chosenOption).toBe('P4');
  });

  it('triarch-stalker-menace — creatures of any controller attacking the chosen player have menace, and others do not', () => {
    const { ctx, stalker, bears } = board('stalker-menace');
    stalker.chosenOption = 'P3';
    attacking(bears['P1']!, 'P3');
    attacking(bears['P2']!, 'P3');
    attacking(bears['P4']!, 'P1');
    expect(hasMenace(ctx, bears['P1']!)).toBe(true);
    // Another player's creature too, and the Stalker's own controller is not special.
    expect(hasMenace(ctx, bears['P2']!)).toBe(true);
    expect(hasMenace(ctx, bears['P4']!)).toBe(false);
    // Not attacking at all.
    expect(hasMenace(ctx, bears['P3']!)).toBe(false);
  });

  it('triarch-stalker-not-planeswalkers — attacking a planeswalker of the chosen player is not attacking that player', () => {
    const { ctx, stalker, bears } = board('stalker-walker');
    stalker.chosenOption = 'P3';
    const walker = spawn(ctx, 'P3', WALKER('P3 Walker'));
    attacking(bears['P1']!, 'P3', walker);
    expect(hasMenace(ctx, bears['P1']!)).toBe(false);
  });

  it('triarch-stalker-no-choice-yet — until a player has been chosen nothing has menace', () => {
    const { ctx, bears } = board('stalker-unchosen');
    attacking(bears['P1']!, 'P2');
    expect(hasMenace(ctx, bears['P1']!)).toBe(false);
  });

  it('triarch-stalker-leaves — without the Stalker nothing has menace', () => {
    const { ctx, stalker, bears } = board('stalker-gone');
    stalker.chosenOption = 'P2';
    attacking(bears['P1']!, 'P2');
    expect(hasMenace(ctx, bears['P1']!)).toBe(true);
    ctx.state.battlefield = ctx.state.battlefield.filter((perm) => perm.id !== stalker.id);
    expect(hasMenace(ctx, bears['P1']!)).toBe(false);
  });

  it('triarch-stalker-whole-game — at the beginning of combat P2 is chosen, and its lone Bear then cannot block your attacker alone but two can', () => {
    const { ctx, bears } = board('stalker-chain');
    const second = spawn(ctx, 'P2', GRIZZLY('P2 Second Bear'));
    turnOfPlayer(ctx, 'P1');
    const alone = declaredCombat(
      ctx,
      { [bears['P1']!.id]: 'P2' },
      { [bears['P2']!.id]: bears['P1']!.id },
    );
    expect(alone.blockRejections).toContain('menace');
    expect(playerById(ctx, 'P2').life).toBe(38);
    bears['P1']!.tapped = false;
    const together = declaredCombat(
      ctx,
      { [bears['P1']!.id]: 'P2' },
      { [bears['P2']!.id]: bears['P1']!.id, [second.id]: bears['P1']!.id },
    );
    expect(together.blockRejections).toEqual([]);
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
  {
    name: 'Toby, Beastie Befriender',
    sha256: 'ab14f8f89747265e1dc7c2837a49999e1ab57539f9ff54794f332d4f8da17ab0',
    clauseCount: 2,
    authored: true,
  },
  {
    name: 'Life of the Party',
    sha256: '6244452d742f3bd5bb3fe11e45312ee784ee2f7b695ea8b0dff970658c43243c',
    clauseCount: 2,
    authored: true,
  },
  {
    name: 'Kardur, Doomscourge',
    sha256: '72604f8eb1df87c4020f3d5029549aca480358b6e0ebbb6e680f72dae76bcaa7',
    clauseCount: 2,
    authored: true,
  },
  {
    name: 'Galactus, Devourer of Worlds',
    sha256: 'd71a8ad0835e3e153d9026cce25fb4ed98e23778c66a132719b06efd69b53b42',
    clauseCount: 1,
    authored: true,
  },
  {
    name: "Silver Surfer, Galactus's Herald",
    sha256: '76cfc351217a248650d6247412f17b37a4286ee0df779aacb1d91bcdb8ac3efb',
    clauseCount: 2,
    authored: true,
  },
  {
    name: 'Taunt from the Rampart',
    sha256: '977b3aeef45a09f28bb03f55282808c78b410affaf2e864422d6d5ba1f877e73',
    clauseCount: 1,
    authored: true,
  },
  {
    name: 'Hexmark Destroyer',
    sha256: 'f588c035d61896dcd748e00c9f6ce673da4d8356f8230ec0a7e42394223a4470',
    clauseCount: 1,
    authored: true,
  },
  {
    name: 'Champion of Lambholt',
    sha256: '7ae06980c1fe8ea421f90e6a5b8485a93182c677e9ea37a94ab5511d11012f63',
    clauseCount: 1,
    authored: true,
  },
  {
    name: 'Pramikon, Sky Rampart',
    sha256: 'd702c231a2760d45148ddb29a6d6a89916d769c2b1f04d12b6e4d7e709733a9a',
    clauseCount: 2,
    authored: true,
  },
  {
    name: 'Teyo, Geometric Tactician',
    sha256: 'c6459f9ac45f2d5ad423b289921a8f98cc6ca5336aaf4fdd57ed8d564de23ade',
    clauseCount: 3,
    authored: true,
  },
  {
    name: 'Triarch Stalker',
    sha256: '7042199aac64458d8a1613d741ff94a5cb545ca6b184502770943558e69ea338',
    clauseCount: 2,
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
