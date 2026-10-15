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
import { resolveTopOfStack } from '../src/stack/stack';
import { runCombatAndExtraCombats } from '../src/turn/turn';
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
): { players: string[]; planeswalkers: string[] } {
  turnOfPlayer(ctx, playerId);
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  let offered: { players: string[]; planeswalkers: string[] } = { players: [], planeswalkers: [] };
  pump(runCombatAndExtraCombats(ctx), (decision) => {
    if (decision.presentationAttackDeclaration !== undefined) {
      const subject = decision.presentationAttackDeclaration.subjects.find(
        (candidate) => candidate.subjectId === creature.id,
      );
      offered = {
        players: subject?.defenders.map((defender) => defender.playerId) ?? [],
        planeswalkers: subject?.planeswalkers.map((walker) => walker.objectId) ?? [],
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
