/**
 * PR03 card coverage: zone-change history, last-known information, death and return
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
import type { AuthoringIssue } from '../src/cards/authoring-validation';
import { interpretCard } from '../src/cards/interpret';
import { validateTriggerHead } from '../src/cards/trigger-contracts';
import type { TokenSpec } from '../src/cards/ability';
import { fixtureOracleId, getOverride } from '../src/cards/overrides';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { addMana } from '../src/mana/pool';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { createGame } from '../src/state/game';
import { createToken, moveObject, playerById } from '../src/state/objects';
import type { EnginePermanent, GameContext } from '../src/state/types';
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

const BEAR_TOKEN: TokenSpec = {
  name: 'Bear',
  typeLine: 'Token Creature — Bear',
  types: ['Creature'],
  subtypes: ['Bear'],
  colors: ['G'],
  power: 2,
  toughness: 2,
};

const LAB_CARD = (name: string) => oracle({ name, typeLine: 'Creature — Secret' });

// ---------------------------------------------------------------------------------------------
// Primitive: the zone a permanent entered from (CR 603.6a)
// ---------------------------------------------------------------------------------------------

describe('Primitive: enters-from-a-graveyard trigger head', () => {
  const watcher = oracle({
    name: 'Lab Grave Watcher',
    typeLine: 'Creature — Spirit',
    oracleText: 'Whenever another creature enters from your graveyard, draw a card.',
  });
  const bear = oracle({ name: 'Lab Bear', typeLine: 'Creature — Bear' });

  it('enters-from-origin-primitive-your-graveyard — only a card from its controller’s own graveyard matches', () => {
    const ctx = pod('origin-yours');
    spawn(ctx, 'P1', watcher);
    enterFrom(ctx, 'P1', bear, 'graveyard');
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.sourceName)).toEqual([
      'Lab Grave Watcher',
    ]);
    ctx.state.pendingTriggers = [];
    // Stolen from an opponent's graveyard: it entered from a graveyard, but not from yours.
    const stolen = conjure(ctx, 'P2', bear, 'graveyard');
    pump(moveObject(ctx, stolen, { zone: 'battlefield', controllerId: 'P1' }));
    expect(ctx.state.pendingTriggers).toEqual([]);
    enterFrom(ctx, 'P1', bear, 'exile');
    expect(ctx.state.pendingTriggers).toEqual([]);
  });

  it('enters-from-origin-primitive-tokens-and-copies — a created token entered from no zone', () => {
    const ctx = pod('origin-token');
    spawn(ctx, 'P1', watcher);
    const token = createToken(ctx, BEAR_TOKEN, 'P1');
    expect(token.enteredFromZone).toBeUndefined();
    expect(ctx.state.pendingTriggers).toEqual([]);
  });

  it('enters-from-origin-primitive-contract — the restriction is valid only on an enters head', () => {
    const issues: AuthoringIssue[] = [];
    validateTriggerHead(
      { when: 'dies', subject: { kind: 'self' }, entersFrom: { zone: 'graveyard' } },
      'trigger',
      issues,
    );
    validateTriggerHead(
      { when: 'enters', subject: { kind: 'self' }, entersFrom: { zone: 'exile' } },
      'trigger',
      issues,
    );
    expect(issues.map((issue) => issue.path)).toEqual(['trigger.entersFrom', 'trigger.entersFrom']);
    const ok: AuthoringIssue[] = [];
    validateTriggerHead(
      {
        when: 'enters',
        subject: { kind: 'self' },
        entersFrom: { zone: 'graveyard', graveyardOwner: 'you' },
      },
      'trigger',
      ok,
    );
    expect(ok).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 3.11 Triarch Praetorian
// ---------------------------------------------------------------------------------------------

describe('Triarch Praetorian', () => {
  const praetorian = pinned('Triarch Praetorian');

  /** P1's library holds three named cards so draws are visible. */
  function ready(seed: string) {
    const ctx = pod(seed);
    const p1 = playerById(ctx, 'P1');
    for (const name of ['Page Three', 'Page Two', 'Page One'])
      conjure(ctx, 'P1', LAB_CARD(name), 'library');
    return { ctx, p1 };
  }

  it('triarch-praetorian-pinned-oracle-supported — the interpreter alone models flying, the origin trigger and unearth', () => {
    expect(praetorian.sha256).toBe(
      '19702457c7e73d501b2509808cee1350b8f3944fc392e738b8f0080924578c9d',
    );
    expectNoRegistration(praetorian.card);
    expectModeled(praetorian.card);
    const def = interpretCard(praetorian.card);
    expect(def.keywords).toEqual(['flying']);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toEqual({
      when: 'enters',
      subject: { kind: 'self' },
      entersFrom: { zone: 'graveyard' },
    });
    expect(def.activatedAbilities.map((entry) => entry.zone)).toEqual(['graveyard']);
  });

  it('triarch-praetorian-unearth-draws-two — unearthed from the graveyard, it draws two and loses 2 life', () => {
    const { ctx, p1 } = ready('praetorian-unearth');
    const card = conjure(ctx, 'P1', praetorian.card, 'graveyard');
    addMana(p1, [...generic(4), ...black(1)]);
    const option = optionFor(ctx, 'P1', card.id, /Unearth/);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    // Unearth is an activated ability: the card stays in the graveyard until it resolves.
    expect(ctx.state.stack).toHaveLength(1);
    expect(p1.manaEntries).toEqual([]);
    resolveTop(ctx);
    expect(p1.graveyard).toEqual([]);
    const perm = ctx.state.battlefield.find((candidate) => candidate.cardId === card.cardId)!;
    expect(perm.enteredFromZone).toBe('graveyard');
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.sourceName)).toEqual([
      'Triarch Praetorian',
    ]);
    settle(ctx);
    expect(p1.hand.map((drawn) => drawn.name)).toEqual(['Page One', 'Page Two']);
    expect(p1.life).toBe(38);
  });

  it('triarch-praetorian-unearth-needs-mana-and-sorcery-timing — {4} or an opponent’s turn offers no unearth', () => {
    const short = ready('praetorian-unearth-short');
    const card = conjure(short.ctx, 'P1', praetorian.card, 'graveyard');
    addMana(short.p1, generic(4));
    expect(optionFor(short.ctx, 'P1', card.id, /Unearth/)).toBeUndefined();
    const offTurn = ready('praetorian-unearth-off-turn');
    const other = conjure(offTurn.ctx, 'P1', praetorian.card, 'graveyard');
    addMana(offTurn.p1, [...generic(4), ...black(1)]);
    offTurn.ctx.state.currentTurnPlayer = 'P2';
    offTurn.ctx.state.activePlayerIndex = 1;
    expect(optionFor(offTurn.ctx, 'P1', other.id, /Unearth/)).toBeUndefined();
  });

  it('triarch-praetorian-cast-from-hand-no-trigger — cast from hand it enters from the stack and draws nothing', () => {
    const { ctx, p1 } = ready('praetorian-cast');
    const card = conjure(ctx, 'P1', praetorian.card, 'hand');
    addMana(p1, [...generic(1), ...black(1)]);
    const option = optionFor(ctx, 'P1', card.id);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    resolveTop(ctx);
    const perm = ctx.state.battlefield.find((candidate) => candidate.cardId === card.cardId)!;
    expect(perm.enteredFromZone).toBe('stack');
    expect(ctx.state.pendingTriggers).toEqual([]);
    settle(ctx);
    expect(p1.hand).toEqual([]);
    expect(p1.life).toBe(40);
  });

  it('triarch-praetorian-other-origins-no-trigger — entering from exile, hand or library does not trigger', () => {
    for (const zone of ['exile', 'hand', 'library'] as const) {
      const { ctx } = ready(`praetorian-${zone}`);
      enterFrom(ctx, 'P1', praetorian.card, zone);
      expect(ctx.state.pendingTriggers, zone).toEqual([]);
    }
  });

  it('triarch-praetorian-reanimated-triggers — any effect returning it from a graveyard triggers, under its new controller', () => {
    const { ctx } = ready('praetorian-reanimated');
    const perm = enterFrom(ctx, 'P2', praetorian.card, 'graveyard');
    expect(perm.controllerId).toBe('P2');
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.controllerId)).toEqual(['P2']);
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

/** Cards restored in PR03. A card enters this table in the same commit that restores it. */
const RESTORED: RestoredCard[] = [
  {
    name: 'Triarch Praetorian',
    sha256: '19702457c7e73d501b2509808cee1350b8f3944fc392e738b8f0080924578c9d',
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

describe('PR03 restoration gate', () => {
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
      (entry) => entry.restoredIn === 'coverage-pr03',
    );
    expect(ours.length).toBeGreaterThan(0);
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
