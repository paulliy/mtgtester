/**
 * Model-call census (ADR 0039): how many tactician and strategist calls a game would make under
 * each tactical mode, without spending anything. Every seat runs the real `OpenAiDecisionProvider`
 * and `StrategyCoordinator`; only the network client is a stub, which answers tactical calls with
 * the heuristic bot and strategist calls with fixed knobs, and counts each call and the prompt
 * tokens the real client would have sent.
 *
 *   bun run ai-call-census [--games N] [--seed S] [--turn-cap N] [--json out.json]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DecisionRequest, OracleCard, PlayerId } from '@mtg/shared';
import { Engine, runToCompletionAsync } from '@mtg/engine';
import { decide, Rng } from '@mtg/bot';
import { buildSupportedPool, type SupportedPool } from '../cards/pool';
import { generateCommanderDeck } from '../decks/generate';
import { DEFAULT_AI_CONFIG, type AiConfig } from '../ai/config';
import { OpenAiDecisionProvider } from '../ai/provider';
import { StrategyCoordinator } from '../ai/strategy-coordinator';
import type { AiClient } from '../ai/client';
import { localCallMeta } from '../ai/logger';
import { knowledgeFor } from '../ai/bot-tactician';

const FIXTURE = 'packages/server/fixtures/coverage-oracle.json';

interface Mode {
  name: string;
  config: Partial<AiConfig>;
}

export const MODES: Mode[] = [
  { name: 'model (today)', config: { tacticalMode: 'model' } },
  {
    name: 'bot, replan every turn',
    config: { tacticalMode: 'bot', botEscalation: 'never', strategistReplan: 'everyTurn' },
  },
  {
    name: 'bot, replan on change',
    config: { tacticalMode: 'bot', botEscalation: 'never', strategistReplan: 'onChange' },
  },
  {
    name: 'bot + escalate close calls',
    config: { tacticalMode: 'bot', botEscalation: 'uncertain', strategistReplan: 'onChange' },
  },
];

export interface CensusCounts {
  turns: number;
  tactician: number;
  strategist: number;
  strategistReused: number;
  tacticianPromptTokens: number;
  strategistPromptTokens: number;
  byDecisionType: Record<string, number>;
}

export async function censusGame(
  pool: SupportedPool,
  seed: string,
  turnCap: number,
  mode: Mode,
): Promise<CensusCounts> {
  const decks = Array.from({ length: 4 }, (_, i) =>
    generateCommanderDeck(pool, { seed: `${seed}-seat${i + 1}` }),
  );
  const engine = new Engine({
    gameId: `census-${seed}`,
    seed,
    players: decks.map((d, i) => ({
      id: `P${i + 1}`,
      deckId: `census-${i + 1}`,
      commanders: [d.commander],
      cards: d.cards,
    })),
    turnCap,
  });
  const counts: CensusCounts = {
    turns: 0,
    tactician: 0,
    strategist: 0,
    strategistReused: 0,
    tacticianPromptTokens: 0,
    strategistPromptTokens: 0,
    byDecisionType: {},
  };
  const knowledge = knowledgeFor(engine);
  const tactician: AiClient = {
    activeModel: 'census-stub',
    requestDecision(prompt, request: DecisionRequest) {
      counts.tactician++;
      counts.tacticianPromptTokens += prompt.estimatedTokens;
      counts.byDecisionType[request.decisionType] =
        (counts.byDecisionType[request.decisionType] ?? 0) + 1;
      const view = engine.view(request.decidingPlayer);
      const response = decide(request, view, new Rng(request.requestId), { knowledge });
      return Promise.resolve({ response, meta: localCallMeta() });
    },
  };
  const strategist: AiClient = {
    activeModel: 'census-stub',
    requestDecision(prompt, request: DecisionRequest) {
      counts.strategistPromptTokens += prompt.estimatedTokens;
      return Promise.resolve({
        response: {
          requestId: request.requestId,
          actionId: 0,
          turnStrategy: { intent: 'census', plannedActions: [], steering: { aggression: 0.5 } },
        },
        meta: localCallMeta(),
      });
    },
  };
  const config: AiConfig = { ...DEFAULT_AI_CONFIG, ...mode.config };
  const queue = { enqueue: <T>(fn: () => Promise<T>): Promise<T> => fn() };
  const coordinator = new StrategyCoordinator(strategist, queue, engine, config);
  const providers = new Map<PlayerId, OpenAiDecisionProvider>();
  const result = await runToCompletionAsync(
    engine,
    (seat) => {
      let provider = providers.get(seat);
      if (provider === undefined) {
        provider = new OpenAiDecisionProvider(
          tactician,
          queue,
          engine,
          config,
          undefined,
          undefined,
          coordinator,
        );
        providers.set(seat, provider);
      }
      return provider;
    },
    { maxDecisions: 20_000 },
  );
  await coordinator.settled();
  counts.turns = result.turnCount;
  counts.strategist = coordinator.strategistStats.calls;
  counts.strategistReused = coordinator.strategistStats.reused;
  return counts;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const games = Number(arg(argv, '--games') ?? 6);
  const seed = arg(argv, '--seed') ?? 'census';
  const turnCap = Number(arg(argv, '--turn-cap') ?? 40);
  const json = arg(argv, '--json');
  const pool = buildSupportedPool(
    JSON.parse(readFileSync(resolve(FIXTURE), 'utf8')) as OracleCard[],
  );
  const rows: Array<Record<string, unknown>> = [];
  for (const mode of MODES) {
    const total: CensusCounts = {
      turns: 0,
      tactician: 0,
      strategist: 0,
      strategistReused: 0,
      tacticianPromptTokens: 0,
      strategistPromptTokens: 0,
      byDecisionType: {},
    };
    for (let g = 0; g < games; g++) {
      const started = performance.now();
      let c: CensusCounts;
      try {
        c = await censusGame(pool, `${seed}-${g}`, turnCap, mode);
      } catch (error) {
        // An engine halt is one lost data point, reported, not a lost run.
        console.error(`  ${mode.name} game ${g}: THREW ${(error as Error).message}`);
        continue;
      }
      console.error(
        `  ${mode.name} game ${g}: ${c.turns} turns, ${c.tactician + c.strategist} calls, ${Math.round(performance.now() - started)} ms`,
      );
      total.turns += c.turns;
      total.tactician += c.tactician;
      total.strategist += c.strategist;
      total.strategistReused += c.strategistReused;
      total.tacticianPromptTokens += c.tacticianPromptTokens;
      total.strategistPromptTokens += c.strategistPromptTokens;
      for (const [k, v] of Object.entries(c.byDecisionType)) {
        total.byDecisionType[k] = (total.byDecisionType[k] ?? 0) + v;
      }
    }
    const calls = total.tactician + total.strategist;
    const row = {
      mode: mode.name,
      turns: total.turns,
      tacticianPerTurn: Number((total.tactician / total.turns).toFixed(2)),
      strategistPerTurn: Number((total.strategist / total.turns).toFixed(2)),
      callsPerTurn: Number((calls / total.turns).toFixed(2)),
      promptTokensPerTurn: Math.round(
        (total.tacticianPromptTokens + total.strategistPromptTokens) / total.turns,
      ),
      strategistReused: total.strategistReused,
      tacticianByDecisionType: total.byDecisionType,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  if (json !== undefined)
    writeFileSync(json, JSON.stringify({ games, seed, turnCap, rows }, null, 2));
}

// Only as the entry point: the census test imports `censusGame` from here.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  void main();
}
