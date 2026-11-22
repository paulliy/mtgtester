/**
 * Whole four-player games between lineup entries ("arms"), for win rates and cost per game where
 * bot-bench's positions give accuracy per decision. An arm is any bot-bench entry: a tactician (the
 * card-aware bot, the bot escalating to a model, a chat model, a decision model) with its
 * strategist (none, or a live model). Every seat plays through the production pipeline, as in a
 * live table: `OpenAiDecisionProvider`, the production `StrategyCoordinator`, and for a decision
 * model the production Jev lane with the bot behind it.
 *
 * Seating. Two arms take two seats each (P1 and P3 against P2 and P4); four arms take one seat
 * each. Every deal is played once per rotation of the arms around the table, so deck and seat
 * luck cancel within a deal: two games per deal for two arms, four for four.
 *
 * What a production table does that this keeps:
 * - Every accepted decision reaches every arm's coordinator, so an opponent's action invalidates a
 *   plan and may start a re-plan, as the one shared coordinator of a live game does. Each arm has
 *   its own coordinator only because each arm has its own strategist model and tactical mode.
 * - Dominated decisions are answered locally (`production` mode), as a live seat answers them.
 *
 * What it changes on purpose: each seat waits for its strategist before its first decision of a
 * turn (`race: true` restores the live race). Four bot-led seats finish a turn long before any
 * model answers, so without the wait a fast arm would play almost every turn without a plan and
 * the game would not measure the strategist (ai-mode-duel's 2026-11-16 run: 46 turns, 0 answered).
 */
import { HeuristicDecisionProvider, parsePolicyFixes } from '../../packages/bot/src';
import {
  Engine,
  runToCompletionAsync,
  type AsyncDecisionProvider,
} from '../../packages/engine/src';
import { knowledgeFor } from '../../packages/server/src/ai/bot-tactician';
import { buildSupportedPool } from '../../packages/server/src/cards/pool';
import {
  OpenAiCompatibleClient,
  type AiClient,
  type AiNetworkAttempt,
} from '../../packages/server/src/ai/client';
import { configForRole, loadAiConfig, type AiConfig } from '../../packages/server/src/ai/config';
import {
  JevClient,
  OpenRouterJevTransport,
  type JevDecisionsTransport,
} from '../../packages/server/src/ai/jev-client';
import type { JevDecisionsRequest } from '../../packages/server/src/ai/jev-context';
import { JevActionPolicy } from '../../packages/server/src/ai/jev-policy';
import { OPENROUTER_BASE_URL } from '../../packages/server/src/ai/jev-runtime';
import {
  AiCallLogger,
  type CallResult,
  type DecisionSource,
} from '../../packages/server/src/ai/logger';
import { OpenAiDecisionProvider } from '../../packages/server/src/ai/provider';
import { RequestQueue } from '../../packages/server/src/ai/queue';
import { StrategyCoordinator } from '../../packages/server/src/ai/strategy-coordinator';
import { JEV_MAX_CHOICE_OPTIONS } from '../../packages/server/src/ai/tactical-decision-shape';
import { generateCommanderDeck } from '../../packages/server/src/decks/generate';
import { TABLE_ENGINE_LIMITS } from '../../packages/server/src/match/engine-limits';
import type {
  DecisionRequest,
  DecisionResponse,
  GameId,
  OracleCard,
  PlayerId,
} from '../../packages/shared/src';
import { round, settleAttempts } from './billing';
import {
  DEFAULT_DECISION_TIMEOUT_MS,
  entryLabel,
  liveStrategist,
  publicEntry,
  resolveBotLedConfig,
  resolveDecisionKey,
  resolveLlmConfig,
  type DecisionEntry,
  type LineupEntry,
  type LlmRuntime,
} from './models';
import { coordinatorConfig, resolveStrategistClientConfig } from './strategist';

export const SEATS: readonly PlayerId[] = ['P1', 'P2', 'P3', 'P4'];
const DEFAULT_FIXTURE = 'packages/server/fixtures/coverage-oracle.json';

/** What one arm spent and how its decisions were answered, in one game or summed over many. */
export interface ArmTally {
  /** Physical requests per role, retries included. */
  requests: { tactician: number; strategist: number; decision: number };
  promptTokens: number;
  responseTokens: number;
  /** Reported charges, plus price-list estimates for unpriced attempts. */
  costUsd: number;
  /** Billed attempts with no price, reported or estimated: `costUsd` is a lower bound when > 0. */
  unpricedAttempts: number;
  /** Requests that failed at the provider (timeouts, HTTP errors, refusals to answer). */
  failedRequests: number;
  /** Requests never sent because the spend cap was reached; the seat's bot answered instead. */
  cappedRequests: number;
  /**
   * How the arm's decisions were answered, in the production pipeline's words: `primary`,
   * `retry` and `jev` are the model's own answers, `fallback` is the bot standing in for a model
   * that gave no legal answer, `bot`, `plan`, `heuristic` and `cache` are answered without one.
   */
  sources: Record<string, number>;
  /** Strategist calls the arm's coordinator made, and turns it reused bot knobs instead. */
  strategistCalls: number;
  strategistReused: number;
}

export function emptyArmTally(): ArmTally {
  return {
    requests: { tactician: 0, strategist: 0, decision: 0 },
    promptTokens: 0,
    responseTokens: 0,
    costUsd: 0,
    unpricedAttempts: 0,
    failedRequests: 0,
    cappedRequests: 0,
    sources: {},
    strategistCalls: 0,
    strategistReused: 0,
  };
}

export function addTally(into: ArmTally, from: ArmTally): void {
  into.requests.tactician += from.requests.tactician;
  into.requests.strategist += from.requests.strategist;
  into.requests.decision += from.requests.decision;
  into.promptTokens += from.promptTokens;
  into.responseTokens += from.responseTokens;
  into.costUsd += from.costUsd;
  into.unpricedAttempts += from.unpricedAttempts;
  into.failedRequests += from.failedRequests;
  into.cappedRequests += from.cappedRequests;
  into.strategistCalls += from.strategistCalls;
  into.strategistReused += from.strategistReused;
  for (const [source, count] of Object.entries(from.sources))
    into.sources[source] = (into.sources[source] ?? 0) + count;
}

/** Decisions a model was asked to answer itself and the share the bot had to play instead. */
export function fallbackShare(tally: ArmTally): number | null {
  const s = tally.sources;
  const asked = (s['primary'] ?? 0) + (s['retry'] ?? 0) + (s['jev'] ?? 0) + (s['fallback'] ?? 0);
  return asked === 0 ? null : (s['fallback'] ?? 0) / asked;
}

export interface GameRecord {
  /** The deal: the seed its four decks and the engine's shuffles come from. */
  deal: number;
  seed: string;
  /** Which rotation of the arms around the table this game used. */
  rotation: number;
  /** Arm id by seat. */
  seats: Record<PlayerId, string>;
  commanders: Record<PlayerId, string>;
  winner: PlayerId | null;
  winnerArm: string | null;
  turns: number;
  /** Elimination order, first out first; the winner, if any, is last. */
  finishingOrder: PlayerId[];
  /** Life at the end, 0 for an eliminated seat. */
  life: Record<PlayerId, number>;
  /** The game turn each seat was first seen eliminated on; null for a survivor. */
  eliminatedOn: Record<PlayerId, number | null>;
  /** The turn cap ended the game: a draw for every seat still in it, not an engine fault. */
  turnCapped: boolean;
  /** The engine stopped the game for any other reason (a probable rules or engine bug). */
  halted: boolean;
  haltReason?: string;
  ms: number;
  /** The spend cap was reached during this game: some model decisions were the bot's. */
  capped: boolean;
  perArm: Record<string, ArmTally>;
}

export interface ArmSummary {
  id: string;
  label: string;
  /** Games the arm sat in, halted ones included. */
  games: number;
  /** Seats the arm filled over those games. */
  seats: number;
  wins: number;
  /** Games with no winner (turn cap, mutual loss), halted ones excluded. */
  draws: number;
  halted: number;
  /** Wins over games that ended (not halted). */
  winRate: number | null;
  /** The share of all remaining life the arm's seats held at the end, mean over ended games. */
  lifeShare: number | null;
  /** Mean game turn on which the arm's seats were eliminated, survivors left out. */
  meanEliminationTurn: number | null;
  costUsd: number;
  costPerGameUsd: number | null;
  /** True when some billed attempt had no price: the cost is a lower bound. */
  costIsLowerBound: boolean;
  tacticianRequestsPerGame: number | null;
  strategistCallsPerGame: number | null;
  decisionRequestsPerGame: number | null;
  /** Above 0.05, the arm's model did not get a fair game (ADR 0039's bar). */
  fallbackShare: number | null;
  totals: ArmTally;
}

export interface DuelSummary {
  arms: ArmSummary[];
  games: number;
  /** A fair arm's expected win rate: one seat in four wins, so two seats expect 0.5. */
  fairWinRate: number;
  meanTurns: number | null;
  spendUsd: number;
  capped: boolean;
}

export interface DuelOptions {
  arms: readonly LineupEntry[];
  /** Deals to play; each is played once per rotation. */
  deals: number;
  seed: string;
  turnCap: number;
  /** Games running at once. */
  jobs: number;
  spendCapUsd: number | null;
  env: Record<string, string | undefined>;
  /** Let the tactician race the strategist, as a live game does, instead of waiting for it. */
  race?: boolean;
  /** No network: chat models are the bot, strategists return fixed knobs, decision models the bot. */
  offline?: boolean;
  /** The Oracle fixture decks are generated from. */
  fixture?: OracleCard[];
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  decisionTransport?: JevDecisionsTransport;
  onGame?: (game: GameRecord) => void;
  onProgress?: (line: string) => void;
}

/** Arm by seat for one rotation: two arms alternate around the table, four take a seat each. */
export function seating(armIds: readonly string[], rotation: number): Record<PlayerId, string> {
  const k = armIds.length;
  return Object.fromEntries(SEATS.map((seat, i) => [seat, armIds[(i + rotation) % k]!])) as Record<
    PlayerId,
    string
  >;
}

/** Refuses an arm a game cannot play faithfully. */
export function checkArms(arms: readonly LineupEntry[]): void {
  if (arms.length !== 2 && arms.length !== 4)
    throw new Error(`a duel takes 2 or 4 arms (seats split evenly), not ${arms.length}`);
  const ids = arms.map((arm) => arm.id);
  const clash = ids.find((id, i) => ids.indexOf(id) !== i);
  if (clash !== undefined) throw new Error(`arm ${clash} is listed twice`);
  for (const arm of arms)
    if (arm.strategist?.kind === 'case')
      throw new Error(
        `${arm.id}: a case's hand-written strategy exists only in bench positions; use none or a model`,
      );
}

/** Counts how the provider answered each decision, per source. */
class CountingLogger extends AiCallLogger {
  constructor(
    gameId: string,
    private readonly tally: ArmTally,
    private readonly sources: Map<string, DecisionSource>,
  ) {
    super(null, gameId);
  }

  override log(
    request: DecisionRequest,
    result: CallResult,
    wasRetry: boolean,
    wasFallback: boolean,
    source: DecisionSource = 'primary',
  ): void {
    super.log(request, result, wasRetry, wasFallback, source);
    if (source === 'strategist') return;
    this.tally.sources[source] = (this.tally.sources[source] ?? 0) + 1;
    this.sources.set(request.requestId, source);
  }
}

interface Budget {
  capUsd: number | null;
  spentUsd: number;
  capped: boolean;
}

/** Thrown in place of a request once the spend cap is reached; the provider's bot answers. */
class SpendCapReached extends Error {
  constructor() {
    super('duel spend cap reached');
    this.name = 'SpendCapReached';
  }
}

/** An offline chat client: the tactician is the bot, the strategist returns fixed knobs. */
function offlineClient(engine: Engine, role: 'tactician' | 'strategist'): AiClient {
  const knowledge = knowledgeFor(engine);
  const bots = new Map<string, HeuristicDecisionProvider>();
  return {
    activeModel: `offline-${role}`,
    requestDecision(_prompt, request) {
      const meta = {
        model: `offline-${role}`,
        promptTokens: 0,
        responseTokens: 0,
        latencyMs: 0,
        wasRetry: false,
        wasFallback: false,
        rawResponse: '{}',
        costUsd: 0,
      };
      if (role === 'strategist')
        return Promise.resolve({
          response: {
            requestId: request.requestId,
            actionId: 0,
            turnStrategy: { intent: 'offline', plannedActions: [], steering: { aggression: 0.5 } },
          },
          meta,
        });
      const seat = request.decidingPlayer;
      let bot = bots.get(seat);
      if (bot === undefined) {
        bot = new HeuristicDecisionProvider(`offline:${seat}`, () => engine.view(seat), {
          knowledge,
        });
        bots.set(seat, bot);
      }
      return Promise.resolve({ response: bot.decide(request), meta });
    },
  };
}

/** An offline Decisions API: always picks the first option offered. */
const offlineDecisions: JevDecisionsTransport = {
  create({ decisionsRequest }: { decisionsRequest: JevDecisionsRequest }) {
    const [first = ''] = Object.keys(decisionsRequest.questions.action.criteria);
    return Promise.resolve({
      id: 'offline',
      model: decisionsRequest.model,
      answers: { action: { type: 'choice', choice: first, confidence: 1 } },
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
    });
  },
} as unknown as JevDecisionsTransport;

interface ArmGame {
  provider(seat: PlayerId): AsyncDecisionProvider;
  coordinator: StrategyCoordinator | undefined;
  /** Every decision the engine accepted, from any seat. */
  observe(request: DecisionRequest, response: DecisionResponse, source: DecisionSource): void;
  finish(): Promise<void>;
  tally: ArmTally;
  sources: Map<string, DecisionSource>;
}

interface GameContext {
  engine: Engine;
  gameId: string;
  options: DuelOptions;
  budget: Budget;
}

/**
 * The arm's seats for one game: its clients, queue, coordinator and one production provider per
 * seat. Nothing here is shared with another arm, so each arm's spending is counted apart.
 */
function armGame(arm: LineupEntry, mySeats: readonly PlayerId[], ctx: GameContext): ArmGame {
  const { engine, options, budget } = ctx;
  const tally = emptyArmTally();
  const sources = new Map<string, DecisionSource>();
  const others = new Set(SEATS.filter((seat) => !mySeats.includes(seat)));
  const runtime: LlmRuntime = {
    env: options.env,
    // A game answers dominated decisions locally, as a live seat does.
    mode: 'production',
    ...(options.fetchImpl !== undefined && { fetchImpl: options.fetchImpl }),
    ...(options.sleepImpl !== undefined && { sleepImpl: options.sleepImpl }),
    ...(options.offline === true && {
      fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
    }),
  };
  const overCap = (): boolean => budget.capUsd !== null && budget.spentUsd >= budget.capUsd;
  /** A fetch that refuses every POST once the cap is reached, so no retry spends past it. */
  const capped = (inner: typeof fetch | undefined): typeof fetch =>
    (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'POST' && overCap()) {
        budget.capped = true;
        tally.cappedRequests += 1;
        throw new SpendCapReached();
      }
      return (inner ?? fetch)(input, init);
    }) as typeof fetch;
  const observeAttempt =
    (
      role: keyof ArmTally['requests'],
      pricing: { inputPerMTok: number; outputPerMTok: number } | undefined,
    ) =>
    (attempt: AiNetworkAttempt): void => {
      if (attempt.error?.includes('spend cap reached') === true) return;
      tally.requests[role] += 1;
      tally.promptTokens += attempt.usage.promptTokens ?? 0;
      tally.responseTokens += attempt.usage.responseTokens ?? 0;
      if (attempt.status !== 'accepted') tally.failedRequests += 1;
      const settled = settleAttempts([attempt], pricing);
      if (settled.costUsd === undefined) tally.unpricedAttempts += 1;
      else {
        tally.costUsd += settled.costUsd;
        budget.spentUsd += settled.costUsd;
      }
    };

  if (arm.kind === 'local') {
    if (liveStrategist(arm) !== undefined)
      throw new Error(`${arm.id}: a local bot reads no strategy`);
    const knowledge = arm.policy === 'heuristic' ? knowledgeFor(engine) : undefined;
    const bots = new Map<PlayerId, HeuristicDecisionProvider>();
    return {
      provider(seat) {
        let bot = bots.get(seat);
        if (bot === undefined) {
          bot = new HeuristicDecisionProvider(
            `duel:${ctx.gameId}:${arm.id}:${seat}`,
            () => engine.view(seat),
            knowledge === undefined
              ? { fixes: [] }
              : {
                  knowledge,
                  ...(arm.fixes !== undefined && { fixes: parsePolicyFixes(arm.fixes) }),
                },
          );
          bots.set(seat, bot);
        }
        const answer = bot;
        return {
          decide(request) {
            tally.sources['bot'] = (tally.sources['bot'] ?? 0) + 1;
            sources.set(request.requestId, 'bot');
            return Promise.resolve(answer.decide(request));
          },
        };
      },
      coordinator: undefined,
      observe() {},
      finish: () => Promise.resolve(),
      tally,
      sources,
    };
  }

  // The tactician's pipeline settings, as bot-bench resolves them for this entry.
  const base = loadAiConfig(options.env);
  let config: AiConfig;
  let jev: { policy: JevActionPolicy; mode: 'active' } | undefined;
  let tacticianClient: AiClient;
  if (arm.kind === 'decision') {
    config = {
      ...configForRole(base, 'tactician'),
      tacticalMode: 'model',
      strategistEnabled: false,
      heuristicsEnabled: true,
      decisionCacheEnabled: false,
      jevEnabled: false,
      jevShadowEnabled: false,
      strategyRouterShadowEnabled: false,
      // What the decision model cannot express, or fails to answer, the bot plays (ADR 0046).
      jevFallback: 'bot',
    };
    jev = {
      policy: decisionPolicy(arm, ctx, observeAttempt('decision', arm.pricing)),
      mode: 'active',
    };
    // A decision-model seat has no chat tactician: nothing must reach one.
    tacticianClient = {
      activeModel: 'none',
      requestDecision: () => Promise.reject(new Error(`${arm.id} has no chat tactician`)),
    };
  } else {
    config =
      arm.kind === 'llm' ? resolveLlmConfig(arm, runtime) : resolveBotLedConfig(arm, runtime);
    const neverEscalates = arm.kind === 'bot-led' && arm.model === undefined;
    tacticianClient =
      options.offline === true
        ? offlineClient(engine, 'tactician')
        : neverEscalates
          ? {
              activeModel: 'none',
              requestDecision: () =>
                Promise.reject(new Error(`${arm.id} has no model to escalate to`)),
            }
          : new OpenAiCompatibleClient(
              config,
              capped(runtime.fetchImpl),
              runtime.sleepImpl,
              observeAttempt('tactician', arm.pricing),
            );
  }
  const logger = new CountingLogger(ctx.gameId, tally, sources);
  const queue = new RequestQueue({ rpmLimit: config.rpmLimit, concurrency: 1 });

  const spec = liveStrategist(arm);
  let coordinator: StrategyCoordinator;
  if (spec === undefined) {
    coordinator = new StrategyCoordinator(null, queue, engine, config, logger, others);
  } else {
    const clientConfig = resolveStrategistClientConfig(spec, runtime);
    const strategistClient: AiClient =
      options.offline === true
        ? offlineClient(engine, 'strategist')
        : new OpenAiCompatibleClient(
            clientConfig,
            capped(runtime.fetchImpl),
            runtime.sleepImpl,
            observeAttempt('strategist', spec.pricing),
          );
    const strategistQueue = new RequestQueue({
      rpmLimit: clientConfig.rpmLimit,
      concurrency: clientConfig.strategistConcurrency,
    });
    coordinator = new StrategyCoordinator(
      strategistClient,
      strategistQueue,
      engine,
      // A decision model's strategist answers in model mode: a plan, not bot knobs.
      coordinatorConfig(
        arm.kind === 'decision' ? { ...config, tacticalMode: 'model' } : config,
        spec,
      ),
      logger,
      others,
    );
  }

  const providers = new Map<PlayerId, AsyncDecisionProvider>();
  return {
    provider(seat) {
      let provider = providers.get(seat);
      if (provider === undefined) {
        const live = new OpenAiDecisionProvider(
          tacticianClient,
          queue,
          engine,
          config,
          logger,
          undefined,
          coordinator,
          jev,
          undefined,
          undefined,
          { botSeed: `duel:${ctx.gameId}:${arm.id}:${seat}` },
        );
        provider =
          spec === undefined || options.race === true
            ? live
            : {
                async decide(request) {
                  coordinator.prepare(request);
                  await coordinator.settled();
                  return live.decide(request);
                },
              };
        providers.set(seat, provider);
      }
      return provider;
    },
    coordinator,
    observe(request, response, source) {
      coordinator.recordAcceptedDecision(request, response);
      // The arm's own seats are recorded by their providers; every other seat's decision is new
      // to this coordinator, and a non-pass one on a planned turn invalidates the plan.
      if (others.has(request.decidingPlayer)) coordinator.recordDecision(request, response, source);
    },
    async finish() {
      coordinator.cancel();
      await coordinator.drained();
      tally.strategistCalls = coordinator.strategistStats.calls;
      tally.strategistReused = coordinator.strategistStats.reused;
    },
    tally,
    sources,
  };
}

/** The production typed-decision policy for a decision-model arm, thresholds off (as bot-bench). */
function decisionPolicy(
  arm: DecisionEntry,
  ctx: GameContext,
  observe: (attempt: AiNetworkAttempt) => void,
): JevActionPolicy {
  const { options, budget } = ctx;
  const base = loadAiConfig(options.env);
  const offline = options.offline === true;
  const apiKey = offline
    ? 'offline'
    : resolveDecisionKey(arm, {
        env: options.env,
        mode: 'production',
        ...(options.decisionTransport !== undefined && {
          decisionTransport: options.decisionTransport,
        }),
      });
  const transport =
    (offline ? offlineDecisions : options.decisionTransport) ?? defaultTransport(apiKey, arm);
  // The Decisions API client has no fetch to wrap, so the cap is checked here, before a request.
  const guarded: JevDecisionsTransport = {
    create(request, requestOptions) {
      if (budget.capUsd !== null && budget.spentUsd >= budget.capUsd) {
        budget.capped = true;
        return Promise.reject(new SpendCapReached());
      }
      return transport.create(request, requestOptions);
    },
  };
  const client = new JevClient(
    {
      apiKey,
      baseUrl: arm.baseUrl ?? OPENROUTER_BASE_URL,
      requestTimeoutMs: arm.requestTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS,
    },
    guarded,
    observe,
  );
  return new JevActionPolicy(
    client,
    new RequestQueue({ rpmLimit: base.rpmLimit, concurrency: 1 }),
    {
      model: arm.model,
      minConfidence: 0,
      minTopTwoMargin: 0,
      maxActions: JEV_MAX_CHOICE_OPTIONS,
      expandTargets: arm.expandTargets ?? true,
      mode: 'active',
      contextOptions: {
        includeMemory: base.contextMemoryEnabled,
        includeFeatures: base.contextFeaturesEnabled,
        useBudgeter: base.contextBudgeterEnabled,
        useCardSummaries: base.contextCardSummariesEnabled,
        inputTokenBudget: base.contextInputTokenBudget,
      },
    },
  );
}

/**
 * The SDK transport `JevClient` builds when it is given none, built here so the spend-cap guard
 * can sit in front of it. One per arm and key.
 */
const transports = new Map<string, JevDecisionsTransport>();
function defaultTransport(apiKey: string, arm: DecisionEntry): JevDecisionsTransport {
  const key = `${arm.baseUrl ?? OPENROUTER_BASE_URL}|${apiKey}`;
  let transport = transports.get(key);
  if (transport === undefined) {
    transport = new OpenRouterJevTransport({
      apiKey,
      baseUrl: arm.baseUrl ?? OPENROUTER_BASE_URL,
      requestTimeoutMs: arm.requestTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS,
    });
    transports.set(key, transport);
  }
  return transport;
}

async function playGame(
  options: DuelOptions,
  pool: ReturnType<typeof buildSupportedPool>,
  deal: number,
  rotation: number,
  budget: Budget,
): Promise<GameRecord> {
  const seed = `${options.seed}-${deal + 1}`;
  const armIds = options.arms.map((arm) => arm.id);
  const seats = seating(armIds, rotation);
  const decks = SEATS.map((_, i) => generateCommanderDeck(pool, { seed: `${seed}-seat${i + 1}` }));
  const gameId = `duel-${seed}-r${rotation}`;
  const engine = new Engine(
    {
      gameId: gameId as GameId,
      seed,
      turnCap: options.turnCap,
      players: decks.map((deck, i) => ({
        id: SEATS[i]!,
        deckId: `duel-${i + 1}`,
        commanders: [deck.commander],
        cards: deck.cards,
      })),
    },
    TABLE_ENGINE_LIMITS,
  );
  const ctx: GameContext = { engine, gameId, options, budget };
  const eliminatedOn = Object.fromEntries(SEATS.map((seat) => [seat, null])) as Record<
    PlayerId,
    number | null
  >;
  const noteEliminations = (turn: number): void => {
    for (const player of engine.getState().players)
      if (player.hasLost === true && eliminatedOn[player.id] === null)
        eliminatedOn[player.id] = turn;
  };
  const arms = new Map<string, ArmGame>();
  for (const arm of options.arms)
    arms.set(
      arm.id,
      armGame(
        arm,
        SEATS.filter((seat) => seats[seat] === arm.id),
        ctx,
      ),
    );
  const started = performance.now();
  let result: Awaited<ReturnType<typeof runToCompletionAsync>> | undefined;
  let error: string | undefined;
  try {
    result = await runToCompletionAsync(
      engine,
      (seat) => arms.get(seats[seat as PlayerId] ?? '')!.provider(seat as PlayerId),
      {
        maxDecisions: 20_000,
        onDecision(request, response) {
          const own = arms.get(seats[request.decidingPlayer] ?? '')!;
          const source = own.sources.get(request.requestId) ?? 'primary';
          own.sources.delete(request.requestId);
          noteEliminations(request.turn);
          for (const arm of arms.values()) arm.observe(request, response, source);
        },
      },
    );
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  // The game is over: stop any strategist call still running instead of paying for it.
  await Promise.all([...arms.values()].map((arm) => arm.finish()));
  const state = engine.getState();
  const life = Object.fromEntries(
    state.players.map((player) => [player.id, player.hasLost === true ? 0 : player.life]),
  ) as Record<PlayerId, number>;
  const winner = result?.winnerSeat ?? null;
  // The engine reports its turn cap as a halt; for a duel it is a draw.
  const turnCapped =
    error === undefined && result?.halted === true && /^turn cap\b/.test(result.haltReason ?? '');
  noteEliminations(result?.turnCount ?? state.turnNumber);
  return {
    deal: deal + 1,
    seed,
    rotation,
    seats,
    commanders: Object.fromEntries(
      SEATS.map((seat, i) => [seat, decks[i]!.commander.name]),
    ) as Record<PlayerId, string>,
    winner,
    winnerArm: winner === null ? null : (seats[winner] ?? null),
    turns: result?.turnCount ?? state.turnNumber,
    finishingOrder: [...(result?.finishingOrder ?? [])].reverse(),
    life,
    eliminatedOn,
    turnCapped,
    halted: !turnCapped && (result === undefined || result.halted),
    ...(!turnCapped &&
      (error ?? result?.haltReason ?? null) !== null && {
        haltReason: error ?? result?.haltReason ?? '',
      }),
    ms: round(performance.now() - started, 0),
    capped: budget.capped,
    perArm: Object.fromEntries([...arms].map(([id, arm]) => [id, arm.tally])),
  };
}

/** Plays every deal once per rotation and summarises per arm. */
export async function runDuel(
  options: DuelOptions,
): Promise<{ games: GameRecord[]; summary: DuelSummary }> {
  checkArms(options.arms);
  const fixture =
    options.fixture ??
    ((await import('node:fs')).readFileSync(DEFAULT_FIXTURE, 'utf8') as unknown as string);
  const pool = buildSupportedPool(
    typeof fixture === 'string' ? (JSON.parse(fixture) as OracleCard[]) : fixture,
  );
  const budget: Budget = { capUsd: options.spendCapUsd, spentUsd: 0, capped: false };
  const schedule: Array<{ deal: number; rotation: number }> = [];
  for (let deal = 0; deal < options.deals; deal++)
    for (let rotation = 0; rotation < options.arms.length; rotation++)
      schedule.push({ deal, rotation });
  const games: GameRecord[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < schedule.length) {
      // Once the cap is reached no new game starts; a game already running finishes on the bot.
      if (budget.capped) return;
      const next = schedule[cursor++]!;
      const game = await playGame(options, pool, next.deal, next.rotation, budget);
      games.push(game);
      options.onGame?.(game);
      options.onProgress?.(
        `deal ${game.deal} rotation ${game.rotation}: ${game.winnerArm ?? (game.halted ? 'halted' : game.turnCapped ? 'draw at the turn cap' : 'draw')} in ${game.turns} turns (${(game.ms / 1000).toFixed(1)} s${game.capped ? ', spend cap reached' : ''})`,
      );
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(options.jobs, schedule.length)) }, worker),
  );
  games.sort((a, b) => a.deal - b.deal || a.rotation - b.rotation);
  return { games, summary: summarise(options.arms, games, budget) };
}

const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

export function summarise(
  arms: readonly LineupEntry[],
  games: readonly GameRecord[],
  budget: { spentUsd: number; capped: boolean },
): DuelSummary {
  const seatsPerArm = SEATS.length / arms.length;
  const summaries = arms.map((arm): ArmSummary => {
    const totals = emptyArmTally();
    for (const game of games) {
      const tally = game.perArm[arm.id];
      if (tally !== undefined) addTally(totals, tally);
    }
    const ended = games.filter((game) => !game.halted);
    const mine = (game: GameRecord): PlayerId[] =>
      SEATS.filter((seat) => game.seats[seat] === arm.id);
    const lifeShares = ended.flatMap((game) => {
      const all = SEATS.reduce((sum, seat) => sum + (game.life[seat] ?? 0), 0);
      return all === 0
        ? []
        : [mine(game).reduce((sum, seat) => sum + (game.life[seat] ?? 0), 0) / all];
    });
    const eliminations = ended.flatMap((game) =>
      mine(game).flatMap((seat) => {
        const turn = game.eliminatedOn[seat];
        return turn === null || turn === undefined ? [] : [turn];
      }),
    );
    const per = (value: number): number | null =>
      games.length === 0 ? null : value / games.length;
    return {
      id: arm.id,
      label: entryLabel(arm),
      games: games.length,
      seats: games.length * seatsPerArm,
      wins: ended.filter((game) => game.winnerArm === arm.id).length,
      draws: ended.filter((game) => game.winner === null).length,
      halted: games.length - ended.length,
      winRate:
        ended.length === 0
          ? null
          : ended.filter((game) => game.winnerArm === arm.id).length / ended.length,
      lifeShare: mean(lifeShares),
      meanEliminationTurn: mean(eliminations),
      costUsd: round(totals.costUsd, 6),
      costPerGameUsd: per(totals.costUsd) === null ? null : round(per(totals.costUsd)!, 6),
      costIsLowerBound: totals.unpricedAttempts > 0,
      tacticianRequestsPerGame: per(totals.requests.tactician),
      strategistCallsPerGame: per(totals.strategistCalls),
      decisionRequestsPerGame: per(totals.requests.decision),
      fallbackShare: fallbackShare(totals),
      totals,
    };
  });
  return {
    arms: summaries,
    games: games.length,
    fairWinRate: seatsPerArm / SEATS.length,
    meanTurns: mean(games.map((game) => game.turns)),
    spendUsd: round(budget.spentUsd, 6),
    capped: budget.capped,
  };
}

const pct = (value: number | null): string =>
  value === null ? '-' : `${(value * 100).toFixed(0)}%`;
const usd = (value: number | null, lowerBound = false): string =>
  value === null
    ? '-'
    : `${lowerBound ? '≥ ' : ''}$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
const num = (value: number | null): string => (value === null ? '-' : value.toFixed(1));

/** The summary as Markdown, for `summary.md` and the console. */
export function renderDuel(
  options: Pick<DuelOptions, 'arms' | 'seed' | 'turnCap' | 'race' | 'offline'>,
  games: readonly GameRecord[],
  summary: DuelSummary,
): string {
  const rows = summary.arms.map((arm) => [
    arm.label,
    `${arm.wins} / ${arm.games - arm.halted}`,
    pct(arm.winRate),
    pct(arm.lifeShare),
    num(arm.meanEliminationTurn),
    usd(arm.costPerGameUsd, arm.costIsLowerBound),
    num(arm.tacticianRequestsPerGame),
    num(arm.strategistCallsPerGame),
    num(arm.decisionRequestsPerGame),
    pct(arm.fallbackShare),
  ]);
  const table = [
    '| Arm | Wins | Win rate | Life share | Mean turn knocked out | Cost / game | Chat tactician requests / game | Strategist calls / game | Decision-model requests / game | Fallback share |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
  const unfair = summary.arms.filter((arm) => (arm.fallbackShare ?? 0) > 0.05);
  const lines = [
    `# Duel: ${summary.arms.map((arm) => arm.id).join(' vs ')}`,
    '',
    `${options.offline === true ? '**Offline: no network, models replaced by the bot. A wiring check only.** ' : ''}Seed \`${options.seed}\`, turn cap ${options.turnCap}, ${summary.games} games (${summary.games / Math.max(1, options.arms.length)} deals × ${options.arms.length} rotations), mean ${num(summary.meanTurns)} turns. ${options.race === true ? 'Tacticians raced their strategists, as in a live game.' : 'Each seat waited for its strategist before its first decision of a turn.'}`,
    '',
    `A fair arm wins ${pct(summary.fairWinRate)} of ended games. Spend ${usd(summary.spendUsd)}${summary.capped ? " (spend cap reached: later model decisions were the bot's, and no further game started)" : ''}.`,
    '',
    table,
    '',
    "Games the turn cap ended are draws. *Life share* is the share of all life left at the end held by the arm's seats. *Mean turn knocked out* is over the arm's eliminated seats only. *Fallback share* is the share of decisions the arm's model was asked that the bot had to play instead; above 5% the model did not get a fair game. A decision model's attacks and blocks are always the bot's and are not counted as fallbacks.",
    '',
    ...(unfair.length === 0
      ? []
      : [
          `> **Not a fair test for ${unfair.map((arm) => arm.label).join(', ')}:** more than 5% of the model's decisions fell back to the bot.`,
          '',
        ]),
    '## Games',
    '',
    '| Deal | Rotation | Seats (P1 P2 P3 P4) | Winner | Turns | Halted |',
    '| --- | --- | --- | --- | --- | --- |',
    ...games.map(
      (game) =>
        `| ${game.deal} | ${game.rotation} | ${SEATS.map((seat) => game.seats[seat]).join(' ')} | ${game.winner === null ? (game.turnCapped ? 'none (turn cap)' : 'none') : `${game.winner} (${game.winnerArm})`} | ${game.turns} | ${game.halted ? (game.haltReason ?? 'yes') : ''} |`,
    ),
    '',
  ];
  return lines.join('\n');
}

/** What is safe to store about the arms: everything but where their keys come from. */
export function publicArms(arms: readonly LineupEntry[]): Record<string, unknown>[] {
  return arms.map((arm) => publicEntry(arm));
}
