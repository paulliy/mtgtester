/**
 * One paid four-player game that seats both tactical modes at the same table (ADR 0039): P1 and
 * P3 play `AI_TACTICAL_MODE=bot` (the bot plays, the strategist sets knobs), P2 and P4 play
 * `AI_TACTICAL_MODE=model` (today's model tactician). Everything else comes from the environment
 * (`.env` is read by Bun), so the endpoint, models and key are the same ones the app uses.
 *
 *   bun run ai-mode-duel [--seed S] [--turn-cap N] [--swap] [--json out.json]
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
import type { AiClient } from '../ai/client';
import type { AiPrompt } from '../ai/context';

const FIXTURE = 'packages/server/fixtures/coverage-oracle.json';
const SEATS: PlayerId[] = ['P1', 'P2', 'P3', 'P4'];
type ModeName = 'bot' | 'model';

interface Tally {
  tacticianCalls: number;
  strategistCalls: number;
  promptTokens: number;
  responseTokens: number;
  costUsd: number;
  costKnown: boolean;
  /** Calls that failed after the client's own retries; the seat fell back to the bot. */
  failedCalls: number;
}

function emptyTally(): Tally {
  return {
    tacticianCalls: 0,
    strategistCalls: 0,
    promptTokens: 0,
    responseTokens: 0,
    costUsd: 0,
    costKnown: true,
    failedCalls: 0,
  };
}

/** Wraps a real client so every call is charged to the mode of the seat it was made for. */
function counting(
  inner: AiClient,
  role: 'tactician' | 'strategist',
  modeOf: (seat: PlayerId) => ModeName,
  tallies: Record<ModeName, Tally>,
): AiClient {
  return {
    get activeModel() {
      return inner.activeModel;
    },
    ...(inner.setAttemptObserver === undefined
      ? {}
      : { setAttemptObserver: inner.setAttemptObserver.bind(inner) }),
    async requestDecision(prompt: AiPrompt, request: DecisionRequest, signal?: AbortSignal) {
      const tally = tallies[modeOf(request.decidingPlayer)];
      let result: Awaited<ReturnType<AiClient['requestDecision']>>;
      try {
        result = await inner.requestDecision(prompt, request, signal);
      } catch (error) {
        tally.failedCalls++;
        throw error;
      }
      if (role === 'tactician') tally.tacticianCalls++;
      else tally.strategistCalls++;
      tally.promptTokens += result.meta.promptTokens;
      tally.responseTokens += result.meta.responseTokens;
      if (typeof result.meta.costUsd === 'number') tally.costUsd += result.meta.costUsd;
      else tally.costKnown = false;
      return result;
    },
  };
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
    new OpenAiCompatibleClient(configForRole(base, 'strategist')),
    'strategist',
    modeOf,
    tallies,
  );
  const tacticianClient = counting(
    new OpenAiCompatibleClient(configForRole(base, 'tactician')),
    'tactician',
    modeOf,
    tallies,
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
  await Promise.all(Object.values(coordinators).map((c) => c.settled()));
  process.stderr.write('\n');

  const life: Record<string, number> = {};
  for (const player of engine.getState().players) {
    life[player.id] = player.hasLost === true ? 0 : player.life;
  }
  const turns = result.turnCount;
  const report = {
    seed,
    swap,
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
