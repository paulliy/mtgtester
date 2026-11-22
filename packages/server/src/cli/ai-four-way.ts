/**
 * Scratch: one paid four-player game with a different tactician setup in every seat.
 *   P1 model-low  : model tactician, reasoning low (the production default)
 *   P2 model-none : model tactician, reasoning off
 *   P3 bot        : bot-led, no escalation
 *   P4 bot-esc    : bot-led, escalating uncertain, unknown-card and scarce-answer to the model (low)
 *
 *   bun run packages/server/src/cli/ai-four-way.ts [--seed S] [--turn-cap N] [--max-usd N] [--json out]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OracleCard, PlayerId } from '@mtg/shared';
import { Engine, runToCompletionAsync } from '@mtg/engine';
import { TABLE_ENGINE_LIMITS } from '../match/engine-limits';
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
import {
  budgetedFetch,
  counting,
  emptyTally,
  fallbackShare,
  SeatTracker,
  type Budget,
  type Tally,
} from './ai-mode-duel';

const FIXTURE = 'packages/server/fixtures/coverage-oracle.json';
const SEATS: PlayerId[] = ['P1', 'P2', 'P3', 'P4'];
type Mode = 'model-low' | 'model-none' | 'bot' | 'bot-esc';
const MODES: Mode[] = ['model-low', 'model-none', 'bot', 'bot-esc'];

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const seed = arg(argv, '--seed') ?? 'four-way-1';
  const turnCap = Number(arg(argv, '--turn-cap') ?? 60);
  const json = arg(argv, '--json');
  const budget: Budget = {
    maxUsd: Number(arg(argv, '--max-usd') ?? 2),
    maxCalls: 1500,
    spentUsd: 0,
    calls: 0,
    capped: false,
  };
  const base = loadAiConfig(process.env);
  if (!base.apiKey) throw new Error('No AI API key in the environment.');

  const modeOf = (seat: PlayerId): Mode => MODES[SEATS.indexOf(seat)]!;
  const botBase = { ...base, tacticalMode: 'bot' as const, strategistReplan: 'onChange' as const };
  const configs: Record<Mode, AiConfig> = {
    'model-low': { ...base, tacticalMode: 'model' },
    'model-none': {
      ...base,
      tacticalMode: 'model',
      tactician: { ...base.tactician, reasoningEnabled: false, reasoningEffort: 'none' },
    },
    bot: { ...botBase, botEscalation: [] },
    'bot-esc': { ...botBase, botEscalation: ['uncertain', 'unknown-card', 'scarce-answer'] },
  };

  const pool = buildSupportedPool(
    JSON.parse(readFileSync(resolve(FIXTURE), 'utf8')) as OracleCard[],
  );
  const decks = SEATS.map((_, i) => generateCommanderDeck(pool, { seed: `${seed}-seat${i + 1}` }));
  const engine = new Engine(
    {
      gameId: `four-way-${seed}`,
      seed,
      turnCap,
      players: decks.map((d, i) => ({
        id: SEATS[i]!,
        deckId: `four-way-${i + 1}`,
        commanders: [d.commander],
        cards: d.cards,
      })),
    },
    TABLE_ENGINE_LIMITS,
  );
  console.log(`Seed ${seed}, turn cap ${turnCap}`);
  decks.forEach((d, i) => console.log(`  ${SEATS[i]} [${MODES[i]}]  ${d.commander.name}`));

  const tallies = Object.fromEntries(MODES.map((m) => [m, emptyTally()])) as Record<Mode, Tally>;
  const strategistClient = counting(
    new OpenAiCompatibleClient(configForRole(base, 'strategist'), budgetedFetch(budget)),
    'strategist',
    modeOf,
    tallies,
    budget,
  );
  const tacticianLow = counting(
    new OpenAiCompatibleClient(configForRole(base, 'tactician'), budgetedFetch(budget)),
    'tactician',
    modeOf,
    tallies,
    budget,
  );
  const tacticianNone = counting(
    new OpenAiCompatibleClient(
      configForRole(configs['model-none'], 'tactician'),
      budgetedFetch(budget),
    ),
    'tactician',
    modeOf,
    tallies,
    budget,
  );
  const queue = new RequestQueue(base);
  const logger = new AiCallLogger(null, `four-way-${seed}`);
  const coordinators = {} as Record<Mode, StrategyCoordinator>;
  for (const mode of MODES) {
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

  const tracker = new SeatTracker();
  const lostSeats = (): PlayerId[] =>
    engine
      .getState()
      .players.filter((p) => p.hasLost === true)
      .map((p) => p.id);
  const providers = new Map<PlayerId, OpenAiDecisionProvider>();
  const started = performance.now();
  const result = await runToCompletionAsync(
    engine,
    (seat) => {
      let provider = providers.get(seat);
      if (provider === undefined) {
        const mode = modeOf(seat);
        provider = new OpenAiDecisionProvider(
          mode === 'model-none' ? tacticianNone : tacticianLow,
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
        tracker.observe(request, lostSeats());
        if (request.decidingPlayer === request.activePlayer && request.step === null) {
          process.stderr.write(`\r  turn ${request.turn}  `);
        }
      },
    },
  );
  for (const c of Object.values(coordinators)) c.cancel();
  await Promise.all(Object.values(coordinators).map((c) => c.drained()));
  process.stderr.write('\n');
  await Promise.all([strategistClient.settle(), tacticianLow.settle(), tacticianNone.settle()]);

  const turns = result.turnCount;
  tracker.finish(turns, lostSeats());
  const life: Record<string, number> = {};
  for (const p of engine.getState().players) life[p.id] = p.hasLost === true ? 0 : p.life;
  const report = {
    seed,
    turns,
    minutes: Number(((performance.now() - started) / 60_000).toFixed(1)),
    winner: result.winnerSeat,
    winnerMode: result.winnerSeat === null ? null : modeOf(result.winnerSeat),
    finishingOrder: result.finishingOrder,
    halted: result.halted,
    haltReason: result.haltReason,
    life,
    spendCap: { maxUsd: budget.maxUsd, reached: budget.capped, spentUsd: budget.spentUsd },
    seats: Object.fromEntries(
      SEATS.map((s) => [
        s,
        {
          mode: modeOf(s),
          commander: decks[SEATS.indexOf(s)]!.commander.name,
          ownTurns: tracker.ownTurnsOf(s),
          eliminatedOnTurn: tracker.eliminationTurnOf(s),
        },
      ]),
    ),
    perMode: Object.fromEntries(
      MODES.map((m) => {
        const t = tallies[m];
        return [
          m,
          {
            tacticianCalls: t.tacticianCalls,
            strategistCalls: t.strategistCalls,
            promptTokens: t.promptTokens,
            responseTokens: t.responseTokens,
            costUsd: Number(t.costUsd.toFixed(4)),
            failedTacticianCalls: t.failedTacticianCalls,
            tacticianFallbackShare: fallbackShare(t),
            tacticianCallsPerOwnTurn: Number(
              (
                t.tacticianCalls / Math.max(1, tracker.ownTurnsOf(SEATS[MODES.indexOf(m)]!))
              ).toFixed(2),
            ),
          },
        ];
      }),
    ),
  };
  console.log(JSON.stringify(report, null, 2));
  if (json !== undefined) writeFileSync(json, JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  console.error((error as Error).stack ?? String(error));
  process.exitCode = 1;
});
