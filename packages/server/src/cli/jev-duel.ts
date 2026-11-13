/**
 * Jev test games (ADR 0041): four-player games that seat Jev placements beside the bot-led and
 * chat tacticians, so their cost, agreement and results can be compared at one table.
 *
 *   bun run jev-duel [--seats bot,bot-jev,model,jev] [--games N] [--seed S] [--turn-cap N]
 *                    [--max-usd N] [--max-calls N] [--jev-min-confidence P] [--jev-min-margin P]
 *                    [--offline] [--out DIR]
 *
 * Seat presets (`--seats`, one per seat, P1 to P4):
 *   bot         Bot-led tactics (ADR 0039), no Jev. Today's planned default.
 *   bot-shadow  Bot-led; Jev answers every supported decision beside the bot without changing
 *               play, and agreement is logged. Plays exactly like `bot`.
 *   bot-jev     Bot-led; on the bot's close calls Jev decides, and the bot's own answer stands
 *               when Jev cannot (unsupported shape, low confidence, failure).
 *   model       The chat tactician model answers every decision, no Jev.
 *   jev         Jev answers every supported decision; the bot answers the rest. No chat tactician.
 *   jev-model   Jev answers every supported decision; the chat tactician answers the rest.
 *
 * With `--games N`, the lineup rotates one seat per game so every preset plays every seat.
 * Spend caps cover chat and Jev calls together; once hit, every seat finishes on the bot for free.
 *
 * `--offline` plays the same games with no network and no key: the chat tactician is the bot,
 * the strategist returns fixed knobs, and Jev is a deterministic stub. Use it to check the
 * wiring and to count how many calls a paid run would make. Its agreement numbers mean nothing.
 *
 * `--out DIR` writes report.json, jev-traces.jsonl and jev-comparisons.jsonl. Nothing here
 * prints or stores an API key.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DecisionRequest, OracleCard, PlayerId } from '@mtg/shared';
import { Engine, runToCompletionAsync } from '@mtg/engine';
import { decide as botDecide, Rng } from '@mtg/bot';
import { buildSupportedPool, type SupportedPool } from '../cards/pool';
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
import type { AiAttemptObserver } from '../ai/client';
import { knowledgeFor } from '../ai/bot-tactician';
import { localCallMeta } from '../ai/logger';
import {
  JevClient,
  JevResponseValidationError,
  type JevActionResult,
  type JevDecisionsTransport,
  type JevReportedUsage,
} from '../ai/jev-client';
import type { JevActionRequest } from '../ai/jev-context';
import {
  JevActionPolicy,
  type JevActionClient,
  type JevComparison,
  type JevDecisionTrace,
  type JevPolicyBinding,
} from '../ai/jev-policy';
import { OPENROUTER_BASE_URL } from '../ai/jev-runtime';
import {
  budgetedFetch,
  counting,
  emptyTally,
  type Budget,
  type CountableClient,
  type CountingClient,
  type Tally,
} from './ai-mode-duel';

const FIXTURE = 'packages/server/fixtures/coverage-oracle.json';
const SEATS: PlayerId[] = ['P1', 'P2', 'P3', 'P4'];

export const PRESETS = ['bot', 'bot-shadow', 'bot-jev', 'model', 'jev', 'jev-model'] as const;
export type Preset = (typeof PRESETS)[number];

export interface JevTally {
  /** Decisions Jev was offered, including ones it could not answer without a call. */
  asked: number;
  /** Network calls made. */
  calls: number;
  accepted: number;
  fallthrough: Record<string, number>;
  promptTokens: number;
  responseTokens: number;
  costUsd: number;
  /** Calls whose response carried no price. */
  unpricedCalls: number;
  /** Calls that failed after they were sent and reported no usage: they may have been billed. */
  unknownCostCalls: number;
  /** Calls refused because the spend cap was reached. */
  cappedCalls: number;
}

export function emptyJevTally(): JevTally {
  return {
    asked: 0,
    calls: 0,
    accepted: 0,
    fallthrough: {},
    promptTokens: 0,
    responseTokens: 0,
    costUsd: 0,
    unpricedCalls: 0,
    unknownCostCalls: 0,
    cappedCalls: 0,
  };
}

export interface PresetSetup {
  config: AiConfig;
  /** How Jev is bound for this preset, or null for none. */
  jev: null | { mode: 'active' | 'shadow'; minConfidence: number; minTopTwoMargin: number };
}

/** The AiConfig and Jev binding each preset plays with. */
export function presetSetup(
  preset: Preset,
  base: AiConfig,
  thresholds: { minConfidence: number; minTopTwoMargin: number },
): PresetSetup {
  const bot: AiConfig = {
    ...base,
    tacticalMode: 'bot',
    botEscalation: [],
    strategistReplan: 'onChange',
  };
  const model: AiConfig = { ...base, tacticalMode: 'model' };
  switch (preset) {
    case 'bot':
      return { config: bot, jev: null };
    case 'bot-shadow':
      return {
        config: { ...bot, jevShadowEnabled: true, jevShadowScope: 'all' },
        jev: { mode: 'shadow', minConfidence: 0, minTopTwoMargin: 0 },
      };
    case 'bot-jev':
      return {
        config: { ...bot, botEscalation: ['uncertain'], jevEnabled: true, jevFallback: 'bot' },
        jev: { mode: 'active', ...thresholds },
      };
    case 'model':
      return { config: model, jev: null };
    case 'jev':
      return {
        config: { ...model, jevEnabled: true, jevFallback: 'bot' },
        jev: { mode: 'active', ...thresholds },
      };
    case 'jev-model':
      return {
        config: { ...model, jevEnabled: true, jevFallback: 'model' },
        jev: { mode: 'active', ...thresholds },
      };
  }
}

export function parseSeats(value: string | undefined): Preset[] {
  const seats = (value ?? 'bot,bot-jev,model,jev').split(',').map((s) => s.trim());
  if (seats.length !== 4) throw new Error('--seats needs exactly four presets, one per seat');
  for (const seat of seats) {
    if (!(PRESETS as readonly string[]).includes(seat)) {
      throw new Error(`unknown seat preset "${seat}"; use one of ${PRESETS.join(', ')}`);
    }
  }
  return seats as Preset[];
}

/** Rotate the lineup one seat per game so every preset plays every seat. */
export function lineupFor(seats: readonly Preset[], game: number): Preset[] {
  const shift = game % seats.length;
  return [...seats.slice(seats.length - shift), ...seats.slice(0, seats.length - shift)];
}

/**
 * Wraps a Jev client so every call is charged to its preset and to the shared budget. A call over
 * the cap is refused before it is sent, so the seat's fallback answers for free.
 */
export function countingJev(
  inner: JevActionClient,
  tally: JevTally,
  budget: Budget,
): JevActionClient {
  return {
    async requestAction(request: JevActionRequest, signal?: AbortSignal) {
      if (budget.spentUsd >= budget.maxUsd || budget.calls >= budget.maxCalls) {
        budget.capped = true;
        tally.cappedCalls++;
        throw new Error('jev-duel spend cap reached');
      }
      budget.calls++;
      tally.calls++;
      const charge = (usage: JevReportedUsage): void => {
        tally.promptTokens += usage.promptTokens;
        tally.responseTokens += usage.responseTokens;
        if (usage.costUsd === undefined) tally.unpricedCalls++;
        else {
          tally.costUsd += usage.costUsd;
          budget.spentUsd += usage.costUsd;
        }
      };
      let result: JevActionResult;
      try {
        result = await inner.requestAction(request, signal);
      } catch (error) {
        // A rejected answer may still have been billed: charge what it reported, and count a
        // failure with no usage as cost unknown rather than free.
        if (error instanceof JevResponseValidationError && error.usage !== undefined) {
          charge(error.usage);
        } else tally.unknownCostCalls++;
        throw error;
      }
      charge(result.meta);
      return result;
    },
  };
}

/** A deterministic stand-in for the Decisions endpoint, for `--offline` runs. */
export function offlineJevTransport(): JevDecisionsTransport {
  return {
    create(request) {
      const keys = Object.keys(request.decisionsRequest.questions.action.criteria);
      const seed = request.decisionsRequest.sessionId ?? '';
      let hash = 0;
      for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
      const choice = keys[hash % keys.length]!;
      const rest = keys.length > 1 ? 0.4 / (keys.length - 1) : 0;
      const probabilities = Object.fromEntries(
        keys.map((key) => [key, key === choice ? (keys.length > 1 ? 0.6 : 1) : rest]),
      );
      return Promise.resolve({
        id: `offline-${seed}`,
        model: request.decisionsRequest.model,
        answers: {
          action: { type: 'choice', choice, confidence: probabilities[choice], probabilities },
        },
        usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
      });
    },
  };
}

/** Offline chat clients: the tactician is the bot, the strategist returns fixed knobs. */
function offlineChatClient(engine: Engine, role: 'tactician' | 'strategist'): CountableClient {
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

export interface AgreementStats {
  compared: number;
  agreed: number;
  sameAction: number;
  closeCalls: number;
  closeCallsAgreed: number;
  meanConfidenceAgreed: number | null;
  meanConfidenceDisagreed: number | null;
}

export function agreementStats(comparisons: readonly JevComparison[]): AgreementStats {
  const answered = comparisons.filter((c) => c.agreed !== undefined);
  const mean = (values: number[]): number | null =>
    values.length === 0
      ? null
      : Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(3));
  const close = answered.filter((c) => c.botUncertain === true);
  return {
    compared: answered.length,
    agreed: answered.filter((c) => c.agreed === true).length,
    sameAction: answered.filter((c) => c.sameAction === true).length,
    closeCalls: close.length,
    closeCallsAgreed: close.filter((c) => c.agreed === true).length,
    meanConfidenceAgreed: mean(
      answered
        .filter((c) => c.agreed === true && c.confidence !== undefined)
        .map((c) => c.confidence!),
    ),
    meanConfidenceDisagreed: mean(
      answered
        .filter((c) => c.agreed === false && c.confidence !== undefined)
        .map((c) => c.confidence!),
    ),
  };
}

export interface GameContext {
  pool: SupportedPool;
  base: AiConfig;
  thresholds: { minConfidence: number; minTopTwoMargin: number };
  offline: boolean;
  jevKey: string;
  turnCap: number;
  budget: Budget;
  tallies: Record<Preset, Tally>;
  jevTallies: Record<Preset, JevTally>;
  traces: Array<JevDecisionTrace & { preset: Preset; game: number }>;
  comparisons: Array<JevComparison & { preset: Preset; game: number }>;
  /** Every game's counting chat clients, so unpriced attempts can be settled at the end. */
  chatClients: CountingClient[];
  quiet?: boolean;
  /** Replaces the Jev transport (tests). Defaults to the offline stub offline, else OpenRouter. */
  jevTransport?: JevDecisionsTransport;
}

/** Play one game with `lineup` (one preset per seat) and charge every call to its preset. */
export async function playGame(
  ctx: GameContext,
  seed: string,
  lineup: readonly Preset[],
  game: number,
): Promise<{ record: GameRecord; engine: Engine }> {
  const {
    pool,
    base,
    thresholds,
    offline,
    jevKey,
    turnCap,
    budget,
    tallies,
    jevTallies,
    traces,
    comparisons,
    chatClients,
  } = ctx;
  const say = (line: string): void => {
    if (ctx.quiet !== true) console.log(line);
  };
  const presetOf = (seat: PlayerId): Preset => lineup[SEATS.indexOf(seat)]!;
  const decks = SEATS.map((_, i) => generateCommanderDeck(pool, { seed: `${seed}-seat${i + 1}` }));
  const engine = new Engine({
    gameId: `jev-duel-${seed}`,
    seed,
    turnCap,
    players: decks.map((d, i) => ({
      id: SEATS[i]!,
      deckId: `jev-duel-${i + 1}`,
      commanders: [d.commander],
      cards: d.cards,
    })),
  });
  say(`\nGame ${game + 1}, seed ${seed}`);
  decks.forEach((d, i) => say(`  ${SEATS[i]} [${lineup[i]}]  ${d.commander.name}`));

  const rawStrategist = offline
    ? offlineChatClient(engine, 'strategist')
    : new OpenAiCompatibleClient(configForRole(base, 'strategist'), budgetedFetch(budget));
  const rawTactician = offline
    ? offlineChatClient(engine, 'tactician')
    : new OpenAiCompatibleClient(configForRole(base, 'tactician'), budgetedFetch(budget));
  const strategistClient = counting<Preset>(rawStrategist, 'strategist', presetOf, tallies, budget);
  const tacticianClient = counting<Preset>(rawTactician, 'tactician', presetOf, tallies, budget);
  chatClients.push(strategistClient, tacticianClient);
  const queue = new RequestQueue(base);
  const logger = new AiCallLogger(null, `jev-duel-${seed}`);

  const jevTransport = ctx.jevTransport ?? (offline ? offlineJevTransport() : undefined);
  const jevBindings = new Map<Preset, JevPolicyBinding | undefined>();
  const pendingJev = new Set<Promise<unknown>>();
  const coordinators = new Map<Preset, StrategyCoordinator>();
  for (const preset of new Set(lineup)) {
    const setup = presetSetup(preset, base, thresholds);
    const others = new Set(SEATS.filter((s) => presetOf(s) !== preset));
    coordinators.set(
      preset,
      new StrategyCoordinator(strategistClient, queue, engine, setup.config, logger, others),
    );
    if (setup.jev === null) {
      jevBindings.set(preset, undefined);
      continue;
    }
    const tally = jevTallies[preset];
    const client = countingJev(
      new JevClient(
        {
          apiKey: jevKey,
          baseUrl: OPENROUTER_BASE_URL,
          requestTimeoutMs: base.jevRequestTimeoutMs,
        },
        jevTransport,
      ),
      tally,
      budget,
    );
    const controller = new AbortController();
    const policy = new JevActionPolicy(client, new RequestQueue({ ...base, concurrency: 2 }), {
      model: base.jevModel,
      minConfidence: setup.jev.minConfidence,
      minTopTwoMargin: setup.jev.minTopTwoMargin,
      maxActions: base.jevMaxActions,
      expandTargets: base.jevExpandTargets,
      mode: setup.jev.mode,
      signal: controller.signal,
      onTrace: (trace) => {
        tally.asked++;
        if (trace.outcome === 'accepted') tally.accepted++;
        else {
          const reason = trace.fallbackReason ?? 'unknown';
          tally.fallthrough[reason] = (tally.fallthrough[reason] ?? 0) + 1;
        }
        traces.push({ ...trace, preset, game });
      },
    });
    jevBindings.set(preset, {
      mode: setup.jev.mode,
      cancel: () => controller.abort(),
      onComparison: (comparison) => comparisons.push({ ...comparison, preset, game }),
      // Shadow answers are not awaited by play, so each one is tracked and drained after the game.
      policy: {
        decide(...args) {
          const decision = policy.decide(...args);
          pendingJev.add(decision);
          void decision.finally(() => pendingJev.delete(decision)).catch(() => {});
          return decision;
        },
      },
    });
  }

  const providers = new Map<PlayerId, OpenAiDecisionProvider>();
  const started = performance.now();
  const result = await runToCompletionAsync(
    engine,
    (seat) => {
      let provider = providers.get(seat);
      if (provider === undefined) {
        const preset = presetOf(seat);
        provider = new OpenAiDecisionProvider(
          tacticianClient,
          queue,
          engine,
          presetSetup(preset, base, thresholds).config,
          logger,
          undefined,
          coordinators.get(preset),
          jevBindings.get(preset),
        );
        providers.set(seat, provider);
      }
      return provider;
    },
    {
      maxDecisions: 20_000,
      onDecision(request) {
        if (request.decidingPlayer === request.activePlayer && request.step === null) {
          if (ctx.quiet !== true) process.stderr.write(`\r  turn ${request.turn}  `);
        }
      },
    },
  );
  // Every strategist call, not only the newest: an older one could otherwise keep spending
  // against the next game's budget or land after the report (as in pool.ts and ai-mode-duel).
  for (const coordinator of coordinators.values()) coordinator.cancel();
  await Promise.all([...coordinators.values()].map((c) => c.drained()));
  if (ctx.quiet !== true) process.stderr.write('\n');
  // Let queued and in-flight shadow answers land (and record their comparisons) before cancelling,
  // so a fast game does not drop its last evidence or change it while the report is written.
  while (pendingJev.size > 0) await Promise.allSettled([...pendingJev]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const binding of jevBindings.values()) binding?.cancel?.();

  const life: Record<string, number> = {};
  for (const player of engine.getState().players) {
    life[player.id] = player.hasLost === true ? 0 : player.life;
  }
  const record: GameRecord = {
    seed,
    lineup: Object.fromEntries(SEATS.map((s) => [s, presetOf(s)])),
    turns: result.turnCount,
    winner: result.winnerSeat,
    winnerPreset: result.winnerSeat === null ? null : presetOf(result.winnerSeat),
    finishingOrder: result.finishingOrder,
    life,
    minutes: Number(((performance.now() - started) / 60_000).toFixed(1)),
  };
  say(
    `  ${record.turns} turns, winner ${record.winner ?? 'none'}${record.winnerPreset === null ? '' : ` [${record.winnerPreset}]`}`,
  );
  return { record, engine };
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

export interface GameRecord {
  seed: string;
  lineup: Record<string, Preset>;
  turns: number;
  winner: PlayerId | null;
  winnerPreset: Preset | null;
  finishingOrder: PlayerId[];
  life: Record<string, number>;
  minutes: number;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const seats = parseSeats(arg(argv, '--seats'));
  const games = Math.max(1, Number(arg(argv, '--games') ?? 1));
  const seedBase = arg(argv, '--seed') ?? 'jev-duel';
  const turnCap = Number(arg(argv, '--turn-cap') ?? 60);
  const offline = argv.includes('--offline');
  const outDir = arg(argv, '--out');
  const thresholds = {
    minConfidence: Number(arg(argv, '--jev-min-confidence') ?? 0),
    minTopTwoMargin: Number(arg(argv, '--jev-min-margin') ?? 0),
  };
  const budget: Budget = {
    maxUsd: Number(arg(argv, '--max-usd') ?? 1),
    maxCalls: Number(arg(argv, '--max-calls') ?? 3000),
    spentUsd: 0,
    calls: 0,
    capped: false,
  };

  const base = loadAiConfig(process.env);
  const jevKey =
    process.env['AI_JEV_API_KEY']?.trim() || process.env['OPENROUTER_API_KEY']?.trim() || '';
  const usesJev = seats.some((s) => presetSetup(s, base, thresholds).jev !== null);
  if (!offline) {
    // Every preset uses the strategist, so a chat key is always needed for a paid run.
    if (!base.apiKey) {
      console.error('No AI API key found in the environment or .env; nothing was played.');
      process.exitCode = 1;
      return;
    }
    if (usesJev && jevKey.length === 0) {
      console.error('Jev seats need OPENROUTER_API_KEY or AI_JEV_API_KEY; nothing was played.');
      process.exitCode = 1;
      return;
    }
  }

  const pool = buildSupportedPool(
    JSON.parse(readFileSync(resolve(FIXTURE), 'utf8')) as OracleCard[],
  );
  const presetsInPlay = [...new Set(seats)];
  const tallies = Object.fromEntries(presetsInPlay.map((p) => [p, emptyTally()])) as Record<
    Preset,
    Tally
  >;
  const jevTallies = Object.fromEntries(presetsInPlay.map((p) => [p, emptyJevTally()])) as Record<
    Preset,
    JevTally
  >;
  const traces: Array<JevDecisionTrace & { preset: Preset; game: number }> = [];
  const comparisons: Array<JevComparison & { preset: Preset; game: number }> = [];
  const records: GameRecord[] = [];
  const chatClients: CountingClient[] = [];

  console.log(
    `${offline ? 'OFFLINE (no network, numbers are a wiring check) — ' : ''}${games} game(s), turn cap ${turnCap}`,
  );
  console.log(`  Strategist: ${base.strategist.models.join(' → ')}`);
  console.log(`  Tactician: ${base.tactician.models.join(' → ')}`);
  console.log(
    `  Jev: ${base.jevModel}, min confidence ${thresholds.minConfidence}, min margin ${thresholds.minTopTwoMargin}, expand targets ${base.jevExpandTargets}`,
  );

  const ctx: GameContext = {
    pool,
    base,
    thresholds,
    offline,
    jevKey,
    turnCap,
    budget,
    tallies,
    jevTallies,
    traces,
    comparisons,
    chatClients,
  };
  for (let game = 0; game < games; game++) {
    const { record } = await playGame(ctx, `${seedBase}-${game}`, lineupFor(seats, game), game);
    records.push(record);
  }

  // Calls we timed out report no cost; ask OpenRouter what they cost (ADR 0040).
  let settledUsd = 0;
  let unsettled = 0;
  // `settle` also adds each billed cost to its preset's tally.
  for (const client of chatClients) {
    const settlement = await client.settle();
    settledUsd += settlement.settledUsd;
    unsettled += settlement.unresolved;
  }

  const turns = records.reduce((sum, r) => sum + r.turns, 0);
  const report = {
    offline,
    games,
    seats,
    thresholds,
    jevModel: base.jevModel,
    spendCap: {
      maxUsd: budget.maxUsd,
      maxCalls: budget.maxCalls,
      reached: budget.capped,
      spentUsd: Number(budget.spentUsd.toFixed(5)),
      settledTimedOutUsd: Number(settledUsd.toFixed(5)),
      unresolvedTimedOutCalls: unsettled,
    },
    turns,
    wins: Object.fromEntries(
      presetsInPlay.map((p) => [p, records.filter((r) => r.winnerPreset === p).length]),
    ),
    perPreset: Object.fromEntries(
      presetsInPlay.map((preset) => {
        const chat = tallies[preset];
        const jev = jevTallies[preset];
        const own = comparisons.filter((c) => c.preset === preset);
        return [
          preset,
          {
            seatsPerGame: seats.filter((s) => s === preset).length,
            chat: {
              ...chat,
              costUsd: chat.costKnown ? Number(chat.costUsd.toFixed(5)) : null,
            },
            jev: { ...jev, costUsd: Number(jev.costUsd.toFixed(6)) },
            jevCallsPerGameTurn: Number((jev.calls / Math.max(1, turns)).toFixed(3)),
            agreement: agreementStats(own),
          },
        ];
      }),
    ),
    records,
  };
  console.log(JSON.stringify(report, null, 2));
  if (outDir !== undefined) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(
      join(outDir, 'jev-traces.jsonl'),
      traces.map((t) => JSON.stringify(t)).join('\n') + (traces.length > 0 ? '\n' : ''),
    );
    writeFileSync(
      join(outDir, 'jev-comparisons.jsonl'),
      comparisons.map((c) => JSON.stringify(c)).join('\n') + (comparisons.length > 0 ? '\n' : ''),
    );
    console.error(`Wrote ${outDir}/report.json, jev-traces.jsonl, jev-comparisons.jsonl`);
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error((error as Error).stack ?? (error as Error).message);
    process.exitCode = 1;
  });
}
