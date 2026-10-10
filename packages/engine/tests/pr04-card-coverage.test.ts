/**
 * PR04 card coverage: counters and turn history (docs/plans/card-coverage-chunks.md).
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
import { resolveTopOfStack } from '../src/stack/stack';
import { runTurn } from '../src/turn/turn';
import { createGame } from '../src/state/game';
import { moveObject, playerById } from '../src/state/objects';
import { effectivePT } from '../src/state/queries';
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

const PINNED_FILES = ['fixtures/marchesa-batch1-oracle.json'];
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

/** Run a whole turn for the current turn player with nobody attacking or blocking. */
function quietTurn(ctx: GameContext) {
  return pump(runTurn(ctx), (decision) => {
    if (decision.presentationAttackDeclaration !== undefined)
      return declareAttacks(decision, () => null);
    if (decision.presentationBlockDeclaration !== undefined)
      return declareBlocks(decision, () => null);
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    return { index: Math.max(pass, 0), targets: new Map() };
  });
}

/** Move a card from `zone` onto the battlefield through the normal zone change. */
function enterFrom(
  ctx: GameContext,
  controllerId: string,
  card: OracleCard,
  zone: 'hand' | 'graveyard' | 'exile' | 'library',
): EnginePermanent {
  const object = conjure(ctx, controllerId, card, zone);
  pump(moveObject(ctx, object, { zone: 'battlefield', controllerId }));
  return ctx.state.battlefield.find((perm) => perm.cardId === object.cardId)!;
}

const generic = (n: number) => Array.from({ length: n }, () => ({ symbol: 'C' as const }));
const black = (n: number) => Array.from({ length: n }, () => ({ symbol: 'B' as const }));

/**
 * `playerId` casts `card` from hand through the normal legality/payment path with `mana`, filling
 * target slots from `targets`. The spell is left on the stack, with its cast triggers pending.
 */
function castFromHand(
  ctx: GameContext,
  playerId: string,
  card: OracleCard,
  mana: { symbol: 'C' | 'W' | 'U' | 'B' | 'R' | 'G' }[],
  targets: ReadonlyMap<number, string> = new Map(),
) {
  const object = conjure(ctx, playerId, card, 'hand');
  addMana(playerById(ctx, playerId), mana);
  const option = optionFor(ctx, playerId, object.id);
  expect(option, `${playerId} casts ${card.name}`).toBeDefined();
  takeAction(ctx, playerId, option!.payload as PriorityActionPayload, undefined, targets);
  return object;
}

/** Put `perm` into its owner's graveyard through the normal single-permanent zone change. */
function kill(ctx: GameContext, perm: EnginePermanent) {
  return pump(moveObject(ctx, perm, { zone: 'graveyard' }));
}

/** The permanent on the battlefield that is this card now, if any. */
function onField(ctx: GameContext, cardId: string) {
  return ctx.state.battlefield.find((perm) => perm.cardId === cardId);
}

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

// ---------------------------------------------------------------------------------------------
// PR04.02 Sautekh Immortal
// ---------------------------------------------------------------------------------------------

describe('Sautekh Immortal', () => {
  const { card } = pinned('Sautekh Immortal');
  const VICTIM = LAB_CARD('Lab Victim');

  /** Put `count` creatures into graveyards from the battlefield this turn, alternating owners. */
  function killCreatures(ctx: GameContext, count: number, opts: { token?: boolean } = {}) {
    for (let i = 0; i < count; i++) {
      const victim = spawn(ctx, i % 2 === 0 ? 'P1' : 'P2', VICTIM, {
        isToken: opts.token === true,
      });
      kill(ctx, victim);
    }
  }

  it('sautekh-immortal-pinned-oracle-supported — the interpreter alone models flash and the enters-with replacement', () => {
    expectNoRegistration(card);
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.keywords).toContain('flash');
    expect(def.entersWithCounters).toEqual({ '+1/+1': { kind: 'creaturesDiedThisTurn' } });
    // A replacement effect (CR 614.1c), never an enters trigger.
    expect(def.triggers).toEqual([]);
  });

  it('sautekh-immortal-counts-every-death — cast with flash after three creatures died, it enters with three counters', () => {
    const ctx = pod('sautekh-three');
    killCreatures(ctx, 2);
    killCreatures(ctx, 1, { token: true });
    expect(ctx.state.creaturesDiedThisTurn).toBe(3);
    // Flash: cast on an opponent's turn.
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    const object = castFromHand(ctx, 'P1', card, [...generic(2), ...black(1)]);
    resolveTop(ctx);
    const sautekh = onField(ctx, object.cardId)!;
    expect(sautekh.counters['+1/+1']).toBe(3);
    expect(effectivePT(ctx, sautekh)).toEqual({ power: 5, toughness: 5 });
    // Nothing waits to trigger: the counters were there as it entered.
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    expect(ctx.state.stack).toHaveLength(0);
  });

  it('sautekh-immortal-no-deaths — with no creature dead this turn it enters with no counters', () => {
    const ctx = pod('sautekh-none');
    const object = castFromHand(ctx, 'P1', card, [...generic(2), ...black(1)]);
    resolveTop(ctx);
    const sautekh = onField(ctx, object.cardId)!;
    expect(sautekh.counters['+1/+1'] ?? 0).toBe(0);
    expect(effectivePT(ctx, sautekh)).toEqual({ power: 2, toughness: 2 });
  });

  it('sautekh-immortal-counts-as-it-enters — a creature dying while the spell is on the stack is counted', () => {
    const ctx = pod('sautekh-stack');
    killCreatures(ctx, 1);
    const object = castFromHand(ctx, 'P1', card, [...generic(2), ...black(1)]);
    killCreatures(ctx, 1);
    resolveTop(ctx);
    expect(onField(ctx, object.cardId)!.counters['+1/+1']).toBe(2);
  });

  it('sautekh-immortal-any-entry — put onto the battlefield from a graveyard it still enters with the counters', () => {
    const ctx = pod('sautekh-reanimate');
    killCreatures(ctx, 2);
    const sautekh = enterFrom(ctx, 'P1', card, 'graveyard');
    expect(sautekh.counters['+1/+1']).toBe(2);
  });

  it('sautekh-immortal-this-turn-only — deaths from an earlier turn are not counted', () => {
    const ctx = pod('sautekh-next-turn');
    killCreatures(ctx, 2);
    expect(ctx.state.creaturesDiedThisTurn).toBe(2);
    // The game loop hands the turn to P2; that real turn starts the count over.
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    quietTurn(ctx);
    expect(ctx.state.creaturesDiedThisTurn).toBe(0);
    const object = castFromHand(ctx, 'P1', card, [...generic(2), ...black(1)]);
    resolveTop(ctx);
    expect(onField(ctx, object.cardId)!.counters['+1/+1'] ?? 0).toBe(0);
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
    name: 'Sautekh Immortal',
    sha256: '26aff26dc163a5d13ad98195d74dcfd5d2260ab0cfad68928b3ac90c457ec21a',
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

describe('PR04 restoration gate', () => {
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
      (entry) => entry.restoredIn === 'coverage-pr04',
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
