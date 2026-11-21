/**
 * One paid four-player game that seats both tactical modes at the same table (ADR 0039): P1 and
 * P3 play `AI_TACTICAL_MODE=bot` (the bot plays, the strategist sets knobs), P2 and P4 play
 * `AI_TACTICAL_MODE=model` (the model tactician, the default). Everything else comes from the environment
 * (`.env` is read by Bun), so the endpoint, models and key are the same ones the app uses.
 *
 *   bun run ai-mode-duel [--seed S] [--turn-cap N] [--max-usd N] [--max-calls N] [--swap] [--json out.json]
 *                        [--escalation T1,T2] [--shadow T1,T2] [--opponents model|bot-never|bot-v1]
 *                        [--delta] [--await-strategist]
 *                        [--offline] [--trace out.jsonl]
 *
 * ADR 0044's game step: `--escalation` makes triggers live for the bot seats (default `never`),
 * `--shadow` logs others, and `--opponents bot-never` seats the bot-led bot with no escalation in
 * P2 and P4 instead of the model tactician, so a trigger is played against `never`.
 *
 * `--delta` gives the `bot` seats strategist delta prompts (hill-climb S6) and turns them off for
 * the others, so with `--opponents bot-never` the two sides differ only in the strategist prompt.
 * Without it every seat uses the configured default (delta prompts on since 2026-11-18).
 *
 * Hill-climb S7: `--opponents bot-v1` seats the same bot-led setup in P2 and P4 but waking the
 * strategist under `table-v1`, while P1 and P3 use `table-v2`, so the wake rule is the only
 * difference. The strategist calls per mode are the saving; the winner is the strength check.
 *
 * `--await-strategist` makes every decision wait for the seat's in-flight strategist call first.
 * It is on by default with `--opponents bot-never` and `bot-v1`: four bot-led seats finish a game
 * in seconds, long before a strategist answers, so every call would be cancelled at game end and
 * the game would measure nothing (2026-11-16: 46 turns, 0 answered calls).
 *
 * Spend caps: once the provider-reported cost reaches `--max-usd` (default 2) or the call count
 * reaches `--max-calls` (default 1500), no further model call is made and every seat plays the
 * rest of the game on the bot fallback; the report says the cap was hit.
 *
 * `--offline` plays the same game with no key and no network: the tactician is the bot and the
 * strategist returns fixed knobs. It checks the decks, seating, report and cost settlement for
 * free before a paid run; its numbers say nothing about play quality.
 *
 * `--swap` seats the modes the other way round, for a second game on the same decks. The report
 * counts real model calls, prompt and response tokens and reported cost per mode, and who won.
 * Nothing here prints or stores the API key.
 *
 * `--trace` writes one JSON line per decision (`decision-trace.ts`): the seat, its menu, the answer,
 * who answered it, the triggers that fired and the knobs in force, so a lost game can be reviewed.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DecisionRequest, OracleCard, PlayerId } from '@mtg/shared';
import { Engine, runToCompletionAsync } from '@mtg/engine';
import { decide as botDecide, Rng } from '@mtg/bot';
import { TABLE_ENGINE_LIMITS } from '../match/engine-limits';
import { buildSupportedPool } from '../cards/pool';
import { generateCommanderDeck } from '../decks/generate';
import { DecisionTraceWriter, decisionTraceLine } from './decision-trace';
import { parseTriggerList, type LiveEscalationTrigger } from '../ai/config';
import {
  AiCallLogger,
  configForRole,
  loadAiConfig,
  OpenAiCompatibleClient,
  OpenAiDecisionProvider,
  RequestQueue,
  StrategyCoordinator,
  type AiConfig,
} from '../ai';
import type { AiAttemptObserver, AiClient, CostSettlement } from '../ai/client';
import type { AiPrompt } from '../ai/context';
import type { AsyncDecisionProvider } from '@mtg/engine';
import { knowledgeFor } from '../ai/bot-tactician';
import { localCallMeta } from '../ai/logger';

const FIXTURE = 'packages/server/fixtures/coverage-oracle.json';
const SEATS: PlayerId[] = ['P1', 'P2', 'P3', 'P4'];
export type ModeName = 'bot' | 'model';

/**
 * A provider that lets the seat's strategist call land before each decision. `prepare` starts the
 * call if this turn has none yet (it is idempotent per turn), and `settled` waits for the newest.
 */
export function awaitingStrategist(
  provider: AsyncDecisionProvider,
  coordinator: Pick<StrategyCoordinator, 'prepare' | 'settled'>,
): AsyncDecisionProvider {
  return {
    async decide(request) {
      coordinator.prepare(request);
      await coordinator.settled();
      return provider.decide(request);
    },
  };
}

export interface Tally {
  tacticianCalls: number;
  strategistCalls: number;
  promptTokens: number;
  responseTokens: number;
  /** Prompt tokens the provider reported serving from its prompt cache, over every attempt. */
  cacheReadTokens: number;
  costUsd: number;
  costKnown: boolean;
  /** Calls that failed after the client's own retries; the seat fell back to the bot. */
  failedCalls: number;
  /** The tactician share of `failedCalls`: decisions a model seat meant to ask the model about. */
  failedTacticianCalls: number;
  /** Rejected or timed-out attempts that reported tokens but no price; their cost is not in costUsd. */
  unpricedAttempts: number;
  /** Accepted calls that came back with no price; the cost stays unknown until settled. */
  unknownCostCalls: number;
  /** Billed cost of unpriced attempts, read from OpenRouter's generation stats after the game. */
  settledUsd: number;
  /** Unpriced attempts whose billed cost could not be found after the game. */
  unsettledAttempts: number;
  /** Physical attempts per serving provider, as OpenRouter names it (`provider` in the reply). */
  providers: Record<string, number>;
}

export function emptyTally(): Tally {
  return {
    tacticianCalls: 0,
    strategistCalls: 0,
    promptTokens: 0,
    responseTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    costKnown: true,
    failedCalls: 0,
    failedTacticianCalls: 0,
    unpricedAttempts: 0,
    unknownCostCalls: 0,
    settledUsd: 0,
    unsettledAttempts: 0,
    providers: {},
  };
}

export interface Budget {
  maxUsd: number;
  maxCalls: number;
  spentUsd: number;
  calls: number;
  capped: boolean;
}

/**
 * A `fetch` that enforces the duel's caps on every physical POST, so the client's own retries
 * (a rejected completion, a timeout) cannot spend past them. A capped request throws before it
 * is sent. GETs (the provider list) are free and pass through.
 */
export function budgetedFetch(budget: Budget, inner: typeof fetch = fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST') {
      if (budget.spentUsd >= budget.maxUsd || budget.calls >= budget.maxCalls) {
        budget.capped = true;
        throw new Error('ai-mode-duel spend cap reached');
      }
      budget.calls++;
    }
    return inner(input, init);
  }) as typeof fetch;
}

/**
 * Wraps a real client so every call is charged to the mode of the seat it was made for. A billed
 * completion the client rejects (malformed JSON, empty content) never reaches the result, so its
 * usage is taken from the client's attempt record instead; accepted attempts are counted from the
 * result, so nothing is charged twice.
 */
export function counting<M extends string = ModeName>(
  inner: CountableClient,
  role: 'tactician' | 'strategist',
  modeOf: (seat: PlayerId) => M,
  tallies: Record<M, Tally>,
  budget: Budget,
): CountingClient {
  const modeByRequest = new Map<string, M>();
  // Kept after a call ends, so a cost settled after the game still finds its seat's mode.
  const settledModeByRequest = new Map<string, M>();
  let outer: AiAttemptObserver | undefined;
  const charge = (tally: Tally, promptTokens = 0, responseTokens = 0, costUsd?: number): void => {
    tally.promptTokens += promptTokens;
    tally.responseTokens += responseTokens;
    if (typeof costUsd === 'number') {
      tally.costUsd += costUsd;
      budget.spentUsd += costUsd;
    } else {
      tally.unknownCostCalls++;
      tally.costKnown = false;
    }
  };
  inner.setAttemptObserver(async (attempt) => {
    const mode = modeByRequest.get(attempt.logicalRequestId);
    if (mode !== undefined) tallies[mode].cacheReadTokens += attempt.usage.cacheReadTokens ?? 0;
    if (mode !== undefined && attempt.backend !== undefined) {
      const providers = tallies[mode].providers;
      providers[attempt.backend] = (providers[attempt.backend] ?? 0) + 1;
    }
    if (mode !== undefined && attempt.status !== 'accepted') {
      const { promptTokens, responseTokens, costUsd } = attempt.usage;
      const tally = tallies[mode];
      if (costUsd === undefined) {
        // A timed-out or failed attempt may carry token estimates but no price. Count it apart
        // instead of marking the whole mode's cost unknown.
        if (promptTokens !== undefined || responseTokens !== undefined) {
          tally.unpricedAttempts++;
          charge(tally, promptTokens, responseTokens, 0);
        }
      } else {
        charge(tally, promptTokens, responseTokens, costUsd);
      }
    }
    await outer?.(attempt);
  });
  return {
    get activeModel() {
      return inner.activeModel;
    },
    setAttemptObserver(observer) {
      outer = observer;
    },
    async requestDecision(prompt: AiPrompt, request: DecisionRequest, signal?: AbortSignal) {
      const mode = modeOf(request.decidingPlayer);
      const tally = tallies[mode];
      if (budget.spentUsd >= budget.maxUsd || budget.calls >= budget.maxCalls) {
        // Thrown before any request is sent: the provider falls back to the bot, for free. Each
        // physical attempt is also capped (and counted) by `budgetedFetch`.
        budget.capped = true;
        throw new Error('ai-mode-duel spend cap reached');
      }
      modeByRequest.set(request.requestId, mode);
      settledModeByRequest.set(request.requestId, mode);
      let result: Awaited<ReturnType<AiClient['requestDecision']>>;
      try {
        result = await inner.requestDecision(prompt, request, signal);
      } catch (error) {
        // A call stopped by the duel's own spend cap is not a provider failure, so it stays out of
        // the fallback share that judges whether the model seats got a fair game.
        if (!budget.capped) {
          tally.failedCalls++;
          if (role === 'tactician') tally.failedTacticianCalls++;
        }
        throw error;
      } finally {
        modeByRequest.delete(request.requestId);
      }
      if (role === 'tactician') tally.tacticianCalls++;
      else tally.strategistCalls++;
      charge(tally, result.meta.promptTokens, result.meta.responseTokens, result.meta.costUsd);
      return result;
    },
    async settle(options) {
      const settlement = await inner.settleUnknownCosts(options);
      for (const attempt of settlement.attempts) {
        const mode = settledModeByRequest.get(attempt.logicalRequestId);
        if (mode === undefined) continue;
        const tally = tallies[mode];
        const billed = attempt.billed?.costUsd;
        if (typeof billed !== 'number') {
          tally.unsettledAttempts++;
          continue;
        }
        tally.settledUsd += billed;
        tally.costUsd += billed;
        budget.spentUsd += billed;
        // An accepted call charged with no price is now priced; when every such call is, the
        // mode's cost is known again. A failed attempt was already charged at 0.
        if (attempt.status === 'accepted' && tally.unknownCostCalls > 0) {
          tally.unknownCostCalls--;
          if (tally.unknownCostCalls === 0) tally.costKnown = true;
        }
      }
      return settlement;
    },
  };
}

/** The parts of `OpenAiCompatibleClient` that `counting` uses, so tests and offline runs can stub it. */
export type CountableClient = Pick<
  OpenAiCompatibleClient,
  'activeModel' | 'requestDecision' | 'setAttemptObserver' | 'settleUnknownCosts'
>;

export interface CountingClient extends AiClient {
  /** Look up what OpenRouter billed for unpriced attempts and add it to each mode's tally. */
  settle(
    options?: Parameters<OpenAiCompatibleClient['settleUnknownCosts']>[0],
  ): Promise<CostSettlement>;
}

/** Offline chat clients: the tactician is the bot, the strategist returns fixed knobs. */
export function offlineChatClient(
  engine: Engine,
  role: 'tactician' | 'strategist',
): CountableClient {
  const knowledge = knowledgeFor(engine);
  return {
    activeModel: `offline-${role}`,
    setAttemptObserver(_observer: AiAttemptObserver | undefined) {},
    settleUnknownCosts: () => Promise.resolve({ attempts: [], settledUsd: 0, unresolved: 0 }),
    requestDecision(_prompt, request: DecisionRequest) {
      if (role === 'strategist') {
        return Promise.resolve({
          response: {
            requestId: request.requestId,
            actionId: 0,
            turnStrategy: { intent: 'offline', plannedActions: [], steering: { aggression: 0.5 } },
          },
          meta: { ...localCallMeta(), costUsd: 0 },
        });
      }
      const view = engine.view(request.decidingPlayer);
      const response = botDecide(request, view, new Rng(request.requestId), { knowledge });
      return Promise.resolve({ response, meta: { ...localCallMeta(), costUsd: 0 } });
    },
  } as CountableClient;
}

/** Failed tactician calls over all tactician calls attempted (failed ones included). */
export function fallbackShare(t: Tally): number {
  const attempted = t.tacticianCalls + t.failedTacticianCalls;
  return attempted === 0 ? 0 : Number((t.failedTacticianCalls / attempted).toFixed(3));
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

/**
 * Per-seat bookkeeping for the report, so strategist calls can be read per seat turn instead of
 * per game turn: a side whose seats live longer is asked more often whatever its wake rule. A
 * seat's own turns are the game turns on which a decision surfaced with it as the active player;
 * its elimination turn is the first observed turn after which it has lost.
 */
export class SeatTracker {
  private readonly ownTurns = new Map<PlayerId, Set<number>>();
  private readonly eliminatedOn = new Map<PlayerId, number>();

  observe(request: Pick<DecisionRequest, 'turn' | 'activePlayer'>, lost: Iterable<PlayerId>): void {
    let turns = this.ownTurns.get(request.activePlayer);
    if (turns === undefined) {
      turns = new Set();
      this.ownTurns.set(request.activePlayer, turns);
    }
    turns.add(request.turn);
    for (const seat of lost) {
      if (!this.eliminatedOn.has(seat)) this.eliminatedOn.set(seat, request.turn);
    }
  }

  /** Seats that lost on the last action of the game are only seen in the final state. */
  finish(finalTurn: number, lost: Iterable<PlayerId>): void {
    for (const seat of lost) {
      if (!this.eliminatedOn.has(seat)) this.eliminatedOn.set(seat, finalTurn);
    }
  }

  ownTurnsOf(seat: PlayerId): number {
    return this.ownTurns.get(seat)?.size ?? 0;
  }

  eliminationTurnOf(seat: PlayerId): number | null {
    return this.eliminatedOn.get(seat) ?? null;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const seed = arg(argv, '--seed') ?? 'mode-duel';
  const turnCap = Number(arg(argv, '--turn-cap') ?? 60);
  const swap = argv.includes('--swap');
  const json = arg(argv, '--json');
  const offline = argv.includes('--offline');
  const tracePath = arg(argv, '--trace');
  const budget: Budget = {
    maxUsd: Number(arg(argv, '--max-usd') ?? 2),
    maxCalls: Number(arg(argv, '--max-calls') ?? 1500),
    spentUsd: 0,
    calls: 0,
    capped: false,
  };

  const base = loadAiConfig(process.env);
  if (!offline && !base.apiKey) {
    console.error('No AI API key found in the environment or .env; nothing was played.');
    process.exitCode = 1;
    return;
  }
  const modeOf = (seat: PlayerId): ModeName =>
    (SEATS.indexOf(seat) % 2 === 0) !== swap ? 'bot' : 'model';
  const escalation = parseTriggerList(arg(argv, '--escalation'), '--escalation');
  if (escalation.includes('lethal'))
    throw new Error('--escalation: lethal is shadow-only (ADR 0044)');
  const shadow = parseTriggerList(arg(argv, '--shadow'), '--shadow');
  const opponents = arg(argv, '--opponents') ?? 'model';
  if (opponents !== 'model' && opponents !== 'bot-never' && opponents !== 'bot-v1')
    throw new Error('--opponents must be model, bot-never or bot-v1');
  const delta = argv.includes('--delta');
  const awaitStrategist = argv.includes('--await-strategist') || opponents !== 'model';
  const configs: Record<ModeName, AiConfig> = {
    bot: {
      ...base,
      ...(delta ? { strategistDeltaEnabled: true } : {}),
      tacticalMode: 'bot',
      botEscalation: escalation as LiveEscalationTrigger[],
      botEscalationShadow: shadow,
      strategistReplan: 'onChange',
      ...(opponents === 'bot-v1' ? { strategistWakeRule: 'table-v2' as const } : {}),
    },
    model:
      opponents === 'model'
        ? { ...base, tacticalMode: 'model', ...(delta ? { strategistDeltaEnabled: false } : {}) }
        : opponents === 'bot-v1'
          ? {
              ...base,
              ...(delta ? { strategistDeltaEnabled: false } : {}),
              tacticalMode: 'bot',
              botEscalation: escalation as LiveEscalationTrigger[],
              botEscalationShadow: shadow,
              strategistReplan: 'onChange',
              strategistWakeRule: 'table-v1',
            }
          : {
              ...base,
              ...(delta ? { strategistDeltaEnabled: false } : {}),
              tacticalMode: 'bot',
              botEscalation: [],
              botEscalationShadow: shadow,
              strategistReplan: 'onChange',
            },
  };

  const pool = buildSupportedPool(
    JSON.parse(readFileSync(resolve(FIXTURE), 'utf8')) as OracleCard[],
  );
  const decks = SEATS.map((_, i) => generateCommanderDeck(pool, { seed: `${seed}-seat${i + 1}` }));
  // Table limits, so a runaway loop halts the game (and is reported) instead of eating memory.
  const engine = new Engine(
    {
      gameId: `mode-duel-${seed}`,
      seed,
      turnCap,
      players: decks.map((d, i) => ({
        id: SEATS[i]!,
        deckId: `duel-${i + 1}`,
        commanders: [d.commander],
        cards: d.cards,
      })),
    },
    TABLE_ENGINE_LIMITS,
  );

  console.log(
    `${offline ? 'OFFLINE (no network, numbers are a wiring check) — ' : ''}Seed ${seed}, turn cap ${turnCap}`,
  );
  // With `--opponents bot-never` the "model" seats play the bot-led bot that never escalates.
  const label = (mode: ModeName): string =>
    mode === 'model' && opponents !== 'model'
      ? opponents
      : mode === 'bot' && delta
        ? 'bot+delta'
        : mode;
  decks.forEach((d, i) =>
    console.log(`  ${SEATS[i]} [${label(modeOf(SEATS[i]!))}]  ${d.commander.name}`),
  );
  console.log(`  Endpoint: ${base.baseUrl}`);
  console.log(`  Strategist: ${base.strategist.models.join(' → ')}`);
  console.log(`  Tactician: ${base.tactician.models.join(' → ')}`);

  const tallies: Record<ModeName, Tally> = { bot: emptyTally(), model: emptyTally() };
  const strategistClient = counting(
    offline
      ? offlineChatClient(engine, 'strategist')
      : new OpenAiCompatibleClient(configForRole(base, 'strategist'), budgetedFetch(budget)),
    'strategist',
    modeOf,
    tallies,
    budget,
  );
  const tacticianClient = counting(
    offline
      ? offlineChatClient(engine, 'tactician')
      : new OpenAiCompatibleClient(configForRole(base, 'tactician'), budgetedFetch(budget)),
    'tactician',
    modeOf,
    tallies,
    budget,
  );
  const queue = new RequestQueue(base);
  const logger = new AiCallLogger(null, `mode-duel-${seed}`);

  // One coordinator per mode, each blind to the other mode's turns, so each seat gets the
  // strategist prompt and re-plan rule of its own mode.
  const coordinators = {} as Record<ModeName, StrategyCoordinator>;
  for (const mode of ['bot', 'model'] as const) {
    const others = new Set(SEATS.filter((s) => modeOf(s) !== mode));
    coordinators[mode] = new StrategyCoordinator(
      strategistClient,
      queue,
      engine,
      configs[mode],
      logger,
      others,
    );
  }
  const trace = tracePath === undefined ? undefined : new DecisionTraceWriter(tracePath);
  const lifeNow = (): Record<string, number> =>
    Object.fromEntries(
      engine.getState().players.map((p) => [p.id, p.hasLost === true ? 0 : p.life]),
    );
  // What the bot-led tactician reported for each decision it was consulted on.
  const botOutcomes = new Map<
    string,
    { escalated: boolean; reasons: readonly string[]; escalatedBy?: string }
  >();
  const providers = new Map<PlayerId, AsyncDecisionProvider>();
  const tracker = new SeatTracker();
  const lostSeats = (): PlayerId[] =>
    engine
      .getState()
      .players.filter((p) => p.hasLost === true)
      .map((p) => p.id);
  const started = performance.now();
  const result = await runToCompletionAsync(
    engine,
    (seat) => {
      let provider = providers.get(seat);
      if (provider === undefined) {
        const mode = modeOf(seat);
        const live = new OpenAiDecisionProvider(
          tacticianClient,
          queue,
          engine,
          configs[mode],
          logger,
          undefined,
          coordinators[mode],
          undefined,
          undefined,
          undefined,
          {
            onBotDecision(request, outcome) {
              if (trace !== undefined) botOutcomes.set(request.requestId, outcome);
            },
          },
        );
        const coordinator = coordinators[mode];
        // `--trace`: one line per decision, with the view as the seat saw it when deciding.
        const traced: AsyncDecisionProvider =
          trace === undefined
            ? live
            : {
                async decide(request) {
                  const view = engine.view(request.decidingPlayer);
                  const life = lifeNow();
                  const response = await live.decide(request);
                  const bot = botOutcomes.get(request.requestId);
                  botOutcomes.delete(request.requestId);
                  const steering = coordinator.steeringFor(request.decidingPlayer);
                  trace.write(
                    decisionTraceLine({
                      request,
                      response,
                      view,
                      mode: modeOf(seat),
                      source: logger.sourceFor(request.requestId) ?? 'unknown',
                      ...(bot !== undefined && { bot }),
                      ...(steering !== undefined && { steering }),
                      life,
                    }),
                  );
                  return response;
                },
              };
        provider = awaitStrategist ? awaitingStrategist(traced, coordinator) : traced;
        providers.set(seat, provider);
      }
      return provider;
    },
    {
      maxDecisions: 20_000,
      onDecision(request) {
        tracker.observe(request, lostSeats());
        if (request.decidingPlayer === request.activePlayer && request.step === null) {
          process.stderr.write(`\r  turn ${request.turn}  `);
        }
      },
    },
  );
  // The game is over: abort any strategist call still running instead of paying for it.
  for (const c of Object.values(coordinators)) c.cancel();
  await Promise.all(Object.values(coordinators).map((c) => c.drained()));
  process.stderr.write('\n');
  // Timed-out and unpriced calls are billed too (ADR 0040); read their cost before reporting.
  await Promise.all([strategistClient.settle(), tacticianClient.settle()]);

  const life: Record<string, number> = {};
  for (const player of engine.getState().players) {
    life[player.id] = player.hasLost === true ? 0 : player.life;
  }
  const turns = result.turnCount;
  tracker.finish(turns, lostSeats());
  trace?.write({
    kind: 'end',
    turns,
    winner: result.winnerSeat,
    winnerMode: result.winnerSeat === null ? null : modeOf(result.winnerSeat),
    finishingOrder: result.finishingOrder,
    life,
  });
  const report = {
    seed,
    swap,
    offline,
    spendCap: {
      maxUsd: budget.maxUsd,
      maxCalls: budget.maxCalls,
      reached: budget.capped,
      spentUsd: Number(budget.spentUsd.toFixed(4)),
    },
    turns,
    minutes: Number(((performance.now() - started) / 60_000).toFixed(1)),
    winner: result.winnerSeat,
    winnerMode: result.winnerSeat === null ? null : modeOf(result.winnerSeat),
    finishingOrder: result.finishingOrder,
    halted: result.halted,
    haltReason: result.haltReason,
    ...(result.haltSite === undefined ? {} : { haltSite: result.haltSite }),
    life,
    /** Each seat's own turns played and the game turn it was eliminated on (null: it survived). */
    seatTurns: Object.fromEntries(
      SEATS.map((s) => [
        s,
        { ownTurns: tracker.ownTurnsOf(s), eliminatedOnTurn: tracker.eliminationTurnOf(s) },
      ]),
    ),
    seats: Object.fromEntries(SEATS.map((s) => [s, modeOf(s)])),
    /** What the `model` seats played: the model tactician, or the bot-led bot with no escalation. */
    opponents,
    /** Whether the `bot` seats' strategist got delta prompts (S6). */
    delta,
    /** Whether each decision waited for its seat's strategist call to land. */
    awaitStrategist,
    escalation,
    shadow,
    perMode: Object.fromEntries(
      (['bot', 'model'] as const).map((mode) => {
        const t = tallies[mode];
        const calls = t.tacticianCalls + t.strategistCalls;
        const ownTurns = SEATS.filter((s) => modeOf(s) === mode).reduce(
          (sum, s) => sum + tracker.ownTurnsOf(s),
          0,
        );
        return [
          mode,
          {
            ...t,
            ownTurns,
            strategistCallsPerOwnTurn: Number(
              (t.strategistCalls / Math.max(1, ownTurns)).toFixed(3),
            ),
            promptTokensPerOwnTurn: Math.round(t.promptTokens / Math.max(1, ownTurns)),
            /** Wake reasons of this side's strategist calls, seat dropped (hill-climb S7). */
            strategistWakes: { ...coordinators[mode].strategistStats.wakes },
            costUsd: t.costKnown ? Number(t.costUsd.toFixed(4)) : null,
            callsPerTurn: Number((calls / Math.max(1, turns)).toFixed(2)),
            // Share of tactician calls that failed and fell back to the bot. Above 0.05 for the
            // model seats, the duel is not a fair test of the model tactician (ADR 0039).
            tacticianFallbackShare: fallbackShare(t),
            promptTokensPerTurn: Math.round(t.promptTokens / Math.max(1, turns)),
            cacheReadSharePct:
              t.promptTokens === 0
                ? 0
                : Number(((t.cacheReadTokens / t.promptTokens) * 100).toFixed(1)),
          },
        ];
      }),
    ),
  };
  console.log(JSON.stringify(report, null, 2));
  if (json !== undefined) writeFileSync(json, JSON.stringify(report, null, 2));
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
}
