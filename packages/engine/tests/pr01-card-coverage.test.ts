/**
 * PR01 card coverage: targeting, optional choices, and resolution fidelity
 * (docs/plans/card-coverage-chunks.md).
 *
 * Each restored card has a `describe` block whose test names start with the engine test IDs the
 * verification manifest declares for it. The gate at the bottom ties the two together: every
 * restored card must be pinned, modeled under both its real Oracle ID and its fixture alias,
 * declared `implemented-reviewed` in the manifest, and mapped to engine tests in this file and to
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
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { buildPlayerView } from '../src/view/view';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

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

function optionMatching(decision: PendingDecision, pattern: RegExp): DecisionOutcome {
  const index = decision.options.findIndex((option) => pattern.test(option.description));
  if (index < 0) {
    throw new Error(
      `no option matching ${String(pattern)} in: ${decision.options.map((o) => o.description).join(' | ')}`,
    );
  }
  return { index, targets: new Map() };
}

/** Answer each decision whose prompt matches with the option matching the paired pattern. */
function answers(rules: [prompt: RegExp, option: RegExp][]): Answer {
  return (decision) => {
    for (const [prompt, option] of rules) {
      if (prompt.test(decision.prompt)) return optionMatching(decision, option);
    }
    return { index: 0, targets: new Map() };
  };
}

function priorityOptions(ctx: GameContext, playerId: string) {
  return computePriorityOptions(ctx, playerById(ctx, playerId));
}

function activationOf(ctx: GameContext, playerId: string, source: EnginePermanent) {
  return priorityOptions(ctx, playerId).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'activateAbility' && payload.objectId === source.id;
  });
}

/** Take a priority action through the normal legality/payment path and leave it on the stack. */
function takeAction(
  ctx: GameContext,
  playerId: string,
  payload: PriorityActionPayload,
  answer?: Answer,
) {
  return pump(
    applyPriorityAction(ctx, playerById(ctx, playerId), payload, {
      index: 0,
      targets: new Map(),
    }),
    answer,
  );
}

function resolveTop(ctx: GameContext, answer?: Answer) {
  return pump(resolveTopOfStack(ctx), answer);
}

const SECRET = (name: string) => oracle({ name, typeLine: 'Creature — Secret' });

// ---------------------------------------------------------------------------------------------
// 1.01 Forum of Amity
// ---------------------------------------------------------------------------------------------

describe('Forum of Amity', () => {
  const forum = pinned('Forum of Amity');

  function readyForum(seed: string) {
    const ctx = pod(seed);
    const land = spawn(ctx, 'P1', forum.card);
    addMana(playerById(ctx, 'P1'), [
      { symbol: 'W' },
      { symbol: 'B' },
      { symbol: 'C' },
      { symbol: 'C' },
    ]);
    return { ctx, land };
  }

  it('forum-of-amity-pinned-oracle-supported — pins the exact Oracle and both supported ids', () => {
    expect(forum.sha256).toBe('b49800b6e3d748f53ad05c73cbf239e4c57e16fac1e8288c5fdf8d1f36b384ee');
    expect(forum.card.oracleText).toBe(
      'This land enters tapped.\n{T}: Add {W} or {B}.\n{2}{W}{B}, {T}: Surveil 1. (Look at the top card of your library. You may put it into your graveyard.)',
    );
    const def = interpretCard(forum.card);
    expect(def.modeled).toBe(true);
    expect(def.unmodeledReasons).toEqual([]);
    expect(def.entersTapped).toBe(true);
    expect(def.manaAbilities).toEqual([{ units: [['W', 'B']] }]);
    expect(def.activatedAbilities).toHaveLength(1);
    expect(def.activatedAbilities[0]!.ability.effects).toEqual([{ op: 'surveil', count: 1 }]);
    expect(getOverride(forum.card.oracleId)).toBeUndefined();
    expect(
      interpretCard({ ...forum.card, oracleId: fixtureOracleId(forum.card.name) }).modeled,
    ).toBe(true);
  });

  it('forum-of-amity-enters-tapped — a normal land play puts it onto the battlefield tapped', () => {
    const ctx = pod('forum-land-play');
    const inHand = conjure(ctx, 'P1', forum.card, 'hand');
    const play = priorityOptions(ctx, 'P1').find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'playLand' && payload.objectId === inHand.id;
    });
    expect(play).toBeDefined();
    takeAction(ctx, 'P1', play!.payload as PriorityActionPayload);
    const entered = ctx.state.battlefield.find((entry) => entry.cardId === inHand.cardId);
    expect(entered?.tapped).toBe(true);
  });

  it('forum-of-amity-surveil-to-graveyard — normal activation surveils the top card into the graveyard', () => {
    const { ctx, land } = readyForum('forum-surveil-graveyard');
    const top = conjure(ctx, 'P1', SECRET('Forum Top Card'), 'library');
    const activation = activationOf(ctx, 'P1', land);
    expect(activation).toBeDefined();
    takeAction(ctx, 'P1', activation!.payload as PriorityActionPayload);
    expect(land.tapped).toBe(true);
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
    expect(ctx.state.stack).toHaveLength(1);

    resolveTop(ctx, answers([[/surveil/, /Put Forum Top Card into your graveyard/]]));

    const p1 = playerById(ctx, 'P1');
    expect(p1.graveyard.map((card) => card.cardId)).toContain(top.cardId);
    expect(p1.library.some((card) => card.cardId === top.cardId)).toBe(false);
    expect(ctx.state.eventLog.some((event) => event.type === 'surveil')).toBe(true);
  });

  it('forum-of-amity-surveil-keep-on-top — keeping the card leaves the library order unchanged', () => {
    const { ctx, land } = readyForum('forum-surveil-keep');
    const top = conjure(ctx, 'P1', SECRET('Forum Kept Card'), 'library');
    const before = playerById(ctx, 'P1').library.map((card) => card.cardId);
    takeAction(ctx, 'P1', activationOf(ctx, 'P1', land)!.payload as PriorityActionPayload);

    const { decisions } = resolveTop(ctx, answers([[/surveil/, /Keep Forum Kept Card on top/]]));

    expect(decisions.filter((decision) => /surveil/.test(decision.prompt))).toHaveLength(1);
    expect(playerById(ctx, 'P1').library[0]?.cardId).toBe(top.cardId);
    expect(playerById(ctx, 'P1').library.map((card) => card.cardId)).toEqual(before);
  });

  it('forum-of-amity-activation-costs — needs {2}{W}{B} and an untapped Forum', () => {
    const ctx = pod('forum-costs');
    const land = spawn(ctx, 'P1', forum.card);
    addMana(playerById(ctx, 'P1'), [{ symbol: 'W' }, { symbol: 'C' }, { symbol: 'C' }]);
    expect(activationOf(ctx, 'P1', land)).toBeUndefined();

    const tapped = readyForum('forum-tapped');
    tapped.land.tapped = true;
    expect(activationOf(tapped.ctx, 'P1', tapped.land)).toBeUndefined();
    expect(activationOf(tapped.ctx, 'P2', tapped.land)).toBeUndefined();
  });

  it('forum-of-amity-surveil-privacy — opponents never see the surveilled card kept on top', () => {
    const { ctx, land } = readyForum('forum-privacy');
    conjure(ctx, 'P1', SECRET('Forum Private Secret'), 'library');
    takeAction(ctx, 'P1', activationOf(ctx, 'P1', land)!.payload as PriorityActionPayload);
    resolveTop(ctx, answers([[/surveil/, /Keep Forum Private Secret on top/]]));
    expect(JSON.stringify(buildPlayerView(ctx, 'P2'))).not.toContain('Forum Private Secret');
  });

  it('forum-of-amity-empty-library — surveil with no library asks nothing and changes nothing', () => {
    const { ctx, land } = readyForum('forum-empty-library');
    playerById(ctx, 'P1').library = [];
    takeAction(ctx, 'P1', activationOf(ctx, 'P1', land)!.payload as PriorityActionPayload);
    const { decisions } = resolveTop(ctx);
    expect(decisions.filter((decision) => /surveil/.test(decision.prompt))).toEqual([]);
    expect(playerById(ctx, 'P1').graveyard).toEqual([]);
    expect(ctx.state.stack).toHaveLength(0);
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

/** Cards restored in PR01. A card enters this table in the same commit that restores it. */
const RESTORED: RestoredCard[] = [
  {
    name: 'Forum of Amity',
    sha256: 'b49800b6e3d748f53ad05c73cbf239e4c57e16fac1e8288c5fdf8d1f36b384ee',
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

describe('PR01 restoration gate', () => {
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
      for (const candidate of [entry.card, { ...entry.card, oracleId: fixtureOracleId(name) }]) {
        const def = interpretCard(candidate);
        expect(def.unmodeledReasons, `${name} (${candidate.oracleId})`).toEqual([]);
        expect(def.modeled, `${name} (${candidate.oracleId})`).toBe(true);
      }
    },
  );

  it('leaves no registration behind for cards the audit records as interpreter-restored', () => {
    const audit = JSON.parse(repoFile('docs/plans/card-catalog-audit.json')) as {
      interpreterRestored?: { oracleId: string; name: string; restoredIn: string }[];
    };
    const ours = (audit.interpreterRestored ?? []).filter(
      (entry) => entry.restoredIn === 'coverage-pr01',
    );
    for (const entry of ours) {
      expect(
        RESTORED.map((card) => card.name),
        entry.name,
      ).toContain(entry.name);
      expect(getOverride(entry.oracleId), entry.name).toBeUndefined();
      expect(getOverride(fixtureOracleId(entry.name)), `${entry.name} alias`).toBeUndefined();
      expect(interpretCard(pinned(entry.name).card).modeled, entry.name).toBe(true);
    }
  });

  it.each(RESTORED.map((card) => [card.name, card] as const))(
    '%s declares implemented-reviewed clauses mapped to engine and viewer evidence',
    (name, expected) => {
      const entry = pinned(name);
      const declared = manifest.cards[entry.card.oracleId];
      expect(declared?.name).toBe(name);
      expect(declared?.oracleSha256).toBe(expected.sha256);
      expect(declared?.implementationStatus).toBe('implemented-reviewed');
      expect(declared?.clauses).toHaveLength(expected.clauseCount);
      for (const clause of declared!.clauses) {
        expect(clause.id, `${name} clause id`).toBeTruthy();
        expect(entry.card.oracleText, `${name} clause text`).toContain(clause.oracleText);
        expect(clause.implementation, `${name} implementation`).not.toHaveLength(0);
        expect(clause.engineTestIds, `${name} engine tests`).not.toHaveLength(0);
        expect(clause.viewerScenarioIds, `${name} viewer scenarios`).not.toHaveLength(0);
        for (const id of clause.engineTestIds) expect(engineSource, id).toContain(`'${id} —`);
        for (const id of clause.viewerScenarioIds) expect(viewerSource, id).toContain(id);
      }
    },
  );
});
