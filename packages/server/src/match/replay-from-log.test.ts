/**
 * Replay from the stored log (ADR 0031 decision 8): a game is reproducible from its stored config
 * and recorded inputs, on the same build and the same card data.
 *
 * The harness rebuilds an engine from `games.config_json` and the stored deck snapshots, feeds it
 * each `decision` event's `submittedResponse` in order, applies out-of-band inputs at the sequence
 * they were recorded at, and compares the final state hash with the game it replays. It exists
 * only in tests. It fails loudly on anything it cannot explain: a request id or sequence that
 * differs, a log that outruns the engine, card data that is not the card data the game saw.
 *
 * Out-of-band inputs are applied by `applyOutOfBandEvent` below: a recorded `yieldCancelled` is
 * the same `Engine.cancelYield` call the live game made, and a recorded `conceded` the same
 * `Engine.concede` (M4).
 */

import { describe, expect, it } from 'vitest';
import { Engine, RandomDecisionProvider, type EnginePlayerConfig } from '@mtg/engine';
import type {
  DecisionResponse,
  GameEvent,
  OracleCard,
  PlayerId,
  ServerToClientMessage,
} from '@mtg/shared';
import { replayHash } from '../benchmark/replay';
import type { GameStore } from '../db';
import { GameRecorder, type GameReplayConfig, type SqliteLike } from '../db/games';
import type { ClockTimers } from './decision-clock';
import { tablePolicy, testerPolicy } from './disclosure';
import { MatchSession } from './session';
import type { SeatSetup } from './setup';
import { provisionalGameConfig, type ProvisionalCatalog } from '../cards/provisional';

// ── The harness ─────────────────────────────────────────────────────────────────────────────

export class ReplayRefusedError extends Error {
  constructor(message: string) {
    super(`replay refused: ${message}`);
    this.name = 'ReplayRefusedError';
  }
}

export class ReplayMismatchError extends Error {
  constructor(message: string) {
    super(`replay mismatch: ${message}`);
    this.name = 'ReplayMismatchError';
  }
}

/** A deck as the engine was given it: what a snapshot id resolves to. */
export interface ResolvedDeck {
  deckId: string;
  commanders: OracleCard[];
  cards: OracleCard[];
  companion?: OracleCard | null;
}

export interface ReplayInput {
  gameId: string;
  /** `games.seed`. */
  seed: string;
  /** `games.config_json`. */
  config: GameReplayConfig;
  /**
   * Resolve a stored deck snapshot to the list the engine was given, in the order it was given:
   * the seeded shuffle starts from that order, so a re-sorted list replays a different game.
   */
  resolveDeck: (snapshotId: string) => ResolvedDeck;
  /** `game_events` in sequence order. */
  events: readonly GameEvent[];
  /** The sha256 of the card data this process has loaded. */
  currentCardDataSha256: string | null;
  /** The provisional catalog this process loaded (H1), when it opted in. */
  provisional?: ProvisionalCatalog;
}

export interface ReplayResult {
  engine: Engine;
  /** How many recorded decisions were fed in. */
  decisions: number;
  /** Out-of-band events applied. */
  outOfBand: number;
  hash: string;
}

/** Event types that are inputs from outside the decision loop, applied at their sequence. */
const OUT_OF_BAND_TYPES: ReadonlySet<string> = new Set(['yieldCancelled', 'conceded']);

/**
 * The state hash replay compares: the whole state but the two fields that depend on when the
 * server drained its board snapshots rather than on the game.
 */
export function replayStateHash(engine: Engine): string {
  const semantic = Object.fromEntries(
    Object.entries(engine.getState()).filter(
      ([key]) => key !== 'sequenceSnapshots' && key !== 'pendingSnapshotSequence',
    ),
  );
  return replayHash(semantic);
}

function nextSequenceOf(engine: Engine): number {
  return (engine.getState().eventLog.at(-1)?.sequence ?? 0) + 1;
}

/**
 * MAIN THREAD: apply one recorded out-of-band input to the engine.
 *
 * Called when the engine's next event sequence equals `event.sequence`, after both `advance()`
 * and `submit()`. For `yieldCancelled` this is `engine.cancelYield(event.payload.player)`, which
 * must emit the event at exactly that sequence (the harness checks). For `conceded` it is
 * `engine.concede(players, reason)`, applied where the live runner applied it: at a decision the
 * engine was waiting on. Anything else is refused rather than skipped, since skipping an input
 * replays a different game.
 */
export function applyOutOfBandEvent(engine: Engine, event: GameEvent): void {
  switch (event.type) {
    case 'yieldCancelled': {
      const player = event.payload['player'];
      if (typeof player !== 'string')
        throw new ReplayMismatchError(
          `'yieldCancelled' at sequence ${event.sequence} names no player`,
        );
      // The live call changed state, which is the only time it emits; replay must too.
      if (!engine.cancelYield(player))
        throw new ReplayMismatchError(
          `${player} was not yielding when 'yieldCancelled' was recorded at sequence ${event.sequence}`,
        );
      return;
    }
    case 'conceded': {
      const players = event.payload['players'];
      const reason = event.payload['reason'];
      if (
        !Array.isArray(players) ||
        !players.every((player) => typeof player === 'string') ||
        (reason !== 'timeLimit' && reason !== 'allAway')
      ) {
        throw new ReplayMismatchError(`'conceded' at sequence ${event.sequence} is malformed`);
      }
      if (!engine.concede(players as string[], reason)) {
        throw new ReplayMismatchError(
          `the game was already over when 'conceded' was recorded at sequence ${event.sequence}`,
        );
      }
      return;
    }
    default:
      throw new ReplayRefusedError(
        `the log holds a '${event.type}' event at sequence ${event.sequence}, which replay does not know`,
      );
  }
}

export function replayFromLog(input: ReplayInput): ReplayResult {
  const { config } = input;
  if (config.schemaVersion !== 1) {
    throw new ReplayRefusedError(`unknown config schema version ${String(config.schemaVersion)}`);
  }
  // The Oracle data is not in git and `card_cache` is overwritten by re-imports, so the hash is
  // the only thing standing between a replay and a silently different game.
  if (config.cardDataSha256 === null || input.currentCardDataSha256 === null) {
    throw new ReplayRefusedError(
      'the card data hash is unknown, so the card data cannot be checked',
    );
  }
  if (config.cardDataSha256 !== input.currentCardDataSha256) {
    throw new ReplayRefusedError(
      `the card data differs (stored ${config.cardDataSha256}, current ${input.currentCardDataSha256})`,
    );
  }
  if (config.rng.kind === 'chacha20' && !/^[0-9a-f]{64}$/.test(config.rng.key)) {
    throw new ReplayRefusedError('the chacha20 key is missing or malformed');
  }

  // A game that played provisional cards (H1) replays only on the exact patch bytes it pinned.
  for (const pin of config.provisional ?? []) {
    const admitted = input.provisional?.admitted.find((a) => a.oracleId === pin.oracleId);
    if (admitted === undefined)
      throw new ReplayRefusedError(`provisional card ${pin.oracleId} is not loaded`);
    if (admitted.patchSha256 !== pin.patchSha256 || admitted.source !== pin.source)
      throw new ReplayRefusedError(
        `provisional card ${pin.oracleId} differs (stored ${pin.source} ${pin.patchSha256}, current ${admitted.source} ${admitted.patchSha256})`,
      );
  }
  const players: EnginePlayerConfig[] = config.seats.map((seat) => {
    const deck = input.resolveDeck(seat.deckSnapshotId);
    return {
      id: seat.seat,
      deckId: deck.deckId,
      commanders: deck.commanders,
      cards: deck.cards,
      ...(deck.companion !== undefined ? { companion: deck.companion } : {}),
      ...(seat.manualMana ? { manualMana: true } : {}),
    };
  });
  const pinned = new Set((config.provisional ?? []).map((pin) => pin.oracleId));
  const provisional = provisionalGameConfig(input.provisional, players);
  const engine = new Engine(
    {
      gameId: input.gameId,
      seed: input.seed,
      ...(config.rng.kind === 'chacha20' && { rng: 'chacha20' as const, rngKey: config.rng.key }),
      turnCap: config.turnCap,
      // Only the pinned cards: a card admitted since the game was played must not change it.
      ...(pinned.size > 0 && {
        allowProvisional: true,
        provisionalDefinitions: (provisional.provisionalDefinitions ?? []).filter((def) =>
          pinned.has(def.oracleId),
        ),
      }),
      players,
    },
    {
      ...(config.engineOptions.maxStepWork !== undefined && {
        maxStepWork: config.engineOptions.maxStepWork,
      }),
      ...(config.engineOptions.maxObjects !== undefined && {
        maxObjects: config.engineOptions.maxObjects,
      }),
    },
  );

  const decisions = input.events.filter((event) => event.type === 'decision');
  const outOfBand = input.events.filter((event) => OUT_OF_BAND_TYPES.has(event.type));
  let nextDecision = 0;
  let nextOutOfBand = 0;
  let applied = 0;

  /** Apply every out-of-band input recorded at the engine's next sequence. */
  const applyDue = (where: string): void => {
    for (;;) {
      const event = outOfBand[nextOutOfBand];
      if (event === undefined) return;
      const next = nextSequenceOf(engine);
      if (event.sequence > next) return;
      if (event.sequence < next) {
        throw new ReplayMismatchError(
          `'${event.type}' was recorded at sequence ${event.sequence} but the engine is already ` +
            `at ${next} ${where}`,
        );
      }
      applyOutOfBandEvent(engine, event);
      nextOutOfBand += 1;
      applied += 1;
      const emitted = engine.getState().eventLog.find((e) => e.sequence === event.sequence);
      if (emitted?.sequence !== event.sequence || emitted.type !== event.type) {
        throw new ReplayMismatchError(
          `applying '${event.type}' at sequence ${event.sequence} emitted ` +
            `'${emitted?.type}' at ${emitted?.sequence}`,
        );
      }
    }
  };

  for (;;) {
    const step = engine.advance();
    applyDue('after advance()');
    // A concession applied at this decision ended the game.
    if (step.kind === 'gameOver' || engine.getResult() !== null) break;
    if (step.kind === 'continue') continue;

    // The log ends at its last recorded event: a game that was abandoned stops here.
    const recorded = decisions[nextDecision];
    if (recorded === undefined) break;

    const response = recorded.payload['submittedResponse'] as DecisionResponse | undefined;
    if (response === undefined) {
      throw new ReplayMismatchError(
        `decision event ${recorded.sequence} has no submittedResponse to feed`,
      );
    }
    if (step.request.requestId !== response.requestId) {
      throw new ReplayMismatchError(
        `decision ${nextDecision + 1}: the engine asked ${step.request.requestId} but the log ` +
          `answered ${response.requestId}`,
      );
    }
    const expectedSequence = nextSequenceOf(engine);
    if (recorded.sequence !== expectedSequence) {
      throw new ReplayMismatchError(
        `decision ${nextDecision + 1} (${response.requestId}): recorded at sequence ` +
          `${recorded.sequence} but the engine would emit it at ${expectedSequence}`,
      );
    }
    engine.submit(response);
    nextDecision += 1;
    applyDue('after submit()');
  }

  if (nextDecision < decisions.length) {
    throw new ReplayMismatchError(
      `the engine finished after ${nextDecision} decisions but the log holds ${decisions.length}`,
    );
  }
  if (nextOutOfBand < outOfBand.length) {
    const left = outOfBand[nextOutOfBand]!;
    throw new ReplayMismatchError(
      `'${left.type}' at sequence ${left.sequence} was never reached (the engine ended at ` +
        `${nextSequenceOf(engine) - 1})`,
    );
  }
  return { engine, decisions: nextDecision, outOfBand: applied, hash: replayStateHash(engine) };
}

// ── A scripted single-player game, recorded through the real session and recorder ───────────

function forest(n: number): OracleCard {
  return {
    oracleId: `forest-${n}`,
    scryfallId: `scry-forest-${n}`,
    name: 'Forest',
    manaCost: null,
    cmc: 0,
    colors: [],
    colorIdentity: ['G'],
    typeLine: 'Basic Land — Forest',
    supertypes: ['Basic'],
    types: ['Land'],
    subtypes: ['Forest'],
    oracleText: '',
    power: null,
    toughness: null,
    loyalty: null,
    defense: null,
    keywords: [],
    layout: 'normal',
    commanderLegality: 'legal',
    isBasicLand: true,
  };
}

function general(seat: string): OracleCard {
  return {
    ...forest(0),
    oracleId: `general-${seat}`,
    scryfallId: `scry-general-${seat}`,
    name: `Test General ${seat}`,
    manaCost: '{G}',
    cmc: 1,
    colors: ['G'],
    typeLine: 'Legendary Creature — Elf',
    supertypes: ['Legendary'],
    types: ['Creature'],
    subtypes: ['Elf'],
    power: '2',
    toughness: '2',
    isBasicLand: false,
  };
}

const SEAT_IDS: readonly PlayerId[] = ['P1', 'P2', 'P3', 'P4'];

/** The decks, as a snapshot table would resolve them. Rebuilt per call: nothing is shared. */
function snapshotTable(): Map<string, ResolvedDeck> {
  return new Map(
    SEAT_IDS.map((seat) => [
      `snap-${seat}`,
      {
        deckId: `deck-${seat}`,
        commanders: [general(seat)],
        cards: Array.from({ length: 12 }, (_, i) => forest(i)),
      },
    ]),
  );
}

function seatSetups(): SeatSetup[] {
  const table = snapshotTable();
  return SEAT_IDS.map((seat) => {
    const deck = table.get(`snap-${seat}`)!;
    return {
      seat,
      deckSnapshotId: `snap-${seat}`,
      config: {
        id: seat,
        deckId: deck.deckId,
        commanders: deck.commanders,
        cards: deck.cards,
      },
      summary: {
        seat,
        deckId: deck.deckId,
        label: `Test General ${seat}`,
        commanderNames: [`Test General ${seat}`],
        colorIdentity: ['G'],
        archetypeTag: 'G — test',
      },
    };
  });
}

/** An in-memory stand-in for `game_events` and the `games` replay columns. */
class RecordedGame {
  readonly events: GameEvent[] = [];
  /** `game_decision_sources`: request id to source. */
  readonly sources = new Map<string, string>();
  config: GameReplayConfig | null = null;
  readonly db: SqliteLike = {
    query: (sql: string) => ({
      run: (...args: unknown[]) => {
        if (sql.includes('INSERT INTO game_events')) {
          const [, sequence, turn, phase, step, actor, type, payload] = args as [
            string,
            number,
            number,
            GameEvent['phase'],
            GameEvent['step'],
            number | null,
            string,
            string,
          ];
          if (!this.events.some((event) => event.sequence === sequence)) {
            this.events.push({
              sequence,
              turn,
              phase,
              step,
              actorSeat: actor === null ? null : `P${actor}`,
              type,
              payload: JSON.parse(payload) as Record<string, unknown>,
            });
          }
        } else if (sql.includes('INSERT INTO game_decision_sources')) {
          this.sources.set(String(args[1]), String(args[3]));
        } else if (sql.includes('UPDATE games SET config_json')) {
          this.config = JSON.parse(String(args[0])) as GameReplayConfig;
        }
      },
      all: () => [],
      get: () => null,
    }),
  };
  store(): GameStore {
    return { recorderFor: (id: string) => new GameRecorder(this.db, id) } as unknown as GameStore;
  }
  sorted(): GameEvent[] {
    return [...this.events].sort((a, b) => a.sequence - b.sequence);
  }
}

const CARD_DATA_SHA = 'fixture-card-data-sha256';

interface Played {
  recorded: RecordedGame;
  session: MatchSession;
}

type ActionRequired = Extract<ServerToClientMessage, { type: 'playerActionRequired' }>;

/**
 * A scripted human plays seat P1 to the end of a game, with manual mana on and no yield ever
 * cancelled. The other seats are random bots. Everything is seeded.
 */
async function playScriptedGame(
  options: { stopAfterDecisions?: number; yieldThenCancel?: boolean } = {},
): Promise<Played> {
  const recorded = new RecordedGame();
  const sent: ServerToClientMessage[] = [];
  const session = new MatchSession({
    disclosure: testerPolicy('singlePlayer'),
    gameId: 'g-replay',
    seed: 'replay-seed',
    seats: seatSetups(),
    providerKind: 'random',
    gameMode: 'singlePlayer',
    humanSeat: 'P1',
    store: recorded.store(),
    replay: {
      cardDataSha256: CARD_DATA_SHA,
      build: { commit: 'test-commit', branch: null, dirty: false },
    },
    livePaceMs: 0,
    send: (message) => sent.push(message),
  });
  const chooser = new RandomDecisionProvider('replay-human');
  let consumed = 0;
  let manualManaOffered = false;
  session.start();
  const deadline = Date.now() + 20_000;
  while (!sent.some((m) => m.type === 'gameOver' || m.type === 'computeHalted')) {
    if (Date.now() > deadline) throw new Error('the scripted game did not finish');
    const next = sent.filter((m): m is ActionRequired => m.type === 'playerActionRequired')[
      consumed
    ];
    if (next === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      continue;
    }
    if (options.stopAfterDecisions !== undefined && consumed >= options.stopAfterDecisions) break;
    consumed += 1;
    manualManaOffered ||= next.payload.request.legalActions.some(
      (action) => action.type === 'activateManaAbility',
    );
    // Yield and take it back until one cancellation has reached the log, then play on.
    const cancelledOnce = session.engine
      .eventsSince(0)
      .some((event) => event.type === 'yieldCancelled');
    const yieldAction =
      options.yieldThenCancel === true && !cancelledOnce
        ? next.payload.request.legalActions.find((action) => action.type === 'passAndYieldTurn')
        : undefined;
    const answer =
      yieldAction !== undefined
        ? { requestId: next.payload.request.requestId, actionId: yieldAction.id }
        : chooser.decide(next.payload.request);
    session.submitPlayerAction('P1', {
      requestId: answer.requestId,
      actionId: answer.actionId,
      revision: next.payload.revision,
      ...('targets' in answer && answer.targets !== undefined ? { targets: answer.targets } : {}),
    });
    if (yieldAction !== undefined) {
      // Change of mind while the yield runs: the same call the player's Cancel button makes.
      await new Promise((resolve) => setTimeout(resolve, 5));
      session.cancelYield('P1');
    }
  }
  if (options.stopAfterDecisions === undefined) {
    await session.settled();
  } else {
    // Let the last accepted answer reach the log, then abandon the game mid-turn.
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.abandon();
    await session.settled();
  }
  expect(manualManaOffered, 'the human was offered a manual mana ability').toBe(true);
  return { recorded, session };
}

function inputFor(played: Played, overrides: Partial<ReplayInput> = {}): ReplayInput {
  const table = snapshotTable();
  const config = played.recorded.config;
  if (config === null) throw new Error('the game stored no replay config');
  return {
    gameId: 'g-replay',
    seed: 'replay-seed',
    config,
    resolveDeck: (snapshotId) => {
      const deck = table.get(snapshotId);
      if (deck === undefined) throw new Error(`no deck snapshot ${snapshotId}`);
      return deck;
    },
    events: played.recorded.sorted(),
    currentCardDataSha256: CARD_DATA_SHA,
    ...overrides,
  };
}

describe('replay from the stored log', () => {
  it('rebuilds a scripted single-player game with manual mana and reaches the same state', async () => {
    const played = await playScriptedGame();
    const config = played.recorded.config!;
    expect(config).toEqual({
      schemaVersion: 1,
      cardDataSha256: CARD_DATA_SHA,
      seats: [
        { seat: 'P1', deckSnapshotId: 'snap-P1', manualMana: true },
        { seat: 'P2', deckSnapshotId: 'snap-P2', manualMana: false },
        { seat: 'P3', deckSnapshotId: 'snap-P3', manualMana: false },
        { seat: 'P4', deckSnapshotId: 'snap-P4', manualMana: false },
      ],
      turnCap: 500,
      rng: { kind: 'legacy', key: '' },
      engineOptions: { maxDecisions: 100000 },
    });
    const events = played.recorded.sorted();
    expect(events.some((event) => event.type === 'yieldCancelled')).toBe(false);
    expect(
      events.some((event) => {
        const description = (event.payload['description'] as string | undefined) ?? '';
        return event.type === 'decision' && /add \{?[WUBRGC]/i.test(description);
      }),
      'a manual mana activation was recorded',
    ).toBe(true);

    const replayed = replayFromLog(inputFor(played));

    expect(replayed.decisions).toBe(events.filter((e) => e.type === 'decision').length);
    expect(replayed.decisions).toBeGreaterThan(20);
    expect(replayed.outOfBand).toBe(0);
    expect(replayed.engine.getState().eventLog).toEqual(events);
    expect(replayed.hash).toBe(replayStateHash(played.session.engine));
    expect(replayed.engine.getResult()).toEqual(played.session.engine.getResult());
  }, 30_000);

  it('ends at the last recorded event when the game was abandoned', async () => {
    const played = await playScriptedGame({ stopAfterDecisions: 12 });
    const events = played.recorded.sorted();
    expect(played.session.runner.getStatus()).toBe('abandoned');

    const replayed = replayFromLog(inputFor(played));

    expect(replayed.decisions).toBe(events.filter((e) => e.type === 'decision').length);
    expect(replayed.engine.getResult()).toBeNull();
    expect(replayed.engine.getState().eventLog.slice(0, events.length)).toEqual(events);
  }, 30_000);

  it('refuses to run on card data whose hash differs, or is unknown', async () => {
    const played = await playScriptedGame();

    expect(() =>
      replayFromLog(inputFor(played, { currentCardDataSha256: 'someone-else' })),
    ).toThrow(/card data differs/);
    expect(() => replayFromLog(inputFor(played, { currentCardDataSha256: null }))).toThrow(
      ReplayRefusedError,
    );
    expect(() =>
      replayFromLog(
        inputFor(played, { config: { ...played.recorded.config!, cardDataSha256: null } }),
      ),
    ).toThrow(ReplayRefusedError);
  }, 30_000);

  it('refuses provisional pins (H1) the loaded catalog does not hold at the same bytes', async () => {
    const played = await playScriptedGame();
    const pin = { oracleId: 'oracle-pinned', source: 'compiler@test', patchSha256: 'a'.repeat(64) };
    const config: GameReplayConfig = { ...played.recorded.config!, provisional: [pin] };
    const catalog = (patchSha256: string): ProvisionalCatalog => ({
      definitions: new Map(),
      admitted: [{ name: 'Pinned', oracleId: pin.oracleId, source: pin.source, patchSha256 }],
      skipped: [],
    });

    expect(() => replayFromLog(inputFor(played, { config }))).toThrow(/is not loaded/);
    expect(() =>
      replayFromLog(inputFor(played, { config, provisional: catalog('b'.repeat(64)) })),
    ).toThrow(/differs/);
    // The same bytes pass the check; this game's decks hold no provisional card, so it replays.
    const replayed = replayFromLog(
      inputFor(played, { config, provisional: catalog(pin.patchSha256) }),
    );
    expect(replayed.hash).toBe(replayStateHash(played.session.engine));
  }, 30_000);

  it('refuses a chacha20 config without a usable key', async () => {
    const played = await playScriptedGame();
    const config: GameReplayConfig = {
      ...played.recorded.config!,
      rng: { kind: 'chacha20', key: '' },
    };
    expect(() => replayFromLog(inputFor(played, { config }))).toThrow(/chacha20 key/);
  }, 30_000);

  it('fails loudly when a recorded request id is not the one the engine asks', async () => {
    const played = await playScriptedGame();
    const events = played.recorded.sorted().map((event) => structuredClone(event));
    const decision = events.filter((event) => event.type === 'decision')[3]!;
    const response = decision.payload['submittedResponse'] as DecisionResponse;
    decision.payload['submittedResponse'] = { ...response, requestId: 'g-replay:tampered' };

    expect(() => replayFromLog(inputFor(played, { events }))).toThrow(
      /decision 4: the engine asked .* but the log answered g-replay:tampered/,
    );
  }, 30_000);

  it('fails loudly when a decision was recorded at a different sequence', async () => {
    const played = await playScriptedGame();
    const events = played.recorded.sorted().map((event) => structuredClone(event));
    const decision = events.filter((event) => event.type === 'decision')[5]!;
    decision.sequence += 1;

    expect(() => replayFromLog(inputFor(played, { events }))).toThrow(
      /recorded at sequence .* but the engine would emit it at/,
    );
  }, 30_000);

  it('fails loudly when the log holds a decision the engine never asks for', async () => {
    const played = await playScriptedGame();
    const events = played.recorded.sorted().map((event) => structuredClone(event));
    const last = events.filter((event) => event.type === 'decision').at(-1)!;
    events.push({ ...structuredClone(last), sequence: last.sequence + 10_000 });

    expect(() => replayFromLog(inputFor(played, { events }))).toThrow(
      /the engine finished after \d+ decisions but the log holds \d+/,
    );
  }, 30_000);

  it('detects a final state that is not the one recorded', async () => {
    const played = await playScriptedGame();
    const replayed = replayFromLog(inputFor(played));
    // Same inputs, a different seed: the shuffles differ, so the hash must too.
    const other = replayFromLog(inputFor(played, { seed: 'another-seed' }));

    expect(other.hash).not.toBe(replayed.hash);
  }, 30_000);

  it('fails on a recorded yieldCancelled for a player who was not yielding', async () => {
    const played = await playScriptedGame();
    const events = played.recorded.sorted().map((event) => structuredClone(event));
    // Recorded where the engine sits right after its first `advance()`: the first decision.
    const first = events.find((event) => event.type === 'decision')!;
    events.push({
      ...structuredClone(first),
      type: 'yieldCancelled',
      payload: { player: 'P1' },
    });

    expect(() => replayFromLog(inputFor(played, { events }))).toThrow(
      /P1 was not yielding when 'yieldCancelled' was recorded/,
    );
  }, 30_000);

  it('replays a game in which the human cancelled a yield', async () => {
    const played = await playScriptedGame({ yieldThenCancel: true });
    const events = played.recorded.sorted();
    expect(events.filter((event) => event.type === 'yieldCancelled').length).toBeGreaterThan(0);

    const replayed = replayFromLog(inputFor(played));
    expect(replayed.hash).toBe(replayStateHash(played.session.engine));
  }, 30_000);

  it('replays a timed table game with timeout and fallback answers that ends at the time limit', async () => {
    const recorded = new RecordedGame();
    let now = 0;
    const due: Array<{ at: number; callback: () => void; id: number }> = [];
    let ids = 0;
    const timers: ClockTimers = {
      now: () => now,
      setTimeout: (callback, ms) => {
        ids += 1;
        due.push({ at: now + ms, callback, id: ids });
        return ids;
      },
      clearTimeout: (handle) => {
        const index = due.findIndex((entry) => entry.id === handle);
        if (index >= 0) due.splice(index, 1);
      },
    };
    const advance = (ms: number): void => {
      const end = now + ms;
      for (;;) {
        due.sort((a, b) => a.at - b.at);
        const next = due[0];
        if (next === undefined || next.at > end) break;
        due.shift();
        now = next.at;
        next.callback();
      }
      now = end;
    };
    const bySeat: Record<string, ServerToClientMessage[]> = { P1: [], P3: [] };
    const pub: ServerToClientMessage[] = [];
    const rngKey = '3c'.repeat(32);
    const session = new MatchSession({
      disclosure: tablePolicy(),
      gameId: 'g-replay',
      seed: 'replay-seed',
      rng: 'chacha20',
      rngKey,
      seats: seatSetups(),
      providerKind: 'random',
      gameMode: 'table',
      seatControllers: { P1: 'human', P2: 'random', P3: 'human', P4: 'random' },
      store: recorded.store(),
      replay: {
        cardDataSha256: CARD_DATA_SHA,
        build: { commit: 'test-commit', branch: null, dirty: false },
      },
      livePaceMs: 0,
      clock: {
        settings: {
          allowanceMs: 1_000,
          bankMs: 0,
          graceMs: 60_000,
          disconnectBudgetMs: 300_000,
          gameCapMs: 30_000,
        },
        timers,
      },
      send: (message) => pub.push(message),
      sendToSeat: (seat, message) => bySeat[seat]!.push(message),
    });
    const chooser = new RandomDecisionProvider('replay-p3');
    let p1Seen = 0;
    let p3Seen = 0;
    session.start();
    const deadline = Date.now() + 20_000;
    while (!pub.some((m) => m.type === 'gameOver' || m.type === 'computeHalted')) {
      if (Date.now() > deadline) throw new Error('the timed game did not finish');
      const p3 = bySeat['P3']!.filter(
        (m): m is ActionRequired => m.type === 'playerActionRequired',
      );
      const p1 = bySeat['P1']!.filter(
        (m): m is ActionRequired => m.type === 'playerActionRequired',
      );
      if ([...recorded.sources.values()].includes('fallback')) {
        // The fallback bot has answered for P1: the table's time runs out while P3 thinks.
        advance(30_000);
      } else if (p3[p3Seen] !== undefined) {
        const next = p3[p3Seen]!;
        p3Seen += 1;
        const answer = chooser.decide(next.payload.request);
        session.submitPlayerAction('P3', {
          requestId: answer.requestId,
          actionId: answer.actionId,
          revision: next.payload.revision,
          ...(answer.targets !== undefined ? { targets: answer.targets } : {}),
        });
      } else if (p1.length > p1Seen) {
        // P1 never answers: each shown decision runs out and the fallback bot answers. After the
        // third the bot keeps the seat.
        p1Seen = p1.length;
        advance(1_000);
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await session.settled();
    const result = session.engine.getResult();
    expect(result?.endReason).toBe('timeLimit');
    const events = recorded.sorted();
    expect(events.some((event) => event.type === 'conceded')).toBe(true);
    // Answers from the player, the clock and the fallback bot all replay alike: replay reads the
    // responses, never who gave them.
    const sources = new Set(recorded.sources.values());
    for (const source of ['human', 'timeout', 'fallback', 'bot']) expect(sources).toContain(source);
    expect(recorded.config?.rng).toEqual({ kind: 'chacha20', key: rngKey });

    const replayed = replayFromLog({
      gameId: 'g-replay',
      seed: 'replay-seed',
      config: recorded.config!,
      resolveDeck: (snapshotId) => snapshotTable().get(snapshotId)!,
      events,
      currentCardDataSha256: CARD_DATA_SHA,
    });
    expect(replayed.outOfBand).toBe(1);
    expect(replayed.engine.getState().eventLog).toEqual(events);
    expect(replayed.hash).toBe(replayStateHash(session.engine));
    expect(replayed.engine.getResult()).toEqual(result);
  }, 30_000);
});
