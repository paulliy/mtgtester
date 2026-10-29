/**
 * ADR 0032 decision 4: every key the engine puts in `LegalAction.data` is registered in
 * `@mtg/shared`'s `ACTION_DATA_KEYS`, with the value types it carries.
 *
 * Keys are collected from two sources:
 *   - the first surfaced decision of every Card Test Lab scenario;
 *   - four fixed-seed four-bot games over generated decks from the committed coverage oracle.
 *
 * This proves coverage only of the keys those runs reach. A change that adds a `data` key
 * registers it in `packages/shared/src/action-data-keys.ts`.
 *
 * The same sweep checks the server's presentation (ADR 0032 decision 3, plan P4): every decision
 * it reaches is enriched for its deciding seat and held to the properties at the end of the file.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { HeuristicDecisionProvider } from '@mtg/bot';
import { Engine, runToCompletion } from '@mtg/engine';
import { ACTION_DATA_KEYS } from '@mtg/shared';
import type {
  ActionDataValueType,
  ActionPresentation,
  DecisionRequest,
  OracleCard,
  PlayerBoardState,
  PlayerId,
} from '@mtg/shared';
import { generateCommanderDeck } from '../decks/generate';
import { enrichPresentation } from '../match/presentation';
import { CARD_TEST_SCENARIO_IDS, createCardTestScenario } from './card-test-scenarios';
import { buildSupportedPool } from './pool';

const GAME_SEEDS = ['keys-1', 'keys-2', 'keys-3', 'keys-4'];
/** Enough turns for lands, casts, activations and combat to surface; the sweep must stay fast. */
const GAME_TURN_CAP = 8;

/** key -> value types seen -> where first seen, for failure messages. */
/** A value type outside the registry's vocabulary (a function, bigint, ...) is `other`. */
type ObservedType = ActionDataValueType | 'other';
type Observed = Map<string, Map<ObservedType, string>>;

function valueType(value: unknown): ObservedType {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'object';
  const kind = typeof value;
  return kind === 'number' || kind === 'string' || kind === 'boolean' || kind === 'object'
    ? kind
    : 'other';
}

/** What the presentation properties found across the sweep. Empty lists mean the property held. */
interface Findings {
  decisions: number;
  /** How many actions of each type were checked, so a property cannot pass by seeing none. */
  actionsByType: Map<string, number>;
  missingLabel: string[];
  entryForAbsentAction: string[];
  missingPriorityEntry: string[];
  idsOutsideProjection: string[];
}
const findings: Findings = {
  decisions: 0,
  actionsByType: new Map(),
  missingLabel: [],
  entryForAbsentAction: [],
  missingPriorityEntry: [],
  idsOutsideProjection: [],
};

/** Every object and seat id the seat's projection names. */
function projectionIds(board: PlayerBoardState): Set<string> {
  const ids = new Set<string>();
  for (const seat of board.seats) {
    ids.add(seat.seat);
    for (const card of [...(seat.hand ?? []), ...seat.graveyard]) ids.add(card.id);
    for (const commander of seat.commanders) {
      if (commander.objectId !== null) ids.add(commander.objectId);
    }
  }
  for (const permanent of board.battlefield) ids.add(permanent.id);
  for (const card of board.exile) ids.add(card.id);
  for (const object of board.stack) ids.add(object.id);
  for (const top of board.revealedLibraryTops ?? []) ids.add(top.card.id);
  return ids;
}

/** Every object or player id the entries of one decision name, with the field that names it. */
function entryIds(
  entries: Record<number, ActionPresentation> | undefined,
): Array<[string, string]> {
  const named: Array<[string, string]> = [];
  for (const presented of Object.values(entries ?? {})) {
    for (const id of presented.payment?.sourceIds ?? []) named.push([id, 'payment']);
    for (const subject of presented.subjects) {
      // A card the engine puts to its own deciding player from their library (a search, a scry)
      // is the decision's own disclosure: the projection counts a library, never lists it.
      if (subject.kind === 'card' && subject.card.zone !== 'library') {
        named.push([subject.card.objectId, `card in ${subject.card.zone}`]);
      }
      if (subject.kind === 'player') named.push([subject.playerId, 'player']);
    }
  }
  return named;
}

const LABELLED = ['castSpell', 'playLand', 'activateAbility', 'activateManaAbility'];

/** Enrich the decision as the session would for its seat and hold it to the properties. */
function checkPresentation(engine: Engine, request: DecisionRequest, source: string): void {
  const board = engine.playerState(request.decidingPlayer);
  const known = projectionIds(board);
  findings.decisions++;

  const sent = enrichPresentation(request, board);
  const entries = sent.presentation?.actions;
  for (const action of request.legalActions) {
    findings.actionsByType.set(action.type, (findings.actionsByType.get(action.type) ?? 0) + 1);
    const entry = entries?.[action.id];
    const where = `${source} (${action.type} #${action.id})`;
    if (
      LABELLED.includes(action.type) &&
      (entry?.label === undefined || entry.label.trim() === '')
    ) {
      findings.missingLabel.push(where);
    }
    if (request.decisionType === 'priority' && entry === undefined) {
      findings.missingPriorityEntry.push(where);
    }
  }

  // A yielded action is gone from the menu the session sends, so it has no entry. Take each
  // action out in turn, as smart yield does, and check the enrichment names nothing in its place.
  if (request.decisionType === 'priority') {
    for (const removed of request.legalActions) {
      if (['pass', 'passAndYieldTurn'].includes(removed.type)) continue;
      const remaining = request.legalActions.filter((action) => action.id !== removed.id);
      const filtered = enrichPresentation({ ...request, legalActions: remaining }, board);
      if (filtered.presentation?.actions?.[removed.id] !== undefined) {
        findings.entryForAbsentAction.push(`${source} (#${removed.id})`);
      }
    }
  }

  for (const [id, field] of entryIds(entries)) {
    if (!known.has(id)) {
      findings.idsOutsideProjection.push(`${source}: ${id} (${field}, ${request.decisionType})`);
    }
  }
}

function observe(
  observed: Observed,
  engine: Engine,
  request: DecisionRequest,
  source: string,
): void {
  checkPresentation(engine, request, source);
  for (const action of request.legalActions) {
    for (const [key, value] of Object.entries(action.data ?? {})) {
      // `undefined` is dropped by the JSON the AI and the browser actually receive.
      if (value === undefined) continue;
      const type = valueType(value);
      const seen = observed.get(key) ?? new Map<ObservedType, string>();
      if (!seen.has(type)) seen.set(type, `${source} (${action.type})`);
      observed.set(key, seen);
    }
  }
}

function sweepScenarios(observed: Observed): void {
  for (const id of CARD_TEST_SCENARIO_IDS) {
    const scenario = createCardTestScenario(id, 'action-data-keys');
    if (scenario === null) throw new Error(`unknown scenario ${id}`);
    for (;;) {
      const step = scenario.engine.advance();
      if (step.kind === 'continue') continue;
      if (step.kind === 'decision') observe(observed, scenario.engine, step.request, id);
      break;
    }
  }
}

function sweepGames(observed: Observed): void {
  // The committed oracle fixture, so the sweep runs without the gitignored Scryfall bulk file.
  const cards = JSON.parse(
    readFileSync(new URL('../../fixtures/coverage-oracle.json', import.meta.url), 'utf8'),
  ) as OracleCard[];
  const pool = buildSupportedPool(cards);
  for (const seed of GAME_SEEDS) {
    const decks = [1, 2, 3, 4].map((seat) =>
      generateCommanderDeck(pool, { seed: `${seed}-deck-${seat}` }),
    );
    const engine = new Engine({
      gameId: seed,
      seed,
      turnCap: GAME_TURN_CAP,
      players: decks.map((deck, i) => ({
        id: `P${i + 1}`,
        deckId: `${seed}-${i + 1}`,
        commanders: [deck.commander],
        cards: deck.cards,
      })),
    });
    const bots = new Map<string, HeuristicDecisionProvider>();
    runToCompletion(
      engine,
      (seat) => {
        let bot = bots.get(seat);
        if (bot === undefined) {
          bot = new HeuristicDecisionProvider(`${seed}-${seat}`, () =>
            engine.view(seat as PlayerId),
          );
          bots.set(seat, bot);
        }
        return bot;
      },
      { onDecision: (request) => observe(observed, engine, request, seed) },
    );
  }
}

describe('LegalAction.data key registry', () => {
  const observed: Observed = new Map();

  beforeAll(() => {
    sweepScenarios(observed);
    sweepGames(observed);
  }, 120_000);

  it('registers every emitted key', () => {
    const unregistered = [...observed]
      .filter(([key]) => !Object.hasOwn(ACTION_DATA_KEYS, key))
      .map(([key, types]) => `${key} (${[...types.values()][0]})`);
    expect(unregistered, 'add these to packages/shared/src/action-data-keys.ts').toEqual([]);
  });

  it('only emits registered value types', () => {
    const unexpected: string[] = [];
    for (const [key, types] of observed) {
      const info = ACTION_DATA_KEYS[key];
      if (info === undefined) continue;
      for (const [type, where] of types) {
        if (type === 'other' || !info.types.includes(type))
          unexpected.push(`${key}: ${type} from ${where}`);
      }
    }
    expect(unexpected, 'widen the key in packages/shared/src/action-data-keys.ts').toEqual([]);
  });

  it('emits every presentation key unless it is marked rare', () => {
    const silent = Object.entries(ACTION_DATA_KEYS)
      .filter(([, info]) => info.consumers.includes('presentation') && info.rare !== true)
      .map(([key]) => key)
      .filter((key) => !observed.has(key));
    expect(silent, 'nothing emitted these; mark them rare or remove the dead read').toEqual([]);
  });

  // The keys below are still read by the browser's deal warnings (`apps/web/src/lib/dealWarnings.ts`)
  // and not by the server's presentation. The raw-data step (plan P5) moves them.
  const READ_BY_BROWSER_UNTIL_P5 = ['subjects', 'chooseAttackers'];

  describe('server presentation over the same sweep (ADR 0032, plan P4)', () => {
    it('reached casts, activations, land plays and priority menus to check', () => {
      expect(findings.decisions).toBeGreaterThan(100);
      for (const type of ['castSpell', 'playLand', 'activateAbility', 'pass']) {
        expect(findings.actionsByType.get(type) ?? 0, type).toBeGreaterThan(0);
      }
    });

    it('gives every cast, activation, land play and mana ability a non-empty label', () => {
      expect(findings.missingLabel).toEqual([]);
    });

    it('gives every action on a priority menu an entry', () => {
      expect(findings.missingPriorityEntry).toEqual([]);
    });

    it('has no entry for an action the menu no longer holds, as after a smart yield', () => {
      expect(findings.entryForAbsentAction).toEqual([]);
    });

    it("names only objects and players in the deciding seat's own projection", () => {
      expect(findings.idsOutsideProjection).toEqual([]);
    });

    it('uses every registry key marked for presentation', () => {
      // The server module and the shared label code it calls are where `data` becomes a label.
      const shared = new URL('../../../shared/src/presentation/', import.meta.url);
      const code = [
        readFileSync(new URL('../match/presentation.ts', import.meta.url), 'utf8'),
        ...readdirSync(shared)
          .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
          .map((name) => readFileSync(new URL(name, shared), 'utf8')),
      ].join('\n');
      const unused = Object.entries(ACTION_DATA_KEYS)
        .filter(([, info]) => info.consumers.includes('presentation'))
        .map(([key]) => key)
        .filter((key) => !READ_BY_BROWSER_UNTIL_P5.includes(key))
        .filter((key) => !code.includes(`'${key}'`));
      expect(unused, 'read these in presentation.ts, or drop the presentation consumer').toEqual(
        [],
      );
    });

    it('lists the keys the browser still reads, and no others', () => {
      const web = new URL('../../../../apps/web/src/', import.meta.url);
      const reads = readFileSync(new URL('lib/dealWarnings.ts', web), 'utf8');
      for (const key of READ_BY_BROWSER_UNTIL_P5) expect(reads).toContain(`'${key}'`);
      // Every other browser source stays off `LegalAction.data`.
      const offenders: string[] = [];
      const visit = (dir: URL): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
          if (entry.isDirectory()) visit(child);
          else if (
            /\.(ts|vue)$/.test(entry.name) &&
            !entry.name.endsWith('.test.ts') &&
            entry.name !== 'dealWarnings.ts' &&
            /\.data\?\.\[|action\.data\b/.test(readFileSync(child, 'utf8'))
          ) {
            offenders.push(child.pathname);
          }
        }
      };
      visit(web);
      expect(offenders).toEqual([]);
    });
  });
});
