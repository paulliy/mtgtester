/**
 * One paid four-player game that seats both tactical modes at the same table (ADR 0039): P1 and
 * P3 play `AI_TACTICAL_MODE=bot` (the bot plays, the strategist sets knobs), P2 and P4 play
 * `AI_TACTICAL_MODE=model` (today's model tactician). Everything else comes from the environment
 * (`.env` is read by Bun), so the endpoint, models and key are the same ones the app uses.
 *
 *   bun run ai-mode-duel [--seed S] [--turn-cap N] [--max-usd N] [--max-calls N] [--swap] [--json out.json]
 *
 * Spend caps: once the provider-reported cost reaches `--max-usd` (default 2) or the call count
 * reaches `--max-calls` (default 1500), no further model call is made and every seat plays the
 * rest of the game on the bot fallback; the report says the cap was hit.
 *
 * `--swap` seats the modes the other way round, for a second game on the same decks. The report
 * counts real model calls, prompt and response tokens and reported cost per mode, and who won.
 * Nothing here prints or stores the API key.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DecisionRequest, OracleCard, PlayerId } from '@mtg/shared';
import { Engine, runToCompletionAsync } from '@mtg/engine';
import { buildSupportedPool } from '../cards/pool';
import { generateCommanderDeck } from '../decks/generate';
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

const FIXTURE = 'packages/server/fixtures/coverage-oracle.json';
const SEATS: PlayerId[] = ['P1', 'P2', 'P3', 'P4'];
export type ModeName = 'bot' | 'model';

export interface Tally {
  tacticianCalls: number;
  strategistCalls: number;
  promptTokens: number;
  responseTokens: number;
  costUsd: number;
  costKnown: boolean;
  /** Calls that failed after the client's own retries; the seat fell back to the bot. */
  failedCalls: number;
  /** Rejected or timed-out attempts that reported tokens but no price; their cost is not in costUsd. */
  unpricedAttempts: number;
  /** Accepted calls that came back with no price; the cost stays unknown until settled. */
  unknownCostCalls: number;
  /** Billed cost of unpriced attempts, read from OpenRouter's generation stats after the game. */
  settledUsd: number;
  /** Unpriced attempts whose billed cost could not be found after the game. */
  unsettledAttempts: number;
}

export function emptyTally(): Tally {
  return {
    tacticianCalls: 0,
    strategistCalls: 0,
    promptTokens: 0,
    responseTokens: 0,
    costUsd: 0,
    costKnown: true,
    failedCalls: 0,
    unpricedAttempts: 0,
    unknownCostCalls: 0,
    settledUsd: 0,
    unsettledAttempts: 0,
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
export function counting(
  inner: OpenAiCompatibleClient,
  role: 'tactician' | 'strategist',
  modeOf: (seat: PlayerId) => ModeName,
  tallies: Record<ModeName, Tally>,
  budget: Budget,
): CountingClient {
  const modeByRequest = new Map<string, ModeName>();
  // Kept after a call ends, so a cost settled after the game still finds its seat's mode.
  const settledModeByRequest = new Map<string, ModeName>();
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
        tally.failedCalls++;
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

export interface CountingClient extends AiClient {
  /** Look up what OpenRouter billed for unpriced attempts and add it to each mode's tally. */
  settle(
    options?: Parameters<OpenAiCompatibleClient['settleUnknownCosts']>[0],
  ): Promise<CostSettlement>;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const seed = arg(argv, '--seed') ?? 'mode-duel';
  const turnCap = Number(arg(argv, '--turn-cap') ?? 60);
  const swap = argv.includes('--swap');
  const json = arg(argv, '--json');
  const budget: Budget = {
    maxUsd: Number(arg(argv, '--max-usd') ?? 2),
    maxCalls: Number(arg(argv, '--max-calls') ?? 1500),
    spentUsd: 0,
    calls: 0,
    capped: false,
  };

  const base = loadAiConfig(process.env);
  if (!base.apiKey) {
    console.error('No AI API key found in the environment or .env; nothing was played.');
    process.exitCode = 1;
    return;
  }
  const modeOf = (seat: PlayerId): ModeName =>
    (SEATS.indexOf(seat) % 2 === 0) !== swap ? 'bot' : 'model';
  const configs: Record<ModeName, AiConfig> = {
    bot: { ...base, tacticalMode: 'bot', botEscalation: 'never', strategistReplan: 'onChange' },
    model: { ...base, tacticalMode: 'model' },
  };

  const pool = buildSupportedPool(
    JSON.parse(readFileSync(resolve(FIXTURE), 'utf8')) as OracleCard[],
  );
  const decks = SEATS.map((_, i) => generateCommanderDeck(pool, { seed: `${seed}-seat${i + 1}` }));
  const engine = new Engine({
    gameId: `mode-duel-${seed}`,
    seed,
    turnCap,
    players: decks.map((d, i) => ({
      id: SEATS[i]!,
      deckId: `duel-${i + 1}`,
      commanders: [d.commander],
      cards: d.cards,
    })),
  });

  console.log(`Seed ${seed}, turn cap ${turnCap}`);
  decks.forEach((d, i) => console.log(`  ${SEATS[i]} [${modeOf(SEATS[i]!)}]  ${d.commander.name}`));
  console.log(`  Endpoint: ${base.baseUrl}`);
  console.log(`  Strategist: ${base.strategist.models.join(' → ')}`);
  console.log(`  Tactician: ${base.tactician.models.join(' → ')}`);

  const tallies: Record<ModeName, Tally> = { bot: emptyTally(), model: emptyTally() };
  const strategistClient = counting(
    new OpenAiCompatibleClient(configForRole(base, 'strategist'), budgetedFetch(budget)),
    'strategist',
    modeOf,
    tallies,
    budget,
  );
  const tacticianClient = counting(
    new OpenAiCompatibleClient(configForRole(base, 'tactician'), budgetedFetch(budget)),
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
  const providers = new Map<PlayerId, OpenAiDecisionProvider>();
  const started = performance.now();
  const result = await runToCompletionAsync(
    engine,
    (seat) => {
      let provider = providers.get(seat);
      if (provider === undefined) {
        const mode = modeOf(seat);
        provider = new OpenAiDecisionProvider(
          tacticianClient,
          queue,
          engine,
          configs[mode],
          logger,
          undefined,
          coordinators[mode],
        );
        providers.set(seat, provider);
      }
      return provider;
    },
    {
      maxDecisions: 20_000,
      onDecision(request) {
        if (request.decidingPlayer === request.activePlayer && request.step === null) {
          process.stderr.write(`\r  turn ${request.turn}  `);
        }
      },
    },
  );
  // The game is over: abort any strategist call still running instead of paying for it.
  for (const c of Object.values(coordinators)) c.cancel();
  await Promise.all(Object.values(coordinators).map((c) => c.settled()));
  process.stderr.write('\n');
  // Timed-out and unpriced calls are billed too (ADR 0040); read their cost before reporting.
  await Promise.all([strategistClient.settle(), tacticianClient.settle()]);

  const life: Record<string, number> = {};
  for (const player of engine.getState().players) {
    life[player.id] = player.hasLost === true ? 0 : player.life;
  }
  const turns = result.turnCount;
  const report = {
    seed,
    swap,
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
    life,
    seats: Object.fromEntries(SEATS.map((s) => [s, modeOf(s)])),
    perMode: Object.fromEntries(
      (['bot', 'model'] as const).map((mode) => {
        const t = tallies[mode];
        const calls = t.tacticianCalls + t.strategistCalls;
        return [
          mode,
          {
            ...t,
            costUsd: t.costKnown ? Number(t.costUsd.toFixed(4)) : null,
            callsPerTurn: Number((calls / Math.max(1, turns)).toFixed(2)),
            promptTokensPerTurn: Math.round(t.promptTokens / Math.max(1, turns)),
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
