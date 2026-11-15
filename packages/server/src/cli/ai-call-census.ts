/**
 * Model-call census (ADR 0039): how many tactician and strategist calls a game would make under
 * each tactical mode, without spending anything. Every seat runs the real `OpenAiDecisionProvider`
 * and `StrategyCoordinator`; only the network client is a stub, which answers tactical calls with
 * the heuristic bot and strategist calls with fixed knobs, and counts each call and the prompt
 * tokens the real client would have sent.
 *
 *   bun run ai-call-census [--games N] [--seed S] [--turn-cap N] [--json out.json]
 *
 * Every bot mode evaluates ADR 0044's escalation triggers in shadow and reports how often each
 * would fire, by decision type and by answer source; `bot + escalate <trigger>` makes one live.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DecisionRequest, OracleCard, PlayerId } from '@mtg/shared';
import { Engine, runToCompletionAsync } from '@mtg/engine';
import { decide, Rng } from '@mtg/bot';
import { buildSupportedPool, type SupportedPool } from '../cards/pool';
import { inferArchetype } from '../decks/archetype';
import { generateCommanderDeck } from '../decks/generate';
import {
  DEFAULT_AI_CONFIG,
  ESCALATION_TRIGGERS,
  LIVE_ESCALATION_TRIGGERS,
  type AiConfig,
} from '../ai/config';
import { OpenAiDecisionProvider } from '../ai/provider';
import { StrategyCoordinator } from '../ai/strategy-coordinator';
import { PrefixCacheModel } from '../ai/prompt-cache';
import type { AiClient } from '../ai/client';
import { localCallMeta } from '../ai/logger';
import { knowledgeFor } from '../ai/bot-tactician';

const FIXTURE = 'packages/server/fixtures/coverage-oracle.json';

interface Mode {
  name: string;
  config: Partial<AiConfig>;
}

/**
 * Every bot mode watches every trigger in shadow, so each mode reports how often each would
 * fire; a trigger mode makes that one trigger live (ADR 0044 decision 6).
 */
const ALL_SHADOW = { botEscalationShadow: [...ESCALATION_TRIGGERS] };

export const MODES: Mode[] = [
  { name: 'model (today)', config: { tacticalMode: 'model' } },
  {
    name: 'bot, replan every turn',
    config: {
      tacticalMode: 'bot',
      botEscalation: [],
      strategistReplan: 'everyTurn',
      ...ALL_SHADOW,
    },
  },
  {
    name: 'bot, replan on change',
    config: { tacticalMode: 'bot', botEscalation: [], strategistReplan: 'onChange', ...ALL_SHADOW },
  },
  ...LIVE_ESCALATION_TRIGGERS.map((trigger): Mode => ({
    name: `bot + escalate ${trigger}`,
    config: {
      tacticalMode: 'bot',
      botEscalation: [trigger],
      strategistReplan: 'onChange',
      ...ALL_SHADOW,
    },
  })),
];

export interface CensusCounts {
  turns: number;
  tactician: number;
  strategist: number;
  strategistReused: number;
  tacticianPromptTokens: number;
  strategistPromptTokens: number;
  /** Prompt characters sent, and how many of them repeat an earlier prompt's prefix (exact). */
  tacticianPromptChars: number;
  tacticianCacheableChars: number;
  strategistPromptChars: number;
  strategistCacheableChars: number;
  /** The cacheable characters of prompts whose cached prefix is at least 1,024 tokens. */
  tacticianLongPrefixChars: number;
  strategistLongPrefixChars: number;
  byDecisionType: Record<string, number>;
  /** Times each trigger fired (live or shadow), summed over seats. */
  triggerFired: Record<string, number>;
  /** Model calls credited to each live trigger. */
  triggerEscalated: Record<string, number>;
  /** `<trigger>:<decisionType>` and `<trigger>:<source>` would-fire counts. */
  triggerBreakdown: Record<string, number>;
}

function addInto(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
}

function emptyCounts(): CensusCounts {
  return {
    turns: 0,
    tactician: 0,
    strategist: 0,
    strategistReused: 0,
    tacticianPromptTokens: 0,
    strategistPromptTokens: 0,
    tacticianPromptChars: 0,
    tacticianCacheableChars: 0,
    strategistPromptChars: 0,
    strategistCacheableChars: 0,
    tacticianLongPrefixChars: 0,
    strategistLongPrefixChars: 0,
    byDecisionType: {},
    triggerFired: {},
    triggerEscalated: {},
    triggerBreakdown: {},
  };
}

export async function censusGame(
  pool: SupportedPool,
  seed: string,
  turnCap: number,
  mode: Mode,
  /** Test seam: sees the finished engine, e.g. to compare event logs across modes. */
  observe?: (engine: Engine) => void,
): Promise<CensusCounts> {
  const decks = Array.from({ length: 4 }, (_, i) =>
    generateCommanderDeck(pool, { seed: `${seed}-seat${i + 1}` }),
  );
  return censusPod(
    decks.map((d) => ({ commanders: [d.commander], cards: d.cards })),
    seed,
    turnCap,
    mode,
    observe,
  );
}

/** The census over four given decks, so a caller can hold the decks fixed as the pool grows. */
export async function censusPod(
  decks: ReadonlyArray<{ commanders: OracleCard[]; cards: OracleCard[] }>,
  seed: string,
  turnCap: number,
  mode: Pick<Mode, 'config'>,
  observe?: (engine: Engine) => void,
  options: {
    /**
     * Give each seat's strategist its inferred archetype, as a live match does. Off by default so
     * existing census figures keep their meaning.
     */
    archetypes?: boolean;
  } = {},
): Promise<CensusCounts> {
  const engine = new Engine({
    gameId: `census-${seed}`,
    seed,
    players: decks.map((d, i) => ({
      id: `P${i + 1}`,
      deckId: `census-${i + 1}`,
      commanders: d.commanders,
      cards: d.cards,
    })),
    turnCap,
  });
  const counts: CensusCounts = emptyCounts();
  const knowledge = knowledgeFor(engine);
  // One cache per role: the two roles may run on different models, and a pod is one session.
  const tacticianCache = new PrefixCacheModel();
  const strategistCache = new PrefixCacheModel();
  const tactician: AiClient = {
    activeModel: 'census-stub',
    requestDecision(prompt, request: DecisionRequest) {
      counts.tactician++;
      counts.tacticianPromptTokens += prompt.estimatedTokens;
      const seen = tacticianCache.observe(prompt.messages);
      counts.tacticianPromptChars += seen.chars;
      counts.tacticianCacheableChars += seen.cacheableChars;
      counts.tacticianLongPrefixChars += seen.longPrefixChars;
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
      const seen = strategistCache.observe(prompt.messages);
      counts.strategistPromptChars += seen.chars;
      counts.strategistCacheableChars += seen.cacheableChars;
      counts.strategistLongPrefixChars += seen.longPrefixChars;
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
  const archetypes =
    options.archetypes === true
      ? new Map(
          decks.map((deck, i) => [
            `P${i + 1}` as PlayerId,
            inferArchetype({
              commanders: deck.commanders,
              cards: deck.cards.map((card) => ({ card, quantity: 1 })),
              colorIdentity: [...new Set(deck.commanders.flatMap((c) => c.colorIdentity))],
            }).tag,
          ]),
        )
      : undefined;
  const coordinator = new StrategyCoordinator(
    strategist,
    queue,
    engine,
    config,
    undefined,
    undefined,
    archetypes,
  );
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
  for (const provider of providers.values()) {
    const stats = provider.escalationStats();
    addInto(counts.triggerFired, stats.fired);
    addInto(counts.triggerEscalated, stats.escalated);
    addInto(counts.triggerBreakdown, stats.byDecisionType);
    addInto(counts.triggerBreakdown, stats.bySource);
  }
  observe?.(engine);
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
    const total = emptyCounts();
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
      addInto(total.byDecisionType, c.byDecisionType);
      addInto(total.triggerFired, c.triggerFired);
      addInto(total.triggerEscalated, c.triggerEscalated);
      addInto(total.triggerBreakdown, c.triggerBreakdown);
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
      // ADR 0044: would-fire counts per trigger (shadow), and model calls each live one made.
      triggerFiredPerTurn: Object.fromEntries(
        Object.entries(total.triggerFired).map(([k, v]) => [
          k,
          Number((v / total.turns).toFixed(3)),
        ]),
      ),
      triggerEscalated: total.triggerEscalated,
      triggerBreakdown: total.triggerBreakdown,
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
